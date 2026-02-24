import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import type { StatsData, SkillUsageEntry, ToolUsageEntry, BashCommandEntry } from '../shared/types';

function sortedEntries<T extends { count: number }>(counts: Map<string, number>, keyName: string): T[] {
  const entries: T[] = [];
  for (const [key, count] of counts) {
    entries.push({ [keyName]: key, count } as T);
  }
  entries.sort((a, b) => b.count - a.count);
  return entries;
}

function buildStatsData(
  skillCounts: Map<string, number>,
  toolCounts: Map<string, number>,
  bashCounts: Map<string, number>,
): StatsData {
  return {
    skillUsage: sortedEntries<SkillUsageEntry>(skillCounts, 'skill'),
    toolUsage: sortedEntries<ToolUsageEntry>(toolCounts, 'tool'),
    bashCommands: sortedEntries<BashCommandEntry>(bashCounts, 'command'),
  };
}

/**
 * Scan all Claude Code JSONL session files under ~/.claude/projects/
 * and collect tool usage stats. Calls onUpdate after each project
 * directory with the current aggregated snapshot.
 */
export async function getStats(onUpdate: (data: StatsData) => void): Promise<void> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return;

  const skillCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const bashCounts = new Map<string, number>();

  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(projectsDir, d.name));
  } catch {
    return;
  }

  let prevTotal = 0;

  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      await scanJsonlFile(path.join(dir, file), skillCounts, toolCounts, bashCounts);
    }

    const newTotal = totalCount(toolCounts);
    if (newTotal !== prevTotal) {
      prevTotal = newTotal;
      onUpdate(buildStatsData(skillCounts, toolCounts, bashCounts));
    }
  }
}

function totalCount(counts: Map<string, number>): number {
  let sum = 0;
  for (const v of counts.values()) sum += v;
  return sum;
}

/** Normalize a bash command for aggregation: first line, trimmed to 80 chars. */
function normalizeBashCommand(command: string): string {
  const firstLine = command.split('\n')[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
}

async function scanJsonlFile(
  filePath: string,
  skillCounts: Map<string, number>,
  toolCounts: Map<string, number>,
  bashCounts: Map<string, number>,
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.includes('"tool_use"')) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== 'assistant') continue;
    const message = parsed.message as { content?: unknown[] } | undefined;
    if (!message?.content || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use') continue;

      const name = b.name as string | undefined;
      if (!name) continue;

      // Tool usage
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);

      // Skill usage
      if (name === 'Skill') {
        const input = b.input as { skill?: string } | undefined;
        if (input?.skill) {
          skillCounts.set(input.skill, (skillCounts.get(input.skill) ?? 0) + 1);
        }
      }

      // Bash commands
      if (name === 'Bash') {
        const input = b.input as { command?: string } | undefined;
        if (input?.command) {
          const normalized = normalizeBashCommand(input.command);
          bashCounts.set(normalized, (bashCounts.get(normalized) ?? 0) + 1);
        }
      }
    }
  }
}
