# Multi-Repo Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to create tasks that span multiple repositories, with each repo checked out as a worktree subdirectory in a lightweight container git repo.

**Architecture:** A multi-repo task uses a container git repo at `~/.bifrost/multi-tasks/<slug>/` with worktrees from selected repos as subdirectories. The container is registered as a Repo with `multiTaskId` set. The existing Task type is unchanged — the task points to the container repo. Cleanup on archive/delete removes all constituent worktrees, deletes the container, and unregisters the container repo.

**Tech Stack:** TypeScript, Electron IPC, React 19, Tailwind CSS, node-pty, git CLI

**Spec:** `docs/superpowers/specs/2026-03-31-multi-repo-tasks-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | Add `multiTaskId?` to `Repo`, add `multiRepoIds?` to `CreateTaskParams` |
| `src/main/worktree-manager.ts` | Modify | Add `createMultiRepoContainer()` and `cleanupMultiRepoContainer()` functions |
| `src/main/ipc-handlers.ts` | Modify | Multi-repo branch in `createTaskCore()`, multi-repo cleanup in `archiveTaskCore()` and `destroyTask()`, block reopen for multi-repo tasks |
| `src/main/task-store.ts` | Check | Ensure Repo serialization handles `multiTaskId` (may need no changes if config-based) |
| `src/renderer/components/TaskCreateDialog.tsx` | Modify | Add PillToggle for Single/Multi mode, multi-repo selection UI |
| `src/renderer/components/RepoDropdown.tsx` | Modify | Filter out repos where `multiTaskId` is set |
| `src/renderer/components/TaskHistoryPanel.tsx` | Modify | Hide reopen for multi-repo tasks |
| `src/renderer/components/RepoManager.tsx` | Modify | Filter out multi-repo container repos from the repo list |
| `src/renderer/components/DiffOverlay.tsx` | Modify | Disable or show message for multi-repo tasks |
| `src/renderer/components/StatusBar.tsx` | Modify | Hide DiffStatsBadge for multi-repo tasks |

---

### Task 1: Add type definitions

**Files:**
- Modify: `src/shared/types.ts:31-37` (Repo interface)
- Modify: `src/shared/types.ts:121-136` (CreateTaskParams interface)

- [ ] **Step 1: Add `multiTaskId` to Repo**

In `src/shared/types.ts`, add `multiTaskId?` to the `Repo` interface:

```typescript
export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  githubPath?: string;
  /** Set when this repo is a synthetic container for a multi-repo task */
  multiTaskId?: string;
}
```

- [ ] **Step 2: Add `multiRepoIds` to CreateTaskParams**

In the same file, add `multiRepoIds?` to `CreateTaskParams`:

```typescript
export interface CreateTaskParams {
  repoId?: string;
  repoPath?: string;
  name?: string;
  branch: string;
  branchName?: string;
  prInfo?: PrInfo;
  inPlace?: boolean;
  prompt?: string;
  /** Repo IDs for multi-repo task — when set, repoId/branch/inPlace/prInfo are ignored */
  multiRepoIds?: string[];
}
```

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS (type-only changes)

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add multiTaskId to Repo and multiRepoIds to CreateTaskParams"
```

---

### Task 2: Implement multi-repo container creation in worktree-manager

**Files:**
- Modify: `src/main/worktree-manager.ts`

This task adds two new exported functions: `createMultiRepoContainer()` for setting up the container with worktrees, and `cleanupMultiRepoContainer()` for tearing it down.

- [ ] **Step 1: Add `createMultiRepoContainer` function**

Add to `src/main/worktree-manager.ts`:

```typescript
import type { Repo } from '../shared/types';

/**
 * Create a multi-repo container: git init a directory, then create worktrees
 * from each selected repo as subdirectories.
 *
 * Returns the container path and a mapping of repo IDs to their worktree directories.
 */
export async function createMultiRepoContainer(
  taskSlug: string,
  repos: Repo[],
): Promise<{ containerPath: string; repoWorktrees: Map<string, string> }> {
  const containerPath = path.join(os.homedir(), '.bifrost', 'multi-tasks', taskSlug);
  await fs.promises.mkdir(containerPath, { recursive: true });

  // Init container repo
  await execFile('git', ['init'], { cwd: containerPath, timeout: 10000 });

  const repoWorktrees = new Map<string, string>();
  const dirNames: string[] = [];
  const dirNameSet = new Set<string>();
  const branchNames: string[] = []; // actual resolved branch names per repo
  const createdWorktrees: string[] = [];

  try {
    for (const repo of repos) {
      // Disambiguate directory names
      let dirName = repo.name;
      if (dirNameSet.has(dirName)) {
        let suffix = 2;
        while (dirNameSet.has(`${dirName}-${suffix}`)) suffix++;
        dirName = `${dirName}-${suffix}`;
      }
      dirNameSet.add(dirName);
      dirNames.push(dirName);

      const worktreePath = path.join(containerPath, dirName);
      const branchName = await resolveAvailableBranchName(repo.path, taskSlug);
      branchNames.push(branchName);

      await execFile(
        'git',
        ['worktree', 'add', worktreePath, '-b', branchName, repo.defaultBranch],
        { cwd: repo.path, timeout: 30000 },
      );
      createdWorktrees.push(worktreePath);
      repoWorktrees.set(repo.id, worktreePath);
    }

    // Write .gitignore
    const gitignoreContent = dirNames.join('\n') + '\n';
    await fs.promises.writeFile(path.join(containerPath, '.gitignore'), gitignoreContent);

    // Write CLAUDE.md
    const claudeMd = generateMultiRepoClaudeMd(taskSlug, repos, dirNames, branchNames);
    await fs.promises.writeFile(path.join(containerPath, 'CLAUDE.md'), claudeMd);

    // Commit initial state
    await execFile('git', ['add', '.gitignore', 'CLAUDE.md'], { cwd: containerPath, timeout: 10000 });
    await execFile('git', ['commit', '-m', 'Initial multi-repo task setup'], {
      cwd: containerPath,
      timeout: 10000,
    });
  } catch (err) {
    // Rollback: remove any worktrees we created
    for (const wt of createdWorktrees) {
      try {
        const dotGit = await fs.promises.readFile(path.join(wt, '.git'), 'utf-8');
        const gitDirMatch = dotGit.match(/gitdir:\s*(.+)/);
        if (gitDirMatch) {
          const gitDir = path.resolve(wt, gitDirMatch[1].trim());
          // .git/worktrees/<name> → .git is 2 levels up
          const parentGitDir = path.resolve(gitDir, '..', '..');
          const parentRepoPath = path.dirname(parentGitDir);
          await execFile('git', ['worktree', 'remove', wt, '--force'], {
            cwd: parentRepoPath,
            timeout: 10000,
          });
        }
      } catch { /* best effort cleanup */ }
    }
    // Remove container directory
    await fs.promises.rm(containerPath, { recursive: true, force: true });
    throw err;
  }

  return { containerPath, repoWorktrees };
}
```

- [ ] **Step 2: Add the CLAUDE.md generator helper**

Note: uses the actual resolved branch names (which may differ from `taskSlug` if a branch with that name already existed in a repo).

```typescript
function generateMultiRepoClaudeMd(
  taskSlug: string,
  repos: Repo[],
  dirNames: string[],
  branchNames: string[],
): string {
  const lines: string[] = [
    `# Multi-Repo Task: ${taskSlug}`,
    '',
    'This is a multi-repo task managed by Bifrost. Each subdirectory is a git worktree',
    'from a separate repository.',
    '',
    '## Repos',
    '',
    '| Directory | Repository | Branch |',
    '|-----------|-----------|--------|',
  ];

  for (let idx = 0; idx < repos.length; idx++) {
    const repo = repos[idx];
    const dir = dirNames[idx];
    const branch = branchNames[idx];
    lines.push(`| \`${dir}/\` | ${repo.path} | \`${branch}\` (from \`${repo.defaultBranch}\`) |`);
  }

  lines.push('');
  lines.push('Make changes in the repo subdirectories, not in this root directory.');
  lines.push('Each subdirectory has its own git history — commit changes within each repo directory separately.');
  lines.push('Do not run git commands (commit, push, etc.) from this root directory.');
  lines.push('');

  return lines.join('\n');
}
```

- [ ] **Step 3: Add `cleanupMultiRepoContainer` function**

```typescript
/**
 * Remove all constituent worktrees and delete the container directory.
 * Each subdirectory's .git file is read to find the parent repo for worktree removal.
 */
export async function cleanupMultiRepoContainer(containerPath: string): Promise<void> {
  // Find and remove each constituent worktree
  const entries = await fs.promises.readdir(containerPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const subPath = path.join(containerPath, entry.name);
    const dotGitPath = path.join(subPath, '.git');

    try {
      const stat = await fs.promises.stat(dotGitPath);
      if (!stat.isFile()) continue; // worktrees have .git as a file, not a directory

      const dotGit = await fs.promises.readFile(dotGitPath, 'utf-8');
      const gitDirMatch = dotGit.match(/gitdir:\s*(.+)/);
      if (!gitDirMatch) continue;

      const gitDir = path.resolve(subPath, gitDirMatch[1].trim());
      // .git/worktrees/<name> → .git is 2 levels up
      const parentGitDir = path.resolve(gitDir, '..', '..');
      const parentRepoPath = path.dirname(parentGitDir);

      await execFile('git', ['worktree', 'remove', subPath, '--force'], {
        cwd: parentRepoPath,
        timeout: 30000,
      });
    } catch {
      // Best effort — worktree may already be removed
    }
  }

  // Delete the container directory
  await fs.promises.rm(containerPath, { recursive: true, force: true });
}
```

- [ ] **Step 4: Add `import os from 'node:os'` at the top of the file**

The file currently imports `fs` and `path` but not `os`. Add:

```typescript
import os from 'node:os';
```

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/worktree-manager.ts
git commit -m "feat: add multi-repo container creation and cleanup functions"
```

---

### Task 3: Wire up multi-repo creation in ipc-handlers

**Files:**
- Modify: `src/main/ipc-handlers.ts:241-315` (createTaskCore)
- Modify: `src/main/ipc-handlers.ts:120-149` (archiveTaskCore)
- Modify: `src/main/ipc-handlers.ts:219-239` (destroyTask)
- Modify: `src/main/ipc-handlers.ts:509+` (REOPEN_TASK handler)

- [ ] **Step 1: Add multi-repo branch to `createTaskCore`**

At the top of `createTaskCore`, before the existing repo resolution logic, add a multi-repo branch:

```typescript
if (params.multiRepoIds?.length) {
  return createMultiRepoTask(params, mainWindow);
}
```

Then add the new function (can be in the same file or extracted — keep it in the same file for now):

```typescript
import { createMultiRepoContainer, cleanupMultiRepoContainer } from './worktree-manager';

async function createMultiRepoTask(params: CreateTaskParams, mainWindow: BrowserWindow): Promise<Task> {
  const config = loadConfig();
  const selectedRepos = params.multiRepoIds!.map((id) => {
    const repo = config.repos.find((r: Repo) => r.id === id);
    if (!repo) throw new Error(`Repo not found: ${id}`);
    return repo;
  });

  const name = params.name || generateTaskName();
  const taskId = randomUUID();
  const taskSlug = slugify(name);

  const { containerPath } = await createMultiRepoContainer(taskSlug, selectedRepos);

  // Register container as a Repo
  const containerRepo: Repo = {
    id: randomUUID(),
    name: taskSlug,
    path: containerPath,
    defaultBranch: 'main',
    multiTaskId: taskId,
  };
  config.repos.push(containerRepo);
  saveConfig(config);

  createSession(taskId, containerPath, mainWindow, {
    taskId,
    name,
    apiPort: getApiPort() ?? undefined,
    permissionMode: config.permissionMode,
    agentTeams: config.agentTeams,
    prompt: params.prompt,
  });

  const task: Task = {
    id: taskId,
    name,
    repoId: containerRepo.id,
    branch: 'main',
    worktreePath: containerPath,
    status: 'running',
    hasUnread: false,
    createdAt: Date.now(),
    ...(params.prompt ? { summary: params.prompt } : {}),
  };

  tasks.push(task);
  saveTasks(tasks);

  if (!_claudeCallbacks) throw new Error('IPC handlers not yet initialized');
  startWatching(task.id, containerPath, mainWindow, _claudeCallbacks, task.sessionId);

  return task;
}
```

Note: You'll need to import `slugify` from worktree-manager or duplicate it. The simplest approach is to export `slugify` from worktree-manager.

- [ ] **Step 2: Add multi-repo cleanup to `archiveTaskCore`**

**Important:** The multi-repo check must go *before* the existing worktree removal block, not after. A multi-repo task has `inPlace: undefined`, so the existing `!task.inPlace` guard would match and attempt `removeWorktree(containerPath, containerPath)` — which would fail since the container is a standalone repo, not a worktree.

Replace the existing worktree removal block in `archiveTaskCore` (the `if (!task.isExternal && !task.inPlace ...)` section) with:

```typescript
if (!task.isExternal && fs.existsSync(task.worktreePath)) {
  const config = loadConfig();
  const repo = config.repos.find((r: Repo) => r.id === task.repoId);
  if (repo?.multiTaskId === task.id) {
    // Multi-repo cleanup: remove constituent worktrees, container dir, and container repo
    try {
      await cleanupMultiRepoContainer(task.worktreePath);
    } catch { /* best effort */ }
    config.repos = config.repos.filter((r: Repo) => r.id !== repo.id);
    saveConfig(config);
  } else if (!task.inPlace && repo) {
    removeWorktree(repo.path, task.worktreePath).catch(() => {});
  }
}
```

- [ ] **Step 3: Add multi-repo cleanup to `destroyTask`**

Same pattern. Replace the existing worktree removal block in `destroyTask`:

```typescript
if (fs.existsSync(task.worktreePath)) {
  const config = loadConfig();
  const repo = config.repos.find((r: Repo) => r.id === task.repoId);
  if (repo?.multiTaskId === task.id) {
    try {
      await cleanupMultiRepoContainer(task.worktreePath);
    } catch { /* best effort */ }
    config.repos = config.repos.filter((r: Repo) => r.id !== repo.id);
    saveConfig(config);
  } else if (!task.inPlace && repo) {
    try {
      await removeWorktree(repo.path, task.worktreePath);
    } catch { /* Worktree may already be removed */ }
  }
}
```

- [ ] **Step 4: Block reopen for multi-repo tasks**

In the `REOPEN_TASK` handler, add an early check:

```typescript
ipcMain.handle(IPC.REOPEN_TASK, async (_event, taskId: string) => {
  const task = getTask(taskId);

  // Multi-repo tasks cannot be reopened (container is deleted on archive)
  const config = loadConfig();
  const repo = config.repos.find((r: Repo) => r.id === task.repoId);
  if (repo?.multiTaskId) {
    throw new Error('Multi-repo tasks cannot be reopened after archiving');
  }

  // ... rest of existing handler
```

- [ ] **Step 5: Export `slugify` from worktree-manager**

In `src/main/worktree-manager.ts`, change `function slugify` to `export function slugify`.

- [ ] **Step 6: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/worktree-manager.ts
git commit -m "feat: wire up multi-repo task creation, archive cleanup, and reopen guard"
```

---

### Task 4: Update the Create Task dialog UI

**Files:**
- Modify: `src/renderer/components/TaskCreateDialog.tsx`

- [ ] **Step 1: Add PillToggle and multi-repo state**

Add imports and state at the top of the component:

```typescript
import PillToggle from './PillToggle';
// ...

type TaskMode = 'single' | 'multi';

// Inside the component:
const [mode, setMode] = useState<TaskMode>('single');
const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());
```

- [ ] **Step 2: Add PillToggle to the dialog header area**

Right after the `<OverlayHeader>` and before the `<div className="p-4 space-y-4">`, or as the first child of the form area, add:

```tsx
{state.repos.filter((r) => !r.multiTaskId).length > 1 && (
  <div className="px-4 pt-3">
    <PillToggle
      options={[
        { value: 'single' as TaskMode, label: 'Single Repo' },
        { value: 'multi' as TaskMode, label: 'Multi Repo' },
      ]}
      value={mode}
      onChange={(v) => {
        setMode(v);
        setError(null);
      }}
    />
  </div>
)}
```

Only show the toggle when there are 2+ repos (multi-repo makes no sense with 0 or 1 repos).

- [ ] **Step 3: Build the multi-repo selection list**

When `mode === 'multi'`, replace the single-repo form (repo dropdown, branch picker, in-place checkbox) with a multi-select list:

```tsx
{mode === 'multi' ? (
  <>
    {/* Repo multi-select */}
    <div>
      <label className="block text-xs text-secondary mb-1">Select Repositories</label>
      <div className="border border-border-input rounded-sm max-h-[200px] overflow-y-auto">
        {state.repos.filter((r) => !r.multiTaskId).map((r) => (
          <label
            key={r.id}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={selectedRepoIds.has(r.id)}
              onChange={() => {
                setSelectedRepoIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(r.id)) next.delete(r.id);
                  else next.add(r.id);
                  return next;
                });
              }}
              className="rounded-sm border-border-input bg-surface-alt text-accent focus:ring-accent focus:ring-offset-0"
            />
            <span className="text-sm text-primary">{r.name}</span>
            <span className="text-xs text-muted truncate">{r.path}</span>
          </label>
        ))}
      </div>
    </div>

    {/* Task name */}
    <div>
      <label className="block text-xs text-secondary mb-1">
        Task <ActionLabel text="Name" showHint={true} />
      </label>
      <div className="flex gap-2">
        <FormInput
          ref={nameRef}
          type="text"
          value={taskName}
          onChange={(e) => setTaskName(e.target.value)}
          placeholder="Task name..."
          className="flex-1 px-3 py-1.5"
        />
        <button
          onClick={regenerateName}
          title={`Generate new name (${altSymbol}N)`}
          tabIndex={-1}
          className="px-2 py-1.5 bg-surface-alt border border-border-input rounded-sm text-secondary hover:text-primary hover:border-border-input text-sm transition-colors"
        >
          &#x21bb;
        </button>
      </div>
    </div>

    {/* Prompt */}
    <div>
      <label className="block text-xs text-secondary mb-1">
        <ActionLabel text="Prompt" showHint={true} />
      </label>
      <FormTextarea
        ref={promptRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.stopPropagation();
        }}
        placeholder="Initial prompt sent to Claude (optional)"
        rows={3}
        className="w-full px-3 py-1.5 resize-y"
      />
    </div>

    {error && <p className="text-xs text-danger">{error}</p>}
  </>
) : (
  // ... existing single-repo form (unchanged)
)}
```

- [ ] **Step 4: Update handleSubmit for multi-repo mode**

Modify `handleSubmit` to handle both modes:

```typescript
const handleSubmit = async () => {
  if (mode === 'multi') {
    if (selectedRepoIds.size < 2 || !taskName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const task = await window.bifrost.createTask({
        multiRepoIds: [...selectedRepoIds],
        name: taskName.trim(),
        branch: '', // ignored for multi-repo
        ...(prompt.trim() && { prompt: prompt.trim() }),
      });
      dispatch({ type: 'ADD_TASK', task });
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: task.id });
      close();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setLoading(false);
    }
    return;
  }

  // Existing single-repo logic unchanged
  if (!repoId || !taskName.trim() || (!inPlace && !branch)) return;
  // ... rest of existing handleSubmit
};
```

- [ ] **Step 5: Update the PrimaryButton disabled state and footer**

Update the disabled condition on the Create button to account for multi-repo mode:

```typescript
disabled={
  loading ||
  (mode === 'single' && (!repoId || !taskName.trim() || (!inPlace && !branch))) ||
  (mode === 'multi' && (selectedRepoIds.size < 2 || !taskName.trim()))
}
```

Update the footer hints for multi-repo mode (no branch shortcut):

```tsx
<span className="text-xs text-faint">
  {mode === 'multi'
    ? `${altSymbol}N name · ${altSymbol}P prompt · Enter create`
    : `${altSymbol}R repo · ${altSymbol}N name · ${altSymbol}B branch · ${altSymbol}P prompt · Enter create`
  }
</span>
```

- [ ] **Step 6: Auto-generate task name when switching to multi mode**

Generate a task name when the user switches to multi mode (similar to how single-repo mode generates on repo select). Use the mode change handler rather than a useEffect to avoid lint warnings about missing dependencies:

```typescript
onChange={(v) => {
  setMode(v);
  setError(null);
  if (v === 'multi' && !taskName) {
    setTaskName(generateTaskName());
  }
}}
```

- [ ] **Step 7: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/TaskCreateDialog.tsx
git commit -m "feat: add Multi Repo tab to Create Task dialog"
```

---

### Task 5: Filter multi-repo container repos from UI lists

**Files:**
- Modify: `src/renderer/components/RepoDropdown.tsx:66`
- Modify: `src/renderer/components/RepoManager.tsx:38`

- [ ] **Step 1: Filter container repos from RepoDropdown**

In `RepoDropdown.tsx`, the `filtered` list already filters repos. Add a `multiTaskId` filter:

```typescript
const filtered = repos.filter((r) => {
  if (r.multiTaskId) return false; // hide container repos
  // ... existing filter logic
});
```

Also filter from `selectedRepo` resolution — if someone passes a container repo ID, the dropdown should handle it gracefully.

- [ ] **Step 2: Filter container repos from RepoManager**

In `RepoManager.tsx`, update `filteredRepos`:

```typescript
const filteredRepos = state.repos.filter((r) => !r.multiTaskId && matchesAllTerms(`${repoDisplayName(r)} ${r.path}`, search));
```

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/RepoDropdown.tsx src/renderer/components/RepoManager.tsx
git commit -m "feat: filter multi-repo container repos from UI lists"
```

---

### Task 6: Hide reopen for multi-repo tasks, disable diff overlay, and hide diff stats

**Files:**
- Modify: `src/renderer/components/TaskHistoryPanel.tsx`
- Modify: `src/renderer/components/DiffOverlay.tsx` (or wherever the diff open action originates)
- Modify: `src/renderer/components/StatusBar.tsx`

- [ ] **Step 1: Identify multi-repo tasks in the renderer**

Multi-repo tasks can be identified by checking if `repo?.multiTaskId` is set. The renderer has access to `state.repos`. Add a helper or inline check:

```typescript
const isMultiRepoTask = (task: Task) => {
  const repo = state.repos.find((r) => r.id === task.repoId);
  return !!repo?.multiTaskId;
};
```

- [ ] **Step 2: Hide reopen button and keyboard shortcut for multi-repo tasks in TaskHistoryPanel**

In TaskHistoryPanel, find where the "Reopen" action is rendered for archived tasks and conditionally hide it. Also guard the `canReopen` function (or equivalent) used by keyboard handlers so that pressing the reopen shortcut on a multi-repo task does nothing:

```typescript
// In the canReopen check or handleReopen:
if (isMultiRepoTask(task)) return false;

// In the JSX:
{!isMultiRepoTask(task) && (
  // existing reopen button/action
)}
```

- [ ] **Step 3: Disable diff overlay for multi-repo tasks**

In the diff overlay trigger (likely a keyboard shortcut or button), add a guard:

```typescript
if (isMultiRepoTask(activeTask)) {
  // Don't open diff overlay — no meaningful single-repo diff
  return;
}
```

Alternatively, if the diff overlay is already open, show a message: "Diff view is not available for multi-repo tasks."

- [ ] **Step 4: Hide DiffStatsBadge for multi-repo tasks in StatusBar**

In `StatusBar.tsx`, find where `DiffStatsBadge` is rendered and add a guard:

```typescript
{!isMultiRepoTask(activeTask) && <DiffStatsBadge ... />}
```

The `IS_WORKTREE_DIRTY` check will also return misleading results for multi-repo tasks (container is always clean). This is a known v1 limitation — the dirty indicator will simply never show for multi-repo tasks.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/TaskHistoryPanel.tsx src/renderer/components/DiffOverlay.tsx src/renderer/components/StatusBar.tsx
git commit -m "feat: hide reopen, disable diff overlay, and hide diff stats for multi-repo tasks"
```

---

### Task 7: End-to-end manual test

- [ ] **Step 1: Start the app**

Run: `npm start`

- [ ] **Step 2: Ensure at least 2 repos are configured**

Open the repo manager and verify at least 2 repos are listed. Add repos if needed.

- [ ] **Step 3: Open Create Task dialog and verify PillToggle**

Press the Create Task shortcut. Verify:
- PillToggle appears with "Single Repo" and "Multi Repo" options
- "Single Repo" is selected by default
- Single Repo mode looks identical to before

- [ ] **Step 4: Switch to Multi Repo mode**

Click "Multi Repo". Verify:
- Repo dropdown is replaced with a checkbox list of repos (container repos filtered out)
- Task name field is present with auto-generated name
- Prompt field is present
- Branch picker and in-place checkbox are absent
- Footer hints updated (no branch shortcut)

- [ ] **Step 5: Create a multi-repo task**

Select 2+ repos, enter a name, optionally a prompt, and click Create. Verify:
- Container directory created at `~/.bifrost/multi-tasks/<slug>/`
- Worktree subdirectories exist for each selected repo
- `.gitignore` lists the repo directories
- `CLAUDE.md` documents the setup
- Claude Code session starts in the container directory
- Task appears in the task list

- [ ] **Step 6: Archive the multi-repo task**

Archive the task. Verify:
- Constituent worktrees removed from parent repos (`git worktree list` in each parent)
- Container directory deleted
- Container repo no longer in the repo list
- Task cannot be reopened (reopen action hidden)

- [ ] **Step 7: Verify container repos are hidden**

Check that:
- Container repos don't appear in RepoDropdown (Create Task dialog, single mode)
- Container repos don't appear in RepoManager
