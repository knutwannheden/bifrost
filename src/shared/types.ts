export type TaskStatus = 'running' | 'stopped' | 'error' | 'archived';

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
}

export interface Task {
  id: string;
  name: string;
  repoId: string;
  branch: string;
  worktreePath: string;
  sessionId: string;
  status: TaskStatus;
  hasUnread: boolean;
  createdAt: number;
  archivedAt?: number;
  /** Last known terminal title (from OSC 0/2) */
  terminalTitle?: string;
}

export interface BifrostConfig {
  repos: Repo[];
  ide: 'code' | 'idea';
  fontSize: number;
}

export interface CreateTaskParams {
  repoId: string;
  name: string;
  branch: string;
}

export interface AddRepoParams {
  type: 'local' | 'clone';
  path?: string;
  url?: string;
}

export interface DiffResult {
  worktreePath: string;
  diff: string;
}

export type ClaudeEventKind = 'user_message' | 'assistant_text' | 'tool_use' | 'tool_result';

export interface ActivityEntry {
  id: string;
  taskId: string;
  timestamp: number;
  type: 'file_change' | 'commit' | 'claude_event';
  filePath?: string;
  diff?: string;
  commitSha?: string;
  commitMessage?: string;
  // Claude event fields
  claudeEventKind?: ClaudeEventKind;
  claudeText?: string;
  claudeToolName?: string;
}

// Context capture types

export interface ContextBase {
  id: number;
  type: string;
  taskId: string;
  taskName: string;
  capturedAt: number;
}

export interface TerminalContext extends ContextBase {
  type: 'terminal';
  content: string;
  hasSelection: boolean;
}

export interface DiffContext extends ContextBase {
  type: 'diff';
  content: string;
}

export interface ActivityContext extends ContextBase {
  type: 'activity';
  content: string;
}

export interface TranscriptContext extends ContextBase {
  type: 'transcript';
  /** Captured terminal text — always stored as fallback */
  content: string;
  jsonlPath: string;
  lineNumber: number;
  uuid: string;
  selectedText?: string;
  selectionStart?: number;
  selectionEnd?: number;
  /** Populated at resolve time from the JSONL file */
  resolvedContent?: string;
}

export type ContextEntry = TerminalContext | DiffContext | ActivityContext | TranscriptContext;

export type CaptureContextParams =
  | { type: 'terminal'; content: string; hasSelection: boolean; taskId: string; taskName: string }
  | { type: 'diff'; content: string; taskId: string; taskName: string }
  | { type: 'activity'; content: string; taskId: string; taskName: string }
  | { type: 'transcript'; content: string; jsonlPath: string; lineNumber: number; uuid: string; selectedText?: string; selectionStart?: number; selectionEnd?: number; taskId: string; taskName: string };

export const DEFAULT_CONFIG: BifrostConfig = {
  repos: [],
  ide: 'code',
  fontSize: 14,
};
