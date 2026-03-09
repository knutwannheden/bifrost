export interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

export function parsePrUrl(text: string): ParsedPrUrl | null {
  const match = text.trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

export interface ParsedIssueUrl {
  owner: string;
  repo: string;
  number: number;
}

export function parseIssueUrl(text: string): ParsedIssueUrl | null {
  const match = text.trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?(?:[?#].*)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

export function parseSlackUrl(text: string): string | null {
  const match = text.trim().match(/^(https?:\/\/[^/]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+\S*)/);
  return match ? match[1] : null;
}
