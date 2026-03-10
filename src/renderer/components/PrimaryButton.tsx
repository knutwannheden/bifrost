import React from 'react';

const SIZE = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent',
};

export default function PrimaryButton({
  size = 'md',
  className = '',
  ...props
}: { size?: 'sm' | 'md' } & React.ButtonHTMLAttributes<HTMLButtonElement> & { ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      className={`${SIZE[size]} bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors ${className}`}
      {...props}
    />
  );
}
