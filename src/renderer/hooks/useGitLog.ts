import { useState, useEffect, useCallback } from 'react';
import type { GitLogEntry } from '../../shared/types';

interface UseGitLogResult {
  entries: GitLogEntry[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useGitLog(taskId: string | null): UseGitLogResult {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLog = useCallback(async () => {
    if (!taskId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const log = await window.bifrost.getGitLog(taskId);
      setEntries(log);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch git log');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  return { entries, loading, error, refetch: fetchLog };
}
