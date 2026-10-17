// Windowed editing of a paged (memory-mapped) document. The editor shows a window of
// `windowLines` lines; edits are committed to the Rust piece table after a short pause and
// whenever the window moves.
//
// The controller never depends on the tab being visible: it reads and writes the window
// through its host, which uses the live EditorView for the active tab and the stored
// EditorState otherwise. Every user edit bumps `revision`; a commit records the revision it
// captured, so edits typed while a commit or page load is in flight are never marked committed
// or overwritten.
import { EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { backend, FindOpts, PagedMatch } from "./backend";
import { compartments, lineNumbersExt, systemChange } from "./editor";
import { settings } from "./settings";
import { t } from "./i18n";

/** Kept for callers that check for page loads; same as `systemChange`. */
export const pagedLoad = systemChange;

export interface PagedHost {
  /** Current window state, whether or not the tab is visible. */
  state(): EditorState;
  /** Apply a transaction to the window, whether or not the tab is visible. */
  dispatch(spec: TransactionSpec): void;
  /** The editor view while the tab is visible. */
  view(): EditorView | null;
  onWindowChanged(): void;
  /** The backend document changed without an editor transaction (Replace All). */
  onBackendEdit(): void;
  /** The loaded window is read-only (`truncated` long line, `lossy` invalid bytes). */
  onWindowFlags(flags: { truncated: boolean; lossy: boolean }): void;
  onError(e: unknown): void;
}

export class PagedController {
  firstLine = 0;
  count = 0;
  totalLines = 0;
  /** Incremented on every user edit of the window. */
  revision = 0;
  /** Revision whose text the backend holds. */
  committedRevision = 0;
  /** The current window must not be committed (truncated line or undecodable bytes). */
  windowReadOnly = false;
  /** Whether an "in selection only" scope is set in the backend. */
  scopeActive = false;
  private queue: Promise<unknown> = Promise.resolve();
  private commitTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollRaf = 0;
  private disposed = false;
  private scrollHandler = () => this.onScroll();
  private attached: EditorView | null = null;

  constructor(
    readonly id: string,
    totalLines: number,
    private host: PagedHost
  ) {
    this.totalLines = totalLines;
  }

  /** True while the window holds edits the backend does not have yet. */
  get dirtyWindow(): boolean {
    return this.revision !== this.committedRevision;
  }

  get windowLines(): number {
    return Math.max(500, settings.pagedWindowLines);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  attach(view: EditorView): void {
    if (this.attached === view) return;
    this.detach();
    this.attached = view;
    view.scrollDOM.addEventListener("scroll", this.scrollHandler, { passive: true });
  }

  detach(): void {
    if (this.attached) {
      this.attached.scrollDOM.removeEventListener("scroll", this.scrollHandler);
      this.attached = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    if (this.commitTimer) clearTimeout(this.commitTimer);
  }

  /** The backend document was replaced (reload): forget pending window edits. */
  resetRevisions(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = undefined;
    this.committedRevision = this.revision;
  }

  /** Load the window starting at `first`, keeping the cursor on `cursorLine` if given. */
  load(first: number, cursorLine?: number, cursorCol = 0): Promise<void> {
    return this.enqueue(async () => {
      for (let attempt = 0; !this.disposed; attempt++) {
        await this.commitNow();
        const rev = this.revision;
        const w = await backend.pagedWindow(this.id, Math.max(0, first), this.windowLines);
        if (this.disposed) return;
        if (this.revision !== rev) {
          // The user typed while the page was loading: commit that first, never overwrite it.
          if (attempt < 5) continue;
          return;
        }
        this.firstLine = w.firstLine;
        this.count = w.count;
        this.totalLines = w.totalLines;
        this.windowReadOnly = w.truncated || w.lossy;
        const doc = this.host.state().doc;
        this.host.dispatch({
          changes: { from: 0, to: doc.length, insert: w.text },
          annotations: [systemChange.of(true), Transaction.addToHistory.of(false)],
          effects: compartments.lineNumbers.reconfigure(lineNumbersExt(settings.lineNumbers, this.firstLine)),
        });
        this.committedRevision = this.revision;
        this.host.onWindowFlags({ truncated: w.truncated, lossy: w.lossy });
        if (cursorLine !== undefined) {
          const rel = Math.min(Math.max(0, cursorLine - this.firstLine), Math.max(0, w.count - 1));
          const st = this.host.state();
          const line = st.doc.line(Math.min(rel + 1, st.doc.lines));
          const pos = Math.min(line.from + cursorCol, line.to);
          this.host.dispatch({ selection: { anchor: pos }, scrollIntoView: true, annotations: [systemChange.of(true)] });
        }
        this.host.onWindowChanged();
        return;
      }
    });
  }

  /** Called from the editor update listener when the user changed the window. */
  noteChange(): void {
    this.revision++;
    this.scheduleCommit();
  }

  private scheduleCommit(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = undefined;
      this.commit().catch((e) => this.host.onError(e));
    }, 700);
  }

  /** Send pending window edits to the backend. Rejects if the backend refuses them. */
  commit(): Promise<void> {
    return this.enqueue(() => this.commitNow());
  }

  private async commitNow(): Promise<void> {
    if (!this.dirtyWindow || this.disposed) return;
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    if (this.windowReadOnly) throw new Error(t("This part of the file is read-only and was not changed."));
    const rev = this.revision;
    const state = this.host.state();
    const text = state.doc.toString();
    const lines = state.doc.lines;
    const total = await backend.pagedCommit(this.id, this.firstLine, this.count, text);
    this.count = lines;
    this.totalLines = total;
    this.committedRevision = rev;
    // Edits typed during the commit stay pending and are sent by the next commit.
    if (this.revision !== rev) this.scheduleCommit();
    this.host.onWindowChanged();
    await backend.pagedStoreEdits(this.id);
  }

  private onScroll(): void {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      const view = this.host.view();
      if (!view || this.disposed) return;
      const doc = view.state.doc;
      const topLine = doc.lineAt(view.viewport.from).number - 1;
      const bottomLine = doc.lineAt(view.viewport.to).number - 1;
      const margin = 200;
      const canUp = this.firstLine > 0;
      const canDown = this.firstLine + this.count < this.totalLines;
      if ((topLine < margin && canUp) || (bottomLine > this.count - margin && canDown)) {
        const centerAbs = this.firstLine + Math.floor((topLine + bottomLine) / 2);
        const newFirst = Math.max(0, centerAbs - Math.floor(this.windowLines / 2));
        if (newFirst === this.firstLine) return;
        const cursorAbs = this.cursorLine();
        const cursorCol = view.state.selection.main.head - doc.lineAt(view.state.selection.main.head).from;
        const keepTopAbs = this.firstLine + topLine;
        this.load(newFirst, cursorAbs, cursorCol)
          .then(() => {
            const v = this.host.view();
            if (!v) return;
            const rel = keepTopAbs - this.firstLine;
            if (rel >= 0 && rel < v.state.doc.lines) {
              const pos = v.state.doc.line(rel + 1).from;
              v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
            }
          })
          .catch((e) => this.host.onError(e));
      }
    });
  }

  /** Absolute (0-based) line of the main cursor. */
  cursorLine(): number {
    const st = this.host.state();
    return this.firstLine + st.doc.lineAt(st.selection.main.head).number - 1;
  }

  async gotoLine(abs: number, col = 0): Promise<void> {
    abs = Math.max(0, Math.min(abs, this.totalLines - 1));
    if (abs >= this.firstLine && abs < this.firstLine + this.count) {
      const line = this.host.state().doc.line(abs - this.firstLine + 1);
      this.host.dispatch({ selection: { anchor: Math.min(line.from + col, line.to) }, scrollIntoView: true });
      this.host.view()?.focus();
      return;
    }
    await this.load(Math.max(0, abs - Math.floor(this.windowLines / 2)), abs, col);
    this.host.view()?.focus();
  }

  /** Absolute line and byte column of a window position. */
  private absPos(pos: number): { line: number; col: number } {
    const st = this.host.state();
    const line = st.doc.lineAt(pos);
    return { line: this.firstLine + line.number - 1, col: utf8Len(line.text.slice(0, pos - line.from)) };
  }

  /** Capture the current selection as the "in selection only" scope. False if it is empty. */
  async setScope(): Promise<boolean> {
    await this.commit();
    const sel = this.host.state().selection.main;
    if (sel.empty) return false;
    const a = this.absPos(sel.from);
    const b = this.absPos(sel.to);
    this.scopeActive = await backend.pagedSetScope(this.id, a.line, a.col, b.line, b.col);
    return this.scopeActive;
  }

  async clearScope(): Promise<void> {
    this.scopeActive = false;
    await backend.pagedClearScope(this.id);
  }

  async find(opts: FindOpts, backwards: boolean, fromSelectionEnd: boolean, scoped = false): Promise<PagedMatch | null> {
    await this.commit();
    const sel = this.host.state().selection.main;
    const anchorPos = backwards ? sel.from : fromSelectionEnd ? sel.to : sel.from;
    const at = this.absPos(anchorPos);
    let m = await backend.pagedFind(this.id, opts, at.line, at.col, backwards, scoped);
    if (!m) {
      // wrap around (within the scope when scoped)
      m = backwards
        ? await backend.pagedFind(this.id, opts, this.totalLines - 1, 1 << 30, true, scoped)
        : await backend.pagedFind(this.id, opts, 0, 0, false, scoped);
    }
    if (!m) return null;
    await this.selectMatch(m);
    return m;
  }

  async selectMatch(m: PagedMatch): Promise<void> {
    if (m.line < this.firstLine || m.line >= this.firstLine + this.count) {
      await this.load(Math.max(0, m.line - Math.floor(this.windowLines / 2)));
    }
    const st = this.host.state();
    const line = st.doc.line(Math.min(m.line - this.firstLine + 1, st.doc.lines));
    const startChar = byteToChar(line.text, m.col);
    const endChar = byteToChar(line.text, m.col + m.len);
    this.host.dispatch({
      selection: { anchor: line.from + startChar, head: Math.min(line.from + endChar, line.to) },
      scrollIntoView: true,
    });
    this.host.view()?.focus();
  }

  async replaceAll(opts: FindOpts, replacement: string, scoped = false): Promise<number> {
    await this.commit();
    const n = await backend.pagedReplaceAll(this.id, opts, replacement, scoped);
    if (n > 0) {
      await this.load(this.firstLine, this.cursorLine());
      await backend.pagedStoreEdits(this.id);
      this.host.onBackendEdit();
    }
    return n;
  }
}

const enc = new TextEncoder();
function utf8Len(s: string): number {
  return enc.encode(s).length;
}

function byteToChar(line: string, byteOff: number): number {
  let bytes = 0;
  for (let i = 0; i < line.length; i++) {
    if (bytes >= byteOff) return i;
    const c = line.codePointAt(i)!;
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (c >= 0x10000) i++;
  }
  return line.length;
}
