// Clipboard actions for menus, the command palette and the editor context menu.
// Keyboard shortcuts (Ctrl+C/X/V) are left to the editor's native handling; these helpers go
// through the Tauri clipboard plugin because WebView2 refuses document.execCommand("paste").
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** The focused text input (find box, dialogs), if any. */
function activeField(): TextField | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && /^(text|search|url|email|number|)$/.test(el.type)) return el;
  return null;
}

function editField(field: TextField, insert: string): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(insert, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Copy (or cut) the selection. With empty selections the whole lines under the cursors are
 * used, matching the editor's own Ctrl+C behaviour.
 */
export async function copySelection(view: EditorView, cut = false): Promise<void> {
  const field = activeField();
  if (field) {
    const text = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
    if (!text) return;
    await writeText(text);
    if (cut && !field.readOnly) editField(field, "");
    return;
  }
  const state = view.state;
  const ranges = state.selection.ranges;
  let text: string;
  let toDelete: { from: number; to: number }[];
  if (ranges.some((r) => !r.empty)) {
    const parts = ranges.filter((r) => !r.empty);
    text = parts.map((r) => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
    toDelete = parts.map((r) => ({ from: r.from, to: r.to }));
  } else {
    const lines = [...new Set(ranges.map((r) => state.doc.lineAt(r.head).number))].map((n) => state.doc.line(n));
    text = lines.map((l) => l.text).join(state.lineBreak) + state.lineBreak;
    toDelete = lines.map((l) => ({ from: l.from, to: Math.min(l.to + 1, state.doc.length) }));
  }
  await writeText(text);
  if (cut && !state.readOnly) view.dispatch({ changes: toDelete, userEvent: "delete.cut", scrollIntoView: true });
  view.focus();
}

export async function pasteClipboard(view: EditorView): Promise<void> {
  let text: string;
  try {
    text = await readText();
  } catch {
    return; // empty clipboard or non-text content
  }
  if (!text) return;
  const field = activeField();
  if (field) {
    if (!field.readOnly) editField(field, field instanceof HTMLInputElement ? text.replace(/\r?\n/g, " ") : text);
    return;
  }
  if (view.state.readOnly) return;
  view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
  view.focus();
}

export function deleteSelection(view: EditorView): void {
  const field = activeField();
  if (field) {
    if (!field.readOnly) editField(field, "");
    return;
  }
  if (view.state.readOnly || view.state.selection.ranges.every((r) => r.empty)) return;
  view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.selection" });
  view.focus();
}

export function selectAllIn(view: EditorView): void {
  const field = activeField();
  if (field) {
    field.select();
    return;
  }
  view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) });
  view.focus();
}

/** Put text on the clipboard. */
export function writeClipboard(text: string): Promise<void> {
  return writeText(text);
}
