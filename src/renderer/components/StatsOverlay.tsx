import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { StatsData, ContextRotEntry, EscalationEntry } from '../../shared/types';

type TabId = 'tool-usage' | 'skill-usage' | 'bash-commands' | 'context-rot' | 'tail-escalation';
type TimeRange = '24h' | 'week' | 'all';

const TABS: { id: TabId; label: string }[] = [
  { id: 'skill-usage', label: 'Skills' },
  { id: 'tool-usage', label: 'Tools' },
  { id: 'bash-commands', label: 'Bash' },
  { id: 'context-rot', label: 'Output' },
  { id: 'tail-escalation', label: 'Escalation' },
];

const TIME_RANGES: { id: TimeRange; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: 'week', label: 'Week' },
  { id: 'all', label: 'All' },
];

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
    if (done) return <div className="px-4 py-8 text-sm text-slate-500 text-center">No data found</div>;
    return <div className="px-4 py-8 text-sm text-slate-500 text-center">Scanning...</div>;
  }

  const maxCount = entries[0].count;
  const total = entries.reduce((sum, e) => sum + e.count, 0);

  return (
    <div className="p-3 space-y-1">
      {entries.map((entry) => {
        const pct = (entry.count / maxCount) * 100;
        return (
          <div key={entry.name} className="flex items-center gap-2">
            <div className="flex-1 h-5 bg-slate-700/50 rounded overflow-hidden relative">
              <div
                className="h-full bg-indigo-500 rounded"
                style={{ width: `${pct}%` }}
              />
              <span className="absolute inset-0 flex items-center px-1.5 text-[11px] text-slate-200 truncate pointer-events-none">
                {entry.name}
              </span>
            </div>
            <span className="text-xs text-right text-slate-400 tabular-nums shrink-0">{entry.count}</span>
            <span className="text-xs w-8 text-right text-slate-500 tabular-nums shrink-0">
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
    if (done) return <div className="px-4 py-8 text-sm text-slate-500 text-center">No data found</div>;
    return <div className="px-4 py-8 text-sm text-slate-500 text-center">Scanning...</div>;
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
            className="cursor-pointer hover:bg-slate-700/30 rounded px-1 -mx-1"
            onClick={() => toggle(entry.name)}
          >
            <div className="flex items-center gap-2">
              <div className="flex-1 h-5 bg-slate-700/50 rounded overflow-hidden relative">
                <div
                  className="h-full bg-cyan-600 rounded"
                  style={{ width: `${pct}%` }}
                />
                <span className="absolute inset-0 flex items-center px-1.5 text-[11px] text-slate-200 truncate pointer-events-none">
                  {entry.name}
                </span>
              </div>
              <span className="text-xs text-right text-slate-400 tabular-nums shrink-0 w-16">
                {formatBytes(entry.totalBytes)}
              </span>
              <span className="text-xs text-right text-slate-500 tabular-nums shrink-0 w-14">
                {entry.count.toLocaleString()}x
              </span>
              <span className="text-xs text-right text-slate-500 tabular-nums shrink-0 w-16">
                avg {formatBytes(entry.avgBytes)}
              </span>
            </div>
            {isExpanded && (
              <div className="text-[11px] text-slate-300 whitespace-pre-wrap break-all py-1 px-1.5">
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
    if (done) return <div className="px-4 py-8 text-sm text-slate-500 text-center">No data found</div>;
    return <div className="px-4 py-8 text-sm text-slate-500 text-center">Scanning...</div>;
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
            className="cursor-pointer hover:bg-slate-700/30 rounded px-1 -mx-1"
            onClick={() => toggle(entry.command)}
          >
            <div className="flex items-center gap-2 py-0.5">
              <span className={`flex-1 text-[11px] text-slate-200 ${isExpanded ? 'whitespace-pre-wrap break-all' : 'truncate'}`}>
                {entry.command}
              </span>
              <span className="text-xs text-slate-400 tabular-nums shrink-0 w-20 text-right">
                {entry.clusters} cluster{entry.clusters !== 1 ? 's' : ''}
              </span>
              <span className="text-xs text-amber-400 tabular-nums shrink-0 w-20 text-right font-medium">
                {entry.wastedRuns} wasted
              </span>
              <span className="text-xs text-slate-500 tabular-nums shrink-0 w-16 text-right">
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
  const { dispatch } = useApp();
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

  const barEntries = getTabEntries(data, activeTab);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[560px] flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`text-sm px-2 py-0.5 rounded ${
                  activeTab === tab.id
                    ? 'bg-slate-700 text-slate-200'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
            {!done && (
              <svg className="animate-spin h-3.5 w-3.5 text-slate-400 ml-2" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
          </div>
          <div className="flex items-center gap-0.5 bg-slate-700/50 rounded px-0.5 py-0.5">
            {TIME_RANGES.map((r) => (
              <button
                key={r.id}
                className={`text-xs px-1.5 py-0.5 rounded ${
                  timeRange === r.id
                    ? 'bg-slate-600 text-slate-200'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                onClick={() => setTimeRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={close}
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none ml-2"
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
