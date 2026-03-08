import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TokenDataPoint, TokenTurnType } from '../../shared/types';
import PillToggle, { type PillOption } from './PillToggle';
import Spinner from './Spinner';

type ChartMode = 'per-turn' | 'cumulative';

const modeOptions: PillOption<ChartMode>[] = [
  { value: 'per-turn', label: 'Per Turn' },
  { value: 'cumulative', label: 'Cumulative' },
];

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

/** Total input tokens including cached */
function totalInput(d: TokenDataPoint): number {
  return d.inputTokens + d.cacheReadTokens + d.cacheCreationTokens;
}

/** Per-turn-type color pairs (input bar, output bar) */
const TURN_COLORS: Record<TokenTurnType, { input: string; output: string }> = {
  user: { input: '#60a5fa', output: '#93c5fd' }, // blue
  tool: { input: '#f59e0b', output: '#fcd34d' }, // amber
  plan: { input: '#a78bfa', output: '#c4b5fd' }, // violet
  agent: { input: '#34d399', output: '#6ee7b7' }, // emerald
};

export default function TokenUsageChart({
  data,
  loading,
  error,
}: {
  data: TokenDataPoint[];
  loading: boolean;
  error: string | null;
}) {
  const [mode, setMode] = useState<ChartMode>('per-turn');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgSize, setSvgSize] = useState({ w: 800, h: 256 });

  // Synchronous measurement after every render to catch layout changes
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 0 && height > 0)
      setSvgSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  });

  // ResizeObserver for external resizes (window resize, panel toggle)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setSvgSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chartPadding = { top: 20, right: 12, bottom: 40, left: 48 };
  const chartW = svgSize.w - chartPadding.left - chartPadding.right;
  const chartH = svgSize.h - chartPadding.top - chartPadding.bottom;

  const cumulativeData = useMemo(() => {
    let outputSum = 0;
    return data.map((p) => {
      outputSum += p.outputTokens;
      return { ...p, cumulativeOutput: outputSum, contextSize: totalInput(p) };
    });
  }, [data]);

  const startTime = data.length > 0 ? data[0].timestamp : 0;

  const findClosestIndex = useCallback(
    (clientX: number): number | null => {
      if (data.length === 0 || !svgRef.current) return null;

      const rect = svgRef.current.getBoundingClientRect();
      // viewBox matches pixel size so coordinate conversion is 1:1
      const mouseX = clientX - rect.left - chartPadding.left;

      if (mouseX < 0 || mouseX > chartW) return null;

      let closestIdx = 0;
      let closestDist = Number.POSITIVE_INFINITY;
      const barGroupWidth = chartW / data.length;
      for (let i = 0; i < data.length; i++) {
        const x =
          mode === 'per-turn'
            ? (i + 0.5) * barGroupWidth
            : ((data[i].timestamp - startTime) / Math.max(data[data.length - 1].timestamp - startTime, 1)) * chartW;
        const dist = Math.abs(mouseX - x);
        if (dist < closestDist) {
          closestDist = dist;
          closestIdx = i;
        }
      }
      return closestIdx;
    },
    [data, mode, startTime, chartPadding.left, chartW],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      setHoveredIndex(findClosestIndex(e.clientX));
    },
    [findClosestIndex],
  );

  const handleMouseLeave = useCallback(() => setHoveredIndex(null), []);

  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const idx = findClosestIndex(e.clientX);
      setSelectedIndex((prev) => (prev === idx ? null : idx));
    },
    [findClosestIndex],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (data.length === 0) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev === null ? data.length - 1 : Math.max(0, prev - 1)));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev === null ? 0 : Math.min(data.length - 1, prev + 1)));
      } else if (e.key === 'Escape') {
        setSelectedIndex(null);
      }
    },
    [data.length],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-secondary p-4">
        <Spinner />
        <span>Loading token usage...</span>
      </div>
    );
  }

  if (error) {
    return <div className="text-sm text-danger p-4">Error: {error}</div>;
  }

  if (data.length === 0) {
    return <div className="text-sm text-muted text-center py-4">No token usage data yet</div>;
  }

  const detailPoint = selectedIndex !== null ? data[selectedIndex] : null;
  const detailCumulative = selectedIndex !== null ? cumulativeData[selectedIndex] : null;

  return (
    <div className="flex flex-col h-full focus:outline-none" tabIndex={-1} onKeyDown={handleKeyDown}>
      <div className="flex items-center gap-4 px-4 py-2 flex-shrink-0">
        <PillToggle options={modeOptions} value={mode} onChange={(v) => setMode(v)} size="sm" />
        <div className="flex items-center gap-4 text-xs text-secondary ml-auto">
          {mode === 'per-turn'
            ? (Object.keys(TURN_COLORS) as TokenTurnType[])
                .filter((tt) => data.some((d) => d.turnType === tt))
                .map((tt) => (
                  <span key={tt} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-3 h-2 rounded-sm"
                      style={{ backgroundColor: TURN_COLORS[tt].input }}
                    />
                    {tt[0].toUpperCase() + tt.slice(1)}
                  </span>
                ))
            : [
                <span key="ctx" className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-0.5" style={{ backgroundColor: TURN_COLORS.user.input }} />
                  Context size
                </span>,
                <span key="out" className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-0.5" style={{ backgroundColor: TURN_COLORS.tool.input }} />
                  Cumulative output
                </span>,
              ]}
          {data.some((d) => d.compacted) && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-2 rounded-sm bg-danger opacity-40" />
              Compaction
            </span>
          )}
        </div>
      </div>

      <div ref={containerRef} className="h-64 shrink-0">
        {svgSize.w > 0 && (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${svgSize.w} ${svgSize.h}`}
            className="w-full h-full cursor-crosshair"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
          >
            {mode === 'per-turn' ? (
              <BarChart
                data={data}
                chartW={chartW}
                chartH={chartH}
                padding={chartPadding}
                hoveredIndex={hoveredIndex}
                selectedIndex={selectedIndex}
              />
            ) : (
              <LineChart
                data={cumulativeData}
                chartW={chartW}
                chartH={chartH}
                padding={chartPadding}
                startTime={startTime}
                hoveredIndex={hoveredIndex}
                selectedIndex={selectedIndex}
              />
            )}
          </svg>
        )}
      </div>

      {detailPoint && detailCumulative ? (
        <DetailPanel
          point={detailPoint}
          cumulativeOutput={detailCumulative.cumulativeOutput}
          index={selectedIndex}
          total={data.length}
          elapsed={formatDuration(detailPoint.timestamp - startTime)}
          onClose={() => setSelectedIndex(null)}
        />
      ) : (
        <div className="px-4 pb-3 pt-2 border-t border-border-default flex-shrink-0">
          <div className="flex justify-between text-xs text-muted">
            <span>{data.length} turns</span>
            <span>
              Total output: {formatTokenCount(cumulativeData[cumulativeData.length - 1]?.cumulativeOutput ?? 0)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Collapsible text block with a label badge */
function CollapsibleBlock({
  label,
  labelColor,
  bgColor,
  borderColor,
  outputTokens,
  inputTokens,
  children,
}: {
  label: string;
  labelColor: string;
  bgColor: string;
  borderColor: string;
  outputTokens?: number;
  inputTokens?: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOut = outputTokens != null && outputTokens > 0;
  const hasIn = inputTokens != null && inputTokens > 0;

  return (
    <div
      className={`mb-1.5 text-[11px] ${bgColor} border ${borderColor} rounded px-2 py-1 cursor-pointer transition-colors`}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-start gap-1.5">
        <span className={`${labelColor} font-semibold flex-shrink-0`}>{label}</span>
        {(hasOut || hasIn) && (
          <span className="font-mono flex-shrink-0 flex items-center gap-1">
            {hasOut && <span className="text-warning">{formatTokenCount(outputTokens)}</span>}
            {hasOut && hasIn && <span className="text-faint">/</span>}
            {hasIn && <span className="text-accent-hover">{formatTokenCount(inputTokens)}</span>}
          </span>
        )}
        <div
          className={`text-primary font-mono whitespace-pre-wrap break-all leading-snug ${expanded ? '' : 'line-clamp-2'}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function DetailPanel({
  point,
  cumulativeOutput,
  index,
  total,
  elapsed,
  onClose,
}: {
  point: TokenDataPoint;
  cumulativeOutput: number;
  index: number;
  total: number;
  elapsed: string;
  onClose: () => void;
}) {
  const inputTotal = totalInput(point);

  return (
    <>
      {/* Scrollable messages area */}
      <div className="border-t border-border-default flex-1 min-h-0 overflow-auto px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-primary">
            Turn {index + 1} of {total}
            <span className="text-muted font-normal ml-2">{elapsed}</span>
            <span className="ml-2" style={{ color: TURN_COLORS[point.turnType].input }}>
              {point.turnType[0].toUpperCase() + point.turnType.slice(1)}
            </span>
            {point.compacted && <span className="ml-2 text-danger">Compacted</span>}
          </div>
          <button
            className="text-secondary hover:text-primary text-lg leading-none transition-colors"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        {/* User prompt */}
        {point.prompt && (
          <CollapsibleBlock
            label="User"
            labelColor="text-success"
            bgColor="bg-success/10"
            borderColor="border-success/30"
          >
            {point.prompt}
          </CollapsibleBlock>
        )}

        {/* Tool calls */}
        {point.tools && point.tools.length > 0 && (
          <div className="mb-2 space-y-1">
            {point.tools.map((tool, i) => (
              <CollapsibleBlock
                key={i}
                label={tool.name}
                labelColor="text-warning"
                bgColor="bg-warning/10"
                borderColor="border-warning/30"
                outputTokens={tool.outputTokens}
                inputTokens={tool.inputTokens}
              >
                {tool.detail || ''}
              </CollapsibleBlock>
            ))}
          </div>
        )}

        {/* Assistant text */}
        {point.summary && (
          <CollapsibleBlock
            label="Claude"
            labelColor="text-accent-hover"
            bgColor="bg-accent/10"
            borderColor="border-accent-muted"
            outputTokens={point.summaryTokens}
          >
            {point.summary}
          </CollapsibleBlock>
        )}
      </div>

      {/* Fixed token stats footer */}
      <div className="border-t border-border-default shrink-0 px-4 py-2">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted">Output</span>
            <span className="text-primary font-mono">{formatTokenCount(point.outputTokens)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Cumulative out</span>
            <span className="text-primary font-mono">{formatTokenCount(cumulativeOutput)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Context size</span>
            <span className="text-primary font-mono">{formatTokenCount(inputTotal)}</span>
          </div>
          <div className="flex justify-between text-faint">
            <span>↳ Input</span>
            <span className="font-mono">{formatTokenCount(point.inputTokens)}</span>
          </div>
          <div className="flex justify-between text-faint">
            <span>↳ Cache read</span>
            <span className="font-mono">{formatTokenCount(point.cacheReadTokens)}</span>
          </div>
          <div className="flex justify-between text-faint">
            <span>↳ Cache creation</span>
            <span className="font-mono">{formatTokenCount(point.cacheCreationTokens)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function BarChart({
  data,
  chartW,
  chartH,
  padding,
  hoveredIndex,
  selectedIndex,
}: {
  data: TokenDataPoint[];
  chartW: number;
  chartH: number;
  padding: { top: number; right: number; bottom: number; left: number };
  hoveredIndex: number | null;
  selectedIndex: number | null;
}) {
  const maxTokens = Math.max(...data.map((d) => d.outputTokens), 1);
  const barGroupWidth = chartW / data.length;
  const barWidth = Math.max(Math.min(barGroupWidth * 0.7, 24), 2);

  const yTicks = computeTicks(0, maxTokens, 5);

  // Determine which index is actively highlighted
  const activeIndex = selectedIndex ?? hoveredIndex;

  return (
    <g transform={`translate(${padding.left},${padding.top})`}>
      {/* Grid lines */}
      {yTicks.map((tick) => (
        <line
          key={tick}
          x1={0}
          y1={chartH - (tick / maxTokens) * chartH}
          x2={chartW}
          y2={chartH - (tick / maxTokens) * chartH}
          stroke="var(--color-border-default)"
          strokeWidth={0.5}
          strokeDasharray="4,4"
        />
      ))}

      {/* Y-axis labels */}
      {yTicks.map((tick) => (
        <text
          key={tick}
          x={-8}
          y={chartH - (tick / maxTokens) * chartH + 4}
          textAnchor="end"
          fontSize={11}
          fill="var(--color-text-muted)"
        >
          {formatTokenCount(tick)}
        </text>
      ))}

      {/* Compaction areas */}
      {data.map((d, i) => {
        if (!d.compacted) return null;
        const x0 = Math.max(0, (i - 1) * barGroupWidth);
        const x1 = i * barGroupWidth + barGroupWidth;
        return (
          <rect
            key={`compact-${i}`}
            x={x0}
            y={0}
            width={x1 - x0}
            height={chartH}
            fill="var(--color-danger)"
            opacity={0.07}
            rx={2}
          />
        );
      })}

      {/* Highlight band for active turn */}
      {activeIndex !== null && (
        <rect
          x={activeIndex * barGroupWidth}
          y={0}
          width={barGroupWidth}
          height={chartH}
          fill="var(--color-text-primary)"
          opacity={selectedIndex !== null ? 0.08 : 0.04}
          rx={2}
        />
      )}

      {/* Bars — output tokens per turn, colored by turn type */}
      {data.map((d, i) => {
        const x = (i + 0.5) * barGroupWidth - barWidth / 2;
        const h = (d.outputTokens / maxTokens) * chartH;
        const isActive = activeIndex === i;
        const opacity = activeIndex === null || isActive ? 0.8 : 0.3;

        return (
          <rect
            key={i}
            x={x}
            y={chartH - h}
            width={barWidth}
            height={h}
            fill={TURN_COLORS[d.turnType].input}
            opacity={opacity}
            rx={1}
          />
        );
      })}

      {/* X-axis labels (sparse) */}
      {data.map((_, i) => {
        const step = Math.max(1, Math.floor(data.length / 10));
        if (i % step !== 0 && i !== data.length - 1) return null;
        const cx = (i + 0.5) * barGroupWidth;
        return (
          <text key={i} x={cx} y={chartH + 18} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">
            {i + 1}
          </text>
        );
      })}

      {/* X-axis label */}
      <text x={chartW / 2} y={chartH + 34} textAnchor="middle" fontSize={11} fill="var(--color-text-faint)">
        Turn
      </text>
    </g>
  );
}

function LineChart({
  data,
  chartW,
  chartH,
  padding,
  startTime,
  hoveredIndex,
  selectedIndex,
}: {
  data: (TokenDataPoint & { cumulativeOutput: number; contextSize: number })[];
  chartW: number;
  chartH: number;
  padding: { top: number; right: number; bottom: number; left: number };
  startTime: number;
  hoveredIndex: number | null;
  selectedIndex: number | null;
}) {
  const endTime = data[data.length - 1].timestamp;
  const timeSpan = Math.max(endTime - startTime, 1);
  const maxTokens = Math.max(...data.map((d) => Math.max(d.contextSize, d.cumulativeOutput)), 1);

  const xOf = (d: TokenDataPoint) => ((d.timestamp - startTime) / timeSpan) * chartW;
  const yOfContext = (d: (typeof data)[0]) => chartH - (d.contextSize / maxTokens) * chartH;
  const yOfOutput = (d: (typeof data)[0]) => chartH - (d.cumulativeOutput / maxTokens) * chartH;

  const contextPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(d)},${yOfContext(d)}`).join(' ');
  const contextFill = `${contextPath} L${xOf(data[data.length - 1])},${chartH} L${xOf(data[0])},${chartH} Z`;
  const outputPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(d)},${yOfOutput(d)}`).join(' ');
  const outputFill = `${outputPath} L${xOf(data[data.length - 1])},${chartH} L${xOf(data[0])},${chartH} Z`;

  const yTicks = computeTicks(0, maxTokens, 5);

  const xTickCount = Math.min(6, data.length);
  const xTicks: number[] = [];
  for (let i = 0; i < xTickCount; i++) {
    xTicks.push(startTime + (timeSpan * i) / (xTickCount - 1));
  }

  const activeIndex = selectedIndex ?? hoveredIndex;

  return (
    <g transform={`translate(${padding.left},${padding.top})`}>
      {/* Grid lines */}
      {yTicks.map((tick) => (
        <line
          key={tick}
          x1={0}
          y1={chartH - (tick / maxTokens) * chartH}
          x2={chartW}
          y2={chartH - (tick / maxTokens) * chartH}
          stroke="var(--color-border-default)"
          strokeWidth={0.5}
          strokeDasharray="4,4"
        />
      ))}

      {/* Y-axis labels */}
      {yTicks.map((tick) => (
        <text
          key={tick}
          x={-8}
          y={chartH - (tick / maxTokens) * chartH + 4}
          textAnchor="end"
          fontSize={11}
          fill="var(--color-text-muted)"
        >
          {formatTokenCount(tick)}
        </text>
      ))}

      {/* Compaction areas */}
      {data.map((d, i) => {
        if (!d.compacted) return null;
        const x0 = i > 0 ? xOf(data[i - 1]) : 0;
        const x1 = xOf(d);
        return (
          <rect
            key={`compact-${i}`}
            x={x0}
            y={0}
            width={Math.max(x1 - x0, 4)}
            height={chartH}
            fill="var(--color-danger)"
            opacity={0.07}
            rx={2}
          />
        );
      })}

      {/* Filled areas */}
      <path d={contextFill} fill={TURN_COLORS.user.input} opacity={0.08} />
      <path d={outputFill} fill={TURN_COLORS.tool.input} opacity={0.1} />

      {/* Lines */}
      <path d={contextPath} fill="none" stroke={TURN_COLORS.user.input} strokeWidth={2} />
      <path d={outputPath} fill="none" stroke={TURN_COLORS.tool.input} strokeWidth={2} />

      {/* Active data point indicators */}
      {activeIndex !== null && data[activeIndex] && (
        <>
          <line
            x1={xOf(data[activeIndex])}
            y1={0}
            x2={xOf(data[activeIndex])}
            y2={chartH}
            stroke="var(--color-text-muted)"
            strokeWidth={1}
            strokeDasharray={selectedIndex !== null ? '0' : '3,3'}
            opacity={selectedIndex !== null ? 0.3 : 0.5}
          />
          <circle
            cx={xOf(data[activeIndex])}
            cy={yOfContext(data[activeIndex])}
            r={selectedIndex !== null ? 5 : 4}
            fill={TURN_COLORS.user.input}
            stroke="var(--color-bg-surface)"
            strokeWidth={selectedIndex !== null ? 2 : 0}
          />
          <circle
            cx={xOf(data[activeIndex])}
            cy={yOfOutput(data[activeIndex])}
            r={selectedIndex !== null ? 5 : 4}
            fill={TURN_COLORS.tool.input}
            stroke="var(--color-bg-surface)"
            strokeWidth={selectedIndex !== null ? 2 : 0}
          />
        </>
      )}

      {/* X-axis time labels */}
      {xTicks.map((t) => (
        <text
          key={t}
          x={((t - startTime) / timeSpan) * chartW}
          y={chartH + 18}
          textAnchor="middle"
          fontSize={11}
          fill="var(--color-text-muted)"
        >
          {formatDuration(t - startTime)}
        </text>
      ))}

      {/* X-axis label */}
      <text x={chartW / 2} y={chartH + 34} textAnchor="middle" fontSize={11} fill="var(--color-text-faint)">
        Elapsed Time
      </text>
    </g>
  );
}

function computeTicks(min: number, max: number, count: number): number[] {
  const range = max - min;
  const rawStep = range / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  let step: number;
  if (normalized <= 1) step = 1 * magnitude;
  else if (normalized <= 2) step = 2 * magnitude;
  else if (normalized <= 5) step = 5 * magnitude;
  else step = 10 * magnitude;

  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) {
    ticks.push(v);
  }
  return ticks;
}
