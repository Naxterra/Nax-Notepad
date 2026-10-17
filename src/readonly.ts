// Read-only policy shared by every editor state.
import { Annotation, EditorState } from "@codemirror/state";

/**
 * Marks a transaction as a system change (loading a page of a large file, reloading from disk)
 * rather than a user edit: it does not make the tab dirty and it is allowed in read-only mode.
 */
export const systemChange = Annotation.define<boolean>();

/**
 * Central read-only policy. CodeMirror's readOnly facet only blocks typing; this filter also
 * drops programmatic edits (menu commands, widgets, completions, paste, replace) while the
 * document is read-only.
 */
export const readOnlyGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.startState.readOnly || tr.annotation(systemChange)) return tr;
  return [];
});
