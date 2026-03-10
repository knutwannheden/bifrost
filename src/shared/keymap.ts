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
  'view.devTerminal': { id: 'view.devTerminal', label: 'Toggle dev terminal', category: 'views', requiresTask: true },
  'view.diff': { id: 'view.diff', label: 'Git diff', category: 'views', requiresTask: true },
  'view.log': { id: 'view.log', label: 'Git log', category: 'views', requiresTask: true },
  'view.history': { id: 'view.history', label: 'Task history', category: 'views' },
  'view.repos': { id: 'view.repos', label: 'Repositories', category: 'views' },
  'view.review': { id: 'view.review', label: 'Review', category: 'views', requiresTask: true },
  'view.notes': { id: 'view.notes', label: 'Notes', category: 'views' },
  'view.triage': { id: 'view.triage', label: 'Triage', category: 'views' },
  'view.notifications': { id: 'view.notifications', label: 'Notifications', category: 'views' },
  'view.stats': { id: 'view.stats', label: 'Stats', category: 'views' },
  'view.supervisor': { id: 'view.supervisor', label: 'Supervisor', category: 'views' },
  'view.activity': { id: 'view.activity', label: 'Activity / tokens', category: 'views', requiresTask: true },
  'action.openIde': { id: 'action.openIde', label: 'Open in IDE', category: 'actions', requiresTask: true },
  'action.openPr': { id: 'action.openPr', label: 'Open PR in GitHub', category: 'actions', requiresTask: true },
  'action.find': { id: 'action.find', label: 'Find in terminal', category: 'actions', requiresTask: true },
  'action.capture': { id: 'action.capture', label: 'Capture context', category: 'actions', requiresTask: true },
  'app.shortcuts': { id: 'app.shortcuts', label: 'Keyboard shortcuts', category: 'app' },
  'app.settings': { id: 'app.settings', label: 'Settings', category: 'app' },
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

function serializeStroke(s: KeyStroke): string {
  const parts: string[] = [];
  if (s.mod) parts.push('Cmd');
  if (s.alt) parts.push('Alt');
  if (s.shift) parts.push('Shift');
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return parts.join('+');
}

export function serializeBinding(strokes: KeyStroke[]): string {
  return strokes.map(serializeStroke).join(' ');
}

function parseStroke(s: string): KeyStroke {
  const parts = s.split('+');
  const key = parts[parts.length - 1].toLowerCase();
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
  kb('view.devTerminal', 'Cmd+/'),
  kb('view.diff', 'Cmd+D'),
  kb('view.log', 'Cmd+L'),
  kb('view.history', 'Cmd+H'),
  kb('view.repos', 'Cmd+R'),
  kb('view.review', 'Cmd+U'),
  kb('view.notes', 'Cmd+N'),
  kb('view.triage', 'Cmd+Y'),
  kb('action.openIde', 'Cmd+O'),
  kb('action.openPr', 'Cmd+G'),
  kb('action.find', 'Cmd+F'),
  kb('action.capture', 'Cmd+Shift+C'),
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
}

export function getInterceptedKeys(keymap: KeyBinding[]): InterceptedKeys {
  const modKeys = new Set<string>();
  const shiftModKeys = new Set<string>();

  for (const binding of keymap) {
    const first = binding.strokes[0];
    if (!first?.mod) continue;
    if (first.shift) {
      shiftModKeys.add(first.key);
    } else {
      modKeys.add(first.key);
    }
  }

  return { modKeys, shiftModKeys };
}

export function strokeMatchesEvent(
  stroke: KeyStroke,
  e: { key: string; code?: string; shiftKey: boolean; altKey: boolean },
): boolean {
  const key = e.key.toLowerCase();
  if (stroke.key === '[' || stroke.key === ']') {
    const code = e.code ?? '';
    const expectedCode = stroke.key === '[' ? 'BracketLeft' : 'BracketRight';
    return code === expectedCode && !!stroke.shift === e.shiftKey && !!stroke.alt === e.altKey;
  }
  return key === stroke.key && !!stroke.shift === e.shiftKey && !!stroke.alt === e.altKey;
}

export function getBindingDisplay(binding: KeyBinding): string {
  return serializeBinding(binding.strokes);
}

export function isCustomized(actionId: string, keybindings?: Record<string, string | null>): boolean {
  return !!keybindings && actionId in keybindings;
}
