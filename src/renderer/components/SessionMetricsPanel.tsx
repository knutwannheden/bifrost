import type { SessionMetricEntry, SessionMetricsResult } from '../../shared/types';
import Spinner from './Spinner';

const flagColors: Record<string, string> = {
  ok: 'text-muted',
  warn: 'text-warning',
  critical: 'text-danger',
};

const flagMarkers: Record<string, string> = {
  ok: ' ',
  warn: '!',
  critical: 'X',
};

function formatValue(name: string, value: number): string {
  if (name === 'timeToFirstCorrectFile' || name === 'editWithoutReadRate' || name === 'toolErrorRate') {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (name === 'humanCorrectionDensity') return `${value.toFixed(1)} / 100 calls`;
  if (name === 'fileFocusScore') return `${Math.round(value)} files/window`;
  if (name === 'costPerDiffLine') return `${Math.round(value)} tokens/line`;
  return `${Math.round(value)}`;
}

function ZScoreBar({ z }: { z: number }) {
  // Visual bar showing where the z-score falls: negative=left, positive=right
  const clamped = Math.max(-3, Math.min(3, z));
  const pct = ((clamped + 3) / 6) * 100;
  const isHigh = z > 1;
  const isLow = z < -1;
  const color = isHigh ? 'bg-warning' : isLow ? 'bg-accent-hover' : 'bg-secondary/40';

  return (
    <div className="relative w-20 h-3 bg-surface-alt rounded-sm overflow-hidden" title={`z=${z.toFixed(2)}`}>
      {/* Center line */}
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border-default" />
      {/* Marker */}
      <div
        className={`absolute top-0.5 bottom-0.5 w-1.5 rounded-sm ${color}`}
        style={{ left: `calc(${pct}% - 3px)` }}
      />
    </div>
  );
}

function MetricRow({ entry }: { entry: SessionMetricEntry }) {
  const color = flagColors[entry.flag];
  const marker = flagMarkers[entry.flag];

  return (
    <div className="flex items-center gap-3 py-1">
      <span className={`w-4 text-center font-mono text-xs ${color}`}>{marker === ' ' ? '' : marker}</span>
      <span className="text-secondary text-xs w-44 truncate">{entry.label}</span>
      <span className="font-mono text-xs text-primary w-32 text-right">{formatValue(entry.name, entry.value)}</span>
      <ZScoreBar z={entry.zScore} />
      <span className="font-mono text-xs text-faint w-12 text-right">{entry.zScore.toFixed(1)}</span>
    </div>
  );
}

function BacktrackDetail({ files }: { files: Array<{ filePath: string; count: number }> }) {
  if (files.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="text-xs font-semibold text-secondary uppercase tracking-wider mb-2">Top Thrashing Files</div>
      <div className="space-y-0.5">
        {files.map((f) => (
          <div key={f.filePath} className="flex items-center gap-2 text-xs">
            <span className="text-warning font-mono">{f.count}x</span>
            <span className="text-primary font-mono truncate">{f.filePath}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SessionMetricsPanel({
  data,
  loading,
  error,
}: {
  data: SessionMetricsResult;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-secondary">
        <Spinner />
        <span>Computing metrics...</span>
      </div>
    );
  }

  if (error) {
    return <div className="text-sm text-danger">Error: {error}</div>;
  }

  if (data.metrics.length === 0) {
    return <div className="text-sm text-muted">No metrics available — session may be too short.</div>;
  }

  return (
    <div className="max-w-2xl">
      {/* Cluster assignment */}
      {data.cluster && (
        <div className="mb-4 flex items-center gap-3">
          <span className="px-2 py-0.5 rounded-sm bg-accent/15 text-accent-hover text-xs font-semibold">
            {data.cluster.label}
          </span>
          <span className="text-xs text-faint">
            distance {data.cluster.distances[data.cluster.index].toFixed(1)}
            {data.cluster.distances.length > 1 &&
              ` · nearest other ${Math.min(...data.cluster.distances.filter((_, i) => i !== data.cluster!.index)).toFixed(1)}`}
          </span>
        </div>
      )}

      {/* Metrics table */}
      <div className="mb-2">
        <div className="flex items-center gap-3 pb-1 border-b border-border-default text-xs text-faint">
          <span className="w-4" />
          <span className="w-44">Metric</span>
          <span className="w-32 text-right">Value</span>
          <span className="w-20 text-center">z-score</span>
          <span className="w-12" />
        </div>
        {data.metrics.map((entry) => (
          <MetricRow key={entry.name} entry={entry} />
        ))}
      </div>

      {/* Backtrack detail */}
      <BacktrackDetail files={data.backtrackDetail} />
    </div>
  );
}
