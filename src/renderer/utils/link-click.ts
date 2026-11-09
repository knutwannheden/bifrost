/**
 * Whether a press on a link stays with the terminal, which opens the link, and
 * not also with a program tracking the mouse. Claude's fullscreen view opens a
 * link it is told was clicked.
 */
export function keepsClickFromProgram(button: number, overLink: boolean, mouseTracked: boolean): boolean {
  return overLink && mouseTracked && button === 0;
}
