import type { Terminal } from '@xterm/xterm';
import type { Macro } from '../../shared/types';
import { getWordBeforeCursor } from './hippie-expand.ts';

/** What ⌥Space puts in place in turn, in one terminal, and which of those is there now. */
let cycle: { sessionId: string; texts: string[]; shown: number } | null = null;

/** Called on any other input, so the next ⌥Space starts from what is typed. */
export function resetMacroCycle(): void {
  cycle = null;
}

/**
 * What the next ⌥Space puts in place of what is there. Presses cycle through the
 * macros whose names start with the name that ends at the cursor, a full name
 * first, then back to that name. Unknown when no macro's name starts with it.
 */
export function nextExpansion(
  terminal: Terminal,
  sessionId: string,
  macros: Macro[],
): { erase: number; text: string } | { unknown: string } | null {
  if (cycle?.sessionId !== sessionId) {
    // The name has to end at the cursor, since the erase counts back from there.
    const typed = getWordBeforeCursor(terminal, /\S/);
    if (!typed) return null;
    const starting = macros.filter((m) => m.name.startsWith(typed));
    if (starting.length === 0) return { unknown: typed };
    const ordered = [...starting.filter((m) => m.name === typed), ...starting.filter((m) => m.name !== typed)];
    cycle = { sessionId, texts: [typed, ...ordered.map((m) => m.text)], shown: 0 };
  }
  const erase = cycle.texts[cycle.shown].length;
  cycle.shown = (cycle.shown + 1) % cycle.texts.length;
  return { erase, text: cycle.texts[cycle.shown] };
}

/** Puts the next macro text, or the name typed, in place of what is there, or says why there is none. */
export function expandMacro(
  terminal: Terminal,
  sessionId: string,
  macros: Macro[],
  notice: (message: string) => void,
): void {
  const next = nextExpansion(terminal, sessionId, macros);
  if (!next) return;
  if ('unknown' in next) {
    notice(`No macro starts with “${next.unknown}”`);
    return;
  }
  window.bifrost.writeToSession(sessionId, '\x7f'.repeat(next.erase));
  // Apart from the erase, as ⌥/ does, so the input takes the erase before the text.
  setTimeout(() => window.bifrost.writeToSession(sessionId, next.text), 20);
}
