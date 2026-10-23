/**
 * A task keeps the PR it last showed when a `gh` call fails.
 * Runs against a fake `gh` on PATH. Run with `npm run check:pr-index`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTaskPrs } from '../src/main/pr-index.ts';
import type { Repo, Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-index-'));
// FAKE_GH names the calls that fail. "list" fails both listings, and "all" fails every call.
fs.writeFileSync(
  path.join(bin, 'gh'),
  `#!/bin/sh
case "$FAKE_GH:$*" in
  all:*) exit 1 ;;
  *:--version) echo "gh version 2.0.0" ;;
  list:*) echo "HTTP 502" >&2; exit 1 ;;
  *"--state all"*) echo '[{"number":42,"state":"OPEN","isDraft":false,"headRefName":"feature","url":"https://github.com/o/r/pull/42"}]' ;;
  *"--state open"*) echo '[{"number":42,"mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}]' ;;
esac
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;

let now = Date.now();
Date.now = () => now;
const HOUR = 60 * 60 * 1000;

const repo = { id: 'r', name: 'r', path: bin, defaultBranch: 'main' } as Repo;
const task = { id: 't', repoId: 'r', branch: 'feature' } as Task;

try {
  process.env.FAKE_GH = 'none';
  const first = (await getTaskPrs([task], [repo])).t;

  process.env.FAKE_GH = 'list';
  now += HOUR;
  const afterFailedListing = (await getTaskPrs([task], [repo])).t;
  check(
    'a failed listing keeps the PR and its checks as last seen',
    !!first && JSON.stringify(afterFailedListing) === JSON.stringify(first),
    `before ${JSON.stringify(first)}, after ${JSON.stringify(afterFailedListing)}`,
  );

  process.env.FAKE_GH = 'all';
  now += HOUR;
  const afterGhVanished = (await getTaskPrs([task], [repo])).t;
  check(
    'gh failing its version check answers from the last index',
    !!first && JSON.stringify(afterGhVanished) === JSON.stringify(first),
    `got ${JSON.stringify(afterGhVanished)}`,
  );
} finally {
  fs.rmSync(bin, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
