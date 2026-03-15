import type React from 'react';
import ActionLabel from '../components/ActionLabel';
import type { PillOption } from '../components/PillToggle';

export interface TabDef<T extends string> {
  value: T;
  label: string;
  hintIndex?: number;
  suffix?: React.ReactNode;
}

export function useTabMnemonics<T extends string>(
  tabs: readonly TabDef<T>[],
  onChange: (value: T) => void,
): {
  options: PillOption<T>[];
  handleTabKey: (e: React.KeyboardEvent) => boolean;
} {
  const options: PillOption<T>[] = tabs.map((tab) => ({
    value: tab.value,
    label: (
      <>
        <ActionLabel text={tab.label} hintIndex={tab.hintIndex} showHint={true} />
        {tab.suffix}
      </>
    ),
  }));

  const handleTabKey = (e: React.KeyboardEvent): boolean => {
    if (!e.altKey) return false;
    for (const tab of tabs) {
      const char = tab.label[tab.hintIndex ?? 0]?.toUpperCase();
      if (char && e.code === `Key${char}`) {
        e.preventDefault();
        onChange(tab.value);
        return true;
      }
    }
    return false;
  };

  return { options, handleTabKey };
}
