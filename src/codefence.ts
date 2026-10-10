// Language helper for Markdown code fences: typing ``` (or ~~~) on an opening fence line pops
// up a filterable list of languages. Picking one fills in the info string, adds the closing
// fence if it is missing and moves the cursor into the block.
import { autocompletion, Completion, CompletionContext, CompletionResult, startCompletion } from "@codemirror/autocomplete";
import { language, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Short forms people type that CodeMirror's language data does not know. */
const EXTRA_ALIASES: Record<string, string> = {
  py: "python",
  ps1: "powershell",
  pwsh: "powershell",
  md: "markdown",
  rb: "ruby",
  kt: "kotlin",
  console: "shell",
  "shell-session": "shell",
  docker: "dockerfile",
  conf: "properties",
  cfg: "properties",
};

/** Info strings offered without highlighting support (still useful for other renderers). */
const PLAIN_LABELS: Record<string, string> = {
  text: "Plain text",
  plaintext: "Plain text",
  abap: "ABAP",
  bat: "Batch",
  cmd: "Batch",
  mermaid: "Mermaid diagram",
};

/** Shown first when nothing is typed yet. */
const COMMON = [
  "bash",
  "powershell",
  "sql",
  "python",
  "json",
  "yaml",
  "xml",
  "javascript",
  "typescript",
  "html",
  "css",
  "lua",
  "ini",
  "toml",
  "diff",
  "c",
  "cpp",
  "csharp",
  "java",
  "go",
  "rust",
  "dockerfile",
  "markdown",
  "text",
];

/** Resolve a fence info string to a language for highlighting inside the block. */
export function codeLanguageFor(info: string): LanguageDescription | null {
  const key = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!key) return null;
  return LanguageDescription.matchLanguageName(languages, EXTRA_ALIASES[key] ?? key, true);
}

let options: Completion[] | null = null;
function allOptions(): Completion[] {
  if (options) return options;
  const seen = new Set<string>();
  const out: Completion[] = [];
  const add = (label: string, detail: string) => {
    if (seen.has(label) || !/^[\w+#.-]+$/.test(label)) return;
    seen.add(label);
    const i = COMMON.indexOf(label);
    out.push({ label, detail, boost: i >= 0 ? 99 - i : 0 });
  };
  for (const d of languages) {
    for (const a of d.alias) add(a, d.name);
    add(d.name.toLowerCase(), d.name);
  }
  for (const [alias, target] of Object.entries(EXTRA_ALIASES)) {
    const d = LanguageDescription.matchLanguageName(languages, target, false);
    if (d) add(alias, d.name);
  }
  for (const [label, detail] of Object.entries(PLAIN_LABELS)) add(label, detail);
  options = out;
  return out;
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;

/**
 * Is line `n` an opening fence? Walks the fences above it: an odd count means we are inside a
 * block, so this line closes it and takes no language.
 */
function isOpeningFence(state: EditorState, n: number): boolean {
  let open: string | null = null;
  for (let i = 1; i < n; i++) {
    const m = FENCE.exec(state.doc.line(i).text);
    if (!m) continue;
    const fence = m[2];
    if (open === null) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length && /^\s*$/.test(state.doc.line(i).text.slice(m[0].length))) open = null;
  }
  return open === null;
}

function closingFenceAfter(state: EditorState, n: number, fence: string): boolean {
  for (let i = n + 1; i <= state.doc.lines; i++) {
    const m = FENCE.exec(state.doc.line(i).text);
    if (m && m[2][0] === fence[0] && m[2].length >= fence.length && /^\s*$/.test(state.doc.line(i).text.slice(m[0].length))) return true;
  }
  return false;
}

function applyLanguage(label: string) {
  return (view: EditorView, _c: Completion, from: number, _to: number) => {
    const state = view.state;
    const line = state.doc.lineAt(from);
    const m = FENCE.exec(line.text)!;
    const indent = m[1];
    const fence = m[2];
    const changes = [{ from, to: line.to, insert: label }];
    let cursor: number;
    if (!closingFenceAfter(state, line.number, fence)) {
      // No closing fence yet: add one with an empty line for the code.
      changes[0].insert = label + "\n" + indent + "\n" + indent + fence;
      cursor = from + label.length + 1 + indent.length;
    } else {
      const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
      const nextIsClose = next && FENCE.test(next.text) && /^\s*(`{3,}|~{3,})\s*$/.test(next.text);
      if (nextIsClose) {
        // Empty block: open a line for the code.
        changes[0].insert = label + "\n" + indent;
        cursor = from + label.length + 1 + indent.length;
      } else {
        // Existing body: put the cursor at the start of the first code line.
        cursor = from + label.length + 1;
      }
    }
    view.dispatch({ changes, selection: { anchor: cursor }, scrollIntoView: true, userEvent: "input.complete" });
  };
}

function fenceLanguageSource(context: CompletionContext): CompletionResult | null {
  // Only in Markdown or plain-text documents.
  const lang = context.state.facet(language);
  if (lang && lang.name !== "markdown") return null;
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = /^(\s*)(`{3,}|~{3,})([\w+#.-]*)$/.exec(before);
  if (!m) return null;
  // Text after the cursor (other than whitespace) means the user is editing something else.
  if (!/^\s*$/.test(line.text.slice(context.pos - line.from))) return null;
  if (!isOpeningFence(context.state, line.number)) return null;
  const from = context.pos - m[3].length;
  return {
    from,
    options: allOptions().map((o) => ({ ...o, apply: applyLanguage(o.label) })),
    validFor: /^[\w+#.-]*$/,
  };
}

export const fenceLanguageCompletion: Extension = [
  autocompletion({ override: [fenceLanguageSource], icons: false, activateOnTyping: true, maxRenderedOptions: 60 }),
  EditorView.theme({
    ".cm-tooltip-autocomplete": { fontFamily: "var(--editor-font)" },
    ".cm-completionDetail": { color: "var(--fg-muted)", fontStyle: "normal", marginLeft: "1.5em" },
    ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)", fontWeight: "bold" },
  }),
];

/** Open the language list at the cursor (used after inserting a code block). */
export function openFenceLanguagePicker(view: EditorView): void {
  startCompletion(view);
}
