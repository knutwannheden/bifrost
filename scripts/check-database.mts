/**
 * The database runs on node:sqlite, which Electron and plain Node both have, so
 * a headless instance opens it with the same code. Run with `npm run check:database`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-db-'));
// db.ts fixes its path as it loads.
process.env.HOME = home;
const { closeDatabase, openDatabase, transaction } = await import('../src/main/db.ts');
const { loadTasks, saveTasks, saveTurnBoundary } = await import('../src/main/task-store.ts');
const { createNote, listNotes } = await import('../src/main/note-store.ts');

try {
  openDatabase();

  {
    const full: Task = {
      id: 'a',
      name: 'every field',
      repoId: 'r',
      baseBranch: 'main',
      branch: 'feature',
      worktreePath: '/w/a',
      sessionId: 's',
      status: 'archived',
      hasUnread: true,
      createdAt: 1,
      archivedAt: 2,
      terminalTitle: 't',
      summary: 'sum',
      createdByTaskId: 'b',
      isExternal: true,
      inPlace: true,
      sessionHistory: ['old'],
      claudeActive: true,
      lastTurnBoundaryAt: 3,
      interruptedAt: 4,
      machine: 'perf',
      curation: {
        outcome: 'merged',
        confidence: 'user',
        reason: 'why',
        prState: 'merged',
        branchMerged: true,
        classifiedAt: 5,
        userOverride: 'abandoned',
        userNote: 'note',
      },
    };
    const bare: Task = {
      id: 'b',
      name: 'no optional field',
      repoId: 'r',
      baseBranch: 'main',
      worktreePath: '/w/b',
      status: 'running',
      hasUnread: false,
      createdAt: 6,
    };
    saveTasks([full, bare]);
    const loaded = loadTasks();
    check('tasks come back from the store as they were saved', isDeepStrictEqual(loaded, [full, bare]), show(loaded));
  }

  {
    let threw = '';
    try {
      transaction(() => {
        createNote('r', 'n');
        throw new Error('x');
      });
    } catch (err) {
      threw = (err as Error).message;
    }
    const notes = listNotes('r');
    check(
      'a transaction that throws leaves nothing behind',
      threw === 'x' && notes.length === 0,
      show({ threw, notes }),
    );
  }

  {
    // Another process takes the write lock and holds it for 400 ms.
    const holder = spawn(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const d = new DatabaseSync(process.argv[1]);
       d.exec('BEGIN IMMEDIATE');
       console.log('locked');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
       d.exec('COMMIT');`,
      path.join(home, '.bifrost', 'bifrost.db'),
    ]);
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
    let error = '';
    try {
      saveTurnBoundary('a', 7);
    } catch (err) {
      error = (err as Error).message;
    }
    await new Promise((resolve) => holder.once('exit', resolve));
    check('a write waits for the lock another process holds', error === '', show({ error }));
  }
} finally {
  closeDatabase();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
