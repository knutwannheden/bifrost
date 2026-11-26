import fs from 'node:fs';
import path from 'node:path';
import { readEpicTemplates } from '../claude-plugin/mcp/epic-templates.mjs';
import type { CreateTaskParams } from '../shared/types.ts';
import { getPluginSourceDir } from './integration-installer.ts';

function epicPluginDir(): string {
  return process.env.BIFROST_PLUGIN_DIR ?? getPluginSourceDir();
}

export function listEpicTemplates() {
  return readEpicTemplates(epicPluginDir());
}

export function buildEpicPrompt(brief: NonNullable<CreateTaskParams['epic']>): string {
  const guide = fs.readFileSync(path.join(epicPluginDir(), 'skills', 'epic', 'workflow.md'), 'utf8').trim();
  return `# Goal\n\n${brief.goal}\n\n${guide}\n\n# Workflow template\n\n${brief.template}`;
}
