import type { Terminal } from '@xterm/xterm';

interface HippieState {
  /** The original partial word the user was typing */
  prefix: string;
  /** Unique completions found in the buffer, nearest first */
  matches: string[];
  /** Current position in the matches array */
  matchIndex: number;
  /** Session where the expand was triggered */
  sessionId: string;
  /** Number of chars to delete to undo the current completion */
  insertedLength: number;
}

let state: HippieState | null = null;

/** Reset hippie-expand state — call on any non-hippie user input. */
export function resetHippieState(): void {
  state = null;
}

/**
 * Extract the partial word immediately before the cursor.
 * Walks backwards from cursorX on the cursor line until whitespace or line start.
 */
function getWordBeforeCursor(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lineIndex = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(lineIndex);
  if (!line) return '';

  const cursorX = buffer.cursorX;
  let start = cursorX;
  while (start > 0) {
    const ch = line.getCell(start - 1)?.getChars() ?? '';
    if (!ch || /\s/.test(ch)) break;
    start--;
  }

  let word = '';
  for (let i = start; i < cursorX; i++) {
    word += line.getCell(i)?.getChars() ?? '';
  }
  return word;
}

/**
 * Search the terminal buffer for words starting with the given prefix.
 * Scans bottom-to-top so nearest matches come first. Deduplicates.
 */
function findMatches(terminal: Terminal, prefix: string): string[] {
  if (!prefix) return [];

  const buffer = terminal.buffer.active;
  const totalLines = buffer.baseY + terminal.rows;
  const seen = new Set<string>();
  const matches: string[] = [];

  for (let y = totalLines - 1; y >= 0; y--) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    // Split on non-word characters to extract tokens
    for (const word of text.split(/[^\w\-./]+/)) {
      if (word.length > prefix.length && word.startsWith(prefix) && !seen.has(word)) {
        seen.add(word);
        matches.push(word);
      }
    }
  }

  return matches;
}

/**
 * Perform hippie-expand (dabbrev-expand) on the terminal.
 * First call: complete the partial word before cursor with the nearest buffer match.
 * Repeated calls: cycle through alternative matches.
 */
export function hippieExpand(terminal: Terminal, sessionId: string): void {
  const isCycling = state !== null && state.sessionId === sessionId;

  if (isCycling) {
    // Cycle to next match
    state!.matchIndex = (state!.matchIndex + 1) % state!.matches.length;
    const match = state!.matches[state!.matchIndex];
    const suffix = match.slice(state!.prefix.length);

    // Delete previous completion, insert new one
    const backspaces = '\x7f'.repeat(state!.insertedLength);
    window.bifrost.writeToSession(sessionId, backspaces + suffix);
    state!.insertedLength = suffix.length;
  } else {
    // Fresh expand
    const prefix = getWordBeforeCursor(terminal);
    if (!prefix) return;

    const matches = findMatches(terminal, prefix);
    if (matches.length === 0) return;

    const suffix = matches[0].slice(prefix.length);
    state = {
      prefix,
      matches,
      matchIndex: 0,
      sessionId,
      insertedLength: suffix.length,
    };

    window.bifrost.writeToSession(sessionId, suffix);
  }
}
