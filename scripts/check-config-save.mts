/**
 * The renderer saves the whole config back, so anything the main process owns
 * has to survive that. Run with `npm run check:config-save`.
 */

import os from 'node:os';

import { mergeRendererConfig } from '../src/main/config-merge.ts';
import { normalizeRepoPath } from '../src/main/repo-path.ts';
import type { BifrostConfig, Repo } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

const repo = (name: string): Repo => ({ id: name, name, path: `/repos/${name}`, defaultBranch: 'main' });
const config = (over: Partial<BifrostConfig>): BifrostConfig => ({ repos: [], fontSize: 13, ...over }) as BifrostConfig;

{
  // The window has held its copy since before add_repo ran, and since before a
  // repo was removed through the dialog.
  const stale = config({ repos: [repo('a')] });
  const onDisk = config({ repos: [repo('a'), repo('b')] });
  const removed = mergeRendererConfig(config({ repos: [repo('a'), repo('b')] }), config({ repos: [repo('a')] }));

  check(
    'the repo list is taken from disk, not from the window',
    mergeRendererConfig(stale, onDisk).repos.length === 2 && removed.repos.length === 1,
  );
}

check(
  "the window's own settings are what get saved",
  mergeRendererConfig(config({ fontSize: 18 }), config({ fontSize: 13 })).fontSize === 18,
);

check(
  'a scan timestamp written since the window loaded is not rolled back',
  mergeRendererConfig(config({}), config({ lastDiskScanAt: 1234 })).lastDiskScanAt === 1234,
);

check(
  'a repo given with a leading ~ is the same repo as its expanded path',
  normalizeRepoPath('~/git/demo') === normalizeRepoPath(`${os.homedir()}/git/demo`),
  `  got ${normalizeRepoPath('~/git/demo')}`,
);

process.exit(failed === 0 ? 0 : 1);
