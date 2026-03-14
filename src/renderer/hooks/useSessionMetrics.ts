import { useCallback, useEffect, useState } from 'react';
import type { SessionMetricsResult } from '../../shared/types';

const EMPTY: SessionMetricsResult = { metrics: [], cluster: null, backtrackDetail: [] };

interface UseSessionMetricsResult {
  data: SessionMetricsResult;
  loading: boolean;
  error: string | null;
}

export function useSessionMetrics(taskId: string | null): UseSessionMetricsResult {
  const [data, setData] = useState<SessionMetricsResult>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!taskId) {
      setData(EMPTY);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.bifrost.getSessionMetrics(taskId);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch session metrics');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Re-fetch when new assistant messages arrive (new tool calls = new metrics)
  useEffect(() => {
    if (!taskId) return;
    const unsub = window.bifrost.onActivityEntry((entry) => {
      if (entry.taskId !== taskId) return;
      if (entry.type === 'claude_event' && entry.claudeEventKind === 'assistant_text') {
        fetchData();
      }
    });
    return unsub;
  }, [taskId, fetchData]);

  return { data, loading, error };
}
