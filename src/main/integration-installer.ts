import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

interface GlobalMcpConfig {
  mcpServers: Record<string, unknown>;
}

interface PluginsFile {
  version: number;
  plugins: Record<string, unknown[]>;
}

export interface IntegrationStatus {
  installed: boolean;
}

const PLUGIN_ID = 'bifrost@local';
const PLUGIN_DEPLOY_DIR = path.join(os.homedir(), '.bifrost', 'plugin');
const PLUGINS_FILE = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const MCP_CONFIG_PATH = path.join(os.homedir(), '.mcp.json');
const OLD_COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands', 'bifrost');
const OLD_MCP_DIR = path.join(os.homedir(), '.bifrost', 'mcp');

export function checkIntegration(): IntegrationStatus {
  try {
    if (fs.existsSync(PLUGINS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8')) as PluginsFile;
      return { installed: !!raw.plugins?.[PLUGIN_ID] };
    }
  } catch {
    // Malformed JSON or read error
  }
  return { installed: false };
}

export function installIntegration(): void {
  const root = getSourceRoot();

  // --- Deploy plugin files ---
  const pluginSrc = path.join(root, 'src', 'claude-plugin');
  if (!fs.existsSync(pluginSrc)) {
    throw new Error(`Plugin source not found: ${pluginSrc}`);
  }
  copyDirSync(pluginSrc, PLUGIN_DEPLOY_DIR);

  // --- Deploy MCP server into plugin ---
  deployMcpServer(root);

  // --- Generate .mcp.json using ${CLAUDE_PLUGIN_ROOT} ---
  const pluginMcp = {
    mcpServers: {
      bifrost: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'],
      },
    },
  };
  fs.writeFileSync(
    path.join(PLUGIN_DEPLOY_DIR, '.mcp.json'),
    JSON.stringify(pluginMcp, null, 2) + '\n',
    'utf-8',
  );

  // --- Register in installed_plugins.json ---
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
  } else {
    pluginsData.plugins[PLUGIN_ID] = [
      {
        scope: 'user',
        installPath: PLUGIN_DEPLOY_DIR,
        version: 'local',
        installedAt: now,
        lastUpdated: now,
      },
    ];
  }

  const pluginsDir = path.dirname(PLUGINS_FILE);
  if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(PLUGINS_FILE, JSON.stringify(pluginsData, null, 2) + '\n', 'utf-8');

  // --- Clean up old integration ---
  cleanupOldIntegration();
}

/**
 * Refresh the MCP server files inside the plugin directory.
 * Called on every app startup so code updates propagate without reinstall.
 */
export function refreshMcpServer(): void {
  try {
    if (!fs.existsSync(path.join(PLUGIN_DEPLOY_DIR, '.claude-plugin'))) return;
    deployMcpServer(getSourceRoot());
  } catch {
    // Best-effort — plugin may not be installed yet
  }
}

function deployMcpServer(root: string): void {
  const mcpSrc = path.join(root, 'src', 'mcp-server');
  const mcpDest = path.join(PLUGIN_DEPLOY_DIR, 'mcp');

  if (!fs.existsSync(mcpSrc)) return;
  if (!fs.existsSync(mcpDest)) fs.mkdirSync(mcpDest, { recursive: true });

  for (const file of ['server.mjs', 'package.json']) {
    fs.copyFileSync(path.join(mcpSrc, file), path.join(mcpDest, file));
  }

  if (!fs.existsSync(path.join(mcpDest, 'node_modules'))) {
    execSync('npm install --production', { cwd: mcpDest, stdio: 'ignore', timeout: 30000 });
  }
}

function cleanupOldIntegration(): void {
  // Remove bifrost entry from ~/.mcp.json
  try {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')) as GlobalMcpConfig;
      if (config.mcpServers?.bifrost) {
        delete config.mcpServers.bifrost;
        fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
}

function getSourceRoot(): string {
  const devRoot = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(devRoot, 'src'))) return devRoot;
  return process.resourcesPath;
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
