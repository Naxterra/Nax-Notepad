// Marks for the compare view: changed, added and removed lines of the two documents.
import { EditorState, RangeSetBuilder, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { Hunk } from "./diff";

export interface CompareMark {
  /** First line (1-based). */
  line: number;
  /** Number of lines; 0 marks the place where the other side has lines this one lacks. */
  count: number;
  kind: "added" | "removed" | "changed";
}

export const setCompareMarks = StateEffect.define<CompareMark[] | null>();

const decos = {
  added: Decoration.line({ class: "cm-diff-added" }),
  removed: Decoration.line({ class: "cm-diff-removed" }),
  changed: Decoration.line({ class: "cm-diff-changed" }),
  gap: Decoration.line({ class: "cm-diff-gap" }),
};

function build(doc: Text, marks: CompareMark[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const m of [...marks].sort((x, y) => x.line - y.line)) {
    if (m.count === 0) {
      const n = Math.min(Math.max(1, m.line), doc.lines);
      b.add(doc.line(n).from, doc.line(n).from, decos.gap);
      continue;
    }
    for (let n = m.line; n < m.line + m.count && n <= doc.lines; n++) b.add(doc.line(n).from, doc.line(n).from, decos[m.kind]);
  }
  return b.finish();
}

export const compareField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) if (e.is(setCompareMarks)) set = e.value ? build(tr.state.doc, e.value) : Decoration.none;
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Marks for the left (a) and right (b) document from diff hunks. */
export function marksFromHunks(hunks: Hunk[]): { a: CompareMark[]; b: CompareMark[] } {
  const a: CompareMark[] = [];
  const b: CompareMark[] = [];
  for (const h of hunks) {
    const na = h.a1 - h.a0;
    const nb = h.b1 - h.b0;
    const kind = na && nb ? "changed" : null;
    a.push({ line: h.a0 + 1, count: na, kind: kind ?? "removed" });
    b.push({ line: h.b0 + 1, count: nb, kind: kind ?? "added" });
  }
  return { a, b };
}

/** Line start of the next (dir 1) or previous (dir -1) block of marked lines. */
export function nextDifference(state: EditorState, pos: number, dir: 1 | -1): number | null {
  const set = state.field(compareField, false);
  if (!set) return null;
  const starts: number[] = [];
  let lastLine = -2;
  for (const it = set.iter(); it.value; it.next()) {
    const n = state.doc.lineAt(it.from).number;
    if (n !== lastLine + 1) starts.push(it.from);
    lastLine = n;
  }
  if (!starts.length) return null;
  const cur = state.doc.lineAt(pos).from;
  if (dir > 0) return starts.find((s) => s > cur) ?? starts[0];
  return [...starts].reverse().find((s) => s < cur) ?? starts[starts.length - 1];
}

export function hasCompareMarks(state: EditorState): boolean {
  const set = state.field(compareField, false);
  return !!set && set.size > 0;
}
