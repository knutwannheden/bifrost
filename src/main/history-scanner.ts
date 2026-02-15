import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RecentRepo } from '../shared/types';
import { getGitHubPath } from './repo-manager';

const HISTORY_PATH = path.join(os.homedir(), '.claude', 'history.jsonl');
const MAX_RESULTS = 5;

export async function scanRecentRepos(excludePaths: Set<string>): Promise<RecentRepo[]> {
  if (!fs.existsSync(HISTORY_PATH)) return [];

  const content = fs.readFileSync(HISTORY_PATH, 'utf-8');
  const lines = content.split('\n');

  // Build map of project path -> most recent timestamp
  const projectMap = new Map<string, number>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { project?: string; timestamp?: number };
      if (!entry.project || !entry.timestamp) continue;
      const existing = projectMap.get(entry.project);
      if (!existing || entry.timestamp > existing) {
        projectMap.set(entry.project, entry.timestamp);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Sort by recency, filter, validate
  const candidates = Array.from(projectMap.entries())
    .sort((a, b) => b[1] - a[1])
    .filter(([p]) => !excludePaths.has(p))
    .filter(([p]) => {
      try {
        return fs.statSync(path.join(p, '.git')).isDirectory();
      } catch {
        return false;
      }
    })
    .slice(0, MAX_RESULTS);

  return Promise.all(
    candidates.map(async ([p, ts]) => ({
      path: p,
      name: path.basename(p),
      lastUsed: ts,
      ...(await getGitHubPath(p).then((g) => (g ? { githubPath: g } : {}))),
    })),
  );
}
