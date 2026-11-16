export type ActionCategory = 'tasks' | 'navigation' | 'views' | 'actions' | 'app';

export interface ActionDefinition {
  id: string;
  label: string;
  category: ActionCategory;
  requiresTask?: boolean;
  doubleConfirm?: boolean;
}

export const ACTION_REGISTRY: Record<string, ActionDefinition> = {
  'task.new': { id: 'task.new', label: 'New task', category: 'tasks' },
  'task.close': {
    id: 'task.close',
    label: 'Close pane / stop task',
    category: 'tasks',
    requiresTask: true,
    doubleConfirm: true,
  },
  'task.rename': { id: 'task.rename', label: 'Rename task', category: 'tasks', requiresTask: true },
  'task.archive': {
    id: 'task.archive',
    label: 'Archive task',
    category: 'tasks',
    requiresTask: true,
    doubleConfirm: true,
  },
  'nav.prevTab': { id: 'nav.prevTab', label: 'Previous tab', category: 'navigation' },
  'nav.nextTab': { id: 'nav.nextTab', label: 'Next tab', category: 'navigation' },
  'nav.tab1': { id: 'nav.tab1', label: 'Switch to tab 1', category: 'navigation' },
  'nav.tab2': { id: 'nav.tab2', label: 'Switch to tab 2', category: 'navigation' },
  'nav.tab3': { id: 'nav.tab3', label: 'Switch to tab 3', category: 'navigation' },
  'nav.tab4': { id: 'nav.tab4', label: 'Switch to tab 4', category: 'navigation' },
  'nav.tab5': { id: 'nav.tab5', label: 'Switch to tab 5', category: 'navigation' },
  'nav.tab6': { id: 'nav.tab6', label: 'Switch to tab 6', category: 'navigation' },
  'nav.tab7': { id: 'nav.tab7', label: 'Switch to tab 7', category: 'navigation' },
  'nav.tab8': { id: 'nav.tab8', label: 'Switch to tab 8', category: 'navigation' },
  'nav.tab9': { id: 'nav.tab9', label: 'Switch to tab 9', category: 'navigation' },
  'nav.lastActive': { id: 'nav.lastActive', label: 'Last active tab', category: 'navigation' },
  'nav.lastNotified': { id: 'nav.lastNotified', label: 'Last notified tab', category: 'navigation' },
  'nav.toggleSidebar': { id: 'nav.toggleSidebar', label: 'Toggle sidebar', category: 'navigation' },
  'nav.filterTasks': { id: 'nav.filterTasks', label: 'Filter tasks', category: 'navigation' },
  'view.devTerminal': { id: 'view.devTerminal', label: 'Toggle dev terminal', category: 'views', requiresTask: true },
  'view.diff': { id: 'view.diff', label: 'Git diff', category: 'views', requiresTask: true },
  'view.log': { id: 'view.log', label: 'Git log', category: 'views', requiresTask: true },
  'view.history': { id: 'view.history', label: 'Task history', category: 'views' },
  'view.repos': { id: 'view.repos', label: 'Repositories', category: 'views' },
  'view.notes': { id: 'view.notes', label: 'Notes', category: 'views' },
  'view.console': { id: 'view.console', label: 'Console', category: 'views' },
  'view.notifications': { id: 'view.notifications', label: 'Notifications', category: 'views' },
  'view.stats': { id: 'view.stats', label: 'Stats', category: 'views' },
  'view.changeFeed': { id: 'view.changeFeed', label: 'Change feed', category: 'views', requiresTask: true },
  'view.activity': { id: 'view.activity', label: 'Activity / tokens', category: 'views', requiresTask: true },
  'action.openIde': { id: 'action.openIde', label: 'Open in IDE', category: 'actions', requiresTask: true },
  'action.openPr': { id: 'action.openPr', label: 'Open PR in GitHub', category: 'actions', requiresTask: true },
  'action.copyPrUrl': { id: 'action.copyPrUrl', label: 'Copy PR URL', category: 'actions', requiresTask: true },
  'action.restartSessions': { id: 'action.restartSessions', label: 'Restart sessions', category: 'actions' },
  'action.find': { id: 'action.find', label: 'Find in terminal', category: 'actions', requiresTask: true },
  'action.copyRef': { id: 'action.copyRef', label: 'Copy task reference', category: 'actions', requiresTask: true },
  'action.scrollUp': { id: 'action.scrollUp', label: 'Scroll terminal up', category: 'actions', requiresTask: true },
  'action.scrollDown': {
    id: 'action.scrollDown',
    label: 'Scroll terminal down',
    category: 'actions',
    requiresTask: true,
  },
  'action.capture': { id: 'action.capture', label: 'Capture context', category: 'actions', requiresTask: true },
  'app.shortcuts': { id: 'app.shortcuts', label: 'Keyboard shortcuts', category: 'app' },
  'app.settings': { id: 'app.settings', label: 'Settings', category: 'app' },
  'app.restart': { id: 'app.restart', label: 'Restart Bifrost', category: 'app' },
};

export const ACTION_CATEGORIES: { id: ActionCategory; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'views', label: 'Views' },
  { id: 'actions', label: 'Actions' },
  { id: 'app', label: 'App' },
];

export interface KeyStroke {
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
}

export interface KeyBinding {
  actionId: string;
  strokes: KeyStroke[];
}

// Arrows round-trip through their symbols so a binding reads as ⌘↑ rather than
// ⌘arrowup, in both the shortcut list and a recorded rebinding.
const ARROW_SYMBOLS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};
const ARROW_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(ARROW_SYMBOLS).map(([key, symbol]) => [symbol, key]),
);

function serializeStroke(s: KeyStroke): string {
  const parts: string[] = [];
  if (s.mod) parts.push('Cmd');
  if (s.alt) parts.push('Alt');
  if (s.shift) parts.push('Shift');
  parts.push(ARROW_SYMBOLS[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key));
  return parts.join('+');
}

export function serializeBinding(strokes: KeyStroke[]): string {
  return strokes.map(serializeStroke).join(' ');
}

export function parseStroke(s: string): KeyStroke {
  const parts = s.split('+');
  const last = parts[parts.length - 1];
  const key = ARROW_KEYS[last] ?? last.toLowerCase();
  return {
    mod: parts.some((p) => p === 'Cmd' || p === 'Ctrl'),
    shift: parts.some((p) => p === 'Shift'),
    alt: parts.some((p) => p === 'Alt'),
    key,
  };
}

export function parseBinding(s: string): KeyStroke[] {
  return s.split(/\s+/).map(parseStroke);
}

function kb(actionId: string, shortcut: string): KeyBinding {
  return { actionId, strokes: parseBinding(shortcut) };
}

export const DEFAULT_KEYMAP: KeyBinding[] = [
  kb('task.new', 'Cmd+T'),
  kb('task.close', 'Cmd+W'),
  kb('task.rename', 'F2'),
  kb('task.archive', 'Cmd+Shift+W'),
  kb('nav.prevTab', 'Cmd+Shift+['),
  kb('nav.nextTab', 'Cmd+Shift+]'),
  kb('nav.tab1', 'Cmd+1'),
  kb('nav.tab2', 'Cmd+2'),
  kb('nav.tab3', 'Cmd+3'),
  kb('nav.tab4', 'Cmd+4'),
  kb('nav.tab5', 'Cmd+5'),
  kb('nav.tab6', 'Cmd+6'),
  kb('nav.tab7', 'Cmd+7'),
  kb('nav.tab8', 'Cmd+8'),
  kb('nav.tab9', 'Cmd+9'),
  kb('nav.lastActive', 'Cmd+-'),
  kb('nav.lastNotified', 'Cmd+='),
  kb('nav.toggleSidebar', 'Cmd+B'),
  kb('nav.filterTasks', 'Cmd+P'),
  kb('view.devTerminal', 'Cmd+/'),
  kb('view.diff', 'Cmd+D'),
  kb('view.log', 'Cmd+L'),
  kb('view.history', 'Cmd+Y'),
  kb('view.repos', 'Cmd+R'),
  kb('view.notes', 'Cmd+N'),
  kb('view.console', 'Cmd+J'),
  kb('view.changeFeed', 'Cmd+E'),
  kb('action.openIde', 'Cmd+O'),
  kb('action.openPr', 'Cmd+G'),
  kb('action.copyPrUrl', 'Cmd+Shift+G'),
  kb('action.find', 'Cmd+F'),
  kb('action.scrollUp', 'Cmd+ArrowUp'),
  kb('action.scrollDown', 'Cmd+ArrowDown'),
  kb('action.copyRef', 'Cmd+Shift+C'),
  kb('app.shortcuts', 'Cmd+K'),
  kb('app.settings', 'Cmd+,'),
];

export function resolveKeymap(keybindings?: Record<string, string | null>): KeyBinding[] {
  if (!keybindings) return DEFAULT_KEYMAP;

  const result: KeyBinding[] = [];
  const overridden = new Set<string>();

  for (const [actionId, binding] of Object.entries(keybindings)) {
    overridden.add(actionId);
    if (binding?.trim()) {
      result.push({ actionId, strokes: parseBinding(binding) });
    }
  }

  for (const b of DEFAULT_KEYMAP) {
    if (!overridden.has(b.actionId)) {
      result.push(b);
    }
  }

  return result;
}

export interface InterceptedKeys {
  modKeys: Set<string>;
  shiftModKeys: Set<string>;
  /** Keys without any modifier (e.g. F2) */
  bareKeys: Set<string>;
}

export function getInterceptedKeys(keymap: KeyBinding[]): InterceptedKeys {
  const modKeys = new Set<string>();
  const shiftModKeys = new Set<string>();
  const bareKeys = new Set<string>();

  for (const binding of keymap) {
    const first = binding.strokes[0];
    if (!first) continue;
    if (first.mod) {
      if (first.shift) {
        shiftModKeys.add(first.key);
      } else {
        modKeys.add(first.key);
      }
    } else if (!first.shift && !first.alt) {
      bareKeys.add(first.key);
    }
  }

  return { modKeys, shiftModKeys, bareKeys };
}

export interface ChordEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// Physical keys whose character Shift changes on a US layout. Off macOS Shift
// is part of the modifier, so these keys are read from e.code instead.
const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

function keyOf(e: ChordEvent, byCode: boolean): string {
  const code = e.code ?? '';
  if (code === 'BracketLeft' || code === 'BracketRight') return CODE_KEYS[code];
  if (byCode) {
    if (CODE_KEYS[code]) return CODE_KEYS[code];
    if (/^Digit\d$/.test(code)) return code.slice(5);
    // Ctrl+Alt can compose another character on some layouts (AltGr on Windows).
    if (/^Key[A-Z]$/.test(code) && !/^[a-z]$/i.test(e.key)) return code.slice(3).toLowerCase();
  }
  return e.key.toLowerCase();
}

/**
 * The stroke a key event spells in the keymap, or null when the chord belongs to
 * the terminal. A stroke's `mod` is Cmd on macOS. Elsewhere it is Ctrl+Shift, and
 * a stroke with both `mod` and `shift` is Ctrl+Alt+Shift, so that plain Ctrl
 * reaches terminal programs as it does in GNOME Terminal or VS Code.
 */
export function strokeOfEvent(e: ChordEvent, mac: boolean): KeyStroke | null {
  if (mac) return { mod: e.metaKey, shift: e.shiftKey, alt: e.altKey, key: keyOf(e, false) };
  if (!e.ctrlKey) return { mod: false, shift: e.shiftKey, alt: e.altKey, key: keyOf(e, false) };
  if (!e.shiftKey) return null;
  return { mod: true, shift: e.altKey, alt: false, key: keyOf(e, true) };
}

export function strokeMatches(binding: KeyStroke, pressed: KeyStroke): boolean {
  return (
    !!binding.mod === pressed.mod &&
    !!binding.shift === !!pressed.shift &&
    !!binding.alt === !!pressed.alt &&
    binding.key === pressed.key
  );
}

function keyLabel(key: string): string {
  return ARROW_SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** How a stroke reads to the user on this platform: ⌘⇧W on macOS, Ctrl+Alt+Shift+W elsewhere. */
export function strokeLabel(s: KeyStroke, mac: boolean): string {
  if (mac) return `${s.mod ? '\u2318' : ''}${s.alt ? '\u2325' : ''}${s.shift ? '\u21E7' : ''}${keyLabel(s.key)}`;
  return [...modifierNames(s), keyLabel(s.key)].join('+');
}

function modifierNames(s: KeyStroke): string[] {
  if (s.mod) return s.shift ? ['Ctrl', 'Alt', 'Shift'] : ['Ctrl', 'Shift'];
  return [...(s.alt ? ['Alt'] : []), ...(s.shift ? ['Shift'] : [])];
}

/** A stroke as an Electron menu accelerator. */
export function strokeAccelerator(s: KeyStroke, mac: boolean): string {
  const key =
    s.key.length === 1 ? s.key.toUpperCase() : s.key.replace(/^arrow/, '').replace(/^./, (c) => c.toUpperCase());
  if (mac) return serializeStroke({ ...s, key }).replace('Cmd', 'CommandOrControl');
  return [...modifierNames(s), key].join('+');
}

export function getBindingDisplay(binding: KeyBinding): string {
  return serializeBinding(binding.strokes);
}

export function isCustomized(actionId: string, keybindings?: Record<string, string | null>): boolean {
  return !!keybindings && actionId in keybindings;
}

/** The window event the shortcuts panel raises to run an action no key binding reaches, its id as the detail. */
export const RUN_ACTION_EVENT = 'bifrost:run-action';
