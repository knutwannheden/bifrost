import { describe, it, expect } from "vitest";
import { segmentSubTasks } from "../segmentation.js";
import type { ToolEvent, DiffSummary } from "../types.js";
import type { TranscriptEntry } from "../claude-parser.js";

function userExternal(content: string, timestamp = "2026-01-01T00:00:00Z"): TranscriptEntry {
  return { type: "user", userType: "external", message: { content }, timestamp } as TranscriptEntry & { userType: string };
}

function userExternalBlocks(text: string, timestamp = "2026-01-01T00:00:00Z"): TranscriptEntry {
  return { type: "user", userType: "external", message: { content: [{ type: "text", text }] }, timestamp } as TranscriptEntry & { userType: string };
}

function userToolResult(timestamp = "2026-01-01T00:00:01Z"): TranscriptEntry {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    timestamp,
  };
}

function assistant(timestamp = "2026-01-01T00:00:02Z", inputTokens = 1000): TranscriptEntry {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "response" }],
      usage: { input_tokens: inputTokens, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    timestamp,
  };
}

function toolEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    toolName: "Read",
    input: {},
    resultText: "",
    isError: false,
    category: "navigation",
    ...overrides,
  };
}

const diff: DiffSummary = {
  totalAdded: 10,
  totalRemoved: 5,
  files: [
    { path: "src/target.ts", linesAdded: 10, linesRemoved: 5, isNew: false, isDeleted: false, addedLines: [] },
  ],
};

describe("segmentSubTasks", () => {
  it("returns empty array for a single-prompt session", () => {
    const entries: TranscriptEntry[] = [
      userExternal("do the thing", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z"),
    ];
    const events = [
      toolEvent({ timestamp: "2026-01-01T00:00:30Z" }),
    ];
    const result = segmentSubTasks(entries, events, diff);
    expect(result).toHaveLength(0);
  });

  it("segments two sub-tasks at human prompt boundaries", () => {
    const entries: TranscriptEntry[] = [
      userExternal("first task", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z"),
      userToolResult("2026-01-01T00:01:30Z"),
      assistant("2026-01-01T00:02:00Z"),
      userExternal("second task", "2026-01-01T00:03:00Z"),
      assistant("2026-01-01T00:04:00Z"),
    ];
    const events = [
      toolEvent({ timestamp: "2026-01-01T00:01:00Z", filePath: "src/a.ts" }),
      toolEvent({ timestamp: "2026-01-01T00:02:00Z", filePath: "src/b.ts" }),
      toolEvent({ timestamp: "2026-01-01T00:04:00Z", filePath: "src/target.ts" }),
    ];
    const result = segmentSubTasks(entries, events, diff);
    expect(result).toHaveLength(2);
    expect(result[0].promptText).toBe("first task");
    expect(result[0].events).toHaveLength(2);
    expect(result[1].promptText).toBe("second task");
    expect(result[1].events).toHaveLength(1);
  });

  it("handles text blocks in user content (not just plain strings)", () => {
    const entries: TranscriptEntry[] = [
      userExternalBlocks("first", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z"),
      userExternalBlocks("second", "2026-01-01T00:02:00Z"),
      assistant("2026-01-01T00:03:00Z"),
    ];
    const events = [
      toolEvent({ timestamp: "2026-01-01T00:00:30Z" }),
      toolEvent({ timestamp: "2026-01-01T00:02:30Z" }),
    ];
    const result = segmentSubTasks(entries, events, diff);
    expect(result).toHaveLength(2);
    expect(result[0].promptText).toBe("first");
    expect(result[1].promptText).toBe("second");
  });

  it("does not treat tool_result user entries as sub-task boundaries", () => {
    const entries: TranscriptEntry[] = [
      userExternal("task", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z"),
      userToolResult("2026-01-01T00:01:30Z"),
      assistant("2026-01-01T00:02:00Z"),
    ];
    const events = [
      toolEvent({ timestamp: "2026-01-01T00:01:00Z" }),
      toolEvent({ timestamp: "2026-01-01T00:02:00Z" }),
    ];
    const result = segmentSubTasks(entries, events, diff);
    // Single prompt = no sub-task breakdown
    expect(result).toHaveLength(0);
  });

  it("computes per-sub-task metrics", () => {
    const entries: TranscriptEntry[] = [
      userExternal("explore", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z", 5000),
      assistant("2026-01-01T00:02:00Z", 8000),
      userExternal("now fix it", "2026-01-01T00:03:00Z"),
      assistant("2026-01-01T00:04:00Z", 10000),
    ];
    const events = [
      toolEvent({ timestamp: "2026-01-01T00:01:00Z", category: "navigation", filePath: "src/other.ts" }),
      toolEvent({ timestamp: "2026-01-01T00:02:00Z", category: "navigation", filePath: "src/foo.ts" }),
      toolEvent({ timestamp: "2026-01-01T00:04:00Z", category: "mutation", filePath: "src/target.ts", toolName: "Edit" }),
    ];
    const result = segmentSubTasks(entries, events, diff);
    expect(result).toHaveLength(2);

    // First sub-task: 2 navigation events, no mutations — targeting metrics are N/A
    expect(result[0].metrics.navigationOverhead).toBeNaN();
    expect(result[0].metrics.mutationDiscoveryWaste).toBe(0); // no mutations at all
    expect(result[0].tokenTimeline.turns).toHaveLength(2);

    // Second sub-task: 1 mutation to diff file
    expect(result[1].metrics.navigationOverhead).toBe(0);
    expect(result[1].metrics.mutationDiscoveryWaste).toBe(0);
    expect(result[1].tokenTimeline.turns).toHaveLength(1);
  });

  it("assigns token turns to correct sub-tasks by timestamp", () => {
    const entries: TranscriptEntry[] = [
      userExternal("first", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z", 3000),
      assistant("2026-01-01T00:02:00Z", 4000),
      userExternal("second", "2026-01-01T00:03:00Z"),
      assistant("2026-01-01T00:04:00Z", 5000),
      assistant("2026-01-01T00:05:00Z", 6000),
      assistant("2026-01-01T00:06:00Z", 7000),
    ];
    const result = segmentSubTasks(entries, [], diff);
    expect(result).toHaveLength(2);
    expect(result[0].tokenTimeline.totalInputTokens).toBe(7000); // 3000 + 4000
    expect(result[1].tokenTimeline.totalInputTokens).toBe(18000); // 5000 + 6000 + 7000
  });

  it("segments three sub-tasks correctly", () => {
    const entries: TranscriptEntry[] = [
      userExternal("task 1", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z"),
      userExternal("task 2", "2026-01-01T00:02:00Z"),
      assistant("2026-01-01T00:03:00Z"),
      userExternal("task 3", "2026-01-01T00:04:00Z"),
      assistant("2026-01-01T00:05:00Z"),
    ];
    const events = [
      toolEvent({ timestamp: "2026-01-01T00:01:00Z" }),
      toolEvent({ timestamp: "2026-01-01T00:03:00Z" }),
      toolEvent({ timestamp: "2026-01-01T00:05:00Z" }),
    ];
    const result = segmentSubTasks(entries, events, diff);
    expect(result).toHaveLength(3);
    expect(result[0].promptText).toBe("task 1");
    expect(result[1].promptText).toBe("task 2");
    expect(result[2].promptText).toBe("task 3");
    expect(result[0].events).toHaveLength(1);
    expect(result[1].events).toHaveLength(1);
    expect(result[2].events).toHaveLength(1);
  });

  it("ignores local command messages", () => {
    const entries: TranscriptEntry[] = [
      userExternal("task 1", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z"),
      { type: "user", userType: "external", message: { content: "<local-command-caveat>Caveat...</local-command-caveat>" }, timestamp: "2026-01-01T00:02:00Z" } as TranscriptEntry & { userType: string },
      { type: "user", userType: "external", message: { content: "<bash-input>npm test</bash-input>" }, timestamp: "2026-01-01T00:02:30Z" } as TranscriptEntry & { userType: string },
      { type: "user", userType: "external", message: { content: "<bash-stdout>ok</bash-stdout>" }, timestamp: "2026-01-01T00:02:45Z" } as TranscriptEntry & { userType: string },
      userExternal("task 2", "2026-01-01T00:03:00Z"),
      assistant("2026-01-01T00:04:00Z"),
    ];
    const result = segmentSubTasks(entries, [], diff);
    expect(result).toHaveLength(2);
    expect(result[0].promptText).toBe("task 1");
    expect(result[1].promptText).toBe("task 2");
  });

  it("ignores interrupt messages (Request interrupted by user)", () => {
    const entries: TranscriptEntry[] = [
      userExternal("task 1", "2026-01-01T00:00:00Z"),
      assistant("2026-01-01T00:01:00Z"),
      userExternalBlocks("[Request interrupted by user]", "2026-01-01T00:02:00Z"),
      userExternal("task 2", "2026-01-01T00:03:00Z"),
      assistant("2026-01-01T00:04:00Z"),
    ];
    const result = segmentSubTasks(entries, [], diff);
    expect(result).toHaveLength(2);
    expect(result[0].promptText).toBe("task 1");
    expect(result[1].promptText).toBe("task 2");
  });
});
