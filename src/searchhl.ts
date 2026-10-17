// Highlights every match of the active search query in the visible part of the editor.
import { SearchQuery } from "@codemirror/search";
import { Extension, StateEffect, StateField } from "@codemirror/state";
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

export const searchHighlight: Extension[] = [queryField, searchHighlighter];

// ---- "in selection only" scope -------------------------------------------------------------

export interface ScopeRange {
  from: number;
  to: number;
}

export const setSearchScope = StateEffect.define<ScopeRange | null>();

const scopeDeco = Decoration.mark({ class: "cm-searchScope" });

/**
 * The range that "in selection only" searches and replacements are restricted to. It is
 * captured once when the option is switched on and then mapped through every edit, so finding
 * or replacing a match never shrinks or widens it. Insertions at its edges stay inside.
 */
export const searchScope = StateField.define<ScopeRange | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSearchScope)) return e.value;
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from, -1);
      const to = tr.changes.mapPos(value.to, 1);
      return to > from ? { from, to } : null;
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v ? Decoration.set([scopeDeco.range(v.from, v.to)]) : Decoration.none)),
});

searchHighlight.push(searchScope);
