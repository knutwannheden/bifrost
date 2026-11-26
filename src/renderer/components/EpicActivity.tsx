import { useState } from 'react';
import { projectEpic } from '../../shared/epic';
import type { EpicChange, EpicState, EpicUpdate, Task } from '../../shared/types';
import { useApp } from '../context/AppContext';
import { terminalRegistry } from '../hooks/useTerminal';
import { formatDate } from '../utils/format-time';
import FormTextarea from './FormTextarea';
import PrimaryButton from './PrimaryButton';
import SectionHeader from './SectionHeader';

type Decision = Extract<EpicChange, { kind: 'decision' }>;

const itemLabels = { open: 'Open', done: 'Done', dropped: 'Dropped' } as const;
const decisionLabels = {
  open: 'Decision raised',
  'awaiting-advice': 'Advice requested',
  'needs-user': 'Asked for your input',
  resolved: 'Decision resolved',
} as const;
const wrap = 'whitespace-pre-wrap wrap-break-word';

function DecisionEvidence({ decision }: { decision: Decision }) {
  return (
    <>
      {decision.rationale && <div className={`text-secondary ${wrap}`}>{decision.rationale}</div>}
      {decision.reference && <div className={`text-muted ${wrap}`}>Reference · {decision.reference}</div>}
    </>
  );
}

function DecisionDetails({ decision, showQuestion = true }: { decision: Decision; showQuestion?: boolean }) {
  return (
    <>
      {showQuestion && <div className={`text-primary ${wrap}`}>{decision.question}</div>}
      {decision.recommendation && decision.status !== 'resolved' && (
        <div className={`text-secondary ${wrap}`}>
          <span className="font-semibold">Recommendation</span> · {decision.recommendation}
        </div>
      )}
      {decision.options && decision.status !== 'resolved' && (
        <ul className="list-disc pl-4 text-secondary">
          {[...new Set(decision.options)].map((option) => (
            <li className={wrap} key={option}>
              {option}
            </li>
          ))}
        </ul>
      )}
      {decision.answer && (
        <div className={`text-secondary ${wrap}`}>
          {decision.decidedBy === 'user' ? 'You decided' : 'Coordinator decided'} · {decision.answer}
        </div>
      )}
      {decision.status !== 'needs-user' && <DecisionEvidence decision={decision} />}
    </>
  );
}

function DecisionReply({ taskId, decision }: { taskId: string; decision: Decision }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<'sent' | 'queued'>();
  const [error, setError] = useState('');
  const locked = sending || delivery !== undefined;

  const send = async () => {
    if (locked || !draft.trim()) return;
    setSending(true);
    setError('');
    const prompt = [
      `My reply to epic decision "${decision.id}".`,
      decision.question,
      decision.reference && `Reference ${decision.reference}`,
      draft,
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      const result = await window.bifrost.sendPrompt(taskId, prompt, 'queue');
      if (!result.ok) throw new Error(result.error || 'Could not send your reply.');
      setDelivery(result.queued ? 'queued' : 'sent');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not send your reply.');
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="space-y-1.5 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <FormTextarea
        aria-label={`Reply to ${decision.question}`}
        placeholder="Type your decision…"
        className="w-full resize-y px-2 py-1"
        rows={2}
        value={draft}
        readOnly={locked}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton size="sm" type="submit" disabled={locked || !draft.trim()}>
          {sending ? 'Sending…' : 'Send reply'}
        </PrimaryButton>
        {delivery && <span role="status">{delivery === 'queued' ? 'Reply queued' : 'Reply sent'}</span>}
        {error && (
          <span className="text-danger" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

export default function EpicActivity({ task, epic }: { task: Task; epic: EpicState }) {
  const { state, dispatch } = useApp();
  const [marking, setMarking] = useState(false);
  const { items, decisions, outcome } = projectEpic(epic);
  const newest = epic.updates.at(-1)?.seq ?? 0;
  const unread = epic.updates.filter((entry) => entry.seq > epic.checkedThrough);
  const tasks = new Map(state.tasks.map((entry) => [entry.id, entry]));
  const itemById = new Map(items.map((entry) => [entry.id, entry]));
  const userDecisions = decisions.filter((entry) => entry.status === 'needs-user');
  const needsUser = userDecisions.length > 0;
  const coordinatorDecisions = decisions.filter(
    (entry) => entry.status === 'awaiting-advice' || entry.status === 'open',
  );
  const resolvedDecisions = decisions.filter((entry) => entry.status === 'resolved');
  const canCheckIn = !task.unreachable && !epic.handoffPending;
  const canReply = task.status === 'running' && !task.unreachable;

  const markCheckedIn = async () => {
    setMarking(true);
    try {
      const through = await window.bifrost.markEpicCheckedIn(task.id, newest);
      dispatch({ type: 'SET_EPIC_CHECK_IN', taskId: task.id, through });
    } catch (error) {
      dispatch({
        type: 'SHOW_TOAST',
        message: error instanceof Error ? error.message : 'Could not mark the epic as checked in',
      });
    } finally {
      setMarking(false);
    }
  };

  const taskLink = (id: string) => {
    const entry = tasks.get(id);
    if (!entry) return <span className="text-muted">Task unavailable</span>;
    if (entry.status === 'archived') return <span className="text-muted">{entry.name} · Archived</span>;
    return (
      <button
        type="button"
        className="text-left text-accent-hover hover:underline transition-colors"
        onClick={() => dispatch({ type: 'SET_ACTIVE_TASK', taskId: id })}
      >
        {entry.name}
      </button>
    );
  };

  const changeSummary = (entry: EpicUpdate) => {
    switch (entry.kind) {
      case 'item':
        return (
          <>
            <div>
              {itemById.get(entry.id)?.addedSeq === entry.seq ? 'Added' : itemLabels[entry.status]} · {entry.title}
            </div>
            {entry.detail && <div className={`text-muted ${wrap}`}>{entry.detail}</div>}
          </>
        );
      case 'decision':
        return (
          <>
            <div className="text-muted">{decisionLabels[entry.status]}</div>
            {entry.status === 'resolved' ? (
              <DecisionDetails decision={entry} />
            ) : (
              <div className={wrap}>{entry.question}</div>
            )}
          </>
        );
      case 'attach':
        return <div>Attached · {taskLink(entry.taskId)}</div>;
      case 'report':
        return (
          <>
            <div className="text-muted">
              {itemById.get(entry.itemId)?.title ?? entry.itemId} · {taskLink(entry.authorTaskId)}
            </div>
            <div className={wrap}>{entry.text}</div>
            {entry.revision && <div className={`text-muted ${wrap}`}>{entry.revision}</div>}
          </>
        );
      case 'end':
        return <div className={wrap}>Outcome · {entry.text}</div>;
      case 'note':
        return <div className={wrap}>{entry.text}</div>;
    }
  };

  return (
    <div className="space-y-4 px-2 py-2 text-xs text-secondary leading-relaxed">
      {task.unreachable && (
        <div className="text-warning">Showing the last known activity. {task.machine} is offline.</div>
      )}
      {epic.handoffPending && (
        <div className="text-warning">The epic is changing owner. Check-in is temporarily unavailable.</div>
      )}
      <section className="space-y-2">
        <SectionHeader className={needsUser ? 'text-warning' : ''}>
          {needsUser ? 'Needs your decision' : 'Your decisions'}
        </SectionHeader>
        {!needsUser && (
          <p className="text-muted">
            {task.unreachable ? 'No decisions needed your input at the last update.' : 'No decisions need your input.'}
          </p>
        )}
        {userDecisions.map((decision) => {
          const update = epic.updates.findLast((entry) => entry.kind === 'decision' && entry.id === decision.id);
          return (
            <div key={decision.id} className="space-y-1 rounded-sm border border-warning/30 bg-warning/10 p-2">
              <DecisionDetails decision={decision} />
              {decision.itemId && (
                <div className="text-muted">Waiting · {itemById.get(decision.itemId)?.title ?? decision.itemId}</div>
              )}
              {canReply && <DecisionReply key={update?.seq} taskId={task.id} decision={decision} />}
              {(decision.rationale || decision.reference) && (
                <details className="pt-1">
                  <summary className="cursor-pointer text-secondary">Technical details</summary>
                  <div className="mt-1 space-y-1 pl-4">
                    <DecisionEvidence decision={decision} />
                  </div>
                </details>
              )}
            </div>
          );
        })}
        {needsUser &&
          !task.unreachable &&
          (canReply ? (
            <button
              type="button"
              className="text-accent-hover hover:underline transition-colors"
              onClick={() => terminalRegistry.get(task.id)?.focus()}
            >
              Reply in epic terminal
            </button>
          ) : (
            <p className="text-muted">Reopen the epic to reply.</p>
          ))}
      </section>
      {coordinatorDecisions.length > 0 && (
        <section className="space-y-2">
          <SectionHeader>With the coordinator</SectionHeader>
          {coordinatorDecisions.map((decision) => (
            <details key={decision.id}>
              <summary className={`cursor-pointer text-primary marker:text-muted ${wrap}`}>
                {decision.question}
                <span className="ml-2 text-muted">
                  {decision.status === 'awaiting-advice' ? 'Awaiting advice' : 'Under review'}
                </span>
              </summary>
              <div className="mt-1 space-y-1 pl-4">
                <DecisionDetails decision={decision} showQuestion={false} />
                {decision.itemId && (
                  <div className="text-muted">Waiting · {itemById.get(decision.itemId)?.title ?? decision.itemId}</div>
                )}
                {decision.status === 'awaiting-advice' && decision.advisorTaskId && (
                  <div className="text-muted">Advisor · {taskLink(decision.advisorTaskId)}</div>
                )}
              </div>
            </details>
          ))}
        </section>
      )}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <SectionHeader>Since last check-in</SectionHeader>
          <PrimaryButton size="sm" disabled={!canCheckIn || marking || unread.length === 0} onClick={markCheckedIn}>
            Mark checked in
          </PrimaryButton>
        </div>
        {unread.length > 0 ? (
          <ol className="divide-y divide-border-default">
            {unread.map((entry) => (
              <li key={entry.seq} className="flex items-baseline gap-2 py-1">
                <time className="w-20 shrink-0 text-muted" dateTime={new Date(entry.at).toISOString()}>
                  {formatDate(entry.at)}
                </time>
                <div className="min-w-0 flex-1">{changeSummary(entry)}</div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted">No new activity.</p>
        )}
      </section>
      <section className="space-y-2">
        <SectionHeader>Work items</SectionHeader>
        <div className={`text-primary ${wrap}`}>{epic.goal}</div>
        {outcome && <div className={`text-secondary ${wrap}`}>Outcome · {outcome}</div>}
        {items.length === 0 && <p className="text-muted">No work items yet.</p>}
        {items.map((item) => (
          <div key={item.id} className="rounded-sm border border-border-default bg-surface-alt/30 p-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <div className="text-primary">{item.title}</div>
              <div className="flex shrink-0 gap-2 text-muted">
                {item.addedSeq > epic.checkedThrough && <span className="text-accent-hover">New</span>}
                <span className={item.status === 'done' ? 'text-success' : undefined}>{itemLabels[item.status]}</span>
              </div>
            </div>
            {item.detail && <div className={wrap}>{item.detail}</div>}
            {item.taskId && <div>{taskLink(item.taskId)}</div>}
            {resolvedDecisions
              .filter((decision) => decision.itemId === item.id)
              .map((decision) => (
                <div key={decision.id} className="mt-2 border-t border-border-default pt-2">
                  <DecisionDetails decision={decision} />
                </div>
              ))}
          </div>
        ))}
      </section>
      {resolvedDecisions.some((decision) => !decision.itemId) && (
        <section className="space-y-2">
          <SectionHeader>Decisions</SectionHeader>
          {resolvedDecisions
            .filter((decision) => !decision.itemId)
            .map((decision) => (
              <div key={decision.id}>
                <DecisionDetails decision={decision} />
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
