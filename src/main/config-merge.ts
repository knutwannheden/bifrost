import type { BifrostConfig } from '../shared/types.ts';

/**
 * Fold a config sent by the renderer into what is on disk. The window holds its
 * copy from load time and writes the whole object back, so fields the main
 * process owns — repos, added by the MCP tool; the reclaim scan's timestamp —
 * would otherwise be reverted by an unrelated setting change.
 */
export function mergeRendererConfig(incoming: BifrostConfig, current: BifrostConfig): BifrostConfig {
  const merged: BifrostConfig = { ...incoming, repos: current.repos };
  if (current.lastDiskScanAt === undefined) delete merged.lastDiskScanAt;
  else merged.lastDiskScanAt = current.lastDiskScanAt;
  return merged;
}
