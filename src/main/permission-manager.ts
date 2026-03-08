import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionDecision, PermissionPromptData, RuleOption } from '../shared/types';

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
 * Extract the relevant input value for pattern matching based on tool type.
 */
function getToolInputValue(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === 'Bash') {
    return (toolInput.command as string) || null;
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
    return (toolInput.file_path as string) || (toolInput.filePath as string) || null;
  }
  return null;
}

/**
 * Check if a single rule pattern matches a tool call.
 *
 * Pattern formats:
 *  - "ToolName"             → matches all uses of that tool
 *  - "ToolName(exact)"      → matches if the tool's primary input equals exact
 *  - "ToolName(prefix:*)"   → matches if the tool's primary input starts with prefix
 *  - "prefix*"  (no parens) → matches if toolName starts with prefix (e.g. mcp__server__*)
 */
function matchesPattern(pattern: string, toolName: string, toolInput: Record<string, unknown>): boolean {
  // Exact tool name match (e.g. "Bash" matches all Bash calls)
  if (pattern === toolName) return true;

  // Wildcard suffix on tool name (e.g. "mcp__server__*")
  if (pattern.endsWith('*') && !pattern.includes('(')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  // Parameterized: ToolName(value) or ToolName(prefix:*)
  const parenIdx = pattern.indexOf('(');
  if (parenIdx > 0 && pattern.endsWith(')')) {
    const patternTool = pattern.slice(0, parenIdx);
    if (patternTool !== toolName) return false;

    const paramValue = pattern.slice(parenIdx + 1, -1);
    const inputValue = getToolInputValue(toolName, toolInput);
    if (!inputValue) return false;

    if (paramValue.endsWith(':*')) {
      const prefix = paramValue.slice(0, -2);
      return inputValue.startsWith(prefix);
    }

    return inputValue === paramValue;
  }

  return false;
}

/**
 * Read allow/deny rule arrays from a Claude Code settings file.
 */
function readSettingsRules(settingsPath: string): { allow: string[]; deny: string[] } {
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);
    return {
      allow: Array.isArray(settings.allow) ? settings.allow : [],
      deny: Array.isArray(settings.deny) ? settings.deny : [],
    };
  } catch {
    return { allow: [], deny: [] };
  }
}

/**
 * Check existing allow/deny rules across all settings scopes for a task.
 * Returns 'allow' or 'deny' if a rule matches, or null if no rule applies.
 * Deny rules take precedence over allow rules.
 */
export function checkExistingRules(
  worktreePath: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): 'allow' | 'deny' | null {
  const settingsFiles = [
    path.join(worktreePath, '.claude', 'settings.local.json'),
    path.join(worktreePath, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];

  const allAllow: string[] = [];
  const allDeny: string[] = [];

  for (const file of settingsFiles) {
    const rules = readSettingsRules(file);
    allAllow.push(...rules.allow);
    allDeny.push(...rules.deny);
  }

  // Deny takes precedence
  for (const pattern of allDeny) {
    if (matchesPattern(pattern, toolName, toolInput)) return 'deny';
  }

  for (const pattern of allAllow) {
    if (matchesPattern(pattern, toolName, toolInput)) return 'allow';
  }

  return null;
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
        const dirWithSlash = dir.endsWith('/') ? dir : `${dir}/`;
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
      hookEventName: 'PreToolUse',
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

  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
