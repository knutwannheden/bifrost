# Right Icon Bar & Notification System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a right icon bar for mouse-based overlay access and a notification bell with popover for plugin update alerts.

**Architecture:** A narrow icon strip on the right edge dispatches the same actions as existing keyboard shortcuts. A notification bell at the top shows a badge when updates are available, with a small popover dropdown to view and act on notifications.

**Tech Stack:** TypeScript, React, Tailwind CSS, inline SVG icons

---

### Task 1: AppNotification Type

**Files:**
- Modify: `src/shared/types.ts` (append after PermissionDecision, ~line 209)

**Step 1: Add the AppNotification type**

Add after the `PermissionDecision` interface:

```typescript
// Notification types

export interface AppNotification {
  id: string;
  type: 'plugin-update' | 'info';
  title: string;
  message: string;
  action?: { label: string; handler: string };
  read: boolean;
  timestamp: number;
}
```

**Step 2: Verify compilation**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`

**Step 3: Commit**

```
git add src/shared/types.ts
git commit -m "Add AppNotification type"
```

---

### Task 2: Notification State in AppContext

**Files:**
- Modify: `src/renderer/context/AppContext.tsx`

**Step 1: Add imports and state**

Add `AppNotification` to the import from `../../shared/types` (line 2).

Add to `AppState` interface (after `permissionQueue`, before `apiPort`):

```typescript
  notifications: AppNotification[];
  showNotificationPopover: boolean;
```

Add actions to `AppAction` type (after `SHIFT_PERMISSION`):

```typescript
  | { type: 'PUSH_NOTIFICATION'; notification: AppNotification }
  | { type: 'DISMISS_NOTIFICATION'; id: string }
  | { type: 'MARK_NOTIFICATIONS_READ' }
  | { type: 'TOGGLE_NOTIFICATION_POPOVER' }
```

Add to `initialState` (after `permissionQueue: []`):

```typescript
  notifications: [],
  showNotificationPopover: false,
```

Add reducer cases (before `default`):

```typescript
    case 'PUSH_NOTIFICATION':
      // Don't add duplicate notifications of the same type
      if (state.notifications.some((n) => n.type === action.notification.type && n.type !== 'info')) {
        return state;
      }
      return { ...state, notifications: [...state.notifications, action.notification] };
    case 'DISMISS_NOTIFICATION':
      return { ...state, notifications: state.notifications.filter((n) => n.id !== action.id) };
    case 'MARK_NOTIFICATIONS_READ':
      return { ...state, notifications: state.notifications.map((n) => ({ ...n, read: true })) };
    case 'TOGGLE_NOTIFICATION_POPOVER': {
      const opening = !state.showNotificationPopover;
      return {
        ...state,
        showNotificationPopover: opening,
        // Mark all as read when opening
        notifications: opening ? state.notifications.map((n) => ({ ...n, read: true })) : state.notifications,
      };
    }
```

**Step 2: Verify compilation**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`

**Step 3: Commit**

```
git add src/renderer/context/AppContext.tsx
git commit -m "Add notification state and actions to AppContext"
```

---

### Task 3: RightIconBar Component

**Files:**
- Create: `src/renderer/components/RightIconBar.tsx`

**Step 1: Create the icon bar component**

This component renders a narrow vertical strip with 5 icons. It reads `state.showDiff`, `state.diffMode`, `state.showSettings`, and `state.notifications` to determine active/badge state. Clicking an icon dispatches the same actions as the existing keyboard shortcuts.

```tsx
import React from 'react';
import { useApp } from '../context/AppContext';
import type { DiffMode } from '../context/AppContext';

// Inline SVG icons (16x16)
function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13.5a2 2 0 0 1-4 0" />
      <path d="M4.5 6a3.5 3.5 0 0 1 7 0c0 3.5 1.5 4.5 1.5 4.5H3S4.5 9.5 4.5 6z" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z" />
      <path d="M8 6v4M6 8h4" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8h2.5l2-4 3 8 2-4H14" />
    </svg>
  );
}

function ReviewIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M6 5h4M6 8h4M6 11h2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2" />
      <path d="M13.5 8a5.5 5.5 0 0 0-.1-.8l1.2-1-.8-1.4-1.5.5a5.5 5.5 0 0 0-1.2-.7L10.8 3H9.2l-.3 1.6c-.5.1-.9.4-1.2.7l-1.5-.5-.8 1.4 1.2 1a5.5 5.5 0 0 0 0 1.6l-1.2 1 .8 1.4 1.5-.5c.3.3.7.5 1.2.7l.3 1.6h1.6l.3-1.6c.5-.1.9-.4 1.2-.7l1.5.5.8-1.4-1.2-1a5.5 5.5 0 0 0 .1-.8z" />
    </svg>
  );
}

interface IconButtonProps {
  active?: boolean;
  badge?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}

function IconButton({ active, badge, title, onClick, children }: IconButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`relative w-full flex items-center justify-center h-9 transition-colors ${
        active
          ? 'text-blue-400 bg-slate-700/50 border-l-2 border-blue-400'
          : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/30 border-l-2 border-transparent'
      }`}
    >
      {children}
      {badge && (
        <span className="absolute top-1.5 right-2 w-2 h-2 rounded-full bg-amber-400" />
      )}
    </button>
  );
}

export default function RightIconBar() {
  const { state, dispatch } = useApp();

  const isDiffActive = state.showDiff;
  const hasUnreadNotifications = state.notifications.some((n) => !n.read);

  const toggleDiffMode = (mode: DiffMode) => {
    if (isDiffActive && state.diffMode === mode) {
      dispatch({ type: 'TOGGLE_DIFF' });
    } else {
      dispatch({ type: 'SET_DIFF_MODE', mode });
      if (!isDiffActive) dispatch({ type: 'TOGGLE_DIFF' });
    }
  };

  return (
    <div className="flex flex-col w-9 bg-slate-800 border-l border-slate-700 shrink-0">
      {/* Notifications */}
      <IconButton
        title="Notifications"
        active={state.showNotificationPopover}
        badge={hasUnreadNotifications}
        onClick={() => dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' })}
      >
        <BellIcon />
      </IconButton>

      {/* Divider */}
      <div className="mx-2 border-t border-slate-700" />

      {/* Diff */}
      <IconButton
        title="Diff (⌘D)"
        active={isDiffActive && state.diffMode === 'git'}
        onClick={() => toggleDiffMode('git')}
      >
        <DiffIcon />
      </IconButton>

      {/* Activity */}
      <IconButton
        title="Activity (⌘A)"
        active={isDiffActive && state.diffMode === 'activity'}
        onClick={() => toggleDiffMode('activity')}
      >
        <ActivityIcon />
      </IconButton>

      {/* Review */}
      <IconButton
        title="Review (⌥U)"
        active={isDiffActive && state.diffMode === 'review'}
        onClick={() => toggleDiffMode('review')}
      >
        <ReviewIcon />
      </IconButton>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Divider */}
      <div className="mx-2 border-t border-slate-700" />

      {/* Settings */}
      <IconButton
        title="Settings (⌘,)"
        active={state.showSettings}
        onClick={() => dispatch({ type: 'TOGGLE_SETTINGS' })}
      >
        <GearIcon />
      </IconButton>
    </div>
  );
}
```

**Step 2: Verify compilation**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`

**Step 3: Commit**

```
git add src/renderer/components/RightIconBar.tsx
git commit -m "Add RightIconBar component with overlay toggle icons"
```

---

### Task 4: NotificationPopover Component

**Files:**
- Create: `src/renderer/components/NotificationPopover.tsx`

**Step 1: Create the popover component**

```tsx
import React, { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';

export default function NotificationPopover() {
  const { state, dispatch } = useApp();
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!state.showNotificationPopover) return;

    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' });
      }
    };

    // Delay to avoid catching the click that opened it
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [state.showNotificationPopover, dispatch]);

  // Close on Escape
  useEffect(() => {
    if (!state.showNotificationPopover) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' });
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state.showNotificationPopover, dispatch]);

  if (!state.showNotificationPopover) return null;

  const handleAction = (notificationId: string, handler: string) => {
    if (handler === 'install-plugin') {
      window.bifrost.installIntegration().then(() => {
        dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
        dispatch({ type: 'SHOW_TOAST', message: 'Plugin updated. Restart Claude Code sessions to apply.' });
      });
    }
    dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' });
  };

  return (
    <div
      ref={popoverRef}
      className="fixed right-11 top-20 z-50 w-72 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl"
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-700">
        <span className="text-xs font-semibold text-slate-300">Notifications</span>
      </div>

      {/* Content */}
      <div className="max-h-72 overflow-y-auto">
        {state.notifications.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-slate-500">
            No notifications
          </div>
        ) : (
          state.notifications.map((n) => (
            <div key={n.id} className="px-3 py-2 border-b border-slate-700/50 last:border-0">
              <div className="text-xs font-medium text-slate-200">{n.title}</div>
              <div className="text-xs text-slate-400 mt-0.5">{n.message}</div>
              {n.action && (
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={() => handleAction(n.id, n.action!.handler)}
                    className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded"
                  >
                    {n.action.label}
                  </button>
                  <button
                    onClick={() => dispatch({ type: 'DISMISS_NOTIFICATION', id: n.id })}
                    className="px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify compilation**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`

**Step 3: Commit**

```
git add src/renderer/components/NotificationPopover.tsx
git commit -m "Add NotificationPopover component"
```

---

### Task 5: Wire Up App.tsx Layout

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add imports**

Add after the PermissionPanel import (line 15):

```typescript
import RightIconBar from './components/RightIconBar';
import NotificationPopover from './components/NotificationPopover';
```

**Step 2: Add integration check on startup**

Add a new `useEffect` after the permission prompt listener (after line 134):

```typescript
  // Check for plugin updates on startup
  useEffect(() => {
    window.bifrost.checkIntegration().then(({ updateAvailable }) => {
      if (updateAvailable) {
        dispatch({
          type: 'PUSH_NOTIFICATION',
          notification: {
            id: 'plugin-update',
            type: 'plugin-update',
            title: 'Plugin Update Available',
            message: 'A new version of the Bifrost plugin is available.',
            action: { label: 'Install', handler: 'install-plugin' },
            read: false,
            timestamp: Date.now(),
          },
        });
      }
    });
  }, [dispatch]);
```

**Step 3: Modify the layout JSX**

The main content area (TaskBar, TaskView, StatusBar) needs to sit next to the RightIconBar. Wrap them in a flex row:

Replace the return JSX (lines 250-293) with:

```tsx
  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200">
      {/* Title bar drag area */}
      <div className="h-8 bg-slate-800 border-b border-slate-700 flex items-center justify-center"
           style={{ WebkitAppRegion: 'drag', paddingLeft: 78 } as React.CSSProperties}>
        <span className="text-xs font-semibold tracking-wide text-slate-500">BIFROST</span>
      </div>

      {/* Main area: content + right icon bar */}
      <div className="flex flex-1 min-h-0">
        {/* Content column */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Task tab bar */}
          <TaskBar />

          {/* Main content: terminal */}
          <TaskView />

          {/* Status bar */}
          <StatusBar
            activeTask={activeTask}
            config={state.config}
            repos={state.repos}
            apiPort={state.apiPort}
            onToggleIde={handleToggleIde}
          />
        </div>

        {/* Right icon bar */}
        <RightIconBar />
      </div>

      {/* Modals */}
      {state.showRepoManager && <RepoManager />}
      {state.showCreateDialog && <TaskCreateDialog />}
      {state.showTaskHistory && <TaskHistoryPanel />}
      {state.showKeyboardShortcuts && <KeyboardShortcutsPanel />}
      {state.showSettings && <SettingsOverlay />}

      {/* Diff overlay */}
      <DiffOverlay />

      {/* Permission approval panel */}
      <PermissionPanel />

      {/* Notification popover */}
      <NotificationPopover />

      {/* Toast notification */}
      {state.toast && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-slate-700 text-slate-200 text-sm rounded shadow-lg animate-fade-in max-w-lg">
          <SimpleMarkdown text={state.toast} />
        </div>
      )}
    </div>
  );
```

**Step 4: Verify compilation**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npx tsc --noEmit`

**Step 5: Run lint**

Run: `cd /Users/knut/git/knutwannheden/bifrost && npm run lint`

**Step 6: Commit**

```
git add src/renderer/App.tsx
git commit -m "Wire up RightIconBar, NotificationPopover, and plugin update check"
```
