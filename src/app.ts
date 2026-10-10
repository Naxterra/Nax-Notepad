// Application state: tabs, the single EditorView, file I/O, session persistence.
import { EditorSelection, EditorState, Extension, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { backend, Eol, SessionData, TabMeta } from "./backend";
import { compartments, createState, languageByName, languageForFile, loadLanguage } from "./editor";
import { livePreview, LivePreviewConfig } from "./livepreview";
import { PagedController, pagedLoad } from "./paged";
import { settings } from "./settings";
import { confirm3 } from "./ui/dialogs";

export type TabKind = "memory" | "paged";

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  kind: TabKind;
  encoding: string;
  eol: Eol;
  languageName: string | null;
  dirty: boolean;
  state: EditorState;
  mtime: number;
  size: number;
  readOnly: boolean;
  pinned: boolean;
  livePreview: boolean;
  untitled: number | null;
  paged: PagedController | null;
  scrollTop: number;
  bufferTimer?: number;
  pendingCursor?: { line: number; col: number };
}

type Listener = () => void;

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}
function joinPath(dir: string, rel: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("\\\\") || rel.startsWith("/")) return rel;
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  const parts = (dir + sep + rel).split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join(sep);
}

let idCounter = 0;
function newId(): string {
  return `t${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

export class App {
  tabs: Tab[] = [];
  active: Tab | null = null;
  view: EditorView;
  nextUntitled = 1;
  private listeners = new Map<string, Set<Listener>>();
  private sessionTimer: number | undefined;
  private restoring = false;
  private cursorSaveTimer: number | undefined;

  constructor(parent: HTMLElement) {
    this.view = new EditorView({ parent, state: EditorState.create({ doc: "" }) });
    window.addEventListener("focus", () => void this.checkExternalChange());
  }

  // ---- events ----------------------------------------------------------------------------
  on(event: "tabs" | "status" | "active", fn: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  emit(event: "tabs" | "status" | "active"): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  // ---- editor state helpers -------------------------------------------------------------
  private listenerExt(): Extension {
    return EditorView.updateListener.of((u) => {
      const tab = this.active;
      if (!tab) return;
      if (u.docChanged) {
        const fromLoad = u.transactions.some((t) => t.annotation(pagedLoad));
        if (!fromLoad) {
          if (!tab.dirty) {
            tab.dirty = true;
            this.emit("tabs");
          }
          if (tab.kind === "paged") tab.paged?.noteChange();
          else this.scheduleBufferStore(tab);
        }
      }
      if (u.docChanged || u.selectionSet) {
        this.emit("status");
        this.scheduleCursorSave();
      }
    });
  }

  private lpConfig(tab: Tab): LivePreviewConfig {
    return {
      resolveImage: (src) => {
        if (/^(https?:|data:|file:|asset:)/i.test(src)) return src;
        const base = tab.path ? dirname(tab.path) : "";
        const abs = base ? joinPath(base, decodeURIComponent(src)) : src;
        return convertFileSrc(abs);
      },
      openLink: (href) => {
        if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) void openUrl(href);
        else if (tab.path) void this.openFiles([joinPath(dirname(tab.path), decodeURIComponent(href.split("#")[0]))]);
      },
    };
  }

  private buildState(tab: Tab, text: string, language: Extension, firstLineOffset = 0): EditorState {
    return createState({
      text,
      settings,
      readOnly: tab.readOnly,
      livePreview: tab.livePreview && tab.languageName === "Markdown",
      lpConfig: this.lpConfig(tab),
      language,
      firstLineOffset,
      extra: [this.listenerExt()],
    });
  }

  private async applyLanguage(tab: Tab, desc: LanguageDescription | null): Promise<void> {
    tab.languageName = desc?.name ?? null;
    const ext: Extension = desc ? await loadLanguage(desc) : [];
    const effects = [
      compartments.language.reconfigure(ext),
      compartments.livePreview.reconfigure(tab.livePreview && tab.languageName === "Markdown" ? livePreview(this.lpConfig(tab)) : []),
    ];
    this.dispatchTo(tab, { effects });
    this.emit("status");
    this.scheduleSessionSave();
  }

  /** Dispatch to a tab whether or not it is active. */
  dispatchTo(tab: Tab, spec: TransactionSpec): void {
    if (tab === this.active) this.view.dispatch(spec);
    else tab.state = tab.state.update(spec).state;
  }

  // ---- tab lifecycle --------------------------------------------------------------------
  private makeTab(partial: Partial<Tab> & { name: string; kind: TabKind }): Tab {
    const tab: Tab = {
      id: partial.id ?? newId(),
      path: partial.path ?? null,
      name: partial.name,
      kind: partial.kind,
      encoding: partial.encoding ?? settings.defaultEncoding,
      eol: partial.eol ?? settings.defaultEol,
      languageName: partial.languageName ?? null,
      dirty: partial.dirty ?? false,
      state: partial.state ?? EditorState.create({ doc: "" }),
      mtime: partial.mtime ?? 0,
      size: partial.size ?? 0,
      readOnly: partial.readOnly ?? false,
      pinned: partial.pinned ?? false,
      livePreview: partial.livePreview ?? settings.livePreviewDefault,
      untitled: partial.untitled ?? null,
      paged: partial.paged ?? null,
      scrollTop: partial.scrollTop ?? 0,
    };
    return tab;
  }

  private insertTab(tab: Tab, index?: number): void {
    if (index === undefined || index < 0 || index > this.tabs.length) this.tabs.push(tab);
    else this.tabs.splice(index, 0, tab);
  }

  newTab(text = "", activate = true): Tab {
    const n = this.nextUntitled++;
    const tab = this.makeTab({ name: `new ${n}`, kind: "memory", untitled: n });
    tab.state = this.buildState(tab, text, []);
    this.insertTab(tab);
    if (activate) this.activate(tab);
    this.emit("tabs");
    this.scheduleSessionSave();
    return tab;
  }

  findByPath(path: string): Tab | undefined {
    const norm = path.toLowerCase();
    return this.tabs.find((t) => t.path && t.path.toLowerCase() === norm);
  }

  async openFiles(paths: string[], activate = true): Promise<Tab | null> {
    let last: Tab | null = null;
    for (const p of paths) {
      const existing = this.findByPath(p);
      if (existing) {
        last = existing;
        continue;
      }
      try {
        last = await this.openOne(p);
      } catch (e) {
        await message(String(e), { title: "Nax-Notepad", kind: "error" });
      }
    }
    if (last && activate) this.activate(last);
    this.emit("tabs");
    this.scheduleSessionSave();
    return last;
  }

  private async openOne(path: string, id?: string, restoreOpts?: { livePreview?: boolean; languageName?: string | null; paged?: boolean }): Promise<Tab> {
    const tabId = id ?? newId();
    const res = restoreOpts?.paged ? await backend.pagedRestore(tabId, path).catch(() => backend.openPath(tabId, path)) : await backend.openPath(tabId, path);
    const tab = this.makeTab({
      id: tabId,
      path: res.path,
      name: res.name,
      kind: res.kind,
      encoding: res.encoding,
      eol: res.eol,
      mtime: res.mtime,
      size: res.size,
      readOnly: res.readOnly,
      livePreview: restoreOpts?.livePreview ?? settings.livePreviewDefault,
    });
    const desc = restoreOpts?.languageName ? languageByName(restoreOpts.languageName) : languageForFile(res.name);
    tab.languageName = desc?.name ?? null;
    const langExt: Extension = desc ? await loadLanguage(desc) : [];
    if (res.kind === "paged") {
      tab.paged = new PagedController(
        tabId,
        res.lineCount ?? 1,
        () => (this.active === tab ? this.view : null),
        { onWindowChanged: () => this.emit("status") },
        () => {
          if (!tab.dirty) {
            tab.dirty = true;
            this.emit("tabs");
          }
        }
      );
      const w = await backend.pagedWindow(tabId, 0, Math.max(500, settings.pagedWindowLines));
      tab.paged.firstLine = w.firstLine;
      tab.paged.count = w.count;
      tab.paged.totalLines = w.totalLines;
      tab.dirty = w.dirty;
      tab.state = this.buildState(tab, w.text, langExt, 0);
    } else {
      tab.state = this.buildState(tab, res.text ?? "", langExt);
    }
    // Replace an empty, untouched untitled tab if it is the only one.
    const placeholder = this.tabs.length === 1 && this.tabs[0].untitled !== null && !this.tabs[0].dirty && this.tabs[0].state.doc.length === 0 ? this.tabs[0] : null;
    this.insertTab(tab);
    if (placeholder) await this.closeTab(placeholder, true);
    return tab;
  }

  activate(tab: Tab): void {
    if (this.active === tab) return;
    if (this.active) {
      this.active.state = this.view.state;
      this.active.scrollTop = this.view.scrollDOM.scrollTop;
      this.active.paged?.detach();
    }
    this.active = tab;
    this.view.setState(tab.state);
    tab.paged?.attach(this.view);
    const st = tab.scrollTop;
    this.view.requestMeasure({
      read: () => null,
      write: () => {
        this.view.scrollDOM.scrollTop = st;
      },
    });
    if (tab.pendingCursor) {
      const pc = tab.pendingCursor;
      tab.pendingCursor = undefined;
      void this.gotoLine(pc.line, pc.col);
    }
    this.view.focus();
    this.emit("active");
    this.emit("tabs");
    this.emit("status");
    this.scheduleSessionSave();
    void this.checkExternalChange();
  }

  activateIndex(i: number): void {
    if (i >= 0 && i < this.tabs.length) this.activate(this.tabs[i]);
  }

  nextTab(delta: number): void {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activateIndex((i + delta + this.tabs.length) % this.tabs.length);
  }

  moveTab(tab: Tab, toIndex: number): void {
    const from = this.tabs.indexOf(tab);
    if (from < 0) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.emit("tabs");
    this.scheduleSessionSave();
  }

  /** Close a tab. Returns false if the user cancelled. */
  async closeTab(tab: Tab, force = false): Promise<boolean> {
    if (!force && tab.dirty) {
      this.activate(tab);
      const r = await confirm3("Save changes?", `Save changes to "${tab.name}" before closing?`);
      if (r === "cancel") return false;
      if (r === "yes") {
        const ok = await this.save(tab);
        if (!ok) return false;
      }
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    this.tabs.splice(i, 1);
    if (tab.bufferTimer) clearTimeout(tab.bufferTimer);
    tab.paged?.dispose();
    if (tab.kind === "paged") void backend.pagedClose(tab.id);
    void backend.sessionDropBuffer(tab.id);
    if (this.active === tab) {
      this.active = null;
      if (this.tabs.length === 0) this.newTab();
      else this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
    }
    this.emit("tabs");
    this.scheduleSessionSave();
    return true;
  }

  async closeOthers(keep: Tab): Promise<void> {
    for (const t of [...this.tabs]) if (t !== keep && !t.pinned) if (!(await this.closeTab(t))) return;
  }
  async closeAll(): Promise<void> {
    for (const t of [...this.tabs]) if (!t.pinned) if (!(await this.closeTab(t))) return;
  }
  async closeToRight(tab: Tab): Promise<void> {
    const i = this.tabs.indexOf(tab);
    for (const t of this.tabs.slice(i + 1)) if (!t.pinned) if (!(await this.closeTab(t))) return;
  }

  // ---- saving -------------------------------------------------------------------------
  docText(tab: Tab): string {
    const state = tab === this.active ? this.view.state : tab.state;
    return state.doc.toString();
  }

  async save(tab: Tab): Promise<boolean> {
    if (!tab.path) return this.saveAs(tab);
    try {
      if (tab.kind === "paged" && tab.paged) {
        await tab.paged.commit();
        const r = await backend.pagedSave(tab.id);
        tab.mtime = r.mtime;
        tab.size = r.size;
        await tab.paged.load(tab.paged.firstLine, tab.paged.cursorLine(this.view));
      } else {
        this.applySaveTransforms(tab);
        const r = await backend.saveText(tab.path, this.docText(tab), tab.encoding, tab.eol);
        tab.mtime = r.mtime;
        tab.size = r.size;
      }
      tab.dirty = false;
      if (tab.bufferTimer) clearTimeout(tab.bufferTimer);
      void backend.sessionDropBuffer(tab.id);
      this.emit("tabs");
      this.emit("status");
      this.scheduleSessionSave();
      return true;
    } catch (e) {
      await message(String(e), { title: "Save failed", kind: "error" });
      return false;
    }
  }

  private applySaveTransforms(tab: Tab): void {
    if (!settings.trimTrailingOnSave && !settings.ensureFinalNewline) return;
    const state = tab === this.active ? this.view.state : tab.state;
    const changes: { from: number; to: number; insert?: string }[] = [];
    if (settings.trimTrailingOnSave) {
      for (let i = 1; i <= state.doc.lines; i++) {
        const line = state.doc.line(i);
        const m = /[ \t]+$/.exec(line.text);
        if (m) changes.push({ from: line.from + m.index, to: line.to });
      }
    }
    if (settings.ensureFinalNewline && state.doc.length > 0 && !state.doc.sliceString(state.doc.length - 1) .endsWith("\n")) {
      changes.push({ from: state.doc.length, to: state.doc.length, insert: "\n" });
    }
    if (changes.length) this.dispatchTo(tab, { changes });
  }

  async saveAs(tab: Tab): Promise<boolean> {
    const target = await saveDialog({
      defaultPath: tab.path ?? `${tab.name}${tab.untitled !== null ? ".txt" : ""}`,
      title: "Save As",
    });
    if (!target) return false;
    try {
      if (tab.kind === "paged" && tab.paged) {
        await tab.paged.commit();
        const r = await backend.pagedSave(tab.id, target);
        tab.path = r.path;
        tab.name = r.name;
        tab.mtime = r.mtime;
        tab.size = r.size;
        await tab.paged.load(tab.paged.firstLine, tab.paged.cursorLine(this.view));
      } else {
        this.applySaveTransforms(tab);
        const r = await backend.saveText(target, this.docText(tab), tab.encoding, tab.eol);
        tab.path = r.path;
        tab.name = r.name;
        tab.mtime = r.mtime;
        tab.size = r.size;
      }
      tab.untitled = null;
      tab.dirty = false;
      void backend.sessionDropBuffer(tab.id);
      await this.applyLanguage(tab, languageForFile(tab.name));
      this.emit("tabs");
      this.emit("status");
      this.scheduleSessionSave();
      return true;
    } catch (e) {
      await message(String(e), { title: "Save failed", kind: "error" });
      return false;
    }
  }

  async saveAll(): Promise<void> {
    for (const t of [...this.tabs]) if (t.dirty) if (!(await this.save(t))) return;
  }

  async openDialog(): Promise<void> {
    const sel = await openDialog({ multiple: true, title: "Open" });
    if (!sel) return;
    await this.openFiles(Array.isArray(sel) ? sel : [sel]);
  }

  async reload(tab: Tab): Promise<void> {
    if (!tab.path) return;
    if (tab.kind === "paged" && tab.paged) {
      await backend.pagedClose(tab.id);
      const res = await backend.openPath(tab.id, tab.path, true);
      tab.paged.totalLines = res.lineCount ?? 1;
      tab.mtime = res.mtime;
      tab.size = res.size;
      tab.dirty = false;
      await tab.paged.load(tab.paged.firstLine, tab.paged.cursorLine(this.view));
    } else {
      const res = await backend.openPath(tab.id, tab.path);
      const state = tab === this.active ? this.view.state : tab.state;
      const head = state.selection.main.head;
      this.dispatchTo(tab, {
        changes: { from: 0, to: state.doc.length, insert: res.text ?? "" },
        selection: { anchor: Math.min(head, (res.text ?? "").length) },
        annotations: [Transaction.addToHistory.of(true)],
      });
      tab.encoding = res.encoding;
      tab.eol = res.eol;
      tab.mtime = res.mtime;
      tab.size = res.size;
      tab.dirty = false;
      void backend.sessionDropBuffer(tab.id);
    }
    this.emit("tabs");
    this.emit("status");
  }

  private checking = false;
  async checkExternalChange(): Promise<void> {
    const tab = this.active;
    if (!tab || !tab.path || this.checking || tab.kind === "paged") return;
    this.checking = true;
    try {
      const exists = await backend.pathExists(tab.path);
      if (!exists) return;
      const mtime = await backend.fileMtime(tab.path);
      if (mtime === tab.mtime) return;
      if (!tab.dirty && settings.autoReloadExternal) {
        await this.reload(tab);
        return;
      }
      tab.mtime = mtime; // ask once per change
      const r = await confirm3("File changed on disk", `"${tab.name}" was modified outside Nax-Notepad.\nReload it and lose your unsaved changes?`, ["Reload", "Keep mine"]);
      if (r === "yes") await this.reload(tab);
    } catch {
      /* ignore */
    } finally {
      this.checking = false;
    }
  }

  // ---- per-tab properties ---------------------------------------------------------------
  async setLanguage(tab: Tab, name: string | null): Promise<void> {
    const desc = name ? languageByName(name) : null;
    await this.applyLanguage(tab, desc);
  }

  setEncoding(tab: Tab, enc: string): void {
    tab.encoding = enc;
    if (tab.kind === "memory") {
      tab.dirty = true;
      this.scheduleBufferStore(tab);
    }
    this.emit("tabs");
    this.emit("status");
    this.scheduleSessionSave();
  }

  setEol(tab: Tab, eol: Eol): void {
    tab.eol = eol;
    tab.dirty = true;
    if (tab.kind === "paged") void backend.pagedSetEol(tab.id, eol);
    else this.scheduleBufferStore(tab);
    this.emit("tabs");
    this.emit("status");
    this.scheduleSessionSave();
  }

  toggleLivePreview(tab: Tab): void {
    tab.livePreview = !tab.livePreview;
    this.dispatchTo(tab, {
      effects: compartments.livePreview.reconfigure(tab.livePreview && tab.languageName === "Markdown" ? livePreview(this.lpConfig(tab)) : []),
    });
    this.emit("status");
    this.scheduleSessionSave();
  }

  setReadOnly(tab: Tab, ro: boolean): void {
    tab.readOnly = ro;
    this.dispatchTo(tab, { effects: compartments.readOnly.reconfigure(EditorState.readOnly.of(ro)) });
    this.emit("status");
  }

  togglePinned(tab: Tab): void {
    tab.pinned = !tab.pinned;
    this.emit("tabs");
    this.scheduleSessionSave();
  }

  /** Re-apply settings-dependent compartments to every tab. */
  applySettingsToAll(effectsFor: (tab: Tab) => import("@codemirror/state").StateEffect<unknown>[]): void {
    for (const t of this.tabs) this.dispatchTo(t, { effects: effectsFor(t) });
    this.view.requestMeasure();
  }

  // ---- navigation -----------------------------------------------------------------------
  async gotoLine(line1: number, col = 0): Promise<void> {
    const tab = this.active;
    if (!tab) return;
    if (tab.kind === "paged" && tab.paged) {
      await tab.paged.gotoLine(line1 - 1, col);
      return;
    }
    const doc = this.view.state.doc;
    const n = Math.max(1, Math.min(line1, doc.lines));
    const l = doc.line(n);
    this.view.dispatch({
      selection: EditorSelection.cursor(Math.min(l.from + col, l.to)),
      effects: EditorView.scrollIntoView(l.from, { y: "center" }),
    });
    this.view.focus();
  }

  /** Absolute 1-based cursor line/column for the status bar. */
  cursorInfo(): { line: number; col: number; selLen: number; selLines: number; totalLines: number } {
    const tab = this.active;
    const state = this.view.state;
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    const offset = tab?.paged?.firstLine ?? 0;
    let selLen = 0;
    let selLines = 0;
    for (const r of state.selection.ranges) {
      selLen += r.to - r.from;
      if (!r.empty) selLines += state.doc.lineAt(r.to).number - state.doc.lineAt(r.from).number + 1;
    }
    return {
      line: line.number + offset,
      col: main.head - line.from + 1,
      selLen,
      selLines,
      totalLines: tab?.paged ? tab.paged.totalLines : state.doc.lines,
    };
  }

  // ---- session --------------------------------------------------------------------------
  private scheduleBufferStore(tab: Tab): void {
    if (tab.bufferTimer) clearTimeout(tab.bufferTimer);
    const delay = tab.size > 4 * 1024 * 1024 ? 3000 : 1000;
    tab.bufferTimer = window.setTimeout(() => {
      tab.bufferTimer = undefined;
      if (!tab.dirty || tab.kind !== "memory") return;
      void backend.sessionStoreBuffer(tab.id, this.docText(tab)).catch((e) => console.warn("buffer store failed", e));
    }, delay);
  }

  private scheduleCursorSave(): void {
    if (this.cursorSaveTimer) return;
    this.cursorSaveTimer = window.setTimeout(() => {
      this.cursorSaveTimer = undefined;
      this.scheduleSessionSave();
    }, 2500);
  }

  scheduleSessionSave(): void {
    if (this.restoring) return;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = window.setTimeout(() => void this.saveSessionNow(), 400);
  }

  private tabMeta(tab: Tab): TabMeta {
    const state = tab === this.active ? this.view.state : tab.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return {
      id: tab.id,
      path: tab.path,
      kind: tab.kind,
      name: tab.name,
      encoding: tab.encoding,
      eol: tab.eol,
      languageName: tab.languageName,
      dirty: tab.dirty,
      livePreview: tab.livePreview,
      pinned: tab.pinned,
      untitled: tab.untitled,
      readOnly: tab.readOnly,
      cursorLine: line.number + (tab.paged?.firstLine ?? 0),
      cursorCol: head - line.from,
      scrollTop: tab === this.active ? this.view.scrollDOM.scrollTop : tab.scrollTop,
      mtime: tab.mtime,
    };
  }

  async saveSessionNow(): Promise<void> {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
    }
    const data: SessionData = {
      tabs: this.tabs.map((t) => this.tabMeta(t)),
      active: this.active?.id ?? null,
      next_untitled: this.nextUntitled,
    };
    await backend.sessionSave(data).catch((e) => console.warn("session save failed", e));
  }

  /** Flush unsaved buffers immediately (used before the window closes). */
  async flushAll(): Promise<void> {
    for (const t of this.tabs) {
      if (t.bufferTimer) {
        clearTimeout(t.bufferTimer);
        t.bufferTimer = undefined;
      }
      if (t.dirty && t.kind === "memory") await backend.sessionStoreBuffer(t.id, this.docText(t)).catch(() => undefined);
      if (t.kind === "paged" && t.paged) await t.paged.commit().catch(() => undefined);
    }
    await this.saveSessionNow();
  }

  async restoreSession(): Promise<boolean> {
    this.restoring = true;
    try {
      const s = await backend.sessionLoad();
      this.nextUntitled = Math.max(1, s.next_untitled || 1);
      let activeTab: Tab | null = null;
      for (const meta of s.tabs) {
        try {
          const tab = await this.restoreTab(meta);
          if (!tab) continue;
          if (meta.id === s.active) activeTab = tab;
        } catch (e) {
          console.warn("restore failed for", meta.path, e);
        }
      }
      if (this.tabs.length === 0) return false;
      this.activate(activeTab ?? this.tabs[0]);
      return true;
    } finally {
      this.restoring = false;
      this.scheduleSessionSave();
    }
  }

  private async restoreTab(meta: TabMeta): Promise<Tab | null> {
    const m = meta as TabMeta & {
      name?: string;
      encoding?: string;
      eol?: Eol;
      languageName?: string | null;
      dirty?: boolean;
      livePreview?: boolean;
      pinned?: boolean;
      untitled?: number | null;
      readOnly?: boolean;
      cursorLine?: number;
      cursorCol?: number;
      scrollTop?: number;
    };
    let tab: Tab | null = null;
    if (meta.kind === "paged" && meta.path) {
      if (!(await backend.pathExists(meta.path))) return null;
      tab = await this.openOne(meta.path, meta.id, { livePreview: m.livePreview, languageName: m.languageName, paged: true });
    } else {
      const buffer = await backend.sessionLoadBuffer(meta.id);
      if (buffer !== null) {
        tab = this.makeTab({
          id: meta.id,
          path: meta.path,
          name: m.name ?? (meta.path ? basename(meta.path) : "new"),
          kind: "memory",
          encoding: m.encoding,
          eol: m.eol,
          dirty: true,
          livePreview: m.livePreview,
          pinned: m.pinned,
          untitled: m.untitled ?? null,
          readOnly: m.readOnly,
          mtime: (m as { mtime?: number }).mtime ?? 0,
        });
        const desc = m.languageName ? languageByName(m.languageName) : tab.path ? languageForFile(tab.name) : null;
        tab.languageName = desc?.name ?? null;
        const langExt: Extension = desc ? await loadLanguage(desc) : [];
        tab.state = this.buildState(tab, buffer, langExt);
        this.insertTab(tab);
      } else if (meta.path) {
        if (!(await backend.pathExists(meta.path))) return null;
        tab = await this.openOne(meta.path, meta.id, { livePreview: m.livePreview, languageName: m.languageName });
      } else {
        // untitled with no stored buffer: empty tab
        tab = this.makeTab({ id: meta.id, name: m.name ?? "new", kind: "memory", untitled: m.untitled ?? null, livePreview: m.livePreview });
        tab.state = this.buildState(tab, "", []);
        this.insertTab(tab);
      }
    }
    if (!tab) return null;
    tab.pinned = m.pinned ?? false;
    if (m.encoding && tab.kind === "memory") tab.encoding = m.encoding;
    if (m.eol) tab.eol = m.eol;
    if (m.readOnly) tab.readOnly = true;
    tab.scrollTop = m.scrollTop ?? 0;
    if (m.cursorLine) tab.pendingCursor = { line: m.cursorLine, col: m.cursorCol ?? 0 };
    return tab;
  }
}
