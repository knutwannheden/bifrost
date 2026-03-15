import crypto from 'node:crypto';
import https from 'node:https';
import { BrowserWindow } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels';
import { loadConfig, saveConfig } from './config';
import { getDb } from './db';

// --- State persistence ---

interface SlackState {
  seenReactions: string[]; // "channelId:messageTs:emoji"
}

function loadSlackState(): SlackState {
  const rows = getDb().prepare('SELECT reaction_key FROM slack_seen_reactions').all() as { reaction_key: string }[];
  return { seenReactions: rows.map((r) => r.reaction_key) };
}

function saveSlackState(state: SlackState): void {
  // Cap at 500 entries (keep most recent)
  if (state.seenReactions.length > 500) {
    state.seenReactions = state.seenReactions.slice(-500);
  }
  const d = getDb();
  const save = d.transaction(() => {
    const now = Date.now();
    d.prepare('DELETE FROM slack_seen_reactions').run();
    const stmt = d.prepare('INSERT INTO slack_seen_reactions (reaction_key, seen_at) VALUES (?, ?)');
    for (const key of state.seenReactions) {
      stmt.run(key, now);
    }
  });
  save();
}

// --- Slack API helpers ---

interface SlackResponse {
  ok: boolean;
  error?: string;
  retryAfter?: number;
  // biome-ignore lint/suspicious/noExplicitAny: Slack API responses have dynamic fields
  [key: string]: any;
}

function slackGet(endpoint: string, token: string, params: Record<string, string> = {}): Promise<SlackResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://slack.com/api/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const req = https.request(
      url,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(body) as SlackResponse;
            if (res.headers['retry-after']) {
              json.retryAfter = parseInt(res.headers['retry-after'] as string, 10);
            }
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let cachedTeamDomain: string | null = null;

async function getTeamDomain(token: string): Promise<string> {
  if (cachedTeamDomain) return cachedTeamDomain;
  const result = await slackGet('auth.test', token);
  if (!result.ok) throw new Error(`auth.test failed: ${result.error}`);
  cachedTeamDomain = result.url
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .split('.')[0];
  return cachedTeamDomain;
}

// --- Reaction polling ---

const OAUTH_PORT = 17843;

const POLL_INTERVAL = 10_000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let nextPollDelay = POLL_INTERVAL;
let polling = false;

async function fetchReactions(mainWindow: BrowserWindow): Promise<void> {
  const config = loadConfig();
  const token = config.slack?.userToken;
  const reactions = config.slack?.reactions;
  if (!token || !reactions?.length) return;

  if (polling) return;
  polling = true;

  try {
    const state = loadSlackState();
    const seenSet = new Set(state.seenReactions);
    const isFirstRun = seenSet.size === 0;

    // Search for messages the user reacted to with each configured emoji
    for (const emoji of reactions) {
      let result: SlackResponse;
      try {
        result = await slackGet('search.messages', token, {
          query: `hasmy::${emoji}:`,
          sort: 'timestamp',
          sort_dir: 'desc',
          count: '20',
        });
      } catch (err) {
        console.error('[slack] Failed to search reactions:', err);
        return;
      }

      if (!result.ok) {
        if (result.error === 'ratelimited') {
          const backoff = result.retryAfter ?? 60;
          console.warn(`[slack] Rate limited, backing off ${backoff}s`);
          nextPollDelay = backoff * 1000;
          return;
        }
        console.error('[slack] search.messages error:', result.error);
        return;
      }

      const matches = result.messages?.matches ?? [];

      for (const match of matches) {
        const messageTs = match.ts as string;
        const channelId = (match.channel?.id ?? '') as string;
        if (!channelId) continue;

        const key = `${channelId}:${messageTs}:${emoji}`;

        if (seenSet.has(key)) continue;
        seenSet.add(key);
        state.seenReactions.push(key);

        // First run: snapshot existing reactions without notifying
        if (isFirstRun) continue;

        let teamDomain: string;
        try {
          teamDomain = await getTeamDomain(token);
        } catch (err) {
          console.error('[slack] Failed to get team domain:', err);
          return;
        }

        const tsWithoutDot = messageTs.replace('.', '');
        const messageUrl = `https://${teamDomain}.slack.com/archives/${channelId}/p${tsWithoutDot}`;
        const messagePreview = ((match.text ?? '') as string).slice(0, 200);

        mainWindow.webContents.send(IPC_STREAM.SLACK_REACTION, channelId, messageTs, messageUrl, messagePreview);
      }
    }

    saveSlackState(state);
  } finally {
    polling = false;
  }
}

export function startPolling(mainWindow: BrowserWindow): void {
  const config = loadConfig();
  if (!config.slack?.enabled || !config.slack?.userToken || !config.slack?.reactions?.length) return;

  // Clear any existing timer
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(): void {
    pollTimer = setTimeout(async () => {
      nextPollDelay = POLL_INTERVAL; // reset; fetchReactions may override on rate limit
      try {
        await fetchReactions(mainWindow);
      } catch (err) {
        console.error('[slack] Poll error:', err);
      }
      schedulePoll();
    }, nextPollDelay);
  }

  // Run immediately on start, then schedule
  nextPollDelay = POLL_INTERVAL;
  fetchReactions(mainWindow)
    .catch((err) => console.error('[slack] Initial poll error:', err))
    .then(() => schedulePoll());
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

    const req = https.request(
      'https://slack.com/api/oauth.v2.access',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (!json.ok) reject(new Error(`Slack OAuth failed: ${json.error}`));
            else resolve(json.authed_user.access_token);
          } catch (err) {
            reject(new Error(`Failed to parse Slack OAuth response: ${err}`));
          }
        });
      },
    );
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

  const redirectUri = `https://localhost:${OAUTH_PORT}/callback`;
  const oauthState = crypto.randomBytes(16).toString('hex');
  const userScope =
    'channels:history,groups:history,reactions:read,users:read,emoji:read,files:read,links:read,search:read';

  const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('user_scope', userScope);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', oauthState);

  return new Promise((resolve, reject) => {
    let settled = false;

    const authWindow = new BrowserWindow({
      width: 600,
      height: 700,
      parent: mainWindow,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    function finish(err?: Error): void {
      if (settled) return;
      settled = true;
      if (!authWindow.isDestroyed()) authWindow.close();
      if (err) reject(err);
      else resolve();
    }

    async function handleRedirect(url: string): Promise<void> {
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
        freshConfig.slack = { ...freshConfig.slack!, userToken: token };
        saveConfig(freshConfig);
        restartPolling(mainWindow);
        finish();
      } catch (err) {
        console.error('[slack] OAuth token exchange error:', err);
        finish(err as Error);
      }
    }

    // Intercept the redirect to localhost before the browser tries to load it
    authWindow.webContents.on('will-redirect', (_event, url) => {
      handleRedirect(url);
    });
    authWindow.webContents.on('will-navigate', (_event, url) => {
      handleRedirect(url);
    });

    // Allow Esc to close the OAuth window
    authWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'Escape') authWindow.close();
    });

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
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  cachedTeamDomain = null;
}
