import React from 'react';

const BASE =
  'bg-surface-alt border border-border-input rounded-sm text-sm text-primary placeholder-muted focus:outline-hidden focus:border-accent focus:ring-1 focus:ring-accent';

export default function FormInput({
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return <input className={`${BASE} ${className}`} {...props} />;
}
