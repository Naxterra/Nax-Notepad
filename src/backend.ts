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
  saveText: (path: string, text: string, encoding: string, eol: Eol) =>
    invoke<SaveResult>("save_text", { path, text, encoding, eol }),
  fileMtime: (path: string) => invoke<number>("file_mtime", { path }),
  encodings: () => invoke<string[]>("encodings"),

  pagedWindow: (id: string, firstLine: number, count: number) =>
    invoke<Window>("paged_window", { id, firstLine, count }),
  pagedCommit: (id: string, firstLine: number, count: number, text: string) =>
    invoke<number>("paged_commit", { id, firstLine, count, text }),
  pagedSave: (id: string, path?: string) => invoke<SaveResult>("paged_save", { id, path: path ?? null }),
  pagedClose: (id: string) => invoke<void>("paged_close", { id }),
  pagedSetEol: (id: string, eol: Eol) => invoke<void>("paged_set_eol", { id, eol }),
  pagedFind: (id: string, opts: FindOpts, fromLine: number, fromCol: number, backwards: boolean) =>
    invoke<PagedMatch | null>("paged_find", { id, opts, fromLine, fromCol, backwards }),
  pagedCount: (id: string, opts: FindOpts) => invoke<number>("paged_count", { id, opts }),
  pagedReplaceAll: (id: string, opts: FindOpts, replacement: string) =>
    invoke<number>("paged_replace_all", { id, opts, replacement }),
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
