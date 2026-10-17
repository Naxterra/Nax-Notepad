// Frontend regression tests. They transpile the real TypeScript modules and run them with real
// CodeMirror state; the Tauri backend, dialogs and DOM-heavy modules are replaced by mocks.
// Based on the expectations of the 2026-10-17 review harness, ported to the current interfaces.
// Run: node tests/frontend.test.cjs
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const repo = path.resolve(__dirname, "..");
const ts = require(path.join(repo, "node_modules/typescript"));
const { EditorState, EditorSelection } = require("@codemirror/state");
const { SearchQuery } = require("@codemirror/search");

global.window = { setTimeout: () => 1, clearTimeout: () => {} };
global.requestAnimationFrame = () => 1;

const backend = {};
const settings = {
  pagedWindowLines: 3000,
  trimTrailingOnSave: false,
  ensureFinalNewline: false,
  lineNumbers: true,
  autoReloadExternal: true,
  keymapPreset: "nax",
  keyOverrides: {},
  macros: [],
  recentFiles: [],
  tabSize: 4,
  insertSpaces: true,
  detectIndent: true,
  syncScroll: false,
  showWhitespace: false,
  showEol: false,
};
const toasts = [];
const dialogs = { toast: (msg) => toasts.push(msg), confirm3: async () => "cancel", message: async () => {}, pickList: async () => null, prompt: async () => null };

const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const source = fs.readFileSync(path.join(repo, "src", name + ".ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  cache[name] = exports;
  const dir = path.posix.dirname(name);
  const localRequire = (id) => {
    if (id.startsWith(".")) id = path.posix.normalize(path.posix.join(dir, id));
    switch (id) {
      case "backend": {
        const real = load("backend-consts");
        return { ...real, backend };
      }
      case "settings":
        return { settings, updateSettings: () => {} };
      case "i18n":
        return { t: (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])) : s) };
      case "ui/dialogs":
        return dialogs;
      case "editor":
        return {
          systemChange: load("readonly").systemChange,
          compartments: { lineNumbers: { reconfigure: () => [] }, readOnly: { reconfigure: () => [] } },
          lineNumbersExt: () => [],
          createState: () => EditorState.create({ doc: "" }),
          languageByName: () => null,
          languageForFile: () => null,
          loadLanguage: async () => [],
        };
      case "readonly":
      case "paged":
      case "app":
      case "commands":
      case "replace":
      case "searchhl":
      case "keymap":
      case "macros":
      case "bookmarks":
      case "columnselect":
      case "compare":
      case "diff":
      case "indentdetect":
      case "nppimport":
      case "symbols":
      case "whitespace":
      case "encodings":
        return load(id);
    }
    if (id.startsWith("@tauri") || !id.startsWith("@")) return {};
    return require(id);
  };
  new Function("require", "exports", compiled)(localRequire, exports);
  return exports;
}
// The error-prefix constants of backend.ts without its Tauri import.
cache["backend-consts"] = (() => {
  const src = fs.readFileSync(path.join(repo, "src/backend.ts"), "utf8");
  const out = {};
  for (const m of src.matchAll(/export const (E_[A-Z_]+) = "([^"]+)";/g)) out[m[1]] = m[2];
  out.errorText = (e) => (e instanceof Error ? e.message : String(e));
  return out;
})();

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

const { PagedController } = load("paged");
const { App } = load("app");
const { readOnlyGuard, systemChange } = load("readonly");

function pagedHost(holder, active = true) {
  return {
    state: () => holder.state,
    dispatch: (spec) => {
      holder.state = holder.state.update(spec).state;
    },
    view: () => (active ? {} : null),
    onWindowChanged() {},
    onBackendEdit() {},
    onWindowFlags() {},
    onError(e) {
      throw e;
    },
  };
}

function fakeApp(tab, view) {
  const app = Object.create(App.prototype);
  view.scrollDOM = view.scrollDOM ?? { scrollTop: 0 };
  Object.assign(app, {
    active: tab,
    tabs: [tab],
    view,
    panes: [{ view, tab, host: null }],
    focused: 0,
    splitOn: false,
    closedTabs: [],
    emit() {},
    scheduleSessionSave() {},
    applyLanguage: async () => {},
  });
  return app;
}

function memoryTab(extra = {}) {
  return { id: "test", path: "test.txt", name: "test.txt", kind: "memory", dirty: true, encoding: "UTF-8", eol: "LF", revision: 1, savedRevision: 0, readOnly: false, ...extra };
}

// ---- findings 2 and 4: large-file edits are committed and never lost -------------------------

test("inactive paged tab commits pending edits", async () => {
  const writes = [];
  backend.pagedCommit = async (id, first, count, text) => {
    writes.push(text);
    return 1;
  };
  backend.pagedStoreEdits = async () => {};
  const holder = { state: EditorState.create({ doc: "edited while visible" }) };
  const c = new PagedController("test", 1, pagedHost(holder, false)); // the tab is not active
  c.count = 1;
  c.noteChange();
  await c.commit();
  assert.deepEqual(writes, ["edited while visible"]);
  assert.equal(c.dirtyWindow, false);
});

test("typing during a paged commit stays pending", async () => {
  const pending = deferred();
  const started = deferred();
  const holder = { state: EditorState.create({ doc: "first edit" }) };
  backend.pagedCommit = () => {
    started.resolve();
    return pending.promise;
  };
  backend.pagedStoreEdits = async () => {};
  const c = new PagedController("test", 1, pagedHost(holder));
  c.count = 1;
  c.noteChange();
  const op = c.commit();
  await started.promise;
  holder.state = EditorState.create({ doc: "second edit" });
  c.noteChange();
  pending.resolve(1);
  await op;
  assert.equal(c.dirtyWindow, true, "newer edits must stay pending");
});

test("typing during a page load is committed, not overwritten", async () => {
  const commits = [];
  let windowCalls = 0;
  const holder = { state: EditorState.create({ doc: "window" }) };
  const c = new PagedController("test", 10, pagedHost(holder));
  c.count = 1;
  backend.pagedCommit = async (id, first, count, text) => {
    commits.push(text);
    return 10;
  };
  backend.pagedStoreEdits = async () => {};
  backend.pagedWindow = async () => {
    windowCalls++;
    if (windowCalls === 1) {
      // The user types while the first window request is in flight.
      holder.state = holder.state.update({ changes: { from: 6, insert: " typed" } }).state;
      c.noteChange();
    }
    return { text: commits.length ? commits[commits.length - 1] : "window", firstLine: 0, count: 1, totalLines: 10, dirty: true, truncated: false, lossy: false };
  };
  await c.load(0);
  assert.deepEqual(commits, ["window typed"], "the typed text must reach the backend");
  assert.equal(holder.state.doc.toString(), "window typed");
  assert.equal(c.dirtyWindow, false);
});

// ---- finding 3: saving marks only the written revision as saved -------------------------------

test("typing during a save keeps the tab dirty and recoverable", async () => {
  const pending = deferred();
  const started = deferred();
  let saved;
  let dropped = false;
  backend.saveText = async (p, text) => {
    saved = text;
    started.resolve();
    return pending.promise;
  };
  backend.sessionDropBuffer = async () => {
    dropped = true;
  };
  const tab = memoryTab();
  const view = { state: EditorState.create({ doc: "first edit" }) };
  const app = fakeApp(tab, view);
  const op = app.save(tab);
  await started.promise;
  view.state = EditorState.create({ doc: "second edit" });
  app.noteUserEdit(tab);
  pending.resolve({ size: 10, mtime: 1, name: "test.txt", path: "test.txt" });
  assert.equal(await op, true);
  assert.equal(saved, "first edit");
  assert.equal(tab.dirty, true, "the newer text is not on disk");
  assert.equal(dropped, false, "the recovery copy must be kept");
});

test("a save without later edits marks the tab clean", async () => {
  backend.saveText = async () => ({ size: 3, mtime: 1, name: "test.txt", path: "test.txt" });
  let dropped = false;
  backend.sessionDropBuffer = async () => {
    dropped = true;
  };
  const tab = memoryTab();
  const app = fakeApp(tab, { state: EditorState.create({ doc: "abc" }) });
  assert.equal(await app.save(tab), true);
  assert.equal(tab.dirty, false);
  assert.equal(dropped, true);
});

test("overlapping saves of one tab run one after another", async () => {
  const order = [];
  const first = deferred();
  backend.saveText = async (p, text) => {
    order.push("start " + text);
    if (order.length === 1) await first.promise;
    order.push("end " + text);
    return { size: 1, mtime: 1, name: "test.txt", path: "test.txt" };
  };
  backend.sessionDropBuffer = async () => {};
  const tab = memoryTab();
  const view = { state: EditorState.create({ doc: "one" }) };
  const app = fakeApp(tab, view);
  const a = app.save(tab);
  await new Promise((r) => setTimeout(r, 0));
  view.state = EditorState.create({ doc: "two" });
  app.noteUserEdit(tab);
  const b = app.save(tab);
  await new Promise((r) => setTimeout(r, 0));
  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["start one", "end one", "start two", "end two"]);
  assert.equal(tab.dirty, false);
});

// ---- finding 6: closing reports persistence failures -------------------------------------------

test("flushAll reports a failure to store unsaved text", async () => {
  backend.sessionStoreBuffer = async () => {
    throw new Error("disk full");
  };
  backend.sessionSave = async () => {};
  const tab = memoryTab();
  const app = fakeApp(tab, { state: EditorState.create({ doc: "only copy" }) });
  await assert.rejects(app.flushAll(), /disk full/);
});

test("flushAll reports a failure to write the session", async () => {
  backend.sessionStoreBuffer = async () => {};
  backend.sessionSave = async () => {
    throw new Error("access denied");
  };
  const tab = memoryTab();
  const app = fakeApp(tab, { state: EditorState.create({ doc: "x" }) });
  await assert.rejects(app.flushAll(), /access denied/);
});

// ---- finding 12: read-only mode -----------------------------------------------------------------

test("read-only blocks custom text transformations", async () => {
  const { buildCommands } = load("commands");
  const view = {
    state: EditorState.create({ doc: "do not change", selection: { anchor: 0, head: 13 }, extensions: [EditorState.readOnly.of(true)] }),
  };
  view.dispatch = (spec) => {
    view.state = view.state.update(spec).state;
  };
  const app = fakeApp({ readOnly: true }, view);
  const commands = buildCommands(app, {}, {});
  for (const id of ["edit.upper", "edit.sortAsc", "md.bold", "md.h1", "md.bullet", "edit.insertDate"]) commands.find((c) => c.id === id).run();
  assert.equal(view.state.doc.toString(), "do not change");
});

test("the central guard drops programmatic edits in read-only state but allows system changes", () => {
  let state = EditorState.create({ doc: "abc", extensions: [EditorState.readOnly.of(true), readOnlyGuard] });
  state = state.update({ changes: { from: 0, insert: "x" } }).state; // e.g. a checkbox widget
  assert.equal(state.doc.toString(), "abc");
  state = state.update({ changes: { from: 0, to: 3, insert: "reloaded" }, annotations: systemChange.of(true) }).state;
  assert.equal(state.doc.toString(), "reloaded");
});

// ---- finding 13: regex replacement keeps context ----------------------------------------------

test("regex replacement preserves lookbehind context", () => {
  const { replacementAt } = load("replace");
  const q = new SearchQuery({ search: "(?<=foo)bar", regexp: true, replace: "$&!" });
  const state = EditorState.create({ doc: "foobar" });
  const hit = q.getCursor(state).next().value;
  assert.equal(replacementAt(q, state.doc.toString(), hit.from, hit.to), "bar!");
});

test("replacement syntax: groups, names, literal dollars", () => {
  const { replacementAt } = load("replace");
  const doc = "user@host and x@y";
  const q = new SearchQuery({ search: "(?<name>\\w+)@(\\w+)", regexp: true, replace: "$2 <- $<name> ($&) $$ $9" });
  const state = EditorState.create({ doc });
  const hit = q.getCursor(state).next().value;
  assert.equal(replacementAt(q, doc, hit.from, hit.to), "host <- user (user@host) $ $9");
  const lit = new SearchQuery({ search: "a.b", regexp: false, replace: "$1" });
  assert.equal(replacementAt(lit, "a.b", 0, 3), "$1");
});

// ---- finding 14: stable "in selection only" scope -----------------------------------------------

test("the selection scope survives finding and replacing inside it", () => {
  const { searchScope, setSearchScope } = load("searchhl");
  let state = EditorState.create({ doc: "cat cat\ncat cat\ncat cat", extensions: [searchScope] });
  state = state.update({ effects: setSearchScope.of({ from: 8, to: 15 }) }).state;
  // Finding a match changes the selection; the scope does not move.
  state = state.update({ selection: EditorSelection.range(8, 11) }).state;
  assert.deepEqual(state.field(searchScope), { from: 8, to: 15 });
  // Replacing at the scope start keeps the replacement inside the scope.
  state = state.update({ changes: { from: 8, to: 11, insert: "doggo" } }).state;
  assert.deepEqual(state.field(searchScope), { from: 8, to: 17 });
  // Edits before the scope shift it.
  state = state.update({ changes: { from: 0, insert: ">>" } }).state;
  assert.deepEqual(state.field(searchScope), { from: 10, to: 19 });
  // Deleting the whole scope removes it instead of widening to the document.
  state = state.update({ changes: { from: 10, to: 19 } }).state;
  assert.equal(state.field(searchScope), null);
});

// ---- 0.4.0: Notepad++ workflow ----------------------------------------------------------------

test("both keyboard presets are free of conflicts", () => {
  const { buildCommands } = load("commands");
  const { effectiveKey, findConflicts } = load("keymap");
  const view = { state: EditorState.create({ doc: "" }) };
  const cmds = buildCommands(fakeApp(memoryTab(), view), {}, {});
  for (const preset of ["nax", "npp"]) {
    const conflicts = findConflicts(cmds.map((c) => ({ id: c.id, key: effectiveKey(c, preset, {}) })));
    assert.deepEqual([...conflicts.entries()], [], `conflicts in preset ${preset}`);
  }
  const byId = (id) => cmds.find((c) => c.id === id);
  assert.equal(effectiveKey(byId("edit.deleteLine"), "npp", {}), "Ctrl+Shift+L");
  assert.equal(effectiveKey(byId("edit.cutLine"), "npp", {}), "Ctrl+L");
  assert.equal(effectiveKey(byId("bookmark.toggle"), "npp", {}), "Ctrl+F2");
  assert.equal(effectiveKey(byId("edit.columnDown"), "nax", {}), "Alt+Shift+ArrowDown");
  // Overrides win, "" removes the key, native clipboard keys are fixed.
  assert.equal(effectiveKey(byId("file.save"), "nax", { "file.save": "F12" }), "F12");
  assert.equal(effectiveKey(byId("file.save"), "nax", { "file.save": "" }), undefined);
  assert.equal(effectiveKey(byId("edit.copy"), "npp", { "edit.copy": "F9" }), "Ctrl+C");
});

test("conflict detection ignores how a chord is written", () => {
  const { findConflicts, normalizeChord } = load("keymap");
  assert.equal(normalizeChord("Shift+Ctrl+k"), normalizeChord("Ctrl+Shift+K"));
  const c = findConflicts([
    { id: "a", key: "Shift+Ctrl+K" },
    { id: "b", key: "Ctrl+Shift+K" },
    { id: "c", key: "Ctrl+K" },
  ]);
  assert.deepEqual([...c.values()], [["a", "b"]]);
});

test("AltGr characters do not trigger Ctrl+Alt shortcuts", () => {
  const { matchesKey, parseChord, chordFromEvent } = load("keymap");
  const altGr = { key: "}", code: "Digit0", ctrlKey: true, altKey: true, shiftKey: false, getModifierState: (k) => k === "AltGraph" };
  assert.equal(matchesKey(parseChord("Ctrl+Alt+0"), altGr), false);
  const real = { ...altGr, key: "0", getModifierState: () => false };
  assert.equal(matchesKey(parseChord("Ctrl+Alt+0"), real), true);
  assert.equal(chordFromEvent({ key: "ArrowUp", code: "ArrowUp", ctrlKey: false, altKey: true, shiftKey: true }), "Alt+Shift+ArrowUp");
  assert.equal(chordFromEvent({ key: "k", code: "KeyK", ctrlKey: true, altKey: false, shiftKey: false }), "Ctrl+K");
  assert.equal(chordFromEvent({ key: "Control", code: "ControlLeft", ctrlKey: true, altKey: false, shiftKey: false }), null);
});

test("Alt+Shift+Arrow builds a column block that clamps short lines", () => {
  const { columnBlock, columnSelectSpec } = load("columnselect");
  let state = EditorState.create({ doc: "abcdef\nab\nabcdef", selection: { anchor: 1 }, extensions: [columnBlock, EditorState.allowMultipleSelections.of(true)] });
  for (const dir of ["down", "down", "right", "right"]) state = state.update(columnSelectSpec(state, dir)).state;
  const ranges = state.selection.ranges.map((r) => [r.anchor, r.head]);
  assert.deepEqual(ranges, [
    [1, 3],
    [8, 9],
    [11, 13],
  ]);
  assert.equal(state.selection.main.head, 13, "the head line is the main range");
  // Typing replaces the block on every line.
  state = state.update(state.replaceSelection("X")).state;
  assert.equal(state.doc.toString(), "aXdef\naX\naXdef");
  // Any other selection change ends the block.
  state = state.update({ selection: { anchor: 0 } }).state;
  assert.equal(state.field(columnBlock), null);
});

test("column block with only up/down gives one cursor per line", () => {
  const { columnBlock, columnSelectSpec } = load("columnselect");
  let state = EditorState.create({ doc: "one\ntwo\nthree", selection: { anchor: 13 }, extensions: [columnBlock, EditorState.allowMultipleSelections.of(true)] });
  state = state.update(columnSelectSpec(state, "up")).state;
  state = state.update(columnSelectSpec(state, "up")).state;
  assert.deepEqual(
    state.selection.ranges.map((r) => [r.from, r.to]),
    [
      [3, 3],
      [7, 7],
      [13, 13],
    ]
  );
});

test("bookmarks follow edits, toggle and wrap around", () => {
  const { bookmarkField, setBookmarks, toggleBookmarkAt, bookmarkLines, nextBookmark } = load("bookmarks");
  let state = EditorState.create({ doc: "a\nb\nc\nd\ne", extensions: [bookmarkField] });
  state = state.update({ effects: setBookmarks.of([2, 4, 99]) }).state;
  assert.deepEqual(bookmarkLines(state), [2, 4]);
  state = state.update({ changes: { from: 0, insert: "new line\n" } }).state;
  assert.deepEqual(bookmarkLines(state), [3, 5], "lines inserted above move the bookmarks");
  state = state.update({ effects: toggleBookmarkAt.of(state.doc.line(3).from + 1) }).state;
  assert.deepEqual(bookmarkLines(state), [5], "toggling anywhere on the line removes it");
  state = state.update({ effects: toggleBookmarkAt.of(0) }).state;
  assert.deepEqual(bookmarkLines(state), [1, 5]);
  assert.equal(nextBookmark(state, state.doc.line(5).from, 1), 0, "wraps to the first bookmark");
  assert.equal(nextBookmark(state, 0, -1), state.doc.line(5).from, "wraps to the last bookmark");
});

test("indentation detection", () => {
  const { detectIndent } = load("indentdetect");
  assert.deepEqual(detectIndent('{\n  "a": {\n    "b": 1,\n    "c": [\n      2\n    ]\n  }\n}\n'), { spaces: true, size: 2 });
  assert.deepEqual(detectIndent("def f():\n    if x:\n        return 1\n    return 2\n\nclass A:\n    pass\n"), { spaces: true, size: 4 });
  assert.deepEqual(detectIndent("func main() {\n\tif x {\n\t\treturn\n\t}\n\tfmt.Println()\n}\n"), { spaces: false, size: 0 });
  assert.equal(detectIndent("plain text\nwithout indentation\n"), null);
  // Block comment continuation lines (" * ") do not count as 1-space indentation.
  assert.deepEqual(detectIndent("/**\n * doc\n * more\n */\nfunction f() {\n    a();\n    if (b) {\n        c();\n    }\n}\n"), { spaces: true, size: 4 });
});

test("line diff finds the changed regions", () => {
  const { diffLines } = load("diff");
  assert.deepEqual(diffLines(["a", "b", "c"], ["a", "x", "c", "d"]), [
    { a0: 1, a1: 2, b0: 1, b1: 2 },
    { a0: 3, a1: 3, b0: 3, b1: 4 },
  ]);
  assert.deepEqual(diffLines(["same"], ["same"]), []);
  // Applying the hunks to A gives B, for many random cases.
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rnd(30) }, () => "l" + rnd(6));
    const b = a.filter(() => rnd(4) !== 0).flatMap((x) => (rnd(5) === 0 ? [x, "n" + rnd(6)] : [x]));
    const hunks = diffLines(a, b);
    const out = [];
    let i = 0;
    for (const h of hunks) {
      out.push(...a.slice(i, h.a0), ...b.slice(h.b0, h.b1));
      i = h.a1;
    }
    out.push(...a.slice(i));
    assert.deepEqual(out, b, `round ${round}`);
  }
});

test("macro recording classifies keys", () => {
  const { stepForKey, addStep } = load("macros");
  const ev = (key, code, mods = {}) => ({ key, code, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  const steps = [];
  for (const e of [ev("H", "KeyH", { shiftKey: true }), ev("i", "KeyI"), ev("Enter", "Enter"), ev("Shift", "ShiftLeft", { shiftKey: true })]) {
    const s = stepForKey(e);
    if (s) addStep(steps, s);
  }
  // AltGr+Q types "@" on German keyboards: text, not a shortcut.
  addStep(steps, stepForKey(ev("@", "KeyQ", { ctrlKey: true, altKey: true, getModifierState: (k) => k === "AltGraph" })));
  addStep(steps, stepForKey(ev("c", "KeyC", { ctrlKey: true })));
  addStep(steps, stepForKey(ev("ArrowLeft", "ArrowLeft", { ctrlKey: true, shiftKey: true })));
  assert.deepEqual(steps, [
    { type: "text", text: "Hi" },
    { type: "key", key: "Enter", code: "Enter" },
    { type: "text", text: "@" },
    { type: "cmd", id: "edit.copy" },
    { type: "key", key: "ArrowLeft", code: "ArrowLeft", ctrl: true, shift: true },
  ]);
});

test("Notepad++ import: settings, session and shortcuts", () => {
  const { parseConfig, parseSession, parseShortcuts } = load("nppimport");
  const config = `<?xml version="1.0"?><NotepadPlus><GUIConfigs>
    <GUIConfig name="TabSetting" replaceBySpace="yes" size="2" />
    <GUIConfig name="ScintillaPrimaryView" lineNumberMargin="show" currentLineHilitingShow="hide" Wrap="yes" whiteSpaceShow="show" eolShow="hide" />
    <GUIConfig name="NewDocDefaultSettings" format="2" encoding="4" lang="0" />
  </GUIConfigs></NotepadPlus>`;
  const s = Object.fromEntries(parseConfig(config).map((c) => [c.key, c.value]));
  assert.deepEqual(s, { tabSize: 2, insertSpaces: true, lineNumbers: true, highlightActiveLine: false, wordWrap: true, showWhitespace: true, showEol: false, defaultEol: "LF", defaultEncoding: "UTF-8" });

  const session = `<NotepadPlus><Session activeView="0">
    <mainView activeIndex="0">
      <File firstVisibleLine="10" filename="C:\\work\\a &amp; b.txt" />
      <File filename="new 1" backupFilePath="C:\\Users\\x\\AppData\\Roaming\\Notepad++\\backup\\new 1@2024" />
    </mainView>
    <subView activeIndex="0"><File filename="D:\\logs\\app.log" /></subView>
  </Session></NotepadPlus>`;
  const files = parseSession(session);
  assert.deepEqual(
    files.map((f) => [f.path, f.view, f.untitled, !!f.backup]),
    [
      ["C:\\work\\a & b.txt", 0, false, false],
      ["new 1", 0, true, true],
      ["D:\\logs\\app.log", 1, false, false],
    ]
  );

  const shortcuts = `<NotepadPlus>
    <InternalCommands>
      <Shortcut id="41006" Ctrl="no" Alt="no" Shift="no" Key="113" />
      <Shortcut id="43005" Ctrl="yes" Alt="no" Shift="no" Key="77" />
      <Shortcut id="49999" Ctrl="yes" Alt="no" Shift="no" Key="65" />
    </InternalCommands>
    <Macros>
      <Macro name="Trim and save" Ctrl="no" Alt="yes" Shift="yes" Key="83">
        <Action type="2" message="0" wParam="42024" lParam="0" sParam="" />
        <Action type="2" message="0" wParam="41006" lParam="0" sParam="" />
      </Macro>
      <Macro name="Quote line" Ctrl="no" Alt="no" Shift="no" Key="0">
        <Action type="0" message="2331" wParam="0" lParam="0" sParam="" />
        <Action type="1" message="2170" wParam="0" lParam="0" sParam="&gt;" />
        <Action type="1" message="2170" wParam="0" lParam="0" sParam=" " />
        <Action type="0" message="2300" wParam="0" lParam="0" sParam="" />
      </Macro>
      <Macro name="Uses search" Ctrl="no" Alt="no" Shift="no" Key="0">
        <Action type="3" message="1700" wParam="0" lParam="0" sParam="" />
      </Macro>
    </Macros>
  </NotepadPlus>`;
  const r = parseShortcuts(shortcuts);
  assert.deepEqual(
    r.shortcuts.map((x) => [x.commandId, x.key]),
    [
      ["file.save", "F2"],
      ["bookmark.toggle", "Ctrl+M"],
      [null, "Ctrl+A"],
    ]
  );
  assert.deepEqual(r.macros[0], { name: "Trim and save", key: "Alt+Shift+S", steps: [{ type: "cmd", id: "edit.trim" }, { type: "cmd", id: "file.save" }], problem: undefined });
  assert.deepEqual(r.macros[1].steps, [
    { type: "key", key: "Home", code: "Home" },
    { type: "text", text: "> " },
    { type: "key", key: "ArrowDown", code: "ArrowDown" },
  ]);
  assert.equal(r.macros[1].key, null);
  assert.equal(r.macros[2].steps, null, "search actions are not imported");
  assert.match(r.macros[2].problem, /search/);
});

test("function list from the syntax tree and Markdown headings", () => {
  const { collectSymbols } = load("symbols");
  const { javascript } = require("@codemirror/lang-javascript");
  const { markdown } = require("@codemirror/lang-markdown");
  const js = EditorState.create({ doc: "function top() {}\nclass Box {\n  open() {}\n}\nconst x = 1;\n", extensions: [javascript()] });
  assert.deepEqual(
    collectSymbols(js).map((s) => [s.name, s.line, s.depth, s.kind]),
    [
      ["top", 1, 0, "function"],
      ["Box", 2, 0, "class"],
      ["open", 3, 1, "function"],
    ]
  );
  const md = EditorState.create({ doc: "# Title\n\ntext\n\n## Part *one*\n", extensions: [markdown()] });
  assert.deepEqual(
    collectSymbols(md).map((s) => [s.name, s.line, s.depth]),
    [
      ["Title", 1, 0],
      ["Part *one*", 5, 1],
    ]
  );
  const plain = EditorState.create({ doc: "x=1\nfunction deploy() {\n  echo\n}\n" });
  assert.deepEqual(
    collectSymbols(plain).map((s) => s.name),
    ["deploy"]
  );
});

test("a clone mirrors edits in both directions", () => {
  const app = Object.create(App.prototype);
  const original = { ...memoryTab({ dirty: false, revision: 0 }), state: EditorState.create({ doc: "hello" }) };
  const clone = { ...memoryTab({ id: "clone", dirty: false, revision: 0 }), cloneOf: original, state: EditorState.create({ doc: "hello" }) };
  Object.assign(app, { tabs: [original, clone], panes: [], splitOn: true, emit() {}, scheduleSessionSave() {} });
  app.dispatchTo(clone, { changes: { from: 5, insert: " world" } });
  assert.equal(original.state.doc.toString(), "hello world");
  app.dispatchTo(original, { changes: { from: 0, insert: ">" } });
  assert.equal(clone.state.doc.toString(), ">hello world");
  assert.equal(app.owner(clone), original);
});

test("follow mode appends new text without marking the tab dirty", async () => {
  const tab = { ...memoryTab({ dirty: false, revision: 0, size: 6 }), state: EditorState.create({ doc: "line1\n", selection: { anchor: 6 } }) };
  tab.tail = { paused: false, offset: 6, headHash: 1, headLen: 6, missing: false, busy: false };
  const app = Object.create(App.prototype);
  Object.assign(app, { tabs: [tab], panes: [], splitOn: false, emit() {}, scheduleSessionSave() {} });
  const calls = [];
  backend.tailCheck = async (path, offset, headHash, headLen, encoding) => {
    calls.push([offset, headHash, headLen, encoding]);
    return { status: "appended", text: "line2\r\nline3\n", offset: 20, mtime: 5 };
  };
  await app.pollTail(tab);
  assert.equal(tab.state.doc.toString(), "line1\nline2\nline3\n");
  assert.equal(tab.dirty, false);
  assert.equal(tab.tail.offset, 20);
  assert.equal(tab.state.selection.main.head, tab.state.doc.length, "the cursor stays at the end");
  assert.deepEqual(calls, [[6, 1, 6, "UTF-8"]]);
  // Unsaved edits pause following instead of mixing file data into them.
  tab.dirty = true;
  await app.pollTail(tab);
  assert.equal(tab.tail.paused, true);
  assert.equal(calls.length, 1);
});

test("reopen with encoding decodes again and keeps the tab clean", async () => {
  const tab = { ...memoryTab({ dirty: false, revision: 0, encoding: "UTF-8" }), state: EditorState.create({ doc: "GrÃ¼ÃŸe" }) };
  const app = Object.create(App.prototype);
  Object.assign(app, { tabs: [tab], panes: [], splitOn: false, emit() {}, scheduleSessionSave() {} });
  const seen = [];
  backend.openPath = async (id, path, forcePaged, encoding) => {
    seen.push([forcePaged, encoding]);
    return { kind: "memory", path, name: "test.txt", text: "Grüße", encoding: "windows-1252", eol: "LF", size: 6, lineCount: null, hadErrors: false, readOnly: false, readOnlyReason: null, mtime: 2, binary: false };
  };
  backend.sessionDropBuffer = async () => {};
  await app.reopenWithEncoding(tab, "windows-1252");
  assert.deepEqual(seen, [[false, "windows-1252"]]);
  assert.equal(tab.state.doc.toString(), "Grüße");
  assert.equal(tab.encoding, "windows-1252");
  assert.equal(tab.dirty, false);
});

test("settings: wrong types are ignored", () => {
  const real = load("settings");
  const v = real.validSettings({ tabSize: "4", macros: { not: "a list" }, keyOverrides: [], wordWrap: true, unknown: 1, recentFiles: ["a"] });
  assert.deepEqual(v, { wordWrap: true, recentFiles: ["a"] });
  assert.ok(real.DATA_KEYS.includes("macros") && real.DATA_KEYS.includes("keyOverrides"));
});

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("PASS", name);
    } catch (e) {
      failures++;
      console.log("FAIL", name, "\n ", e && e.message);
    }
  }
  console.log(`${tests.length} frontend tests: ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
})();
