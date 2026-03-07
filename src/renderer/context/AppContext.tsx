import React, { createContext, useContext, useReducer, useEffect } from 'react';
import type { Repo, Task, BifrostConfig, TaskStatus, PermissionPromptData, AppNotification, ReviewEntry } from '../../shared/types';

export type DiffMode = 'git' | 'activity' | 'log' | 'review';
export type ReviewStatus = 'idle' | 'running' | 'done' | 'error';
export type PaneTarget = 'claude' | 'dev';

export interface TaskPaneState {
  devSessionId: string | null;
  claudeHidden: boolean;
  devHidden: boolean;
  focusedPane: PaneTarget;
  showDiff: boolean;
  diffMode: DiffMode;
}

export interface AppState {
  repos: Repo[];
  tasks: Task[];
  tasksLoaded: boolean;
  activeTaskId: string | null;
  previousActiveTaskId: string | null;
  lastNotifiedTaskId: string | null;
  config: BifrostConfig | null;
  showRepoManager: boolean;
  showCreateDialog: boolean;
  createDialogRepoId: string | null;
  createDialogSlackUrl: string | null;
  showTaskHistory: boolean;
  showKeyboardShortcuts: boolean;
  showSettings: boolean;
  showNotes: boolean;
  showStats: boolean;
  showSupervisor: boolean;
  paneStates: Record<string, TaskPaneState>;
  /** Review markdown content keyed by reviewId */
  reviewContent: Record<string, string>;
  /** Review status keyed by reviewId */
  reviewStatus: Record<string, ReviewStatus>;
  /** Timestamp when the current review started running */
  reviewStartedAt: number | null;
  /** Review entry lists keyed by taskId */
  reviews: Record<string, ReviewEntry[]>;
  /** Active (selected) review ID keyed by taskId */
  activeReviewId: Record<string, string | null>;
  /** Active discussion PTY sessions keyed by taskId */
  reviewDiscussion: Record<string, { ptySessionId: string; reviewId: string }>;
  toast: string | null;
  toastHint: string | null;
  toastDuration: number;
  toastAction: { label: string; callback: () => void } | null;
  permissionQueue: PermissionPromptData[];
  notifications: AppNotification[];
  showNotificationPopover: boolean;
  apiPort: number | null;
  archiveConfirm: { taskId: string; taskName: string } | null;
}

export type AppAction =
  | { type: 'SET_CONFIG'; config: BifrostConfig }
  | { type: 'SET_REPOS'; repos: Repo[] }
  | { type: 'SET_TASKS'; tasks: Task[] }
  | { type: 'ADD_TASK'; task: Task }
  | { type: 'REMOVE_TASK'; taskId: string }
  | { type: 'UPDATE_TASK'; task: Task }
  | { type: 'SET_ACTIVE_TASK'; taskId: string | null }
  | { type: 'SET_TASK_UNREAD'; taskId: string; hasUnread: boolean }
  | { type: 'SET_TASK_STATUS'; taskId: string; status: TaskStatus }
  | { type: 'TOGGLE_REPO_MANAGER' }
  | { type: 'SHOW_CREATE_TASK_DIALOG'; show: boolean; repoId?: string; slackUrl?: string }
  | { type: 'TOGGLE_DIFF' }
  | { type: 'TOGGLE_TASK_HISTORY' }
  | { type: 'TOGGLE_KEYBOARD_SHORTCUTS' }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'TOGGLE_NOTES' }
  | { type: 'TOGGLE_STATS' }
  | { type: 'TOGGLE_SUPERVISOR' }
  | { type: 'SET_DIFF_MODE'; mode: DiffMode }
  | { type: 'SET_DEV_SESSION'; taskId: string; devSessionId: string }
  | { type: 'CLOSE_DEV_SESSION'; taskId: string }
  | { type: 'SET_PANE_FOCUS'; taskId: string; pane: PaneTarget }
  | { type: 'HIDE_PANE'; taskId: string; pane: PaneTarget }
  | { type: 'SHOW_PANE'; taskId: string; pane: PaneTarget }
  | { type: 'SHOW_TOAST'; message: string; duration?: number; hint?: string; action?: { label: string; callback: () => void } }
  | { type: 'HIDE_TOAST' }
  | { type: 'SET_API_PORT'; port: number | null }
  | { type: 'PUSH_PERMISSION'; request: PermissionPromptData }
  | { type: 'SHIFT_PERMISSION' }
  | { type: 'PUSH_NOTIFICATION'; notification: AppNotification }
  | { type: 'DISMISS_NOTIFICATION'; id: string }
  | { type: 'TOGGLE_NOTIFICATION_POPOVER' }
  | { type: 'SET_TASK_SUMMARY'; taskId: string; summary: string }
  | { type: 'SET_REVIEW_STATUS'; reviewId: string; status: ReviewStatus }
  | { type: 'SET_REVIEW_CONTENT'; reviewId: string; content: string }
  | { type: 'SET_REVIEWS'; taskId: string; reviews: ReviewEntry[] }
  | { type: 'ADD_REVIEW'; taskId: string; review: ReviewEntry }
  | { type: 'DELETE_REVIEW'; taskId: string; reviewId: string }
  | { type: 'SET_ACTIVE_REVIEW'; taskId: string; reviewId: string | null }
  | { type: 'UPDATE_REVIEW_SESSION'; taskId: string; reviewId: string; sessionId: string }
  | { type: 'SET_REVIEW_DISCUSSION'; taskId: string; reviewId: string; ptySessionId: string }
  | { type: 'CLEAR_REVIEW_DISCUSSION'; taskId: string }
  | { type: 'REORDER_TASKS'; taskIds: string[] }
  | { type: 'SHOW_ARCHIVE_CONFIRM'; taskId: string; taskName: string }
  | { type: 'HIDE_ARCHIVE_CONFIRM' };

const initialState: AppState = {
  repos: [],
  tasks: [],
  tasksLoaded: false,
  activeTaskId: null,
  previousActiveTaskId: null,
  lastNotifiedTaskId: null,
  config: null,
  showRepoManager: false,
  showCreateDialog: false,
  createDialogRepoId: null,
  createDialogSlackUrl: null,
  showTaskHistory: false,
  showKeyboardShortcuts: false,
  showSettings: false,
  showNotes: false,
  showStats: false,
  showSupervisor: false,
  paneStates: {},
  reviewContent: {},
  reviewStatus: {},
  reviewStartedAt: null,
  reviews: {},
  activeReviewId: {},
  reviewDiscussion: {},
  toast: null,
  toastHint: null,
  toastDuration: 2000,
  toastAction: null,
  permissionQueue: [],
  notifications: [],
  showNotificationPopover: false,
  apiPort: null,
  archiveConfirm: null,
};

export const defaultPaneState: TaskPaneState = {
  devSessionId: null,
  claudeHidden: false,
  devHidden: false,
  focusedPane: 'claude',
  showDiff: false,
  diffMode: 'git',
};

function getPaneState(state: AppState, taskId: string): TaskPaneState {
  return state.paneStates[taskId] ?? defaultPaneState;
}

function setPaneState(state: AppState, taskId: string, ps: TaskPaneState): AppState {
  return { ...state, paneStates: { ...state.paneStates, [taskId]: ps } };
}

function hiddenKey(pane: PaneTarget): 'claudeHidden' | 'devHidden' {
  return pane === 'claude' ? 'claudeHidden' : 'devHidden';
}

/** Close all global overlays — used when toggling one open so only one shows at a time */
const allOverlaysClosed = {
  showRepoManager: false,
  showCreateDialog: false,
  showTaskHistory: false,
  showKeyboardShortcuts: false,
  showSettings: false,
  showNotes: false,
  showStats: false,
  showSupervisor: false,
};

/** Close the active task's diff overlay */
function closeActiveTaskDiff(state: AppState): AppState {
  if (!state.activeTaskId) return state;
  const ps = getPaneState(state, state.activeTaskId);
  if (!ps.showDiff) return state;
  return setPaneState(state, state.activeTaskId, { ...ps, showDiff: false });
}

/** Get diff state for the active task (convenience for consumers) */
export function getActiveDiffState(state: AppState): { showDiff: boolean; diffMode: DiffMode } {
  if (!state.activeTaskId) return { showDiff: false, diffMode: 'git' };
  const ps = state.paneStates[state.activeTaskId] ?? defaultPaneState;
  return { showDiff: ps.showDiff, diffMode: ps.diffMode };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CONFIG':
      return { ...state, config: action.config, repos: action.config.repos };
    case 'SET_REPOS':
      return { ...state, repos: action.repos };
    case 'SET_TASKS': {
      // Restore persisted active task, or auto-select first running task
      const persisted = localStorage.getItem('bifrost:activeTaskId');
      const autoSelect = !state.activeTaskId
        ? (persisted && action.tasks.some((t) => t.id === persisted && t.status !== 'archived')
           ? persisted
           : action.tasks.find((t) => t.status === 'running')?.id
             ?? action.tasks.find((t) => t.status !== 'archived')?.id
             ?? null)
        : state.activeTaskId;
      return { ...state, tasks: action.tasks, tasksLoaded: true, activeTaskId: autoSelect };
    }
    case 'ADD_TASK':
      return { ...state, tasks: [...state.tasks, action.task] };
    case 'REMOVE_TASK': {
      const newTasks = state.tasks.filter((t) => t.id !== action.taskId);
      const activeTasks = newTasks.filter((t) => t.status !== 'archived');
      const newActiveId =
        state.activeTaskId === action.taskId
          ? (activeTasks.length > 0 ? activeTasks[activeTasks.length - 1].id : null)
          : state.activeTaskId;
      return { ...state, tasks: newTasks, activeTaskId: newActiveId };
    }
    case 'UPDATE_TASK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.task.id ? action.task : t,
        ),
      };
    case 'SET_ACTIVE_TASK':
      return {
        ...state,
        activeTaskId: action.taskId,
        previousActiveTaskId: state.activeTaskId !== action.taskId ? state.activeTaskId : state.previousActiveTaskId,
      };
    case 'SET_TASK_UNREAD': {
      const target = state.tasks.find((t) => t.id === action.taskId);
      if (target?.hasUnread === action.hasUnread) return state;
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, hasUnread: action.hasUnread } : t,
        ),
        ...(action.hasUnread && { lastNotifiedTaskId: action.taskId }),
      };
    }
    case 'SET_TASK_STATUS':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, status: action.status } : t,
        ),
      };
    case 'TOGGLE_REPO_MANAGER':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showRepoManager: !state.showRepoManager });
    case 'SHOW_CREATE_TASK_DIALOG':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showCreateDialog: action.show, createDialogRepoId: action.repoId ?? null, createDialogSlackUrl: action.slackUrl ?? null });
    case 'TOGGLE_DIFF': {
      if (!state.activeTaskId) return state;
      const ps = getPaneState(state, state.activeTaskId);
      const opening = !ps.showDiff;
      const base = opening ? { ...state, ...allOverlaysClosed } : state;
      return setPaneState(base, state.activeTaskId, { ...ps, showDiff: opening });
    }
    case 'TOGGLE_TASK_HISTORY':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showTaskHistory: !state.showTaskHistory });
    case 'TOGGLE_KEYBOARD_SHORTCUTS':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showKeyboardShortcuts: !state.showKeyboardShortcuts });
    case 'TOGGLE_SETTINGS':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showSettings: !state.showSettings });
    case 'TOGGLE_NOTES':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showNotes: !state.showNotes });
    case 'TOGGLE_STATS':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showStats: !state.showStats });
    case 'TOGGLE_SUPERVISOR':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showSupervisor: !state.showSupervisor });
    case 'SET_DIFF_MODE': {
      if (!state.activeTaskId) return state;
      const ps = getPaneState(state, state.activeTaskId);
      return setPaneState(state, state.activeTaskId, { ...ps, diffMode: action.mode });
    }
    case 'SET_DEV_SESSION': {
      const ps = getPaneState(state, action.taskId);
      return setPaneState(state, action.taskId, { ...ps, devSessionId: action.devSessionId, devHidden: false, focusedPane: 'dev' });
    }
    case 'CLOSE_DEV_SESSION': {
      const ps = getPaneState(state, action.taskId);
      return setPaneState(state, action.taskId, { ...ps, devSessionId: null, devHidden: false, focusedPane: 'claude' });
    }
    case 'SET_PANE_FOCUS': {
      const ps = getPaneState(state, action.taskId);
      return setPaneState(state, action.taskId, { ...ps, focusedPane: action.pane });
    }
    case 'HIDE_PANE': {
      const ps = getPaneState(state, action.taskId);
      const key = hiddenKey(action.pane);
      return setPaneState(state, action.taskId, { ...ps, [key]: true });
    }
    case 'SHOW_PANE': {
      const ps = getPaneState(state, action.taskId);
      const key = hiddenKey(action.pane);
      return setPaneState(state, action.taskId, { ...ps, [key]: false });
    }
    case 'SHOW_TOAST':
      return { ...state, toast: action.message, toastHint: action.hint ?? null, toastDuration: action.duration ?? 2000, toastAction: action.action ?? null };
    case 'HIDE_TOAST':
      return { ...state, toast: null, toastHint: null, toastAction: null };
    case 'SET_API_PORT':
      return { ...state, apiPort: action.port };
    case 'SET_TASK_SUMMARY':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, summary: action.summary } : t,
        ),
      };
    case 'SET_REVIEW_STATUS':
      return {
        ...state,
        reviewStatus: { ...state.reviewStatus, [action.reviewId]: action.status },
        reviewStartedAt: action.status === 'running' ? (state.reviewStartedAt ?? Date.now()) : action.status === 'done' || action.status === 'idle' ? null : state.reviewStartedAt,
      };
    case 'SET_REVIEW_CONTENT':
      return { ...state, reviewContent: { ...state.reviewContent, [action.reviewId]: action.content } };
    case 'SET_REVIEWS':
      return { ...state, reviews: { ...state.reviews, [action.taskId]: action.reviews } };
    case 'ADD_REVIEW':
      return {
        ...state,
        reviews: {
          ...state.reviews,
          [action.taskId]: [...(state.reviews[action.taskId] ?? []), action.review],
        },
      };
    case 'DELETE_REVIEW': {
      const reviews = (state.reviews[action.taskId] ?? []).filter((r) => r.id !== action.reviewId);
      const activeId = state.activeReviewId[action.taskId];
      return {
        ...state,
        reviews: { ...state.reviews, [action.taskId]: reviews },
        activeReviewId: activeId === action.reviewId
          ? { ...state.activeReviewId, [action.taskId]: reviews.length > 0 ? reviews[reviews.length - 1].id : null }
          : state.activeReviewId,
      };
    }
    case 'SET_ACTIVE_REVIEW':
      return { ...state, activeReviewId: { ...state.activeReviewId, [action.taskId]: action.reviewId } };
    case 'UPDATE_REVIEW_SESSION': {
      const taskReviews = (state.reviews[action.taskId] ?? []).map((r) =>
        r.id === action.reviewId ? { ...r, sessionId: action.sessionId } : r,
      );
      return { ...state, reviews: { ...state.reviews, [action.taskId]: taskReviews } };
    }
    case 'SET_REVIEW_DISCUSSION':
      return { ...state, reviewDiscussion: { ...state.reviewDiscussion, [action.taskId]: { ptySessionId: action.ptySessionId, reviewId: action.reviewId } } };
    case 'CLEAR_REVIEW_DISCUSSION': {
      const { [action.taskId]: _removed, ...rest } = state.reviewDiscussion;
      void _removed;
      return { ...state, reviewDiscussion: rest };
    }
    case 'REORDER_TASKS': {
      const idSet = new Set(action.taskIds);
      const reordered = action.taskIds.map((id) => state.tasks.find((t) => t.id === id)!).filter(Boolean);
      let ri = 0;
      return { ...state, tasks: state.tasks.map((t) => idSet.has(t.id) ? reordered[ri++] : t) };
    }
    case 'PUSH_PERMISSION':
      return { ...state, permissionQueue: [...state.permissionQueue, action.request] };
    case 'SHIFT_PERMISSION':
      return { ...state, permissionQueue: state.permissionQueue.slice(1) };
    case 'PUSH_NOTIFICATION':
      if (state.notifications.some((n) => n.type === action.notification.type && n.type !== 'info')) {
        return state;
      }
      return { ...state, notifications: [...state.notifications, action.notification] };
    case 'DISMISS_NOTIFICATION':
      return { ...state, notifications: state.notifications.filter((n) => n.id !== action.id) };
    case 'TOGGLE_NOTIFICATION_POPOVER': {
      const opening = !state.showNotificationPopover;
      return {
        ...state,
        showNotificationPopover: opening,
        notifications: opening ? state.notifications.map((n) => ({ ...n, read: true })) : state.notifications,
      };
    }
    case 'SHOW_ARCHIVE_CONFIRM':
      return { ...state, archiveConfirm: { taskId: action.taskId, taskName: action.taskName } };
    case 'HIDE_ARCHIVE_CONFIRM':
      return { ...state, archiveConfirm: null };
    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}>({ state: initialState, dispatch: () => { /* default no-op */ } });

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => {
    window.bifrost.loadConfig().then((config) => {
      dispatch({ type: 'SET_CONFIG', config });
    });
    window.bifrost.getApiPort().then((port) => {
      dispatch({ type: 'SET_API_PORT', port });
    });
    window.bifrost.listTasks().then((tasks) => {
      dispatch({ type: 'SET_TASKS', tasks });
    });

    const unsubSummary = window.bifrost.onTaskSummary((taskId, summary) => {
      dispatch({ type: 'SET_TASK_SUMMARY', taskId, summary });
    });
    return () => { unsubSummary(); };
  }, []);

  // Persist active task selection across restarts
  useEffect(() => {
    if (!state.tasksLoaded) return; // Don't clear before tasks load
    if (state.activeTaskId) {
      localStorage.setItem('bifrost:activeTaskId', state.activeTaskId);
    } else {
      localStorage.removeItem('bifrost:activeTaskId');
    }
  }, [state.activeTaskId, state.tasksLoaded]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
