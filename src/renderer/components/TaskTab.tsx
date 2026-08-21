import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskPr } from '../../shared/types';
import { useApp } from '../context/AppContext';
import Highlight from './Highlight';
import PinIcon from './PinIcon';
import PrPill from './PrPill';
import Spinner from './Spinner';

interface TaskTabProps {
  task: Task;
  repoName: string;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onRegenerateTitle: () => Promise<void>;
  isPinned: boolean;
  onTogglePin: () => void;
  search: string;
  isSelected: boolean;
  pr?: TaskPr;
}

export default function TaskTab({
  task,
  repoName,
  isActive,
  onClick,
  onClose,
  onRename,
  onRegenerateTitle,
  isPinned,
  onTogglePin,
  search,
  isSelected,
  pr,
}: TaskTabProps) {
  const { state, dispatch } = useApp();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(task.name);
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
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
        // Assumes the tooltip's 5 lines (name, summary, branch, base, terminal
        // title) stay unwrapped; a long summary can make the actual height exceed this.
        const estimatedHeight = 100;
        const fitsBelow = rect.bottom + 4 + estimatedHeight <= window.innerHeight;
        const y = fitsBelow ? rect.bottom + 4 : rect.top - 4 - estimatedHeight;
        setTooltipPos({ x: rect.left, y });
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

  useEffect(() => {
    if (!menuPos) return;
    const close = () => setMenuPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuPos]);

  const startEdit = () => {
    setEditName(task.name);
    setEditing(true);
  };

  const handleRegenerate = async () => {
    setMenuPos(null);
    setRegenerating(true);
    try {
      await onRegenerateTitle();
    } finally {
      setRegenerating(false);
    }
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
          className="px-1.5 py-0.5 bg-surface-hover border border-accent rounded-sm text-xs text-primary focus:outline-hidden focus:ring-1 focus:ring-accent w-full"
        />
      </div>
    );
  }

  // An in-place task works on the checked-out branch, so naming its base twice
  // says nothing; a task with no branch of its own has only a base to show.
  const branchLine = !task.branch
    ? `Base: ${task.baseBranch}`
    : task.branch === task.baseBranch
      ? `Branch: ${task.branch}`
      : `Branch: ${task.branch} · Base: ${task.baseBranch}`;

  const tooltipLines = [task.name, task.summary, branchLine].filter(Boolean) as string[];

  // Activity indicator: green pulse while Claude works, solid blue once results wait
  const showPulse = task.claudeActive === true;
  const showSolid = !showPulse && task.hasUnread && !isActive;

  return (
    <>
      <button
        ref={buttonRef}
        className={`group relative flex w-full items-center px-3 py-1.5 text-left transition-colors ${
          isActive ? 'bg-surface-alt text-primary' : 'hover:bg-surface-hover text-secondary'
        } ${isSelected ? 'ring-1 ring-inset ring-accent' : ''}`}
        style={isActive ? { backgroundColor: 'color-mix(in srgb, var(--color-accent) 25%, transparent)' } : undefined}
        onClick={onClick}
        onMouseDown={(e) => {
          // Prevent the button from stealing focus so the terminal
          // keeps (or receives) focus when switching tabs.
          if (!editing) e.preventDefault();
        }}
        onDoubleClick={startEdit}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowTooltip(false);
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span className="flex flex-col min-w-0 flex-1 overflow-hidden group-hover:mask-r-from-[calc(100%-2.5rem)] group-hover:mask-r-to-[calc(100%-1.5rem)]">
          <span className="flex items-center gap-1.5">
            {regenerating ? <Spinner size="sm" /> : null}
            {task.hasUnread && !isActive && !showSolid ? (
              <span className="w-2 h-2 rounded-full bg-accent shrink-0" />
            ) : null}
            <span className="text-xs leading-tight truncate">
              <Highlight text={task.name} search={search} />
            </span>
          </span>
          <span className="flex items-center gap-1 text-[10px] leading-tight text-muted">
            <span className="flex-1 truncate">
              <Highlight text={repoName} search={search} />
            </span>
            {pr ? <PrPill pr={pr} onOpen={() => window.bifrost.openUrl(pr.url)} /> : null}
          </span>
        </span>
        {/* Sits over the label, which masks its right edge on hover: the label
            is laid out at the full row width whatever these controls do. */}
        <span className="absolute right-3 top-0 bottom-0 flex items-center gap-0.5 invisible group-hover:visible">
          {/* biome-ignore lint/a11y/useSemanticElements: can't nest <button> inside parent <button> */}
          <span
            role="button"
            title={isPinned ? 'Unpin' : 'Pin'}
            className={`transition-colors cursor-pointer ${
              isPinned ? 'text-accent hover:text-primary' : 'text-muted hover:text-primary'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            tabIndex={-1}
          >
            <PinIcon filled={isPinned} />
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: can't nest <button> inside parent <button> */}
          <span
            role="button"
            title="Close"
            className="text-muted hover:text-primary transition-colors cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            tabIndex={-1}
          >
            &times;
          </span>
        </span>
        {showPulse && !isActive && <span className="activity-pulse absolute top-0 bottom-0 left-0 w-1" />}
        {showSolid && <span className="absolute top-0 bottom-0 left-0 w-1 bg-info" />}
        {isActive && <span className="absolute top-0 bottom-0 left-0 w-1 bg-accent" />}
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
      {menuPos &&
        createPortal(
          <div
            className="fixed z-50 bg-surface border border-border-input rounded-sm shadow-xl py-1 min-w-[180px]"
            style={{ left: menuPos.x, top: menuPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 text-xs text-primary hover:bg-surface-hover transition-colors"
              onClick={() => {
                setMenuPos(null);
                onTogglePin();
              }}
            >
              {isPinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 text-xs text-primary hover:bg-surface-hover transition-colors"
              onClick={handleRegenerate}
            >
              Regenerate title
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
