import { backend, Eol } from "./backend";
import { LangSetting } from "./i18n";

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
};

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
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (raw[k] !== undefined && typeof raw[k] === typeof DEFAULTS[k]) {
        (settings as unknown as Record<string, unknown>)[k] = raw[k];
      }
    }
  } catch (e) {
    console.warn("settings load failed", e);
  }
  return settings;
}

let saveTimer: number | undefined;
export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  for (const fn of listeners) fn(settings);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    backend.settingsSave({ ...settings } as unknown as Record<string, unknown>).catch((e) => console.warn("settings save failed", e));
  }, 300);
}
