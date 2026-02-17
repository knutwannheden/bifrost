# Permission Approvals Overhaul — Design

## Summary

Replace Bifrost's global permission mode with an interactive approval system. A Claude Code PreToolUse plugin hook routes permission prompts to Bifrost's HTTP API, which displays a floating panel in the Electron UI. Users approve or deny with a scope selector (local/project/user) that persists rules directly to Claude Code's settings files.

## Architecture

### End-to-End Flow

1. Claude Code fires PreToolUse → `bifrost-permission.sh` hook script
2. Hook POSTs `{ tool_name, tool_input, cwd, ... }` to `http://127.0.0.1:$PORT/permission`
3. Main process creates pending request, sends `IPC_STREAM.PERMISSION_PROMPT` to renderer
4. Renderer shows floating permission panel with tool details, rule options, scope selector
5. User decides → renderer invokes `IPC.RESOLVE_PERMISSION` → main resolves held HTTP response
6. If persisting: main writes rule to appropriate `.claude/settings*.json`
7. Hook script outputs `{ "hookSpecificOutput": { "permissionDecision": "allow"|"deny" } }`
8. Claude Code proceeds or aborts

### Hook Configuration

New `PreToolUse` entry in `src/claude-plugin/hooks/hooks.json`:

```json
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
```

Matcher is `*` because Claude Code only fires PreToolUse for tools not already allowed by its settings. The 120s timeout gives users time to respond; on timeout the hook exits 0 (no output), falling back to Claude's default behavior.

### Hook Script

`bifrost-permission.sh` — reads JSON from stdin, POSTs to Bifrost API, echoes response:

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

Graceful fallback: if Bifrost isn't running or the request times out, hook exits 0 with no output, so Claude falls back to its default permission prompt in the terminal.

### Main Process

**New module: `permission-manager.ts`**

Manages:
- Pending request map: `Map<string, { resolve, taskId, toolName, toolInput, timestamp }>`
- Request lifecycle: create, resolve, timeout (120s), cleanup on task kill
- Writing rules to Claude Code settings files

**New `/permission` endpoint in `bifrost-api.ts`:**

- Receives PreToolUse JSON input
- Finds matching task by `cwd`
- Creates pending request via permission-manager
- Sends IPC event to renderer
- Triggers notification (sound/dock bounce) if task not focused
- Holds HTTP connection open until resolved or timed out
- Returns `{ "hookSpecificOutput": { "permissionDecision": "allow"|"deny" } }`

**Settings file writer:**

Given a decision, rule pattern, and scope, reads/creates the JSON file, adds pattern to `allow` or `deny` array (deduplicating), writes back.

Path resolution:
- **Local**: `<task.worktreePath>/.claude/settings.local.json`
- **Project**: `<task.worktreePath>/.claude/settings.json`
- **User**: `~/.claude/settings.json`

### IPC Channels

New entries in `ipc-channels.ts`:
- `IPC_STREAM.PERMISSION_PROMPT` — main→renderer: new permission request arrived
- `IPC.RESOLVE_PERMISSION` — renderer→main: user made a decision

New `BifrostAPI` methods:
- `onPermissionPrompt(callback: (request: PermissionPromptData) => void): () => void`
- `resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>`

### Types

```typescript
interface PermissionPromptData {
  requestId: string;
  taskId: string;
  taskName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  ruleOptions: RuleOption[];
}

interface RuleOption {
  label: string;     // e.g. "Allow all npm commands"
  pattern: string;   // e.g. "Bash(npm:*)"
}

interface PermissionDecision {
  action: 'allow' | 'deny';
  persist: boolean;
  scope?: 'local' | 'project' | 'user';
  rulePattern?: string;
}
```

Rule options are computed on the main process side based on tool name and input. For example, `Bash` with command `npm run build`:
- "Allow this exact command" → `Bash(npm run build)`
- "Allow all npm commands" → `Bash(npm:*)`
- "Allow all Bash" → `Bash`

### Renderer — Floating Permission Panel

- **Not an overlay** — does not participate in `allOverlaysClosed` mutual exclusion. Floats independently so terminals and overlays remain accessible.
- **State**: `permissionQueue: PermissionPromptData[]` in `AppState`. Shows first item; on resolve, shifts to next.
- **Position**: anchored bottom-right or top-center.
- **Keyboard**: focus-trappable with shortcuts — `A` allow, `D` deny, `1/2/3` scope, `Tab` cycle rule options.
- **Notifications**: uses existing notification service (sound + dock bounce) when window unfocused.

### Permission Mode Integration

Existing `permissionMode` config continues to work:
- `skip-permissions`: Claude never fires PreToolUse, hook never runs.
- `sandbox`: Claude runs sandboxed; PreToolUse fires for non-sandboxed tools.
- `default`: the new permission panel handles all approval prompts.

No changes to `session-manager.ts` or `config.ts` needed.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/main/permission-manager.ts` | Create | Pending requests, settings writer |
| `src/main/bifrost-api.ts` | Modify | Add `/permission` endpoint |
| `src/shared/ipc-channels.ts` | Modify | Add PERMISSION_PROMPT, RESOLVE_PERMISSION |
| `src/shared/types.ts` | Modify | Add PermissionPromptData, PermissionDecision, RuleOption |
| `src/preload/preload.ts` | Modify | Expose onPermissionPrompt, resolvePermission |
| `src/renderer/context/AppContext.tsx` | Modify | Add permissionQueue state + actions |
| `src/renderer/components/PermissionPanel.tsx` | Create | Floating permission UI |
| `src/renderer/App.tsx` | Modify | Wire up permission prompt listener, render panel |
| `src/claude-plugin/hooks/hooks.json` | Modify | Add PreToolUse entry |
| `src/claude-plugin/hooks/bifrost-permission.sh` | Create | Hook script |
| `src/main/ipc-handlers.ts` | Modify | Register RESOLVE_PERMISSION handler |
