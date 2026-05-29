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

  // Compute recency-based accent background for inactive tabs.
  // Uses rank among running tasks: most recently visited inactive tab
  // gets the strongest color, fading in steps for older tabs.
  const recencyBg = (() => {
    if (isActive) return undefined;
    const lastActive = state.lastActiveAt[task.id];
    if (!lastActive) return 'transparent';
    // Rank this tab among all running tasks by recency (0 = most recent)
    const runningTasks = state.tasks.filter((t) => t.status === 'running' && t.id !== state.activeTaskId);
    const ranked = runningTasks
      .map((t) => ({ id: t.id, ts: state.lastActiveAt[t.id] ?? 0 }))
      .filter((t) => t.ts > 0)
      .sort((a, b) => b.ts - a.ts);
    const rank = ranked.findIndex((t) => t.id === task.id);
    if (rank < 0) return 'transparent';
    // Opacity tiers: 18%, 12%, 7%, 3%, then 0%
    const tiers = [18, 12, 7, 3];
    const pct = rank < tiers.length ? tiers[rank] : 0;
    if (pct === 0) return 'transparent';
    return `color-mix(in srgb, var(--color-accent) ${pct}%, transparent)`;
  })();

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
        className={`group relative flex items-center gap-1.5 pl-4 pr-2 h-full whitespace-nowrap overflow-hidden max-w-[280px] transition-colors ${
          isActive ? 'text-primary' : 'hover:bg-surface-alt/50 text-secondary'
        }`}
        style={{ backgroundColor: isActive ? 'color-mix(in srgb, var(--color-accent) 25%, transparent)' : recencyBg }}
        onClick={onClick}
        onMouseDown={(e) => {
          // Prevent the button from stealing focus so the terminal
          // keeps (or receives) focus when switching tabs.
          if (!editing) e.preventDefault();
        }}
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
        <span className="flex flex-col items-center min-w-0 overflow-hidden">
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
          className="ml-1 text-muted hover:text-primary shrink-0 invisible group-hover:visible transition-colors cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          tabIndex={-1}
        >
          &times;
        </span>
        {showSweep && !isActive && <span className="activity-sweep absolute bottom-0 left-0 right-0 h-[2px]" />}
        {showSolid && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-success" />}
        {isActive && <span className="tab-active-underline absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />}
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
