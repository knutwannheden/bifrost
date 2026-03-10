import React, { useCallback, useEffect, useState } from 'react';
import type { PrerequisiteStatus } from '../../shared/types';
import type { PaneTarget } from '../context/AppContext';
import { defaultPaneState, useApp } from '../context/AppContext';
import { altSymbol, modSymbol, shiftSymbol } from '../utils/platform';
import Kbd from './Kbd';
import SectionHeader from './SectionHeader';
import Spinner from './Spinner';
import TerminalPane from './TerminalPane';

const shortcuts = [
  { keys: 'Cmd+R', label: 'Add a repository' },
  { keys: 'Cmd+T', label: 'Create a new task' },
  { keys: 'Cmd+H', label: 'Resume from history' },
  { keys: 'Cmd+K', label: 'Command palette' },
];

const tips = [
  'Most views support instant search \u2014 just start typing to filter. Space-separated terms are ANDed.',
  `Underlined characters in buttons are mnemonics \u2014 press ${altSymbol}that letter to activate.`,
  'Double-click a task tab to rename it inline.',
  `Press ${modSymbol}D to view git diff and activity log for the current task.`,
  'Hover over a task tab to see its summary, branch, and current activity.',
  `Use ${modSymbol}F to search within the terminal. Enter/Shift+Enter to navigate matches.`,
  'Each task runs in its own git worktree \u2014 agents work independently without conflicts.',
  `Press ${modSymbol}H to browse task history and resume archived tasks.`,
  `Use ${modSymbol}K to open the command palette for quick access to all actions.`,
  `Press ${modSymbol}, to open settings and customize font size, IDE, and more.`,
  `Press ${modSymbol}/ to open a dev terminal alongside Claude \u2014 press again to toggle focus between panes.`,
  `Press ${modSymbol}${shiftSymbol}C to capture context and copy a [Bifrost #N] reference to clipboard \u2014 paste it into any Claude Code session to share context.`,
  `Press ${modSymbol}U to run an AI review of your task\u2019s changes \u2014 get actionable feedback before committing.`,
  'When a permission prompt appears, press Tab to focus it \u2014 then use A/D to allow/deny, Esc to deny once.',
  `Press ${modSymbol}- to jump back to your previous tab \u2014 like cd - for tasks.`,
  `Press ${modSymbol}= to jump to the last tab that had a notification.`,
  'Copy a GitHub PR or issue URL to your clipboard \u2014 Bifrost will detect it automatically.',
];

export default function TaskView() {
  const { state, dispatch } = useApp();
  const [splitRatio, setSplitRatio] = useState(0.7);
  const [prereqs, setPrereqs] = useState<PrerequisiteStatus | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * tips.length));

  const openTasks = state.tasks.filter((t) => t.status === 'running');
  const activeTask = openTasks.find((t) => t.id === state.activeTaskId);

  const handlePaneFocus = useCallback(
    (taskId: string, pane: PaneTarget) => {
      dispatch({ type: 'SET_PANE_FOCUS', taskId, pane });
    },
    [dispatch],
  );

  const handleTitleChange = useCallback(
    (taskId: string, title: string) => {
      if (taskId === state.activeTaskId) {
        window.bifrost.setTerminalTitle(taskId, title);
      }
    },
    [state.activeTaskId],
  );

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = (e.target as HTMLElement).parentElement;
    if (!container) return;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = (ev.clientY - rect.top) / rect.height;
      setSplitRatio(Math.min(0.9, Math.max(0.1, ratio)));
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Check prerequisites when welcome screen would show
  useEffect(() => {
    if (!activeTask && state.tasksLoaded && openTasks.length === 0) {
      window.bifrost.checkPrerequisites().then(setPrereqs);
    }
  }, [activeTask, state.tasksLoaded, openTasks.length]);

  const handleInstallPlugin = useCallback(async () => {
    setInstalling('plugin');
    try {
      await window.bifrost.installIntegration();
      setPrereqs((p) => (p ? { ...p, plugin: { installed: true, updateAvailable: false } } : p));
      dispatch({ type: 'SHOW_TOAST', message: 'Claude integration installed' });
    } catch (err) {
      dispatch({ type: 'SHOW_TOAST', message: `Install failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setInstalling(null);
    }
  }, [dispatch]);

  const handleInstallModel = useCallback(
    async (model: string) => {
      setInstalling(model);
      try {
        await window.bifrost.installOllamaModel(model);
        setPrereqs((p) =>
          p ? { ...p, ollamaModels: p.ollamaModels.map((m) => (m.name === model ? { ...m, installed: true } : m)) } : p,
        );
        dispatch({ type: 'SHOW_TOAST', message: `Model ${model} installed` });
      } catch (err) {
        dispatch({
          type: 'SHOW_TOAST',
          message: `Install failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setInstalling(null);
      }
    },
    [dispatch],
  );

  // Set window title from task name when active task changes
  useEffect(() => {
    if (activeTask) {
      window.bifrost.setTerminalTitle(activeTask.id, activeTask.name);
    }
  }, [activeTask?.id]);

  if (!activeTask) {
    // Don't show welcome screen while tasks are loading or running tasks exist
    // (avoids flashing during startup task restoration)
    if (!state.tasksLoaded || openTasks.length > 0) {
      return <div className="flex-1" />;
    }
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-muted max-w-md">
          <p className="text-2xl font-semibold text-primary mb-2">BIFROST</p>
          <p className="text-sm text-secondary mb-6 leading-relaxed">
            A keyboard-centric command center for orchestrating parallel Claude Code sessions. Each task runs in its own
            isolated git worktree, so agents work independently without stepping on each other.
          </p>

          {prereqs && (
            <div className="mb-6 text-left">
              <PrerequisiteChecklist
                prereqs={prereqs}
                installing={installing}
                onInstallPlugin={handleInstallPlugin}
                onInstallModel={handleInstallModel}
              />
            </div>
          )}

          <div className="inline-grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-left">
            {shortcuts.map((s) => (
              <React.Fragment key={s.keys}>
                <Kbd size="sm">{s.keys}</Kbd>
                <span className="text-xs text-secondary">{s.label}</span>
              </React.Fragment>
            ))}
          </div>
          {state.config?.showTips !== false && (
            <div className="mt-6 flex flex-col items-center gap-1.5">
              <div className="bg-surface-alt/50 border border-border-input/50 rounded-full px-4 py-2 flex items-center gap-2 max-w-sm">
                <span className="text-warning text-sm shrink-0">&#x1F4A1;</span>
                <p className="text-xs text-secondary leading-relaxed">{tips[tipIndex]}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setTipIndex((i) => (i + 1) % tips.length)}
                  className="text-[10px] text-muted hover:text-secondary transition-colors"
                >
                  Next tip
                </button>
                <span className="text-[10px] text-faint">|</span>
                <button
                  onClick={async () => {
                    if (!state.config) return;
                    const newConfig = { ...state.config, showTips: false };
                    await window.bifrost.saveConfig(newConfig);
                    dispatch({ type: 'SET_CONFIG', config: newConfig });
                  }}
                  className="text-[10px] text-faint hover:text-secondary transition-colors"
                >
                  Don&apos;t show tips
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      {openTasks.map((task) => {
        const isActive = task.id === state.activeTaskId;
        const ps = state.paneStates[task.id] ?? defaultPaneState;

        const showClaude = !ps.claudeHidden;
        const showDev = !!ps.devSessionId && !ps.devHidden;

        return (
          <div key={task.id} className="absolute inset-0 flex flex-col" style={{ display: isActive ? 'flex' : 'none' }}>
            {/* Claude pane — always rendered, hidden via CSS to preserve xterm state */}
            <div
              style={{
                flex: showDev ? `0 0 ${splitRatio * 100}%` : '1 1 0%',
                minHeight: 0,
                display: showClaude ? 'block' : 'none',
                overflow: 'hidden',
              }}
            >
              <TerminalPane
                sessionId={task.id}
                taskId={task.id}
                active={isActive}
                focused={ps.focusedPane === 'claude'}
                hideCursor
                paneType="claude"
                onFocusRequest={() => handlePaneFocus(task.id, 'claude')}
                onTitleChange={(title) => handleTitleChange(task.id, title)}
              />
            </div>

            {/* Draggable divider between panes */}
            {showDev && showClaude && (
              <div
                className="shrink-0 bg-border-default hover:bg-accent cursor-row-resize transition-colors"
                style={{ height: 4 }}
                onMouseDown={handleDividerMouseDown}
              />
            )}

            {/* Dev terminal pane — rendered when session exists, hidden via CSS */}
            {ps.devSessionId && (
              <div
                style={{
                  flex: '1 1 0%',
                  minHeight: showClaude ? 100 : 0,
                  display: showDev ? 'block' : 'none',
                  overflow: 'hidden',
                }}
              >
                <TerminalPane
                  sessionId={ps.devSessionId}
                  active={isActive}
                  focused={ps.focusedPane === 'dev'}
                  paneType="dev"
                  onFocusRequest={() => handlePaneFocus(task.id, 'dev')}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Prerequisite Checklist ---

function CheckIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="text-success text-sm leading-none">&#10003;</span>
  ) : (
    <span className="text-danger text-sm leading-none">&#10007;</span>
  );
}

function InstallButton({ label, spinning, onClick }: { label: string; spinning: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={spinning}
      className="ml-2 px-2 py-0.5 text-[10px] bg-accent hover:bg-accent-hover disabled:opacity-50 text-white rounded-sm transition-colors"
    >
      {spinning ? <Spinner size="sm" /> : label}
    </button>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        window.bifrost.openUrl(href);
      }}
      className="text-accent-hover hover:underline"
    >
      {children}
    </a>
  );
}

function PrerequisiteChecklist({
  prereqs,
  installing,
  onInstallPlugin,
  onInstallModel,
}: {
  prereqs: PrerequisiteStatus;
  installing: string | null;
  onInstallPlugin: () => void;
  onInstallModel: (model: string) => void;
}) {
  const allRequiredOk = prereqs.git && prereqs.claude && prereqs.plugin.installed;
  const allOptionalOk = prereqs.gh && prereqs.ollama && prereqs.ollamaModels.every((m) => m.installed);

  // Hide checklist entirely when everything is installed and no updates available
  if (allRequiredOk && !prereqs.plugin.updateAvailable && allOptionalOk) return null;

  return (
    <div className="space-y-3">
      {/* Required */}
      {(!prereqs.git || !prereqs.claude || !prereqs.plugin.installed || prereqs.plugin.updateAvailable) && (
        <div>
          <SectionHeader className="mb-1.5">Required</SectionHeader>
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <CheckIcon ok={prereqs.git} />
              <span className={prereqs.git ? 'text-secondary' : 'text-primary'}>
                git {!prereqs.git && <span className="text-muted">— version control</span>}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <CheckIcon ok={prereqs.claude} />
              <span className={prereqs.claude ? 'text-secondary' : 'text-primary'}>
                claude{' '}
                {!prereqs.claude && (
                  <span className="text-muted">
                    —{' '}
                    <ExternalLink href="https://docs.anthropic.com/en/docs/claude-code/overview">
                      Claude Code CLI
                    </ExternalLink>
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <CheckIcon ok={prereqs.plugin.installed && !prereqs.plugin.updateAvailable} />
              <span
                className={
                  prereqs.plugin.installed && !prereqs.plugin.updateAvailable ? 'text-secondary' : 'text-primary'
                }
              >
                Bifrost plugin
              </span>
              {(!prereqs.plugin.installed || prereqs.plugin.updateAvailable) && (
                <InstallButton
                  label={prereqs.plugin.updateAvailable ? 'Update' : 'Install'}
                  spinning={installing === 'plugin'}
                  onClick={onInstallPlugin}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Optional */}
      {(!prereqs.gh || !prereqs.ollama || prereqs.ollamaModels.some((m) => !m.installed)) && (
        <div>
          <SectionHeader className="mb-1.5">Optional</SectionHeader>
          <div className="space-y-1">
            {!prereqs.gh && (
              <div className="flex items-center gap-2 text-xs">
                <CheckIcon ok={false} />
                <span className="text-primary">
                  gh{' '}
                  <span className="text-muted">
                    — <ExternalLink href="https://cli.github.com">GitHub CLI</ExternalLink> for PR-based task creation
                  </span>
                </span>
              </div>
            )}
            {!prereqs.ollama && (
              <div className="flex items-center gap-2 text-xs">
                <CheckIcon ok={false} />
                <span className="text-primary">
                  ollama{' '}
                  <span className="text-muted">
                    — <ExternalLink href="https://ollama.com">local models</ExternalLink> for task summaries
                  </span>
                </span>
              </div>
            )}
            {prereqs.ollama &&
              prereqs.ollamaModels
                .filter((m) => !m.installed)
                .map((m) => (
                  <div key={m.name} className="flex items-center gap-2 text-xs pl-4">
                    <CheckIcon ok={false} />
                    <span className="text-primary font-mono">{m.name}</span>
                    <InstallButton
                      label="Pull"
                      spinning={installing === m.name}
                      onClick={() => onInstallModel(m.name)}
                    />
                  </div>
                ))}
          </div>
        </div>
      )}
    </div>
  );
}
