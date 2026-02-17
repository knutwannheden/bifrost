# PR-Aware Task Creation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect GitHub PR links on the clipboard when the Create Task dialog opens and auto-fill the dialog with the matched repo and PR branch.

**Architecture:** New IPC channels for clipboard reading and PR info fetching. PR metadata fetched via `gh` CLI with `git ls-remote` fallback. Worktree creation extended to fetch remote/fork branches and set upstream. Welcome screen shows `gh` install recommendation.

**Tech Stack:** Electron IPC, `gh` CLI, `git` CLI, React (TaskCreateDialog, TaskView)

---

### Task 1: Add `PrInfo` type and new IPC channels

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc-channels.ts`

**Step 1: Add `PrInfo` type to `src/shared/types.ts`**

Add after the `CreateTaskParams` interface (line 58):

```typescript
export interface PrInfo {
  number: number;
  title?: string; // unavailable in git-only fallback
  headBranch: string;
  headRepoOwner: string;
  headRepoName: string;
  isFork: boolean;
}
```

**Step 2: Add IPC channels to `src/shared/ipc-channels.ts`**

Add to the `IPC` object:

```typescript
  // Clipboard
  READ_CLIPBOARD: 'clipboard:read',

  // PR
  FETCH_PR_INFO: 'pr:fetch-info',
  CHECK_GH_AVAILABLE: 'gh:check',
```

Add to the `BifrostAPI` interface:

```typescript
  // Clipboard
  readClipboard(): Promise<string>;

  // PR
  fetchPrInfo(repoId: string, prNumber: number): Promise<import('./types').PrInfo>;
  checkGhAvailable(): Promise<boolean>;
```

Import `PrInfo` in the type imports at the top of `ipc-channels.ts`.

**Step 3: Commit**

```
feat: add PrInfo type and IPC channels for PR-aware task creation
```

---

### Task 2: Implement main process IPC handlers

**Files:**
- Modify: `src/main/ipc-handlers.ts`

**Step 1: Add clipboard read handler**

After the `SELECT_DIRECTORY` handler (line 614), add:

```typescript
  // Clipboard
  ipcMain.handle(IPC.READ_CLIPBOARD, () => {
    return clipboard.readText();
  });
```

**Step 2: Add `gh` availability check handler**

```typescript
  ipcMain.handle(IPC.CHECK_GH_AVAILABLE, async () => {
    try {
      await execFile('gh', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  });
```

**Step 3: Add PR info fetch handler**

```typescript
  ipcMain.handle(IPC.FETCH_PR_INFO, async (_event, repoId: string, prNumber: number) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);

    // Try gh CLI first
    try {
      const { stdout } = await execFile(
        'gh',
        ['pr', 'view', String(prNumber), '--json', 'headRefName,headRepositoryOwner,headRepository,title,number'],
        { cwd: repo.path, timeout: 10000 },
      );
      const data = JSON.parse(stdout);
      const headRepoOwner = data.headRepositoryOwner?.login ?? '';
      const headRepoName = data.headRepository?.name ?? '';
      const repoOwner = repo.githubPath?.split('/')[0] ?? '';
      return {
        number: data.number,
        title: data.title,
        headBranch: data.headRefName,
        headRepoOwner,
        headRepoName,
        isFork: headRepoOwner !== '' && headRepoOwner !== repoOwner,
      };
    } catch {
      // gh not available or failed — fall back to git
    }

    // Fallback: git ls-remote
    const { stdout: prRef } = await execFile(
      'git',
      ['ls-remote', 'origin', `refs/pull/${prNumber}/head`],
      { cwd: repo.path, timeout: 10000 },
    );
    const prSha = prRef.split('\t')[0];
    if (!prSha) throw new Error(`PR #${prNumber} not found`);

    // Try to find the branch name by matching SHA against remote refs
    let headBranch = `pull/${prNumber}/head`;
    try {
      const { stdout: refs } = await execFile(
        'git',
        ['ls-remote', '--heads', 'origin'],
        { cwd: repo.path, timeout: 10000 },
      );
      for (const line of refs.split('\n')) {
        const [sha, ref] = line.split('\t');
        if (sha === prSha && ref) {
          headBranch = ref.replace('refs/heads/', '');
          break;
        }
      }
    } catch {
      // ignore, use fallback branch name
    }

    return {
      number: prNumber,
      headBranch,
      headRepoOwner: '',
      headRepoName: '',
      isFork: false, // can't determine from git alone
    };
  });
```

**Step 4: Commit**

```
feat: add IPC handlers for clipboard read, gh check, and PR info fetch
```

---

### Task 3: Add preload bridge methods

**Files:**
- Modify: `src/preload/preload.ts`

**Step 1: Add the three new methods to the `api` object**

After the `selectDirectory` method, add:

```typescript
  // Clipboard
  readClipboard: () => ipcRenderer.invoke(IPC.READ_CLIPBOARD),

  // PR
  fetchPrInfo: (repoId, prNumber) => ipcRenderer.invoke(IPC.FETCH_PR_INFO, repoId, prNumber),
  checkGhAvailable: () => ipcRenderer.invoke(IPC.CHECK_GH_AVAILABLE),
```

**Step 2: Commit**

```
feat: expose clipboard, PR info, and gh check via preload bridge
```

---

### Task 4: Extend worktree creation for PR branches

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/worktree-manager.ts`
- Modify: `src/main/ipc-handlers.ts`

**Step 1: Extend `CreateTaskParams` to carry optional PR info**

In `src/shared/types.ts`, modify `CreateTaskParams`:

```typescript
export interface CreateTaskParams {
  repoId: string;
  name: string;
  branch: string;
  /** PR info for PR-sourced tasks — triggers fetch + upstream setup */
  prInfo?: PrInfo;
}
```

**Step 2: Add `createWorktreeFromPr` function in `worktree-manager.ts`**

Add after the existing `createWorktree` function:

```typescript
export async function createWorktreeFromPr(
  repoPath: string,
  taskName: string,
  prInfo: import('../shared/types').PrInfo,
): Promise<string> {
  const repoName = path.basename(repoPath);
  const worktreePath = path.join(
    os.homedir(),
    '.bifrost',
    'worktrees',
    repoName,
    taskName,
  );

  if (prInfo.isFork && prInfo.headRepoOwner) {
    // Add fork remote if not already present
    const remoteName = prInfo.headRepoOwner;
    try {
      await execFile('git', ['remote', 'get-url', remoteName], { cwd: repoPath });
    } catch {
      // Remote doesn't exist, add it
      const url = `https://github.com/${prInfo.headRepoOwner}/${prInfo.headRepoName}.git`;
      await execFile('git', ['remote', 'add', remoteName, url], { cwd: repoPath });
    }
    await execFile('git', ['fetch', remoteName, prInfo.headBranch], { cwd: repoPath });
    await execFile(
      'git',
      ['worktree', 'add', worktreePath, '-b', taskName, `${remoteName}/${prInfo.headBranch}`],
      { cwd: repoPath },
    );
    // Set upstream for pulling updates
    await execFile(
      'git',
      ['branch', '--set-upstream-to', `${remoteName}/${prInfo.headBranch}`, taskName],
      { cwd: worktreePath },
    );
  } else {
    // Same-repo PR — fetch branch from origin
    await execFile('git', ['fetch', 'origin', prInfo.headBranch], { cwd: repoPath });
    await execFile(
      'git',
      ['worktree', 'add', worktreePath, '-b', taskName, `origin/${prInfo.headBranch}`],
      { cwd: repoPath },
    );
    await execFile(
      'git',
      ['branch', '--set-upstream-to', `origin/${prInfo.headBranch}`, taskName],
      { cwd: worktreePath },
    );
  }

  return worktreePath;
}
```

**Step 3: Update CREATE_TASK handler in `ipc-handlers.ts`**

Import `createWorktreeFromPr` alongside `createWorktree`. In the `CREATE_TASK` handler (~line 196-229), change the worktree creation to:

```typescript
    const worktreePath = params.prInfo
      ? await createWorktreeFromPr(repo.path, params.name, params.prInfo)
      : await createWorktree(repo.path, params.name, params.branch);
```

**Step 4: Commit**

```
feat: extend worktree creation to handle PR branches with upstream tracking
```

---

### Task 5: Add PR detection to TaskCreateDialog

**Files:**
- Modify: `src/renderer/components/TaskCreateDialog.tsx`

**Step 1: Add PR URL parsing utility**

Add at the top of the file, after imports:

```typescript
interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

function parsePrUrl(text: string): ParsedPrUrl | null {
  const match = text.trim().match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/,
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}
```

**Step 2: Add PR state and clipboard detection effect**

Add new state variables after existing state declarations (~line 32):

```typescript
  const [prBanner, setPrBanner] = useState<{ number: number; title?: string; repoId?: string; headBranch?: string; message?: string } | null>(null);
  const [prInfo, setPrInfo] = useState<import('../../shared/types').PrInfo | null>(null);
```

Add a new `useEffect` for clipboard detection, right after the existing `useEffect` that focuses the repo input (after line 74):

```typescript
  // Detect PR URL on clipboard when dialog opens
  useEffect(() => {
    (async () => {
      try {
        const text = await window.bifrost.readClipboard();
        const parsed = parsePrUrl(text);
        if (!parsed) return;

        // Find matching repo
        const matchedRepo = state.repos.find(
          (r) => r.githubPath?.toLowerCase() === `${parsed.owner}/${parsed.repo}`.toLowerCase(),
        );

        if (!matchedRepo) {
          setPrBanner({ number: parsed.number, message: `PR #${parsed.number} detected but ${parsed.owner}/${parsed.repo} is not managed in Bifrost` });
          return;
        }

        // Fetch PR metadata
        const info = await window.bifrost.fetchPrInfo(matchedRepo.id, parsed.number);
        setPrInfo(info);

        // Auto-fill: select repo and set branch
        setRepoId(matchedRepo.id);
        setRepoSearch(repoDisplayName(matchedRepo));
        setPrBanner({
          number: info.number,
          title: info.title,
          repoId: matchedRepo.id,
          headBranch: info.headBranch,
        });
      } catch {
        // Clipboard read failed or PR fetch failed — silently ignore
      }
    })();
  }, []);
```

**Step 3: Auto-select PR branch when branches load**

In the existing `useEffect` that fetches branches (the one at ~line 76), add PR branch selection logic. After the branch list is loaded and default branch is selected, add:

```typescript
      // If PR detected, select the PR branch (add to list if not present)
      if (prBanner?.headBranch && prBanner?.repoId === repoId) {
        if (!b.includes(prBanner.headBranch)) {
          const withPrBranch = [prBanner.headBranch, ...b];
          setBranches(withPrBranch);
        }
        setBranch(prBanner.headBranch);
      }
```

**Step 4: Update `handleSubmit` to pass `prInfo`**

In the `handleSubmit` function, pass `prInfo` to `createTask`:

```typescript
      const task = await window.bifrost.createTask({
        repoId,
        name: taskName.trim(),
        branch,
        ...(prInfo && { prInfo }),
      });
```

**Step 5: Add PR banner UI**

Inside the dialog, right after `<div className="p-4 space-y-4">` (line 184), add:

```tsx
          {/* PR detection banner */}
          {prBanner && (
            <div className="flex items-center justify-between bg-blue-900/40 border border-blue-700/50 rounded px-3 py-2">
              <p className="text-xs text-blue-300">
                {prBanner.message
                  ? prBanner.message
                  : `PR #${prBanner.number}${prBanner.title ? `: ${prBanner.title}` : ''}`}
              </p>
              <button
                onClick={() => {
                  setPrBanner(null);
                  setPrInfo(null);
                  // Reset to default branch
                  const repo = state.repos.find((r) => r.id === repoId);
                  if (repo && branches.includes(repo.defaultBranch)) {
                    setBranch(repo.defaultBranch);
                  }
                }}
                className="text-xs text-blue-400 hover:text-blue-200 ml-3 whitespace-nowrap"
              >
                Ignore
              </button>
            </div>
          )}
```

**Step 6: Commit**

```
feat: detect PR URL on clipboard and auto-fill Create Task dialog
```

---

### Task 6: Add `gh` recommendation pill to welcome screen

**Files:**
- Modify: `src/renderer/components/TaskView.tsx`

**Step 1: Add `gh` availability state**

Add a new state variable after the existing state declarations (~line 34):

```typescript
  const [ghMissing, setGhMissing] = useState(false);
```

**Step 2: Check `gh` alongside integration check**

In the `useEffect` that checks integration status (line 76-83), add a parallel `gh` check:

```typescript
      window.bifrost.checkGhAvailable().then((available) => {
        setGhMissing(!available);
      });
```

**Step 3: Add recommendation pill in the welcome screen**

After the integration install block (after line 142, before the shortcuts grid), add:

```tsx
          {ghMissing && (
            <div className="mb-6">
              <div className="inline-flex items-center gap-2 bg-amber-900/30 border border-amber-700/40 rounded-full px-4 py-2">
                <span className="text-xs text-amber-300">
                  Install <a href="https://cli.github.com" onClick={(e) => { e.preventDefault(); window.bifrost.openUrl('https://cli.github.com'); }} className="underline hover:text-amber-200">GitHub CLI</a> to enable PR-based task creation
                </span>
              </div>
            </div>
          )}
```

**Step 4: Commit**

```
feat: show gh CLI recommendation on welcome screen when not installed
```

---

### Task 7: Verify and run lint

**Step 1: Run lint**

```bash
npm run lint
```

Fix any lint errors.

**Step 2: Manual smoke test**

1. Copy a GitHub PR URL to clipboard
2. Open Create Task dialog (Cmd+T)
3. Verify banner appears, repo and branch are pre-filled
4. Click Ignore — verify it resets to defaults
5. Test with a PR URL for an unmanaged repo — verify "not managed" message
6. Test with non-PR text on clipboard — verify normal behavior
7. Check welcome screen shows `gh` pill (temporarily rename `gh` binary or test on system without it)

**Step 3: Final commit if any lint fixes**

```
fix: lint fixes for PR-aware task creation
```
