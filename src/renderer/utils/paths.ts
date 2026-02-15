/** Replace /Users/<user> or /home/<user> prefix with ~ */
export function shortPath(p: string): string {
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  return m ? '~' + p.slice(m[1].length) : p;
}
