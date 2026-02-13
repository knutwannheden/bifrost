import React, { useRef, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { DiffMode } from '../context/AppContext';
import { useDiff } from '../hooks/useDiff';
import { useActivityLog } from '../hooks/useActivityLog';
import { parseDiff, extFromPath } from '../utils/diff-parser';
import { highlightLines } from '../utils/syntax-highlight';
import type { DiffFile, DiffLine } from '../utils/diff-parser';
import type { HighlightedToken } from '../utils/syntax-highlight';
import type { ActivityEntry } from '../../shared/types';

interface HighlightedFile {
  file: DiffFile;
  /** One token array per line across all hunks, in order */
  tokensByLine: HighlightedToken[][];
}

function useHighlightedFiles(diff: string | null): HighlightedFile[] | null {
  const [highlighted, setHighlighted] = useState<HighlightedFile[] | null>(null);

  useEffect(() => {
    if (!diff) {
      setHighlighted(null);
      return;
    }

    const files = parseDiff(diff);
    let cancelled = false;

    Promise.all(
      files.map(async (file) => {
        const ext = extFromPath(file.newPath || file.oldPath);
        const allLines = file.hunks.flatMap((h) => h.lines);
        const tokens = await highlightLines(
          allLines.map((l) => l.content),
          ext,
        );
        return { file, tokensByLine: tokens };
      }),
    ).then((result) => {
      if (!cancelled) setHighlighted(result);
    });

    return () => {
      cancelled = true;
    };
  }, [diff]);

  return highlighted;
}

const lineNumWidth = 'w-12';

function LineNumber({ num }: { num: number | null }) {
  return (
    <span className={`${lineNumWidth} inline-block text-right pr-2 select-none text-slate-600 text-xs leading-5`}>
      {num ?? ''}
    </span>
  );
}

function DiffLineRow({
  line,
  tokens,
}: {
  line: DiffLine;
  tokens: HighlightedToken[];
}) {
  const bgClass =
    line.type === 'add'
      ? 'bg-[#1a3a1a]'
      : line.type === 'remove'
        ? 'bg-[#3a1a1a]'
        : '';

  const signColor =
    line.type === 'add'
      ? 'text-green-500'
      : line.type === 'remove'
        ? 'text-red-500'
        : 'text-slate-600';

  const sign =
    line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';

  return (
    <div className={`flex leading-5 ${bgClass}`}>
      <LineNumber num={line.oldLineNo} />
      <LineNumber num={line.newLineNo} />
      <span className={`${signColor} w-4 inline-block text-center flex-shrink-0 text-xs leading-5`}>
        {sign}
      </span>
      <span className="flex-1 text-xs leading-5 whitespace-pre">
        {tokens.map((token, i) => (
          <span key={i} style={{ color: token.color }}>
            {token.content}
          </span>
        ))}
      </span>
    </div>
  );
}

function FileSection({ data }: { data: HighlightedFile }) {
  const { file, tokensByLine } = data;
  let lineIdx = 0;

  return (
    <div className="mb-6">
      <div className="sticky top-0 z-10 bg-slate-800 border border-slate-600 rounded-t px-3 py-1.5 text-xs font-semibold text-slate-300">
        {file.newPath || file.oldPath}
      </div>
      <div className="border border-t-0 border-slate-700 rounded-b overflow-x-auto font-mono">
        {file.hunks.map((hunk, hi) => (
          <React.Fragment key={hi}>
            {hi > 0 && (
              <div className="border-t border-slate-700/50 bg-slate-800/50 px-3 py-0.5 text-xs text-blue-400">
                {hunk.header}
              </div>
            )}
            {hunk.lines.map((line, li) => {
              const idx = lineIdx++;
              return (
                <DiffLineRow
                  key={`${hi}-${li}`}
                  line={line}
                  tokens={tokensByLine[idx] ?? [{ content: line.content, color: '#e2e8f0' }]}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function ClaudeEventView({ entry }: { entry: ActivityEntry }) {
  const kindConfig: Record<string, { label: string; color: string; bg: string; border: string }> = {
    user_message: { label: 'User', color: 'text-green-400', bg: 'bg-green-900/20', border: 'border-green-700/40' },
    assistant_text: { label: 'Claude', color: 'text-purple-400', bg: 'bg-purple-900/20', border: 'border-purple-700/40' },
    tool_use: { label: '', color: 'text-amber-400', bg: 'bg-amber-900/15', border: 'border-amber-700/30' },
    tool_result: { label: 'Result', color: 'text-slate-400', bg: 'bg-slate-800/50', border: 'border-slate-700/30' },
  };

  const config = kindConfig[entry.claudeEventKind ?? ''] ?? kindConfig.assistant_text;

  if (entry.claudeEventKind === 'tool_use') {
    return (
      <div className={`mb-1 flex items-start gap-2 px-3 py-1.5 ${config.bg} border ${config.border} rounded text-xs`}>
        <span className="text-slate-500 flex-shrink-0">{formatTimestamp(entry.timestamp)}</span>
        <span className={`${config.color} font-semibold flex-shrink-0`}>{entry.claudeToolName}</span>
        {entry.claudeText && (
          <span className="text-slate-400 font-mono truncate">{entry.claudeText}</span>
        )}
      </div>
    );
  }

  return (
    <div className={`mb-2 px-3 py-2 ${config.bg} border ${config.border} rounded text-xs`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-slate-500">{formatTimestamp(entry.timestamp)}</span>
        <span className={`${config.color} font-semibold`}>{config.label}</span>
      </div>
      <p className="text-slate-300 whitespace-pre-wrap">{entry.claudeText}</p>
    </div>
  );
}

function ActivityEntryView({ entry }: { entry: ActivityEntry }) {
  const highlighted = useHighlightedFiles(entry.diff ?? null);

  if (entry.type === 'claude_event') {
    return <ClaudeEventView entry={entry} />;
  }

  if (entry.type === 'commit') {
    return (
      <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-blue-900/30 border border-blue-700/50 rounded text-xs">
        <span className="text-slate-500">{formatTimestamp(entry.timestamp)}</span>
        <span className="text-blue-400 font-semibold">Commit</span>
        <span className="text-slate-400 font-mono">{entry.commitSha?.slice(0, 8)}</span>
        <span className="text-slate-300">{entry.commitMessage}</span>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1 text-xs">
        <span className="text-slate-500">{formatTimestamp(entry.timestamp)}</span>
        <span className="text-slate-300 font-mono">{entry.filePath}</span>
      </div>
      {highlighted && highlighted.map((data, i) => (
        <FileSection key={i} data={data} />
      ))}
      {!highlighted && entry.diff && (
        <pre className="text-xs text-slate-400 font-mono overflow-x-auto p-2 bg-slate-800/50 rounded border border-slate-700">
          {entry.diff}
        </pre>
      )}
    </div>
  );
}

function ActionLabel({ text, hintIndex = 0, showHint }: { text: string; hintIndex?: number; showHint: boolean }) {
  if (!showHint) return <>{text}</>;
  return (
    <>
      {text.slice(0, hintIndex)}
      <span className="underline underline-offset-2">{text[hintIndex]}</span>
      {text.slice(hintIndex + 1)}
    </>
  );
}

function ModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (m: DiffMode) => void }) {
  return (
    <div className="flex gap-1">
      {(['git', 'activity'] as const).map((m) => (
        <button
          key={m}
          tabIndex={-1}
          onClick={() => onChange(m)}
          className={`px-3 py-1 text-xs rounded ${
            mode === m
              ? 'bg-slate-600 text-slate-200'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
          }`}
        >
          {m === 'git' ? (
            <ActionLabel text="Git Diff" showHint={true} />
          ) : (
            <ActionLabel text="Activity Log" showHint={true} />
          )}
        </button>
      ))}
    </div>
  );
}

function GitDiffContent({ taskId }: { taskId: string }) {
  const { diff, loading, error } = useDiff(taskId);
  const highlighted = useHighlightedFiles(diff);

  return (
    <>
      {loading && (
        <div className="flex items-center gap-2 text-slate-400">
          <div className="w-4 h-4 border-2 border-slate-500 border-t-slate-200 rounded-full animate-spin" />
          <span>Loading diff...</span>
        </div>
      )}

      {error && (
        <div className="text-red-400">Error: {error}</div>
      )}

      {!loading && !error && (diff === null || diff === '') && (
        <div className="text-slate-500">No changes</div>
      )}

      {!loading && !error && highlighted && highlighted.map((data, i) => (
        <FileSection key={i} data={data} />
      ))}
    </>
  );
}

function ActivityLogContent({ taskId }: { taskId: string }) {
  const { entries, loading, error } = useActivityLog(taskId);

  return (
    <>
      {loading && (
        <div className="flex items-center gap-2 text-slate-400">
          <div className="w-4 h-4 border-2 border-slate-500 border-t-slate-200 rounded-full animate-spin" />
          <span>Loading activity log...</span>
        </div>
      )}

      {error && (
        <div className="text-red-400">Error: {error}</div>
      )}

      {!loading && !error && entries.length === 0 && (
        <div className="text-slate-500">No activity recorded yet</div>
      )}

      {!loading && !error && entries.map((entry) => (
        <ActivityEntryView key={entry.id} entry={entry} />
      ))}
    </>
  );
}

export default function DiffOverlay() {
  const { state, dispatch } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.showDiff) {
      containerRef.current?.focus();
    }
  }, [state.showDiff]);

  if (!state.showDiff) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: 'TOGGLE_DIFF' });
        break;

      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: 'SET_DIFF_MODE', mode: state.diffMode === 'git' ? 'activity' : 'git' });
        break;

      case 'ArrowUp':
        e.preventDefault();
        scrollRef.current?.scrollBy({ top: -80 });
        break;

      case 'ArrowDown':
        e.preventDefault();
        scrollRef.current?.scrollBy({ top: 80 });
        break;

      default:
        // Alt+letter shortcuts
        if (e.altKey) {
          switch (e.code) {
            case 'KeyG':
              e.preventDefault();
              dispatch({ type: 'SET_DIFF_MODE', mode: 'git' });
              break;
            case 'KeyA':
              e.preventDefault();
              dispatch({ type: 'SET_DIFF_MODE', mode: 'activity' });
              break;
          }
        }
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-30 bg-slate-900/95 flex flex-col focus:outline-none"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center justify-between h-10 px-4 border-b border-slate-700 flex-shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold text-slate-300">Diff</span>
          <ModeToggle
            mode={state.diffMode}
            onChange={(m) => dispatch({ type: 'SET_DIFF_MODE', mode: m })}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-600">&uarr;&darr; scroll &middot; Tab toggle</span>
          <button
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg"
            onClick={() => dispatch({ type: 'TOGGLE_DIFF' })}
          >
            &times;
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto p-4">
        {state.activeTaskId && state.diffMode === 'git' && (
          <GitDiffContent taskId={state.activeTaskId} />
        )}
        {state.activeTaskId && state.diffMode === 'activity' && (
          <ActivityLogContent taskId={state.activeTaskId} />
        )}
        {!state.activeTaskId && (
          <div className="text-slate-500">No active task</div>
        )}
      </div>
    </div>
  );
}
