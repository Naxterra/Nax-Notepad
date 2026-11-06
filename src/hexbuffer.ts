// Bytes edited in the hex view.
//
// Files up to FULL_LIMIT are loaded completely, and bytes can be overwritten, inserted and
// deleted. Larger files are read in chunks on demand and edited by overwriting bytes only. The
// changes are kept as patches and written by streaming the file through a temporary copy.

import { t } from "./i18n";

export interface ByteSource {
  size: number;
  read(offset: number, len: number): Promise<Uint8Array>;
  /** Search in bounded blocks, applying these unsaved overwrites before matching. */
  find?(pattern: Uint8Array, from: number, backwards: boolean, patches?: [number, number][]): Promise<number | null>;
}

export interface HexSnapshot {
  originalSize: number;
  /** Complete edited bytes for resizable files, encoded as base64. */
  bytes?: string;
  /** Sparse overwrites for large files; the original must still match its recorded stamp. */
  patches?: [number, number][];
}

export const FULL_LIMIT = 8 * 1024 * 1024;
const CHUNK = 64 * 1024;
const READ_PIECE = 4 * 1024 * 1024;

type Op = { kind: "set"; at: number; before: Uint8Array; after: Uint8Array; modBefore?: Uint8Array } | { kind: "insert"; at: number; bytes: Uint8Array } | { kind: "remove"; at: number; bytes: Uint8Array };

export class HexBuffer {
  /** Byte edits pause while a save writes this buffer and reloads its source. */
  saving = false;
  /** Changes even when undo returns to an earlier state (guards asynchronous clipboard work). */
  revision = 0;
  /** Whether bytes can be inserted and deleted (the file is held in memory). */
  readonly resizable: boolean;
  /** Size of the file when it was loaded. */
  readonly originalSize: number;
  private data: Uint8Array;
  /** Per byte: 1 if changed since loading (full mode). */
  private mod: Uint8Array;
  private patches = new Map<number, number>();
  private cache = new Map<number, Uint8Array>();
  private pending = new Map<number, Promise<Uint8Array>>();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  /** Undo depth that matches the file on disk; -1 when that state can no longer be reached. */
  private savedDepth = 0;

  private constructor(
    private source: ByteSource,
    data: Uint8Array | null
  ) {
    this.originalSize = source.size;
    this.resizable = data !== null;
    this.data = data ?? new Uint8Array(0);
    this.mod = new Uint8Array(this.data.length);
  }

  /** Load a buffer; small sources are read completely. */
  static async load(source: ByteSource, fullLimit = FULL_LIMIT): Promise<HexBuffer> {
    if (source.size > fullLimit) return new HexBuffer(source, null);
    const data = new Uint8Array(source.size);
    for (let o = 0; o < source.size; o += READ_PIECE) {
      const len = Math.min(READ_PIECE, source.size - o);
      const part = await source.read(o, len);
      if (part.length !== len) throw new Error(t("The file changed while its bytes were being read. Reload it and try again."));
      data.set(part, o);
    }
    return new HexBuffer(source, data);
  }

  /** Rebuild a dirty buffer without expanding a large source into memory. */
  static restore(snapshot: HexSnapshot, source: ByteSource): HexBuffer {
    const invalid = () => new Error(t("The saved byte changes are damaged and could not be restored."));
    if (!Number.isSafeInteger(snapshot.originalSize) || snapshot.originalSize < 0 || snapshot.originalSize !== source.size) throw invalid();
    if ((typeof snapshot.bytes === "string") === Array.isArray(snapshot.patches)) throw invalid();
    let data: Uint8Array | null = null;
    if (typeof snapshot.bytes === "string") {
      if (snapshot.originalSize > FULL_LIMIT) throw invalid();
      try { data = Uint8Array.from(atob(snapshot.bytes), (ch) => ch.charCodeAt(0)); }
      catch { throw invalid(); }
    }
    const buffer = new HexBuffer(source, data);
    for (const patch of snapshot.patches ?? []) {
      if (!Array.isArray(patch) || patch.length !== 2 || !Number.isSafeInteger(patch[0]) || patch[0] < 0 || patch[0] >= source.size || !Number.isInteger(patch[1]) || patch[1] < 0 || patch[1] > 255 || buffer.patches.has(patch[0])) throw invalid();
      buffer.patches.set(patch[0], patch[1]);
    }
    buffer.savedDepth = -1;
    buffer.mod.fill(1);
    return buffer;
  }

  snapshot(): HexSnapshot {
    if (!this.resizable) return { originalSize: this.originalSize, patches: this.patchList() };
    let binary = "";
    for (let i = 0; i < this.data.length; i += 0x8000) binary += String.fromCharCode(...this.data.subarray(i, i + 0x8000));
    return { originalSize: this.originalSize, bytes: btoa(binary) };
  }

  get size(): number {
    return this.resizable ? this.data.length : this.originalSize;
  }

  get dirty(): boolean {
    return this.undoStack.length !== this.savedDepth;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Number of changed bytes (overwrite mode) or edits (resizable mode). */
  get changeCount(): number {
    return this.resizable ? this.undoStack.length : this.patches.size;
  }

  /** Make sure the bytes in [start, end) can be read synchronously. */
  async ready(start: number, end: number): Promise<void> {
    if (this.resizable) return;
    end = Math.min(end, this.originalSize);
    const waits: Promise<unknown>[] = [];
    for (let i = Math.floor(start / CHUNK); i * CHUNK < end; i++) {
      waits.push(this.chunk(i));
    }
    await Promise.all(waits);
  }

  private chunk(i: number): Promise<Uint8Array> {
    const cached = this.cache.get(i);
    if (cached) return Promise.resolve(cached);
    let p = this.pending.get(i);
    if (!p) {
      const len = Math.min(CHUNK, this.originalSize - i * CHUNK);
      p = this.source.read(i * CHUNK, len).then((b) => {
        if (b.length !== len) throw new Error(t("The file changed while its bytes were being read. Reload it and try again."));
        this.cache.set(i, b);
        if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
        return b;
      }).finally(() => this.pending.delete(i));
      this.pending.set(i, p);
    }
    return p;
  }

  /** Copy a range without depending on its chunks remaining in the display cache. */
  async readSlice(start: number, end: number): Promise<Uint8Array> {
    start = Math.max(0, Math.min(start, this.size));
    end = Math.max(start, Math.min(end, this.size));
    if (this.resizable) return this.data.slice(start, end);
    const out = new Uint8Array(end - start);
    for (let at = start; at < end;) {
      const i = Math.floor(at / CHUNK);
      const bytes = await this.chunk(i);
      const to = Math.min(end, (i + 1) * CHUNK);
      out.set(bytes.subarray(at % CHUNK, at % CHUNK + to - at), at - start);
      at = to;
    }
    for (const [at, byte] of this.patches) if (at >= start && at < end) out[at - start] = byte;
    return out;
  }

  /** The byte at `o`, or undefined if it is not loaded (or beyond the end). */
  byteAt(o: number): number | undefined {
    if (o < 0 || o >= this.size) return undefined;
    if (this.resizable) return this.data[o];
    const p = this.patches.get(o);
    if (p !== undefined) return p;
    const c = this.cache.get(Math.floor(o / CHUNK));
    return c ? c[o % CHUNK] : undefined;
  }

  isModified(o: number): boolean {
    return this.resizable ? this.mod[o] === 1 : this.patches.has(o);
  }

  /** Offset of the next (or previous) occurrence of `pattern` starting at `from`, or null. */
  async find(pattern: Uint8Array, from: number, backwards: boolean): Promise<number | null> {
    if (!pattern.length) return null;
    if (backwards && from < 0) return null;
    if (!this.resizable) return this.source.find ? this.source.find(pattern, Math.max(0, from), backwards, this.patchList()) : null;
    const d = this.data;
    const last = d.length - pattern.length;
    const match = (i: number) => {
      for (let k = 0; k < pattern.length; k++) if (d[i + k] !== pattern[k]) return false;
      return true;
    };
    if (backwards) {
      for (let i = Math.min(from, last); i >= 0; i--) if (d[i] === pattern[0] && match(i)) return i;
    } else {
      for (let i = Math.max(0, from); i <= last; i++) {
        i = d.indexOf(pattern[0], i);
        if (i < 0 || i > last) break;
        if (match(i)) return i;
      }
    }
    return null;
  }

  /** Bytes [start, end) (must be ready). */
  slice(start: number, end: number): Uint8Array {
    end = Math.min(end, this.size);
    if (this.resizable) return this.data.slice(start, end);
    const out = new Uint8Array(Math.max(0, end - start));
    for (let o = start; o < end; o++) out[o - start] = this.byteAt(o) ?? 0;
    return out;
  }

  // ---- edits ------------------------------------------------------------------------------

  /** Overwrite bytes at `at`. Returns the number written (large files cannot grow). */
  overwrite(at: number, bytes: Uint8Array): number {
    if (!this.resizable) bytes = bytes.subarray(0, Math.max(0, this.originalSize - at));
    if (!bytes.length) return 0;
    const inside = Math.max(0, Math.min(bytes.length, this.size - at));
    const before = this.slice(at, at + inside);
    if (inside < bytes.length) {
      // Writing past the end of a small file appends.
      this.apply({ kind: "set", at, before, after: bytes.subarray(0, inside) }, true);
      this.apply({ kind: "insert", at: at + inside, bytes: bytes.slice(inside) }, true);
    } else this.apply({ kind: "set", at, before, after: bytes.slice() }, true);
    return bytes.length;
  }

  insert(at: number, bytes: Uint8Array): void {
    if (!this.resizable) throw new Error("not resizable");
    if (bytes.length) this.apply({ kind: "insert", at, bytes: bytes.slice() }, true);
  }

  remove(at: number, count: number): void {
    if (!this.resizable) throw new Error("not resizable");
    count = Math.min(count, this.size - at);
    if (count > 0) this.apply({ kind: "remove", at, bytes: this.data.slice(at, at + count) }, true);
  }

  /** Undo the last edit; returns the offset to put the cursor at, or null. */
  undo(): number | null {
    const op = this.undoStack.pop();
    if (!op) return null;
    this.revert(op);
    this.redoStack.push(op);
    this.revision++;
    return op.at;
  }

  redo(): number | null {
    const op = this.redoStack.pop();
    if (!op) return null;
    this.forward(op);
    this.undoStack.push(op);
    this.revision++;
    return op.kind === "insert" ? op.at + op.bytes.length : op.at;
  }

  /** The current state is on disk. */
  markSaved(): void {
    this.savedDepth = this.undoStack.length;
  }

  /** Whole content (resizable buffers). */
  bytes(): Uint8Array {
    return this.data;
  }

  /** Changed bytes as (offset, value), for patching a large file. */
  patchList(): [number, number][] {
    return [...this.patches.entries()].sort((a, b) => a[0] - b[0]);
  }

  private apply(op: Op, record: boolean): void {
    this.forward(op);
    this.revision++;
    if (!record) return;
    // Merge consecutive single-byte overwrites of the same byte (typing two hex digits).
    const last = this.undoStack[this.undoStack.length - 1];
    if (this.savedDepth > this.undoStack.length) this.savedDepth = -1;
    if (last && last.kind === "set" && op.kind === "set" && last.at === op.at && last.after.length === op.after.length && this.undoStack.length !== this.savedDepth) {
      last.after = op.after;
    } else {
      this.undoStack.push(op);
    }
    this.redoStack = [];
  }

  private forward(op: Op): void {
    if (op.kind === "set") {
      // Remember which bytes were changed before, so undo restores exactly that state.
      if (!op.modBefore) {
        op.modBefore = this.resizable ? this.mod.slice(op.at, op.at + op.after.length) : Uint8Array.from(op.after, (_, i) => (this.patches.has(op.at + i) ? 1 : 0));
      }
      this.write(op.at, op.after);
    }
    else if (op.kind === "insert") this.splice(op.at, 0, op.bytes);
    else this.splice(op.at, op.bytes.length, new Uint8Array(0));
  }

  private revert(op: Op): void {
    if (op.kind === "set") {
      this.write(op.at, op.before, op.modBefore);
      if (this.resizable && op.modBefore) this.mod.set(op.modBefore, op.at);
    }
    else if (op.kind === "insert") this.splice(op.at, op.bytes.length, new Uint8Array(0));
    else this.splice(op.at, 0, op.bytes, true);
  }

  /** Write bytes; when undoing, `wasPatched` tells which bytes were original before the edit. */
  private write(at: number, bytes: Uint8Array, wasPatched?: Uint8Array): void {
    if (this.resizable) {
      this.data.set(bytes, at);
      this.mod.fill(1, at, at + bytes.length);
      return;
    }
    for (let i = 0; i < bytes.length; i++) {
      if (wasPatched && !wasPatched[i]) this.patches.delete(at + i);
      else this.patches.set(at + i, bytes[i]);
    }
  }

  private splice(at: number, removeCount: number, insert: Uint8Array, restoring = false): void {
    const n = this.data.length - removeCount + insert.length;
    const data = new Uint8Array(n);
    const mod = new Uint8Array(n);
    data.set(this.data.subarray(0, at));
    mod.set(this.mod.subarray(0, at));
    data.set(insert, at);
    mod.fill(restoring ? 0 : 1, at, at + insert.length);
    data.set(this.data.subarray(at + removeCount), at + insert.length);
    mod.set(this.mod.subarray(at + removeCount), at + insert.length);
    this.data = data;
    this.mod = mod;
  }
}

/** Bytes from text typed or pasted into the hex column ("41 42 0a"), or null if it is not hex. */
export function parseHex(text: string): Uint8Array | null {
  const digits = text.replace(/0x/gi, "").replace(/[\s,;:-]/g, "");
  if (!digits || digits.length % 2 || /[^0-9a-f]/i.test(digits)) return null;
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bytes for text pasted into the character column: Latin-1 if possible, else UTF-8. */
export function textBytes(text: string): Uint8Array {
  if (/^[\u0000-ÿ]*$/.test(text)) return Uint8Array.from(text, (c) => c.charCodeAt(0));
  return new TextEncoder().encode(text);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
