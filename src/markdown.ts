// Markdown formatting commands: wrap/unwrap inline marks, toggle line prefixes, insert blocks.
import { EditorSelection, SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openFenceLanguagePicker } from "./codefence";

function wordAt(view: EditorView, pos: number): SelectionRange {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  let a = pos - line.from;
  let b = a;
  const isWord = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return EditorSelection.range(line.from + a, line.from + b);
}

/** Toggle an inline mark such as `**` around each selection (or the word at the cursor). */
export function toggleInline(view: EditorView, open: string, close = open): boolean {
  const tr = view.state.changeByRange((range) => {
    let r = range;
    if (r.empty) r = wordAt(view, r.head);
    const text = view.state.sliceDoc(r.from, r.to);
    const before = view.state.sliceDoc(Math.max(0, r.from - open.length), r.from);
    const after = view.state.sliceDoc(r.to, r.to + close.length);
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      const inner = text.slice(open.length, text.length - close.length);
      return { changes: { from: r.from, to: r.to, insert: inner }, range: EditorSelection.range(r.from, r.from + inner.length) };
    }
    if (before === open && after === close) {
      return {
        changes: [
          { from: r.from - open.length, to: r.from, insert: "" },
          { from: r.to, to: r.to + close.length, insert: "" },
        ],
        range: EditorSelection.range(r.from - open.length, r.to - open.length),
      };
    }
    if (r.empty) {
      return { changes: { from: r.from, insert: open + close }, range: EditorSelection.cursor(r.from + open.length) };
    }
    return { changes: { from: r.from, to: r.to, insert: open + text + close }, range: EditorSelection.range(r.from + open.length, r.to + open.length) };
  });
  view.dispatch(tr, { userEvent: "input.format" });
  return true;
}

function selectedLines(view: EditorView): number[] {
  const set = new Set<number>();
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return [...set].sort((x, y) => x - y);
}

/** Set (or clear with level 0) the ATX heading level of every selected line. */
export function setHeading(view: EditorView, level: number): boolean {
  const changes = [];
  for (const n of selectedLines(view)) {
    const line = view.state.doc.line(n);
    const m = /^(#{1,6})\s+/.exec(line.text);
    const cur = m ? m[1].length : 0;
    const target = cur === level ? 0 : level;
    const stripped = m ? line.text.slice(m[0].length) : line.text;
    const insert = target ? "#".repeat(target) + " " + stripped : stripped;
    if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
  return true;
}

const LIST_RE = /^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s+)/;

export type LineKind = "bullet" | "numbered" | "task" | "quote";

/** Toggle a list marker or quote prefix on the selected lines. */
export function toggleLinePrefix(view: EditorView, kind: LineKind): boolean {
  const lines = selectedLines(view).map((n) => view.state.doc.line(n));
  const matcher: Record<LineKind, RegExp> = {
    bullet: /^(\s*)[-*+]\s+(?!\[[ xX]\]\s)/,
    task: /^(\s*)[-*+]\s+\[[ xX]\]\s+/,
    numbered: /^(\s*)\d+[.)]\s+/,
    quote: /^(\s*)>\s+/,
  };
  const allHave = lines.every((l) => matcher[kind].test(l.text) || l.text.trim() === "");
  const changes = [];
  let idx = 1;
  for (const line of lines) {
    const indentMatch = /^\s*/.exec(line.text);
    const indent = indentMatch ? indentMatch[0] : "";
    let body = line.text.replace(LIST_RE, "$1");
    body = body.slice(indent.length);
    let insert: string;
    if (allHave) insert = indent + body;
    else {
      const prefix = kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : kind === "quote" ? "> " : `${idx++}. `;
      insert = indent + prefix + body;
    }
    if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
  return true;
}

export function insertLink(view: EditorView, image = false): boolean {
  const tr = view.state.changeByRange((r) => {
    const text = view.state.sliceDoc(r.from, r.to);
    const isUrl = /^https?:\/\//i.test(text);
    const label = image ? "alt" : "text";
    const inner = isUrl ? label : text || label;
    const url = isUrl ? text : "url";
    const s = `${image ? "!" : ""}[${inner}](${url})`;
    const selStart = isUrl || !text ? r.from + (image ? 2 : 1) : r.from + (image ? 2 : 1) + inner.length + 2;
    const selLen = isUrl || !text ? inner.length : url.length;
    return { changes: { from: r.from, to: r.to, insert: s }, range: EditorSelection.range(selStart, selStart + selLen) };
  });
  view.dispatch(tr, { userEvent: "input.format" });
  return true;
}

export function insertCodeBlock(view: EditorView): boolean {
  const r = view.state.selection.main;
  const from = view.state.doc.lineAt(r.from).from;
  const to = view.state.doc.lineAt(r.to).to;
  const body = view.state.sliceDoc(from, to);
  const indent = /^\s*/.exec(body)?.[0] ?? "";
  const insert = indent + "```\n" + body + "\n" + indent + "```";
  view.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + indent.length + 3), userEvent: "input.format" });
  // Offer the language list right at the opening fence.
  openFenceLanguagePicker(view);
  return true;
}

export function insertHorizontalRule(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const insert = (line.text.length ? "\n\n" : "") + "---\n";
  view.dispatch({ changes: { from: line.to, insert }, selection: EditorSelection.cursor(line.to + insert.length), userEvent: "input.format" });
  return true;
}

export function insertTable(view: EditorView, cols = 3, rows = 2): boolean {
  const header = "| " + Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(" | ") + " |";
  const sep = "|" + Array.from({ length: cols }, () => " --- |").join("");
  const body = Array.from({ length: rows }, () => "|" + Array.from({ length: cols }, () => "   |").join("")).join("\n");
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const insert = (line.text.length ? "\n\n" : "") + [header, sep, body].join("\n") + "\n";
  view.dispatch({ changes: { from: line.to, insert }, selection: EditorSelection.cursor(line.to + insert.length), userEvent: "input.format" });
  return true;
}

/** Extra file extensions treated as Markdown besides those CodeMirror already knows. */
export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkdn", "mkd", "mdwn", "mdtxt", "mdtext", "text", "rmd", "qmd", "mdx"];
