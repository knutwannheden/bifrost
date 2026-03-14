import type { ToolEvent, ToolCategory, TokenTimeline, TokenTurn } from "./types.js";
import path from "node:path";

/** Raw parsed JSONL entry */
export interface TranscriptEntry {
  type: "summary" | "system" | "user" | "assistant";
  message?: {
    content?: unknown;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  timestamp?: string;
  isCompactSummary?: boolean;
  isSidechain?: boolean;
  cwd?: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text: string }>;
  is_error?: boolean;
}

const NAVIGATION_TOOLS = new Set(["Read", "ListFiles", "SearchFiles", "Grep", "LS", "Glob"]);
const TEST_PATTERNS = /\b(jest|vitest|pytest|cargo\s+test|go\s+test|npm\s+test|npx\s+vitest|npx\s+jest|mvn\s+test|gradle\s+test|gw\s+test)\b/;
const WRITE_PATTERNS = /(?:sed\s+-i|tee\s|>\s|>>)/;

/**
 * Parse Claude Code JSONL transcript text into structured entries.
 * Skips compact summaries and malformed lines.
 */
export function parseClaudeTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      if (entry.isCompactSummary) continue;
      entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/**
 * Extract normalized tool events from parsed transcript entries.
 * Joins tool_use blocks (in assistant entries) with tool_result blocks (in user entries).
 */
export function extractToolEvents(entries: TranscriptEntry[]): ToolEvent[] {
  const events: ToolEvent[] = [];

  // Collect all tool_use blocks with their timestamps
  const pendingToolUses = new Map<
    string,
    { toolUse: ToolUseBlock; timestamp: string; cwd?: string }
  >();

  for (const entry of entries) {
    if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content as unknown[]) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") {
          pendingToolUses.set(b.id as string, {
            toolUse: b as unknown as ToolUseBlock,
            timestamp: entry.timestamp || "",
            cwd: entry.cwd,
          });
        }
      }
    }

    if (entry.type === "user" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content as unknown[]) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          const result = b as unknown as ToolResultBlock;
          const pending = pendingToolUses.get(result.tool_use_id);
          if (!pending) continue;

          const { toolUse, timestamp, cwd } = pending;
          const resultText = extractResultText(result.content);
          const category = categorizeTool(toolUse.name, toolUse.input);
          const filePath = extractFilePath(toolUse, cwd);
          const writtenContent = extractWrittenContent(toolUse);

          events.push({
            timestamp,
            toolName: toolUse.name,
            input: toolUse.input,
            resultText,
            isError: result.is_error === true,
            filePath,
            category,
            writtenContent,
          });

          pendingToolUses.delete(result.tool_use_id);
        }
      }
    }
  }

  return events;
}

/**
 * Extract token usage timeline from assistant entries.
 */
export function extractTokenTimeline(entries: TranscriptEntry[]): TokenTimeline {
  const turns: TokenTurn[] = [];

  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const usage = entry.message?.usage;
    if (!usage) continue;

    // inputTokens = full context fill for this turn (non-cached + cached)
    const inputTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);

    turns.push({
      timestamp: entry.timestamp || "",
      inputTokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    });
  }

  const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0);

  // Cost-weighted: approximate relative API cost
  // Non-cached input: 1x, cache creation: 1.25x, cache read: 0.1x, output: 5x
  const totalCostWeightedTokens = turns.reduce((s, t) => {
    const nonCached = t.inputTokens - t.cacheCreationTokens - t.cacheReadTokens;
    return s + nonCached + t.cacheCreationTokens * 1.25 + t.cacheReadTokens * 0.1 + t.outputTokens * 5;
  }, 0);

  return { turns, totalInputTokens, totalOutputTokens, totalCostWeightedTokens };
}

/**
 * Normalize a file path to repo-relative form.
 * If cwd is provided, uses path.relative. Otherwise, strips common prefixes.
 */
export function normalizePath(filePath: string, cwd?: string): string {
  if (cwd && path.isAbsolute(filePath)) {
    return path.relative(cwd, filePath);
  }

  // Strip common absolute prefixes: /Users/<user>/<project>/ or /home/<user>/<project>/
  let normalized = filePath.replace(/^\/(?:Users|home)\/[^/]+\/[^/]+\//, "");

  // Strip leading ./
  normalized = normalized.replace(/^\.\//, "");

  return normalized;
}

function extractResultText(content: string | Array<{ type: string; text: string }>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => b.text || "").join("");
  }
  return "";
}

function categorizeTool(name: string, input: Record<string, unknown>): ToolCategory {
  if (NAVIGATION_TOOLS.has(name)) return "navigation";

  if (name === "Write" || name === "Edit" || name === "MultiEdit") return "mutation";

  if (name === "Bash") {
    const cmd = (input.command as string) || "";
    if (TEST_PATTERNS.test(cmd)) return "test";
    if (WRITE_PATTERNS.test(cmd)) return "mutation";
    return "other";
  }

  return "other";
}

function extractFilePath(toolUse: ToolUseBlock, cwd?: string): string | undefined {
  const rawPath =
    (toolUse.input.file_path as string) ||
    (toolUse.input.path as string) ||
    undefined;

  if (!rawPath) return undefined;
  return normalizePath(rawPath, cwd);
}

function extractWrittenContent(toolUse: ToolUseBlock): string | undefined {
  switch (toolUse.name) {
    case "Write":
      return toolUse.input.content as string | undefined;
    case "Edit":
      return toolUse.input.new_string as string | undefined;
    case "MultiEdit": {
      const edits = toolUse.input.edits as Array<{ new_string: string }> | undefined;
      if (!edits) return undefined;
      return edits.map((e) => e.new_string).join("\n");
    }
    default:
      return undefined;
  }
}
