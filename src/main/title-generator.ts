import { runOneShot } from './claude-oneshot';
import { readTranscriptExcerpt } from './task-summarizer';

const TITLE_TIMEOUT_MS = 60_000;
const MODEL = 'claude-sonnet-5';

// A transcript line can carry an entire tool result, and input size is what the
// call costs. Head holds the original intent and tail the current state, so they
// stay balanced: a tail-weighted excerpt drifts the title onto the step in progress.
const MAX_LINE_CHARS = 2_000;
const MAX_HEAD_CHARS = 6_000;
const MAX_TAIL_CHARS = 6_000;

function capExcerpt(input: string): string {
  const capped = input
    .split('\n')
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line))
    .join('\n');
  if (capped.length <= MAX_HEAD_CHARS + MAX_TAIL_CHARS) return capped;
  return `${capped.slice(0, MAX_HEAD_CHARS)}\n…\n${capped.slice(-MAX_TAIL_CHARS)}`;
}

/** The CLI validates against this, so the prompt carries only editorial rules. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '3-8 words, fewer than 40 characters.' },
    description: { type: 'string', description: 'One or two sentences naming the subject and the desired outcome.' },
    branch: { type: 'string', description: 'lowercase-hyphenated, 2-5 words, no slashes.' },
  },
  required: ['title', 'description', 'branch'],
  additionalProperties: false,
} as const;

const PROMPT = `You are naming a Claude Code session so its owner can recognize it weeks later.

The input is a sequence of JSONL lines from the session transcript: "user" lines are the operator's
messages, "assistant" lines are Claude's replies, and the excerpt covers the first and last exchanges.

Identify the durable subject: what system or problem the session is really about, and what the operator
ultimately wants changed. Read the user messages first — the original subject stays the subject until the
user clearly changes it. Use assistant messages only to resolve vague references and unnamed code.

Editorial rules:
- Title the subject and outcome, not the current step. A session moving through research, planning,
  implementation, review, and merge has not changed subjects.
- Ignore incidental instructions about how the agent should work, and artifacts such as plans, branches,
  PRs, tests, and commits, unless they are themselves the topic.
- Do not claim the work is complete, and do not copy and truncate a message.
- The description is the searchable one: name concrete systems, files, and symbols so it can be found by
  keyword later. Do not restate the title.
- Avoid quotes, labels, filler, and trailing punctuation.`;

export interface GeneratedTaskTitle {
  title: string;
  description: string;
  branch: string;
}

function parseResult(out: Partial<GeneratedTaskTitle> | null): GeneratedTaskTitle | null {
  if (!out) return null;
  try {
    const title = out.title?.trim();
    const description = out.description?.trim();
    const branch = out.branch
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!title || !description || !branch) return null;
    return { title, description, branch };
  } catch {
    return null;
  }
}

/**
 * Derive a title, searchable description, and branch name from a task's
 * transcript. Returns null when there is no transcript or the CLI fails.
 */
export async function generateTaskTitle(
  worktreePath: string,
  options?: { sessionId?: string },
): Promise<GeneratedTaskTitle | null> {
  const input = readTranscriptExcerpt(worktreePath, options?.sessionId);
  if (!input) return null;
  const out = await runOneShot<Partial<GeneratedTaskTitle>>({
    prompt: PROMPT,
    input: `Session transcript:\n${capExcerpt(input)}`,
    model: MODEL,
    schema: OUTPUT_SCHEMA,
    timeoutMs: TITLE_TIMEOUT_MS,
    label: 'title-generator',
  });
  return parseResult(out);
}
