const CLIPBOARD_SELECTION = 'c';

/**
 * The text a session wants copied out of an OSC 52 payload
 * (`<selections>;<base64>`), or null when the sequence is not a clipboard write
 * this terminal owns — `?` asks the terminal to report its contents back, and
 * other selection letters address buffers the app does not manage. Answering
 * either replaces what the user copied with something they never asked for.
 */
export function decodeOsc52(payload: string): string | null {
  const separator = payload.indexOf(';');
  if (separator === -1) return null;

  const selections = payload.slice(0, separator);
  if (selections !== '' && !selections.includes(CLIPBOARD_SELECTION)) return null;

  // Senders may wrap long base64 across lines.
  const encoded = payload.slice(separator + 1).replace(/\s/g, '');
  if (!encoded || encoded === '?') return null;

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
