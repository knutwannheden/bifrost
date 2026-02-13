import React, { useState } from 'react';
import type { Task } from '../../shared/types';

interface TaskTabProps {
  task: Task;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  running: 'bg-green-400',
  stopped: 'bg-slate-400',
  error: 'bg-red-400',
};

export default function TaskTab({ task, isActive, onClick, onClose }: TaskTabProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      className={`flex items-center gap-1.5 px-3 h-full text-sm whitespace-nowrap transition-colors ${
        isActive
          ? 'bg-slate-700 border-b-2 border-blue-500 text-slate-200'
          : 'bg-transparent hover:bg-slate-700/50 text-slate-400'
      }`}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColors[task.status]}`} />
      {task.hasUnread && !isActive && (
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
      )}
      <span className="truncate max-w-[120px]">{task.name}</span>
      {hovered && (
        <span
          className="ml-1 text-slate-500 hover:text-slate-200 flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          &times;
        </span>
      )}
    </button>
  );
}
