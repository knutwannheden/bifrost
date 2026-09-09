import { Unicode11Addon } from '@xterm/addon-unicode11';

interface WidthConfigurableTerminal {
  loadAddon(addon: Unicode11Addon): void;
  unicode: { activeVersion: string };
}

/**
 * xterm's default width table gives every emoji a single cell though Unicode
 * classes them wide, so everything after one lands a column to the left of
 * where a wcwidth-based program puts it. Version 11 widens them and leaves
 * ambiguous characters narrow, which is what the box-drawing TUI wants. The
 * mirror applies it too so its rows hold the same screen the renderer shows.
 */
export function applyUnicodeWidths(terminal: WidthConfigurableTerminal): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
}
