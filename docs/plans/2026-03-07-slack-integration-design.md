# Slack Integration Design

## Goal

Allow Bifrost to monitor Slack for emoji reactions on messages. When a user reacts with a configured emoji, Bifrost surfaces a notification with a "Create Task" button that opens the Create Task dialog pre-filled with the Slack message link.

## OAuth Flow

1. User enters Slack Client ID and Client Secret in the Settings overlay.
2. User clicks "Connect to Slack".
3. Bifrost starts a temporary HTTPS server on a random localhost port (self-signed TLS cert).
4. Opens the browser to Slack's OAuth authorize URL with user token scopes: `channels:history`, `groups:history`, `reactions:read`, `users:read`, `emoji:read`, `files:read`, `links:read`.
5. Slack redirects to `https://localhost:{port}/callback?code=...`.
6. Bifrost exchanges the code for a user token via `oauth.v2.access`.
7. Stores the token in `config.json` under `slack.userToken`.
8. Shuts down the temporary HTTPS server.
9. Settings UI shows "Connected" status with a "Disconnect" option.

## Reaction Polling

- A `SlackPoller` service in the main process polls `reactions.list` every 30 seconds.
- Started when a valid token, at least one emoji, and `enabled: true` are configured.
- Walks results (returned in reverse chronological order) until hitting a previously-seen timestamp.
- For each new reaction matching a configured emoji name:
  - Constructs a Slack message URL from the item's channel and timestamp.
  - Sends a `SLACK_REACTION` IPC stream event to the renderer.
- Poller stops/restarts automatically when settings change (token added/removed, emoji list edited, enabled toggled).

## Notifications

- On `SLACK_REACTION`, the renderer:
  - Shows a toast with a "Create Task" button.
  - Pushes a **persistent** `AppNotification` to the notification popover (bell icon in right bar).
- Persistent notifications (Slack reactions, plugin updates) remain in the popover until dismissed.
- Ephemeral notifications (task waiting for input) show only as toasts — never stored in `state.notifications`. This is the existing behavior for hook-based task notifications.
- `AppNotification` gains a `persistent: boolean` field and a `'slack-reaction'` type.
- Clicking "Create Task" on either the toast or the notification opens the Create Task dialog with the Slack message URL pre-filled (reuses existing `parseSlackUrl` and prompt generation).

## Config & Storage

`config.json` — user settings:
```json
{
  "slack": {
    "clientId": "...",
    "clientSecret": "...",
    "userToken": "xoxp-...",
    "reactions": ["bifrost", "robot_face"],
    "enabled": true
  }
}
```

`~/.bifrost/slack.json` — transient polling state:
```json
{
  "lastProcessedTimestamp": 1709827200,
  "processedReactions": ["C059AMX9324:1772814046.766799"]
}
```

`processedReactions` is capped at 500 entries, oldest pruned.

When toggling from disabled to enabled, the user is prompted: "Process reactions since you disconnected?" Yes polls from `lastProcessedTimestamp`; No advances the timestamp to now.

## Settings UI

New "Slack" section in the existing Settings overlay:

- **Enabled** toggle at the top
- **Client ID** — text input
- **Client Secret** — text input (masked)
- **Connect to Slack** button — disabled until ID and Secret are filled in; shows "Connected" state after OAuth
- **Reactions** — list of emoji names to watch for (without colons)

## Architecture

New module:
| Module | Purpose |
|--------|---------|
| `src/main/slack-service.ts` | OAuth flow (localhost HTTPS server), token management, `reactions.list` polling, reaction dedup, state persistence |

Integration points:
- `slack-service` emits `SLACK_REACTION` via IPC stream.
- `App.tsx` listens for `SLACK_REACTION`, pushes persistent notification + shows toast with "Create Task" action.
- "Create Task" action opens dialog with Slack message URL pre-filled.
- Poller lifecycle managed by config changes.

No new renderer components — extends Settings overlay and reuses existing notification popover + toast system.
