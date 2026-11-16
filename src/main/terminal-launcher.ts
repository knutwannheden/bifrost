import { execFile, spawn } from 'node:child_process';
import type { BifrostConfig } from '../shared/types.ts';

type Terminal = BifrostConfig['terminal'];
type Command = { command: string; args: string[] };

function appleScript(terminal: Terminal, dir: string): string {
  const escaped = dir.replace(/'/g, "'\\''");
  switch (terminal) {
    case 'iTerm':
      return `tell application "iTerm"
  activate
  create window with default profile command "/bin/zsh"
  tell current session of current window
    write text "cd '${escaped}'"
  end tell
end tell`;
    case 'Ghostty':
      return `do shell script "open -a Ghostty '${escaped}'"`;
    case 'Warp':
      return `do shell script "open -a Warp '${escaped}'"`;
    default:
      return `tell application "Terminal"
  activate
  do script "cd '${escaped}'"
end tell`;
  }
}

const LINUX = {
  'gnome-terminal': (dir: string) => ({ command: 'gnome-terminal', args: [`--working-directory=${dir}`] }),
  konsole: (dir: string) => ({ command: 'konsole', args: ['--workdir', dir] }),
  kitty: (dir: string) => ({ command: 'kitty', args: ['--directory', dir] }),
  Ghostty: (dir: string) => ({ command: 'ghostty', args: [`--working-directory=${dir}`] }),
} satisfies Partial<Record<Terminal, (dir: string) => Command>>;

/**
 * The commands that open a terminal in the directory, to try in order until one exists.
 * A command without a flag for the directory gets it as its working directory.
 */
export function terminalCommands(
  platform: NodeJS.Platform,
  terminal: Terminal,
  dir: string,
  terminalEnv: string | undefined,
): Command[] {
  if (platform === 'darwin') return [{ command: 'osascript', args: ['-e', appleScript(terminal, dir)] }];
  const chosen = LINUX[terminal as keyof typeof LINUX]?.(dir);
  // Auto and the macOS choices, the default 'Terminal' among them, try only these. A chosen terminal that is missing goes on to them.
  const fallback = [
    ...(terminalEnv ? [{ command: terminalEnv, args: [] }] : []),
    { command: 'x-terminal-emulator', args: [] },
    LINUX['gnome-terminal'](dir),
    LINUX.konsole(dir),
    { command: 'xterm', args: [] },
  ];
  return chosen ? [chosen, ...fallback.filter((c) => c.command !== chosen.command)] : fallback;
}

/** Whether the command started. A terminal runs until its window closes, so this does not wait for it. */
function started({ command, args }: Command, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** Opens the terminal in the directory, and reports whether one opened. */
export async function openTerminal(terminal: Terminal, dir: string): Promise<boolean> {
  const commands = terminalCommands(process.platform, terminal, dir, process.env.TERMINAL);
  if (process.platform === 'darwin') {
    // osascript returns once the terminal has the window, and fails when the app is missing.
    const { command, args } = commands[0];
    return new Promise((resolve) => execFile(command, args, (error) => resolve(!error)));
  }
  for (const command of commands) {
    if (await started(command, dir)) return true;
  }
  return false;
}
