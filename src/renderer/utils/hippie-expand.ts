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
    if (!ch || /\W/.test(ch)) break;
    start--;
  }

  let word = '';
  for (let i = start; i < cursorX; i++) {
    word += line.getCell(i)?.getChars() ?? '';
  }
  return word;
}

/**
 * Fallback for TUIs (like Claude Code) that park the xterm cursor away from
 * the input area. Scans the buffer for the last `❯` prompt between `───`
 * separators and returns the last word of the input text.
 */
function getWordFromTuiPrompt(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const totalLines = buffer.baseY + terminal.rows;

  for (let y = totalLines - 1; y >= Math.max(0, totalLines - 50); y--) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    const promptIdx = text.indexOf('❯');
    if (promptIdx < 0) continue;

    // Verify separator above
    let hasSeparatorAbove = false;
    for (let sy = y - 1; sy >= Math.max(0, y - 3); sy--) {
      const sLine = buffer.getLine(sy);
      if (!sLine) continue;
      if (sLine.translateToString(true).includes('───')) {
        hasSeparatorAbove = true;
        break;
      }
    }
    if (!hasSeparatorAbove) continue;

    // Build the full input text (first line + continuation lines)
    let inputText = text.slice(promptIdx + 1).trim();
    for (let cy = y + 1; cy < totalLines; cy++) {
      const cLine = buffer.getLine(cy);
      if (!cLine) break;
      const cText = cLine.translateToString(true);
      if (cText.includes('───') || cText.includes('shift+tab to cycle')) break;
      const stripped = cText.startsWith('  ') ? cText.slice(2) : cText;
      inputText += ` ${stripped}`;
    }
    inputText = inputText.trimEnd();

    // Extract the last word (word chars only, no trailing punctuation)
    const words = inputText.match(/\w+/g);
    return words && words.length > 0 ? words[words.length - 1] : '';
  }
  return '';
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
    // Extract word-boundary tokens (no surrounding punctuation)
    const tokens = text.match(/\w+/g);
    if (!tokens) continue;
    for (const token of tokens) {
      if (token.length > prefix.length && token.startsWith(prefix) && !seen.has(token)) {
        seen.add(token);
        matches.push(token);
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

    // Delete previous completion, then insert new one (separate writes
    // so the TUI processes backspaces before receiving new text)
    const backspaces = '\x7f'.repeat(state!.insertedLength);
    window.bifrost.writeToSession(sessionId, backspaces);
    setTimeout(() => {
      window.bifrost.writeToSession(sessionId, suffix);
    }, 20);
    state!.insertedLength = suffix.length;
  } else {
    // Fresh expand — try cursor-based first, fall back to TUI prompt scanning
    let prefix = getWordBeforeCursor(terminal);
    if (!prefix) {
      prefix = getWordFromTuiPrompt(terminal);
    }
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
