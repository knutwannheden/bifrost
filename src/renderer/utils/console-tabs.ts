import type { BifrostConfig } from '../../shared/types';

/** The consoles the overlay offers: '' for this machine's, then each machine that runs its own instance. */
export function consoleTabs(config: BifrostConfig | null): string[] {
  return ['', ...(config?.machines ?? []).filter((m) => m.instance).map((m) => m.name)];
}

export function stepConsole(tabs: string[], current: string, step: 1 | -1): string {
  return tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length];
}
