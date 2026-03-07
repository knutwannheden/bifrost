import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import type { DiffMode } from '../context/AppContext';
import { getActiveDiffState } from '../context/AppContext';
import { useDiff } from '../hooks/useDiff';
import { useActivityLog } from '../hooks/useActivityLog';
import { useGitLog } from '../hooks/useGitLog';
import { parseDiff, extFromPath, diffFileStats } from '../utils/diff-parser';
import { highlightLines } from '../utils/syntax-highlight';
import ActionLabel from './ActionLabel';
import DiffStatsBadge from './DiffStatsBadge';
import Highlight from './Highlight';
import PillToggle, { type PillOption } from './PillToggle';
import ReviewContent from './ReviewContent';
import ReviewSidebar from './ReviewSidebar';
import SearchIndicator from './SearchIndicator';
import Spinner from './Spinner';
import { formatTimestamp, formatRelative } from '../utils/format-time';
import type { DiffFile, DiffLine, DiffFileStatus } from '../utils/diff-parser';
import type { HighlightedToken } from '../utils/syntax-highlight';
import { isModKey } from '../utils/platform';
import { useInstantSearch } from '../hooks/useInstantSearch';
import type { ActivityEntry, CaptureContextParams, GitLogEntry, ReviewEntry } from '../../shared/types';

interface HighlightedFile {
  file: DiffFile;
  /** One token array per line across all hunks, in order */
  tokensByLine: HighlightedToken[][];
}

function plainTokens(lines: DiffLine[]): HighlightedToken[][] {
  return lines.map((l) => [{ content: l.content, color: '#e2e8f0' }]);
}

/** Used only for small inline diffs (activity log entries) */
function useHighlightedFiles(diff: string | null): HighlightedFile[] | null {
  const [highlighted, setHighlighted] = useState<HighlightedFile[] | null>(null);

  useEffect(() => {
    if (!diff) {
      setHighlighted(null);
      return;
    }

    const files = parseDiff(diff);
    let cancelled = false;

    Promise.all(
      files.map(async (file) => {
        const ext = extFromPath(file.newPath || file.oldPath);
        const allLines = file.hunks.flatMap((h) => h.lines);
        const tokens = await highlightLines(
          allLines.map((l) => l.content),
          ext,
        );
        return { file, tokensByLine: tokens };
      }),
    ).then((result) => {
      if (!cancelled) setHighlighted(result);
    });

    return () => {
      cancelled = true;
    };
  }, [diff]);

  return highlighted;
}

const lineNumWidth = 'w-12';

function LineNumber({ num }: { num: number | null }) {
  return (
    <span className={`${lineNumWidth} inline-block text-right pr-2 select-none text-faint text-xs leading-5 flex-shrink-0`}>
      {num ?? ''}
    </span>
  );
}

const lineStyles: Record<DiffLine['type'], { bg: string; signColor: string; sign: string }> = {
  add: { bg: 'bg-[#1a3a1a]', signColor: 'text-success', sign: '+' },
  remove: { bg: 'bg-[#3a1a1a]', signColor: 'text-danger', sign: '-' },
  context: { bg: '', signColor: 'text-faint', sign: ' ' },
};

function DiffLineRow({
  line,
  tokens,
}: {
  line: DiffLine;
  tokens: HighlightedToken[];
}) {
  const { bg: bgClass, signColor, sign } = lineStyles[line.type];

  return (
    <div className={`flex leading-5 ${bgClass}`}>
      <LineNumber num={line.oldLineNo} />
      <LineNumber num={line.newLineNo} />
      <span className={`${signColor} w-4 inline-block text-center flex-shrink-0 text-xs leading-5`}>
        {sign}
      </span>
      <span className="flex-1 text-xs leading-5 whitespace-pre">
        {tokens.map((token, i) => (
          <span key={i} style={{ color: token.color }}>
            {token.content}
          </span>
        ))}
      </span>
    </div>
  );
}

function FileSection({ data }: { data: HighlightedFile }) {
  const { file, tokensByLine } = data;
  let lineIdx = 0;

  return (
    <div className="mb-6">
      <div className="sticky top-0 z-10 bg-surface border border-border-input rounded-t px-3 py-1.5 text-xs font-semibold text-primary">
        {file.newPath || file.oldPath}
      </div>
      {file.binary ? (
        <div className="border border-t-0 border-border-default rounded-b px-3 py-2 text-xs text-muted italic">
          Binary file not shown
        </div>
      ) : (
        <div className="border border-t-0 border-border-default rounded-b overflow-x-auto font-mono">
          {file.hunks.map((hunk, hi) => (
            <React.Fragment key={hi}>
              {hi > 0 && (
                <div className="border-t border-border-default/50 bg-surface/50 px-3 py-0.5 text-xs text-accent-hover">
                  {hunk.header}
                </div>
              )}
              {hunk.lines.map((line, li) => {
                const idx = lineIdx++;
                return (
                  <DiffLineRow
                    key={`${hi}-${li}`}
                    line={line}
                    tokens={tokensByLine[idx] ?? [{ content: line.content, color: '#e2e8f0' }]}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** Only renders diff content + highlights when scrolled near the viewport */
function LazyFileSection({ file, sectionRef }: { file: DiffFile; sectionRef?: (el: HTMLDivElement | null) => void }) {
  const [visible, setVisible] = useState(false);
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);
  const observerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = observerRef.current;
    if (!el) return;

    let cancelled = false;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect();
        setVisible(true);
        const ext = extFromPath(file.newPath || file.oldPath);
        const allLines = file.hunks.flatMap((h) => h.lines);
        highlightLines(allLines.map((l) => l.content), ext).then((result) => {
          if (!cancelled) setTokens(result);
        });
      }
    }, { rootMargin: '300px' });

    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); };
  }, [file]);

  if (!visible) {
    // Estimated height: 20px per line (leading-5) + hunk separator headers
    const totalLines = file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
    const hunkHeaders = file.hunks.length > 1 ? (file.hunks.length - 1) * 24 : 0;
    const estimatedHeight = file.binary ? 32 : totalLines * 20 + hunkHeaders;

    return (
      <div ref={(el) => { observerRef.current = el; sectionRef?.(el); }} className="mb-6">
        <div className="sticky top-0 z-10 bg-surface border border-border-input rounded-t px-3 py-1.5 text-xs font-semibold text-primary">
          {file.newPath || file.oldPath}
        </div>
        <div className="border border-t-0 border-border-default rounded-b" style={{ height: estimatedHeight }} />
      </div>
    );
  }

  const allLines = file.hunks.flatMap((h) => h.lines);
  const displayTokens = tokens ?? plainTokens(allLines);

  return (
    <div ref={(el) => { observerRef.current = el; sectionRef?.(el); }}>
      <FileSection data={{ file, tokensByLine: displayTokens }} />
    </div>
  );
}

function ClaudeEventView({ entry }: { entry: ActivityEntry }) {
  const kindConfig: Record<string, { label: string; color: string; bg: string; border: string }> = {
    user_message: { label: 'User', color: 'text-green-400', bg: 'bg-green-900/20', border: 'border-green-700/40' },
    assistant_text: { label: 'Claude', color: 'text-purple-400', bg: 'bg-purple-900/20', border: 'border-purple-700/40' },
    tool_use: { label: '', color: 'text-amber-400', bg: 'bg-amber-900/15', border: 'border-amber-700/30' },
    tool_result: { label: 'Result', color: 'text-secondary', bg: 'bg-surface/50', border: 'border-border-default/30' },
  };

  const config = kindConfig[entry.claudeEventKind ?? ''] ?? kindConfig.assistant_text;

  if (entry.claudeEventKind === 'tool_use') {
    return (
      <div className={`flex items-start gap-2 px-3 py-1.5 ${config.bg} border ${config.border} rounded text-xs`}>
        <span className="text-muted flex-shrink-0">{formatTimestamp(entry.timestamp)}</span>
        <span className={`${config.color} font-semibold flex-shrink-0`}>{entry.claudeToolName}</span>
        {entry.claudeText && (
          <span className="text-secondary font-mono truncate">{entry.claudeText}</span>
        )}
      </div>
    );
  }

  return (
    <div className={`px-3 py-2 ${config.bg} border ${config.border} rounded text-xs`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-muted">{formatTimestamp(entry.timestamp)}</span>
        <span className={`${config.color} font-semibold`}>{config.label}</span>
      </div>
      <p className="text-primary whitespace-pre-wrap">{entry.claudeText}</p>
    </div>
  );
}

function ActivityEntryView({ entry, search }: { entry: ActivityEntry; search: string }) {
  const highlighted = useHighlightedFiles(entry.diff ?? null);

  if (entry.type === 'claude_event') {
    return <ClaudeEventView entry={entry} />;
  }

  if (entry.type === 'commit') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-accent/10 border border-accent-muted rounded text-xs">
        <span className="text-muted">{formatTimestamp(entry.timestamp)}</span>
        <span className="text-accent-hover font-semibold">Commit</span>
        <span className="text-secondary font-mono">{entry.commitSha?.slice(0, 8)}</span>
        <span className="text-primary"><Highlight text={entry.commitMessage ?? ''} search={search} /></span>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1 text-xs">
        <span className="text-muted">{formatTimestamp(entry.timestamp)}</span>
        <span className="text-primary font-mono"><Highlight text={entry.filePath ?? ''} search={search} /></span>
      </div>
      {highlighted && highlighted.map((data, i) => (
        <FileSection key={i} data={data} />
      ))}
      {!highlighted && entry.diff && (
        <pre className="text-xs text-secondary font-mono overflow-x-auto p-2 bg-surface/50 rounded border border-border-default">
          {entry.diff}
        </pre>
      )}
    </div>
  );
}

const modeOptions: PillOption<DiffMode>[] = [
  { value: 'git', label: <ActionLabel text="Git Diff" showHint={true} /> },
  { value: 'activity', label: <ActionLabel text="Activity Log" showHint={true} /> },
  { value: 'log', label: <ActionLabel text="Git Log" hintIndex={4} showHint={true} /> },
  { value: 'review', label: <ActionLabel text="Review" showHint={true} /> },
];

/** Get searchable text from an activity entry */
function entrySearchText(entry: ActivityEntry): string {
  return `${entry.claudeText ?? ''} ${entry.filePath ?? ''} ${entry.commitMessage ?? ''} ${entry.claudeToolName ?? ''} ${entry.diff ?? ''}`.toLowerCase();
}

/** Format an activity entry as plain text for context capture */
function entryToText(entry: ActivityEntry): string {
  if (entry.type === 'commit') {
    return `[commit] ${entry.commitSha?.slice(0, 8)} ${entry.commitMessage ?? ''}`;
  }
  if (entry.type === 'claude_event') {
    const kind = entry.claudeEventKind ?? 'unknown';
    if (kind === 'tool_use') return `[tool_use] ${entry.claudeToolName ?? ''} ${entry.claudeText ?? ''}`;
    return `[${kind}] ${entry.claudeText ?? ''}`;
  }
  if (entry.type === 'file_change') {
    return `[file] ${entry.filePath ?? ''}\n${entry.diff ?? ''}`;
  }
  return `[${entry.type}]`;
}

const statusConfig: Record<DiffFileStatus, { letter: string; color: string }> = {
  added: { letter: 'A', color: 'text-success' },
  modified: { letter: 'M', color: 'text-warning' },
  deleted: { letter: 'D', color: 'text-danger' },
  renamed: { letter: 'R', color: 'text-accent-hover' },
};

type GitFileStage = 'unstaged' | 'staged' | 'committed' | 'untracked';

const stageIndicator: Record<GitFileStage, { label: string; color: string; title: string }> = {
  staged: { label: 'S', color: 'text-success', title: 'Staged' },
  unstaged: { label: 'U', color: 'text-warning', title: 'Unstaged' },
  committed: { label: 'C', color: 'text-accent-hover', title: 'Committed' },
  untracked: { label: '?', color: 'text-muted', title: 'Untracked' },
};

interface FileTreeNode {
  /** Display label — may be a merged path like "src/main/java" for sparse dirs */
  label: string;
  /** Full directory path from repo root (used as key for collapse state) */
  path: string;
  children: FileTreeNode[];
  /** Files directly in this directory, with their index in the flat files array */
  files: { file: DiffFile; flatIndex: number }[];
}

function buildFileTree(files: DiffFile[]): FileTreeNode {
  const root: FileTreeNode = { label: '', path: '', children: [], files: [] };

  // Insert each file into the tree
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i].newPath || files[i].oldPath;
    const lastSlash = filePath.lastIndexOf('/');
    const dirPath = lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
    const segments = dirPath ? dirPath.split('/') : [];

    let node = root;
    let currentPath = '';
    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      let child = node.children.find((c) => c.path === currentPath);
      if (!child) {
        child = { label: seg, path: currentPath, children: [], files: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.files.push({ file: files[i], flatIndex: i });
  }

  // Sparse-collapse: merge single-child dirs with zero files
  function collapse(node: FileTreeNode): void {
    for (const child of node.children) collapse(child);
    while (node.children.length === 1 && node.files.length === 0) {
      const only = node.children[0];
      node.label = node.label ? `${node.label}/${only.label}` : only.label;
      node.path = only.path;
      node.children = only.children;
      node.files = only.files;
    }
  }
  for (const child of root.children) collapse(child);

  // Sort: directories first (alphabetical), then files (alphabetical)
  function sortTree(node: FileTreeNode): void {
    node.children.sort((a, b) => a.label.localeCompare(b.label));
    node.files.sort((a, b) => {
      const aName = (a.file.newPath || a.file.oldPath).split('/').pop()!;
      const bName = (b.file.newPath || b.file.oldPath).split('/').pop()!;
      return aName.localeCompare(bName);
    });
    for (const child of node.children) sortTree(child);
  }
  sortTree(root);

  return root;
}

/** Compute aggregate stats for a tree node and all descendants */
function treeNodeStats(node: FileTreeNode): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of node.files) {
    const s = diffFileStats(f.file);
    additions += s.additions;
    deletions += s.deletions;
  }
  for (const child of node.children) {
    const s = treeNodeStats(child);
    additions += s.additions;
    deletions += s.deletions;
  }
  return { additions, deletions };
}

/** Find the directory paths that contain the file at the given flat index */
function findAncestorPaths(node: FileTreeNode, flatIndex: number): string[] | null {
  for (const f of node.files) {
    if (f.flatIndex === flatIndex) return [];
  }
  for (const child of node.children) {
    const result = findAncestorPaths(child, flatIndex);
    if (result !== null) return [child.path, ...result];
  }
  return null;
}

function FileTreeItem({
  node,
  depth,
  collapsed,
  onToggle,
  selectedIndex,
  onSelectFile,
  fileStatuses,
  fileRefs,
  search,
}: {
  node: FileTreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  selectedIndex: number;
  onSelectFile: (index: number) => void;
  fileStatuses: Record<string, GitFileStage[]>;
  fileRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  search: string;
}) {
  const isCollapsed = collapsed.has(node.path);
  const stats = useMemo(() => treeNodeStats(node), [node]);

  return (
    <>
      {/* Directory row */}
      <div
        className="flex items-center gap-1.5 py-0.5 cursor-pointer hover:bg-surface text-xs"
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={() => onToggle(node.path)}
      >
        <span className="text-muted w-3 text-center flex-shrink-0">
          {isCollapsed ? '▸' : '▾'}
        </span>
        <span className="text-secondary truncate"><Highlight text={node.label} search={search} /></span>
        <DiffStatsBadge additions={stats.additions} deletions={stats.deletions} className="flex-shrink-0 ml-auto" />
      </div>
      {/* Children (dirs then files) when expanded */}
      {!isCollapsed && (
        <>
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              selectedIndex={selectedIndex}
              onSelectFile={onSelectFile}
              fileStatuses={fileStatuses}
              fileRefs={fileRefs}
              search={search}
            />
          ))}
          {node.files.map(({ file, flatIndex }) => {
            const path = file.newPath || file.oldPath;
            const basename = path.split('/').pop()!;
            const fileStat = diffFileStats(file);
            const cfg = statusConfig[file.status];
            const stages = fileStatuses[path] ?? [];
            const isSelected = flatIndex === selectedIndex;

            return (
              <div
                key={flatIndex}
                ref={(el) => { fileRefs.current[flatIndex] = el; }}
                onClick={() => onSelectFile(flatIndex)}
                className={`flex items-center gap-2 py-1 cursor-pointer text-xs ${
                  isSelected
                    ? 'bg-surface-alt/50 border-l-2 border-accent-hover'
                    : 'border-l-2 border-transparent hover:bg-surface'
                }`}
                style={{ paddingLeft: (depth + 1) * 16 + 8 }}
              >
                <span className="flex gap-0.5 flex-shrink-0">
                  <span className={`${cfg.color} font-bold`}>{cfg.letter}</span>
                  {stages.map((stage) => {
                    const si = stageIndicator[stage as GitFileStage];
                    return si ? (
                      <span key={stage} className={`${si.color} font-mono font-bold`} title={si.title}>{si.label}</span>
                    ) : null;
                  })}
                </span>
                <span className="text-primary truncate"><Highlight text={basename} search={search} /></span>
                {file.binary
                  ? <span className="text-xs text-faint italic flex-shrink-0 ml-auto">binary</span>
                  : <DiffStatsBadge additions={fileStat.additions} deletions={fileStat.deletions} className="flex-shrink-0 ml-auto" />
                }
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function FileListSidebar({
  files,
  selectedIndex,
  onSelectFile,
  fileStatuses,
  search,
}: {
  files: DiffFile[];
  selectedIndex: number;
  onSelectFile: (index: number) => void;
  fileStatuses: Record<string, GitFileStage[]>;
  search: string;
}) {
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildFileTree(files), [files]);

  // Auto-expand ancestors of the selected file
  useEffect(() => {
    if (files.length === 0) return;
    const ancestors = findAncestorPaths(tree, selectedIndex);
    if (!ancestors || ancestors.length === 0) return;
    setCollapsed((prev) => {
      const collapsedAncestors = ancestors.filter((p) => prev.has(p));
      if (collapsedAncestors.length === 0) return prev;
      const next = new Set(prev);
      for (const p of collapsedAncestors) next.delete(p);
      return next;
    });
  }, [selectedIndex, tree, files.length]);

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const totalStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      const s = diffFileStats(f);
      additions += s.additions;
      deletions += s.deletions;
    }
    return { additions, deletions };
  }, [files]);

  const handleToggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Check if all files are in root (no directories) — render flat list
  const hasTree = tree.children.length > 0;

  return (
    <div className="w-72 flex-shrink-0 border-r border-border-default overflow-y-auto">
      <div className="px-3 py-2 border-b border-border-default text-xs text-secondary flex items-center gap-2">
        <span>{files.length} file{files.length !== 1 ? 's' : ''}</span>
        <DiffStatsBadge additions={totalStats.additions} deletions={totalStats.deletions} />
      </div>
      {hasTree ? (
        <>
          {/* Root-level directories */}
          {tree.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={0}
              collapsed={collapsed}
              onToggle={handleToggle}
              selectedIndex={selectedIndex}
              onSelectFile={onSelectFile}
              fileStatuses={fileStatuses}
              fileRefs={itemRefs}
              search={search}
            />
          ))}
          {/* Root-level files (no directory) */}
          {tree.files.map(({ file, flatIndex }) => {
            const path = file.newPath || file.oldPath;
            const basename = path.split('/').pop() || path;
            const stats = diffFileStats(file);
            const cfg = statusConfig[file.status];
            const stages = fileStatuses[path] ?? [];
            const isSelected = flatIndex === selectedIndex;

            return (
              <div
                key={flatIndex}
                ref={(el) => { itemRefs.current[flatIndex] = el; }}
                onClick={() => onSelectFile(flatIndex)}
                className={`flex items-center gap-2 px-3 py-1 cursor-pointer text-xs ${
                  isSelected
                    ? 'bg-surface-alt/50 border-l-2 border-accent-hover'
                    : 'border-l-2 border-transparent hover:bg-surface'
                }`}
              >
                <span className="flex gap-0.5 flex-shrink-0">
                  <span className={`${cfg.color} font-bold`}>{cfg.letter}</span>
                  {stages.map((stage) => {
                    const si = stageIndicator[stage as GitFileStage];
                    return si ? (
                      <span key={stage} className={`${si.color} font-mono font-bold`} title={si.title}>{si.label}</span>
                    ) : null;
                  })}
                </span>
                <span className="text-primary truncate"><Highlight text={basename} search={search} /></span>
                {file.binary
                  ? <span className="text-xs text-faint italic flex-shrink-0 ml-auto">binary</span>
                  : <DiffStatsBadge additions={stats.additions} deletions={stats.deletions} className="flex-shrink-0 ml-auto" />
                }
              </div>
            );
          })}
        </>
      ) : (
        /* Flat fallback when all files are in root */
        tree.files.map(({ file, flatIndex }) => {
          const path = file.newPath || file.oldPath;
          const stats = diffFileStats(file);
          const cfg = statusConfig[file.status];
          const stages = fileStatuses[path] ?? [];
          const isSelected = flatIndex === selectedIndex;

          return (
            <div
              key={flatIndex}
              ref={(el) => { itemRefs.current[flatIndex] = el; }}
              onClick={() => onSelectFile(flatIndex)}
              className={`flex items-center gap-2 px-3 py-1 cursor-pointer text-xs ${
                isSelected
                  ? 'bg-surface-alt/50 border-l-2 border-accent-hover'
                  : 'border-l-2 border-transparent hover:bg-surface'
              }`}
            >
              <span className="flex gap-0.5 flex-shrink-0">
                <span className={`${cfg.color} font-bold`}>{cfg.letter}</span>
                {stages.map((stage) => {
                  const si = stageIndicator[stage as GitFileStage];
                  return si ? (
                    <span key={stage} className={`${si.color} font-mono font-bold`} title={si.title}>{si.label}</span>
                  ) : null;
                })}
              </span>
              <span className="text-primary truncate"><Highlight text={path} search={search} /></span>
              {file.binary
                ? <span className="text-xs text-faint italic flex-shrink-0 ml-auto">binary</span>
                : <DiffStatsBadge additions={stats.additions} deletions={stats.deletions} className="flex-shrink-0 ml-auto" />
              }
            </div>
          );
        })
      )}
    </div>
  );
}

type DiffScope = 'working' | 'all';

const scopeLabels: Record<DiffScope, { text: string; hintIndex: number }> = {
  working: { text: 'Working tree', hintIndex: 8 },
  all: { text: 'All changes', hintIndex: 4 },
};

const scopeOptions: PillOption<DiffScope>[] = (['working', 'all'] as const).map((s) => ({
  value: s,
  label: <ActionLabel text={scopeLabels[s].text} hintIndex={scopeLabels[s].hintIndex} showHint={true} />,
}));

function ScopeToggle({ scope, onChange }: { scope: DiffScope; onChange: (s: DiffScope) => void }) {
  return (
    <div className="px-3 py-2 border-b border-border-default flex-shrink-0">
      <PillToggle options={scopeOptions} value={scope} onChange={onChange} />
    </div>
  );
}

function GitDiffContent({ taskId, search, gitFileIdx, onSetGitFileIdx, onFileCount, filesRef, scope, onSetScope }: { taskId: string; search: string; gitFileIdx: number; onSetGitFileIdx: (idx: number) => void; onFileCount: (count: number) => void; filesRef: React.MutableRefObject<DiffFile[]>; scope: DiffScope; onSetScope: (s: DiffScope) => void }) {
  const { diff, loading, error } = useDiff(taskId, scope);
  const [fileStatuses, setFileStatuses] = useState<Record<string, GitFileStage[]>>({});

  const fileSectionRefs = useRef<(HTMLDivElement | null)[]>([]);

  const files = useMemo(() => diff ? parseDiff(diff) : null, [diff]);

  // Fetch file statuses alongside the diff
  useEffect(() => {
    window.bifrost.getFileStatuses(taskId, scope).then(
      (statuses) => setFileStatuses(statuses as Record<string, GitFileStage[]>),
    ).catch(() => setFileStatuses({}));
  }, [taskId, diff, scope]);

  const filtered = useMemo(() => {
    if (!files || !search) return files;
    const s = search.toLowerCase();
    return files.filter((file) => {
      const path = (file.newPath || file.oldPath).toLowerCase();
      if (path.includes(s)) return true;
      return file.hunks.some((h) =>
        h.lines.some((l) => l.content.toLowerCase().includes(s)),
      );
    });
  }, [files, search]);

  // Report file list to parent for search indicator and Cmd+O
  useEffect(() => {
    filesRef.current = filtered ?? [];
    onFileCount(filtered ? filtered.length : 0);
  }, [filtered, onFileCount, filesRef]);

  // Scroll to selected file only when user navigates
  const prevGitFileIdx = useRef(gitFileIdx);
  useEffect(() => {
    if (prevGitFileIdx.current !== gitFileIdx) {
      fileSectionRefs.current[gitFileIdx]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      prevGitFileIdx.current = gitFileIdx;
    }
  }, [gitFileIdx, filtered]);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col">
        <ScopeToggle scope={scope} onChange={onSetScope} />
        <div className="flex items-center gap-2 text-secondary p-4">
          <Spinner />
          <span>Loading diff...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col">
        <ScopeToggle scope={scope} onChange={onSetScope} />
        <div className="text-sm text-danger p-4">Error: {error}</div>
      </div>
    );
  }

  if (diff === null || diff === '') {
    return (
      <div className="flex-1 flex flex-col">
        <ScopeToggle scope={scope} onChange={onSetScope} />
        <div className="text-muted p-4">No changes</div>
      </div>
    );
  }

  if (filtered && filtered.length === 0 && search) {
    return (
      <div className="flex-1 flex flex-col">
        <ScopeToggle scope={scope} onChange={onSetScope} />
        <div className="text-sm text-muted text-center py-4">No matching files</div>
      </div>
    );
  }

  if (!filtered) return null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ScopeToggle scope={scope} onChange={onSetScope} />
      <div className="flex-1 flex min-h-0">
        <FileListSidebar
          files={filtered}
          selectedIndex={gitFileIdx}
          onSelectFile={onSetGitFileIdx}
          fileStatuses={scope === 'working'
            ? Object.fromEntries(Object.entries(fileStatuses).map(([k, v]) => [k, v.filter((s) => s !== 'committed')]))
            : fileStatuses
          }
          search={search}
        />
        <div className="flex-1 overflow-auto px-4 pb-4">
          {filtered.map((file, i) => (
            <LazyFileSection
              key={`${file.newPath || file.oldPath}-${i}`}
              file={file}
              sectionRef={(el) => { fileSectionRefs.current[i] = el; }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}


function GitLogEntryView({ entry, focused, search }: { entry: GitLogEntry; focused: boolean; search: string }) {
  return (
    <div
      className={`flex items-start gap-3 px-3 py-2 bg-surface/40 border border-border-default/50 rounded text-xs ${
        focused ? 'ring-1 ring-accent-muted bg-accent/10' : ''
      }`}
    >
      <span className="text-warning font-mono flex-shrink-0"><Highlight text={entry.shortSha} search={search} /></span>
      <span className="text-primary flex-1 min-w-0 break-words"><Highlight text={entry.subject} search={search} /></span>
      <span className="text-muted flex-shrink-0"><Highlight text={entry.author} search={search} /></span>
      <span className="text-faint flex-shrink-0 w-16 text-right">{formatRelative(new Date(entry.date).getTime())}</span>
    </div>
  );
}

function ReviewPanel({ taskId }: { taskId: string }) {
  const { state, dispatch } = useApp();

  const reviews = state.reviews[taskId] ?? [];
  const activeReviewId = state.activeReviewId[taskId] ?? null;

  // Track which review has discussion active (for the sidebar indicator)
  const [discussingReviewId, setDiscussingReviewId] = useState<string | null>(null);

  // Load review list on mount
  useEffect(() => {
    window.bifrost.listReviews(taskId).then((entries) => {
      dispatch({ type: 'SET_REVIEWS', taskId, reviews: entries });
      // Auto-select the most recent review if none selected
      if (entries.length > 0 && !state.activeReviewId[taskId] && state.reviewStatus['__pending__'] !== 'running') {
        const newest = entries.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
        dispatch({ type: 'SET_ACTIVE_REVIEW', taskId, reviewId: newest.id });
      }
    });
  }, [taskId]);

  const handleSelectReview = useCallback((reviewId: string | null) => {
    dispatch({ type: 'SET_ACTIVE_REVIEW', taskId, reviewId });
  }, [taskId, dispatch]);

  const handleNewReview = useCallback(() => {
    dispatch({ type: 'SET_ACTIVE_REVIEW', taskId, reviewId: null });
  }, [taskId, dispatch]);

  const handleNewReviewCreated = useCallback((review: ReviewEntry) => {
    dispatch({ type: 'ADD_REVIEW', taskId, review });
    dispatch({ type: 'SET_ACTIVE_REVIEW', taskId, reviewId: review.id });
  }, [taskId, dispatch]);

  const handleDeleteReview = useCallback(async (reviewId: string) => {
    await window.bifrost.deleteReview(taskId, reviewId);
    dispatch({ type: 'DELETE_REVIEW', taskId, reviewId });
  }, [taskId, dispatch]);

  return (
    <div className="flex-1 flex min-h-0">
      <ReviewSidebar
        reviews={reviews}
        activeReviewId={activeReviewId}
        reviewStatuses={state.reviewStatus}
        discussingReviewId={discussingReviewId}
        onSelect={handleSelectReview}
        onNewReview={handleNewReview}
        onDelete={handleDeleteReview}
      />
      <ReviewContent
        taskId={taskId}
        activeReviewId={activeReviewId}
        onNewReviewCreated={handleNewReviewCreated}
        onDiscussionChange={setDiscussingReviewId}
      />
    </div>
  );
}

export default function DiffOverlay() {
  const { state, dispatch } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const gitFilesRef = useRef<DiffFile[]>([]);

  const { search, handleSearchKey, clearSearch } = useInstantSearch();
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [gitFileIdx, setGitFileIdx] = useState(0);
  const [gitFileCount, setGitFileCount] = useState(0);
  const [diffScope, setDiffScope] = useState<DiffScope>('working');

  const { showDiff, diffMode } = getActiveDiffState(state);
  const isActivity = diffMode === 'activity';
  const isLog = diffMode === 'log';
  const isReview = diffMode === 'review';

  // Fetch activity data at DiffOverlay level for search/navigation
  const activityLog = useActivityLog(
    showDiff && isActivity && state.activeTaskId ? state.activeTaskId : null,
  );

  const filteredEntries = useMemo(() => {
    if (!search) return activityLog.entries;
    const s = search.toLowerCase();
    return activityLog.entries.filter((e) => entrySearchText(e).includes(s));
  }, [activityLog.entries, search]);

  // Fetch git log data at DiffOverlay level for search/navigation
  const gitLog = useGitLog(
    showDiff && isLog && state.activeTaskId ? state.activeTaskId : null,
  );

  const filteredLogEntries = useMemo(() => {
    if (!search) return gitLog.entries;
    const s = search.toLowerCase();
    return gitLog.entries.filter((e) => e.subject.toLowerCase().includes(s));
  }, [gitLog.entries, search]);

  // Reset search and focus when mode changes
  useEffect(() => {
    clearSearch();
    setFocusedIdx(0);
    setGitFileIdx(0);
  }, [diffMode]);

  // Reset focus when search changes
  useEffect(() => {
    setFocusedIdx(0);
    setGitFileIdx(0);
  }, [search]);

  // Clamp focus when list shrinks
  useEffect(() => {
    if (isActivity && focusedIdx >= filteredEntries.length && filteredEntries.length > 0) {
      setFocusedIdx(filteredEntries.length - 1);
    }
    if (isLog && focusedIdx >= filteredLogEntries.length && filteredLogEntries.length > 0) {
      setFocusedIdx(filteredLogEntries.length - 1);
    }
  }, [filteredEntries.length, filteredLogEntries.length, focusedIdx, isActivity, isLog]);

  // Clamp git file index when file list shrinks
  useEffect(() => {
    if (!isActivity && gitFileIdx >= gitFileCount && gitFileCount > 0) {
      setGitFileIdx(gitFileCount - 1);
    }
  }, [gitFileCount, gitFileIdx, isActivity]);

  // Scroll focused entry into view
  useEffect(() => {
    if (isActivity || isLog) {
      itemRefs.current[focusedIdx]?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIdx, isActivity, isLog]);

  useEffect(() => {
    if (showDiff) {
      containerRef.current?.focus();
    }
  }, [showDiff]);

  if (!showDiff) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't intercept keys when focus is inside a terminal or form input
    const tag = (e.target as HTMLElement).tagName;
    const isInInput = tag === 'INPUT' || tag === 'TEXTAREA';
    if ((e.target as HTMLElement).closest?.('.xterm')) return;
    // Esc in an input: blur first, second Esc closes overlay
    if (isInInput) {
      if (e.key === 'Escape') {
        e.preventDefault();
        (document.activeElement as HTMLElement)?.blur?.();
        containerRef.current?.focus();
      }
      return;
    }

    // Mod+O: open the focused entry's file in the IDE
    if (isModKey(e) && !e.shiftKey && e.key.toLowerCase() === 'o') {
      const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
      if (activeTask) {
        let filePath: string | undefined;
        if (isActivity && filteredEntries.length > 0) {
          const entry = filteredEntries[focusedIdx];
          filePath = entry?.filePath;
        } else if (!isActivity && gitFilesRef.current.length > 0) {
          const file = gitFilesRef.current[gitFileIdx];
          filePath = file?.newPath || file?.oldPath;
        }
        if (filePath) {
          e.preventDefault();
          window.bifrost.openInIde(activeTask.worktreePath, filePath);
          return;
        }
        // No file from focused entry — let useKeyboard handle it
      }
    }

    // Mod+Shift+C: capture context for the focused entry
    if (isModKey(e) && e.shiftKey && e.key.toLowerCase() === 'c') {
      const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
      if (!activeTask) return;

      if (isActivity && filteredEntries.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const entry = filteredEntries[focusedIdx];
        if (!entry) return;

        const content = entryToText(entry);
        const params: CaptureContextParams = {
          type: 'activity',
          content,
          taskId: activeTask.id,
          taskName: activeTask.name,
        };
        window.bifrost.captureContext(params).then((id) => {
          dispatch({ type: 'SHOW_TOAST', message: `[Bifrost #${id}] copied` });
        });
        return;
      }

      if (isLog && filteredLogEntries.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const entry = filteredLogEntries[focusedIdx];
        if (!entry) return;

        const content = `[commit] ${entry.shortSha} ${entry.subject} (${entry.author})`;
        const params: CaptureContextParams = {
          type: 'activity',
          content,
          taskId: activeTask.id,
          taskName: activeTask.name,
        };
        window.bifrost.captureContext(params).then((id) => {
          dispatch({ type: 'SHOW_TOAST', message: `[Bifrost #${id}] copied` });
        });
        return;
      }
    }

    if (handleSearchKey(e)) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: 'TOGGLE_DIFF' });
        break;

      case 'Tab': {
        e.preventDefault();
        e.stopPropagation();
        const modes: DiffMode[] = ['git', 'activity', 'log', 'review'];
        const curIdx = modes.indexOf(diffMode);
        const step = e.shiftKey ? modes.length - 1 : 1;
        dispatch({ type: 'SET_DIFF_MODE', mode: modes[(curIdx + step) % modes.length] });
        break;
      }

      case 'ArrowUp':
        e.preventDefault();
        if (isActivity && filteredEntries.length > 0) {
          setFocusedIdx((i) => (i > 0 ? i - 1 : filteredEntries.length - 1));
        } else if (isLog && filteredLogEntries.length > 0) {
          setFocusedIdx((i) => (i > 0 ? i - 1 : filteredLogEntries.length - 1));
        } else if (diffMode === 'git' && gitFileCount > 0) {
          setGitFileIdx((i) => (i > 0 ? i - 1 : gitFileCount - 1));
        }
        break;

      case 'ArrowDown':
        e.preventDefault();
        if (isActivity && filteredEntries.length > 0) {
          setFocusedIdx((i) => (i < filteredEntries.length - 1 ? i + 1 : 0));
        } else if (isLog && filteredLogEntries.length > 0) {
          setFocusedIdx((i) => (i < filteredLogEntries.length - 1 ? i + 1 : 0));
        } else if (diffMode === 'git' && gitFileCount > 0) {
          setGitFileIdx((i) => (i < gitFileCount - 1 ? i + 1 : 0));
        }
        break;

      case 'ArrowLeft':
      case 'ArrowRight':
        if (diffMode === 'git') {
          e.preventDefault();
          setDiffScope(e.key === 'ArrowLeft' ? 'working' : 'all');
        }
        break;

      default:
        // Alt+letter shortcuts
        if (e.altKey) {
          switch (e.code) {
            case 'KeyG':
              e.preventDefault();
              dispatch({ type: 'SET_DIFF_MODE', mode: 'git' });
              break;
            case 'KeyA':
              e.preventDefault();
              dispatch({ type: 'SET_DIFF_MODE', mode: 'activity' });
              break;
            case 'KeyL':
              e.preventDefault();
              dispatch({ type: 'SET_DIFF_MODE', mode: 'log' });
              break;
            case 'KeyU':
              e.preventDefault();
              dispatch({ type: 'SET_DIFF_MODE', mode: 'review' });
              break;
            case 'KeyT':
              if (diffMode === 'git') {
                e.preventDefault();
                setDiffScope('working');
              }
              break;
            case 'KeyC':
              if (diffMode === 'git') {
                e.preventDefault();
                setDiffScope('all');
              }
              break;
          }
        }
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-30 flex flex-col focus:outline-none"
      style={{ backgroundColor: 'var(--color-app)' }}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center justify-between h-10 px-4 border-b border-border-default flex-shrink-0">
        <div className="flex items-center gap-4">
          <PillToggle
            options={modeOptions}
            value={diffMode}
            onChange={(m) => dispatch({ type: 'SET_DIFF_MODE', mode: m })}
            size="md"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-faint">
            &uarr;&darr; navigate &middot; Tab/&#8679;Tab cycle &middot; type to search &middot; Esc close
          </span>
          <button
            tabIndex={-1}
            className="text-secondary hover:text-primary text-lg leading-none"
            onClick={() => dispatch({ type: 'TOGGLE_DIFF' })}
          >
            &times;
          </button>
        </div>
      </div>

      <SearchIndicator
        search={search}
        className="mx-4 mt-3 flex-shrink-0"
        matchInfo={
          isActivity ? `${filteredEntries.length} match${filteredEntries.length !== 1 ? 'es' : ''}` :
          isLog ? `${filteredLogEntries.length} commit${filteredLogEntries.length !== 1 ? 's' : ''}` :
          diffMode === 'git' ? `${gitFileCount} file${gitFileCount !== 1 ? 's' : ''}` :
          undefined
        }
      />

      {state.activeTaskId && diffMode === 'git' && (
        <GitDiffContent
          taskId={state.activeTaskId}
          search={search}
          gitFileIdx={gitFileIdx}
          onSetGitFileIdx={setGitFileIdx}
          onFileCount={setGitFileCount}
          filesRef={gitFilesRef}
          scope={diffScope}
          onSetScope={setDiffScope}
        />
      )}

      {state.activeTaskId && isLog && (
        <div className="flex-1 overflow-auto p-4">
          {gitLog.loading && (
            <div className="flex items-center gap-2 text-secondary">
              <Spinner />
              <span>Loading git log...</span>
            </div>
          )}

          {gitLog.error && (
            <div className="text-sm text-danger">Error: {gitLog.error}</div>
          )}

          {!gitLog.loading && !gitLog.error && filteredLogEntries.length === 0 && (
            <div className="text-sm text-muted text-center py-4">
              {search ? 'No matching commits' : 'No commits'}
            </div>
          )}

          {!gitLog.loading && !gitLog.error && filteredLogEntries.length > 0 && (
            <div className="space-y-1">
              {filteredLogEntries.map((entry, idx) => (
                <div
                  key={entry.sha}
                  ref={(el) => { itemRefs.current[idx] = el; }}
                  onMouseEnter={() => setFocusedIdx(idx)}
                >
                  <GitLogEntryView entry={entry} focused={idx === focusedIdx} search={search} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div ref={scrollRef} className={`flex-1 overflow-auto p-4 ${!isActivity ? 'hidden' : ''}`}>
        {state.activeTaskId && isActivity && (
          <>
            {activityLog.loading && (
              <div className="flex items-center gap-2 text-secondary">
                <Spinner />
                <span>Loading activity log...</span>
              </div>
            )}

            {activityLog.error && (
              <div className="text-sm text-danger">Error: {activityLog.error}</div>
            )}

            {!activityLog.loading && !activityLog.error && filteredEntries.length === 0 && (
              <div className="text-sm text-muted text-center py-4">
                {search ? 'No matching entries' : 'No activity recorded yet'}
              </div>
            )}

            {!activityLog.loading && !activityLog.error && (
              <div className="space-y-1">
                {filteredEntries.map((entry, idx) => (
                  <div
                    key={entry.id}
                    ref={(el) => { itemRefs.current[idx] = el; }}
                    onMouseEnter={() => setFocusedIdx(idx)}
                    className={`rounded transition-colors ${
                      idx === focusedIdx
                        ? 'ring-1 ring-accent-muted bg-accent/10'
                        : ''
                    }`}
                  >
                    <ActivityEntryView entry={entry} search={search} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {state.activeTaskId && isReview && (
        <ReviewPanel taskId={state.activeTaskId} />
      )}

      {!state.activeTaskId && (
        <div className="flex-1 p-4 text-muted">No active task</div>
      )}
    </div>
  );
}
