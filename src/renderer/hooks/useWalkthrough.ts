import { useCallback, useEffect, useState } from 'react';
import type { Remapped, Staleness, Walkthrough } from '../../shared/walkthrough';

export interface UseWalkthroughResult {
  walkthrough: Walkthrough | null;
  staleness: Staleness | null;
  loading: boolean;
  /** The diff on screen: the walkthrough's own range, or the branch as it stands now. */
  diff: string | null;
  diffError: string | null;
  onCurrentHead: boolean;
  setOnCurrentHead: (on: boolean) => void;
  /** Present only on the current head, keyed by step or comment id. */
  remapped: Record<string, Remapped> | null;
  generating: boolean;
  generateError: string | null;
  generate: (focus: string | null) => void;
}

export function useWalkthrough(taskId: string): UseWalkthroughResult {
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null);
  const [staleness, setStaleness] = useState<Staleness | null>(null);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [onCurrentHead, setOnCurrentHead] = useState(false);
  const [remapped, setRemapped] = useState<Record<string, Remapped> | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await window.bifrost.getWalkthrough(taskId);
      setWalkthrough(result.walkthrough);
      setStaleness(result.staleness);
      setGenerating(result.generating);
      setGenerateError(result.error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    setOnCurrentHead(false);
    load();
  }, [load]);

  useEffect(() => {
    const offUpdated = window.bifrost.onWalkthroughUpdated((id) => {
      if (id === taskId) load();
    });
    // A commit moves the branch head, which is what staleness measures.
    const offActivity = window.bifrost.onActivityEntry((entry) => {
      if (entry.taskId === taskId && entry.type === 'commit') load();
    });
    return () => {
      offUpdated();
      offActivity();
    };
  }, [taskId, load]);

  useEffect(() => {
    if (!walkthrough) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffError(null);
    window.bifrost
      .getWalkthroughDiff(taskId, onCurrentHead)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((err) => {
        if (cancelled) return;
        // The commits a walkthrough was written against can be garbage-collected after a rebase.
        if (!onCurrentHead) setOnCurrentHead(true);
        else setDiffError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, walkthrough, onCurrentHead]);

  useEffect(() => {
    if (!walkthrough || !onCurrentHead) {
      setRemapped(null);
      return;
    }
    let cancelled = false;
    window.bifrost.remapWalkthrough(taskId).then((r) => {
      if (!cancelled) setRemapped(r);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, walkthrough, onCurrentHead, staleness?.currentHead]);

  const generate = useCallback(
    (focus: string | null) => {
      setGenerating(true);
      setGenerateError(null);
      window.bifrost.generateWalkthrough(taskId, focus).then((r) => {
        if (r.ok) setOnCurrentHead(false);
      });
    },
    [taskId],
  );

  return {
    walkthrough,
    staleness,
    loading,
    diff,
    diffError,
    onCurrentHead,
    setOnCurrentHead,
    remapped,
    generating,
    generateError,
    generate,
  };
}
