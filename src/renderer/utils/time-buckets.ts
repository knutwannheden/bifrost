export const TIME_BUCKETS = [
  'Last 10 minutes',
  'Today',
  'Yesterday',
  'This week',
  'Last week',
  'This month',
  'Older',
] as const;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Which bucket a timestamp falls into, newest first. */
export function getTimeBucket(ts: number): (typeof TIME_BUCKETS)[number] {
  const now = new Date();
  const diffMs = now.getTime() - ts;

  if (diffMs < 10 * 60 * 1000) return 'Last 10 minutes';

  const today = startOfDay(now);
  const taskDay = startOfDay(new Date(ts));

  if (taskDay.getTime() === today.getTime()) return 'Today';

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (taskDay.getTime() === yesterday.getTime()) return 'Yesterday';

  const daysAgo = Math.floor((today.getTime() - taskDay.getTime()) / (24 * 60 * 60 * 1000));
  if (daysAgo < 7) return 'This week';
  if (daysAgo < 14) return 'Last week';
  if (daysAgo < 30) return 'This month';
  return 'Older';
}
