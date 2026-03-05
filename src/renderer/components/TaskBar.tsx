import { useState, useRef } from 'react';
import TaskTab from './TaskTab';
import { useApp } from '../context/AppContext';

function repoLabel(repoPath: string): string {
  const parts = repoPath.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] || '';
}

export default function TaskBar() {
  const { state, dispatch } = useApp();
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<'left' | 'right'>('left');
  const draggingId = useRef<string | null>(null);

  const openTasks = state.tasks.filter((t) => t.status === 'running');

  if (openTasks.length === 0) return null;

  const repos = state.config?.repos ?? [];

  const handleDragOver = (e: React.DragEvent, taskId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    setDropSide(e.clientX < mid ? 'left' : 'right');
    setDragOverId(taskId);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const fromId = draggingId.current;
    if (!fromId || !dragOverId || fromId === dragOverId) {
      setDragOverId(null);
      return;
    }
    const ids = openTasks.map((t) => t.id);
    const fromIdx = ids.indexOf(fromId);
    // Remove dragged item
    ids.splice(fromIdx, 1);
    // Find target position
    let toIdx = ids.indexOf(dragOverId);
    if (dropSide === 'right') toIdx += 1;
    ids.splice(toIdx, 0, fromId);
    dispatch({ type: 'REORDER_TASKS', taskIds: ids });
    window.bifrost.reorderTasks(ids);
    setDragOverId(null);
  };

  return (
    <div className="flex items-stretch h-10 bg-slate-800/50 border-b border-slate-700 overflow-x-auto">
      {openTasks.map((task) => {
        const repo = repos.find((r) => r.id === task.repoId);
        const repoName = repo ? repoLabel(repo.path) : repoLabel(task.worktreePath);
        const isOver = dragOverId === task.id && draggingId.current !== task.id;
        return (
        <div
          key={task.id}
          className="relative flex items-stretch"
          onDragOver={(e) => handleDragOver(e, task.id)}
          onDrop={handleDrop}
          onDragLeave={() => { if (dragOverId === task.id) setDragOverId(null); }}
        >
          {isOver && dropSide === 'left' && (
            <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-blue-500 z-10" />
          )}
          <TaskTab
            task={task}
            repoName={repoName}
            isActive={task.id === state.activeTaskId}
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
            onDragStart={() => { draggingId.current = task.id; }}
            onDragEnd={() => { draggingId.current = null; setDragOverId(null); }}
          />
          {isOver && dropSide === 'right' && (
            <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-blue-500 z-10" />
          )}
        </div>
        );
      })}
    </div>
  );
}
