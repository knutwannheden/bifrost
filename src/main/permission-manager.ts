import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PermissionPromptData, PermissionDecision, RuleOption } from '../shared/types';

const REQUEST_TIMEOUT_MS = 120_000;

interface PendingRequest {
  taskId: string;
  resolve: (value: Record<string, unknown>) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

let worktreePathResolver: ((taskId: string) => string) | null = null;

/**
 * Set the resolver function for looking up worktree paths by task ID.
 * This avoids a circular dependency with ipc-handlers.
 */
export function setWorktreePathResolver(resolver: (taskId: string) => string): void {
  worktreePathResolver = resolver;
}

/**
 * Compute pre-set rule options for a given tool name and input.
 */
export function computeRuleOptions(toolName: string, toolInput: Record<string, unknown>): RuleOption[] {
  const options: RuleOption[] = [];

  if (toolName === 'Bash') {
    const command = (toolInput.command as string) || '';
    const firstWord = command.split(/\s+/)[0] || '';

    if (command) {
      options.push({ label: `Allow this exact command`, pattern: `Bash(${command})` });
    }
    if (firstWord) {
      options.push({ label: `Allow all ${firstWord} commands`, pattern: `Bash(${firstWord}:*)` });
    }
    options.push({ label: 'Allow all Bash', pattern: 'Bash' });
  } else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
    const filePath = (toolInput.file_path as string) || (toolInput.filePath as string) || '';

    if (filePath) {
      options.push({ label: `Allow for this file`, pattern: `${toolName}(${filePath})` });
      const dir = path.dirname(filePath);
      if (dir && dir !== '.') {
        const dirWithSlash = dir.endsWith('/') ? dir : dir + '/';
        options.push({ label: `Allow in ${dirWithSlash}`, pattern: `${toolName}(${dirWithSlash}:*)` });
      }
    }
    options.push({ label: `Allow all ${toolName}`, pattern: toolName });
  } else if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    options.push({ label: `Allow this MCP tool`, pattern: toolName });
    if (parts.length >= 3) {
      const server = parts[1];
      options.push({ label: `Allow all ${server} tools`, pattern: `mcp__${server}__*` });
    }
  } else {
    options.push({ label: `Allow ${toolName}`, pattern: toolName });
  }

  return options;
}

/**
 * Create a pending permission request.
 * Returns the prompt data to send to the renderer and a promise that resolves
 * when the request is resolved, cancelled, or times out.
 */
export function createRequest(
  taskId: string,
  taskName: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): { promptData: PermissionPromptData; response: Promise<Record<string, unknown>> } {
  const requestId = randomUUID();
  const ruleOptions = computeRuleOptions(toolName, toolInput);

  const promptData: PermissionPromptData = {
    requestId,
    taskId,
    taskName,
    toolName,
    toolInput,
    ruleOptions,
  };

  let resolvePromise: (value: Record<string, unknown>) => void;
  const response = new Promise<Record<string, unknown>>((resolve) => {
    resolvePromise = resolve;
  });

  const timeout = setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      pendingRequests.delete(requestId);
      // Empty object = fallback to Claude default
      resolvePromise!({});
    }
  }, REQUEST_TIMEOUT_MS);

  pendingRequests.set(requestId, {
    taskId,
    resolve: resolvePromise!,
    timeout,
  });

  return { promptData, response };
}

/**
 * Resolve a pending permission request with a user decision.
 */
export function resolveRequest(requestId: string, decision: PermissionDecision): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingRequests.delete(requestId);

  // Persist rule if requested
  if (decision.persist && decision.rulePattern && decision.scope) {
    writeRule(decision.action, decision.rulePattern, decision.scope, pending.taskId);
  }

  pending.resolve({
    hookSpecificOutput: {
      permissionDecision: decision.action,
    },
  });
}

/**
 * Cancel all pending requests for a task (e.g. when task is stopped or archived).
 * Resolves each with an empty object so Claude falls back to its default behavior.
 */
export function cancelTaskRequests(taskId: string): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.taskId === taskId) {
      clearTimeout(pending.timeout);
      pending.resolve({});
      pendingRequests.delete(requestId);
    }
  }
}

/**
 * Write a permission rule to the appropriate Claude settings file.
 */
function writeRule(
  action: 'allow' | 'deny',
  pattern: string,
  scope: 'local' | 'project' | 'user',
  taskId: string,
): void {
  let settingsPath: string;

  if (scope === 'user') {
    settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  } else if (worktreePathResolver) {
    const worktreePath = worktreePathResolver(taskId);
    if (scope === 'local') {
      settingsPath = path.join(worktreePath, '.claude', 'settings.local.json');
    } else {
      // project
      settingsPath = path.join(worktreePath, '.claude', 'settings.json');
    }
  } else {
    console.error('permission-manager: worktreePathResolver not set, cannot write rule');
    return;
  }

  // Read existing settings or start fresh
  let settings: Record<string, unknown> = {};
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(content);
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      settings = {};
    }
  } catch {
    // File missing or corrupt — start fresh
  }

  const key = action === 'allow' ? 'allow' : 'deny';
  let list = settings[key];
  if (!Array.isArray(list)) {
    list = [];
  }

  // Deduplicate
  if (!(list as string[]).includes(pattern)) {
    (list as string[]).push(pattern);
  }

  settings[key] = list;

  // Ensure directory exists
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
