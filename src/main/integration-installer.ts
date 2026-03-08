import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

interface PluginsFile {
  version: number;
  plugins: Record<string, unknown[]>;
}

interface KnownMarketplaces {
  [name: string]: {
    source: { source: string; path: string };
    installLocation: string;
    lastUpdated: string;
    autoUpdate?: boolean;
  };
}

export interface IntegrationStatus {
  installed: boolean;
  updateAvailable: boolean;
}

const MARKETPLACE_NAME = 'bifrost';
const PLUGIN_NAME = 'bifrost';
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const MARKETPLACE_DIR = path.join(os.homedir(), '.bifrost', 'marketplace');
const PLUGIN_DEPLOY_DIR = path.join(MARKETPLACE_DIR, PLUGIN_NAME);
const PLUGINS_FILE = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const KNOWN_MARKETPLACES_FILE = path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const MCP_CONFIG_PATH = path.join(os.homedir(), '.mcp.json');
const OLD_COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands', 'bifrost');
const OLD_MCP_DIR = path.join(os.homedir(), '.bifrost', 'mcp');
const OLD_PLUGIN_DIR = path.join(os.homedir(), '.bifrost', 'plugin');
const OLD_PLUGIN_ID = 'bifrost@local';

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readPluginVersion(pluginDir: string): string | null {
  try {
    const manifest = path.join(pluginDir, '.claude-plugin', 'plugin.json');
    const data = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    return data.version || null;
  } catch {
    return null;
  }
}

/**
 * Claude's marketplace caching may not copy hooks/ into the plugin cache directory.
 * This ensures hooks exist at whatever path Claude is actually loading the plugin from.
 */
export function ensureHooks(): void {
  try {
    if (!fs.existsSync(PLUGINS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as PluginsFile;
    const entries = raw.plugins?.[PLUGIN_ID] as Array<Record<string, unknown>> | undefined;
    if (!entries?.[0]?.installPath) return;

    const installPath = entries[0].installPath as string;
    const cachedHooks = path.join(installPath, 'hooks');
    const sourceHooks = path.join(PLUGIN_DEPLOY_DIR, 'hooks');

    if (!fs.existsSync(path.join(cachedHooks, 'hooks.json')) && fs.existsSync(path.join(sourceHooks, 'hooks.json'))) {
      copyDirSync(sourceHooks, cachedHooks);
      console.log(`[integration] Copied hooks to ${cachedHooks}`);
    }
  } catch {
    // Best-effort
  }
}

export function checkIntegration(): IntegrationStatus {
  try {
    // Check both registration and enablement
    let registered = false;
    if (fs.existsSync(PLUGINS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as PluginsFile;
      registered = !!raw.plugins?.[PLUGIN_ID];
    }

    let enabled = false;
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      enabled = !!(settings.enabledPlugins as Record<string, boolean>)?.[PLUGIN_ID];
    }

    const installed = registered && enabled;
    if (!installed) return { installed: false, updateAvailable: false };

    const deployedVersion = readPluginVersion(PLUGIN_DEPLOY_DIR);
    let sourceVersion: string | null = null;
    try {
      sourceVersion = readPluginVersion(getPluginSourceDir());
    } catch {
      // Plugin source not found in packaged app
    }
    const updateAvailable = !!(sourceVersion && sourceVersion !== deployedVersion);

    return { installed: true, updateAvailable };
  } catch {
    // Malformed JSON or read error
  }
  return { installed: false, updateAvailable: false };
}

export async function installIntegration(): Promise<void> {
  // --- Deploy plugin files into marketplace directory ---
  const pluginSrc = getPluginSourceDir();
  copyDirSync(pluginSrc, PLUGIN_DEPLOY_DIR);

  // --- Create marketplace manifest ---
  const marketplaceManifestDir = path.join(MARKETPLACE_DIR, '.claude-plugin');
  if (!fs.existsSync(marketplaceManifestDir)) fs.mkdirSync(marketplaceManifestDir, { recursive: true });

  const pluginVersion = readPluginVersion(PLUGIN_DEPLOY_DIR) || '0.0.0';
  const marketplaceManifest = {
    name: MARKETPLACE_NAME,
    metadata: {
      description: 'Bifrost — keyboard-centric orchestration for parallel Claude Code sessions',
      version: pluginVersion,
      pluginRoot: '.',
    },
    owner: {
      name: 'Bifrost',
    },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: `./${PLUGIN_NAME}`,
      },
    ],
  };
  fs.writeFileSync(
    path.join(marketplaceManifestDir, 'marketplace.json'),
    `${JSON.stringify(marketplaceManifest, null, 2)}\n`,
    'utf-8',
  );

  // --- Install MCP server dependencies ---
  await installMcpDeps();

  // --- Register marketplace in known_marketplaces.json ---
  registerMarketplace();

  // --- Register plugin in installed_plugins.json ---
  registerPlugin(pluginVersion);

  // --- Enable plugin in settings.json ---
  enablePlugin();

  // --- Clean up old integration ---
  cleanupOldIntegration();
}

function registerMarketplace(): void {
  let marketplaces: KnownMarketplaces = {};
  const pluginsDir = path.dirname(KNOWN_MARKETPLACES_FILE);
  try {
    if (fs.existsSync(KNOWN_MARKETPLACES_FILE)) {
      marketplaces = JSON.parse(fs.readFileSync(KNOWN_MARKETPLACES_FILE, 'utf-8'));
    }
  } catch {
    marketplaces = {};
  }

  marketplaces[MARKETPLACE_NAME] = {
    source: {
      source: 'directory',
      path: MARKETPLACE_DIR,
    },
    installLocation: MARKETPLACE_DIR,
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };

  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
  atomicWriteFileSync(KNOWN_MARKETPLACES_FILE, `${JSON.stringify(marketplaces, null, 2)}\n`);
}

function registerPlugin(pluginVersion: string): void {
  let pluginsData: PluginsFile = { version: 2, plugins: {} };
  try {
    if (fs.existsSync(PLUGINS_FILE)) {
      pluginsData = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as PluginsFile;
      if (!pluginsData.plugins) pluginsData.plugins = {};
    }
  } catch {
    pluginsData = { version: 2, plugins: {} };
  }

  const now = new Date().toISOString();
  const existing = pluginsData.plugins[PLUGIN_ID] as Array<Record<string, unknown>> | undefined;
  if (existing && existing.length > 0) {
    existing[0].lastUpdated = now;
    existing[0].installPath = PLUGIN_DEPLOY_DIR;
    existing[0].version = pluginVersion;
  } else {
    pluginsData.plugins[PLUGIN_ID] = [
      {
        scope: 'user',
        installPath: PLUGIN_DEPLOY_DIR,
        version: pluginVersion,
        installedAt: now,
        lastUpdated: now,
      },
    ];
  }

  const pluginsDir = path.dirname(PLUGINS_FILE);
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
  atomicWriteFileSync(PLUGINS_FILE, `${JSON.stringify(pluginsData, null, 2)}\n`);
}

function enablePlugin(): void {
  try {
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
    if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') {
      settings.enabledPlugins = {};
    }
    const enabled = settings.enabledPlugins as Record<string, boolean>;
    enabled[PLUGIN_ID] = true;
    // Remove old plugin ID if present
    delete enabled[OLD_PLUGIN_ID];
    atomicWriteFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    // Best-effort — settings may be read-only
  }
}

async function installMcpDeps(): Promise<void> {
  const mcpDest = path.join(PLUGIN_DEPLOY_DIR, 'mcp');
  if (!fs.existsSync(path.join(mcpDest, 'package.json'))) return;
  if (!fs.existsSync(path.join(mcpDest, 'node_modules'))) {
    await execFile('npm', ['install', '--production'], { cwd: mcpDest, timeout: 30000 });
  }
}

function cleanupOldIntegration(): void {
  // Remove bifrost entry from ~/.mcp.json
  try {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      const raw = fs.readFileSync(MCP_CONFIG_PATH, 'utf-8');
      const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (config.mcpServers?.bifrost) {
        delete config.mcpServers.bifrost;
        atomicWriteFileSync(MCP_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
      }
    }
  } catch {
    // Best-effort
  }

  // Remove old slash commands directory
  try {
    if (fs.existsSync(OLD_COMMANDS_DIR)) {
      fs.rmSync(OLD_COMMANDS_DIR, { recursive: true });
    }
  } catch {
    // Best-effort
  }

  // Remove old standalone MCP server directory
  try {
    if (fs.existsSync(OLD_MCP_DIR)) {
      fs.rmSync(OLD_MCP_DIR, { recursive: true });
    }
  } catch {
    // Best-effort
  }

  // Remove old plugin directory (pre-marketplace layout)
  try {
    if (fs.existsSync(OLD_PLUGIN_DIR) && OLD_PLUGIN_DIR !== PLUGIN_DEPLOY_DIR) {
      fs.rmSync(OLD_PLUGIN_DIR, { recursive: true });
    }
  } catch {
    // Best-effort
  }

  // Remove old plugin registration
  try {
    if (fs.existsSync(PLUGINS_FILE)) {
      const pluginsData = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as PluginsFile;
      if (pluginsData.plugins?.[OLD_PLUGIN_ID]) {
        delete pluginsData.plugins[OLD_PLUGIN_ID];
        atomicWriteFileSync(PLUGINS_FILE, `${JSON.stringify(pluginsData, null, 2)}\n`);
      }
    }
  } catch {
    // Best-effort
  }
}

function getPluginSourceDir(): string {
  // In dev: __dirname is .vite/build, so ../../src/claude-plugin exists
  const devRoot = path.resolve(__dirname, '..', '..');
  const devPlugin = path.join(devRoot, 'src', 'claude-plugin');
  if (fs.existsSync(devPlugin)) return devPlugin;

  // In production: asar root contains claude-plugin/ (copied by forge hook)
  const asarPlugin = path.join(devRoot, 'claude-plugin');
  if (fs.existsSync(asarPlugin)) return asarPlugin;

  throw new Error('Plugin source not found');
}

function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
