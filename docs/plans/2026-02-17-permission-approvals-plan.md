# Permission Approvals Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the global permission mode with an interactive PreToolUse hook that routes approval prompts to a floating Electron UI panel, persisting rules to Claude Code settings files.

**Architecture:** A PreToolUse command hook posts to Bifrost's HTTP API, which holds the connection while the renderer shows a floating panel. User decisions are sent back via IPC, persisted to `.claude/settings*.json`, and returned as hook output.

**Tech Stack:** TypeScript, Electron IPC, React, Tailwind CSS, Node HTTP server, Bash (hook script)

---

### Task 1: Shared Types & IPC Channels

**Files:**
- Modify: `src/shared/types.ts` (append after line 186)
- Modify: `src/shared/ipc-channels.ts` (add channels + API methods)

**Step 1: Add permission types to `src/shared/types.ts`**

Add after the `DEFAULT_CONFIG` export at line 186:

```typescript
// Permission approval types

export interface RuleOption {
  label: string;
  pattern: string;
}

export interface PermissionPromptData {
  requestId: string;
  taskId: string;
  taskName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  ruleOptions: RuleOption[];
}

export interface PermissionDecision {
  action: 'allow' | 'deny';
  persist: boolean;
  scope?: 'local' | 'project' | 'user';
  rulePattern?: string;
}
```

**Step 2: Add IPC channels to `src/shared/ipc-channels.ts`**

Add to the `IPC` object (after the `CHECK_GH_AVAILABLE` line ~99):

```typescript
  // Permission
  RESOLVE_PERMISSION: 'permission:resolve',
```

Add to `IPC_STREAM` object (after `HOOK_NOTIFICATION` line ~110):

```typescript
  PERMISSION_PROMPT: 'permission:prompt',
```

**Step 3: Add BifrostAPI methods to `src/shared/ipc-channels.ts`**

Add to the `BifrostAPI` interface, after the `onHookNotification` method block (~line 208):

```typescript
  // Permission prompts
  onPermissionPrompt(callback: (request: PermissionPromptData) => void): () => void;
  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>;
```

Add `PermissionPromptData` and `PermissionDecision` to the type imports at line 1.

**Step 4: Verify the project compiles**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```
git add src/shared/types.ts src/shared/ipc-channels.ts
git commit -m "Add permission approval types and IPC channels"
```

---

### Task 2: Preload Bridge

**Files:**
- Modify: `src/preload/preload.ts` (add two new API methods)

**Step 1: Add `onPermissionPrompt` method**

Add after the `onHookNotification` block (after line 132):

```typescript
  // Permission prompts
  onPermissionPrompt: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, request: import('../shared/types').PermissionPromptData) =>
      callback(request);
    ipcRenderer.on(IPC_STREAM.PERMISSION_PROMPT, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.PERMISSION_PROMPT, handler);
  },
  resolvePermission: (requestId, decision) =>
    ipcRenderer.invoke(IPC.RESOLVE_PERMISSION, requestId, decision),
```

**Step 2: Verify the project compiles**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```
git add src/preload/preload.ts
git commit -m "Expose permission prompt IPC in preload bridge"
```

---

### Task 3: Permission Manager (Main Process)

**Files:**
- Create: `src/main/permission-manager.ts`

**Step 1: Create the permission manager module**

Create `src/main/permission-manager.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PermissionPromptData, PermissionDecision, RuleOption } from '../shared/types';

const TIMEOUT_MS = 120_000;

interface PendingRequest {
  requestId: string;
  taskId: string;
  taskName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  ruleOptions: RuleOption[];
  resolve: (response: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();

/**
 * Compute pre-set rule options for a given tool name and input.
 * Returns 2-3 options from most specific to most general.
 */
export function computeRuleOptions(toolName: string, toolInput: Record<string, unknown>): RuleOption[] {
  const options: RuleOption[] = [];

  if (toolName === 'Bash') {
    const command = (toolInput.command as string) || '';
    const firstWord = command.split(/\s+/)[0] || '';

    if (command) {
      options.push({ label: `Allow this exact command`, pattern: `Bash(${command})` });
    }
    if (firstWord && firstWord !== command) {
      options.push({ label: `Allow all "${firstWord}" commands`, pattern: `Bash(${firstWord}:*)` });
    }
    options.push({ label: 'Allow all Bash', pattern: 'Bash' });
  } else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
    const filePath = (toolInput.file_path as string) || '';
    if (filePath) {
      const dir = path.dirname(filePath);
      options.push({ label: `Allow ${toolName} for this file`, pattern: `${toolName}(${filePath})` });
      if (dir !== '.') {
        options.push({ label: `Allow ${toolName} in ${path.basename(dir)}/`, pattern: `${toolName}(${dir}/:*)` });
      }
    }
    options.push({ label: `Allow all ${toolName}`, pattern: toolName });
  } else if (toolName.startsWith('mcp__')) {
    options.push({ label: `Allow this MCP tool`, pattern: toolName });
    // Extract server prefix: mcp__server__tool -> mcp__server__*
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      const serverPrefix = `${parts[0]}__${parts[1]}__`;
      options.push({ label: `Allow all ${parts[1]} tools`, pattern: `${serverPrefix}*` });
    }
  } else {
    options.push({ label: `Allow ${toolName}`, pattern: toolName });
  }

  return options;
}

/**
 * Create a pending permission request.
 * Returns the PermissionPromptData to send to the renderer,
 * and a Promise that resolves when the user decides.
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

  const response = new Promise<Record<string, unknown>>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      // Timeout: return empty response so hook falls back to Claude default
      resolve({});
    }, TIMEOUT_MS);

    pending.set(requestId, {
      requestId,
      taskId,
      taskName,
      toolName,
      toolInput,
      ruleOptions,
      resolve,
      timer,
    });
  });

  return { promptData, response };
}

/**
 * Resolve a pending permission request with the user's decision.
 */
export function resolveRequest(requestId: string, decision: PermissionDecision): void {
  const req = pending.get(requestId);
  if (!req) return;

  clearTimeout(req.timer);
  pending.delete(requestId);

  if (decision.persist && decision.rulePattern && decision.scope) {
    writeRule(decision.action, decision.rulePattern, decision.scope, req.taskId);
  }

  req.resolve({
    hookSpecificOutput: {
      permissionDecision: decision.action,
    },
  });
}

/**
 * Cancel all pending requests for a task (e.g. when task is killed).
 */
export function cancelTaskRequests(taskId: string): void {
  for (const [id, req] of pending) {
    if (req.taskId === taskId) {
      clearTimeout(req.timer);
      pending.delete(id);
      req.resolve({});
    }
  }
}

// --- Settings file writer ---

// Lazy import to avoid circular dependency with ipc-handlers
let getWorktreePath: ((taskId: string) => string) | null = null;

export function setWorktreePathResolver(resolver: (taskId: string) => string): void {
  getWorktreePath = resolver;
}

function settingsPath(scope: 'local' | 'project' | 'user', taskId: string): string {
  switch (scope) {
    case 'local': {
      const wt = getWorktreePath?.(taskId);
      if (!wt) throw new Error('Cannot resolve worktree path for task');
      return path.join(wt, '.claude', 'settings.local.json');
    }
    case 'project': {
      const wt = getWorktreePath?.(taskId);
      if (!wt) throw new Error('Cannot resolve worktree path for task');
      return path.join(wt, '.claude', 'settings.json');
    }
    case 'user':
      return path.join(os.homedir(), '.claude', 'settings.json');
  }
}

function writeRule(
  action: 'allow' | 'deny',
  pattern: string,
  scope: 'local' | 'project' | 'user',
  taskId: string,
): void {
  const filePath = settingsPath(scope, taskId);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      settings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // Corrupt file — start fresh
    }
  }

  const key = action; // 'allow' or 'deny'
  const list = (settings[key] as string[]) || [];

  if (!list.includes(pattern)) {
    list.push(pattern);
    settings[key] = list;
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  }
}
```

**Step 2: Verify the project compiles**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```
git add src/main/permission-manager.ts
git commit -m "Add permission manager with request lifecycle and settings writer"
```

---

### Task 4: HTTP Endpoint & IPC Handler

**Files:**
- Modify: `src/main/bifrost-api.ts` (add `/permission` endpoint)
- Modify: `src/main/ipc-handlers.ts` (register RESOLVE_PERMISSION handler, wire up cancelTaskRequests)

**Step 1: Add `/permission` endpoint to `bifrost-api.ts`**

Add import at top of file:

```typescript
import { createRequest } from './permission-manager';
```

Add a new case in the `handleRequest` switch block (before the `default` case at line 154):

```typescript
    case '/permission': {
      const cwd = body.cwd as string;
      const toolName = body.tool_name as string;
      const toolInput = (body.tool_input as Record<string, unknown>) || {};

      if (!cwd || !toolName) {
        errorResponse(res, 'Missing cwd or tool_name');
        return;
      }

      const task = getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
      if (!task) {
        // No matching task — fall back to Claude default
        jsonResponse(res, {});
        return;
      }

      const { promptData, response } = createRequest(task.id, task.name, toolName, toolInput);

      // Send to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.PERMISSION_PROMPT, promptData);
      }

      // Notify user
      handleBellNotification(task.id, task.name, false);

      // Hold connection open until resolved
      const result = await response;
      jsonResponse(res, result);
      return;
    }
```

**Step 2: Register RESOLVE_PERMISSION handler in `ipc-handlers.ts`**

Add import at top:

```typescript
import { resolveRequest, cancelTaskRequests, setWorktreePathResolver } from './permission-manager';
```

Add `PermissionDecision` to the type import from `'../shared/types'`.

Add after the `registerIpcHandlers` function opens (after line 128, near the other setup code):

```typescript
  // Permission manager: provide worktree path resolver
  setWorktreePathResolver((taskId) => getTask(taskId).worktreePath);
```

Add the IPC handler (near the end of `registerIpcHandlers`, before the closing brace):

```typescript
  // Permission
  ipcMain.handle(IPC.RESOLVE_PERMISSION, (_event, requestId: string, decision: PermissionDecision) => {
    resolveRequest(requestId, decision);
  });
```

Add `cancelTaskRequests(taskId)` call inside `destroyTask()` (at line 80, before `stopWatching`):

```typescript
  cancelTaskRequests(taskId);
```

Also add the same call in the `STOP_TASK` handler (line 266, inside the `if (task.status === 'running')` block):

```typescript
  cancelTaskRequests(taskId);
```

**Step 3: Verify the project compiles**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```
git add src/main/bifrost-api.ts src/main/ipc-handlers.ts
git commit -m "Add /permission HTTP endpoint and RESOLVE_PERMISSION IPC handler"
```

---

### Task 5: Hook Script & Configuration

**Files:**
- Create: `src/claude-plugin/hooks/bifrost-permission.sh`
- Modify: `src/claude-plugin/hooks/hooks.json`

**Step 1: Create the hook script**

Create `src/claude-plugin/hooks/bifrost-permission.sh`:

```bash
#!/usr/bin/env bash
INPUT="$(cat)"
PORT="${BIFROST_API_PORT:-$(cat "$HOME/.bifrost/api-port" 2>/dev/null)}"
[ -z "$PORT" ] && exit 0
RESPONSE=$(curl -s --max-time 120 \
  -X POST -H "Content-Type: application/json" \
  -d "$INPUT" \
  "http://127.0.0.1:${PORT}/permission" 2>/dev/null)
[ -z "$RESPONSE" ] && exit 0
echo "$RESPONSE"
```

Make it executable: `chmod +x src/claude-plugin/hooks/bifrost-permission.sh`

**Step 2: Add PreToolUse entry to `hooks.json`**

Replace `src/claude-plugin/hooks/hooks.json` with:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/bifrost-permission.sh",
            "timeout": 120
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/bifrost-notify.sh",
            "async": true
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/bifrost-notify.sh",
            "async": true
          }
        ]
      }
    ]
  }
}
```

**Step 3: Bump plugin version**

Update `src/claude-plugin/.claude-plugin/plugin.json` version from `1.3.0` to `1.4.0` so the plugin gets reinstalled:

```json
{
  "name": "bifrost",
  "version": "1.4.0",
  "description": "Bifrost integration — MCP tools and skills for multi-task orchestration"
}
```

**Step 4: Commit**

```
git add src/claude-plugin/hooks/bifrost-permission.sh src/claude-plugin/hooks/hooks.json src/claude-plugin/.claude-plugin/plugin.json
git commit -m "Add PreToolUse hook script and configuration, bump plugin to 1.4.0"
```

---

### Task 6: Renderer State (AppContext)

**Files:**
- Modify: `src/renderer/context/AppContext.tsx`

**Step 1: Add permission queue to AppState**

Add import for `PermissionPromptData` at the top (line 2):

```typescript
import type { Repo, Task, BifrostConfig, TaskStatus, PermissionPromptData } from '../../shared/types';
```

Add to `AppState` interface (after `toastDuration` at line 34):

```typescript
  permissionQueue: PermissionPromptData[];
```

Add actions to `AppAction` type (after `SET_API_PORT` at line 61):

```typescript
  | { type: 'PUSH_PERMISSION'; request: PermissionPromptData }
  | { type: 'SHIFT_PERMISSION' }
```

Add to `initialState` (after `toastDuration` at line 84):

```typescript
  permissionQueue: [],
```

Add reducer cases (before the `default` case at line 222):

```typescript
    case 'PUSH_PERMISSION':
      return { ...state, permissionQueue: [...state.permissionQueue, action.request] };
    case 'SHIFT_PERMISSION':
      return { ...state, permissionQueue: state.permissionQueue.slice(1) };
```

**Step 2: Verify the project compiles**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```
git add src/renderer/context/AppContext.tsx
git commit -m "Add permission queue to renderer state"
```

---

### Task 7: Permission Panel Component

**Files:**
- Create: `src/renderer/components/PermissionPanel.tsx`

**Step 1: Create the floating permission panel**

Create `src/renderer/components/PermissionPanel.tsx`:

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import type { PermissionDecision } from '../../shared/types';

type Scope = 'local' | 'project' | 'user';

export default function PermissionPanel() {
  const { state, dispatch } = useApp();
  const request = state.permissionQueue[0];

  const [selectedRule, setSelectedRule] = useState(0);
  const [scope, setScope] = useState<Scope>('local');
  const [persist, setPersist] = useState(true);

  // Reset selection when request changes
  useEffect(() => {
    setSelectedRule(0);
    setScope('local');
    setPersist(true);
  }, [request?.requestId]);

  const handleDecision = useCallback((action: 'allow' | 'deny') => {
    if (!request) return;

    const decision: PermissionDecision = {
      action,
      persist,
      scope: persist ? scope : undefined,
      rulePattern: persist ? request.ruleOptions[selectedRule]?.pattern : undefined,
    };

    window.bifrost.resolvePermission(request.requestId, decision);
    dispatch({ type: 'SHIFT_PERMISSION' });
  }, [request, persist, scope, selectedRule, dispatch]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!request) return;

    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'a':
        case 'A':
          e.preventDefault();
          handleDecision('allow');
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          handleDecision('deny');
          break;
        case '1':
          e.preventDefault();
          setScope('local');
          break;
        case '2':
          e.preventDefault();
          setScope('project');
          break;
        case '3':
          e.preventDefault();
          setScope('user');
          break;
        case 'Tab':
          e.preventDefault();
          setSelectedRule((prev) => (prev + 1) % request.ruleOptions.length);
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          setPersist((prev) => !prev);
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [request, handleDecision]);

  if (!request) return null;

  const queueCount = state.permissionQueue.length;

  // Format tool input for display
  const inputSummary = request.toolName === 'Bash'
    ? (request.toolInput.command as string) || ''
    : JSON.stringify(request.toolInput, null, 2).slice(0, 200);

  return (
    <div className="fixed bottom-14 right-4 z-40 w-96 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-xs font-semibold text-slate-300">
            Permission Request
          </span>
        </div>
        <div className="flex items-center gap-2">
          {queueCount > 1 && (
            <span className="text-xs text-slate-500">+{queueCount - 1} more</span>
          )}
          <span className="text-xs text-slate-500">{request.taskName}</span>
        </div>
      </div>

      {/* Tool info */}
      <div className="px-3 py-2 border-b border-slate-700">
        <div className="text-sm font-medium text-slate-200">{request.toolName}</div>
        <pre className="mt-1 text-xs text-slate-400 font-mono whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
          {inputSummary}
        </pre>
      </div>

      {/* Rule options */}
      {persist && (
        <div className="px-3 py-2 border-b border-slate-700">
          <div className="text-xs text-slate-400 mb-1">
            Rule pattern <span className="text-slate-500">(Tab to cycle)</span>
          </div>
          <div className="space-y-1">
            {request.ruleOptions.map((opt, i) => (
              <button
                key={opt.pattern}
                onClick={() => setSelectedRule(i)}
                className={`w-full text-left px-2 py-1 rounded text-xs ${
                  i === selectedRule
                    ? 'bg-blue-600/30 text-blue-300 border border-blue-500/50'
                    : 'text-slate-400 hover:bg-slate-700'
                }`}
              >
                <span>{opt.label}</span>
                <span className="ml-2 font-mono text-slate-500">{opt.pattern}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scope selector & persist toggle */}
      <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={persist}
            onChange={(e) => setPersist(e.target.checked)}
            className="rounded border-slate-600 bg-slate-700 text-blue-500"
          />
          <span>Remember <span className="text-slate-500">(P)</span></span>
        </label>

        {persist && (
          <div className="flex gap-1 ml-auto">
            {(['local', 'project', 'user'] as Scope[]).map((s, i) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2 py-0.5 rounded text-xs ${
                  scope === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                }`}
              >
                {s} <span className="text-slate-500">{i + 1}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="px-3 py-2 flex gap-2">
        <button
          onClick={() => handleDecision('allow')}
          className="flex-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded"
        >
          Allow <span className="text-green-200 text-xs">(A)</span>
        </button>
        <button
          onClick={() => handleDecision('deny')}
          className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded"
        >
          Deny <span className="text-red-200 text-xs">(D)</span>
        </button>
      </div>
    </div>
  );
}
```

**Step 2: Verify the project compiles**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```
git add src/renderer/components/PermissionPanel.tsx
git commit -m "Add floating permission panel component"
```

---

### Task 8: Wire Up App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add import for PermissionPanel**

Add after the `SettingsOverlay` import (line 14):

```typescript
import PermissionPanel from './components/PermissionPanel';
```

**Step 2: Add permission prompt listener**

Add a new `useEffect` block after the hook notification listener (after line 125):

```typescript
  // Listen for permission prompts from main process
  useEffect(() => {
    const unsub = window.bifrost.onPermissionPrompt((request) => {
      dispatch({ type: 'PUSH_PERMISSION', request });
    });
    return unsub;
  }, [dispatch]);
```

**Step 3: Render PermissionPanel**

Add `<PermissionPanel />` in the JSX, after the `DiffOverlay` (after line 272):

```tsx
      {/* Permission approval panel */}
      <PermissionPanel />
```

**Step 4: Verify the project compiles**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```
git add src/renderer/App.tsx
git commit -m "Wire up permission prompt listener and render panel"
```

---

### Task 9: Manual Integration Test

**Step 1: Start the app in development mode**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npm start`

**Step 2: Verify the app starts without errors**

Check the dev console (View > Toggle Developer Tools) for any import/compilation errors.

**Step 3: Test the permission flow end-to-end**

1. Create a task in Bifrost
2. In the Claude session, trigger a tool use that requires permission
3. Verify the floating panel appears with correct tool name/input
4. Test keyboard shortcuts: `Tab` to cycle rules, `1/2/3` for scope, `A` to allow, `D` to deny
5. Test persist: allow a Bash command at "local" scope, verify `.claude/settings.local.json` is updated
6. Verify the allow rule prevents the hook from firing again for that tool

**Step 4: Final commit if any fixes needed**

```
git add -A
git commit -m "Fix integration issues from manual testing"
```
