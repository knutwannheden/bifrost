import type { Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;

const extToLang: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  java: 'java', py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', css: 'css', scss: 'scss',
  md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', graphql: 'graphql', kt: 'kotlin', swift: 'swift',
  vue: 'vue', svelte: 'svelte', php: 'php', tf: 'hcl',
};

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-dark'],
        langs: Object.values(extToLang).filter((v, i, a) => a.indexOf(v) === i),
      }),
    );
  }
  return highlighterPromise;
}

export interface HighlightedToken {
  content: string;
  color: string;
}

export async function highlightLines(
  lines: string[],
  ext: string,
): Promise<HighlightedToken[][]> {
  const lang = extToLang[ext];
  if (!lang) {
    return lines.map((line) => [{ content: line, color: '#e2e8f0' }]);
  }

  try {
    const highlighter = await getHighlighter();
    const code = lines.join('\n');
    const result = highlighter.codeToTokens(code, { lang: lang as import('shiki').BundledLanguage, theme: 'github-dark' });

    return result.tokens.map((lineTokens) =>
      lineTokens.map((token) => ({
        content: token.content,
        color: token.color ?? '#e2e8f0',
      })),
    );
  } catch {
    return lines.map((line) => [{ content: line, color: '#e2e8f0' }]);
  }
}
