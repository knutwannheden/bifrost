import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INHERITED_SESSION_VARS } from './session-manager';

/**
 * A transcript is filed under a project directory derived from the working
 * directory, so these run outside any worktree as well as leaving no session
 * behind: among a task's own transcripts, Bifrost's replies are read back as the
 * agent's work by everything that scans that directory.
 */
const ONESHOT_DIR = path.join(os.homedir(), '.bifrost', 'oneshot');

/**
 * The default system prompt equips an agent, which costs about 40k tokens a call
 * and buys nothing here: the whole instruction arrives on stdin, and the reply
 * comes back through the structured-output tool.
 */
const TRANSFORM_PROMPT = 'You rewrite text. Reply only through the structured output tool.';

export interface OneShotOptions {
  /** Standing instructions; the transcript or other input follows it on stdin. */
  prompt: string;
  input: string;
  model: string;
  /** The CLI validates the reply against this, so the prompt carries only editorial rules. */
  schema: unknown;
  timeoutMs: number;
  /** Prefixes log lines, so a failure says which caller it belonged to. */
  label: string;
}

/**
 * The CLI installs as a symlink its updater repoints, so the name resolves for
 * everything except the instant of a version swap. One retry covers that.
 */
const RESPAWN_DELAY_MS = 400;

/** One run of the CLI. Its JSON report on stdout is kept only from a run that succeeded. */
interface CliRun {
  ok: boolean;
  stdout: string;
  /** The binary was not found, so the call never reached the CLI. */
  missing: boolean;
}

/**
 * Put one text transform through the CLI and hand back its structured reply.
 * Loading no tools, MCP servers or settings is what keeps this a transform
 * rather than a session, and keeps its cost to the text it is given.
 */
export async function runOneShot<T>(options: OneShotOptions): Promise<T | null> {
  const args = ['--json-schema', JSON.stringify(options.schema), '--model', options.model];
  args.push('--system-prompt', TRANSFORM_PROMPT, '--tools', '');
  const run = await runCli(args, `${options.prompt}\n\n${options.input}`, options.timeoutMs, options.label);
  if (!run.ok) return null;
  try {
    return (JSON.parse(run.stdout).structured_output as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Shown as the sender of what the relay delivers. */
const RELAY_NAME = 'Bifrost';
const RELAY_TIMEOUT_MS = 60_000;
const RELAY_PROMPT =
  'You deliver one message to another Claude Code session with SendMessage, then stop. ' +
  'Send the message verbatim. If SendMessage cannot tell which session the name means, call ListAgents ' +
  'and send to the one that is running, not offline, giving its [ref]. ' +
  'Reply with SENT followed by the address you gave SendMessage, or FAILED followed by the reason.';

/**
 * Deliver one message to the session with that name, the way one session
 * messages another. Bifrost is no session, so a headless one sends it for it.
 * The sender exits once it has sent, so a reply reaches nobody.
 */
export async function relayMessage(to: string, message: string): Promise<boolean> {
  const args = ['--model', 'haiku', '--name', RELAY_NAME, '--system-prompt', RELAY_PROMPT];
  args.push('--tools', 'SendMessage,ListAgents');
  const input = `Recipient: ${JSON.stringify(to)}\n\nMessage:\n${message}`;
  const run = await runCli(args, input, RELAY_TIMEOUT_MS, 'relay');
  if (!run.ok) return false;
  let result = '';
  try {
    result = String(JSON.parse(run.stdout).result ?? '').trim();
  } catch {
    /* reported as not sent below */
  }
  const sent = result.startsWith('SENT');
  console[sent ? 'log' : 'warn'](`[relay] to ${to}: ${result || '(no result)'}`);
  return sent;
}

/** Runs the CLI once more after a moment when its binary was not found on the first try. */
async function runCli(args: string[], input: string, timeoutMs: number, label: string): Promise<CliRun> {
  const first = await attempt(args, input, timeoutMs, label);
  if (!first.missing) return first;

  await new Promise((r) => setTimeout(r, RESPAWN_DELAY_MS));
  const second = await attempt(args, input, timeoutMs, label);
  if (second.missing) {
    console.warn(`[${label}] claude is not on PATH; skipping`);
  }
  return second;
}

function oneShotDir(): string {
  fs.mkdirSync(ONESHOT_DIR, { recursive: true });
  return ONESHOT_DIR;
}

function attempt(args: string[], input: string, timeoutMs: number, label: string): Promise<CliRun> {
  return new Promise((resolve) => {
    const env = { ...process.env } as Record<string, string>;
    for (const name of INHERITED_SESSION_VARS) delete env[name];

    const child = spawn(
      'claude',
      [
        '-p',
        '--output-format',
        'json',
        ...args,
        '--no-session-persistence',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--no-chrome',
        '--dangerously-skip-permissions',
      ],
      { cwd: oneShotDir(), env },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, missing = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: ok ? stdout : '', missing });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false);
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    // Drained even though unused on success: an unread pipe fills once the CLI
    // writes past the OS buffer (~64KB) and blocks the child until the timeout.
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) console.error(`[${label}] failed to spawn claude:`, err);
      finish(false, missing);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // --output-format json reports failures as JSON on stdout, so stderr is
        // routinely empty and carries none of the reason.
        console.error(
          `[${label}] claude exited with code ${code}`,
          `\n  stdout: ${stdout.trim().slice(0, 2000) || '(empty)'}`,
          `\n  stderr: ${stderr.trim().slice(0, 500) || '(empty)'}`,
        );
        finish(false);
        return;
      }
      finish(true);
    });

    child.stdin.on('error', () => finish(false));
    child.stdin.end(input);
  });
}
