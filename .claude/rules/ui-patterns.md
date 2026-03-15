Consistent UI patterns across all renderer components:

**Empty states:**
- Standard: `text-sm text-muted text-center py-4`
- Never use `text-xs` for empty state messages

**Inline styles:**
- Use Tailwind classes instead of `style={{ }}` wherever possible
- Exceptions: terminal sizing (xterm.js), tooltip positioning, Shiki token colors

**Interactive elements:**
- All buttons/links with hover states must include `transition-colors`
- Use semantic color tokens (`text-success`, `bg-warning/20`) — never raw Tailwind colors (`text-green-400`, `bg-amber-500/20`)

**Loading states:**
- Use `Spinner` component with adjacent text in a flex container
- Pattern: `<div className="flex items-center gap-2 text-secondary"><Spinner /><span>Loading...</span></div>`
