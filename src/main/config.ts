import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BifrostConfig, DEFAULT_CONFIG, type Machine } from '../shared/types.ts';

export { mergeRendererConfig } from './config-merge.ts';

const CONFIG_DIR = path.join(os.homedir(), '.bifrost');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): BifrostConfig {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  let dirty = false;

  // Migrate sandbox: boolean -> permissionMode
  if ('sandbox' in raw) {
    if (!('permissionMode' in raw)) {
      raw.permissionMode = raw.sandbox ? 'sandbox' : 'default';
    }
    delete raw.sandbox;
    dirty = true;
  }

  if (dirty) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf-8');
  }

  return { ...DEFAULT_CONFIG, ...raw };
}

export function saveConfig(config: BifrostConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Adds the machine ssh reaches as host, named after its first label unless named. A host already there is answered as it is. */
export function addMachine(host: string, name = host.split('.')[0]): Machine {
  const config = loadConfig();
  const machines = config.machines ?? [];
  const known = machines.find((m) => m.host === host);
  if (known) return known;
  const taken = machines.find((m) => m.name === name);
  if (taken) throw new Error(`The machine "${name}" is ${taken.host}. Give this one another name.`);
  const machine: Machine = { name, host };
  saveConfig({ ...config, machines: [...machines, machine] });
  return machine;
}

export function removeMachine(name: string): void {
  const config = loadConfig();
  const machines = config.machines ?? [];
  if (!machines.some((m) => m.name === name)) throw new Error(`No machine named "${name}"`);
  const rest = machines.filter((m) => m.name !== name);
  saveConfig({ ...config, machines: rest.length > 0 ? rest : undefined });
}
