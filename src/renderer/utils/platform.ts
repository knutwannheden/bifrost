const isMac = navigator.platform.startsWith('Mac');

/** Check if the platform modifier key is pressed (Cmd on macOS, Ctrl on Linux/Windows) */
export function isModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** Platform-appropriate modifier symbol for display */
export const modSymbol = isMac ? '\u2318' : 'Ctrl+';

/** Platform-appropriate shift symbol for display */
export const shiftSymbol = isMac ? '\u21E7' : 'Shift+';

/** Platform-appropriate alt/option symbol for display */
export const altSymbol = isMac ? '\u2325' : 'Alt+';

/** Platform-appropriate delete symbol for display */
export const deleteSymbol = isMac ? '\u232B' : 'Del';
