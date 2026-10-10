// Find / Replace panel and Find in Files results.
import { SearchQuery } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { App } from "../app";
import { backend, FileHit, FindOpts } from "../backend";
import { setQuery } from "../searchhl";
import { h, toast } from "./dialogs";
import { t } from "../i18n";

export interface FindPanel {
  open(mode: "find" | "replace" | "files"): void;
  close(): void;
  next(): void;
  prev(): void;
  isOpen(): boolean;
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : p;
}

export function mountFind(app: App, top: HTMLElement, bottom: HTMLElement): FindPanel {
  const findInput = h("input", { class: "input find-input", type: "text", placeholder: t("Find") }) as HTMLInputElement;
  const replaceInput = h("input", { class: "input find-input", type: "text", placeholder: t("Replace") }) as HTMLInputElement;
  const dirInput = h("input", { class: "input find-input", type: "text", placeholder: t("Folder") }) as HTMLInputElement;
  const globInput = h("input", { class: "input find-input glob", type: "text", placeholder: t("*.txt;*.md (all if empty)") }) as HTMLInputElement;
  const status = h("span", { class: "find-status" });

  const toggles = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    inSelection: false,
  };
  const makeToggle = (key: keyof typeof toggles, label: string, title: string) => {
    const b = h("button", { class: "find-toggle", title, tabindex: "-1" }, label);
    b.addEventListener("click", () => {
      toggles[key] = !toggles[key];
      b.classList.toggle("on", toggles[key]);
      pushQuery();
    });
    return b;
  };
  const tCase = makeToggle("caseSensitive", "Aa", t("Match case (Alt+C)"));
  const tWord = makeToggle("wholeWord", "ab", t("Whole word (Alt+W)"));
  const tRegex = makeToggle("regex", ".*", t("Regular expression (Alt+R)"));
  const tSel = makeToggle("inSelection", "≡", t("In selection only"));

  const btnPrev = h("button", { class: "btn small", title: t("Previous (Shift+F3)"), tabindex: "-1", click: () => prev() }, "↑");
  const btnNext = h("button", { class: "btn small", title: t("Next (F3)"), tabindex: "-1", click: () => next() }, "↓");
  const btnCount = h("button", { class: "btn small", title: t("Count matches"), tabindex: "-1", click: () => void count() }, t("Count"));
  const btnReplace = h("button", { class: "btn small", click: () => void replaceOne() }, t("Replace"));
  const btnReplaceAll = h("button", { class: "btn small", click: () => void replaceAll() }, t("Replace all"));
  const btnFiles = h("button", { class: "btn small", click: () => void searchFiles() }, t("Search files"));
  const btnBrowse = h("button", { class: "btn small", title: t("Choose folder"), click: () => void browse() }, "…");
  const btnClose = h("button", { class: "find-close", title: t("Close (Esc)"), tabindex: "-1", click: () => close() }, "×");
  const modeBtn = (m: "find" | "replace" | "files", label: string) => h("button", { class: "find-mode", tabindex: "-1", click: () => open(m) }, label);
  const mFind = modeBtn("find", t("Find"));
  const mReplace = modeBtn("replace", t("Replace"));
  const mFiles = modeBtn("files", t("In Files"));

  const rowFind = h("div", { class: "find-row" }, h("div", { class: "find-modes" }, mFind, mReplace, mFiles), findInput, tCase, tWord, tRegex, tSel, btnPrev, btnNext, btnCount, status, btnClose);
  const rowReplace = h("div", { class: "find-row" }, h("span", { class: "find-spacer" }), replaceInput, btnReplace, btnReplaceAll);
  const rowFiles = h("div", { class: "find-row" }, h("span", { class: "find-spacer" }), dirInput, btnBrowse, globInput, btnFiles);
  const panel = h("div", { class: "find-panel" }, rowFind, rowReplace, rowFiles);
  panel.style.display = "none";
  top.append(panel);

  const results = h("div", { class: "results-list" });
  const resultsHeader = h("div", { class: "results-header" }, h("span", { class: "results-title" }, t("Search results")), h("button", { class: "find-close", click: () => hideResults() }, "×"));
  const resultsPanel = h("div", { class: "results-panel" }, resultsHeader, results);
  resultsPanel.style.display = "none";
  bottom.append(resultsPanel);

  let mode: "find" | "replace" | "files" = "find";
  let visible = false;

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
    app.view.dispatch({ effects: setQuery.of(visible ? q : null) });
  };
  app.on("active", pushQuery);

  const scope = () => {
    const sel = app.view.state.selection.main;
    return toggles.inSelection && !sel.empty ? { from: sel.from, to: sel.to } : { from: 0, to: app.view.state.doc.length };
  };

  function findMemory(backwards: boolean, fromSelEnd = true): boolean {
    const q = query();
    if (!q.valid || !q.search) return false;
    const state = app.view.state;
    const sel = state.selection.main;
    const sc = scope();
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
      const m = await tab.paged.find(opts(), backwards, true);
      status.textContent = m ? "" : t("Not found");
      app.view.dispatch({ effects: setQuery.of(query()) });
      return !!m;
    } catch (e) {
      status.textContent = String(e);
      return false;
    }
  }

  function next(): void {
    if (!findInput.value) return;
    if (app.active?.kind === "paged") void findPaged(false);
    else findMemory(false);
  }
  function prev(): void {
    if (!findInput.value) return;
    if (app.active?.kind === "paged") void findPaged(true);
    else findMemory(true);
  }

  async function count(): Promise<void> {
    if (!findInput.value) return;
    if (app.active?.kind === "paged") {
      const n = await backend.pagedCount(app.active.id, opts()).catch((e) => (status.textContent = String(e), 0));
      status.textContent = t("{n} matches", { n: n.toLocaleString() });
      return;
    }
    const q = query();
    if (!q.valid) return;
    const sc = scope();
    let n = 0;
    const c = q.getCursor(app.view.state, sc.from, sc.to);
    for (let r = c.next(); !r.done; r = c.next()) n++;
    status.textContent = t("{n} matches", { n: n.toLocaleString() });
  }

  async function replaceOne(): Promise<void> {
    const tab = app.active;
    if (!tab || tab.readOnly) return;
    if (tab.kind === "paged") {
      // replace the current selection if it matches, then find next
      const q = query();
      const sel = app.view.state.selection.main;
      const text = app.view.state.sliceDoc(sel.from, sel.to);
      if (!sel.empty && matchesWhole(q, text)) {
        const rep = replacementFor(q, text);
        app.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: rep }, selection: { anchor: sel.from + rep.length } });
      }
      await findPaged(false);
      return;
    }
    const q = query();
    if (!q.valid || !q.search) return;
    const state = app.view.state;
    const sel = state.selection.main;
    const c = q.getCursor(state, sel.from, sel.to);
    const r = c.next();
    if (!sel.empty && !r.done && r.value.from === sel.from && r.value.to === sel.to) {
      const rep = replacementFor(q, state.sliceDoc(r.value.from, r.value.to));
      app.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: rep }, selection: { anchor: sel.from + rep.length } });
    }
    findMemory(false);
  }

  async function replaceAll(): Promise<void> {
    const tab = app.active;
    if (!tab || tab.readOnly || !findInput.value) return;
    if (tab.kind === "paged" && tab.paged) {
      const n = await tab.paged.replaceAll(opts(), replaceInput.value).catch((e) => (status.textContent = String(e), 0));
      status.textContent = t("Replaced {n}", { n: n.toLocaleString() });
      return;
    }
    const q = query();
    if (!q.valid) return;
    const sc = scope();
    const changes: { from: number; to: number; insert: string }[] = [];
    const c = q.getCursor(app.view.state, sc.from, sc.to);
    for (let r = c.next(); !r.done; r = c.next()) changes.push({ from: r.value.from, to: r.value.to, insert: replacementFor(q, app.view.state.sliceDoc(r.value.from, r.value.to)) });
    if (changes.length) app.view.dispatch({ changes, userEvent: "input.replace.all" });
    status.textContent = t("Replaced {n}", { n: changes.length.toLocaleString() });
  }

  async function browse(): Promise<void> {
    const d = await openDialog({ directory: true, title: t("Search in folder") });
    if (typeof d === "string") dirInput.value = d;
  }

  async function searchFiles(): Promise<void> {
    if (!findInput.value) return;
    const root = dirInput.value.trim() || (app.active?.path ? dirname(app.active.path) : "");
    if (!root) {
      toast(t("Choose a folder first"));
      return;
    }
    dirInput.value = root;
    status.textContent = t("Searching…");
    btnFiles.disabled = true;
    try {
      const hits = await backend.findInFiles(root, opts(), globInput.value.trim());
      showResults(hits, root);
      status.textContent = t("{n} hits", { n: hits.length.toLocaleString() }) + (hits.length >= 5000 ? t(" (limit)") : "");
    } catch (e) {
      status.textContent = String(e);
    } finally {
      btnFiles.disabled = false;
    }
  }

  function showResults(hits: FileHit[], root: string): void {
    results.replaceChildren();
    let lastPath = "";
    for (const hit of hits) {
      if (hit.path !== lastPath) {
        lastPath = hit.path;
        const rel = hit.path.startsWith(root) ? hit.path.slice(root.length).replace(/^[\\/]/, "") : hit.path;
        results.append(h("div", { class: "result-file", title: hit.path, click: () => void app.openFiles([hit.path]) }, rel));
      }
      const row = h(
        "div",
        {
          class: "result-row",
          click: async () => {
            await app.openFiles([hit.path]);
            await app.gotoLine(hit.line + 1, hit.col);
          },
        },
        h("span", { class: "result-line" }, String(hit.line + 1)),
        h("span", { class: "result-text" }, hit.text.trim())
      );
      results.append(row);
    }
    if (!hits.length) results.append(h("div", { class: "result-empty" }, t("No matches")));
    resultsPanel.style.display = "";
  }
  function hideResults(): void {
    resultsPanel.style.display = "none";
    app.view.focus();
  }

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
    visible = false;
    panel.style.display = "none";
    status.textContent = "";
    app.view.dispatch({ effects: setQuery.of(null) });
    app.view.focus();
  }

  findInput.addEventListener("input", () => {
    pushQuery();
    if (mode !== "files" && app.active?.kind !== "paged") findMemory(false, false);
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "files" || e.target === dirInput || e.target === globInput) void searchFiles();
      else if (e.target === replaceInput) void replaceOne();
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

  return { open, close, next, prev, isOpen: () => visible };
}

function matchesWhole(q: SearchQuery, text: string): boolean {
  if (!q.valid || !q.search) return false;
  if (q.regexp) {
    try {
      const re = new RegExp(`^(?:${q.search})$`, q.caseSensitive ? "" : "i");
      return re.test(text);
    } catch {
      return false;
    }
  }
  return q.caseSensitive ? text === q.search : text.toLowerCase() === q.search.toLowerCase();
}

/** Expand the replacement for one matched string ($1, $&, $<name> in regex mode). */
function replacementFor(q: SearchQuery, matched: string): string {
  if (!q.regexp) return q.replace;
  const flags = q.caseSensitive ? "" : "i";
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${q.search})$`, flags + "u");
  } catch {
    try {
      re = new RegExp(`^(?:${q.search})$`, flags);
    } catch {
      return q.replace;
    }
  }
  return re.test(matched) ? matched.replace(re, q.replace) : q.replace;
}
