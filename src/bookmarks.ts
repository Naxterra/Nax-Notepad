// Line bookmarks with a gutter, like Notepad++ (Ctrl+F2 / F2 / Shift+F2). Bookmarks follow
// edits and are stored per tab in the session as line numbers.
import { EditorState, Extension, RangeSet, RangeSetBuilder, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker } from "@codemirror/view";

class BookmarkMarker extends GutterMarker {
  toDOM(): Node {
    const el = document.createElement("div");
    el.className = "cm-bookmark";
    return el;
  }
}
const marker = new BookmarkMarker();

/** Toggle the bookmark on the line containing the position. */
export const toggleBookmarkAt = StateEffect.define<number>({ map: (p, m) => m.mapPos(p) });
/** Replace all bookmarks with these 1-based line numbers. */
export const setBookmarks = StateEffect.define<number[]>();

function normalize(set: RangeSet<GutterMarker>, doc: Text): RangeSet<GutterMarker> {
  const b = new RangeSetBuilder<GutterMarker>();
  let lastLine = -1;
  for (const it = set.iter(); it.value; it.next()) {
    const line = doc.lineAt(Math.min(it.from, doc.length));
    if (line.number === lastLine) continue;
    lastLine = line.number;
    b.add(line.from, line.from, marker);
  }
  return b.finish();
}

export const bookmarkField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    if (tr.docChanged) set = normalize(set.map(tr.changes), tr.state.doc);
    for (const e of tr.effects) {
      if (e.is(setBookmarks)) {
        const doc = tr.state.doc;
        const lines = [...new Set(e.value.filter((n) => n >= 1 && n <= doc.lines))].sort((a, b) => a - b);
        const b = new RangeSetBuilder<GutterMarker>();
        for (const n of lines) b.add(doc.line(n).from, doc.line(n).from, marker);
        set = b.finish();
      } else if (e.is(toggleBookmarkAt)) {
        const line = tr.state.doc.lineAt(Math.min(e.value, tr.state.doc.length));
        let has = false;
        set.between(line.from, line.to, () => {
          has = true;
          return false;
        });
        set = has
          ? set.update({ filter: (from) => from < line.from || from > line.to })
          : set.update({ add: [marker.range(line.from)], sort: true });
      }
    }
    return set;
  },
});

const lineDeco = Decoration.line({ class: "cm-bookmarkLine" });

export const bookmarks: Extension = [
  bookmarkField,
  gutter({
    class: "cm-bookmark-gutter",
    markers: (v) => v.state.field(bookmarkField),
    initialSpacer: () => marker,
    domEventHandlers: {
      mousedown(view, line) {
        view.dispatch({ effects: toggleBookmarkAt.of(line.from) });
        return true;
      },
    },
  }),
  EditorView.decorations.compute([bookmarkField], (state) => {
    const b = new RangeSetBuilder<Decoration>();
    for (const it = state.field(bookmarkField).iter(); it.value; it.next()) b.add(it.from, it.from, lineDeco);
    return b.finish();
  }),
];

/** Bookmarked lines (1-based, ascending). */
export function bookmarkLines(state: EditorState): number[] {
  const out: number[] = [];
  const set = state.field(bookmarkField, false);
  if (!set) return out;
  for (const it = set.iter(); it.value; it.next()) out.push(state.doc.lineAt(it.from).number);
  return out;
}

/** Start of the next (dir 1) or previous (dir -1) bookmarked line, wrapping around. */
export function nextBookmark(state: EditorState, pos: number, dir: 1 | -1): number | null {
  const lines = bookmarkLines(state);
  if (!lines.length) return null;
  const cur = state.doc.lineAt(pos).number;
  const n = dir > 0 ? (lines.find((l) => l > cur) ?? lines[0]) : ([...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1]);
  return state.doc.line(n).from;
}
