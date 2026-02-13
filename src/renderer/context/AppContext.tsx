import React, { createContext, useContext, useReducer, useEffect } from 'react';
import type { Repo, Task, BifrostConfig, TaskStatus } from '../../shared/types';

export type DiffMode = 'git' | 'activity';

export interface AppState {
  repos: Repo[];
  tasks: Task[];
  activeTaskId: string | null;
  config: BifrostConfig | null;
  showRepoManager: boolean;
  showCreateDialog: boolean;
  showDiff: boolean;
  showTaskHistory: boolean;
  diffMode: DiffMode;
}

type AppAction =
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
  | { type: 'SHOW_CREATE_TASK_DIALOG'; show: boolean }
  | { type: 'TOGGLE_DIFF' }
  | { type: 'TOGGLE_TASK_HISTORY' }
  | { type: 'SET_DIFF_MODE'; mode: DiffMode };

const initialState: AppState = {
  repos: [],
  tasks: [],
  activeTaskId: null,
  config: null,
  showRepoManager: false,
  showCreateDialog: false,
  showDiff: false,
  showTaskHistory: false,
  diffMode: 'git',
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
      return { ...state, showRepoManager: !state.showRepoManager };
    case 'SHOW_CREATE_TASK_DIALOG':
      return { ...state, showCreateDialog: action.show };
    case 'TOGGLE_DIFF':
      return { ...state, showDiff: !state.showDiff };
    case 'TOGGLE_TASK_HISTORY':
      return { ...state, showTaskHistory: !state.showTaskHistory };
    case 'SET_DIFF_MODE':
      return { ...state, diffMode: action.mode };
    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}>({ state: initialState, dispatch: () => {} });

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => {
    window.bifrost.loadConfig().then((config) => {
      dispatch({ type: 'SET_CONFIG', config });
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
