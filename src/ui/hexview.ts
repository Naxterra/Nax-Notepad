// Read-only hex view with virtual scrolling. Works for files of any size because rows are
// rendered on demand from 64 KB chunks fetched through the backend.
import { t } from "../i18n";
import { h, prompt } from "./dialogs";

export interface HexSource {
  size: number;
  name: string;
  read(offset: number, len: number): Promise<Uint8Array>;
}

const BYTES_PER_ROW = 16;
const CHUNK = 64 * 1024;
const MAX_VIRTUAL = 6_000_000; // px, keeps the scroll container within browser limits

export class HexView {
  readonly root: HTMLElement;
  private header: HTMLElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private body: HTMLElement;
  private source: HexSource | null = null;
  private cache = new Map<number, Uint8Array>();
  private pending = new Map<number, Promise<Uint8Array>>();
  private firstRow = 0;
  private rowHeight = 20;
  private syncing = false;
  private raf = 0;

  constructor(parent: HTMLElement) {
    this.header = h("div", { class: "hex-header" });
    this.spacer = h("div", { class: "hex-spacer" });
    this.body = h("pre", { class: "hex-body" });
    this.scroller = h("div", { class: "hex-scroller", tabindex: "0" }, this.spacer, this.body);
    this.root = h("div", { class: "hex-root" }, this.header, this.scroller);
    this.root.style.display = "none";
    parent.appendChild(this.root);
    this.scroller.addEventListener("scroll", () => this.onScroll());
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (!this.scaled()) return;
        e.preventDefault();
        this.setFirstRow(this.firstRow + Math.sign(e.deltaY) * 3);
      },
      { passive: false }
    );
    this.scroller.addEventListener("keydown", (e) => this.onKey(e));
    new ResizeObserver(() => this.render()).observe(this.scroller);
  }

  get visible(): boolean {
    return this.root.style.display !== "none";
  }

  show(source: HexSource): void {
    this.source = source;
    this.cache.clear();
    this.pending.clear();
    this.firstRow = 0;
    this.root.style.display = "";
    this.spacer.style.height = `${this.virtualHeight()}px`;
    this.scroller.scrollTop = 0;
    this.render();
    this.scroller.focus();
  }

  hide(): void {
    this.root.style.display = "none";
    this.source = null;
    this.cache.clear();
    this.pending.clear();
  }

  private rows(): number {
    return this.source ? Math.max(1, Math.ceil(this.source.size / BYTES_PER_ROW)) : 0;
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
    this.scroller.scrollTop = max > 0 ? (this.firstRow / max) * track : 0;
    this.syncing = false;
    this.render();
  }

  async gotoOffset(): Promise<void> {
    if (!this.source) return;
    const cur = (this.firstRow * BYTES_PER_ROW).toString(16).toUpperCase();
    const r = await prompt(t("Go to offset"), t("Offset (hex, or decimal with a # prefix):"), cur);
    if (r === null) return;
    const s = r.trim();
    const n = s.startsWith("#") ? parseInt(s.slice(1), 10) : parseInt(s.replace(/^0x/i, ""), 16);
    if (Number.isFinite(n)) this.setFirstRow(Math.floor(n / BYTES_PER_ROW));
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

  private onKey(e: KeyboardEvent): void {
    const page = this.visibleRows() - 1;
    const map: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (e.key in map) {
      e.preventDefault();
      this.setFirstRow(this.firstRow + map[e.key]);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      this.setFirstRow(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      this.setFirstRow(this.rows());
    }
  }

  private chunkFor(offset: number): Uint8Array | Promise<Uint8Array> {
    const idx = Math.floor(offset / CHUNK);
    const hit = this.cache.get(idx);
    if (hit) return hit;
    let p = this.pending.get(idx);
    if (!p) {
      const src = this.source!;
      p = src.read(idx * CHUNK, Math.min(CHUNK, src.size - idx * CHUNK)).then((b) => {
        this.cache.set(idx, b);
        this.pending.delete(idx);
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
        return b;
      });
      this.pending.set(idx, p);
    }
    return p;
  }

  render(): void {
    if (!this.source || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      void this.renderNow();
    });
  }

  private async renderNow(): Promise<void> {
    const src = this.source;
    if (!src) return;
    const first = this.firstRow;
    const count = this.visibleRows() + 1;
    const startOff = first * BYTES_PER_ROW;
    const endOff = Math.min(src.size, (first + count) * BYTES_PER_ROW);
    const needed = new Set<number>();
    for (let o = startOff; o < endOff; o += CHUNK - (o % CHUNK)) needed.add(Math.floor(o / CHUNK));
    const chunks = await Promise.all([...needed].map((i) => this.chunkFor(i * CHUNK)));
    if (this.source !== src || this.firstRow !== first) return; // stale
    const byIdx = new Map([...needed].map((i, k) => [i, chunks[k]]));
    const byteAt = (o: number) => {
      const c = byIdx.get(Math.floor(o / CHUNK));
      return c ? c[o % CHUNK] : 0;
    };
    const width = Math.max(8, src.size.toString(16).length);
    const lines: string[] = [];
    for (let r = 0; r < count; r++) {
      const off = (first + r) * BYTES_PER_ROW;
      if (off >= src.size) break;
      const n = Math.min(BYTES_PER_ROW, src.size - off);
      let hex = "";
      let ascii = "";
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        if (i < n) {
          const b = byteAt(off + i);
          hex += b.toString(16).padStart(2, "0") + (i === 7 ? "  " : " ");
          ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·";
        } else hex += "   " + (i === 7 ? " " : "");
      }
      lines.push(`${off.toString(16).padStart(width, "0")}  ${hex} |${ascii}|`);
    }
    this.body.textContent = lines.join("\n");
    this.body.style.top = `${this.scaled() ? this.scroller.scrollTop : first * this.rowHeight}px`;
    this.header.textContent = `${src.name}  ·  ${src.size.toLocaleString()} ${t("bytes")}  ·  ${t("Offset")} 0x${startOff.toString(16).toUpperCase()}`;
  }
}
