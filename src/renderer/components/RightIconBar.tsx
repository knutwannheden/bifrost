import React from 'react';
import type { DiffMode } from '../context/AppContext';
import { getActiveDiffState, useApp } from '../context/AppContext';
import { useKeymap } from '../context/KeymapContext';
import Kbd from './Kbd';

function BellIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 11.5a2 2 0 0 1-4 0" />
      <path d="M4.5 6a3.5 3.5 0 0 1 7 0c0 3.5 1.5 4.5 1.5 4.5H3S4.5 9.5 4.5 6z" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z" />
      <path d="M8 6v4M6 8h4" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 8h2.5l2-4 3 8 2-4H14" />
    </svg>
  );
}

function TriageIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 14v-4M8 10L4 4h8L8 10z" />
      <circle cx="8" cy="6" r="0.5" fill="currentColor" />
    </svg>
  );
}

function StatsIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 13V8M6.5 13V5M10 13V7M13.5 13V3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    </svg>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  badge?: 'amber' | 'green' | 'blue';
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}

const badgeClasses = {
  amber: 'bg-warning',
  green: 'bg-success animate-pulse',
  blue: 'bg-accent',
};

function IconButton({ active, badge, label, shortcut, onClick, children, ...rest }: IconButtonProps) {
  return (
    <button
      onClick={onClick}
      {...rest}
      className={`group relative w-full flex items-center justify-center h-8 transition-colors ${
        active
          ? 'text-accent-hover bg-surface-alt/50 border-l-2 border-accent-hover'
          : 'text-muted hover:text-secondary hover:bg-surface-alt/30 border-l-2 border-transparent'
      }`}
    >
      {children}
      {badge && <span className={`absolute top-1 right-1.5 w-2 h-2 rounded-full ${badgeClasses[badge]}`} />}
      <span className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-1.5 px-2 py-1 rounded-sm bg-app border border-border-default shadow-lg whitespace-nowrap z-50">
        <span className="text-xs text-primary">{label}</span>
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </span>
    </button>
  );
}

export default function RightIconBar() {
  const { state, dispatch } = useApp();
  const { getDisplayString } = useKeymap();

  const { showDiff: isDiffActive, diffMode } = getActiveDiffState(state);
  const hasUnreadNotifications = state.notifications.some((n) => !n.read);

  const triageItems = Object.values(state.triages);
  const hasTriageWaiting = triageItems.some((t) => t.waiting);
  const hasTriageRunning = triageItems.some((t) => t.status === 'running');
  const triageBadge = hasTriageWaiting ? ('amber' as const) : hasTriageRunning ? ('green' as const) : undefined;

  const toggleDiffMode = (mode: DiffMode) => {
    if (isDiffActive && diffMode === mode) {
      dispatch({ type: 'TOGGLE_DIFF' });
    } else {
      dispatch({ type: 'SET_DIFF_MODE', mode });
      if (!isDiffActive) dispatch({ type: 'TOGGLE_DIFF' });
    }
  };

  return (
    <div className="flex flex-col w-11 bg-surface border-l border-border-default shrink-0">
      <IconButton
        label="Notifications"
        shortcut={getDisplayString('view.notifications')}
        active={state.showNotificationPopover}
        badge={hasUnreadNotifications ? 'amber' : undefined}
        onClick={() => dispatch({ type: 'TOGGLE_NOTIFICATION_POPOVER' })}
        data-notification-bell
      >
        <BellIcon />
      </IconButton>

      <div className="mx-2 my-1 border-t border-border-default" />

      <IconButton
        label="Diff"
        shortcut={getDisplayString('view.diff')}
        active={isDiffActive && diffMode === 'git'}
        onClick={() => toggleDiffMode('git')}
      >
        <DiffIcon />
      </IconButton>

      <IconButton
        label="Tokens"
        shortcut={getDisplayString('view.activity')}
        active={isDiffActive && diffMode === 'activity'}
        onClick={() => toggleDiffMode('activity')}
      >
        <ActivityIcon />
      </IconButton>

      <IconButton
        label="Triage"
        shortcut={getDisplayString('view.triage')}
        active={state.showTriage}
        badge={triageBadge}
        onClick={() => dispatch({ type: 'SHOW_TRIAGE' })}
      >
        <TriageIcon />
      </IconButton>

      <div className="flex-1" />

      <div className="mx-2 my-1 border-t border-border-default" />

      <IconButton
        label="Statistics"
        shortcut={getDisplayString('view.stats')}
        active={state.showStats}
        onClick={() => dispatch({ type: 'TOGGLE_STATS' })}
      >
        <StatsIcon />
      </IconButton>

      <IconButton
        label="Settings"
        shortcut={getDisplayString('app.settings')}
        active={state.showSettings}
        onClick={() => dispatch({ type: 'TOGGLE_SETTINGS' })}
      >
        <GearIcon />
      </IconButton>
      <div className="h-1" />
    </div>
  );
}
