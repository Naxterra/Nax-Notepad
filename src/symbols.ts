// Function list: functions, classes and headings of the current document, taken from the
// syntax tree where the language has one and from simple patterns otherwise.
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export interface DocSymbol {
  name: string;
  /** 1-based line in the document (window) the symbol starts on. */
  line: number;
  /** Nesting level (0 = top level). */
  depth: number;
  kind: "function" | "class" | "type" | "heading";
}

const SYMBOL_NODE = /^(Function|Method|Class|Struct|Enum|Trait|Impl|Interface|TypeAlias|Module|Namespace|Object|Constructor)(Declaration|Definition|Item|Decl|Specifier|Statement)?$/;
const NAME_NODE = /^(VariableDefinition|VariableName|Definition|DefName|BoundIdentifier|TypeIdentifier|TypeDefinition|PropertyDefinition|PropertyName|Identifier|Name|FieldName|TypeName|FieldIdentifier|ScopedIdentifier|QualifiedName)$/;
const BODY_NODE = /(Body|Block|ParamList|ArgList|Parameters|ParameterList|DeclarationList|FieldDeclarationList)$/;

function kindOf(type: string): DocSymbol["kind"] {
  if (/^(Function|Method|Constructor)/.test(type)) return "function";
  if (/^(Class|Object|Module|Namespace|Impl)/.test(type)) return "class";
  return "type";
}

/** The name of a declaration: the first name-like node before its body. */
function nameOf(node: SyntaxNode, state: EditorState): string | null {
  const queue: { n: SyntaxNode; depth: number }[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) queue.push({ n: c, depth: 0 });
  while (queue.length) {
    const { n, depth } = queue.shift()!;
    if (BODY_NODE.test(n.type.name)) continue;
    if (NAME_NODE.test(n.type.name)) return state.sliceDoc(n.from, Math.min(n.to, n.from + 120));
    if (depth < 3) for (let c = n.firstChild; c; c = c.nextSibling) queue.push({ n: c, depth: depth + 1 });
  }
  return null;
}

const PATTERNS: { re: RegExp; kind: DocSymbol["kind"] }[] = [
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$.:]+)/, kind: "function" },
  { re: /^\s*(?:async\s+)?def\s+(\w+)/, kind: "function" },
  { re: /^\s*class\s+(\w+)/, kind: "class" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "function" },
  { re: /^\s*(?:function|filter)\s+([\w-]+)/i, kind: "function" },
  { re: /^\s*(?:sub|proc|procedure)\s+([\w.:]+)/i, kind: "function" },
  { re: /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure|view|table)\s+([\w."[\]]+)/i, kind: "function" },
  { re: /^\s*([\w-]+)\s*\(\)\s*\{/, kind: "function" },
  { re: /^\s*\[([^\]]+)\]\s*$/, kind: "type" },
];

function fromPatterns(state: EditorState, maxLines: number): DocSymbol[] {
  const out: DocSymbol[] = [];
  const n = Math.min(state.doc.lines, maxLines);
  for (let i = 1; i <= n; i++) {
    const text = state.doc.line(i).text;
    if (text.length > 500) continue;
    for (const p of PATTERNS) {
      const m = p.re.exec(text);
      if (m) {
        out.push({ name: m[1], line: i, depth: /^\s/.test(text) ? 1 : 0, kind: p.kind });
        break;
      }
    }
  }
  return out;
}

/** Symbols of the document, in document order. */
export function collectSymbols(state: EditorState, timeoutMs = 300): DocSymbol[] {
  const tree = ensureSyntaxTree(state, state.doc.length, timeoutMs) ?? syntaxTree(state);
  const out: DocSymbol[] = [];
  const stack: number[] = []; // end positions of enclosing symbols
  tree.iterate({
    enter: (ref) => {
      const type = ref.type.name;
      const heading = /^(ATXHeading|SetextHeading)(\d)$/.exec(type);
      if (heading) {
        const line = state.doc.lineAt(ref.from);
        const name = line.text.replace(/^\s*#+\s*/, "").replace(/\s*#+\s*$/, "").trim() || "…";
        out.push({ name, line: line.number, depth: Number(heading[2]) - 1, kind: "heading" });
        return false;
      }
      if (!SYMBOL_NODE.test(type)) return;
      while (stack.length && stack[stack.length - 1] <= ref.from) stack.pop();
      const name = nameOf(ref.node, state);
      if (name) {
        out.push({ name, line: state.doc.lineAt(ref.from).number, depth: stack.length, kind: kindOf(type) });
        stack.push(ref.to);
      }
    },
  });
  return out.length ? out : fromPatterns(state, 20000);
}
