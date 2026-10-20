# Change Walkthrough, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Walkthrough tab in the diff overlay that leads the user through a task's committed change in narrated order, with typed inline annotations, exact anchoring, staleness detection and regeneration.

**Architecture:** Pure schema and anchoring logic in `src/shared/walkthrough.ts`; git, storage and the one-shot generator in `src/main/walkthrough-service.ts`; four IPC channels and one stream; the diff renderer extracted from `DiffOverlay.tsx` into `DiffFileView.tsx` with annotation hooks; `WalkthroughContent.tsx` as the tab.

**Tech Stack:** Electron, TypeScript, React 19, Tailwind, Shiki, `claude -p --json-schema` through `runOneShot`, node's type stripping for `scripts/check-*.mts`.

**Spec:** `docs/superpowers/specs/2026-10-20-change-walkthrough-design.md`

## Global Constraints

- Generator model `claude-opus-5-5`; diff cap 400,000 characters, refused above with the size in the message.
- Storage `~/.bifrost/walkthroughs/<taskId>/<generatedAt>-<head7>.json`; newest file is current; never overwrite.
- Schema `version: 1`. Phase 1 writes `author: "agent"`, `review: null`, `change.pr: null`, `generator.kind: "cold"`.
- Kind colours: narration `accent`, finding `accent-hover`, concern `warning`, bug `danger`. Status badges: shifted muted, fuzzy warning, lost danger.
- No plugin changes, no `/walkthrough` route, no `ingestFindings` in phase 1.
- Renderer conventions from CLAUDE.md: semantic tokens only, `PrimaryButton`, `FormTextarea`, `Spinner` loading pattern, footer listing every key, `transition-colors` on hover.
- Check scripts follow `scripts/check-diff-base.mts`: `check(name, ok, detail)`, exit non-zero on failure, `npm run check:<name>`.

## Review Focus

1. A model-misnumbered anchor whose quote occurs elsewhere in the file: repaired to the quoted line, nearest occurrence to the claimed number wins. Pinned in Task 1.
2. An anchor at the very start or end of a file: the snippet's `before`/`after` are short, not padded or out of range. Pinned in Task 1.
3. A deleted file, or an `old`-side anchor: the old side resolves against `base`, not `head`. Pinned in Task 2.
4. A walkthrough on a task whose head commit has been garbage-collected or rebased away: the viewer still opens, shows "rebased", and the pinned diff falls back to the stored snippets with every anchor `lost` or `fuzzy`. Pinned in Task 2.
5. A generator reply with zero steps, or every anchor unverifiable: stored and shown, with a banner rather than an empty tour. Pinned in Task 2.

---

### Task 1: Schema and pure anchoring

**Files:**
- Move: `src/renderer/utils/diff-parser.ts` → `src/shared/diff-parser.ts` (update the one importer, `DiffOverlay.tsx`)
- Create: `src/shared/walkthrough.ts`
- Create: `scripts/check-walkthrough-schema.mts`, `package.json` script `check:walkthrough-schema`

**Interfaces — Produces:**
- Types `StepKind = 'narration'|'finding'|'bug'|'concern'`, `Side = 'old'|'new'`, `Snippet {before,first,last,after: string[]}`, `Anchor {path, side, commit, lines: [number, number], snippet}`, `Comment`, `Step {id, kind, chapter?, title, body, anchor: Anchor|null, unverified?: true, comments}`, `Walkthrough` per the spec.
- `AnchorStatus = 'exact'|'shifted'|'fuzzy'|'lost'`; `Remapped {anchor: Anchor|null, status: AnchorStatus}`.
- `GeneratedWalkthrough` / `GeneratedStep` / `GeneratedAnchor {path, side, lines, quote}`: the model's reply shape, and `GENERATED_SCHEMA` (JSON schema for it).
- `numberDiff(files: DiffFile[]): string` — per file a `--- path` header, per hunk its `@@` header, per line `${old ?? '-'}`/`${new ?? '-'}` right-padded to 5, `|`, sign, content.
- `locateQuote(lines: string[], claimed: number, quote: string): number | null` — 1-based line; claimed if it matches (trimmed comparison), else nearest occurrence, else null.
- `extractSnippet(fileLines: string[], range: [number, number]): Snippet` — before 3, first up to 4, last up to 2 (empty when the range is ≤4 lines), after 3, clipped at file bounds.
- `parseZeroContextHunks(diff: string): {oldStart, oldLines, newStart, newLines}[]`.
- `shiftRange(range, hunks): [number, number] | null` — null when a hunk touches the range; otherwise the range moved by the net offset of hunks entirely above it. A pure insertion (`oldLines = 0`) after line `a` touches the range when `s ≤ a < e`.
- `matchSnippet(fileLines, snippet, originalLength): [number, number] | null` — unique match of `first` (exact, then whitespace-trimmed); end at `start + originalLength - 1` if `last` matches there, else the first `last` match within `2 × originalLength` after start; null on zero or multiple `first` matches.

- [ ] **Step 1: Write the failing checks** in `check-walkthrough-schema.mts`:
  - `numberDiff` on a hunk with context, removed and added lines produces `    1|    1| ctx`, `    2|    -|-old`, `    -|    2|+new`.
  - `locateQuote` returns the claimed line when it matches, the nearest occurrence when the model is off by 3 and the quote also occurs 20 lines further away, and null for an absent quote.
  - `extractSnippet` at line 1 of a 3-line file gives `before: []`, and at the last line `after: []`.
  - `shiftRange([10,12])`: a 2-line insertion at line 3 gives `[12,14]`; a hunk at 11 gives null; an insertion after line 12 leaves `[10,12]`; an insertion after line 10 gives null.
  - `matchSnippet` finds a block moved 30 lines down, returns null when `first` occurs twice, and matches with changed indentation.
- [ ] **Step 2: Run** `npm run check:walkthrough-schema` — expect a module-not-found failure.
- [ ] **Step 3: Implement** `src/shared/walkthrough.ts` and move the diff parser.
- [ ] **Step 4: Run** `npm run check:walkthrough-schema` — all `ok`; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat: walkthrough schema and pure anchoring`.

### Task 2: Main-process service

**Files:**
- Modify: `src/main/diff-service.ts` — `getRangeDiff(worktreePath, base, head): Promise<string>` (`git diff -M --no-color base head`, 10MB buffer)
- Create: `src/main/walkthrough-service.ts`
- Create: `scripts/check-walkthrough-anchor.mts`, `package.json` script `check:walkthrough-anchor`

**Interfaces — Consumes:** Task 1 exports; `runOneShot`; `resolveDiffBase`.
**Produces:**
- `anchorGenerated(worktreePath, base, head, generated: GeneratedWalkthrough, meta: {focus, model}): Promise<Walkthrough>` — per anchor: read `git show <commit>:<path>` (commit = head for new, base for old), `locateQuote`, fill `lines` (shifted by the repair), `commit`, `snippet`; an unlocatable anchor becomes `anchor: null, unverified: true`. Comments likewise; a comment that cannot be anchored is dropped into its step's body as a trailing paragraph rather than lost.
- `remapAnchor(worktreePath, anchor, target: string): Promise<Remapped>` — same commit → exact; `cat-file -e` fails → snippet path; else `git diff -U0 -M <commit> <target> -- <path>`; rename in that diff → snippet path against the new path; `shiftRange` result with zero offset → exact, nonzero → shifted, null → lost; snippet path: `matchSnippet` hit → fuzzy, miss → lost.
- `assessStaleness(worktreePath, w: Walkthrough): Promise<Staleness>` with `Staleness = {state: 'current'|'ahead'|'rebased', currentHead: string, commitsAhead?: number, dirty: boolean}`.
- `generateWalkthrough(task, focus: string|null): Promise<Walkthrough>` — throws with a user-facing message on oversize, empty diff, or a null reply.
- `storeWalkthrough(taskId, w)`, `loadCurrentWalkthrough(taskId): Walkthrough | null`.
- `WALKTHROUGH_PROMPT` constant: ordering rules from the spec, chapters past ~8 steps, one `quote` per anchor copied verbatim from the numbered diff, `concern`/`bug`/`finding` only where the focus asks or narration makes it unavoidable, no review.

- [ ] **Step 1: Write the failing checks** in `check-walkthrough-anchor.mts`, against a temp repo built like `check-diff-base.mts`. Commit A (base), B (head) changing `f.ts`. Anchor a step on lines in B. Then:
  - commit C adding 5 lines above → `shifted`, range +5;
  - commit D editing inside → `lost`;
  - commit E renaming `f.ts` → `g.ts` → `fuzzy`, path `g.ts`;
  - an anchor whose `commit` is a nonexistent sha, target containing the block once → `fuzzy`; twice → `lost`;
  - an `old`-side anchor on a deleted file resolves against base;
  - `anchorGenerated` repairs a quote misnumbered by 2 and marks an absent quote `unverified`;
  - `assessStaleness` reports `ahead` with count after C, and `rebased` after `git reset --hard A && commit` rewrites history.
- [ ] **Step 2: Run** `npm run check:walkthrough-anchor` — fails.
- [ ] **Step 3: Implement** the service. Git calls through `execFile` with `cwd: worktreePath`, `--no-optional-locks`.
- [ ] **Step 4: Run** both check scripts and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: walkthrough generation, storage and re-anchoring`.

### Task 3: IPC

**Files:** `src/shared/ipc-channels.ts`, `src/preload/preload.ts`, `src/main/ipc-handlers.ts`

**Produces on `window.bifrost`:**
- `getWalkthrough(taskId): Promise<{walkthrough: Walkthrough | null; staleness: Staleness | null}>`
- `generateWalkthrough(taskId, focus: string | null): Promise<{ok: true} | {ok: false; error: string}>` — stores, then sends the stream event.
- `getWalkthroughDiff(taskId, onCurrentHead: boolean): Promise<string>` — `base..head` from the file, or `resolveDiffBase..HEAD`.
- `remapWalkthrough(taskId): Promise<Record<string, Remapped>>` — keyed by step or comment id, against current HEAD (old side against the current merge-base).
- `onWalkthroughUpdated(cb: (taskId: string) => void): () => void` — `IPC_STREAM.WALKTHROUGH_UPDATED`.

- [ ] **Step 1:** Add channels, signatures, preload, handlers (all four files together).
- [ ] **Step 2:** `npm run typecheck` and `npm run lint` clean.
- [ ] **Step 3: Commit** `feat: walkthrough IPC`.

### Task 4: Extract the diff renderer

**Files:** Create `src/renderer/components/DiffFileView.tsx`; modify `DiffOverlay.tsx`.

**Produces:** `LazyFileSection({file, sectionRef?, forceVisible?, annotations?})` with `annotations: {lineClass?(line): string | undefined; before?(line): ReactNode; after?(line): ReactNode}`, where `line` is a `DiffLine`.

- [ ] **Step 1:** Move `FileSection`, `LazyFileSection`, `DiffLineRow`, `LineNumber`, `lineStyles`, `plainTokens`; add `forceVisible` (skips the observer) and the three hooks.
- [ ] **Step 2:** `npm run typecheck`, `npm run lint`; Git Diff tab renders as before in `npm start`.
- [ ] **Step 3: Commit** `refactor: extract the diff file renderer`.

### Task 5: The Walkthrough tab

**Files:** Create `src/renderer/hooks/useWalkthrough.ts`, `src/renderer/components/WalkthroughContent.tsx`; modify `DiffOverlay.tsx`, `src/renderer/context/AppContext.tsx` (`'walkthrough'` in `DiffMode`).

**Interfaces — Consumes:** Task 3 API; Task 4 `LazyFileSection`; `parseDiff` from `src/shared/diff-parser.ts`; `SimpleMarkdown`.

Behaviour is the spec's "The viewer" section. Decisions it leaves open, settled here:
- Tab label `Walkthrough`, mnemonic `W` (index 0; free among Git Diff/Tokens/Git Log/Metrics).
- `useWalkthrough(taskId)` returns `{walkthrough, staleness, diff, remapped, onCurrentHead, setOnCurrentHead, generating, error, generate(focus)}`; refetches on `onWalkthroughUpdated` for this task and re-runs staleness on an `onActivityEntry` commit for this task's worktree.
- On current head, a step whose remap is `lost` or whose anchor is null shows its snippet as a static block in the card at the top of its file section, or in the step list pane when the file is gone.
- Keys inside the tab: `↓`/`↑` step, `→`/`←` chapter, `Mod+O` IDE at the step's current-head line, `⌥R` regenerate (opens the focus input pre-filled), `⌥H` toggle current head. These replace the Git Diff tab's arrow handling only while `diffMode === 'walkthrough'`. The header hint string switches to the walkthrough's keys.

- [ ] **Step 1:** Implement the hook and component; wire the tab.
- [ ] **Step 2:** `npm run typecheck`, `npm run lint`, all walkthrough check scripts.
- [ ] **Step 3:** `npm start`; generate a walkthrough on a task with commits; step through; commit in the worktree and see the stale banner; toggle current head and see a badge.
- [ ] **Step 4: Commit** `feat: the walkthrough tab`.
