import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import type { StatsData, SkillUsageEntry, ToolUsageEntry, BashCommandEntry, ContextRotEntry, EscalationEntry } from '../shared/types';

function sortedEntries<T extends { count: number }>(counts: Map<string, number>, keyName: string): T[] {
  const entries: T[] = [];
  for (const [key, count] of counts) {
    entries.push({ [keyName]: key, count } as T);
  }
  entries.sort((a, b) => b.count - a.count);
  return entries;
}

interface RotAccum { count: number; totalBytes: number }
interface EscalationAccum { clusters: number; wastedRuns: number; worstCluster: number }

function buildStatsData(
  skillCounts: Map<string, number>,
  toolCounts: Map<string, number>,
  bashCounts: Map<string, number>,
  rotByKey: Map<string, RotAccum>,
  escalationByCmd: Map<string, EscalationAccum>,
): StatsData {
  const contextRot: ContextRotEntry[] = [];
  for (const [name, { count, totalBytes }] of rotByKey) {
    contextRot.push({ name, count, totalBytes, avgBytes: Math.round(totalBytes / count) });
  }
  contextRot.sort((a, b) => b.totalBytes - a.totalBytes);

  const tailEscalation: EscalationEntry[] = [];
  for (const [command, { clusters, wastedRuns, worstCluster }] of escalationByCmd) {
    tailEscalation.push({ command, clusters, wastedRuns, worstCluster });
  }
  tailEscalation.sort((a, b) => b.wastedRuns - a.wastedRuns);

  return {
    skillUsage: sortedEntries<SkillUsageEntry>(skillCounts, 'skill'),
    toolUsage: sortedEntries<ToolUsageEntry>(toolCounts, 'tool'),
    bashCommands: sortedEntries<BashCommandEntry>(bashCounts, 'command'),
    contextRot,
    tailEscalation,
  };
}

// Generation counter — incremented on each getStats call so stale scans stop emitting.
let currentGeneration = 0;

/**
 * Scan all Claude Code JSONL session files under ~/.claude/projects/
 * and collect tool usage stats. Calls onUpdate after each project
 * directory with the current aggregated snapshot.
 * @param since Only count entries with timestamp >= this value (epoch ms). 0 = all time.
 */
export async function getStats(onUpdate: (data: StatsData) => void, since = 0): Promise<void> {
  const generation = ++currentGeneration;

  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return;

  const skillCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const bashCounts = new Map<string, number>();
  const rotByKey = new Map<string, RotAccum>();
  const escalationByCmd = new Map<string, EscalationAccum>();

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
    if (generation !== currentGeneration) return;

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      if (generation !== currentGeneration) return;
      const filePath = path.join(dir, file);
      // Skip files last modified before the time range (they can't contain newer entries)
      if (since > 0) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < since) continue;
        } catch { continue; }
      }
      await scanJsonlFile(filePath, skillCounts, toolCounts, bashCounts, rotByKey, escalationByCmd, since);
    }

    if (generation !== currentGeneration) return;
    const newTotal = totalCount(toolCounts);
    if (newTotal !== prevTotal) {
      prevTotal = newTotal;
      onUpdate(buildStatsData(skillCounts, toolCounts, bashCounts, rotByKey, escalationByCmd));
    }
  }

  // Always emit a final update so the UI shows the (possibly empty) result
  if (generation === currentGeneration) {
    onUpdate(buildStatsData(skillCounts, toolCounts, bashCounts, rotByKey, escalationByCmd));
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

/** Strip trailing observation-only suffixes to get the base command for clustering. */
function extractBaseCommand(command: string): string | undefined {
  let base = command.trim();
  // Strip "cd <path> && " or "cd <path> ; " prefix — just navigation
  base = base.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '');
  // Strip trailing pipe stages (tail, head, grep, etc.) from end of full command
  const pipeRe = /\s*\|\s*(?:tail|head|grep|awk|sed|wc|cut|sort|uniq|tee|tac)\b[^|]*$/;
  while (pipeRe.test(base)) base = base.replace(pipeRe, '');
  base = base.replace(/\s+2>&1\s*$/, '').trim();
  base = base.replace(/\s+--(quiet|info)\b/g, '').trim();
  // Shorten home dir for readability
  const home = os.homedir();
  if (home) base = base.replaceAll(home, '~');
  if (base.length < 5) return undefined;
  return base;
}

/** Measure the character length of a tool_result content field. */
function measureContent(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') total += (b.text as string).length;
    }
    return total;
  }
  return 0;
}

function accumulateRot(rotByKey: Map<string, RotAccum>, key: string, bytes: number): void {
  const existing = rotByKey.get(key);
  if (existing) {
    existing.count++;
    existing.totalBytes += bytes;
  } else {
    rotByKey.set(key, { count: 1, totalBytes: bytes });
  }
}

/**
 * Walk a per-file call sequence and detect back-to-back runs of the same
 * Bash command with no intervening Edit/Write. Accumulates into the global map.
 */
function detectEscalation(
  callSequence: { toolName: string; baseCommand?: string }[],
  escalationByCmd: Map<string, EscalationAccum>,
): void {
  let lastEditIndex = -1;
  const cmdState = new Map<string, { lastRunIndex: number; clusterSize: number }>();

  function finalizeCluster(cmd: string, size: number) {
    if (size >= 2) {
      const acc = escalationByCmd.get(cmd) ?? { clusters: 0, wastedRuns: 0, worstCluster: 0 };
      acc.clusters++;
      acc.wastedRuns += size - 1;
      acc.worstCluster = Math.max(acc.worstCluster, size);
      escalationByCmd.set(cmd, acc);
    }
  }

  for (let i = 0; i < callSequence.length; i++) {
    const entry = callSequence[i];

    if (entry.toolName === 'Edit' || entry.toolName === 'Write' || entry.toolName === 'NotebookEdit') {
      lastEditIndex = i;
      for (const [cmd, state] of cmdState) {
        finalizeCluster(cmd, state.clusterSize);
      }
      cmdState.clear();
      continue;
    }

    if (entry.baseCommand) {
      const state = cmdState.get(entry.baseCommand);
      if (state && lastEditIndex <= state.lastRunIndex) {
        // No edit since last run of this command — extend cluster
        state.clusterSize++;
        state.lastRunIndex = i;
      } else {
        // First run since an edit (or first ever)
        if (state) finalizeCluster(entry.baseCommand, state.clusterSize);
        cmdState.set(entry.baseCommand, { lastRunIndex: i, clusterSize: 1 });
      }
    }
  }

  // Finalize remaining clusters at end of file
  for (const [cmd, state] of cmdState) {
    finalizeCluster(cmd, state.clusterSize);
  }
}

async function scanJsonlFile(
  filePath: string,
  skillCounts: Map<string, number>,
  toolCounts: Map<string, number>,
  bashCounts: Map<string, number>,
  rotByKey: Map<string, RotAccum>,
  escalationByCmd: Map<string, EscalationAccum>,
  since = 0,
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // Per-file state: map tool_use id → tool info for context rot matching
  const toolUseMap = new Map<string, { toolName: string; bashKey?: string }>();
  // Per-file call sequence for escalation detection
  const callSequence: { toolName: string; baseCommand?: string }[] = [];

  for await (const line of rl) {
    const hasToolUse = line.includes('"tool_use"');
    const hasToolResult = line.includes('"tool_result"');
    if (!hasToolUse && !hasToolResult) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (since > 0 && typeof parsed.timestamp === 'string') {
      const ts = new Date(parsed.timestamp).getTime();
      if (ts < since) continue;
    }

    const message = parsed.message as { content?: unknown[] } | undefined;
    if (!message?.content || !Array.isArray(message.content)) continue;

    // Assistant messages: extract tool_use blocks
    if (parsed.type === 'assistant' && hasToolUse) {
      for (const block of message.content) {
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_use') continue;

        const name = b.name as string | undefined;
        if (!name) continue;

        // Tool usage counts
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);

        // Skill usage
        if (name === 'Skill') {
          const input = b.input as { skill?: string } | undefined;
          if (input?.skill) {
            skillCounts.set(input.skill, (skillCounts.get(input.skill) ?? 0) + 1);
          }
        }

        // Bash commands
        let bashKey: string | undefined;
        let baseCommand: string | undefined;
        if (name === 'Bash') {
          const input = b.input as { command?: string } | undefined;
          if (input?.command) {
            const normalized = normalizeBashCommand(input.command);
            bashCounts.set(normalized, (bashCounts.get(normalized) ?? 0) + 1);
            // Use full command (home-shortened) for context rot — no truncation
            const home = os.homedir();
            let fullCmd = input.command.trim();
            if (home) fullCmd = fullCmd.replaceAll(home, '~');
            bashKey = 'Bash: ' + fullCmd;
            baseCommand = extractBaseCommand(input.command);
          }
        }

        // Record for context rot matching
        const id = b.id as string | undefined;
        if (id) {
          toolUseMap.set(id, { toolName: name, bashKey });
        }

        // Record for escalation detection
        callSequence.push({ toolName: name, baseCommand });
      }
    }

    // User messages: extract tool_result blocks for context rot
    if (parsed.type === 'user' && hasToolResult) {
      for (const block of message.content) {
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;

        const toolUseId = b.tool_use_id as string | undefined;
        if (!toolUseId) continue;

        const info = toolUseMap.get(toolUseId);
        if (!info) continue;

        const bytes = measureContent(b.content);
        if (bytes === 0) continue;

        // Accumulate by tool name
        accumulateRot(rotByKey, info.toolName, bytes);

        // Also accumulate by specific bash command if applicable
        if (info.bashKey) {
          accumulateRot(rotByKey, info.bashKey, bytes);
        }
      }
    }
  }

  // Detect escalation patterns for this file
  detectEscalation(callSequence, escalationByCmd);
}
