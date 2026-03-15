import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../../shared/types';
import { useApp } from '../context/AppContext';

interface TaskTabProps {
  task: Task;
  repoName: string;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

export default function TaskTab({
  task,
  repoName,
  isActive,
  onClick,
  onClose,
  onRename,
  onDragStart,
  onDragEnd,
}: TaskTabProps) {
  const { state, dispatch } = useApp();
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

  // React to START_RENAME_TASK from keymap engine
  useEffect(() => {
    if (state.renamingTaskId === task.id) {
      dispatch({ type: 'CLEAR_RENAME_TASK' });
      startEdit();
    }
  }, [state.renamingTaskId]);

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
          className="px-1.5 py-0.5 bg-surface-hover border border-accent rounded-sm text-xs text-primary focus:outline-hidden focus:ring-1 focus:ring-accent w-28"
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

  // Activity indicator: green sweep when Claude is working, solid green when results waiting
  const showSweep = task.claudeActive === true;
  const showSolid = !showSweep && task.hasUnread && !isActive;

  return (
    <>
      <button
        ref={buttonRef}
        draggable
        className={`group relative flex items-center gap-1.5 px-5 h-full whitespace-nowrap overflow-hidden max-w-[280px] transition-colors ${
          isActive
            ? 'bg-surface-alt border-b-2 border-accent text-primary'
            : 'bg-transparent hover:bg-surface-alt/50 text-secondary'
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
            {task.hasUnread && !isActive && !showSolid ? (
              <span className="w-2 h-2 rounded-full bg-accent shrink-0" />
            ) : null}
            <span className="text-xs leading-tight truncate">{task.name}</span>
          </span>
          <span className="text-[9px] leading-tight truncate max-w-full text-muted">{repoName}</span>
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: can't nest <button> inside parent <button> */}
        <span
          role="button"
          className="ml-1 text-muted hover:text-primary shrink-0 hidden group-hover:inline transition-colors cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          tabIndex={-1}
        >
          &times;
        </span>
        {showSweep && <span className="activity-sweep absolute bottom-0 left-0 right-0 h-[2px]" />}
        {showSolid && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-success" />}
      </button>
      {showTooltip &&
        tooltipPos &&
        createPortal(
          <div
            className="fixed z-50 pointer-events-none bg-app border border-border-input rounded-sm px-2 py-1.5 shadow-lg max-w-xl"
            style={{ left: tooltipPos.x, top: tooltipPos.y }}
          >
            {tooltipLines.map((line, i) => (
              <div key={i} className={`text-xs ${i === 0 ? 'text-primary font-semibold' : 'text-secondary'}`}>
                {line}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
