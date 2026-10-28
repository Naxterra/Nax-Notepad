// Frontend regression tests. They transpile the real TypeScript modules and run them with real
// CodeMirror state; the Tauri backend, dialogs and DOM-heavy modules are replaced by mocks.
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
// Native message boxes shown through the Tauri dialog plugin.
const messages = [];
const tauriDialog = { message: async (text) => messages.push(text), save: async () => null, open: async () => null };

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
      case "hexbuffer":
      case "bytemap":
      case "signature":
      case "paths":
        return load(id);
    }
    if (id === "@tauri-apps/plugin-dialog") return tauriDialog;
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
    keptMetas: [],
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

test("saving tells the backend which file version it replaces so another program's changes are not overwritten", async () => {
  const expected = [];
  backend.saveText = async (p, text, enc, eol, lossy, expectedMtime) => {
    expected.push(expectedMtime);
    return { size: 3, mtime: 9000, name: "test.txt", path: p };
  };
  backend.sessionDropBuffer = async () => {};
  const tab = memoryTab({ mtime: 1234 });
  const app = fakeApp(tab, { state: EditorState.create({ doc: "abc" }) });
  assert.equal(await app.save(tab), true);
  // After "Keep mine" for a change on disk, the save may replace exactly that version.
  tab.externalAck = 5678;
  assert.equal(await app.save(tab), true);
  // Save As writes a file the user picked, so there is no version to compare with.
  assert.equal(await app.writeTab(tab, "other.txt", true), true);
  assert.deepEqual(expected, [1234, 5678, null]);
});

test("after the page reloads (language change), recovery writes still count as newer than the last save", () => {
  const { bufferGeneration, setBufferEpoch } = load("app");
  try {
    setBufferEpoch(1);
    const savedBeforeReload = bufferGeneration(20);
    setBufferEpoch(2);
    assert.ok(bufferGeneration(1) > savedBeforeReload, "the first edit after the reload must be stored");
  } finally {
    setBufferEpoch(0);
  }
});

test("a recovery write that finishes after the save cannot bring the old text back", async () => {
  const stores = [];
  const drops = [];
  backend.sessionStoreBuffer = async (id, text, generation) => stores.push(generation);
  backend.sessionDropBuffer = async (id, generation) => drops.push(generation);
  backend.sessionSave = async () => {};
  backend.saveText = async (p) => ({ size: 3, mtime: 1, name: "test.txt", path: p });
  const tab = memoryTab();
  const view = { state: EditorState.create({ doc: "abc" }) };
  const app = fakeApp(tab, view);
  await app.flushAll();
  assert.equal(await app.save(tab), true);
  // The backend ignores a store whose generation is not above the dropped one.
  assert.equal(drops.length, 1);
  assert.ok(stores[0] <= drops[0], "the store of the saved text must count as outdated");
  view.state = EditorState.create({ doc: "abcd" });
  app.noteUserEdit(tab);
  await app.flushAll();
  assert.ok(stores[1] > drops[0], "text typed after the save must be stored again");
});

test("unsaved changes to a large file on a missing drive are kept for the next start, not deleted", async () => {
  messages.length = 0;
  backend.sessionHasRecovery = async () => true;
  backend.sessionLoad = async () => ({ tabs: [{ id: "big", path: "E:/logs/big.log", kind: "paged", dirty: true }], active: null, next_untitled: 1 });
  backend.pathExists = async () => false;
  const app = fakeApp(memoryTab(), { state: EditorState.create({ doc: "" }) });
  app.tabs = [];
  assert.equal(await app.restoreSession(), false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /kept and tried again at the next start/);
  assert.match(messages[0], /big\.log/);
  // The entry stays in the session, so the backend does not delete its recovery log.
  let saved;
  backend.sessionSave = async (s) => {
    saved = s;
  };
  await app.saveSessionNow();
  assert.deepEqual(saved.tabs.map((x) => x.id), ["big"]);
  assert.ok(saved.tabs[0].keptSince > 0);
});

test("unsaved changes that could not be restored for 30 days are reported as lost", async () => {
  messages.length = 0;
  backend.sessionHasRecovery = async () => true;
  const longAgo = Date.now() - 31 * 24 * 3600 * 1000;
  backend.sessionLoad = async () => ({ tabs: [{ id: "big", path: "E:/logs/big.log", kind: "paged", dirty: true, keptSince: longAgo }], active: null, next_untitled: 1 });
  backend.pathExists = async () => false;
  const app = fakeApp(memoryTab(), { state: EditorState.create({ doc: "" }) });
  app.tabs = [];
  await app.restoreSession();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /could not be restored, because the files were changed by another program or their recovery data is missing/);
  assert.deepEqual(app.keptMetas, []);
});

test("a tab with unsaved text whose restore fails is kept in the session instead of being dropped", async () => {
  messages.length = 0;
  backend.sessionHasRecovery = async () => true;
  backend.sessionLoad = async () => ({ tabs: [{ id: "locked", path: "C:/data/locked.txt", kind: "memory", dirty: true }], active: null, next_untitled: 1 });
  const app = fakeApp(memoryTab(), { state: EditorState.create({ doc: "" }) });
  app.tabs = [];
  app.restoreTab = async () => {
    throw new Error("access denied");
  };
  await app.restoreSession();
  assert.deepEqual(app.keptMetas.map((x) => x.id), ["locked"]);
  assert.match(messages[0], /locked\.txt/);
});

test("a tab whose recovery data is gone is reported as lost once and not kept", async () => {
  messages.length = 0;
  backend.sessionHasRecovery = async () => false;
  backend.sessionLoad = async () => ({ tabs: [{ id: "gone", path: "C:/data/gone.txt", kind: "memory", dirty: true }], active: null, next_untitled: 1 });
  const app = fakeApp(memoryTab(), { state: EditorState.create({ doc: "" }) });
  app.tabs = [];
  app.restoreTab = async () => {
    throw new Error("access denied");
  };
  await app.restoreSession();
  assert.deepEqual(app.keptMetas, []);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /recovery data is missing/);
  assert.match(messages[0], /gone\.txt/);
});

test("closing before the last session is restored does not write a session that would delete its recovery data", async () => {
  let writes = 0;
  backend.sessionSave = async () => {
    writes++;
  };
  backend.sessionStoreBuffer = async () => {};
  const app = fakeApp(memoryTab(), { state: EditorState.create({ doc: "typed early" }) });
  app.holdSession();
  await app.saveSessionNow(true);
  await app.flushAll();
  assert.equal(writes, 0, "nothing may be written while the old session is not restored");
  backend.sessionLoad = async () => ({ tabs: [], active: null, next_untitled: 1 });
  await app.restoreSession();
  await app.saveSessionNow(true);
  assert.equal(writes, 1, "after the restore the session is written again");
});

test("a kept entry stays in the session while its file is being opened, so its recovery data is not deleted", async () => {
  const app = fakeApp(memoryTab({ path: "other.txt" }), { state: EditorState.create({ doc: "" }) });
  const kept = { id: "big", path: "E:/logs/big.log", kind: "paged", dirty: true, keptSince: Date.now() };
  app.keptMetas = [kept];
  let written;
  backend.sessionSave = async (s) => {
    written = s;
  };
  app.restoreTab = async () => {
    await app.saveSessionNow(); // a background session save while the slow restore runs
    return { ...memoryTab({ id: "big", path: "E:/logs/big.log" }) };
  };
  await app.openFiles(["E:/logs/big.log"], false);
  assert.ok(written.tabs.some((m) => m.id === "big"), "the kept entry must be in that session");
  assert.deepEqual(app.keptMetas, []);
});

test("a kept entry that is lost when its file is opened is reported and not put back", async () => {
  messages.length = 0;
  const app = fakeApp(memoryTab({ path: "other.txt" }), { state: EditorState.create({ doc: "" }) });
  const kept = { id: "big", path: "E:/logs/big.log", kind: "paged", dirty: true, keptSince: Date.now() - 31 * 24 * 3600 * 1000 };
  app.keptMetas = [kept];
  app.lostEdits = [];
  app.notRestored = [];
  backend.pathExists = async () => false;
  backend.sessionHasRecovery = async () => true;
  app.openOne = async () => {
    throw new Error("drive not connected");
  };
  await app.openFiles(["E:/logs/big.log"], false);
  assert.deepEqual(app.keptMetas, []);
  assert.ok(messages.some((m) => /could not be restored, because/.test(m) && /big\.log/.test(m)));
});

test("a kept entry that still cannot be restored when its file is opened stays only once", async () => {
  const app = fakeApp(memoryTab({ path: "other.txt" }), { state: EditorState.create({ doc: "" }) });
  const kept = { id: "big", path: "E:/logs/big.log", kind: "paged", dirty: true, keptSince: Date.now() };
  app.keptMetas = [kept];
  app.lostEdits = [];
  app.notRestored = [];
  backend.pathExists = async () => false;
  backend.sessionHasRecovery = async () => true;
  app.openOne = async () => {
    throw new Error("drive not connected");
  };
  await app.openFiles(["E:/logs/big.log"], false);
  assert.deepEqual(app.keptMetas.map((m) => m.id), ["big"]);
});

test("opening a file whose unsaved changes were kept restores those changes instead of a second tab", async () => {
  const app = fakeApp(memoryTab({ path: "other.txt" }), { state: EditorState.create({ doc: "" }) });
  const kept = { id: "big", path: "E:/logs/big.log", kind: "paged", dirty: true, keptSince: Date.now() };
  app.keptMetas = [kept];
  const restored = { ...memoryTab({ id: "big", path: "E:/logs/big.log" }) };
  const seen = [];
  app.restoreTab = async (meta) => {
    seen.push(meta.id);
    return restored;
  };
  app.openOne = async () => assert.fail("the kept changes must be used");
  const tab = await app.openFiles(["e:/LOGS/big.log"], false);
  assert.equal(tab, restored);
  assert.deepEqual(seen, ["big"]);
  assert.deepEqual(app.keptMetas, []);
});

test("text typed while a file is being reloaded stops the reload instead of being replaced", async () => {
  toasts.length = 0;
  const tab = { ...memoryTab({ dirty: true, revision: 3 }), state: EditorState.create({ doc: "typed" }) };
  const app = Object.create(App.prototype);
  Object.assign(app, { tabs: [tab], panes: [], splitOn: false, emit() {}, scheduleSessionSave() {} });
  backend.openPath = async (id, path) => {
    tab.revision++; // the user types while the file is read
    return { kind: "memory", path, name: "test.txt", text: "from disk", encoding: "UTF-8", eol: "LF", size: 9, lineCount: null, hadErrors: false, readOnly: false, readOnlyReason: null, mtime: 9, binary: false };
  };
  await app.reload(tab);
  assert.equal(tab.state.doc.toString(), "typed");
  assert.equal(tab.dirty, true);
  assert.ok(toasts.some((m) => /reload was stopped/.test(m)));
});

test("saving a large file with several hard links explains why it was not saved", async () => {
  messages.length = 0;
  backend.pagedSave = async () => {
    throw new Error("E_HARD_LINKS:C:/logs/big.log");
  };
  const tab = memoryTab({ kind: "paged", name: "big.log", paged: { commit: async () => {} } });
  const app = fakeApp(tab, { state: EditorState.create({ doc: "x" }) });
  assert.equal(await app.save(tab), false);
  assert.equal(tab.dirty, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /hard links/);
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

// ---- 0.5.3: release review fixes ----------------------------------------------------------------

test("a file that grew past the size limit is reloaded in pages instead of being emptied", async () => {
  toasts.length = 0;
  const tab = { ...memoryTab({ dirty: false, revision: 0 }), state: EditorState.create({ doc: "old text" }) };
  const app = Object.create(App.prototype);
  Object.assign(app, { tabs: [tab], panes: [], splitOn: false, emit() {}, scheduleSessionSave() {} });
  backend.openPath = async (id, path) => ({ kind: "paged", path, name: "test.txt", text: null, encoding: "UTF-8", eol: "CRLF", size: 60 << 20, lineCount: 1000, hadErrors: false, readOnly: false, readOnlyReason: null, mtime: 3, binary: false });
  backend.pagedWindow = async () => ({ text: "line1\r\nline2", firstLine: 0, count: 2, totalLines: 1000, truncated: false, lossy: false, dirty: false });
  backend.sessionDropBuffer = async () => {};
  await app.reload(tab);
  assert.equal(tab.kind, "paged");
  assert.equal(tab.paged.totalLines, 1000);
  assert.equal(tab.size, 60 << 20);
  assert.equal(tab.dirty, false);
  assert.ok(toasts.some((m) => /shown in pages/.test(m)));
});

test("a large file whose reload fails keeps the open document", async () => {
  let closed = false;
  const paged = { resetRevisions() {}, load: async () => {}, firstLine: 0, cursorLine: () => 0 };
  const tab = { ...memoryTab({ kind: "paged", dirty: false, revision: 0 }), paged, state: EditorState.create({ doc: "window" }) };
  const app = Object.create(App.prototype);
  Object.assign(app, { tabs: [tab], panes: [], splitOn: false, emit() {}, scheduleSessionSave() {} });
  backend.pagedClose = async () => {
    closed = true;
  };
  backend.openPath = async () => {
    throw new Error("sharing violation");
  };
  await assert.rejects(app.reload(tab), /sharing violation/);
  assert.equal(closed, false, "the open document must stay in the backend");
  assert.equal(tab.paged, paged);
});

test("a large file's window keeps a lone carriage return inside its line", () => {
  const { pagedLineExtensions, windowText } = load("paged");
  const { EditorView } = require("@codemirror/view");
  const state = EditorState.create({ doc: windowText("a\rb\r\nc"), extensions: pagedLineExtensions });
  assert.equal(state.doc.lines, 2, "the backend counts lines at \\n only");
  assert.equal(state.doc.toString(), "a\rb\nc");
  // Pasted Windows text must not leave a \r before the line break that the file adds itself.
  const pasted = state.facet(EditorView.clipboardInputFilter).reduce((text, f) => f(text, state), "x\r\ny\rz");
  assert.equal(pasted, "x\ny\nz");
});

test("with restoring all tabs switched off, tabs with unsaved text still come back", async () => {
  backend.sessionLoad = async () => ({
    tabs: [
      { id: "saved", path: "a.txt", kind: "memory", dirty: false },
      { id: "draft", path: null, kind: "memory", dirty: true },
    ],
    active: null,
    next_untitled: 1,
  });
  const app = fakeApp(memoryTab(), { state: EditorState.create({ doc: "" }) });
  app.tabs = [];
  const seen = [];
  app.restoreTab = async (meta) => {
    seen.push(meta.id);
    return null;
  };
  await app.restoreSession({ onlyUnsaved: true });
  assert.deepEqual(seen, ["draft"]);
  seen.length = 0;
  await app.restoreSession();
  assert.deepEqual(seen, ["saved", "draft"]);
});

test("cancelling the changed-on-disk question does not allow saving over the other program's changes", async () => {
  const oldConfirm = dialogs.confirm3;
  dialogs.confirm3 = async () => "cancel";
  settings.autoReloadExternal = false;
  try {
    backend.pathExists = async () => true;
    backend.fileMtime = async () => 100;
    const expected = [];
    backend.saveText = async (p, text, enc, eol, lossy, expectedMtime) => {
      expected.push(expectedMtime);
      throw new Error("E_EXTERNAL_CHANGE:" + p);
    };
    const tab = memoryTab({ mtime: 50 });
    const app = fakeApp(tab, { state: EditorState.create({ doc: "abc" }) });
    await app.checkExternalChange();
    assert.equal(tab.externalAck, undefined);
    await app.save(tab);
    assert.deepEqual(expected, [50], "the save must still compare with the version that was read");
    // "Keep mine" allows replacing exactly that version.
    dialogs.confirm3 = async (title) => (title === "File changed on disk" ? "no" : "cancel");
    await app.checkExternalChange();
    assert.equal(tab.externalAck, 100);
  } finally {
    dialogs.confirm3 = oldConfirm;
    settings.autoReloadExternal = true;
  }
});

test("the reload question mentions losing changes only when there are unsaved changes", async () => {
  const questions = [];
  const oldConfirm = dialogs.confirm3;
  dialogs.confirm3 = async (title, text) => {
    questions.push(text);
    return "cancel";
  };
  settings.autoReloadExternal = false;
  try {
    backend.pathExists = async () => true;
    let mtime = 100;
    backend.fileMtime = async () => mtime;
    const tab = memoryTab({ dirty: false, mtime: 50 });
    const app = fakeApp(tab, { state: EditorState.create({ doc: "abc" }) });
    await app.checkExternalChange();
    tab.dirty = true;
    mtime = 200;
    await app.checkExternalChange();
    assert.equal(questions.length, 2);
    assert.doesNotMatch(questions[0], /lose/);
    assert.match(questions[1], /lose your unsaved changes/);
  } finally {
    dialogs.confirm3 = oldConfirm;
    settings.autoReloadExternal = true;
  }
});

test("letter shortcuts follow the keyboard layout (AZERTY), digits stay by position", () => {
  const { eventKey, matchesKey, parseChord } = load("keymap");
  const { stepForKey } = load("macros");
  const azertyA = { key: "a", code: "KeyQ", ctrlKey: true, shiftKey: false, altKey: false };
  assert.equal(eventKey(azertyA), "a");
  assert.equal(matchesKey(parseChord("Ctrl+A"), azertyA), true);
  assert.equal(matchesKey(parseChord("Ctrl+Q"), azertyA), false, "the A key must not comment lines");
  assert.equal(eventKey({ ...azertyA, key: "A", shiftKey: true }), "a");
  // Layouts without Latin letters keep the physical key, so Ctrl+C still copies.
  assert.equal(eventKey({ key: "с", code: "KeyC", ctrlKey: true, shiftKey: false, altKey: false }), "c");
  assert.equal(eventKey({ key: "&", code: "Digit1", ctrlKey: true, shiftKey: false, altKey: false }), "1");
  assert.deepEqual(stepForKey(azertyA), { type: "cmd", id: "edit.selectAll" });
  // AZERTY's "," sits where M is on US keyboards: Ctrl+, opens Settings, not Ctrl+M.
  const azertyComma = { key: ",", code: "KeyM", ctrlKey: true, shiftKey: false, altKey: false };
  assert.equal(eventKey(azertyComma), ",");
  assert.equal(matchesKey(parseChord("Ctrl+,"), azertyComma), true);
  assert.equal(matchesKey(parseChord("Ctrl+M"), azertyComma), false);
});

test("text typed through an input method is recorded in a macro", () => {
  const { MacroRecorder } = load("commands");
  const r = new MacroRecorder();
  const ev = (key, mods = {}) => ({ key, code: "KeyA", ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...mods });
  r.start();
  r.key(ev("Process", { isComposing: true }));
  r.composed("日本");
  r.composed("");
  // A dead key sequence (^ then e) whose result is a normal key press is recorded once.
  r.key(ev("ê"));
  r.composed("ê");
  r.stop();
  assert.deepEqual(r.last, [{ type: "text", text: "日本ê" }]);
});

test("Live Preview never loads images from network shares and loads internet images only when allowed", () => {
  const { imageSource, safeDecode } = load("paths");
  const doc = "C:\\notes\\a.md";
  assert.deepEqual(imageSource("pic.png", doc, false), { path: "C:\\notes\\pic.png" });
  assert.deepEqual(imageSource("my%20pic.png", doc, false), { path: "C:\\notes\\my pic.png" });
  assert.deepEqual(imageSource("100%.png", doc, false), { path: "C:\\notes\\100%.png" }, "invalid percent-encoding is kept as text");
  assert.deepEqual(imageSource("file:///C:/pics/x.png", doc, false), { path: "C:/pics/x.png" });
  for (const blocked of ["\\\\server\\share\\x.png", "//server/share/x.png", "file://server/share/x.png", "\\\\?\\C:\\x.png", "\\\\.\\pipe\\x", "asset://localhost/x.png", "javascript:alert(1)", "https://example.com/x.png"]) {
    assert.equal(imageSource(blocked, doc, false), null, blocked);
  }
  assert.deepEqual(imageSource("https://example.com/x.png", doc, true), { url: "https://example.com/x.png" });
  assert.equal(imageSource("http://example.com/x.png", doc, true), null, "plain http is never loaded");
  assert.deepEqual(imageSource("data:image/png;base64,AAAA", doc, false), { url: "data:image/png;base64,AAAA" });
  // A document on a share may show images from the same share, but not from other computers.
  const shared = "\\\\srv\\docs\\a.md";
  assert.deepEqual(imageSource("img/x.png", shared, false), { path: "\\\\srv\\docs\\img\\x.png" });
  assert.equal(imageSource("\\\\other\\s\\x.png", shared, false), null);
  assert.deepEqual(imageSource("..\\..\\other\\x.png", shared, false), { path: "\\\\srv\\docs\\other\\x.png" }, "\"..\" never leaves the share");
  assert.equal(imageSource("\\\\srv\\docs\\..\\..\\other\\x.png", shared, false), null);
  assert.deepEqual(imageSource("\\\\srv\\docs\\a..b.png", shared, false), { path: "\\\\srv\\docs\\a..b.png" }, "two dots inside a file name are fine");
  assert.equal(safeDecode("100%"), "100%");
  const { joinPath } = load("paths");
  assert.equal(joinPath("\\\\srv\\docs", "notes.md"), "\\\\srv\\docs\\notes.md", "links in documents on a share open on that share");
});

test("settings: wrong types are ignored", () => {
  const real = load("settings");
  const v = real.validSettings({ tabSize: "4", macros: { not: "a list" }, keyOverrides: [], wordWrap: true, unknown: 1, recentFiles: ["a"] });
  assert.deepEqual(v, { wordWrap: true, recentFiles: ["a"] });
  assert.ok(real.DATA_KEYS.includes("macros") && real.DATA_KEYS.includes("keyOverrides"));
});

// ---- 0.4.1: hex editor -----------------------------------------------------------------------

const memSource = (bytes) => ({ size: bytes.length, read: async (o, l) => bytes.slice(o, o + l) });

test("hex buffer: overwrite, insert, remove, undo and redo (small file)", async () => {
  const { HexBuffer } = load("hexbuffer");
  const b = await HexBuffer.load(memSource(Uint8Array.from([0x41, 0x42, 0x43, 0x44])));
  assert.equal(b.resizable, true);
  b.overwrite(1, Uint8Array.from([0x10]));
  b.overwrite(1, Uint8Array.from([0x1f])); // second hex digit of the same byte: one undo step
  b.insert(4, Uint8Array.from([0x0d, 0x0a]));
  b.remove(0, 1);
  assert.deepEqual([...b.bytes()], [0x1f, 0x43, 0x44, 0x0d, 0x0a]);
  assert.equal(b.dirty, true);
  assert.equal(b.isModified(0), true);
  assert.equal(b.isModified(1), false);
  b.undo();
  b.undo();
  assert.deepEqual([...b.bytes()], [0x41, 0x1f, 0x43, 0x44]);
  b.undo();
  assert.deepEqual([...b.bytes()], [0x41, 0x42, 0x43, 0x44]);
  assert.equal(b.dirty, false, "undo back to the loaded state is clean");
  assert.equal(b.isModified(1), false);
  b.redo();
  assert.deepEqual([...b.bytes()], [0x41, 0x1f, 0x43, 0x44]);
  // Writing past the end of a small file appends.
  b.overwrite(4, Uint8Array.from([1, 2]));
  assert.deepEqual([...b.bytes()], [0x41, 0x1f, 0x43, 0x44, 1, 2]);
  b.markSaved();
  assert.equal(b.dirty, false);
  b.undo();
  assert.equal(b.dirty, true, "undo after saving differs from the file");
});

test("hex buffer: large files are patched, never resized", async () => {
  const { HexBuffer } = load("hexbuffer");
  const data = Uint8Array.from({ length: 200000 }, (_, i) => i % 256);
  const reads = [];
  const src = { size: data.length, read: async (o, l) => (reads.push([o, l]), data.slice(o, o + l)) };
  const b = await HexBuffer.load(src, 1000);
  assert.equal(b.resizable, false);
  assert.equal(reads.length, 0, "nothing is read before it is shown");
  await b.ready(70000, 70010);
  assert.deepEqual(reads, [[65536, 65536]]);
  assert.equal(b.byteAt(70000), 70000 % 256);
  assert.equal(b.byteAt(10), undefined, "not loaded");
  assert.equal(b.overwrite(199999, Uint8Array.from([7, 8, 9])), 1, "cannot grow");
  assert.equal(b.size, 200000);
  await b.ready(199999, 200000);
  b.overwrite(70000, Uint8Array.from([0xee]));
  assert.deepEqual(b.patchList(), [
    [70000, 0xee],
    [199999, 7],
  ]);
  assert.throws(() => b.remove(0, 1));
  b.undo();
  b.undo();
  assert.deepEqual(b.patchList(), [], "undo removes the patches");
  assert.equal(b.dirty, false);
});

test("hex input parsing", () => {
  const { parseHex, textBytes, toHex } = load("hexbuffer");
  assert.deepEqual([...parseHex("41 42 0a")], [0x41, 0x42, 0x0a]);
  assert.deepEqual([...parseHex("0x4142,0x43")], [0x41, 0x42, 0x43]);
  assert.equal(parseHex("414"), null);
  assert.equal(parseHex("hello"), null);
  assert.deepEqual([...textBytes("Aü")], [0x41, 0xfc]);
  assert.deepEqual([...textBytes("€")], [0xe2, 0x82, 0xac]);
  assert.equal(toHex(Uint8Array.from([0, 255, 16])), "00 FF 10");
});

test("the hidden text editor cannot be changed while the hex view is shown", () => {
  const app = Object.create(App.prototype);
  assert.equal(app.effectiveReadOnly({ readOnly: false, paged: null, hexView: true }), true);
  assert.equal(app.effectiveReadOnly({ readOnly: false, paged: null, hexView: false }), false);
});

test("saving byte changes writes the bytes, not the hidden text", async () => {
  const { HexBuffer } = load("hexbuffer");
  const tab = { ...memoryTab({ dirty: true, revision: 0, savedRevision: 0, mtime: 1234 }), state: EditorState.create({ doc: "" }) };
  tab.hex = await HexBuffer.load(memSource(Uint8Array.from([1, 2, 3])));
  tab.hex.overwrite(0, Uint8Array.from([9]));
  const app = Object.create(App.prototype);
  Object.assign(app, { tabs: [tab], panes: [], splitOn: false, emit() {}, scheduleSessionSave() {}, addRecent() {} });
  const writes = [];
  backend.writeBytes = async (path, bytes, mtime) => (writes.push([path, [...bytes], mtime]), { size: 3, mtime: 5, name: "test.txt", path });
  backend.saveText = async () => assert.fail("the text must not be written");
  backend.openPath = async (id, path) => ({ kind: "memory", path, name: "test.txt", text: "\t\u0002\u0003", encoding: "windows-1252", eol: "LF", size: 3, lineCount: null, hadErrors: false, readOnly: false, readOnlyReason: null, mtime: 5, binary: true });
  backend.sessionDropBuffer = async () => {};
  assert.equal(await app.save(tab), true);
  assert.deepEqual(writes, [["test.txt", [9, 2, 3], 1234]]);
  assert.equal(tab.dirty, false);
  assert.equal(tab.hex, undefined, "the buffer is loaded again from the saved file");
  assert.equal(tab.mtime, 5);
});

// ---- 0.5.0: split view mapping, file types, value inspector ------------------------------------

test("byte map: text positions and file bytes map both ways", () => {
  const { createByteMap } = load("bytemap");
  const { Text } = require("@codemirror/state");
  // UTF-8 with CRLF: "Grüße\r\nok" is 6 + 1 (ü) + 1 (ß) bytes = "Gr" 2, "ü" 2, "ß" 2, "e" 1 = 7, CRLF 2, "ok" 2 = 11.
  const doc = Text.of(["Grüße", "ok"]);
  const m = createByteMap(doc, "UTF-8", "CRLF", 11);
  assert.ok(m);
  assert.equal(m.toByte(0), 0);
  assert.equal(m.toByte(3), 4, "after G, r, ü");
  assert.equal(m.toByte(5), 7, "end of line 1");
  assert.equal(m.toByte(6), 9, "line 2 starts after CRLF");
  assert.equal(m.toPos(4), 3);
  assert.equal(m.toPos(3), 2, "second byte of ü belongs to ü");
  assert.equal(m.toPos(8), 5, "inside the line break");
  assert.equal(m.toPos(10), 7);
  // A UTF-8 BOM shifts everything by three bytes.
  const bom = createByteMap(doc, "UTF-8-BOM", "CRLF", 14);
  assert.equal(bom.toByte(0), 3);
  assert.equal(bom.toPos(3), 0);
  // Single-byte code pages: one byte per character.
  const cp = createByteMap(Text.of(["Grüße"]), "windows-1252", "LF", 5);
  assert.equal(cp.toByte(4), 4);
  // UTF-16: two bytes per character, four for characters outside the BMP.
  const u16 = createByteMap(Text.of(["a😀b"]), "UTF-16LE", "LF", 2 + 8);
  assert.equal(u16.toByte(1), 4, "after BOM and a");
  assert.equal(u16.toByte(3), 8, "after the surrogate pair");
  // Unsupported or inconsistent: no map.
  assert.equal(createByteMap(doc, "GBK", "CRLF", 11), null);
  assert.equal(createByteMap(doc, "UTF-8", "LF", 11), null, "size does not match");
});

test("file types are recognized from their first bytes", () => {
  const { detectSignature } = load("signature");
  const b = (...x) => Uint8Array.from(x);
  assert.equal(detectSignature(b(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31)), "PDF");
  assert.equal(detectSignature(b(0x4d, 0x5a, 0x90, 0x00)), "Windows executable or DLL (PE)");
  assert.equal(detectSignature(b(0x50, 0x4b, 0x03, 0x04)), "ZIP archive (also DOCX, XLSX, JAR)");
  assert.equal(detectSignature(b(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69)), "MP4 or MOV video");
  assert.equal(detectSignature(b(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), "WebP image");
  assert.equal(detectSignature(b(0x68, 0x65, 0x6c, 0x6c, 0x6f)), null);
  assert.equal(detectSignature(b(0x25)), null, "too short");
});

test("value inspector reads numbers in both byte orders", () => {
  // inspector.ts needs the DOM; test its pure part through a tiny copy of the module.
  const src = fs.readFileSync(path.join(repo, "src/ui/inspector.ts"), "utf8");
  const start = src.indexOf("export function interpret");
  const end = src.indexOf("export interface Inspector");
  const code = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const ex = {};
  new Function("exports", code)(ex);
  const v = (bytes, le) => Object.fromEntries(ex.interpret(Uint8Array.from(bytes), le).map((x) => [x.label, x.value]));
  const le = v([0x01, 0x02, 0x00, 0x00, 0, 0, 0, 0], true);
  assert.equal(le.UInt16, "513");
  assert.equal(le.Int32, "513");
  assert.equal(le.Binary, "00000001");
  const be = v([0x01, 0x02], false);
  assert.equal(be.UInt16, "258");
  assert.equal(be.Int32, "–", "not enough bytes");
  assert.equal(v([0xff], true).Int8, "-1");
  assert.equal(v([0, 0, 0x80, 0x3f], true).Float32, "1");
});

test("hex buffer finds byte patterns forwards and backwards", async () => {
  const { HexBuffer } = load("hexbuffer");
  const data = Uint8Array.from([1, 2, 3, 1, 2, 3, 9]);
  const b = await HexBuffer.load({ size: data.length, read: async (o, l) => data.slice(o, o + l) });
  const p = Uint8Array.from([1, 2, 3]);
  assert.equal(await b.find(p, 0, false), 0);
  assert.equal(await b.find(p, 1, false), 3);
  assert.equal(await b.find(p, 4, false), null);
  assert.equal(await b.find(p, 6, true), 3);
  assert.equal(await b.find(p, 2, true), 0);
  // Large files delegate to the source (the backend search).
  const calls = [];
  const big = await HexBuffer.load({ size: 100, read: async () => new Uint8Array(0), find: async (pat, from, back) => (calls.push([from, back]), 42) }, 10);
  assert.equal(await big.find(p, 5, true), 42);
  assert.deepEqual(calls, [[5, true]]);
});

test("view modes: only the hex mode locks the text", () => {
  const app = Object.create(App.prototype);
  const tab = { readOnly: false, paged: null, hexView: true, splitView: true };
  assert.equal(app.effectiveReadOnly(tab), false, "split keeps the text editable");
  assert.equal(app.viewMode(tab), "split");
  tab.splitView = false;
  assert.equal(app.effectiveReadOnly(tab), true);
  assert.equal(app.viewMode(tab), "hex");
  tab.hexView = false;
  assert.equal(app.viewMode(tab), "text");
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
