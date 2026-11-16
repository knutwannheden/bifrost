/**
 * The welcome screen lists the programs Bifrost needs here, which depend on the
 * agent its sessions run. Run with `npm run check:prerequisites`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPrograms } from '../src/main/prerequisites.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-prereq-')));
// Everything on PATH but tmux and the agents, and a Codex that answers --version.
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const hidden = new Set(['tmux', 'claude', 'copilot', 'codex']);
const seen = new Set<string>();
for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    continue;
  }
  for (const name of names) {
    if (hidden.has(name) || seen.has(name)) continue;
    seen.add(name);
    fs.symlinkSync(path.join(dir, name), path.join(bin, name));
  }
}
fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = bin;

try {
  const programs = await checkPrograms('codex', 'claude');
  const of = (name: string) => programs.find((p) => p.name === name);
  const required = programs.filter((p) => p.required).map((p) => p.name);
  check(
    "with Codex as the agent and Claude for Bifrost's own calls, git, tmux, python3, curl and codex are required, a missing tmux shows, and claude is optional",
    show(required.sort()) === show(['codex', 'curl', 'git', 'python3', 'tmux']) &&
      of('tmux')?.found === false &&
      of('codex')?.found === true &&
      of('claude')?.required === false,
    show(programs),
  );

  const alone = await checkPrograms('codex', 'codex');
  check(
    "with Codex for both, no other agent's CLI is listed",
    !alone.some((p) => p.name === 'claude' || p.name === 'copilot'),
    show(alone),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
