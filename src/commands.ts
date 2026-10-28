// Command registry: every action in the app, with title and default keybinding, plus the
// global key dispatcher and the macro recorder.
import {
  copyLineDown,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  lineComment,
  lineUncomment,
  moveLineDown,
  moveLineUp,
  redo,
  selectLine,
  toggleBlockComment,
  toggleComment,
  undo,
} from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./app";
import { backend, Eol } from "./backend";
import { bookmarkLines, nextBookmark, setBookmarks, toggleBookmarkAt } from "./bookmarks";
import { columnSelectCommand } from "./columnselect";
import { compareField, marksFromHunks, nextDifference, setCompareMarks } from "./compare";
import { diffLines } from "./diff";
import { ENCODINGS } from "./encodings";
import { lang, t } from "./i18n";
import { detectIndent } from "./indentdetect";
import { applyKeymap, displayChord, letterOf, matchesKey, ParsedKey, parseChord } from "./keymap";
import { addStep, describeSteps, MacroStep, playSteps, stepForKey } from "./macros";
import { checkForUpdates, ISSUES_URL, REPO_URL } from "./update";
import { openUrl } from "@tauri-apps/plugin-opener";
import { insertCodeBlock, insertHorizontalRule, insertLink, insertTable, setHeading, toggleInline, toggleLinePrefix } from "./markdown";
import { settings, updateSettings } from "./settings";
import { copySelection, pasteClipboard, selectAllIn, writeClipboard } from "./clipboard";
import { THEMES } from "./theme";
import { confirmDialog, pickList, prompt, toast } from "./ui/dialogs";
import { FindPanel } from "./ui/find";
import type { HexView } from "./ui/hexview";
import { openSettingsDialog } from "./ui/settingsdialog";

export interface Command {
  id: string;
  title: string;
  key?: string;
  /** Key in the default (Nax-Notepad) preset; `key` is the effective one. */
  defaultKey?: string;
  category: string;
  run: () => unknown;
  /** The key is handled natively by the editor/inputs; it is only shown in menus. */
  native?: boolean;
  /** Toggle state shown as a check mark in menus. */
  checked?: () => boolean;
}

export interface CommandExtras {
  toggleMenuBar: () => void;
  about: () => void;
  hexGoto?: () => boolean;
  /** The hex editor of the focused pane, if it is shown. */
  hex?: () => HexView | null;
  showSidebar?: (tab: "folders" | "functions" | null) => void;
  sidebarShown?: () => string | null;
  openShortcuts?: () => void;
  nppImport?: () => void;
  exportSettings?: () => void;
  importSettings?: () => void;
  /** Called when the saved macros changed (commands must be rebuilt). */
  macrosChanged?: () => void;
  /** Called after the keyboard preset changed in Settings. */
  keymapChanged?: () => void;
}

// ---- macro recorder -------------------------------------------------------------------------

export class MacroRecorder {
  recording = false;
  steps: MacroStep[] = [];
  /** The last recorded macro. */
  last: MacroStep[] | null = null;
  private listeners = new Set<() => void>();

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }
  private changed(): void {
    for (const fn of this.listeners) fn();
  }
  start(): void {
    this.recording = true;
    this.steps = [];
    this.changed();
  }
  stop(): void {
    this.recording = false;
    if (this.steps.length) this.last = this.steps;
    this.steps = [];
    this.changed();
  }
  command(id: string): void {
    if (this.recording && !id.startsWith("macro.")) addStep(this.steps, { type: "cmd", id });
  }
  key(e: KeyboardEvent): void {
    if (!this.recording) return;
    const s = stepForKey(e);
    if (s) addStep(this.steps, s);
  }
  /** Text that an input method (IME) committed; its key presses are not recorded. */
  composed(text: string): void {
    if (this.recording && text) addStep(this.steps, { type: "text", text });
  }
}

export const recorder = new MacroRecorder();

/** Run a command, recording it into a macro that is being recorded. */
export function runCommand(c: Command): unknown {
  recorder.command(c.id);
  return c.run();
}

export function buildCommands(app: App, find: FindPanel, extras: CommandExtras): Command[] {
  const v = () => app.view;
  /** Custom edits respect read-only mode (the editor's own commands already do). */
  const writable = (): boolean => {
    if (extras.hex?.()) {
      toast(t("This works in the text view. Leave the hex view with Ctrl+Shift+H first."), 4000);
      return false;
    }
    if (!v().state.readOnly) return true;
    toast(t("This document is read-only."));
    return false;
  };
  const memoryOnly = (): boolean => {
    if (app.active?.kind !== "paged") return true;
    toast(t("This is not available for large files."));
    return false;
  };
  const transformSelection = (fn: (s: string) => string) => {
    if (!writable()) return;
    const state = v().state;
    const changes = state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to, insert: fn(state.sliceDoc(r.from, r.to)) }));
    if (changes.length) v().dispatch({ changes });
  };
  const transformLines = (fn: (lines: string[]) => string[]) => {
    if (!writable()) return;
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
  const tabSize = () => (app.active ? app.indentOf(app.active).size : settings.tabSize);

  const cutLine = async () => {
    if (!writable()) return;
    const state = v().state;
    const ranges = state.selection.ranges.map((r) => {
      const a = state.doc.lineAt(r.from);
      const b = state.doc.lineAt(r.empty ? r.to : Math.max(r.from, r.to - 1));
      return EditorSelection.range(a.from, Math.min(b.to + 1, state.doc.length));
    });
    v().dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex) });
    await copySelection(v(), true);
  };
  const transposeLine = () => {
    if (!writable()) return;
    const state = v().state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    if (line.number === 1) return;
    const prev = state.doc.line(line.number - 1);
    v().dispatch({
      changes: { from: prev.from, to: line.to, insert: line.text + "\n" + prev.text },
      selection: { anchor: prev.from + Math.min(head - line.from, line.text.length) },
      userEvent: "move.line",
    });
  };
  const joinLines = () => {
    if (!writable()) return;
    const state = v().state;
    const r = state.selection.main;
    const a = state.doc.lineAt(r.from);
    let b = state.doc.lineAt(r.empty ? r.from : Math.max(r.from, r.to - 1));
    if (a.number === b.number) {
      if (b.number === state.doc.lines) return;
      b = state.doc.line(b.number + 1);
    }
    const lines = state.sliceDoc(a.from, b.to).split("\n");
    const out = lines.map((l, i) => (i === 0 ? l.replace(/\s+$/, "") : l.trim())).filter((l, i) => i === 0 || l !== "").join(" ");
    v().dispatch({ changes: { from: a.from, to: b.to, insert: out }, selection: { anchor: a.from + out.length }, userEvent: "input" });
  };

  // ---- bookmarks ----
  const bookmarkGuard = (): boolean => {
    if (app.active?.kind === "paged") {
      toast(t("Bookmarks are not available for large files."));
      return false;
    }
    return true;
  };
  const gotoBookmark = (dir: 1 | -1) => {
    if (!bookmarkGuard()) return;
    const pos = nextBookmark(v().state, v().state.selection.main.head, dir);
    if (pos === null) {
      toast(t("No bookmarks in this document."));
      return;
    }
    v().dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  };
  const bookmarkedText = (): string[] => {
    const st = v().state;
    return bookmarkLines(st).map((n) => st.doc.line(n).text);
  };

  // ---- compare ----
  const runCompare = () => {
    const a = app.panes[0].tab;
    const b = app.panes[1].tab;
    if (!app.splitOn || !a || !b) {
      toast(t("Show two documents side by side first (Move to Other View or Clone to Other View)."), 5000);
      return;
    }
    if (a.kind === "paged" || b.kind === "paged") {
      toast(t("Large files cannot be compared."));
      return;
    }
    const va = app.panes[0].view;
    const vb = app.panes[1].view;
    const hunks = diffLines(va.state.doc.toString().split("\n"), vb.state.doc.toString().split("\n"));
    const marks = marksFromHunks(hunks);
    va.dispatch({ effects: setCompareMarks.of(marks.a) });
    vb.dispatch({ effects: setCompareMarks.of(marks.b) });
    if (!settings.syncScroll) app.setSyncScroll(true);
    toast(hunks.length ? t("{n} differences", { n: hunks.length }) : t("The documents are identical."));
    if (hunks.length) {
      const first = va.state.doc.line(Math.min(hunks[0].a0 + 1, va.state.doc.lines)).from;
      va.dispatch({ selection: { anchor: first }, effects: EditorView.scrollIntoView(first, { y: "center" }) });
    }
  };
  const gotoDifference = (dir: 1 | -1) => {
    const pos = nextDifference(v().state, v().state.selection.main.head, dir);
    if (pos === null) {
      toast(t("No differences marked. Use Compare first."));
      return;
    }
    v().dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  };
  const clearCompare = () => {
    for (const p of app.panes) if (p.view.state.field(compareField, false)?.size) p.view.dispatch({ effects: setCompareMarks.of(null) });
  };

  // ---- macros ----
  const playContext = {
    view: () => app.view,
    runCommand: (id: string) => {
      const c = cmds.find((x) => x.id === id);
      return c?.run();
    },
  };
  const play = async (steps: MacroStep[] | null, times: number | "eof") => {
    if (!steps?.length) {
      toast(t("There is no recorded macro. Record one with Ctrl+Shift+R."));
      return;
    }
    if (recorder.recording) recorder.stop();
    if (v().state.readOnly && steps.some((s) => s.type !== "cmd")) {
      toast(t("This document is read-only."));
      return;
    }
    if (times === "eof") {
      if (!memoryOnly()) return;
      for (let i = 0; i < 100000; i++) {
        const before = v().state;
        const line = before.doc.lineAt(before.selection.main.head).number;
        await playSteps(steps, playContext);
        const after = v().state;
        if (after.selection.main.head >= after.doc.length) break;
        const newLine = after.doc.lineAt(after.selection.main.head).number;
        if (!(newLine > line || after.doc.lines < before.doc.lines)) break;
      }
      return;
    }
    for (let i = 0; i < times; i++) await playSteps(steps, playContext);
  };
  const chooseMacro = async (): Promise<MacroStep[] | null> => {
    const items = [
      ...(recorder.last ? [{ label: t("Recorded macro"), value: "", detail: describeSteps(recorder.last) }] : []),
      ...settings.macros.map((m, i) => ({ label: m.name, value: String(i), detail: describeSteps(m.steps) })),
    ];
    if (!items.length) return null;
    if (items.length === 1) return items[0].value === "" ? recorder.last : settings.macros[0].steps;
    const it = await pickList(t("Macro"), items);
    if (!it) return null;
    return it.value === "" ? recorder.last : (settings.macros[Number(it.value)]?.steps ?? null);
  };

  // ---- indentation ----
  const chooseIndent = async () => {
    const tab = app.active;
    if (!tab) return;
    const it = await pickList(t("Indentation"), [
      { label: t("Detect from content"), value: "detect" },
      { label: t("Use the default from Settings"), value: "default", detail: settings.insertSpaces ? t("Spaces: {n}", { n: settings.tabSize }) : t("Tabs: {n}", { n: settings.tabSize }) },
      ...[2, 4, 8].map((n) => ({ label: t("Spaces: {n}", { n }), value: `s${n}` })),
      ...[2, 4, 8].map((n) => ({ label: t("Tabs (width {n})", { n }), value: `t${n}` })),
    ]);
    if (!it) return;
    if (it.value === "default") app.setIndent(tab, null);
    else if (it.value === "detect") {
      const info = detectIndent(app.docText(tab));
      if (!info) {
        toast(t("The indentation could not be detected."));
        return;
      }
      app.setIndent(tab, { spaces: info.spaces, size: info.size || settings.tabSize });
      toast(info.spaces ? t("Spaces: {n}", { n: info.size }) : t("Tabs"));
    } else app.setIndent(tab, { spaces: it.value[0] === "s", size: Number(it.value.slice(1)) });
  };

  const chooseEncoding = async (mode: "reopen" | "convert") => {
    const tab = app.active;
    if (!tab) return;
    const title = mode === "reopen" ? t("Reopen with Encoding") : t("Convert to Encoding (applied on save)");
    const it = await pickList(title, ENCODINGS.map((e) => ({ label: e, value: e, detail: e === app.owner(tab).encoding ? t("current") : undefined })));
    if (!it) return;
    if (mode === "reopen") await app.reopenWithEncoding(tab, it.value);
    else app.setEncoding(tab, it.value);
  };
  const eolCmd = (eol: Eol, title: string): Command => ({
    id: `eol.${eol.toLowerCase()}`,
    title,
    category: t("Encoding"),
    run: () => app.active && app.setEol(app.active, eol),
    checked: () => !!app.active && app.owner(app.active).eol === eol,
  });

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
    { id: "file.reopenClosed", title: t("Reopen Closed Tab"), key: "Ctrl+Shift+T", category: t("File"), run: () => app.reopenClosed() },
    { id: "file.clearRecent", title: t("Clear Recent Files"), category: t("File"), run: () => app.clearRecent() },
    { id: "file.exit", title: t("Exit"), key: "Alt+F4", category: t("File"), run: () => getCurrentWindow().close() },
    // Edit
    { id: "edit.undo", title: t("Undo"), key: "Ctrl+Z", native: true, category: t("Edit"), run: () => (extras.hex?.() ? extras.hex!()!.undo() : undo(v())) },
    { id: "edit.redo", title: t("Redo"), key: "Ctrl+Y", native: true, category: t("Edit"), run: () => (extras.hex?.() ? extras.hex!()!.redo() : redo(v())) },
    { id: "edit.cut", title: t("Cut"), key: "Ctrl+X", native: true, category: t("Edit"), run: () => (extras.hex?.() ? extras.hex!()!.copy(true) : copySelection(v(), true)) },
    { id: "edit.copy", title: t("Copy"), key: "Ctrl+C", native: true, category: t("Edit"), run: () => (extras.hex?.() ? extras.hex!()!.copy() : copySelection(v())) },
    { id: "edit.paste", title: t("Paste"), key: "Ctrl+V", native: true, category: t("Edit"), run: () => (extras.hex?.() ? extras.hex!()!.paste() : pasteClipboard(v())) },
    { id: "edit.selectAll", title: t("Select All"), key: "Ctrl+A", native: true, category: t("Edit"), run: () => (extras.hex?.() ? extras.hex!()!.selectAll() : selectAllIn(v())) },
    { id: "edit.selectLine", title: t("Select Line"), key: "Ctrl+L", category: t("Edit"), run: () => selectLine(v()) },
    { id: "edit.columnUp", title: t("Column Select Up"), key: "Alt+Shift+ArrowUp", category: t("Edit"), run: () => columnSelectCommand("up")(v()) },
    { id: "edit.columnDown", title: t("Column Select Down"), key: "Alt+Shift+ArrowDown", category: t("Edit"), run: () => columnSelectCommand("down")(v()) },
    { id: "edit.columnLeft", title: t("Column Select Left"), key: "Alt+Shift+ArrowLeft", category: t("Edit"), run: () => columnSelectCommand("left")(v()) },
    { id: "edit.columnRight", title: t("Column Select Right"), key: "Alt+Shift+ArrowRight", category: t("Edit"), run: () => columnSelectCommand("right")(v()) },
    { id: "edit.duplicateLine", title: t("Duplicate Line"), key: "Ctrl+D", category: t("Edit"), run: () => copyLineDown(v()) },
    { id: "edit.cutLine", title: t("Cut Line"), category: t("Edit"), run: () => cutLine() },
    { id: "edit.deleteLine", title: t("Delete Line"), key: "Ctrl+Shift+K", category: t("Edit"), run: () => deleteLine(v()) },
    { id: "edit.transposeLine", title: t("Swap Line with Previous"), category: t("Edit"), run: () => transposeLine() },
    { id: "edit.joinLines", title: t("Join Lines"), key: "Ctrl+J", category: t("Edit"), run: () => joinLines() },
    { id: "edit.moveLineUp", title: t("Move Line Up"), key: "Alt+ArrowUp", category: t("Edit"), run: () => moveLineUp(v()) },
    { id: "edit.moveLineDown", title: t("Move Line Down"), key: "Alt+ArrowDown", category: t("Edit"), run: () => moveLineDown(v()) },
    { id: "edit.toggleComment", title: t("Toggle Line Comment"), key: "Ctrl+/", category: t("Edit"), run: () => toggleComment(v()) },
    { id: "edit.lineComment", title: t("Comment Lines"), category: t("Edit"), run: () => lineComment(v()) },
    { id: "edit.lineUncomment", title: t("Uncomment Lines"), category: t("Edit"), run: () => lineUncomment(v()) },
    { id: "edit.blockComment", title: t("Toggle Block Comment"), key: "Alt+Shift+A", category: t("Edit"), run: () => toggleBlockComment(v()) },
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
    { id: "edit.tabsToSpaces", title: t("Convert Tabs to Spaces"), category: t("Edit"), run: () => transformLines((l) => l.map((x) => x.replace(/\t/g, " ".repeat(tabSize())))) },
    { id: "edit.spacesToTabs", title: t("Convert Leading Spaces to Tabs"), category: t("Edit"), run: () => transformLines((l) => l.map((x) => x.replace(/^( +)/, (m) => "\t".repeat(Math.floor(m.length / tabSize())) + " ".repeat(m.length % tabSize())))) },
    { id: "edit.indentation", title: t("Indentation of This File…"), category: t("Edit"), run: () => chooseIndent() },
    { id: "edit.insertDate", title: t("Insert Date/Time"), key: "F5", category: t("Edit"), run: () => writable() && v().dispatch(v().state.replaceSelection(new Date().toLocaleString())) },
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
    { id: "search.findAllDoc", title: t("Find All in Current Document"), category: t("Search"), run: () => find.findAll("doc") },
    { id: "search.findAllTabs", title: t("Find All in All Open Tabs"), category: t("Search"), run: () => find.findAll("tabs") },
    { id: "search.filter", title: t("Filter Lines (live)…"), key: "Ctrl+Alt+L", category: t("Search"), run: () => find.filterLines() },
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
    // Bookmarks
    { id: "bookmark.toggle", title: t("Toggle Bookmark"), key: "Ctrl+F2", category: t("Bookmarks"), run: () => bookmarkGuard() && v().dispatch({ effects: toggleBookmarkAt.of(v().state.selection.main.head) }) },
    { id: "bookmark.next", title: t("Next Bookmark"), key: "F2", category: t("Bookmarks"), run: () => gotoBookmark(1) },
    { id: "bookmark.prev", title: t("Previous Bookmark"), key: "Shift+F2", category: t("Bookmarks"), run: () => gotoBookmark(-1) },
    { id: "bookmark.clear", title: t("Clear All Bookmarks"), category: t("Bookmarks"), run: () => bookmarkGuard() && v().dispatch({ effects: setBookmarks.of([]) }) },
    {
      id: "bookmark.copyLines",
      title: t("Copy Bookmarked Lines"),
      category: t("Bookmarks"),
      run: async () => {
        if (!bookmarkGuard()) return;
        const lines = bookmarkedText();
        if (!lines.length) return toast(t("No bookmarks in this document."));
        await writeClipboard(lines.join("\n") + "\n");
        toast(t("{n} lines copied", { n: lines.length }));
      },
    },
    {
      id: "bookmark.removeLines",
      title: t("Remove Bookmarked Lines"),
      category: t("Bookmarks"),
      run: () => {
        if (!bookmarkGuard() || !writable()) return;
        const st = v().state;
        const changes = bookmarkLines(st).map((n) => {
          const l = st.doc.line(n);
          return n < st.doc.lines ? { from: l.from, to: l.to + 1 } : { from: Math.max(0, l.from - 1), to: l.to };
        });
        if (changes.length) v().dispatch({ changes, userEvent: "delete.line" });
      },
    },
    // View
    { id: "view.wrap", title: t("Word Wrap"), key: "Alt+Z", category: t("View"), run: () => updateSettings({ wordWrap: !settings.wordWrap }), checked: () => settings.wordWrap },
    { id: "view.lineNumbers", title: t("Line Numbers"), category: t("View"), run: () => updateSettings({ lineNumbers: !settings.lineNumbers }), checked: () => settings.lineNumbers },
    { id: "view.whitespace", title: t("Show Whitespace"), category: t("View"), run: () => updateSettings({ showWhitespace: !settings.showWhitespace }), checked: () => settings.showWhitespace },
    { id: "view.eol", title: t("Show Line Endings"), category: t("View"), run: () => updateSettings({ showEol: !settings.showEol }), checked: () => settings.showEol },
    { id: "view.livePreview", title: t("Markdown Live Preview"), key: "Ctrl+Shift+V", category: t("View"), run: () => app.active && app.toggleLivePreview(app.active), checked: () => !!app.active?.livePreview && app.active.languageName === "Markdown" },
    { id: "view.zoomIn", title: t("Zoom In"), key: "Ctrl+=", category: t("View"), run: () => updateSettings({ fontSize: Math.min(72, settings.fontSize + 1) }) },
    { id: "view.zoomOut", title: t("Zoom Out"), key: "Ctrl+-", category: t("View"), run: () => updateSettings({ fontSize: Math.max(6, settings.fontSize - 1) }) },
    { id: "view.zoomReset", title: t("Reset Zoom"), key: "Ctrl+0", category: t("View"), run: () => updateSettings({ fontSize: 14 }) },
    { id: "view.menuBar", title: t("Menu Bar"), category: t("View"), run: () => extras.toggleMenuBar(), checked: () => settings.showMenuBar },
    { id: "view.hexView", title: t("Hex View"), key: "Ctrl+Shift+H", category: t("View"), run: () => app.active && app.toggleHexView(app.active), checked: () => !!app.active?.hexView },
    { id: "view.sidebar", title: t("Folder Workspace"), key: "Ctrl+Shift+E", category: t("View"), run: () => extras.showSidebar?.(extras.sidebarShown?.() === "folders" ? null : "folders"), checked: () => extras.sidebarShown?.() === "folders" },
    { id: "view.functionList", title: t("Function List"), category: t("View"), run: () => extras.showSidebar?.(extras.sidebarShown?.() === "functions" ? null : "functions"), checked: () => extras.sidebarShown?.() === "functions" },
    { id: "view.moveOther", title: t("Move to Other View"), category: t("View"), run: () => app.active && app.moveToOtherView(app.active) },
    { id: "view.cloneOther", title: t("Clone to Other View"), category: t("View"), run: () => app.active && app.cloneToOtherView(app.active) },
    { id: "view.focusOther", title: t("Switch to Other View"), key: "F8", category: t("View"), run: () => app.splitOn && app.focusPane(1 - app.focused) },
    { id: "view.closeSplit", title: t("Close Split View"), category: t("View"), run: () => app.closeSplit() },
    { id: "view.syncScroll", title: t("Synchronize Scrolling"), category: t("View"), run: () => app.setSyncScroll(!settings.syncScroll), checked: () => settings.syncScroll },
    { id: "compare.run", title: t("Compare the Two Views"), category: t("View"), run: () => runCompare() },
    { id: "compare.next", title: t("Next Difference"), key: "Alt+PageDown", category: t("View"), run: () => gotoDifference(1) },
    { id: "compare.prev", title: t("Previous Difference"), key: "Alt+PageUp", category: t("View"), run: () => gotoDifference(-1) },
    { id: "compare.clear", title: t("Clear Comparison"), category: t("View"), run: () => clearCompare() },
    { id: "view.follow", title: t("Follow File Changes (tail -f)"), category: t("View"), run: () => app.active && app.toggleFollow(app.active), checked: () => !!app.active && !!app.owner(app.active).tail },
    {
      id: "view.followPause",
      title: t("Pause Following"),
      category: t("View"),
      run: () => {
        const tab = app.active && app.owner(app.active);
        if (!tab?.tail) return toast(t("This file is not being followed."));
        app.pauseFollow(tab, !tab.tail.paused);
      },
      checked: () => !!app.active && !!app.owner(app.active).tail?.paused,
    },
    // Encoding
    { id: "encoding.reopen", title: t("Reopen with Encoding…"), category: t("Encoding"), run: () => chooseEncoding("reopen") },
    { id: "encoding.convert", title: t("Convert to Encoding…"), category: t("Encoding"), run: () => chooseEncoding("convert") },
    eolCmd("CRLF", t("Windows (CRLF)")),
    eolCmd("LF", t("Unix (LF)")),
    eolCmd("CR", t("Classic Mac (CR)")),
    // Markdown formatting
    { id: "md.bold", title: t("Bold"), key: "Ctrl+B", category: t("Markdown"), run: () => writable() && toggleInline(v(), "**") },
    { id: "md.italic", title: t("Italic"), key: "Ctrl+I", category: t("Markdown"), run: () => writable() && toggleInline(v(), "*") },
    { id: "md.strike", title: t("Strikethrough"), key: "Ctrl+Shift+X", category: t("Markdown"), run: () => writable() && toggleInline(v(), "~~") },
    { id: "md.code", title: t("Inline Code"), key: "Ctrl+`", category: t("Markdown"), run: () => writable() && toggleInline(v(), "`") },
    { id: "md.highlight", title: t("Highlight"), category: t("Markdown"), run: () => writable() && toggleInline(v(), "==") },
    { id: "md.h1", title: t("Heading 1"), key: "Ctrl+Alt+1", category: t("Markdown"), run: () => writable() && setHeading(v(), 1) },
    { id: "md.h2", title: t("Heading 2"), key: "Ctrl+Alt+2", category: t("Markdown"), run: () => writable() && setHeading(v(), 2) },
    { id: "md.h3", title: t("Heading 3"), key: "Ctrl+Alt+3", category: t("Markdown"), run: () => writable() && setHeading(v(), 3) },
    { id: "md.h4", title: t("Heading 4"), key: "Ctrl+Alt+4", category: t("Markdown"), run: () => writable() && setHeading(v(), 4) },
    { id: "md.h5", title: t("Heading 5"), key: "Ctrl+Alt+5", category: t("Markdown"), run: () => writable() && setHeading(v(), 5) },
    { id: "md.h6", title: t("Heading 6"), key: "Ctrl+Alt+6", category: t("Markdown"), run: () => writable() && setHeading(v(), 6) },
    { id: "md.h0", title: t("Remove Heading"), key: "Ctrl+Alt+0", category: t("Markdown"), run: () => writable() && setHeading(v(), 0) },
    { id: "md.bullet", title: t("Bullet List"), key: "Ctrl+Shift+8", category: t("Markdown"), run: () => writable() && toggleLinePrefix(v(), "bullet") },
    { id: "md.numbered", title: t("Numbered List"), key: "Ctrl+Shift+7", category: t("Markdown"), run: () => writable() && toggleLinePrefix(v(), "numbered") },
    { id: "md.task", title: t("Task List"), key: "Ctrl+Shift+9", category: t("Markdown"), run: () => writable() && toggleLinePrefix(v(), "task") },
    { id: "md.quote", title: t("Quote"), key: "Ctrl+Shift+Q", category: t("Markdown"), run: () => writable() && toggleLinePrefix(v(), "quote") },
    { id: "md.link", title: t("Insert Link"), key: "Ctrl+K", category: t("Markdown"), run: () => writable() && insertLink(v()) },
    { id: "md.image", title: t("Insert Image"), key: "Ctrl+Shift+I", category: t("Markdown"), run: () => writable() && insertLink(v(), true) },
    { id: "md.codeblock", title: t("Code Block"), key: "Ctrl+Alt+C", category: t("Markdown"), run: () => writable() && insertCodeBlock(v()) },
    { id: "md.table", title: t("Insert Table"), category: t("Markdown"), run: () => writable() && insertTable(v()) },
    { id: "md.hr", title: t("Horizontal Rule"), category: t("Markdown"), run: () => writable() && insertHorizontalRule(v()) },
    // Macros
    {
      id: "macro.record",
      title: t("Record Macro"),
      key: "Ctrl+Shift+R",
      category: t("Macro"),
      run: () => {
        if (recorder.recording) {
          recorder.stop();
          toast(recorder.last ? t("Macro recorded ({n} steps).", { n: recorder.last.length }) : t("Nothing was recorded."));
        } else {
          recorder.start();
          app.view.focus();
        }
      },
      checked: () => recorder.recording,
    },
    { id: "macro.play", title: t("Run Macro"), key: "Ctrl+Shift+M", category: t("Macro"), run: () => play(recorder.last, 1) },
    {
      id: "macro.playMulti",
      title: t("Run Macro Multiple Times…"),
      category: t("Macro"),
      run: async () => {
        const steps = await chooseMacro();
        if (!steps) return toast(t("There is no recorded macro. Record one with Ctrl+Shift+R."));
        const r = await prompt(t("Run Macro Multiple Times"), t('Number of runs, or "end" to run until the end of the file:'), "2");
        if (r === null) return;
        if (/^\s*(e|end|ende)\s*$/i.test(r)) return play(steps, "eof");
        const n = Math.floor(Number(r));
        if (!(n > 0 && n <= 100000)) return toast(t("Enter a number between 1 and 100000."));
        await play(steps, n);
      },
    },
    {
      id: "macro.save",
      title: t("Save Recorded Macro…"),
      category: t("Macro"),
      run: async () => {
        if (!recorder.last?.length) return toast(t("There is no recorded macro. Record one with Ctrl+Shift+R."));
        const name = (await prompt(t("Save Macro"), t("Name of the macro:"), ""))?.trim();
        if (!name) return;
        const others = settings.macros.filter((m) => m.name !== name);
        updateSettings({ macros: [...others, { name, steps: recorder.last }] }, { silent: true });
        extras.macrosChanged?.();
        toast(t('Macro "{name}" saved. Assign a key in Keyboard Shortcuts.', { name }), 4000);
      },
    },
    {
      id: "macro.delete",
      title: t("Delete Saved Macro…"),
      category: t("Macro"),
      run: async () => {
        if (!settings.macros.length) return toast(t("There are no saved macros."));
        const it = await pickList(t("Delete Saved Macro"), settings.macros.map((m, i) => ({ label: m.name, value: String(i), detail: describeSteps(m.steps) })));
        if (!it) return;
        const m = settings.macros[Number(it.value)];
        if (!(await confirmDialog(t("Delete Saved Macro"), t('Delete the macro "{name}"?', { name: m.name }), t("Delete")))) return;
        updateSettings({ macros: settings.macros.filter((x) => x !== m) }, { silent: true });
        extras.macrosChanged?.();
      },
    },
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
        const it = await pickList(t("Open tabs"), app.tabs.map((tab) => ({ label: (app.owner(tab).dirty ? "● " : "") + tab.name, value: tab.id, detail: tab.path ?? t("unsaved") })));
        const tab = it && app.tabs.find((x) => x.id === it.value);
        if (tab) app.activate(tab);
      },
    },
    // Settings / Help
    { id: "settings.open", title: t("Settings…"), key: "Ctrl+,", category: t("Settings"), run: () => openSettingsDialog(extras) },
    { id: "settings.shortcuts", title: t("Keyboard Shortcuts…"), category: t("Settings"), run: () => extras.openShortcuts?.() },
    { id: "settings.nppImport", title: t("Import from Notepad++…"), category: t("Settings"), run: () => extras.nppImport?.() },
    { id: "settings.export", title: t("Export Settings…"), category: t("Settings"), run: () => extras.exportSettings?.() },
    { id: "settings.import", title: t("Import Settings…"), category: t("Settings"), run: () => extras.importSettings?.() },
    { id: "settings.dataFolder", title: t("Open Data Folder"), category: t("Settings"), run: async () => backend.revealInExplorer(await backend.appDataDir()) },
    { id: "help.palette", title: t("Command Palette…"), key: "Ctrl+Shift+P", category: t("Help"), run: () => paletteFor(cmds, find) },
    { id: "help.updates", title: t("Check for Updates…"), category: t("Help"), run: () => checkForUpdates(false) },
    { id: "help.github", title: t("GitHub Repository"), category: t("Help"), run: () => openUrl(REPO_URL) },
    { id: "help.issue", title: t("Report an Issue"), category: t("Help"), run: () => openUrl(ISSUES_URL) },
    { id: "help.about", title: t("About Nax-Notepad"), category: t("Help"), run: () => extras.about() },
    {
      id: "file.copyPath",
      title: t("Copy File Path"),
      category: t("File"),
      run: () => {
        const path = app.active && app.owner(app.active).path;
        if (path) {
          void writeClipboard(path);
          toast(t("Path copied"));
        }
      },
    },
  ];
  for (let i = 1; i <= 9; i++) {
    cmds.push({ id: `view.tab${i}`, title: t("Go to Tab {n}", { n: i }), key: `Ctrl+${i}`, category: t("View"), run: () => app.activateIndex(i === 9 ? app.tabsIn(app.focused).length - 1 : i - 1) });
  }
  for (const c of cmds) c.defaultKey = c.key;
  playOnce = (steps) => play(steps, 1);
  addMacroCommands(cmds);
  applyKeymap(cmds, settings.keymapPreset, settings.keyOverrides);
  return cmds;
}

let playOnce: (steps: MacroStep[]) => unknown = () => undefined;

/** (Re)create the commands for saved macros ("macro.user.<name>"). */
export function addMacroCommands(cmds: Command[]): void {
  for (let i = cmds.length - 1; i >= 0; i--) if (cmds[i].id.startsWith("macro.user.")) cmds.splice(i, 1);
  for (const m of settings.macros ?? []) {
    cmds.push({ id: `macro.user.${m.name}`, title: m.name, category: t("Macro"), run: () => playOnce(m.steps) });
  }
}

/** Command palette: run a command, or find the typed text in the document. */
export async function paletteFor(cmds: Command[], find?: FindPanel): Promise<void> {
  const FIND = "@@find";
  let query = "";
  const it = await pickList(
    "",
    cmds.filter((c) => c.id !== "help.palette").map((c) => ({ label: `${c.category}: ${c.title}`, value: c.id, hint: c.key ? displayChord(c.key, lang) : undefined })),
    {
      placeholder: t("Type a command, or text to find…"),
      dynamic: (q) => {
        query = q;
        return q && find ? [{ label: t('Find "{text}" in the document', { text: q }), value: FIND, detail: t("Search") }] : [];
      },
    }
  );
  if (!it) return;
  if (it.value === FIND && find) {
    find.findText(query);
    return;
  }
  const c = cmds.find((x) => x.id === it.value);
  if (c) await runCommand(c);
}

// ---- keybinding dispatch -------------------------------------------------------------------

let keyCapture: ((e: KeyboardEvent) => void) | null = null;

/** Send every key press to `fn` instead of running commands (shortcut editor). */
export function setKeyCapture(fn: ((e: KeyboardEvent) => void) | null): void {
  keyCapture = fn;
}


export interface KeyDispatcher {
  /** Re-read the keys of all commands (after the keymap changed). */
  rebuild(): void;
}

export function installKeybindings(getCmds: () => Command[], opts: { isBlocked: () => boolean; isEditorTarget: (t: EventTarget | null) => boolean }): KeyDispatcher {
  let single: { p: ParsedKey; c: Command }[] = [];
  let chords: { first: ParsedKey; second: ParsedKey; c: Command }[] = [];
  const rebuild = () => {
    single = [];
    chords = [];
    for (const c of getCmds()) {
      if (!c.key || c.native) continue;
      const seq = c.key.trim().split(/\s+/);
      if (seq.length === 2) chords.push({ first: parseChord(seq[0]), second: parseChord(seq[1]), c });
      else single.push({ p: parseChord(c.key), c });
    }
  };
  rebuild();
  let pendingChord: ParsedKey | null = null;
  const sameChord = (a: ParsedKey, b: ParsedKey) => a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
  const fire = (e: KeyboardEvent, c: Command) => {
    e.preventDefault();
    e.stopPropagation();
    void runCommand(c);
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (keyCapture) {
        keyCapture(e);
        return;
      }
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt") return;
      if (pendingChord) {
        const first = pendingChord;
        pendingChord = null;
        const hit = chords.find((ch) => sameChord(ch.first, first) && matchesKey(ch.second, e));
        if (hit) return fire(e, hit.c);
      }
      if (opts.isBlocked()) {
        // Swallow WebView2 browser shortcuts that would reload or inspect the page.
        if (isBrowserShortcut(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const target = e.target as HTMLElement;
      const inInput = target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
      for (const ch of chords) {
        if (matchesKey(ch.first, e)) {
          pendingChord = ch.first;
          e.preventDefault();
          return;
        }
      }
      for (const { p, c } of single) {
        if (!matchesKey(p, e)) continue;
        // Let text inputs keep native Alt+F4 handling.
        if (inInput && c.id === "file.exit") return;
        return fire(e, c);
      }
      if (isBrowserShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (recorder.recording && opts.isEditorTarget(e.target)) recorder.key(e);
    },
    { capture: true }
  );
  window.addEventListener(
    "compositionend",
    (e) => {
      if (recorder.recording && opts.isEditorTarget(e.target)) recorder.composed(e.data ?? "");
    },
    { capture: true }
  );
  return { rebuild };
}

function isBrowserShortcut(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const letter = letterOf(e);
  if (k === "f12") return true;
  if (ctrl && e.shiftKey && (letter === "j" || letter === "r" || letter === "i")) return true;
  if (ctrl && !e.shiftKey && !e.altKey && letter === "r") return true;
  if (k === "f5" && ctrl) return true;
  if (k === "f7") return true; // caret browsing prompt
  return false;
}
