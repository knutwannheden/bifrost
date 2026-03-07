import React, { useEffect, useRef } from 'react';
import type { ReviewEntry } from '../../shared/types';
import type { ReviewStatus } from '../context/AppContext';
import Spinner from './Spinner';
import { formatRelative } from '../utils/format-time';

interface ReviewSidebarProps {
  reviews: ReviewEntry[];
  activeReviewId: string | null;
  reviewStatuses: Record<string, ReviewStatus>;
  discussingReviewId: string | null;
  onSelect: (reviewId: string | null) => void;
  onNewReview: () => void;
  onDelete: (reviewId: string) => void;
}

export default function ReviewSidebar({
  reviews,
  activeReviewId,
  reviewStatuses,
  discussingReviewId,
  onSelect,
  onNewReview,
  onDelete,
}: ReviewSidebarProps) {
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Scroll active review into view
  useEffect(() => {
    if (!activeReviewId) return;
    const idx = reviews.findIndex((r) => r.id === activeReviewId);
    if (idx >= 0) itemRefs.current[idx]?.scrollIntoView({ block: 'nearest' });
  }, [activeReviewId, reviews]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when focus is in an input/textarea or terminal
      if (
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement instanceof HTMLInputElement ||
        (document.activeElement as HTMLElement)?.closest?.('.xterm')
      ) return;

      if (e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        onNewReview();
        return;
      }

      if (e.altKey && e.code === 'KeyD' && activeReviewId) {
        e.preventDefault();
        onDelete(activeReviewId);
        return;
      }

      if ((e.key === 'j' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const idx = activeReviewId ? reviews.findIndex((r) => r.id === activeReviewId) : -1;
        // Sorted newest first, so "down" goes to older
        if (idx < reviews.length - 1) {
          onSelect(reviews[idx + 1].id);
        }
        return;
      }

      if ((e.key === 'k' || e.key === 'ArrowUp') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const idx = activeReviewId ? reviews.findIndex((r) => r.id === activeReviewId) : reviews.length;
        if (idx > 0) {
          onSelect(reviews[idx - 1].id);
        }
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [reviews, activeReviewId, onSelect, onNewReview, onDelete]);

  // Reviews displayed newest first
  const sortedReviews = [...reviews].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="w-48 flex-shrink-0 border-r border-border-default flex flex-col overflow-hidden">
      <button
        onClick={onNewReview}
        className={`mx-2 mt-2 mb-1 px-3 py-1.5 text-xs rounded transition-colors ${
          activeReviewId === null
            ? 'bg-accent text-white'
            : 'bg-surface-alt hover:bg-surface-hover text-secondary'
        }`}
      >
        + <span className="underline underline-offset-2">N</span>ew Review
      </button>

      <div className="flex-1 overflow-y-auto">
        {sortedReviews.map((review, idx) => {
          const isActive = review.id === activeReviewId;
          const status = reviewStatuses[review.id];
          const isDiscussing = review.id === discussingReviewId;
          const number = reviews.length - reviews.indexOf(review);

          return (
            <div
              key={review.id}
              ref={(el) => { itemRefs.current[idx] = el; }}
              onClick={() => onSelect(review.id)}
              className={`px-3 py-2 cursor-pointer border-l-2 transition-colors ${
                isActive
                  ? 'bg-surface-alt/50 border-accent-hover'
                  : 'border-transparent hover:bg-surface'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted">#{number}</span>
                <span className={`px-1.5 py-0.5 text-[10px] rounded ${
                  review.scope === 'working'
                    ? 'bg-emerald-900/40 text-emerald-400'
                    : 'bg-blue-900/40 text-blue-400'
                }`}>
                  {review.scope === 'working' ? 'Working' : 'All'}
                </span>
                {status === 'running' && (
                  <Spinner size="sm" />
                )}
                {isDiscussing && <span className="text-xs" title="Discussion active">💬</span>}
              </div>
              <div className="text-[11px] text-muted mt-0.5 truncate">
                {review.instructions || 'No instructions'}
              </div>
              <div className="text-[10px] text-faint mt-0.5">
                {formatRelative(review.timestamp)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
