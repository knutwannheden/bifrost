import React from 'react';
import { useApp, getActiveDiffState } from '../context/AppContext';
import type { DiffMode } from '../context/AppContext';

function BellIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 11.5a2 2 0 0 1-4 0" />
      <path d="M4.5 6a3.5 3.5 0 0 1 7 0c0 3.5 1.5 4.5 1.5 4.5H3S4.5 9.5 4.5 6z" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z" />
      <path d="M8 6v4M6 8h4" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8h2.5l2-4 3 8 2-4H14" />
    </svg>
  );
}

function ReviewIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M6 5h4M6 8h4M6 11h2" />
    </svg>
  );
}

function SupervisorIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="4" r="2" />
      <path d="M8 6v2" />
      <path d="M4.5 10.5L8 8l3.5 2.5" />
      <circle cx="4.5" cy="12" r="1.5" />
      <circle cx="11.5" cy="12" r="1.5" />
    </svg>
  );
}

function StatsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13V8M6.5 13V5M10 13V7M13.5 13V3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    </svg>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  badge?: boolean;
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}

function IconButton({ active, badge, label, shortcut, onClick, children, ...rest }: IconButtonProps) {
  return (
    <button
      onClick={onClick}
      {...rest}
      className={`group relative w-full flex items-center justify-center h-8 transition-colors ${
        active
          ? 'text-blue-400 bg-slate-700/50 border-l-2 border-blue-400'
          : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/30 border-l-2 border-transparent'
      }`}
    >
      {children}
      {badge && (
        <span className="absolute top-1 right-1.5 w-2 h-2 rounded-full bg-amber-400" />
      )}
      <span className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 border border-slate-700 shadow-lg whitespace-nowrap z-50">
        <span className="text-xs text-slate-200">{label}</span>
        {shortcut && <kbd className="text-[10px] text-slate-400 bg-slate-800 px-1 py-0.5 rounded border border-slate-600">{shortcut}</kbd>}
      </span>
    </button>
  );
}

export default function RightIconBar() {
  const { state, dispatch } = useApp();

  const { showDiff: isDiffActive, diffMode } = getActiveDiffState(state);
  const hasUnreadNotifications = state.notifications.some((n) => !n.read);

  const toggleDiffMode = (mode: DiffMode) => {
    if (isDiffActive && diffMode === mode) {
      dispatch({ type: 'TOGGLE_DIFF' });
    } else {
      dispatch({ type: 'SET_DIFF_MODE', mode });
      if (!isDiffActive) dispatch({ type: 'TOGGLE_DIFF' });
    }
  };

  return (
    <div className="flex flex-col w-11 bg-slate-800 border-l border-slate-700 shrink-0">
      <IconButton
        label="Notifications"
        active={state.showNotificationPopover}
        badge={hasUnreadNotifications}
        onClick={() => dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' })}
        data-notification-bell
      >
        <BellIcon />
      </IconButton>

      <div className="mx-2 my-1 border-t border-slate-700" />

      <IconButton
        label="Diff"
        shortcut="⌘D"
        active={isDiffActive && diffMode === 'git'}
        onClick={() => toggleDiffMode('git')}
      >
        <DiffIcon />
      </IconButton>

      <IconButton
        label="Activity"
        shortcut="⌘A"
        active={isDiffActive && diffMode === 'activity'}
        onClick={() => toggleDiffMode('activity')}
      >
        <ActivityIcon />
      </IconButton>

      <IconButton
        label="Review"
        shortcut="⌥U"
        active={isDiffActive && diffMode === 'review'}
        onClick={() => toggleDiffMode('review')}
      >
        <ReviewIcon />
      </IconButton>

      {state.config?.experimentalFeatures && (
        <IconButton
          label="Supervisor"
          active={state.showSupervisor}
          badge={supervisorBadge}
          onClick={() => dispatch({ type: 'TOGGLE_SUPERVISOR' })}
        >
          <SupervisorIcon />
        </IconButton>
      )}

      <div className="flex-1" />

      <div className="mx-2 my-1 border-t border-slate-700" />

      <IconButton
        label="Statistics"
        active={state.showStats}
        onClick={() => dispatch({ type: 'TOGGLE_STATS' })}
      >
        <StatsIcon />
      </IconButton>

      <IconButton
        label="Settings"
        shortcut="⌘,"
        active={state.showSettings}
        onClick={() => dispatch({ type: 'TOGGLE_SETTINGS' })}
      >
        <GearIcon />
      </IconButton>
      <div className="h-1" />
    </div>
  );
}
