/**
 * The external-session scan decides what the Sessions tab offers to resume.
 * Run with `npm run check:sessions`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanClaudeSessions } from '../src/main/claude-session-scanner.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-scan-'));
const projects = path.join(root, 'projects');
const now = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

/** A working directory that exists on disk, as a real session's cwd would. */
function workdir(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a transcript under `dirName`, whose mtime is `ageDays` old. */
function transcript(dirName: string, file: string, session: { sessionId: string; cwd: string }, ageDays: number) {
  const dir = path.join(projects, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${file}.jsonl`);
  fs.writeFileSync(filePath, `${JSON.stringify({ type: 'file-history-snapshot' })}\n${JSON.stringify(session)}\n`);
  const mtime = new Date(now - ageDays * DAY_MS);
  fs.utimesSync(filePath, mtime, mtime);
}

// A repo whose name contains dashes: the encoded directory name alone cannot
// say where the separators are, so the scan must read the cwd off the transcript.
const dashed = workdir('my-dashed-repo');
transcript('-tmp-my-dashed-repo', 'a', { sessionId: 'fresh', cwd: dashed }, 1);
transcript('-tmp-my-dashed-repo', 'b', { sessionId: 'fresh', cwd: dashed }, 2);
transcript('-tmp-my-dashed-repo', 'c', { sessionId: 'stale', cwd: dashed }, 30);

const worktree = workdir('task-worktree');
transcript('-tmp-task-worktree', 'd', { sessionId: 'bifrost-task', cwd: worktree }, 1);

transcript('-tmp-deleted', 'e', { sessionId: 'gone', cwd: path.join(root, 'deleted') }, 1);

const sessions = scanClaudeSessions(new Set([worktree]), projects);
const ids = sessions.map((s) => s.sessionId);

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

check(
  'a session reports the cwd its transcript recorded',
  sessions.find((s) => s.sessionId === 'fresh')?.cwd === dashed,
  `  got ${JSON.stringify(sessions.find((s) => s.sessionId === 'fresh')?.cwd)} want ${dashed}`,
);
check('a session id spanning two transcripts is listed once', ids.filter((id) => id === 'fresh').length === 1);
check('a session past the age cutoff is left out', !ids.includes('stale'));
check('a task worktree is not offered as an external session', !ids.includes('bifrost-task'));
check('a session whose cwd is gone is left out', !ids.includes('gone'));

fs.rmSync(root, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
