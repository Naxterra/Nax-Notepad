// Obsidian-style Markdown Live Preview: the document is rendered in place and the raw syntax
// of a block is revealed only while the cursor is on one of its lines.
import { syntaxTree } from "@codemirror/language";
import { EditorState, Extension, Range, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";

export interface LivePreviewConfig {
  /** Resolve an image source (relative or absolute) to a URL the webview can load. */
  resolveImage: (src: string) => string;
  openLink: (href: string) => void;
}

class BulletWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-bullet";
    s.textContent = "•";
    return s;
  }
  eq() {
    return true;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-lp-checkbox";
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const next = this.checked ? "[ ]" : "[x]";
      view.dispatch({ changes: { from: this.pos, to: this.pos + 3, insert: next } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-hr";
    return s;
  }
  eq() {
    return true;
  }
}

class LangBadgeWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(o: LangBadgeWidget) {
    return o.lang === this.lang;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-langbadge";
    s.textContent = this.lang || "code";
    return s;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-image";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt;
    img.addEventListener("error", () => {
      wrap.textContent = `🖼 ${this.alt || this.src} (not found)`;
      wrap.classList.add("cm-lp-image-missing");
    });
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const hr = Decoration.replace({ widget: new HrWidget() });

const lineDeco = (cls: string) => Decoration.line({ class: cls });
const markDeco = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs });

function revealed(state: EditorState, from: number, to: number): boolean {
  const doc = state.doc;
  const lf = doc.lineAt(from).number;
  const lt = doc.lineAt(Math.min(to, doc.length)).number;
  for (const r of state.selection.ranges) {
    const rf = doc.lineAt(r.from).number;
    const rt = doc.lineAt(r.to).number;
    if (rf <= lt && rt >= lf) return true;
  }
  return false;
}

function childrenNamed(node: SyntaxNode, names: string[]): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (names.includes(c.name)) out.push(c);
  }
  return out;
}

function buildDecorations(view: EditorView, cfg: LivePreviewConfig): DecorationSet {
  const state = view.state;
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  const addLines = (from: number, to: number, cls: string) => {
    let line = doc.lineAt(from);
    for (;;) {
      ranges.push(lineDeco(cls).range(line.from));
      if (line.to >= to || line.number >= doc.lines) break;
      line = doc.line(line.number + 1);
    }
  };
  const hideRange = (from: number, to: number) => {
    if (to > from) ranges.push(hide.range(from, to));
  };
  const hideMarkPlusSpace = (n: SyntaxNode) => {
    let to = n.to;
    if (doc.sliceString(to, to + 1) === " ") to += 1;
    hideRange(n.from, to);
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (ref: SyntaxNodeRef) => {
        const name = ref.name;
        const node = ref.node;
        const shown = () => revealed(state, ref.from, ref.to);
        if (/^ATXHeading[1-6]$/.test(name)) {
          const level = name.slice(-1);
          addLines(ref.from, ref.from, `cm-lp-h cm-lp-h${level}`);
          if (!shown()) for (const m of childrenNamed(node, ["HeaderMark"])) hideMarkPlusSpace(m);
          return;
        }
        if (name === "SetextHeading1" || name === "SetextHeading2") {
          const level = name.slice(-1);
          ranges.push(lineDeco(`cm-lp-h cm-lp-h${level}`).range(doc.lineAt(ref.from).from));
          const marks = childrenNamed(node, ["HeaderMark"]);
          for (const m of marks) {
            ranges.push(lineDeco("cm-lp-setextmark").range(doc.lineAt(m.from).from));
            if (!shown()) hideRange(m.from, m.to);
          }
          return;
        }
        switch (name) {
          case "Emphasis":
            ranges.push(markDeco("cm-lp-em").range(ref.from, ref.to));
            if (!shown()) for (const m of childrenNamed(node, ["EmphasisMark"])) hideRange(m.from, m.to);
            return;
          case "StrongEmphasis":
            ranges.push(markDeco("cm-lp-strong").range(ref.from, ref.to));
            if (!shown()) for (const m of childrenNamed(node, ["EmphasisMark"])) hideRange(m.from, m.to);
            return;
          case "Strikethrough":
            ranges.push(markDeco("cm-lp-strike").range(ref.from, ref.to));
            if (!shown()) for (const m of childrenNamed(node, ["StrikethroughMark"])) hideRange(m.from, m.to);
            return;
          case "Highlight":
            ranges.push(markDeco("cm-lp-highlight").range(ref.from, ref.to));
            if (!shown()) for (const m of childrenNamed(node, ["HighlightMark"])) hideRange(m.from, m.to);
            return;
          case "InlineCode": {
            const marks = childrenNamed(node, ["CodeMark"]);
            ranges.push(markDeco("cm-lp-code").range(ref.from, ref.to));
            if (!shown()) for (const m of marks) hideRange(m.from, m.to);
            return;
          }
          case "FencedCode": {
            addLines(ref.from, ref.to, "cm-lp-codeblock");
            const firstLine = doc.lineAt(ref.from);
            const lastLine = doc.lineAt(ref.to);
            const marks = childrenNamed(node, ["CodeMark"]);
            const info = childrenNamed(node, ["CodeInfo"])[0];
            const inside = shown();
            ranges.push(lineDeco("cm-lp-fence cm-lp-fence-start").range(firstLine.from));
            if (marks.length > 1 && lastLine.number !== firstLine.number) {
              ranges.push(lineDeco("cm-lp-fence cm-lp-fence-end").range(lastLine.from));
            }
            if (!inside) {
              const lang = info ? doc.sliceString(info.from, info.to) : "";
              const openEnd = info ? info.to : marks[0]?.to ?? firstLine.to;
              ranges.push(
                Decoration.replace({ widget: new LangBadgeWidget(lang) }).range(firstLine.from, Math.min(openEnd, firstLine.to))
              );
              if (marks.length > 1 && lastLine.number !== firstLine.number) {
                hideRange(marks[marks.length - 1].from, marks[marks.length - 1].to);
              }
            }
            return;
          }
          case "CodeBlock":
            addLines(ref.from, ref.to, "cm-lp-codeblock");
            return;
          case "Blockquote":
            addLines(ref.from, ref.to, "cm-lp-quote");
            if (!shown()) {
              for (const m of childrenNamed(node, ["QuoteMark"])) hideMarkPlusSpace(m);
            }
            return; // keep iterating into children
          case "Link": {
            const url = childrenNamed(node, ["URL"])[0];
            const href = url ? doc.sliceString(url.from, url.to) : "";
            ranges.push(markDeco("cm-lp-link", { "data-href": href, title: href }).range(ref.from, ref.to));
            if (!shown()) {
              const marks = childrenNamed(node, ["LinkMark", "URL", "LinkTitle", "LinkLabel"]);
              // Hide everything except the link text: first "[" and from "]" to the end.
              const open = marks.find((m) => m.name === "LinkMark");
              if (open) hideRange(open.from, open.to);
              const close = marks.filter((m) => m.name === "LinkMark")[1];
              if (close) hideRange(close.from, ref.to);
            }
            return;
          }
          case "Autolink": {
            const href = doc.sliceString(ref.from, ref.to).replace(/^<|>$/g, "");
            ranges.push(markDeco("cm-lp-link", { "data-href": href }).range(ref.from, ref.to));
            if (!shown()) for (const m of childrenNamed(node, ["LinkMark"])) hideRange(m.from, m.to);
            return;
          }
          case "URL": {
            if (node.parent && (node.parent.name === "Link" || node.parent.name === "Image" || node.parent.name === "Autolink")) return;
            const href = doc.sliceString(ref.from, ref.to);
            ranges.push(markDeco("cm-lp-link", { "data-href": href }).range(ref.from, ref.to));
            return;
          }
          case "Image": {
            if (!shown()) {
              const url = childrenNamed(node, ["URL"])[0];
              const alt = node.getChild("LinkLabel");
              const src = url ? doc.sliceString(url.from, url.to) : "";
              const altText = alt ? doc.sliceString(alt.from, alt.to) : doc.sliceString(ref.from, ref.to).replace(/^!\[([^\]]*)\].*$/, "$1");
              ranges.push(Decoration.replace({ widget: new ImageWidget(cfg.resolveImage(src), altText) }).range(ref.from, ref.to));
            }
            return;
          }
          case "ListItem": {
            const mark = node.getChild("ListMark");
            if (mark && !revealed(state, mark.from, mark.to)) {
              const txt = doc.sliceString(mark.from, mark.to);
              if (/^[-*+]$/.test(txt)) ranges.push(bullet.range(mark.from, mark.to));
            }
            const task = node.getChild("Task");
            if (task) {
              const marker = task.getChild("TaskMarker");
              if (marker) {
                const txt = doc.sliceString(marker.from, marker.to);
                const checked = /x/i.test(txt);
                if (checked) ranges.push(markDeco("cm-lp-task-done").range(marker.to, task.to));
                if (!revealed(state, marker.from, marker.to)) {
                  ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked, marker.from) }).range(marker.from, marker.to));
                }
              }
            }
            return;
          }
          case "HorizontalRule":
            if (!shown()) ranges.push(hr.range(ref.from, ref.to));
            else ranges.push(markDeco("cm-lp-hr-src").range(ref.from, ref.to));
            return;
          case "Table":
            addLines(ref.from, ref.to, "cm-lp-table");
            return;
          case "TableHeader":
            ranges.push(markDeco("cm-lp-strong").range(ref.from, ref.to));
            return;
          case "Escape":
            if (!shown()) hideRange(ref.from, ref.from + 1);
            return;
          case "HTMLTag":
          case "HTMLBlock":
          case "CommentBlock":
            ranges.push(markDeco("cm-lp-html").range(ref.from, ref.to));
            return;
          case "Superscript":
            ranges.push(markDeco("cm-lp-sup").range(ref.from, ref.to));
            if (!shown()) for (const m of childrenNamed(node, ["SuperscriptMark"])) hideRange(m.from, m.to);
            return;
          case "Subscript":
            ranges.push(markDeco("cm-lp-sub").range(ref.from, ref.to));
            if (!shown()) for (const m of childrenNamed(node, ["SubscriptMark"])) hideRange(m.from, m.to);
            return;
          case "HardBreak":
            if (!shown()) hideRange(ref.from, ref.to);
            return;
        }
        return;
      },
    });
  }
  return Decoration.set(ranges, true);
}

const livePreviewTheme = EditorView.baseTheme({
  "&.cm-livepreview .cm-content": {
    fontFamily: "var(--lp-font)",
    fontSize: "1.08em",
    maxWidth: "var(--lp-width)",
    margin: "0 auto",
    padding: "12px 24px 40vh 8px",
  },
  "&.cm-livepreview .cm-line": { padding: "1px 4px 1px 2px" },
  ".cm-lp-h": { fontWeight: "650", lineHeight: "1.25", paddingTop: "0.5em !important", paddingBottom: "0.2em !important" },
  ".cm-lp-h1": { fontSize: "1.9em" },
  ".cm-lp-h2": { fontSize: "1.55em", borderBottom: "1px solid var(--hr)", marginBottom: "0.2em" },
  ".cm-lp-h3": { fontSize: "1.3em" },
  ".cm-lp-h4": { fontSize: "1.15em" },
  ".cm-lp-h5": { fontSize: "1.05em" },
  ".cm-lp-h6": { fontSize: "1em", color: "var(--fg-muted)" },
  ".cm-lp-setextmark": { fontSize: "0.5em", lineHeight: "1", color: "var(--fg-muted)" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-strike": { textDecoration: "line-through", opacity: "0.75" },
  ".cm-lp-highlight": { backgroundColor: "var(--search-match)" },
  ".cm-lp-code": {
    fontFamily: "var(--editor-font)",
    fontSize: "0.92em",
    backgroundColor: "var(--code-bg)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    padding: "0 3px",
  },
  ".cm-lp-codeblock": {
    fontFamily: "var(--editor-font)",
    fontSize: "0.92em",
    backgroundColor: "var(--code-bg)",
    borderLeft: "3px solid var(--border)",
    borderRight: "1px solid var(--border)",
    paddingLeft: "10px !important",
  },
  ".cm-lp-fence": { color: "var(--fg-muted)" },
  ".cm-lp-fence-start": { borderTop: "1px solid var(--border)", borderTopLeftRadius: "4px" },
  ".cm-lp-fence-end": { borderBottom: "1px solid var(--border)", minHeight: "0.6em" },
  ".cm-lp-langbadge": {
    fontFamily: "var(--lp-font)",
    fontSize: "0.75em",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--fg-muted)",
    userSelect: "none",
  },
  ".cm-lp-quote": {
    borderLeft: "3px solid var(--quote-border)",
    paddingLeft: "12px !important",
    color: "var(--fg-muted)",
    fontStyle: "italic",
  },
  ".cm-lp-link": { color: "var(--link)", textDecoration: "underline", cursor: "pointer" },
  ".cm-lp-bullet": { color: "var(--accent)", display: "inline-block", width: "1ch", textAlign: "center", fontWeight: "bold" },
  ".cm-lp-checkbox": { verticalAlign: "-2px", margin: "0 2px 0 0", accentColor: "var(--accent)", cursor: "pointer" },
  ".cm-lp-task-done": { textDecoration: "line-through", opacity: "0.6" },
  ".cm-lp-hr": {
    display: "inline-block",
    width: "100%",
    borderTop: "2px solid var(--hr)",
    verticalAlign: "middle",
    height: "0",
  },
  ".cm-lp-hr-src": { color: "var(--fg-muted)" },
  ".cm-lp-table": { fontFamily: "var(--editor-font)", fontSize: "0.92em" },
  ".cm-lp-image": { display: "inline-block", maxWidth: "100%", verticalAlign: "top" },
  ".cm-lp-image img": { maxWidth: "100%", maxHeight: "60vh", borderRadius: "4px", display: "block" },
  ".cm-lp-image-missing": { color: "var(--fg-muted)", fontStyle: "italic" },
  ".cm-lp-html": { color: "var(--syn-meta)", fontFamily: "var(--editor-font)", fontSize: "0.92em" },
  ".cm-lp-sup": { verticalAlign: "super", fontSize: "0.75em" },
  ".cm-lp-sub": { verticalAlign: "sub", fontSize: "0.75em" },
});

/** Rebuild the decorations once a mouse selection has ended. */
const mouseSelectionDone = StateEffect.define<null>();

export function livePreview(cfg: LivePreviewConfig): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /**
       * True while the mouse button is held to place the cursor or select text. Revealing the
       * Markdown syntax of the touched line would move its text under the mouse, so the selection
       * would end at the wrong place; the layout is kept until the button is released.
       */
      mouseSelecting = false;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, cfg);
      }
      update(u: ViewUpdate) {
        const done = u.transactions.some((tr) => tr.effects.some((e) => e.is(mouseSelectionDone)));
        const structural = u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state);
        if (structural || done || (u.selectionSet && !this.mouseSelecting)) {
          this.decorations = buildDecorations(u.view, cfg);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          const target = (e.target as HTMLElement).closest(".cm-lp-link") as HTMLElement | null;
          if (target && (e.ctrlKey || e.metaKey)) {
            const href = target.dataset.href;
            if (href) {
              e.preventDefault();
              cfg.openLink(href);
              return true;
            }
          }
          if (e.button === 0 && !(e.target as HTMLElement).closest("input, .cm-lp-checkbox")) {
            this.mouseSelecting = true;
            const end = () => {
              window.removeEventListener("mouseup", end, true);
              window.removeEventListener("blur", end);
              this.mouseSelecting = false;
              // Let CodeMirror finish its own mouseup handling first.
              setTimeout(() => view.dispatch({ effects: mouseSelectionDone.of(null) }), 0);
            };
            window.addEventListener("mouseup", end, true);
            window.addEventListener("blur", end);
          }
          return false;
        },
      },
    }
  );
  return [plugin, livePreviewTheme, EditorView.editorAttributes.of({ class: "cm-livepreview" })];
}
