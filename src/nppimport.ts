// Reads a reviewed subset of Notepad++ configuration: editor settings (config.xml), open files
// and unsaved "new N" documents (session.xml), keyboard shortcuts and macros (shortcuts.xml).
// Everything that cannot be mapped is reported instead of being guessed.
import { MacroStep } from "./macros";

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  /** Raw inner XML (empty for self-closing elements). */
  inner: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "quot") return '"';
    if (l === "apos") return "'";
    const code = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
  return out;
}

/** All elements named `name` (not nested in each other), with attributes and inner XML. */
export function elements(xml: string, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const re = new RegExp(`<${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    if (m[2] === "/") {
      out.push({ name, attrs, inner: "" });
      continue;
    }
    const close = xml.indexOf(`</${name}>`, re.lastIndex);
    const end = close < 0 ? xml.length : close;
    out.push({ name, attrs, inner: xml.slice(re.lastIndex, end) });
    re.lastIndex = close < 0 ? xml.length : close + name.length + 3;
  }
  return out;
}

// ---- config.xml ----------------------------------------------------------------------------

export interface SettingChange {
  key: string;
  value: unknown;
  /** Human readable description, e.g. "Tab size: 4". */
  label: string;
}

const NPP_ENCODINGS: Record<string, string> = { "0": "windows-1252", "1": "UTF-8-BOM", "2": "UTF-16BE", "3": "UTF-16LE", "4": "UTF-8" };
const NPP_EOL: Record<string, string> = { "0": "CRLF", "1": "CR", "2": "LF" };

export function parseConfig(xml: string): SettingChange[] {
  const out: SettingChange[] = [];
  const gui = new Map(elements(xml, "GUIConfig").map((e) => [e.attrs.name ?? "", e]));
  const tab = gui.get("TabSetting");
  if (tab) {
    const size = Number(tab.attrs.size);
    if (size >= 1 && size <= 16) out.push({ key: "tabSize", value: size, label: `Tab size: ${size}` });
    if (tab.attrs.replaceBySpace) out.push({ key: "insertSpaces", value: tab.attrs.replaceBySpace === "yes", label: `Insert spaces: ${tab.attrs.replaceBySpace}` });
  }
  const view = gui.get("ScintillaPrimaryView");
  if (view) {
    const flag = (attr: string, key: string, label: string, on = "show") => {
      const v = view.attrs[attr];
      if (v !== undefined) out.push({ key, value: v === on || v === "yes", label: `${label}: ${v}` });
    };
    flag("lineNumberMargin", "lineNumbers", "Line numbers");
    flag("currentLineHilitingShow", "highlightActiveLine", "Highlight current line");
    flag("Wrap", "wordWrap", "Word wrap", "yes");
    flag("whiteSpaceShow", "showWhitespace", "Show whitespace");
    flag("eolShow", "showEol", "Show line endings");
    flag("indentGuideLine", "indentationMarkers", "Indentation guides");
  }
  const nd = gui.get("NewDocDefaultSettings");
  if (nd) {
    const eol = NPP_EOL[nd.attrs.format ?? ""];
    if (eol) out.push({ key: "defaultEol", value: eol, label: `Line endings for new files: ${eol}` });
    const enc = NPP_ENCODINGS[nd.attrs.encoding ?? ""];
    if (enc) out.push({ key: "defaultEncoding", value: enc, label: `Encoding for new files: ${enc}` });
  }
  return out;
}

// ---- session.xml ---------------------------------------------------------------------------

export interface SessionFile {
  path: string;
  /** 0 = main view, 1 = second view. */
  view: 0 | 1;
  /** Notepad++ keeps a copy of unsaved text here (only with session snapshots enabled). */
  backup: string | null;
  /** True for an unsaved "new N" document. */
  untitled: boolean;
  line: number;
}

export function parseSession(xml: string): SessionFile[] {
  const out: SessionFile[] = [];
  const views: [string, 0 | 1][] = [
    ["mainView", 0],
    ["subView", 1],
  ];
  for (const [tag, view] of views) {
    for (const v of elements(xml, tag)) {
      for (const f of elements(v.inner, "File")) {
        const path = f.attrs.filename ?? "";
        if (!path) continue;
        const untitled = !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
        out.push({ path, view, backup: f.attrs.backupFilePath || null, untitled, line: Number(f.attrs.firstVisibleLine) || 0 });
      }
    }
  }
  return out;
}

// ---- shortcuts.xml -------------------------------------------------------------------------

/** Notepad++ menu command ids (IDM_*) that have a Nax-Notepad equivalent. */
export const NPP_COMMANDS: Record<number, string> = {
  41001: "file.new",
  41002: "file.open",
  41003: "file.close",
  41004: "file.closeAll",
  41005: "file.closeOthers",
  41006: "file.save",
  41007: "file.saveAll",
  41008: "file.saveAs",
  41011: "file.exit",
  42001: "edit.cut",
  42002: "edit.copy",
  42003: "edit.undo",
  42004: "edit.redo",
  42005: "edit.paste",
  42007: "edit.selectAll",
  42010: "edit.duplicateLine",
  42011: "edit.transposeLine",
  42013: "edit.joinLines",
  42014: "edit.moveLineUp",
  42015: "edit.moveLineDown",
  42016: "edit.upper",
  42017: "edit.lower",
  42022: "edit.toggleComment",
  42024: "edit.trim",
  42055: "edit.removeEmpty",
  43001: "search.find",
  43002: "search.next",
  43003: "search.replace",
  43004: "search.goto",
  43005: "bookmark.toggle",
  43006: "bookmark.next",
  43007: "bookmark.prev",
  43008: "bookmark.clear",
  43009: "edit.matchBracket",
  43010: "search.prev",
  44022: "view.wrap",
  44023: "view.zoomIn",
  44024: "view.zoomOut",
  44025: "view.whitespace",
  44026: "view.eol",
};

/** Scintilla messages used in recorded macros, as keys or commands. */
const SCI_KEYS: Record<number, { key: string; code?: string; ctrl?: boolean; shift?: boolean } | string> = {
  2300: { key: "ArrowDown" },
  2301: { key: "ArrowDown", shift: true },
  2302: { key: "ArrowUp" },
  2303: { key: "ArrowUp", shift: true },
  2304: { key: "ArrowLeft" },
  2305: { key: "ArrowLeft", shift: true },
  2306: { key: "ArrowRight" },
  2307: { key: "ArrowRight", shift: true },
  2308: { key: "ArrowLeft", ctrl: true },
  2309: { key: "ArrowLeft", ctrl: true, shift: true },
  2310: { key: "ArrowRight", ctrl: true },
  2311: { key: "ArrowRight", ctrl: true, shift: true },
  2312: { key: "Home" },
  2313: { key: "Home", shift: true },
  2314: { key: "End" },
  2315: { key: "End", shift: true },
  2316: { key: "Home", ctrl: true },
  2317: { key: "Home", ctrl: true, shift: true },
  2318: { key: "End", ctrl: true },
  2319: { key: "End", ctrl: true, shift: true },
  2320: { key: "PageUp" },
  2321: { key: "PageUp", shift: true },
  2322: { key: "PageDown" },
  2323: { key: "PageDown", shift: true },
  2326: { key: "Backspace" },
  2327: { key: "Tab" },
  2328: { key: "Tab", shift: true },
  2329: { key: "Enter" },
  2331: { key: "Home" },
  2332: { key: "Home", shift: true },
  2335: { key: "Backspace", ctrl: true },
  2336: { key: "Delete", ctrl: true },
  2180: { key: "Delete" },
  2177: "edit.cut",
  2178: "edit.copy",
  2179: "edit.paste",
  2176: "edit.undo",
  2011: "edit.redo",
  2013: "edit.selectAll",
  2337: "edit.cutLine",
  2338: "edit.deleteLine",
  2339: "edit.transposeLine",
  2340: "edit.lower",
  2341: "edit.upper",
  2404: "edit.duplicateLine",
  2469: "edit.duplicateLine",
};

const KEY_CODES: Record<string, string> = {
  ArrowDown: "ArrowDown",
  ArrowUp: "ArrowUp",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Backspace: "Backspace",
  Tab: "Tab",
  Enter: "Enter",
  Delete: "Delete",
};

/** Windows virtual-key code to a chord key name. */
export function vkName(vk: number): string | null {
  if (vk >= 65 && vk <= 90) return String.fromCharCode(vk);
  if (vk >= 48 && vk <= 57) return String.fromCharCode(vk);
  if (vk >= 112 && vk <= 123) return `F${vk - 111}`;
  if (vk >= 96 && vk <= 105) return String(vk - 96);
  const named: Record<number, string> = {
    8: "Backspace",
    9: "Tab",
    13: "Enter",
    27: "Escape",
    32: "Space",
    33: "PageUp",
    34: "PageDown",
    35: "End",
    36: "Home",
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    45: "Insert",
    46: "Delete",
    186: ";",
    187: "=",
    188: ",",
    189: "-",
    190: ".",
    191: "/",
    192: "`",
    219: "[",
    220: "\\",
    221: "]",
    222: "'",
  };
  return named[vk] ?? null;
}

/** Chord text from Notepad++ shortcut attributes, "" for "no shortcut", null if unknown. */
export function chordFromAttrs(a: Record<string, string>): string | null {
  const vk = Number(a.Key);
  if (!vk) return "";
  const name = vkName(vk);
  if (!name) return null;
  return (a.Ctrl === "yes" ? "Ctrl+" : "") + (a.Alt === "yes" ? "Alt+" : "") + (a.Shift === "yes" ? "Shift+" : "") + name;
}

export interface ImportedShortcut {
  nppId: number;
  commandId: string | null;
  key: string | null;
}

export interface ImportedMacro {
  name: string;
  key: string | null;
  steps: MacroStep[] | null;
  /** Why the macro cannot be imported (steps is null). */
  problem?: string;
}

export function parseShortcuts(xml: string): { shortcuts: ImportedShortcut[]; macros: ImportedMacro[] } {
  const shortcuts: ImportedShortcut[] = [];
  for (const sec of elements(xml, "InternalCommands")) {
    for (const s of elements(sec.inner, "Shortcut")) {
      const nppId = Number(s.attrs.id);
      shortcuts.push({ nppId, commandId: NPP_COMMANDS[nppId] ?? null, key: chordFromAttrs(s.attrs) });
    }
  }
  const macros: ImportedMacro[] = [];
  for (const sec of elements(xml, "Macros")) {
    for (const m of elements(sec.inner, "Macro")) {
      const name = m.attrs.name ?? "Macro";
      const key = chordFromAttrs(m.attrs);
      const conv = convertActions(elements(m.inner, "Action").map((a) => a.attrs));
      macros.push({ name, key: key || null, steps: conv.steps, problem: conv.problem });
    }
  }
  return { shortcuts, macros };
}

/** Convert recorded Notepad++ actions; any unsupported action rejects the whole macro. */
export function convertActions(actions: Record<string, string>[]): { steps: MacroStep[] | null; problem?: string } {
  const steps: MacroStep[] = [];
  for (const a of actions) {
    const type = Number(a.type);
    const msg = Number(a.message);
    if (type === 1 && msg === 2170) {
      // SCI_REPLACESEL: typed text
      const text = a.sParam ?? "";
      const last = steps[steps.length - 1];
      if (last?.type === "text") last.text += text;
      else steps.push({ type: "text", text });
      continue;
    }
    if (type === 0 || type === 1) {
      const m = SCI_KEYS[msg];
      if (m === undefined) return { steps: null, problem: `Scintilla message ${msg}` };
      if (typeof m === "string") steps.push({ type: "cmd", id: m });
      else {
        const step: MacroStep = { type: "key", key: m.key, code: KEY_CODES[m.key] ?? m.key };
        if (m.ctrl) step.ctrl = true;
        if (m.shift) step.shift = true;
        steps.push(step);
      }
      continue;
    }
    if (type === 2) {
      const id = NPP_COMMANDS[Number(a.wParam)];
      if (!id) return { steps: null, problem: `menu command ${a.wParam}` };
      steps.push({ type: "cmd", id });
      continue;
    }
    return { steps: null, problem: type === 3 ? "search/replace action" : `action type ${a.type}` };
  }
  if (!steps.length) return { steps: null, problem: "empty" };
  return { steps };
}
