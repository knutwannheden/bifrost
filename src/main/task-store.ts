import type { Task, TaskCuration, TaskOutcome } from '../shared/types';
import { getDb } from './db';

// biome-ignore lint/suspicious/noExplicitAny: row objects from SQLite have dynamic fields
type Row = Record<string, any>;

function rowToTask(row: Row): Task {
  const task: Task = {
    id: row.id,
    name: row.name,
    repoId: row.repo_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    status: row.status,
    hasUnread: !!row.has_unread,
    createdAt: row.created_at,
  };

  if (row.session_id != null) task.sessionId = row.session_id;
  if (row.archived_at != null) task.archivedAt = row.archived_at;
  if (row.terminal_title != null) task.terminalTitle = row.terminal_title;
  if (row.summary != null) task.summary = row.summary;
  if (row.is_external) task.isExternal = true;
  if (row.in_place) task.inPlace = true;
  if (row.session_history != null) task.sessionHistory = JSON.parse(row.session_history);
  if (row.claude_active) task.claudeActive = true;

  if (row.cur_outcome != null) {
    const curation: TaskCuration = {
      outcome: row.cur_outcome as TaskOutcome,
      confidence: row.cur_confidence ?? 'auto',
      classifiedAt: row.cur_classified_at ?? 0,
    };
    if (row.cur_reason != null) curation.reason = row.cur_reason;
    if (row.cur_pr_state != null) curation.prState = row.cur_pr_state;
    if (row.cur_branch_merged != null) curation.branchMerged = !!row.cur_branch_merged;
    if (row.cur_user_override != null) curation.userOverride = row.cur_user_override as TaskOutcome;
    if (row.cur_user_note != null) curation.userNote = row.cur_user_note;
    task.curation = curation;
  }

  return task;
}

const UPSERT_SQL = `INSERT OR REPLACE INTO tasks (
  id, name, repo_id, branch, worktree_path, session_id, status, has_unread,
  created_at, archived_at, terminal_title, summary, is_external, in_place,
  session_history, claude_active, cur_outcome, cur_confidence, cur_reason,
  cur_pr_state, cur_branch_merged, cur_classified_at, cur_user_override, cur_user_note
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function taskParams(t: Task) {
  return [
    t.id,
    t.name,
    t.repoId,
    t.branch ?? '',
    t.worktreePath,
    t.sessionId ?? null,
    t.status,
    t.hasUnread ? 1 : 0,
    t.createdAt,
    t.archivedAt ?? null,
    t.terminalTitle ?? null,
    t.summary ?? null,
    t.isExternal ? 1 : 0,
    t.inPlace ? 1 : 0,
    t.sessionHistory ? JSON.stringify(t.sessionHistory) : null,
    t.claudeActive ? 1 : 0,
    t.curation?.outcome ?? null,
    t.curation?.confidence ?? null,
    t.curation?.reason ?? null,
    t.curation?.prState ?? null,
    t.curation?.branchMerged != null ? (t.curation.branchMerged ? 1 : 0) : null,
    t.curation?.classifiedAt ?? null,
    t.curation?.userOverride ?? null,
    t.curation?.userNote ?? null,
  ];
}

export function loadTasks(): Task[] {
  const rows = getDb().prepare<unknown[], Row>('SELECT * FROM tasks ORDER BY created_at').all();
  return rows.map(rowToTask);
}

export function saveTasks(tasks: Task[]): void {
  const d = getDb();
  const save = d.transaction(() => {
    d.prepare('DELETE FROM tasks').run();
    const stmt = d.prepare(UPSERT_SQL);
    for (const t of tasks) {
      stmt.run(...taskParams(t));
    }
  });
  save();
}
