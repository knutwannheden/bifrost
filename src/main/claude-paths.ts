import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code's own directory, which is ~/.claude unless CLAUDE_CONFIG_DIR moves it. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/** Bifrost's CLAUDE_CONFIG_DIR relative to home, or null when it is unset or lies outside home. */
export function claudeConfigRelative(): string | null {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return null;
  const relative = path.relative(os.homedir(), path.resolve(dir));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : null;
}

let warnedOutsideHome = false;

/**
 * The config dir a session uses on the machine whose home is `home`. It is
 * Bifrost's own, at the same path relative to home. Undefined means Claude's default.
 */
export function claudeConfigDirAt(home: string): string | undefined {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return undefined;
  const relative = claudeConfigRelative();
  if (relative !== null) return path.posix.join(home, relative);
  if (home === os.homedir()) return dir;
  if (!warnedOutsideHome) {
    warnedOutsideHome = true;
    console.warn(`[claude] ${dir} lies outside home, so sessions on other machines use Claude's default`);
  }
  return undefined;
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
