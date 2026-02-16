import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
// import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

// Global registry so keyboard shortcuts can access terminal instances
export const terminalRegistry = new Map<string, Terminal>();
export const searchAddonRegistry = new Map<string, SearchAddon>();

interface TerminalOptions {
  cursorBlink?: boolean;
  hideCursor?: boolean;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  visible?: boolean;
  onBell?: () => void;
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
  const onBellRef = useRef(options?.onBell);
  onBellRef.current = options?.onBell;

  useEffect(() => {
    if (!sessionId || !containerRef.current) return;

    const hideCursor = options?.hideCursor ?? false;
    const bg = '#282a36';
    const cursorConfig = hideCursor
      ? { cursorBlink: false, cursorStyle: 'bar' as const, cursorWidth: 1, cursorInactiveStyle: 'none' as const }
      : { cursorBlink: options?.cursorBlink ?? true, cursorStyle: 'block' as const, cursorInactiveStyle: 'outline' as const };

    const terminal = new Terminal({
      ...cursorConfig,
      fontWeight: options?.fontWeight ?? 300,
      fontSize: options?.fontSize ?? 14,
      fontFamily: `"${options?.fontFamily ?? 'MesloLGS NF'}", Menlo, Monaco, "Courier New", monospace`,
      linkHandler: {
        activate: (_event, uri) => {
          window.bifrost.openUrl(uri);
        },
      },
      theme: {
        background: bg,
        foreground: '#f8f8f2',
        cursor: hideCursor ? bg : '#f8f8f2',
        selectionBackground: '#44475a',
        selectionForeground: '#f8f8f2',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_e, uri) => {
      window.bifrost.openUrl(uri);
    });

    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(containerRef.current);

    // Use WebGL renderer for better performance with multiple terminals
    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available, fall back to default canvas renderer
    }

    // Initial fit — also resize PTY immediately so output produced before
    // the buffer drain uses correct dimensions instead of the default 120×30.
    try {
      fitAddon.fit();
      window.bifrost.resizeSession(sessionId, terminal.cols, terminal.rows);
    } catch {
      // container may not be visible yet
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminalRegistry.set(sessionId, terminal);
    searchAddonRegistry.set(sessionId, searchAddon);

    // Let the app handle these Cmd+key shortcuts instead of xterm
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.metaKey && !e.shiftKey) {
        const key = e.key.toLowerCase();
        if ('atdrhko,lgf'.includes(key)) return false;
      }
      if (e.metaKey && e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'w' || key === 'c') return false;
      }
      // Let Alt+U through for review mode toggle
      if (e.altKey && !e.metaKey && e.code === 'KeyU') return false;
      return true;
    });

    // Send keystrokes to session
    terminal.onData((data) => {
      window.bifrost.writeToSession(sessionId, data);
    });

    // Listen for terminal title changes (OSC 0/2)
    terminal.onTitleChange((title) => {
      onTitleChangeRef.current?.(title);
    });

    // Suppress bell/OSC notifications during initial buffer drain
    let drainComplete = false;

    // Listen for terminal bell (BEL) — used for instant idle notifications
    terminal.onBell(() => {
      if (drainComplete) onBellRef.current?.();
    });

    // Listen for OSC 9 (iTerm2) and OSC 777 (rxvt) desktop notifications
    // Claude Code uses one of these for idle notifications
    terminal.parser.registerOscHandler(9, () => {
      if (drainComplete) onBellRef.current?.();
      return true;
    });
    terminal.parser.registerOscHandler(777, () => {
      if (drainComplete) onBellRef.current?.();
      return true;
    });

    // Replay any buffered output from before this listener was registered,
    // then force a resize to trigger SIGWINCH so Claude Code redraws its
    // TUI with the correct dimensions (buffer was generated at default 120×30).
    window.bifrost.drainSessionBuffer(sessionId).then((buf) => {
      if (buf) {
        terminal.write(buf, () => {
          drainComplete = true;
          try {
            fitAddon.fit();
            window.bifrost.resizeSession(sessionId, terminal.cols, terminal.rows);
          } catch { /* container may not be visible */ }
        });
      } else {
        drainComplete = true;
      }
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
      (sid: string) => {
        if (sid === sessionId) {
          terminal.write('\r\n[Session ended]\r\n');
        }
      },
    );

    // ResizeObserver for auto-fit
    // Skip when container has zero dimensions (pane hidden via display:none)
    // to avoid truncating xterm scrollback buffer.
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      try {
        fitAddon.fit();
        // Resize all PTYs (including background tabs) so they stay in sync
        // when the window is resized. Prevents garbled output from stale dimensions.
        window.bifrost.resizeAllSessions(terminal.cols, terminal.rows);
      } catch {
        // ignore resize errors
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      removeDataListener();
      removeExitListener();
      searchAddonRegistry.delete(sessionId);
      terminalRegistry.delete(sessionId);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, containerRef]);

  // Update fontSize dynamically when config changes
  const fontSize = options?.fontSize ?? 14;
  useEffect(() => {
    if (terminalRef.current && fitAddonRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      try {
        fitAddonRef.current.fit();
      } catch {
        // ignore fit errors
      }
    }
  }, [fontSize]);

  // Update fontWeight dynamically when config changes
  const fontWeight = options?.fontWeight ?? 300;
  useEffect(() => {
    if (terminalRef.current && fitAddonRef.current) {
      terminalRef.current.options.fontWeight = fontWeight;
      try {
        fitAddonRef.current.fit();
      } catch {
        // ignore fit errors
      }
    }
  }, [fontWeight]);

  // Update fontFamily dynamically when config changes
  const fontFamily = options?.fontFamily ?? 'MesloLGS NF';
  useEffect(() => {
    if (terminalRef.current && fitAddonRef.current) {
      terminalRef.current.options.fontFamily = `"${fontFamily}", Menlo, Monaco, "Courier New", monospace`;
      try {
        fitAddonRef.current.fit();
      } catch {
        // ignore fit errors
      }
    }
  }, [fontFamily]);

  // Re-fit when pane becomes visible (e.g. switching tabs) so the PTY
  // column count stays in sync with xterm after background data writes.
  const visible = options?.visible ?? true;
  useEffect(() => {
    if (visible && sessionId && terminalRef.current && fitAddonRef.current) {
      try {
        fitAddonRef.current.fit();
        window.bifrost.resizeSession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
      } catch {
        // ignore fit errors
      }
    }
  }, [visible, sessionId]);

  return { terminal: terminalRef, fitAddon: fitAddonRef };
}
