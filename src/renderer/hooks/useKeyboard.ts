import { useEffect } from 'react';
import type { AppState, AppAction, PaneTarget } from '../context/AppContext';
import { defaultPaneState } from '../context/AppContext';
import { terminalRegistry } from './useTerminal';

function getTerminalContent(sessionId: string): string | null {
  const terminal = terminalRegistry.get(sessionId);
  if (!terminal) return null;

  // Check for selection first
  const selection = terminal.getSelection();
  if (selection && selection.trim().length > 0) return selection;

  // Fall back to last 50 lines of buffer
  const buffer = terminal.buffer.active;
  const totalRows = buffer.length;
  const startRow = Math.max(0, totalRows - 50);
  const lines: string[] = [];
  for (let i = startRow; i < totalRows; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  const content = lines.join('\n').trimEnd();
  return content.length > 0 ? content : null;
}

export function useKeyboard(state: AppState, dispatch: React.Dispatch<AppAction>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;

      const key = e.key.toLowerCase();

      // Cmd+Shift+C: capture context
      if (e.shiftKey && key === 'c') {
        e.preventDefault();
        const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
        if (!activeTask) return;

        const capture = async () => {
          let content: string | null = null;
          let label: string;

          if (state.showDiff) {
            // Capture diff or activity log content
            if (state.diffMode === 'git') {
              const diff = await window.bifrost.getDiff(activeTask.id);
              content = diff.diff || null;
              label = 'git diff';
            } else {
              const entries = await window.bifrost.getActivityLog(activeTask.id);
              content = entries.map((e) => {
                if (e.type === 'commit') return `[commit] ${e.commitMessage}`;
                if (e.type === 'file_change') return `[file] ${e.filePath}\n${e.diff || ''}`;
                if (e.type === 'claude_event') return `[${e.claudeEventKind}] ${e.claudeText || ''}`;
                return `[${e.type}]`;
              }).join('\n\n');
              label = 'activity log';
            }
          } else {
            // Try terminal content
            const ps = state.paneStates[activeTask.id] ?? defaultPaneState;
            const targetSessionId = ps.focusedPane === 'dev' && ps.devSessionId
              ? ps.devSessionId
              : activeTask.sessionId;
            content = getTerminalContent(targetSessionId);
            label = 'terminal';
          }

          if (!content || content.trim().length === 0) return;

          const id = await window.bifrost.captureContext(content, label, activeTask.id);
          dispatch({ type: 'SHOW_TOAST', message: `[Bifrost #${id}] copied` });
        };
        capture();
        return;
      }

      // Cmd+Shift+[ or Cmd+Shift+]: switch to prev/next tab
      if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        const openTasks = state.tasks.filter((t) => t.status === 'running');
        if (openTasks.length === 0) return;
        const currentIdx = openTasks.findIndex((t) => t.id === state.activeTaskId);
        let newIdx: number;
        if (e.code === 'BracketLeft') {
          newIdx = currentIdx <= 0 ? openTasks.length - 1 : currentIdx - 1;
        } else {
          newIdx = currentIdx >= openTasks.length - 1 ? 0 : currentIdx + 1;
        }
        dispatch({ type: 'SET_ACTIVE_TASK', taskId: openTasks[newIdx].id });
        return;
      }

      // Cmd+1 through Cmd+9: switch to task at index
      if (key >= '1' && key <= '9') {
        const openTasks = state.tasks.filter((t) => t.status === 'running');
        const index = parseInt(key, 10) - 1;
        if (index < openTasks.length) {
          e.preventDefault();
          dispatch({ type: 'SET_ACTIVE_TASK', taskId: openTasks[index].id });
        }
        return;
      }

      switch (key) {
        case 't':
          e.preventDefault();
          dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true });
          break;

        case 'w': {
          e.preventDefault();
          if (!state.activeTaskId) break;
          const taskId = state.activeTaskId;
          const ps = state.paneStates[taskId] ?? defaultPaneState;

          // Hide the focused pane
          const hiding = ps.focusedPane;
          const otherPane: PaneTarget = hiding === 'claude' ? 'dev' : 'claude';
          const otherHidden = otherPane === 'claude' ? ps.claudeHidden : ps.devHidden;
          const otherExists = otherPane === 'dev' ? !!ps.devSessionId : true;

          if (otherExists && !otherHidden) {
            // Other pane is visible — hide current and focus other
            dispatch({ type: 'HIDE_PANE', taskId, pane: hiding });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: otherPane });
          } else {
            // Both panes will be hidden — close the tab
            if (ps.devSessionId) {
              window.bifrost.closeDevTerminal(taskId);
              dispatch({ type: 'CLOSE_DEV_SESSION', taskId });
            }
            window.bifrost.stopTask(taskId).then((updated) => {
              dispatch({ type: 'UPDATE_TASK', task: updated });
              const remaining = state.tasks.filter(
                (t) => t.id !== taskId && t.status === 'running',
              );
              dispatch({
                type: 'SET_ACTIVE_TASK',
                taskId: remaining.length > 0 ? remaining[remaining.length - 1].id : null,
              });
            });
          }
          break;
        }

        case '/': {
          e.preventDefault();
          if (!state.activeTaskId) break;
          const taskId = state.activeTaskId;
          const ps = state.paneStates[taskId] ?? defaultPaneState;

          if (!ps.devSessionId) {
            // No dev terminal yet — create one
            window.bifrost.createDevTerminal(taskId).then((devSessionId) => {
              dispatch({ type: 'SET_DEV_SESSION', taskId, devSessionId });
            });
          } else if (ps.claudeHidden) {
            // Claude pane hidden — show it and focus it
            dispatch({ type: 'SHOW_PANE', taskId, pane: 'claude' });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: 'claude' });
          } else if (ps.devHidden) {
            // Dev pane hidden — show it and focus it
            dispatch({ type: 'SHOW_PANE', taskId, pane: 'dev' });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: 'dev' });
          } else {
            // Both visible — toggle focus
            const newFocus: PaneTarget = ps.focusedPane === 'claude' ? 'dev' : 'claude';
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: newFocus });
          }
          break;
        }

        case 'r':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_REPO_MANAGER' });
          break;

        case 'd':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_DIFF' });
          break;

        case 'h':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_TASK_HISTORY' });
          break;

        case 'o': {
          e.preventDefault();
          const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
          if (activeTask) {
            window.bifrost.openInIde(activeTask.worktreePath);
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state, dispatch]);
}
