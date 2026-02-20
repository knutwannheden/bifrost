import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../../shared/types';

interface TaskTabProps {
  task: Task;
  repoName: string;
  isActive: boolean;
  agentBusy: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

export default function TaskTab({ task, repoName, isActive, agentBusy, onClick, onClose, onRename, onDragStart, onDragEnd }: TaskTabProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(task.name);
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);

  const handleMouseEnter = () => {
    hoverTimer.current = setTimeout(() => {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setTooltipPos({ x: rect.left, y: rect.bottom + 4 });
      }
      setShowTooltip(true);
    }, 500);
  };

  const handleMouseLeave = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setShowTooltip(false);
  };

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

  const tooltipLines = [
    task.name,
    task.summary,
    `Branch: ${task.branch}`,
    task.terminalTitle ? `Terminal: ${task.terminalTitle}` : undefined,
  ].filter(Boolean) as string[];

  return (
    <>
      <button
        ref={buttonRef}
        draggable
        className={`group flex items-center gap-1.5 px-3 h-full whitespace-nowrap transition-colors ${
          isActive
            ? 'bg-slate-700 border-b-2 border-blue-500 text-slate-200'
            : 'bg-transparent hover:bg-slate-700/50 text-slate-400'
        }`}
        onClick={onClick}
        onDoubleClick={startEdit}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', task.id);
          onDragStart(e);
        }}
        onDragEnd={onDragEnd}
      >
        <span className="flex flex-col items-center min-w-0 max-w-[200px]">
          <span className="flex items-center gap-1.5">
            {agentBusy && !isActive ? (
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
            ) : task.hasUnread && !isActive ? (
              <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
            ) : null}
            <span className="text-xs leading-tight truncate">{task.name}</span>
          </span>
          <span className="text-[9px] leading-tight truncate max-w-full text-slate-500">{repoName}</span>
        </span>
        <span
          className="ml-1 text-slate-500 hover:text-slate-200 flex-shrink-0 hidden group-hover:inline"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          &times;
        </span>
      </button>
      {showTooltip && tooltipPos && createPortal(
        <div
          className="fixed z-50 pointer-events-none bg-slate-900 border border-slate-600 rounded px-2 py-1.5 shadow-lg font-sans max-w-xl"
          style={{ left: tooltipPos.x, top: tooltipPos.y }}
        >
          {tooltipLines.map((line, i) => (
            <div key={i} className={`text-xs ${i === 0 ? 'text-slate-200 font-medium' : 'text-slate-400'}`}>{line}</div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
