// Application state: tabs, the editor panes (one, or two side by side), file I/O and session
// persistence.
//
// Each pane has its own EditorView. A tab is shown in at most one pane; its live state is that
// pane's view state, otherwise `tab.state`. `view` and `active` always refer to the focused pane.
// A clone is a second tab showing the same document in the other pane: edits are mirrored
// between the two, and saving, dirty state and recovery belong to the original tab.
import { Annotation, EditorSelection, EditorState, Extension, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { backend, E_EXTERNAL_CHANGE, E_HARD_LINKS, E_READ_ONLY_ENCODING, E_UNREPRESENTABLE, Eol, errorText, OpenResult, SaveResult, SessionData, TabMeta } from "./backend";
import { bookmarkLines, setBookmarks } from "./bookmarks";
import { compartments, createState, indentExt, languageByName, languageForFile, loadLanguage, systemChange } from "./editor";
import { HexBuffer } from "./hexbuffer";
import { detectIndent, IndentInfo } from "./indentdetect";
import { livePreview, LivePreviewConfig } from "./livepreview";
import { PagedController, PagedHost, pagedLineExtensions, windowText } from "./paged";
import { basename, dirname, imageSource, joinPath, safeDecode } from "./paths";
import { settings, updateSettings } from "./settings";
import { whitespaceExt } from "./whitespace";
import { confirm3, confirmDialog, toast } from "./ui/dialogs";
import { t } from "./i18n";

export type TabKind = "memory" | "paged";
export type ViewMode = "text" | "hex" | "split";

/** State of "follow" (tail -f) mode for a tab. */
export interface TailState {
  paused: boolean;
  /** Bytes of the file already shown (small files). */
  offset: number;
  headHash: number;
  headLen: number;
  /** The file is currently missing (deleted or being rotated). */
  missing: boolean;
  busy: boolean;
}

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
  hexView: boolean;
  /** With hexView: show the text and the bytes side by side (the bytes are read-only then). */
  splitView: boolean;
  /** Incremented on every change that affects what Save would write. */
  revision: number;
  /** Revision that is on disk. */
  savedRevision: number;
  /** Saves of this tab run one after another. */
  saveChain?: Promise<unknown>;
  /** Why the tab cannot be made editable (shown when the user tries). */
  lockedReadOnly?: string;
  /** Disk modification time the user already answered "keep mine" for. */
  externalAck?: number;
  /** Last time a background persistence error was shown for this tab. */
  lastErrorToast?: number;
  /** Pane the tab belongs to (0 = left/main, 1 = right/second view). */
  pane: 0 | 1;
  /** Set on a clone: the tab whose document this tab mirrors. */
  cloneOf?: Tab;
  /** Indentation of this document; null uses the settings. */
  indent: IndentInfo | null;
  /** Follow mode (tail -f). */
  tail?: TailState;
  /** Bytes shown in the hex view, with their unsaved edits. */
  hex?: HexBuffer;
  /** What `hex` was loaded from (file size and time, or the unsaved text). */
  hexKey?: string;
  /** The text is read-only because the file has bytes that are invalid in its encoding. */
  invalidBytes?: boolean;
}

/** What the hex view of a tab shows. */
export interface HexInfo {
  buffer: HexBuffer;
  name: string;
  /** Why the bytes cannot be edited, or null. */
  readOnly: string | null;
}

interface Pane {
  host: HTMLElement;
  view: EditorView;
  tab: Tab | null;
}

interface ClosedTab {
  path: string | null;
  name: string;
  text?: string;
  line: number;
}

/** Same file time, also accepting legacy session values stored in whole seconds. */
function sameMtime(disk: number, known: number): boolean {
  return disk === known || (known > 0 && known < 1e11 && Math.floor(disk / 1000) === known);
}

/** Marks an edit copied from a tab to its clone (or back), so it is not mirrored again. */
const mirrored = Annotation.define<boolean>();

type AppEvent = "tabs" | "status" | "active" | "layout" | "doc";
type Listener = () => void;

let bufferEpoch = 0;

/** Set once per page load from `backend.sessionBufferEpoch()`, before any recovery data is written. */
export function setBufferEpoch(epoch: number): void {
  bufferEpoch = epoch;
}

/**
 * Generation of the recovery buffer that holds revision `rev` of a tab. The backend ignores a
 * store whose generation is not above the last dropped one, so a store that finishes after the
 * save of the same revision cannot bring the old text back. Revisions start again when the page
 * reloads (a language change) while the backend keeps running, so every page load has its own,
 * higher epoch in the upper bits.
 */
export function bufferGeneration(rev: number): number {
  return bufferEpoch * 2 ** 32 + rev + 1;
}

/** Display name of an untitled tab in the current UI language. */
function untitledName(n: number): string {
  return t("new {n}", { n });
}

let idCounter = 0;
function newId(): string {
  return `t${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

const MAX_RECENT = 20;
const MAX_CLOSED = 20;

export class App {
  tabs: Tab[] = [];
  /** Tab of the focused pane. */
  active: Tab | null = null;
  /** View of the focused pane. */
  view: EditorView;
  panes: Pane[] = [];
  focused = 0;
  /** Whether the second pane is shown. */
  splitOn = false;
  nextUntitled = 1;
  closedTabs: ClosedTab[] = [];
  private listeners = new Map<AppEvent, Set<Listener>>();
  private sessionTimer: number | undefined;
  private restoring = false;
  /** Large files whose unsaved changes could not be restored during the current session restore. */
  private lostEdits: string[] = [];
  private cursorSaveTimer: number | undefined;
  private scrollSyncing = false;
  private syncOffset = 0;

  constructor(hosts: HTMLElement[]) {
    this.panes = hosts.map((host, i) => {
      const view = new EditorView({
        parent: host,
        state: EditorState.create({ doc: "" }),
        dispatchTransactions: (trs, v) => this.onDispatch(trs, v),
      });
      host.addEventListener("focusin", () => {
        if (this.focused !== i && this.panes[i].tab) this.focusPane(i, false);
      });
      view.scrollDOM.addEventListener("scroll", () => this.onPaneScroll(i), { passive: true });
      return { host, view, tab: null };
    });
    this.view = this.panes[0].view;
    window.addEventListener("focus", () => void this.checkExternalChange());
    window.setInterval(() => this.pollFollowed(), 1000);
  }

  // ---- events ----------------------------------------------------------------------------
  on(event: AppEvent, fn: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }
  emit(event: AppEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  // ---- panes ------------------------------------------------------------------------------
  /** The tab that owns the document (the original for a clone). */
  owner(tab: Tab): Tab {
    return tab.cloneOf ?? tab;
  }

  clonesOf(tab: Tab): Tab[] {
    return this.tabs.filter((x) => x.cloneOf === tab);
  }

  /** Pane index a tab is displayed in. */
  paneIndex(tab: Tab): 0 | 1 {
    return this.splitOn ? tab.pane : 0;
  }

  tabsIn(pane: number): Tab[] {
    return this.tabs.filter((x) => this.paneIndex(x) === pane);
  }

  private paneOf(tab: Tab): Pane | null {
    for (const p of this.panes) if (p.tab === tab) return p;
    return null;
  }

  /** The view showing `tab`, or null when the tab is in the background. */
  viewOf(tab: Tab): EditorView | null {
    return this.paneOf(tab)?.view ?? null;
  }

  /** Current editor state of a tab, whether or not it is visible. */
  stateOf(tab: Tab): EditorState {
    return this.viewOf(tab)?.state ?? tab.state;
  }

  private onDispatch(trs: readonly Transaction[], view: EditorView): void {
    view.update(trs);
    const pane = this.panes.find((p) => p.view === view);
    if (pane?.tab) this.mirror(pane.tab, trs);
  }

  /** Copy document changes of `tab` to its clone or original. */
  private mirror(tab: Tab, trs: readonly Transaction[]): void {
    const own = this.owner(tab);
    const partners = [own, ...this.clonesOf(own)].filter((x) => x !== tab);
    if (!partners.length) return;
    for (const tr of trs) {
      if (!tr.docChanged || tr.annotation(mirrored)) continue;
      for (const p of partners) {
        this.dispatchTo(p, { changes: tr.changes, annotations: [mirrored.of(true), systemChange.of(true), Transaction.addToHistory.of(false)] });
      }
    }
  }

  /** Make pane `i` the focused one. */
  focusPane(i: number, focusView = true): void {
    if (!this.panes[i]) return;
    this.focused = i;
    this.view = this.panes[i].view;
    this.active = this.panes[i].tab;
    this.panes.forEach((p, k) => p.host.parentElement?.classList.toggle("focused", k === i));
    if (focusView) this.view.focus();
    this.emit("active");
    this.emit("tabs");
    this.emit("status");
  }

  /** Remember the view state of a tab that leaves its pane. */
  private stash(tab: Tab): void {
    const v = this.viewOf(tab);
    if (!v) return;
    tab.state = v.state;
    tab.scrollTop = v.scrollDOM.scrollTop;
    tab.paged?.detach();
  }

  /** Put `tab` into its pane (without changing focus). */
  private show(tab: Tab): Pane {
    const pane = this.panes[this.paneIndex(tab)];
    if (pane.tab === tab) return pane;
    const old = this.paneOf(tab);
    if (old) {
      this.stash(tab);
      old.tab = null;
    }
    if (pane.tab) this.stash(pane.tab);
    pane.tab = tab;
    pane.view.setState(tab.state);
    tab.paged?.attach(pane.view);
    const st = tab.scrollTop;
    pane.view.requestMeasure({
      read: () => null,
      write: () => {
        pane.view.scrollDOM.scrollTop = st;
      },
    });
    return pane;
  }

  setSplit(on: boolean): void {
    if (this.splitOn === on) return;
    this.splitOn = on;
    this.panes[1].host.parentElement!.style.display = on ? "" : "none";
    this.emit("layout");
  }

  /** Move a tab to the other pane, opening the split view if needed. */
  moveToOtherView(tab: Tab): void {
    const from = this.paneIndex(tab);
    const to: 0 | 1 = from === 0 ? 1 : 0;
    const own = this.owner(tab);
    const twin = [own, ...this.clonesOf(own)].find((x) => x !== tab && this.splitOn && x.pane === to);
    if (twin) {
      // The document is already shown in the other pane.
      if (tab.cloneOf) {
        this.removeTab(tab);
        this.activate(twin);
        return;
      }
      this.removeTab(twin); // keep the original, drop its clone
    }
    this.setSplit(true);
    const src = this.paneOf(tab);
    if (src) {
      this.stash(tab);
      src.tab = null;
    }
    tab.pane = to;
    this.refillPane(from);
    this.activate(tab);
    this.emit("tabs");
    this.scheduleSessionSave();
  }

  /** Show the same document in the other pane (small files only). */
  async cloneToOtherView(tab: Tab): Promise<void> {
    const own = this.owner(tab);
    if (own.kind === "paged") {
      toast(t("Large files cannot be shown twice."));
      return;
    }
    const to: 0 | 1 = this.paneIndex(tab) === 0 ? 1 : 0;
    const existing = [own, ...this.clonesOf(own)].find((x) => x !== tab && this.splitOn && x.pane === to);
    if (existing) {
      this.activate(existing);
      return;
    }
    const clone = this.makeTab({
      name: own.name,
      kind: "memory",
      path: own.path,
      encoding: own.encoding,
      eol: own.eol,
      readOnly: own.readOnly,
      livePreview: own.livePreview,
      untitled: own.untitled,
    });
    clone.cloneOf = own;
    clone.pane = to;
    clone.indent = own.indent;
    clone.languageName = own.languageName;
    const desc = own.languageName ? languageByName(own.languageName) : null;
    const langExt: Extension = desc ? await loadLanguage(desc) : [];
    const st = this.stateOf(own);
    clone.state = this.buildState(clone, st.doc.toString(), langExt);
    clone.state = clone.state.update({ selection: EditorSelection.cursor(Math.min(st.selection.main.head, clone.state.doc.length)) }).state;
    this.tabs.splice(this.tabs.indexOf(own) + 1, 0, clone);
    this.setSplit(true);
    this.activate(clone);
    this.emit("tabs");
  }

  /** Close the second pane: its tabs move to the first, clones are closed. */
  closeSplit(): void {
    if (!this.splitOn) return;
    const p1 = this.panes[1];
    if (p1.tab) {
      this.stash(p1.tab);
      p1.tab = null;
    }
    for (const tab of [...this.tabs]) {
      if (tab.cloneOf) this.removeTab(tab, false);
      else tab.pane = 0;
    }
    this.setSplit(false);
    if (!this.panes[0].tab) {
      if (this.tabs.length) this.show(this.tabs[0]);
      else this.newTab("", false);
    }
    this.focusPane(0);
    this.emit("tabs");
    this.scheduleSessionSave();
  }

  /** After a pane lost its tab: show a neighbour, or close an empty second pane. */
  private refillPane(pane: number, nearIndex = 0): void {
    if (this.panes[pane].tab && this.tabs.includes(this.panes[pane].tab!)) return;
    this.panes[pane].tab = null;
    const same = this.tabsIn(pane);
    if (same.length) {
      const next = same.find((x) => this.tabs.indexOf(x) >= nearIndex) ?? same[same.length - 1];
      this.show(next);
      if (this.focused === pane) this.focusPane(pane, false);
      return;
    }
    if (pane === 1) {
      this.setSplit(false);
      if (this.focused === 1) this.focusPane(0);
      return;
    }
    if (this.splitOn && this.tabsIn(1).length) {
      // The main pane became empty: give it a new tab, like Notepad++.
      const tab = this.newTab("", false);
      tab.pane = 0;
      this.show(tab);
      if (this.focused === 0) this.focusPane(0, false);
      return;
    }
    this.newTab();
  }

  private onPaneScroll(i: number): void {
    if (!this.splitOn || !settings.syncScroll || this.scrollSyncing) return;
    const src = this.panes[i].view;
    const dst = this.panes[1 - i].view;
    if (!this.panes[1 - i].tab) return;
    this.scrollSyncing = true;
    try {
      const top = src.scrollDOM.scrollTop;
      const blk = src.lineBlockAtHeight(top);
      const line = src.state.doc.lineAt(blk.from).number + (i === 0 ? this.syncOffset : -this.syncOffset);
      const frac = blk.height ? (top - blk.top) / blk.height : 0;
      const n = Math.max(1, Math.min(dst.state.doc.lines, line));
      const dblk = dst.lineBlockAt(dst.state.doc.line(n).from);
      dst.scrollDOM.scrollTop = dblk.top + frac * dblk.height;
      dst.scrollDOM.scrollLeft = src.scrollDOM.scrollLeft;
    } finally {
      requestAnimationFrame(() => (this.scrollSyncing = false));
    }
  }

  /** Turn synchronized scrolling on or off, keeping the current line offset between panes. */
  setSyncScroll(on: boolean): void {
    if (on && this.splitOn) {
      const top = (v: EditorView) => v.state.doc.lineAt(v.lineBlockAtHeight(v.scrollDOM.scrollTop).from).number;
      this.syncOffset = top(this.panes[1].view) - top(this.panes[0].view);
    } else this.syncOffset = 0;
    updateSettings({ syncScroll: on }, { silent: true });
    this.emit("status");
  }

  // ---- editor state helpers -------------------------------------------------------------
  private listenerExt(tab: Tab): Extension {
    return EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const userEdit = u.transactions.some((tr) => tr.docChanged && !tr.annotation(systemChange));
        if (userEdit) {
          const own = this.owner(tab);
          this.noteUserEdit(own);
          if (own.kind === "paged") own.paged?.noteChange();
          else this.scheduleBufferStore(own);
        }
        this.emit("doc");
      }
      if ((u.docChanged || u.selectionSet) && tab === this.active) {
        this.emit("status");
        this.scheduleCursorSave();
      }
    });
  }

  private lpConfig(tab: Tab): LivePreviewConfig {
    return {
      resolveImage: (src) => {
        const s = imageSource(src, this.owner(tab).path, settings.remoteImages);
        if (!s) return null;
        return "url" in s ? s.url : convertFileSrc(s.path);
      },
      openLink: (href) => {
        const path = this.owner(tab).path;
        if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) void openUrl(href);
        else if (path) void this.openFiles([joinPath(dirname(path), safeDecode(href.split("#")[0]))]);
      },
    };
  }

  /** Record a change that Save must write. */
  noteUserEdit(tab: Tab): void {
    tab.revision++;
    if (!tab.dirty) {
      tab.dirty = true;
      this.emit("tabs");
    }
  }

  /** Read-only for editing: the tab setting or a window of a large file that cannot be edited. */
  effectiveReadOnly(tab: Tab): boolean {
    // In the hex view the text editor is hidden: nothing may change the text behind it.
    return tab.readOnly || !!tab.paged?.windowReadOnly || (tab.hexView && !tab.splitView);
  }

  private applyReadOnly(tab: Tab): void {
    for (const x of [tab, ...this.clonesOf(tab)]) {
      x.readOnly = tab.readOnly;
      this.dispatchTo(x, { effects: compartments.readOnly.reconfigure(EditorState.readOnly.of(this.effectiveReadOnly(x))) });
    }
    this.emit("status");
  }

  /** Show a background failure (recovery copy, large-file commit) at most every 30 seconds per tab. */
  reportBackgroundError(tab: Tab, e: unknown): void {
    console.warn("background error", tab.name, e);
    const now = Date.now();
    if (tab.lastErrorToast && now - tab.lastErrorToast < 30000) return;
    tab.lastErrorToast = now;
    toast(t('Could not store "{name}": {error}', { name: tab.name, error: errorText(e) }), 6000);
  }

  private pagedHost(tab: Tab): PagedHost {
    return {
      state: () => this.stateOf(tab),
      dispatch: (spec) => this.dispatchTo(tab, spec),
      view: () => this.viewOf(tab),
      onWindowChanged: () => this.emit("status"),
      onBackendEdit: () => this.noteUserEdit(tab),
      onWindowFlags: (f) => {
        this.applyReadOnly(tab);
        if (this.active === tab && f.truncated) toast(t("This line is too long to edit and is shown only in part, read-only."), 5000);
        else if (this.active === tab && f.lossy) toast(t("This part of the file is not valid UTF-8 and is shown read-only."), 5000);
      },
      onError: (e) => this.reportBackgroundError(tab, e),
    };
  }

  /** Indentation extension of a tab. */
  indentExtFor(tab: Tab): Extension {
    return indentExt(settings, this.owner(tab).indent);
  }

  whitespaceExtFor(tab: Tab): Extension {
    return whitespaceExt(settings.showWhitespace, settings.showEol, () => this.owner(tab).eol);
  }

  private buildState(tab: Tab, text: string, language: Extension, firstLineOffset = 0): EditorState {
    return createState({
      text,
      settings,
      readOnly: this.effectiveReadOnly(tab),
      livePreview: tab.livePreview && tab.languageName === "Markdown",
      lpConfig: this.lpConfig(tab),
      language,
      firstLineOffset,
      indent: tab.indent ?? undefined,
      eol: () => this.owner(tab).eol,
      extra: [this.listenerExt(tab), tab.kind === "paged" ? pagedLineExtensions : []],
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

  /** Dispatch to a tab whether or not it is visible. */
  dispatchTo(tab: Tab, spec: TransactionSpec): void {
    const v = this.viewOf(tab);
    if (v) v.dispatch(spec);
    else {
      const tr = tab.state.update(spec);
      tab.state = tr.state;
      this.mirror(tab, [tr]);
    }
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
      hexView: false,
      splitView: false,
      revision: partial.dirty ? 1 : 0,
      savedRevision: 0,
      pane: partial.pane ?? (this.splitOn ? (this.focused as 0 | 1) : 0),
      indent: partial.indent ?? null,
    };
    return tab;
  }

  private insertTab(tab: Tab, index?: number): void {
    if (index === undefined || index < 0 || index > this.tabs.length) this.tabs.push(tab);
    else this.tabs.splice(index, 0, tab);
  }

  newTab(text = "", activate = true): Tab {
    // Use the lowest number not taken by an open "new N" tab, like Notepad++.
    const used = new Set(this.tabs.filter((x) => !x.cloneOf).map((x) => x.untitled).filter((u): u is number => u !== null));
    let n = 1;
    while (used.has(n)) n++;
    const tab = this.makeTab({ name: untitledName(n), kind: "memory", untitled: n });
    tab.state = this.buildState(tab, text, []);
    this.insertTab(tab);
    if (text) {
      tab.dirty = true;
      tab.revision = 1;
      this.scheduleBufferStore(tab);
    }
    if (activate) this.activate(tab);
    this.emit("tabs");
    this.scheduleSessionSave();
    return tab;
  }

  findByPath(path: string): Tab | undefined {
    const norm = path.toLowerCase();
    return this.tabs.find((x) => !x.cloneOf && x.path && x.path.toLowerCase() === norm);
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

  /** Remember a file in the Recent Files list. */
  addRecent(path: string): void {
    const norm = path.toLowerCase();
    const list = [path, ...settings.recentFiles.filter((p) => p.toLowerCase() !== norm)].slice(0, MAX_RECENT);
    updateSettings({ recentFiles: list }, { silent: true });
  }

  clearRecent(): void {
    updateSettings({ recentFiles: [] }, { silent: true });
  }

  private async openOne(path: string, id?: string, restoreOpts?: { livePreview?: boolean; languageName?: string | null; paged?: boolean; hexView?: boolean; pane?: 0 | 1 }): Promise<Tab> {
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
      pane: restoreOpts?.pane,
    });
    tab.hexView = restoreOpts?.hexView ?? res.binary;
    if (res.readOnlyReason === "encoding") {
      tab.lockedReadOnly = t("Large files in {encoding} can be viewed but not edited yet.", { encoding: res.encoding });
      if (!this.restoring) toast(t('"{name}" was opened read-only.', { name: res.name }) + " " + tab.lockedReadOnly, 6000);
    } else if (res.kind === "memory" && res.hadErrors) {
      tab.readOnly = true;
      tab.invalidBytes = true;
      if (!this.restoring)
        toast(t('"{name}" contains bytes that are not valid {encoding}. It was opened read-only so saving cannot change them. Use the tab menu to allow editing.', { name: res.name, encoding: res.encoding }), 8000);
    }
    const desc = restoreOpts?.languageName ? languageByName(restoreOpts.languageName) : languageForFile(res.name);
    tab.languageName = desc?.name ?? null;
    const langExt: Extension = desc ? await loadLanguage(desc) : [];
    if (res.kind === "paged") {
      tab.paged = new PagedController(tabId, res.lineCount ?? 1, this.pagedHost(tab));
      const w = await backend.pagedWindow(tabId, 0, Math.max(500, settings.pagedWindowLines));
      tab.paged.firstLine = w.firstLine;
      tab.paged.count = w.count;
      tab.paged.totalLines = w.totalLines;
      tab.paged.windowReadOnly = w.truncated || w.lossy;
      if (w.dirty) {
        tab.dirty = true;
        tab.revision = 1;
      }
      tab.state = this.buildState(tab, windowText(w.text), langExt, 0);
    } else {
      const text = res.text ?? "";
      if (settings.detectIndent) {
        const info = detectIndent(text);
        if (info) tab.indent = { spaces: info.spaces, size: info.size || settings.tabSize };
      }
      tab.state = this.buildState(tab, text, langExt);
    }
    // Replace an empty, untouched untitled tab if it is the only one.
    const placeholder = this.tabs.length === 1 && this.tabs[0].untitled !== null && !this.tabs[0].dirty && this.stateOf(this.tabs[0]).doc.length === 0 ? this.tabs[0] : null;
    this.insertTab(tab);
    if (placeholder) await this.closeTab(placeholder, true);
    if (!this.restoring) this.addRecent(res.path);
    return tab;
  }

  activate(tab: Tab): void {
    if (!this.tabs.includes(tab)) return;
    const idx = this.paneIndex(tab);
    const same = this.panes[idx].tab === tab && this.focused === idx && this.active === tab;
    if (same) return;
    this.show(tab);
    this.focusPane(idx, true);
    if (tab.pendingCursor) {
      const pc = tab.pendingCursor;
      tab.pendingCursor = undefined;
      void this.gotoLine(pc.line, pc.col);
    }
    this.scheduleSessionSave();
    void this.checkExternalChange();
  }

  activateIndex(i: number): void {
    const list = this.tabsIn(this.focused);
    if (i >= 0 && i < list.length) this.activate(list[i]);
  }

  nextTab(delta: number): void {
    const list = this.tabsIn(this.focused);
    if (!this.active || list.length < 2) return;
    const i = list.indexOf(this.active);
    this.activate(list[(i + delta + list.length) % list.length]);
  }

  moveTab(tab: Tab, toIndex: number): void {
    const from = this.tabs.indexOf(tab);
    if (from < 0) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.emit("tabs");
    this.scheduleSessionSave();
  }

  /** Take a tab out of the tab list and its pane, without prompting. */
  private removeTab(tab: Tab, refill = true): void {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    const paneIdx = this.paneIndex(tab);
    const pane = this.paneOf(tab);
    if (pane) {
      tab.paged?.detach();
      pane.tab = null;
    }
    this.tabs.splice(i, 1);
    if (this.active === tab) this.active = null;
    if (pane && refill) this.refillPane(paneIdx, i);
    this.emit("tabs");
  }

  /** Close a tab. Returns false if the user cancelled. */
  async closeTab(tab: Tab, force = false): Promise<boolean> {
    if (tab.cloneOf) {
      this.removeTab(tab);
      this.scheduleSessionSave();
      return true;
    }
    if (!force && tab.dirty) {
      this.activate(tab);
      const r = await confirm3(t("Save changes?"), t('Save changes to "{name}" before closing?', { name: tab.name }));
      if (r === "cancel") return false;
      if (r === "yes") {
        const ok = await this.save(tab);
        if (!ok) return false;
      }
    }
    if (!this.tabs.includes(tab)) return true;
    this.rememberClosed(tab);
    for (const c of this.clonesOf(tab)) this.removeTab(c);
    if (tab.bufferTimer) clearTimeout(tab.bufferTimer);
    tab.tail = undefined;
    tab.paged?.dispose();
    if (tab.kind === "paged") void backend.pagedClose(tab.id);
    void backend.sessionDropBuffer(tab.id, bufferGeneration(tab.revision));
    this.removeTab(tab);
    if (this.tabs.length === 0) this.newTab();
    this.scheduleSessionSave();
    return true;
  }

  private rememberClosed(tab: Tab): void {
    const state = this.stateOf(tab);
    const line = state.doc.lineAt(state.selection.main.head).number + (tab.paged?.firstLine ?? 0);
    let entry: ClosedTab | null = null;
    if (tab.path) entry = { path: tab.path, name: tab.name, line };
    else if (state.doc.length > 0 && state.doc.length < 8 * 1024 * 1024) entry = { path: null, name: tab.name, text: state.doc.toString(), line };
    if (!entry) return;
    this.closedTabs.push(entry);
    if (this.closedTabs.length > MAX_CLOSED) this.closedTabs.shift();
  }

  /** Reopen the most recently closed tab (Ctrl+Shift+T). */
  async reopenClosed(): Promise<void> {
    for (;;) {
      const c = this.closedTabs.pop();
      if (!c) {
        toast(t("No closed tabs to reopen."));
        return;
      }
      if (c.path) {
        if (!(await backend.pathExists(c.path))) continue;
        const tab = await this.openFiles([c.path]);
        if (tab) await this.gotoLine(c.line);
      } else {
        this.newTab(c.text ?? "");
        await this.gotoLine(c.line);
      }
      return;
    }
  }

  async closeOthers(keep: Tab): Promise<void> {
    for (const x of [...this.tabs]) if (x !== keep && !x.pinned && x.cloneOf !== this.owner(keep) && x !== keep.cloneOf) if (!(await this.closeTab(x))) return;
  }
  async closeAll(): Promise<void> {
    for (const x of [...this.tabs]) if (!x.pinned && this.tabs.includes(x)) if (!(await this.closeTab(x))) return;
  }
  async closeToRight(tab: Tab): Promise<void> {
    const list = this.tabsIn(this.paneIndex(tab));
    const i = list.indexOf(tab);
    for (const x of list.slice(i + 1)) if (!x.pinned && this.tabs.includes(x)) if (!(await this.closeTab(x))) return;
  }

  // ---- saving -------------------------------------------------------------------------
  docText(tab: Tab): string {
    return this.stateOf(tab).doc.toString();
  }

  /** Run the save operations of one tab one after another. */
  private serial<T>(tab: Tab, fn: () => Promise<T>): Promise<T> {
    const run = (tab.saveChain ?? Promise.resolve()).then(fn, fn);
    tab.saveChain = run.catch(() => undefined);
    return run;
  }

  save(tab: Tab): Promise<boolean> {
    tab = this.owner(tab);
    if (tab.hex?.dirty && tab.path) return this.serial(tab, () => this.writeHex(tab));
    if (!tab.path) return this.saveAs(tab);
    const path = tab.path;
    return this.serial(tab, () => this.writeTab(tab, path, false));
  }

  /**
   * Write `tab` to `target`. Only the revision captured before writing is marked as saved:
   * edits made while the write is in progress keep the tab dirty and protected by recovery.
   */
  private async writeTab(tab: Tab, target: string, isSaveAs: boolean, opts: { lossy?: boolean; overwrite?: boolean } = {}): Promise<boolean> {
    try {
      let rev: number;
      let r: SaveResult;
      if (tab.kind === "paged" && tab.paged) {
        rev = tab.revision;
        await tab.paged.commit();
        r = await backend.pagedSave(tab.id, isSaveAs ? target : undefined, opts.overwrite ?? false);
      } else {
        this.applySaveTransforms(tab);
        rev = tab.revision;
        // Save As writes a new file (overwriting one was already confirmed). A normal save
        // refuses when another program changed the file since it was read, unless the user
        // chose "Keep mine" for exactly that change.
        const expected = isSaveAs ? null : (tab.externalAck ?? (tab.mtime || null));
        r = await backend.saveText(target, this.docText(tab), tab.encoding, tab.eol, opts.lossy ?? false, expected);
      }
      tab.path = r.path;
      tab.name = r.name;
      tab.mtime = r.mtime;
      tab.size = r.size;
      tab.externalAck = undefined;
      if (isSaveAs) tab.untitled = null;
      for (const c of this.clonesOf(tab)) {
        c.path = tab.path;
        c.name = tab.name;
        c.untitled = tab.untitled;
      }
      if (tab.kind === "paged" && tab.paged) await tab.paged.load(tab.paged.firstLine, tab.paged.cursorLine());
      this.markSaved(tab, rev);
      if (isSaveAs) {
        await this.applyLanguage(tab, languageForFile(tab.name));
        this.addRecent(tab.path);
      }
      if (tab.tail) await this.restartFollow(tab);
      this.emit("tabs");
      this.emit("status");
      this.scheduleSessionSave();
      return true;
    } catch (e) {
      return this.handleSaveError(tab, target, isSaveAs, e, opts);
    }
  }

  private markSaved(tab: Tab, rev: number): void {
    tab.savedRevision = rev;
    const clean = tab.revision === rev;
    tab.dirty = !clean;
    if (clean) {
      if (tab.bufferTimer) clearTimeout(tab.bufferTimer);
      tab.bufferTimer = undefined;
      void backend.sessionDropBuffer(tab.id, bufferGeneration(rev));
    } else if (tab.kind === "memory") {
      this.scheduleBufferStore(tab);
    }
  }

  private async handleSaveError(tab: Tab, target: string, isSaveAs: boolean, e: unknown, opts: { lossy?: boolean; overwrite?: boolean }): Promise<boolean> {
    const msg = errorText(e);
    if (msg.startsWith(E_UNREPRESENTABLE)) {
      let info = { encoding: tab.encoding, chars: "", count: 0 };
      try {
        info = JSON.parse(msg.slice(E_UNREPRESENTABLE.length));
      } catch {
        /* keep defaults */
      }
      const r = await confirm3(
        t("Characters cannot be saved in {encoding}", { encoding: info.encoding }),
        t('{count} characters in this document do not exist in {encoding}, for example: {chars}\n\nSave the file as UTF-8 instead, or replace those characters with "?"?', info),
        [t("Save as UTF-8"), t("Replace with ?")]
      );
      if (r === "yes") {
        tab.encoding = "UTF-8";
        this.emit("status");
        return this.writeTab(tab, target, isSaveAs, opts);
      }
      if (r === "no") return this.writeTab(tab, target, isSaveAs, { ...opts, lossy: true });
      return false;
    }
    if (msg.startsWith(E_EXTERNAL_CHANGE)) {
      const r = await confirm3(
        t("File changed on disk"),
        t('"{name}" was changed by another program after it was opened. Saving now would overwrite those changes.', { name: tab.name }),
        [t("Save As…"), t("Reload")]
      );
      if (r === "yes") {
        const other = await saveDialog({ defaultPath: tab.path ?? tab.name, title: t("Save As") });
        if (!other) return false;
        return this.writeTab(tab, other, true, opts);
      }
      if (r === "no") await this.reload(tab);
      return false;
    }
    if (msg.startsWith(E_HARD_LINKS)) {
      await message(t('"{name}" has several names (hard links). A file this large cannot be saved without separating them, so it was not saved. Use Save As to save a copy.', { name: tab.name }), {
        title: t("Save failed"),
        kind: "error",
      });
      return false;
    }
    if (msg.startsWith(E_READ_ONLY_ENCODING)) {
      await message(tab.lockedReadOnly ?? t("This document is read-only."), { title: t("Save failed"), kind: "error" });
      return false;
    }
    await message(msg, { title: t("Save failed"), kind: "error" });
    return false;
  }

  private applySaveTransforms(tab: Tab): void {
    if (!settings.trimTrailingOnSave && !settings.ensureFinalNewline) return;
    const state = this.stateOf(tab);
    const changes: { from: number; to: number; insert?: string }[] = [];
    if (settings.trimTrailingOnSave) {
      for (let i = 1; i <= state.doc.lines; i++) {
        const line = state.doc.line(i);
        const m = /[ \t]+$/.exec(line.text);
        if (m) changes.push({ from: line.from + m.index, to: line.to });
      }
    }
    if (settings.ensureFinalNewline && state.doc.length > 0 && !state.doc.sliceString(state.doc.length - 1).endsWith("\n")) {
      changes.push({ from: state.doc.length, to: state.doc.length, insert: "\n" });
    }
    if (changes.length) this.dispatchTo(tab, { changes });
  }

  async saveAs(tab: Tab): Promise<boolean> {
    tab = this.owner(tab);
    const target = await saveDialog({
      defaultPath: tab.path ?? `${tab.name}${tab.untitled !== null ? ".txt" : ""}`,
      title: t("Save As"),
    });
    if (!target) return false;
    return this.serial(tab, () => this.writeTab(tab, target, true));
  }

  async saveAll(): Promise<void> {
    for (const x of [...this.tabs]) if (x.dirty && !x.cloneOf) if (!(await this.save(x))) return;
  }

  async openDialog(): Promise<void> {
    const sel = await openDialog({ multiple: true, title: t("Open") });
    if (!sel) return;
    await this.openFiles(Array.isArray(sel) ? sel : [sel]);
  }

  /**
   * Re-read the file from disk. With `encoding` the bytes are decoded with that encoding
   * ("Reopen with Encoding") instead of the detected one.
   */
  async reload(tab: Tab, encoding: string | null = null): Promise<void> {
    tab = this.owner(tab);
    if (!tab.path) return;
    tab.hex = undefined;
    tab.hexKey = undefined;
    if (tab.kind === "paged" && tab.paged) {
      // Opening under the same id replaces the document only when the file could be opened, so
      // a failed reload keeps the current one.
      const res = await backend.openPath(tab.id, tab.path, true, encoding);
      tab.paged.resetRevisions();
      tab.paged.totalLines = res.lineCount ?? 1;
      tab.mtime = res.mtime;
      tab.size = res.size;
      tab.encoding = res.encoding;
      tab.eol = res.eol;
      tab.paged.scopeActive = false;
      tab.lockedReadOnly = res.readOnlyReason === "encoding" ? t("Large files in {encoding} can be viewed but not edited yet.", { encoding: res.encoding }) : undefined;
      if (tab.lockedReadOnly) tab.readOnly = true;
      await tab.paged.load(tab.paged.firstLine, tab.paged.cursorLine());
      this.applyReadOnly(tab);
    } else {
      const res = await backend.openPath(tab.id, tab.path, false, encoding);
      if (res.kind === "paged") {
        await this.becomePaged(tab, res);
        this.finishReload(tab);
        if (tab.tail) await this.restartFollow(tab);
        return;
      }
      const state = this.stateOf(tab);
      const head = state.selection.main.head;
      this.dispatchTo(tab, {
        changes: { from: 0, to: state.doc.length, insert: res.text ?? "" },
        selection: { anchor: Math.min(head, (res.text ?? "").length) },
        annotations: [systemChange.of(true), Transaction.addToHistory.of(true)],
      });
      tab.encoding = res.encoding;
      tab.eol = res.eol;
      tab.mtime = res.mtime;
      tab.size = res.size;
      if (res.hadErrors && !tab.readOnly) {
        tab.readOnly = true;
        tab.invalidBytes = true;
        this.applyReadOnly(tab);
        toast(t('"{name}" contains bytes that are not valid {encoding}. It was opened read-only so saving cannot change them. Use the tab menu to allow editing.', { name: tab.name, encoding: res.encoding }), 8000);
      }
    }
    this.finishReload(tab);
    if (tab.tail) await this.restartFollow(tab);
  }

  private finishReload(tab: Tab): void {
    tab.savedRevision = tab.revision;
    tab.dirty = false;
    tab.externalAck = undefined;
    void backend.sessionDropBuffer(tab.id, bufferGeneration(tab.revision));
    this.emit("tabs");
    this.emit("status");
  }

  /**
   * Turn a memory tab into a paged one after its file grew beyond the size limit; `res` is the
   * paged document the backend opened. The text is never loaded into a JS string.
   */
  private async becomePaged(tab: Tab, res: OpenResult): Promise<void> {
    for (const c of this.clonesOf(tab)) this.removeTab(c);
    if (tab.bufferTimer) clearTimeout(tab.bufferTimer);
    tab.bufferTimer = undefined;
    tab.kind = "paged";
    tab.encoding = res.encoding;
    tab.eol = res.eol;
    tab.mtime = res.mtime;
    tab.size = res.size;
    tab.lockedReadOnly = res.readOnlyReason === "encoding" ? t("Large files in {encoding} can be viewed but not edited yet.", { encoding: res.encoding }) : undefined;
    if (tab.lockedReadOnly) tab.readOnly = true;
    tab.paged = new PagedController(tab.id, res.lineCount ?? 1, this.pagedHost(tab));
    const w = await backend.pagedWindow(tab.id, 0, Math.max(500, settings.pagedWindowLines));
    tab.paged.firstLine = w.firstLine;
    tab.paged.count = w.count;
    tab.paged.totalLines = w.totalLines;
    tab.paged.windowReadOnly = w.truncated || w.lossy;
    const desc = tab.languageName ? languageByName(tab.languageName) : null;
    const langExt: Extension = desc ? await loadLanguage(desc) : [];
    tab.state = this.buildState(tab, windowText(w.text), langExt, 0);
    const view = this.viewOf(tab);
    if (view) {
      view.setState(tab.state);
      tab.paged.attach(view);
    }
    this.applyReadOnly(tab);
    toast(t('"{name}" is now larger than {size} MB and is shown in pages.', { name: tab.name, size: 48 }), 6000);
  }

  /** "Reopen with Encoding": decode the file again with `encoding`, discarding edits after asking. */
  async reopenWithEncoding(tab: Tab, encoding: string): Promise<void> {
    tab = this.owner(tab);
    if (!tab.path) {
      toast(t("This document has no file to reopen."));
      return;
    }
    if (tab.dirty) {
      const ok = await confirmDialog(t("Reopen with Encoding"), t('Discard the unsaved changes to "{name}" and reopen it as {encoding}?', { name: tab.name, encoding }), t("Reopen"));
      if (!ok) return;
    }
    try {
      await this.reload(tab, encoding);
    } catch (e) {
      toast(errorText(e), 6000);
    }
    this.scheduleSessionSave();
  }

  private checking = false;
  async checkExternalChange(): Promise<void> {
    const tab = this.active ? this.owner(this.active) : null;
    if (!tab || !tab.path || this.checking || (tab.tail && !tab.tail.paused)) return;
    this.checking = true;
    try {
      let changed: boolean;
      let mtime: number;
      if (tab.kind === "paged") {
        const st = await backend.pagedDiskState(tab.id);
        changed = st.changed;
        mtime = st.mtime;
      } else {
        if (!(await backend.pathExists(tab.path))) return;
        mtime = await backend.fileMtime(tab.path);
        changed = !sameMtime(mtime, tab.mtime);
      }
      if (!changed || tab.externalAck === mtime) return;
      if (!tab.dirty && settings.autoReloadExternal) {
        await this.reload(tab);
        return;
      }
      const question = tab.dirty
        ? t('"{name}" was modified outside Nax-Notepad.\nReload it and lose your unsaved changes?', { name: tab.name })
        : t('"{name}" was modified outside Nax-Notepad.\nReload it?', { name: tab.name });
      const r = await confirm3(t("File changed on disk"), question, [t("Reload"), t("Keep mine")]);
      if (r === "yes") await this.reload(tab);
      // "Keep mine" lets the next save replace exactly this version and stops asking about it.
      // Cancel decides nothing: the question comes back, and saving still refuses.
      else if (r === "no") tab.externalAck = mtime;
    } catch {
      /* ignore */
    } finally {
      this.checking = false;
    }
  }

  // ---- follow mode (tail -f) ------------------------------------------------------------
  /** Start or stop following a file that another program appends to. */
  async toggleFollow(tab: Tab): Promise<void> {
    tab = this.owner(tab);
    if (tab.tail) {
      tab.tail = undefined;
      this.emit("status");
      return;
    }
    if (!tab.path) {
      toast(t("Save the document to a file first."));
      return;
    }
    if (tab.dirty) {
      toast(t("Following needs a document without unsaved changes. Save or reload it first."), 5000);
      return;
    }
    const tail: TailState = { paused: false, offset: tab.size, headHash: 0, headLen: 0, missing: false, busy: true };
    tab.tail = tail;
    try {
      await this.restartFollow(tab);
    } finally {
      tail.busy = false;
    }
    this.scrollToEnd(tab);
    this.emit("status");
  }

  pauseFollow(tab: Tab, paused: boolean): void {
    tab = this.owner(tab);
    if (!tab.tail) return;
    if (!paused && tab.dirty) {
      toast(t("Following needs a document without unsaved changes. Save or reload it first."), 5000);
      return;
    }
    tab.tail.paused = paused;
    this.emit("status");
  }

  /**
   * Take the loaded file as the new starting point (after loading or saving it): new data is
   * read from the size that was loaded, and the current beginning of the file is remembered to
   * detect replacement (log rotation).
   */
  private async restartFollow(tab: Tab): Promise<void> {
    const tail = tab.tail;
    if (!tail || !tab.path) return;
    tail.offset = tab.size;
    tail.missing = false;
    if (tab.kind !== "memory") return;
    try {
      const st = await backend.tailStart(tab.path);
      tail.headHash = st.headHash;
      tail.headLen = st.headLen;
    } catch {
      tail.missing = true;
    }
  }

  private scrollToEnd(tab: Tab): void {
    const st = this.stateOf(tab);
    if (tab.kind === "paged" && tab.paged) {
      void tab.paged.gotoLine(tab.paged.totalLines - 1);
      return;
    }
    this.dispatchTo(tab, { selection: { anchor: st.doc.length }, scrollIntoView: true, annotations: systemChange.of(true) });
  }

  private pollFollowed(): void {
    for (const tab of this.tabs) if (tab.tail && !tab.tail.paused && !tab.tail.busy) void this.pollTail(tab);
  }

  private async pollTail(tab: Tab): Promise<void> {
    const tail = tab.tail;
    if (!tail || !tab.path) return;
    if (tab.dirty) {
      tail.paused = true;
      toast(t('Following "{name}" is paused because it has unsaved changes.', { name: tab.name }), 5000);
      this.emit("status");
      return;
    }
    tail.busy = true;
    try {
      if (tab.kind === "memory") {
        const r = await backend.tailCheck(tab.path, tail.offset, tail.headHash, tail.headLen, tab.encoding);
        if (tab.tail !== tail || tab.dirty) return;
        const wasMissing = tail.missing;
        tail.missing = r.status === "missing";
        if (r.status === "appended") {
          if (r.text) this.appendFollowed(tab, r.text);
          tail.offset = r.offset;
          tab.size = r.offset;
          tab.mtime = r.mtime;
        } else if (r.status === "rotated") {
          await this.reload(tab);
          toast(t('"{name}" was replaced on disk and has been reloaded.', { name: tab.name }));
          this.scrollToEnd(tab);
        }
        if (wasMissing !== tail.missing) this.emit("status");
      } else if (tab.paged) {
        const r = await backend.pagedTailCheck(tab.id);
        if (tab.tail !== tail) return;
        tail.missing = r.status === "missing";
        if (r.status === "dirty") {
          tail.paused = true;
          this.emit("status");
        } else if (r.status === "appended") {
          const p = tab.paged;
          const atEnd = p.cursorLine() >= p.totalLines - 1;
          const windowAtEnd = p.firstLine + p.count >= p.totalLines - 1;
          p.totalLines = r.totalLines;
          tab.size = r.size ?? tab.size;
          tab.mtime = r.mtime ?? tab.mtime;
          if (atEnd) await p.gotoLine(r.totalLines - 1);
          else if (windowAtEnd) await p.load(p.firstLine, p.cursorLine());
          this.emit("status");
          this.emit("doc");
        } else if (r.status === "rotated") {
          await this.reload(tab);
          this.scrollToEnd(tab);
        }
      }
    } catch (e) {
      this.reportBackgroundError(tab, e);
    } finally {
      tail.busy = false;
    }
  }

  private appendFollowed(tab: Tab, text: string): void {
    const st = this.stateOf(tab);
    const end = st.doc.length;
    const atEnd = st.selection.main.empty && st.selection.main.head === end;
    this.dispatchTo(tab, { changes: { from: end, insert: text }, annotations: [systemChange.of(true), Transaction.addToHistory.of(false)] });
    if (atEnd) this.dispatchTo(tab, { selection: { anchor: this.stateOf(tab).doc.length }, scrollIntoView: true, annotations: systemChange.of(true) });
  }

  // ---- per-tab properties ---------------------------------------------------------------
  async setLanguage(tab: Tab, name: string | null): Promise<void> {
    const desc = name ? languageByName(name) : null;
    await this.applyLanguage(tab, desc);
  }

  /** "Convert to Encoding": the text is written in `enc` on the next save. */
  setEncoding(tab: Tab, enc: string): void {
    tab = this.owner(tab);
    if (tab.kind !== "memory") {
      toast(t("Converting large files to another encoding is not supported yet."));
      return;
    }
    tab.encoding = enc;
    this.noteUserEdit(tab);
    this.scheduleBufferStore(tab);
    this.emit("tabs");
    this.emit("status");
    this.scheduleSessionSave();
  }

  async setEol(tab: Tab, eol: Eol): Promise<void> {
    tab = this.owner(tab);
    if (tab.lockedReadOnly) {
      toast(tab.lockedReadOnly);
      return;
    }
    if (tab.kind === "paged") {
      try {
        await backend.pagedSetEol(tab.id, eol);
      } catch (e) {
        toast(errorText(e));
        return;
      }
    }
    tab.eol = eol;
    this.noteUserEdit(tab);
    if (tab.kind === "memory") this.scheduleBufferStore(tab);
    for (const x of [tab, ...this.clonesOf(tab)]) this.dispatchTo(x, { effects: compartments.whitespace.reconfigure(this.whitespaceExtFor(x)) });
    this.emit("tabs");
    this.emit("status");
    this.scheduleSessionSave();
  }

  /** Set the indentation of one document (null = use the settings). */
  setIndent(tab: Tab, info: IndentInfo | null): void {
    tab = this.owner(tab);
    tab.indent = info;
    for (const x of [tab, ...this.clonesOf(tab)]) {
      x.indent = info;
      this.dispatchTo(x, { effects: compartments.indent.reconfigure(this.indentExtFor(x)) });
    }
    this.emit("status");
    this.scheduleSessionSave();
  }

  /** Effective indentation of a tab. */
  indentOf(tab: Tab): IndentInfo {
    const i = this.owner(tab).indent;
    return { spaces: i ? i.spaces : settings.insertSpaces, size: i && i.size > 0 ? i.size : settings.tabSize };
  }

  toggleLivePreview(tab: Tab): void {
    tab.livePreview = !tab.livePreview;
    this.dispatchTo(tab, {
      effects: compartments.livePreview.reconfigure(tab.livePreview && tab.languageName === "Markdown" ? livePreview(this.lpConfig(tab)) : []),
    });
    this.emit("status");
    this.scheduleSessionSave();
  }

  /** Switch between the text and the hex view. Unsaved byte edits are saved or discarded first. */
  async toggleHexView(tab: Tab): Promise<void> {
    await this.setViewMode(tab, tab.hexView ? "text" : "hex");
  }

  viewMode(tab: Tab): ViewMode {
    return !tab.hexView ? "text" : tab.splitView ? "split" : "hex";
  }

  /** Show the text, the bytes (editable), or both side by side. */
  async setViewMode(tab: Tab, mode: ViewMode): Promise<void> {
    const own = this.owner(tab);
    const cur = this.viewMode(tab);
    if (cur === mode) return;
    // Byte edits are only possible in the hex mode: save or discard them when leaving it.
    if (cur === "hex" && own.hex?.dirty && !this.tabs.some((x) => x !== tab && x.hexView && !x.splitView && this.owner(x) === own)) {
      const r = await confirm3(t("Unsaved byte changes"), t('Save the changes made in the hex view of "{name}"?', { name: own.name }), [t("Save"), t("Discard")]);
      if (r === "cancel") return;
      if (r === "yes" && !(await this.save(own))) return;
      if (r === "no") this.discardHex(own);
    }
    tab.hexView = mode !== "text";
    tab.splitView = mode === "split";
    this.dispatchTo(tab, { effects: compartments.readOnly.reconfigure(EditorState.readOnly.of(this.effectiveReadOnly(tab))) });
    this.emit("active");
    this.emit("status");
    this.scheduleSessionSave();
  }

  /** Bytes for the hex view of `tab`, loaded on first use and after the file changed. */
  async hexFor(tab: Tab): Promise<HexInfo> {
    const own = this.owner(tab);
    const textDirty = own.revision !== own.savedRevision || !own.path;
    const key = textDirty ? `text:${own.revision}` : `file:${own.path}:${own.size}:${own.mtime}`;
    if (!own.hex || (!own.hex.dirty && own.hexKey !== key)) {
      if (textDirty) {
        const bytes = new TextEncoder().encode(this.docText(own));
        own.hex = await HexBuffer.load({ size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) });
      } else {
        const path = own.path!;
        const size = await backend.fileSize(path);
        own.hex = await HexBuffer.load({ size, read: (o, l) => backend.readBytes(path, o, l), find: (pattern, from, backwards) => backend.findBytes(path, pattern, from, backwards) });
      }
      own.hexKey = key;
    }
    let readOnly: string | null = null;
    if (tab.splitView) readOnly = t("In the split view the bytes are shown for inspection. Choose Hex to edit them.");
    else if (own.hexKey?.startsWith("text:")) readOnly = t("The hex view shows the unsaved text as UTF-8. Save the document to edit the bytes of the file.");
    else if (own.readOnly && !own.lockedReadOnly && !own.invalidBytes) readOnly = t("This document is read-only.");
    const name = own.name + (readOnly && own.hexKey?.startsWith("text:") ? ` (${t("unsaved")}, UTF-8)` : "");
    return { buffer: own.hex, name, readOnly };
  }

  /** The hex view changed bytes: the tab is dirty while they are unsaved. */
  noteHexChange(tab: Tab): void {
    const own = this.owner(tab);
    const dirty = !!own.hex?.dirty || own.revision !== own.savedRevision;
    if (dirty !== own.dirty) {
      own.dirty = dirty;
      this.emit("tabs");
    }
    this.emit("status");
  }

  private discardHex(tab: Tab): void {
    tab.hex = undefined;
    tab.hexKey = undefined;
    tab.dirty = tab.revision !== tab.savedRevision;
    this.emit("tabs");
  }

  /** Write the bytes edited in the hex view, then load the file again. */
  private async writeHex(tab: Tab): Promise<boolean> {
    const buf = tab.hex!;
    const path = tab.path!;
    if (tab.revision !== tab.savedRevision) {
      await message(t("The text of this document was also changed. Save or reload the text before saving byte changes."), { title: t("Save failed"), kind: "error" });
      return false;
    }
    const paged = tab.kind === "paged";
    try {
      // A large file is memory-mapped; Windows cannot replace it while the mapping is open.
      if (paged) {
        tab.paged?.resetRevisions();
        await backend.pagedClose(tab.id);
      }
      if (buf.resizable) await backend.writeBytes(path, buf.bytes(), tab.mtime);
      else await backend.patchFile(path, buf.patchList(), buf.originalSize, tab.mtime);
    } catch (e) {
      if (paged) await this.reopenPaged(tab).catch(() => undefined);
      const msg = errorText(e);
      if (msg.startsWith(E_EXTERNAL_CHANGE)) {
        await message(t('"{name}" was changed by another program. Your byte changes were not saved; reload the file to see its current content.', { name: tab.name }), { title: t("Save failed"), kind: "error" });
      } else await message(msg, { title: t("Save failed"), kind: "error" });
      return false;
    }
    this.discardHex(tab);
    await this.reload(tab);
    this.addRecent(path);
    return true;
  }

  private async reopenPaged(tab: Tab): Promise<void> {
    if (!tab.path || !tab.paged) return;
    const res = await backend.openPath(tab.id, tab.path, true);
    tab.paged.totalLines = res.lineCount ?? 1;
    await tab.paged.load(tab.paged.firstLine, tab.paged.cursorLine());
  }

  setReadOnly(tab: Tab, ro: boolean): void {
    tab = this.owner(tab);
    if (!ro && tab.lockedReadOnly) {
      toast(tab.lockedReadOnly);
      return;
    }
    tab.readOnly = ro;
    this.applyReadOnly(tab);
  }

  togglePinned(tab: Tab): void {
    tab.pinned = !tab.pinned;
    this.emit("tabs");
    this.scheduleSessionSave();
  }

  /** Re-apply settings-dependent compartments to every tab. */
  applySettingsToAll(effectsFor: (tab: Tab) => import("@codemirror/state").StateEffect<unknown>[]): void {
    for (const x of this.tabs) this.dispatchTo(x, { effects: effectsFor(x) });
    for (const p of this.panes) p.view.requestMeasure();
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
      backend.sessionStoreBuffer(tab.id, this.docText(tab), bufferGeneration(tab.revision)).catch((e) => this.reportBackgroundError(tab, e));
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
    const state = this.stateOf(tab);
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const view = this.viewOf(tab);
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
      hexView: tab.hexView,
      splitView: tab.splitView,
      pinned: tab.pinned,
      untitled: tab.untitled,
      readOnly: tab.readOnly,
      cursorLine: line.number + (tab.paged?.firstLine ?? 0),
      cursorCol: head - line.from,
      scrollTop: view ? view.scrollDOM.scrollTop : tab.scrollTop,
      mtime: tab.mtime,
      pane: this.paneIndex(tab),
      shown: !!this.paneOf(tab),
      indent: tab.indent,
      bookmarks: tab.kind === "memory" ? bookmarkLines(state) : [],
    };
  }

  /** Write the session file. Background saves only log failures; `strict` rethrows them. */
  async saveSessionNow(strict = false): Promise<void> {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
    }
    const owners = this.tabs.filter((x) => !x.cloneOf);
    const active = this.active ? this.owner(this.active) : null;
    const data: SessionData = {
      tabs: owners.map((x) => this.tabMeta(x)),
      active: active?.id ?? null,
      next_untitled: this.nextUntitled,
    };
    try {
      await backend.sessionSave(data);
    } catch (e) {
      if (strict) throw e;
      console.warn("session save failed", e);
    }
  }

  /**
   * Store everything needed to restore unsaved work (used before the window closes or the
   * page reloads). Rejects, naming the affected tabs, if anything could not be stored.
   */
  async flushAll(): Promise<void> {
    const errors: string[] = [];
    for (const tab of this.tabs) {
      if (tab.cloneOf) continue;
      if (tab.bufferTimer) {
        clearTimeout(tab.bufferTimer);
        tab.bufferTimer = undefined;
      }
      if (tab.hex?.dirty) errors.push(`${tab.name}: ${t("byte changes in the hex view cannot be kept for recovery. Save them first.")}`);
      try {
        if (tab.revision !== tab.savedRevision && tab.kind === "memory") await backend.sessionStoreBuffer(tab.id, this.docText(tab), bufferGeneration(tab.revision));
        if (tab.kind === "paged" && tab.paged) {
          await tab.paged.commit();
          if (tab.dirty) await backend.pagedStoreEdits(tab.id);
        }
      } catch (e) {
        errors.push(`${tab.name}: ${errorText(e)}`);
      }
    }
    try {
      await this.saveSessionNow(true);
    } catch (e) {
      errors.push(`${t("Session")}: ${errorText(e)}`);
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }

  /**
   * Reopen the tabs of the last session. With `onlyUnsaved`, only tabs with unsaved changes come
   * back: their text exists nowhere else, and saving the session prunes what is not reopened.
   */
  async restoreSession(opts: { onlyUnsaved?: boolean } = {}): Promise<boolean> {
    this.restoring = true;
    this.lostEdits = [];
    try {
      const s = await backend.sessionLoad();
      if (opts.onlyUnsaved) s.tabs = s.tabs.filter((m) => (m as { dirty?: boolean }).dirty);
      this.nextUntitled = Math.max(1, s.next_untitled || 1);
      let activeTab: Tab | null = null;
      let shownOther: Tab | null = null;
      if (s.tabs.some((m) => (m as { pane?: number }).pane === 1)) this.setSplit(true);
      for (const meta of s.tabs) {
        try {
          const tab = await this.restoreTab(meta);
          if (!tab) continue;
          if (meta.id === s.active) activeTab = tab;
          else if ((meta as { shown?: boolean }).shown) shownOther = tab;
        } catch (e) {
          console.warn("restore failed for", meta.path, e);
        }
      }
      if (this.tabs.length === 0) return false;
      if (this.splitOn && !this.tabsIn(1).length) this.setSplit(false);
      if (this.splitOn && !this.tabsIn(0).length) {
        for (const x of this.tabs) x.pane = 0;
        this.setSplit(false);
      }
      const first = activeTab ?? this.tabs[0];
      if (this.splitOn) {
        const otherPane = this.paneIndex(first) === 0 ? 1 : 0;
        const other = shownOther && this.paneIndex(shownOther) === otherPane ? shownOther : this.tabsIn(otherPane)[0];
        if (other) this.show(other);
      }
      this.activate(first);
      return true;
    } finally {
      this.restoring = false;
      this.scheduleSessionSave();
      if (this.lostEdits.length) {
        void message(t("Unsaved changes to these large files could not be restored, because the files were changed or removed by another program:\n\n{files}", { files: this.lostEdits.join("\n") }), {
          title: t("Unsaved changes lost"),
          kind: "warning",
        });
      }
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
      hexView?: boolean;
      splitView?: boolean;
      pinned?: boolean;
      untitled?: number | null;
      readOnly?: boolean;
      cursorLine?: number;
      cursorCol?: number;
      scrollTop?: number;
      pane?: number;
      indent?: IndentInfo | null;
      bookmarks?: number[];
    };
    const pane: 0 | 1 = m.pane === 1 && this.splitOn ? 1 : 0;
    let tab: Tab | null = null;
    if (meta.kind === "paged" && meta.path) {
      // The recovery log of a large file only describes changes to the file it was made for.
      if (!(await backend.pathExists(meta.path))) {
        if (m.dirty) this.lostEdits.push(meta.path);
        return null;
      }
      tab = await this.openOne(meta.path, meta.id, { livePreview: m.livePreview, languageName: m.languageName, paged: true, hexView: m.hexView, pane });
      if (m.dirty && !tab.dirty) this.lostEdits.push(meta.path);
    } else {
      const buffer = await backend.sessionLoadBuffer(meta.id);
      if (buffer !== null) {
        tab = this.makeTab({
          id: meta.id,
          path: meta.path,
          // Untitled names are rebuilt so they follow the current language ("new 1" / "neu 1").
          name: m.untitled != null ? untitledName(m.untitled) : (m.name ?? (meta.path ? basename(meta.path) : untitledName(1))),
          kind: "memory",
          encoding: m.encoding,
          eol: m.eol,
          dirty: true,
          livePreview: m.livePreview,
          pinned: m.pinned,
          untitled: m.untitled ?? null,
          readOnly: m.readOnly,
          mtime: (m as { mtime?: number }).mtime ?? 0,
          pane,
          indent: m.indent ?? null,
        });
        const desc = m.languageName ? languageByName(m.languageName) : tab.path ? languageForFile(tab.name) : null;
        tab.languageName = desc?.name ?? null;
        const langExt: Extension = desc ? await loadLanguage(desc) : [];
        tab.state = this.buildState(tab, buffer, langExt);
        this.insertTab(tab);
      } else if (meta.path) {
        if (!(await backend.pathExists(meta.path))) return null;
        tab = await this.openOne(meta.path, meta.id, { livePreview: m.livePreview, languageName: m.languageName, hexView: m.hexView, pane });
      } else {
        // untitled with no stored buffer: empty tab
        tab = this.makeTab({ id: meta.id, name: untitledName(m.untitled ?? 1), kind: "memory", untitled: m.untitled ?? null, livePreview: m.livePreview, pane });
        tab.state = this.buildState(tab, "", []);
        this.insertTab(tab);
      }
    }
    if (!tab) return null;
    tab.pinned = m.pinned ?? false;
    tab.splitView = !!m.splitView && tab.hexView;
    if (m.encoding && tab.kind === "memory") tab.encoding = m.encoding;
    if (m.eol) tab.eol = m.eol;
    if (m.readOnly) tab.readOnly = true;
    if (m.indent !== undefined && tab.kind === "memory") {
      tab.indent = m.indent;
      tab.state = tab.state.update({ effects: compartments.indent.reconfigure(this.indentExtFor(tab)) }).state;
    }
    if (m.bookmarks?.length && tab.kind === "memory") tab.state = tab.state.update({ effects: setBookmarks.of(m.bookmarks) }).state;
    tab.scrollTop = m.scrollTop ?? 0;
    if (m.cursorLine) tab.pendingCursor = { line: m.cursorLine, col: m.cursorCol ?? 0 };
    return tab;
  }
}
