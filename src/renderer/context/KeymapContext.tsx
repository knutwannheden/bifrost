import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { getBindingDisplay, getInterceptedKeys, type KeyBinding, resolveKeymap } from '../../shared/keymap';
import type { BifrostConfig } from '../../shared/types';
import { interceptedKeysRef } from '../hooks/useTerminal';

interface KeymapContextValue {
  keymap: KeyBinding[];
  getBindingForAction(actionId: string): KeyBinding | undefined;
  getDisplayString(actionId: string): string | undefined;
}

const KeymapContext = createContext<KeymapContextValue>({
  keymap: [],
  getBindingForAction: () => undefined,
  getDisplayString: () => undefined,
});

export function KeymapProvider({ config, children }: { config: BifrostConfig | null; children: React.ReactNode }) {
  const value = useMemo<KeymapContextValue>(() => {
    const keymap = resolveKeymap(config?.keybindings);

    const byAction = new Map<string, KeyBinding>();
    for (const binding of keymap) {
      if (!byAction.has(binding.actionId)) {
        byAction.set(binding.actionId, binding);
      }
    }

    return {
      keymap,
      getBindingForAction: (actionId: string) => byAction.get(actionId),
      getDisplayString: (actionId: string) => {
        const binding = byAction.get(actionId);
        return binding ? getBindingDisplay(binding) : undefined;
      },
    };
  }, [config?.keybindings]);

  // Keep the module-level ref in sync so terminal key handlers always read current bindings
  const intercepted = useMemo(() => getInterceptedKeys(value.keymap), [value.keymap]);
  useEffect(() => {
    interceptedKeysRef.current = intercepted;
  }, [intercepted]);

  return <KeymapContext.Provider value={value}>{children}</KeymapContext.Provider>;
}

export function useKeymap() {
  return useContext(KeymapContext);
}
