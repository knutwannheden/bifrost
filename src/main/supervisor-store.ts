import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SupervisorState } from '../shared/types';

const SUPERVISOR_PATH = path.join(os.homedir(), '.bifrost', 'supervisor.json');

const DEFAULT_STATE: SupervisorState = {
  running: false,
  concurrency: 2,
  items: [],
};

export function loadSupervisorState(): SupervisorState {
  if (!fs.existsSync(SUPERVISOR_PATH)) return { ...DEFAULT_STATE, items: [] };
  try {
    const raw = fs.readFileSync(SUPERVISOR_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULT_STATE, items: [] };
  }
}

export function saveSupervisorState(state: SupervisorState): void {
  const dir = path.dirname(SUPERVISOR_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = SUPERVISOR_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, SUPERVISOR_PATH);
}
