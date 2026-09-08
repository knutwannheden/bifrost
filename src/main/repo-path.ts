import os from 'node:os';
import path from 'node:path';

/**
 * The path a repo is identified by. `path.resolve` leaves a leading ~ in place,
 * so comparing an unexpanded path against a stored one never matches.
 */
export function normalizeRepoPath(repoPath: string): string {
  const expanded =
    repoPath.startsWith('~/') || repoPath === '~' ? path.join(os.homedir(), repoPath.slice(1)) : repoPath;
  return path.resolve(expanded);
}
