import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const CLI = join(import.meta.dirname, 'cli.ts');
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'headroom-cli-'));
  // A stand-in for ps on which nothing ever burns CPU, so the real machine's load cannot fail a test.
  const quietPs = join(dir, 'ps-quiet.sh');
  writeFileSync(quietPs, '#!/bin/sh\nprintf "  PID  PPID      TIME COMMAND\\n4243 1 0:00.00 idle\\n"\n', {
    mode: 0o755,
  });
  env = {
    ...process.env,
    HEADROOM_DB: join(dir, 'board.db'),
    HEADROOM_PS: quietPs,
    HEADROOM_SAMPLE_MS: '20',
    HEADROOM_POLL_MS: '50',
    CLAUDE_CODE_SESSION_ID: 'sess-cli',
    BIFROST_SESSION_NAME: undefined,
    HEADROOM_AS: undefined,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv }, input, encoding: 'utf8' });
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
    expect(second.out).toMatch(/1st in line/);
    expect(second.out).not.toMatch(/granted/);

    const third = run(['acquire', 'cpu', '--shared', '--why', 'more tests', '--as', 'suite-2']);
    expect(third.out).toMatch(/2nd in line/);
  });

  test('-q prints only the claim id, for shell composition', () => {
    const r = run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench', '-q']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('1');
    const queued = run(['acquire', 'cpu', '--exclusive', '--why', 'profiling', '--as', 'prof', '-q']);
    expect(queued.code).toBe(1);
    expect(queued.out.trim()).toBe('2');
  });

  test('hold with a grace period lets the command see the yield request and finish on its own', async () => {
    run(['acquire', 'cpu', '--shared', '--why', 'long tests', '--as', 'suite']);
    const holding = spawn(
      process.execPath,
      [
        CLI,
        'hold',
        '1',
        '--grace',
        'never',
        '--',
        'sh',
        '-c',
        'while [ ! -e "$HEADROOM_YIELD" ]; do sleep 0.05; done; echo saw-yield',
      ],
      { env },
    );
    let out = '';
    holding.stdout.on('data', (d) => (out += d));
    holding.stderr.on('data', (d) => (out += d));
    await new Promise((r) => setTimeout(r, 300));
    run(['seize', 'cpu', '--why', 'hotfix timing', '--as', 'boss']);
    const code = await new Promise<number | null>((r) => holding.on('exit', r));

    expect(out).toContain('saw-yield');
    expect(code).toBe(0);
  }, 10_000);

  test('release --requeue reports the new claim and its place behind the others', () => {
    run(['acquire', 'cpu', '--exclusive', '--why', 'round 1', '--as', 'bench']);
    run(['acquire', 'cpu', '--exclusive', '--why', 'profiling', '--as', 'prof']);
    const r = run(['release', '1', '--requeue']);
    expect(r.out).toMatch(/granted next.*"prof"/);
    expect(r.out).toMatch(/waiting #3.*1st in line/);
  });

  test('after a tool call, a holder hears once of each session that starts waiting behind it', () => {
    const afterTool = (session: string) =>
      run(['hook'], JSON.stringify({ session_id: session, hook_event_name: 'PostToolUse' }));
    const acquireAs = (holder: string, session: string) =>
      run(['acquire', 'cpu', '--exclusive', '--why', `${holder} work`, '--as', holder], undefined, {
        CLAUDE_CODE_SESSION_ID: session,
      });

    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    expect(afterTool('sess-cli').out.trim()).toBe('');

    acquireAs('prof', 'sess-prof');
    const told = afterTool('sess-cli').out;
    expect(told).toContain('prof work');
    expect(told).toContain('headroom release 1 --requeue');
    expect(afterTool('sess-cli').out.trim()).toBe('');
    expect(afterTool('sess-prof').out.trim()).toBe('');

    acquireAs('lint', 'sess-lint');
    expect(afterTool('sess-cli').out).toContain('lint work');
  });

  test('hook injects on change, at session start, and always for a session with a claim', () => {
    const prompt = (session: string) =>
      run(['hook'], JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit' }));
    const start = (session: string) =>
      run(['hook'], JSON.stringify({ session_id: session, hook_event_name: 'SessionStart' }));

    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    expect(prompt('watcher').out).toContain('JMH run');
    expect(prompt('watcher').out.trim()).toBe('');
    expect(start('watcher').out).toContain('JMH run');

    run(['acquire', 'cpu', '--shared', '--why', 'tests', '--as', 'suite']);
    expect(prompt('watcher').out).toContain('tests');

    expect(prompt('sess-cli').out).toContain('JMH run');
    expect(prompt('sess-cli').out).toContain('JMH run');
  });

  test("other sessions' shared claims coming and going are not a change to a session without a claim", () => {
    const prompt = () =>
      run(['hook'], JSON.stringify({ session_id: 'watcher', hook_event_name: 'UserPromptSubmit' })).out.trim();

    run(['acquire', 'cpu', '--shared', '--why', 'tests', '--as', 'suite']);
    run(['renew', '1']);
    expect(prompt()).toBe('');
    run(['acquire', 'cpu', '--shared', '--why', 'lint', '--as', 'lint']);
    run(['renew', '2']);
    run(['release', '1']);
    expect(prompt()).toBe('');

    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    expect(prompt()).toContain('JMH run');
  });

  test('status samples how busy the machine is, which the board alone cannot say', () => {
    const r = run(['status']);
    expect(r.out).toMatch(/\d+% busy/);
  });

  test('renew --why restates the reason on the board', () => {
    run(['acquire', 'cpu', '--exclusive', '--why', 'round 1 of 5', '--as', 'bench']);
    run(['renew', '1', '--why', 'round 3 of 5, ~10 min left']);
    expect(run(['status']).out).toContain('round 3 of 5');
  });

  test('a session with no name at all is named by its directory and session id', () => {
    const r = run(['acquire', 'cpu', '--shared', '--why', 'tests']);
    expect(r.code).toBe(0);
    expect(run(['status']).out).toContain('offered to headroom/sess-cli');
  });

  test('a Bifrost session without the name variable resolves its name from the local API', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const ok = req.url === '/find-task' && JSON.parse(body).query === 'sess-cli';
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(ok ? { ok: true, task: { id: 't1' }, sessionName: 'My Bifrost task' } : { error: 'no' }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      // The server answers from this process, so the CLI must not be waited on synchronously.
      const child = spawn(process.execPath, [CLI, 'acquire', 'cpu', '--shared', '--why', 'tests'], {
        env: { ...env, BIFROST_API_PORT: String(port) },
      });
      const code = await new Promise<number | null>((r) => child.on('exit', r));
      expect(code).toBe(0);
      expect(run(['status']).out).toContain('My Bifrost task');
    } finally {
      server.close();
    }
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
    expect(run(['status']).out).toMatch(/^nothing claimed/);
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

  test('a killed hold frees the claim on the next look, and a finished hold hands it back to the session', async () => {
    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    const holding = spawn(process.execPath, [CLI, 'hold', '1', '--', 'sleep', '2'], { env });
    await new Promise((r) => setTimeout(r, 400));
    holding.kill('SIGKILL');
    await new Promise<void>((r) => holding.on('exit', () => r()));
    expect(run(['status']).out).toMatch(/^nothing claimed/);

    run(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    expect(run(['hold', '2', '--', 'true']).code).toBe(0);
    expect(run(['status']).out).toMatch(/held by bench/);
  }, 10_000);

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
    expect(run(['status']).out).toMatch(/offered to boss/);
  }, 10_000);

  test('an exclusive acquire is refused with the pids while something outside any claim pins the CPU', () => {
    // A stand-in for ps whose one hog burns three CPU-seconds between any two calls.
    const ps = join(dir, 'ps.sh');
    writeFileSync(
      ps,
      '#!/bin/sh\nn=$(cat "$0.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0.n"\n' +
        'printf "  PID  PPID      TIME COMMAND\\n4242 1 0:%02d.00 hog\\n4243 1 0:00.00 idle\\n" $((n*3))\n',
      { mode: 0o755 },
    );
    const busyEnv = { ...env, HEADROOM_PS: ps, HEADROOM_SAMPLE_MS: '20' };
    const busy = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env: busyEnv, encoding: 'utf8' });

    const refused = busy(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench']);
    expect(refused.status).toBe(4);
    expect(refused.stdout + refused.stderr).toMatch(/hog.*4242|4242.*hog/);
    expect(run(['status']).out).toMatch(/^nothing claimed/);

    expect(busy(['acquire', 'cpu', '--shared', '--why', 'tests', '--as', 'suite']).status).toBe(0);
    expect(busy(['acquire', 'cpu', '--exclusive', '--why', 'JMH run', '--as', 'bench', '--force']).status).toBe(1);
  });

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
    const busy = run(['hook'], JSON.stringify({ session_id: 'onlooker', hook_event_name: 'UserPromptSubmit' }));
    const parsed = JSON.parse(busy.out);
    expect(parsed.systemMessage).toContain('bench');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('JMH run');
  });
});
