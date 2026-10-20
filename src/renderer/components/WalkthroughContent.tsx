import type React from 'react';
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { parseDiff } from '../../shared/diff-parser';
import type { Anchor, AnchorStatus, Comment, Step, StepKind, Walkthrough } from '../../shared/walkthrough';
import { useWalkthrough } from '../hooks/useWalkthrough';
import { isModKey } from '../utils/platform';
import { layOut, type Shown } from '../utils/walkthrough-layout';
import { type DiffAnnotations, LazyFileSection } from './DiffFileView';
import FormInput from './FormInput';
import PrimaryButton from './PrimaryButton';
import SectionHeader from './SectionHeader';
import SimpleMarkdown from './SimpleMarkdown';
import Spinner from './Spinner';

export const WALKTHROUGH_HINTS = '↑↓ step · ←→ chapter · ⌥R regenerate · ⌥H current head · ⌘O open · Esc close';

const KIND: Record<StepKind, { label: string; dot: string; border: string; text: string }> = {
  narration: { label: 'Narration', dot: 'bg-accent', border: 'border-accent', text: 'text-accent-hover' },
  finding: { label: 'Finding', dot: 'bg-accent-hover', border: 'border-accent-hover', text: 'text-accent-hover' },
  concern: { label: 'Concern', dot: 'bg-warning', border: 'border-warning', text: 'text-warning' },
  bug: { label: 'Bug', dot: 'bg-danger', border: 'border-danger', text: 'text-danger' },
};

const STATUS: Record<Exclude<AnchorStatus, 'exact'>, { label: string; className: string }> = {
  shifted: { label: 'moved', className: 'text-muted' },
  fuzzy: { label: 're-anchored by text', className: 'text-warning' },
  lost: { label: 'lines changed since', className: 'text-danger' },
};

function StatusBadge({ status }: { status: AnchorStatus | null }) {
  if (!status || status === 'exact') return null;
  const s = STATUS[status];
  return <span className={`text-xs ${s.className} shrink-0`}>{s.label}</span>;
}

function SnippetBlock({ anchor }: { anchor: Anchor }) {
  const { first, last } = anchor.snippet;
  return (
    <pre className="mt-2 rounded-sm bg-surface-alt px-2 py-1 font-mono text-xs text-secondary overflow-x-auto">
      {[...first, ...(last.length ? ['…', ...last] : [])].join('\n')}
    </pre>
  );
}

function CommentRow({ comment }: { comment: Comment }) {
  const k = KIND[comment.kind];
  return (
    <div
      className={`sticky left-0 max-w-3xl my-1 ml-24 border-l-2 ${k.border} bg-surface px-3 py-1.5 font-sans text-xs text-primary`}
    >
      <span className={`font-semibold ${k.text}`}>{k.label}</span>
      <SimpleMarkdown text={comment.body} />
    </div>
  );
}

function StepCard({
  step,
  index,
  total,
  status,
  anchor,
  outside,
  orphanComments,
}: {
  step: Step;
  index: number;
  total: number;
  status: AnchorStatus | null;
  anchor: Anchor | null;
  outside: boolean;
  orphanComments: Comment[];
}) {
  const k = KIND[step.kind];
  return (
    <div
      data-current-step
      className={`sticky left-0 max-w-3xl my-2 scroll-mt-10 rounded-sm border border-border-default border-l-4 ${k.border} bg-surface px-4 py-3 font-sans text-sm text-primary shadow-sm`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted shrink-0">
          {index + 1} / {total}
        </span>
        {step.kind !== 'narration' && <span className={`text-xs font-semibold ${k.text}`}>{k.label}</span>}
        <span className="font-semibold">{step.title}</span>
        <span className="ml-auto" />
        <StatusBadge status={status} />
      </div>
      <div className="mt-1 text-secondary">
        <SimpleMarkdown text={step.body} />
      </div>
      {step.unverified && (
        <div className="mt-2 text-xs text-warning">The generator named lines its quote could not be found at.</div>
      )}
      {outside && step.anchor && (
        <>
          <div className="mt-2 text-xs text-muted">
            {status === 'lost'
              ? 'These lines changed after this walkthrough was written. As written:'
              : `${step.anchor.path}:${step.anchor.lines[0]}–${step.anchor.lines[1]}, outside the diff's hunks:`}
          </div>
          <SnippetBlock anchor={anchor ?? step.anchor} />
        </>
      )}
      {orphanComments.map((c) => (
        <div key={c.id} className={`mt-2 border-l-2 ${KIND[c.kind].border} pl-2 text-xs`}>
          <span className={`font-semibold ${KIND[c.kind].text}`}>{KIND[c.kind].label}</span>
          <SimpleMarkdown text={c.body} />
        </div>
      ))}
    </div>
  );
}

function StepMarker({ step, index, onSelect }: { step: Step; index: number; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="sticky left-0 flex items-center gap-1.5 px-2 py-0.5 font-sans text-xs text-muted hover:text-primary transition-colors"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${KIND[step.kind].dot}`} />
      {index + 1}. {step.title}
    </button>
  );
}

function StepList({
  w,
  current,
  onSelect,
  statusOf,
}: {
  w: Walkthrough;
  current: number;
  onSelect: (i: number) => void;
  statusOf: (step: Step) => AnchorStatus | null;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    refs.current[current]?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <div className="w-72 shrink-0 border-r border-border-default overflow-y-auto">
      <div className="px-3 py-2 border-b border-border-default text-xs text-secondary">
        <SimpleMarkdown text={w.summary} />
      </div>
      {w.steps.map((step, i) => (
        <div key={step.id}>
          {step.chapter && step.chapter !== w.steps[i - 1]?.chapter && (
            <SectionHeader className="px-3 pt-3 pb-1">{step.chapter}</SectionHeader>
          )}
          <button
            type="button"
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => onSelect(i)}
            className={`w-full flex items-center gap-2 py-1 pl-3 pr-2 text-left text-xs cursor-pointer ${
              i === current
                ? 'bg-surface-alt/50 border-l-2 border-accent-hover'
                : 'border-l-2 border-transparent hover:bg-surface transition-colors'
            }`}
          >
            <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${KIND[step.kind].dot}`} />
            <span className="text-muted shrink-0">{i + 1}.</span>
            <span className="text-primary truncate">{step.title}</span>
            <span className="ml-auto" />
            <StatusBadge status={step.anchor ? statusOf(step) : null} />
          </button>
        </div>
      ))}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'muted' | 'warning'; children: React.ReactNode }) {
  const cls = tone === 'warning' ? 'bg-warning/10 text-warning' : 'bg-surface text-secondary';
  return (
    <div className={`px-4 py-1.5 border-b border-border-default text-xs flex items-center gap-3 ${cls}`}>
      {children}
    </div>
  );
}

const LINK = 'text-accent-hover hover:text-primary transition-colors';

export interface WalkthroughHandle {
  /** True when the key was the walkthrough's to handle. */
  handleKeyDown(e: React.KeyboardEvent): boolean;
}

export default function WalkthroughContent({
  taskId,
  worktreePath,
  ref,
}: {
  taskId: string;
  worktreePath: string;
  ref?: React.Ref<WalkthroughHandle>;
}) {
  const wt = useWalkthrough(taskId);
  const { walkthrough: w, remapped, onCurrentHead } = wt;
  const [current, setCurrent] = useState(0);
  const [focus, setFocus] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const focusInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrent(0);
    setFocus(w?.focus ?? '');
    setRegenerating(false);
  }, [w?.generatedAt]);

  const files = useMemo(() => (wt.diff ? parseDiff(wt.diff) : []), [wt.diff]);
  const shown = useMemo(
    () =>
      (id: string, anchor: Anchor | null): Shown => {
        if (!onCurrentHead) return { anchor, status: anchor ? 'exact' : null };
        const r = remapped?.[id];
        return r ? { anchor: r.anchor, status: r.status } : { anchor: null, status: null };
      },
    [onCurrentHead, remapped],
  );
  const steps = w?.steps ?? [];
  const layout = useMemo(() => layOut(files, steps, shown, current), [files, steps, shown, current]);

  useEffect(() => {
    if (!w || files.length === 0) return;
    const id = requestAnimationFrame(() => {
      scroller.current?.querySelector('[data-current-step]')?.scrollIntoView({ block: 'start', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [current, files, w, layout]);

  useEffect(() => {
    if (regenerating) focusInput.current?.focus();
  }, [regenerating]);

  const generate = () => {
    // The input unmounts below, and the overlay only hears keys while focus is inside it.
    focusInput.current?.parentElement?.closest<HTMLElement>('[tabindex="-1"]')?.focus();
    setRegenerating(false);
    wt.generate(focus.trim() || null);
  };

  const chapterStarts = steps.flatMap((s, i) => (i === 0 || s.chapter !== steps[i - 1].chapter ? [i] : []));

  const openInIde = async () => {
    const step = steps[current];
    if (!step?.anchor) return;
    const map = remapped ?? (await window.bifrost.remapWalkthrough(taskId));
    const now = map[step.id]?.anchor;
    if (now && now.side === 'new') window.bifrost.openInIde(worktreePath, now.path, now.lines[0]);
    else window.bifrost.openInIde(worktreePath, step.anchor.path);
  };

  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (isModKey(e) && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openInIde();
      return true;
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.code === 'KeyR' && w) {
        e.preventDefault();
        setRegenerating(true);
        return true;
      }
      if (e.code === 'KeyH' && w) {
        e.preventDefault();
        wt.setOnCurrentHead(!onCurrentHead);
        return true;
      }
      return false;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setCurrent((i) => Math.min(i + 1, steps.length - 1));
        return true;
      case 'ArrowUp':
        e.preventDefault();
        setCurrent((i) => Math.max(i - 1, 0));
        return true;
      case 'ArrowRight': {
        e.preventDefault();
        const next = chapterStarts.find((s) => s > current);
        if (next !== undefined) setCurrent(next);
        return true;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const prev = chapterStarts.filter((s) => s < current).at(-1);
        if (prev !== undefined) setCurrent(prev);
        return true;
      }
      case 'Enter':
        if (w || wt.generating) return false;
        e.preventDefault();
        generate();
        return true;
    }
    return false;
  };

  useImperativeHandle(ref, () => ({ handleKeyDown }));

  const focusField = (
    <FormInput
      ref={focusInput}
      value={focus}
      onChange={(e) => setFocus(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          generate();
        }
      }}
      placeholder="Focus (optional): what should the tour pay attention to?"
      className="flex-1 px-3 py-1.5"
    />
  );

  if (wt.loading) {
    return (
      <div className="flex items-center gap-2 text-secondary p-4">
        <Spinner />
        <span>Loading walkthrough...</span>
      </div>
    );
  }

  if (wt.generating) {
    return (
      <div className="flex items-center gap-2 text-secondary p-4">
        <Spinner />
        <span>Narrating the change. This takes a few minutes...</span>
      </div>
    );
  }

  if (!w) {
    return (
      <div className="flex-1 flex justify-center pt-12">
        <div className="w-[36rem] space-y-3">
          <div className="text-sm text-muted text-center py-4">No walkthrough for this change yet</div>
          <div className="flex gap-2">
            {focusField}
            <PrimaryButton onClick={generate}>Generate</PrimaryButton>
          </div>
          {wt.generateError && <div className="text-sm text-danger">{wt.generateError}</div>}
        </div>
      </div>
    );
  }

  const step = steps[current];
  const statusOf = (s: Step) => shown(s.id, s.anchor).status;
  const unverified = steps.filter((s) => s.unverified).length;
  const st = wt.staleness;
  const short = (sha: string) => sha.slice(0, 7);
  const currentUnplaced = step && layout.unplaced.has(current);

  const annotations = (fi: number): DiffAnnotations | undefined => {
    if (!layout.annotatedFiles.has(fi)) return undefined;
    return {
      lineClass: (line) =>
        layout.highlighted.has(line) && step ? `border-l-2 ${KIND[step.kind].border}` : 'border-l-2 border-transparent',
      before: (line) =>
        layout.before
          .get(line)
          ?.map((i) =>
            i === current ? (
              <StepCard
                key={steps[i].id}
                step={steps[i]}
                index={i}
                total={steps.length}
                status={statusOf(steps[i])}
                anchor={shown(steps[i].id, steps[i].anchor).anchor}
                outside={false}
                orphanComments={layout.orphanComments.get(steps[i].id) ?? []}
              />
            ) : (
              <StepMarker key={steps[i].id} step={steps[i]} index={i} onSelect={() => setCurrent(i)} />
            ),
          ),
      after: (line) => layout.after.get(line)?.map((c) => <CommentRow key={c.id} comment={c} />),
    };
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default shrink-0">
        <span className="text-sm font-semibold text-primary truncate">{w.title}</span>
        {step?.chapter && <span className="text-xs text-secondary truncate">{step.chapter}</span>}
        <span className="ml-auto text-xs text-muted shrink-0">
          {steps.length ? `${current + 1} / ${steps.length}` : 'no steps'}
        </span>
        <button
          type="button"
          onClick={() => setCurrent((i) => Math.max(i - 1, 0))}
          className="text-secondary hover:text-primary transition-colors"
        >
          ◀
        </button>
        <button
          type="button"
          onClick={() => setCurrent((i) => Math.min(i + 1, steps.length - 1))}
          className="text-secondary hover:text-primary transition-colors"
        >
          ▶
        </button>
      </div>

      {regenerating && (
        <div className="flex gap-2 px-4 py-2 border-b border-border-default">
          {focusField}
          <PrimaryButton size="sm" onClick={generate}>
            Regenerate
          </PrimaryButton>
          <button type="button" onClick={() => setRegenerating(false)} className={`text-xs ${LINK}`}>
            Cancel
          </button>
        </div>
      )}
      {wt.generateError && <Banner tone="warning">{wt.generateError}</Banner>}
      {st && st.state !== 'current' && (
        <Banner tone="warning">
          <span>
            Written against {short(w.change.head)}. The branch is now {short(st.currentHead)}
            {st.state === 'ahead'
              ? `, ${st.commitsAhead} commit${st.commitsAhead === 1 ? '' : 's'} ahead.`
              : ', rebased.'}
            {onCurrentHead ? ' Showing the current head.' : ' Showing the change as written.'}
          </span>
          <button type="button" onClick={() => wt.setOnCurrentHead(!onCurrentHead)} className={LINK}>
            {onCurrentHead ? 'Show as written' : 'Show on current head'}
          </button>
          <button type="button" onClick={() => setRegenerating(true)} className={LINK}>
            Regenerate
          </button>
        </Banner>
      )}
      {st?.dirty && <Banner tone="muted">Uncommitted changes are not part of this walkthrough.</Banner>}
      {unverified > 0 && (
        <Banner tone="muted">
          {unverified} step{unverified === 1 ? ' names' : 's name'} lines that could not be found, and show without an
          anchor.
        </Banner>
      )}

      <div className="flex-1 flex min-h-0">
        <StepList w={w} current={current} onSelect={setCurrent} statusOf={statusOf} />
        <div ref={scroller} className="flex-1 overflow-auto px-4 pb-4">
          {steps.length === 0 && (
            <div className="text-sm text-muted text-center py-4">The generator produced no steps.</div>
          )}
          {wt.diffError && <div className="text-sm text-danger p-4">Error: {wt.diffError}</div>}
          {currentUnplaced && (
            <StepCard
              step={step}
              index={current}
              total={steps.length}
              status={statusOf(step)}
              anchor={shown(step.id, step.anchor).anchor}
              outside={!!step.anchor}
              orphanComments={layout.orphanComments.get(step.id) ?? []}
            />
          )}
          {files.map((file, i) => (
            <LazyFileSection
              key={`${file.newPath || file.oldPath}-${i}`}
              file={file}
              forceVisible={layout.annotatedFiles.has(i)}
              annotations={annotations(i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
