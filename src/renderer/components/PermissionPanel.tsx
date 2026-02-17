import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import type { PermissionDecision } from '../../shared/types';

type Scope = 'local' | 'project' | 'user';

export default function PermissionPanel() {
  const { state, dispatch } = useApp();
  const request = state.permissionQueue[0];

  const [selectedRule, setSelectedRule] = useState(0);
  const [scope, setScope] = useState<Scope>('local');
  const [persist, setPersist] = useState(true);

  // Reset selection when request changes
  useEffect(() => {
    setSelectedRule(0);
    setScope('local');
    setPersist(true);
  }, [request?.requestId]);

  const handleDecision = useCallback((action: 'allow' | 'deny') => {
    if (!request) return;

    const decision: PermissionDecision = {
      action,
      persist,
      scope: persist ? scope : undefined,
      rulePattern: persist ? request.ruleOptions[selectedRule]?.pattern : undefined,
    };

    window.bifrost.resolvePermission(request.requestId, decision);
    dispatch({ type: 'SHIFT_PERMISSION' });
  }, [request, persist, scope, selectedRule, dispatch]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!request) return;

    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input or terminal
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.target as HTMLElement)?.closest('.xterm')) return;

      switch (e.key) {
        case 'a':
        case 'A':
          e.preventDefault();
          handleDecision('allow');
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          handleDecision('deny');
          break;
        case '1':
          e.preventDefault();
          setScope('local');
          break;
        case '2':
          e.preventDefault();
          setScope('project');
          break;
        case '3':
          e.preventDefault();
          setScope('user');
          break;
        case 'Tab':
          e.preventDefault();
          setSelectedRule((prev) => (prev + 1) % request.ruleOptions.length);
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          setPersist((prev) => !prev);
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [request, handleDecision]);

  if (!request) return null;

  const queueCount = state.permissionQueue.length;

  // Format tool input for display
  const inputSummary = request.toolName === 'Bash'
    ? (request.toolInput.command as string) || ''
    : JSON.stringify(request.toolInput, null, 2).slice(0, 200);

  return (
    <div className="fixed bottom-14 right-4 z-40 w-96 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-xs font-semibold text-slate-300">
            Permission Request
          </span>
        </div>
        <div className="flex items-center gap-2">
          {queueCount > 1 && (
            <span className="text-xs text-slate-500">+{queueCount - 1} more</span>
          )}
          <span className="text-xs text-slate-500">{request.taskName}</span>
        </div>
      </div>

      {/* Tool info */}
      <div className="px-3 py-2 border-b border-slate-700">
        <div className="text-sm font-medium text-slate-200">{request.toolName}</div>
        <pre className="mt-1 text-xs text-slate-400 font-mono whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
          {inputSummary}
        </pre>
      </div>

      {/* Rule options */}
      {persist && (
        <div className="px-3 py-2 border-b border-slate-700">
          <div className="text-xs text-slate-400 mb-1">
            Rule pattern <span className="text-slate-500">(Tab to cycle)</span>
          </div>
          <div className="space-y-1">
            {request.ruleOptions.map((opt, i) => (
              <button
                key={opt.pattern}
                onClick={() => setSelectedRule(i)}
                className={`w-full text-left px-2 py-1 rounded text-xs ${
                  i === selectedRule
                    ? 'bg-blue-600/30 text-blue-300 border border-blue-500/50'
                    : 'text-slate-400 hover:bg-slate-700'
                }`}
              >
                <span>{opt.label}</span>
                <span className="ml-2 font-mono text-slate-500">{opt.pattern}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scope selector & persist toggle */}
      <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={persist}
            onChange={(e) => setPersist(e.target.checked)}
            className="rounded border-slate-600 bg-slate-700 text-blue-500"
          />
          <span>Remember <span className="text-slate-500">(P)</span></span>
        </label>

        {persist && (
          <div className="flex gap-1 ml-auto">
            {(['local', 'project', 'user'] as Scope[]).map((s, i) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2 py-0.5 rounded text-xs ${
                  scope === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                }`}
              >
                {s} <span className="text-slate-500">{i + 1}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="px-3 py-2 flex gap-2">
        <button
          onClick={() => handleDecision('allow')}
          className="flex-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded"
        >
          Allow <span className="text-green-200 text-xs">(A)</span>
        </button>
        <button
          onClick={() => handleDecision('deny')}
          className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded"
        >
          Deny <span className="text-red-200 text-xs">(D)</span>
        </button>
      </div>
    </div>
  );
}
