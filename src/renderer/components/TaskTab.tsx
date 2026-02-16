import { useState, useRef, useEffect } from 'react';
import type { Task } from '../../shared/types';

interface TaskTabProps {
  task: Task;
  repoName: string;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}

const statusColors: Record<string, string> = {
  running: 'bg-green-400',
  stopped: 'bg-slate-400',
  error: 'bg-red-400',
};

export default function TaskTab({ task, repoName, isActive, onClick, onClose, onRename }: TaskTabProps) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(task.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    setEditName(task.name);
    setEditing(true);
  };

  const submitEdit = () => {
    setEditing(false);
    const trimmed = editName.trim();
    if (trimmed && trimmed !== task.name) {
      onRename(trimmed);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center h-full px-1">
        <input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitEdit();
            if (e.key === 'Escape') setEditing(false);
            e.stopPropagation();
          }}
          onBlur={submitEdit}
          className="px-1.5 py-0.5 bg-slate-600 border border-blue-500 rounded text-xs text-slate-200 focus:outline-none w-28"
        />
      </div>
    );
  }

  const tooltip = [
    task.name,
    task.summary,
    `Branch: ${task.branch}`,
    task.terminalTitle ? `Terminal: ${task.terminalTitle}` : undefined,
  ].filter(Boolean).join('\n');

  return (
    <button
      title={tooltip}
      className={`flex items-center gap-1.5 px-3 h-full whitespace-nowrap transition-colors ${
        isActive
          ? 'bg-slate-700 border-b-2 border-blue-500 text-slate-200'
          : 'bg-transparent hover:bg-slate-700/50 text-slate-400'
      }`}
      onClick={onClick}
      onDoubleClick={startEdit}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="flex flex-col items-center min-w-0 max-w-[200px]">
        <span className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColors[task.status]}`} />
          {task.hasUnread && !isActive && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
          )}
          <span className="text-xs leading-tight truncate">{task.name}</span>
        </span>
        <span className="text-[9px] leading-tight truncate max-w-full text-slate-500">{repoName}</span>
      </span>
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
