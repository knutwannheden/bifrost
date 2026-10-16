/**
 * Which configured repo a caller's `repo` string names. A name, a GitHub slug
 * and an absolute path all resolve. Anything else is an error, since a task
 * created against the wrong repo does its work there.
 * Run with `npm run check:repo-match`.
 */
import os from 'node:os';
import path from 'node:path';
import { matchRepo } from '../src/main/repo-manager.ts';
import type { Repo } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

function repo(name: string, repoPath: string, githubPath?: string): Repo {
  return { id: `id-${githubPath ?? repoPath}`, name, path: repoPath, defaultBranch: 'main', githubPath };
}

const api = repo('web-api', '/Users/me/git/acme/web-api', 'acme/web-api');
const upstream = repo('widget', '/Users/me/git/upstream/widget', 'upstream/widget');
const fork = repo('widget', '/Users/me/git/acme/widget', 'acme/widget');
const repos = [api, upstream, fork];

function failure(input: string, list: readonly Repo[] = repos): string {
  try {
    matchRepo(list, input);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

check('a configured repo name resolves', matchRepo(repos, 'web-api') === api, `got ${failure('web-api')}`);

check('a GitHub slug resolves', matchRepo(repos, 'acme/widget') === fork, `got ${matchRepo(repos, 'acme/widget')?.id}`);

{
  const message = failure('widget');
  check(
    'a name two repos share is rejected, naming the slugs that separate them',
    message.includes('widget') && message.includes('acme/widget') && message.includes('upstream/widget'),
    `got ${JSON.stringify(message)}`,
  );

  const twice = [api, { ...api, id: 'other' }];
  check(
    'a name repeated for one directory resolves to it',
    matchRepo(twice, 'web-api')?.path === api.path,
    `got ${failure('web-api', twice)}`,
  );
}

{
  const message = failure('not-configured');
  check(
    'a bare word that matches nothing is rejected rather than treated as a path',
    message.includes('not-configured') && !message.includes(process.cwd()),
    `got ${JSON.stringify(message)}`,
  );
}

{
  check(
    'an absolute path resolves to the repo holding it',
    matchRepo(repos, '/Users/me/git/upstream/widget/') === upstream,
  );

  check(
    'an absolute path no repo holds comes back null, for the caller to add',
    matchRepo(repos, '/Users/me/git/acme/unlisted') === null,
  );

  const home = repo('here', path.join(os.homedir(), 'git', 'here'));
  check('a leading ~ expands', matchRepo([home], '~/git/here') === home, `got ${failure('~/git/here', [home])}`);
}

process.exit(failed === 0 ? 0 : 1);
