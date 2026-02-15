import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ClaudeSession } from '../shared/types';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function decodeProjectPath(dirName: string): string {
  // Claude encodes paths: leading / removed, remaining / → -
  // e.g. "-Users-knut-git-foo" → "/Users/knut/git/foo"
  // The leading dash represents the root /
  //
  // Ambiguity: dashes in directory names (e.g. "moderne-ast-write") are
  // indistinguishable from path separators.  We resolve this by greedily
  // matching the longest existing path segments from left to right.
  const parts = dirName.replace(/^-/, '').split('-');
  let resolved = '';
  let i = 0;
  while (i < parts.length) {
    // Try progressively longer dash-joined segments, keeping the longest match.
    // Don't stop on first failure — "moderne-ast" may not exist while
    // "moderne-ast-write" does.
    let best = parts[i];
    let bestLen = 1;
    for (let j = i + 1; j < parts.length; j++) {
      const candidate = parts.slice(i, j + 1).join('-');
      const testPath = resolved + '/' + candidate;
      try {
        fs.statSync(testPath);
        best = candidate;
        bestLen = j - i + 1;
      } catch {
        // keep trying longer segments
      }
    }
    resolved += '/' + best;
    i += bestLen;
  }
  return resolved;
}

function parseSessionInfo(filePath: string): { sessionId: string; cwd: string; slug?: string } | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (bytesRead === 0) return null;

    // Scan the first few lines — the session metadata line with sessionId/cwd
    // may not be the first line (e.g. file-history-snapshot can come first).
    const text = buf.toString('utf-8', 0, bytesRead);
    for (const line of text.split('\n').slice(0, 10)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.sessionId && parsed.cwd) {
          return { sessionId: parsed.sessionId, cwd: parsed.cwd, slug: parsed.slug };
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // ignore read errors
  }
  return null;
}

export function scanClaudeSessions(excludePaths: Set<string>): ClaudeSession[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const now = Date.now();
  const sessions: ClaudeSession[] = [];
  const seenSessionIds = new Set<string>();

  try {
    const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);

    for (const dirName of projectDirs) {
      const projectPath = decodeProjectPath(dirName);

      // Skip paths that belong to Bifrost tasks
      if (excludePaths.has(projectPath)) continue;

      // Skip if the directory no longer exists
      if (!fs.existsSync(projectPath)) continue;

      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
      let stat;
      try {
        stat = fs.statSync(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      // Find JSONL files in this project dir
      let files;
      try {
        files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        let fileStat;
        try {
          fileStat = fs.statSync(filePath);
        } catch {
          continue;
        }

        // Skip old sessions
        if (now - fileStat.mtimeMs > MAX_AGE_MS) continue;

        const info = parseSessionInfo(filePath);
        if (!info) continue;

        // Deduplicate by sessionId (a session may span multiple JSONL files)
        if (seenSessionIds.has(info.sessionId)) continue;
        seenSessionIds.add(info.sessionId);

        sessions.push({
          sessionId: info.sessionId,
          cwd: info.cwd,
          projectDirName: dirName,
          slug: info.slug,
          lastModified: fileStat.mtimeMs,
        });
      }
    }
  } catch {
    // Best effort
  }

  // Sort most recent first
  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}
