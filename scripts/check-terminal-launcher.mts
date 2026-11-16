/**
 * The commands that open a terminal in a directory, in the order they are
 * tried. Run with `npm run check:terminal-launcher`.
 */

import { terminalCommands } from '../src/main/terminal-launcher.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const dir = "/home/u/it's here";

{
  const chosen = (['gnome-terminal', 'konsole', 'kitty', 'Ghostty'] as const).map(
    (t) => terminalCommands('linux', t, dir, undefined)[0],
  );
  check(
    'on Linux, the chosen terminal opens with its own flag for the directory',
    show(chosen) ===
      show([
        { command: 'gnome-terminal', args: [`--working-directory=${dir}`] },
        { command: 'konsole', args: ['--workdir', dir] },
        { command: 'kitty', args: ['--directory', dir] },
        { command: 'ghostty', args: [`--working-directory=${dir}`] },
      ]),
    show(chosen),
  );
}

{
  const auto = terminalCommands('linux', 'auto', dir, 'alacritty').map((c) => c.command);
  const macChoice = terminalCommands('linux', 'iTerm', dir, undefined).map((c) => c.command);
  const missingKitty = terminalCommands('linux', 'kitty', dir, undefined).map((c) => c.command);
  check(
    "on Linux, Auto, a macOS terminal, or a chosen one that is missing, goes on to $TERMINAL, the distribution's default, then the common ones",
    show(auto) === show(['alacritty', 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) &&
      show(macChoice) === show(['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) &&
      show(missingKitty) === show(['kitty', 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']),
    show({ auto, macChoice, missingKitty }),
  );
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
