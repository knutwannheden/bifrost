import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { BrowserWindow } from 'electron';
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

export function startOAuth(mainWindow: BrowserWindow): Promise<void> {
  const config = loadConfig();
  const clientId = config.slack?.clientId;
  const clientSecret = config.slack?.clientSecret;
  if (!clientId || !clientSecret) {
    return Promise.reject(new Error('Slack client ID and secret must be configured first'));
  }

  // Use a redirect URI that Slack has configured but we never actually serve.
  // The BrowserWindow intercepts the navigation before it loads.
  const redirectUri = `https://localhost:${OAUTH_PORT}/callback`;
  const oauthState = crypto.randomBytes(16).toString('hex');
  const userScope = 'channels:history,groups:history,reactions:read,users:read,emoji:read,files:read,links:read';

  const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('user_scope', userScope);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', oauthState);

  return new Promise((resolve, reject) => {
    let settled = false;

    // Open Slack OAuth in an Electron BrowserWindow — no local server needed.
    // We intercept the redirect to localhost before the browser tries to load it.
    const authWindow = new BrowserWindow({
      width: 600,
      height: 700,
      parent: mainWindow,
      modal: true,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    function finish(err?: Error): void {
      if (settled) return;
      settled = true;
      authWindow.close();
      if (err) reject(err);
      else resolve();
    }

    // Intercept navigation to the redirect URI
    authWindow.webContents.on('will-redirect', async (_event, url) => {
      if (!url.startsWith(redirectUri)) return;

      const parsed = new URL(url);
      const error = parsed.searchParams.get('error');
      const returnedState = parsed.searchParams.get('state');
      const code = parsed.searchParams.get('code');

      if (error) {
        finish(new Error(`Slack OAuth denied: ${error}`));
        return;
      }
      if (returnedState !== oauthState) {
        finish(new Error('OAuth state mismatch'));
        return;
      }
      if (!code) {
        finish(new Error('OAuth callback missing code'));
        return;
      }

      try {
        const token = await exchangeCodeForToken(clientId, clientSecret, code, redirectUri);

        const freshConfig = loadConfig();
        freshConfig.slack = {
          ...freshConfig.slack!,
          userToken: token,
        };
        saveConfig(freshConfig);

        restartPolling(mainWindow);
        finish();
      } catch (err) {
        console.error('[slack] OAuth token exchange error:', err);
        finish(err as Error);
      }
    });

    // Also check will-navigate for the same redirect (some flows use navigate instead of redirect)
    authWindow.webContents.on('will-navigate', async (_event, url) => {
      if (!url.startsWith(redirectUri)) return;

      const parsed = new URL(url);
      const code = parsed.searchParams.get('code');
      const returnedState = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');

      if (error) {
        finish(new Error(`Slack OAuth denied: ${error}`));
        return;
      }
      if (returnedState !== oauthState) {
        finish(new Error('OAuth state mismatch'));
        return;
      }
      if (!code) {
        finish(new Error('OAuth callback missing code'));
        return;
      }

      try {
        const token = await exchangeCodeForToken(clientId, clientSecret, code, redirectUri);

        const freshConfig = loadConfig();
        freshConfig.slack = {
          ...freshConfig.slack!,
          userToken: token,
        };
        saveConfig(freshConfig);

        restartPolling(mainWindow);
        finish();
      } catch (err) {
        console.error('[slack] OAuth token exchange error:', err);
        finish(err as Error);
      }
    });

    // User closed the window without completing OAuth
    authWindow.on('closed', () => {
      if (!settled) {
        settled = true;
        reject(new Error('OAuth window closed'));
      }
    });

    authWindow.loadURL(authorizeUrl.toString());
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
