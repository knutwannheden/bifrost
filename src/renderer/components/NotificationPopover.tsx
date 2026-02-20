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
    if (handler === 'install-plugin') {
      dispatch({ type: 'SHOW_TOAST', message: 'Installing plugin update...' });
      window.bifrost.installIntegration().then(() => {
        dispatch({ type: 'DISMISS_NOTIFICATION', id: notificationId });
        dispatch({ type: 'SHOW_TOAST', message: 'Plugin updated. Restart Claude Code sessions to apply.' });
      }).catch(() => {
        dispatch({ type: 'SHOW_TOAST', message: 'Plugin update failed.' });
      });
    }
  };

  return (
    <div
      ref={popoverRef}
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}
      className="fixed right-11 top-20 z-50 w-72 max-h-[300px] flex flex-col bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-slate-700">
        <span className="text-xs font-semibold text-slate-300">Notifications</span>
      </div>

      <div className="flex-1 overflow-y-auto">
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
