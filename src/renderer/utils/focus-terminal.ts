import type { AppState } from '../context/AppContext';
import { terminalRegistry } from '../hooks/useTerminal';
import { terminalKeyFor } from './keyboard-target';

/** Hand keystrokes back to a task's terminal, addressing the pane that holds focus. */
export function focusTaskTerminal(state: AppState, taskId: string | null): void {
  if (!taskId) return;
  terminalRegistry.get(terminalKeyFor(taskId, state.paneStates[taskId]))?.focus();
}
