import React from 'react';
import { altSymbol, modSymbol, shiftSymbol } from '../utils/platform';

type KbdSize = 'sm' | 'xs';

/** Map semantic modifier prefixes to platform-specific symbols */
function formatKeys(text: string): string {
  return text
    .replace(/Cmd\+/g, modSymbol)
    .replace(/Ctrl\+/g, modSymbol)
    .replace(/Alt\+/g, altSymbol)
    .replace(/Shift\+/g, shiftSymbol);
}

function formatChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') return formatKeys(children);
  return children;
}

export default function Kbd({ children, size = 'xs' }: { children: React.ReactNode; size?: KbdSize }) {
  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-1 py-0.5 text-[10px]';
  return (
    <kbd className={`${sizeClass} bg-surface-alt border border-border-input rounded text-secondary`}>
      {formatChildren(children)}
    </kbd>
  );
}
