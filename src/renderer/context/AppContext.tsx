import React, { createContext, useContext, useEffect, useReducer } from 'react';
import type {
  AppNotification,
  BifrostConfig,
  PermissionPromptData,
  Repo,
  ReviewEntry,
  Task,
  TaskStatus,
  TriageEntry,
} from '../../shared/types';

export type DiffMode = 'git' | 'activity' | 'log' | 'review';
export type ReviewStatus = 'idle' | 'running' | 'done' | 'error';
export type PaneTarget = 'claude' | 'dev';
export type TriageTab = 'new' | 'history';

export interface TriageItem {
  prompt: string;
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  ptySessionId: string | null;
  activity: string[];
  waiting: boolean;
  expanded: boolean;
}

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
  /** Tasks with a review that completed but hasn't been viewed yet */
  unreadReview: Record<string, boolean>;
  toast: string | null;
  toastHint: string | null;
  toastDuration: number;
  toastAction: { label: string; callback: () => void }[] | null;
  permissionQueue: PermissionPromptData[];
  showTriage: boolean;
  triages: Record<string, TriageItem>;
  triageDraftPrompt: string;
  triageTab: TriageTab;
  triageHistory: TriageEntry[];
  notifications: AppNotification[];
  showNotificationPopover: boolean;
  apiPort: number | null;
  archiveConfirm: { taskId: string; taskName: string } | null;
  renamingTaskId: string | null;
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
  | {
      type: 'SHOW_TOAST';
      message: string;
      duration?: number;
      hint?: string;
      action?: { label: string; callback: () => void } | { label: string; callback: () => void }[];
    }
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
  | { type: 'MARK_REVIEW_UNREAD'; taskId: string }
  | { type: 'CLEAR_REVIEW_UNREAD'; taskId: string }
  | { type: 'REORDER_TASKS'; taskIds: string[] }
  | { type: 'SHOW_ARCHIVE_CONFIRM'; taskId: string; taskName: string }
  | { type: 'HIDE_ARCHIVE_CONFIRM' }
  | { type: 'SHOW_TRIAGE'; prompt?: string }
  | { type: 'CLOSE_TRIAGE' }
  | { type: 'SET_TRIAGE_TAB'; tab: TriageTab }
  | { type: 'SET_TRIAGE_DRAFT_PROMPT'; prompt: string }
  | { type: 'ADD_TRIAGE'; id: string; item: TriageItem }
  | { type: 'UPDATE_TRIAGE'; id: string; updates: Partial<TriageItem> }
  | { type: 'REMOVE_TRIAGE'; id: string }
  | { type: 'SET_TRIAGE_ACTIVITY'; triageId: string; activity: string }
  | { type: 'SET_TRIAGE_WAITING'; triageId: string }
  | { type: 'SET_TRIAGE_HISTORY'; history: TriageEntry[] }
  | { type: 'START_RENAME_TASK'; taskId: string }
  | { type: 'CLEAR_RENAME_TASK' };

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
  unreadReview: {},
  toast: null,
  toastHint: null,
  toastDuration: 2000,
  toastAction: null,
  showTriage: false,
  triages: {},
  triageDraftPrompt: '',
  triageTab: 'new' as TriageTab,
  triageHistory: [],
  permissionQueue: [],
  notifications: [],
  showNotificationPopover: false,
  apiPort: null,
  archiveConfirm: null,
  renamingTaskId: null,
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
  showTriage: false,
};

/** Close the active task's diff overlay */
function closeActiveTaskDiff(state: AppState): AppState {
  if (!state.activeTaskId) return state;
  const ps = getPaneState(state, state.activeTaskId);
  if (!ps.showDiff) return state;
  return setPaneState(state, state.activeTaskId, { ...ps, showDiff: false });
}

/** Check whether any modal overlay is open (excludes non-modal popover and confirm dialog) */
export function isAnyOverlayOpen(state: AppState): boolean {
  if (
    state.showRepoManager ||
    state.showCreateDialog ||
    state.showTaskHistory ||
    state.showKeyboardShortcuts ||
    state.showSettings ||
    state.showNotes ||
    state.showStats ||
    state.showSupervisor ||
    state.showTriage
  )
    return true;
  if (state.activeTaskId) {
    const ps = state.paneStates[state.activeTaskId];
    if (ps?.showDiff) return true;
  }
  return false;
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
        ? persisted && action.tasks.some((t) => t.id === persisted && t.status === 'running')
          ? persisted
          : (action.tasks.find((t) => t.status === 'running')?.id ?? null)
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
          ? activeTasks.length > 0
            ? activeTasks[activeTasks.length - 1].id
            : null
          : state.activeTaskId;
      return { ...state, tasks: newTasks, activeTaskId: newActiveId };
    }
    case 'UPDATE_TASK': {
      const prev = state.tasks.find((t) => t.id === action.task.id);
      const reopened = prev && prev.status !== 'running' && action.task.status === 'running';
      const tasks = reopened
        ? [...state.tasks.filter((t) => t.id !== action.task.id), action.task]
        : state.tasks.map((t) => (t.id === action.task.id ? action.task : t));
      return { ...state, tasks };
    }
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
        tasks: state.tasks.map((t) => (t.id === action.taskId ? { ...t, hasUnread: action.hasUnread } : t)),
        ...(action.hasUnread && { lastNotifiedTaskId: action.taskId }),
      };
    }
    case 'SET_TASK_STATUS':
      return {
        ...state,
        tasks: state.tasks.map((t) => (t.id === action.taskId ? { ...t, status: action.status } : t)),
      };
    case 'TOGGLE_REPO_MANAGER':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showRepoManager: !state.showRepoManager });
    case 'SHOW_CREATE_TASK_DIALOG':
      return closeActiveTaskDiff({
        ...state,
        ...allOverlaysClosed,
        showCreateDialog: action.show,
        createDialogRepoId: action.repoId ?? null,
        createDialogSlackUrl: action.slackUrl ?? null,
      });
    case 'TOGGLE_DIFF': {
      if (!state.activeTaskId) return state;
      const ps = getPaneState(state, state.activeTaskId);
      const opening = !ps.showDiff;
      const base = opening ? { ...state, ...allOverlaysClosed } : state;
      let next = setPaneState(base, state.activeTaskId, { ...ps, showDiff: opening });
      if (opening && ps.diffMode === 'review' && state.unreadReview[state.activeTaskId]) {
        const { [state.activeTaskId]: _, ...rest } = next.unreadReview;
        void _;
        next = { ...next, unreadReview: rest };
      }
      return next;
    }
    case 'TOGGLE_TASK_HISTORY':
      return closeActiveTaskDiff({ ...state, ...allOverlaysClosed, showTaskHistory: !state.showTaskHistory });
    case 'TOGGLE_KEYBOARD_SHORTCUTS':
      return closeActiveTaskDiff({
        ...state,
        ...allOverlaysClosed,
        showKeyboardShortcuts: !state.showKeyboardShortcuts,
      });
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
      const next = setPaneState(state, state.activeTaskId, { ...ps, diffMode: action.mode });
      if (action.mode === 'review' && state.unreadReview[state.activeTaskId]) {
        const { [state.activeTaskId]: _, ...rest } = next.unreadReview;
        void _;
        return { ...next, unreadReview: rest };
      }
      return next;
    }
    case 'SET_DEV_SESSION': {
      const ps = getPaneState(state, action.taskId);
      return setPaneState(state, action.taskId, {
        ...ps,
        devSessionId: action.devSessionId,
        devHidden: false,
        focusedPane: 'dev',
      });
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
    case 'SHOW_TOAST': {
      const ta = action.action ? (Array.isArray(action.action) ? action.action : [action.action]) : null;
      return {
        ...state,
        toast: action.message,
        toastHint: action.hint ?? null,
        toastDuration: action.duration ?? 2000,
        toastAction: ta,
      };
    }
    case 'HIDE_TOAST':
      return { ...state, toast: null, toastHint: null, toastAction: null };
    case 'SET_API_PORT':
      return { ...state, apiPort: action.port };
    case 'SET_TASK_SUMMARY':
      return {
        ...state,
        tasks: state.tasks.map((t) => (t.id === action.taskId ? { ...t, summary: action.summary } : t)),
      };
    case 'SET_REVIEW_STATUS':
      return {
        ...state,
        reviewStatus: { ...state.reviewStatus, [action.reviewId]: action.status },
        reviewStartedAt:
          action.status === 'running'
            ? (state.reviewStartedAt ?? Date.now())
            : action.status === 'done' || action.status === 'idle'
              ? null
              : state.reviewStartedAt,
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
        activeReviewId:
          activeId === action.reviewId
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
      return {
        ...state,
        reviewDiscussion: {
          ...state.reviewDiscussion,
          [action.taskId]: { ptySessionId: action.ptySessionId, reviewId: action.reviewId },
        },
      };
    case 'CLEAR_REVIEW_DISCUSSION': {
      const { [action.taskId]: _removed, ...rest } = state.reviewDiscussion;
      void _removed;
      return { ...state, reviewDiscussion: rest };
    }
    case 'MARK_REVIEW_UNREAD':
      return { ...state, unreadReview: { ...state.unreadReview, [action.taskId]: true } };
    case 'CLEAR_REVIEW_UNREAD': {
      const { [action.taskId]: _cleared, ...remaining } = state.unreadReview;
      void _cleared;
      return { ...state, unreadReview: remaining };
    }
    case 'REORDER_TASKS': {
      const idSet = new Set(action.taskIds);
      const reordered = action.taskIds.map((id) => state.tasks.find((t) => t.id === id)!).filter(Boolean);
      let ri = 0;
      return { ...state, tasks: state.tasks.map((t) => (idSet.has(t.id) ? reordered[ri++] : t)) };
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
    case 'START_RENAME_TASK':
      return { ...state, renamingTaskId: action.taskId };
    case 'CLEAR_RENAME_TASK':
      return { ...state, renamingTaskId: null };
    case 'SHOW_TRIAGE':
      return closeActiveTaskDiff({
        ...state,
        ...allOverlaysClosed,
        showTriage: true,
        triageDraftPrompt: action.prompt ?? state.triageDraftPrompt,
      });
    case 'CLOSE_TRIAGE':
      return { ...state, showTriage: false };
    case 'SET_TRIAGE_TAB':
      return { ...state, triageTab: action.tab };
    case 'SET_TRIAGE_DRAFT_PROMPT':
      return { ...state, triageDraftPrompt: action.prompt };
    case 'ADD_TRIAGE':
      return { ...state, triages: { ...state.triages, [action.id]: action.item } };
    case 'UPDATE_TRIAGE': {
      const existing = state.triages[action.id];
      if (!existing) return state;
      return { ...state, triages: { ...state.triages, [action.id]: { ...existing, ...action.updates } } };
    }
    case 'REMOVE_TRIAGE': {
      const { [action.id]: _removed, ...rest } = state.triages;
      void _removed;
      return { ...state, triages: rest };
    }
    case 'SET_TRIAGE_ACTIVITY': {
      const t = state.triages[action.triageId];
      if (!t) return state;
      return {
        ...state,
        triages: {
          ...state.triages,
          [action.triageId]: { ...t, activity: [...t.activity, action.activity] },
        },
      };
    }
    case 'SET_TRIAGE_WAITING': {
      const tw = state.triages[action.triageId];
      if (!tw) return state;
      return {
        ...state,
        triages: { ...state.triages, [action.triageId]: { ...tw, waiting: true } },
      };
    }
    case 'SET_TRIAGE_HISTORY':
      return { ...state, triageHistory: action.history };
    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}>({
  state: initialState,
  dispatch: () => {
    /* default no-op */
  },
});

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
    return () => {
      unsubSummary();
    };
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

  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useApp() {
  return useContext(AppContext);
}
