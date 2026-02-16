import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Task } from '../shared/types';

const TASKS_PATH = path.join(os.homedir(), '.bifrost', 'tasks.json');

export function loadTasks(): Task[] {
  if (!fs.existsSync(TASKS_PATH)) return [];
  try {
    const raw = fs.readFileSync(TASKS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveTasks(tasks: Task[]): void {
  const dir = path.dirname(TASKS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = TASKS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf-8');
  fs.renameSync(tmp, TASKS_PATH);
}
