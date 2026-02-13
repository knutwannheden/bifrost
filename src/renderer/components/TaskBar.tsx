import React from 'react';
import TaskTab from './TaskTab';
import { useApp } from '../context/AppContext';

export default function TaskBar() {
  const { state, dispatch } = useApp();

  if (state.tasks.length === 0) return null;

  return (
    <div className="flex items-center h-8 bg-slate-800/50 border-b border-slate-700 overflow-x-auto">
      {state.tasks.map((task) => (
        <TaskTab
          key={task.id}
          task={task}
          isActive={task.id === state.activeTaskId}
          onClick={() => dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id })}
          onClose={() => {
            window.bifrost.closeTask(task.id).then(() => {
              dispatch({ type: 'REMOVE_TASK', taskId: task.id });
            });
          }}
        />
      ))}
    </div>
  );
}
