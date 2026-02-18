import { useState, useCallback, useEffect } from 'react';

interface UseDiffResult {
  diff: string | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useDiff(taskId: string | null, scope: 'working' | 'all' = 'working'): UseDiffResult {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!taskId) {
      setDiff(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await window.bifrost.getDiff(taskId, scope);
      setDiff(result.diff);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch diff');
    } finally {
      setLoading(false);
    }
  }, [taskId, scope]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  return { diff, loading, error, refetch: fetchDiff };
}
