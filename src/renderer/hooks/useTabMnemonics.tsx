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
  value: T,
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
    // Alt+letter: jump to specific tab
    if (e.altKey) {
      for (const tab of tabs) {
        const char = tab.label[tab.hintIndex ?? 0]?.toUpperCase();
        if (char && e.code === `Key${char}`) {
          e.preventDefault();
          onChange(tab.value);
          return true;
        }
      }
    }

    // Ctrl+Left/Right: cycle tabs
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.value === value);
      const step = e.key === 'ArrowRight' ? 1 : tabs.length - 1;
      onChange(tabs[(idx + step) % tabs.length].value);
      return true;
    }

    return false;
  };

  return { options, handleTabKey };
}
