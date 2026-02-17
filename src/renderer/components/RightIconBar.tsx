import React from 'react';
import { useApp } from '../context/AppContext';
import type { DiffMode } from '../context/AppContext';

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

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  badge?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}

function IconButton({ active, badge, title, onClick, children, ...rest }: IconButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      {...rest}
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
      <IconButton
        title="Notifications"
        active={state.showNotificationPopover}
        badge={hasUnreadNotifications}
        onClick={() => dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' })}
        data-notification-bell
      >
        <BellIcon />
      </IconButton>

      <div className="mx-2 border-t border-slate-700" />

      <IconButton
        title="Diff (⌘D)"
        active={isDiffActive && state.diffMode === 'git'}
        onClick={() => toggleDiffMode('git')}
      >
        <DiffIcon />
      </IconButton>

      <IconButton
        title="Activity (⌘A)"
        active={isDiffActive && state.diffMode === 'activity'}
        onClick={() => toggleDiffMode('activity')}
      >
        <ActivityIcon />
      </IconButton>

      <IconButton
        title="Review (⌥U)"
        active={isDiffActive && state.diffMode === 'review'}
        onClick={() => toggleDiffMode('review')}
      >
        <ReviewIcon />
      </IconButton>

      <div className="flex-1" />

      <div className="mx-2 border-t border-slate-700" />

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
