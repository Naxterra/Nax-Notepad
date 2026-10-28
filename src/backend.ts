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

export interface FinishedSaves {
  /** Files that got the content that was being saved. */
  finished: string[];
  /** Saves that could not be finished safely; the file was left alone and `kept` lists the copies. */
  failed: { target: string; kept: string[] }[];
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
export const E_HARD_LINKS = "E_HARD_LINKS:";
export const E_SEARCH_ENCODING = "E_SEARCH_ENCODING:";
export const E_NO_SCOPE = "E_NO_SCOPE:";
export const E_CANCELLED = "E_CANCELLED:";

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

export interface FoundLine {
  line: number;
  col: number;
  len: number;
  text: string;
}

export interface SkippedFile {
  path: string;
  /** "binary", "encoding" or "unreadable" */
  reason: string;
}

export interface FindInFilesResult {
  hits: FileHit[];
  skipped: SkippedFile[];
  skippedCount: number;
  filesSearched: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface DirEntryInfo {
  name: string;
  path: string;
  isDir: boolean;
}

export interface TailStart {
  size: number;
  headHash: number;
  headLen: number;
}

export interface TailCheck {
  status: "same" | "appended" | "rotated" | "missing";
  text: string;
  offset: number;
  mtime: number;
}

export interface PagedTailCheck {
  status: "same" | "appended" | "rotated" | "missing" | "dirty";
  totalLines: number;
  size?: number;
  mtime?: number;
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
  openPath: (id: string, path: string, forcePaged = false, encoding: string | null = null) =>
    invoke<OpenResult>("open_path", { id, path, forcePaged, encoding }),
  /** `expectedMtime`: the time the file had when it was read; the save fails with E_EXTERNAL_CHANGE if it differs. */
  saveText: (path: string, text: string, encoding: string, eol: Eol, lossy = false, expectedMtime: number | null = null) =>
    invoke<SaveResult>("save_text", { path, text, encoding, eol, lossy, expectedMtime }),
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
  /** Stores whose `generation` is not above the last dropped one are ignored (late writes after a save). */
  sessionStoreBuffer: (id: string, text: string, generation: number) => invoke<void>("session_store_buffer", { id, text, generation }),
  sessionLoadBuffer: (id: string) => invoke<string | null>("session_load_buffer", { id }),
  /** True when unsaved text or a large-file edit log is stored for the tab. */
  sessionHasRecovery: (id: string) => invoke<boolean>("session_has_recovery", { id }),
  sessionDropBuffer: (id: string, generation: number) => invoke<void>("session_drop_buffer", { id, generation }),
  /** A new, higher number for every page load (see `bufferGeneration` in app.ts). */
  sessionBufferEpoch: () => invoke<number>("session_buffer_epoch"),
  settingsLoad: () => invoke<Record<string, unknown>>("settings_load"),
  settingsSave: (value: Record<string, unknown>) => invoke<void>("settings_save", { value }),
  startupFiles: () => invoke<string[]>("startup_files"),
  /**
   * Interrupted saves of hard-linked files that were dealt with when the app started. Waits
   * until that is done, so ask before restoring tabs.
   */
  finishedSaves: () => invoke<FinishedSaves>("finished_saves"),

  findInFiles: (root: string, opts: FindOpts, include: string, maxHits = 5000) =>
    invoke<FindInFilesResult>("find_in_files", { root, opts, include, maxHits }),
  cancelSearch: () => invoke<void>("cancel_search"),
  pagedFindAll: (id: string, opts: FindOpts, scoped = false, max = 10000) =>
    invoke<{ hits: FoundLine[]; truncated: boolean }>("paged_find_all", { id, opts, scoped, max }),
  pagedTailCheck: (id: string) => invoke<PagedTailCheck>("paged_tail_check", { id }),
  tailStart: (path: string) => invoke<TailStart>("tail_start", { path }),
  tailCheck: (path: string, offset: number, headHash: number, headLen: number, encoding: string) =>
    invoke<TailCheck>("tail_check", { path, offset, headHashValue: headHash, headLen, encoding }),
  listDir: (path: string) => invoke<DirEntryInfo[]>("list_dir", { path }),
  readTextFile: (path: string, maxBytes?: number) => invoke<string>("read_text_file", { path, maxBytes: maxBytes ?? null }),
  writeTextFile: (path: string, text: string) => invoke<void>("write_text_file", { path, text }),
  appDataDir: () => invoke<string>("app_data_dir"),
  nppConfigDir: () => invoke<string | null>("npp_config_dir"),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  readBytes: async (path: string, offset: number, len: number) => new Uint8Array(await invoke<ArrayBuffer>("read_bytes", { path, offset, len })),
  fileSize: (path: string) => invoke<number>("file_size", { path }),
  /** Replace a file with `bytes` (atomic). Fails with E_EXTERNAL_CHANGE if its time differs. */
  writeBytes: (path: string, bytes: Uint8Array, expectedMtime: number) =>
    invoke<SaveResult>("write_bytes", bytes, { headers: { "x-path": encodeURIComponent(path), "x-mtime": String(expectedMtime) } }),
  /** Offset of a byte pattern in a file (searches the file on disk). */
  findBytes: (path: string, pattern: Uint8Array, from: number, backwards: boolean) =>
    invoke<number | null>("find_bytes", { path, pattern: Array.from(pattern), from, backwards }),
  /** Change single bytes of a (large) file through an atomic copy. */
  patchFile: (path: string, patches: [number, number][], expectedLen: number, expectedMtime: number) =>
    invoke<SaveResult>("patch_file", { path, patches, expectedLen, expectedMtime }),
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),
};
