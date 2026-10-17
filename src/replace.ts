// Replacement text for search matches. Matches are found by CodeMirror's search cursor; the
// replacement is computed by re-running the regex at the match position on the full text, so
// lookbehind/lookahead and anchors see the real surrounding context and capture groups are
// filled correctly. Syntax is JavaScript's: $& $1..$99 $<name> $` $' $$.
// The large-file engine (Rust) accepts the same syntax except $` and $'.
import { SearchQuery } from "@codemirror/search";

/** A sticky copy of the query's regex, positioned with lastIndex. Null when not a regex query. */
export function stickyRegex(q: SearchQuery): RegExp | null {
  if (!q.regexp) return null;
  const flags = "m" + (q.caseSensitive ? "" : "i") + "y";
  try {
    return new RegExp(q.search, flags + "u");
  } catch {
    try {
      return new RegExp(q.search, flags);
    } catch {
      return null;
    }
  }
}

/** Expand a JavaScript-style replacement template for one match. */
export function expandReplacement(template: string, m: RegExpExecArray, input: string): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c !== "$" || i + 1 >= template.length) {
      out += c;
      continue;
    }
    const n = template[i + 1];
    if (n === "$") {
      out += "$";
      i++;
    } else if (n === "&") {
      out += m[0];
      i++;
    } else if (n === "`") {
      out += input.slice(0, m.index);
      i++;
    } else if (n === "'") {
      out += input.slice(m.index + m[0].length);
      i++;
    } else if (n >= "0" && n <= "9") {
      const two = template.slice(i + 1, i + 3);
      if (/^\d\d$/.test(two) && +two >= 1 && +two < m.length) {
        out += m[+two] ?? "";
        i += 2;
      } else if (+n >= 1 && +n < m.length) {
        out += m[+n] ?? "";
        i += 1;
      } else {
        out += c;
      }
    } else if (n === "<" && m.groups) {
      const end = template.indexOf(">", i + 2);
      if (end > 0) {
        out += m.groups[template.slice(i + 2, end)] ?? "";
        i = end;
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Replacement for the match [from, to) of `q` in `text` (the full document, or the visible
 * window of a large file). Literal searches return the replacement unchanged.
 */
export function replacementAt(q: SearchQuery, text: string, from: number, to: number, re: RegExp | null = stickyRegex(q)): string {
  if (!q.regexp || !re) return q.replace;
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m || m.index !== from || m[0].length !== to - from) return q.replace;
  return expandReplacement(q.replace, m, text);
}
