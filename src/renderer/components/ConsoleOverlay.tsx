import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useOverlayFocus } from '../hooks/useOverlayFocus';
import { altSymbol } from '../utils/platform';
import CloseButton from './CloseButton';
import OverlayFooter from './OverlayFooter';
import OverlayHeader from './OverlayHeader';
import Spinner from './Spinner';
import TerminalPane from './TerminalPane';

export default function ConsoleOverlay() {
  const { state, dispatch } = useApp();
  const machine = state.consoleMachine;
  // This machine's console, then one for each machine that runs its own instance.
  const consoles = ['', ...(state.config?.machines ?? []).filter((m) => m.instance).map((m) => m.name)];
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => dispatch({ type: 'CLOSE_CONSOLE' }), [dispatch]);
  const select = useCallback((m: string) => dispatch({ type: 'SELECT_CONSOLE', machine: m }), [dispatch]);

  const show = useCallback((pending: Promise<string>, isCurrent: () => boolean) => {
    setSessionId(null);
    setFailure(null);
    pending.then(
      (id) => isCurrent() && setSessionId(id),
      (err: Error) => isCurrent() && setFailure(err.message),
    );
  }, []);

  // The session runs whether or not this overlay is open, so opening it is a
  // matter of finding out what to attach to.
  useEffect(() => {
    let current = true;
    show(window.bifrost.consoleSession(machine || undefined), () => current);
    return () => {
      current = false;
    };
  }, [machine, show]);

  const reset = useCallback(() => {
    show(window.bifrost.resetConsole(machine || undefined), () => true);
  }, [machine, show]);

  useOverlayFocus(overlayRef);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (!e.altKey) return;
    if (e.code === 'KeyR') {
      e.preventDefault();
      reset();
      return;
    }
    const picked = consoles[Number(e.code.replace('Digit', '')) - 1];
    if (e.code.startsWith('Digit') && picked !== undefined) {
      e.preventDefault();
      select(picked);
    }
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="absolute inset-0 z-20 bg-overlay focus:outline-hidden"
      onClick={close}
    >
      <div
        className="absolute inset-8 flex flex-col bg-surface rounded-lg border border-border-input shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {consoles.length > 1 ? (
          <div className="flex items-center justify-between px-4 border-b border-border-default">
            <div className="flex items-center gap-5">
              {consoles.map((m) => (
                <button
                  key={m || 'here'}
                  type="button"
                  onClick={() => select(m)}
                  className={`relative py-3 text-sm font-semibold border-b-2 transition-colors ${
                    m === machine
                      ? 'text-primary border-accent'
                      : 'text-secondary border-transparent hover:text-primary'
                  }`}
                >
                  {m || 'This Mac'}
                  {state.consoleUnread.includes(m) && (
                    <span className="absolute top-2.5 -right-2 w-1.5 h-1.5 rounded-full bg-accent" />
                  )}
                </button>
              ))}
            </div>
            <CloseButton onClick={close} />
          </div>
        ) : (
          <OverlayHeader title="Console" onClose={close} />
        )}

        <div className="flex-1 min-h-0 p-2">
          {sessionId ? (
            <TerminalPane key={sessionId} sessionId={sessionId} active focused />
          ) : failure ? (
            <div className="text-sm text-muted text-center py-4">{failure}</div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-4 text-secondary">
              <Spinner />
              <span className="text-sm">Starting console...</span>
            </div>
          )}
        </div>

        <OverlayFooter>
          <span className="text-xs text-faint">
            {consoles.length > 1 && (
              <>
                {altSymbol}1–{consoles.length} switch console &middot;{' '}
              </>
            )}
            {altSymbol}R start over &middot; Esc close &middot; addressable as &ldquo;bifrost&rdquo;
          </span>
        </OverlayFooter>
      </div>
    </div>
  );
}
