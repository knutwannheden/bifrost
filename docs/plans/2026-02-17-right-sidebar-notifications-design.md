# Right Icon Bar & Notification System — Design

## Summary

Add a narrow right icon bar to Bifrost for mouse-based access to existing overlays, plus a notification bell with badge and popover dropdown for plugin/integration update notifications.

## Layout

The main layout gains a vertical icon strip on the right edge:

```
┌─ Title Bar ─────────────────────────┬──┐
├─ TaskBar (tabs) ────────────────────┤  │
│                                     │🔔│
│  TaskView (terminals)               │──│
│                                     │📄│
│                                     │📋│
│                                     │📝│
│                                     │──│
│                                     │⚙️│
├─ StatusBar ─────────────────────────┤  │
└─────────────────────────────────────┴──┘
```

### Right Icon Bar

- Fixed-width vertical strip (~36px) on the right edge
- Spans from TaskBar bottom to StatusBar top
- 5 icons stacked vertically with a divider separating notifications from overlays:

| Position | Icon | Action | Keyboard equivalent |
|----------|------|--------|-------------------|
| Top | Bell | Toggle notification popover | (new) |
| --- | divider | --- | --- |
| Middle | File diff | Toggle DiffOverlay (git mode) | Cmd+D |
| Middle | List | Toggle DiffOverlay (activity mode) | Cmd+A |
| Middle | Clipboard | Toggle DiffOverlay (review mode) | Alt+U |
| --- | divider | --- | --- |
| Bottom | Gear | Toggle SettingsOverlay | Cmd+, |

- Active overlay indicated by highlighted icon (blue left border or background tint)
- Bell icon shows a badge dot (amber) when there are unread notifications
- Icons use Lucide or similar icon library already available, or simple SVG icons

### Notification System

**Scope**: Plugin/integration update notifications only (for now). Designed to be extensible.

**Badge**: Small colored dot (amber) on the bell icon when unread notifications exist.

**Popover dropdown**: Clicking the bell opens a small dropdown anchored below/left of the icon:
- Width ~280px, max-height ~300px
- List of notification cards, each with:
  - Title (e.g., "Plugin Update Available")
  - Description (e.g., "Bifrost plugin v1.4.0")
  - Action button (e.g., "Install" / "Dismiss")
- Closes on click-outside or Escape
- Empty state: "No notifications"

**Notification source**: The existing `checkIntegration()` IPC call returns `{ installed, updateAvailable }`. Checked on startup and when tasks are created. When `updateAvailable` is true, a notification is pushed.

### What stays the same

- Toasts remain as bottom-center auto-dismissing messages
- Permission panel remains as its own floating panel (bottom-right, z-40)
- All existing keyboard shortcuts continue to work unchanged
- Overlays (DiffOverlay, SettingsOverlay, etc.) are unchanged internally
- The icon bar just adds mouse-click triggers for the same actions

## State Changes

**AppState additions:**
- `notifications: Notification[]` — list of notification items
- `showNotificationPopover: boolean` — popover visibility

**Notification type:**
```typescript
interface AppNotification {
  id: string;
  type: 'plugin-update' | 'info';
  title: string;
  message: string;
  action?: { label: string; handler: string };
  read: boolean;
  timestamp: number;
}
```

**New actions:**
- `PUSH_NOTIFICATION` — add a notification
- `DISMISS_NOTIFICATION` — remove by id
- `MARK_NOTIFICATIONS_READ` — mark all as read (when popover opens)
- `TOGGLE_NOTIFICATION_POPOVER` — toggle popover

The notification popover is NOT part of the `allOverlaysClosed` mutual exclusion — it's a small popover, not an overlay.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/renderer/components/RightIconBar.tsx` | Create | Icon strip component |
| `src/renderer/components/NotificationPopover.tsx` | Create | Bell popover dropdown |
| `src/renderer/App.tsx` | Modify | Add RightIconBar to layout, adjust TaskView width |
| `src/renderer/context/AppContext.tsx` | Modify | Add notification state + actions |
| `src/shared/types.ts` | Modify | Add AppNotification type |
