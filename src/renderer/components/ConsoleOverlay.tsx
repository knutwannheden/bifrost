import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useOverlayFocus } from '../hooks/useOverlayFocus';
import { altSymbol } from '../utils/platform';
import OverlayFooter from './OverlayFooter';
import OverlayHeader from './OverlayHeader';
import Spinner from './Spinner';
import TerminalPane from './TerminalPane';

export default function ConsoleOverlay() {
  const { dispatch } = useApp();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => dispatch({ type: 'CLOSE_CONSOLE' }), [dispatch]);

  // The session runs whether or not this overlay is open, so opening it is a
  // matter of finding out what to attach to.
  useEffect(() => {
    let cancelled = false;
    window.bifrost
      .consoleSession()
      .then((id) => {
        if (!cancelled) setSessionId(id);
      })
      .catch(() => {
        if (!cancelled) setSessionId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reset = useCallback(() => {
    setSessionId(null);
    window.bifrost.resetConsole().then(setSessionId);
  }, []);

  useOverlayFocus(overlayRef);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.altKey && e.code === 'KeyR') {
      e.preventDefault();
      reset();
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
        <OverlayHeader title="Console" onClose={close} />

        <div className="flex-1 min-h-0 p-2">
          {sessionId ? (
            <TerminalPane sessionId={sessionId} active focused />
          ) : (
            <div className="flex items-center justify-center gap-2 py-4 text-secondary">
              <Spinner />
              <span className="text-sm">Starting console...</span>
            </div>
          )}
        </div>

        <OverlayFooter>
          <span className="text-xs text-faint">
            {altSymbol}R start over &middot; Esc close &middot; addressable as &ldquo;bifrost&rdquo;
          </span>
        </OverlayFooter>
      </div>
    </div>
  );
}
