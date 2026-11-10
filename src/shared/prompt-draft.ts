/**
 * The text typed at an agent's prompt, on a screen captured with its escape codes.
 * Claude's and Copilot's input box is the last ❯ line with a rule above it.
 * Codex's is the last line starting with ›. Each draws a suggestion or
 * placeholder there faint, so faint text is left out.
 */
export function promptDraft(screen: string): string {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i > 0; i--) {
    const at = lines[i].indexOf('❯');
    if (at >= 0 && lines[i - 1].includes('───')) return unfaint(lines[i].slice(at + 1)).trim();
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = unescaped(lines[i]);
    if (text.startsWith('›')) return unfaint(lines[i].slice(lines[i].indexOf('›') + 1)).trim();
  }
  return '';
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts the codes being removed
const unescaped = (line: string) => line.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '');

function unfaint(text: string): string {
  let out = '';
  let faint = false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts the codes being read
  for (const part of text.split(/(\x1b\[[0-9;:?]*[A-Za-z])/)) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts the codes being read
    const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part);
    if (sgr) {
      for (const p of sgr[1].split(';')) {
        if (p === '2') faint = true;
        else if (p === '' || p === '0' || p === '22') faint = false;
      }
    } else if (!part.startsWith('\x1b') && !faint) {
      out += part;
    }
  }
  return out;
}
