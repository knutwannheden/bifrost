# Replacing the tab strip with a time-grouped sidebar

## Problem

Open tasks live in a horizontal strip (`TaskBar.tsx`), which shows every running task in creation order. At 42 open tabs the strip holds far more than it can display, so finding a task means scrolling a single undifferentiated row.

The strip also gives every task equal weight. Grouped by when they were last touched, the 42 currently divide as:

| bucket | tabs |
|---|---|
| Today | 19 |
| This week | 2 |
| Last week | 5 |
| Older | 16 |

Two thirds have seen nothing for a week or more, yet occupy the same space as the handful being worked on.

Grouping by repository does not help: the same 42 split 25 / 12 / 3 / 2 across four repositories, leaving the largest pile intact.

## Approach

A vertical sidebar replaces the strip, listing tasks newest-first and grouping them by how recently they were touched. Groups below the current week collapse, so dormant work costs one line each rather than one line per task.

The grouping already exists. `TaskHistoryPanel.tsx` defines `TIME_BUCKETS` and `getTimeBucket` and uses them to group History. Both surfaces share that code, so the sidebar's groups and History's groups cannot drift — which matters because History is where the user searches when scanning fails.

Grouping by attention state instead — a "working" and a "needs you" group above the time buckets — was considered and rejected for now. It depends on `claudeActive` and `hasUnread`, which are not yet trusted; ordering the list by an unreliable signal would put the wrong tasks on top. It remains available as a later refinement, since it only adds groups above the existing ones.

## Recency

A task's recency is the newest modification time among every `.jsonl` in its Claude project directory, falling back to `createdAt` when there is none. One `readdir` and a few `stat` calls per task; no transcript parsing.

`getSessionMtime` currently reads only `<sessionId>.jsonl`. A task whose session was cleared or resumed points at a file that stopped changing, so 18 of the 42 open tasks fall back to `createdAt` and sort as though they were never touched. Taking the newest file in the directory covers cleared and resumed sessions, and covers a separate subagent transcript should one ever appear — on this machine subagent work is not written to its own file, and no transcript contains sidechain entries.

## Components

| File | Change |
|---|---|
| `src/renderer/components/TaskSidebar.tsx` | New. Groups, collapse, scroll. Replaces `TaskBar.tsx`. |
| `src/renderer/components/TaskTab.tsx` | Restyled as a vertical row. |
| `src/renderer/components/TaskBar.tsx` | Deleted. |
| `src/renderer/utils/time-buckets.ts` | New. `TIME_BUCKETS` and `getTimeBucket`, moved out of `TaskHistoryPanel.tsx`. |
| `src/renderer/components/TaskHistoryPanel.tsx` | Imports the shared bucket helpers. |
| `src/renderer/App.tsx` | Sidebar becomes a left column beside the content column. |
| `src/main/bifrost-api.ts` | `getSessionMtime` returns the newest transcript mtime in the project directory. |
| `src/shared/types.ts` | `BifrostConfig` gains sidebar width, hidden, and collapsed-bucket state. |

`TaskTab` is restyled rather than parameterised by orientation. The strip is going away, so a second layout would be dead weight. It keeps its inline rename, tooltip, context menu with Regenerate title, close button, activity indicators, and recency tinting.

## Behaviour

Tasks sort by recency descending, group by bucket, and render in `TIME_BUCKETS` order with empty groups omitted. Each header carries its name and count.

Groups from "This week" downward start collapsed. Collapse state persists in `BifrostConfig`, as do the sidebar's width and hidden state.

`nav.prevTab` and `nav.nextTab` (`Cmd+Shift+[` and `Cmd+Shift+]`) walk the visible order and skip collapsed groups. No positional bindings exist, so nothing else in the keymap changes.

## Dropping manual order

`TaskBar` supports drag-to-reorder backed by the `REORDER_TASKS` IPC channel. Sorting by recency makes a manual arrangement meaningless — the next session write would undo it — so the drag handlers go. The IPC channel and its handler stay in place, unused, rather than being removed in the same change.

## Testing

No test framework is configured, so verification is by inspection and by running the app:

- The sidebar lists every running task exactly once, and the count across groups equals the number of running tasks.
- A task with no transcript sorts by `createdAt` rather than disappearing or landing in the wrong group.
- A task whose session was cleared sorts by its newest transcript, not the stale one named by `sessionId`.
- Collapse state, width, and hidden state survive a restart.
- `Cmd+Shift+]` from the last visible item of an expanded group lands on the first visible item of the next expanded group, skipping collapsed ones.
- History's groups match the sidebar's for the same task.

## Out of scope

- A filter field in the sidebar. The intent is to absorb History's search later; the layout leaves room above the groups so it can be added without restructuring.
- Grouping by attention state, for the reason given under Approach.
- Removing the `REORDER_TASKS` channel.
