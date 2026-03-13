import { terminalRegistry } from '../hooks/useTerminal';

/**
 * Scrape partial prompt text from a Claude terminal buffer.
 * Looks for the `❯` prompt character between `───` separator lines,
 * then returns any text the user has typed after it.
 */
export function scrapePartialPrompt(taskId: string): string {
  const terminal = terminalRegistry.get(taskId);
  if (!terminal) return '';

  const buffer = terminal.buffer.active;
  const totalLines = buffer.baseY + terminal.rows;

  // Scan backwards to find the prompt line with ❯
  // The Claude Code TUI shows: ───────\n❯ user text\n───────
  for (let y = totalLines - 1; y >= Math.max(0, totalLines - 50); y--) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);

    // Look for the ❯ prompt character
    const promptIdx = text.indexOf('❯');
    if (promptIdx < 0) continue;

    // Check that a nearby line above has the separator
    let hasSeparatorAbove = false;
    for (let sy = y - 1; sy >= Math.max(0, y - 3); sy--) {
      const sLine = buffer.getLine(sy);
      if (!sLine) continue;
      const sText = sLine.translateToString(true);
      if (sText.includes('───')) {
        hasSeparatorAbove = true;
        break;
      }
    }
    if (!hasSeparatorAbove) continue;

    // Extract text after ❯ (skip the space after it)
    let userText = text.slice(promptIdx + 1);
    if (userText.startsWith(' ')) userText = userText.slice(1);

    // Also collect any continuation lines (multi-line input)
    for (let cy = y + 1; cy < totalLines; cy++) {
      const cLine = buffer.getLine(cy);
      if (!cLine) break;
      const cText = cLine.translateToString(true);
      // Stop at separator line or status bar
      if (cText.includes('───') || cText.includes('bypass permissions')) break;
      userText += `\n${cText}`;
    }

    return userText.trimEnd();
  }

  return '';
}
