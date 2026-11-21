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
  /** Live Preview loads images from the internet (each load tells the server the document was opened). */
  remoteImages: boolean;
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
  /** Show the inspector beside the hex view. */
  inspectorVisible: boolean;
  /** 0 fits the available width; otherwise a fixed number of bytes in each hex row. */
  hexBytesPerRow: number;
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
  remoteImages: false,
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
  inspectorVisible: true,
  hexBytesPerRow: 0,
};

/**
 * Keys that hold the user's data rather than preferences. "Reset to defaults" keeps them and
 * they are not part of a settings export unless noted in `EXPORT_DATA_KEYS`.
 */
export const DATA_KEYS: (keyof Settings)[] = ["keymapPreset", "keyOverrides", "findHistory", "replaceHistory", "recentFiles", "macros", "workspaceFolders", "lastUpdateCheck"];

/** Data keys that a settings export includes (shortcuts and macros, not history). */
export const EXPORT_DATA_KEYS: (keyof Settings)[] = ["keymapPreset", "keyOverrides", "macros"];

const NUM_BOUNDS: Partial<Record<keyof Settings, [number, number]>> = {
  fontSize: [6, 72],
  previewMaxWidth: [0, 5000],
  tabSize: [1, 16],
  pagedWindowLines: [500, 50000],
  lastUpdateCheck: [0, Number.MAX_SAFE_INTEGER],
};

const ENUM_VALUES: Partial<Record<keyof Settings, readonly string[]>> = {
  defaultEol: ["LF", "CRLF", "CR"],
  language: ["system", "en", "de"],
  keymapPreset: ["nax", "npp"],
  sidebarTab: ["folders", "functions"],
};

const STRING_ARRAY_KEYS = new Set<keyof Settings>(["findHistory", "replaceHistory", "recentFiles", "workspaceFolders"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isValidMacroStep(s: unknown): boolean {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const o = s as Record<string, unknown>;
  if (o.type === "text") return typeof o.text === "string";
  if (o.type === "cmd") return typeof o.id === "string";
  if (o.type === "key") return typeof o.key === "string" && typeof o.code === "string";
  return false;
}

const INT_KEYS = new Set<keyof Settings>(["tabSize", "fontSize", "previewMaxWidth", "pagedWindowLines", "lastUpdateCheck"]);

/** Keep only known keys whose value has the right type, range and structure. */
export function validSettings(raw: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = raw[k];
    const d = DEFAULTS[k];
    if (v === undefined || v === null || typeof v !== typeof d || Array.isArray(v) !== Array.isArray(d)) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      if (INT_KEYS.has(k) && !Number.isInteger(v)) continue;
      if (k === "hexBytesPerRow") {
        if (![0, 16, 32, 64].includes(v)) continue;
      } else {
        const bounds = NUM_BOUNDS[k];
        if (bounds && (v < bounds[0] || v > bounds[1])) continue;
      }
    } else if (typeof v === "string") {
      const allowed = ENUM_VALUES[k];
      if (allowed && !allowed.includes(v)) continue;
    } else if (STRING_ARRAY_KEYS.has(k)) {
      if (!(v as unknown[]).every((x) => typeof x === "string")) continue;
    } else if (k === "keyOverrides") {
      const clean: Record<string, string> = {};
      for (const [okKey, okVal] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(okKey) || typeof okVal !== "string") continue;
        clean[okKey] = okVal;
      }
      out[k] = clean;
      continue;
    } else if (k === "macros") {
      const clean: Macro[] = [];
      for (const item of v as unknown[]) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const m = item as Record<string, unknown>;
        if (typeof m.name === "string" && m.name.trim() && Array.isArray(m.steps) && m.steps.every(isValidMacroStep)) {
          clean.push({ name: m.name, steps: m.steps as Macro["steps"] });
        }
      }
      out[k] = clean;
      continue;
    }
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
let settingsVersion = 0;
let savedVersion = 0;
let inFlight: Promise<void> | null = null;

function persistSettings(): Promise<void> {
  const prev = inFlight ? inFlight.catch(() => undefined) : Promise.resolve();
  const run = prev.then(async () => {
    while (savedVersion < settingsVersion) {
      const target = settingsVersion;
      await backend.settingsSave({ ...settings } as unknown as Record<string, unknown>);
      savedVersion = target;
    }
  });
  const tracked = run.then(
    () => undefined,
    () => undefined
  ).finally(() => {
    if (inFlight === tracked) inFlight = null;
  });
  inFlight = tracked;
  return run;
}

/** Change settings and save them. `silent` skips the change listeners (for data keys). */
export function updateSettings(patch: Partial<Settings>, opts: { silent?: boolean } = {}): void {
  Object.assign(settings, patch);
  settingsVersion++;
  if (!opts.silent) for (const fn of listeners) fn(settings);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    persistSettings().catch((e) => console.warn("settings save failed", e));
  }, 300);
}

/** Flush any pending or in-flight settings write before closing or reloading the window. */
export async function flushSettings(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (savedVersion < settingsVersion) {
    await persistSettings();
    return;
  }
  if (inFlight) await inFlight;
}
