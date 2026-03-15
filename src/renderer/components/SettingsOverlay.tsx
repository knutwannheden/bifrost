import React, { useMemo, useRef, useState } from 'react';
import { PROMPT_DEFS } from '../../shared/default-prompts';
import type { BifrostConfig } from '../../shared/types';
import { useApp } from '../context/AppContext';
import { useOverlayFocus } from '../hooks/useOverlayFocus';
import { TERMINAL_THEME_NAMES } from '../terminal-themes';
import { modSymbol } from '../utils/platform';
import { matchesAllTerms } from '../utils/search';
import FormInput from './FormInput';
import FormSelect from './FormSelect';
import FormTextarea from './FormTextarea';
import Highlight from './Highlight';
import OverlayFooter from './OverlayFooter';
import OverlayHeader from './OverlayHeader';
import PillToggle from './PillToggle';
import PrimaryButton from './PrimaryButton';
import SectionHeader from './SectionHeader';

interface SettingDef {
  key: string;
  category: string;
  label: string;
  description?: string;
  tooltip?: string;
  render: (config: BifrostConfig, update: (updates: Partial<BifrostConfig>) => void) => React.ReactNode;
}

const CATEGORIES = ['Appearance', 'Agent', 'General', 'Slack'] as const;

function buildSettings(): SettingDef[] {
  return [
    {
      key: 'theme',
      category: 'Appearance',
      label: 'Theme',
      tooltip: 'Choose between dark and light UI theme, or follow the system setting.',
      render: (config, update) => (
        <PillToggle
          options={[
            { label: 'System', value: 'system' },
            { label: 'Dark', value: 'dark' },
            { label: 'Light', value: 'light' },
          ]}
          value={config.theme}
          onChange={(v) => update({ theme: v as BifrostConfig['theme'] })}
        />
      ),
    },
    {
      key: 'terminalTheme',
      category: 'Appearance',
      label: 'Terminal Theme',
      tooltip: 'Color scheme for xterm.js terminals. Independent of the UI theme.',
      render: (config, update) => (
        <FormSelect
          value={config.terminalTheme}
          onChange={(e) => update({ terminalTheme: e.target.value })}
          className="px-2 py-1"
        >
          {TERMINAL_THEME_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </FormSelect>
      ),
    },
    {
      key: 'fontSize',
      category: 'Appearance',
      label: 'Font Size',
      tooltip: 'Terminal font size in pixels. Affects all task terminals and dev terminals.',
      render: (config, update) => (
        <div className="flex items-center gap-2">
          <button
            onClick={() => update({ fontSize: Math.max(8, config.fontSize - 1) })}
            className="w-7 h-7 flex items-center justify-center rounded-sm bg-surface-alt text-secondary hover:bg-surface-hover text-sm transition-colors"
          >
            -
          </button>
          <span className="text-sm text-primary w-6 text-center tabular-nums">{config.fontSize}</span>
          <button
            onClick={() => update({ fontSize: Math.min(32, config.fontSize + 1) })}
            className="w-7 h-7 flex items-center justify-center rounded-sm bg-surface-alt text-secondary hover:bg-surface-hover text-sm transition-colors"
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
        <FormSelect
          value={config.fontFamily}
          onChange={(e) => update({ fontFamily: e.target.value })}
          className="px-2 py-1"
        >
          {[
            { label: 'MesloLGS NF', value: 'MesloLGS NF' },
            { label: 'JetBrains Mono NF', value: 'JetBrainsMono Nerd Font' },
            { label: 'Fira Code NF', value: 'FiraCode Nerd Font' },
            { label: 'Hack NF', value: 'Hack Nerd Font' },
            { label: 'Menlo', value: 'Menlo' },
            { label: 'Monaco', value: 'Monaco' },
          ].map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </FormSelect>
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
      tooltip:
        'When enabled, background tasks that stop or need input trigger a system bell sound and a toast popup. Disable if you prefer to check task status manually.',
      render: (config, update) => (
        <ToggleSwitch checked={config.notifications !== false} onChange={(v) => update({ notifications: v })} />
      ),
    },
    {
      key: 'permissionMode',
      category: 'Agent',
      label: 'Permission Mode',
      tooltip:
        'Controls how Claude Code handles tool permissions.\n\nDefault: Claude asks before running tools that could modify files or execute commands.\n\nSandbox: Restricts file system and network access to a safe subset, reducing the need for manual approvals.\n\nSkip Permissions: Auto-approves all tool use without asking. Use with caution — Claude can run any command.',
      render: (config, update) => (
        <div className="flex flex-col gap-1.5 mt-1">
          {[
            { value: 'default' as const, label: 'Default' },
            { value: 'sandbox' as const, label: 'Sandbox', desc: 'restricts file and network access' },
            { value: 'skip-permissions' as const, label: 'Skip Permissions', desc: 'auto-approve all tool use' },
          ].map((opt) => (
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
      category: 'Agent',
      label: 'Manage permissions',
      description: 'Handle tool permission prompts in Bifrost instead of Claude Code',
      tooltip:
        'When enabled, tool permission prompts appear as a floating panel in Bifrost rather than in the terminal. You can allow/deny with keyboard shortcuts and persist rules across sessions.\n\nWhen disabled, Claude Code handles permissions natively in its own TUI.',
      render: (config, update) => (
        <ToggleSwitch checked={config.managePermissions} onChange={(v) => update({ managePermissions: v })} />
      ),
    },
    {
      key: 'hideTerminalOnSwitch',
      category: 'Agent',
      label: 'Hide terminal on switch',
      description: `${modSymbol}/ hides dev terminal when switching to Claude`,
      tooltip: `When you press ${modSymbol}/ to switch focus from the dev terminal to the Claude pane, this setting also hides the dev terminal to give Claude the full screen. Press ${modSymbol}/ again to bring it back.`,
      render: (config, update) => (
        <ToggleSwitch checked={config.hideTerminalOnSwitch} onChange={(v) => update({ hideTerminalOnSwitch: v })} />
      ),
    },
    {
      key: 'agentTeams',
      category: 'Agent',
      label: 'Agent Teams',
      description: 'Enable experimental agent teams feature',
      tooltip:
        'Sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 for new sessions. This enables Claude Code\u2019s built-in multi-agent coordination where subagents can run in parallel.',
      render: (config, update) => (
        <ToggleSwitch checked={config.agentTeams} onChange={(v) => update({ agentTeams: v })} />
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
      tooltip:
        'Shows a random keyboard shortcut or workflow tip on the welcome screen when no tasks are open. Click the tip to cycle through them.',
      render: (config, update) => (
        <ToggleSwitch checked={config.showTips !== false} onChange={(v) => update({ showTips: v })} />
      ),
    },
    {
      key: 'experimentalFeatures',
      category: 'General',
      label: 'Experimental features',
      description: 'Enable experimental features like Supervisor',
      tooltip:
        'When enabled, experimental features like the Supervisor (for headless note processing) become available.',
      render: (config, update) => (
        <ToggleSwitch checked={config.experimentalFeatures} onChange={(v) => update({ experimentalFeatures: v })} />
      ),
    },
    {
      key: 'ollamaModels',
      category: 'General',
      label: 'Ollama models',
      description: 'Models to try for task summarization, in priority order',
      tooltip:
        'Comma-separated list of ollama model names. Bifrost tries each in order for task summarization, falling back to Claude Haiku if none are available.',
      render: (config, update) => (
        <FormInput
          type="text"
          value={(config.ollamaModels ?? []).join(', ')}
          onChange={(e) =>
            update({
              ollamaModels: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          className="px-2 py-1 w-48"
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
        <FormInput
          type="text"
          value={config.slack?.clientId ?? ''}
          onChange={(e) => update({ slack: { ...config.slack, clientId: e.target.value } } as Partial<BifrostConfig>)}
          className="px-2 py-1 w-48"
        />
      ),
    },
    {
      key: 'slack-clientSecret',
      category: 'Slack',
      label: 'Client Secret',
      description: 'Slack app Client Secret',
      render: (config, update) => (
        <FormInput
          type="password"
          value={config.slack?.clientSecret ?? ''}
          onChange={(e) =>
            update({ slack: { ...config.slack, clientSecret: e.target.value } } as Partial<BifrostConfig>)
          }
          className="px-2 py-1 w-48"
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
          <PrimaryButton
            size="sm"
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
          >
            Connect to Slack
          </PrimaryButton>
        );
      },
    },
    {
      key: 'slack-reactions',
      category: 'Slack',
      label: 'Reactions',
      description: 'Emoji names to watch for (without colons)',
      render: (config, update) => (
        <FormInput
          type="text"
          value={(config.slack?.reactions ?? []).join(', ')}
          onChange={(e) =>
            update({
              slack: {
                ...config.slack,
                reactions: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
            } as Partial<BifrostConfig>)
          }
          className="px-2 py-1 w-48"
          placeholder="bifrost, robot_face"
        />
      ),
    },
  ];
}

function PromptEditor({
  config,
  updateConfig,
  selectedPrompt,
  setSelectedPrompt,
  search,
}: {
  config: BifrostConfig;
  updateConfig: (updates: Partial<BifrostConfig>) => void;
  selectedPrompt: string | null;
  setSelectedPrompt: (key: string | null) => void;
  search: string;
}) {
  const promptDefs = search.trim()
    ? PROMPT_DEFS.filter((p) => matchesAllTerms(`${p.name} ${p.description} Prompts`, search))
    : PROMPT_DEFS;
  const selected = PROMPT_DEFS.find((p) => p.key === selectedPrompt);
  const currentValue = selected ? config.prompts?.[selected.key] || '' : '';
  const isCustom = selected ? !!config.prompts?.[selected.key] : false;

  const handleSave = (value: string) => {
    if (!selected) return;
    const trimmed = value.trim();
    const prompts = { ...config.prompts };
    if (trimmed && trimmed !== selected.defaultValue.trim()) {
      prompts[selected.key] = trimmed;
    } else {
      delete prompts[selected.key];
    }
    updateConfig({ prompts });
  };

  const handleRevert = () => {
    if (!selected) return;
    const prompts = { ...config.prompts };
    delete prompts[selected.key];
    updateConfig({ prompts });
  };

  return (
    <div className="mt-6">
      <SectionHeader className="mb-2">Prompts</SectionHeader>
      <div className="border border-border-input rounded-sm overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            {promptDefs.map((p) => {
              const isActive = selectedPrompt === p.key;
              const hasCustom = !!config.prompts?.[p.key];
              return (
                <tr
                  key={p.key}
                  onClick={() => setSelectedPrompt(isActive ? null : p.key)}
                  className={`cursor-pointer transition-colors ${
                    isActive ? 'bg-surface-alt' : 'hover:bg-surface-hover'
                  }`}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-primary">
                        <Highlight text={p.name} search={search} />
                      </span>
                      {hasCustom && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-accent/20 text-accent">custom</span>
                      )}
                    </div>
                    <p className="text-xs text-muted">
                      <Highlight text={p.description} search={search} />
                    </p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selected && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-secondary">{selected.name} prompt</label>
            <button
              onClick={handleRevert}
              disabled={!isCustom}
              className="text-xs text-danger hover:brightness-125 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Revert to default
            </button>
          </div>
          <FormTextarea
            value={currentValue || selected.defaultValue}
            onChange={(e) => handleSave(e.target.value)}
            rows={12}
            className="w-full text-xs font-mono p-2 resize-y"
          />
        </div>
      )}
    </div>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
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
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);

  const settings = useMemo(() => buildSettings(), []);

  useOverlayFocus(searchRef);

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
    return settings.filter((s) => matchesAllTerms(`${s.label} ${s.description ?? ''} ${s.category}`, search));
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
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-hidden"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface rounded-lg border border-border-input w-[720px] flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <OverlayHeader title="Settings" onClose={close}>
          <FormInput
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings..."
            className="px-2 py-1 w-48"
          />
        </OverlayHeader>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left nav */}
          <div className="w-[140px] shrink-0 border-r border-border-default py-2">
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
                <div
                  key={cat}
                  ref={(el) => {
                    categoryRefs.current[cat] = el;
                  }}
                >
                  <SectionHeader className="mb-3">{cat}</SectionHeader>
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
                            <p className="text-xs text-muted">
                              <Highlight text={setting.description} search={search} />
                            </p>
                          )}
                          {setting.tooltip && (
                            <div className="hidden group-hover/tip:block absolute left-0 top-full mt-1 z-50 bg-app border border-border-input rounded-sm px-3 py-2 shadow-lg w-96 whitespace-pre-line text-xs text-secondary leading-relaxed">
                              {setting.tooltip}
                            </div>
                          )}
                        </div>
                        {setting.render(config, updateConfig)}
                      </div>
                    ))}
                  </div>
                  {cat === 'Agent' &&
                    (!search.trim() ||
                      PROMPT_DEFS.some((p) => matchesAllTerms(`${p.name} ${p.description} Prompts`, search))) && (
                      <PromptEditor
                        config={config}
                        updateConfig={updateConfig}
                        selectedPrompt={selectedPrompt}
                        setSelectedPrompt={setSelectedPrompt}
                        search={search}
                      />
                    )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <OverlayFooter>
          <span className="text-xs text-faint">&uarr;&darr; categories &middot; type to search &middot; Esc close</span>
        </OverlayFooter>
      </div>
    </div>
  );
}
