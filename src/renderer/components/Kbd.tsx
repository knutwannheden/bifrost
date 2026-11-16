import React from 'react';
import { shortcutLabel } from '../utils/platform';

type KbdSize = 'sm' | 'xs';

function formatChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') return shortcutLabel(children);
  return children;
}

export default function Kbd({ children, size = 'xs' }: { children: React.ReactNode; size?: KbdSize }) {
  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-1 py-0.5 text-[10px]';
  return (
    <kbd className={`${sizeClass} bg-surface-alt border border-border-input rounded-sm text-secondary`}>
      {formatChildren(children)}
    </kbd>
  );
}
