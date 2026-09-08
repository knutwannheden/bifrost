# A change feed beside the terminal

## Problem

Watching an agent work means reading its terminal, where a diff appears as an `Edit(file.ts)` line with the change folded away behind `ctrl+o`. Scrolling back to see what it actually wrote costs the live view, and the terminal is a single column regardless of how wide the window is.

`DiffOverlay` answers a different question. It shows cumulative git state — what the worktree looks like now — with no ordering and no connection to what the agent said while producing it. Two edits an hour apart to the same file appear as one hunk list, and the reasoning that produced them is gone.

Near-fullscreen, the window has several hundred pixels to the right of a terminal that does not use them.

## Where the data comes from

The transcript already carries every diff. An `Edit` tool result is recorded as `toolUseResult` with these fields:

| field | contents |
|---|---|
| `filePath` | absolute path |
| `oldString` / `newString` | the replaced and replacing text |
| `originalFile` | the file's entire content before the edit |
| `structuredPatch` | unified hunks: `oldStart`, `oldLines`, `newStart`, `newLines`, `lines` |
| `replaceAll` | whether the edit applied to every occurrence |

`Write` records the same shape with `content` in place of `oldString`/`newString`, plus `type` set to `create` or `update`.

`claude-watcher.ts` already tails these files: byte offsets per file, a `@parcel/watcher` watch on the project directory, and a two-second safety poll. It parses `assistant_text` and `tool_use` blocks and discards `toolUseResult` entirely.

`openInIde(worktreePath, filePath, line)` is registered in `ipc-handlers.ts` and exposed on `window.bifrost`. `DiffOverlay.tsx` and `useKeymapEngine.ts` already call it with a line number.

The feed is therefore a second parse of a stream already being read, and click-through to the editor is wiring rather than construction.

The transcript is not the whole account, though. Of the 120 most recent sessions on this machine, 9 wrote files at all; **5 of those wrote only through the shell** — `cat >> f <<'PY'`, `sed -i`, `python3 - <<'EOF'` — and 4 mixed both. None used the edit tools alone. A transcript-only feed would show nothing for the majority of file-writing work, so the worktree is read as a second source.

## Grouping

A feed item is one of three kinds:

- **narration** — an assistant text or thinking block
- **change** — one file, its merged hunks, and `+N −M`
- **tick** — a dim line naming a non-edit tool and its target

A change groups consecutive edits to the same file. The group breaks on an edit to a different file, and on a new narration block — without the second rule the text that explains a change gets swallowed by the group above it. Non-edit tools do not break a group; they become ticks. A `Bash` test run between two edits to one file therefore leaves them merged, which can put ten minutes between the halves of a single card.

Items sit in transcript order, and a card holds the position of its first edit: it is pushed as soon as that edit lands and rewritten as the rest merge in, so a change is on screen while the agent is still working on the file rather than appearing once it moves on.

A turn reasons as often as it speaks, and frequently does only the first before acting: across sixty recent transcripts there are 1366 tool calls, 1168 thinking blocks and 724 text blocks. Most thinking blocks carry only a signature, but the tenth that hold prose are the note explaining the call beneath them, and none runs past 423 characters. They read as narration, set quieter than a statement.

Consecutive ticks for the same tool collapse into one line carrying a count.

A merged group's diff is recomputed rather than spliced: `structuredPatch(first.originalFile, finalContent)` from `jsdiff`, where `finalContent` is the last edit's `originalFile` with its `oldString`→`newString` substitution applied. Splicing each edit's hunks instead requires line-offset arithmetic that is wrong whenever a later edit rewrites text an earlier one inserted, which is the normal shape of an agent correcting itself. `jsdiff` is a new dependency; nothing in the tree computes diffs today, since `DiffOverlay` parses `git diff` output.

A create reports no `originalFile` and an empty `structuredPatch`, so its base is the empty file and its `content` becomes the card's body. Cards cap at 200 lines and mark themselves `truncated` past that.

## Two sources, one assertion

Both sources say the same kind of thing: *file F now holds content C*. A tool result says it through the reconstruction above; a scan says it by snapshotting the worktree. Neither carries the content as identity — both reduce it to git's blob id, which `blobSha` computes for a reconstructed file and `git diff-tree` already prints for a scanned one. `foldFeed` tracks the blob each file has been shown to hold and drops any assertion matching it, so whichever source arrives first draws the card and the other is silent. No debounce, and no ordering requirement between them.

## What the feed holds when a panel opens

The last two megabytes of the session's transcript, and its subagents', folded on first open. That covers all but the largest transcripts whole — the median is 0.1MB and the ninetieth percentile 1.1MB — and yields more than the two-hundred-item cap even on a transcript whose lines each carry a file's contents. On the largest here, 32MB across 33 subagent files, the read costs about 150ms once.

Worktree-derived cards are journalled to `~/.bifrost/feed/<task>.jsonl` as they are drawn, capped at the same two hundred the feed shows, and read back beside the transcript. They are not in the database: they belong to one task, and archiving it takes them, so a reopened archive has narration and no diffs. Four fifths of file writes here go through the shell rather than an edit tool, so without the journal a restart would lose most of what the feed is for. The transcript's half is worth having on its own, and the first scan takes the worktree as it stands rather than reporting everything since HEAD.

## Which worktree changes count as edits

Nothing in a filesystem change says who made it. "Changed, and not git" would sweep in editor saves, formatter output, lockfiles and build artefacts alongside the agent's work.

So a change is shown only when one of the session's own shell commands was running as it appeared. The transcript records each `Bash` call and its result, which gives an exact window; subagent commands count too, since their writes reach the same worktree. A grace period covers the gap between a command exiting and the poll noticing. The command becomes the card's heading — `during cat >> tests/test_x.py <<'PY'` — standing in for the narration such a change has none of.

A backgrounded command returns from its tool call at once and keeps writing for minutes, so its result does not close its window. The transcript announces the end itself, in a `<task-notification>` carrying the originating `<tool-use-id>`, and that is what closes it. Backgrounded work is 2.9% of shell calls here, but it is the long-running 2.9%.

An unattributed change is taken as the new baseline and not drawn, so it never resurfaces. That is a real cost: a write that lands after its command exits is dropped silently, and silence is indistinguishable from the agent having made no edits. `changeFeedAttributedOnly`, in Settings, turns the rule off and shows every non-git change instead.

Scanning is confined to the task whose panel is open, and git does the work:

```
GIT_INDEX_FILE=<per-task temp>  git add -A && git write-tree   →  a tree id  (55ms on this repo)
git diff-tree -p --find-renames --unified=1 <previous> <latest>
```

Each open card holds the tree it began at, and every scan reports a file's whole change since then rather than the sliver since the last scan — which is what lets the newest report stand for the card. A card ends at narration, or when another file is reported after it; its file then starts again from where the worktree stands. A baseline is a 40-byte tree id rather than a map of file contents. `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` point the index and the objects a snapshot writes at a scratch store under the temp directory, while the repository's own objects stay readable so an unchanged blob is never rewritten. In the repository those objects would be unreachable from any ref, and `gc` keeps unreachable objects for a fortnight: four per snapshot on this repository, every two seconds, is past `gc.auto`'s threshold of 6700 within the hour. The redirect costs about nine milliseconds a snapshot, 42 against 51 on a 192-file checkout. No feed outlives a restart, so the scratch is cleared at startup, and a task's own goes with its feed. Past 64MB the store is dropped whole and the next scan takes the worktree afresh: at twenty kilobytes a snapshot only the trees the open cards measure from are ever read again, and the journal already holds what was drawn. Rename detection, `.gitignore`, binary files and the stat-cached walk all come from git; a rename that changed nothing and a binary file both arrive without a patch and are dropped, having nothing to show.

Paths matching `changeFeedIgnore` — lockfiles, `dist/`, `__snapshots__` and the rest of `DEFAULT_IGNORE` by default — never reach the feed. They change as a consequence of the edit above them rather than as the work itself.

## Git moves the tree without editing anything

A checkout, stash or reset rewrites files wholesale, and none of it is an edit anyone narrated. Two guards keep that out of the feed, because they catch different things:

- **HEAD moved.** Every baseline was taken against the old commit, so all are cleared and re-derived. Covers commit, branch checkout, rebase, reset.
- **A tree-moving command ran.** `git checkout -- src tests` leaves HEAD alone, so the transcript's own `Bash` records are matched against `movesTreeWholesale` and open a four-second quiet window. `apply` and `commit` are deliberately absent: one writes content the agent authored, the other writes none.

In a quiet round the scan still runs and still updates snapshots — it just emits nothing, so the tree's new state becomes the baseline the next real edit is measured against.

Neither guard touches tool-derived cards. An `Edit` during a quiet window still draws its card.

## Components

| File | Change |
|---|---|
| `src/main/change-feed.ts` | New. `parseFeedLines` and `foldFeed`, both pure. Owns the grouping rules, the `jsdiff` recomputation, and `summarizeToolInput`, which moved here from `claude-watcher.ts` so the check script can load the fold without pulling in Electron. |
| `src/main/change-feed-service.ts` | New. Per-task event buffers, the transcript tail, the subagent offsets, and the worktree scan. |
| `src/main/claude-watcher.ts` | Hands the lines it already reads to the service each poll and sends the folded items. |
| `src/main/ipc-handlers.ts` | Handler for the initial tail read. |
| `src/shared/types.ts` | `FeedItem` and its three variants. `BifrostConfig` gains `changeFeedWidth` and `changeFeedHidden`. |
| `src/shared/ipc-channels.ts` | `IPC.CHANGE_FEED_LOAD`, `IPC_STREAM.CHANGE_FEED_ITEMS`, and the `BifrostAPI` signatures. |
| `src/preload/preload.ts` | Bridges both. |
| `src/renderer/components/ChangeFeedPanel.tsx` | New. The dock. |
| `src/renderer/components/RightIconBar.tsx` | Toggle icon. |
| `src/renderer/App.tsx` | The dock as a column between the content column and the icon bar. |
| `src/renderer/context/AppContext.tsx` | `showChangeFeed`, the feed items, and the selected index. |
| `src/shared/keymap.ts` | `view.changeFeed`, bound to `Cmd+E`. |
| `src/renderer/hooks/useKeymapEngine.ts` | Toggle; `action.openIde` targets the feed selection when the dock holds focus. |
| `src/main/claude-oneshot.ts` | Runs outside any worktree, and retries once when the spawn reports ENOENT. |
| `src/renderer/utils/focus-terminal.ts` | New. Hands focus back to the task's terminal, addressing the pane that holds it. |
| `src/renderer/components/SettingsOverlay.tsx` | The attribution toggle. |
| `src/renderer/components/SimpleMarkdown.tsx` | Wraps `react-markdown` in the app's tokens; the toast and the feed share it. |
| `package.json` | `diff`, and `react-markdown` with `remark-gfm` and `remark-breaks`. |
| `src/renderer/utils/agent-address.ts` | New. Resolves a message's addressee to a task name. |
| `scripts/check-change-feed.mts` | New. Pins the grouping rules. |
| `scripts/check-worktree-scan.mts` | New. Drives the scan over a real git repository. |
| `tsconfig.json` | `noEmit` and `allowImportingTsExtensions`, so a check script can load a main-process module. |
| `package.json` | `diff` dependency. |

## Behaviour

The dock is a resizable column whose width persists in `BifrostConfig`, following `sidebarWidth` and `sidebarHidden`. Opening it narrows the terminal, so the PTY resizes and Claude's output rewraps.

`Cmd+E` opens the dock and puts focus in it, and moves focus to it when it is open but focus sits elsewhere. Pressing it while the dock already holds focus closes it, so the same key both reaches the panel and dismisses it. `changeFeedHasFocus` in `utils/keyboard-target.ts` answers which case applies. Esc moves focus back to the task's terminal and leaves the dock open, matching what Esc does elsewhere in the app. ↑/↓ move the selection while the dock holds focus.

Items append at the bottom and the view stays pinned there. Scrolling up unpins; returning to the bottom re-pins. The renderer keeps the most recent 200 items and drops the rest, since the panel is for watching rather than for archaeology.

The three newest change cards render expanded and the rest collapse to a header line — path, `+N −M`, and an edit count when the group merged more than one. Clicking a header expands it.

At the widths this panel occupies, wrapped code is unreadable, so hunks render unified with one line of context and scroll horizontally within their card. Syntax highlighting reuses `utils/syntax-highlight.ts`; the stats badge reuses `DiffStatsBadge`.

A `SendMessage` tick names the task it was addressed to and opens it on click, when the addressee still matches a task — Claude appends a disambiguating reference to the session name, and a task renamed since its session started is addressed by its former one, so the match is best-effort and the tick falls back to plain text.

A command heads its card as the work it does: agents open with `cd <worktree> && …`, the same prefix on every one, long enough to crowd out the part that differs in a dock this wide.

Clicking a path opens it at the first hunk's `newStart`. Clicking a hunk line opens it at that line. `Cmd+O` does the same for the selection. All three pass the absolute `filePath` to `openInIde`; `relPath` is display only, and agents edit outside the worktree often enough — memory files, scratch dirs — that it shortens those against `~` instead of rendering a chain of `..`.

Switching tasks re-reads the tail of the new task's transcript. The feed is a projection of that file and holds no state of its own.

## Changes made by subagents

Subagent work is written to `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`. `claude-watcher.ts` already discovers these for token usage, but only as a one-shot read; the live tail does not follow them.

They carry a meaningful share of the editing. Of the 400 most recently modified subagent transcripts on this machine, 72 contain an edit tool call, totalling 575 `Edit` and 200 `Write`. A feed that ignores them goes blank during agent fan-out.

Only their file changes cross over. Those same 400 transcripts hold 8920 `Bash` calls and 817 `Read`s, which as ticks would bury the session's own feed.

Labelling has no single source. The parent transcript links an agent only when a skill forked it, through a `<forked-skill-launch>` record carrying `agentId` and `skillName`; an ordinary `Agent` call leaves no link, and these files carry no `slug`. So a label falls back to the first line of prose in the subagent's own opening prompt — prose, because agents are dispatched behind an XML envelope or a fenced block as often as a sentence — and to the `agentId` when even that is absent.

`pullSubagents` reads new bytes from each `agent-*.jsonl` on the poll the watcher already runs, so no second timer is needed, and it runs even when the session's own transcript gained nothing. Events from every file are sorted by timestamp before folding. A change never merges across agents: the group's identity is file plus label.

## Testing

`scripts/check-change-feed.mts` runs `foldFeed` over a fixture transcript, following the convention of the existing `scripts/check-*.mts` invariant checks. It pins:

- both break rules — a different file, and an intervening narration block
- that a `Bash` call between two edits to one file does not break the group
- the recomputed diff for a group where a later edit rewrites text an earlier one inserted
- a `Write` following an `Edit` on the same file
- a create, which carries no `originalFile` to diff against
- a file edited outside the worktree
- tick collapsing with a count
- that a subagent's changes are attributed and never merge with the session's own
- a worktree change shown under the command it appeared during
- one write seen by both sources drawing one card
- which git commands move the tree and which do not
- that a blob id matches what `git hash-object` gives
- a diff parsing to one entry per patched file, skipping renames and binaries
- the ignore list catching build output at any depth
- a message's addressee resolving to a task name
- a command reading as its work rather than the directory it starts in
- a thought reading as narration, and an empty one not reading as anything
- a background command's completion notice naming the call that started it, and not becoming an item itself


`foldFeed` is pure, so these are the whole behaviour of the fold. The scan is not: `scripts/check-worktree-scan.mts` builds a git repository in a temporary directory and drives the service through it, pinning that a run of edits to one file arrives as a single card carrying all of them, and that returning to a file after another has intervened opens a card holding only what is new. Reaching the service from a check script is what `allowImportingTsExtensions` is for; the only `tsc` the project runs already passes `--noEmit`.

The dock is left to manual checking.

## Bifrost's own replies are not the task's

The CLI files a transcript under a project directory derived from the working directory. `runOneShot` ran from the worktree, so every summary and generated title landed among the task's own transcripts — and the activity log, token usage and this feed all read *every* `.jsonl` in that directory when a task's session id is unknown. Bifrost was reading its own output back as the agent's work. One-shots now run from `~/.bifrost/oneshot`; they load no tools, settings or MCP servers and take their input on stdin, so the directory they run in carries nothing else.

## The CLI is a symlink

`claude` resolves through `~/.local/bin/claude`, which the CLI's updater repoints as versions land — three in as many days on this machine. `runOneShot` retries once after 400ms when a spawn reports ENOENT, and reports a missing binary at warning level: a task without a summary is still the task.

## Out of scope

`DiffOverlay` stays; neither surface subsumes the other.

No cross-task feed, no search, no export, and no persistence.
