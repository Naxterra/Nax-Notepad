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
import { t } from "./i18n";
import { checkForUpdates, ISSUES_URL, REPO_URL } from "./update";
import { openUrl } from "@tauri-apps/plugin-opener";
import { insertCodeBlock, insertHorizontalRule, insertLink, insertTable, setHeading, toggleInline, toggleLinePrefix } from "./markdown";
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

export function buildCommands(app: App, find: FindPanel, extras: { toggleMenuBar: () => void; about: () => void; hexGoto?: () => boolean }): Command[] {
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
    { id: "file.new", title: t("New"), key: "Ctrl+N", category: t("File"), run: () => app.newTab() },
    { id: "file.open", title: t("Open…"), key: "Ctrl+O", category: t("File"), run: () => app.openDialog() },
    { id: "file.save", title: t("Save"), key: "Ctrl+S", category: t("File"), run: () => app.active && app.save(app.active) },
    { id: "file.saveAs", title: t("Save As…"), key: "Ctrl+Shift+S", category: t("File"), run: () => app.active && app.saveAs(app.active) },
    { id: "file.saveAll", title: t("Save All"), key: "Ctrl+Alt+S", category: t("File"), run: () => app.saveAll() },
    { id: "file.reload", title: t("Reload from Disk"), category: t("File"), run: () => app.active && app.reload(app.active) },
    { id: "file.close", title: t("Close Tab"), key: "Ctrl+W", category: t("File"), run: () => app.active && app.closeTab(app.active) },
    { id: "file.closeAll", title: t("Close All Tabs"), key: "Ctrl+Shift+W", category: t("File"), run: () => app.closeAll() },
    { id: "file.closeOthers", title: t("Close Other Tabs"), category: t("File"), run: () => app.active && app.closeOthers(app.active) },
    { id: "file.exit", title: t("Exit"), key: "Alt+F4", category: t("File"), run: () => getCurrentWindow().close() },
    // Edit
    { id: "edit.undo", title: t("Undo"), key: "Ctrl+Z", category: t("Edit"), run: () => undo(v()) },
    { id: "edit.redo", title: t("Redo"), key: "Ctrl+Y", category: t("Edit"), run: () => redo(v()) },
    { id: "edit.cut", title: t("Cut"), key: "Ctrl+X", category: t("Edit"), run: () => document.execCommand("cut") },
    { id: "edit.copy", title: t("Copy"), key: "Ctrl+C", category: t("Edit"), run: () => document.execCommand("copy") },
    { id: "edit.paste", title: t("Paste"), key: "Ctrl+V", category: t("Edit"), run: () => document.execCommand("paste") },
    { id: "edit.selectAll", title: t("Select All"), key: "Ctrl+A", category: t("Edit"), run: () => selectAll(v()) },
    { id: "edit.selectLine", title: t("Select Line"), key: "Ctrl+L", category: t("Edit"), run: () => selectLine(v()) },
    { id: "edit.duplicateLine", title: t("Duplicate Line"), key: "Ctrl+D", category: t("Edit"), run: () => copyLineDown(v()) },
    { id: "edit.deleteLine", title: t("Delete Line"), key: "Ctrl+Shift+K", category: t("Edit"), run: () => deleteLine(v()) },
    { id: "edit.moveLineUp", title: t("Move Line Up"), key: "Alt+ArrowUp", category: t("Edit"), run: () => moveLineUp(v()) },
    { id: "edit.moveLineDown", title: t("Move Line Down"), key: "Alt+ArrowDown", category: t("Edit"), run: () => moveLineDown(v()) },
    { id: "edit.toggleComment", title: t("Toggle Line Comment"), key: "Ctrl+/", category: t("Edit"), run: () => toggleComment(v()) },
    { id: "edit.indent", title: t("Indent"), category: t("Edit"), run: () => indentMore(v()) },
    { id: "edit.outdent", title: t("Outdent"), category: t("Edit"), run: () => indentLess(v()) },
    { id: "edit.upper", title: t("UPPERCASE"), key: "Ctrl+Shift+U", category: t("Edit"), run: () => transformSelection((s) => s.toUpperCase()) },
    { id: "edit.lower", title: t("lowercase"), key: "Ctrl+U", category: t("Edit"), run: () => transformSelection((s) => s.toLowerCase()) },
    { id: "edit.title", title: t("Title Case"), category: t("Edit"), run: () => transformSelection((s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())) },
    { id: "edit.sortAsc", title: t("Sort Lines Ascending"), category: t("Edit"), run: () => transformLines((l) => [...l].sort((a, b) => a.localeCompare(b))) },
    { id: "edit.sortDesc", title: t("Sort Lines Descending"), category: t("Edit"), run: () => transformLines((l) => [...l].sort((a, b) => b.localeCompare(a))) },
    { id: "edit.sortNum", title: t("Sort Lines Numerically"), category: t("Edit"), run: () => transformLines((l) => [...l].sort((a, b) => parseFloat(a) - parseFloat(b))) },
    { id: "edit.dedupe", title: t("Remove Duplicate Lines"), category: t("Edit"), run: () => transformLines((l) => [...new Set(l)]) },
    { id: "edit.removeEmpty", title: t("Remove Empty Lines"), category: t("Edit"), run: () => transformLines((l) => l.filter((x) => x.trim() !== "")) },
    { id: "edit.reverse", title: t("Reverse Lines"), category: t("Edit"), run: () => transformLines((l) => [...l].reverse()) },
    { id: "edit.trim", title: t("Trim Trailing Whitespace"), category: t("Edit"), run: () => transformLines((l) => l.map((x) => x.replace(/[ \t]+$/, ""))) },
    { id: "edit.tabsToSpaces", title: t("Convert Tabs to Spaces"), category: t("Edit"), run: () => transformLines((l) => l.map((x) => x.replace(/\t/g, " ".repeat(settings.tabSize)))) },
    { id: "edit.spacesToTabs", title: t("Convert Leading Spaces to Tabs"), category: t("Edit"), run: () => transformLines((l) => l.map((x) => x.replace(/^( +)/, (m) => "\t".repeat(Math.floor(m.length / settings.tabSize)) + " ".repeat(m.length % settings.tabSize)))) },
    { id: "edit.insertDate", title: t("Insert Date/Time"), key: "F5", category: t("Edit"), run: () => v().dispatch(v().state.replaceSelection(new Date().toLocaleString())) },
    { id: "edit.matchBracket", title: t("Go to Matching Bracket"), key: "Ctrl+Shift+B", category: t("Edit"), run: () => cursorMatchingBracket(v()) },
    { id: "edit.fold", title: t("Fold"), key: "Ctrl+Shift+[", category: t("Edit"), run: () => foldCode(v()) },
    { id: "edit.unfold", title: t("Unfold"), key: "Ctrl+Shift+]", category: t("Edit"), run: () => unfoldCode(v()) },
    { id: "edit.foldAll", title: t("Fold All"), category: t("Edit"), run: () => foldAll(v()) },
    { id: "edit.unfoldAll", title: t("Unfold All"), category: t("Edit"), run: () => unfoldAll(v()) },
    // Search
    { id: "search.find", title: t("Find…"), key: "Ctrl+F", category: t("Search"), run: () => find.open("find") },
    { id: "search.replace", title: t("Replace…"), key: "Ctrl+H", category: t("Search"), run: () => find.open("replace") },
    { id: "search.findInFiles", title: t("Find in Files…"), key: "Ctrl+Shift+F", category: t("Search"), run: () => find.open("files") },
    { id: "search.next", title: t("Find Next"), key: "F3", category: t("Search"), run: () => find.next() },
    { id: "search.prev", title: t("Find Previous"), key: "Shift+F3", category: t("Search"), run: () => find.prev() },
    {
      id: "search.goto",
      title: t("Go to Line…"),
      key: "Ctrl+G",
      category: t("Search"),
      run: async () => {
        if (extras.hexGoto && extras.hexGoto()) return;
        const c = app.cursorInfo();
        const r = await prompt(t("Go to line"), t("Line number (1 – {max}):", { max: c.totalLines.toLocaleString() }), String(c.line));
        if (r === null) return;
        const m = /^\s*(\d+)(?:\s*[:,]\s*(\d+))?/.exec(r);
        if (m) await app.gotoLine(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0);
      },
    },
    // View
    { id: "view.wrap", title: t("Toggle Word Wrap"), key: "Alt+Z", category: t("View"), run: () => updateSettings({ wordWrap: !settings.wordWrap }) },
    { id: "view.lineNumbers", title: t("Toggle Line Numbers"), category: t("View"), run: () => updateSettings({ lineNumbers: !settings.lineNumbers }) },
    { id: "view.livePreview", title: t("Toggle Markdown Live Preview"), key: "Ctrl+Shift+V", category: t("View"), run: () => app.active && app.toggleLivePreview(app.active) },
    { id: "view.zoomIn", title: t("Zoom In"), key: "Ctrl+=", category: t("View"), run: () => updateSettings({ fontSize: Math.min(72, settings.fontSize + 1) }) },
    { id: "view.zoomOut", title: t("Zoom Out"), key: "Ctrl+-", category: t("View"), run: () => updateSettings({ fontSize: Math.max(6, settings.fontSize - 1) }) },
    { id: "view.zoomReset", title: t("Reset Zoom"), key: "Ctrl+0", category: t("View"), run: () => updateSettings({ fontSize: 14 }) },
    { id: "view.menuBar", title: t("Toggle Menu Bar"), category: t("View"), run: () => extras.toggleMenuBar() },
    { id: "view.hexView", title: t("Toggle Hex View"), key: "Ctrl+Shift+H", category: t("View"), run: () => app.active && app.toggleHexView(app.active) },
    // Markdown formatting
    { id: "md.bold", title: t("Bold"), key: "Ctrl+B", category: t("Markdown"), run: () => toggleInline(v(), "**") },
    { id: "md.italic", title: t("Italic"), key: "Ctrl+I", category: t("Markdown"), run: () => toggleInline(v(), "*") },
    { id: "md.strike", title: t("Strikethrough"), key: "Ctrl+Shift+X", category: t("Markdown"), run: () => toggleInline(v(), "~~") },
    { id: "md.code", title: t("Inline Code"), key: "Ctrl+`", category: t("Markdown"), run: () => toggleInline(v(), "`") },
    { id: "md.highlight", title: t("Highlight"), category: t("Markdown"), run: () => toggleInline(v(), "==") },
    { id: "md.h1", title: t("Heading 1"), key: "Ctrl+Alt+1", category: t("Markdown"), run: () => setHeading(v(), 1) },
    { id: "md.h2", title: t("Heading 2"), key: "Ctrl+Alt+2", category: t("Markdown"), run: () => setHeading(v(), 2) },
    { id: "md.h3", title: t("Heading 3"), key: "Ctrl+Alt+3", category: t("Markdown"), run: () => setHeading(v(), 3) },
    { id: "md.h4", title: t("Heading 4"), key: "Ctrl+Alt+4", category: t("Markdown"), run: () => setHeading(v(), 4) },
    { id: "md.h5", title: t("Heading 5"), key: "Ctrl+Alt+5", category: t("Markdown"), run: () => setHeading(v(), 5) },
    { id: "md.h6", title: t("Heading 6"), key: "Ctrl+Alt+6", category: t("Markdown"), run: () => setHeading(v(), 6) },
    { id: "md.h0", title: t("Remove Heading"), key: "Ctrl+Alt+0", category: t("Markdown"), run: () => setHeading(v(), 0) },
    { id: "md.bullet", title: t("Bullet List"), key: "Ctrl+Shift+8", category: t("Markdown"), run: () => toggleLinePrefix(v(), "bullet") },
    { id: "md.numbered", title: t("Numbered List"), key: "Ctrl+Shift+7", category: t("Markdown"), run: () => toggleLinePrefix(v(), "numbered") },
    { id: "md.task", title: t("Task List"), key: "Ctrl+Shift+9", category: t("Markdown"), run: () => toggleLinePrefix(v(), "task") },
    { id: "md.quote", title: t("Quote"), key: "Ctrl+Shift+Q", category: t("Markdown"), run: () => toggleLinePrefix(v(), "quote") },
    { id: "md.link", title: t("Insert Link"), key: "Ctrl+K", category: t("Markdown"), run: () => insertLink(v()) },
    { id: "md.image", title: t("Insert Image"), key: "Ctrl+Shift+I", category: t("Markdown"), run: () => insertLink(v(), true) },
    { id: "md.codeblock", title: t("Code Block"), key: "Ctrl+Alt+C", category: t("Markdown"), run: () => insertCodeBlock(v()) },
    { id: "md.table", title: t("Insert Table"), category: t("Markdown"), run: () => insertTable(v()) },
    { id: "md.hr", title: t("Horizontal Rule"), category: t("Markdown"), run: () => insertHorizontalRule(v()) },
    {
      id: "view.theme",
      title: t("Choose Theme…"),
      key: "Ctrl+Alt+T",
      category: t("View"),
      run: async () => {
        const it = await pickList(t("Theme"), [{ label: t("Follow Windows"), value: "system" }, ...THEMES.map((th) => ({ label: th.name, value: th.id, detail: th.dark ? t("dark") : t("light") }))]);
        if (it) updateSettings({ theme: it.value });
      },
    },
    { id: "view.nextTab", title: t("Next Tab"), key: "Ctrl+Tab", category: t("View"), run: () => app.nextTab(1) },
    { id: "view.prevTab", title: t("Previous Tab"), key: "Ctrl+Shift+Tab", category: t("View"), run: () => app.nextTab(-1) },
    { id: "view.pageDown", title: t("Next Tab (PgDn)"), key: "Ctrl+PageDown", category: t("View"), run: () => app.nextTab(1) },
    { id: "view.pageUp", title: t("Previous Tab (PgUp)"), key: "Ctrl+PageUp", category: t("View"), run: () => app.nextTab(-1) },
    {
      id: "view.switchTab",
      title: t("Switch to Tab…"),
      key: "Ctrl+P",
      category: t("View"),
      run: async () => {
        const it = await pickList(t("Open tabs"), app.tabs.map((tab) => ({ label: (tab.dirty ? "● " : "") + tab.name, value: tab.id, detail: tab.path ?? t("unsaved") })));
        const tab = it && app.tabs.find((x) => x.id === it.value);
        if (tab) app.activate(tab);
      },
    },
    // Settings / Help
    { id: "settings.open", title: t("Settings…"), key: "Ctrl+,", category: t("Settings"), run: () => openSettingsDialog() },
    { id: "help.palette", title: t("Command Palette…"), key: "Ctrl+Shift+P", category: t("Help"), run: () => paletteFor(cmds) },
    { id: "help.updates", title: t("Check for Updates…"), category: t("Help"), run: () => checkForUpdates(false) },
    { id: "help.github", title: t("GitHub Repository"), category: t("Help"), run: () => openUrl(REPO_URL) },
    { id: "help.issue", title: t("Report an Issue"), category: t("Help"), run: () => openUrl(ISSUES_URL) },
    { id: "help.about", title: t("About Nax-Notepad"), category: t("Help"), run: () => extras.about() },
    {
      id: "file.copyPath",
      title: t("Copy File Path"),
      category: t("File"),
      run: () => {
        if (app.active?.path) {
          void navigator.clipboard.writeText(app.active.path);
          toast(t("Path copied"));
        }
      },
    },
  ];
  for (let i = 1; i <= 9; i++) {
    cmds.push({ id: `view.tab${i}`, title: t("Go to Tab {n}", { n: i }), key: `Ctrl+${i}`, category: t("View"), run: () => app.activateIndex(i === 9 ? app.tabs.length - 1 : i - 1) });
  }
  return cmds;
}

export async function paletteFor(cmds: Command[]): Promise<void> {
  const it = await pickList(
    "",
    cmds.filter((c) => c.id !== "help.palette").map((c) => ({ label: `${c.category}: ${c.title}`, value: c.id, hint: c.key })),
    { placeholder: t("Type a command…") }
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
  if (e.code === "Backquote") return "`";
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
  if (ctrl && e.shiftKey && (k === "j" || k === "r")) return true;
  if (ctrl && !e.shiftKey && !e.altKey && k === "r") return true;
  if (k === "f5" && ctrl) return true;
  if (k === "f7") return true; // caret browsing prompt
  return false;
}
