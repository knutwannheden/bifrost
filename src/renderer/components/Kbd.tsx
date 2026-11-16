import React from 'react';
import { isMac } from '../utils/platform';

type KbdSize = 'sm' | 'xs';

/** Map the keymap's modifier names to what this platform's user presses */
function formatKeys(text: string): string {
  if (!isMac) return text.replace(/Cmd\+Shift\+/g, 'Ctrl+Alt+Shift+').replace(/Cmd\+/g, 'Ctrl+Shift+');
  return text
    .replace(/(Cmd|Ctrl)\+/g, '⌘')
    .replace(/Alt\+/g, '⌥')
    .replace(/Shift\+/g, '⇧');
}

function formatChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') return formatKeys(children);
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
