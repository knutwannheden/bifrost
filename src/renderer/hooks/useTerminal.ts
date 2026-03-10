import { FitAddon } from '@xterm/addon-fit';
// import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { resolveTerminalTheme } from '../terminal-themes';
import { isMac, isModKey } from '../utils/platform';

// Global registry so keyboard shortcuts can access terminal instances
export const terminalRegistry = new Map<string, Terminal>();
export const searchAddonRegistry = new Map<string, SearchAddon>();

interface TerminalOptions {
  cursorBlink?: boolean;
  hideCursor?: boolean;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  terminalTheme?: string;
  isDark?: boolean;
  visible?: boolean;
  paneType?: 'claude' | 'dev';
}

export function useTerminal(
  sessionId: string | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  onTitleChange?: (title: string) => void,
  options?: TerminalOptions,
) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [loading, setLoading] = useState(true);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  useEffect(() => {
    if (!sessionId || !containerRef.current) return;
    setLoading(true);

    const paneType = options?.paneType;
    const hideCursor = options?.hideCursor ?? false;
    const selectedTheme = resolveTerminalTheme(options?.terminalTheme ?? 'Auto', options?.isDark ?? true);
    const cursorConfig = hideCursor
      ? { cursorBlink: false, cursorStyle: 'bar' as const, cursorWidth: 1, cursorInactiveStyle: 'none' as const }
      : {
          cursorBlink: options?.cursorBlink ?? true,
          cursorStyle: 'block' as const,
          cursorInactiveStyle: 'outline-solid' as const,
        };

    const terminal = new Terminal({
      ...cursorConfig,
      fontWeight: options?.fontWeight ?? 300,
      fontSize: options?.fontSize ?? 14,
      fontFamily: `"${options?.fontFamily ?? 'MesloLGS NF'}", Menlo, Monaco, "Courier New", monospace`,
      linkHandler: {
        activate: (_event, uri) => {
          window.bifrost.openUrl(uri);
        },
        allowNonHttpProtocols: true,
      },
      theme: {
        ...selectedTheme,
        cursor: hideCursor ? selectedTheme.background : selectedTheme.cursor,
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

    // Use WebGL renderer for better performance with multiple terminals.
    // On context loss (e.g. system sleep), dispose and re-create the addon
    // so xterm falls back to canvas temporarily then recovers.
    const loadWebgl = () => {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          // Re-attempt WebGL after a short delay (GPU may be available again)
          setTimeout(loadWebgl, 1000);
        });
        terminal.loadAddon(webgl);
      } catch {
        // WebGL not available, fall back to default canvas renderer
      }
    };
    loadWebgl();

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
      // Tab: focus the permission panel when one is visible
      if (e.key === 'Tab' && e.type === 'keydown' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const panel = document.querySelector<HTMLElement>('[data-permission-panel]');
        if (panel) {
          e.preventDefault();
          panel.focus();
          return false;
        }
      }
      // Cmd+Left/Right/Backspace: emulate macOS terminal behavior
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Backspace') {
          if (e.type === 'keydown') {
            const seq =
              e.key === 'ArrowLeft'
                ? '\x1bOH' // Home
                : e.key === 'ArrowRight'
                  ? '\x1bOF' // End
                  : '\x15'; // Ctrl+U (kill line)
            window.bifrost.writeToSession(sessionId!, seq);
          }
          return false;
        }
      }
      // Option+Left/Right: word navigation (ESC b / ESC f)
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          if (e.type === 'keydown') {
            const seq = e.key === 'ArrowLeft' ? '\x1bb' : '\x1bf';
            window.bifrost.writeToSession(sessionId!, seq);
          }
          return false;
        }
      }
      if (isModKey(e) && !e.shiftKey) {
        const key = e.key.toLowerCase();
        // On Linux, let readline shortcuts (Ctrl+A/D/R/H/K/L) pass through
        // to the dev terminal instead of intercepting them for app shortcuts.
        // Users can Ctrl+/ to switch to the Claude pane for those shortcuts.
        if (!isMac && paneType === 'dev' && 'adrhkl'.includes(key)) return true;
        if ('atdrhkuno,lgf/'.includes(key)) return false;
      }
      if (isModKey(e) && e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'w' || key === 'c') return false;
      }
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

    // Replay any buffered output from before this listener was registered,
    // then force a resize to trigger SIGWINCH so Claude Code redraws its
    // TUI with the correct dimensions (buffer was generated at default 120×30).
    window.bifrost.drainSessionBuffer(sessionId).then((buf) => {
      if (buf) {
        setLoading(false);
        terminal.write(buf, () => {
          try {
            fitAddon.fit();
            window.bifrost.resizeSession(sessionId, terminal.cols, terminal.rows);
          } catch {
            /* container may not be visible */
          }
        });
      }
    });

    // Receive data from session
    // When user has scrolled up, hold the viewport at the same absolute
    // line so they can read without the view jumping.  When the viewport
    // is at the bottom, let xterm auto-scroll to follow new output
    // (tail -f behaviour).
    let hasReceivedData = false;
    let userScrolledUp = false;
    let savedViewportY = 0;

    terminal.onScroll(() => {
      const buf = terminal.buffer.active;
      userScrolledUp = buf.viewportY < buf.baseY;
      if (userScrolledUp) {
        savedViewportY = buf.viewportY;
      }
    });

    const removeDataListener = window.bifrost.onSessionData((sid: string, data: string) => {
      if (sid === sessionId) {
        if (!hasReceivedData) {
          hasReceivedData = true;
          setLoading(false);
        }
        terminal.write(data, () => {
          if (userScrolledUp) {
            terminal.scrollToLine(savedViewportY);
          }
        });
      }
    });

    // Handle session exit
    const removeExitListener = window.bifrost.onSessionExit((sid: string) => {
      if (sid === sessionId) {
        terminal.write('\r\n[Session ended]\r\n');
      }
    });

    // ResizeObserver for auto-fit
    // Skip when container has zero dimensions (pane hidden via display:none)
    // to avoid truncating xterm scrollback buffer.
    // Debounce PTY resizes to avoid flooding the process with SIGWINCHes
    // during rapid window/pane drags — each one causes a full TUI redraw.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      try {
        fitAddon.fit();
      } catch {
        // ignore fit errors
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        window.bifrost.resizeSession(sessionId, terminal.cols, terminal.rows);
      }, 100);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
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
    if (sessionId && terminalRef.current && fitAddonRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      try {
        fitAddonRef.current.fit();
        window.bifrost.resizeSession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
      } catch {
        // ignore fit errors
      }
    }
  }, [sessionId, fontSize]);

  // Update fontWeight dynamically when config changes
  const fontWeight = options?.fontWeight ?? 300;
  useEffect(() => {
    if (sessionId && terminalRef.current && fitAddonRef.current) {
      terminalRef.current.options.fontWeight = fontWeight;
      try {
        fitAddonRef.current.fit();
        window.bifrost.resizeSession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
      } catch {
        // ignore fit errors
      }
    }
  }, [sessionId, fontWeight]);

  // Update fontFamily dynamically when config changes
  const fontFamily = options?.fontFamily ?? 'MesloLGS NF';
  useEffect(() => {
    if (sessionId && terminalRef.current && fitAddonRef.current) {
      terminalRef.current.options.fontFamily = `"${fontFamily}", Menlo, Monaco, "Courier New", monospace`;
      try {
        fitAddonRef.current.fit();
        window.bifrost.resizeSession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
      } catch {
        // ignore fit errors
      }
    }
  }, [sessionId, fontFamily]);

  // Update terminal theme dynamically when config changes
  const terminalTheme = options?.terminalTheme ?? 'Auto';
  const isDark = options?.isDark ?? true;
  const hideCursorOpt = options?.hideCursor ?? false;
  useEffect(() => {
    if (sessionId && terminalRef.current) {
      const theme = resolveTerminalTheme(terminalTheme, isDark);
      terminalRef.current.options.theme = {
        ...theme,
        cursor: hideCursorOpt ? theme.background : theme.cursor,
      };
    }
  }, [sessionId, terminalTheme, isDark, hideCursorOpt]);

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

  return { terminal: terminalRef, fitAddon: fitAddonRef, loading };
}
