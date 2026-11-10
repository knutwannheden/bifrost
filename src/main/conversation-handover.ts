import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, Task } from '../shared/types.ts';
import { claudeConfigDir, claudeConfigRelative } from './claude-paths.ts';
import { sessionDir } from './tmux-session.ts';

const NAMES: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' };

/** About 15k tokens: enough to carry on from, without spending the new session's context on history. */
const KEEP_CHARS = 60_000;

interface Turn {
  user: boolean;
  text: string;
}

/** The file on this machine that holds the conversation an agent keeps under sessionId. */
export function transcriptFile(agent: AgentKind, sessionId: string): string | undefined {
  const home = os.homedir();
  const existing = (file: string) => (fs.existsSync(file) ? file : undefined);
  const subdirs = (dir: string) => {
    try {
      return fs.readdirSync(dir).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  };
  if (agent === 'claude') {
    return subdirs(path.join(claudeConfigDir(), 'projects'))
      .map((dir) => path.join(dir, `${sessionId}.jsonl`))
      .find((file) => fs.existsSync(file));
  }
  if (agent === 'copilot') {
    const copilotHome = process.env.COPILOT_HOME ?? path.join(home, '.copilot');
    return existing(path.join(copilotHome, 'session-state', sessionId, 'events.jsonl'));
  }
  const days = subdirs(path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions'))
    .flatMap(subdirs)
    .flatMap(subdirs);
  return days
    .flatMap(subdirs)
    .find((file) => /\/rollout-[^/]*\.jsonl$/.test(file) && file.endsWith(`-${sessionId}.jsonl`));
}

type Block = { type?: string; text?: unknown };
const texts = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Block[])
        .filter((b) => typeof b.text === 'string' && b.type !== 'thinking')
        .map((b) => b.text as string)
        .join('\n\n')
    : typeof content === 'string'
      ? content
      : '';

/** A turn from one transcript record, or null for tool traffic and what the agent adds on its own. */
function turnOf(agent: AgentKind, record: Record<string, any>): Turn | null {
  if (agent === 'claude') {
    if (record.isMeta || (record.type !== 'user' && record.type !== 'assistant')) return null;
    const text = texts(record.message?.content);
    // Slash commands and their output come back as user records in tags.
    if (record.type === 'user' && text.startsWith('<')) return null;
    return { user: record.type === 'user', text };
  }
  if (agent === 'copilot') {
    if (record.type !== 'user.message' && record.type !== 'assistant.message') return null;
    return { user: record.type === 'user.message', text: texts(record.data?.content) };
  }
  const item = record.payload;
  if (record.type !== 'response_item' || item?.type !== 'message') return null;
  if (item.role !== 'user' && item.role !== 'assistant') return null;
  const text = texts(item.content);
  // Codex puts its environment and the repo's AGENTS.md before the prompt as user messages.
  if (item.role === 'user' && (text.startsWith('<') || text.startsWith('# AGENTS.md'))) return null;
  return { user: item.role === 'user', text };
}

function turns(agent: AgentKind, file: string): Turn[] {
  const out: Turn[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    let record: Record<string, any>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const turn = turnOf(agent, record);
    if (!turn || !turn.text.trim()) continue;
    const last = out[out.length - 1];
    if (last?.user === turn.user) last.text += `\n\n${turn.text.trim()}`;
    else out.push({ user: turn.user, text: turn.text.trim() });
  }
  return out;
}

/**
 * Writes the conversation an agent kept under sessionId as text in the task's
 * session directory, and returns the prompt that points the next agent at it.
 * Only the most recent part is kept.
 */
export function handOverConversation(taskId: string, agent: AgentKind, sessionId: string): string | undefined {
  const source = transcriptFile(agent, sessionId);
  if (!source) return undefined;
  const sections = turns(agent, source).map((t) => `## ${t.user ? 'User' : NAMES[agent]}\n\n${t.text}\n`);
  let size = 0;
  let from = sections.length;
  while (from > 0 && size + sections[from - 1].length <= KEEP_CHARS) size += sections[--from].length;
  const kept =
    from === sections.length && from > 0 ? [`…${sections[from - 1].slice(-KEEP_CHARS)}`] : sections.slice(from);
  const file = path.join(os.homedir(), sessionDir(taskId), 'conversation.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, kept.join('\n'));
  return handOverPrompt(agent, file);
}

function handOverPrompt(agent: AgentKind, where: string): string {
  return [
    `This task's conversation so far was with ${NAMES[agent]}, and you are taking it over.`,
    `Read ${where} for it.`,
    'If its last request is unfinished, carry on with it. Otherwise wait for my next message.',
  ].join(' ');
}

/**
 * The handover prompt for a session on another machine, whose transcript
 * Bifrost cannot read from here. It names the transcript in the previous agent's own format.
 */
export function remoteHandOver(agent: AgentKind, sessionId: string): string {
  const where = {
    claude: `~/${claudeConfigRelative() ?? '.claude'}/projects/*/${sessionId}.jsonl`,
    copilot: `~/.copilot/session-state/${sessionId}/events.jsonl`,
    codex: `~/.codex/sessions/*/*/*/rollout-*-${sessionId}.jsonl`,
  }[agent];
  return handOverPrompt(agent, `${where}, ${NAMES[agent]}'s own transcript`);
}

/**
 * What a task's record becomes as its session starts under agent. A
 * conversation another agent kept moves to the history, and handOver gives the
 * prompt that carries it on. Every agent but Codex starts under an id chosen here.
 * A session still running in tmux is only joined, so its task keeps the agent it has.
 */
export function switchAgent(
  task: Pick<Task, 'agent' | 'sessionId' | 'sessionHistory'>,
  chosen: AgentKind,
  handOver: (was: AgentKind, sessionId: string) => string | undefined,
  running = false,
): { changes: Partial<Task>; prompt?: string } {
  const was = task.agent ?? 'claude';
  const agent = running ? was : chosen;
  const changes: Partial<Task> = {};
  let prompt: string | undefined;
  let sessionId = task.sessionId;
  if (was !== agent) {
    changes.agent = agent;
    if (sessionId) {
      prompt = handOver(was, sessionId);
      changes.sessionHistory = [...(task.sessionHistory ?? []), sessionId];
      changes.sessionId = sessionId = undefined;
    }
  }
  if (!sessionId && agent !== 'codex') changes.sessionId = randomUUID();
  return { changes, prompt };
}
