import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseDiff } from '../shared/diff-parser';
import { GENERATED_SCHEMA, type GeneratedWalkthrough, numberDiff, type Walkthrough } from '../shared/walkthrough';
import { runOneShot } from './claude-oneshot';
import { getRangeDiff, resolveDiffBase } from './diff-service';
import { anchorGenerated, currentHead } from './walkthrough-anchor';

const execFile = promisify(execFileCb);

const ROOT = path.join(os.homedir(), '.bifrost', 'walkthroughs');

/** Runs once per change on request and reads all of it, so the narrative is worth the larger model. */
const MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 15 * 60_000;
/** A diff past this is too large to narrate well, and a truncated one would be narrated wrongly. */
const MAX_DIFF_CHARS = 400_000;

const PROMPT = `You are writing a guided tour of a code change for a human who wants to understand it.
This is not a code review. Your job is the order and the narration.

The input is the commit log of the change and its diff. Every diff line is prefixed with its line
number on the old side, its line number on the new side, then the diff sign; "-" means the line does
not exist on that side.

Produce an ordered list of steps. Each step is one stop: a title, a short markdown body saying what
this part of the change does and why the reader should look at it now, and an anchor on the lines it
is about. Order the steps so that the change becomes understandable:
- the idea or type a change is built around before the code that uses it
- producers before consumers, and the core change before its call sites
- tests after the code they test
- mechanical fallout (renames, imports, generated files, lockfiles) last, grouped into one or two steps
Diff order and alphabetical order are not reasons for an order.

Anchors:
- path is the file's path on the side you anchor to; side is "new" for added or context lines and
  "old" for removed lines.
- lines are the first and last line of the range, inclusive, copied from that side's column. Never
  count lines yourself.
- quote is the text of the first anchored line, verbatim, without the diff sign. It is used to check
  your line numbers, so copy it exactly.
- A step may have a null anchor only when it is about the change as a whole.

Use chapters (the same chapter string on consecutive steps) when there are more than about eight steps.

Every step and comment has a kind. Use "narration" for everything that explains. Use "concern",
"bug" or "finding" only where the reader's focus asks for it, or where narrating the code made a
problem impossible not to mention; put those as comments on the lines they are about. Do not look for
problems beyond that.

Write plainly. Say what the code does and why, in the terms the reader will meet in the diff.`;

export interface GenerateRequest {
  worktreePath: string;
  baseRef: string;
  focus: string | null;
}

export async function generateWalkthrough({ worktreePath, baseRef, focus }: GenerateRequest): Promise<Walkthrough> {
  const base = await resolveDiffBase(worktreePath, baseRef);
  if (!base) throw new Error(`No merge base with ${baseRef}`);
  const head = await currentHead(worktreePath);
  const diff = await getRangeDiff(worktreePath, base, head);
  if (!diff.trim()) throw new Error('No committed changes on this branch');

  const numbered = numberDiff(parseDiff(diff));
  if (numbered.length > MAX_DIFF_CHARS) {
    throw new Error(
      `The diff is ${Math.round(numbered.length / 1000)}k characters; walkthroughs stop at ${MAX_DIFF_CHARS / 1000}k`,
    );
  }

  const { stdout: log } = await execFile('git', ['log', '--reverse', '--format=%h %s%n%b', `${base}..${head}`], {
    cwd: worktreePath,
    maxBuffer: 5 * 1024 * 1024,
  });
  const { stdout: headRef } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });

  const input = [
    focus ? `The reader's focus:\n${focus}` : 'The reader gave no particular focus.',
    `Commits, oldest first:\n${log.trim()}`,
    `Diff:\n${numbered}`,
  ].join('\n\n');
  const generated = await runOneShot<GeneratedWalkthrough>({
    prompt: PROMPT,
    input,
    model: MODEL,
    schema: GENERATED_SCHEMA,
    timeoutMs: TIMEOUT_MS,
    label: 'walkthrough',
  });
  if (!generated) throw new Error('The generator gave no answer; see the main process log');

  return anchorGenerated(worktreePath, base, head, generated, {
    focus,
    model: MODEL,
    headRef: headRef.trim() === 'HEAD' ? null : headRef.trim(),
  });
}

function taskDir(taskId: string): string {
  return path.join(ROOT, taskId);
}

/** Each walkthrough is a new file, so regenerating never destroys a tour. */
export function storeWalkthrough(taskId: string, w: Walkthrough): void {
  const dir = taskDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${w.generatedAt.replace(/[:.]/g, '-')}-${w.change.head.slice(0, 7)}.json`;
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(w, null, 2)}\n`);
}

export function loadCurrentWalkthrough(taskId: string): Walkthrough | null {
  let files: string[];
  try {
    files = fs.readdirSync(taskDir(taskId)).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  const newest = files.sort().at(-1);
  if (!newest) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(taskDir(taskId), newest), 'utf-8')) as Walkthrough;
  } catch {
    return null;
  }
}
