import { useCallback, useEffect, useRef } from 'react';
import { ACTION_REGISTRY, type KeyBinding, strokeMatchesEvent } from '../../shared/keymap';
import type { CaptureContextParams } from '../../shared/types';
import type { AppAction, AppState, PaneTarget } from '../context/AppContext';
import { defaultPaneState, getActiveDiffState, isAnyOverlayOpen } from '../context/AppContext';
import { useKeymap } from '../context/KeymapContext';
import { requestArchive } from '../utils/archive';
import { isMac, isModKey, modSymbol, shiftSymbol } from '../utils/platform';
import { terminalRegistry } from './useTerminal';

const RECORD_SYMBOL = '\u23FA'; // ⏺
const DOUBLE_PRESS_MS = 500;
const CHORD_TIMEOUT_MS = 1500;

function extractFilePath(text: string): { path: string; line?: number } | null {
  let trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n')) return null;

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`')) ||
    (trimmed.startsWith('(') && trimmed.endsWith(')'))
  ) {
    trimmed = trimmed.slice(1, -1);
  }

  const match = trimmed.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (match) {
    return { path: match[1], line: Number.parseInt(match[2], 10) };
  }

  if (/[/.]/.test(trimmed) && !/\s/.test(trimmed)) {
    return { path: trimmed };
  }

  return null;
}

interface TerminalCapture {
  content: string;
  hasSelection: boolean;
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

  const transcriptText = findTranscriptText(terminal, hasSelection);
  return { content, hasSelection, transcriptText };
}

function findTranscriptText(terminal: import('@xterm/xterm').Terminal, hasSelection: boolean): string | null {
  const buffer = terminal.buffer.active;

  let endRow: number;
  if (hasSelection) {
    const selRange = terminal.getSelectionPosition();
    endRow = selRange ? selRange.end.y : buffer.cursorY + buffer.viewportY;
  } else {
    endRow = buffer.cursorY + buffer.viewportY;
  }

  const startRow = Math.max(0, endRow - 200);

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

  const lines: string[] = [];
  for (let row = recordRow; row <= endRow; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    let text = line.translateToString(true);
    if (row === recordRow) {
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

interface ChordState {
  firstStroke: KeyBinding[];
  timeoutId: ReturnType<typeof setTimeout>;
}

function formatStrokeDisplay(stroke: { mod?: boolean; shift?: boolean; key: string }): string {
  const parts: string[] = [];
  if (stroke.mod) parts.push(modSymbol);
  if (stroke.shift) parts.push(shiftSymbol);
  parts.push(stroke.key.toUpperCase());
  return parts.join('');
}

export function useKeymapEngine(state: AppState, dispatch: React.Dispatch<AppAction>) {
  const { keymap } = useKeymap();
  const doublePressTimers = useRef(new Map<string, number>());
  const chordStateRef = useRef<ChordState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;

  const executeAction = useCallback(
    (actionId: string) => {
      const s = stateRef.current;
      const { showDiff, diffMode } = getActiveDiffState(s);

      switch (actionId) {
        case 'task.new':
          dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: !s.showCreateDialog });
          break;

        case 'task.close': {
          if (!s.activeTaskId) break;
          const taskId = s.activeTaskId;
          const ps = s.paneStates[taskId] ?? defaultPaneState;

          if (ps.focusedPane === 'dev') {
            dispatch({ type: 'HIDE_PANE', taskId, pane: 'dev' });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: 'claude' });
          } else {
            if (ps.devSessionId) {
              window.bifrost.closeDevTerminal(taskId);
              dispatch({ type: 'CLOSE_DEV_SESSION', taskId });
            }
            window.bifrost.stopTask(taskId).then((updated) => {
              dispatch({ type: 'UPDATE_TASK', task: updated });
              const remaining = s.tasks.filter((t) => t.id !== taskId && t.status === 'running');
              dispatch({
                type: 'SET_ACTIVE_TASK',
                taskId: remaining.length > 0 ? remaining[remaining.length - 1].id : null,
              });
            });
          }
          break;
        }

        case 'task.rename': {
          if (!s.activeTaskId) break;
          dispatch({ type: 'START_RENAME_TASK', taskId: s.activeTaskId });
          break;
        }

        case 'task.archive': {
          const taskId = s.activeTaskId;
          if (!taskId) break;
          const task = s.tasks.find((t) => t.id === taskId);
          if (!task || task.status === 'archived') break;
          requestArchive(taskId, task.name, s, dispatch);
          break;
        }

        case 'nav.prevTab':
        case 'nav.nextTab': {
          const openTasks = s.tasks.filter((t) => t.status === 'running');
          if (openTasks.length === 0) break;
          const currentIdx = openTasks.findIndex((t) => t.id === s.activeTaskId);
          let newIdx: number;
          if (actionId === 'nav.prevTab') {
            newIdx = currentIdx <= 0 ? openTasks.length - 1 : currentIdx - 1;
          } else {
            newIdx = currentIdx >= openTasks.length - 1 ? 0 : currentIdx + 1;
          }
          dispatch({ type: 'SET_ACTIVE_TASK', taskId: openTasks[newIdx].id });
          break;
        }

        case 'nav.tab1':
        case 'nav.tab2':
        case 'nav.tab3':
        case 'nav.tab4':
        case 'nav.tab5':
        case 'nav.tab6':
        case 'nav.tab7':
        case 'nav.tab8':
        case 'nav.tab9': {
          const openTasks = s.tasks.filter((t) => t.status === 'running');
          const index = Number.parseInt(actionId.slice(-1), 10) - 1;
          if (index < openTasks.length) {
            dispatch({ type: 'SET_ACTIVE_TASK', taskId: openTasks[index].id });
          }
          break;
        }

        case 'nav.lastActive': {
          const prevId = s.previousActiveTaskId;
          if (prevId && s.tasks.some((t) => t.id === prevId && t.status === 'running')) {
            dispatch({ type: 'SET_ACTIVE_TASK', taskId: prevId });
          }
          break;
        }

        case 'nav.lastNotified': {
          const notifId = s.lastNotifiedTaskId;
          if (
            notifId &&
            notifId !== s.activeTaskId &&
            s.tasks.some((t) => t.id === notifId && t.status === 'running')
          ) {
            dispatch({ type: 'SET_ACTIVE_TASK', taskId: notifId });
          }
          break;
        }

        case 'view.devTerminal': {
          if (!s.activeTaskId) break;
          const taskId = s.activeTaskId;
          const ps = s.paneStates[taskId] ?? defaultPaneState;

          if (!ps.devSessionId) {
            window.bifrost.createDevTerminal(taskId).then((devSessionId) => {
              dispatch({ type: 'SET_DEV_SESSION', taskId, devSessionId });
            });
          } else if (ps.claudeHidden) {
            dispatch({ type: 'SHOW_PANE', taskId, pane: 'claude' });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: 'claude' });
          } else if (ps.devHidden) {
            dispatch({ type: 'SHOW_PANE', taskId, pane: 'dev' });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: 'dev' });
          } else {
            const newFocus: PaneTarget = ps.focusedPane === 'claude' ? 'dev' : 'claude';
            if (newFocus === 'claude' && s.config?.hideTerminalOnSwitch) {
              dispatch({ type: 'HIDE_PANE', taskId, pane: 'dev' });
            }
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: newFocus });
          }
          break;
        }

        case 'view.diff':
          dispatch({ type: 'TOGGLE_DIFF' });
          break;

        case 'view.log':
          if (showDiff && diffMode === 'log') {
            dispatch({ type: 'TOGGLE_DIFF' });
          } else {
            dispatch({ type: 'SET_DIFF_MODE', mode: 'log' });
            if (!showDiff) dispatch({ type: 'TOGGLE_DIFF' });
          }
          break;

        case 'view.history':
          dispatch({ type: 'TOGGLE_TASK_HISTORY' });
          break;

        case 'view.repos':
          dispatch({ type: 'TOGGLE_REPO_MANAGER' });
          break;

        case 'view.review':
          if (showDiff && diffMode === 'review') {
            dispatch({ type: 'TOGGLE_DIFF' });
          } else {
            dispatch({ type: 'SET_DIFF_MODE', mode: 'review' });
            if (!showDiff) dispatch({ type: 'TOGGLE_DIFF' });
          }
          break;

        case 'view.notes':
          dispatch({ type: 'TOGGLE_NOTES' });
          break;

        case 'view.triage':
          if (s.showTriage) {
            dispatch({ type: 'CLOSE_TRIAGE' });
          } else {
            dispatch({ type: 'SHOW_TRIAGE' });
          }
          break;

        case 'view.notifications':
          dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' });
          break;

        case 'view.stats':
          dispatch({ type: 'TOGGLE_STATS' });
          break;

        case 'view.supervisor':
          dispatch({ type: 'TOGGLE_SUPERVISOR' });
          break;

        case 'view.activity':
          if (showDiff && diffMode === 'activity') {
            dispatch({ type: 'TOGGLE_DIFF' });
          } else {
            dispatch({ type: 'SET_DIFF_MODE', mode: 'activity' });
            if (!showDiff) dispatch({ type: 'TOGGLE_DIFF' });
          }
          break;

        case 'action.openIde': {
          const activeTask = s.tasks.find((t) => t.id === s.activeTaskId);
          if (!activeTask) break;

          const openFile = async () => {
            const domSelection = window.getSelection()?.toString()?.trim();
            if (domSelection) {
              const extracted = extractFilePath(domSelection);
              if (extracted) {
                window.bifrost.openInIde(activeTask.worktreePath, extracted.path, extracted.line);
                return;
              }
            }

            const ps = s.paneStates[activeTask.id] ?? defaultPaneState;
            const targetSessionId =
              ps.focusedPane === 'dev' && ps.devSessionId ? ps.devSessionId : activeTask.sessionId;
            const terminal = terminalRegistry.get(targetSessionId);
            const selection = terminal?.getSelection()?.trim();
            if (selection) {
              const extracted = extractFilePath(selection);
              if (extracted) {
                window.bifrost.openInIde(activeTask.worktreePath, extracted.path, extracted.line);
                return;
              }
            }

            try {
              const lastFile = await window.bifrost.getLastChangedFile(activeTask.id);
              if (lastFile) {
                window.bifrost.openInIde(activeTask.worktreePath, lastFile);
                return;
              }
            } catch {
              // ignore — fall through to worktree
            }

            window.bifrost.openInIde(activeTask.worktreePath);
          };
          openFile();
          break;
        }

        case 'action.openPr': {
          const activeTask = s.tasks.find((t) => t.id === s.activeTaskId);
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

        case 'action.find':
          // Handled locally by TerminalPane — no-op here
          break;

        case 'action.capture': {
          const activeTask = s.tasks.find((t) => t.id === s.activeTaskId);
          if (!activeTask) break;

          const capture = async () => {
            let params: CaptureContextParams | null = null;
            const taskMeta = { taskId: activeTask.id, taskName: activeTask.name };

            if (showDiff) {
              const domSelection = window.getSelection()?.toString()?.trim();
              if (domSelection) {
                params = {
                  type: diffMode === 'review' ? 'activity' : (diffMode as 'diff' | 'activity'),
                  content: domSelection,
                  ...taskMeta,
                };
              } else if (diffMode === 'git') {
                const diff = await window.bifrost.getDiff(activeTask.id);
                const content = diff.diff;
                if (!content?.trim()) return;
                params = { type: 'diff', content, ...taskMeta };
              } else if (diffMode === 'review') {
                const content = s.reviewContent[activeTask.id];
                if (!content?.trim()) return;
                params = { type: 'activity', content, ...taskMeta };
              } else {
                const entries = await window.bifrost.getActivityLog(activeTask.id);
                const content = entries
                  .map((e) => {
                    if (e.type === 'commit') return `[commit] ${e.commitMessage}`;
                    if (e.type === 'file_change') return `[file] ${e.filePath}\n${e.diff || ''}`;
                    if (e.type === 'claude_event') return `[${e.claudeEventKind}] ${e.claudeText || ''}`;
                    return `[${e.type}]`;
                  })
                  .join('\n\n');
                if (!content.trim()) return;
                params = { type: 'activity', content, ...taskMeta };
              }
            } else {
              const ps = s.paneStates[activeTask.id] ?? defaultPaneState;
              const targetSessionId =
                ps.focusedPane === 'dev' && ps.devSessionId ? ps.devSessionId : activeTask.sessionId;
              const cap = getTerminalCapture(targetSessionId);
              if (!cap) return;

              if (cap.transcriptText) {
                const match = await window.bifrost.findTranscriptMatch(
                  activeTask.worktreePath,
                  cap.transcriptText.slice(0, 500),
                );
                if (match) {
                  params = {
                    type: 'transcript',
                    content: cap.content,
                    jsonlPath: match.jsonlPath,
                    lineNumber: match.lineNumber,
                    uuid: match.uuid,
                    selectedText: cap.hasSelection ? cap.content : undefined,
                    ...taskMeta,
                  };
                }
              }

              if (!params) {
                params = {
                  type: 'terminal',
                  content: cap.content,
                  hasSelection: cap.hasSelection,
                  ...taskMeta,
                };
              }
            }

            const id = await window.bifrost.captureContext(params);
            dispatch({ type: 'SHOW_TOAST', message: `[Bifrost #${id}] copied` });
          };
          capture();
          break;
        }

        case 'app.shortcuts':
          dispatch({ type: 'TOGGLE_KEYBOARD_SHORTCUTS' });
          break;

        case 'app.settings':
          dispatch({ type: 'TOGGLE_SETTINGS' });
          break;
      }
    },
    [dispatch],
  );

  const handleActionWithDoubleConfirm = useCallback(
    (actionId: string) => {
      const actionDef = ACTION_REGISTRY[actionId];
      if (actionDef?.doubleConfirm) {
        const now = Date.now();
        const lastPress = doublePressTimers.current.get(actionId) ?? 0;
        if (now - lastPress >= DOUBLE_PRESS_MS) {
          doublePressTimers.current.set(actionId, now);
          const binding = keymapRef.current.find((b) => b.actionId === actionId);
          if (binding) {
            const display = formatStrokeDisplay(binding.strokes[0]);
            dispatch({
              type: 'SHOW_TOAST',
              message: `Press ${display} again to ${actionDef.label.toLowerCase()}`,
            });
          }
          return;
        }
        doublePressTimers.current.set(actionId, 0);
      }
      executeAction(actionId);
    },
    [executeAction, dispatch],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isModKey(e)) {
        // If we're in chord-pending state and user presses a non-mod key, check second stroke
        const chord = chordStateRef.current;
        if (chord) {
          clearTimeout(chord.timeoutId);
          chordStateRef.current = null;

          for (const binding of chord.firstStroke) {
            if (binding.strokes.length >= 2 && strokeMatchesEvent(binding.strokes[1], e)) {
              e.preventDefault();
              handleActionWithDoubleConfirm(binding.actionId);
              return;
            }
          }
          dispatch({ type: 'SHOW_TOAST', message: 'Chord cancelled' });
          return;
        }
        return;
      }

      // Cancel any pending chord on a new mod key press
      if (chordStateRef.current) {
        clearTimeout(chordStateRef.current.timeoutId);
        chordStateRef.current = null;
      }

      // Skip shortcuts when typing in an overlay input/textarea/select
      const target = e.target as HTMLElement;
      const inOverlayInput =
        isAnyOverlayOpen(stateRef.current) &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (inOverlayInput) return;

      const key = e.key.toLowerCase();
      const s = stateRef.current;

      // On Linux, let readline shortcuts reach the focused dev terminal
      if (!isMac && s.activeTaskId) {
        const activePs = s.paneStates[s.activeTaskId] ?? defaultPaneState;
        if (activePs.focusedPane === 'dev' && activePs.devSessionId && 'adrhkl'.includes(key)) {
          return;
        }
      }

      // Find all bindings whose first stroke matches
      const currentKeymap = keymapRef.current;
      const matchingBindings = currentKeymap.filter((b) => strokeMatchesEvent(b.strokes[0], e));
      if (matchingBindings.length === 0) return;

      // Cmd+Shift+C: skip if already handled by DiffOverlay
      if (matchingBindings.length === 1 && matchingBindings[0].actionId === 'action.capture' && e.defaultPrevented) {
        return;
      }

      e.preventDefault();

      // Separate single-stroke and chord (multi-stroke) matches
      const singleStroke = matchingBindings.filter((b) => b.strokes.length === 1);
      const chordPrefixes = matchingBindings.filter((b) => b.strokes.length > 1);

      // Chord prefix wins over single-stroke (VS Code behavior)
      if (chordPrefixes.length > 0) {
        const timeoutId = setTimeout(() => {
          chordStateRef.current = null;
          dispatch({ type: 'SHOW_TOAST', message: 'Chord timed out' });
        }, CHORD_TIMEOUT_MS);
        chordStateRef.current = { firstStroke: chordPrefixes, timeoutId };
        const display = formatStrokeDisplay(chordPrefixes[0].strokes[0]);
        dispatch({ type: 'SHOW_TOAST', message: `${display} …`, duration: CHORD_TIMEOUT_MS });
        return;
      }

      // Execute single-stroke binding
      if (singleStroke.length > 0) {
        handleActionWithDoubleConfirm(singleStroke[0].actionId);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch, handleActionWithDoubleConfirm]);
}
