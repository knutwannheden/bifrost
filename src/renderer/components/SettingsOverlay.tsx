import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import type { BifrostConfig } from '../../shared/types';
import { modSymbol } from '../utils/platform';
import { matchesAllTerms } from '../utils/search';
import Highlight from './Highlight';
import PillToggle from './PillToggle';

interface SettingDef {
  key: string;
  category: string;
  label: string;
  description?: string;
  tooltip?: string;
  render: (config: BifrostConfig, update: (updates: Partial<BifrostConfig>) => void) => React.ReactNode;
}

const CATEGORIES = ['Appearance', 'Claude Code', 'General', 'Slack'] as const;

function buildSettings(): SettingDef[] {
  return [
    {
      key: 'fontSize',
      category: 'Appearance',
      label: 'Font Size',
      tooltip: 'Terminal font size in pixels. Affects all task terminals and dev terminals.',
      render: (config, update) => (
        <div className="flex items-center gap-2">
          <button
            onClick={() => update({ fontSize: Math.max(8, config.fontSize - 1) })}
            className="w-7 h-7 flex items-center justify-center rounded bg-surface-alt text-secondary hover:bg-surface-hover text-sm"
          >
            -
          </button>
          <span className="text-sm text-primary w-6 text-center tabular-nums">{config.fontSize}</span>
          <button
            onClick={() => update({ fontSize: Math.min(32, config.fontSize + 1) })}
            className="w-7 h-7 flex items-center justify-center rounded bg-surface-alt text-secondary hover:bg-surface-hover text-sm"
          >
            +
          </button>
        </div>
      ),
    },
    {
      key: 'fontFamily',
      category: 'Appearance',
      label: 'Font Family',
      tooltip: 'Monospace font used in terminals. Nerd Font variants include icons used by many CLI tools.',
      render: (config, update) => (
        <select
          value={config.fontFamily}
          onChange={(e) => update({ fontFamily: e.target.value })}
          className="bg-surface-alt border border-border-input rounded px-2 py-1 text-sm text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        >
          {[
            { label: 'MesloLGS NF', value: 'MesloLGS NF' },
            { label: 'JetBrains Mono NF', value: 'JetBrainsMono Nerd Font' },
            { label: 'Fira Code NF', value: 'FiraCode Nerd Font' },
            { label: 'Hack NF', value: 'Hack Nerd Font' },
            { label: 'Menlo', value: 'Menlo' },
            { label: 'Monaco', value: 'Monaco' },
          ].map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'fontWeight',
      category: 'Appearance',
      label: 'Font Weight',
      tooltip: 'Font weight from 100 (thin) to 900 (black). 300 is light, 400 is regular, 700 is bold.',
      render: (config, update) => (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={100}
            max={900}
            step={100}
            value={config.fontWeight}
            onChange={(e) => update({ fontWeight: Number(e.target.value) })}
            className="w-24 accent-accent"
          />
          <span className="text-sm text-primary w-6 text-center tabular-nums">{config.fontWeight}</span>
        </div>
      ),
    },
    {
      key: 'notifications',
      category: 'Appearance',
      label: 'Notifications',
      description: 'Sound, toast, and OS alerts when a task needs input',
      tooltip: 'When enabled, background tasks that stop or need input trigger a system bell sound and a toast popup. Disable if you prefer to check task status manually.',
      render: (config, update) => (
        <ToggleSwitch
          checked={config.notifications !== false}
          onChange={(v) => update({ notifications: v })}
        />
      ),
    },
    {
      key: 'permissionMode',
      category: 'Claude Code',
      label: 'Permission Mode',
      tooltip: 'Controls how Claude Code handles tool permissions.\n\nDefault: Claude asks before running tools that could modify files or execute commands.\n\nSandbox: Restricts file system and network access to a safe subset, reducing the need for manual approvals.\n\nSkip Permissions: Auto-approves all tool use without asking. Use with caution — Claude can run any command.',
      render: (config, update) => (
        <div className="flex flex-col gap-1.5 mt-1">
          {([
            { value: 'default' as const, label: 'Default' },
            { value: 'sandbox' as const, label: 'Sandbox', desc: 'restricts file and network access' },
            { value: 'skip-permissions' as const, label: 'Skip Permissions', desc: 'auto-approve all tool use' },
          ]).map((opt) => (
            <label key={opt.value} className="flex items-start gap-2 cursor-pointer group">
              <input
                type="radio"
                name="permissionMode"
                checked={config.permissionMode === opt.value}
                onChange={() => update({ permissionMode: opt.value })}
                className="mt-0.5 accent-accent"
              />
              <span className="text-sm text-secondary group-hover:text-primary">
                {opt.label}
                {opt.desc && <span className="text-muted"> — {opt.desc}</span>}
              </span>
            </label>
          ))}
        </div>
      ),
    },
    {
      key: 'managePermissions',
      category: 'Claude Code',
      label: 'Manage permissions',
      description: 'Handle tool permission prompts in Bifrost instead of Claude Code',
      tooltip: 'When enabled, tool permission prompts appear as a floating panel in Bifrost rather than in the terminal. You can allow/deny with keyboard shortcuts and persist rules across sessions.\n\nWhen disabled, Claude Code handles permissions natively in its own TUI.',
      render: (config, update) => (
        <ToggleSwitch
          checked={config.managePermissions}
          onChange={(v) => update({ managePermissions: v })}
        />
      ),
    },
    {
      key: 'hideTerminalOnSwitch',
      category: 'Claude Code',
      label: 'Hide terminal on switch',
      description: `${modSymbol}/ hides dev terminal when switching to Claude`,
      tooltip: `When you press ${modSymbol}/ to switch focus from the dev terminal to the Claude pane, this setting also hides the dev terminal to give Claude the full screen. Press ${modSymbol}/ again to bring it back.`,
      render: (config, update) => (
        <ToggleSwitch
          checked={config.hideTerminalOnSwitch}
          onChange={(v) => update({ hideTerminalOnSwitch: v })}
        />
      ),
    },
    {
      key: 'agentTeams',
      category: 'Claude Code',
      label: 'Agent Teams',
      description: 'Enable experimental agent teams feature',
      tooltip: 'Sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 for new sessions. This enables Claude Code\u2019s built-in multi-agent coordination where subagents can run in parallel.',
      render: (config, update) => (
        <ToggleSwitch
          checked={config.agentTeams}
          onChange={(v) => update({ agentTeams: v })}
        />
      ),
    },
    {
      key: 'ide',
      category: 'General',
      label: 'IDE',
      tooltip: `Which IDE to open when you press ${modSymbol}O. VS Code uses the "code" CLI, IntelliJ uses the "idea" CLI, Zed uses the "zed" CLI. The IDE opens the task\u2019s worktree directory.`,
      render: (config, update) => (
        <PillToggle
          options={[
            { value: 'code' as const, label: 'VS Code' },
            { value: 'idea' as const, label: 'IntelliJ' },
            { value: 'zed' as const, label: 'Zed' },
          ]}
          value={config.ide}
          onChange={(v) => update({ ide: v })}
          size="md"
        />
      ),
    },
    {
      key: 'showTips',
      category: 'General',
      label: 'Show tips on welcome screen',
      description: 'Display a rotating tip on the welcome screen',
      tooltip: 'Shows a random keyboard shortcut or workflow tip on the welcome screen when no tasks are open. Click the tip to cycle through them.',
      render: (config, update) => (
        <ToggleSwitch
          checked={config.showTips !== false}
          onChange={(v) => update({ showTips: v })}
        />
      ),
    },
    {
      key: 'experimentalFeatures',
      category: 'General',
      label: 'Experimental features',
      description: 'Enable experimental features like Supervisor',
      tooltip: 'When enabled, experimental features like the Supervisor (for headless note processing) become available.',
      render: (config, update) => (
        <ToggleSwitch
          checked={config.experimentalFeatures}
          onChange={(v) => update({ experimentalFeatures: v })}
        />
      ),
    },
    {
      key: 'ollamaModels',
      category: 'General',
      label: 'Ollama models',
      description: 'Models to try for task summarization, in priority order',
      tooltip: 'Comma-separated list of ollama model names. Bifrost tries each in order for task summarization, falling back to Claude Haiku if none are available.',
      render: (config, update) => (
        <input
          type="text"
          value={(config.ollamaModels ?? []).join(', ')}
          onChange={(e) => update({ ollamaModels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          className="bg-surface-alt border border-border-input rounded px-2 py-1 text-sm text-primary w-48 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          placeholder="phi4-mini, gemma3:1b"
        />
      ),
    },
    {
      key: 'slack-enabled',
      category: 'Slack',
      label: 'Enabled',
      description: 'Monitor Slack for emoji reactions',
      render: (config, update) => (
        <ToggleSwitch
          checked={config.slack?.enabled ?? false}
          onChange={(v) => update({ slack: { ...config.slack, enabled: v } } as Partial<BifrostConfig>)}
        />
      ),
    },
    {
      key: 'slack-clientId',
      category: 'Slack',
      label: 'Client ID',
      description: 'Slack app Client ID',
      render: (config, update) => (
        <input
          type="text"
          value={config.slack?.clientId ?? ''}
          onChange={(e) => update({ slack: { ...config.slack, clientId: e.target.value } } as Partial<BifrostConfig>)}
          className="bg-surface-alt border border-border-input rounded px-2 py-1 text-sm text-primary w-48 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
      ),
    },
    {
      key: 'slack-clientSecret',
      category: 'Slack',
      label: 'Client Secret',
      description: 'Slack app Client Secret',
      render: (config, update) => (
        <input
          type="password"
          value={config.slack?.clientSecret ?? ''}
          onChange={(e) => update({ slack: { ...config.slack, clientSecret: e.target.value } } as Partial<BifrostConfig>)}
          className="bg-surface-alt border border-border-input rounded px-2 py-1 text-sm text-primary w-48 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
      ),
    },
    {
      key: 'slack-connect',
      category: 'Slack',
      label: 'Connection',
      render: (config, update) => {
        if (config.slack?.userToken) {
          return (
            <div className="flex items-center gap-2">
              <span className="text-sm text-success">Connected ✓</span>
              <button
                onClick={async () => {
                  await window.bifrost.disconnectSlack();
                  const fresh = await window.bifrost.loadConfig();
                  update(fresh);
                }}
                className="text-xs text-danger hover:brightness-125 underline"
              >
                Disconnect
              </button>
            </div>
          );
        }
        return (
          <button
            onClick={async () => {
              try {
                await window.bifrost.startSlackOAuth();
                const fresh = await window.bifrost.loadConfig();
                update(fresh);
              } catch (err) {
                console.error('OAuth failed:', err);
              }
            }}
            disabled={!config.slack?.clientId || !config.slack?.clientSecret}
            className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Connect to Slack
          </button>
        );
      },
    },
    {
      key: 'slack-reactions',
      category: 'Slack',
      label: 'Reactions',
      description: 'Emoji names to watch for (without colons)',
      render: (config, update) => (
        <input
          type="text"
          value={(config.slack?.reactions ?? []).join(', ')}
          onChange={(e) => update({ slack: { ...config.slack, reactions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } } as Partial<BifrostConfig>)}
          className="bg-surface-alt border border-border-input rounded px-2 py-1 text-sm text-primary w-48 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          placeholder="bifrost, robot_face"
        />
      ),
    },
  ];
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-accent' : 'bg-surface-hover'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-5' : ''
        }`}
      />
    </button>
  );
}

export default function SettingsOverlay() {
  const { state, dispatch } = useApp();
  const overlayRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const config = state.config;
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>(CATEGORIES[0]);

  const settings = useMemo(() => buildSettings(), []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const close = () => dispatch({ type: 'TOGGLE_SETTINGS' });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        (e.target as HTMLElement).blur();
        overlayRef.current?.focus();
      } else {
        close();
      }
      return;
    }

    // Arrow keys navigate categories when not in an input
    const tag = (e.target as HTMLElement).tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const curIdx = visibleCategories.indexOf(activeCategory);
        const step = e.key === 'ArrowDown' ? 1 : visibleCategories.length - 1;
        const nextCat = visibleCategories[(curIdx + step) % visibleCategories.length];
        scrollToCategory(nextCat);
      }
    }
  };

  const updateConfig = async (updates: Partial<typeof config>) => {
    if (!config) return;
    const newConfig = { ...config, ...updates };
    await window.bifrost.saveConfig(newConfig);
    dispatch({ type: 'SET_CONFIG', config: newConfig });
  };

  const filteredSettings = useMemo(() => {
    if (!search.trim()) return settings;
    return settings.filter(
      (s) => matchesAllTerms(`${s.label} ${s.description ?? ''} ${s.category}`, search),
    );
  }, [settings, search]);

  const visibleCategories = useMemo(() => {
    if (search.trim()) {
      return [...new Set(filteredSettings.map((s) => s.category))];
    }
    return [...CATEGORIES];
  }, [filteredSettings, search]);

  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const scrollToCategory = (cat: string) => {
    setActiveCategory(cat);
    categoryRefs.current[cat]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (!config) return null;

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface rounded-lg border border-border-input w-[720px] flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <h2 className="text-sm font-semibold text-primary">Settings</h2>
          <div className="flex items-center gap-3">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search settings..."
              className="bg-surface-alt border border-border-input rounded px-2 py-1 text-sm text-primary placeholder-muted w-48 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
            <button
              onClick={close}
              tabIndex={-1}
              className="text-secondary hover:text-primary text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left nav */}
          <div className="w-[140px] flex-shrink-0 border-r border-border-default py-2">
            {visibleCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => scrollToCategory(cat)}
                className={`w-full text-left px-4 py-1.5 text-sm ${
                  activeCategory === cat
                    ? 'text-accent-hover bg-surface-alt/50'
                    : 'text-secondary hover:text-primary hover:bg-surface-alt/30'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Right pane */}
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {visibleCategories.map((cat) => {
              const catSettings = filteredSettings.filter((s) => s.category === cat);
              if (catSettings.length === 0) return null;
              return (
                <div key={cat} ref={(el) => { categoryRefs.current[cat] = el; }}>
                  <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-3">
                    {cat}
                  </h3>
                  <div className="space-y-4">
                    {catSettings.map((setting) => (
                      <div key={setting.key} className="flex items-start justify-between gap-4">
                        <div className="min-w-0 group/tip relative">
                          <label className="text-sm text-secondary flex items-center gap-1.5">
                            <Highlight text={setting.label} search={search} />
                            {setting.tooltip && (
                              <span className="text-faint hover:text-secondary cursor-help text-xs">&#9432;</span>
                            )}
                          </label>
                          {setting.description && (
                            <p className="text-xs text-muted"><Highlight text={setting.description} search={search} /></p>
                          )}
                          {setting.tooltip && (
                            <div className="hidden group-hover/tip:block absolute left-0 top-full mt-1 z-50 bg-app border border-border-input rounded px-3 py-2 shadow-lg w-96 whitespace-pre-line text-xs text-secondary leading-relaxed">
                              {setting.tooltip}
                            </div>
                          )}
                        </div>
                        {setting.render(config, updateConfig)}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 pb-3 pt-2 border-t border-border-default">
          <span className="text-xs text-faint">&uarr;&darr; categories &middot; type to search &middot; Esc close</span>
        </div>
      </div>
    </div>
  );
}
