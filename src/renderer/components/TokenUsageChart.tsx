import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TokenDataPoint, TokenTurnType, TokenUsageResult } from '../../shared/types';
import { matchesAllTerms } from '../utils/search';
import Highlight from './Highlight';
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

export interface TokenUsageChartHandle {
  handleKeyDown: (e: React.KeyboardEvent) => void;
  matchCount: number | null;
}

const TokenUsageChart = forwardRef<
  TokenUsageChartHandle,
  { data: TokenUsageResult; loading: boolean; error: string | null; search: string }
>(function TokenUsageChart({ data, loading, error, search }, ref) {
  const points = data.points;
  const [mode, setMode] = useState<ChartMode>('per-turn');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgSize, setSvgSize] = useState({ w: 800, h: 256 });
  const [focusedMessageIndex, setFocusedMessageIndex] = useState<number | null>(null);

  /** Build flat list of message texts for a turn (for searching) */
  const turnMessages = useCallback((d: TokenDataPoint): string[] => {
    const msgs: string[] = [];
    if (d.prompt) msgs.push(d.prompt);
    if (d.tools) for (const t of d.tools) msgs.push(`${t.name} ${t.detail || ''}`);
    if (d.summary) msgs.push(d.summary);
    return msgs;
  }, []);

  /** Indices of turns that have at least one matching message */
  const matchingIndices = useMemo(() => {
    if (!search) return null;
    const indices: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (turnMessages(points[i]).some((msg) => matchesAllTerms(msg, search))) indices.push(i);
    }
    return indices;
  }, [search, points, turnMessages]);

  /** Set of matching indices for O(1) lookup */
  const matchingSet = useMemo(() => (matchingIndices ? new Set(matchingIndices) : null), [matchingIndices]);

  /** Matching message indices within the selected turn */
  const matchingMessageIndices = useMemo(() => {
    if (!search || selectedIndex === null) return null;
    const msgs = turnMessages(points[selectedIndex]);
    const indices: number[] = [];
    for (let i = 0; i < msgs.length; i++) {
      if (matchesAllTerms(msgs[i], search)) indices.push(i);
    }
    return indices;
  }, [search, selectedIndex, points, turnMessages]);

  // Auto-select first matching turn when search changes
  useEffect(() => {
    if (matchingIndices && matchingIndices.length > 0) {
      setSelectedIndex(matchingIndices[0]);
    } else if (search) {
      setSelectedIndex(null);
    }
  }, [matchingIndices, search]);

  // Reset focused message when selected turn changes
  useEffect(() => {
    if (matchingMessageIndices && matchingMessageIndices.length > 0) {
      setFocusedMessageIndex(matchingMessageIndices[0]);
    } else {
      setFocusedMessageIndex(null);
    }
  }, [selectedIndex, matchingMessageIndices]);

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
    return points.map((p) => {
      return { ...p, contextSize: totalInput(p) };
    });
  }, [points]);

  const subagentCumulativeData = useMemo(() => {
    return data.subagents.map((sa) => ({
      ...sa,
      cumulativePoints: sa.points.map((p) => ({
        ...p,
        contextSize: totalInput(p),
      })),
    }));
  }, [data.subagents]);

  const startTime = points.length > 0 ? points[0].timestamp : 0;

  const findClosestIndex = useCallback(
    (clientX: number): number | null => {
      if (points.length === 0 || !svgRef.current) return null;

      const rect = svgRef.current.getBoundingClientRect();
      // viewBox matches pixel size so coordinate conversion is 1:1
      const mouseX = clientX - rect.left - chartPadding.left;

      if (mouseX < 0 || mouseX > chartW) return null;

      let closestIdx = 0;
      let closestDist = Number.POSITIVE_INFINITY;
      const barGroupWidth = chartW / points.length;
      for (let i = 0; i < points.length; i++) {
        const x =
          mode === 'per-turn'
            ? (i + 0.5) * barGroupWidth
            : ((points[i].timestamp - startTime) / Math.max(points[points.length - 1].timestamp - startTime, 1)) *
              chartW;
        const dist = Math.abs(mouseX - x);
        if (dist < closestDist) {
          closestDist = dist;
          closestIdx = i;
        }
      }
      return closestIdx;
    },
    [points, mode, startTime, chartPadding.left, chartW],
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

  /** Total message count for the currently selected turn */
  const selectedTurnMessageCount = useMemo(() => {
    if (selectedIndex === null) return 0;
    return turnMessages(points[selectedIndex]).length;
  }, [selectedIndex, points, turnMessages]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (points.length === 0) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (matchingIndices && matchingIndices.length > 0) {
          setSelectedIndex((prev) => {
            const cur = prev ?? matchingIndices[0] + 1;
            const prevMatch = matchingIndices.filter((i) => i < cur);
            return prevMatch.length > 0 ? prevMatch[prevMatch.length - 1] : matchingIndices[matchingIndices.length - 1];
          });
        } else if (!search) {
          setSelectedIndex((prev) => (prev === null ? points.length - 1 : Math.max(0, prev - 1)));
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (matchingIndices && matchingIndices.length > 0) {
          setSelectedIndex((prev) => {
            const cur = prev ?? -1;
            const nextMatch = matchingIndices.find((i) => i > cur);
            return nextMatch !== undefined ? nextMatch : matchingIndices[0];
          });
        } else if (!search) {
          setSelectedIndex((prev) => (prev === null ? 0 : Math.min(points.length - 1, prev + 1)));
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectedIndex === null) {
          // No turn selected yet — select last turn
          setSelectedIndex(points.length - 1);
        } else if (matchingMessageIndices && matchingMessageIndices.length > 0) {
          setFocusedMessageIndex((prev) => {
            const cur = prev ?? matchingMessageIndices[0] + 1;
            const prevMsg = matchingMessageIndices.filter((i) => i < cur);
            return prevMsg.length > 0
              ? prevMsg[prevMsg.length - 1]
              : matchingMessageIndices[matchingMessageIndices.length - 1];
          });
        } else if (!search && selectedTurnMessageCount > 0) {
          // Navigate messages within the current turn (wrap around)
          setFocusedMessageIndex((prev) => (prev === null || prev === 0 ? selectedTurnMessageCount - 1 : prev - 1));
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (selectedIndex === null) {
          // No turn selected yet — select first turn
          setSelectedIndex(0);
        } else if (matchingMessageIndices && matchingMessageIndices.length > 0) {
          setFocusedMessageIndex((prev) => {
            const cur = prev ?? -1;
            const nextMsg = matchingMessageIndices.find((i) => i > cur);
            return nextMsg !== undefined ? nextMsg : matchingMessageIndices[0];
          });
        } else if (!search && selectedTurnMessageCount > 0) {
          // Navigate messages within the current turn (wrap around)
          setFocusedMessageIndex((prev) => (prev === null || prev >= selectedTurnMessageCount - 1 ? 0 : prev + 1));
        }
      } else if (e.key === 'Escape') {
        setSelectedIndex(null);
      }
    },
    [points.length, matchingIndices, matchingMessageIndices, search, selectedIndex, selectedTurnMessageCount],
  );

  useImperativeHandle(ref, () => ({ handleKeyDown, matchCount: matchingIndices ? matchingIndices.length : null }), [
    handleKeyDown,
    matchingIndices,
  ]);

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

  if (points.length === 0) {
    return <div className="text-sm text-muted text-center py-4">No token usage data yet</div>;
  }

  const detailPoint = selectedIndex !== null ? points[selectedIndex] : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 px-4 py-2 flex-shrink-0">
        <PillToggle options={modeOptions} value={mode} onChange={(v) => setMode(v)} size="sm" />
        <div className="flex items-center gap-4 text-xs text-secondary ml-auto">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 rounded-sm" style={{ backgroundColor: TURN_COLORS.user.input }} />
            Context size
          </span>
          {mode === 'per-turn' && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-2 rounded-sm" style={{ backgroundColor: TURN_COLORS.tool.input }} />
              Output
            </span>
          )}
          {mode === 'cumulative' && data.subagents.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-2 rounded-sm" style={{ backgroundColor: TURN_COLORS.agent.input }} />
              Subagent
            </span>
          )}
          {points.some((d) => d.compacted) && (
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
                data={points}
                chartW={chartW}
                chartH={chartH}
                padding={chartPadding}
                hoveredIndex={hoveredIndex}
                selectedIndex={selectedIndex}
                matchingSet={matchingSet}
              />
            ) : (
              <LineChart
                data={cumulativeData}
                subagents={subagentCumulativeData}
                chartW={chartW}
                chartH={chartH}
                padding={chartPadding}
                startTime={startTime}
                hoveredIndex={hoveredIndex}
                selectedIndex={selectedIndex}
                matchingSet={matchingSet}
              />
            )}
          </svg>
        )}
      </div>

      {detailPoint ? (
        <DetailPanel
          point={detailPoint}
          points={points}
          prevContextSize={selectedIndex > 0 ? totalInput(points[selectedIndex - 1]) : 0}
          index={selectedIndex}
          total={points.length}
          elapsed={formatDuration(detailPoint.timestamp - startTime)}
          search={search}
          focusedMessageIndex={focusedMessageIndex}
          onClose={() => setSelectedIndex(null)}
        />
      ) : (
        <div className="px-4 pb-3 pt-2 border-t border-border-default flex-shrink-0">
          <div className="flex justify-between text-xs text-muted">
            <span>{points.length} turns</span>
            <span>
              Total output:{' '}
              {formatTokenCount(
                points.reduce((sum, p) => sum + p.outputTokens, 0) +
                  data.subagents.reduce((sum, sa) => sum + sa.points.reduce((s, p) => s + p.outputTokens, 0), 0),
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
});

export default TokenUsageChart;

/** Collapsible text block with a label badge */
function CollapsibleBlock({
  label,
  labelColor,
  bgColor,
  borderColor,
  outputTokens,
  inputTokens,
  search,
  focused,
  matches,
  children,
}: {
  label: string;
  labelColor: string;
  bgColor: string;
  borderColor: string;
  outputTokens?: number;
  inputTokens?: number;
  search?: string;
  focused?: boolean;
  /** Whether this block matches the active search (undefined = no search active) */
  matches?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const elRef = useRef<HTMLDivElement>(null);
  const hasOut = outputTokens != null && outputTokens > 0;
  const hasIn = inputTokens != null && inputTokens > 0;
  const faded = matches === false;

  // Auto-expand and scroll into view when focused
  useEffect(() => {
    if (focused && elRef.current) {
      if (!expanded) setExpanded(true);
      elRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply highlighting if search is active and children is a string
  const content = search && typeof children === 'string' ? <Highlight text={children} search={search} /> : children;

  return (
    <div
      ref={elRef}
      className={`mb-1.5 text-[11px] ${bgColor} border ${focused ? 'border-accent' : borderColor} rounded px-2 py-1 cursor-pointer transition-colors ${focused ? 'ring-1 ring-accent' : ''} ${faded ? 'opacity-30' : ''}`}
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
          {content}
        </div>
      </div>
    </div>
  );
}

function DetailPanel({
  point,
  points,
  prevContextSize,
  index,
  total,
  elapsed,
  search,
  focusedMessageIndex,
  onClose,
}: {
  point: TokenDataPoint;
  points: TokenDataPoint[];
  prevContextSize: number;
  index: number;
  total: number;
  elapsed: string;
  search: string;
  focusedMessageIndex: number | null;
  onClose: () => void;
}) {
  const inputTotal = totalInput(point);
  const contextGrowth = inputTotal - prevContextSize;
  const cumulativeOutput = points.slice(0, index + 1).reduce((sum, p) => sum + p.outputTokens, 0);

  // Message index mapping: 0 = prompt (if present), then tools, then summary
  let msgIdx = 0;
  const promptIdx = point.prompt ? msgIdx++ : -1;
  const toolStartIdx = msgIdx;
  if (point.tools) msgIdx += point.tools.length;
  const summaryIdx = point.summary ? msgIdx : -1;

  // Per-message match status (undefined when no search active)
  const isSearching = search.length > 0;
  const promptMatches = isSearching && point.prompt ? matchesAllTerms(point.prompt, search) : undefined;
  const summaryMatches = isSearching && point.summary ? matchesAllTerms(point.summary, search) : undefined;

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
            search={search}
            focused={focusedMessageIndex === promptIdx}
            matches={promptMatches}
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
                search={search}
                focused={focusedMessageIndex === toolStartIdx + i}
                matches={isSearching ? matchesAllTerms(`${tool.name} ${tool.detail || ''}`, search) : undefined}
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
            search={search}
            focused={focusedMessageIndex === summaryIdx}
            matches={summaryMatches}
          >
            {point.summary}
          </CollapsibleBlock>
        )}
      </div>

      {/* Fixed token stats footer */}
      <div className="border-t border-border-default shrink-0 px-4 py-2">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted">Context size</span>
            <span className="text-primary font-mono">
              {formatTokenCount(inputTotal)}
              {contextGrowth !== 0 && (
                <span className={contextGrowth > 0 ? 'text-warning ml-1' : 'text-success ml-1'}>
                  {contextGrowth > 0 ? '+' : ''}
                  {formatTokenCount(contextGrowth)}
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Output</span>
            <span className="text-primary font-mono">{formatTokenCount(point.outputTokens)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Cumulative out</span>
            <span className="text-primary font-mono">{formatTokenCount(cumulativeOutput)}</span>
          </div>
          <div className="flex justify-between text-faint">
            <span>Cache read / creation</span>
            <span className="font-mono">
              {formatTokenCount(point.cacheReadTokens)} / {formatTokenCount(point.cacheCreationTokens)}
            </span>
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
  matchingSet,
}: {
  data: TokenDataPoint[];
  chartW: number;
  chartH: number;
  padding: { top: number; right: number; bottom: number; left: number };
  hoveredIndex: number | null;
  selectedIndex: number | null;
  matchingSet: Set<number> | null;
}) {
  const maxTokens = Math.max(...data.map((d) => totalInput(d) + d.outputTokens), 1);
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

      {/* Stacked bars — context size (blue) + output (amber) */}
      {data.map((d, i) => {
        const x = (i + 0.5) * barGroupWidth - barWidth / 2;
        const ctx = totalInput(d);
        const hCtx = (ctx / maxTokens) * chartH;
        const hOut = (d.outputTokens / maxTokens) * chartH;
        const isActive = activeIndex === i;
        const isMatch = matchingSet === null || matchingSet.has(i);
        // Dim non-matching bars during search; without search, keep all at normal opacity
        // and rely on the highlight band to distinguish the selected bar.
        const opacity = !isMatch ? 0.12 : matchingSet !== null && !isActive ? 0.3 : 0.8;

        return (
          <g key={i}>
            {/* Context size (bottom) */}
            <rect
              x={x}
              y={chartH - hCtx - hOut}
              width={barWidth}
              height={hCtx}
              fill={TURN_COLORS.user.input}
              opacity={opacity}
              rx={1}
            />
            {/* Output (top) */}
            <rect
              x={x}
              y={chartH - hOut}
              width={barWidth}
              height={hOut}
              fill={TURN_COLORS.tool.input}
              opacity={opacity}
              rx={1}
            />
          </g>
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

type CumulativePoint = TokenDataPoint & { contextSize: number };

function LineChart({
  data,
  subagents,
  chartW,
  chartH,
  padding,
  startTime,
  hoveredIndex,
  selectedIndex,
  matchingSet,
}: {
  data: CumulativePoint[];
  subagents: { id: string; slug: string; cumulativePoints: CumulativePoint[] }[];
  chartW: number;
  chartH: number;
  padding: { top: number; right: number; bottom: number; left: number };
  startTime: number;
  hoveredIndex: number | null;
  selectedIndex: number | null;
  matchingSet: Set<number> | null;
}) {
  const endTime = data[data.length - 1].timestamp;
  const timeSpan = Math.max(endTime - startTime, 1);
  const subagentMax =
    subagents.length > 0 ? Math.max(...subagents.flatMap((sa) => sa.cumulativePoints.map((p) => p.contextSize))) : 0;
  const maxTokens = Math.max(...data.map((d) => d.contextSize), subagentMax, 1);

  const xOf = (d: TokenDataPoint) => ((d.timestamp - startTime) / timeSpan) * chartW;
  const yOfContext = (d: (typeof data)[0]) => chartH - (d.contextSize / maxTokens) * chartH;

  const contextPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(d)},${yOfContext(d)}`).join(' ');
  const contextFill = `${contextPath} L${xOf(data[data.length - 1])},${chartH} L${xOf(data[0])},${chartH} Z`;

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

      {/* Filled area */}
      <path d={contextFill} fill={TURN_COLORS.user.input} opacity={0.08} />

      {/* Line */}
      <path d={contextPath} fill="none" stroke={TURN_COLORS.user.input} strokeWidth={2} />

      {/* Subagent lines */}
      {subagents.map((sa, saIdx) => {
        const pts = sa.cumulativePoints;
        if (pts.length === 0) return null;
        const saPath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p)},${yOfContext(p)}`).join(' ');
        const saFill = `${saPath} L${xOf(pts[pts.length - 1])},${chartH} L${xOf(pts[0])},${chartH} Z`;
        const lineOpacity = Math.max(0.4, 0.6 - saIdx * 0.1);
        return (
          <g key={sa.id}>
            <path d={saFill} fill={TURN_COLORS.agent.input} opacity={0.05} />
            <path d={saPath} fill="none" stroke={TURN_COLORS.agent.input} strokeWidth={1.5} opacity={lineOpacity} />
          </g>
        );
      })}

      {/* Matching turn markers */}
      {matchingSet &&
        data.map(
          (d, i) =>
            matchingSet.has(i) && (
              <circle
                key={`match-${i}`}
                cx={xOf(d)}
                cy={yOfContext(d)}
                r={3}
                fill={TURN_COLORS.user.input}
                opacity={0.6}
              />
            ),
        )}

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
