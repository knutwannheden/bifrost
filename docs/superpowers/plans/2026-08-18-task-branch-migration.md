# Task Branch Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `Task.branch` the meaning most call sites already assume — the worktree's own branch — and move the fork point to `Task.baseBranch`.

**Architecture:** A schema v3 migration renames the `branch` column to `base_branch` and adds a nullable `branch`, backfilled from each surviving worktree's `HEAD`. `createWorktree` starts returning the branch it creates so new tasks record both. Consumers that want the fork point are repointed to `baseBranch`; the rest become correct without changing.

**Tech Stack:** TypeScript, Electron, better-sqlite3, Biome, `tsc --noEmit`

**Spec:** `docs/superpowers/specs/2026-08-18-task-branch-migration-design.md`

## Global Constraints

- No test framework is configured. Every task verifies with `npm run typecheck`, `npm run lint`, and a stated manual/data check. Do not add a test framework.
- `npm run typecheck` reports a pre-existing baseline of **24 errors**. A task passes when the count is 24 or lower and none of the errors name a file the task touched.
- `npm run lint` must exit 0. It reports 4 pre-existing warnings; that is expected.
- Node is pinned by `.node-version` to 24.19.0. Run `fnm use` if the shell is on another version.
- Never run `npm audit fix --force` (it downgrades electron-forge to v6) or `npm audit fix --only=prod` (it prunes devDependencies).
- Never operate on the live database at `~/.bifrost/bifrost.db`. Copy it to `$TMPDIR` for any verification.
- `branch` is optional throughout. Treat `undefined` as a supported state, never as an error.

---

### Task 1: Add `baseBranch` to the Task type

**Files:**
- Modify: `src/shared/types.ts:41-65`

**Interfaces:**
- Produces: `Task.baseBranch: string` (the ref the worktree was forked from) and `Task.branch?: string` (the worktree's own branch, `undefined` when unknown). Every later task depends on these names.

- [ ] **Step 1: Change the Task fields**

In `src/shared/types.ts`, replace the existing `branch: string;` line inside `interface Task` with:

```ts
  /** The ref this worktree was created from. */
  baseBranch: string;
  /** The worktree's own branch; undefined when it could not be recovered. */
  branch?: string;
```

- [ ] **Step 2: Observe the compiler list every consumer**

Run: `npm run typecheck 2>&1 | grep -c "error TS"`

Expected: a count **above** the 24 baseline. This is the point of the step — the new errors enumerate every site that must be visited in Tasks 3–8. Save the list:

```bash
npm run typecheck 2>&1 | grep "error TS" > /tmp/branch-migration-sites.txt
wc -l /tmp/branch-migration-sites.txt
```

- [ ] **Step 3: Commit the type change alone**

```bash
git add src/shared/types.ts
git commit -m "refactor: split task branch into base and worktree branch"
```

The tree does not compile after this commit. That is intentional and is resolved by Task 8; do not push until then.

---

### Task 2: Migrate the database schema

**Files:**
- Modify: `src/main/db.ts:11` (version constant), `src/main/db.ts:15-40` (CREATE TABLE), `src/main/db.ts:183-189` (migration chain)

**Interfaces:**
- Consumes: nothing.
- Produces: a `tasks` table with `base_branch TEXT NOT NULL` and `branch TEXT` (nullable). Task 3 reads and writes these column names.

- [ ] **Step 1: Bump the schema version**

In `src/main/db.ts`, change:

```ts
const CURRENT_VERSION = 2;
```

to:

```ts
const CURRENT_VERSION = 3;
```

- [ ] **Step 2: Update the CREATE TABLE for fresh installs**

In the `tasks` table definition, replace the line `branch        TEXT NOT NULL,` with:

```sql
  base_branch   TEXT NOT NULL,
  branch        TEXT,
```

- [ ] **Step 3: Add the v3 migration**

In the migration chain, immediately after the `if (row.version < 2) { … }` block, add:

```ts
    if (row.version < 3) {
      d.exec('ALTER TABLE tasks RENAME COLUMN branch TO base_branch');
      d.exec('ALTER TABLE tasks ADD COLUMN branch TEXT');
      backfillTaskBranches(d);
      console.log('[db] Migration v3: split tasks.branch into base_branch + branch');
    }
```

- [ ] **Step 4: Implement the backfill**

Add to `src/main/db.ts`, above `openDatabase`:

```ts
/**
 * Recover each task's own branch from its worktree. A directory that is gone,
 * or on a detached HEAD, leaves the branch unknown.
 */
function backfillTaskBranches(d: Database.Database): void {
  const rows = d
    .prepare<unknown[], { id: string; worktree_path: string }>(
      'SELECT id, worktree_path FROM tasks WHERE worktree_path IS NOT NULL',
    )
    .all();
  const update = d.prepare('UPDATE tasks SET branch = ? WHERE id = ?');
  let recovered = 0;
  for (const row of rows) {
    if (!fs.existsSync(row.worktree_path)) continue;
    try {
      const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: row.worktree_path,
        timeout: 5000,
        encoding: 'utf-8',
      }).trim();
      if (branch) {
        update.run(branch, row.id);
        recovered++;
      }
    } catch {
      // Worktree unreadable or detached; the branch stays unknown.
    }
  }
  console.log(`[db] Migration v3: recovered ${recovered} of ${rows.length} task branches`);
}
```

`src/main/db.ts` already imports `fs` and `Database from 'better-sqlite3'`, so `Database.Database` resolves. Add one import at the top:

```ts
import { execFileSync } from 'node:child_process';
```

- [ ] **Step 5: Verify the migration against a copy of the real database**

```bash
cp ~/.bifrost/bifrost.db "$TMPDIR/mig.db"
sqlite3 "$TMPDIR/mig.db" "ALTER TABLE tasks RENAME COLUMN branch TO base_branch; ALTER TABLE tasks ADD COLUMN branch TEXT;"
sqlite3 -csv "$TMPDIR/mig.db" "SELECT count(*) AS total, count(base_branch) AS with_base, count(branch) AS with_branch FROM tasks;"
```

Expected: `1046,1046,0` — every row keeps its fork point, and `branch` starts empty. This proves the rename preserves data before any application code runs it.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck 2>&1 | grep -E "db\.ts" || echo "db.ts clean"
git add src/main/db.ts
git commit -m "feat: migrate tasks schema to separate base and worktree branch"
```

---

### Task 3: Persist both fields in the task store

**Files:**
- Modify: `src/main/task-store.ts:7-42` (`rowToTask`), `src/main/task-store.ts:44-49` (`UPSERT_SQL`), `src/main/task-store.ts:51-80` (`taskParams`)

**Interfaces:**
- Consumes: the `base_branch` and `branch` columns from Task 2.
- Produces: round-tripping of `Task.baseBranch` and `Task.branch` through SQLite.

- [ ] **Step 1: Read both columns in `rowToTask`**

Replace `branch: row.branch,` in the base object literal with:

```ts
    baseBranch: row.base_branch,
```

and add to the optional-field block below it (next to the other `!= null` guards):

```ts
  if (row.branch != null) task.branch = row.branch;
```

- [ ] **Step 2: Write both columns**

In `UPSERT_SQL`, change the column list `id, name, repo_id, branch, worktree_path,` to:

```sql
  id, name, repo_id, base_branch, branch, worktree_path,
```

and add one more `?` to the `VALUES` list so it has 25 placeholders.

- [ ] **Step 3: Supply both parameters**

In `taskParams`, replace `t.branch ?? '',` with:

```ts
    t.baseBranch ?? '',
    t.branch ?? null,
```

- [ ] **Step 4: Verify placeholder and parameter counts match**

```bash
node -e "
const s=require('fs').readFileSync('src/main/task-store.ts','utf8');
const cols=s.match(/INSERT OR REPLACE INTO tasks \(([^)]*)\)/)[1].split(',').length;
const qs=(s.match(/VALUES \(([^)]*)\)/)[1].match(/\?/g)||[]).length;
console.log('columns:',cols,'placeholders:',qs);
if(cols!==qs) throw new Error('MISMATCH');
"
```

Expected: `columns: 25 placeholders: 25`. A mismatch throws — this is the failure mode that silently corrupts every row.

- [ ] **Step 5: Commit**

```bash
git add src/main/task-store.ts
git commit -m "feat: persist base branch and worktree branch separately"
```

---

### Task 4: Return the created branch from worktree creation

**Files:**
- Modify: `src/main/worktree-manager.ts:64-129` (`createWorktree`), `src/main/worktree-manager.ts:131-181` (`createWorktreeFromPr`)

**Interfaces:**
- Produces: `createWorktree(...): Promise<{ worktreePath: string; branch: string }>` and `createWorktreeFromPr(...): Promise<{ worktreePath: string; branch: string }>`. Task 5 destructures both.

- [ ] **Step 1: Change `createWorktree`'s return type and value**

Change the signature's return type from `Promise<string>` to:

```ts
): Promise<{ worktreePath: string; branch: string }> {
```

and change its final `return worktreePath;` to:

```ts
  return { worktreePath, branch: newBranchName };
```

- [ ] **Step 2: Change `createWorktreeFromPr` the same way**

Change its return type from `Promise<string>` to `Promise<{ worktreePath: string; branch: string }>`, and change its final `return worktreePath;` to:

```ts
  return { worktreePath, branch: localBranch };
```

- [ ] **Step 3: Confirm the compiler flags the one caller**

Run: `npm run typecheck 2>&1 | grep "ipc-handlers"`

Expected: an error at the `createWorktree` / `createWorktreeFromPr` call site in `createTaskCore`. Task 5 fixes it.

- [ ] **Step 4: Commit**

```bash
git add src/main/worktree-manager.ts
git commit -m "feat: return the created branch from worktree creation"
```

---

### Task 5: Record both branches when creating a task

**Files:**
- Modify: `src/main/ipc-handlers.ts:372-441` (`createTaskCore`)

**Interfaces:**
- Consumes: `createWorktree` / `createWorktreeFromPr` from Task 4; `Task.baseBranch` / `Task.branch` from Task 1.
- Produces: new tasks with both fields populated.

- [ ] **Step 1: Rename the local base variable**

In `createTaskCore`, rename the local `branch` to `baseBranch` throughout the function. It is declared as `let branch = repo.defaultBranch;` and reassigned from `params.branch` and, for in-place tasks, from `git symbolic-ref`.

- [ ] **Step 2: Capture the created branch**

Replace the worktree-creation block with:

```ts
  let taskBranch: string | undefined;
  if (params.inPlace) {
    const conflict = tasks.find((t) => t.status !== 'archived' && t.worktreePath === repo.path);
    if (conflict) {
      throw new Error(`An active task "${conflict.name}" already uses the main worktree for this repo`);
    }
    worktreePath = repo.path;
    const { stdout } = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo.path, timeout: 5000 });
    baseBranch = stdout.trim();
    inPlace = true;
    taskBranch = baseBranch;
  } else {
    const created = params.prInfo
      ? await createWorktreeFromPr(repo.path, name, params.prInfo)
      : await createWorktree(repo.path, name, baseBranch, params.branchName);
    worktreePath = created.worktreePath;
    taskBranch = created.branch;
  }
```

An in-place task works directly on the repository's checked-out branch, so its own branch and its base are the same ref.

- [ ] **Step 3: Store both on the new task**

In the `const task: Task = { … }` literal, replace `branch,` with:

```ts
    baseBranch,
    ...(taskBranch ? { branch: taskBranch } : {}),
```

- [ ] **Step 4: Verify a new task records both**

Start the app (`npm start`), create a task, then:

```bash
sqlite3 -csv ~/.bifrost/bifrost.db "SELECT name, base_branch, branch FROM tasks ORDER BY created_at DESC LIMIT 1;"
```

Expected: `base_branch` is the ref you forked from (e.g. `origin/main`) and `branch` is the generated task branch — two different values.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat: record a task's own branch at creation"
```

---

### Task 6: Repoint the fork-point consumers

**Files:**
- Modify: `src/main/ipc-handlers.ts:808-810` (git log base), `src/main/ipc-handlers.ts` (the `isWorktreeDisposable` call inside `archiveTaskCore`), `src/main/curator-service.ts:86` (the `isWorktreeDisposable` call)

**Interfaces:**
- Consumes: `Task.baseBranch` from Task 1.
- Produces: no signature changes.

- [ ] **Step 1: Point the git-log base at `baseBranch`**

Replace lines 808-810 of `src/main/ipc-handlers.ts` with:

```ts
    return getGitLog(task.worktreePath, task.baseBranch || undefined);
```

The comment above them explained which meaning `branch` carried; the field name now says it, so remove the comment.

- [ ] **Step 2: Point both disposability checks at `baseBranch`**

In `src/main/ipc-handlers.ts` (inside `archiveTaskCore`) and `src/main/curator-service.ts:86`, change `isWorktreeDisposable(task.worktreePath, task.branch)` to:

```ts
isWorktreeDisposable(task.worktreePath, task.baseBranch)
```

- [ ] **Step 3: Verify disposability still answers correctly**

```bash
cp ~/.bifrost/bifrost.db "$TMPDIR/d.db"
sqlite3 -csv "$TMPDIR/d.db" "SELECT worktree_path, base_branch FROM tasks WHERE status='stopped';" > "$TMPDIR/d.csv"
python3 - <<'PY'
import csv, os, subprocess
for wt, base in csv.reader(open(os.environ['TMPDIR']+'/d.csv')):
    if not wt or not os.path.isdir(wt) or not base: continue
    st = subprocess.run(['git','status','--porcelain'], cwd=wt, capture_output=True, text=True).stdout.strip()
    ahead = subprocess.run(['git','rev-list','--count',f'{base}..HEAD'], cwd=wt, capture_output=True, text=True)
    ok = ahead.returncode == 0
    print(f"{os.path.basename(wt):45} clean={not st}  ahead={ahead.stdout.strip() if ok else 'UNRESOLVED'}")
PY
```

Expected: every row resolves an `ahead` count. Any `UNRESOLVED` means `base_branch` does not name a ref reachable from that worktree, and disposability will answer `false` there — safe, but worth noting.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/curator-service.ts
git commit -m "refactor: read the fork point from baseBranch"
```

---

### Task 7: Handle an unknown branch in the task-branch consumers

**Files:**
- Modify: `src/main/curator-service.ts:120-199` (`classifyTask`), `src/main/ipc-handlers.ts:656` (`restoreWorktree` call), `src/main/bifrost-api.ts:171`, `src/main/worktree-manager.ts:159-170` (`restoreWorktree`)

**Interfaces:**
- Consumes: `Task.branch?: string` from Task 1.
- Produces: `restoreWorktree(repoPath: string, taskName: string, branch?: string): Promise<string>`.

- [ ] **Step 1: Skip classification when the branch is unknown**

At the top of `classifyTask` in `src/main/curator-service.ts`, immediately after the `repo` lookup guard, add:

```ts
  // Without the task's own branch there is nothing to ask GitHub or git about,
  // and asking about the fork point answers for the wrong branch.
  if (!task.branch) return null;
```

- [ ] **Step 2: Let `restoreWorktree` take the real branch**

Change its signature and body in `src/main/worktree-manager.ts`:

```ts
export async function restoreWorktree(repoPath: string, taskName: string, branch?: string): Promise<string> {
  const worktreePath = resolveWorktreePath(repoPath, taskName);

  await fs.promises.mkdir(path.join(repoPath, '.worktrees'), { recursive: true });

  const ref = branch ?? slugify(taskName);
  try {
    await execFile('git', ['worktree', 'add', worktreePath, ref], { cwd: repoPath, timeout: 30000 });
  } catch (err) {
    throw new Error(
      `Cannot restore worktree for "${taskName}": no branch named "${ref}". ` +
        `This task predates branch tracking, so its branch must be selected manually.`,
      { cause: err },
    );
  }

  return worktreePath;
}
```

- [ ] **Step 3: Pass the branch at the call site**

In `src/main/ipc-handlers.ts:656`, change the call to:

```ts
      worktreePath = await restoreWorktree(repo.path, task.name, task.branch);
```

- [ ] **Step 4: Guard the search in the HTTP API**

In `src/main/bifrost-api.ts:171`, change `t.branch.toLowerCase().includes(lower)` to:

```ts
      (t.branch ?? t.baseBranch ?? '').toLowerCase().includes(lower),
```

This is a null-dereference, not a style point: `branch` is undefined for 905 existing tasks.

- [ ] **Step 5: Expose both fields in the API payload**

In the task list payload in `src/main/bifrost-api.ts` (near line 266), replace `branch: t.branch,` with:

```ts
          branch: t.branch,
          baseBranch: t.baseBranch,
```

- [ ] **Step 6: Verify the unknown path is exercised**

```bash
sqlite3 -csv ~/.bifrost/bifrost.db "SELECT count(*) FROM tasks WHERE branch IS NULL;"
```

Expected: a large number (about 905 before any new tasks). Confirms `undefined` is the common path and Step 4's guard is load-bearing.

- [ ] **Step 7: Commit**

```bash
git add src/main/curator-service.ts src/main/worktree-manager.ts src/main/ipc-handlers.ts src/main/bifrost-api.ts
git commit -m "feat: handle tasks whose own branch is unknown"
```

---

### Task 8: Update the renderer and clear the compiler

**Files:**
- Modify: `src/renderer/components/TaskTab.tsx:157`, `src/renderer/components/TaskHistoryPanel.tsx:299`, `:387`, `:460`, `:659`

**Interfaces:**
- Consumes: `Task.branch?` and `Task.baseBranch` from Task 1.

- [ ] **Step 1: Show both refs in the tab tooltip**

In `src/renderer/components/TaskTab.tsx`, replace the `` `Branch: ${task.branch}` `` entry in `tooltipLines` with:

```tsx
    task.branch ? `Branch: ${task.branch}` : undefined,
    `Base: ${task.baseBranch}`,
```

`tooltipLines` already filters falsy entries, so an unknown branch drops its line.

- [ ] **Step 2: Fall back in the History list and search**

At line 299 change `text={task.branch}` to:

```tsx
              <Highlight text={task.branch ?? task.baseBranch} search={search} />
```

At line 387 change the searched string to include both:

```tsx
            return matchesAllTerms(
              `${t.name} ${t.branch ?? ''} ${t.baseBranch} ${repo?.name ?? ''} ${t.summary ?? ''}`,
              search,
            );
```

- [ ] **Step 3: Compare against the task's own branch**

At line 460 the comparison is against the worktree's current branch, so it wants `task.branch`. Guard the unknown case so a task with no recorded branch never reports a spurious change:

```tsx
        if (task.branch && currentBranch !== task.branch) {
```

At line 659 change `{branchConfirm.task.branch}` to:

```tsx
{branchConfirm.task.branch ?? branchConfirm.task.baseBranch}
```

- [ ] **Step 4: Confirm the compiler is back to baseline**

```bash
npm run typecheck 2>&1 | grep -c "error TS"
```

Expected: **24 or fewer**. Then confirm none of them are ours:

```bash
npm run typecheck 2>&1 | grep -E "branch|baseBranch" || echo "no branch-related errors"
```

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/renderer/components/TaskTab.tsx src/renderer/components/TaskHistoryPanel.tsx
git commit -m "feat: show a task's own branch and fall back to its base"
```

---

### Task 9: Verify the migration end to end

**Files:** none modified.

- [ ] **Step 1: Back up the live database**

```bash
cp ~/.bifrost/bifrost.db "$TMPDIR/bifrost-pre-v3.db"
```

Keep this until the app has run correctly. The migration is one-way.

- [ ] **Step 2: Run the app and let the migration execute**

Run: `npm start`

Expected in the console: `[db] Migration v3: split tasks.branch into base_branch + branch` followed by `[db] Migration v3: recovered N of 1046 task branches`, with N near 141.

- [ ] **Step 3: Confirm the data landed**

```bash
sqlite3 -csv ~/.bifrost/bifrost.db "
SELECT count(*) AS total,
       count(base_branch) AS with_base,
       count(branch) AS with_branch,
       sum(base_branch = coalesce(branch,'')) AS same_both
FROM tasks;"
```

Expected: `total` 1046+, `with_base` equal to total, `with_branch` near 141. `same_both` counts in-place tasks, where the two legitimately match.

- [ ] **Step 4: Confirm the bogus merge verdicts stop**

```bash
sqlite3 -csv ~/.bifrost/bifrost.db "
SELECT count(*) FROM tasks WHERE cur_outcome='merged' AND branch IS NULL;"
```

These are the pre-existing verdicts produced by comparing the fork point against itself. They remain in the table as historical rows; the point is that no *new* ones appear, because Task 7 skips classification when `branch` is unknown.

- [ ] **Step 5: Exercise the tab tooltip and History search**

Hover a tab: it shows `Branch:` (the task's own) and `Base:` on separate lines. Open History and search for a task branch name: a task created after Task 5 matches on its own branch.

- [ ] **Step 6: Push the branch**

```bash
npm run lint && npm run typecheck 2>&1 | grep -c "error TS"
git push
```
