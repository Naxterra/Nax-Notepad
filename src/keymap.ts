// Keyboard presets, user overrides, chord parsing and conflict detection.
// Chords are written like "Ctrl+Shift+K", "Alt+Shift+ArrowUp" or "F2"; a two-step chord is
// two of those separated by a space.

export type KeymapPreset = "nax" | "npp";

/**
 * Keys that differ from the Nax-Notepad defaults in the Notepad++ preset. An empty string
 * removes the key, so the preset itself has no conflicts.
 */
export const NPP_KEYS: Record<string, string> = {
  "file.saveAs": "Ctrl+Alt+S",
  "file.saveAll": "Ctrl+Shift+S",
  "edit.selectLine": "",
  "edit.cutLine": "Ctrl+L",
  "edit.deleteLine": "Ctrl+Shift+L",
  "edit.transposeLine": "Ctrl+T",
  "edit.moveLineUp": "Ctrl+Shift+ArrowUp",
  "edit.moveLineDown": "Ctrl+Shift+ArrowDown",
  "edit.toggleComment": "Ctrl+Q",
  "edit.lineComment": "Ctrl+K",
  "edit.lineUncomment": "Ctrl+Shift+K",
  "edit.blockComment": "Ctrl+Shift+Q",
  "edit.matchBracket": "Ctrl+B",
  "edit.joinLines": "Ctrl+J",
  "md.bold": "",
  "md.link": "",
  "md.quote": "",
  "help.palette": "Ctrl+Alt+Shift+P",
  "macro.play": "Ctrl+Shift+P",
};

export const PRESETS: { id: KeymapPreset; label: string }[] = [
  { id: "nax", label: "Nax-Notepad" },
  { id: "npp", label: "Notepad++" },
];

export interface Bindable {
  id: string;
  /** Key of the command in the Nax-Notepad preset. */
  defaultKey?: string;
  key?: string;
  native?: boolean;
}

/** Key of a command for a preset and the user's overrides ("" or undefined = none). */
export function effectiveKey(c: Bindable, preset: string, overrides: Record<string, string> = {}): string | undefined {
  if (c.native) return c.defaultKey;
  overrides = overrides ?? {};
  let k = c.defaultKey;
  if (preset === "npp" && c.id in NPP_KEYS) k = NPP_KEYS[c.id];
  if (Object.prototype.hasOwnProperty.call(overrides, c.id)) k = overrides[c.id];
  return k ? k : undefined;
}

/** Set `key` on every command from the preset and overrides. */
export function applyKeymap(cmds: Bindable[], preset: string, overrides: Record<string, string>): void {
  for (const c of cmds) c.key = effectiveKey(c, preset, overrides);
}

export interface ParsedKey {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const KEY_ALIASES: Record<string, string> = { esc: "escape", del: "delete", ins: "insert", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", " ": "space", plus: "+" };

export function parseChord(s: string): ParsedKey {
  const parts = s.split("+");
  let key = parts.pop()!;
  if (key === "" && parts.length && parts[parts.length - 1] === "") {
    parts.pop(); // "Ctrl++"
    key = "+";
  }
  key = key.toLowerCase();
  key = KEY_ALIASES[key] ?? key;
  const mods = parts.map((p) => p.toLowerCase());
  return { ctrl: mods.includes("ctrl"), shift: mods.includes("shift"), alt: mods.includes("alt"), key };
}

/** Canonical text of a chord sequence, for comparing keys written in different ways. */
export function normalizeChord(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((part) => {
      const p = parseChord(part);
      return (p.ctrl ? "ctrl+" : "") + (p.alt ? "alt+" : "") + (p.shift ? "shift+" : "") + p.key;
    })
    .join(" ");
}

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  getModifierState?: (k: string) => boolean;
}

/**
 * The letter of a letter key as the keyboard layout labels it: AZERTY's A key (physical KeyQ)
 * is "a". Layouts without Latin letters (Cyrillic, Greek, ...) fall back to the physical key,
 * so Ctrl+C still copies there. Null when the key is not a letter key, including a key that
 * sits where a letter is on US keyboards but types punctuation (AZERTY's "," on KeyM).
 */
export function letterOf(e: KeyLike): string | null {
  const k = e.key ?? "";
  if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase();
  if (k.length === 1 && !/^\p{L}$/u.test(k)) return null;
  const code = e.code ?? "";
  return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : null;
}

/** Key name of an event: letters as the layout labels them (like the menus), digits and punctuation by position. */
export function eventKey(e: KeyLike): string {
  const code = e.code ?? "";
  const letter = letterOf(e);
  if (letter) return letter;
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad") && /^Numpad\d$/.test(code)) return code.slice(6);
  if (code === "Equal") return "=";
  if (code === "Minus") return "-";
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Slash") return "/";
  if (code === "Backslash") return "\\";
  if (code === "Semicolon") return ";";
  if (code === "Quote") return "'";
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Backquote") return "`";
  if (code === "Space") return "space";
  return e.key.toLowerCase();
}

/** AltGr (Ctrl+Alt on Windows) types characters such as { } [ ] @ € on many layouts. */
export function isAltGr(e: KeyLike): boolean {
  return !!e.getModifierState?.("AltGraph");
}

export function matchesKey(p: ParsedKey, e: KeyLike): boolean {
  if (isAltGr(e) && p.ctrl && p.alt) return false;
  return p.ctrl === (e.ctrlKey || !!e.metaKey) && p.shift === e.shiftKey && p.alt === e.altKey && p.key === eventKey(e);
}

const NAMED: Record<string, string> = {
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  delete: "Delete",
  backspace: "Backspace",
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  space: "Space",
};

/** Chord text for a key event ("Ctrl+Shift+K"), or null for a lone modifier. */
export function chordFromEvent(e: KeyLike): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Process", "Unidentified"].includes(e.key)) return null;
  const k = eventKey(e);
  let name: string;
  if (NAMED[k]) name = NAMED[k];
  else if (/^f\d{1,2}$/.test(k)) name = k.toUpperCase();
  else if (k.length === 1) name = k.toUpperCase();
  else name = k.charAt(0).toUpperCase() + k.slice(1);
  const altGr = isAltGr(e);
  return (e.ctrlKey && !altGr ? "Ctrl+" : "") + (e.altKey && !altGr ? "Alt+" : "") + (e.shiftKey ? "Shift+" : "") + name;
}

/** Groups of command ids that share a key (only groups with more than one command). */
export function findConflicts(bindings: { id: string; key?: string }[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const b of bindings) {
    if (!b.key) continue;
    const n = normalizeChord(b.key);
    if (!byKey.has(n)) byKey.set(n, []);
    byKey.get(n)!.push(b.id);
  }
  for (const [k, ids] of [...byKey]) if (ids.length < 2) byKey.delete(k);
  return byKey;
}

/** Display form of a chord in the UI language (Strg/Umschalt in German). */
export function displayChord(key: string, lang: string): string {
  if (lang !== "de") return key;
  return key
    .split(" ")
    .map((c) =>
      c
        .split("+")
        .map((p) => ({ Ctrl: "Strg", Shift: "Umschalt", ArrowUp: "Pfeil↑", ArrowDown: "Pfeil↓", ArrowLeft: "Pfeil←", ArrowRight: "Pfeil→", Delete: "Entf", Insert: "Einfg", PageUp: "Bild↑", PageDown: "Bild↓", Home: "Pos1", End: "Ende", Space: "Leertaste", Enter: "Eingabe", Escape: "Esc" })[p] ?? p)
        .join("+")
    )
    .join(" ");
}
