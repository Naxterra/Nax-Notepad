// Windowed editing of a paged (memory-mapped) document. The editor shows a window of
// `windowLines` lines; edits are committed to the Rust piece table after a short pause and
// whenever the window moves.
import { Annotation, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { backend, FindOpts, PagedMatch } from "./backend";
import { compartments, lineNumbersExt } from "./editor";
import { settings } from "./settings";

export const pagedLoad = Annotation.define<boolean>();

export interface PagedListener {
  onWindowChanged(): void;
}

export class PagedController {
  firstLine = 0;
  count = 0;
  totalLines = 0;
  dirtyWindow = false;
  private queue: Promise<unknown> = Promise.resolve();
  private commitTimer: number | undefined;
  private scrollRaf = 0;
  private disposed = false;
  private scrollHandler = () => this.onScroll();
  private attached: EditorView | null = null;

  constructor(
    readonly id: string,
    totalLines: number,
    private getView: () => EditorView | null,
    private listener: PagedListener,
    private onEdited: () => void
  ) {
    this.totalLines = totalLines;
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

  /** Load the window starting at `first` into the view, keeping the cursor on `cursorLine` if given. */
  load(first: number, cursorLine?: number, cursorCol = 0): Promise<void> {
    return this.enqueue(async () => {
      const view = this.getView();
      if (!view || this.disposed) return;
      await this.commitNow();
      const w = await backend.pagedWindow(this.id, Math.max(0, first), this.windowLines);
      const v = this.getView();
      if (!v || this.disposed) return;
      this.firstLine = w.firstLine;
      this.count = w.count;
      this.totalLines = w.totalLines;
      const doc = v.state.doc;
      let selection;
      if (cursorLine !== undefined) {
        const rel = Math.min(Math.max(0, cursorLine - this.firstLine), Math.max(0, w.count - 1));
        // selection resolved after the change via a second dispatch
        selection = rel;
      }
      v.dispatch({
        changes: { from: 0, to: doc.length, insert: w.text },
        annotations: [pagedLoad.of(true), Transaction.addToHistory.of(false)],
        effects: compartments.lineNumbers.reconfigure(lineNumbersExt(settings.lineNumbers, this.firstLine)),
      });
      if (selection !== undefined) {
        const line = v.state.doc.line(Math.min(selection + 1, v.state.doc.lines));
        const pos = Math.min(line.from + cursorCol, line.to);
        v.dispatch({ selection: { anchor: pos }, scrollIntoView: true, annotations: [pagedLoad.of(true)] });
      }
      this.dirtyWindow = false;
      this.listener.onWindowChanged();
    });
  }

  /** Called from the editor update listener when the document changed by user action. */
  noteChange(): void {
    this.dirtyWindow = true;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => void this.commit(), 700);
  }

  commit(): Promise<void> {
    return this.enqueue(() => this.commitNow());
  }

  private async commitNow(): Promise<void> {
    if (!this.dirtyWindow || this.disposed) return;
    const view = this.getView();
    if (!view) return;
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    const text = view.state.doc.toString();
    const lines = view.state.doc.lines;
    const total = await backend.pagedCommit(this.id, this.firstLine, this.count, text);
    this.count = lines;
    this.totalLines = total;
    this.dirtyWindow = false;
    this.listener.onWindowChanged();
    await backend.pagedStoreEdits(this.id).catch(() => undefined);
    this.onEdited();
  }

  private onScroll(): void {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      const view = this.getView();
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
        const cursorAbs = this.firstLine + doc.lineAt(view.state.selection.main.head).number - 1;
        const cursorCol = view.state.selection.main.head - doc.lineAt(view.state.selection.main.head).from;
        const keepTopAbs = this.firstLine + topLine;
        void this.load(newFirst, cursorAbs, cursorCol).then(() => {
          const v = this.getView();
          if (!v) return;
          const rel = keepTopAbs - this.firstLine;
          if (rel >= 0 && rel < v.state.doc.lines) {
            const pos = v.state.doc.line(rel + 1).from;
            v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
          }
        });
      }
    });
  }

  /** Absolute (0-based) line of the main cursor. */
  cursorLine(view: EditorView): number {
    return this.firstLine + view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  }

  async gotoLine(abs: number, col = 0): Promise<void> {
    const view = this.getView();
    if (!view) return;
    abs = Math.max(0, Math.min(abs, this.totalLines - 1));
    if (abs >= this.firstLine && abs < this.firstLine + this.count) {
      const line = view.state.doc.line(abs - this.firstLine + 1);
      view.dispatch({ selection: { anchor: Math.min(line.from + col, line.to) }, scrollIntoView: true });
      view.focus();
      return;
    }
    await this.load(Math.max(0, abs - Math.floor(this.windowLines / 2)), abs, col);
    this.getView()?.focus();
  }

  async find(opts: FindOpts, backwards: boolean, fromSelectionEnd: boolean): Promise<PagedMatch | null> {
    const view = this.getView();
    if (!view) return null;
    await this.commit();
    const sel = view.state.selection.main;
    const anchorPos = backwards ? sel.from : fromSelectionEnd ? sel.to : sel.from;
    const line = view.state.doc.lineAt(anchorPos);
    const absLine = this.firstLine + line.number - 1;
    const col = utf8Len(line.text.slice(0, anchorPos - line.from));
    let m = await backend.pagedFind(this.id, opts, absLine, col, backwards);
    if (!m) {
      // wrap around
      m = backwards
        ? await backend.pagedFind(this.id, opts, this.totalLines - 1, 1 << 30, true)
        : await backend.pagedFind(this.id, opts, 0, 0, false);
    }
    if (!m) return null;
    await this.selectMatch(m);
    return m;
  }

  async selectMatch(m: PagedMatch): Promise<void> {
    let view = this.getView();
    if (!view) return;
    if (m.line < this.firstLine || m.line >= this.firstLine + this.count) {
      await this.load(Math.max(0, m.line - Math.floor(this.windowLines / 2)));
      view = this.getView();
      if (!view) return;
    }
    const line = view.state.doc.line(Math.min(m.line - this.firstLine + 1, view.state.doc.lines));
    const startChar = byteToChar(line.text, m.col);
    const endChar = byteToChar(line.text, m.col + m.len);
    view.dispatch({
      selection: { anchor: line.from + startChar, head: Math.min(line.from + endChar, line.to) },
      scrollIntoView: true,
    });
    view.focus();
  }

  async replaceAll(opts: FindOpts, replacement: string): Promise<number> {
    await this.commit();
    const n = await backend.pagedReplaceAll(this.id, opts, replacement);
    if (n > 0) {
      const view = this.getView();
      const cursor = view ? this.cursorLine(view) : 0;
      await this.load(this.firstLine, cursor);
      this.dirtyWindow = false;
      await backend.pagedStoreEdits(this.id).catch(() => undefined);
      this.onEdited();
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
