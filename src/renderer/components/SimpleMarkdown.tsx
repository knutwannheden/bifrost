import Markdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * Agents write a single newline where they mean a line break, as GitHub renders
 * it, so `remark-breaks` joins GFM rather than leaving those as spaces.
 */
const PLUGINS = [remarkGfm, remarkBreaks];

/** Element styles, since the app's colours come from tokens rather than a reset. */
const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="mt-2 mb-1 font-semibold text-primary">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-2 mb-1 font-semibold text-primary">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 font-semibold text-primary">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border-default pl-2 text-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-border-default" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      {/* Rules rather than a grid: a box per cell is more ink than the numbers. */}
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border-input">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border-default/40 last:border-0">{children}</tr>,
  th: ({ children }) => <th className="px-2 py-1.5 font-semibold text-secondary">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1.5 align-top">{children}</td>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent-hover hover:underline transition-colors">
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="my-1 overflow-x-auto rounded-sm border border-border-default/60 bg-surface-alt px-2 py-1 text-primary">
      {children}
    </pre>
  ),
  code: ({ className, children }) =>
    // Only a fenced block carries a language class; a span gets the inline chip,
    // which is the one thing in narration a reader scans for.
    className ? (
      <code className="font-mono text-xs">{children}</code>
    ) : (
      <code className="rounded-sm bg-code/10 px-1 font-mono text-xs text-code">{children}</code>
    ),
};

/** Renders agent prose and toasts. Raw HTML is not enabled, so text stays text. */
export default function SimpleMarkdown({ text }: { text: string }) {
  return (
    <div className="break-words">
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}
