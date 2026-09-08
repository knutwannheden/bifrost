/** The parts of an event target this decision needs, so it can be checked without a DOM. */
export interface ShortcutTarget {
  tagName: string;
  closest(selector: string): unknown;
}

/**
 * Whether keystrokes on this element belong to it rather than to the app. A
 * terminal keeps focus in a hidden textarea, and a shortcut pressed over one
 * still has to reach the app — that is what its own key handler forwards.
 */
export function ownsKeystrokes(target: ShortcutTarget): boolean {
  if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && target.tagName !== 'SELECT') return false;
  return !target.closest('.xterm');
}

/** The change feed dock marks itself so shortcuts can tell when it holds focus. */
export function changeFeedHasFocus(): boolean {
  return document.activeElement?.closest('[data-change-feed]') != null;
}

/** The pane fields that decide which terminal a task's keystrokes belong to. */
export interface PaneFocus {
  focusedPane?: string;
  devSessionId?: string | null;
}

/**
 * The key a task's visible terminal is registered under. The main pane registers
 * as the task itself; `task.sessionId` names the Claude session, which is a
 * separate namespace and matches nothing in the registry.
 */
export function terminalKeyFor(taskId: string, pane?: PaneFocus): string {
  return pane?.focusedPane === 'dev' && pane.devSessionId ? pane.devSessionId : taskId;
}
