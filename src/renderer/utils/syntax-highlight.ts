import { type BundledLanguage, createHighlighter, type Highlighter } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

let highlighterPromise: Promise<Highlighter> | null = null;

const extToLang: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
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
  jsonc: 'jsonc',
  json5: 'json5',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  xsl: 'xsl',
  svg: 'xml',
  pom: 'xml',
  csproj: 'xml',
  fsproj: 'xml',
  props: 'xml',
  targets: 'xml',
  resx: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'mdx',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  graphql: 'graphql',
  kt: 'kotlin',
  kts: 'kts',
  groovy: 'groovy',
  gradle: 'groovy',
  scala: 'scala',
  swift: 'swift',
  vue: 'vue',
  svelte: 'svelte',
  php: 'php',
  tf: 'hcl',
  tfvars: 'hcl',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  proto: 'proto',
  ini: 'ini',
  properties: 'properties',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  zig: 'zig',
  nim: 'nim',
  nix: 'nix',
  elm: 'elm',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  lisp: 'lisp',
  prisma: 'prisma',
};

/** Filename-based mapping for files whose extension is ambiguous (e.g. `.config`) */
const nameToLang: Record<string, string> = {
  'nuget.config': 'xml',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  'tsconfig.json': 'jsonc',
  '.gitignore': 'ini',
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  Jenkinsfile: 'groovy',
};

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    const allLangs = [...new Set([...Object.values(extToLang), ...Object.values(nameToLang)])];
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: allLangs,
      engine: createJavaScriptRegexEngine(),
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

const FALLBACK_DARK = '#f8f8f2'; /* Dracula Foreground */
const FALLBACK_LIGHT = '#24292e';

/**
 * Tokens for the lines of a diff, one array per line with the hunks flattened,
 * which is how callers index the result. Each hunk is highlighted on its own,
 * because the file between two hunks is not shown: a comment or string whose
 * close falls in that gap stays open for every line after it.
 */
export async function highlightLines(
  hunks: string[][],
  ext: string,
  dark = true,
  filename?: string,
): Promise<HighlightedToken[][]> {
  const lang = (filename && nameToLang[filename]) || extToLang[ext];
  const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  const shikiTheme = dark ? 'github-dark' : 'github-light';
  const plain = () => hunks.flat().map((line) => [{ content: line, color: fallback }]);

  if (!lang) return plain();

  try {
    const highlighter = await getHighlighter();
    return hunks.flatMap((lines) =>
      highlighter
        .codeToTokens(lines.join('\n'), { lang: lang as BundledLanguage, theme: shikiTheme })
        .tokens.map((lineTokens) =>
          lineTokens.map((token) => ({
            content: token.content,
            color: token.color ?? fallback,
          })),
        ),
    );
  } catch (err) {
    console.warn('[syntax-highlight] Shiki highlighting failed:', err);
    return plain();
  }
}
