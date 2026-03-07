import React from 'react';

type KbdSize = 'sm' | 'xs';

export default function Kbd({ children, size = 'xs' }: { children: React.ReactNode; size?: KbdSize }) {
  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-1 py-0.5 text-[10px]';
  return (
    <kbd className={`${sizeClass} font-mono bg-slate-700 border border-slate-600 rounded text-slate-400`}>
      {children}
    </kbd>
  );
}
