# Slack Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Monitor Slack for emoji reactions and surface them as persistent notifications with a "Create Task" action in Bifrost.

**Architecture:** New `slack-service.ts` in the main process handles OAuth (localhost HTTPS server with self-signed cert) and polls `reactions.list`. Reactions are sent to the renderer via IPC, shown as toasts and persisted in the notification popover. Settings extend `BifrostConfig` with a `slack` sub-object; transient polling state lives in `~/.bifrost/slack.json`.

**Tech Stack:** Electron (main process), Node.js `https` + `crypto` (self-signed TLS for OAuth callback), Slack Web API (HTTP calls, no SDK), React (Settings UI)

**Design doc:** `docs/plans/2026-03-07-slack-integration-design.md`

---

### Task 1: Extend BifrostConfig with Slack settings

**Files:**
- Modify: `src/shared/types.ts`

**Step 1: Add SlackConfig interface and update BifrostConfig**

In `src/shared/types.ts`, add before `AppNotification`:

```typescript
export interface SlackConfig {
  clientId: string;
  clientSecret: string;
  userToken: string;
  reactions: string[];
  enabled: boolean;
}
```

Add to `BifrostConfig`:
```typescript
slack?: SlackConfig;
```

**Step 2: Add `'slack-reaction'` to AppNotification.type union**

Change `AppNotification.type` from:
```typescript
type: 'plugin-update' | 'restart-sessions' | 'info';
```
to:
```typescript
type: 'plugin-update' | 'restart-sessions' | 'info' | 'slack-reaction';
```

Add `persistent?: boolean` field to `AppNotification`.

**Step 3: Commit**

```
feat: add SlackConfig type and slack-reaction notification type
```

---

### Task 2: Add IPC channels and BifrostAPI for Slack

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/preload/preload.ts`

**Step 1: Add IPC channels**

In `IPC` object:
```typescript
// Slack
SLACK_START_OAUTH: 'slack:start-oauth',
SLACK_DISCONNECT: 'slack:disconnect',
```

In `IPC_STREAM` object:
```typescript
SLACK_REACTION: 'slack:reaction',
```

**Step 2: Add methods to BifrostAPI interface**

```typescript
// Slack
startSlackOAuth(): Promise<void>;
disconnectSlack(): Promise<void>;
onSlackReaction(callback: (channelId: string, messageTs: string, messageUrl: string, messagePreview: string) => void): () => void;
```

**Step 3: Implement in preload.ts**

Follow existing patterns — `ipcRenderer.invoke` for request-response, `ipcRenderer.on` / `ipcRenderer.removeListener` for streams. Match the pattern used by `onHookNotification` or `onTaskCreated`.

**Step 4: Commit**

```
feat: add Slack IPC channels and preload bridge
```

---

### Task 3: Implement slack-service.ts — OAuth flow

**Files:**
- Create: `src/main/slack-service.ts`
- Modify: `src/main/ipc-handlers.ts`

**Step 1: Implement OAuth with localhost HTTPS redirect**

`src/main/slack-service.ts`:

```typescript
import https from 'node:https';
import crypto from 'node:crypto';
import { shell, BrowserWindow } from 'electron';
import { loadConfig, saveConfig } from './config';
```

Key functions:

- `startOAuth(mainWindow: BrowserWindow): Promise<void>` —
  1. Generate self-signed TLS cert using `crypto.generateKeyPairSync` and `crypto.X509Certificate` (or use `node-forge` / raw openssl — simplest: `tls.createSecureContext` with an ephemeral self-signed cert via Node's `crypto`).
  2. Start `https.createServer` on port 0 (random available port).
  3. Build Slack authorize URL: `https://slack.com/oauth/v2/authorize` with params: `client_id`, `user_scope=channels:history,groups:history,reactions:read,users:read,emoji:read,files:read,links:read`, `redirect_uri=https://localhost:{port}/callback`, `state={random}`.
  4. Open browser via `shell.openExternal(url)`.
  5. Handle `GET /callback?code=...&state=...` — verify state, exchange code for token via `https://slack.com/api/oauth.v2.access` POST, store `authed_user.access_token` in config as `slack.userToken`, close server.
  6. On error or timeout (60s), close server and reject.

- `disconnectSlack(): void` — remove `slack.userToken` from config, stop poller.

For the self-signed cert, the simplest approach is:
```typescript
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
// Use selfsigned npm package, or generate with crypto.createSign
```

Actually, simplest: use the `selfsigned` npm package (small, zero-dep) or generate raw with Node crypto. Check what's available — if `selfsigned` would be a new dependency, just use raw Node crypto to create a self-signed cert.

**Step 2: Register IPC handlers in ipc-handlers.ts**

```typescript
import { startOAuth, disconnectSlack } from './slack-service';

// In registerHandlers:
ipcMain.handle(IPC.SLACK_START_OAUTH, () => startOAuth(mainWindow));
ipcMain.handle(IPC.SLACK_DISCONNECT, () => disconnectSlack());
```

**Step 3: Manually test OAuth flow**

- Set Client ID and Secret in config.json manually
- Call `startSlackOAuth()` from dev tools
- Verify browser opens, redirect comes back, token is stored
- Browser will show a certificate warning for the self-signed cert — this is expected and the user clicks through once

**Step 4: Commit**

```
feat: implement Slack OAuth flow with localhost HTTPS redirect
```

---

### Task 4: Implement slack-service.ts — Reaction polling

**Files:**
- Modify: `src/main/slack-service.ts`

**Step 1: Add state persistence**

```typescript
const SLACK_STATE_PATH = path.join(os.homedir(), '.bifrost', 'slack.json');

interface SlackState {
  lastProcessedTimestamp: number;
  processedReactions: string[]; // "channelId:messageTs"
}

function loadSlackState(): SlackState { ... }
function saveSlackState(state: SlackState): void { ... }
```

Cap `processedReactions` at 500 entries on save.

**Step 2: Implement reaction polling**

```typescript
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startPolling(mainWindow: BrowserWindow): void { ... }
export function stopPolling(): void { ... }
```

`startPolling`:
- Load config; if `!slack.enabled || !slack.userToken || !slack.reactions.length`, return.
- Set interval at 30s.
- Each tick: call `fetchReactions()`.

`fetchReactions`:
- Call Slack API `https://slack.com/api/reactions.list` with `token`, `limit=100`, `cursor` for pagination.
- Walk items in order. Each item has `message.ts`, `channel`, and `message.reactions[]`.
- For each item, check if any reaction name matches `config.slack.reactions`.
- Check dedup: `${channel}:${message.ts}` not in `processedReactions` and `message.ts` > `lastProcessedTimestamp`.
- For new matches: construct Slack message URL (`https://{team}.slack.com/archives/{channel}/p{ts_without_dot}`), extract a message preview (first 100 chars of `message.text`), send `IPC_STREAM.SLACK_REACTION` to renderer.
- Update `lastProcessedTimestamp` and `processedReactions`, save state.

Note: `reactions.list` returns the user's own reactions. The team domain is needed for constructing URLs — get it from `auth.test` API call (cache it on first poll or after OAuth).

**Step 3: Wire up poller lifecycle**

Export `restartPolling(mainWindow)` that stops + starts. Call it:
- After OAuth completes (token stored)
- After disconnect
- From `ipc-handlers.ts` after `SAVE_CONFIG` (settings changed)

**Step 4: Commit**

```
feat: implement Slack reaction polling with dedup and state persistence
```

---

### Task 5: Add Slack section to Settings overlay

**Files:**
- Modify: `src/renderer/components/SettingsOverlay.tsx`

**Step 1: Add 'Slack' to categories**

```typescript
const CATEGORIES = ['Appearance', 'Claude Code', 'General', 'Slack'] as const;
```

**Step 2: Add Slack settings to buildSettings()**

Add these entries with `category: 'Slack'`:

1. **Enabled** — toggle switch, reads/writes `config.slack?.enabled`. Default false.
2. **Client ID** — text input, reads/writes `config.slack?.clientId`.
3. **Client Secret** — password input (`type="password"`), reads/writes `config.slack?.clientSecret`.
4. **Connect** — button that calls `window.bifrost.startSlackOAuth()`. Shows "Connected ✓" if `config.slack?.userToken` exists, with a "Disconnect" link that calls `window.bifrost.disconnectSlack()` and reloads config.
5. **Reactions** — text input (comma-separated), reads/writes `config.slack?.reactions`. Placeholder: `bifrost, robot_face`.

The `updateConfig` function already handles partial updates. For the `slack` sub-object, the render callbacks will need to merge: `update({ slack: { ...config.slack, clientId: value } })` — but note `BifrostConfig` currently uses spread at the top level. The `slack` key is a nested object, so the settings render functions need to handle the nesting.

Since the existing `SettingDef.render` receives `(config, update)` where `update` does `{ ...config, ...updates }`, nested updates need to pass the full `slack` object:

```typescript
render: (config, update) => (
  <input
    value={config.slack?.clientId ?? ''}
    onChange={(e) => update({ slack: { ...config.slack, clientId: e.target.value } } as any)}
  />
)
```

The Connect button is special — not a standard setting widget. Render it as a button that triggers the OAuth flow and shows status based on `config.slack?.userToken`.

**Step 3: Commit**

```
feat: add Slack section to Settings overlay
```

---

### Task 6: Handle Slack reactions in the renderer

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/NotificationPopover.tsx`

**Step 1: Listen for SLACK_REACTION in App.tsx**

Add a `useEffect` similar to the existing `onTaskCreated` listener:

```typescript
useEffect(() => {
  const unsub = window.bifrost.onSlackReaction((channelId, messageTs, messageUrl, messagePreview) => {
    // Show toast with Create Task action
    dispatch({
      type: 'SHOW_TOAST',
      message: `Slack: ${messagePreview}`,
      duration: 8000,
      action: {
        label: 'Create Task',
        callback: () => dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true }),
      },
    });

    // Push persistent notification
    dispatch({
      type: 'PUSH_NOTIFICATION',
      notification: {
        id: `slack-${channelId}-${messageTs}`,
        type: 'slack-reaction',
        title: 'Slack Reaction',
        message: messagePreview,
        action: { label: 'Create Task', handler: `slack-create-task:${messageUrl}` },
        read: false,
        timestamp: Date.now(),
        persistent: true,
      },
    });
  });
  return unsub;
}, [dispatch]);
```

Also: before showing the toast, write the Slack URL to clipboard so `TaskCreateDialog` picks it up via existing clipboard detection. Or — better — pass the URL via a new field on `SHOW_CREATE_TASK_DIALOG` action so it's explicit rather than relying on clipboard side-effects.

Add `slackUrl?: string` to `SHOW_CREATE_TASK_DIALOG` action type. The Create Task dialog reads it and pre-fills the Slack prompt, same as the clipboard flow.

**Step 2: Handle slack-create-task in NotificationPopover.tsx**

In the `handleAction` function, add:

```typescript
if (handler.startsWith('slack-create-task:')) {
  const url = handler.slice('slack-create-task:'.length);
  dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true, slackUrl: url });
  dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
}
```

**Step 3: Update TaskCreateDialog to accept slackUrl from action**

In `AppState`, add `createDialogSlackUrl: string | null`. Set it in the reducer when `SHOW_CREATE_TASK_DIALOG` fires with `slackUrl`. `TaskCreateDialog` reads `state.createDialogSlackUrl` and uses it (same as current clipboard detection flow, but explicit). Clear it when dialog closes.

**Step 4: Commit**

```
feat: surface Slack reactions as toasts and persistent notifications
```

---

### Task 7: Wire up poller lifecycle and enable/disable flow

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/slack-service.ts`
- Modify: `src/main/main.ts`

**Step 1: Start poller on app launch**

In `main.ts`, after the window is ready and IPC handlers are registered, call:

```typescript
import { startPolling } from './slack-service';
startPolling(mainWindow);
```

**Step 2: Restart poller on config save**

In `ipc-handlers.ts`, the `SAVE_CONFIG` handler already exists. After saving, call `restartPolling(mainWindow)`.

**Step 3: Handle enable toggle with catch-up prompt**

When `enabled` transitions from `false` to `true` in the Settings UI, the renderer should show a toast asking about catch-up. This can be handled in the Settings overlay itself:

```typescript
// In the Slack enabled toggle onChange:
if (newValue && !config.slack?.enabled) {
  // Show toast: "Process missed reactions?"
  dispatch({
    type: 'SHOW_TOAST',
    message: 'Process reactions since last connected?',
    duration: 10000,
    action: { label: 'Yes', callback: () => { /* no-op, poller uses existing lastProcessedTimestamp */ } },
  });
  // If "No" — we'd need to reset lastProcessedTimestamp to now via an IPC call
}
```

Add an IPC call `SLACK_SKIP_CATCHUP` that sets `lastProcessedTimestamp` to now in `slack.json`. The "No" path calls this before enabling.

Actually simpler: add `skipCatchup(): Promise<void>` to BifrostAPI. Renderer calls it when user declines catch-up, then saves the config with `enabled: true`.

**Step 4: Commit**

```
feat: wire up Slack poller lifecycle with enable/disable and catch-up
```

---

### Task 8: Lint, manual test, and final commit

**Step 1: Run lint**

```
npm run lint
```

Fix any issues.

**Step 2: Manual test checklist**

- [ ] Enter Client ID + Secret in Settings, click Connect → browser opens Slack OAuth page
- [ ] Approve in Slack → redirect to localhost → token stored, UI shows "Connected"
- [ ] Configure reactions list (e.g. `bifrost`)
- [ ] React to a Slack message with the configured emoji
- [ ] Within 30s, toast appears in Bifrost with message preview and "Create Task" button
- [ ] Bell icon shows unread indicator, popover shows the notification
- [ ] Click "Create Task" → Create Task dialog opens with Slack URL pre-filled
- [ ] Disable Slack in settings → poller stops
- [ ] Re-enable → prompted about catch-up
- [ ] Disconnect → token removed, poller stops

**Step 3: Final commit**

```
feat: Slack integration — complete implementation
```
