interface ActionLabelProps {
  text: string;
  hintIndex?: number;
  showHint: boolean;
}

export default function ActionLabel({ text, hintIndex = 0, showHint }: ActionLabelProps) {
  if (!showHint) return <>{text}</>;
  const before = text.slice(0, hintIndex);
  const char = text[hintIndex];
  const after = text.slice(hintIndex + 1);
  return (
    <span>
      {before}
      <span className="underline underline-offset-2">{char}</span>
      {after}
    </span>
  );
}
