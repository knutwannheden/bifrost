import React, { useEffect, useRef } from 'react';
import { useApp, defaultPaneState, getActiveDiffState } from './context/AppContext';
import type { PaneTarget } from './context/AppContext';
import type { BifrostAPI } from '../shared/ipc-channels';
import { useKeyboard } from './hooks/useKeyboard';
import TaskBar from './components/TaskBar';
import TaskView from './components/TaskView';
import StatusBar from './components/StatusBar';
import RepoManager from './components/RepoManager';
import TaskCreateDialog from './components/TaskCreateDialog';
import { modSymbol } from './utils/platform';
import DiffOverlay from './components/DiffOverlay';
import TaskHistoryPanel from './components/TaskHistoryPanel';
import KeyboardShortcutsPanel from './components/KeyboardShortcutsPanel';
import SettingsOverlay from './components/SettingsOverlay';
import PermissionPanel from './components/PermissionPanel';
import RightIconBar from './components/RightIconBar';
import NotificationPopover from './components/NotificationPopover';
import NotesOverlay from './components/NotesOverlay';
import StatsOverlay from './components/StatsOverlay';
import SupervisorOverlay from './components/SupervisorOverlay';
import { requestArchive, performArchive } from './utils/archive';
import { parsePrUrl, parseSlackUrl } from './utils/clipboard-links';
import { slackToPlainText } from './utils/slack-markup';

declare global {
  interface Window {
    bifrost: BifrostAPI;
  }
}

/** Render basic inline markdown: bold, italic, inline code, and newlines. */
function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="whitespace-pre-wrap">
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {i > 0 && <br />}
          {renderInline(line)}
        </React.Fragment>
      ))}
    </div>
  );
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match **bold**, *italic*, `code`
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[2]) parts.push(<strong key={match.index}>{match[2]}</strong>);
    else if (match[3]) parts.push(<em key={match.index}>{match[3]}</em>);
    else if (match[4]) parts.push(<code key={match.index} className="bg-surface-alt px-1 rounded text-xs">{match[4]}</code>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function App() {
  const { state, dispatch } = useApp();

  useKeyboard(state, dispatch);

  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId) ?? null;

  // Buffer last assistant text per task for hook notifications
  const lastAssistantText = useRef(new Map<string, string>());

  // Ref for activeTaskId so the JSONL listener doesn't re-subscribe on tab switch
  const activeTaskIdRef = useRef(state.activeTaskId);
  activeTaskIdRef.current = state.activeTaskId;

  // Mark active task as read when switching to it, and sync to main process
  useEffect(() => {
    window.bifrost.setActiveTaskId(state.activeTaskId);
    if (state.activeTaskId) {
      dispatch({ type: 'SET_TASK_UNREAD', taskId: state.activeTaskId, hasUnread: false });
    }
  }, [state.activeTaskId, dispatch]);

  // Listen for session exit to update task status
  useEffect(() => {
    const unsub = window.bifrost.onSessionExit((sessionId, code) => {
      const task = state.tasks.find((t) => t.sessionId === sessionId);
      if (task && task.status !== 'archived') {
        dispatch({ type: 'SET_TASK_STATUS', taskId: task.id, status: 'stopped' });
        if (code !== 0 && code !== 143) { // 143 = SIGTERM (intentional kill)
          dispatch({ type: 'SHOW_TOAST', message: `${task.name} exited with code ${code}` });
        }
      }
    });
    return unsub;
  }, [state.tasks, dispatch]);

  // Buffer last assistant text per task for hook notifications.
  useEffect(() => {
    const unsub = window.bifrost.onActivityEntry((entry) => {
      if (entry.type === 'claude_event' && entry.claudeEventKind === 'assistant_text' && entry.claudeText) {
        lastAssistantText.current.set(entry.taskId, entry.claudeText);
      }
    });
    return unsub;
  }, [dispatch]);

  // Listen for tasks created via the HTTP API (e.g. from MCP create_task tool)
  useEffect(() => {
    const unsub = window.bifrost.onTaskCreated((task) => {
      dispatch({ type: 'ADD_TASK', task });
      dispatch({ type: 'SET_TASK_UNREAD', taskId: task.id, hasUnread: true });
      dispatch({ type: 'SHOW_TOAST', message: `New task: **${task.name}**` });
    });
    return unsub;
  }, [dispatch]);

  // Listen for hook-based notifications (from Claude Code plugin)
  useEffect(() => {
    const unsub = window.bifrost.onHookNotification(
      (taskId, taskName, message) => {
        if (taskId === state.activeTaskId) return;
        dispatch({ type: 'SET_TASK_UNREAD', taskId, hasUnread: true });
        if (message) {
          // Notification hook provides message directly
          const lines = message.split('\n').slice(0, 3).join('\n');
          const truncated = lines.length < message.length ? lines + '...' : lines;
          dispatch({ type: 'SHOW_TOAST', message: `**${taskName}**\n${truncated}`, duration: 5000, hint: `${modSymbol}= to switch` });
        } else {
          // Stop hook — delay briefly so the activity watcher streams the final entry
          setTimeout(() => {
            const text = lastAssistantText.current.get(taskId) || 'Waiting for input';
            const lines = text.split('\n').slice(0, 3).join('\n');
            const truncated = lines.length < text.length ? lines + '...' : lines;
            dispatch({ type: 'SHOW_TOAST', message: `**${taskName}**\n${truncated}`, duration: 5000, hint: `${modSymbol}= to switch` });
          }, 500);
        }
      },
    );
    return unsub;
  }, [state.activeTaskId, dispatch]);

  // Listen for Slack reactions
  useEffect(() => {
    const unsub = window.bifrost.onSlackReaction((channelId, messageTs, messageUrl, messagePreview) => {
      const notificationId = `slack-${channelId}-${messageTs}`;
      const plainPreview = slackToPlainText(messagePreview);
      // Show toast with Create Task action
      dispatch({
        type: 'SHOW_TOAST',
        message: `Slack: ${plainPreview}`,
        duration: 8000,
        action: {
          label: 'Create Task',
          callback: () => {
            dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
            dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true, slackUrl: messageUrl });
          },
        },
      });

      // Push persistent notification
      dispatch({
        type: 'PUSH_NOTIFICATION',
        notification: {
          id: notificationId,
          type: 'slack-reaction',
          title: 'Slack Reaction',
          message: plainPreview,
          action: { label: 'Create Task', handler: `slack-create-task:${messageUrl}` },
          persistent: true,
          read: false,
          timestamp: Date.now(),
        },
      });
    });
    return unsub;
  }, [dispatch]);

  // Listen for permission prompts from main process
  useEffect(() => {
    const unsub = window.bifrost.onPermissionPrompt((request) => {
      dispatch({ type: 'PUSH_PERMISSION', request });
    });
    return unsub;
  }, [dispatch]);

  // Check for plugin updates on startup
  useEffect(() => {
    window.bifrost.checkIntegration().then(({ updateAvailable }) => {
      if (updateAvailable) {
        dispatch({
          type: 'PUSH_NOTIFICATION',
          notification: {
            id: 'plugin-update',
            type: 'plugin-update',
            title: 'Plugin Update Available',
            message: 'A new version of the Bifrost plugin is available.',
            action: { label: 'Install', handler: 'install-plugin' },
            read: false,
            timestamp: Date.now(),
          },
        });
      }
    }).catch(() => {});
  }, [dispatch]);

  // Detect PR / Slack links on clipboard when window gains focus
  const lastClipboardRef = useRef<string | null>(null);
  useEffect(() => {
    const onFocus = async () => {
      try {
        const text = await window.bifrost.readClipboard();
        if (!text || text === lastClipboardRef.current) return;
        lastClipboardRef.current = text;

        let label: string | undefined;
        if (parseSlackUrl(text)) {
          label = 'Slack message detected';
        } else if (parsePrUrl(text)) {
          const pr = parsePrUrl(text)!;
          label = `PR #${pr.number} detected`;
        }
        if (label) {
          dispatch({
            type: 'SHOW_TOAST',
            message: label,
            duration: 5000,
            action: {
              label: 'Create Task',
              callback: () => dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true }),
            },
          });
        }
      } catch {
        // clipboard read failed — ignore
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [dispatch]);

  // Listen for menu actions from the main process
  useEffect(() => {
    const unsub = window.bifrost.onMenuAction((action) => {
      switch (action) {
        case 'new-task':
          dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true });
          break;
        case 'repositories':
          dispatch({ type: 'TOGGLE_REPO_MANAGER' });
          break;
        case 'diff':
          dispatch({ type: 'TOGGLE_DIFF' });
          break;
        case 'review': {
          const { showDiff: sd, diffMode: dm } = getActiveDiffState(state);
          if (sd && dm === 'review') {
            dispatch({ type: 'TOGGLE_DIFF' });
          } else {
            dispatch({ type: 'SET_DIFF_MODE', mode: 'review' });
            if (!sd) dispatch({ type: 'TOGGLE_DIFF' });
          }
          break;
        }
        case 'task-history':
          dispatch({ type: 'TOGGLE_TASK_HISTORY' });
          break;
        case 'toggle-dev-terminal': {
          if (!state.activeTaskId) break;
          const taskId = state.activeTaskId;
          const ps = state.paneStates[taskId] ?? defaultPaneState;
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
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: newFocus });
          }
          break;
        }
        case 'close-pane': {
          if (!state.activeTaskId) break;
          const taskId = state.activeTaskId;
          const ps = state.paneStates[taskId] ?? defaultPaneState;
          const hiding = ps.focusedPane;
          const otherPane: PaneTarget = hiding === 'claude' ? 'dev' : 'claude';
          const otherHidden = otherPane === 'claude' ? ps.claudeHidden : ps.devHidden;
          const otherExists = otherPane === 'dev' ? !!ps.devSessionId : true;
          if (otherExists && !otherHidden) {
            // Other pane visible — hide focused pane, switch to other
            dispatch({ type: 'HIDE_PANE', taskId, pane: hiding });
            dispatch({ type: 'SET_PANE_FOCUS', taskId, pane: otherPane });
          } else {
            // Other pane hidden or doesn't exist — closing last visible pane stops the task
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
        case 'archive-task': {
          const archiveId = state.activeTaskId;
          if (!archiveId) break;
          const archiveTask = state.tasks.find((t) => t.id === archiveId);
          if (!archiveTask || archiveTask.status === 'archived') break;
          requestArchive(archiveId, archiveTask.name, state, dispatch);
          break;
        }
        case 'quit-confirm':
          dispatch({ type: 'SHOW_TOAST', message: `Press ${modSymbol}Q again to quit` });
          break;
        case 'open-in-ide': {
          const task = state.tasks.find((t) => t.id === state.activeTaskId);
          if (task) {
            // From menu, try last changed file as fallback
            window.bifrost.getLastChangedFile(task.id)
              .then((lastFile) => window.bifrost.openInIde(task.worktreePath, lastFile ?? undefined))
              .catch(() => window.bifrost.openInIde(task.worktreePath));
          }
          break;
        }
      }
    });
    return unsub;
  }, [state, dispatch]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!state.toast) return;
    const timer = setTimeout(() => dispatch({ type: 'HIDE_TOAST' }), state.toastDuration);
    return () => clearTimeout(timer);
  }, [state.toast, state.toastDuration, dispatch]);

  const handleToggleIde = async () => {
    if (!state.config) return;
    const ides: BifrostConfig['ide'][] = ['code', 'idea', 'zed'];
    const newIde = ides[(ides.indexOf(state.config.ide) + 1) % ides.length];
    await window.bifrost.setIde(newIde);
    dispatch({ type: 'SET_CONFIG', config: { ...state.config, ide: newIde } });
  };

  return (
    <div className="flex flex-col h-screen bg-app text-primary">
      {/* Title bar drag area */}
      <div className="h-8 bg-surface border-b border-border-default flex items-center justify-center"
           style={{ WebkitAppRegion: 'drag', paddingLeft: 78 } as React.CSSProperties}>
        <span className="text-xs font-semibold tracking-wide text-faint">BIFROST</span>
      </div>

      {/* Main area: content + right icon bar */}
      <div className="flex flex-1 min-h-0">
        {/* Content column — relative for overlay positioning */}
        <div className="flex flex-col flex-1 min-w-0 relative">
          {/* Task tab bar */}
          <TaskBar />

          {/* Task content area — relative container for content-scoped overlays */}
          <div className="flex-1 min-h-0 relative flex flex-col">
            {/* Main content: terminal */}
            <TaskView />

            {/* Content-scoped overlays (absolute within content area) */}
            <DiffOverlay />
            {state.showSettings && <SettingsOverlay />}
            {state.showRepoManager && <RepoManager />}
            {state.showCreateDialog && <TaskCreateDialog />}
            {state.showTaskHistory && <TaskHistoryPanel />}
            {state.showKeyboardShortcuts && <KeyboardShortcutsPanel />}
            {state.showNotes && <NotesOverlay />}
            {state.showStats && <StatsOverlay />}
            {state.showSupervisor && <SupervisorOverlay />}
          </div>

          {/* Status bar */}
          <StatusBar
            activeTask={activeTask}
            config={state.config}
            repos={state.repos}
            apiPort={state.apiPort}
            onToggleIde={handleToggleIde}
          />
        </div>

        {/* Right icon bar */}
        <RightIconBar />
      </div>

      {/* Permission approval panel */}
      <PermissionPanel />

      {/* Notification popover */}
      <NotificationPopover />

      {/* Archive confirmation dialog */}
      {state.archiveConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' });
            }
          }}
        >
          <div className="bg-surface rounded-lg border border-border-input p-6 w-[400px] shadow-xl">
            <h3 className="text-sm font-semibold text-primary mb-3">Uncommitted Changes</h3>
            <p className="text-sm text-secondary mb-5">
              <span className="font-medium text-primary">{state.archiveConfirm.taskName}</span> has uncommitted changes that will be lost when the worktree is removed.
            </p>
            <div className="flex justify-end gap-3">
              <button
                autoFocus
                onClick={() => dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' })}
                className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { taskId } = state.archiveConfirm!;
                  dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' });
                  performArchive(taskId, state, dispatch);
                }}
                className="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded"
              >
                Force Archive
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {state.toast && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-app/60 backdrop-blur-xl text-primary text-sm rounded-xl shadow-2xl border border-white/10 animate-fade-in max-w-lg">
          <div className="flex items-center gap-3">
            <SimpleMarkdown text={state.toast} />
            {state.toastAction && (
              <button
                onClick={() => {
                  state.toastAction!.callback();
                  dispatch({ type: 'HIDE_TOAST' });
                }}
                className="shrink-0 px-2.5 py-1 bg-accent hover:bg-accent-hover text-white text-xs rounded"
              >
                {state.toastAction.label}
              </button>
            )}
          </div>
          {state.toastHint && (
            <div className="text-right text-xs text-faint mt-1">{state.toastHint}</div>
          )}
        </div>
      )}
    </div>
  );
}
