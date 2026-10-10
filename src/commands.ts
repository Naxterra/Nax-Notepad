// Command registry: every action in the app, with title and optional default keybinding.
import {
  copyLineDown,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  selectLine,
  toggleComment,
  undo,
} from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./app";
import { settings, updateSettings } from "./settings";
import { THEMES } from "./theme";
import { pickList, prompt, toast } from "./ui/dialogs";
import { FindPanel } from "./ui/find";
import { openSettingsDialog } from "./ui/settingsdialog";

export interface Command {
  id: string;
  title: string;
  key?: string;
  category: string;
  run: () => void | Promise<unknown>;
}

export function buildCommands(app: App, find: FindPanel, extras: { toggleMenuBar: () => void; about: () => void }): Command[] {
  const v = () => app.view;
  const transformSelection = (fn: (s: string) => string) => {
    const state = v().state;
    const changes = state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to, insert: fn(state.sliceDoc(r.from, r.to)) }));
    if (changes.length) v().dispatch({ changes });
  };
  const transformLines = (fn: (lines: string[]) => string[]) => {
    const state = v().state;
    const r = state.selection.main;
    const fromLine = state.doc.lineAt(r.from);
    const toLine = state.doc.lineAt(r.empty ? r.from : Math.max(r.from, r.to - 1));
    const from = r.empty ? 0 : fromLine.from;
    const to = r.empty ? state.doc.length : toLine.to;
    const text = state.sliceDoc(from, to);
    const out = fn(text.split("\n")).join("\n");
    if (out !== text) v().dispatch({ changes: { from, to, insert: out }, selection: EditorSelection.range(from, from + out.length) });
  };

  const cmds: Command[] = [
    // File
    { id: "file.new", title: "New", key: "Ctrl+N", category: "File", run: () => app.newTab() },
    { id: "file.open", title: "Open…", key: "Ctrl+O", category: "File", run: () => app.openDialog() },
    { id: "file.save", title: "Save", key: "Ctrl+S", category: "File", run: () => app.active && app.save(app.active) },
    { id: "file.saveAs", title: "Save As…", key: "Ctrl+Shift+S", category: "File", run: () => app.active && app.saveAs(app.active) },
    { id: "file.saveAll", title: "Save All", key: "Ctrl+Alt+S", category: "File", run: () => app.saveAll() },
    { id: "file.reload", title: "Reload from Disk", category: "File", run: () => app.active && app.reload(app.active) },
    { id: "file.close", title: "Close Tab", key: "Ctrl+W", category: "File", run: () => app.active && app.closeTab(app.active) },
    { id: "file.closeAll", title: "Close All Tabs", key: "Ctrl+Shift+W", category: "File", run: () => app.closeAll() },
    { id: "file.closeOthers", title: "Close Other Tabs", category: "File", run: () => app.active && app.closeOthers(app.active) },
    { id: "file.exit", title: "Exit", key: "Alt+F4", category: "File", run: () => getCurrentWindow().close() },
    // Edit
    { id: "edit.undo", title: "Undo", key: "Ctrl+Z", category: "Edit", run: () => undo(v()) },
    { id: "edit.redo", title: "Redo", key: "Ctrl+Y", category: "Edit", run: () => redo(v()) },
    { id: "edit.cut", title: "Cut", key: "Ctrl+X", category: "Edit", run: () => document.execCommand("cut") },
    { id: "edit.copy", title: "Copy", key: "Ctrl+C", category: "Edit", run: () => document.execCommand("copy") },
    { id: "edit.paste", title: "Paste", key: "Ctrl+V", category: "Edit", run: () => document.execCommand("paste") },
    { id: "edit.selectAll", title: "Select All", key: "Ctrl+A", category: "Edit", run: () => selectAll(v()) },
    { id: "edit.selectLine", title: "Select Line", key: "Ctrl+L", category: "Edit", run: () => selectLine(v()) },
    { id: "edit.duplicateLine", title: "Duplicate Line", key: "Ctrl+D", category: "Edit", run: () => copyLineDown(v()) },
    { id: "edit.deleteLine", title: "Delete Line", key: "Ctrl+Shift+K", category: "Edit", run: () => deleteLine(v()) },
    { id: "edit.moveLineUp", title: "Move Line Up", key: "Alt+ArrowUp", category: "Edit", run: () => moveLineUp(v()) },
    { id: "edit.moveLineDown", title: "Move Line Down", key: "Alt+ArrowDown", category: "Edit", run: () => moveLineDown(v()) },
    { id: "edit.toggleComment", title: "Toggle Line Comment", key: "Ctrl+/", category: "Edit", run: () => toggleComment(v()) },
    { id: "edit.indent", title: "Indent", category: "Edit", run: () => indentMore(v()) },
    { id: "edit.outdent", title: "Outdent", category: "Edit", run: () => indentLess(v()) },
    { id: "edit.upper", title: "UPPERCASE", key: "Ctrl+Shift+U", category: "Edit", run: () => transformSelection((s) => s.toUpperCase()) },
    { id: "edit.lower", title: "lowercase", key: "Ctrl+U", category: "Edit", run: () => transformSelection((s) => s.toLowerCase()) },
    { id: "edit.title", title: "Title Case", category: "Edit", run: () => transformSelection((s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())) },
    { id: "edit.sortAsc", title: "Sort Lines Ascending", category: "Edit", run: () => transformLines((l) => [...l].sort((a, b) => a.localeCompare(b))) },
    { id: "edit.sortDesc", title: "Sort Lines Descending", category: "Edit", run: () => transformLines((l) => [...l].sort((a, b) => b.localeCompare(a))) },
    { id: "edit.sortNum", title: "Sort Lines Numerically", category: "Edit", run: () => transformLines((l) => [...l].sort((a, b) => parseFloat(a) - parseFloat(b))) },
    { id: "edit.dedupe", title: "Remove Duplicate Lines", category: "Edit", run: () => transformLines((l) => [...new Set(l)]) },
    { id: "edit.removeEmpty", title: "Remove Empty Lines", category: "Edit", run: () => transformLines((l) => l.filter((x) => x.trim() !== "")) },
    { id: "edit.reverse", title: "Reverse Lines", category: "Edit", run: () => transformLines((l) => [...l].reverse()) },
    { id: "edit.trim", title: "Trim Trailing Whitespace", category: "Edit", run: () => transformLines((l) => l.map((x) => x.replace(/[ \t]+$/, ""))) },
    { id: "edit.tabsToSpaces", title: "Convert Tabs to Spaces", category: "Edit", run: () => transformLines((l) => l.map((x) => x.replace(/\t/g, " ".repeat(settings.tabSize)))) },
    { id: "edit.spacesToTabs", title: "Convert Leading Spaces to Tabs", category: "Edit", run: () => transformLines((l) => l.map((x) => x.replace(/^( +)/, (m) => "\t".repeat(Math.floor(m.length / settings.tabSize)) + " ".repeat(m.length % settings.tabSize)))) },
    { id: "edit.insertDate", title: "Insert Date/Time", key: "F5", category: "Edit", run: () => v().dispatch(v().state.replaceSelection(new Date().toLocaleString())) },
    { id: "edit.matchBracket", title: "Go to Matching Bracket", key: "Ctrl+B", category: "Edit", run: () => cursorMatchingBracket(v()) },
    { id: "edit.fold", title: "Fold", key: "Ctrl+Shift+[", category: "Edit", run: () => foldCode(v()) },
    { id: "edit.unfold", title: "Unfold", key: "Ctrl+Shift+]", category: "Edit", run: () => unfoldCode(v()) },
    { id: "edit.foldAll", title: "Fold All", category: "Edit", run: () => foldAll(v()) },
    { id: "edit.unfoldAll", title: "Unfold All", category: "Edit", run: () => unfoldAll(v()) },
    // Search
    { id: "search.find", title: "Find…", key: "Ctrl+F", category: "Search", run: () => find.open("find") },
    { id: "search.replace", title: "Replace…", key: "Ctrl+H", category: "Search", run: () => find.open("replace") },
    { id: "search.findInFiles", title: "Find in Files…", key: "Ctrl+Shift+F", category: "Search", run: () => find.open("files") },
    { id: "search.next", title: "Find Next", key: "F3", category: "Search", run: () => find.next() },
    { id: "search.prev", title: "Find Previous", key: "Shift+F3", category: "Search", run: () => find.prev() },
    {
      id: "search.goto",
      title: "Go to Line…",
      key: "Ctrl+G",
      category: "Search",
      run: async () => {
        const c = app.cursorInfo();
        const r = await prompt("Go to line", `Line number (1 – ${c.totalLines.toLocaleString()}):`, String(c.line));
        if (r === null) return;
        const m = /^\s*(\d+)(?:\s*[:,]\s*(\d+))?/.exec(r);
        if (m) await app.gotoLine(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0);
      },
    },
    // View
    { id: "view.wrap", title: "Toggle Word Wrap", key: "Alt+Z", category: "View", run: () => updateSettings({ wordWrap: !settings.wordWrap }) },
    { id: "view.lineNumbers", title: "Toggle Line Numbers", category: "View", run: () => updateSettings({ lineNumbers: !settings.lineNumbers }) },
    { id: "view.livePreview", title: "Toggle Markdown Live Preview", key: "Ctrl+Shift+V", category: "View", run: () => app.active && app.toggleLivePreview(app.active) },
    { id: "view.zoomIn", title: "Zoom In", key: "Ctrl+=", category: "View", run: () => updateSettings({ fontSize: Math.min(72, settings.fontSize + 1) }) },
    { id: "view.zoomOut", title: "Zoom Out", key: "Ctrl+-", category: "View", run: () => updateSettings({ fontSize: Math.max(6, settings.fontSize - 1) }) },
    { id: "view.zoomReset", title: "Reset Zoom", key: "Ctrl+0", category: "View", run: () => updateSettings({ fontSize: 14 }) },
    { id: "view.menuBar", title: "Toggle Menu Bar", category: "View", run: () => extras.toggleMenuBar() },
    {
      id: "view.theme",
      title: "Choose Theme…",
      key: "Ctrl+K Ctrl+T",
      category: "View",
      run: async () => {
        const it = await pickList("Theme", [{ label: "Follow Windows", value: "system" }, ...THEMES.map((t) => ({ label: t.name, value: t.id, detail: t.dark ? "dark" : "light" }))]);
        if (it) updateSettings({ theme: it.value });
      },
    },
    { id: "view.nextTab", title: "Next Tab", key: "Ctrl+Tab", category: "View", run: () => app.nextTab(1) },
    { id: "view.prevTab", title: "Previous Tab", key: "Ctrl+Shift+Tab", category: "View", run: () => app.nextTab(-1) },
    { id: "view.pageDown", title: "Next Tab (PgDn)", key: "Ctrl+PageDown", category: "View", run: () => app.nextTab(1) },
    { id: "view.pageUp", title: "Previous Tab (PgUp)", key: "Ctrl+PageUp", category: "View", run: () => app.nextTab(-1) },
    {
      id: "view.switchTab",
      title: "Switch to Tab…",
      key: "Ctrl+P",
      category: "View",
      run: async () => {
        const it = await pickList("Open tabs", app.tabs.map((t) => ({ label: (t.dirty ? "● " : "") + t.name, value: t.id, detail: t.path ?? "unsaved" })));
        const t = it && app.tabs.find((x) => x.id === it.value);
        if (t) app.activate(t);
      },
    },
    // Settings / Help
    { id: "settings.open", title: "Settings…", key: "Ctrl+,", category: "Settings", run: () => openSettingsDialog() },
    { id: "help.palette", title: "Command Palette…", key: "Ctrl+Shift+P", category: "Help", run: () => paletteFor(cmds) },
    { id: "help.about", title: "About Nax-Notepad", category: "Help", run: () => extras.about() },
    {
      id: "file.copyPath",
      title: "Copy File Path",
      category: "File",
      run: () => {
        if (app.active?.path) {
          void navigator.clipboard.writeText(app.active.path);
          toast("Path copied");
        }
      },
    },
  ];
  for (let i = 1; i <= 9; i++) {
    cmds.push({ id: `view.tab${i}`, title: `Go to Tab ${i}`, key: `Ctrl+${i}`, category: "View", run: () => app.activateIndex(i === 9 ? app.tabs.length - 1 : i - 1) });
  }
  return cmds;
}

export async function paletteFor(cmds: Command[]): Promise<void> {
  const it = await pickList(
    "",
    cmds.filter((c) => c.id !== "help.palette").map((c) => ({ label: `${c.category}: ${c.title}`, value: c.id, hint: c.key })),
    { placeholder: "Type a command…" }
  );
  const c = it && cmds.find((x) => x.id === it.value);
  if (c) await c.run();
}

// ---- keybinding dispatch -------------------------------------------------------------------

interface ParsedKey {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseChord(s: string): ParsedKey {
  const parts = s.split("+");
  const key = parts.pop()!.toLowerCase();
  return {
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
    key: key === "=" ? "=" : key,
  };
}

function eventKey(e: KeyboardEvent): string {
  if (e.code.startsWith("Digit")) return e.code.slice(5);
  if (e.code === "Equal") return "=";
  if (e.code === "Minus") return "-";
  if (e.code === "Comma") return ",";
  if (e.code === "Slash") return "/";
  if (e.code === "BracketLeft") return "[";
  if (e.code === "BracketRight") return "]";
  if (e.code.startsWith("Key")) return e.code.slice(3).toLowerCase();
  return e.key.toLowerCase();
}

function matches(p: ParsedKey, e: KeyboardEvent): boolean {
  return p.ctrl === (e.ctrlKey || e.metaKey) && p.shift === e.shiftKey && p.alt === e.altKey && p.key === eventKey(e);
}

export function installKeybindings(cmds: Command[], isBlocked: () => boolean): void {
  const single: { p: ParsedKey; c: Command }[] = [];
  const chords: { first: ParsedKey; second: ParsedKey; c: Command }[] = [];
  for (const c of cmds) {
    if (!c.key) continue;
    const seq = c.key.split(" ");
    if (seq.length === 2) chords.push({ first: parseChord(seq[0]), second: parseChord(seq[1]), c });
    else single.push({ p: parseChord(c.key), c });
  }
  let pendingChord: ParsedKey | null = null;
  const sameChord = (a: ParsedKey, b: ParsedKey) => a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt") return;
      // Swallow WebView2 browser shortcuts that would reload or inspect the page.
      if (isBrowserShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (pendingChord) {
        const first = pendingChord;
        pendingChord = null;
        const hit = chords.find((ch) => sameChord(ch.first, first) && matches(ch.second, e));
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          void hit.c.run();
          return;
        }
      }
      if (isBlocked()) return;
      const target = e.target as HTMLElement;
      const inInput = target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
      for (const ch of chords) {
        if (matches(ch.first, e)) {
          pendingChord = ch.first;
          e.preventDefault();
          return;
        }
      }
      for (const { p, c } of single) {
        if (!matches(p, e)) continue;
        // Let text inputs keep their native clipboard/undo behaviour.
        if (inInput && /^(edit\.(cut|copy|paste|undo|redo|selectAll)|file\.exit)$/.test(c.id)) return;
        e.preventDefault();
        e.stopPropagation();
        void c.run();
        return;
      }
    },
    { capture: true }
  );
}

function isBrowserShortcut(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = eventKey(e);
  if (k === "f12") return true;
  if (ctrl && e.shiftKey && (k === "i" || k === "j" || k === "c" || k === "r")) return true;
  if (ctrl && !e.shiftKey && !e.altKey && k === "r") return true;
  if (k === "f5" && ctrl) return true;
  if (k === "f7") return true; // caret browsing prompt
  return false;
}
