import {
  type ChordEvent,
  type KeyStroke,
  parseStroke,
  strokeLabel,
  strokeMatches,
  strokeOfEvent,
} from '../../shared/keymap';

export const isMac = navigator.userAgent.includes('Macintosh');

/** The keymap stroke a key event spells, or null when the chord belongs to the terminal. */
export function pressedStroke(e: ChordEvent): KeyStroke | null {
  return strokeOfEvent(e, isMac);
}

/** Whether a key event is the given shortcut, written as in the keymap (`Cmd+Shift+C`). */
export function isShortcut(e: ChordEvent, shortcut: string): boolean {
  const pressed = pressedStroke(e);
  return !!pressed && strokeMatches(parseStroke(shortcut), pressed);
}

/** A shortcut written as in the keymap (`Cmd+Shift+C`), as this platform's user reads it. */
export function shortcutLabel(shortcut: string): string {
  return strokeLabel(parseStroke(shortcut), isMac);
}

/** Platform-appropriate modifier symbol for display */
export const modSymbol = isMac ? '⌘' : 'Ctrl+Shift+';

/** Platform-appropriate alt/option symbol for display */
export const altSymbol = isMac ? '⌥' : 'Alt+';

/** Platform-appropriate symbol for the Backspace key */
export const deleteSymbol = isMac ? '⌫' : 'Backspace';
