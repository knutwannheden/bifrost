import type { BifrostConfig, ClaudeAccount, Task } from '../../shared/types';
import type { AppAction } from '../context/AppContext';

type Dispatch = (action: AppAction) => void;

export function accountLabel(account: ClaudeAccount): string {
  return `~/${account.dir ?? '.claude'}${account.email ? ` — ${account.email}` : ''}`;
}

/** Makes the account the one sessions start with, and offers to move the running ones to it. */
export async function switchClaudeAccount(
  account: ClaudeAccount,
  config: BifrostConfig,
  tasks: Task[],
  dispatch: Dispatch,
): Promise<void> {
  const next = { ...config, claudeConfigDir: account.dir };
  await window.bifrost.saveConfig(next);
  dispatch({ type: 'SET_CONFIG', config: next });
  dispatch({ type: 'SHOW_TOAST', message: `Sessions now start with ${accountLabel(account)}` });
  if (!tasks.some((t) => t.status === 'running')) return;
  dispatch({
    type: 'PUSH_NOTIFICATION',
    notification: {
      id: 'restart-sessions',
      type: 'restart-sessions',
      title: 'Restart Sessions?',
      message: 'Running sessions keep the account they started with until they restart.',
      action: { label: 'Restart sessions', handler: 'restart-sessions' },
      read: false,
      timestamp: Date.now(),
    },
  });
}
