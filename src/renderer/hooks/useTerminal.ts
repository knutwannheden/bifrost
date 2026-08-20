import { FitAddon } from '@xterm/addon-fit';
// import { LigaturesAddon } from '@xterm/addon-ligatures';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/**
 * Wrap fitAddon.fit() with viewport preservation. Without this, a row-count
 * change during fit can leave the viewport pointing at an offset where there's
 * no live content (Claude Code's TUI looks blank until the next user resize).
 * Pattern adapted from Tabby (xtermFrontend.ts:427-437).
 */
function safeFit(terminal: Terminal, fitAddon: FitAddon): void {
  const before = terminal.buffer.active;
  const wasAtBottom = before.viewportY >= before.baseY;
  try {
    fitAddon.fit();
  } catch {
    return;
  }
  if (wasAtBottom) {
    terminal.scrollToBottom();
  }
}

interface TerminalOptions {
  cursorBlink?: boolean;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  terminalTheme?: string;
  isDark?: boolean;
  visible?: boolean;
  paneType?: 'claude' | 'dev';
  /** 'dom' (default) or 'webgl'. See BifrostConfig.terminalRenderer. */
  renderer?: 'dom' | 'webgl';
}

export function useTerminal(
  sessionId: string | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  onTitleChange?: (title: string) => void,
  options?: TerminalOptions,
) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const [loading, setLoading] = useState(true);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  // Track last cols/rows sent to PTY so we can skip no-op resizes that
  // would otherwise fire SIGWINCH and trigger a TUI redraw on every
  // tab switch.
  const lastResize = useRef<{ cols: number; rows: number } | null>(null);
  const sendResizeIfChanged = useCallback(
    (cols: number, rows: number) => {
      if (!sessionId) return;
      if (lastResize.current?.cols === cols && lastResize.current?.rows === rows) return;
      lastResize.current = { cols, rows };
      window.bifrost.resizeSession(sessionId, cols, rows);
    },
    [sessionId],
  );
  useEffect(() => {
    if (!sessionId || !containerRef.current) return;
    setLoading(true);

    const paneType = options?.paneType;
    const selectedTheme = resolveTerminalTheme(options?.terminalTheme ?? 'Auto', options?.isDark ?? true);
    const terminal = new Terminal({
      // Claude Code draws no caret of its own: it parks the real cursor at the
      // insertion point and shows it with DECTCEM.
      cursorBlink: options?.cursorBlink ?? true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontWeight: options?.fontWeight ?? 300,
      fontSize: options?.fontSize ?? 14,
      fontFamily: `"${options?.fontFamily ?? 'MesloLGS NF'}", Menlo, Monaco, "Courier New", monospace`,
      linkHandler: {
        activate: (_event, uri) => {
          window.bifrost.openUrl(uri);
        },
        allowNonHttpProtocols: true,
      },
      theme: selectedTheme,
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

    // Renderer selection. The built-in DOM renderer (used when this is not
    // 'webgl') has no texture atlas and so cannot exhibit the atlas-ghosting
    // bug that garbles background-colored cells until a resize. The WebGL
    // addon is faster under heavy streaming but carries that bug (and the
    // context-loss / atlas-clear workarounds below exist solely to manage it).
    const useWebgl = (options?.renderer ?? 'dom') === 'webgl';

    // On context loss (e.g. system sleep), dispose and re-create the addon
    // so xterm falls back to the DOM renderer temporarily then recovers.
    const loadWebgl = () => {
      try {
        const webgl = new WebglAddon();
        webglAddonRef.current = webgl;
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (webglAddonRef.current === webgl) webglAddonRef.current = null;
          // Re-attempt WebGL after a short delay (GPU may be available again)
          setTimeout(loadWebgl, 1000);
        });
        // Atlas-overflow guard: heavy color/glyph variety from Claude Code's
        // TUI fills multiple atlas pages and trips xterm.js's WebGL ghosting
        // bug (xtermjs/xterm.js#5847), producing overlapping garbled glyphs
        // on colored cells that only clear on resize. Force a clear once
        // enough pages have accumulated so glyphs get rerasterized.
        let pagesAdded = 0;
        webgl.onAddTextureAtlasCanvas(() => {
          pagesAdded++;
          if (pagesAdded >= 4) {
            pagesAdded = 0;
            // Defer so we don't clear mid-render
            setTimeout(() => webglAddonRef.current?.clearTextureAtlas(), 0);
          }
        });
        terminal.loadAddon(webgl);
      } catch {
        // WebGL not available, fall back to the built-in DOM renderer
      }
    };
    if (useWebgl) loadWebgl();

    // Sizes xterm to the container before attaching: the snapshot is built for
    // these dimensions.
    safeFit(terminal, fitAddon);

    // Font-settle: terminal.open() above measures the cell using whatever
    // font is currently resolved, which can be the fallback if the configured
    // family hasn't finished loading. Once the real font lands, dimensions
    // and atlas contents are stale. Re-measure and clear the atlas after the
    // font is ready so first-paint glyphs aren't stuck at fallback metrics.
    let fontSettleCancelled = false;
    const desiredFont = `${options?.fontSize ?? 14}px "${options?.fontFamily ?? 'MesloLGS NF'}"`;
    document.fonts
      .load(desiredFont)
      .then(() => {
        if (fontSettleCancelled || !terminalRef.current || !fitAddonRef.current) return;
        webglAddonRef.current?.clearTextureAtlas();
        safeFit(terminal, fitAddon);
        sendResizeIfChanged(terminal.cols, terminal.rows);
      })
      .catch(() => {
        /* font failed to load — fall back to whatever xterm measured */
      });

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

    // Route input to the session, buffering when locked by prompt-sender.
    const sendInput = (data: string) => {
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
    };

    terminal.onData((data) => {
      resetHippieState();
      sendInput(data);
    });

    // Listen for terminal title changes (OSC 0/2)
    terminal.onTitleChange((title) => {
      onTitleChangeRef.current?.(title);
    });

    // Receive data from session
    let hasReceivedData = false;
    let attached = false;
    // A session is spawned on demand, so a terminal can reach it before it
    // exists. Output is kept until the attach settles rather than judged
    // against a snapshot that may never come.
    const beforeAttach: string[] = [];

    function writeSessionData(data: string): void {
      if (!hasReceivedData) {
        hasReceivedData = true;
        setLoading(false);
      }
      terminal.write(data);
    }

    /** No session to snapshot: the pane renders live output from here on. */
    function attachFailed(): void {
      attached = true;
      // The PTY never took this geometry, so let the next fit deliver it.
      lastResize.current = null;
      for (const data of beforeAttach) writeSessionData(data);
      beforeAttach.length = 0;
      setLoading(false);
    }

    // The attach carries this geometry to the PTY, so record it as sent.
    lastResize.current = { cols: terminal.cols, rows: terminal.rows };
    window.bifrost
      .attachSession(sessionId, terminal.cols, terminal.rows)
      .then((alive) => {
        if (!alive) attachFailed();
      })
      .catch((err) => {
        console.error(`[terminal] attach failed for ${sessionId}:`, err);
        attachFailed();
      });

    // Strip per-line trailing whitespace from clipboard text. xterm's
    // getTrimmedLength counts cells holding regular spaces (e.g. background-
    // color padding emitted by Claude's TUI) as content, so copied lines
    // retain padding to the full terminal width — which destination editors
    // wrap as visible blank lines. Capture phase + stopPropagation keeps
    // xterm's bubble-phase handler from overwriting our cleaned data.
    const onCopy = (e: ClipboardEvent) => {
      if (!terminal.hasSelection()) return;
      const sel = terminal.getSelection();
      if (!sel) return;
      const cleaned = sel
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n');
      e.clipboardData?.setData('text/plain', cleaned);
      e.preventDefault();
      e.stopPropagation();
    };
    containerRef.current?.addEventListener('copy', onCopy, { capture: true });

    // Claude's TUI always accepts bracketed paste at the prompt, so frame the
    // paste here rather than relying on xterm's tracked mode, which requires
    // it to have parsed Claude's enable sequence off the output stream.
    const onPaste = (e: ClipboardEvent) => {
      if (paneType !== 'claude') return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      // Mirror xterm's prepareTextForTerminal (\n→\r); replace embedded ESC
      // with the visible ␛ symbol so it can't prematurely close the
      // bracketed-paste span.
      const sanitized = text.replace(/\r?\n/g, '\r').split('\x1b').join('␛');
      const framed = `\x1b[200~${sanitized}\x1b[201~`;
      sendInput(framed);
    };
    containerRef.current?.addEventListener('paste', onPaste, { capture: true });

    const removeDataListener = window.bifrost.onSessionData((sid: string, data: string, isReplay: boolean) => {
      if (sid !== sessionId) return;
      if (isReplay) {
        // The snapshot already contains everything held here.
        attached = true;
        beforeAttach.length = 0;
      } else if (!attached) {
        beforeAttach.push(data);
        return;
      }
      writeSessionData(data);
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
      safeFit(terminal, fitAddon);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        sendResizeIfChanged(terminal.cols, terminal.rows);
      }, 100);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      fontSettleCancelled = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      containerRef.current?.removeEventListener('copy', onCopy, { capture: true });
      containerRef.current?.removeEventListener('paste', onPaste, { capture: true });
      resizeObserver.disconnect();
      removeDataListener();
      removeExitListener();
      searchAddonRegistry.delete(sessionId);
      terminalRegistry.delete(sessionId);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      webglAddonRef.current = null;
    };
    // options?.renderer is intentionally a dependency: switching renderer
    // disposes and recreates the terminal (the safe pattern — never re-open
    // an existing instance), so the A/B toggle takes effect without a restart.
  }, [sessionId, containerRef, sendResizeIfChanged, options?.renderer]);

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
        safeFit(terminalRef.current, fitAddonRef.current);
        sendResizeIfChanged(terminalRef.current.cols, terminalRef.current.rows);
      }, delay);
    },
    [sessionId, sendResizeIfChanged],
  );

  // Update fontSize dynamically when config changes
  const fontSize = options?.fontSize ?? 14;
  useEffect(() => {
    if (sessionId && terminalRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      webglAddonRef.current?.clearTextureAtlas();
      debouncedFitResize();
    }
  }, [sessionId, fontSize, debouncedFitResize]);

  // Update fontWeight dynamically when config changes
  const fontWeight = options?.fontWeight ?? 300;
  useEffect(() => {
    if (sessionId && terminalRef.current) {
      terminalRef.current.options.fontWeight = fontWeight;
      webglAddonRef.current?.clearTextureAtlas();
      debouncedFitResize();
    }
  }, [sessionId, fontWeight, debouncedFitResize]);

  // Update fontFamily dynamically when config changes
  const fontFamily = options?.fontFamily ?? 'MesloLGS NF';
  useEffect(() => {
    if (sessionId && terminalRef.current) {
      terminalRef.current.options.fontFamily = `"${fontFamily}", Menlo, Monaco, "Courier New", monospace`;
      webglAddonRef.current?.clearTextureAtlas();
      debouncedFitResize();
    }
  }, [sessionId, fontFamily, debouncedFitResize]);

  // Update terminal theme dynamically when config changes
  const terminalTheme = options?.terminalTheme ?? 'Auto';
  const isDark = options?.isDark ?? true;
  useEffect(() => {
    if (sessionId && terminalRef.current) {
      terminalRef.current.options.theme = resolveTerminalTheme(terminalTheme, isDark);
      // Cached glyphs in the WebGL atlas keep their old fg/bg colors until
      // invalidated — without this they'd render with the previous theme's
      // colors until something else forces an atlas refresh.
      webglAddonRef.current?.clearTextureAtlas();
    }
  }, [sessionId, terminalTheme, isDark]);

  // Re-fit when pane becomes visible (e.g. switching tabs) so the PTY
  // column count stays in sync with xterm after background data writes.
  // Debounce by 50ms so rapid Cmd+Shift+[/] cycling doesn't trigger
  // a fit+resize IPC for every intermediate tab.
  const visible = options?.visible ?? true;
  useEffect(() => {
    if (visible && sessionId) debouncedFitResize();
  }, [visible, sessionId, debouncedFitResize]);

  // xterm's RenderService pauses rendering while the terminal sits in a
  // display:none subtree (driven by an IntersectionObserver on the screen
  // element). When the subtree becomes visible again the IO callback that
  // restarts rendering fires asynchronously and the recovery refresh is
  // batched through requestAnimationFrame — so the browser can paint one
  // or more frames showing the canvas's stale pixels before xterm catches
  // up. That's the brief glyph-garbling on tab switch.
  //
  // Force a synchronous viewport refresh on the hidden→visible transition,
  // before the next browser paint. We have to clear _isPaused first since
  // the IO callback that normally clears it hasn't fired yet at this point;
  // the IO will set it again later (and ours is idempotent with that).
  const wasVisible = useRef(visible);
  useLayoutEffect(() => {
    const term = terminalRef.current;
    if (term && visible && !wasVisible.current) {
      const renderService = (term as { _core?: { _renderService?: { _isPaused: boolean } } })._core?._renderService;
      if (renderService) renderService._isPaused = false;
      // refresh's third (sync) argument is in the runtime impl but missing from the public d.ts;
      // synchronous render guarantees the visible frame is correct, not the next one.
      (term as { refresh(start: number, end: number, sync?: boolean): void }).refresh(0, term.rows - 1, true);
    }
    wasVisible.current = visible;
  }, [visible]);

  return { terminal: terminalRef, fitAddon: fitAddonRef, loading };
}
