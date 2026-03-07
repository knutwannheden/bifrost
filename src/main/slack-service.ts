import https from 'node:https';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { shell, BrowserWindow } from 'electron';
import { loadConfig, saveConfig } from './config';

function generateSelfSignedCert(): { key: string; cert: string } {
  const result = execSync(
    'openssl req -x509 -newkey rsa:2048 -keyout /dev/stdout -out /dev/stdout -days 1 -nodes -subj "/CN=localhost"',
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const keyMatch = result.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/);
  const certMatch = result.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!keyMatch || !certMatch) throw new Error('Failed to generate self-signed certificate');
  return { key: keyMatch[0], cert: certMatch[0] };
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

  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const { key, cert } = generateSelfSignedCert();

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

        if (returnedState !== state) {
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

        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const redirectUri = `https://localhost:${port}/callback`;

        const token = await exchangeCodeForToken(clientId, clientSecret, code, redirectUri);

        // Store token in config
        const freshConfig = loadConfig();
        freshConfig.slack = {
          ...freshConfig.slack!,
          userToken: token,
        };
        saveConfig(freshConfig);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Connected to Slack!</h1><p>You can close this window.</p></body></html>');

        // Notify renderer
        mainWindow.webContents.send('slack:oauth-complete');

        cleanup();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end('Internal error');
        cleanup();
        reject(err);
      }
    });

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('OAuth timed out after 60 seconds'));
    }, 60_000);

    function cleanup(): void {
      clearTimeout(timeout);
      server.close();
    }

    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const redirectUri = `https://localhost:${port}/callback`;
      const userScope = 'channels:history,groups:history,reactions:read,users:read,emoji:read,files:read,links:read';

      const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize');
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('user_scope', userScope);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('state', state);

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

/** Stub — filled in by Task 4 (slack polling) */
export function stopPolling(): void {
  // no-op for now
}
