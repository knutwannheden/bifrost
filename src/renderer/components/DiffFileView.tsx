import React, { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffLine } from '../../shared/diff-parser';
import { extFromPath } from '../../shared/diff-parser';
import { isDarkTheme } from '../hooks/useTheme';
import { type WordRange, wordRanges } from '../utils/inline-diff';
import type { HighlightedToken } from '../utils/syntax-highlight';
import { highlightLines } from '../utils/syntax-highlight';
import DiffLineTokens from './DiffLineTokens';

/** What a caller draws on a diff's lines, keyed by the line itself. */
export interface DiffAnnotations {
  lineClass?(line: DiffLine): string | undefined;
  before?(line: DiffLine): ReactNode;
  after?(line: DiffLine): ReactNode;
}

interface HighlightedFile {
  file: DiffFile;
  /** One token array per line across all hunks, in order */
  tokensByLine: HighlightedToken[][];
  /** The words each of those lines differs from its counterpart by */
  rangesByLine: (WordRange[] | null)[];
}

function plainTokens(lines: DiffLine[]): HighlightedToken[][] {
  const color = isDarkTheme() ? '#f8f8f2' : '#24292e';
  return lines.map((l) => [{ content: l.content, color }]);
}

const lineNumWidth = 'w-12';

function LineNumber({ num }: { num: number | null }) {
  return (
    <span className={`${lineNumWidth} inline-block text-right pr-2 select-none text-faint text-xs leading-5 shrink-0`}>
      {num ?? ''}
    </span>
  );
}

const lineStyles: Record<DiffLine['type'], { bg: string; wordBg: string; signColor: string; sign: string }> = {
  add: { bg: 'bg-diff-add', wordBg: 'bg-diff-add-word', signColor: 'text-success', sign: '+' },
  remove: { bg: 'bg-diff-remove', wordBg: 'bg-diff-remove-word', signColor: 'text-danger', sign: '-' },
  context: { bg: '', wordBg: '', signColor: 'text-faint', sign: ' ' },
};

function DiffLineRow({
  line,
  tokens,
  ranges,
  extraClass,
}: {
  line: DiffLine;
  tokens: HighlightedToken[];
  ranges: WordRange[] | null;
  extraClass?: string;
}) {
  const { bg: bgClass, wordBg, signColor, sign } = lineStyles[line.type];

  return (
    <div className={`flex leading-5 ${bgClass} ${extraClass ?? ''}`}>
      <LineNumber num={line.oldLineNo} />
      <LineNumber num={line.newLineNo} />
      <span className="flex-1 text-xs leading-5 whitespace-pre">
        <span className={`${signColor} inline-block w-4 text-center`}>{sign}</span>
        <DiffLineTokens tokens={tokens} ranges={ranges} changedBg={wordBg} />
      </span>
    </div>
  );
}

function FileSection({ data, annotations }: { data: HighlightedFile; annotations?: DiffAnnotations }) {
  const { file, tokensByLine, rangesByLine } = data;
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
          <div className="min-w-max">
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
                    <React.Fragment key={`${hi}-${li}`}>
                      {annotations?.before?.(line)}
                      <DiffLineRow
                        line={line}
                        tokens={
                          tokensByLine[idx] ?? [{ content: line.content, color: isDarkTheme() ? '#f8f8f2' : '#24292e' }]
                        }
                        ranges={rangesByLine[idx] ?? null}
                        extraClass={annotations?.lineClass?.(line)}
                      />
                      {annotations?.after?.(line)}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Only renders diff content + highlights when scrolled near the viewport */
export function LazyFileSection({
  file,
  sectionRef,
  forceVisible = false,
  annotations,
}: {
  file: DiffFile;
  sectionRef?: (el: HTMLDivElement | null) => void;
  /** Mount now, for a caller about to scroll into the section. */
  forceVisible?: boolean;
  annotations?: DiffAnnotations;
}) {
  const [visible, setVisible] = useState(forceVisible);
  useEffect(() => {
    if (forceVisible) setVisible(true);
  }, [forceVisible]);
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);
  const observerRef = useRef<HTMLDivElement | null>(null);
  const ranges = useMemo(() => (visible ? wordRanges(file.hunks.map((h) => h.lines)) : []), [visible, file]);

  // Effect 1: detect when the section scrolls near the viewport
  useEffect(() => {
    if (visible) return;
    const el = observerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          setVisible(true);
        }
      },
      { rootMargin: '300px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // Effect 2: run Shiki highlighting once visible (re-runs if file changes)
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    const filePath = file.newPath || file.oldPath;
    const ext = extFromPath(filePath);
    const filename = filePath.split('/').pop() || '';
    highlightLines(
      file.hunks.map((h) => h.lines.map((l) => l.content)),
      ext,
      isDarkTheme(),
      filename,
    ).then((result) => {
      if (!cancelled) setTokens(result);
    });

    return () => {
      cancelled = true;
    };
  }, [visible, file]);

  if (!visible) {
    // Estimated height: 20px per line (leading-5) + hunk separator headers
    const totalLines = file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
    const hunkHeaders = file.hunks.length > 1 ? (file.hunks.length - 1) * 24 : 0;
    const estimatedHeight = file.binary ? 32 : totalLines * 20 + hunkHeaders;

    return (
      <div
        ref={(el) => {
          observerRef.current = el;
          sectionRef?.(el);
        }}
        className="mb-6"
      >
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
    <div
      ref={(el) => {
        observerRef.current = el;
        sectionRef?.(el);
      }}
    >
      <FileSection data={{ file, tokensByLine: displayTokens, rangesByLine: ranges }} annotations={annotations} />
    </div>
  );
}
