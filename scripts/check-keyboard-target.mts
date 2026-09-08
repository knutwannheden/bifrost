/**
 * A terminal focused inside an overlay must not swallow the shortcut that
 * closes it. Run with `npm run check:keyboard-target`.
 */
import { ownsKeystrokes, type ShortcutTarget, terminalKeyFor } from '../src/renderer/utils/keyboard-target.ts';

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
}

const target = (tagName: string, insideTerminal = false): ShortcutTarget => ({
  tagName,
  closest: (selector: string) => (insideTerminal && selector === '.xterm' ? {} : null),
});

check("a terminal's hidden textarea leaves shortcuts alone", !ownsKeystrokes(target('TEXTAREA', true)));
check("an overlay's own textarea keeps its keystrokes", ownsKeystrokes(target('TEXTAREA')));
check('a plain element never claims keystrokes', !ownsKeystrokes(target('DIV')));

// The registry keys the main pane by the task; a Claude session id matches nothing.
check("a task's main terminal is keyed by the task", terminalKeyFor('task-1') === 'task-1');
check(
  'a dev pane is addressed only while it holds focus',
  terminalKeyFor('task-1', { focusedPane: 'dev', devSessionId: 'dev-9' }) === 'dev-9' &&
    terminalKeyFor('task-1', { focusedPane: 'claude', devSessionId: 'dev-9' }) === 'task-1',
);

process.exit(failed === 0 ? 0 : 1);
