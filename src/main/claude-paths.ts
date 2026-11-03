import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code's own directory, which is ~/.claude unless CLAUDE_CONFIG_DIR moves it. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/** The name of the directory Claude files a session's transcripts under, made from the session's working directory. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Where Claude files the transcripts of the sessions it runs in cwd. */
export function transcriptDir(cwd: string): string {
  return path.join(claudeConfigDir(), 'projects', claudeProjectDir(cwd));
}

/** Whether Claude has no transcript of the session left that it could resume. */
export function isSessionStale(worktreePath: string, sessionId?: string): boolean {
  const projectPath = transcriptDir(worktreePath);
  if (!fs.existsSync(projectPath)) {
    return true;
  }
  if (sessionId) {
    const sessionFilePath = path.join(projectPath, `${sessionId}.jsonl`);
    try {
      const stat = fs.statSync(sessionFilePath);
      // Files under 4 KB typically contain only metadata (file-history-snapshot,
      // progress entries) with no actual conversation — Claude cannot resume these.
      return stat.size < 4096;
    } catch {
      return true;
    }
  }
  return false;
}
