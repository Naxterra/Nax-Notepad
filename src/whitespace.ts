// "Show whitespace" and "Show line endings", like Notepad++'s View > Show Symbol.
import { Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, highlightWhitespace, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";

class EolWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: EolWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-eol";
    el.textContent = this.label;
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** A marker after every line that has a line break, showing the document's line ending. */
export function eolMarkers(label: () => string): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      label: string;
      constructor(view: EditorView) {
        this.label = label();
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        const l = label();
        if (u.docChanged || u.viewportChanged || l !== this.label) {
          this.label = l;
          this.decorations = this.build(u.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const deco = Decoration.widget({ widget: new EolWidget(this.label), side: 1 });
        const doc = view.state.doc;
        const out = [];
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = doc.lineAt(pos);
            if (line.number < doc.lines) out.push(deco.range(line.to));
            pos = line.to + 1;
          }
        }
        return Decoration.set(out);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export function whitespaceExt(showWhitespace: boolean, showEol: boolean, eol: () => string): Extension {
  return [showWhitespace ? highlightWhitespace() : [], showEol ? eolMarkers(eol) : []];
}
