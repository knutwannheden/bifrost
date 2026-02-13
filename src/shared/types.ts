export type TaskStatus = 'running' | 'stopped' | 'error';

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

export const DEFAULT_CONFIG: BifrostConfig = {
  repos: [],
  ide: 'code',
  fontSize: 14,
};
