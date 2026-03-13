import React from 'react';

const BASE =
  'bg-surface-alt border border-border-input rounded-sm text-sm text-primary placeholder-muted focus:outline-hidden focus:border-accent focus:ring-1 focus:ring-accent';

export default function FormTextarea({
  className = '',
  onKeyDown,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Option+Enter inserts a newline (like Shift+Enter), consistent with xterm.js
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\n');
      return;
    }
    onKeyDown?.(e);
  };

  return <textarea className={`${BASE} ${className}`} onKeyDown={handleKeyDown} {...props} />;
}
