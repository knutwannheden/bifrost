import React from 'react';
import { useApp } from '../context/AppContext';
import TerminalPane from './TerminalPane';

const shortcuts = [
  { keys: '⌘T', label: 'New task' },
  { keys: '⌘W', label: 'Archive task' },
  { keys: '⌘H', label: 'Task history' },
  { keys: '⌘R', label: 'Repositories' },
  { keys: '⌘D', label: 'View diff' },
  { keys: '⌘O', label: 'Open in IDE' },
  { keys: '⌘1-9', label: 'Switch task' },
];

export default function TaskView() {
  const { state } = useApp();

  const activeTasks = state.tasks.filter((t) => t.status !== 'archived');
  const activeTask = activeTasks.find((t) => t.id === state.activeTaskId);

  if (!activeTask) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-500">
          <p className="text-lg mb-4">No active tasks</p>
          <div className="inline-grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-left">
            {shortcuts.map((s) => (
              <React.Fragment key={s.keys}>
                <kbd className="px-1.5 py-0.5 bg-slate-700 rounded text-slate-300 text-xs text-center">
                  {s.keys}
                </kbd>
                <span className="text-xs text-slate-400">{s.label}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      {activeTasks.map((task) => (
        <div
          key={task.id}
          className="absolute inset-0"
          style={{ display: task.id === state.activeTaskId ? 'block' : 'none' }}
        >
          <TerminalPane sessionId={task.sessionId} active={task.id === state.activeTaskId} />
        </div>
      ))}
    </div>
  );
}
