// Guess the indentation of a file from its content (tabs, or spaces and their width).

export interface IndentInfo {
  /** Indent with spaces (true) or tabs (false). */
  spaces: boolean;
  /** Indent width in columns; for tabs also the tab width. */
  size: number;
}

/**
 * Detect the indentation style from the first `maxLines` lines. Returns null when there is not
 * enough indented text to decide. For tab-indented files `size` is 0 (keep the configured width).
 */
export function detectIndent(text: string, maxLines = 2000): IndentInfo | null {
  let tabLines = 0;
  let spaceLines = 0;
  const deltas = new Map<number, number>();
  let prev = 0;
  let i = 0;
  for (let n = 0; i < text.length && n < maxLines; n++) {
    let j = text.indexOf("\n", i);
    if (j < 0) j = text.length;
    const line = text.slice(i, j).replace(/\r$/, "");
    i = j + 1;
    if (!line.trim()) continue;
    if (line[0] === "\t") {
      tabLines++;
      prev = 0;
      continue;
    }
    let w = 0;
    while (line[w] === " ") w++;
    // Skip block comment continuation lines (" * text"), they are offset by one space.
    if (w > 0 && line[w] === "*" && (line[w + 1] === " " || line[w + 1] === "/" || line.length === w + 1)) continue;
    if (w > 0) spaceLines++;
    const d = Math.abs(w - prev);
    if (d >= 2 && d <= 8) deltas.set(d, (deltas.get(d) ?? 0) + 1);
    prev = w;
  }
  if (tabLines + spaceLines < 3) return null;
  if (tabLines > spaceLines) return { spaces: false, size: 0 };
  let best = 0;
  let bestCount = 0;
  for (const [d, c] of deltas) {
    if (c > bestCount || (c === bestCount && d < best)) {
      best = d;
      bestCount = c;
    }
  }
  return best ? { spaces: true, size: best } : null;
}
