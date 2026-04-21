import { FitAddon } from '@xterm/addon-fit';
// import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { IMarker } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_KEYMAP, getInterceptedKeys, type InterceptedKeys } from '../../shared/keymap';
import { resolveTerminalTheme } from '../terminal-themes';
import { hippieExpand, resetHippieState } from '../utils/hippie-expand';
import { isMac, isModKey } from '../utils/platform';

// Global registry so keyboard shortcuts can access terminal instances
export const terminalRegistry = new Map<string, Terminal>();
export const searchAddonRegistry = new Map<string, SearchAddon>();

// Terminal input lock for prompt-sender: when locked, keystrokes are buffered
export const terminalInputLocks = new Set<string>();
const terminalInputBuffers = new Map<string, string[]>();

export function lockTerminalInput(sessionId: string): void {
  terminalInputLocks.add(sessionId);
}

export function unlockTerminalInput(sessionId: string): void {
  terminalInputLocks.delete(sessionId);
  // Replay buffered keystrokes
  const buffer = terminalInputBuffers.get(sessionId);
  if (buffer && buffer.length > 0) {
    for (const data of buffer) {
      window.bifrost.writeToSession(sessionId, data);
    }
  }
  terminalInputBuffers.delete(sessionId);
}

// Module-level ref so KeymapContext can update intercepted keys without re-attaching the handler.
// Initialised from DEFAULT_KEYMAP so terminal interception works before KeymapProvider mounts.
export const interceptedKeysRef: { current: InterceptedKeys } = { current: getInterceptedKeys(DEFAULT_KEYMAP) };

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
      // Option+/: hippie-expand (dabbrev-expand)
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          if (e.type === 'keydown') {
            const seq = e.key === 'ArrowLeft' ? '\x1bb' : '\x1bf';
            window.bifrost.writeToSession(sessionId!, seq);
          }
          return false;
        }
        if (e.code === 'Slash') {
          // Prevent macOS from generating the composed '÷' character
          e.preventDefault();
          if (e.type === 'keydown') {
            hippieExpand(terminal, sessionId!);
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
        if (interceptedKeysRef.current.modKeys.has(key)) return false;
      }
      if (isModKey(e) && e.shiftKey) {
        const key = e.key.toLowerCase();
        if (interceptedKeysRef.current.shiftModKeys.has(key)) return false;
      }
      // Bare keys (no modifiers) like F2
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (interceptedKeysRef.current.bareKeys.has(e.key.toLowerCase())) return false;
      }
      return true;
    });

    // Send keystrokes to session (buffer when locked by prompt-sender)
    terminal.onData((data) => {
      resetHippieState();
      if (terminalInputLocks.has(sessionId)) {
        let buf = terminalInputBuffers.get(sessionId);
        if (!buf) {
          buf = [];
          terminalInputBuffers.set(sessionId, buf);
        }
        buf.push(data);
      } else {
        window.bifrost.writeToSession(sessionId, data);
      }
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
    // When the viewport is not at the bottom, prevent xterm's
    // auto-scroll from jumping away from what the user is reading.
    //
    // We pin to an IMarker at the viewport's top line: xterm keeps the
    // marker's .line in sync with its content as the scrollback is
    // written to and trimmed, so the viewport tracks content rather
    // than a fixed absolute line number that would drift once the
    // scrollback cap is reached.
    let hasReceivedData = false;
    let lockedMarker: IMarker | null = null;
    // True while the user is actively scrolling via wheel/trackpad
    let userScrolling = false;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;

    function isAtBottom(): boolean {
      const buf = terminal.buffer.active;
      return buf.viewportY >= buf.baseY;
    }

    function clearLock(): void {
      if (lockedMarker && !lockedMarker.isDisposed) lockedMarker.dispose();
      lockedMarker = null;
    }

    function setLockAtViewportTop(): void {
      clearLock();
      const buf = terminal.buffer.active;
      const cursorAbs = buf.baseY + buf.cursorY;
      const offset = buf.viewportY - cursorAbs;
      try {
        const m = terminal.registerMarker(offset);
        if (m && !m.isDisposed) lockedMarker = m;
      } catch {
        // marker out of range — leave lock unset
      }
    }

    // Detect user scroll via wheel events on the container
    const onWheel = () => {
      userScrolling = true;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        userScrolling = false;
        if (isAtBottom()) {
          clearLock();
        } else {
          setLockAtViewportTop();
        }
      }, 150);
    };
    containerRef.current?.addEventListener('wheel', onWheel, { passive: true, capture: true });

    // When xterm scrolls programmatically (auto-scroll on write),
    // snap back to the locked marker's current line.
    terminal.onScroll(() => {
      if (!lockedMarker || userScrolling) return;
      if (lockedMarker.isDisposed) {
        // Content fell out of scrollback — release the lock
        lockedMarker = null;
        return;
      }
      const buf = terminal.buffer.active;
      const target = lockedMarker.line;
      if (target >= buf.baseY) {
        // Locked content is now within the bottom viewport — release lock
        clearLock();
        return;
      }
      if (buf.viewportY !== target) terminal.scrollToLine(target);
    });

    const removeDataListener = window.bifrost.onSessionData((sid: string, data: string) => {
      if (sid === sessionId) {
        if (!hasReceivedData) {
          hasReceivedData = true;
          setLoading(false);
        }
        // Auto-engage lock if viewport isn't at the bottom
        if (!lockedMarker && !isAtBottom()) setLockAtViewportTop();
        terminal.write(data);
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
      if (scrollTimer) clearTimeout(scrollTimer);
      clearLock();
      containerRef.current?.removeEventListener('wheel', onWheel, { capture: true });
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

  // Debounced fit+resize to avoid flooding the PTY with SIGWINCHes
  // when multiple config changes or tab switches fire in quick succession.
  // A SIGWINCH mid-render can corrupt Claude Code's TUI output.
  const pendingResize = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedFitResize = useCallback(
    (delay = 50) => {
      if (pendingResize.current) clearTimeout(pendingResize.current);
      pendingResize.current = setTimeout(() => {
        pendingResize.current = null;
        if (!terminalRef.current || !fitAddonRef.current || !sessionId) return;
        try {
          fitAddonRef.current.fit();
          window.bifrost.resizeSession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
        } catch {
          // ignore fit errors
        }
      }, delay);
    },
    [sessionId],
  );

  // Update fontSize dynamically when config changes
  const fontSize = options?.fontSize ?? 14;
  useEffect(() => {
    if (sessionId && terminalRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      debouncedFitResize();
    }
  }, [sessionId, fontSize, debouncedFitResize]);

  // Update fontWeight dynamically when config changes
  const fontWeight = options?.fontWeight ?? 300;
  useEffect(() => {
    if (sessionId && terminalRef.current) {
      terminalRef.current.options.fontWeight = fontWeight;
      debouncedFitResize();
    }
  }, [sessionId, fontWeight, debouncedFitResize]);

  // Update fontFamily dynamically when config changes
  const fontFamily = options?.fontFamily ?? 'MesloLGS NF';
  useEffect(() => {
    if (sessionId && terminalRef.current) {
      terminalRef.current.options.fontFamily = `"${fontFamily}", Menlo, Monaco, "Courier New", monospace`;
      debouncedFitResize();
    }
  }, [sessionId, fontFamily, debouncedFitResize]);

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
  // Debounce by 50ms so rapid Cmd+Shift+[/] cycling doesn't trigger
  // a fit+resize IPC for every intermediate tab.
  const visible = options?.visible ?? true;
  useEffect(() => {
    if (visible && sessionId) debouncedFitResize();
  }, [visible, sessionId, debouncedFitResize]);

  return { terminal: terminalRef, fitAddon: fitAddonRef, loading };
}
