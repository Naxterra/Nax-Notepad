// Typed wrappers around the Rust commands.
import { invoke } from "@tauri-apps/api/core";

export type Eol = "LF" | "CRLF" | "CR";

export interface OpenResult {
  kind: "memory" | "paged";
  path: string;
  name: string;
  text: string | null;
  encoding: string;
  eol: Eol;
  size: number;
  lineCount: number | null;
  hadErrors: boolean;
  readOnly: boolean;
  /** "encoding" when a large file is read-only because its encoding cannot be written. */
  readOnlyReason: string | null;
  /** Modification time in milliseconds. */
  mtime: number;
  binary: boolean;
}

export interface SaveResult {
  size: number;
  mtime: number;
  name: string;
  path: string;
}

export interface Window {
  text: string;
  firstLine: number;
  count: number;
  totalLines: number;
  dirty: boolean;
  /** One line exceeded the window limit and only its start is shown. */
  truncated: boolean;
  /** The text contained bytes that are invalid in the file's encoding. */
  lossy: boolean;
}

export interface DiskCheck {
  changed: boolean;
  mtime: number;
}

/** Error prefixes sent by the backend. */
export const E_UNREPRESENTABLE = "E_UNREPRESENTABLE:";
export const E_EXTERNAL_CHANGE = "E_EXTERNAL_CHANGE:";
export const E_READ_ONLY_ENCODING = "E_READ_ONLY_ENCODING:";
export const E_SEARCH_ENCODING = "E_SEARCH_ENCODING:";
export const E_NO_SCOPE = "E_NO_SCOPE:";

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface FindOpts {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface PagedMatch {
  line: number;
  col: number;
  len: number;
  offset: number;
}

export interface FileHit {
  path: string;
  line: number;
  col: number;
  text: string;
}

export interface TabMeta {
  id: string;
  path: string | null;
  kind: string;
  [k: string]: unknown;
}

export interface SessionData {
  tabs: TabMeta[];
  active: string | null;
  next_untitled: number;
}

export const backend = {
  openPath: (id: string, path: string, forcePaged = false) =>
    invoke<OpenResult>("open_path", { id, path, forcePaged }),
  saveText: (path: string, text: string, encoding: string, eol: Eol, lossy = false) =>
    invoke<SaveResult>("save_text", { path, text, encoding, eol, lossy }),
  fileMtime: (path: string) => invoke<number>("file_mtime", { path }),
  encodings: () => invoke<string[]>("encodings"),

  pagedWindow: (id: string, firstLine: number, count: number) =>
    invoke<Window>("paged_window", { id, firstLine, count }),
  pagedCommit: (id: string, firstLine: number, count: number, text: string) =>
    invoke<number>("paged_commit", { id, firstLine, count, text }),
  pagedSave: (id: string, path?: string, overwriteExternal = false) =>
    invoke<SaveResult>("paged_save", { id, path: path ?? null, overwriteExternal }),
  pagedClose: (id: string) => invoke<void>("paged_close", { id }),
  pagedSetEol: (id: string, eol: Eol) => invoke<void>("paged_set_eol", { id, eol }),
  pagedFind: (id: string, opts: FindOpts, fromLine: number, fromCol: number, backwards: boolean, scoped = false) =>
    invoke<PagedMatch | null>("paged_find", { id, opts, fromLine, fromCol, backwards, scoped }),
  pagedCount: (id: string, opts: FindOpts, scoped = false) => invoke<number>("paged_count", { id, opts, scoped }),
  pagedReplaceAll: (id: string, opts: FindOpts, replacement: string, scoped = false) =>
    invoke<number>("paged_replace_all", { id, opts, replacement, scoped }),
  pagedSetScope: (id: string, startLine: number, startCol: number, endLine: number, endCol: number) =>
    invoke<boolean>("paged_set_scope", { id, startLine, startCol, endLine, endCol }),
  pagedClearScope: (id: string) => invoke<void>("paged_clear_scope", { id }),
  pagedDiskState: (id: string) => invoke<DiskCheck>("paged_disk_state", { id }),
  pagedStoreEdits: (id: string) => invoke<void>("paged_store_edits", { id }),
  pagedRestore: (id: string, path: string) => invoke<OpenResult>("paged_restore", { id, path }),

  sessionLoad: () => invoke<SessionData>("session_load"),
  sessionSave: (s: SessionData) => invoke<void>("session_save", { s }),
  sessionStoreBuffer: (id: string, text: string) => invoke<void>("session_store_buffer", { id, text }),
  sessionLoadBuffer: (id: string) => invoke<string | null>("session_load_buffer", { id }),
  sessionDropBuffer: (id: string) => invoke<void>("session_drop_buffer", { id }),
  settingsLoad: () => invoke<Record<string, unknown>>("settings_load"),
  settingsSave: (value: Record<string, unknown>) => invoke<void>("settings_save", { value }),
  startupFiles: () => invoke<string[]>("startup_files"),

  findInFiles: (root: string, opts: FindOpts, include: string, maxHits = 5000) =>
    invoke<FileHit[]>("find_in_files", { root, opts, include, maxHits }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  readBytes: async (path: string, offset: number, len: number) => new Uint8Array(await invoke<ArrayBuffer>("read_bytes", { path, offset, len })),
  fileSize: (path: string) => invoke<number>("file_size", { path }),
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),
};
