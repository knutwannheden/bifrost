import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { AppState, AppAction, PaneTarget } from '../context/AppContext';
import type { CaptureContextParams } from '../../shared/types';
import { defaultPaneState, getActiveDiffState } from '../context/AppContext';
import { terminalRegistry } from './useTerminal';

const RECORD_SYMBOL = '\u23FA'; // ⏺
const DOUBLE_PRESS_MS = 500;

/**
 * Try to extract a file path (and optional line number) from text.
 * Handles patterns like:
 *   src/main/foo.ts:42:10
 *   src/main/foo.ts:42
 *   src/main/foo.ts
 *   "path/to/file.ts"
 *   (path/to/file.ts)
 */
function extractFilePath(text: string): { path: string; line?: number } | null {
  let trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n')) return null;

  // Strip matching quotes/parens/brackets
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('`') && trimmed.endsWith('`')) ||
      (trimmed.startsWith('(') && trimmed.endsWith(')'))) {
    trimmed = trimmed.slice(1, -1);
  }

  // Match file:line:col or file:line
  const match = trimmed.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (match) {
    return { path: match[1], line: parseInt(match[2], 10) };
  }

  // Check if it looks like a file path (has extension or directory separator, no spaces)
  if (/[/.]/.test(trimmed) && !/\s/.test(trimmed)) {
    return { path: trimmed };
  }

  return null;
}

interface TerminalCapture {
  content: string;
  hasSelection: boolean;
  /** Text from the nearest ⏺ to the selection/cursor, if found */
  transcriptText: string | null;
}

function getTerminalCapture(sessionId: string): TerminalCapture | null {
  const terminal = terminalRegistry.get(sessionId);
  if (!terminal) return null;

  const selection = terminal.getSelection();
  const hasSelection = !!selection?.trim();

  let content: string;
  if (hasSelection) {
    content = selection;
  } else {
    // Fall back to last 50 lines of buffer
    const buffer = terminal.buffer.active;
    const totalRows = buffer.length;
    const startRow = Math.max(0, totalRows - 50);
    const lines: string[] = [];
    for (let i = startRow; i < totalRows; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    content = lines.join('\n').trimEnd();
  }

  if (!content.trim()) return null;

  // Scan for ⏺ to detect Claude assistant turn
  const transcriptText = findTranscriptText(terminal, hasSelection);

  return { content, hasSelection, transcriptText };
}

/**
 * Scan backwards through the terminal buffer from the selection/cursor
 * looking for ⏺ (U+23FA) which marks Claude assistant turns.
 * Returns the text from ⏺ to the end of the captured region, or null.
 */
function findTranscriptText(terminal: Terminal, hasSelection: boolean): string | null {
  const buffer = terminal.buffer.active;

  // Determine the search end row
  let endRow: number;
  if (hasSelection) {
    const selRange = terminal.getSelectionPosition();
    endRow = selRange ? selRange.end.y : buffer.cursorY + buffer.viewportY;
  } else {
    endRow = buffer.cursorY + buffer.viewportY;
  }

  // Determine the search start row (limit lookback)
  const startRow = Math.max(0, endRow - 200);

  // Search backwards for ⏺
  let recordRow = -1;
  for (let row = endRow; row >= startRow; row--) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let col = line.length - 1; col >= 0; col--) {
      const cell = line.getCell(col);
      if (cell && cell.getChars() === RECORD_SYMBOL) {
        recordRow = row;
        break;
      }
    }
    if (recordRow >= 0) break;
  }

  if (recordRow < 0) return null;

  // Extract text from after the ⏺ to the end of the captured region
  const lines: string[] = [];
  for (let row = recordRow; row <= endRow; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    let text = line.translateToString(true);
    if (row === recordRow) {
      // Skip past the ⏺ character and any leading whitespace after it
      const symbolIdx = text.indexOf(RECORD_SYMBOL);
      if (symbolIdx >= 0) {
        text = text.slice(symbolIdx + 1).trimStart();
      }
    }
    lines.push(text);
  }

  const result = lines.join('\n').trim();
  return result.length > 0 ? result : null;
}

export function useKeyboard(state: AppState, dispatch: React.Dispatch<AppAction>) {
  const lastCmdWRef = useRef(0);
  const lastCmdShiftWRef = useRef(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { showDiff, diffMode } = getActiveDiffState(state);

      // Alt+U: open/toggle review mode (works without Cmd)
      // Skip when an overlay is open to avoid closing it via mutual exclusion
      if (e.altKey && !e.metaKey && e.code === 'KeyU') {
        if (state.showTaskHistory || state.showRepoManager || state.showSettings || state.showKeyboardShortcuts) return;
        e.preventDefault();
        if (showDiff && diffMode === 'review') {
          dispatch({ type: 'TOGGLE_DIFF' });
        } else {
          dispatch({ type: 'SET_DIFF_MODE', mode: 'review' });
          if (!showDiff) {
            dispatch({ type: 'TOGGLE_DIFF' });
          }
        }
        return;
      }

      if (!e.metaKey) return;

      const key = e.key.toLowerCase();

      // Cmd+Shift+C: capture context (skip if already handled by DiffOverlay)
      if (e.shiftKey && key === 'c' && !e.defaultPrevented) {
        e.preventDefault();
        const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
        if (!activeTask) return;

        const capture = async () => {
          let params: CaptureContextParams | null = null;
          const taskMeta = { taskId: activeTask.id, taskName: activeTask.name };

          if (showDiff) {
            // Use DOM text selection if available (works in any diff/review mode)
            const domSelection = window.getSelection()?.toString()?.trim();
            if (domSelection) {
              params = { type: diffMode === 'review' ? 'activity' : diffMode as 'diff' | 'activity', content: domSelection, ...taskMeta };
            } else if (diffMode === 'git') {
              const diff = await window.bifrost.getDiff(activeTask.id);
              const content = diff.diff;
              if (!content?.trim()) return;
              params = { type: 'diff', content, ...taskMeta };
            } else if (diffMode === 'review') {
              const content = state.reviewContent[activeTask.id];
              if (!content?.trim()) return;
              params = { type: 'activity', content, ...taskMeta };
            } else {
              const entries = await window.bifrost.getActivityLog(activeTask.id);
              const content = entries.map((e) => {
                if (e.type === 'commit') return `[commit] ${e.commitMessage}`;
                if (e.type === 'file_change') return `[file] ${e.filePath}\n${e.diff || ''}`;
                if (e.type === 'claude_event') return `[${e.claudeEventKind}] ${e.claudeText || ''}`;
                return `[${e.type}]`;
              }).join('\n\n');
              if (!content.trim()) return;
              params = { type: 'activity', content, ...taskMeta };
            }
          } else {
            const ps = state.paneStates[activeTask.id] ?? defaultPaneState;
            const targetSessionId = ps.focusedPane === 'dev' && ps.devSessionId
              ? ps.devSessionId
              : activeTask.sessionId;
            const capture = getTerminalCapture(targetSessionId);
            if (!capture) return;

            // If we found a ⏺ marker, try to match against Claude's JSONL
            if (capture.transcriptText) {
              const match = await window.bifrost.findTranscriptMatch(
                activeTask.worktreePath,
                capture.transcriptText.slice(0, 500), // limit search text size
              );
              if (match) {
                params = {
                  type: 'transcript',
                  content: capture.content,
                  jsonlPath: match.jsonlPath,
                  lineNumber: match.lineNumber,
                  uuid: match.uuid,
                  selectedText: capture.hasSelection ? capture.content : undefined,
                  ...taskMeta,
                };
              }
            }

            // Fall back to terminal context
            if (!params) {
              params = {
                type: 'terminal',
                content: capture.content,
                hasSelection: capture.hasSelection,
                ...taskMeta,
              };
            }
          }

          const id = await window.bifrost.captureContext(params);
          dispatch({ type: 'SHOW_TOAST', message: `[Bifrost #${id}] copied` });
        };
        capture();
        return;
      }

      // Cmd+Shift+W: archive current task (double-tap required)
      if (e.shiftKey && key === 'w') {
        e.preventDefault();
        const taskId = state.activeTaskId;
        if (!taskId) return;
        const task = state.tasks.find((t) => t.id === taskId);
        if (!task || task.status === 'archived') return;

        const now = Date.now();
        if (now - lastCmdShiftWRef.current >= DOUBLE_PRESS_MS) {
          lastCmdShiftWRef.current = now;
          dispatch({ type: 'SHOW_TOAST', message: 'Press \u2318\u21E7W again to archive task' });
          return;
        }
        lastCmdShiftWRef.current = 0;

        // Select next task immediately — archiveTask is async (worktree
        // removal) and the session-exit event would clear the tab first.
        const remaining = state.tasks.filter(
          (t) => t.id !== taskId && t.status === 'running',
        );
        dispatch({
          type: 'SET_ACTIVE_TASK',
          taskId: remaining.length > 0 ? remaining[remaining.length - 1].id : null,
        });
        window.bifrost.archiveTask(taskId).then((updated) => {
          dispatch({ type: 'UPDATE_TASK', task: updated });
        });
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

      // Cmd+-: switch to previous active tab
      if (key === '-' && !e.shiftKey) {
        e.preventDefault();
        const prevId = state.previousActiveTaskId;
        if (prevId && state.tasks.some((t) => t.id === prevId && t.status === 'running')) {
          dispatch({ type: 'SET_ACTIVE_TASK', taskId: prevId });
        }
        return;
      }

      // Cmd+=: switch to last notified tab
      if (key === '=' && !e.shiftKey) {
        e.preventDefault();
        const notifId = state.lastNotifiedTaskId;
        if (notifId && notifId !== state.activeTaskId && state.tasks.some((t) => t.id === notifId && t.status === 'running')) {
          dispatch({ type: 'SET_ACTIVE_TASK', taskId: notifId });
        }
        return;
      }

      switch (key) {
        case 't':
          e.preventDefault();
          dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: !state.showCreateDialog });
          break;

        case 'w': {
          e.preventDefault();
          if (!state.activeTaskId) break;
          const taskId = state.activeTaskId;
          const ps = state.paneStates[taskId] ?? defaultPaneState;

          if (ps.focusedPane === 'dev') {
            // Hide dev pane, focus Claude
            dispatch({ type: 'HIDE_PANE', taskId, pane: 'dev' });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: 'claude' });
          } else {
            // Claude focused — double Cmd+W to close task
            const now = Date.now();
            if (now - lastCmdWRef.current >= DOUBLE_PRESS_MS) {
              lastCmdWRef.current = now;
              dispatch({ type: 'SHOW_TOAST', message: 'Press ⌘W again to stop task' });
              break;
            }
            lastCmdWRef.current = 0;

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
            // Both visible — toggle focus (optionally hide dev pane)
            const newFocus: PaneTarget = ps.focusedPane === 'claude' ? 'dev' : 'claude';
            if (newFocus === 'claude' && state.config?.hideTerminalOnSwitch) {
              dispatch({ type: 'HIDE_PANE', taskId, pane: 'dev' });
            }
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

        case 'l':
          e.preventDefault();
          if (showDiff && diffMode === 'log') {
            dispatch({ type: 'TOGGLE_DIFF' });
          } else {
            dispatch({ type: 'SET_DIFF_MODE', mode: 'log' });
            if (!showDiff) {
              dispatch({ type: 'TOGGLE_DIFF' });
            }
          }
          break;

        case 'k':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' });
          break;

        case ',':
          e.preventDefault();
          dispatch({ type: 'TOGGLE_SETTINGS' });
          break;

        case 'g': {
          e.preventDefault();
          const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
          if (!activeTask) break;
          window.bifrost.getPrUrl(activeTask.id).then((url) => {
            if (url) {
              window.bifrost.openUrl(url);
            } else {
              dispatch({ type: 'SHOW_TOAST', message: 'No PR found for this branch' });
            }
          });
          break;
        }

        case 'o': {
          e.preventDefault();
          const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
          if (!activeTask) break;

          const openFile = async () => {
            // 1. Try DOM text selection (e.g. diff overlay, activity view)
            const domSelection = window.getSelection()?.toString()?.trim();
            if (domSelection) {
              const extracted = extractFilePath(domSelection);
              if (extracted) {
                window.bifrost.openInIde(activeTask.worktreePath, extracted.path, extracted.line);
                return;
              }
            }

            // 2. Try terminal selection
            const ps = state.paneStates[activeTask.id] ?? defaultPaneState;
            const targetSessionId = ps.focusedPane === 'dev' && ps.devSessionId
              ? ps.devSessionId
              : activeTask.sessionId;
            const terminal = terminalRegistry.get(targetSessionId);
            const selection = terminal?.getSelection()?.trim();
            if (selection) {
              const extracted = extractFilePath(selection);
              if (extracted) {
                window.bifrost.openInIde(activeTask.worktreePath, extracted.path, extracted.line);
                return;
              }
            }

            // 3. Fall back to last changed file from activity watcher
            try {
              const lastFile = await window.bifrost.getLastChangedFile(activeTask.id);
              if (lastFile) {
                window.bifrost.openInIde(activeTask.worktreePath, lastFile);
                return;
              }
            } catch {
              // ignore — fall through to worktree
            }

            // 4. Fall back to just opening the worktree
            window.bifrost.openInIde(activeTask.worktreePath);
          };
          openFile();
          break;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state, dispatch]);
}
