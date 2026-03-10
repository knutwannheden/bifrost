import React, { useEffect, useRef, useState } from 'react';
import type { ContextRotEntry, EscalationEntry, StatsData } from '../../shared/types';
import { useApp } from '../context/AppContext';
import FlaskIcon from './FlaskIcon';
import OverlayFooter from './OverlayFooter';
import OverlayHeader from './OverlayHeader';
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
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
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
            <div className="flex-1 h-5 bg-surface-alt/50 rounded-sm overflow-hidden relative">
              <div className="h-full bg-accent rounded-sm" style={{ width: `${pct}%` }} />
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
      if (next.has(name)) next.delete(name);
      else next.add(name);
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
            className="cursor-pointer hover:bg-surface-alt/30 rounded-sm px-1 -mx-1"
            onClick={() => toggle(entry.name)}
          >
            <div className="flex items-center gap-2">
              <div className="flex-1 h-5 bg-surface-alt/50 rounded-sm overflow-hidden relative">
                <div className="h-full bg-accent-hover rounded-sm" style={{ width: `${pct}%` }} />
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
              <div className="text-[11px] text-secondary whitespace-pre-wrap break-all py-1 px-1.5">{entry.name}</div>
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
      if (next.has(cmd)) next.delete(cmd);
      else next.add(cmd);
      return next;
    });

  return (
    <div className="p-3 space-y-1">
      {entries.map((entry) => {
        const isExpanded = expanded.has(entry.command);
        return (
          <div
            key={entry.command}
            className="cursor-pointer hover:bg-surface-alt/30 rounded-sm px-1 -mx-1"
            onClick={() => toggle(entry.command)}
          >
            <div className="flex items-center gap-2 py-0.5">
              <span
                className={`flex-1 text-[11px] text-primary ${isExpanded ? 'whitespace-pre-wrap break-all' : 'truncate'}`}
              >
                {entry.command}
              </span>
              <span className="text-xs text-secondary tabular-nums shrink-0 w-20 text-right">
                {entry.clusters} cluster{entry.clusters !== 1 ? 's' : ''}
              </span>
              <span className="text-xs text-warning tabular-nums shrink-0 w-20 text-right font-medium">
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
  skillUsage: [],
  toolUsage: [],
  bashCommands: [],
  contextRot: [],
  tailEscalation: [],
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
      return;
    }

    // Tab/Shift+Tab: cycle through tabs
    if (e.key === 'Tab') {
      e.preventDefault();
      const curIdx = visibleTabs.findIndex((t) => t.id === activeTab);
      const step = e.shiftKey ? visibleTabs.length - 1 : 1;
      setActiveTab(visibleTabs[(curIdx + step) % visibleTabs.length].id);
      return;
    }

    // Arrow Left/Right: cycle time ranges
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const curIdx = TIME_RANGES.findIndex((r) => r.id === timeRange);
      const step = e.key === 'ArrowLeft' ? TIME_RANGES.length - 1 : 1;
      setTimeRange(TIME_RANGES[(curIdx + step) % TIME_RANGES.length].id);
      return;
    }
  };

  const visibleTabs = TABS.filter((tab) => !tab.experimental || experimental);
  const barEntries = getTabEntries(data, activeTab);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay focus:outline-hidden"
      onClick={close}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        className="bg-surface rounded-lg border border-border-input w-[560px] flex flex-col shadow-xl max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <OverlayHeader title="Stats" onClose={close}>
          <div className="flex items-center gap-1">
            <PillToggle
              options={visibleTabs.map((tab) => ({
                value: tab.id,
                label: (
                  <>
                    {tab.label}
                    {tab.experimental && <FlaskIcon />}
                  </>
                ),
              }))}
              value={activeTab}
              onChange={(v) => setActiveTab(v)}
            />
            {!done && <Spinner size="sm" className="ml-2" />}
          </div>
          <div className="bg-surface-alt/50 rounded-sm px-0.5 py-0.5">
            <PillToggle options={timeRangeOptions} value={timeRange} onChange={(v) => setTimeRange(v)} />
          </div>
        </OverlayHeader>

        {/* Content */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {barEntries !== null && <BarChart entries={barEntries} done={done} />}
          {activeTab === 'context-rot' && (
            <OutputChart entries={data.contextRot.filter((e) => e.totalBytes >= 1000)} done={done} />
          )}
          {activeTab === 'tail-escalation' && (
            <EscalationTable entries={data.tailEscalation.filter((e) => e.wastedRuns >= 2)} done={done} />
          )}
        </div>

        {/* Footer */}
        <OverlayFooter>
          <span className="text-xs text-faint">
            Tab/&#8679;Tab tabs &middot; &larr;&rarr; time range &middot; Esc close
          </span>
        </OverlayFooter>
      </div>
    </div>
  );
}
