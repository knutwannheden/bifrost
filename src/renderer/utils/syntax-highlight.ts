import { type BundledLanguage, createHighlighter, type Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;

const extToLang: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  java: 'java',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  kt: 'kotlin',
  swift: 'swift',
  vue: 'vue',
  svelte: 'svelte',
  php: 'php',
  tf: 'hcl',
};

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...new Set(Object.values(extToLang))],
    }).catch((err) => {
      // Reset so next call retries instead of caching the rejected promise
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

export interface HighlightedToken {
  content: string;
  color: string;
}

const FALLBACK_DARK = '#e2e8f0';
const FALLBACK_LIGHT = '#24292e';

export async function highlightLines(lines: string[], ext: string, dark = true): Promise<HighlightedToken[][]> {
  const lang = extToLang[ext];
  const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  const shikiTheme = dark ? 'github-dark' : 'github-light';

  if (!lang) {
    return lines.map((line) => [{ content: line, color: fallback }]);
  }

  try {
    const highlighter = await getHighlighter();
    const code = lines.join('\n');
    const result = highlighter.codeToTokens(code, {
      lang: lang as BundledLanguage,
      theme: shikiTheme,
    });

    return result.tokens.map((lineTokens) =>
      lineTokens.map((token) => ({
        content: token.content,
        color: token.color ?? fallback,
      })),
    );
  } catch (err) {
    console.warn('[syntax-highlight] Shiki highlighting failed:', err);
    return lines.map((line) => [{ content: line, color: fallback }]);
  }
}
