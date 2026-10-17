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
const settings = { pagedWindowLines: 3000, trimTrailingOnSave: false, ensureFinalNewline: false, lineNumbers: true, autoReloadExternal: true };
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
  Object.assign(app, { active: tab, tabs: [tab], view, emit() {}, scheduleSessionSave() {}, applyLanguage: async () => {} });
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
