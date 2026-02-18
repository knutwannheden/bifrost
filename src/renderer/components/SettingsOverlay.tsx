import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import type { BifrostConfig } from '../../shared/types';

interface SettingDef {
  key: string;
  category: string;
  label: string;
  description?: string;
  tooltip?: string;
  render: (config: BifrostConfig, update: (updates: Partial<BifrostConfig>) => void) => React.ReactNode;
}

const CATEGORIES = ['Appearance', 'Claude Code', 'General'] as const;

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
            className="w-7 h-7 flex items-center justify-center rounded bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm"
          >
            -
          </button>
          <span className="text-sm text-slate-200 w-6 text-center font-mono">{config.fontSize}</span>
          <button
            onClick={() => update({ fontSize: Math.min(32, config.fontSize + 1) })}
            className="w-7 h-7 flex items-center justify-center rounded bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm"
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
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
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
            className="w-24 accent-blue-500"
          />
          <span className="text-sm text-slate-200 w-6 text-center font-mono">{config.fontWeight}</span>
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
                className="mt-0.5 accent-blue-500"
              />
              <span className="text-sm text-slate-300 group-hover:text-slate-200">
                {opt.label}
                {opt.desc && <span className="text-slate-500"> — {opt.desc}</span>}
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
      description: '\u2318/ hides dev terminal when switching to Claude',
      tooltip: 'When you press \u2318/ to switch focus from the dev terminal to the Claude pane, this setting also hides the dev terminal to give Claude the full screen. Press \u2318/ again to bring it back.',
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
      tooltip: 'Which IDE to open when you press \u2318O. VS Code uses the "code" CLI, IntelliJ uses the "idea" CLI. The IDE opens the task\u2019s worktree directory.',
      render: (config, update) => (
        <div className="flex gap-1">
          {(['code', 'idea'] as const).map((ide) => (
            <button
              key={ide}
              onClick={() => update({ ide })}
              className={`px-3 py-1 text-xs rounded ${
                config.ide === ide
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {ide === 'code' ? 'VS Code' : 'IntelliJ'}
            </button>
          ))}
        </div>
      ),
    },
    {
      key: 'groupHistoryByRepo',
      category: 'General',
      label: 'Group history by repo',
      description: 'Group tasks by repository in history view',
      tooltip: 'When enabled, the task history panel (\u2318H) organizes archived tasks under collapsible repository headings instead of a flat chronological list.',
      render: (config, update) => (
        <ToggleSwitch
          checked={config.groupHistoryByRepo}
          onChange={(v) => update({ groupHistoryByRepo: v })}
        />
      ),
    },
    {
      key: 'localWorktrees',
      category: 'General',
      label: 'Local worktrees',
      description: 'Create worktrees inside the repo directory (.worktrees/)',
      tooltip: 'By default, worktrees are created in a sibling directory next to your repo. With this enabled, they go into a .worktrees/ folder inside the repo instead.\n\nUseful when your IDE or tools expect everything under one root directory. Make sure to add .worktrees/ to your .gitignore.',
      render: (config, update) => (
        <ToggleSwitch
          checked={config.localWorktrees}
          onChange={(v) => update({ localWorktrees: v })}
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
  ];
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-blue-600' : 'bg-slate-600'
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
      close();
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
    const q = search.toLowerCase();
    return settings.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        (s.description && s.description.toLowerCase().includes(q)) ||
        s.category.toLowerCase().includes(q),
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
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}
        className="bg-slate-800 rounded-lg border border-slate-600 w-[720px] flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Settings</h2>
          <div className="flex items-center gap-3">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search settings..."
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 placeholder-slate-500 w-48 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={close}
              tabIndex={-1}
              className="text-slate-400 hover:text-slate-200 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left nav */}
          <div className="w-[140px] flex-shrink-0 border-r border-slate-700 py-2">
            {visibleCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => scrollToCategory(cat)}
                className={`w-full text-left px-4 py-1.5 text-sm ${
                  activeCategory === cat
                    ? 'text-blue-400 bg-slate-700/50'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/30'
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
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                    {cat}
                  </h3>
                  <div className="space-y-4">
                    {catSettings.map((setting) => (
                      <div key={setting.key} className="flex items-start justify-between gap-4">
                        <div className="min-w-0 group/tip relative">
                          <label className="text-sm text-slate-300 flex items-center gap-1.5">
                            {setting.label}
                            {setting.tooltip && (
                              <span className="text-slate-600 hover:text-slate-400 cursor-help text-xs">&#9432;</span>
                            )}
                          </label>
                          {setting.description && (
                            <p className="text-xs text-slate-500">{setting.description}</p>
                          )}
                          {setting.tooltip && (
                            <div className="hidden group-hover/tip:block absolute left-0 top-full mt-1 z-50 bg-slate-900 border border-slate-600 rounded px-3 py-2 shadow-lg w-96 whitespace-pre-line text-xs text-slate-300 leading-relaxed">
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
        <div className="flex justify-end px-4 py-2 border-t border-slate-700">
          <span className="text-xs text-slate-500">{'\u2318'}, to close</span>
        </div>
      </div>
    </div>
  );
}
