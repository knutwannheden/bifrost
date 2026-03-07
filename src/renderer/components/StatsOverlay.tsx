import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { StatsData, ContextRotEntry, EscalationEntry } from '../../shared/types';
import PillToggle, { type PillOption } from './PillToggle';
import Spinner from './Spinner';

type TabId = 'tool-usage' | 'skill-usage' | 'bash-commands' | 'context-rot' | 'tail-escalation';
type TimeRange = '24h' | 'week' | 'all';

const TABS: { id: TabId; label: string; experimental?: boolean }[] = [
  { id: 'skill-usage', label: 'Skills' },
  { id: 'tool-usage', label: 'Tools', experimental: true },
  { id: 'bash-commands', label: 'Bash', experimental: true },
  { id: 'context-rot', label: 'Output', experimental: true },
  { id: 'tail-escalation', label: 'Escalation', experimental: true },
];

const TIME_RANGES: { id: TimeRange; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: 'week', label: 'Week' },
  { id: 'all', label: 'All' },
];

const timeRangeOptions: PillOption<TimeRange>[] = TIME_RANGES.map((r) => ({
  value: r.id,
  label: r.label,
}));

function sinceForRange(range: TimeRange): number | undefined {
  if (range === '24h') return Date.now() - 24 * 60 * 60 * 1000;
  if (range === 'week') return Date.now() - 7 * 24 * 60 * 60 * 1000;
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + ' GB';
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB';
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB';
  return bytes + ' B';
}

function BarChart({ entries, done }: { entries: { name: string; count: number }[]; done: boolean }) {
  if (entries.length === 0) {
    if (done) return <div className="px-4 py-8 text-sm text-muted text-center">No data found</div>;
    return <div className="px-4 py-8 text-sm text-muted text-center">Scanning...</div>;
  }

  const maxCount = entries[0].count;
  const total = entries.reduce((sum, e) => sum + e.count, 0);

  return (
    <div className="p-3 space-y-1">
      {entries.map((entry) => {
        const pct = (entry.count / maxCount) * 100;
        return (
          <div key={entry.name} className="flex items-center gap-2">
            <div className="flex-1 h-5 bg-surface-alt/50 rounded overflow-hidden relative">
              <div
                className="h-full bg-indigo-500 rounded"
                style={{ width: `${pct}%` }}
              />
              <span className="absolute inset-0 flex items-center px-1.5 text-[11px] text-primary truncate pointer-events-none">
                {entry.name}
              </span>
            </div>
            <span className="text-xs text-right text-secondary tabular-nums shrink-0">{entry.count}</span>
            <span className="text-xs w-8 text-right text-muted tabular-nums shrink-0">
              {((entry.count / total) * 100).toFixed(0)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function OutputChart({ entries, done }: { entries: ContextRotEntry[]; done: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (entries.length === 0) {
    if (done) return <div className="px-4 py-8 text-sm text-muted text-center">No data found</div>;
    return <div className="px-4 py-8 text-sm text-muted text-center">Scanning...</div>;
  }

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });

  const maxBytes = entries[0].totalBytes;

  return (
    <div className="p-3 space-y-1">
      {entries.map((entry) => {
        const pct = (entry.totalBytes / maxBytes) * 100;
        const isExpanded = expanded.has(entry.name);
        return (
          <div
            key={entry.name}
            className="cursor-pointer hover:bg-surface-alt/30 rounded px-1 -mx-1"
            onClick={() => toggle(entry.name)}
          >
            <div className="flex items-center gap-2">
              <div className="flex-1 h-5 bg-surface-alt/50 rounded overflow-hidden relative">
                <div
                  className="h-full bg-cyan-600 rounded"
                  style={{ width: `${pct}%` }}
                />
                <span className="absolute inset-0 flex items-center px-1.5 text-[11px] text-primary truncate pointer-events-none">
                  {entry.name}
                </span>
              </div>
              <span className="text-xs text-right text-secondary tabular-nums shrink-0 w-16">
                {formatBytes(entry.totalBytes)}
              </span>
              <span className="text-xs text-right text-muted tabular-nums shrink-0 w-14">
                {entry.count.toLocaleString()}x
              </span>
              <span className="text-xs text-right text-muted tabular-nums shrink-0 w-16">
                avg {formatBytes(entry.avgBytes)}
              </span>
            </div>
            {isExpanded && (
              <div className="text-[11px] text-secondary whitespace-pre-wrap break-all py-1 px-1.5">
                {entry.name}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EscalationTable({ entries, done }: { entries: EscalationEntry[]; done: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (entries.length === 0) {
    if (done) return <div className="px-4 py-8 text-sm text-muted text-center">No data found</div>;
    return <div className="px-4 py-8 text-sm text-muted text-center">Scanning...</div>;
  }

  const toggle = (cmd: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cmd)) next.delete(cmd); else next.add(cmd);
      return next;
    });

  return (
    <div className="p-3 space-y-1">
      {entries.map((entry) => {
        const isExpanded = expanded.has(entry.command);
        return (
          <div
            key={entry.command}
            className="cursor-pointer hover:bg-surface-alt/30 rounded px-1 -mx-1"
            onClick={() => toggle(entry.command)}
          >
            <div className="flex items-center gap-2 py-0.5">
              <span className={`flex-1 text-[11px] text-primary ${isExpanded ? 'whitespace-pre-wrap break-all' : 'truncate'}`}>
                {entry.command}
              </span>
              <span className="text-xs text-secondary tabular-nums shrink-0 w-20 text-right">
                {entry.clusters} cluster{entry.clusters !== 1 ? 's' : ''}
              </span>
              <span className="text-xs text-amber-400 tabular-nums shrink-0 w-20 text-right font-medium">
                {entry.wastedRuns} wasted
              </span>
              <span className="text-xs text-muted tabular-nums shrink-0 w-16 text-right">
                worst: {entry.worstCluster}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getTabEntries(data: StatsData, tab: TabId): { name: string; count: number }[] | null {
  switch (tab) {
    case 'tool-usage':
      return data.toolUsage.map((e) => ({ name: e.tool, count: e.count }));
    case 'skill-usage':
      return data.skillUsage.map((e) => ({ name: e.skill, count: e.count }));
    case 'bash-commands':
      return data.bashCommands.map((e) => ({ name: e.command, count: e.count }));
    default:
      return null;
  }
}

const emptyStats: StatsData = {
  skillUsage: [], toolUsage: [], bashCommands: [],
  contextRot: [], tailEscalation: [],
};

export default function StatsOverlay() {
  const { state, dispatch } = useApp();
  const experimental = state.config?.experimentalFeatures ?? false;
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabId>('skill-usage');
  const [timeRange, setTimeRange] = useState<TimeRange>('week');
  const [data, setData] = useState<StatsData>(emptyStats);
  const [done, setDone] = useState(false);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    setData(emptyStats);
    setDone(false);
    const unsub = window.bifrost.onStatsUpdate(setData);
    window.bifrost.getStats(sinceForRange(timeRange)).then(() => setDone(true));
    return unsub;
  }, [timeRange]);

  const close = () => dispatch({ type: 'TOGGLE_STATS' });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const visibleTabs = TABS.filter((tab) => !tab.experimental || experimental);
  const barEntries = getTabEntries(data, activeTab);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        className="bg-surface rounded-lg border border-border-input w-[560px] flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <div className="flex items-center gap-1">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                className={`text-sm px-2 py-0.5 rounded flex items-center gap-1 ${
                  activeTab === tab.id
                    ? 'bg-surface-hover text-primary'
                    : 'text-secondary hover:text-primary hover:bg-surface-alt'
                }`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
                {tab.experimental && (
                  <svg width="10" height="10" viewBox="0 0 16 16" className="text-green-400 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <path d="M6 1h4v1H9v4l3.5 6.5a1 1 0 0 1-.9 1.5H4.4a1 1 0 0 1-.9-1.5L7 6V2H6V1z" />
                    <path d="M5.5 10.5L7.5 7h1l2 3.5a1 1 0 0 1-.9 1.5H6.4a1 1 0 0 1-.9-1.5z" fill="currentColor" opacity="0.5" stroke="none" />
                  </svg>
                )}
              </button>
            ))}
            {!done && (
              <Spinner size="sm" className="ml-2" />
            )}
          </div>
          <div className="bg-surface-alt/50 rounded px-0.5 py-0.5">
            <PillToggle options={timeRangeOptions} value={timeRange} onChange={(v) => setTimeRange(v)} />
          </div>
          <button
            onClick={close}
            tabIndex={-1}
            className="text-secondary hover:text-primary text-lg leading-none ml-2"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {barEntries !== null && <BarChart entries={barEntries} done={done} />}
          {activeTab === 'context-rot' && <OutputChart entries={data.contextRot.filter((e) => e.totalBytes >= 1000)} done={done} />}
          {activeTab === 'tail-escalation' && <EscalationTable entries={data.tailEscalation.filter((e) => e.wastedRuns >= 2)} done={done} />}
        </div>
      </div>
    </div>
  );
}
