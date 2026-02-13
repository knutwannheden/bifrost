import React from 'react';
import TaskTab from './TaskTab';
import { useApp } from '../context/AppContext';

export default function TaskBar() {
  const { state, dispatch } = useApp();

  const activeTasks = state.tasks.filter((t) => t.status !== 'archived');

  if (activeTasks.length === 0) return null;

  return (
    <div className="flex items-center h-8 bg-slate-800/50 border-b border-slate-700 overflow-x-auto">
      {activeTasks.map((task) => (
        <TaskTab
          key={task.id}
          task={task}
          isActive={task.id === state.activeTaskId}
          onClick={() => dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id })}
          onClose={() => {
            window.bifrost.archiveTask(task.id).then((updated) => {
              dispatch({ type: 'UPDATE_TASK', task: updated });
              if (state.activeTaskId === task.id) {
                const remaining = activeTasks.filter((t) => t.id !== task.id);
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
      ))}
    </div>
  );
}
