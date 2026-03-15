import React from 'react';

const BASE =
  'bg-surface-alt border border-border-input rounded-sm text-sm text-primary focus:outline-hidden focus:border-accent focus:ring-1 focus:ring-accent';

export default function FormSelect({
  className = '',
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { ref?: React.Ref<HTMLSelectElement> }) {
  return <select className={`${BASE} ${className}`} {...props} />;
}
