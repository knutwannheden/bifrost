/**
 * The Claude accounts Bifrost offers are the config dirs in home that hold a
 * login, and switching between them moves what Bifrost reads with no restart.
 * Runs against a temporary home. Run with `npm run check:claude-account`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-account-')));
const home = path.join(root, 'home');
const repo = path.join(root, 'repo');
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const login = (email: string) => ({ oauthAccount: { emailAddress: email } });

write(path.join(home, '.claude.json'), login('me@home.test'));
fs.mkdirSync(path.join(home, '.claude'));
const work = path.join(home, '.claude-work');
write(path.join(work, '.claude.json'), login('me@work.test'));
write(path.join(work, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'bifrost@bifrost': [{}] } });
write(path.join(work, 'settings.json'), { enabledPlugins: { 'bifrost@bifrost': true } });
write(path.join(work, 'history.jsonl'), `${JSON.stringify({ project: repo, timestamp: 1 })}\n`);
fs.mkdirSync(path.join(home, '.claude-cache'));
write(path.join(home, '.claude-notes'), 'not a dir');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const { applyClaudeConfigDir, listClaudeAccounts } = await import('../src/main/claude-paths.ts');
const { checkIntegration } = await import('../src/main/integration-installer.ts');
const { scanRecentRepos } = await import('../src/main/history-scanner.ts');

try {
  {
    const listed = listClaudeAccounts();
    check(
      'the accounts are ~/.claude and each ~/.claude-* dir that holds a login, with its email',
      show(listed) ===
        show([
          { dir: null, email: 'me@home.test', current: true },
          { dir: '.claude-work', email: 'me@work.test', current: false },
        ]),
      show(listed),
    );
  }

  {
    applyClaudeConfigDir('.claude-work');
    const plugin = checkIntegration().installed;
    const recent = (await scanRecentRepos(new Set())).map((r) => r.path);
    const current = listClaudeAccounts().find((a) => a.current)?.dir;
    check(
      'after a switch, the plugin, the history and the current account come from the new dir',
      plugin && recent.includes(repo) && current === '.claude-work',
      show({ plugin, recent, current }),
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
