import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import PrimaryButton from './PrimaryButton';

export default function NotificationPopover() {
  const { state, dispatch } = useApp();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Reset focus index when popover opens or notification list changes
  useEffect(() => {
    if (state.showNotificationPopover) setFocusedIdx(0);
  }, [state.showNotificationPopover]);

  // Auto-focus the popover when opened
  useEffect(() => {
    if (state.showNotificationPopover) popoverRef.current?.focus();
  }, [state.showNotificationPopover]);

  // Close on click outside
  useEffect(() => {
    if (!state.showNotificationPopover) return;

    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        // Don't close if clicking the bell icon button — let its onClick toggle handle it
        const target = e.target as HTMLElement;
        if (target.closest('[data-notification-bell]')) return;
        dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' });
      }
    };

    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [state.showNotificationPopover, dispatch]);

  if (!state.showNotificationPopover) return null;

  const handleAction = (notificationId: string, handler: string) => {
    dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' });
    if (handler.startsWith('view-review:')) {
      const targetTaskId = handler.slice('view-review:'.length);
      dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
      dispatch({ type: 'SET_ACTIVE_TASK', taskId: targetTaskId });
      dispatch({ type: 'SET_DIFF_MODE', mode: 'review' });
      const ps = state.paneStates[targetTaskId];
      if (!ps?.showDiff) dispatch({ type: 'TOGGLE_DIFF' });
      return;
    }
    if (handler.startsWith('slack-create-task:')) {
      const url = handler.slice('slack-create-task:'.length);
      dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
      dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true, slackUrl: url });
      return;
    }
    if (handler === 'install-plugin') {
      dispatch({ type: 'SHOW_TOAST', message: 'Installing plugin update...' });
      window.bifrost
        .installIntegration()
        .then(() => {
          dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
          const runningTasks = state.tasks.filter((t) => t.status === 'running');
          if (runningTasks.length > 0) {
            dispatch({
              type: 'PUSH_NOTIFICATION',
              notification: {
                id: 'restart-sessions',
                type: 'plugin-update',
                title: 'Restart Sessions?',
                message: `${runningTasks.length} running task${runningTasks.length > 1 ? 's' : ''} will be restarted to use the updated plugin.`,
                action: { label: 'Restart All', handler: 'restart-sessions' },
                read: false,
                timestamp: Date.now(),
              },
            });
            dispatch({
              type: 'SHOW_TOAST',
              message: 'Plugin updated. Use `/reload-plugins` or restart sessions to apply.',
            });
          } else {
            dispatch({
              type: 'SHOW_TOAST',
              message: 'Plugin updated. Use `/reload-plugins` in running sessions to apply.',
            });
          }
        })
        .catch(() => {
          dispatch({ type: 'SHOW_TOAST', message: 'Plugin update failed.' });
        });
    } else if (handler === 'restart-sessions') {
      dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
      const runningTasks = state.tasks.filter((t) => t.status === 'running');
      dispatch({
        type: 'SHOW_TOAST',
        message: `Restarting ${runningTasks.length} session${runningTasks.length > 1 ? 's' : ''}...`,
      });
      Promise.all(
        runningTasks.map(async (task) => {
          const stopped = await window.bifrost.stopTask(task.id);
          dispatch({ type: 'UPDATE_TASK', task: stopped });
          const reopened = await window.bifrost.reopenTask(task.id);
          dispatch({ type: 'UPDATE_TASK', task: reopened });
        }),
      )
        .then(() => {
          dispatch({ type: 'SHOW_TOAST', message: 'All sessions restarted.' });
        })
        .catch(() => {
          dispatch({ type: 'SHOW_TOAST', message: 'Some sessions failed to restart.' });
        });
    }
  };

  const notifications = state.notifications;
  const clampedIdx = Math.min(focusedIdx, notifications.length - 1);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (notifications.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        setFocusedIdx((i) => (i < notifications.length - 1 ? i + 1 : 0));
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        setFocusedIdx((i) => (i > 0 ? i - 1 : notifications.length - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const n = notifications[clampedIdx];
        if (n?.action) handleAction(n.id, n.action.handler);
        break;
      }
      case 'd': {
        e.preventDefault();
        const n = notifications[clampedIdx];
        if (n) dispatch({ type: 'DISMISS_NOTIFICATION', id: n.id });
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' });
        break;
    }
  };

  return (
    <div
      ref={popoverRef}
      tabIndex={-1}
      className="fixed right-11 top-20 z-50 w-72 max-h-[300px] flex flex-col bg-app/60 backdrop-blur-xl border border-border-input rounded-lg shadow-2xl overflow-hidden focus:outline-hidden"
      onKeyDown={handleKeyDown}
    >
      <div className="px-3 py-2 border-b border-border-default">
        <span className="text-xs font-semibold text-secondary">Notifications</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">No notifications</div>
        ) : (
          notifications.map((n, idx) => (
            <div
              key={n.id}
              className={`px-3 py-2 border-b border-border-default/50 last:border-0 ${idx === clampedIdx ? 'bg-surface-hover' : ''}`}
            >
              <div className="text-xs font-medium text-primary">{n.title}</div>
              <div className="text-xs text-secondary mt-0.5">{n.message}</div>
              {n.action && (
                <div className="mt-1.5 flex gap-2">
                  <PrimaryButton size="sm" onClick={() => handleAction(n.id, n.action!.handler)}>
                    {n.action.label}
                  </PrimaryButton>
                  <button
                    onClick={() => dispatch({ type: 'DISMISS_NOTIFICATION', id: n.id })}
                    className="px-2 py-0.5 text-xs text-secondary hover:text-primary transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      {notifications.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border-default">
          <span className="text-xs text-faint">↑↓ navigate · Enter action · d dismiss · Esc close</span>
        </div>
      )}
    </div>
  );
}
