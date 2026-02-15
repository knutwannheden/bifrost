import React, { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';

export default function SettingsOverlay() {
  const { state, dispatch } = useApp();
  const overlayRef = useRef<HTMLDivElement>(null);
  const config = state.config;

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  const close = () => dispatch({ type: 'TOGGLE_SETTINGS' });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const updateConfig = async (updates: Partial<typeof config>) => {
    if (!config) return;
    const newConfig = { ...config, ...updates };
    await window.bifrost.saveConfig(newConfig);
    dispatch({ type: 'SET_CONFIG', config: newConfig });
  };

  if (!config) return null;

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 focus:outline-none"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[400px] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">Settings</h2>
          <button
            onClick={close}
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* IDE */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-slate-300">IDE</label>
            <div className="flex gap-1">
              {(['code', 'idea'] as const).map((ide) => (
                <button
                  key={ide}
                  onClick={() => updateConfig({ ide })}
                  className={`px-3 py-1 text-xs rounded ${
                    config.ide === ide
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {ide === 'code' ? 'VS Code' : 'IntelliJ'}
                </button>
              ))}
            </div>
          </div>

          {/* Font Size */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-slate-300">Font Size</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => updateConfig({ fontSize: Math.max(8, config.fontSize - 1) })}
                className="w-7 h-7 flex items-center justify-center rounded bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm"
              >
                -
              </button>
              <span className="text-sm text-slate-200 w-6 text-center font-mono">{config.fontSize}</span>
              <button
                onClick={() => updateConfig({ fontSize: Math.min(32, config.fontSize + 1) })}
                className="w-7 h-7 flex items-center justify-center rounded bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm"
              >
                +
              </button>
            </div>
          </div>

          {/* Sandbox */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-slate-300">Sandbox Mode</label>
              <p className="text-xs text-slate-500">Enable sandbox for new Claude sessions</p>
            </div>
            <button
              onClick={() => updateConfig({ sandbox: !config.sandbox })}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                config.sandbox ? 'bg-blue-600' : 'bg-slate-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  config.sandbox ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>

          {/* Group history by repo */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-slate-300">Group history by repo</label>
              <p className="text-xs text-slate-500">Group tasks by repository in history view</p>
            </div>
            <button
              onClick={() => updateConfig({ groupHistoryByRepo: !config.groupHistoryByRepo })}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                config.groupHistoryByRepo ? 'bg-blue-600' : 'bg-slate-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  config.groupHistoryByRepo ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>

          {/* Hide terminal on switch */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-slate-300">Hide terminal on switch</label>
              <p className="text-xs text-slate-500">&#8984;/ hides dev terminal when switching to Claude</p>
            </div>
            <button
              onClick={() => updateConfig({ hideTerminalOnSwitch: !config.hideTerminalOnSwitch })}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                config.hideTerminalOnSwitch ? 'bg-blue-600' : 'bg-slate-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  config.hideTerminalOnSwitch ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
