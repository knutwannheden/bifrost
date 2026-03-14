# Session Metrics Overlay — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Metrics" tab to the Diff overlay that shows postmortem session metrics and cluster classification for the active task.

**Architecture:** The main process runs the postmortem tool's metric computation against the active task's JSONL transcript, classifies against the bundled cluster model, and returns results via a new IPC channel. The renderer shows metrics as a compact table with z-scores and flags, plus cluster assignment. Follows the existing `GET_TOKEN_USAGE` / `useTokenUsage` pattern exactly.

**Tech Stack:** TypeScript, React, Electron IPC, postmortem tool modules (imported directly from `tools/postmortem/src/`)

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/shared/types.ts` | Modify | Add `SessionMetricsResult` type |
| `src/shared/ipc-channels.ts` | Modify | Add `GET_SESSION_METRICS` channel + `BifrostAPI.getSessionMetrics()` |
| `src/main/session-metrics.ts` | Create | Main process: compute metrics from JSONL, classify against model |
| `src/main/ipc-handlers.ts` | Modify | Register the new IPC handler |
| `src/preload/preload.ts` | Modify | Wire `getSessionMetrics` in preload bridge |
| `src/renderer/hooks/useSessionMetrics.ts` | Create | React hook (follows `useTokenUsage` pattern) |
| `src/renderer/components/SessionMetricsPanel.tsx` | Create | The metrics tab content component |
| `src/renderer/components/DiffOverlay.tsx` | Modify | Add "Metrics" tab to PillToggle, render `SessionMetricsPanel` |
| `src/renderer/context/AppContext.tsx` | Modify | Add `'metrics'` to `DiffMode` union |

---

### Task 1: Shared types and IPC channel

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add SessionMetricsResult type to shared/types.ts**

```typescript
export interface SessionMetricEntry {
  name: string;
  label: string;
  value: number;
  zScore: number;
  flag: 'ok' | 'warn' | 'critical';
}

export interface SessionMetricsResult {
  metrics: SessionMetricEntry[];
  cluster: {
    index: number;
    label: string;
    distances: number[];
  } | null;
  backtrackDetail: Array<{ filePath: string; count: number }>;
}
```

- [ ] **Step 2: Add IPC channel**

In `ipc-channels.ts`, add to `IPC`:
```typescript
GET_SESSION_METRICS: 'metrics:get-session',
```

Add to `BifrostAPI`:
```typescript
getSessionMetrics(taskId: string): Promise<SessionMetricsResult>;
```

- [ ] **Step 3: Wire in preload.ts**

```typescript
getSessionMetrics: (taskId) => ipcRenderer.invoke(IPC.GET_SESSION_METRICS, taskId),
```

- [ ] **Step 4: Commit**

```
feat: add SessionMetricsResult type and IPC channel
```

---

### Task 2: Main process metrics computation

**Files:**
- Create: `src/main/session-metrics.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Create session-metrics.ts**

This module:
1. Finds the JSONL transcript for a task (same path logic as `claude-watcher.ts`)
2. Imports postmortem modules (`claude-parser`, `metrics`, `clustering`) directly
3. Computes metrics from the JSONL
4. Classifies against the bundled cluster model
5. Returns `SessionMetricsResult`

Key considerations:
- Import from `../../tools/postmortem/src/claude-parser.js` etc. (relative imports, Vite will handle them since they're TypeScript)
- Load `tools/postmortem/cluster-model.json` at module init
- Use the same JSONL path resolution as `getTokenUsageData` in `claude-watcher.ts` — check `claude-watcher.ts` for how it finds the JSONL path from `worktreePath` + `sessionId`
- Cache: store the last result + line count per task to avoid recomputing when nothing changed

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeTranscript, extractToolEvents, extractTokenTimeline } from '../../tools/postmortem/src/claude-parser.js';
import { computeMetrics } from '../../tools/postmortem/src/metrics.js';
import { classifyPoint, type ClusterModel } from '../../tools/postmortem/src/clustering.js';
import { parseDiff } from '../../tools/postmortem/src/diff-parser.js';
import type { SessionMetricsResult, SessionMetricEntry } from '../shared/types';
```

The function `getSessionMetricsData(worktreePath: string, sessionId?: string): SessionMetricsResult` should:
1. Find the JSONL file (follow the same logic used by `getTokenUsageData`)
2. Parse and compute metrics
3. Normalize metrics using model params and classify
4. Map each metric to a `SessionMetricEntry` with label, value, zScore, flag
5. Include backtrackDetail from the metrics

For the diff, attempt `git diff main` from the worktreePath. If it fails, use empty diff (metrics that need diff will be NaN, which maps to flag='ok' and won't show in the UI).

- [ ] **Step 2: Register IPC handler in ipc-handlers.ts**

```typescript
ipcMain.handle(IPC.GET_SESSION_METRICS, (_event, taskId: string) => {
  const task = getTask(taskId);
  return getSessionMetricsData(task.worktreePath, task.sessionId);
});
```

- [ ] **Step 3: Verify the imports work**

Run `npm start` to confirm the Vite build handles the cross-directory TypeScript imports. If Vite can't resolve `../../tools/postmortem/src/`, we may need to add the path to the Vite config's resolve aliases or copy the needed modules.

- [ ] **Step 4: Commit**

```
feat: add session metrics computation in main process
```

---

### Task 3: Renderer hook

**Files:**
- Create: `src/renderer/hooks/useSessionMetrics.ts`

- [ ] **Step 1: Create the hook**

Follow the `useTokenUsage` pattern exactly: useState for data/loading/error, useCallback for fetch, useEffect to fetch on taskId change, useEffect to refetch on activity entry.

```typescript
import { useCallback, useEffect, useState } from 'react';
import type { SessionMetricsResult } from '../../shared/types';

const EMPTY: SessionMetricsResult = { metrics: [], cluster: null, backtrackDetail: [] };

export function useSessionMetrics(taskId: string | null) {
  // ... same pattern as useTokenUsage
}
```

- [ ] **Step 2: Commit**

```
feat: add useSessionMetrics hook
```

---

### Task 4: Metrics panel component

**Files:**
- Create: `src/renderer/components/SessionMetricsPanel.tsx`

- [ ] **Step 1: Create the component**

Layout:
- Top: cluster assignment badge (if available) — "Cluster: Careful reads" with distance
- Middle: metrics table — each row shows: flag indicator ([!]/[X]/blank), label, value, z-score bar
- Bottom: backtrack detail (top 5 thrashing files) if any backtracks flagged

Follow Bifrost UI conventions:
- `text-primary` for metric labels, `text-secondary` for values
- `text-warning` for warn flags, `text-danger` for critical
- `text-muted` for z-scores
- `bg-surface` for the panel background
- `font-mono` for numeric values
- Compact table layout, no unnecessary whitespace

The component receives `SessionMetricsResult` as props (plus loading/error state).

- [ ] **Step 2: Commit**

```
feat: add SessionMetricsPanel component
```

---

### Task 5: Wire into DiffOverlay

**Files:**
- Modify: `src/renderer/context/AppContext.tsx`
- Modify: `src/renderer/components/DiffOverlay.tsx`

- [ ] **Step 1: Add 'metrics' to DiffMode**

In `AppContext.tsx`:
```typescript
export type DiffMode = 'git' | 'activity' | 'log' | 'review' | 'metrics';
```

- [ ] **Step 2: Add Metrics tab to DiffOverlay**

In `modeOptions` array, add:
```typescript
{ value: 'metrics', label: <ActionLabel text="Metrics" hintIndex={0} showHint={true} /> },
```

Add the `useSessionMetrics` hook call (similar to how `useTokenUsage` is called):
```typescript
const sessionMetrics = useSessionMetrics(
  showDiff && diffMode === 'metrics' && state.activeTaskId ? state.activeTaskId : null
);
```

Add the rendering block alongside the other mode panels:
```typescript
{state.activeTaskId && diffMode === 'metrics' && (
  <div className="flex-1 overflow-auto p-4">
    <SessionMetricsPanel
      data={sessionMetrics.data}
      loading={sessionMetrics.loading}
      error={sessionMetrics.error}
    />
  </div>
)}
```

Add `Alt+M` keyboard shortcut for the metrics tab, add `'metrics'` to the Tab-cycle array.

- [ ] **Step 3: Run `npm run lint` and fix any issues**

- [ ] **Step 4: Test manually**

Start the app with `npm start`, open a task, open the diff overlay (Cmd+D), switch to the Metrics tab. Verify:
- Metrics load and display
- Cluster assignment shows
- Flags render with correct colors
- Tab cycling includes the new tab
- Alt+M shortcut works

- [ ] **Step 5: Commit**

```
feat: add Metrics tab to DiffOverlay with session metrics and clustering
```
