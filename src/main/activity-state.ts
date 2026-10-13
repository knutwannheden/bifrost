/**
 * Whether a task is still working, which its turn-level hooks alone cannot say.
 * Subagents outlive the turn that spawned them, so every path that would let a
 * task go idle has to ask here first.
 */

/** Start times of the subagents a task has outstanding, oldest first. */
const outstanding = new Map<string, number[]>();

/** Tasks whose turn has asked to end and is waiting on the subagents above. */
const heldTurns = new Set<string>();

/**
 * SubagentStop arrives over a fire-and-forget curl from an async hook, so one
 * can go missing and leave a task working for as long as it stays open. This
 * bounds that to a single session.
 */
export const SUBAGENT_MAX_MS = 10 * 60_000;

function live(taskId: string, at: number): number[] {
  const starts = (outstanding.get(taskId) ?? []).filter((start) => at - start < SUBAGENT_MAX_MS);
  if (starts.length > 0) outstanding.set(taskId, starts);
  else outstanding.delete(taskId);
  return starts;
}

export function subagentStarted(taskId: string, at: number = Date.now()): void {
  outstanding.set(taskId, [...live(taskId, at), at]);
}

/** One subagent is back. True when that was the last one a held turn waited on. */
export function subagentStopped(taskId: string, at: number = Date.now()): boolean {
  const starts = live(taskId, at);
  starts.shift();
  if (starts.length > 0) outstanding.set(taskId, starts);
  else outstanding.delete(taskId);
  if (starts.length > 0 || !heldTurns.has(taskId)) return false;
  heldTurns.delete(taskId);
  return true;
}

/**
 * Whether the turn ends now. False holds it open until the subagents are back,
 * at which point `subagentStopped` reports it ending.
 */
export function turnEnded(taskId: string, at: number = Date.now()): boolean {
  if (live(taskId, at).length === 0) {
    heldTurns.delete(taskId);
    return true;
  }
  heldTurns.add(taskId);
  return false;
}

export function subagentsRunning(taskId: string, at: number = Date.now()): boolean {
  return live(taskId, at).length > 0;
}

/** Tasks whose held turn has outlasted its subagents, and so ends now. */
export function sweepHeldTurns(at: number = Date.now()): string[] {
  const ended: string[] = [];
  for (const taskId of heldTurns) {
    if (live(taskId, at).length > 0) continue;
    heldTurns.delete(taskId);
    ended.push(taskId);
  }
  return ended;
}

/** Drops a task's outstanding work, for a new prompt or a session that is gone. */
export function forgetTask(taskId: string): void {
  outstanding.delete(taskId);
  heldTurns.delete(taskId);
}
