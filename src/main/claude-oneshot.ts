import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INHERITED_SESSION_VARS } from './session-manager';

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
  model: string;
  /** The CLI validates the reply against this, so the prompt carries only editorial rules. */
  schema: unknown;
  timeoutMs: number;
  /** Prefixes log lines, so a failure says which caller it belonged to. */
  label: string;
}

/**
 * The CLI installs as a symlink its updater repoints, so the name resolves for
 * everything except the instant of a version swap. One retry covers that.
 */
const RESPAWN_DELAY_MS = 400;

interface Attempt<T> {
  value: T | null;
  /** The binary was not found, so the call never reached the CLI. */
  missing: boolean;
}

/**
 * Put one text transform through the CLI and hand back its structured reply.
 * Loading no tools, MCP servers or settings is what keeps this a transform
 * rather than a session, and keeps its cost to the text it is given.
 */
export async function runOneShot<T>(options: OneShotOptions): Promise<T | null> {
  const first = await attempt<T>(options);
  if (!first.missing) return first.value;

  await new Promise((r) => setTimeout(r, RESPAWN_DELAY_MS));
  const second = await attempt<T>(options);
  if (second.missing) {
    console.warn(`[${options.label}] claude is not on PATH; skipping`);
  }
  return second.value;
}

function oneShotDir(): string {
  fs.mkdirSync(ONESHOT_DIR, { recursive: true });
  return ONESHOT_DIR;
}

function attempt<T>(options: OneShotOptions): Promise<Attempt<T>> {
  return new Promise((resolve) => {
    const env = { ...process.env } as Record<string, string>;
    for (const name of INHERITED_SESSION_VARS) delete env[name];

    const child = spawn(
      'claude',
      [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(options.schema),
        '--model',
        options.model,
        '--system-prompt',
        TRANSFORM_PROMPT,
        '--tools',
        '',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--no-chrome',
        '--dangerously-skip-permissions',
      ],
      { cwd: oneShotDir(), env },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: T | null, missing = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ value, missing });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, options.timeoutMs);

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
      if (!missing) console.error(`[${options.label}] failed to spawn claude:`, err);
      finish(null, missing);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // --output-format json reports failures as JSON on stdout, so stderr is
        // routinely empty and carries none of the reason.
        console.error(
          `[${options.label}] claude exited with code ${code}`,
          `\n  stdout: ${stdout.trim().slice(0, 2000) || '(empty)'}`,
          `\n  stderr: ${stderr.trim().slice(0, 500) || '(empty)'}`,
        );
        finish(null);
        return;
      }
      try {
        finish((JSON.parse(stdout).structured_output as T | undefined) ?? null);
      } catch {
        finish(null);
      }
    });

    child.stdin.on('error', () => finish(null));
    child.stdin.end(`${options.prompt}\n\n${options.input}`);
  });
}
