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
  /** Claude Code session ID (JSONL filename) for resume */
  claudeSessionId?: string;
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

export const DEFAULT_CONFIG: BifrostConfig = {
  repos: [],
  ide: 'code',
  fontSize: 14,
};
