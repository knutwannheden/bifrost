import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';

interface McpConfig {
  mcpServers: Record<string, unknown>;
}

export interface IntegrationStatus {
  mcpInstalled: boolean;
  commandsInstalled: boolean;
}

const COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands', 'bifrost');
const MCP_CONFIG_PATH = path.join(os.homedir(), '.mcp.json');

export function checkIntegration(): IntegrationStatus {
  // Check MCP config
  let mcpInstalled = false;
  try {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')) as McpConfig;
      mcpInstalled = !!raw.mcpServers?.bifrost;
    }
  } catch {
    // Malformed JSON or read error
  }

  // Check slash commands
  const commandsInstalled = fs.existsSync(path.join(COMMANDS_DIR, 'review-fix.md'));

  return { mcpInstalled, commandsInstalled };
}

export function installIntegration(): void {
  // --- MCP config ---
  let config: McpConfig = { mcpServers: {} };
  try {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')) as McpConfig;
      if (!config.mcpServers) config.mcpServers = {};
    }
  } catch {
    config = { mcpServers: {} };
  }

  config.mcpServers.bifrost = {
    command: 'node',
    args: [path.join(os.homedir(), '.bifrost', 'mcp', 'server.mjs')],
  };
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // --- Slash commands ---
  if (!fs.existsSync(COMMANDS_DIR)) {
    fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  }

  const srcDir = path.join(
    app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..'),
    'src',
    'slash-commands',
  );

  if (fs.existsSync(srcDir)) {
    for (const file of fs.readdirSync(srcDir)) {
      if (file.endsWith('.md')) {
        fs.copyFileSync(path.join(srcDir, file), path.join(COMMANDS_DIR, file));
      }
    }
  }
}
