import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const CLI = join(import.meta.dirname, 'cli.ts');
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'headroom-cli-'));
  env = {
    ...process.env,
    HEADROOM_DB: join(dir, 'board.db'),
    HEADROOM_POLL_MS: '50',
    CLAUDE_CODE_SESSION_ID: 'sess-cli',
    BIFROST_SESSION_NAME: undefined,
    HEADROOM_AS: undefined,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('cli', () => {
  test('a queued acquire names the holder the way SendMessage takes it, and exits non-zero', () => {
    const first = run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/granted #1/);

    const second = run(['acquire', 'cpu', '--shared', '--why', 'tests', '--as', 'suite']);
    expect(second.code).toBe(1);
    expect(second.out).toMatch(/waiting #2/);
    expect(second.out).toContain('SendMessage');
    expect(second.out).toContain('"bench"');
  });

  test('release names whoever is granted next, so the releaser can tell them', () => {
    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    run(['acquire', 'cpu', '--shared', '--why', 'tests', '--as', 'suite']);

    const released = run(['release', '1']);
    expect(released.out).toMatch(/granted next.*"suite"/);
    expect(run(['release', '2']).out).not.toContain('granted next');
  });

  test('wait returns once the holder releases', async () => {
    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    run(['acquire', 'cpu', '--shared', '--why', 'tests', '--as', 'suite']);

    const waiting = spawn(process.execPath, [CLI, 'wait', '2', '--timeout', '5s'], { env });
    let out = '';
    waiting.stdout.on('data', (d) => (out += d));
    await new Promise((r) => setTimeout(r, 150));
    run(['release', '1']);
    const code = await new Promise<number | null>((r) => waiting.on('exit', r));

    expect(code).toBe(0);
    expect(out).toMatch(/granted #2/);
  }, 10_000);

  test('a claim with no messageable name is refused rather than filed under the user', () => {
    const r = run(['acquire', 'cpu', '--shared', '--why', 'tests']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--as');
    expect(run(['status']).out).toBe('nothing claimed\n');
  });

  test('run holds the claim for the command and releases it on exit, passing the exit code through', () => {
    const r = run([
      'run',
      'cpu',
      '--shared',
      '--why',
      'tests',
      '--as',
      'suite',
      '--',
      'sh',
      '-c',
      'echo working; exit 7',
    ]);
    expect(r.out).toContain('working');
    expect(r.code).toBe(7);
    expect(run(['status']).out).toBe('nothing claimed\n');
  });

  test('run that gives up waiting withdraws its claim, since the command never ran', () => {
    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    const r = run([
      'run',
      'cpu',
      '--shared',
      '--why',
      'tests',
      '--as',
      'suite',
      '--timeout',
      '1s',
      '--',
      'echo',
      'never',
    ]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain('never');
    expect(run(['status']).out).not.toMatch(/waiting/);
  });

  test('run stops its command when the claim is asked to yield', async () => {
    const running = spawn(
      process.execPath,
      [CLI, 'run', 'cpu', '--shared', '--why', 'long tests', '--as', 'suite', '--', 'sleep', '30'],
      { env },
    );
    let out = '';
    running.stdout.on('data', (d) => (out += d));
    running.stderr.on('data', (d) => (out += d));
    await new Promise((r) => setTimeout(r, 300));
    run(['seize', 'cpu', '--why', 'hotfix timing', '--as', 'boss']);
    const code = await new Promise<number | null>((r) => running.on('exit', r));

    expect(code).toBe(3);
    expect(out).toMatch(/yield/i);
    expect(out).toContain('boss');
    expect(run(['status']).out).toMatch(/held by boss/);
  }, 10_000);

  test('renew tells a holder that someone has asked it to yield', () => {
    run(['acquire', 'cpu', '--shared', '--why', 'tests', '--as', 'suite']);
    run(['seize', 'cpu', '--why', 'hotfix timing', '--as', 'boss']);

    const renewed = run(['renew', '1', '--ttl', '5m']);
    expect(renewed.out).toMatch(/yield/i);
    expect(renewed.out).toContain('boss');
  });

  test('hook prints nothing for an empty board and the injection JSON otherwise', () => {
    const empty = run(['hook'], JSON.stringify({ session_id: 'sess-cli', hook_event_name: 'UserPromptSubmit' }));
    expect(empty.code).toBe(0);
    expect(empty.out.trim()).toBe('');

    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    const busy = run(['hook'], JSON.stringify({ session_id: 'sess-cli', hook_event_name: 'UserPromptSubmit' }));
    const parsed = JSON.parse(busy.out);
    expect(parsed.systemMessage).toContain('bench');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('JMH run');
  });
});
