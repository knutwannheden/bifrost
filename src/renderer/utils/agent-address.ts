/**
 * The task a message was addressed to. Claude disambiguates same-named sessions
 * with a trailing reference, which is no part of the task's name.
 */
export function messageTargetName(to: string): string {
  return to.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
}
