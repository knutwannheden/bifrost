import TaskTab from './TaskTab';
import { useApp, defaultPaneState } from '../context/AppContext';

function repoLabel(repoPath: string): string {
  const parts = repoPath.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] || '';
}

export default function TaskBar() {
  const { state, dispatch } = useApp();

  const openTasks = state.tasks.filter((t) => t.status === 'running');

  if (openTasks.length === 0) return null;

  const repos = state.config?.repos ?? [];

  return (
    <div className="flex items-stretch h-10 bg-slate-800/50 border-b border-slate-700 overflow-x-auto">
      {openTasks.map((task) => {
        const repo = repos.find((r) => r.id === task.repoId);
        const repoName = repo ? repoLabel(repo.path) : repoLabel(task.worktreePath);
        const ps = state.paneStates[task.id] ?? defaultPaneState;
        return (
        <TaskTab
          key={task.id}
          task={task}
          repoName={repoName}
          isActive={task.id === state.activeTaskId}
          isReviewActive={ps.activeSession === 'review'}
          onClick={() => dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id })}
          onClose={() => {
            window.bifrost.stopTask(task.id).then((updated) => {
              dispatch({ type: 'UPDATE_TASK', task: updated });
              if (state.activeTaskId === task.id) {
                const remaining = openTasks.filter((t) => t.id !== task.id);
                dispatch({
                  type: 'SET_ACTIVE_TASK',
                  taskId: remaining.length > 0 ? remaining[remaining.length - 1].id : null,
                });
              }
            });
          }}
          onRename={(name) => {
            window.bifrost.renameTask(task.id, name).then((updated) => {
              dispatch({ type: 'UPDATE_TASK', task: updated });
            });
          }}
        />
        );
      })}
    </div>
  );
}
