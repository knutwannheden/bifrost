import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** What a machine reports about its instance: the build it has, and the port where its API answers. */
export interface InstanceStatus {
  hash?: string;
  port?: number;
}

export interface Packed {
  dir: string;
  hash: string;
}

const packs = new Map<string, Promise<Packed>>();

/**
 * The headless instance built from the checkout, once per process, beside a
 * package.json naming the native module the machine installs for itself.
 */
export function pack(checkout: string): Promise<Packed> {
  let packed = packs.get(checkout);
  if (!packed) {
    packed = build(checkout);
    packs.set(checkout, packed);
    packed.catch(() => packs.delete(checkout));
  }
  return packed;
}

async function build(checkout: string): Promise<Packed> {
  await execFile('npm', ['run', '-s', 'build:headless'], { cwd: checkout });
  const dir = path.join(checkout, '.vite', 'headless');
  const own = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf-8'));
  const manifest = { private: true, dependencies: { '@parcel/watcher': own.dependencies['@parcel/watcher'] } };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, hash: hashOf(dir) };
}

export function hashOf(dir: string): string {
  const hash = createHash('sha256');
  for (const name of ['headless.js', 'package.json']) hash.update(fs.readFileSync(path.join(dir, name)));
  return hash.digest('hex');
}

export function plan(status: InstanceStatus, hash: string): 'none' | 'start' | 'install' {
  if (status.hash !== hash) return 'install';
  return status.port ? 'none' : 'start';
}
