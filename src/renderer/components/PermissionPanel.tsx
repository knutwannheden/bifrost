import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import type { PermissionDecision } from '../../shared/types';

type Scope = 'local' | 'project' | 'user';

export default function PermissionPanel() {
  const { state, dispatch } = useApp();
  const request = state.permissionQueue[0];
  const panelRef = useRef<HTMLDivElement>(null);

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

  const handleDenyOnce = useCallback(() => {
    if (!request) return;
    window.bifrost.resolvePermission(request.requestId, { action: 'deny', persist: false });
    dispatch({ type: 'SHIFT_PERMISSION' });
  }, [request, dispatch]);

  // Keyboard shortcuts — only active when the panel has focus.
  // The user clicks the panel (or any button in it) to engage.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!request) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        handleDenyOnce();
        break;
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
  }, [request, handleDecision, handleDenyOnce]);

  // Focus the panel container when the user clicks anywhere inside it,
  // so keyboard shortcuts activate without needing to click a specific spot.
  const handleClick = useCallback(() => {
    panelRef.current?.focus();
  }, []);

  if (!request) return null;

  const queueCount = state.permissionQueue.length;

  // Format tool input for display
  const inputSummary = request.toolName === 'Bash'
    ? (request.toolInput.command as string) || ''
    : JSON.stringify(request.toolInput, null, 2).slice(0, 200);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-permission-panel
      className="fixed bottom-14 right-4 z-40 w-96 bg-surface border border-border-input rounded-lg shadow-2xl focus:outline-none focus:ring-1 focus:ring-accent-muted"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-default">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          <span className="text-xs font-semibold text-secondary">
            Permission Request
          </span>
          <span className="text-xs text-faint">Tab to focus</span>
        </div>
        <div className="flex items-center gap-2">
          {queueCount > 1 && (
            <span className="text-xs text-muted">+{queueCount - 1} more</span>
          )}
          <span className="text-xs text-muted">{request.taskName}</span>
        </div>
      </div>

      {/* Tool info */}
      <div className="px-3 py-2 border-b border-border-default">
        <div className="text-sm font-medium text-primary">{request.toolName}</div>
        <pre className="mt-1 text-xs text-secondary font-mono whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
          {inputSummary}
        </pre>
      </div>

      {/* Rule options */}
      {persist && (
        <div className="px-3 py-2 border-b border-border-default">
          <div className="text-xs text-secondary mb-1">
            Rule pattern <span className="text-muted">(Tab to cycle)</span>
          </div>
          <div className="space-y-1">
            {request.ruleOptions.map((opt, i) => (
              <button
                key={opt.pattern}
                onClick={() => setSelectedRule(i)}
                className={`w-full text-left px-2 py-1 rounded text-xs ${
                  i === selectedRule
                    ? 'bg-accent/30 text-accent-hover border border-accent-muted'
                    : 'text-secondary hover:bg-surface-alt'
                }`}
              >
                <span>{opt.label}</span>
                <span className="ml-2 font-mono text-muted">{opt.pattern}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scope selector & persist toggle */}
      <div className="px-3 py-2 border-b border-border-default flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-secondary">
          <input
            type="checkbox"
            checked={persist}
            onChange={(e) => setPersist(e.target.checked)}
            className="rounded border-border-input bg-surface-alt text-accent"
          />
          <span>Remember <span className="text-muted">(P)</span></span>
        </label>

        {persist && (
          <div className="flex gap-1 ml-auto">
            {(['local', 'project', 'user'] as Scope[]).map((s, i) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2 py-0.5 rounded text-xs ${
                  scope === s
                    ? 'bg-accent text-white'
                    : 'bg-surface-alt text-secondary hover:bg-surface-hover'
                }`}
              >
                {s} <span className="text-muted">{i + 1}</span>
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
