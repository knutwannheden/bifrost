import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useOverlayFocus } from '../hooks/useOverlayFocus';
import { altSymbol } from '../utils/platform';
import OverlayFooter from './OverlayFooter';
import OverlayHeader from './OverlayHeader';
import Spinner from './Spinner';
import TerminalPane from './TerminalPane';

/**
 * Claude's own login, run on a machine and shown here as a terminal, so its
 * link opens here and its code is pasted back into it.
 */
export default function MachineLoginOverlay({ machine }: { machine: string }) {
  const { dispatch } = useApp();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => dispatch({ type: 'CLOSE_MACHINE_LOGIN' }), [dispatch]);

  const start = useCallback(() => {
    setSessionId(null);
    setStatus(null);
    window.bifrost.startMachineLogin(machine).then(setSessionId, (err: Error) => setStatus(err.message));
  }, [machine]);

  useEffect(() => {
    start();
  }, [start]);

  // The login is over when Claude's login command exits, whether it worked or not.
  useEffect(() => {
    if (!sessionId) return;
    return window.bifrost.onSessionExit((id) => {
      if (id !== sessionId) return;
      setStatus('Checking the login...');
      window.bifrost.checkMachineLogin(machine).then(
        (loggedIn) => {
          if (!loggedIn) {
            setStatus(`Claude on ${machine} is still not logged in.`);
            return;
          }
          dispatch({ type: 'SHOW_TOAST', message: `Logged in on ${machine}`, duration: 4000 });
          close();
        },
        (err: Error) => setStatus(err.message),
      );
    });
  }, [sessionId, machine, dispatch, close]);

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
      start();
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
        className="absolute inset-x-16 inset-y-24 flex flex-col bg-surface rounded-lg border border-border-input shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <OverlayHeader title={`Log in to Claude on ${machine}`} onClose={close} />

        <div className="flex-1 min-h-0 p-2">
          {status ? (
            <div className="text-sm text-muted text-center py-4">{status}</div>
          ) : sessionId ? (
            <TerminalPane key={sessionId} sessionId={sessionId} active focused />
          ) : (
            <div className="flex items-center justify-center gap-2 py-4 text-secondary">
              <Spinner />
              <span className="text-sm">Starting the login...</span>
            </div>
          )}
        </div>

        <OverlayFooter>
          <span className="text-xs text-faint">
            Open the link, sign in, then paste the code here &middot; {altSymbol}R start over &middot; Esc close
          </span>
        </OverlayFooter>
      </div>
    </div>
  );
}
