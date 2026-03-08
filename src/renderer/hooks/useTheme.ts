import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApp } from '../context/AppContext';

/** Check if the resolved theme is currently dark (reads from DOM). */
export function isDarkTheme(): boolean {
  return !document.documentElement.classList.contains('light');
}

/**
 * React hook that returns the resolved dark/light state and re-renders
 * when the system color scheme changes (for theme='system').
 */
export function useResolvedDark(): boolean {
  const { state } = useApp();
  const theme = state.config?.theme ?? 'system';

  const systemDark = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  return useMemo(() => {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return systemDark;
  }, [theme, systemDark]);
}

/**
 * Applies 'light' class on <html> based on config.theme and system preference.
 */
export function useTheme(): void {
  const isDark = useResolvedDark();

  useEffect(() => {
    document.documentElement.classList.toggle('light', !isDark);
  }, [isDark]);
}
