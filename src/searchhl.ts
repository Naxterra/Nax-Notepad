// Highlights every match of the active search query in the visible part of the editor.
import { SearchQuery } from "@codemirror/search";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

export const setQuery = StateEffect.define<SearchQuery | null>();

export const queryField = StateField.define<SearchQuery | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setQuery)) value = e.value;
    return value;
  },
});

const matchDeco = Decoration.mark({ class: "cm-searchMatch" });

export const searchHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.state.field(queryField) !== u.startState.field(queryField)) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const q = view.state.field(queryField);
      if (!q || !q.valid || !q.search) return Decoration.none;
      const ranges = [];
      for (const { from, to } of view.visibleRanges) {
        const cursor = q.getCursor(view.state, Math.max(0, from - 250), Math.min(view.state.doc.length, to + 250));
        let n = 0;
        for (let r = cursor.next(); !r.done && n < 5000; r = cursor.next(), n++) {
          if (r.value.to > r.value.from) ranges.push(matchDeco.range(r.value.from, r.value.to));
        }
      }
      return Decoration.set(ranges, true);
    }
  },
  { decorations: (v) => v.decorations }
);

export const searchHighlight = [queryField, searchHighlighter];
