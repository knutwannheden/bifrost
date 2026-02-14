import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

interface TerminalOptions {
  cursorBlink?: boolean;
  hideCursor?: boolean;
}

export function useTerminal(
  sessionId: string | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  onTitleChange?: (title: string) => void,
  options?: TerminalOptions,
) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  useEffect(() => {
    if (!sessionId || !containerRef.current) return;

    const hideCursor = options?.hideCursor ?? false;
    const terminal = new Terminal({
      cursorBlink: hideCursor ? false : (options?.cursorBlink ?? true),
      cursorStyle: hideCursor ? 'bar' : 'block',
      cursorWidth: hideCursor ? 1 : undefined,
      cursorInactiveStyle: hideCursor ? 'none' : 'outline',
      fontSize: 14,
      fontFamily: '"MesloLGS NF", "MesloLGM Nerd Font", "JetBrainsMono Nerd Font", "FiraCode Nerd Font", "Hack Nerd Font", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: hideCursor ? '#0f172a' : '#e2e8f0',
        selectionBackground: '#334155',
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);

    // Initial fit
    try {
      fitAddon.fit();
    } catch {
      // container may not be visible yet
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Send keystrokes to session
    terminal.onData((data) => {
      window.bifrost.writeToSession(sessionId, data);
    });

    // Listen for terminal title changes (OSC 0/2)
    terminal.onTitleChange((title) => {
      onTitleChangeRef.current?.(title);
    });

    // Receive data from session
    const removeDataListener = window.bifrost.onSessionData(
      (sid: string, data: string) => {
        if (sid === sessionId) {
          terminal.write(data);
        }
      },
    );

    // Handle session exit
    const removeExitListener = window.bifrost.onSessionExit(
      (sid: string, _code: number) => {
        if (sid === sessionId) {
          terminal.write('\r\n[Session ended]\r\n');
        }
      },
    );

    // ResizeObserver for auto-fit
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        window.bifrost.resizeSession(sessionId, terminal.cols, terminal.rows);
      } catch {
        // ignore resize errors
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      removeDataListener();
      removeExitListener();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, containerRef]);

  return { terminal: terminalRef, fitAddon: fitAddonRef };
}
