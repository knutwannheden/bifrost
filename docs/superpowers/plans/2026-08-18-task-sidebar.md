# Task Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the horizontal task strip with a vertical sidebar that groups open tasks by how recently they were touched.

**Architecture:** The time buckets already used by the History overlay move into a shared util so both surfaces group identically. `getSessionMtime` starts reporting the newest transcript in a task's project directory instead of one named file. A new `TaskSidebar` renders the groups; `TaskTab` is restyled as a vertical row and `TaskBar` is deleted.

**Tech Stack:** TypeScript, Electron, React 19, Tailwind v4, Biome, `tsc --noEmit`

**Spec:** `docs/superpowers/specs/2026-08-18-task-sidebar-design.md`

## Global Constraints

- No test framework is configured. Do NOT add one. Every task verifies with `npm run typecheck`, `npm run lint`, and a stated inspection.
- `npm run typecheck` has a pre-existing baseline of **24 errors**. A task passes when the total is 24 or fewer AND it introduced no new error. Do not assume a touched file is error-free at baseline — these already hold errors, and a task may legitimately touch them:

  | file | baseline errors |
  |---|---|
  | `src/main/main.ts` | 5 |
  | `tools/postmortem/src/bucketing.ts` | 4 |
  | `src/renderer/hooks/useKeymapEngine.ts` | 3 |
  | `src/renderer/hooks/useKeyboard.ts` | 3 |
  | `src/renderer/components/TokenUsageChart.tsx` | 3 |
  | `src/main/slack-service.ts` | 2 |
  | `src/main/bifrost-api.ts` | 2 |
  | `src/renderer/components/SupervisorOverlay.tsx` | 1 |
  | `src/renderer/components/KeyboardShortcutsPanel.tsx` | 1 |
- `npm run lint` must exit 0. It reports 4 pre-existing warnings in `supervisor-service.ts`; that is expected.
- Node is pinned by `.node-version` to 24.19.0. Run `eval "$(fnm env)" && fnm use` if commands fail on version grounds.
- Never operate on the live database at `~/.bifrost/bifrost.db`, and never modify anything under `~/.bifrost/backups/`.
- Never run `npm audit fix --force` or `npm audit fix --only=prod`.
- UI conventions (repo CLAUDE.md and `.claude/rules/ui-patterns.md`): semantic colour tokens only (`text-primary`, `bg-surface`, `text-muted`), never raw Tailwind colours; every hover state carries `transition-colors`; Tailwind classes rather than `style={{}}` except for measured sizing.
- Bifrost may be running while you work. Do NOT run `npm start` unless a task says to.

---

### Task 1: Share the time buckets

**Files:**
- Create: `src/renderer/utils/time-buckets.ts`
- Modify: `src/renderer/components/TaskHistoryPanel.tsx`

**Interfaces:**
- Produces: `TIME_BUCKETS: readonly string[]` and `getTimeBucket(ts: number): string`, imported by Task 4.

- [ ] **Step 1: Create the shared util**

Create `src/renderer/utils/time-buckets.ts` with exactly the logic `TaskHistoryPanel.tsx` uses today, moved unchanged:

```ts
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
export function getTimeBucket(ts: number): string {
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
```

- [ ] **Step 2: Delete the originals and import instead**

In `src/renderer/components/TaskHistoryPanel.tsx`, delete the local `TIME_BUCKETS`, `startOfDay` and `getTimeBucket` definitions, and add to the existing import block:

```ts
import { getTimeBucket, TIME_BUCKETS } from '../utils/time-buckets';
```

- [ ] **Step 3: Verify History still groups identically**

```bash
npm run typecheck 2>&1 | grep -E "TaskHistoryPanel|time-buckets" || echo "clean"
npm run lint
grep -c "getTimeBucket\|TIME_BUCKETS" src/renderer/components/TaskHistoryPanel.tsx
```

Expected: no errors naming either file, lint exit 0, and the grep showing only the import and its two call sites (3 or fewer). A higher count means a definition was left behind.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/utils/time-buckets.ts src/renderer/components/TaskHistoryPanel.tsx
git commit -m "refactor: share the time buckets between History and the sidebar"
```

---

### Task 2: Report the newest transcript as a task's recency

**Files:**
- Modify: `src/main/bifrost-api.ts` (`getSessionMtime`)

**Interfaces:**
- Produces: `getSessionMtime(worktreePath: string, sessionId?: string): number | null` — unchanged signature, now returning the newest `.jsonl` mtime in the task's project directory.

- [ ] **Step 1: Always scan the directory**

`getSessionMtime` currently returns the mtime of `<sessionId>.jsonl` when a `sessionId` is given, and only scans the directory when one is not. A task whose session was cleared or resumed names a file that stopped changing, so it reports as older than it is — or as `null` when the file is gone.

Replace the body after the `projectPath` existence check with the directory scan alone, dropping the `sessionId` branch entirely:

```ts
  // The newest transcript in the directory, which covers sessions replaced by
  // /clear or a resume as well as the one named by sessionId.
  try {
    const mtimes = fs
      .readdirSync(projectPath)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => fs.statSync(path.join(projectPath, f)).mtimeMs);
    return mtimes.length > 0 ? Math.max(...mtimes) : null;
  } catch {
    return null;
  }
}
```

Leave the `sessionId` parameter in the signature — callers pass it and a later change may narrow the scan again.

- [ ] **Step 2: Verify against real transcripts**

This reads only `~/.claude/projects`, never the database:

```bash
node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const base=path.join(os.homedir(),'.claude','projects');
let multi=0, differs=0;
for (const d of fs.readdirSync(base)) {
  const p=path.join(base,d);
  let files; try { files=fs.readdirSync(p).filter(f=>f.endsWith('.jsonl')); } catch { continue; }
  if (files.length<2) continue;
  multi++;
  const m=files.map(f=>fs.statSync(path.join(p,f)).mtimeMs);
  if (Math.max(...m)!==m[0]) differs++;
}
console.log('dirs with >1 transcript:',multi,'| where newest is not the first listed:',differs);
"
```

Expected: a non-zero count of multi-transcript directories, proving the scan has something to do. On the reference machine this was 15.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
npm run typecheck 2>&1 | grep "bifrost-api" || echo "clean"
npm run lint
git add src/main/bifrost-api.ts
git commit -m "fix: report a task's recency from its newest transcript"
```

---

### Task 3: Persist the sidebar's state

**Files:**
- Modify: `src/shared/types.ts` (`BifrostConfig`)

**Interfaces:**
- Produces: `BifrostConfig.sidebarWidth?: number`, `BifrostConfig.sidebarHidden?: boolean`, `BifrostConfig.collapsedBuckets?: string[]`. Task 4 reads and writes all three.

- [ ] **Step 1: Add the fields**

In `src/shared/types.ts`, inside `interface BifrostConfig`, add next to the other optional display settings:

```ts
  /** Sidebar width in pixels; unset means the default. */
  sidebarWidth?: number;
  sidebarHidden?: boolean;
  /** Names from TIME_BUCKETS whose groups are folded shut. */
  collapsedBuckets?: string[];
```

All three are optional so an existing `config.json` stays valid without a migration.

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck 2>&1 | grep -c "error TS"
git add src/shared/types.ts
git commit -m "feat: add sidebar layout settings to the config"
```

Expected: 24 or fewer.

---

### Task 4: Build the sidebar and delete the strip

**Files:**
- Create: `src/renderer/components/TaskSidebar.tsx`
- Modify: `src/renderer/components/TaskTab.tsx`
- Modify: `src/renderer/App.tsx`
- Delete: `src/renderer/components/TaskBar.tsx`

**Interfaces:**
- Consumes: `getTimeBucket` / `TIME_BUCKETS` from Task 1; `getSessionMtime` behaviour from Task 2; the three `BifrostConfig` fields from Task 3.

- [ ] **Step 1: Restyle `TaskTab` as a vertical row**

`TaskTab` keeps every behaviour it has — inline rename, hover tooltip, context menu with Regenerate title, close button, activity indicators, recency tinting. Only its layout changes. Replace the root `<button>`'s className and remove the drag attributes (`draggable`, `onDragStart`, `onDragEnd`) and the `onDragStart`/`onDragEnd` props from `TaskTabProps`:

```tsx
        className={`group relative flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
          isActive ? 'bg-surface-alt text-primary' : 'hover:bg-surface-hover text-secondary'
        }`}
```

Change the inner content block from the stacked-centre layout to a left-aligned row, keeping the same children:

```tsx
        <span className="flex flex-col min-w-0 flex-1 overflow-hidden">
          <span className="flex items-center gap-1.5">
            {regenerating ? <Spinner size="sm" /> : null}
            {task.hasUnread && !isActive && !showSolid ? (
              <span className="w-2 h-2 rounded-full bg-accent shrink-0" />
            ) : null}
            <span className="text-xs leading-tight truncate">{task.name}</span>
          </span>
          <span className="text-[10px] leading-tight truncate text-muted">{repoName}</span>
        </span>
```

Replace the three absolutely-positioned bottom bars (`activity-sweep`, the solid `bg-success` bar, and `tab-active-underline`) with left-edge equivalents, since a vertical row has no meaningful bottom edge:

```tsx
        {showSweep && !isActive && <span className="activity-sweep absolute top-0 bottom-0 left-0 w-[2px]" />}
        {showSolid && <span className="absolute top-0 bottom-0 left-0 w-[2px] bg-success" />}
        {isActive && <span className="absolute top-0 bottom-0 left-0 w-[2px] bg-accent" />}
```

Leave `recencyBg` and its `style={{ backgroundColor: … }}` as they are — it is a computed colour, which the UI rules permit.

- [ ] **Step 2: Create `TaskSidebar.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { repoDisplayName, shortPath } from '../utils/paths';
import { getTimeBucket, TIME_BUCKETS } from '../utils/time-buckets';
import TaskTab from './TaskTab';

const DEFAULT_WIDTH = 240;
// Anything older than the current week starts folded, so dormant work costs
// one line per group rather than one line per task.
const DEFAULT_COLLAPSED = ['This week', 'Last week', 'This month', 'Older'];

export default function TaskSidebar() {
  const { state, dispatch } = useApp();
  const [mtimes, setMtimes] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.bifrost.getSessionMtimes().then((m) => {
        if (!cancelled) setMtimes(m);
      });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const config = state.config;
  const collapsed = config?.collapsedBuckets ?? DEFAULT_COLLAPSED;
  const width = config?.sidebarWidth ?? DEFAULT_WIDTH;

  const openTasks = state.tasks.filter((t) => t.status === 'running');
  if (openTasks.length === 0) return null;

  const recency = (id: string, createdAt: number) => mtimes[id] ?? createdAt;
  const sorted = [...openTasks].sort((a, b) => recency(b.id, b.createdAt) - recency(a.id, a.createdAt));

  const groups = new Map<string, typeof sorted>();
  for (const task of sorted) {
    const bucket = getTimeBucket(recency(task.id, task.createdAt));
    const list = groups.get(bucket);
    if (list) list.push(task);
    else groups.set(bucket, [task]);
  }

  const toggle = (bucket: string) => {
    const next = collapsed.includes(bucket) ? collapsed.filter((b) => b !== bucket) : [...collapsed, bucket];
    if (config) {
      const updated = { ...config, collapsedBuckets: next };
      dispatch({ type: 'SET_CONFIG', config: updated });
      window.bifrost.saveConfig(updated);
    }
  };

  return (
    <div
      className="flex flex-col shrink-0 overflow-y-auto bg-surface/50 border-r border-border-default"
      style={{ width }}
    >
      {TIME_BUCKETS.filter((b) => groups.has(b)).map((bucket) => {
        const tasks = groups.get(bucket) ?? [];
        const isCollapsed = collapsed.includes(bucket);
        return (
          <div key={bucket}>
            <button
              type="button"
              onClick={() => toggle(bucket)}
              className="flex w-full items-center gap-1 px-2 py-1 text-xs font-semibold text-secondary uppercase tracking-wider hover:text-primary transition-colors"
            >
              <span className="w-3 shrink-0">{isCollapsed ? '▸' : '▾'}</span>
              <span className="truncate">{bucket}</span>
              <span className="ml-auto text-muted">{tasks.length}</span>
            </button>
            {!isCollapsed &&
              tasks.map((task) => {
                const repo = state.repos.find((r) => r.id === task.repoId);
                return (
                  <TaskTab
                    key={task.id}
                    task={task}
                    repoName={repo ? repoDisplayName(repo) : shortPath(task.worktreePath)}
                    isActive={task.id === state.activeTaskId}
                    onClick={() => dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id })}
                    onClose={() => {
                      window.bifrost.stopTask(task.id).then((updated) => {
                        dispatch({ type: 'UPDATE_TASK', task: updated });
                        if (state.activeTaskId === task.id) {
                          const remaining = openTasks.filter((t) => t.id !== task.id);
                          dispatch({
                            type: 'SET_ACTIVE_TASK',
                            taskId: remaining.length > 0 ? remaining[0].id : null,
                          });
                        }
                      });
                    }}
                    onRename={(name) => {
                      window.bifrost.renameTask(task.id, name).then((updated) => {
                        dispatch({ type: 'UPDATE_TASK', task: updated });
                      });
                    }}
                    onRegenerateTitle={async () => {
                      try {
                        const result = await window.bifrost.regenerateTaskTitle(task.id);
                        if (!result) {
                          dispatch({ type: 'SHOW_TOAST', message: 'No transcript to generate a title from' });
                          return;
                        }
                        dispatch({ type: 'UPDATE_TASK', task: result.task });
                        dispatch({
                          type: 'SHOW_TOAST',
                          message: result.renamedBranch
                            ? `Renamed to "${result.task.name}" on ${result.renamedBranch}`
                            : `Renamed to "${result.task.name}"`,
                        });
                      } catch {
                        dispatch({ type: 'SHOW_TOAST', message: 'Title generation failed' });
                      }
                    }}
                  />
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
```

`SET_CONFIG` is the action `AppContext` defines for replacing the config (`AppContext.tsx:91`), and its reducer also refreshes `state.repos` from it (`AppContext.tsx:277`). Use it as written; do not add a new action.

- [ ] **Step 3: Place it in the layout**

In `src/renderer/App.tsx`, remove `import TaskBar from './components/TaskBar';`, add `import TaskSidebar from './components/TaskSidebar';`, delete the `<TaskBar />` line from inside the content column, and render the sidebar as a sibling column before it:

```tsx
        <div className="flex flex-1 min-h-0">
          {!state.config?.sidebarHidden && <TaskSidebar />}
          {/* Content column — relative for overlay positioning */}
          <div className="flex flex-col flex-1 min-w-0 relative">
```

- [ ] **Step 4: Delete the strip**

```bash
git rm src/renderer/components/TaskBar.tsx
```

`REORDER_TASKS` and its IPC handler stay in place, unused.

- [ ] **Step 5: Verify statically**

```bash
npm run typecheck 2>&1 | grep -E "TaskSidebar|TaskTab|App\.tsx" || echo "clean"
npm run lint
grep -rn "TaskBar" src/ || echo "no references to the deleted strip remain"
```

Expected: no errors naming the touched files, lint exit 0, and no lingering `TaskBar` references.

- [ ] **Step 6: Verify in the app**

Run `npm start`. Confirm:
- every running task appears exactly once, and the counts on the headers sum to the number of open tasks
- groups from "This week" down start folded; clicking a header toggles it and the state survives a restart
- clicking a row switches task; the close button still stops it
- `Cmd+Shift+]` and `Cmd+Shift+[` move between visible rows and skip folded groups
- opening History shows the same task in the same bucket as the sidebar

- [ ] **Step 7: Commit**

```bash
git add -A src/renderer
git commit -m "feat: group open tasks by recency in a sidebar"
```

---

### Task 5: Make the sidebar resizable and hideable

**Files:**
- Modify: `src/renderer/components/TaskSidebar.tsx`
- Modify: `src/shared/keymap.ts`

**Interfaces:**
- Consumes: `BifrostConfig.sidebarWidth` and `sidebarHidden` from Task 3.

- [ ] **Step 1: Add a drag handle**

Inside `TaskSidebar`'s root element, after the groups, add a handle that writes the new width to config on release. Persisting only on release keeps one config write per drag rather than one per mouse-move:

```tsx
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startWidth = width;
          const onMove = (ev: MouseEvent) => {
            setDragWidth(Math.min(480, Math.max(160, startWidth + ev.clientX - startX)));
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setDragWidth((w) => {
              if (w != null && config) {
                const updated = { ...config, sidebarWidth: w };
                dispatch({ type: 'SET_CONFIG', config: updated });
                window.bifrost.saveConfig(updated);
              }
              return null;
            });
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40 transition-colors"
      />
```

Add `const [dragWidth, setDragWidth] = useState<number | null>(null);` beside the other state, make the root `relative`, and use `style={{ width: dragWidth ?? width }}` so the drag previews live without writing config on every frame.

- [ ] **Step 2: Add a toggle binding**

In `src/shared/keymap.ts`, add the action beside the other navigation entries:

```ts
  'nav.toggleSidebar': { id: 'nav.toggleSidebar', label: 'Toggle sidebar', category: 'navigation' },
```

and its default binding beside the other `kb(...)` lines:

```ts
  kb('nav.toggleSidebar', 'Cmd+B'),
```

Then add the handler in `src/renderer/hooks/useKeymapEngine.ts`, in the same `switch (actionId)` that holds `nav.prevTab`. `s` is the state snapshot the other cases already use:

```ts
        case 'nav.toggleSidebar': {
          if (s.config) {
            const updated = { ...s.config, sidebarHidden: !s.config.sidebarHidden };
            dispatch({ type: 'SET_CONFIG', config: updated });
            window.bifrost.saveConfig(updated);
          }
          break;
        }
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck 2>&1 | grep -E "TaskSidebar|keymap" || echo "clean"
npm run lint
```

Then `npm start` and confirm: dragging the edge resizes and the width survives a restart; `Cmd+B` hides and shows the sidebar and that also survives a restart; the width clamps between 160 and 480.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/TaskSidebar.tsx src/shared/keymap.ts
git commit -m "feat: resize and hide the task sidebar"
```

---

### Task 6: Make keyboard navigation follow the sidebar's order

**Files:**
- Modify: `src/renderer/context/AppContext.tsx`
- Modify: `src/renderer/components/TaskSidebar.tsx`
- Modify: `src/renderer/hooks/useKeymapEngine.ts:193-223`

**Interfaces:**
- Produces: `AppState.visibleTaskIds: string[]` and the action `{ type: 'SET_VISIBLE_TASK_IDS'; taskIds: string[] }`.

`nav.prevTab`, `nav.nextTab` and `nav.tab1`–`nav.tab9` all index `s.tasks.filter((t) => t.status === 'running')`, which is creation order. The sidebar renders by recency and omits rows in collapsed groups, so `Cmd+3` selects a different task than the third row on screen. The sidebar publishes the order it renders and the keymap engine indexes that.

- [ ] **Step 1: Carry the order in state**

In `src/renderer/context/AppContext.tsx`, add to the `AppState` interface beside the other task fields:

```ts
  /** Task ids in the order the sidebar renders them, collapsed groups excluded. */
  visibleTaskIds: string[];
```

Add to the `AppAction` union:

```ts
  | { type: 'SET_VISIBLE_TASK_IDS'; taskIds: string[] }
```

Add `visibleTaskIds: []` to the initial state object, and this case to the reducer:

```ts
    case 'SET_VISIBLE_TASK_IDS': {
      const { taskIds } = action;
      if (
        taskIds.length === state.visibleTaskIds.length &&
        taskIds.every((id, i) => id === state.visibleTaskIds[i])
      ) {
        return state;
      }
      return { ...state, visibleTaskIds: taskIds };
    }
```

Returning the same `state` object when the order is unchanged keeps this from re-rendering every consumer each time the sidebar recomputes.

- [ ] **Step 2: Publish the order from the sidebar**

In `src/renderer/components/TaskSidebar.tsx`, after `groups` is built, compute the flat visible order and publish it:

```ts
  const visibleTaskIds = TIME_BUCKETS.filter((b) => groups.has(b) && !collapsed.includes(b)).flatMap((b) =>
    (groups.get(b) ?? []).map((t) => t.id),
  );

  useEffect(() => {
    dispatch({ type: 'SET_VISIBLE_TASK_IDS', taskIds: visibleTaskIds });
  }, [visibleTaskIds.join(',')]);
```

- [ ] **Step 3: Index that order in the keymap engine**

In `src/renderer/hooks/useKeymapEngine.ts`, replace the body of the `nav.prevTab` / `nav.nextTab` case:

```ts
        case 'nav.prevTab':
        case 'nav.nextTab': {
          const ids = s.visibleTaskIds.length > 0 ? s.visibleTaskIds : s.tasks.filter((t) => t.status === 'running').map((t) => t.id);
          if (ids.length === 0) break;
          const currentIdx = ids.indexOf(s.activeTaskId ?? '');
          let newIdx: number;
          if (actionId === 'nav.prevTab') {
            newIdx = currentIdx <= 0 ? ids.length - 1 : currentIdx - 1;
          } else {
            newIdx = currentIdx >= ids.length - 1 ? 0 : currentIdx + 1;
          }
          dispatch({ type: 'SET_ACTIVE_TASK', taskId: ids[newIdx] });
          break;
        }
```

and the body of the `nav.tab1`–`nav.tab9` case:

```ts
        case 'nav.tab9': {
          const ids = s.visibleTaskIds.length > 0 ? s.visibleTaskIds : s.tasks.filter((t) => t.status === 'running').map((t) => t.id);
          const index = Number.parseInt(actionId.slice(-1), 10) - 1;
          if (index < ids.length) {
            dispatch({ type: 'SET_ACTIVE_TASK', taskId: ids[index] });
          }
          break;
        }
```

Keep every `case 'nav.tabN':` label above it exactly as it is. The fallback to running tasks covers the moment before the sidebar first publishes, and the case where the sidebar is hidden.

- [ ] **Step 4: Verify**

```bash
npm run typecheck 2>&1 | grep -E "AppContext|TaskSidebar|useKeymapEngine" || echo "clean"
npm run lint
```

Then `npm start` and confirm:
- `Cmd+3` selects the third row counting from the top of the sidebar
- collapsing a group above it makes `Cmd+3` select a different task, matching what is on screen
- `Cmd+Shift+]` steps down the visible rows and skips collapsed groups
- with the sidebar hidden (`Cmd+B`), `Cmd+3` still selects a task rather than doing nothing

- [ ] **Step 5: Commit**

```bash
git add src/renderer/context/AppContext.tsx src/renderer/components/TaskSidebar.tsx src/renderer/hooks/useKeymapEngine.ts
git commit -m "feat: index tab shortcuts by the sidebar's visible order"
```
