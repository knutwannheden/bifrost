# A guided walkthrough of a change

## Problem

A diff is presented in file-alphabetical order, and that is almost never the order in which a change makes sense. The reader opens `a/config.ts`, meets a flag whose purpose lives in `src/z/engine.ts`, and reconstructs the author's intent by jumping around. The author, or the agent that made the change, already knows the order that explains it: the new type first, then the function that produces it, then the call site that consumes it, then the tests, then the mechanical fallout.

This is a tour, not a review. Its job is to lead a human through a change in that order, with a paragraph per stop and the occasional inline remark. Where review findings exist they are shown as typed stops on the same tour, not re-derived.

## The viewer already exists, in part

`DiffOverlay.tsx` renders a unified diff per file: `FileSection` draws hunks through `DiffLineRow`, with old and new line numbers, Shiki highlighting, word-level ranges, and lazy mounting as a file scrolls near the viewport. It is not a standalone component — these are module-private functions wired to the task's working-tree diff.

So the walkthrough is **navigation and annotations layered on the existing renderer**, after one extraction: `FileSection`, `LazyFileSection` and `DiffLineRow` move to `DiffFileView.tsx` and grow three optional hooks — a class per line, an element rendered before a line, an element rendered after a line. The Git Diff tab passes none of them and is unchanged. The walkthrough passes all three.

The walkthrough is a fifth tab of `DiffOverlay` beside Git Diff, Tokens, Git Log and Metrics. The overlay is already the per-task full-screen surface for looking at a change, carries the keyboard model, and its left column (the file tree) is what the step list replaces.

## The steps file

JSON, one file per walkthrough, validated by the CLI's `--json-schema` when a model produces it and by the same schema when an agent submits it.

```jsonc
{
  "version": 1,
  "title": "Advisory claims on shared resources",
  "summary": "One paragraph: what the change is for and the shape of the tour.",
  "change": {
    "base": "3f2a…",          // commit the diff is measured from
    "head": "9c1d…",          // commit the diff is measured to; every anchor is relative to one of these
    "headRef": "headroom",    // branch name at generation time, display only
    "pr": null                // phase 2: { "owner", "repo", "number" }
  },
  "focus": "the locking protocol",   // the user's focus-context string, or null
  "generatedAt": "2026-10-20T14:02:11Z",
  "generator": { "kind": "cold", "model": "claude-opus-5-5" },   // or { "kind": "task", "taskId" }
  "steps": [
    {
      "id": "s1",
      "kind": "narration",            // narration | finding | bug | concern
      "chapter": "The claim",         // consecutive steps sharing a chapter form one
      "title": "A claim is a row in one SQLite table",
      "body": "Markdown. Why this stop comes first and what to notice.",
      "anchor": { /* see below */ },
      "comments": [
        {
          "id": "s1c1",
          "kind": "concern",
          "body": "Expiry is compared in local time.",
          "author": "agent",          // agent | user
          "anchor": { /* same shape, a sub-range of the step's lines */ },
          "review": null              // phase 2: { "state": "draft" | "submitted", "githubId"? }
        }
      ]
    }
  ]
}
```

Decisions in the shape:

- **Order is the step array and nothing else.** A chapter is a label on a step; consecutive steps with the same label are drawn under one heading. A separate chapter list with step ids would be a second ordering to keep in sync.
- **`kind` is on steps and comments alike**, defaulting to `narration`. A `bug` step is a stop whose whole purpose is the bug; a `bug` comment is a remark inside a narration stop. The viewer colours both the same way.
- **Comments are the phase 2 surface.** `author` and `review` are in the schema now so a user-written draft and an agent remark are the same object in the same file, and a pending GitHub review is the set of comments with `review.state = "draft"`. Phase 1 writes only `author: "agent"`, `review: null`.
- **Findings from a reviewer are steps or comments of kind `finding`/`bug`.** The walkthrough never evaluates code itself. See "Ingesting findings" below.

### Ingesting findings

A finding arrives as `{ path, line, endLine?, side?, kind?, title, body }` — the shape a code-review pass already reports, a file and a line with a one-line summary and an explanation. `side` defaults to `new` and `kind` to `finding`. Findings carry no quote, so the line is taken as given against `head` and the snippet is filled from it.

`ingestFindings(walkthrough, findings)` is pure. It attaches each finding as a comment on the step whose anchor covers its line, or appends a step under a trailing "Findings" chapter when none does. The result is stored as a new walkthrough file, like a regeneration, so the file stays the single document.

The producer is the agent: `submit_walkthrough` takes an optional `findings` array alongside, or instead of, a full walkthrough. Findings alone attach to the current walkthrough. Phase 1 has no producer, so the function and its check ship in phase 1b with the tool.

### The anchor

```jsonc
{
  "path": "src/main/headroom.ts",
  "side": "new",                 // new = lines in `commit`'s tree as the diff's right side; old = left side
  "commit": "9c1d…",             // the commit whose tree the line numbers index: head for new, base for old
  "lines": [41, 58],             // inclusive, 1-based, on that side
  "snippet": {
    "before": ["", "export function acquire(", "  req: ClaimRequest,"],
    "first":  ["): Claim {", "  const now = clock();", "  const row = db", "    .prepare("],
    "last":   ["  return toClaim(row);", "}"],
    "after":  ["", "export function release(id: string) {", "  db"]
  }
}
```

The model is never asked to produce a snippet or a commit. It produces `path`, `side`, `lines` and a verbatim `quote` of the first anchored line; the validator in the main process checks the quote against the line at `lines[0]` on that side of the real diff, searches the file's hunks for it when the numbers are off, and fills `commit` and `snippet` from `git show <commit>:<path>`. A quote found nowhere leaves the step without an anchor and marked `unverified`. Models misnumber lines often enough that the quote check is not optional.

To keep misnumbering rare, the generator's input is the diff with explicit numbers on every line — `  41|  43| ctx`, `  42|   -|-removed`, `   -|  44|+added` — so the model copies rather than counts.

## Anchoring: why the viewer never points at the wrong line

A walkthrough is a document about one `(base, head)` pair. Git reproduces that diff exactly for as long as the two objects exist, which, through a rebase or an amend, is for weeks by way of the reflog. So:

**The default view is pinned.** The walkthrough tab renders `git diff <base> <head>`, not the working-tree diff, and every anchor is exact by construction. Line drift cannot happen in this view because the view does not move.

**Staleness is detected, not inferred.** Opening the tab compares `change.head` to the branch's current `HEAD`. When they differ a banner says so — "Generated against 9c1d3a2; the branch is now 7e0f1b4 (2 commits ahead)" or "(rebased)" when `head` is no longer an ancestor — and offers two actions: **Regenerate** and **Show on current head**. The check reruns whenever the activity watcher reports a commit.

**Re-anchoring onto the current head is explicit, per step, and never silent.** It is what the IDE jump needs, what "show on current head" needs, and what phase 2 needs to post a comment against the PR's current `commit_id`. `remapAnchor(anchor, target)` returns a new anchor plus a status:

| status | how it was found | drawn as |
|---|---|---|
| `exact` | target commit equals `anchor.commit`, or no hunk between them touches or precedes the anchored lines | no badge |
| `shifted` | `git diff -U0 <anchor.commit> <target> -- path` has no hunk touching the anchored lines; the range moves by the net offset of hunks above it | small "moved" badge, lines highlighted as normal |
| `fuzzy` | `anchor.commit` is gone from the object store, or git reports the file renamed; the `snippet` (`first` then `last`, exact, then whitespace-trimmed) matches exactly once in the target file | "re-anchored by text" badge in warning colour |
| `lost` | a hunk in that diff overlaps the anchored lines, or the snippet matches zero or several places, or the file is gone | the step's card renders with its `snippet` as a static code block and the note "these lines changed after this walkthrough was written"; nothing in the live diff is highlighted |

Git does the mapping where it can because it is exact: an unchanged line's new number is a function of the hunks above it, with no heuristics. The snippet is the fallback for when the original object is unreachable — a walkthrough copied to another machine, or one older than the reflog — and the bar for it is a unique match, because a near-miss highlighted with confidence is the failure this whole section exists to prevent. A `lost` anchor on a `concern` or `bug` step is also the signal that the remark may have been addressed.

`old`-side anchors map through the same function with `base` as the source and the new merge-base as the target.

Re-anchoring is pure over three inputs — the anchor, the `-U0` hunk list, and the target file's lines — and is pinned by a check script.

## Where the walkthrough comes from

Two producers write the same file, and everything after the file is shared: validate, anchor, store, draw.

**Cold pass.** `generateWalkthrough(worktreePath, base, head, focus)` runs through `runOneShot`: no tools, no session, the numbered diff and `git log --reverse base..head` on stdin, output constrained to the schema. The prompt asks for the order that makes the change understandable — declarations before uses, the core before its tests, producers before consumers, mechanical fallout last — for chapters past about eight steps, for a quote per anchor, and for `concern`/`bug`/`finding` only where the focus string asked for it or where narrating made something impossible not to mention. It does not ask for a review. The model is Opus 5.5 (`claude-opus-5-5`): this runs once per change on the user's request and reads the whole diff, so quality dominates cost. The diff is capped at 400k characters; past that the generator refuses with the size, since the tour of a diff too large to read is not worth a truncated model's guess.

**The task that made the change.** The agent that wrote a change knows its narrative and already holds the context the cold pass would have to infer. It submits the same JSON through a new MCP tool, `submit_walkthrough`, which posts to `/walkthrough` on the Bifrost API; the main process validates and anchors it exactly as it does the cold output and tells the renderer. A `walkthrough` skill in the plugin tells the agent the shape, the ordering rules and the quote requirement, and accepts a focus. The viewer's empty state offers both routes: **Generate** (cold) and **Ask the task's agent**, the second only when the task's session is idle, implemented by sending `/bifrost:walkthrough <focus>` through the existing prompt sender. Nothing fires on `Stop` automatically; a prompt that wants a walkthrough on completion says so.

Both producers need the diff committed. `base` is the merge-base with the task's base branch as `resolveDiffBase` computes it today, `head` is `HEAD`. A dirty worktree is noted in the banner ("uncommitted changes are not part of this walkthrough") and otherwise ignored; anchoring an uncommitted tree would mean inventing a commit for it.

## Storage

`~/.bifrost/walkthroughs/<taskId>/<generatedAt>-<head7>.json`. The newest file in the directory is the task's current walkthrough; regenerating adds a file rather than overwriting, so a tour the user was halfway through survives a regeneration they regret. It sits beside the change feed's journal for the same reason: it belongs to one task and goes when the task does. Not in SQLite — the file is the document, and phase 2 edits it in place as comments are drafted.

## The viewer

Left column, where the file tree sits in Git Diff: the steps in order under their chapter headings, each with a kind-coloured dot, its title, and the anchor status badge when not `exact`. The current step is marked the way the selected file is.

Main pane: the pinned diff in file order, through `DiffFileView`. Above it a sticky bar — `3 / 12 · The claim · ◀ ▶` — and under that, when stale, the banner. The current step's body renders as a card **inline, immediately above its first anchored line**, and its anchored lines carry a left accent border and a tint in the step's kind colour. Its comments render as rows under their last anchored line, in their kind colour. Every other step's first line carries a small numbered pill in the gutter, in that step's kind colour, so the reader scrolling freely sees where the tour stops; clicking a pill jumps there.

Navigating to a step forces its file section to mount (the lazy section gains a `forceVisible` prop) and scrolls the anchor to the top of the pane. The diff stays the diff: nothing is reordered, the tour is a path through it.

Kind colours: `narration` → accent, `finding` → accent-hover, `concern` → warning, `bug` → danger. Status badges: `shifted` muted, `fuzzy` warning, `lost` danger.

Keys, while the walkthrough tab holds focus: `↓`/`↑` next/previous step; `→`/`←` next/previous chapter; `Mod+O` open the step's file in the IDE at its line on the current head, using the remap; `⌥R` regenerate; `⌥F` focus the focus-string input; `⌥H` toggle "show on current head". Footer lists them. `Enter` in the empty state triggers Generate.

Empty state: "No walkthrough for this change yet", a `FormTextarea` for the focus string, and `PrimaryButton` Generate beside the Ask-the-agent action. Loading: spinner with "Narrating 23 files…". A generator failure shows its message and keeps the previous walkthrough if there was one.

## Components

| File | Change |
|---|---|
| `src/shared/walkthrough.ts` | New. The schema types (`Walkthrough`, `Step`, `Comment`, `Anchor`, `AnchorStatus`), the JSON schema constant the generator and the API both validate against, and the pure functions: `remapAnchor`, `ingestFindings`, `numberDiff`. Shared because the renderer draws statuses and the main process computes them. |
| `src/main/walkthrough-service.ts` | New. `generateWalkthrough`, `validateAndAnchor` (quote check, snippet fill), `loadCurrent`, `store`, `assessStaleness`, and the git helpers it needs: diff of a range, `cat-file -e`, `show <commit>:<path>`, `diff -U0` between two commits for one path. |
| `src/main/diff-service.ts` | `getRangeDiff(worktreePath, base, head)` with rename detection. |
| `src/main/bifrost-api.ts` | `/walkthrough` POST: validate, anchor, store, notify. |
| `src/main/ipc-handlers.ts` | `walkthrough:get`, `walkthrough:generate`, `walkthrough:diff`, `walkthrough:remap`. |
| `src/shared/ipc-channels.ts`, `src/preload/preload.ts` | The four channels, `IPC_STREAM.WALKTHROUGH_UPDATED`, and the `BifrostAPI` signatures. |
| `src/renderer/components/DiffFileView.tsx` | New. `FileSection`, `LazyFileSection`, `DiffLineRow` moved out of `DiffOverlay.tsx`, with the three annotation hooks and `forceVisible`. |
| `src/renderer/components/WalkthroughContent.tsx` | New. Step list, sticky bar, banner, empty and loading states, the annotated diff. |
| `src/renderer/components/DiffOverlay.tsx` | The fifth tab; walkthrough keys in `handleKeyDown`. |
| `src/renderer/context/AppContext.tsx` | `'walkthrough'` in `DiffMode`. |
| `src/renderer/hooks/useWalkthrough.ts` | New. Loads the walkthrough and its diff, subscribes to updates, re-checks staleness on commit activity. |
| `src/claude-plugin/mcp/server.mjs` | `submit_walkthrough`. |
| `src/claude-plugin/skills/walkthrough/SKILL.md` | New. The agent-side generator prompt. |
| `src/claude-plugin/.claude-plugin/plugin.json` | Version bump; the user accepts the integration update. |
| `scripts/check-walkthrough-anchor.mts` | New. Builds a git repository in a temp directory, anchors a step, then commits above it, edits inside it, renames the file, rebases, and drops the original object; pins each status. |
| `scripts/check-walkthrough-schema.mts` | New. Quote repair of a misnumbered anchor, an unfindable quote leaving a step unverified, snippet extraction at file boundaries, `numberDiff` on added, removed and context lines, and `ingestFindings` attaching to a covering step and appending otherwise. |

## Phases

**Phase 1 — local, after this document is approved.** Everything in the table except the plugin rows, `/walkthrough` and `ingestFindings`: schema, cold generator with focus input, the tab with prev/next and inline typed annotations, pinned view, staleness banner, re-anchoring with statuses, regenerate, the two check scripts.

**Phase 1b — the task narrates its own change.** `submit_walkthrough` with its `findings` field, `/walkthrough`, `ingestFindings` and its check, the skill, the Ask-the-agent action. Small once phase 1 exists, since it reuses validate-anchor-store, but it ships a plugin update, so it is a separate commit the user can hold back.

**Phase 2 — GitHub.** `change.pr`; user-authored comments in the viewer with the agent able to draft; a pending review as the set of `review.state = "draft"` comments; a Submit action that re-anchors every draft onto the PR's current head, refuses while any is `lost`, and posts one review through `gh`. The tool never posts without that explicit action. Anchors map one-to-one onto GitHub's review comment fields: `side` to `LEFT`/`RIGHT`, `lines` to `start_line`/`line`, `commit` to `commit_id`.

## Out of scope

Walking an uncommitted working tree. Generating from a PR that is not checked out locally (phase 2 fetches the PR branch into the task first). Editing step text in the viewer. Any review judgement of the code by this component.
