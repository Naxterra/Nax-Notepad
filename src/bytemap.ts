// Maps positions in the decoded text to byte offsets in the file and back, for the linked
// selection in the split view. Only encodings with a simple, fixed rule per character are
// supported (UTF-8, UTF-16 and single-byte code pages); the mapping is verified against the
// file size, so a document with mixed line endings or invalid bytes simply gets no mapping.
import { Text } from "@codemirror/state";

type Width = (cp: number) => number;

const SINGLE_BYTE = /^(windows-125\d|iso-8859-\d+|koi8-[ru]|macintosh|ibm866|x-mac-cyrillic|us-ascii|ascii|latin1)$/i;

function widthFor(encoding: string): { width: Width; unit: number } | null {
  const e = encoding.toUpperCase();
  if (e === "UTF-8" || e === "UTF-8-BOM") return { width: (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4), unit: 1 };
  if (e === "UTF-16LE" || e === "UTF-16BE") return { width: (cp) => (cp < 0x10000 ? 2 : 4), unit: 2 };
  if (SINGLE_BYTE.test(encoding)) return { width: () => 1, unit: 1 };
  return null;
}

export interface ByteMap {
  /** Byte offset of a text position. */
  toByte(pos: number): number;
  /** Text position of a byte offset (the character that contains it). */
  toPos(byte: number): number;
}

function bytesOf(s: string, width: Width): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    n += width(cp);
    if (cp > 0xffff) i++;
  }
  return n;
}

/**
 * A map for `doc` as decoded from a file of `fileSize` bytes, or null when the encoding is not
 * supported or the computed size does not match the file.
 */
export function createByteMap(doc: Text, encoding: string, eol: "LF" | "CRLF" | "CR", fileSize: number): ByteMap | null {
  const w = widthFor(encoding);
  if (!w) return null;
  const eolBytes = (eol === "CRLF" ? 2 : 1) * w.unit;
  const starts = new Float64Array(doc.lines + 1);
  let total = 0;
  for (let n = 1; n <= doc.lines; n++) {
    starts[n - 1] = total;
    total += bytesOf(doc.line(n).text, w.width);
    if (n < doc.lines) total += eolBytes;
  }
  starts[doc.lines] = total;
  // A byte order mark is not part of the text.
  const bom = fileSize - total;
  if (!(bom === 0 || (bom === 3 && w.unit === 1 && /UTF-8/i.test(encoding)) || (bom === 2 && w.unit === 2))) return null;

  return {
    toByte(pos: number): number {
      const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
      return bom + starts[line.number - 1] + bytesOf(line.text.slice(0, pos - line.from), w.width);
    },
    toPos(byte: number): number {
      const b = byte - bom;
      if (b <= 0) return 0;
      if (b >= total) return doc.length;
      let lo = 0;
      let hi = doc.lines - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= b) lo = mid;
        else hi = mid - 1;
      }
      const line = doc.line(lo + 1);
      let acc = starts[lo];
      for (let i = 0; i < line.text.length; i++) {
        const cp = line.text.codePointAt(i)!;
        const next = acc + w.width(cp);
        if (b < next) return line.from + i;
        acc = next;
        if (cp > 0xffff) i++;
      }
      return line.to; // inside the line break
    },
  };
}
