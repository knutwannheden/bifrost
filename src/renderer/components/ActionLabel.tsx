import React from 'react';

interface ActionLabelProps {
  text: string;
  hintIndex?: number;
  showHint: boolean;
}

export default function ActionLabel({ text, hintIndex = 0, showHint }: ActionLabelProps) {
  if (!showHint) return <>{text}</>;
  return (
    <>
      {text.slice(0, hintIndex)}
      <span className="underline underline-offset-2">{text[hintIndex]}</span>
      {text.slice(hintIndex + 1)}
    </>
  );
}
