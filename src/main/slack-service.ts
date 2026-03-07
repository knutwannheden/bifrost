import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { shell, BrowserWindow } from 'electron';
import { loadConfig, saveConfig } from './config';
import { IPC_STREAM } from '../shared/ipc-channels';

// --- State persistence ---

const SLACK_STATE_PATH = path.join(os.homedir(), '.bifrost', 'slack.json');

interface SlackState {
  lastProcessedTimestamp: number;
  processedReactions: string[]; // "channelId:messageTs"
}

function loadSlackState(): SlackState {
  try {
    const data = fs.readFileSync(SLACK_STATE_PATH, 'utf-8');
    return JSON.parse(data) as SlackState;
  } catch {
    return { lastProcessedTimestamp: 0, processedReactions: [] };
  }
}

function saveSlackState(state: SlackState): void {
  // Cap processedReactions at 500 entries (keep most recent)
  if (state.processedReactions.length > 500) {
    state.processedReactions = state.processedReactions.slice(-500);
  }
  const dir = path.dirname(SLACK_STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SLACK_STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Slack API helpers ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slackGet(endpoint: string, token: string, params: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://slack.com/api/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const req = https.request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: string) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let cachedTeamDomain: string | null = null;

async function getTeamDomain(token: string): Promise<string> {
  if (cachedTeamDomain) return cachedTeamDomain;
  const result = await slackGet('auth.test', token);
  if (!result.ok) throw new Error(`auth.test failed: ${result.error}`);
  cachedTeamDomain = result.url.replace(/^https?:\/\//, '').replace(/\/$/, '').split('.')[0];
  return cachedTeamDomain;
}

// --- Reaction polling ---

const OAUTH_PORT = 17843;

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchReactions(mainWindow: BrowserWindow): Promise<void> {
  const config = loadConfig();
  const token = config.slack?.userToken;
  const reactions = config.slack?.reactions;
  if (!token || !reactions?.length) return;

  const state = loadSlackState();
  const processedSet = new Set(state.processedReactions);

  let teamDomain: string;
  try {
    teamDomain = await getTeamDomain(token);
  } catch (err) {
    console.error('[slack] Failed to get team domain:', err);
    return;
  }

  let cursor: string | undefined;
  let newTimestamp = state.lastProcessedTimestamp;

  do {
    const params: Record<string, string> = { limit: '100' };
    if (cursor) params.cursor = cursor;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    try {
      result = await slackGet('reactions.list', token, params);
    } catch (err) {
      console.error('[slack] Failed to fetch reactions:', err);
      return;
    }

    if (!result.ok) {
      console.error('[slack] reactions.list error:', result.error);
      return;
    }

    const items = result.items ?? [];
    for (const item of items) {
      if (item.type !== 'message' || !item.message || !item.channel) continue;

      const messageTs = item.message.ts as string;
      const channelId = item.channel as string;
      const dedup = `${channelId}:${messageTs}`;

      // Parse timestamp for comparison (Slack ts is "seconds.microseconds")
      const tsNum = parseFloat(messageTs);

      if (tsNum <= state.lastProcessedTimestamp) continue;
      if (processedSet.has(dedup)) continue;

      const messageReactions: Array<{ name: string }> = item.message.reactions ?? [];
      const hasMatch = messageReactions.some((r) => reactions.includes(r.name));
      if (!hasMatch) continue;

      // Build Slack message URL
      const tsWithoutDot = messageTs.replace('.', '');
      const messageUrl = `https://${teamDomain}.slack.com/archives/${channelId}/p${tsWithoutDot}`;
      const messagePreview = (item.message.text ?? '').slice(0, 100);

      mainWindow.webContents.send(IPC_STREAM.SLACK_REACTION, channelId, messageTs, messageUrl, messagePreview);

      processedSet.add(dedup);
      state.processedReactions.push(dedup);
      if (tsNum > newTimestamp) newTimestamp = tsNum;
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  state.lastProcessedTimestamp = newTimestamp;
  saveSlackState(state);
}

export function startPolling(mainWindow: BrowserWindow): void {
  const config = loadConfig();
  if (!config.slack?.enabled || !config.slack?.userToken || !config.slack?.reactions?.length) return;

  // Clear any existing timer
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  pollTimer = setInterval(() => {
    fetchReactions(mainWindow).catch((err) => {
      console.error('[slack] Poll error:', err);
    });
  }, 30_000);

  // Run immediately on start
  fetchReactions(mainWindow).catch((err) => {
    console.error('[slack] Initial poll error:', err);
  });
}

export function restartPolling(mainWindow: BrowserWindow): void {
  stopPolling();
  startPolling(mainWindow);
}

function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString();

    const req = https.request('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: string) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json.ok) reject(new Error(`Slack OAuth failed: ${json.error}`));
          else resolve(json.authed_user.access_token);
        } catch (err) {
          reject(new Error(`Failed to parse Slack OAuth response: ${err}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

let oauthServer: https.Server | null = null;

const CERT_DIR = path.join(os.homedir(), '.bifrost', 'certs');
const CA_KEY_PATH = path.join(CERT_DIR, 'ca-key.pem');
const CA_CERT_PATH = path.join(CERT_DIR, 'ca.pem');
const SERVER_KEY_PATH = path.join(CERT_DIR, 'server-key.pem');
const SERVER_CERT_PATH = path.join(CERT_DIR, 'server.pem');

/**
 * Get or create a locally-trusted TLS cert for localhost.
 * On first run: generates a CA, adds it to the macOS login keychain (prompts
 * for password), and signs a localhost cert. Certs persist in ~/.bifrost/certs/.
 */
function getOrCreateCert(): { key: string; cert: string } {
  if (fs.existsSync(SERVER_KEY_PATH) && fs.existsSync(SERVER_CERT_PATH)) {
    // Check if the server cert is still valid (not expired)
    try {
      execSync(`openssl x509 -checkend 86400 -noout -in "${SERVER_CERT_PATH}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return {
        key: fs.readFileSync(SERVER_KEY_PATH, 'utf-8'),
        cert: fs.readFileSync(SERVER_CERT_PATH, 'utf-8'),
      };
    } catch {
      // Cert expired or invalid — regenerate
    }
  }

  if (!fs.existsSync(CERT_DIR)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
  }

  // Generate CA key + cert (valid 10 years)
  if (!fs.existsSync(CA_KEY_PATH) || !fs.existsSync(CA_CERT_PATH)) {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${CA_KEY_PATH}" -out "${CA_CERT_PATH}" -days 3650 -nodes -subj "/CN=Bifrost Local CA"`,
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Trust the CA in the macOS login keychain (shows native password dialog)
    execSync(
      `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${CA_CERT_PATH}"`,
      { stdio: 'inherit' },
    );
  }

  // Generate server key + CSR, sign with CA (valid 1 year)
  execSync(
    `openssl req -newkey rsa:2048 -keyout "${SERVER_KEY_PATH}" -out "${CERT_DIR}/server.csr" -nodes -subj "/CN=localhost"`,
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  // Create extensions file for SAN (required by modern browsers)
  const extPath = path.join(CERT_DIR, 'ext.cnf');
  fs.writeFileSync(extPath, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');

  execSync(
    `openssl x509 -req -in "${CERT_DIR}/server.csr" -CA "${CA_CERT_PATH}" -CAkey "${CA_KEY_PATH}" -CAcreateserial -out "${SERVER_CERT_PATH}" -days 365 -extfile "${extPath}"`,
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  // Clean up temp files
  try { fs.unlinkSync(path.join(CERT_DIR, 'server.csr')); } catch { /* ignore */ }
  try { fs.unlinkSync(extPath); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(CERT_DIR, 'ca.srl')); } catch { /* ignore */ }

  return {
    key: fs.readFileSync(SERVER_KEY_PATH, 'utf-8'),
    cert: fs.readFileSync(SERVER_CERT_PATH, 'utf-8'),
  };
}

export function startOAuth(mainWindow: BrowserWindow): Promise<void> {
  const config = loadConfig();
  const clientId = config.slack?.clientId;
  const clientSecret = config.slack?.clientSecret;
  if (!clientId || !clientSecret) {
    return Promise.reject(new Error('Slack client ID and secret must be configured first'));
  }

  // Close any leftover server from a previous timed-out attempt
  if (oauthServer) {
    oauthServer.close();
    oauthServer = null;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const oauthState = crypto.randomBytes(16).toString('hex');
    const { key, cert } = getOrCreateCert();

    const redirectUri = `https://localhost:${OAUTH_PORT}/callback`;
    const userScope = 'channels:history,groups:history,reactions:read,users:read,emoji:read,files:read,links:read';

    const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('user_scope', userScope);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', oauthState);

    // HTTPS server with a locally-trusted cert (CA in login keychain).
    const server = https.createServer({ key, cert }, async (req, res) => {
      try {
        const url = new URL(req.url ?? '', `https://localhost`);

        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const returnedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authorization denied</h1><p>You can close this window.</p></body></html>');
          cleanup();
          reject(new Error(`Slack OAuth denied: ${error}`));
          return;
        }

        if (returnedState !== oauthState) {
          res.writeHead(400);
          res.end('State mismatch');
          cleanup();
          reject(new Error('OAuth state mismatch'));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end('Missing code');
          cleanup();
          reject(new Error('OAuth callback missing code'));
          return;
        }

        const token = await exchangeCodeForToken(clientId, clientSecret, code, redirectUri);

        const freshConfig = loadConfig();
        freshConfig.slack = {
          ...freshConfig.slack!,
          userToken: token,
        };
        saveConfig(freshConfig);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Connected to Slack!</h1><p>You can close this window.</p></body></html>');

        restartPolling(mainWindow);
        cleanup();
        resolve();
      } catch (err) {
        console.error('[slack] OAuth callback error:', err);
        res.writeHead(500);
        res.end('Internal error');
        cleanup();
        reject(err);
      }
    });

    oauthServer = server;

    const timeout = setTimeout(() => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error('OAuth timed out after 120 seconds'));
      }
    }, 120_000);

    function cleanup(): void {
      clearTimeout(timeout);
      server.close();
      oauthServer = null;
    }

    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(`OAuth server failed: ${err.message}`));
      }
    });

    server.listen(OAUTH_PORT, () => {
      shell.openExternal(authorizeUrl.toString());
    });
  });
}

export function disconnectSlack(): void {
  const config = loadConfig();
  if (config.slack) {
    config.slack.userToken = '';
    saveConfig(config);
  }
  stopPolling();
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  cachedTeamDomain = null;
}
