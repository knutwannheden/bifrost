import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, BifrostConfig } from '../shared/types.ts';
import { modelFlags } from './agents.ts';
import { loadConfig } from './config.ts';
import { INHERITED_SESSION_VARS } from './session-manager.ts';

/**
 * A transcript is filed under a project directory derived from the working
 * directory, so these run outside any worktree as well as leaving no session
 * behind: among a task's own transcripts, Bifrost's replies are read back as the
 * agent's work by everything that scans that directory.
 */
const ONESHOT_DIR = path.join(os.homedir(), '.bifrost', 'oneshot');

/**
 * The default system prompt equips an agent, which costs about 40k tokens a call
 * and buys nothing here: the whole instruction arrives on stdin, and the reply
 * comes back through the structured-output tool.
 */
const TRANSFORM_PROMPT = 'You rewrite text. Reply only through the structured output tool.';

export interface OneShotOptions {
  /** Standing instructions; the transcript or other input follows it on stdin. */
  prompt: string;
  input: string;
  /** Copilot and Codex run their own default model. */
  claudeModel: string;
  /** The effort Copilot and Codex run at, in their terms. Absent leaves their default. */
  effort?: string;
  /** The reply is held to this, so the prompt carries only editorial rules. */
  schema: unknown;
  timeoutMs: number;
  /** Prefixes log lines, so a failure says which caller it belonged to. */
  label: string;
}

/** The agent that runs Bifrost's titles, summaries and walkthroughs, or 'off' for none. */
export function oneShotAgent(config: BifrostConfig = loadConfig()): AgentKind | 'off' {
  return config.oneshotAgent ?? config.agent ?? 'claude';
}

/**
 * The CLI installs as a symlink its updater repoints, so the name resolves for
 * everything except the instant of a version swap. One retry covers that.
 */
const RESPAWN_DELAY_MS = 400;

/** One run of a CLI. Its stdout is kept only from a run that succeeded. */
interface CliRun {
  ok: boolean;
  stdout: string;
  /** The binary was not found, so the call never reached the CLI. */
  missing: boolean;
}

/**
 * Put one text transform through the chosen agent's CLI and hand back its
 * structured reply, or null when the agent is off or gives none. Loading no
 * tools, MCP servers or settings where the CLI allows it is what keeps this a
 * transform rather than a session, and keeps its cost to the text it is given.
 */
export async function runOneShot<T>(options: OneShotOptions): Promise<T | null> {
  const agent = oneShotAgent();
  if (agent === 'off') return null;
  if (agent === 'codex') return runCodex<T>(options);
  if (agent === 'copilot') return runCopilot<T>(options);
  return runClaude<T>(options);
}

async function runClaude<T>(options: OneShotOptions): Promise<T | null> {
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(options.schema)];
  args.push('--model', options.claudeModel, '--system-prompt', TRANSFORM_PROMPT, '--tools', '', ...CLAUDE_ISOLATION);
  const run = await runCli('claude', args, `${options.prompt}\n\n${options.input}`, options.timeoutMs, options.label);
  if (!run.ok) return null;
  try {
    return (JSON.parse(run.stdout).structured_output as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Codex enforces the schema itself, and writes the final reply to a file of its own. */
async function runCodex<T>(options: OneShotOptions): Promise<T | null> {
  const dir = fs.mkdtempSync(path.join(oneShotDir(), 'codex-'));
  try {
    const schemaFile = path.join(dir, 'schema.json');
    const replyFile = path.join(dir, 'reply.json');
    fs.writeFileSync(schemaFile, JSON.stringify(options.schema));
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only'];
    args.push('--output-schema', schemaFile, '-o', replyFile, ...modelFlags('codex', { effort: options.effort }), '-');
    const run = await runCli('codex', args, `${options.prompt}\n\n${options.input}`, options.timeoutMs, options.label);
    if (!run.ok) return null;
    return JSON.parse(fs.readFileSync(replyFile, 'utf-8')) as T;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copilot has no schema option, so the schema goes into the prompt and the
 * reply is checked here. With -p it ignores stdin, so the whole prompt is piped.
 */
async function runCopilot<T>(options: OneShotOptions): Promise<T | null> {
  const args = ['--silent', '--no-color', '--no-auto-update', '--available-tools', ''];
  args.push('--no-custom-instructions', '--disable-builtin-mcps', ...modelFlags('copilot', { effort: options.effort }));
  const input = [
    options.prompt,
    `Reply with one JSON object and nothing else, matching this JSON Schema:\n${JSON.stringify(options.schema)}`,
    options.input,
  ].join('\n\n');
  const run = await runCli('copilot', args, input, options.timeoutMs, options.label);
  if (!run.ok) return null;
  const reply = jsonReply<T>(run.stdout, options.schema);
  if (!reply) console.warn(`[${options.label}] copilot gave no JSON matching the schema: ${run.stdout.slice(0, 500)}`);
  return reply;
}

/**
 * The JSON object in a reply that holds the schema's top-level required keys, or
 * null. A model asked for bare JSON may still fence it or add a sentence.
 */
export function jsonReply<T>(text: string, schema: unknown): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const required = (schema as { required?: string[] }).required ?? [];
  return required.every((key) => key in value) ? (value as T) : null;
}

/** Keeps a Claude run from loading the user's settings, MCP servers or browser, and from asking. */
const CLAUDE_ISOLATION = [
  '--no-session-persistence',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--no-chrome',
  '--dangerously-skip-permissions',
];

/** Shown as the sender of what the relay delivers. */
const RELAY_NAME = 'Bifrost';
const RELAY_TIMEOUT_MS = 60_000;
const RELAY_PROMPT =
  'You deliver one message to another Claude Code session with SendMessage, then stop. ' +
  'Send the message verbatim. If SendMessage cannot tell which session the name means, call ListAgents ' +
  'and send to the one that is running, not offline, giving its [ref]. ' +
  'Reply with SENT followed by the address you gave SendMessage, or FAILED followed by the reason.';

/**
 * Deliver one message to the session with that name, the way one session
 * messages another. Bifrost is no session, so a headless one sends it for it.
 * The sender exits once it has sent, so a reply reaches nobody. It always runs
 * Claude, since only Claude has SendMessage.
 */
export async function relayMessage(to: string, message: string): Promise<boolean> {
  const args = ['-p', '--output-format', 'json', '--model', 'haiku', '--name', RELAY_NAME];
  args.push('--system-prompt', RELAY_PROMPT, '--tools', 'SendMessage,ListAgents', ...CLAUDE_ISOLATION);
  const input = `Recipient: ${JSON.stringify(to)}\n\nMessage:\n${message}`;
  const run = await runCli('claude', args, input, RELAY_TIMEOUT_MS, 'relay');
  if (!run.ok) return false;
  let result = '';
  try {
    result = String(JSON.parse(run.stdout).result ?? '').trim();
  } catch {
    /* reported as not sent below */
  }
  const sent = result.startsWith('SENT');
  console[sent ? 'log' : 'warn'](`[relay] to ${to}: ${result || '(no result)'}`);
  return sent;
}

/** Runs the CLI once more after a moment when its binary was not found on the first try. */
async function runCli(bin: string, args: string[], input: string, timeoutMs: number, label: string): Promise<CliRun> {
  const first = await attempt(bin, args, input, timeoutMs, label);
  if (!first.missing) return first;

  await new Promise((r) => setTimeout(r, RESPAWN_DELAY_MS));
  const second = await attempt(bin, args, input, timeoutMs, label);
  if (second.missing) {
    console.warn(`[${label}] ${bin} is not on PATH; skipping`);
  }
  return second;
}

function oneShotDir(): string {
  fs.mkdirSync(ONESHOT_DIR, { recursive: true });
  return ONESHOT_DIR;
}

function attempt(bin: string, args: string[], input: string, timeoutMs: number, label: string): Promise<CliRun> {
  return new Promise((resolve) => {
    const env = { ...process.env } as Record<string, string>;
    for (const name of INHERITED_SESSION_VARS) delete env[name];

    const child = spawn(bin, args, { cwd: oneShotDir(), env });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, missing = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: ok ? stdout : '', missing });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false);
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    // Drained even though unused on success: an unread pipe fills once the CLI
    // writes past the OS buffer (~64KB) and blocks the child until the timeout.
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) console.error(`[${label}] failed to spawn ${bin}:`, err);
      finish(false, missing);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // Claude's --output-format json reports failures as JSON on stdout, so
        // stderr is routinely empty and carries none of the reason.
        console.error(
          `[${label}] ${bin} exited with code ${code}`,
          `\n  stdout: ${stdout.trim().slice(0, 2000) || '(empty)'}`,
          `\n  stderr: ${stderr.trim().slice(-500) || '(empty)'}`,
        );
        finish(false);
        return;
      }
      finish(true);
    });

    child.stdin.on('error', () => finish(false));
    child.stdin.end(input);
  });
}
