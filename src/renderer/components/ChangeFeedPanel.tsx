import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedChange, FeedItem } from '../../shared/types';
import { useApp } from '../context/AppContext';
import { useKeymap } from '../context/KeymapContext';
import { isDarkTheme } from '../hooks/useTheme';
import { messageTargetName } from '../utils/agent-address';
import { focusTaskTerminal } from '../utils/focus-terminal';
import { type HighlightedToken, highlightLines } from '../utils/syntax-highlight';
import DiffStatsBadge from './DiffStatsBadge';
import Kbd from './Kbd';
import OverlayFooter from './OverlayFooter';
import SimpleMarkdown from './SimpleMarkdown';

const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 280;
const MAX_WIDTH = 900;

/** Cards left expanded at the bottom of the feed, where the agent is working. */
const EXPANDED_TAIL = 3;

/** How close to the bottom still counts as following the agent. */
const PIN_SLACK_PX = 24;

/** The line's number in the file after the change, and its diff role. */
interface RenderLine {
  sign: '+' | '-' | ' ';
  content: string;
  newLineNo: number;
}

function renderLines(change: FeedChange): RenderLine[] {
  const out: RenderLine[] = [];
  for (const hunk of change.hunks) {
    let no = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
      out.push({ sign, content: line.slice(1), newLineNo: no });
      if (sign !== '-') no++;
    }
  }
  return out;
}

const signStyles = {
  '+': { bg: 'bg-diff-add', color: 'text-success' },
  '-': { bg: 'bg-diff-remove', color: 'text-danger' },
  ' ': { bg: '', color: 'text-faint' },
} as const;

function ChangeCard({
  change,
  expanded,
  selected,
  onToggle,
  onSelect,
  onOpen,
}: {
  change: FeedChange;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onOpen: (line?: number) => void;
}) {
  const lines = useMemo(() => renderLines(change), [change]);
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const ext = change.relPath.split('.').pop() ?? '';
    const filename = change.relPath.split('/').pop();
    highlightLines(
      lines.map((l) => l.content),
      ext,
      isDarkTheme(),
      filename,
    ).then((result) => {
      if (!cancelled) setTokens(result);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, lines, change.relPath]);

  const fallback = isDarkTheme() ? '#f8f8f2' : '#24292e';

  return (
    <div
      className={`mb-2 rounded-sm border ${selected ? 'border-accent' : 'border-border-default'} bg-surface-alt/30 ${
        change.agentLabel ? 'opacity-75' : ''
      }`}
    >
      {change.command && (
        <div className="px-2 pt-1 text-xs text-faint font-mono truncate" title={change.command}>
          during {change.command}
        </div>
      )}
      {change.agentLabel && (
        <div className="px-2 pt-1 text-xs text-faint truncate" title={change.agentLabel}>
          via {change.agentLabel}
        </div>
      )}
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          onClick={onToggle}
          className="text-faint hover:text-secondary transition-colors text-xs w-3 shrink-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          onClick={() => {
            onSelect();
            onOpen(change.hunks[0]?.newStart);
          }}
          className="flex-1 min-w-0 text-left font-mono text-xs text-primary hover:text-accent-hover transition-colors truncate"
          title={change.relPath}
        >
          {change.relPath}
        </button>
        {change.created && <span className="text-xs text-success shrink-0">new</span>}
        {change.editCount > 1 && <span className="text-xs text-muted shrink-0">×{change.editCount}</span>}
        <DiffStatsBadge additions={change.added} deletions={change.removed} className="shrink-0" />
      </div>

      {expanded && (
        <div className="border-t border-border-default/60 overflow-x-auto font-mono">
          {lines.map((line, i) => {
            const { bg, color } = signStyles[line.sign];
            return (
              <button
                key={i}
                onClick={() => {
                  onSelect();
                  onOpen(line.newLineNo);
                }}
                className={`flex w-full text-left leading-5 ${bg} hover:bg-surface-hover transition-colors`}
              >
                <span className="w-10 pr-2 text-right select-none text-faint text-xs leading-5 shrink-0">
                  {line.sign === '-' ? '' : line.newLineNo}
                </span>
                <span className="flex-1 text-xs leading-5 whitespace-pre">
                  <span className={`${color} inline-block w-3 text-center`}>{line.sign}</span>
                  {(tokens?.[i] ?? [{ content: line.content, color: fallback }]).map((t, ti) => (
                    <span key={ti} style={{ color: t.color }}>
                      {t.content}
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
          {change.truncated && <div className="px-3 py-1 text-xs text-muted italic">…change continues</div>}
        </div>
      )}
    </div>
  );
}

export default function ChangeFeedPanel() {
  const { state, dispatch } = useApp();
  const { getDisplayString } = useKeymap();
  const config = state.config;
  const open = config?.changeFeedOpen ?? false;
  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
  const taskId = activeTask?.id;

  const [items, setItems] = useState<FeedItem[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = dragWidth ?? config?.changeFeedWidth ?? DEFAULT_WIDTH;

  useEffect(() => {
    if (!open || !taskId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setOverrides({});
    setSelectedId(null);
    window.bifrost
      .loadChangeFeed(taskId)
      .then((loaded) => {
        if (!cancelled) setItems(loaded);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, taskId]);

  useEffect(() => {
    if (!open || !taskId) return;
    return window.bifrost.onChangeFeed((id, next) => {
      if (id === taskId) setItems(next);
    });
  }, [open, taskId]);

  useEffect(() => {
    if (state.changeFeedFocus === 0) return;
    containerRef.current?.focus();
  }, [state.changeFeedFocus]);

  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, pinned]);

  const changes = useMemo(() => items.filter((i): i is FeedChange => i.kind === 'change'), [items]);
  const defaultExpanded = useMemo(() => new Set(changes.slice(-EXPANDED_TAIL).map((c) => c.id)), [changes]);
  const isExpanded = (id: string) => overrides[id] ?? defaultExpanded.has(id);

  const select = useCallback(
    (change: FeedChange | null) => {
      setSelectedId(change?.id ?? null);
      dispatch({
        type: 'SET_CHANGE_FEED_SELECTION',
        selection: change ? { filePath: change.filePath, line: change.hunks[0]?.newStart } : null,
      });
    },
    [dispatch],
  );

  const openInIde = useCallback(
    (filePath: string, line?: number) => {
      if (activeTask) window.bifrost.openInIde(activeTask.worktreePath, filePath, line);
    },
    [activeTask],
  );

  const step = (delta: number) => {
    if (changes.length === 0) return;
    const at = changes.findIndex((c) => c.id === selectedId);
    const next = at < 0 ? (delta > 0 ? 0 : changes.length - 1) : Math.min(changes.length - 1, Math.max(0, at + delta));
    select(changes[next]);
    document.querySelector(`[data-feed-item="${changes[next].id}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      data-change-feed
      tabIndex={-1}
      onMouseDown={() => containerRef.current?.focus()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          step(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(-1);
        } else if (e.key === 'Enter') {
          const change = changes.find((c) => c.id === selectedId);
          if (change) openInIde(change.filePath, change.hunks[0]?.newStart);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          focusTaskTerminal(state, state.activeTaskId);
        }
      }}
      className="relative flex flex-col bg-surface border-l-2 border-border-default shrink-0 focus:outline-hidden focus:border-accent-hover focus-within:border-accent-hover"
      style={{ width }}
    >
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startWidth = width;
          const onMove = (ev: MouseEvent) => {
            setDragWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth - (ev.clientX - startX))));
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setDragWidth((w) => {
              if (w != null && config) {
                const updated = { ...config, changeFeedWidth: w };
                dispatch({ type: 'SET_CONFIG', config: updated });
                window.bifrost.saveConfig(updated);
              }
              return null;
            });
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40 transition-colors z-10"
      />

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK_PX);
        }}
        className="flex-1 min-h-0 overflow-y-auto px-2 py-2"
      >
        {items.length === 0 ? (
          <div className="text-sm text-muted text-center py-4">Nothing yet</div>
        ) : (
          items.map((item) => {
            if (item.kind === 'narration') {
              return (
                <div
                  key={item.id}
                  className={`px-1 pt-3 pb-1 text-xs leading-relaxed ${
                    item.thinking ? 'text-muted italic' : 'text-secondary'
                  }`}
                >
                  <SimpleMarkdown text={item.text} />
                </div>
              );
            }
            if (item.kind === 'tick') {
              const addressee =
                item.tool === 'SendMessage'
                  ? state.tasks.find((t) => t.name === messageTargetName(item.detail))
                  : undefined;
              return (
                <div key={item.id} className="flex items-baseline gap-1.5 px-1 py-0.5 text-xs text-faint">
                  <span className="shrink-0">{item.tool}</span>
                  {addressee ? (
                    <button
                      onClick={() => dispatch({ type: 'SET_ACTIVE_TASK', taskId: addressee.id })}
                      className="truncate text-left text-accent-hover hover:underline transition-colors"
                      title={`Open ${addressee.name}`}
                    >
                      {addressee.name}
                    </button>
                  ) : (
                    <span className="truncate font-mono">{item.detail}</span>
                  )}
                  {item.count > 1 && <span className="shrink-0">×{item.count}</span>}
                </div>
              );
            }
            return (
              <div key={item.id} data-feed-item={item.id}>
                <ChangeCard
                  change={item}
                  expanded={isExpanded(item.id)}
                  selected={item.id === selectedId}
                  onToggle={() => setOverrides((o) => ({ ...o, [item.id]: !isExpanded(item.id) }))}
                  onSelect={() => select(item)}
                  onOpen={(line) => openInIde(item.filePath, line)}
                />
              </div>
            );
          })
        )}
      </div>

      <OverlayFooter className="shrink-0">
        <div className="flex items-center gap-2 text-xs text-faint">
          <span>↑↓ select</span>
          <span>·</span>
          <span>Enter open</span>
          <span>·</span>
          <span>Esc terminal</span>
          <span className="flex-1" />
          <Kbd>{getDisplayString('view.changeFeed')}</Kbd>
        </div>
      </OverlayFooter>
    </div>
  );
}
