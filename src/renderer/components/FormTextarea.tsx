import React from 'react';

const BASE =
  'bg-surface-alt border border-border-input rounded text-sm text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent';

export default function FormTextarea({
  className = '',
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) {
  return <textarea className={`${BASE} ${className}`} {...props} />;
}
