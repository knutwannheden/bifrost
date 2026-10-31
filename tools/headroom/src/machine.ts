import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

export interface Proc {
  pid: number;
  ppid: number;
  comm: string;
  /** Accumulated CPU time in milliseconds. */
  cpuMs: number;
}

export interface ForeignLoad {
  /** CPU burned by the competing processes outside every excluded tree, as a percentage of one core. */
  percent: number;
  top: { pid: number; comm: string; percent: number }[];
}

/**
 * A process competes for a core from this share of one. Those under it are
 * the desktop's idle hum and stay out of the sum however many there are.
 */
const COMPETING_PERCENT = 50;

/** Long enough that a one-second burst of one process does not tip the sample. */
const DEFAULT_SAMPLE_MS = 3000;

/** ps TIME, which runs [[dd-]hh:]mm:ss.hh, as milliseconds. */
function parseTime(text: string): number {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = clock!.split(':').map(Number);
  const seconds = parts.reduce((acc, n) => acc * 60 + n, 0);
  return Math.round((Number(days) * 86_400 + seconds) * 1000);
}

/** The table `ps -Ao pid,ppid,time,comm` prints, by pid. */
export function parsePs(text: string): Map<number, Proc> {
  const procs = new Map<number, Proc>();
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || !/^\d+$/.test(f[0]!)) continue;
    procs.set(Number(f[0]), {
      pid: Number(f[0]),
      ppid: Number(f[1]),
      comm: basename(f.slice(3).join(' ')),
      cpuMs: parseTime(f[2]!),
    });
  }
  return procs;
}

/** What ran between two snapshots outside the given process trees. */
export function foreignLoad(
  before: Map<number, Proc>,
  after: Map<number, Proc>,
  windowMs: number,
  excludedRoots: number[],
): ForeignLoad {
  const roots = new Set(excludedRoots);
  const excluded = (pid: number): boolean => {
    for (let p: number | undefined = pid, hops = 0; p && p > 0 && hops < 64; p = after.get(p)?.ppid, hops++) {
      if (roots.has(p)) return true;
    }
    return false;
  };
  const top: ForeignLoad['top'] = [];
  for (const proc of after.values()) {
    if (excluded(proc.pid)) continue;
    const burned = proc.cpuMs - (before.get(proc.pid)?.cpuMs ?? 0);
    const percent = Math.round((100 * burned) / windowMs);
    if (percent < COMPETING_PERCENT) continue;
    top.push({ pid: proc.pid, comm: proc.comm, percent });
  }
  top.sort((a, b) => b.percent - a.percent);
  return { percent: top.reduce((sum, p) => sum + p.percent, 0), top: top.slice(0, 5) };
}

function ps(): Map<number, Proc> {
  const custom = process.env.HEADROOM_PS;
  const r = custom
    ? spawnSync(custom, [], { encoding: 'utf8' })
    : spawnSync('ps', ['-Ao', 'pid,ppid,time,comm'], { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || `ps exited ${r.status}`).trim());
  return parsePs(r.stdout);
}

/**
 * Samples the machine for a moment and reports what ran outside the given
 * process trees, or the reason it could not look.
 */
export async function sampleForeignLoad(excludedRoots: number[]): Promise<ForeignLoad | { error: string }> {
  const windowMs = Number(process.env.HEADROOM_SAMPLE_MS ?? DEFAULT_SAMPLE_MS);
  try {
    const before = ps();
    await new Promise((r) => setTimeout(r, windowMs));
    return foreignLoad(before, ps(), windowMs, excludedRoots);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function describeLoad(load: ForeignLoad): string {
  const top = load.top.map((p) => `${p.comm} ${p.percent}% (pid ${p.pid})`).join(', ');
  return `${load.percent}% busy outside any claim${top ? `: ${top}` : ''}`;
}
