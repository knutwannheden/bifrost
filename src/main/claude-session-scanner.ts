import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeSession } from '../shared/types';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

export function scanClaudeSessions(excludePaths: Set<string>, projectsDir = CLAUDE_PROJECTS_DIR): ClaudeSession[] {
  if (!fs.existsSync(projectsDir)) return [];

  const now = Date.now();
  const sessions: ClaudeSession[] = [];
  const seenSessionIds = new Set<string>();

  try {
    const projectDirs = fs.readdirSync(projectsDir);

    for (const dirName of projectDirs) {
      const dirPath = path.join(projectsDir, dirName);

      let files: string[];
      try {
        files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        let fileStat: fs.Stats;
        try {
          fileStat = fs.statSync(filePath);
        } catch {
          continue;
        }

        // Skip old sessions
        if (now - fileStat.mtimeMs > MAX_AGE_MS) continue;

        // The transcript records its own cwd. Claude's directory names encode a
        // path with / → -, which a repo name containing a dash makes ambiguous.
        const info = parseSessionInfo(filePath);
        if (!info) continue;

        // Skip paths that belong to Bifrost tasks
        if (excludePaths.has(info.cwd)) continue;
        if (!fs.existsSync(info.cwd)) continue;

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
