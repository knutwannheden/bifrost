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
    dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' });
    if (handler.startsWith('slack-create-task:')) {
      const url = handler.slice('slack-create-task:'.length);
      dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
      dispatch({ type: 'SHOW_CREATE_TASK_DIALOG', show: true, slackUrl: url });
      return;
    }
    if (handler === 'install-plugin') {
      dispatch({ type: 'SHOW_TOAST', message: 'Installing plugin update...' });
      window.bifrost.installIntegration().then(() => {
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
          dispatch({ type: 'SHOW_TOAST', message: 'Plugin updated. Use `/reload-plugins` or restart sessions to apply.' });
        } else {
          dispatch({ type: 'SHOW_TOAST', message: 'Plugin updated. Use `/reload-plugins` in running sessions to apply.' });
        }
      }).catch(() => {
        dispatch({ type: 'SHOW_TOAST', message: 'Plugin update failed.' });
      });
    } else if (handler === 'restart-sessions') {
      dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
      const runningTasks = state.tasks.filter((t) => t.status === 'running');
      dispatch({ type: 'SHOW_TOAST', message: `Restarting ${runningTasks.length} session${runningTasks.length > 1 ? 's' : ''}...` });
      Promise.all(
        runningTasks.map(async (task) => {
          const stopped = await window.bifrost.stopTask(task.id);
          dispatch({ type: 'UPDATE_TASK', task: stopped });
          const reopened = await window.bifrost.reopenTask(task.id);
          dispatch({ type: 'UPDATE_TASK', task: reopened });
        }),
      ).then(() => {
        dispatch({ type: 'SHOW_TOAST', message: 'All sessions restarted.' });
      }).catch(() => {
        dispatch({ type: 'SHOW_TOAST', message: 'Some sessions failed to restart.' });
      });
    }
  };

  return (
    <div
      ref={popoverRef}
      className="fixed right-11 top-20 z-50 w-72 max-h-[300px] flex flex-col bg-app/60 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-border-default">
        <span className="text-xs font-semibold text-secondary">Notifications</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {state.notifications.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">
            No notifications
          </div>
        ) : (
          state.notifications.map((n) => (
            <div key={n.id} className="px-3 py-2 border-b border-border-default/50 last:border-0">
              <div className="text-xs font-medium text-primary">{n.title}</div>
              <div className="text-xs text-secondary mt-0.5">{n.message}</div>
              {n.action && (
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={() => handleAction(n.id, n.action!.handler)}
                    className="px-2 py-0.5 text-xs bg-accent hover:bg-accent-hover text-white rounded"
                  >
                    {n.action.label}
                  </button>
                  <button
                    onClick={() => dispatch({ type: 'DISMISS_NOTIFICATION', id: n.id })}
                    className="px-2 py-0.5 text-xs text-secondary hover:text-primary"
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
