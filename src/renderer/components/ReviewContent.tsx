import React, { useCallback, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import type { ReviewStatus } from '../context/AppContext';

/**
 * Lightweight Markdown renderer for structured review output.
 * Handles headings, checkboxes, bold, inline code, and paragraphs.
 */
function renderMarkdownLine(
  line: string,
  lineIndex: number,
  checkedLines: Set<number>,
  onToggle: (lineIndex: number) => void,
): React.ReactNode {
  // Headings
  if (line.startsWith('### ')) {
    return <h3 key={lineIndex} className="text-sm font-semibold text-slate-200 mt-4 mb-1">{renderInline(line.slice(4))}</h3>;
  }
  if (line.startsWith('## ')) {
    return <h2 key={lineIndex} className="text-base font-semibold text-slate-200 mt-5 mb-2">{renderInline(line.slice(3))}</h2>;
  }
  if (line.startsWith('# ')) {
    return <h1 key={lineIndex} className="text-lg font-bold text-slate-100 mt-5 mb-2">{renderInline(line.slice(2))}</h1>;
  }

  // Checkbox lines: - [ ] or - [x]
  const checkboxMatch = line.match(/^(\s*)- \[([ xX])\] (.*)$/);
  if (checkboxMatch) {
    const isChecked = checkedLines.has(lineIndex);
    const indent = checkboxMatch[1].length;
    return (
      <label
        key={lineIndex}
        className="flex items-start gap-2 py-0.5 cursor-pointer hover:bg-slate-700/30 rounded px-1 -mx-1"
        style={{ paddingLeft: indent * 4 }}
      >
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onToggle(lineIndex)}
          className="mt-1 accent-blue-500 flex-shrink-0"
        />
        <span className="text-sm text-slate-300">{renderInline(checkboxMatch[3])}</span>
      </label>
    );
  }

  // Regular bullet points
  const bulletMatch = line.match(/^(\s*)- (.*)$/);
  if (bulletMatch) {
    const indent = bulletMatch[1].length;
    return (
      <div key={lineIndex} className="flex items-start gap-2 py-0.5" style={{ paddingLeft: indent * 4 }}>
        <span className="text-slate-500 flex-shrink-0 mt-0.5">-</span>
        <span className="text-sm text-slate-300">{renderInline(bulletMatch[2])}</span>
      </div>
    );
  }

  // Empty lines
  if (!line.trim()) {
    return <div key={lineIndex} className="h-2" />;
  }

  // Paragraphs
  return <p key={lineIndex} className="text-sm text-slate-300 py-0.5">{renderInline(line)}</p>;
}

/** Render inline formatting: **bold**, `code` */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldIdx = remaining.indexOf('**');
    const codeIdx = remaining.indexOf('`');

    // Find the earliest match
    const nextBold = boldIdx >= 0 ? boldIdx : Infinity;
    const nextCode = codeIdx >= 0 ? codeIdx : Infinity;

    if (nextBold === Infinity && nextCode === Infinity) {
      parts.push(remaining);
      break;
    }

    if (nextBold <= nextCode) {
      // Try bold
      const endBold = remaining.indexOf('**', boldIdx + 2);
      if (endBold >= 0) {
        if (boldIdx > 0) parts.push(remaining.slice(0, boldIdx));
        parts.push(<strong key={key++} className="text-slate-100 font-semibold">{remaining.slice(boldIdx + 2, endBold)}</strong>);
        remaining = remaining.slice(endBold + 2);
        continue;
      }
    }

    if (nextCode <= nextBold) {
      // Try inline code
      const endCode = remaining.indexOf('`', codeIdx + 1);
      if (endCode >= 0) {
        if (codeIdx > 0) parts.push(remaining.slice(0, codeIdx));
        parts.push(<code key={key++} className="px-1 py-0.5 bg-slate-700 rounded text-xs text-amber-300 font-mono">{remaining.slice(codeIdx + 1, endCode)}</code>);
        remaining = remaining.slice(endCode + 1);
        continue;
      }
    }

    // No closing match found — emit rest as text
    parts.push(remaining);
    break;
  }

  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>;
}

function parseCheckedLines(content: string): Set<number> {
  const checked = new Set<number>();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- \[[xX]\]/.test(lines[i])) {
      checked.add(i);
    }
  }
  return checked;
}

interface ReviewContentProps {
  taskId: string;
}

export default function ReviewContent({ taskId }: ReviewContentProps) {
  const { state, dispatch } = useApp();

  const content = state.reviewContent[taskId] ?? '';
  const status: ReviewStatus = state.reviewStatus[taskId] ?? 'idle';

  const checkedLines = useMemo(() => parseCheckedLines(content), [content]);
  const hasChecked = checkedLines.size > 0;

  const lines = useMemo(() => content.split('\n'), [content]);

  // Load review from disk on mount / when switching to this tab.
  // Also starts the file watcher (via LOAD_REVIEW handler) so external
  // edits stream in via REVIEW_PROGRESS.
  useEffect(() => {
    if (status === 'running') return;
    window.bifrost.loadReview(taskId).then((saved) => {
      if (saved) {
        dispatch({ type: 'SET_REVIEW_CONTENT', taskId, content: saved });
        if (status !== 'done') {
          dispatch({ type: 'SET_REVIEW_STATUS', taskId, status: 'done' });
        }
      }
    });
  }, [taskId]);

  // Stream partial review output (while running) and external file changes (while done)
  useEffect(() => {
    const unsub = window.bifrost.onReviewProgress((tid, updated) => {
      if (tid === taskId) {
        dispatch({ type: 'SET_REVIEW_CONTENT', taskId, content: updated });
        // If we receive an update while done, stay in done state
        if (status !== 'running' && status !== 'done') {
          dispatch({ type: 'SET_REVIEW_STATUS', taskId, status: 'done' });
        }
      }
    });
    return unsub;
  }, [taskId, status, dispatch]);


  const handleRunReview = useCallback(async () => {
    dispatch({ type: 'SET_REVIEW_STATUS', taskId, status: 'running' });
    try {
      const result = await window.bifrost.runReview(taskId);
      dispatch({ type: 'SET_REVIEW_CONTENT', taskId, content: result });
      dispatch({ type: 'SET_REVIEW_STATUS', taskId, status: 'done' });
    } catch (err) {
      dispatch({ type: 'SET_REVIEW_STATUS', taskId, status: 'error' });
      dispatch({ type: 'SET_REVIEW_CONTENT', taskId, content: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [taskId, dispatch]);

  const handleToggle = useCallback((lineIndex: number) => {
    const newLines = [...lines];
    const line = newLines[lineIndex];
    if (/^\s*- \[ \]/.test(line)) {
      newLines[lineIndex] = line.replace('- [ ]', '- [x]');
    } else if (/^\s*- \[[xX]\]/.test(line)) {
      newLines[lineIndex] = line.replace(/- \[[xX]\]/, '- [ ]');
    }
    const updated = newLines.join('\n');
    dispatch({ type: 'SET_REVIEW_CONTENT', taskId, content: updated });
    window.bifrost.saveReview(taskId, updated);
  }, [lines, taskId, dispatch]);

  const handleCopyPrompt = useCallback(() => {
    navigator.clipboard.writeText('/bifrost:review-fix');
    dispatch({ type: 'SHOW_TOAST', message: 'Copied /bifrost:review-fix \u2014 paste into Claude session' });
  }, [dispatch]);

  // Enter / Cmd+Enter: run review or copy prompt
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      // Plain Enter in idle/error state → run review (default action)
      if (!e.metaKey && (status === 'idle' || status === 'error') && !content) {
        e.preventDefault();
        handleRunReview();
        return;
      }
      // Cmd+Enter: run review or copy prompt
      if (e.metaKey) {
        e.preventDefault();
        if (status === 'done' && hasChecked) {
          handleCopyPrompt();
        } else if (status === 'idle' || status === 'done' || status === 'error') {
          handleRunReview();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [status, content, hasChecked, handleCopyPrompt, handleRunReview]);

  // Idle state — no existing review
  if (status === 'idle' && !content) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <button
          onClick={handleRunReview}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          R<span className="underline underline-offset-2">u</span>n Review
        </button>
        <div className="max-w-sm text-center text-xs text-slate-500 leading-relaxed">
          Runs Claude on the current git diff to produce a review with actionable items.
          Check the items you want to address, then copy a prompt to paste into the main session.
        </div>
      </div>
    );
  }

  // Running state — show spinner + streaming content
  if (status === 'running') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700 flex-shrink-0 text-slate-400">
          <div className="w-4 h-4 border-2 border-slate-500 border-t-slate-200 rounded-full animate-spin flex-shrink-0" />
          <span className="text-sm">Running review...</span>
        </div>
        {content && (
          <div className="flex-1 overflow-auto p-4 font-sans">
            {lines.map((line, i) => renderMarkdownLine(line, i, new Set(), () => { /* read-only during streaming */ }))}
          </div>
        )}
      </div>
    );
  }

  // Error state
  if (status === 'error') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div className="text-red-400 text-sm">{content || 'Review failed'}</div>
        <button
          onClick={handleRunReview}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // Done state — render markdown with checkboxes
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-auto p-4 font-sans">
        {lines.map((line, i) => renderMarkdownLine(line, i, checkedLines, handleToggle))}
      </div>
      <div className="flex items-center gap-3 px-4 py-3 border-t border-slate-700 flex-shrink-0">
        <button
          onClick={handleRunReview}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-xs transition-colors"
        >
          Re-run Review
        </button>
        <button
          onClick={handleCopyPrompt}
          disabled={!hasChecked}
          className={`px-3 py-1.5 rounded text-xs transition-colors ${
            hasChecked
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-slate-800 text-slate-600 cursor-not-allowed'
          }`}
        >
          Copy Prompt
        </button>
        {hasChecked && (
          <span className="text-xs text-slate-500">{checkedLines.size} item{checkedLines.size !== 1 ? 's' : ''} selected</span>
        )}
        <span className="ml-auto text-xs text-slate-600">
          &#8984;Enter {status === 'done' && hasChecked ? 'copy prompt' : 'run review'}
        </span>
      </div>
    </div>
  );
}
