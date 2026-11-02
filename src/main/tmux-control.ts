import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

/** The scrollback a replay carries, as much as the session mirror keeps. */
const REPLAY_LINES = 1000;
/** send-keys -H takes one argument per byte, so a long paste goes over several commands. */
const KEYS_PER_COMMAND = 256;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;

interface Pending {
  done(lines: string[], error: boolean): void;
}

/**
 * One tmux control-mode client attached to one session, over a child process's
 * pipes. Commands go one per line, and tmux answers each in a %begin/%end block.
 * Pane output arrives as %output lines carrying the program's own bytes.
 */
export class TmuxControl {
  /**
   * Terminal output that reproduces the pane as it was when the client
   * attached, with scrollback, screen and cursor. onOutput carries on from it.
   */
  readonly screen: Promise<string>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: Pending[] = [];
  private block: { header: string; lines: string[]; ours: boolean } | null = null;
  private rest = Buffer.alloc(0);
  private readonly decoder = new TextDecoder('utf-8');
  /** Output before the replay is in the replay, so it is dropped until then. */
  private live = false;
  private readonly outputListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  private exited = false;

  private constructor(child: ChildProcessWithoutNullStreams, cols: number, rows: number) {
    this.child = child;
    child.stdin.on('error', () => {
      /* the client has gone, which its exit reports */
    });
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    let rejectScreen: (err: Error) => void = () => {};
    this.screen = new Promise<string>((resolve, reject) => {
      rejectScreen = reject;
      const answers: string[][] = [];
      const collect = (lines: string[]) => answers.push(lines);
      // tmux runs a line's commands without reading the pane in between, so the
      // captures and the cursor describe one moment, and output after it is new.
      this.send(
        `refresh-client -C ${cols}x${rows} ; ` +
          `display -p '#{cursor_x} #{cursor_y} #{alternate_on} #{pane_height}' ; ` +
          'capture-pane -p -e -a -q ; ' +
          `capture-pane -p -e -S -${REPLAY_LINES}`,
        [
          collect,
          collect,
          collect,
          (lines) => {
            this.live = true;
            resolve(replay(answers[1][0] ?? '0 0 0 0', answers[2], lines));
          },
        ],
      );
    });
    // An unawaited replay is no error of its own, since the exit is reported.
    this.screen.catch(() => {});
    const ended = (code: number | null) => {
      if (this.exited) return;
      this.exited = true;
      rejectScreen(new Error(`tmux exited with ${code} before its screen was read`));
      for (const p of this.pending.splice(0)) p.done(['tmux exited'], true);
      for (const listener of this.exitListeners) listener(code);
    };
    child.on('exit', ended);
    // A command that cannot be spawned reports an error and no exit.
    child.on('error', () => ended(null));
  }

  /** Spawns `command args`, which attach a tmux client in control mode, sized cols by rows. */
  static start(
    command: string,
    args: string[],
    size: { cols: number; rows: number },
    env: NodeJS.ProcessEnv = process.env,
  ): TmuxControl {
    return new TmuxControl(spawn(command, args, { stdio: 'pipe', env }), size.cols, size.rows);
  }

  onOutput(listener: (data: string) => void): void {
    this.outputListeners.push(listener);
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }

  /** The output lines of one tmux command, rejecting with its error. */
  command(line: string): Promise<string[]> {
    return new Promise((resolve, reject) =>
      this.send(line, [(lines, error) => (error ? reject(new Error(lines.join('\n'))) : resolve(lines))]),
    );
  }

  write(data: string): void {
    const bytes = Buffer.from(data, 'utf8');
    for (let i = 0; i < bytes.length; i += KEYS_PER_COMMAND) {
      const keys = [...bytes.subarray(i, i + KEYS_PER_COMMAND)].map((b) => b.toString(16).padStart(2, '0'));
      this.command(`send-keys -H ${keys.join(' ')}`).catch(() => {});
    }
  }

  resize(cols: number, rows: number): void {
    this.command(`refresh-client -C ${cols}x${rows}`).catch(() => {});
  }

  /** Ends this client. The session runs on. */
  detach(): void {
    this.child.stdin.end();
  }

  /** Ends the session, and with it the program and this client. */
  kill(): void {
    this.command('kill-session').catch(() => {});
  }

  /** A line with `;` between commands is answered by one block per command. */
  private send(line: string, answers: Array<(lines: string[], error: boolean) => void>): void {
    if (this.exited || !this.child.stdin.writable) {
      for (const done of answers) done(['tmux is not attached'], true);
      return;
    }
    for (const done of answers) this.pending.push({ done });
    this.child.stdin.write(`${line}\n`);
  }

  private read(chunk: Buffer): void {
    let data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let newline = data.indexOf(NEWLINE);
    while (newline >= 0) {
      this.line(data.subarray(0, newline));
      data = data.subarray(newline + 1);
      newline = data.indexOf(NEWLINE);
    }
    this.rest = Buffer.from(data);
  }

  private line(raw: Buffer): void {
    const text = raw.toString('utf8');
    if (this.block) {
      // A pane line can read like %end, so the block closes only on its own numbers.
      const [kind, ...header] = text.split(' ');
      if ((kind === '%end' || kind === '%error') && header.join(' ') === this.block.header) {
        const { lines, ours } = this.block;
        this.block = null;
        if (ours) this.pending.shift()?.done(lines, kind === '%error');
      } else {
        this.block.lines.push(text);
      }
      return;
    }
    if (text.startsWith('%begin ')) {
      const header = text.slice('%begin '.length);
      // Flag bit 1 marks a command this client sent. The attaching command's block has it clear.
      const flags = Number(header.split(' ')[2]);
      this.block = { header, lines: [], ours: (flags & 1) === 1 };
    } else if (text.startsWith('%output ')) {
      // %output %<pane> <data>
      const start = raw.indexOf(0x20, '%output '.length) + 1;
      const data = this.decoder.decode(unescapeOutput(raw.subarray(start)), { stream: true });
      if (this.live && data) for (const listener of this.outputListeners) listener(data);
    }
  }
}

/** tmux writes bytes below space, and the backslash, as a backslash and three octal digits. */
function unescapeOutput(escaped: Buffer): Buffer {
  const out = Buffer.alloc(escaped.length);
  let n = 0;
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === BACKSLASH && isOctal(escaped, i + 1)) {
      out[n++] = Number.parseInt(escaped.subarray(i + 1, i + 4).toString('latin1'), 8);
      i += 3;
    } else {
      out[n++] = escaped[i];
    }
  }
  return out.subarray(0, n);
}

function isOctal(bytes: Buffer, at: number): boolean {
  if (at + 3 > bytes.length) return false;
  for (let i = at; i < at + 3; i++) if (bytes[i] < 0x30 || bytes[i] > 0x37) return false;
  return true;
}

/**
 * The pane's scrollback and screen as terminal output, then its cursor. tmux
 * closes each captured line's attributes, so the lines join as they are. On
 * the alternate screen, the normal screen behind it goes first.
 */
function replay(state: string, normalBehind: string[], captured: string[]): string {
  const [x, y, alternate, height] = state.split(' ').map(Number);
  const cursor = `\x1b[${y + 1};${x + 1}H`;
  if (!alternate) return captured.join('\r\n') + cursor;
  const scrollback = captured.slice(0, captured.length - height);
  const shown = captured.slice(captured.length - height);
  return `${[...scrollback, ...normalBehind].join('\r\n')}\x1b[?1049h\x1b[H${shown.join('\r\n')}${cursor}`;
}
