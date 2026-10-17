// Find / Replace panel, Find in Files, Find All (document or all tabs) and the live line filter.
import { SearchQuery } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { App, Tab } from "../app";
import { backend, E_CANCELLED, E_NO_SCOPE, E_SEARCH_ENCODING, errorText, FindInFilesResult, FindOpts } from "../backend";
import { replacementAt, stickyRegex } from "../replace";
import { searchScope, setQuery, setSearchScope } from "../searchhl";
import { settings, updateSettings } from "../settings";
import { h, toast } from "./dialogs";
import { t } from "../i18n";

export interface FindPanel {
  open(mode: "find" | "replace" | "files"): void;
  close(): void;
  next(): void;
  prev(): void;
  isOpen(): boolean;
  findAll(scope: "doc" | "tabs"): Promise<void>;
  filterLines(): Promise<void>;
  /** Open Find in Files for a folder. */
  searchIn(dir: string): void;
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : p;
}

const MAX_HISTORY = 20;
const MAX_ROWS = 5000;

interface ResultRow {
  line: number;
  text: string;
  go: () => void | Promise<void>;
}
interface ResultGroup {
  title: string;
  tooltip?: string;
  open?: () => void;
  rows: ResultRow[];
}

let listCounter = 0;

export function mountFind(app: App, top: HTMLElement, bottom: HTMLElement): FindPanel {
  const findList = h("datalist", { id: `nax-find-history-${++listCounter}` });
  const replaceList = h("datalist", { id: `nax-replace-history-${listCounter}` });
  const findInput = h("input", { class: "input find-input", type: "text", placeholder: t("Find"), list: findList.id, autocomplete: "off" }) as HTMLInputElement;
  const replaceInput = h("input", { class: "input find-input", type: "text", placeholder: t("Replace"), list: replaceList.id, autocomplete: "off" }) as HTMLInputElement;
  const dirInput = h("input", { class: "input find-input", type: "text", placeholder: t("Folder") }) as HTMLInputElement;
  const globInput = h("input", { class: "input find-input glob", type: "text", placeholder: t("*.txt;*.md (all if empty)") }) as HTMLInputElement;
  const status = h("span", { class: "find-status" });

  const toggles = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    inSelection: false,
  };
  const makeToggle = (key: "caseSensitive" | "wholeWord" | "regex", label: string, title: string) => {
    const b = h("button", { class: "find-toggle", title, tabindex: "-1" }, label);
    b.addEventListener("click", () => {
      toggles[key] = !toggles[key];
      b.classList.toggle("on", toggles[key]);
      pushQuery();
      if (filterActive) scheduleFilter();
    });
    return b;
  };
  const tCase = makeToggle("caseSensitive", "Aa", t("Match case (Alt+C)"));
  const tWord = makeToggle("wholeWord", "ab", t("Whole word (Alt+W)"));
  const tRegex = makeToggle("regex", ".*", t("Regular expression (Alt+R)"));
  // "In selection only" captures the selection once as a fixed scope (see searchScope).
  const tSel = h("button", { class: "find-toggle", title: t("In selection only"), tabindex: "-1" }, "≡");
  tSel.addEventListener("click", () => void toggleScope());

  const btnPrev = h("button", { class: "btn small", title: t("Previous (Shift+F3)"), tabindex: "-1", click: () => prev() }, "↑");
  const btnNext = h("button", { class: "btn small", title: t("Next (F3)"), tabindex: "-1", click: () => next() }, "↓");
  const btnCount = h("button", { class: "btn small", title: t("Count matches"), tabindex: "-1", click: () => void count() }, t("Count"));
  const btnAll = h("button", { class: "btn small", title: t("Find All in Current Document"), tabindex: "-1", click: () => void findAll("doc") }, t("Find all"));
  const btnAllTabs = h("button", { class: "btn small", title: t("Find All in All Open Tabs"), tabindex: "-1", click: () => void findAll("tabs") }, t("All tabs"));
  const btnFilter = h("button", { class: "btn small", title: t("Show only matching lines, updated live (Ctrl+Alt+L)"), tabindex: "-1", click: () => void filterLines() }, t("Filter"));
  const btnCancel = h("button", { class: "btn small danger", title: t("Stop the running search"), tabindex: "-1", click: () => void backend.cancelSearch() }, t("Cancel"));
  btnCancel.style.display = "none";
  const btnReplace = h("button", { class: "btn small", click: () => void replaceOne() }, t("Replace"));
  const btnReplaceAll = h("button", { class: "btn small", click: () => void replaceAll() }, t("Replace all"));
  const btnFiles = h("button", { class: "btn small", click: () => void searchFiles() }, t("Search files"));
  const btnBrowse = h("button", { class: "btn small", title: t("Choose folder"), click: () => void browse() }, "…");
  const btnClose = h("button", { class: "find-close", title: t("Close (Esc)"), tabindex: "-1", click: () => close() }, "×");
  const modeBtn = (m: "find" | "replace" | "files", label: string) => h("button", { class: "find-mode", tabindex: "-1", click: () => open(m) }, label);
  const mFind = modeBtn("find", t("Find"));
  const mReplace = modeBtn("replace", t("Replace"));
  const mFiles = modeBtn("files", t("In Files"));

  const rowFind = h(
    "div",
    { class: "find-row" },
    h("div", { class: "find-modes" }, mFind, mReplace, mFiles),
    findInput,
    tCase,
    tWord,
    tRegex,
    tSel,
    btnPrev,
    btnNext,
    btnCount,
    btnAll,
    btnAllTabs,
    btnFilter,
    btnCancel,
    status,
    btnClose
  );
  const rowReplace = h("div", { class: "find-row" }, h("span", { class: "find-spacer" }), replaceInput, btnReplace, btnReplaceAll);
  const rowFiles = h("div", { class: "find-row" }, h("span", { class: "find-spacer" }), dirInput, btnBrowse, globInput, btnFiles);
  const panel = h("div", { class: "find-panel" }, rowFind, rowReplace, rowFiles, findList, replaceList);
  panel.style.display = "none";
  top.append(panel);

  const results = h("div", { class: "results-list" });
  const resultsTitle = h("span", { class: "results-title" }, t("Search results"));
  const resultsHeader = h("div", { class: "results-header" }, resultsTitle, h("button", { class: "find-close", title: t("Close"), click: () => hideResults() }, "×"));
  const resultsPanel = h("div", { class: "results-panel" }, resultsHeader, results);
  resultsPanel.style.display = "none";
  bottom.append(resultsPanel);

  let mode: "find" | "replace" | "files" = "find";
  let visible = false;

  // ---- history ----
  const renderHistory = () => {
    findList.replaceChildren(...settings.findHistory.map((v) => h("option", { value: v })));
    replaceList.replaceChildren(...settings.replaceHistory.map((v) => h("option", { value: v })));
  };
  renderHistory();
  const remember = (withReplace = false) => {
    const add = (list: string[], v: string) => (v ? [v, ...list.filter((x) => x !== v)].slice(0, MAX_HISTORY) : list);
    const patch: { findHistory: string[]; replaceHistory?: string[] } = { findHistory: add(settings.findHistory, findInput.value) };
    if (withReplace) patch.replaceHistory = add(settings.replaceHistory, replaceInput.value);
    if (patch.findHistory[0] === settings.findHistory[0] && !withReplace) return;
    updateSettings(patch, { silent: true });
    renderHistory();
  };

  const query = (): SearchQuery =>
    new SearchQuery({
      search: findInput.value,
      caseSensitive: toggles.caseSensitive,
      regexp: toggles.regex,
      wholeWord: toggles.wholeWord,
      replace: replaceInput.value,
      literal: !toggles.regex,
    });
  const opts = (): FindOpts => ({
    pattern: findInput.value,
    regex: toggles.regex,
    caseSensitive: toggles.caseSensitive,
    wholeWord: toggles.wholeWord,
  });

  const pushQuery = () => {
    const q = findInput.value ? query() : null;
    if (q && !q.valid) {
      status.textContent = t("Invalid regex");
      app.view.dispatch({ effects: setQuery.of(null) });
      return;
    }
    status.textContent = "";
    app.view.dispatch({ effects: setQuery.of(visible || filterActive ? q : null) });
  };
  app.on("active", pushQuery);

  /** Show the Cancel button while a backend search runs. */
  let busyCount = 0;
  const busy = async <T>(fn: () => Promise<T>): Promise<T> => {
    busyCount++;
    btnCancel.style.display = "";
    try {
      return await fn();
    } finally {
      if (--busyCount === 0) btnCancel.style.display = "none";
    }
  };

  const setScopeToggle = (on: boolean) => {
    toggles.inSelection = on;
    tSel.classList.toggle("on", on);
  };

  /** Range searched in a small file: the fixed scope, the whole document, or null if the scope is gone. */
  const scope = (): { from: number; to: number } | null => {
    if (!toggles.inSelection) return { from: 0, to: app.view.state.doc.length };
    return app.view.state.field(searchScope, false) ?? null;
  };

  function scopeLost(): void {
    setScopeToggle(false);
    app.view.dispatch({ effects: setSearchScope.of(null) });
    status.textContent = t("The selection scope no longer exists.");
  }

  async function toggleScope(): Promise<void> {
    const tab = app.active;
    if (!tab) return;
    if (toggles.inSelection) {
      setScopeToggle(false);
      if (tab.kind === "paged" && tab.paged) await tab.paged.clearScope().catch(() => undefined);
      else app.view.dispatch({ effects: setSearchScope.of(null) });
      pushQuery();
      return;
    }
    if (tab.kind === "paged" && tab.paged) {
      const ok = await tab.paged.setScope().catch((e) => {
        status.textContent = errorText(e);
        return false;
      });
      if (!ok) {
        toast(t("Select the text to search in first."));
        return;
      }
    } else {
      const sel = app.view.state.selection.main;
      if (sel.empty) {
        toast(t("Select the text to search in first."));
        return;
      }
      app.view.dispatch({ effects: setSearchScope.of({ from: sel.from, to: sel.to }) });
    }
    setScopeToggle(true);
    pushQuery();
  }

  // Show the scope state of the tab that becomes active.
  app.on("active", () => {
    const tab = app.active;
    const on = !!tab && (tab.kind === "paged" ? !!tab.paged?.scopeActive : !!app.view.state.field(searchScope, false));
    setScopeToggle(on);
  });

  /** Messages for errors returned by large-file search operations. */
  function pagedError(e: unknown): void {
    const msg = errorText(e);
    if (msg.startsWith(E_CANCELLED)) {
      status.textContent = t("Cancelled");
    } else if (msg.startsWith(E_NO_SCOPE)) {
      if (app.active?.paged) app.active.paged.scopeActive = false;
      scopeLost();
    } else if (msg.startsWith(E_SEARCH_ENCODING)) {
      status.textContent = t("Search is not available in large files in {encoding}.", { encoding: msg.slice(E_SEARCH_ENCODING.length) });
    } else status.textContent = msg;
  }

  function findMemory(backwards: boolean, fromSelEnd = true): boolean {
    const q = query();
    if (!q.valid || !q.search) return false;
    const state = app.view.state;
    const sel = state.selection.main;
    const sc = scope();
    if (!sc) {
      scopeLost();
      return false;
    }
    const matches: { from: number; to: number }[] = [];
    let hit: { from: number; to: number } | null = null;
    if (!backwards) {
      const start = fromSelEnd ? sel.to : sel.from;
      let c = q.getCursor(state, Math.max(sc.from, start), sc.to);
      let r = c.next();
      if (!r.done) hit = r.value;
      else {
        c = q.getCursor(state, sc.from, sc.to); // wrap
        r = c.next();
        if (!r.done) {
          hit = r.value;
          toast(t("Wrapped to start"));
        }
      }
    } else {
      const c = q.getCursor(state, sc.from, sc.to);
      for (let r = c.next(); !r.done; r = c.next()) matches.push(r.value);
      const before = matches.filter((m) => m.from < sel.from);
      hit = before.length ? before[before.length - 1] : matches.length ? (toast(t("Wrapped to end")), matches[matches.length - 1]) : null;
    }
    if (!hit) {
      status.textContent = t("Not found");
      return false;
    }
    app.view.dispatch({ selection: EditorSelection.range(hit.from, hit.to), scrollIntoView: true, effects: setQuery.of(q) });
    status.textContent = "";
    return true;
  }

  async function findPaged(backwards: boolean): Promise<boolean> {
    const tab = app.active;
    if (!tab?.paged || !findInput.value) return false;
    try {
      const m = await busy(() => tab.paged!.find(opts(), backwards, true, toggles.inSelection));
      status.textContent = m ? "" : t("Not found");
      app.view.dispatch({ effects: setQuery.of(query()) });
      return !!m;
    } catch (e) {
      pagedError(e);
      return false;
    }
  }

  function next(): void {
    if (!findInput.value) return;
    remember();
    if (app.active?.kind === "paged") void findPaged(false);
    else findMemory(false);
  }
  function prev(): void {
    if (!findInput.value) return;
    remember();
    if (app.active?.kind === "paged") void findPaged(true);
    else findMemory(true);
  }

  async function count(): Promise<void> {
    if (!findInput.value) return;
    remember();
    if (app.active?.kind === "paged") {
      const id = app.active.id;
      try {
        const n = await busy(() => backend.pagedCount(id, opts(), toggles.inSelection));
        status.textContent = t("{n} matches", { n: n.toLocaleString() });
      } catch (e) {
        pagedError(e);
      }
      return;
    }
    const q = query();
    if (!q.valid) return;
    const sc = scope();
    if (!sc) return scopeLost();
    let n = 0;
    const c = q.getCursor(app.view.state, sc.from, sc.to);
    for (let r = c.next(); !r.done; r = c.next()) n++;
    status.textContent = t("{n} matches", { n: n.toLocaleString() });
  }

  async function replaceOne(): Promise<void> {
    const tab = app.active;
    if (!tab || app.view.state.readOnly) return;
    const q = query();
    if (!q.valid || !q.search) return;
    remember(true);
    const state = app.view.state;
    const sel = state.selection.main;
    if (tab.kind === "paged") {
      // Replace the current selection if it is a match, then find the next one.
      const text = state.doc.toString();
      if (!sel.empty && selectionIsMatch(q, text, sel.from, sel.to)) {
        const rep = replacementAt(q, text, sel.from, sel.to);
        app.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: rep }, selection: { anchor: sel.from + rep.length }, userEvent: "input.replace" });
      }
      await findPaged(false);
      return;
    }
    const sc = scope();
    if (!sc) return scopeLost();
    if (!sel.empty && sel.from >= sc.from && sel.to <= sc.to) {
      const c = q.getCursor(state, sel.from, sel.to);
      const r = c.next();
      if (!r.done && r.value.from === sel.from && r.value.to === sel.to) {
        const rep = replacementAt(q, state.doc.toString(), sel.from, sel.to);
        app.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: rep }, selection: { anchor: sel.from + rep.length }, userEvent: "input.replace" });
      }
    }
    findMemory(false);
  }

  async function replaceAll(): Promise<void> {
    const tab = app.active;
    if (!tab || app.view.state.readOnly || !findInput.value) return;
    const q = query();
    if (!q.valid) return;
    remember(true);
    if (tab.kind === "paged" && tab.paged) {
      try {
        // q.replace has escapes like \n resolved, exactly as for small files.
        const n = await busy(() => tab.paged!.replaceAll(opts(), q.replace, toggles.inSelection));
        status.textContent = t("Replaced {n}", { n: n.toLocaleString() });
      } catch (e) {
        pagedError(e);
      }
      return;
    }
    const sc = scope();
    if (!sc) return scopeLost();
    const state = app.view.state;
    const text = state.doc.toString();
    const re = stickyRegex(q);
    const changes: { from: number; to: number; insert: string }[] = [];
    const c = q.getCursor(state, sc.from, sc.to);
    for (let r = c.next(); !r.done; r = c.next()) changes.push({ from: r.value.from, to: r.value.to, insert: replacementAt(q, text, r.value.from, r.value.to, re) });
    if (changes.length) app.view.dispatch({ changes, userEvent: "input.replace.all" });
    status.textContent = t("Replaced {n}", { n: changes.length.toLocaleString() });
  }

  async function browse(): Promise<void> {
    const d = await openDialog({ directory: true, title: t("Search in folder") });
    if (typeof d === "string") dirInput.value = d;
  }

  // ---- results panel ----
  function renderResults(title: string, groups: ResultGroup[], notes: HTMLElement[] = []): void {
    resultsTitle.replaceChildren(title, ...notes);
    results.replaceChildren();
    let shown = 0;
    for (const g of groups) {
      if (groups.length > 1 || g.title) results.append(h("div", { class: "result-file", title: g.tooltip ?? g.title, click: () => g.open?.() }, g.title, h("span", { class: "result-count" }, ` (${g.rows.length.toLocaleString()})`)));
      for (const row of g.rows) {
        if (shown++ >= MAX_ROWS) break;
        results.append(h("div", { class: "result-row", click: () => void row.go() }, h("span", { class: "result-line" }, String(row.line + 1)), h("span", { class: "result-text" }, row.text.length > 400 ? row.text.slice(0, 400) + "…" : row.text)));
      }
    }
    if (shown > MAX_ROWS) results.append(h("div", { class: "result-empty" }, t("Only the first {n} results are shown.", { n: MAX_ROWS.toLocaleString() })));
    if (!groups.some((g) => g.rows.length)) results.append(h("div", { class: "result-empty" }, t("No matches")));
    resultsPanel.style.display = "";
  }
  function hideResults(): void {
    resultsPanel.style.display = "none";
    stopFilter();
    app.view.focus();
  }

  async function searchFiles(): Promise<void> {
    if (!findInput.value) return;
    remember();
    stopFilter();
    const root = dirInput.value.trim() || (app.active?.path ? dirname(app.active.path) : "");
    if (!root) {
      toast(t("Choose a folder first"));
      return;
    }
    dirInput.value = root;
    status.textContent = t("Searching…");
    btnFiles.disabled = true;
    try {
      const res = await busy(() => backend.findInFiles(root, opts(), globInput.value.trim()));
      showFileResults(res, root);
      status.textContent = t("{n} hits", { n: res.hits.length.toLocaleString() }) + (res.truncated ? t(" (limit)") : "") + (res.cancelled ? " · " + t("Cancelled") : "");
    } catch (e) {
      status.textContent = String(e);
    } finally {
      btnFiles.disabled = false;
    }
  }

  const REASONS: Record<string, string> = {
    binary: t("binary file"),
    encoding: t("large file that is not UTF-8"),
    unreadable: t("could not be read"),
  };

  function showFileResults(res: FindInFilesResult, root: string): void {
    const groups: ResultGroup[] = [];
    let cur: ResultGroup | null = null;
    for (const hit of res.hits) {
      if (!cur || cur.tooltip !== hit.path) {
        const rel = hit.path.startsWith(root) ? hit.path.slice(root.length).replace(/^[\\/]/, "") : hit.path;
        const path = hit.path;
        cur = { title: rel, tooltip: path, open: () => void app.openFiles([path]), rows: [] };
        groups.push(cur);
      }
      cur.rows.push({
        line: hit.line,
        text: hit.text.trim(),
        go: async () => {
          await app.openFiles([hit.path]);
          await app.gotoLine(hit.line + 1, hit.col);
        },
      });
    }
    const files = new Set(res.hits.map((x) => x.path)).size;
    const notes: HTMLElement[] = [];
    if (res.cancelled) notes.push(h("span", { class: "results-note" }, " · " + t("Cancelled, results are incomplete")));
    if (res.truncated) notes.push(h("span", { class: "results-note" }, " · " + t("Stopped at {n} hits", { n: res.hits.length.toLocaleString() })));
    if (res.skippedCount) {
      const link = h("a", { href: "#", class: "results-note link" }, " · " + t("{n} files not searched", { n: res.skippedCount.toLocaleString() }));
      link.addEventListener("click", (e) => {
        e.preventDefault();
        renderResults(t("Files not searched"), [
          {
            title: "",
            rows: res.skipped.map((s) => ({ line: -1, text: `${s.path}  —  ${REASONS[s.reason] ?? s.reason}`, go: () => void app.openFiles([s.path]) })),
          },
        ]);
        results.querySelectorAll(".result-line").forEach((el) => (el.textContent = ""));
      });
      notes.push(link);
    }
    renderResults(t("{n} hits in {files} files ({searched} searched)", { n: res.hits.length.toLocaleString(), files: files.toLocaleString(), searched: res.filesSearched.toLocaleString() }), groups, notes);
  }

  /** Matches of the query in one tab, one row per match. */
  async function matchesIn(tab: Tab, q: SearchQuery, scoped: boolean): Promise<{ rows: ResultRow[]; truncated: boolean }> {
    if (tab.kind === "paged" && tab.paged) {
      await tab.paged.commit();
      const r = await backend.pagedFindAll(tab.id, opts(), scoped, MAX_ROWS);
      return {
        truncated: r.truncated,
        rows: r.hits.map((m) => ({
          line: m.line,
          text: m.text,
          go: async () => {
            app.activate(tab);
            await tab.paged!.selectMatch({ line: m.line, col: m.col, len: m.len, offset: 0 });
          },
        })),
      };
    }
    const st = app.stateOf(tab);
    const sc = scoped ? (st.field(searchScope, false) ?? null) : null;
    if (scoped && !sc) throw new Error(E_NO_SCOPE);
    const rows: ResultRow[] = [];
    const c = q.getCursor(st, sc?.from ?? 0, sc?.to ?? st.doc.length);
    let truncated = false;
    for (let r = c.next(); !r.done; r = c.next()) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const { from, to } = r.value;
      const line = st.doc.lineAt(from);
      rows.push({
        line: line.number - 1,
        text: line.text,
        go: () => {
          app.activate(tab);
          const len = app.view.state.doc.length;
          app.view.dispatch({ selection: EditorSelection.range(Math.min(from, len), Math.min(to, len)), effects: EditorView.scrollIntoView(Math.min(from, len), { y: "center" }) });
          app.view.focus();
        },
      });
    }
    return { rows, truncated };
  }

  async function findAll(where: "doc" | "tabs"): Promise<void> {
    if (!findInput.value) {
      open("find");
      return;
    }
    const q = query();
    if (!q.valid) {
      status.textContent = t("Invalid regex");
      return;
    }
    remember();
    stopFilter();
    const tabs = where === "doc" ? (app.active ? [app.active] : []) : app.tabs.filter((x) => !x.cloneOf);
    const groups: ResultGroup[] = [];
    let total = 0;
    const notes: HTMLElement[] = [];
    try {
      await busy(async () => {
        for (const tab of tabs) {
          const r = await matchesIn(tab, q, where === "doc" && toggles.inSelection);
          if (r.truncated) notes.push(h("span", { class: "results-note" }, " · " + t("{name}: only the first {n} matches", { name: tab.name, n: MAX_ROWS.toLocaleString() })));
          total += r.rows.length;
          if (r.rows.length || where === "doc") groups.push({ title: tab.name, tooltip: tab.path ?? tab.name, open: () => app.activate(tab), rows: r.rows });
        }
      });
    } catch (e) {
      pagedError(e);
      return;
    }
    status.textContent = t("{n} matches", { n: total.toLocaleString() });
    renderResults(where === "doc" ? t("Find all: {n} matches", { n: total.toLocaleString() }) : t("Find all in {tabs} tabs: {n} matches", { n: total.toLocaleString(), tabs: tabs.length }), groups, notes);
  }

  // ---- live line filter ----
  let filterActive = false;
  let filterTimer: number | undefined;
  let filterRunning = false;
  let filterAgain = false;

  function stopFilter(): void {
    filterActive = false;
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = undefined;
    resultsPanel.classList.remove("live");
  }

  function scheduleFilter(): void {
    if (!filterActive) return;
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => void runFilter(), 250);
  }

  async function runFilter(): Promise<void> {
    if (!filterActive) return;
    if (filterRunning) {
      filterAgain = true;
      return;
    }
    const tab = app.active;
    const q = query();
    if (!tab || !q.valid || !q.search) return;
    filterRunning = true;
    try {
      const atBottom = results.scrollTop + results.clientHeight >= results.scrollHeight - 4;
      const r = await matchesIn(tab, q, false);
      // One row per line.
      const rows: ResultRow[] = [];
      for (const row of r.rows) if (!rows.length || rows[rows.length - 1].line !== row.line) rows.push(row);
      const notes = r.truncated ? [h("span", { class: "results-note" }, " · " + t("Stopped at {n} hits", { n: MAX_ROWS.toLocaleString() }))] : [];
      renderResults(t('Filter "{pattern}" in {name}: {n} lines (live)', { pattern: q.search, name: tab.name, n: rows.length.toLocaleString() }), [{ title: "", rows }], notes);
      resultsPanel.classList.add("live");
      if (atBottom || tab.tail) results.scrollTop = results.scrollHeight;
    } catch (e) {
      pagedError(e);
    } finally {
      filterRunning = false;
      if (filterAgain) {
        filterAgain = false;
        scheduleFilter();
      }
    }
  }

  async function filterLines(): Promise<void> {
    if (!findInput.value) {
      open("find");
      status.textContent = t("Type the text to filter by, then press Filter.");
      return;
    }
    remember();
    filterActive = true;
    await runFilter();
  }
  app.on("doc", scheduleFilter);
  app.on("active", scheduleFilter);

  function open(m: "find" | "replace" | "files"): void {
    mode = m;
    visible = true;
    panel.style.display = "";
    rowReplace.style.display = m === "replace" ? "" : "none";
    rowFiles.style.display = m === "files" ? "" : "none";
    mFind.classList.toggle("on", m === "find");
    mReplace.classList.toggle("on", m === "replace");
    mFiles.classList.toggle("on", m === "files");
    const sel = app.view.state.selection.main;
    if (!sel.empty && sel.to - sel.from < 200) {
      const text = app.view.state.sliceDoc(sel.from, sel.to);
      if (!text.includes("\n")) findInput.value = text;
    }
    if (m === "files" && !dirInput.value && app.active?.path) dirInput.value = dirname(app.active.path);
    findInput.focus();
    findInput.select();
    pushQuery();
  }
  function close(): void {
    if (toggles.inSelection) void toggleScope();
    visible = false;
    panel.style.display = "none";
    status.textContent = "";
    app.view.dispatch({ effects: setQuery.of(filterActive ? query() : null) });
    app.view.focus();
  }

  findInput.addEventListener("input", () => {
    pushQuery();
    if (mode !== "files" && app.active?.kind !== "paged") findMemory(false, false);
    if (filterActive) scheduleFilter();
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "files" || e.target === dirInput || e.target === globInput) void searchFiles();
      else if (e.target === replaceInput) void replaceOne();
      else if (e.altKey) void findAll("doc");
      else if (e.shiftKey) prev();
      else next();
    } else if (e.altKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      tCase.click();
    } else if (e.altKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      tWord.click();
    } else if (e.altKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      tRegex.click();
    }
  });

  const searchIn = (dir: string) => {
    open("files");
    dirInput.value = dir;
  };

  return { open, close, next, prev, isOpen: () => visible, findAll, filterLines, searchIn };
}

/** Whether [from, to) of `text` is exactly one match of `q` (used for Replace in large files). */
function selectionIsMatch(q: SearchQuery, text: string, from: number, to: number): boolean {
  if (!q.valid || !q.search) return false;
  if (q.regexp) {
    const re = stickyRegex(q);
    if (!re) return false;
    re.lastIndex = from;
    const m = re.exec(text);
    return !!m && m.index === from && m[0].length === to - from;
  }
  const sel = text.slice(from, to);
  return q.caseSensitive ? sel === q.search : sel.toLowerCase() === q.search.toLowerCase();
}
