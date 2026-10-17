import { backend, Eol } from "./backend";
import { LangSetting } from "./i18n";
import type { Macro } from "./macros";

export interface Settings {
  theme: string; // "system" | theme id
  fontFamily: string;
  fontSize: number;
  previewFontFamily: string;
  previewMaxWidth: number; // px, 0 = full width
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  highlightActiveLine: boolean;
  indentationMarkers: boolean;
  bracketMatching: boolean;
  autoCloseBrackets: boolean;
  defaultEol: Eol;
  defaultEncoding: string;
  livePreviewDefault: boolean;
  restoreSession: boolean;
  trimTrailingOnSave: boolean;
  ensureFinalNewline: boolean;
  pagedWindowLines: number;
  showMenuBar: boolean;
  autoReloadExternal: boolean;
  language: LangSetting;
  checkUpdates: boolean;
  lastUpdateCheck: number;
  /** "nax" or "npp" (Notepad++ keys). */
  keymapPreset: string;
  /** Command id -> chord ("" removes the key). */
  keyOverrides: Record<string, string>;
  findHistory: string[];
  replaceHistory: string[];
  recentFiles: string[];
  macros: Macro[];
  showWhitespace: boolean;
  showEol: boolean;
  detectIndent: boolean;
  syncScroll: boolean;
  workspaceFolders: string[];
  sidebarVisible: boolean;
  /** "folders" or "functions" */
  sidebarTab: string;
}

export const DEFAULTS: Settings = {
  theme: "system",
  fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
  fontSize: 14,
  previewFontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  previewMaxWidth: 980,
  tabSize: 4,
  insertSpaces: true,
  wordWrap: false,
  lineNumbers: true,
  highlightActiveLine: true,
  indentationMarkers: true,
  bracketMatching: true,
  autoCloseBrackets: true,
  defaultEol: "CRLF",
  defaultEncoding: "UTF-8",
  livePreviewDefault: true,
  restoreSession: true,
  trimTrailingOnSave: false,
  ensureFinalNewline: false,
  pagedWindowLines: 3000,
  showMenuBar: true,
  autoReloadExternal: true,
  language: "system",
  checkUpdates: true,
  lastUpdateCheck: 0,
  keymapPreset: "nax",
  keyOverrides: {},
  findHistory: [],
  replaceHistory: [],
  recentFiles: [],
  macros: [],
  showWhitespace: false,
  showEol: false,
  detectIndent: true,
  syncScroll: false,
  workspaceFolders: [],
  sidebarVisible: false,
  sidebarTab: "folders",
};

/**
 * Keys that hold the user's data rather than preferences. "Reset to defaults" keeps them and
 * they are not part of a settings export unless noted in `EXPORT_DATA_KEYS`.
 */
export const DATA_KEYS: (keyof Settings)[] = ["keymapPreset", "keyOverrides", "findHistory", "replaceHistory", "recentFiles", "macros", "workspaceFolders", "lastUpdateCheck"];

/** Data keys that a settings export includes (shortcuts and macros, not history). */
export const EXPORT_DATA_KEYS: (keyof Settings)[] = ["keymapPreset", "keyOverrides", "macros"];

/** Keep only known keys whose value has the same type as the default. */
export function validSettings(raw: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = raw[k];
    const d = DEFAULTS[k];
    if (v === undefined || v === null || typeof v !== typeof d || Array.isArray(v) !== Array.isArray(d)) continue;
    out[k] = v;
  }
  return out as Partial<Settings>;
}

export const settings: Settings = { ...DEFAULTS };

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();

export function onSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await backend.settingsLoad();
    Object.assign(settings, validSettings(raw));
  } catch (e) {
    console.warn("settings load failed", e);
  }
  return settings;
}

let saveTimer: number | undefined;
/** Change settings and save them. `silent` skips the change listeners (for data keys). */
export function updateSettings(patch: Partial<Settings>, opts: { silent?: boolean } = {}): void {
  Object.assign(settings, patch);
  if (!opts.silent) for (const fn of listeners) fn(settings);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    backend.settingsSave({ ...settings } as unknown as Record<string, unknown>).catch((e) => console.warn("settings save failed", e));
  }, 300);
}
