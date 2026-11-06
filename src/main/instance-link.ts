import type { Task } from '../shared/types.ts';
import { claudeConfigRelative } from './claude-paths.ts';
import { loadConfig } from './config.ts';
import { connectPeer, IDE, peerTasks, postToPeer, refreshPeer, registerPeer } from './peers.ts';
import { getRemoteHost, localClaudeValue, remoteClonePath } from './remote-host.ts';
import { machinesInUse } from './restore-plan.ts';
import { forgetTasks, getTasks } from './task-service.ts';

/** Whether the named machine runs its own instance, which owns the tasks there. */
export function isInstanceMachine(name: string | undefined): boolean {
  return !!name && (loadConfig().machines ?? []).some((m) => m.name === name && m.instance === true);
}

/**
 * Registers each machine that runs its own instance as a peer, whose connect
 * brings that instance up, copies it the preferences here and has it link
 * back. The tasks still held here for such a machine are handed over.
 */
export function linkInstances(): void {
  for (const machine of loadConfig().machines ?? []) {
    if (!machine.instance) continue;
    registerPeer(machine.name, async () => {
      const host = getRemoteHost(machine.name);
      const port = await host.ensureInstance();
      await sendPreferences(port);
      // The machine's view of this instance is its own concern, so a failure there leaves this link up.
      await post(port, '/link-back', { name: IDE, port: (await host.connect()).apiPort }).catch((err) =>
        console.warn(`[instances] ${machine.name} did not link back: ${(err as Error).message}`),
      );
      return port;
    });
    const held = getTasks().filter((t) => t.machine === machine.name);
    if (held.length > 0) {
      handOver(machine.name, held).catch((err) =>
        console.warn(`[instances] ${machine.name} kept none of ${held.length} tasks: ${(err as Error).message}`),
      );
    }
  }
}

/**
 * Connects to each machine an open task runs on, so the first tab there finds the
 * link up and the setup synced. A machine that is away waits for its first tab.
 */
export function connectMachinesInUse(): void {
  for (const name of machinesInUse([...getTasks(), ...peerTasks()])) {
    const connecting = isInstanceMachine(name)
      ? connectPeer(name)
      : Promise.resolve().then(() => getRemoteHost(name).connect());
    connecting.catch((err) => console.warn(`[instances] ${name} not connected at start: ${(err as Error).message}`));
  }
}

/** One handover at a time per machine, since each settings save asks for one. */
const handingOver = new Map<string, Promise<void>>();

/**
 * Hands tasks to the machine's instance, with their repos at the paths they
 * have there, and forgets them here once it has taken them.
 */
export function handOver(machine: string, handed: Task[]): Promise<void> {
  const previous = handingOver.get(machine) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      const still = handed.filter((t) => getTasks().some((held) => held.id === t.id));
      return still.length > 0 ? handOverNow(machine, still) : undefined;
    });
  handingOver.set(machine, next);
  return next;
}

async function handOverNow(machine: string, handed: Task[]): Promise<void> {
  const info = await getRemoteHost(machine).connectReady();
  const repos = loadConfig()
    .repos.filter((r) => handed.some((t) => t.repoId === r.id))
    .map((r) => ({ ...r, path: `${info.home}/${remoteClonePath(r)}` }));
  const answer = await postToPeer(machine, '/import-tasks', { tasks: handed, repos });
  forgetTasks((answer.ids as string[] | undefined) ?? []);
  await refreshPeer(machine);
}

function sendPreferences(port: number): Promise<void> {
  const config = loadConfig();
  return post(port, '/preferences', {
    permissionMode: config.permissionMode,
    agentTeams: config.agentTeams,
    managePermissions: config.managePermissions,
    prompts: config.prompts,
    remoteControlAtStartup: localClaudeValue('remoteControlAtStartup') === true,
    claudeConfigDir: claudeConfigRelative(),
  });
}

async function post(port: number, route: string, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route} answered ${res.status}`);
}
