import React, { useEffect, useRef } from 'react';
import type { BifrostAPI } from '../shared/ipc-channels';
import type { BifrostConfig } from '../shared/types';
import ActionLabel from './components/ActionLabel';
import ChangeFeedPanel from './components/ChangeFeedPanel';
import ConsoleOverlay from './components/ConsoleOverlay';
import DiffOverlay from './components/DiffOverlay';
import KeyboardShortcutsPanel from './components/KeyboardShortcutsPanel';
import NotesOverlay from './components/NotesOverlay';
import NotificationPopover from './components/NotificationPopover';
import PermissionPanel from './components/PermissionPanel';
import PrimaryButton from './components/PrimaryButton';
import RepoManager from './components/RepoManager';
import RightIconBar from './components/RightIconBar';
import SettingsOverlay from './components/SettingsOverlay';
import SimpleMarkdown from './components/SimpleMarkdown';
import StatsOverlay from './components/StatsOverlay';
import StatusBar from './components/StatusBar';
import TaskCreateDialog from './components/TaskCreateDialog';
import TaskHistoryPanel from './components/TaskHistoryPanel';
import TaskSidebar from './components/TaskSidebar';
import TaskView from './components/TaskView';
import type { AppAction, AppState, PaneTarget } from './context/AppContext';
import { defaultPaneState, useApp } from './context/AppContext';
import { KeymapProvider } from './context/KeymapContext';
import { useKeymapEngine } from './hooks/useKeymapEngine';
import { lockTerminalInput, unlockTerminalInput } from './hooks/useTerminal';
import { useTheme } from './hooks/useTheme';
import { performArchive, requestArchive } from './utils/archive';
import { parseIssueUrl, parsePrUrl, parseSlackUrl } from './utils/clipboard-links';
import { formatBytes } from './utils/format-bytes';
import { nextActiveTaskId } from './utils/next-active-task';
import { modSymbol } from './utils/platform';
import { scrapePartialPrompt } from './utils/scrape-prompt';
import { slackToPlainText } from './utils/slack-markup';

declare global {
  interface Window {
    bifrost: BifrostAPI;
  }
}

/** Rendered inside KeymapProvider so useKeymapEngine can read resolved keymap via context */
function KeymapEngineHost({ state, dispatch }: { state: AppState; dispatch: React.Dispatch<AppAction> }) {
  useKeymapEngine(state, dispatch);
  return null;
}

export default function App() {
  const { state, dispatch } = useApp();

  useTheme();

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
        dispatch({ type: 'SET_CLAUDE_ACTIVE', taskId: task.id, active: false });
        if (code !== 0 && code !== 143) {
          // 143 = SIGTERM (intentional kill)
          dispatch({ type: 'SHOW_TOAST', message: `${task.name} exited with code ${code}` });
        }
      }
    });
    return unsub;
  }, [state.tasks, dispatch]);

  // Listen for Claude active/inactive signals
  useEffect(() => {
    const unsub = window.bifrost.onClaudeActive((taskId, active) => {
      dispatch({ type: 'SET_CLAUDE_ACTIVE', taskId, active });
    });
    return unsub;
  }, [dispatch]);

  useEffect(() => {
    const unsub = window.bifrost.onTaskTurnBoundary((taskId, at) => {
      dispatch({ type: 'SET_TURN_BOUNDARY', taskId, at });
    });
    return unsub;
  }, [dispatch]);

  // Handle scrape-prompt requests from main process (prompt-sender).
  // Lock terminal input during the send to prevent user keystrokes from interfering.
  useEffect(() => {
    const unsubScrape = window.bifrost.onScrapePromptRequest((taskId, requestId) => {
      lockTerminalInput(taskId);
      const text = scrapePartialPrompt(taskId);
      window.bifrost.scrapePromptResponse(requestId, text);
    });
    const unsubUnlock = window.bifrost.onTerminalUnlock((taskId) => {
      unlockTerminalInput(taskId);
    });
    return () => {
      unsubScrape();
      unsubUnlock();
    };
  }, []);

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

  // Listen for toast messages from main process
  useEffect(() => {
    const unsub = window.bifrost.onToast((message, duration) => {
      dispatch({ type: 'SHOW_TOAST', message, duration });
    });
    return unsub;
  }, [dispatch]);

  // Repos change from outside the window too — the MCP add_repo tool writes one
  // straight to the config the dialog reads from.
  useEffect(() => {
    const unsub = window.bifrost.onReposChanged((repos) => {
      dispatch({ type: 'SET_REPOS', repos });
    });
    return unsub;
  }, [dispatch]);

  // A reclaim scan finishing is the only thing that raises this notification;
  // the scan itself is scheduled in the main process.
  useEffect(() => {
    const unsub = window.bifrost.onDiskReclaimReady((scan) => {
      dispatch({ type: 'SET_DISK_RECLAIM', scan });
      dispatch({
        type: 'PUSH_NOTIFICATION',
        notification: {
          id: 'disk-reclaim',
          type: 'disk-reclaim',
          title: `Reclaim ${formatBytes(scan.totalKb * 1024)}`,
          message: `${scan.candidates.length} worktree${scan.candidates.length > 1 ? 's are' : ' is'} clean, pushed and idle. Branches and commits are kept.`,
          action: { label: `Free ${formatBytes(scan.totalKb * 1024)}`, handler: 'free-disk' },
          read: false,
          timestamp: Date.now(),
        },
      });
    });
    return unsub;
  }, [dispatch]);

  // Listen for tasks closed/archived via the HTTP API (e.g. from MCP close_task tool)
  useEffect(() => {
    const unsub = window.bifrost.onTaskClosed((taskId, archived) => {
      if (archived) {
        const task = state.tasks.find((t) => t.id === taskId);
        if (task) {
          dispatch({ type: 'UPDATE_TASK', task: { ...task, status: 'archived', archivedAt: Date.now() } });
        }
      } else {
        dispatch({ type: 'SET_TASK_STATUS', taskId, status: 'stopped' });
      }
    });
    return unsub;
  }, [dispatch, state.tasks]);

  // Listen for hook-based notifications (from Claude Code plugin)
  useEffect(() => {
    const unsub = window.bifrost.onHookNotification((taskId, taskName, message, _title, notificationType) => {
      dispatch({ type: 'SET_CLAUDE_ACTIVE', taskId, active: false });
      if (taskId === state.activeTaskId) return;
      dispatch({ type: 'SET_TASK_UNREAD', taskId, hasUnread: true, failed: notificationType === 'stop_failure' });
      if (message) {
        // Notification hook provides message directly
        const lines = message.split('\n').slice(0, 3).join('\n');
        const truncated = lines.length < message.length ? `${lines}...` : lines;
        dispatch({
          type: 'SHOW_TOAST',
          message: `**${taskName}**\n${truncated}`,
          duration: 5000,
          hint: `${modSymbol}= to switch`,
        });
      } else {
        // Stop hook — delay briefly so the activity watcher streams the final entry
        setTimeout(() => {
          const text = lastAssistantText.current.get(taskId) || 'Waiting for input';
          const lines = text.split('\n').slice(0, 3).join('\n');
          const truncated = lines.length < text.length ? `${lines}...` : lines;
          dispatch({
            type: 'SHOW_TOAST',
            message: `**${taskName}**\n${truncated}`,
            duration: 5000,
            hint: `${modSymbol}= to switch`,
          });
        }, 500);
      }
    });
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
    window.bifrost
      .checkIntegration()
      .then(({ updateAvailable }) => {
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
      })
      .catch(() => {});
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
        } else if (parseIssueUrl(text)) {
          const issue = parseIssueUrl(text)!;
          label = `Issue #${issue.number} detected`;
        }
        if (label) {
          dispatch({
            type: 'SHOW_TOAST',
            message: label,
            duration: 5000,
            action: [
              {
                label: 'Create Task',
                callback: () => dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true }),
              },
              {
                label: 'Console',
                callback: () => dispatch({ type: 'SHOW_CONSOLE' }),
              },
            ],
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
              dispatch({ type: 'SET_ACTIVE_TASK', taskId: nextActiveTaskId(state, taskId) });
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
            window.bifrost
              .getLastChangedFile(task.id)
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

  // Track tab recency — only mark as active after a 200ms dwell
  // so rapid Cmd+Shift+[/] cycling doesn't mark every tab
  useEffect(() => {
    if (!state.activeTaskId) return;
    const taskId = state.activeTaskId;
    const timer = setTimeout(() => {
      dispatch({ type: 'MARK_TAB_ACTIVE', taskId });
    }, 200);
    return () => clearTimeout(timer);
  }, [state.activeTaskId, dispatch]);

  // Show zoom level toast
  useEffect(() => {
    const unsub = window.bifrost.onZoomChanged((pct) => {
      dispatch({ type: 'SHOW_TOAST', message: `Zoom: ${pct}%`, duration: 1500 });
    });
    return unsub;
  }, [dispatch]);

  // Alt+letter shortcuts for toast action buttons (use e.code for macOS compatibility)
  useEffect(() => {
    if (!state.toastAction?.length) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const match = state.toastAction?.find((a) => `Key${a.label[0].toUpperCase()}` === e.code);
      if (match) {
        e.preventDefault();
        match.callback();
        dispatch({ type: 'HIDE_TOAST' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state.toastAction, dispatch]);

  const handleToggleIde = async () => {
    if (!state.config) return;
    const ides: BifrostConfig['ide'][] = ['code', 'idea', 'zed'];
    const newIde = ides[(ides.indexOf(state.config.ide) + 1) % ides.length];
    await window.bifrost.setIde(newIde);
    dispatch({ type: 'SET_CONFIG', config: { ...state.config, ide: newIde } });
  };

  return (
    <KeymapProvider config={state.config}>
      <KeymapEngineHost state={state} dispatch={dispatch} />
      <div className="flex flex-col h-screen bg-app text-primary">
        {/* Title bar drag area */}
        <div
          className="h-8 bg-surface border-b border-border-default flex items-center justify-center"
          style={{ WebkitAppRegion: 'drag', paddingLeft: 78 } as React.CSSProperties}
        >
          <span className="text-xs font-semibold tracking-wide text-faint">BIFROST</span>
        </div>

        {/* Main area: content + right icon bar */}
        <div className="flex flex-1 min-h-0">
          {!state.config?.sidebarHidden && <TaskSidebar />}
          {/* Content column — relative for overlay positioning */}
          <div className="flex flex-col flex-1 min-w-0 relative">
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
              {state.showConsole && <ConsoleOverlay />}
            </div>

            {/* Status bar */}
            <StatusBar activeTask={activeTask} config={state.config} onToggleIde={handleToggleIde} />
          </div>

          <ChangeFeedPanel />

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
            className="fixed inset-0 z-50 flex items-center justify-center bg-overlay focus:outline-hidden"
            tabIndex={-1}
            ref={(el) => el?.focus()}
            onClick={() => dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' });
              }
              if (e.altKey && e.code === 'KeyC') {
                e.preventDefault();
                dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' });
              }
              if (e.altKey && e.code === 'KeyA') {
                e.preventDefault();
                const { taskId } = state.archiveConfirm!;
                dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' });
                performArchive(taskId, state, dispatch);
              }
            }}
          >
            <div
              className="bg-surface rounded-lg border border-border-input p-6 w-[400px] shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-semibold text-primary mb-3">Uncommitted Changes</h3>
              <p className="text-sm text-secondary mb-5">
                <span className="font-medium text-primary">{state.archiveConfirm.taskName}</span> has uncommitted
                changes that will be lost when the worktree is removed.
              </p>
              <div className="flex items-center gap-3">
                <span className="text-xs text-faint flex-1">Esc cancel</span>
                <PrimaryButton autoFocus onClick={() => dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' })} className="px-4">
                  <ActionLabel text="Cancel" showHint />
                </PrimaryButton>
                <button
                  onClick={() => {
                    const { taskId } = state.archiveConfirm!;
                    dispatch({ type: 'HIDE_ARCHIVE_CONFIRM' });
                    performArchive(taskId, state, dispatch);
                  }}
                  className="px-4 py-1.5 text-sm bg-danger/80 hover:bg-danger text-white rounded-sm transition-colors"
                >
                  Force <ActionLabel text="Archive" showHint />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast notification */}
        {state.toast && (
          <div className="fixed top-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-app/60 backdrop-blur-xl text-primary text-sm rounded-lg shadow-2xl border border-border-input animate-fade-in max-w-lg">
            <div className="flex items-center gap-3">
              <SimpleMarkdown text={state.toast} />
              {state.toastAction?.map((a, i) => (
                <PrimaryButton
                  key={i}
                  size="sm"
                  onClick={() => {
                    a.callback();
                    dispatch({ type: 'HIDE_TOAST' });
                  }}
                  className="shrink-0"
                >
                  <ActionLabel text={a.label} showHint={true} />
                </PrimaryButton>
              ))}
            </div>
            {state.toastHint && <div className="text-right text-xs text-faint mt-1">{state.toastHint}</div>}
          </div>
        )}
      </div>
    </KeymapProvider>
  );
}
