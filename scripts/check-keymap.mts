/**
 * Which key presses reach which bindings, on macOS and elsewhere. Run with `npm run check:keymap`.
 */
import {
  DEFAULT_KEYMAP,
  parseStroke,
  strokeAccelerator,
  strokeLabel,
  strokeMatches,
  strokeOfEvent,
} from '../src/shared/keymap.ts';

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
}

type Mods = { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean };
const press = (key: string, code: string, m: Mods = {}) => ({
  key,
  code,
  ctrlKey: !!m.ctrl,
  metaKey: !!m.meta,
  shiftKey: !!m.shift,
  altKey: !!m.alt,
});

function actionFor(e: ReturnType<typeof press>, mac: boolean): string | undefined {
  const pressed = strokeOfEvent(e, mac);
  if (!pressed) return undefined;
  return DEFAULT_KEYMAP.find((b) => b.strokes.length === 1 && strokeMatches(b.strokes[0], pressed))?.actionId;
}

const linux = false;
const mac = true;

check('Linux: plain Ctrl+R is left to the terminal', strokeOfEvent(press('r', 'KeyR', { ctrl: true }), linux) === null);
check(
  'Linux: Ctrl+Shift+T makes a new task',
  actionFor(press('T', 'KeyT', { ctrl: true, shift: true }), linux) === 'task.new',
);
check(
  'Linux: Ctrl+Shift+1 switches to tab 1, though Shift turns the key into "!"',
  actionFor(press('!', 'Digit1', { ctrl: true, shift: true }), linux) === 'nav.tab1',
);
check(
  'Linux: Ctrl+Alt+Shift+W archives, where macOS has Cmd+Shift+W',
  actionFor(press('W', 'KeyW', { ctrl: true, alt: true, shift: true }), linux) === 'task.archive',
);
check(
  'macOS keeps Cmd: Cmd+T makes a new task, Cmd+Shift+W archives',
  actionFor(press('t', 'KeyT', { meta: true }), mac) === 'task.new' &&
    actionFor(press('w', 'KeyW', { meta: true, shift: true }), mac) === 'task.archive',
);

const archive = parseStroke('Cmd+Shift+W');
check('Linux shows Cmd+Shift+W as Ctrl+Alt+Shift+W', strokeLabel(archive, linux) === 'Ctrl+Alt+Shift+W');
check('macOS shows Cmd+Shift+W as ⌘⇧W', strokeLabel(archive, mac) === '⌘⇧W');
check('Linux menus get Ctrl+Alt+Shift+W', strokeAccelerator(archive, linux) === 'Ctrl+Alt+Shift+W');
check('macOS menus get CommandOrControl+Shift+W', strokeAccelerator(archive, mac) === 'CommandOrControl+Shift+W');

process.exit(failed === 0 ? 0 : 1);
