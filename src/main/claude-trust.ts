import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The config Claude Code reads, which CLAUDE_CONFIG_DIR moves out of the home directory. */
function claudeConfigPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), '.claude.json');
}

/** What Claude Code writes for a project it has not met, with trust granted. */
export const TRUSTED_ENTRY = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

/**
 * The directory Claude keys a workspace's trust under. For a git worktree that
 * is its main repository, for another checkout its top level, and outside git
 * the directory itself.
 */
function trustRoot(dir: string): string {
  const real = fs.realpathSync(dir);
  const git = (arg: string) =>
    execFileSync('git', ['-C', real, 'rev-parse', arg], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const common = path.resolve(real, git('--git-common-dir'));
    return fs.realpathSync(path.basename(common) === '.git' ? path.dirname(common) : git('--show-toplevel'));
  } catch {
    return real;
  }
}

/**
 * Grant the workspace a directory belongs to the trust Claude Code would
 * otherwise stop and ask for, under the key its own dialog writes on accept.
 * Trust on a directory above that key does not count. Answers whether it wrote.
 * A session that never sees the question is one an agent can drive unattended.
 */
export function trustDirectory(dir: string, configPath = claudeConfigPath()): boolean {
  let key: string;
  try {
    key = trustRoot(dir);
  } catch {
    return false;
  }

  let config: { projects?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    // Absent, or in a shape this cannot safely rewrite.
    return false;
  }

  const projects = config.projects ?? {};
  if (projects[key]?.hasTrustDialogAccepted === true) return false;
  config.projects = { ...projects, [key]: { ...TRUSTED_ENTRY, ...projects[key], hasTrustDialogAccepted: true } };

  // Claude Code rewrites this file whole and often. Renaming into place keeps a
  // collision to a lost update rather than a truncated config.
  const tmp = `${configPath}.bifrost-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmp, configPath);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing left to clean up */
    }
    return false;
  }
}
