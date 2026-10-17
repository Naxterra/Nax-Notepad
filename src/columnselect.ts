// Keyboard column (block) selection, like Alt+Shift+Arrow in Notepad++. The block is kept as
// anchor and head in visual columns, so tabs line up and short lines are clamped to their end.
import { Annotation, countColumn, EditorSelection, EditorState, findColumn, SelectionRange, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface Block {
  anchorLine: number;
  anchorCol: number;
  headLine: number;
  headCol: number;
}

const columnSelect = Annotation.define<Block>();

/** The current keyboard block selection; any other selection change ends it. */
export const columnBlock = StateField.define<Block | null>({
  create: () => null,
  update(value, tr) {
    const b = tr.annotation(columnSelect);
    if (b) return b;
    if (tr.selection || tr.docChanged) return null;
    return value;
  },
});

export type ColumnDir = "up" | "down" | "left" | "right";

/** Selection after extending the block one step in `dir`. */
export function columnSelection(state: EditorState, dir: ColumnDir): { selection: EditorSelection; block: Block } {
  const tabSize = state.tabSize;
  const doc = state.doc;
  let b = state.field(columnBlock, false) ?? null;
  if (!b) {
    const main = state.selection.main;
    const al = doc.lineAt(main.anchor);
    const hl = doc.lineAt(main.head);
    b = {
      anchorLine: al.number,
      anchorCol: countColumn(al.text, tabSize, main.anchor - al.from),
      headLine: hl.number,
      headCol: countColumn(hl.text, tabSize, main.head - hl.from),
    };
  }
  let { headLine, headCol } = b;
  if (dir === "up") headLine = Math.max(1, headLine - 1);
  else if (dir === "down") headLine = Math.min(doc.lines, headLine + 1);
  else if (dir === "left") headCol = Math.max(0, headCol - 1);
  else {
    let widest = 0;
    const lo = Math.min(b.anchorLine, headLine);
    const hi = Math.max(b.anchorLine, headLine);
    for (let n = lo; n <= hi; n++) widest = Math.max(widest, countColumn(doc.line(n).text, tabSize));
    headCol = Math.min(headCol + 1, Math.max(widest, headCol));
  }
  const block: Block = { anchorLine: b.anchorLine, anchorCol: b.anchorCol, headLine, headCol };
  const ranges: SelectionRange[] = [];
  const step = headLine >= block.anchorLine ? 1 : -1;
  for (let n = block.anchorLine; ; n += step) {
    const line = doc.line(n);
    const a = line.from + findColumn(line.text, block.anchorCol, tabSize);
    const h = line.from + findColumn(line.text, block.headCol, tabSize);
    ranges.push(EditorSelection.range(a, h));
    if (n === headLine) break;
  }
  return { selection: EditorSelection.create(ranges, ranges.length - 1), block };
}

/** Editor command extending the block selection in `dir`. */
export function columnSelectCommand(dir: ColumnDir) {
  return (view: EditorView): boolean => {
    const r = columnSelection(view.state, dir);
    view.dispatch({ selection: r.selection, annotations: columnSelect.of(r.block), scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

/** Transaction spec for a block step (used by tests and macros without a view). */
export function columnSelectSpec(state: EditorState, dir: ColumnDir) {
  const r = columnSelection(state, dir);
  return { selection: r.selection, annotations: columnSelect.of(r.block) };
}
