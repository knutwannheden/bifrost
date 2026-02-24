import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { StatsData } from '../../shared/types';

type TabId = 'tool-usage' | 'skill-usage' | 'bash-commands';

const TABS: { id: TabId; label: string }[] = [
  { id: 'skill-usage', label: 'Skills' },
  { id: 'tool-usage', label: 'Tools' },
  { id: 'bash-commands', label: 'Bash' },
];

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

function getTabEntries(data: StatsData, tab: TabId): { name: string; count: number }[] {
  switch (tab) {
    case 'tool-usage':
      return data.toolUsage.map((e) => ({ name: e.tool, count: e.count }));
    case 'skill-usage':
      return data.skillUsage.map((e) => ({ name: e.skill, count: e.count }));
    case 'bash-commands':
      return data.bashCommands.map((e) => ({ name: e.command, count: e.count }));
  }
}

const emptyStats: StatsData = { skillUsage: [], toolUsage: [], bashCommands: [] };

export default function StatsOverlay() {
  const { dispatch } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabId>('skill-usage');
  const [data, setData] = useState<StatsData>(emptyStats);
  const [done, setDone] = useState(false);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    const unsub = window.bifrost.onStatsUpdate(setData);
    window.bifrost.getStats().then(() => setDone(true));
    return unsub;
  }, []);

  const close = () => dispatch({ type: 'TOGGLE_STATS' });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const entries = getTabEntries(data, activeTab);

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
          <BarChart entries={entries} done={done} />
        </div>
      </div>
    </div>
  );
}
