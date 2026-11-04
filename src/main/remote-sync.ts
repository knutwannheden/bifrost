import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shQuote } from './remote-host.ts';

export interface SyncOptions {
  localHome: string;
  remoteHome: string;
  /** Repos whose parent directories may hold a CLAUDE.md that Claude loads for them. */
  repoPaths: string[];
  /** Further files and directories, relative to home or written with ~/. */
  syncPaths: string[];
  /** Bifrost's own headroom, copied there and linked into ~/.local/bin. */
  headroomDir?: string;
  /** The Claude config dir sessions use, under localHome. Without it, ~/.claude. */
  configDir?: string;
}

/** What syncing needs from the machine. */
export interface SyncTarget {
  upload(localDir: string, remoteDir: string): Promise<void>;
  exec(script: string): Promise<string>;
}

/** A file or directory that lands at path, relative to home on the machine, and is replaced there whole. */
interface Unit {
  path: string;
  from?: string;
  /** The parts of `from` copied, when not all of it. */
  only?: string[];
  text?: string;
}

const MANIFEST = '.bifrost/sync-manifest.json';
const DROP = '.bifrost/sync-drop';
const HEADROOM = '.bifrost/tools/headroom';
/** The user's rules, which the machine's CLAUDE.md imports. That file is added to, never replaced. */
const RULES = '.bifrost/claude/CLAUDE.md';
const RULES_IMPORT = `@~/${RULES}`;
/** Remote sessions load Bifrost's plugin with --plugin-dir, and a second copy would clash with it. */
const OWN_PLUGIN = 'bifrost@bifrost';
const OWN_MARKETPLACE = 'bifrost';
/** Claude's marks for the processes using a plugin here, which mean nothing on the machine. */
const LOCAL_ONLY = new Set(['.in_use']);
/** A unit is replaced whole, so none may contain these. */
const PROTECTED = ['.claude/.credentials.json', '.claude/projects', '.claude.json', '.ssh', '.bifrost', '.config/gh'];

/** The parts of Claude Code's config files that syncing reads. */
interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
  statusLine?: { command?: unknown };
}
interface InstalledPlugins {
  plugins?: Record<string, Array<{ installPath?: unknown }>>;
}
interface Marketplace {
  source?: { source?: string; path?: string };
  installLocation: string;
}
interface MarketplaceManifest {
  plugins?: Array<{ name: string; source?: unknown }>;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** The path relative to home, or null for one outside it, which has no place to go on the machine. */
function homeRelative(home: string, file: string): string | null {
  const relative = path.relative(home, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : null;
}

/** Where an entry links to, or null when it is no link. */
function linkTarget(entry: string): string | null {
  return fs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink()
    ? path.resolve(path.dirname(entry), fs.readlinkSync(entry))
    : null;
}

/** A config dir's own login and account, which stay on the machine they were made on. */
const PER_ACCOUNT = ['.claude.json', '.credentials.json'];

/**
 * Where a top-level entry of the config dir is read here and written there.
 * In a config dir other than ~/.claude, an entry linking into ~/.claude is that target.
 */
function configPart(o: SyncOptions, name: string): { from: string; path: string } {
  const claudeHome = `${o.localHome}/.claude`;
  const entry = `${o.configDir ?? claudeHome}/${name}`;
  const target = o.configDir && o.configDir !== claudeHome ? linkTarget(entry) : null;
  const from = target && homeRelative(claudeHome, target) ? target : entry;
  return { from, path: homeRelative(o.localHome, from) ?? `.claude/${name}` };
}

/** The top-level links of a config dir other than ~/.claude into ~/.claude, relative to home. */
function configLinks(o: SyncOptions): Array<{ path: string; target: string; dir: boolean }> {
  const claudeHome = `${o.localHome}/.claude`;
  if (!o.configDir || o.configDir === claudeHome) return [];
  const dir = o.configDir;
  return fs.readdirSync(dir).flatMap((name) => {
    const target = PER_ACCOUNT.includes(name) ? null : linkTarget(`${dir}/${name}`);
    const relative = target ? homeRelative(o.localHome, target) : null;
    const linkPath = homeRelative(o.localHome, `${dir}/${name}`);
    const stat = target ? fs.statSync(target, { throwIfNoEntry: false }) : undefined;
    if (!target || !homeRelative(claudeHome, target) || !relative || !linkPath || !stat) return [];
    return [{ path: linkPath, target: relative, dir: stat.isDirectory() }];
  });
}

/**
 * Recreates each link there, relative, after making its target exist. A real file
 * or directory where a link would go is kept and reported as KEPT.
 */
function linkLines(links: ReturnType<typeof configLinks>): string[] {
  return links.flatMap(({ path: p, target, dir }) => {
    const relative = path.posix.relative(path.posix.dirname(p), target);
    return [
      `mkdir -p "$(dirname ${shQuote(p)})"`,
      dir
        ? `mkdir -p ${shQuote(target)}`
        : `[ -e ${shQuote(target)} ] || { mkdir -p "$(dirname ${shQuote(target)})" && : > ${shQuote(target)}; }`,
      `if [ -L ${shQuote(p)} ] || [ ! -e ${shQuote(p)} ]; then ln -sfn ${shQuote(relative)} ${shQuote(p)}; ` +
        `else printf 'KEPT=%s\\n' ${shQuote(p)}; fi`,
    ];
  });
}

function units(o: SyncOptions): Unit[] {
  const home = o.localHome;
  const list: Unit[] = [];
  const add = (from: string) => {
    const relative = homeRelative(home, from);
    if (relative && fs.existsSync(from) && !list.some((u) => u.path === relative)) list.push({ path: relative, from });
  };
  const resolve = (p: string) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(home, p));

  const rules = configPart(o, 'CLAUDE.md');
  if (fs.existsSync(rules.from)) list.push({ path: RULES, from: rules.from });
  for (const dir of ['skills', 'agents', 'commands']) add(configPart(o, dir).from);
  const settingsPart = configPart(o, 'settings.json');
  const plugins = configPart(o, 'plugins');
  const settings = readJson<ClaudeSettings>(settingsPart.from) ?? {};
  if (typeof settings.statusLine?.command === 'string') add(resolve(settings.statusLine.command));
  for (const repo of o.repoPaths) {
    for (let dir = path.dirname(repo); homeRelative(home, dir); dir = path.dirname(dir)) add(`${dir}/CLAUDE.md`);
  }

  // The plugins enabled here, each where it is installed, and the marketplaces they come from.
  const enabled = Object.entries(settings.enabledPlugins ?? {})
    .filter(([id, on]) => on && id !== OWN_PLUGIN)
    .map(([id]) => id);
  const installed = readJson<InstalledPlugins>(`${plugins.from}/installed_plugins.json`) ?? {};
  const known = readJson<Record<string, Marketplace>>(`${plugins.from}/known_marketplaces.json`) ?? {};
  for (const id of enabled) {
    const installPath = installed.plugins?.[id]?.[0]?.installPath;
    if (typeof installPath === 'string') add(installPath);
  }
  const knownThere: Record<string, Marketplace> = {};
  for (const name of new Set(enabled.map((id) => id.slice(id.indexOf('@') + 1)))) {
    const entry = known[name];
    if (!entry || name === OWN_MARKETPLACE || !fs.existsSync(entry.installLocation)) continue;
    const dest = `${plugins.path}/marketplaces/${name}`;
    const there = `${o.remoteHome}/${dest}`;
    if (entry.source?.source === 'directory') {
      // A directory marketplace is often a whole repo. Claude needs its manifest and the plugins enabled from it.
      const manifest = readJson<MarketplaceManifest>(`${entry.installLocation}/.claude-plugin/marketplace.json`) ?? {};
      const sources = (manifest.plugins ?? [])
        .filter((p) => enabled.includes(`${p.name}@${name}`) && typeof p.source === 'string')
        .map((p) => path.normalize(p.source as string));
      list.push({ path: dest, from: entry.installLocation, only: ['.claude-plugin', ...sources] });
      knownThere[name] = { ...entry, source: { source: 'directory', path: there }, installLocation: there };
    } else {
      // Claude reads a GitHub marketplace's version from its clone, so the clone travels whole.
      list.push({ path: dest, from: entry.installLocation });
      knownThere[name] = { ...entry, installLocation: there };
    }
  }

  const rewrite = (value: unknown) => JSON.stringify(value, null, 2).split(home).join(o.remoteHome);
  const enabledThere = Object.fromEntries(enabled.map((id) => [id, true]));
  list.push({ path: settingsPart.path, text: rewrite({ ...settings, enabledPlugins: enabledThere }) });
  const installedThere = Object.fromEntries(
    enabled.filter((id) => installed.plugins?.[id]).map((id) => [id, installed.plugins?.[id]]),
  );
  list.push({
    path: `${plugins.path}/installed_plugins.json`,
    text: rewrite({ ...installed, plugins: installedThere }),
  });
  list.push({ path: `${plugins.path}/known_marketplaces.json`, text: rewrite(knownThere) });

  if (o.headroomDir && fs.existsSync(o.headroomDir)) {
    const parts = ['package.json', 'src', 'skill'].filter((p) => fs.existsSync(path.join(o.headroomDir as string, p)));
    list.push({ path: HEADROOM, from: o.headroomDir, only: parts });
  }

  const builtIn = new Set(list.map((u) => u.path));
  const configRelative = o.configDir ? homeRelative(home, o.configDir) : null;
  const protectedPaths = [...PROTECTED, ...(configRelative ? PER_ACCOUNT.map((f) => `${configRelative}/${f}`) : [])];
  for (const extra of o.syncPaths) {
    const relative = homeRelative(home, resolve(extra));
    const contains = (p: string) => p === relative || p.startsWith(`${relative}/`);
    if (
      !relative ||
      protectedPaths.some(contains) ||
      [...builtIn].some((p) => contains(p) || relative.startsWith(`${p}/`))
    ) {
      console.warn(`[sync] skipping ${extra}: it overlaps what Bifrost syncs or protects`);
      continue;
    }
    add(resolve(extra));
  }
  return list;
}

/**
 * Calls onFile for each file under abs, following symlinks, with its path
 * relative to the unit. A directory that links back to one it sits in is skipped.
 */
function walk(
  abs: string,
  relative: string,
  onFile: (real: string, relative: string, mode: number) => void,
  above = new Set<string>(),
): void {
  const real = fs.realpathSync(abs);
  const stat = fs.statSync(real);
  if (stat.isFile()) {
    onFile(real, relative, stat.mode);
  } else if (stat.isDirectory() && !above.has(real)) {
    const inside = new Set(above).add(real);
    for (const name of fs.readdirSync(real).sort()) {
      if (!LOCAL_ONLY.has(name)) walk(path.join(abs, name), relative ? `${relative}/${name}` : name, onFile, inside);
    }
  }
}

function eachPart(unit: Unit, onFile: (real: string, relative: string, mode: number) => void): void {
  for (const part of unit.only ?? ['']) {
    const abs = path.join(unit.from as string, part);
    if (fs.existsSync(abs)) walk(abs, part, onFile);
  }
}

/** A hash of what a unit holds, with each file's path and whether it is executable. */
function hashUnit(unit: Unit): string {
  const hash = createHash('sha1');
  if (unit.text !== undefined) return hash.update(`text\0${unit.text}`).digest('hex');
  eachPart(unit, (real, relative, mode) => {
    hash
      .update(`${relative}\0${mode & 0o111 ? 'x' : '-'}\0`)
      .update(fs.readFileSync(real))
      .update('\0');
  });
  return hash.digest('hex');
}

/** Copies a unit into the staging directory as plain files, since a symlink would point at this machine. */
function stageUnit(unit: Unit, stage: string): void {
  const dest = path.join(stage, unit.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (unit.text !== undefined) {
    fs.writeFileSync(dest, unit.text);
    return;
  }
  eachPart(unit, (real, relative, mode) => {
    const target = relative ? path.join(dest, relative) : dest;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(real, target);
    fs.chmodSync(target, mode & 0o777);
  });
}

/** A path the manifest names, accepted only when it stays inside the home directory. */
function safeRelative(p: string): boolean {
  return p !== '' && !path.isAbsolute(p) && !p.split('/').includes('..');
}

/**
 * Brings the machine's Claude setup in line with this machine's. Each unit is
 * hashed here and compared with the manifest the last sync left there, so only
 * what changed travels. A unit synced before and gone here is removed there.
 */
export async function syncMachine(target: SyncTarget, o: SyncOptions): Promise<{ sent: string[]; removed: string[] }> {
  const list = units(o);
  const local = Object.fromEntries(list.map((u) => [u.path, hashUnit(u)]));
  const claudeMd = configPart(o, 'CLAUDE.md').path;
  const importRules =
    RULES in local
      ? `grep -qxF ${shQuote(RULES_IMPORT)} ${shQuote(claudeMd)} 2>/dev/null || ` +
        `{ mkdir -p "$(dirname ${shQuote(claudeMd)})" && printf '\\n%s\\n' ${shQuote(RULES_IMPORT)} >> ${shQuote(claudeMd)}; }\n`
      : '';
  // Links are made on every sync and kept out of the manifest, which removes what it lists once gone here.
  const links = linkLines(configLinks(o));
  let remote: Record<string, string> = {};
  try {
    remote = JSON.parse(
      (await target.exec(`cd "$HOME"\n${importRules}cat ${MANIFEST} 2>/dev/null || true`)).trim() || '{}',
    );
  } catch {
    /* no manifest yet, or an unreadable one, and everything travels */
  }
  const sent = list.filter((u) => remote[u.path] !== local[u.path]).map((u) => u.path);
  const removed = Object.keys(remote).filter((p) => !(p in local) && safeRelative(p));
  if (sent.length === 0 && removed.length === 0 && links.length === 0) return { sent, removed };

  if (sent.length > 0) {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-sync-'));
    try {
      for (const unit of list) if (sent.includes(unit.path)) stageUnit(unit, stage);
      await target.upload(stage, DROP);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }

  const script = ['set -e', 'cd "$HOME"'];
  for (const p of sent) {
    script.push(
      `rm -rf ${shQuote(p)}`,
      `mkdir -p "$(dirname ${shQuote(p)})"`,
      `mv ${shQuote(`${DROP}/${p}`)} ${shQuote(p)}`,
    );
  }
  for (const p of removed) script.push(`rm -rf ${shQuote(p)}`);
  script.push(`rm -rf ${DROP}`, `printf '%s\\n' ${shQuote(JSON.stringify(local))} > ${MANIFEST}`);
  if (sent.includes(HEADROOM)) {
    script.push('mkdir -p .local/bin', `ln -sfn "$HOME/${HEADROOM}/src/cli.ts" .local/bin/headroom`);
  }
  const plugins = configPart(o, 'plugins');
  if (sent.includes(`${plugins.path}/installed_plugins.json`)) {
    // A marketplace enabled here but with no copy, such as Anthropic's directory, has to be fetched there.
    const known = readJson<Record<string, Marketplace>>(`${plugins.from}/known_marketplaces.json`) ?? {};
    const settings = readJson<ClaudeSettings>(configPart(o, 'settings.json').from) ?? {};
    const fetched = new Set(
      Object.entries(settings.enabledPlugins ?? {})
        .filter(([id, on]) => on && id !== OWN_PLUGIN)
        .map(([id]) => id.slice(id.indexOf('@') + 1))
        .filter((name) => !known[name]),
    );
    for (const name of fetched)
      script.push(`claude plugin marketplace update ${shQuote(name)} >/dev/null 2>&1 || true`);
  }
  script.push(...links);
  const out = await target.exec(script.join('\n'));
  for (const kept of out.matchAll(/^KEPT=(.*)$/gm)) {
    console.warn(`[sync] kept ${kept[1]} there, which is no link, where this machine links into ~/.claude`);
  }
  return { sent, removed };
}
