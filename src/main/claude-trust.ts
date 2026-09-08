import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json');

/** What Claude Code writes for a project it has not met, with trust granted. */
const TRUSTED_ENTRY = {
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
 * Grant a directory the workspace trust Claude Code would otherwise stop and
 * ask for, by writing the key its own dialog writes on accept. Answers whether
 * it wrote, which is once per directory: a session that never sees the prompt
 * is one an agent can drive unattended.
 */
export function trustDirectory(dir: string, configPath = CLAUDE_CONFIG): boolean {
  // Claude looks a project up under the path it resolved, so a directory
  // reached through a symlink is not the key it will read.
  let key: string;
  try {
    key = fs.realpathSync(dir);
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
