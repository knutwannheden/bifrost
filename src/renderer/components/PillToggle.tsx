import React from 'react';

export interface PillOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

interface PillToggleProps<T extends string> {
  options: PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}

const sizeClasses = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1 text-xs',
} as const;

export default function PillToggle<T extends string>({ options, value, onChange, size = 'sm' }: PillToggleProps<T>) {
  const sizeClass = sizeClasses[size];

  return (
    <div className="flex gap-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          tabIndex={-1}
          onClick={() => onChange(opt.value)}
          className={`${sizeClass} rounded inline-flex items-center gap-1.5 transition-colors ${
            value === opt.value
              ? 'bg-surface-hover text-primary'
              : 'text-secondary hover:text-primary hover:bg-surface-alt'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
