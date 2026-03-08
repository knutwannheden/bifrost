import { useCallback, useEffect, useState } from 'react';
import type { TokenDataPoint } from '../../shared/types';

interface UseTokenUsageResult {
  data: TokenDataPoint[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useTokenUsage(taskId: string | null): UseTokenUsageResult {
  const [data, setData] = useState<TokenDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!taskId) {
      setData([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.bifrost.getTokenUsage(taskId);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch token usage');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Re-fetch when new activity entries arrive (they may contain new token data)
  useEffect(() => {
    if (!taskId) return;
    const unsub = window.bifrost.onActivityEntry((entry) => {
      if (entry.taskId !== taskId) return;
      if (entry.type === 'claude_event' && entry.claudeEventKind === 'assistant_text') {
        // A new assistant message likely has token data — refetch
        fetchData();
      }
    });
    return unsub;
  }, [taskId, fetchData]);

  return { data, loading, error, refetch: fetchData };
}
