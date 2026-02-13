import React from 'react';
import { useApp } from '../context/AppContext';
import TerminalPane from './TerminalPane';

export default function TaskView() {
  const { state } = useApp();

  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);

  if (!activeTask) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-500">
          <p className="text-lg">No active tasks</p>
          <p className="text-sm mt-1">
            Press{' '}
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded text-slate-300 text-xs">
              Cmd+T
            </kbd>{' '}
            to create a task
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      {state.tasks.map((task) => (
        <div
          key={task.id}
          className="absolute inset-0"
          style={{ display: task.id === state.activeTaskId ? 'block' : 'none' }}
        >
          <TerminalPane sessionId={task.sessionId} />
        </div>
      ))}
    </div>
  );
}
