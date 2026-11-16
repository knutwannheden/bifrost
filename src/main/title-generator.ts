import { runOneShot } from './oneshot';
import { type ConversationSource, EXCERPT_FORMAT, readTranscriptExcerpt } from './task-summarizer';

const TITLE_TIMEOUT_MS = 60_000;
const MODEL = 'claude-sonnet-5';

// Head holds the original intent and tail the current state, so they stay balanced.
// A tail-weighted excerpt drifts the title onto the step in progress.
const MAX_HEAD_CHARS = 6_000;
const MAX_TAIL_CHARS = 6_000;

function capExcerpt(input: string): string {
  if (input.length <= MAX_HEAD_CHARS + MAX_TAIL_CHARS) return input;
  return `${input.slice(0, MAX_HEAD_CHARS)}\n…\n${input.slice(-MAX_TAIL_CHARS)}`;
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

const PROMPT = `You are naming a coding agent's session so its owner can recognize it weeks later.

${EXCERPT_FORMAT}

Identify the durable subject: what system or problem the session is really about, and what the operator
ultimately wants changed. Read the user messages first — the original subject stays the subject until the
user clearly changes it. Use the agent's replies only to resolve vague references and unnamed code.

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
export async function generateTaskTitle(source: ConversationSource): Promise<GeneratedTaskTitle | null> {
  const input = readTranscriptExcerpt(source);
  if (!input) return null;
  const out = await runOneShot<Partial<GeneratedTaskTitle>>({
    prompt: PROMPT,
    input: `Conversation:\n${capExcerpt(input)}`,
    claudeModel: MODEL,
    effort: 'low',
    schema: OUTPUT_SCHEMA,
    timeoutMs: TITLE_TIMEOUT_MS,
    label: 'title-generator',
  });
  return parseResult(out);
}
