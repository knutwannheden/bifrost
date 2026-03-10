import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffStats, ReviewEntry } from '../../shared/types';
import type { ReviewStatus } from '../context/AppContext';
import { useApp } from '../context/AppContext';
import { formatElapsed } from '../utils/format-time';
import { isModKey } from '../utils/platform';
import ActionLabel from './ActionLabel';
import DiffStatsBadge from './DiffStatsBadge';
import FormTextarea from './FormTextarea';
import Kbd from './Kbd';
import PillToggle, { type PillOption } from './PillToggle';
import PrimaryButton from './PrimaryButton';
import Spinner from './Spinner';
import TerminalPane from './TerminalPane';

type ReviewScope = 'working' | 'all';

const scopeLabels: Record<ReviewScope, { text: string; hintIndex: number }> = {
  working: { text: 'Working tree', hintIndex: 8 },
  all: { text: 'All changes', hintIndex: 4 },
};

function ReviewScopeToggle({
  scope,
  onChange,
  stats,
}: {
  scope: ReviewScope;
  onChange: (s: ReviewScope) => void;
  stats: Record<ReviewScope, DiffStats | null | undefined>;
}) {
  const options: PillOption<ReviewScope>[] = (['working', 'all'] as const).map((s) => ({
    value: s,
    label: (
      <>
        <span>
          <ActionLabel text={scopeLabels[s].text} hintIndex={scopeLabels[s].hintIndex} showHint={true} />
        </span>
        {stats[s] && <DiffStatsBadge additions={stats[s].additions} deletions={stats[s].deletions} />}
      </>
    ),
  }));

  return <PillToggle options={options} value={scope} onChange={onChange} />;
}

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
    return (
      <h3 key={lineIndex} className="text-base font-semibold text-primary mt-4 mb-1">
        {renderInline(line.slice(4))}
      </h3>
    );
  }
  if (line.startsWith('## ')) {
    return (
      <h2 key={lineIndex} className="text-lg font-semibold text-primary mt-5 mb-2">
        {renderInline(line.slice(3))}
      </h2>
    );
  }
  if (line.startsWith('# ')) {
    return (
      <h1 key={lineIndex} className="text-xl font-bold text-primary mt-5 mb-2">
        {renderInline(line.slice(2))}
      </h1>
    );
  }

  // Checkbox lines: - [ ] or - [x]
  const checkboxMatch = line.match(/^(\s*)- \[([ xX])\] (.*)$/);
  if (checkboxMatch) {
    const isChecked = checkedLines.has(lineIndex);
    const indent = checkboxMatch[1].length;
    return (
      <label
        key={lineIndex}
        className="flex items-start gap-2 py-0.5 cursor-pointer hover:bg-surface-alt/30 rounded px-1 -mx-1"
        style={{ paddingLeft: indent * 4 }}
      >
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onToggle(lineIndex)}
          className="mt-1 accent-accent flex-shrink-0"
        />
        <span className="text-base text-primary">{renderInline(checkboxMatch[3])}</span>
      </label>
    );
  }

  // Regular bullet points
  const bulletMatch = line.match(/^(\s*)- (.*)$/);
  if (bulletMatch) {
    const indent = bulletMatch[1].length;
    return (
      <div key={lineIndex} className="flex items-start gap-2 py-0.5" style={{ paddingLeft: indent * 4 }}>
        <span className="text-muted flex-shrink-0 mt-0.5">-</span>
        <span className="text-base text-primary">{renderInline(bulletMatch[2])}</span>
      </div>
    );
  }

  // Empty lines
  if (!line.trim()) {
    return <div key={lineIndex} className="h-2" />;
  }

  // Paragraphs
  return (
    <p key={lineIndex} className="text-base text-primary py-0.5">
      {renderInline(line)}
    </p>
  );
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
        parts.push(
          <strong key={key++} className="text-primary font-semibold">
            {renderInline(remaining.slice(boldIdx + 2, endBold))}
          </strong>,
        );
        remaining = remaining.slice(endBold + 2);
        continue;
      }
    }

    if (nextCode <= nextBold) {
      // Try inline code
      const endCode = remaining.indexOf('`', codeIdx + 1);
      if (endCode >= 0) {
        if (codeIdx > 0) parts.push(remaining.slice(0, codeIdx));
        parts.push(
          <code key={key++} className="px-1 py-0.5 bg-surface-alt rounded text-sm text-warning font-mono">
            {remaining.slice(codeIdx + 1, endCode)}
          </code>,
        );
        remaining = remaining.slice(endCode + 1);
        continue;
      }
    }

    // No closing match found — emit rest as text
    parts.push(remaining);
    break;
  }

  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
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

function useElapsed(running: boolean, startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running || !startedAt) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - startedAt);
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(interval);
  }, [running, startedAt]);

  return elapsed;
}

interface ReviewContentProps {
  taskId: string;
  activeReviewId: string | null;
  onNewReviewCreated: (review: ReviewEntry) => void;
  onDiscussionChange: (reviewId: string | null) => void;
}

export default function ReviewContent({
  taskId,
  activeReviewId,
  onNewReviewCreated,
  onDiscussionChange,
}: ReviewContentProps) {
  const { state, dispatch } = useApp();

  const reviewId = activeReviewId;
  const content = reviewId ? (state.reviewContent[reviewId] ?? '') : '';
  const status: ReviewStatus = reviewId ? (state.reviewStatus[reviewId] ?? 'idle') : 'idle';

  // Review entry from manifest
  const reviews = state.reviews[taskId] ?? [];
  const activeEntry = reviewId ? reviews.find((r) => r.id === reviewId) : null;
  const hasReviewSession = !!activeEntry?.sessionId;

  // New review form state
  const [reviewScope, setReviewScope] = useState<ReviewScope>('working');
  const [reviewInstructions, setReviewInstructions] = useState('');
  const instructionsRef = useRef<HTMLTextAreaElement>(null);

  // Discussion terminal state (persisted in AppContext so it survives overlay close/reopen)
  const discussion = state.reviewDiscussion[taskId];
  const reviewPtySessionId = discussion?.ptySessionId ?? null;
  const discussingReviewId = discussion?.reviewId ?? null;
  const [showDiscussion, setShowDiscussion] = useState(
    () => discussingReviewId !== null && discussingReviewId === activeReviewId,
  );

  // Notify parent of discussion state changes
  useEffect(() => {
    onDiscussionChange(showDiscussion ? discussingReviewId : null);
  }, [showDiscussion, discussingReviewId, onDiscussionChange]);

  // Diff stats for both scopes (for new review form)
  const [scopeStats, setScopeStats] = useState<Record<ReviewScope, DiffStats | null | undefined>>({
    working: undefined,
    all: undefined,
  });
  useEffect(() => {
    let cancelled = false;
    Promise.all([window.bifrost.getDiffStats(taskId, 'working'), window.bifrost.getDiffStats(taskId, 'all')]).then(
      ([working, all]) => {
        if (!cancelled) setScopeStats({ working, all });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Whether current scope has changes (for enabling Run Review)
  const currentScopeStats = scopeStats[reviewScope];
  const canRunReview =
    currentScopeStats === undefined ||
    (currentScopeStats !== null && (currentScopeStats.additions > 0 || currentScopeStats.deletions > 0));

  const checkedLines = useMemo(() => parseCheckedLines(content), [content]);
  const hasChecked = checkedLines.size > 0;
  const lines = useMemo(() => content.split('\n'), [content]);

  // Load review content from disk when switching reviews
  useEffect(() => {
    if (!reviewId || status === 'running') return;
    window.bifrost.loadReview(taskId, reviewId).then((saved) => {
      if (saved) {
        dispatch({ type: 'SET_REVIEW_CONTENT', reviewId, content: saved });
        if (status !== 'done') {
          dispatch({ type: 'SET_REVIEW_STATUS', reviewId, status: 'done' });
        }
      }
    });
  }, [taskId, reviewId]);

  // Stream partial review output and external file changes
  useEffect(() => {
    const unsub = window.bifrost.onReviewProgress((tid, rid, updated) => {
      if (tid === taskId && rid === reviewId) {
        dispatch({ type: 'SET_REVIEW_CONTENT', reviewId: rid, content: updated });
        if (status !== 'running' && status !== 'done') {
          dispatch({ type: 'SET_REVIEW_STATUS', reviewId: rid, status: 'done' });
        }
      }
    });
    return unsub;
  }, [taskId, reviewId, status, dispatch]);

  // Update review entry when session ID arrives (set asynchronously via SessionStart hook)
  useEffect(() => {
    const unsub = window.bifrost.onReviewSession((tid, rid, sid) => {
      if (tid === taskId) {
        dispatch({ type: 'UPDATE_REVIEW_SESSION', taskId: tid, reviewId: rid, sessionId: sid });
      }
    });
    return unsub;
  }, [taskId, dispatch]);

  // Show last JSONL activity during review
  const [reviewActivity, setReviewActivity] = useState<string | null>(null);
  useEffect(() => {
    const unsub = window.bifrost.onReviewActivity((tid, _rid, activity) => {
      if (tid === taskId) setReviewActivity(activity);
    });
    return unsub;
  }, [taskId]);

  // Hide discussion view when switching to a different review
  useEffect(() => {
    setShowDiscussion(discussingReviewId !== null && discussingReviewId === reviewId);
  }, [reviewId, discussingReviewId]);

  const handleRunReview = useCallback(async () => {
    // Generate a temporary ID for tracking; the real one comes from the backend
    dispatch({ type: 'SET_REVIEW_STATUS', reviewId: '__pending__', status: 'running' });
    dispatch({ type: 'CLEAR_REVIEW_DISCUSSION', taskId });
    setShowDiscussion(false);
    setReviewActivity(null);
    try {
      const {
        reviewId: newReviewId,
        markdown,
        sessionId,
      } = await window.bifrost.runReview(taskId, reviewScope, reviewInstructions || undefined);
      const review: ReviewEntry = {
        id: newReviewId,
        scope: reviewScope,
        instructions: reviewInstructions?.trim() || undefined,
        timestamp: Date.now(),
        sessionId,
      };
      dispatch({ type: 'SET_REVIEW_STATUS', reviewId: '__pending__', status: 'idle' });
      dispatch({ type: 'SET_REVIEW_CONTENT', reviewId: newReviewId, content: markdown });
      dispatch({ type: 'SET_REVIEW_STATUS', reviewId: newReviewId, status: 'done' });
      dispatch({ type: 'MARK_REVIEW_UNREAD', taskId });
      dispatch({
        type: 'PUSH_NOTIFICATION',
        notification: {
          id: `review-done-${newReviewId}`,
          type: 'info',
          title: 'Review complete',
          message: `Code review finished for ${taskId}`,
          read: false,
          timestamp: Date.now(),
        },
      });
      onNewReviewCreated(review);
      setReviewInstructions('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'Review cancelled') {
        dispatch({ type: 'SHOW_TOAST', message: `Review failed: ${msg}` });
      }
      dispatch({ type: 'SET_REVIEW_STATUS', reviewId: '__pending__', status: 'idle' });
    }
  }, [taskId, reviewScope, reviewInstructions, dispatch, onNewReviewCreated]);

  const handleToggle = useCallback(
    (lineIndex: number) => {
      if (!reviewId) return;
      const newLines = [...lines];
      const line = newLines[lineIndex];
      if (/^\s*- \[ \]/.test(line)) {
        newLines[lineIndex] = line.replace('- [ ]', '- [x]');
      } else if (/^\s*- \[[xX]\]/.test(line)) {
        newLines[lineIndex] = line.replace(/- \[[xX]\]/, '- [ ]');
      }
      const updated = newLines.join('\n');
      dispatch({ type: 'SET_REVIEW_CONTENT', reviewId, content: updated });
      window.bifrost.saveReview(taskId, reviewId, updated);
    },
    [lines, taskId, reviewId, dispatch],
  );

  const handleCopyPrompt = useCallback(() => {
    const reviewPath = reviewId
      ? `~/.bifrost/tasks/${taskId}/reviews/${reviewId}.md`
      : `~/.bifrost/tasks/${taskId}/review.md`;
    const prompt = `/bifrost:review-fix ${reviewPath}`;
    navigator.clipboard.writeText(prompt);
    dispatch({ type: 'SHOW_TOAST', message: 'Copied /bifrost:review-fix \u2014 paste into Claude session' });
  }, [taskId, reviewId, dispatch]);

  const handleDiscuss = useCallback(async () => {
    if (!reviewId) return;
    if (reviewPtySessionId && discussingReviewId === reviewId) {
      setShowDiscussion(true);
      return;
    }
    try {
      const ptySessionId = await window.bifrost.resumeReview(taskId, reviewId);
      dispatch({ type: 'SET_REVIEW_DISCUSSION', taskId, reviewId, ptySessionId });
      setShowDiscussion(true);
    } catch (err) {
      dispatch({
        type: 'SHOW_TOAST',
        message: `Failed to resume review: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [taskId, reviewId, reviewPtySessionId, discussingReviewId, dispatch]);

  const handleCloseDiscussion = useCallback(() => {
    window.bifrost.closeReviewSession(taskId);
    dispatch({ type: 'CLEAR_REVIEW_DISCUSSION', taskId });
    setShowDiscussion(false);
  }, [taskId, dispatch]);

  const isReviewRunning = status === 'running' || state.reviewStatus.__pending__ === 'running';
  const elapsed = useElapsed(isReviewRunning, state.reviewStartedAt);

  const handleCancelReview = useCallback(() => {
    window.bifrost.cancelReview(taskId);
  }, [taskId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when in terminal
      if ((e.target as HTMLElement)?.closest?.('.xterm')) return;

      // Alt+C: cancel running review (checked before scope toggle to avoid collision)
      if (e.altKey && e.code === 'KeyC' && isReviewRunning) {
        e.preventDefault();
        handleCancelReview();
        return;
      }

      // New review form shortcuts
      if (!reviewId && !showDiscussion) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          setReviewScope(e.key === 'ArrowLeft' ? 'working' : 'all');
          return;
        }
        if (e.altKey && (e.code === 'KeyT' || e.code === 'KeyC')) {
          e.preventDefault();
          setReviewScope(e.code === 'KeyT' ? 'working' : 'all');
          return;
        }
        // Alt+I: focus instructions textarea
        if (e.altKey && e.code === 'KeyI') {
          e.preventDefault();
          instructionsRef.current?.focus();
          return;
        }
      }

      // Escape: blur input first, then return from discussion
      if (e.key === 'Escape') {
        if (
          document.activeElement instanceof HTMLTextAreaElement ||
          document.activeElement instanceof HTMLInputElement
        ) {
          e.preventDefault();
          const container = (document.activeElement as HTMLElement).closest<HTMLElement>('[tabindex]');
          (document.activeElement as HTMLElement).blur();
          container?.focus();
          return;
        }
        if (showDiscussion) {
          e.preventDefault();
          setShowDiscussion(false);
          return;
        }
      }

      if (e.key !== 'Enter') return;
      if (document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement)
        return;

      if (isModKey(e)) {
        if (status === 'done' && hasChecked) {
          e.preventDefault();
          handleCopyPrompt();
        }
      } else if (status === 'done' && hasReviewSession && !showDiscussion) {
        e.preventDefault();
        handleDiscuss();
      } else if (!reviewId && !showDiscussion && canRunReview) {
        // New review form → run review
        e.preventDefault();
        handleRunReview();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    reviewId,
    status,
    showDiscussion,
    hasChecked,
    hasReviewSession,
    canRunReview,
    isReviewRunning,
    handleCancelReview,
    handleCopyPrompt,
    handleDiscuss,
    handleRunReview,
  ]);

  // === New Review Form ===
  if (!reviewId) {
    const isRunning = state.reviewStatus.__pending__ === 'running';

    if (isRunning) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Spinner />
          <span className="text-sm text-secondary">
            Running review... <span className="text-muted">{formatElapsed(elapsed)}</span>
          </span>
          {reviewActivity && (
            <span className="text-xs text-muted max-w-md truncate" title={reviewActivity}>
              {reviewActivity}
            </span>
          )}
          <button
            onClick={handleCancelReview}
            className="px-3 py-1.5 text-xs text-secondary hover:text-primary hover:bg-surface-alt rounded transition-colors"
          >
            Cancel
          </button>
          <span className="text-xs text-faint">
            <Kbd>Alt+C</Kbd> to cancel
          </span>
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
          <div className="flex flex-col gap-2 w-full max-w-md">
            <label className="text-xs text-secondary">Scope:</label>
            <ReviewScopeToggle scope={reviewScope} onChange={setReviewScope} stats={scopeStats} />
          </div>
          <div className="flex flex-col gap-2 w-full max-w-md">
            <label className="text-xs text-secondary">
              <ActionLabel text="Instructions" showHint={true} /> (optional):
            </label>
            <FormTextarea
              ref={instructionsRef}
              value={reviewInstructions}
              onChange={(e) => setReviewInstructions(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && canRunReview) {
                  e.preventDefault();
                  handleRunReview();
                }
              }}
              placeholder="Focus on error handling, security..."
              className="w-full px-3 py-2 resize-none"
              rows={2}
            />
          </div>
          <button
            onClick={handleRunReview}
            disabled={!canRunReview}
            className={`px-3 py-1.5 rounded text-sm transition-colors ${
              canRunReview ? 'bg-accent hover:bg-accent-hover text-white' : 'bg-surface text-faint cursor-not-allowed'
            }`}
          >
            Run Review
          </button>
          {canRunReview ? (
            <span className="text-xs text-faint">
              <Kbd>Enter</Kbd> to run
            </span>
          ) : (
            <span className="text-xs text-faint">No changes to review for this scope.</span>
          )}
        </div>
      </div>
    );
  }

  // === Running state ===
  if (status === 'running') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default flex-shrink-0 text-secondary">
          <Spinner />
          <span className="text-sm">
            Running review... <span className="text-muted">{formatElapsed(elapsed)}</span>
          </span>
          {activeEntry && (
            <span
              className={`px-1.5 py-0.5 text-[10px] rounded ${
                activeEntry.scope === 'working' ? 'bg-success/15 text-success' : 'bg-accent/10 text-accent-hover'
              }`}
            >
              {activeEntry.scope === 'working' ? 'Working tree' : 'All changes'}
            </span>
          )}
          {reviewActivity && !content && (
            <span className="text-xs text-muted truncate max-w-xs" title={reviewActivity}>
              {reviewActivity}
            </span>
          )}
          <button
            onClick={handleCancelReview}
            className="ml-auto px-2 py-1 text-xs text-secondary hover:text-primary hover:bg-surface-alt rounded transition-colors flex-shrink-0"
          >
            Cancel
          </button>
        </div>
        {content && (
          <div className="flex-1 overflow-auto p-4">
            {lines.map((line, i) =>
              renderMarkdownLine(line, i, new Set(), () => {
                /* read-only during streaming */
              }),
            )}
          </div>
        )}
      </div>
    );
  }

  // === Error state ===
  if (status === 'error') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div className="text-danger text-sm">{content || 'Review failed'}</div>
      </div>
    );
  }

  // === Done state ===
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Metadata bar */}
      {activeEntry && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border-default flex-shrink-0 text-xs text-muted">
          <span
            className={`px-1.5 py-0.5 rounded ${
              activeEntry.scope === 'working' ? 'bg-success/15 text-success' : 'bg-accent/10 text-accent-hover'
            }`}
          >
            {activeEntry.scope === 'working' ? 'Working tree' : 'All changes'}
          </span>
          {activeEntry.instructions && (
            <span className="truncate max-w-xs" title={activeEntry.instructions}>
              &ldquo;{activeEntry.instructions}&rdquo;
            </span>
          )}
        </div>
      )}

      {/* Markdown review view — hidden (not unmounted) when discussion is active */}
      <div className="flex-1 flex flex-col min-h-0" style={{ display: showDiscussion ? 'none' : undefined }}>
        <div className="flex-1 overflow-auto p-4">
          {lines.map((line, i) => renderMarkdownLine(line, i, checkedLines, handleToggle))}
        </div>
        <div className="flex items-center gap-3 px-4 py-3 border-t border-border-default flex-shrink-0">
          <button
            onClick={handleCopyPrompt}
            disabled={!hasChecked}
            className={`px-3 py-1.5 rounded text-xs transition-colors ${
              hasChecked ? 'bg-accent hover:bg-accent-hover text-white' : 'bg-surface text-faint cursor-not-allowed'
            }`}
          >
            Copy Prompt
          </button>
          {hasReviewSession && !showDiscussion && (
            <PrimaryButton size="sm" onClick={handleDiscuss}>
              Discuss
            </PrimaryButton>
          )}
          {hasChecked && (
            <span className="text-xs text-faint">
              {checkedLines.size} item{checkedLines.size !== 1 ? 's' : ''} selected
            </span>
          )}
          <span className="ml-auto text-xs text-faint">
            {hasReviewSession && !showDiscussion && (
              <>
                <Kbd>Enter</Kbd> discuss
              </>
            )}
            {hasChecked && (
              <>
                {hasReviewSession && ' · '}
                <Kbd>Cmd+Enter</Kbd> copy prompt
              </>
            )}
          </span>
        </div>
      </div>

      {/* Discussion terminal — kept mounted when toggled away */}
      {reviewPtySessionId && discussingReviewId === reviewId && (
        <div className="flex-1 flex flex-col min-h-0" style={{ display: showDiscussion ? undefined : 'none' }}>
          <div className="flex-1 min-h-0">
            <TerminalPane sessionId={reviewPtySessionId} active={showDiscussion} focused={showDiscussion} />
          </div>
          <div className="flex items-center gap-3 px-4 py-2 border-t border-border-default flex-shrink-0">
            <button
              onClick={handleCloseDiscussion}
              className="px-3 py-1.5 text-xs text-secondary hover:text-primary hover:bg-surface-alt rounded transition-colors"
            >
              Close Discussion
            </button>
            <span className="text-xs text-faint">
              <Kbd>Esc</Kbd> back to review
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
