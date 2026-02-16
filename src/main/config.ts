import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BifrostConfig, DEFAULT_CONFIG } from '../shared/types';

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

  // Migrate sandbox: boolean -> permissionMode
  if ('sandbox' in raw && !('permissionMode' in raw)) {
    raw.permissionMode = raw.sandbox ? 'sandbox' : 'default';
    delete raw.sandbox;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf-8');
  }

  return { ...DEFAULT_CONFIG, ...raw };
}

export function saveConfig(config: BifrostConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
