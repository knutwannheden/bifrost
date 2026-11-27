import { projectEpic } from '../../shared/epic.ts';
import type { Task } from '../../shared/types.ts';
import { getTimeBucket, TIME_BUCKETS } from './time-buckets.ts';

const PINNED = 'Pinned';
const BUCKETS = [PINNED, ...TIME_BUCKETS] as const;
type Bucket = (typeof BUCKETS)[number];

export function taskSections(
  tasks: readonly Task[],
  {
    pinnedIds,
    collapsedBuckets,
    expandedEpicIds,
    activeTaskId,
    matchedIds,
  }: {
    pinnedIds: readonly string[];
    collapsedBuckets: readonly string[];
    expandedEpicIds: ReadonlySet<string>;
    activeTaskId: string | null;
    matchedIds: ReadonlySet<string> | null;
  },
) {
  const recency = (task: Task) => task.lastTurnBoundaryAt ?? task.createdAt;
  const open = tasks.filter((task) => task.status !== 'archived').sort((a, b) => recency(b) - recency(a));
  const roots = new Map(open.filter((task) => task.epic).map((task) => [task.id, task]));
  const attached = new Map<string, string>();
  for (const root of roots.values()) {
    if (!root.epic) continue;
    for (const id of projectEpic(root.epic).attachedTaskIds) {
      if (!attached.has(id)) attached.set(id, root.id);
    }
  }

  const groups = new Map<string, { root: Task; members: Task[]; recency: number }>();
  for (const task of open) {
    const creator = task.createdByTaskId ? roots.get(task.createdByTaskId) : undefined;
    const parent = task.epic ? undefined : (creator ?? roots.get(attached.get(task.id) ?? ''));
    const root = parent ?? task;
    let group = groups.get(root.id);
    if (!group) {
      group = { root, members: [], recency: recency(root) };
      groups.set(root.id, group);
    }
    if (parent) {
      group.members.push(task);
      group.recency = Math.max(group.recency, recency(task));
    }
  }

  const pinned = new Set(pinnedIds);
  const sections = new Map<
    Bucket,
    {
      bucket: Bucket;
      count: number;
      rows: { task: Task; rootId: string; child: boolean; foldable: boolean; pinIds: string[] }[];
    }
  >();
  for (const { root, members, recency } of [...groups.values()].sort((a, b) => b.recency - a.recency)) {
    const all = [root, ...members];
    const pinIds = all.map((task) => task.id).filter((id) => pinned.has(id));
    const shown =
      matchedIds && !matchedIds.has(root.id)
        ? members.filter((task) => matchedIds.has(task.id) || task.id === activeTaskId)
        : members;
    if (matchedIds && !matchedIds.has(root.id) && root.id !== activeTaskId && shown.length === 0) continue;

    const bucket = pinIds.length > 0 ? PINNED : getTimeBucket(recency);
    let section = sections.get(bucket);
    if (!section) {
      section = { bucket, count: 0, rows: [] };
      sections.set(bucket, section);
    }
    section.count += 1 + shown.length;

    const bucketFolded = !matchedIds && collapsedBuckets.includes(bucket);
    const activeInGroup = all.some((task) => task.id === activeTaskId);
    if (bucketFolded && !activeInGroup) continue;

    const epicFolded = !matchedIds && !expandedEpicIds.has(root.id);
    const foldable = !matchedIds && !bucketFolded && members.length > 0;
    section.rows.push({ task: root, rootId: root.id, child: false, foldable, pinIds });
    for (const task of shown) {
      if ((!bucketFolded && !epicFolded) || task.id === activeTaskId) {
        section.rows.push({ task, rootId: root.id, child: true, foldable: false, pinIds });
      }
    }
  }

  return BUCKETS.flatMap((bucket) => {
    const section = sections.get(bucket);
    return section ? [section] : [];
  });
}
