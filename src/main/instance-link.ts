import type { Task } from '../shared/types.ts';
import { loadConfig } from './config.ts';
import { postToPeer, refreshPeer, registerPeer } from './peers.ts';
import { getRemoteHost, localClaudeValue, remoteClonePath } from './remote-host.ts';
import { forgetTasks, getTasks } from './task-service.ts';

/** Whether the named machine runs its own instance, which owns the tasks there. */
export function isInstanceMachine(name: string | undefined): boolean {
  return !!name && (loadConfig().machines ?? []).some((m) => m.name === name && m.instance === true);
}

/**
 * Registers each machine that runs its own instance as a peer, whose connect
 * brings that instance up and copies it the preferences here. The tasks still
 * held here for such a machine are handed over.
 */
export function linkInstances(): void {
  for (const machine of loadConfig().machines ?? []) {
    if (!machine.instance) continue;
    registerPeer(machine.name, async () => {
      const port = await getRemoteHost(machine.name).ensureInstance();
      await sendPreferences(port);
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
 * Hands tasks to the machine's instance, with their repos at the paths they
 * have there, and forgets them here once it has taken them.
 */
export async function handOver(machine: string, handed: Task[]): Promise<void> {
  const info = await getRemoteHost(machine).connectReady();
  const repos = loadConfig()
    .repos.filter((r) => handed.some((t) => t.repoId === r.id))
    .map((r) => ({ ...r, path: `${info.home}/${remoteClonePath(r)}` }));
  const answer = await postToPeer(machine, '/import-tasks', { tasks: handed, repos });
  forgetTasks((answer.ids as string[] | undefined) ?? []);
  await refreshPeer(machine);
}

async function sendPreferences(port: number): Promise<void> {
  const config = loadConfig();
  const res = await fetch(`http://127.0.0.1:${port}/preferences`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      permissionMode: config.permissionMode,
      agentTeams: config.agentTeams,
      managePermissions: config.managePermissions,
      prompts: config.prompts,
      remoteControlAtStartup: localClaudeValue('remoteControlAtStartup') === true,
    }),
  });
  if (!res.ok) throw new Error(`preferences answered ${res.status}`);
}
