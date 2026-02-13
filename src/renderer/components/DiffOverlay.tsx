import React, { useRef, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useDiff } from '../hooks/useDiff';
import { parseDiff, extFromPath } from '../utils/diff-parser';
import { highlightLines } from '../utils/syntax-highlight';
import type { DiffFile, DiffLine } from '../utils/diff-parser';
import type { HighlightedToken } from '../utils/syntax-highlight';

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

export default function DiffOverlay() {
  const { state, dispatch } = useApp();
  const { diff, loading, error } = useDiff(state.showDiff ? state.activeTaskId : null);
  const highlighted = useHighlightedFiles(state.showDiff ? diff : null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.showDiff) {
      containerRef.current?.focus();
    }
  }, [state.showDiff]);

  if (!state.showDiff) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dispatch({ type: 'TOGGLE_DIFF' });
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
        <span className="text-sm font-semibold text-slate-300">Diff</span>
        <button
          tabIndex={-1}
          className="text-slate-400 hover:text-slate-200 text-lg"
          onClick={() => dispatch({ type: 'TOGGLE_DIFF' })}
        >
          &times;
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
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
      </div>
    </div>
  );
}
