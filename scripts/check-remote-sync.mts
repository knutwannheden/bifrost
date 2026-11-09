/**
 * Syncing brings a machine's Claude setup in line with this machine's. It runs
 * here between two home directories, with a stand-in for the machine that
 * unpacks uploads and runs scripts locally. Run with `npm run check:remote-sync`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rsyncArgs, type SyncOptions, syncMachine } from '../src/main/remote-sync.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-sync-')));
const here = path.join(root, 'here');
const there = path.join(root, 'there');
const write = (file: string, text: string, mode?: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode === undefined ? undefined : { mode });
};
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '');
const json = (file: string) => JSON.parse(read(file) || '{}');

write(`${here}/.claude/CLAUDE.md`, 'global rules\n');
// Something on the machine may own its CLAUDE.md, as a provisioning script that rewrites a block of it would.
write(`${there}/.claude/CLAUDE.md`, '<!-- machine block -->\n');
write(`${here}/.claude/skills/plain/SKILL.md`, 'a skill\n');
write(`${root}/elsewhere/linked-skill/SKILL.md`, 'a skill kept outside\n');
fs.symlinkSync(`${root}/elsewhere/linked-skill`, `${here}/.claude/skills/linked`);
write(`${here}/.claude/statusline.sh`, '#!/bin/sh\necho status\n', 0o755);
write(`${here}/git/acme/CLAUDE.md`, 'org rules\n');
fs.mkdirSync(`${here}/git/acme/widget`, { recursive: true });
write(`${here}/.local/bin/gw`, '#!/bin/sh\necho gw\n', 0o755);
const headroom = `${root}/bifrost/tools/headroom`;
write(`${headroom}/package.json`, '{"name":"headroom"}');
write(`${headroom}/src/cli.ts`, '#!/usr/bin/env node\n', 0o755);
write(`${headroom}/node_modules/dep/index.js`, 'not for the machine\n');

const cache = `${here}/.claude/plugins/cache`;
write(`${cache}/hub/tool/1.0.0/.claude-plugin/plugin.json`, '{"name":"tool"}');
write(`${cache}/hub/tool/1.0.0/.in_use/4242`, '');
write(`${cache}/local/lab/0.1.0/.claude-plugin/plugin.json`, '{"name":"lab"}');
write(`${here}/.bifrost/marketplace/bifrost/.claude-plugin/plugin.json`, '{"name":"bifrost"}');
write(`${here}/.claude/plugins/marketplaces/hub/.claude-plugin/marketplace.json`, '{"name":"hub"}');
write(`${here}/.claude/plugins/marketplaces/hub/plugins/tool/README.md`, 'tool\n');
const localMarket = `${here}/git/acme/market`;
write(
  `${localMarket}/.claude-plugin/marketplace.json`,
  JSON.stringify({ name: 'local', plugins: [{ name: 'lab', source: './plugins/lab' }] }),
);
write(`${localMarket}/plugins/lab/SKILL.md`, 'lab\n');
write(`${localMarket}/src/big-file.txt`, 'not part of any plugin\n');

write(
  `${here}/.claude/settings.json`,
  JSON.stringify({
    statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
    env: { TOOL_HOME: `${here}/tools` },
    enabledPlugins: { 'tool@hub': true, 'lab@local': true, 'bifrost@bifrost': true },
  }),
);
write(
  `${here}/.claude/plugins/installed_plugins.json`,
  JSON.stringify({
    version: 2,
    plugins: {
      'tool@hub': [{ installPath: `${cache}/hub/tool/1.0.0` }],
      'lab@local': [{ installPath: `${cache}/local/lab/0.1.0` }],
      'bifrost@bifrost': [{ installPath: `${here}/.bifrost/marketplace/bifrost` }],
    },
  }),
);
write(
  `${here}/.claude/plugins/known_marketplaces.json`,
  JSON.stringify({
    hub: {
      source: { source: 'github', repo: 'acme/hub' },
      installLocation: `${here}/.claude/plugins/marketplaces/hub`,
    },
    local: { source: { source: 'directory', path: localMarket }, installLocation: localMarket },
    bifrost: {
      source: { source: 'directory', path: `${here}/.bifrost/marketplace` },
      installLocation: `${here}/.bifrost/marketplace`,
    },
  }),
);

/** The machine, played by a second home directory here. */
const machine = {
  async upload(localDir: string, remoteDir: string) {
    const dest = path.join(there, remoteDir);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(localDir, dest, { recursive: true });
  },
  async exec(script: string) {
    // The machine has its own Claude config, not the one whoever runs this check uses.
    const env = { ...process.env, HOME: there, CLAUDE_CONFIG_DIR: undefined };
    return execFileSync('sh', ['-s'], { cwd: there, input: script, env }).toString();
  },
  async rsync(localDir: string, remoteDir: string) {
    execFileSync('rsync', rsyncArgs(localDir, path.join(there, remoteDir)));
  },
};
const withoutRsync = { upload: machine.upload, exec: machine.exec };
const options = (syncPaths: string[]): SyncOptions => ({
  localHome: here,
  remoteHome: there,
  repoPaths: [`${here}/git/acme/widget`],
  syncPaths,
  headroomDir: headroom,
});

const first = await syncMachine(machine, options(['~/.local/bin/gw']));
{
  const settings = json(`${there}/.claude/settings.json`);
  const installed = json(`${there}/.claude/plugins/installed_plugins.json`);
  const known = json(`${there}/.claude/plugins/known_marketplaces.json`);
  check(
    'a first sync brings the setup over, imports the rules beside what the machine keeps, rewrites home paths, and leaves out Bifrost’s own plugin',
    read(`${there}/.bifrost/claude/CLAUDE.md`) === 'global rules\n' &&
      read(`${there}/.claude/CLAUDE.md`) === '<!-- machine block -->\n\n@~/.bifrost/claude/CLAUDE.md\n' &&
      read(`${there}/.claude/skills/linked/SKILL.md`) === 'a skill kept outside\n' &&
      !fs.lstatSync(`${there}/.claude/skills/linked`).isSymbolicLink() &&
      read(`${there}/git/acme/CLAUDE.md`) === 'org rules\n' &&
      (fs.statSync(`${there}/.local/bin/gw`).mode & 0o111) !== 0 &&
      (fs.statSync(`${there}/.claude/statusline.sh`).mode & 0o111) !== 0 &&
      settings.env.TOOL_HOME === `${there}/tools` &&
      !('bifrost@bifrost' in settings.enabledPlugins) &&
      installed.plugins['tool@hub'][0].installPath === `${there}/.claude/plugins/cache/hub/tool/1.0.0` &&
      !('bifrost@bifrost' in installed.plugins) &&
      !('bifrost' in known) &&
      fs.existsSync(`${there}/.claude/plugins/cache/hub/tool/1.0.0/.claude-plugin/plugin.json`) &&
      !fs.existsSync(`${there}/.claude/plugins/cache/hub/tool/1.0.0/.in_use`) &&
      read(`${there}/.claude/plugins/marketplaces/hub/plugins/tool/README.md`) === 'tool\n',
    show({ first, settings, installed, known }),
  );
  const localThere = known.local?.installLocation;
  check(
    'a directory marketplace travels as its manifest and the enabled plugins’ directories, under Claude’s own',
    localThere === `${there}/.claude/plugins/marketplaces/local` &&
      known.local.source.path === localThere &&
      read(`${localThere}/plugins/lab/SKILL.md`) === 'lab\n' &&
      fs.existsSync(`${localThere}/.claude-plugin/marketplace.json`) &&
      !fs.existsSync(`${localThere}/src`) &&
      !fs.existsSync(`${there}/git/acme/market`),
    show(known),
  );
}

check(
  'headroom comes from Bifrost’s own tools, without its node_modules, and is put where sessions find it',
  fs.readlinkSync(`${there}/.local/bin/headroom`) === `${there}/.bifrost/tools/headroom/src/cli.ts` &&
    fs.existsSync(`${there}/.bifrost/tools/headroom/package.json`) &&
    !fs.existsSync(`${there}/.bifrost/tools/headroom/node_modules`),
);

write(`${here}/.claude/CLAUDE.md`, 'global rules, revised\n');
write(`${cache}/hub/tool/1.0.0/.in_use/5151`, '');
const second = await syncMachine(machine, options([]));
check(
  'a second sync sends only what changed here, not the marks of plugins in use here, and removes what it synced before that is gone',
  show(second.sent) === show(['.bifrost/claude/CLAUDE.md']) &&
    show(second.removed) === show(['.local/bin/gw']) &&
    read(`${there}/.bifrost/claude/CLAUDE.md`) === 'global rules, revised\n' &&
    read(`${there}/.claude/CLAUDE.md`) === '<!-- machine block -->\n\n@~/.bifrost/claude/CLAUDE.md\n' &&
    !fs.existsSync(`${there}/.local/bin/gw`) &&
    // The copy there keeps what this sync did not send.
    read(`${there}/.bifrost/sync-copy/.claude/skills/plain/SKILL.md`) === 'a skill\n',
  show(second),
);

write(`${here}/.claude/skills/plain/notes.md`, 'notes\n');
await syncMachine(machine, options([]));
fs.rmSync(`${here}/.claude/skills/plain/notes.md`);
await syncMachine(machine, options([]));
check(
  'a file removed from a synced directory here is removed there too',
  !fs.existsSync(`${there}/.claude/skills/plain/notes.md`) &&
    read(`${there}/.claude/skills/plain/SKILL.md`) === 'a skill\n',
);

{
  // A sync before skills travelled one by one left them there as one part.
  const manifest = json(`${there}/.bifrost/sync-manifest.json`);
  for (const key of Object.keys(manifest)) if (key.startsWith('.claude/skills/')) delete manifest[key];
  manifest['.claude/skills'] = 'whole';
  write(`${there}/.bifrost/sync-manifest.json`, JSON.stringify(manifest));
  const split = await syncMachine(machine, options([]));
  check(
    'a sync that splits a directory into its entries removes the old whole before sending them',
    show(split.removed) === show(['.claude/skills']) &&
      read(`${there}/.claude/skills/plain/SKILL.md`) === 'a skill\n' &&
      read(`${there}/.claude/skills/linked/SKILL.md`) === 'a skill kept outside\n',
    show(split),
  );
}

{
  write(`${here}/.claude/skills/plain/SKILL.md`, 'a skill, revised here\n');
  write(`${there}/.claude/skills/plain/SKILL.md`, 'a skill, edited there\n');
  write(`${here}/.claude/skills/linked/SKILL.md`, 'a skill kept outside, revised\n');
  const manifest = json(`${there}/.bifrost/sync-manifest.json`);
  manifest['.claude/skills'] = 'whole';
  write(`${there}/.bifrost/sync-manifest.json`, JSON.stringify(manifest));
  const kept = await syncMachine(machine, { ...options([]), cloned: ['.claude/skills/plain'] });
  check(
    'an entry a dotfiles clone there keeps is neither sent nor removed, while the others travel',
    read(`${there}/.claude/skills/plain/SKILL.md`) === 'a skill, edited there\n' &&
      read(`${there}/.claude/skills/linked/SKILL.md`) === 'a skill kept outside, revised\n' &&
      !kept.sent.includes('.claude/skills/plain') &&
      !kept.removed.includes('.claude/skills'),
    show(kept),
  );
  write(`${here}/.claude/skills/plain/SKILL.md`, 'a skill\n');
}

{
  // A second config dir, as a second Claude account keeps, linking everything but its login into ~/.claude.
  const work = `${here}/.claude-work`;
  fs.mkdirSync(`${here}/.claude/projects`, { recursive: true });
  write(`${here}/.claude/history.jsonl`, '');
  fs.mkdirSync(work);
  fs.symlinkSync(`${here}/.claude/skills`, `${work}/skills`);
  fs.symlinkSync('../.claude/settings.json', `${work}/settings.json`);
  fs.symlinkSync(`${here}/.claude/projects`, `${work}/projects`);
  fs.symlinkSync(`${here}/.claude/history.jsonl`, `${work}/history.jsonl`);
  write(`${work}/.claude.json`, '{"oauthAccount":{}}');
  write(`${work}/.credentials.json`, '{}');
  write(`${there}/.claude-work/history.jsonl`, 'mine');
  await syncMachine(machine, { ...options([]), configDir: work });
  const link = (p: string) =>
    fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ? fs.readlinkSync(p) : null;
  const links = {
    skills: link(`${there}/.claude-work/skills`),
    settings: link(`${there}/.claude-work/settings.json`),
    projects: link(`${there}/.claude-work/projects`),
  };
  check(
    'another config dir arrives as links into ~/.claude there, its own files stay here, and nothing of ~/.claude moves',
    links.skills === '../.claude/skills' &&
      fs.existsSync(`${there}/.claude/skills/plain/SKILL.md`) &&
      links.settings === '../.claude/settings.json' &&
      fs.existsSync(`${there}/.claude/settings.json`) &&
      links.projects === '../.claude/projects' &&
      fs.statSync(`${there}/.claude/projects`).isDirectory() &&
      !fs.existsSync(`${there}/.claude-work/.claude.json`) &&
      !fs.existsSync(`${there}/.claude-work/.credentials.json`) &&
      link(`${there}/.claude-work/history.jsonl`) === null &&
      read(`${there}/.claude-work/history.jsonl`) === 'mine' &&
      // That dir has no plugins entry here, and the machine's own registry stays where it is.
      fs.existsSync(`${there}/.claude/plugins/installed_plugins.json`) &&
      !fs.existsSync(`${there}/.claude-work/plugins`),
    show({ links, history: read(`${there}/.claude-work/history.jsonl`) }),
  );
}

{
  // A plugin installed while Claude ran from the second config dir records its path through that dir's link.
  const work = `${here}/.claude-work`;
  fs.symlinkSync(`${here}/.claude/plugins`, `${work}/plugins`);
  write(`${cache}/hub/fresh/2.0.0/.claude-plugin/plugin.json`, '{"name":"fresh"}');
  const installed = json(`${here}/.claude/plugins/installed_plugins.json`);
  installed.plugins['fresh@hub'] = [{ installPath: `${work}/plugins/cache/hub/fresh/2.0.0` }];
  write(`${here}/.claude/plugins/installed_plugins.json`, JSON.stringify(installed));
  const settings = json(`${here}/.claude/settings.json`);
  settings.enabledPlugins['fresh@hub'] = true;
  write(`${here}/.claude/settings.json`, JSON.stringify(settings));
  // There, a sync before this one left a copy under the path that is now a link into ~/.claude.
  fs.mkdirSync(`${there}/.claude-work`, { recursive: true });
  fs.rmSync(`${there}/.claude-work/plugins`, { recursive: true, force: true });
  fs.symlinkSync('../.claude/plugins', `${there}/.claude-work/plugins`);
  const manifest = json(`${there}/.bifrost/sync-manifest.json`);
  manifest['.claude-work/plugins/cache/hub/tool/1.0.0'] = 'stale';
  write(`${there}/.bifrost/sync-manifest.json`, JSON.stringify(manifest));

  // A machine without rsync gets the changed parts as a tarball.
  await syncMachine(withoutRsync, { ...options([]), configDir: work });
  const recorded = json(`${there}/.claude/plugins/installed_plugins.json`).plugins['fresh@hub']?.[0]?.installPath;
  const sentTo = Object.keys(json(`${there}/.bifrost/sync-manifest.json`)).filter((k) => k.includes('fresh'));
  check(
    "a plugin installed through a config dir's link lands in ~/.claude there, and nothing is removed through a link",
    recorded === `${there}/.claude/plugins/cache/hub/fresh/2.0.0` &&
      show(sentTo) === show(['.claude/plugins/cache/hub/fresh/2.0.0']) &&
      fs.existsSync(`${there}/.claude/plugins/cache/hub/fresh/2.0.0/.claude-plugin/plugin.json`) &&
      fs.existsSync(`${there}/.claude/plugins/cache/hub/tool/1.0.0/.claude-plugin/plugin.json`),
    show({ recorded, sentTo, tool: fs.existsSync(`${there}/.claude/plugins/cache/hub/tool/1.0.0`) }),
  );
}

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
