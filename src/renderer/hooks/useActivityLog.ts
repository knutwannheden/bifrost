import { useCallback, useEffect, useState } from 'react';
import type { ActivityEntry } from '../../shared/types';

interface UseActivityLogResult {
  entries: ActivityEntry[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useActivityLog(taskId: string | null): UseActivityLogResult {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
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
      const log = await window.bifrost.getActivityLog(taskId);
      setEntries(log);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch activity log');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  // Listen for live activity entries
  useEffect(() => {
    if (!taskId) return;
    const unsub = window.bifrost.onActivityEntry((entry) => {
      if (entry.taskId !== taskId) return;
      if (entry.type === 'commit') {
        // On commit, replace all entries with just the commit marker
        setEntries([entry]);
      } else {
        setEntries((prev) => [...prev, entry]);
      }
    });
    return unsub;
  }, [taskId]);

  return { entries, loading, error, refetch: fetchLog };
}
