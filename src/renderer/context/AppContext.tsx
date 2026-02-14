import React, { createContext, useContext, useReducer, useEffect } from 'react';
import type { Repo, Task, BifrostConfig, TaskStatus } from '../../shared/types';

export type DiffMode = 'git' | 'activity';
export type PaneTarget = 'claude' | 'dev';

export interface TaskPaneState {
  devSessionId: string | null;
  claudeHidden: boolean;
  devHidden: boolean;
  focusedPane: PaneTarget;
}

export interface AppState {
  repos: Repo[];
  tasks: Task[];
  activeTaskId: string | null;
  config: BifrostConfig | null;
  showRepoManager: boolean;
  showCreateDialog: boolean;
  createDialogRepoId: string | null;
  showDiff: boolean;
  showTaskHistory: boolean;
  showKeyboardShortcuts: boolean;
  diffMode: DiffMode;
  paneStates: Record<string, TaskPaneState>;
  toast: string | null;
  apiPort: number | null;
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
  | { type: 'SHOW_CREATE_TASK_DIALOG'; show: boolean; repoId?: string }
  | { type: 'TOGGLE_DIFF' }
  | { type: 'TOGGLE_TASK_HISTORY' }
  | { type: 'TOGGLE_KEYBOARD_SHORTCUTS' }
  | { type: 'SET_DIFF_MODE'; mode: DiffMode }
  | { type: 'SET_DEV_SESSION'; taskId: string; devSessionId: string }
  | { type: 'CLOSE_DEV_SESSION'; taskId: string }
  | { type: 'SET_PANE_FOCUS'; taskId: string; pane: PaneTarget }
  | { type: 'HIDE_PANE'; taskId: string; pane: PaneTarget }
  | { type: 'SHOW_PANE'; taskId: string; pane: PaneTarget }
  | { type: 'SHOW_TOAST'; message: string }
  | { type: 'HIDE_TOAST' }
  | { type: 'SET_API_PORT'; port: number | null };

const initialState: AppState = {
  repos: [],
  tasks: [],
  activeTaskId: null,
  config: null,
  showRepoManager: false,
  showCreateDialog: false,
  createDialogRepoId: null,
  showDiff: false,
  showTaskHistory: false,
  showKeyboardShortcuts: false,
  diffMode: 'git',
  paneStates: {},
  toast: null,
  apiPort: null,
};

export const defaultPaneState: TaskPaneState = {
  devSessionId: null,
  claudeHidden: false,
  devHidden: false,
  focusedPane: 'claude',
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

/** Close all overlays — used when toggling one open so only one shows at a time */
const allOverlaysClosed = {
  showRepoManager: false,
  showCreateDialog: false,
  showDiff: false,
  showTaskHistory: false,
  showKeyboardShortcuts: false,
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CONFIG':
      return { ...state, config: action.config, repos: action.config.repos };
    case 'SET_REPOS':
      return { ...state, repos: action.repos };
    case 'SET_TASKS':
      return { ...state, tasks: action.tasks };
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
      return { ...state, activeTaskId: action.taskId };
    case 'SET_TASK_UNREAD':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, hasUnread: action.hasUnread } : t,
        ),
      };
    case 'SET_TASK_STATUS':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, status: action.status } : t,
        ),
      };
    case 'TOGGLE_REPO_MANAGER':
      return { ...state, ...allOverlaysClosed, showRepoManager: !state.showRepoManager };
    case 'SHOW_CREATE_TASK_DIALOG':
      return { ...state, ...allOverlaysClosed, showCreateDialog: action.show, createDialogRepoId: action.repoId ?? null };
    case 'TOGGLE_DIFF':
      return { ...state, ...allOverlaysClosed, showDiff: !state.showDiff };
    case 'TOGGLE_TASK_HISTORY':
      return { ...state, ...allOverlaysClosed, showTaskHistory: !state.showTaskHistory };
    case 'TOGGLE_KEYBOARD_SHORTCUTS':
      return { ...state, ...allOverlaysClosed, showKeyboardShortcuts: !state.showKeyboardShortcuts };
    case 'SET_DIFF_MODE':
      return { ...state, diffMode: action.mode };
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
      return { ...state, toast: action.message };
    case 'HIDE_TOAST':
      return { ...state, toast: null };
    case 'SET_API_PORT':
      return { ...state, apiPort: action.port };
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
      // Auto-select first active (non-archived) task on startup
      const active = tasks.find((t) => t.status !== 'archived');
      if (active) {
        dispatch({ type: 'SET_ACTIVE_TASK', taskId: active.id });
      }
    });
  }, []);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}
