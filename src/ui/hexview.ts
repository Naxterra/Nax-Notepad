// Hex editor with virtual scrolling. Works for files of any size because rows are rendered on
// demand; the bytes and their edits live in a HexBuffer.
//
// Keys: arrows, Page Up/Down, Home/End (row), Ctrl+Home/End move the cursor (with Shift they
// select). Tab switches between the hex and the character column, Insert switches between
// overwrite and insert. Typing hex digits or characters changes bytes; Backspace and Delete
// remove bytes (small files). Ctrl+C/X/V/A/Z/Y work on bytes.
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { writeClipboard } from "../clipboard";
import { HexBuffer, parseHex, textBytes, toHex } from "../hexbuffer";
import { t } from "../i18n";
import { contextMenu, h, prompt, toast } from "./dialogs";

export interface HexSession {
  name: string;
  buffer: HexBuffer;
  /** Why the bytes cannot be edited, or null. */
  readOnly: string | null;
  /** Called after every edit. */
  onChange(): void;
}

const BYTES_PER_ROW = 16;
const MAX_VIRTUAL = 6_000_000; // px, keeps the scroll container within browser limits

type Pane = "hex" | "ascii";

function esc(c: string): string {
  return c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c;
}

export class HexView {
  readonly root: HTMLElement;
  private header: HTMLElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private body: HTMLElement;
  private session: HexSession | null = null;
  private firstRow = 0;
  private rowHeight = 20;
  private syncing = false;
  private raf = 0;
  private cursor = 0;
  private nibble = 0;
  private pane: Pane = "hex";
  private anchor: number | null = null;
  private insertMode = false;
  private dragging = false;

  constructor(parent: HTMLElement) {
    this.header = h("div", { class: "hex-header" });
    this.spacer = h("div", { class: "hex-spacer" });
    this.body = h("div", { class: "hex-body" });
    this.scroller = h("div", { class: "hex-scroller", tabindex: "0" }, this.spacer, this.body);
    this.root = h("div", { class: "hex-root" }, this.header, this.scroller);
    this.root.style.display = "none";
    parent.appendChild(this.root);
    this.scroller.addEventListener("scroll", () => this.onScroll());
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (!this.scaled() || e.ctrlKey) return;
        e.preventDefault();
        this.setFirstRow(this.firstRow + Math.sign(e.deltaY) * 3);
      },
      { passive: false }
    );
    this.scroller.addEventListener("keydown", (e) => this.onKey(e));
    this.body.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.body.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", () => (this.dragging = false));
    this.root.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    new ResizeObserver(() => this.render()).observe(this.scroller);
  }

  get visible(): boolean {
    return this.root.style.display !== "none";
  }

  /** The buffer currently shown. */
  get buffer(): HexBuffer | null {
    return this.session?.buffer ?? null;
  }

  show(session: HexSession, focus = true): void {
    const same = this.session?.buffer === session.buffer;
    this.session = session;
    this.root.style.display = "";
    if (!same) {
      this.firstRow = 0;
      this.cursor = 0;
      this.nibble = 0;
      this.anchor = null;
      this.insertMode = false;
      this.scroller.scrollTop = 0;
    }
    this.cursor = Math.min(this.cursor, this.maxCursor());
    this.spacer.style.height = `${this.virtualHeight()}px`;
    this.render();
    if (focus) this.scroller.focus();
  }

  hide(): void {
    this.root.style.display = "none";
    this.session = null;
  }

  focus(): void {
    this.scroller.focus();
  }

  private get buf(): HexBuffer {
    return this.session!.buffer;
  }
  private size(): number {
    return this.session ? this.buf.size : 0;
  }
  /** Cursor may stand after the last byte when bytes can be appended. */
  private maxCursor(): number {
    if (!this.session) return 0;
    return this.buf.resizable && !this.session.readOnly ? this.size() : Math.max(0, this.size() - 1);
  }
  private rows(): number {
    return Math.max(1, Math.ceil((this.maxCursor() + 1) / BYTES_PER_ROW));
  }
  private visibleRows(): number {
    return Math.max(1, Math.floor(this.scroller.clientHeight / this.rowHeight));
  }
  private scaled(): boolean {
    return this.rows() * this.rowHeight > MAX_VIRTUAL;
  }
  private virtualHeight(): number {
    return Math.min(this.rows() * this.rowHeight, MAX_VIRTUAL);
  }

  setFirstRow(row: number): void {
    const max = Math.max(0, this.rows() - this.visibleRows());
    this.firstRow = Math.max(0, Math.min(row, max));
    this.syncing = true;
    const track = this.virtualHeight() - this.scroller.clientHeight;
    this.scroller.scrollTop = this.scaled() ? (max > 0 ? (this.firstRow / max) * track : 0) : this.firstRow * this.rowHeight;
    this.syncing = false;
    this.render();
  }

  async gotoOffset(): Promise<void> {
    if (!this.session) return;
    const cur = this.cursor.toString(16).toUpperCase();
    const r = await prompt(t("Go to offset"), t("Offset (hex, or decimal with a # prefix):"), cur);
    if (r === null) return;
    const s = r.trim();
    const n = s.startsWith("#") ? parseInt(s.slice(1), 10) : parseInt(s.replace(/^0x/i, ""), 16);
    if (Number.isFinite(n)) this.moveTo(n, false);
    this.scroller.focus();
  }

  private onScroll(): void {
    if (this.syncing) return;
    const max = Math.max(0, this.rows() - this.visibleRows());
    const track = this.virtualHeight() - this.scroller.clientHeight;
    this.firstRow = this.scaled() ? Math.round((this.scroller.scrollTop / Math.max(1, track)) * max) : Math.floor(this.scroller.scrollTop / this.rowHeight);
    this.firstRow = Math.max(0, Math.min(this.firstRow, max));
    this.render();
  }

  // ---- cursor and selection ---------------------------------------------------------------

  private selection(): { from: number; to: number } | null {
    if (this.anchor === null || this.anchor === this.cursor) return null;
    return { from: Math.min(this.anchor, this.cursor), to: Math.max(this.anchor, this.cursor) + 1 };
  }

  private moveTo(offset: number, extend: boolean): void {
    if (extend && this.anchor === null) this.anchor = this.cursor;
    if (!extend) this.anchor = null;
    this.cursor = Math.max(0, Math.min(offset, this.maxCursor()));
    this.nibble = 0;
    const row = Math.floor(this.cursor / BYTES_PER_ROW);
    const vis = this.visibleRows();
    if (row < this.firstRow) this.setFirstRow(row);
    else if (row >= this.firstRow + vis) this.setFirstRow(row - vis + 1);
    else this.render();
  }

  selectAll(): void {
    if (!this.session) return;
    this.anchor = 0;
    this.cursor = Math.max(0, this.size() - 1);
    this.render();
  }

  private editable(): boolean {
    const s = this.session;
    if (!s) return false;
    if (s.readOnly) {
      toast(s.readOnly, 5000);
      return false;
    }
    return true;
  }

  private changed(): void {
    this.spacer.style.height = `${this.virtualHeight()}px`;
    this.session?.onChange();
    this.render();
  }

  // ---- editing ----------------------------------------------------------------------------

  /** Replace the selection (or write at the cursor) with `bytes`. */
  private put(bytes: Uint8Array): void {
    const b = this.buf;
    const sel = this.selection();
    let at = this.cursor;
    if (sel && b.resizable) {
      b.remove(sel.from, sel.to - sel.from);
      at = sel.from;
      b.insert(at, bytes);
    } else if (this.insertMode && b.resizable) b.insert(at, bytes);
    else {
      if (sel) at = sel.from;
      const n = b.overwrite(at, bytes);
      if (n < bytes.length) toast(t("Large files cannot grow in the hex view. Only existing bytes were changed."), 5000);
    }
    this.anchor = null;
    this.changed();
    this.moveTo(at + bytes.length, false);
  }

  private typeNibble(v: number): void {
    const b = this.buf;
    if (this.selection()) {
      this.put(new Uint8Array([v << 4]));
      this.moveTo(this.cursor - 1, false);
      this.nibble = 1;
      this.render();
      return;
    }
    const at = this.cursor;
    if (this.nibble === 0) {
      if ((this.insertMode || at >= b.size) && b.resizable) b.insert(at, new Uint8Array([v << 4]));
      else if (at < b.size) b.overwrite(at, new Uint8Array([(v << 4) | ((b.byteAt(at) ?? 0) & 0x0f)]));
      else return;
      this.nibble = 1;
      this.changed();
      return;
    }
    b.overwrite(at, new Uint8Array([((b.byteAt(at) ?? 0) & 0xf0) | v]));
    this.changed();
    this.moveTo(at + 1, false);
  }

  private removeBytes(backwards: boolean): void {
    const b = this.buf;
    if (!b.resizable) {
      toast(t("Bytes cannot be removed from large files in the hex view. Overwrite them instead."), 5000);
      return;
    }
    const sel = this.selection();
    if (sel) {
      b.remove(sel.from, sel.to - sel.from);
      this.anchor = null;
      this.changed();
      this.moveTo(sel.from, false);
      return;
    }
    const at = backwards ? this.cursor - (this.nibble ? 0 : 1) : this.cursor;
    if (at < 0 || at >= b.size) return;
    b.remove(at, 1);
    this.changed();
    this.moveTo(at, false);
  }

  async copy(cut = false): Promise<void> {
    if (!this.session) return;
    const sel = this.selection() ?? (this.cursor < this.size() ? { from: this.cursor, to: this.cursor + 1 } : null);
    if (!sel) return;
    if (sel.to - sel.from > 16 * 1024 * 1024) {
      toast(t("The selection is too large to copy."));
      return;
    }
    await this.buf.ready(sel.from, sel.to);
    const bytes = this.buf.slice(sel.from, sel.to);
    const text = this.pane === "hex" ? toHex(bytes) : Array.from(bytes, (x) => (x === 0 ? "." : String.fromCharCode(x))).join("");
    await writeClipboard(text);
    if (!cut || !this.editable()) return;
    if (!this.buf.resizable) {
      toast(t("Bytes cannot be removed from large files in the hex view. Overwrite them instead."), 5000);
      return;
    }
    this.buf.remove(sel.from, sel.to - sel.from);
    this.anchor = null;
    this.changed();
    this.moveTo(sel.from, false);
  }

  async paste(): Promise<void> {
    if (!this.session || !this.editable()) return;
    let text: string;
    try {
      text = await readText();
    } catch {
      return;
    }
    if (!text) return;
    const bytes = this.pane === "hex" ? (parseHex(text) ?? textBytes(text)) : textBytes(text);
    await this.buf.ready(this.cursor, this.cursor + bytes.length);
    this.put(bytes);
  }

  undo(): void {
    if (!this.session || this.session.readOnly) return;
    const at = this.buf.undo();
    if (at === null) return;
    this.anchor = null;
    this.changed();
    this.moveTo(at, false);
  }

  redo(): void {
    if (!this.session || this.session.readOnly) return;
    const at = this.buf.redo();
    if (at === null) return;
    this.anchor = null;
    this.changed();
    this.moveTo(at, false);
  }

  toggleInsert(): void {
    if (!this.session) return;
    if (!this.buf.resizable) {
      toast(t("Large files can only be overwritten in the hex view."));
      return;
    }
    this.insertMode = !this.insertMode;
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.session) return;
    const altGr = e.getModifierState?.("AltGraph");
    const ctrl = (e.ctrlKey || e.metaKey) && !altGr;
    const shift = e.shiftKey;
    const page = this.visibleRows() - 1;
    const row = Math.floor(this.cursor / BYTES_PER_ROW) * BYTES_PER_ROW;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (ctrl && !e.altKey) {
      const c = e.code;
      if (c === "KeyC") return handled(), void this.copy();
      if (c === "KeyX") return handled(), void this.copy(true);
      if (c === "KeyV") return handled(), void this.paste();
      if (c === "KeyA") return handled(), this.selectAll();
      if (c === "KeyZ" && !shift) return handled(), this.undo();
      if (c === "KeyY" || (c === "KeyZ" && shift)) return handled(), this.redo();
      if (k === "Home") return handled(), this.moveTo(0, shift);
      if (k === "End") return handled(), this.moveTo(this.maxCursor(), shift);
      return; // other shortcuts are app commands
    }
    if (e.altKey && !altGr) return;
    const moves: Record<string, number> = {
      ArrowLeft: this.cursor - 1,
      ArrowRight: this.cursor + 1,
      ArrowUp: this.cursor - BYTES_PER_ROW,
      ArrowDown: this.cursor + BYTES_PER_ROW,
      PageUp: this.cursor - page * BYTES_PER_ROW,
      PageDown: this.cursor + page * BYTES_PER_ROW,
      Home: row,
      End: row + BYTES_PER_ROW - 1,
    };
    if (k in moves) {
      handled();
      if ((k === "ArrowUp" && this.cursor < BYTES_PER_ROW) || (k === "ArrowDown" && moves[k] > this.maxCursor() && Math.floor(this.cursor / 16) === Math.floor(this.maxCursor() / 16))) return;
      this.moveTo(moves[k], shift);
      return;
    }
    if (k === "Tab") {
      handled();
      this.pane = this.pane === "hex" ? "ascii" : "hex";
      this.nibble = 0;
      this.render();
      return;
    }
    if (k === "Insert") return handled(), this.toggleInsert();
    if (k === "Escape") {
      this.anchor = null;
      this.render();
      return;
    }
    if (k === "Backspace" || k === "Delete") {
      handled();
      if (this.editable()) this.removeBytes(k === "Backspace");
      return;
    }
    if (k.length !== 1) return;
    handled();
    if (!this.editable()) return;
    if (this.pane === "hex") {
      const v = parseInt(k, 16);
      if (Number.isNaN(v)) return;
      this.typeNibble(v);
    } else {
      const bytes = textBytes(k);
      this.put(bytes);
    }
  }

  private offsetAt(e: MouseEvent): { o: number; pane: Pane } | null {
    const el = (e.target as HTMLElement).closest("[data-o]") as HTMLElement | null;
    if (!el) return null;
    return { o: Number(el.dataset.o), pane: el.classList.contains("hx-a") ? "ascii" : "hex" };
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const hit = this.offsetAt(e);
    e.preventDefault();
    this.scroller.focus();
    if (!hit) return;
    this.pane = hit.pane;
    this.moveTo(hit.o, e.shiftKey);
    if (!e.shiftKey) this.anchor = hit.o;
    this.dragging = true;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragging) return;
    const hit = this.offsetAt(e);
    if (!hit || hit.o === this.cursor) return;
    this.cursor = Math.min(hit.o, this.maxCursor());
    this.render();
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (!this.session) return;
    const hit = this.offsetAt(e);
    const sel = this.selection();
    if (hit && !(sel && hit.o >= sel.from && hit.o < sel.to)) {
      this.pane = hit.pane;
      this.moveTo(hit.o, false);
    }
    const ro = !!this.session.readOnly;
    contextMenu(e.clientX, e.clientY, [
      { label: t("Undo"), run: () => this.undo(), disabled: ro || !this.buf.canUndo },
      { label: t("Redo"), run: () => this.redo(), disabled: ro || !this.buf.canRedo },
      "-",
      { label: t("Cut"), run: () => void this.copy(true), disabled: ro || !this.buf.resizable },
      { label: this.pane === "hex" ? t("Copy as hex") : t("Copy as text"), run: () => void this.copy() },
      { label: t("Paste"), run: () => void this.paste(), disabled: ro },
      { label: t("Delete"), run: () => this.removeBytes(false), disabled: ro || !this.buf.resizable },
      "-",
      { label: t("Select All"), run: () => this.selectAll() },
      { label: t("Go to offset"), run: () => void this.gotoOffset() },
      "-",
      { label: this.insertMode ? t("Overwrite mode") : t("Insert mode"), run: () => this.toggleInsert(), disabled: ro || !this.buf.resizable },
    ]);
  }

  // ---- rendering --------------------------------------------------------------------------

  render(): void {
    if (!this.session || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      void this.renderNow();
    });
  }

  private async renderNow(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const b = s.buffer;
    const first = this.firstRow;
    const count = this.visibleRows() + 1;
    const startOff = first * BYTES_PER_ROW;
    await b.ready(startOff, (first + count) * BYTES_PER_ROW);
    if (this.session !== s || this.firstRow !== first) return; // stale
    const size = b.size;
    const width = Math.max(8, Math.max(size, 1).toString(16).length);
    const sel = this.selection();
    const lastCursor = this.maxCursor();
    const out: string[] = [];
    for (let r = 0; r < count; r++) {
      const off = (first + r) * BYTES_PER_ROW;
      if (off > lastCursor && off >= size) break;
      let hex = "";
      let ascii = "";
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        const o = off + i;
        const gap = i === 7 ? "  " : " ";
        if (o > lastCursor && o >= size) {
          hex += "  " + gap;
          continue;
        }
        const v = b.byteAt(o);
        let cls = "";
        if (sel && o >= sel.from && o < sel.to) cls += " hx-sel";
        if (o === this.cursor) cls += this.pane === "hex" ? " hx-cur" : " hx-cur2";
        if (o < size && b.isModified(o)) cls += " hx-mod";
        const text = o >= size ? "··" : v === undefined ? "??" : v.toString(16).padStart(2, "0");
        hex += `<span class="hx-b${cls}" data-o="${o}">${text}</span>${gap}`;
        let acls = "";
        if (sel && o >= sel.from && o < sel.to) acls += " hx-sel";
        if (o === this.cursor) acls += this.pane === "ascii" ? " hx-cur" : " hx-cur2";
        if (o < size && b.isModified(o)) acls += " hx-mod";
        const ch = o >= size ? " " : v === undefined ? "?" : v >= 0x20 && v < 0x7f ? esc(String.fromCharCode(v)) : "·";
        ascii += `<span class="hx-a${acls}" data-o="${o}">${ch}</span>`;
      }
      out.push(`<div class="hx-row"><span class="hx-off">${off.toString(16).padStart(width, "0")}</span>  ${hex} <span class="hx-bar">|</span>${ascii}<span class="hx-bar">|</span></div>`);
    }
    this.body.innerHTML = out.join("");
    this.body.style.top = `${this.scaled() ? this.scroller.scrollTop : first * this.rowHeight}px`;
    const parts = [
      s.name,
      `${size.toLocaleString()} ${t("bytes")}`,
      `${t("Offset")} 0x${this.cursor.toString(16).toUpperCase()} (${this.cursor.toLocaleString()})`,
    ];
    if (sel) parts.push(t("{n} bytes selected", { n: (sel.to - sel.from).toLocaleString() }));
    parts.push(s.readOnly ? t("read-only") : this.insertMode ? t("INSERT") : t("OVERWRITE"));
    if (b.dirty) parts.push(t("{n} changes, Ctrl+S saves", { n: b.changeCount.toLocaleString() }));
    this.header.textContent = parts.join("  ·  ");
    this.header.title = s.readOnly ?? t("Tab switches between hex and characters, Insert between insert and overwrite.");
  }
}
