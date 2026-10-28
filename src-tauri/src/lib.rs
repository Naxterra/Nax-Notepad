mod paged;
mod session;
mod textfmt;

use paged::{DiskState, Match, PagedDoc, Piece};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, Manager, State};

/// Bumped by `cancel_search`; long searches stop when it changes while they run.
static SEARCH_GEN: AtomicU64 = AtomicU64::new(0);

fn cancel_token() -> impl Fn() -> bool {
    let gen = SEARCH_GEN.load(Ordering::SeqCst);
    move || SEARCH_GEN.load(Ordering::SeqCst) != gen
}

/// Stop the running Find in Files, Count, Find All or Replace All.
#[tauri::command]
fn cancel_search() {
    SEARCH_GEN.fetch_add(1, Ordering::SeqCst);
}
use textfmt::Eol;

/// Files larger than this are opened in paged (memory-mapped) mode.
const PAGED_THRESHOLD: u64 = 48 * 1024 * 1024;

#[derive(Default)]
pub struct AppState {
    /// Open large documents. The map lock is held only to look a document up; each document has
    /// its own lock, so a long save or search in one file does not block the others.
    paged: Mutex<HashMap<String, Arc<Mutex<PagedDoc>>>>,
    startup_files: Mutex<Vec<String>>,
    /// Files whose interrupted save was dealt with at this start (shown to the user once).
    recovery: Arc<Recovery>,
}

#[derive(Serialize, Default)]
struct FinishedSaves {
    /// The file got the content that was being saved.
    finished: Vec<String>,
    /// The save could not be finished safely; the file was left as it is.
    failed: Vec<FailedSave>,
}

#[derive(Serialize)]
struct FailedSave {
    target: String,
    /// Copies of the content that was being saved and of the previous content.
    kept: Vec<String>,
}

/// The result of the recovery of interrupted saves, which runs on its own thread at start.
#[derive(Default)]
struct Recovery {
    /// (finished, report)
    state: std::sync::Mutex<(bool, FinishedSaves)>,
    done: std::sync::Condvar,
}

fn doc_handle(state: &AppState, id: &str) -> Result<Arc<Mutex<PagedDoc>>, String> {
    state.paged.lock().get(id).cloned().ok_or_else(|| "document not open".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResult {
    kind: String, // "memory" | "paged"
    path: String,
    name: String,
    text: Option<String>,
    encoding: String,
    eol: Eol,
    size: u64,
    line_count: Option<usize>,
    had_errors: bool,
    read_only: bool,
    /// Why the document is read-only beyond the file attribute ("encoding" for large files in
    /// encodings the paged editor cannot write).
    read_only_reason: Option<String>,
    /// Modification time in milliseconds.
    mtime: u64,
    /// True when the first 8 KB contain NUL bytes (opened in hex view by default).
    binary: bool,
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| p.display().to_string())
}

fn mtime_of(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
async fn open_path(
    state: State<'_, AppState>,
    id: String,
    path: String,
    force_paged: Option<bool>,
    encoding: Option<String>,
) -> Result<OpenResult, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("Cannot open {}: {e}", p.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory", p.display()));
    }
    let read_only = meta.permissions().readonly();
    let size = meta.len();
    let binary = {
        use std::io::Read;
        let mut probe = vec![0u8; 8192];
        let n = std::fs::File::open(&p).and_then(|mut f| f.read(&mut probe)).unwrap_or(0);
        let (bom, _) = textfmt::detect_bom(&probe[..n]);
        bom == textfmt::Bom::None && probe[..n].contains(&0)
    };
    if size >= PAGED_THRESHOLD || force_paged.unwrap_or(false) {
        let doc = PagedDoc::open_with(&p, encoding.as_deref())?;
        let editable = doc.is_editable();
        let res = OpenResult {
            kind: "paged".into(),
            path: p.display().to_string(),
            name: file_name(&p),
            text: None,
            encoding: doc.encoding_label().to_string(),
            eol: doc.eol,
            size,
            line_count: Some(doc.line_count()),
            had_errors: false,
            read_only: read_only || !editable,
            read_only_reason: if editable { None } else { Some("encoding".into()) },
            mtime: doc.file_mtime_ms(),
            binary,
        };
        state.paged.lock().insert(id, Arc::new(Mutex::new(doc)));
        return Ok(res);
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("Cannot read {}: {e}", p.display()))?;
    let dec = match encoding.as_deref() {
        Some(label) => textfmt::decode_as(&bytes, label)?,
        None => textfmt::decode(&bytes),
    };
    Ok(OpenResult {
        kind: "memory".into(),
        path: p.display().to_string(),
        name: file_name(&p),
        text: Some(dec.text),
        encoding: dec.encoding,
        eol: dec.eol,
        size,
        line_count: None,
        had_errors: dec.had_errors,
        read_only,
        read_only_reason: None,
        mtime: mtime_of(&p),
        binary,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    size: u64,
    mtime: u64,
    name: String,
    path: String,
}

#[tauri::command]
async fn save_text(
    path: String,
    text: String,
    encoding: String,
    eol: Eol,
    lossy: Option<bool>,
    expected_mtime: Option<u64>,
) -> Result<SaveResult, String> {
    let p = PathBuf::from(&path);
    // Refuses characters the encoding cannot represent unless the user confirmed a lossy save.
    let bytes = textfmt::encode_with(&text, &encoding, eol, lossy.unwrap_or(false)).map_err(|e| e.to_message())?;
    if let Some(dir) = p.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create folder: {e}"))?;
        }
    }
    // The modification time the editor knows; a different one means another program wrote the
    // file after it was opened or saved. Checked under the save lock, so two saves cannot both
    // pass it.
    let unchanged = || if p.exists() { ensure_unchanged(&p, expected_mtime, None) } else { Ok(()) };
    session::replace_atomic_checked(&p, unchanged, |f| std::io::Write::write_all(f, &bytes))?;
    Ok(SaveResult {
        size: bytes.len() as u64,
        mtime: mtime_of(&p),
        name: file_name(&p),
        path: p.display().to_string(),
    })
}

#[tauri::command]
fn file_mtime(path: String) -> u64 {
    mtime_of(Path::new(&path))
}

#[tauri::command]
fn encodings() -> Vec<&'static str> {
    textfmt::ENCODINGS.to_vec()
}

// ---- paged documents ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    text: String,
    first_line: usize,
    count: usize,
    total_lines: usize,
    dirty: bool,
    /// One line was longer than the window limit and only its start is included.
    truncated: bool,
    /// The text contained bytes invalid in the document's encoding.
    lossy: bool,
}

#[tauri::command]
async fn paged_window(
    state: State<'_, AppState>,
    id: String,
    first_line: usize,
    count: usize,
) -> Result<Window, String> {
    let handle = doc_handle(&state, &id)?;
    let doc = handle.lock();
    let w = doc.read_window(first_line, count, paged::MAX_WINDOW_BYTES);
    Ok(Window {
        text: w.text,
        first_line: w.first,
        count: w.count,
        total_lines: doc.line_count(),
        dirty: doc.is_dirty(),
        truncated: w.truncated,
        lossy: w.lossy,
    })
}

#[tauri::command]
async fn paged_commit(
    state: State<'_, AppState>,
    id: String,
    first_line: usize,
    count: usize,
    text: String,
) -> Result<usize, String> {
    let handle = doc_handle(&state, &id)?;
    let mut doc = handle.lock();
    doc.replace_lines(first_line, count, &text)
}

#[tauri::command]
async fn paged_save(
    state: State<'_, AppState>,
    id: String,
    path: Option<String>,
    overwrite_external: Option<bool>,
) -> Result<SaveResult, String> {
    let handle = doc_handle(&state, &id)?;
    let mut doc = handle.lock();
    let target = path.map(PathBuf::from).unwrap_or_else(|| doc.path.clone());
    doc.save_to_opts(&target, overwrite_external.unwrap_or(false))?;
    Ok(SaveResult {
        size: doc.file_len(),
        mtime: doc.file_mtime_ms(),
        name: file_name(&target),
        path: target.display().to_string(),
    })
}

#[tauri::command]
fn paged_close(state: State<'_, AppState>, id: String) {
    state.paged.lock().remove(&id);
}

#[tauri::command]
fn paged_set_eol(state: State<'_, AppState>, id: String, eol: Eol) -> Result<(), String> {
    let handle = doc_handle(&state, &id)?;
    let mut doc = handle.lock();
    if !doc.is_editable() {
        return Err(format!("{}{}", paged::E_READ_ONLY_ENCODING, doc.encoding_label()));
    }
    // Takes effect on save: the whole document is converted to this line ending.
    doc.eol = eol;
    Ok(())
}

#[derive(Serialize)]
struct DiskCheck {
    changed: bool,
    mtime: u64,
}

/// Whether the backing file of a paged document changed on disk since it was opened or saved.
#[tauri::command]
async fn paged_disk_state(state: State<'_, AppState>, id: String) -> Result<DiskCheck, String> {
    let handle = doc_handle(&state, &id)?;
    let doc = handle.lock();
    let now = DiskState::read(&doc.path).ok();
    Ok(DiskCheck {
        changed: now.map_or(true, |n| n != doc.disk_state()),
        mtime: now.map_or(0, |n| n.mtime_ms()),
    })
}

/// Set the "in selection only" range of a paged document from window coordinates
/// (absolute line, byte column). Returns false when the range is empty.
#[tauri::command]
async fn paged_set_scope(
    state: State<'_, AppState>,
    id: String,
    start_line: usize,
    start_col: usize,
    end_line: usize,
    end_col: usize,
) -> Result<bool, String> {
    let handle = doc_handle(&state, &id)?;
    let mut doc = handle.lock();
    let a = doc.line_start(start_line) + start_col;
    let b = doc.line_start(end_line) + end_col;
    Ok(doc.set_scope(a, b))
}

#[tauri::command]
async fn paged_clear_scope(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Ok(handle) = doc_handle(&state, &id) {
        handle.lock().clear_scope();
    }
    Ok(())
}

/// Translate JavaScript replacement syntax ($&, $1..$99, $<name>, $$) into the regex crate's
/// expansion syntax, so small and large files accept the same replacement strings.
fn js_to_rust_replacement(s: &str, groups: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '$' {
            out.push(c);
            i += 1;
            continue;
        }
        let Some(&n) = chars.get(i + 1) else {
            out.push_str("$$");
            i += 1;
            continue;
        };
        if n == '$' {
            out.push_str("$$");
            i += 2;
        } else if n == '&' {
            out.push_str("${0}");
            i += 2;
        } else if n.is_ascii_digit() {
            let two: Option<usize> = chars
                .get(i + 1..i + 3)
                .filter(|d| d.iter().all(|c| c.is_ascii_digit()))
                .map(|d| d.iter().collect::<String>().parse().unwrap());
            let one = n.to_digit(10).unwrap() as usize;
            if let Some(t) = two.filter(|&t| t >= 1 && t < groups) {
                out.push_str(&format!("${{{t}}}"));
                i += 3;
            } else if one >= 1 && one < groups {
                out.push_str(&format!("${{{one}}}"));
                i += 2;
            } else {
                out.push_str("$$");
                i += 1;
            }
        } else if n == '<' {
            match chars[i + 2..].iter().position(|&c| c == '>') {
                Some(end) => {
                    let name: String = chars[i + 2..i + 2 + end].iter().collect();
                    out.push_str(&format!("${{{name}}}"));
                    i += 3 + end;
                }
                None => {
                    out.push_str("$$");
                    i += 1;
                }
            }
        } else {
            out.push_str("$$");
            i += 1;
        }
    }
    out
}

fn ensure_searchable(doc: &PagedDoc) -> Result<(), String> {
    if doc.is_editable() {
        Ok(())
    } else {
        Err(format!("E_SEARCH_ENCODING:{}", doc.encoding_label()))
    }
}

fn build_regex(pattern: &str, regex: bool, case_sensitive: bool, whole_word: bool) -> Result<regex::bytes::Regex, String> {
    let mut pat = if regex {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    if whole_word {
        pat = format!(r"\b(?:{pat})\b");
    }
    regex::bytes::RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .multi_line(true)
        .build()
        .map_err(|e| format!("Invalid pattern: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindOpts {
    pattern: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
}

#[tauri::command]
async fn paged_find(
    state: State<'_, AppState>,
    id: String,
    opts: FindOpts,
    from_line: usize,
    from_col: usize,
    backwards: bool,
    scoped: Option<bool>,
) -> Result<Option<Match>, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let handle = doc_handle(&state, &id)?;
    let doc = handle.lock();
    ensure_searchable(&doc)?;
    let from = doc.line_start(from_line).saturating_add(from_col);
    doc.find_in_c(&re, from, backwards, scoped.unwrap_or(false), &cancel_token())
}

#[tauri::command]
async fn paged_count(state: State<'_, AppState>, id: String, opts: FindOpts, scoped: Option<bool>) -> Result<usize, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let handle = doc_handle(&state, &id)?;
    let doc = handle.lock();
    ensure_searchable(&doc)?;
    doc.count_in_c(&re, 1_000_000, scoped.unwrap_or(false), &cancel_token())
}

#[derive(Serialize)]
struct FindAllResult {
    hits: Vec<paged::FoundLine>,
    truncated: bool,
}

/// Every match in a large file (for "find all in open tabs" and line filters).
#[tauri::command]
async fn paged_find_all(
    state: State<'_, AppState>,
    id: String,
    opts: FindOpts,
    scoped: Option<bool>,
    max: Option<usize>,
) -> Result<FindAllResult, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let handle = doc_handle(&state, &id)?;
    let doc = handle.lock();
    ensure_searchable(&doc)?;
    let (hits, truncated) = doc.find_all_c(&re, scoped.unwrap_or(false), max.unwrap_or(10_000), &cancel_token())?;
    Ok(FindAllResult { hits, truncated })
}

/// Pick up data appended to a large file by another program (follow / tail mode).
#[tauri::command]
async fn paged_tail_check(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let handle = doc_handle(&state, &id)?;
    let mut doc = handle.lock();
    if doc.is_dirty() {
        return Ok(serde_json::json!({ "status": "dirty", "totalLines": doc.line_count() }));
    }
    let status = doc.refresh_append()?;
    Ok(serde_json::json!({
        "status": status,
        "totalLines": doc.line_count(),
        "size": doc.file_len(),
        "mtime": doc.file_mtime_ms(),
    }))
}

#[tauri::command]
async fn paged_replace_all(
    state: State<'_, AppState>,
    id: String,
    opts: FindOpts,
    replacement: String,
    scoped: Option<bool>,
) -> Result<usize, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let rep = if opts.regex {
        js_to_rust_replacement(&replacement, re.captures_len())
    } else {
        replacement.replace('$', "$$")
    };
    let handle = doc_handle(&state, &id)?;
    let mut doc = handle.lock();
    doc.replace_all_in_c(&re, rep.as_bytes(), scoped.unwrap_or(false), &cancel_token())
}

#[tauri::command]
async fn paged_store_edits(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let handle = doc_handle(&state, &id)?;
    let doc = handle.lock();
    let (pieces_path, add_path) = session::edits_paths(&id);
    if !doc.is_dirty() {
        let _ = std::fs::remove_file(&pieces_path);
        let _ = std::fs::remove_file(&add_path);
        return Ok(());
    }
    if !doc.can_log_edits() {
        // Backed by the temporary copy of a failed save; a log against the original would be wrong.
        return Ok(());
    }
    let (pieces, add) = doc.edits();
    #[derive(Serialize)]
    struct Log<'a> {
        file_len: u64,
        /// Seconds, kept for logs written by older versions.
        file_mtime: u64,
        disk: DiskState,
        eol: Eol,
        pieces: &'a [Piece],
    }
    let disk = doc.disk_state();
    let log = Log {
        file_len: disk.len,
        file_mtime: disk.mtime_ns / 1_000_000_000,
        disk,
        eol: doc.eol,
        pieces,
    };
    std::fs::create_dir_all(session::buffers_dir()).map_err(|e| e.to_string())?;
    session::write_atomic(&add_path, add)?;
    session::write_atomic(&pieces_path, &serde_json::to_vec(&log).map_err(|e| e.to_string())?)
}

/// Re-open a paged document from the session and restore its unsaved edits, if the file on
/// disk is unchanged. Returns (restored_edits, line_count).
#[tauri::command]
async fn paged_restore(state: State<'_, AppState>, id: String, path: String) -> Result<OpenResult, String> {
    let mut res = open_path(state.clone(), id.clone(), path, None, None).await?;
    if res.kind != "paged" {
        return Ok(res);
    }
    let (pieces_path, add_path) = session::edits_paths(&id);
    #[derive(Deserialize)]
    struct Log {
        file_len: u64,
        file_mtime: u64,
        #[serde(default)]
        disk: Option<DiskState>,
        #[serde(default)]
        eol: Option<Eol>,
        pieces: Vec<Piece>,
    }
    if let (Ok(pj), Ok(add)) = (std::fs::read(&pieces_path), std::fs::read(&add_path)) {
        if let Ok(log) = serde_json::from_slice::<Log>(&pj) {
            if let Ok(handle) = doc_handle(&state, &id) {
                let mut doc = handle.lock();
                let disk = doc.disk_state();
                let unchanged = match log.disk {
                    Some(d) => d == disk || doc.matches_legacy_fingerprint(&d),
                    None => log.file_len == disk.len && log.file_mtime == disk.mtime_ns / 1_000_000_000,
                };
                if unchanged && doc.is_editable() && doc.import_edits(log.pieces, add).is_ok() {
                    if let Some(eol) = log.eol {
                        doc.eol = eol;
                    }
                    res.line_count = Some(doc.line_count());
                    res.had_errors = false;
                }
            }
        }
    }
    Ok(res)
}

// ---- session ------------------------------------------------------------------------------

#[tauri::command]
fn session_load() -> session::Session {
    session::load_session()
}

#[tauri::command]
fn session_save(s: session::Session) -> Result<(), String> {
    session::save_session(&s)?;
    session::prune_buffers(&s);
    Ok(())
}

#[tauri::command]
async fn session_store_buffer(id: String, text: String, generation: Option<u64>) -> Result<(), String> {
    session::store_buffer_gen(&id, &text, generation)
}

#[tauri::command]
fn session_buffer_epoch() -> u64 {
    session::next_buffer_epoch()
}

#[tauri::command]
fn session_has_recovery(id: String) -> bool {
    session::has_recovery(&id)
}

#[tauri::command]
fn session_load_buffer(id: String) -> Option<String> {
    session::load_buffer(&id)
}

#[tauri::command]
fn session_drop_buffer(id: String, generation: Option<u64>) {
    session::drop_buffer_gen(&id, generation)
}

#[tauri::command]
fn settings_load() -> serde_json::Value {
    session::load_settings()
}

#[tauri::command]
fn settings_save(value: serde_json::Value) -> Result<(), String> {
    session::save_settings(&value)
}

#[tauri::command]
fn startup_files(state: State<'_, AppState>) -> Vec<String> {
    std::mem::take(&mut *state.startup_files.lock())
}

#[tauri::command]
async fn finished_saves(state: State<'_, AppState>) -> Result<FinishedSaves, String> {
    // Waits until the recovery at start is done; the frontend asks before it restores tabs, so
    // no tab shows a file that is still being repaired.
    let recovery = state.recovery.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = recovery.state.lock().unwrap_or_else(|e| e.into_inner());
        while !s.0 {
            s = recovery.done.wait(s).unwrap_or_else(|e| e.into_inner());
        }
        std::mem::take(&mut s.1)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Security attributes that let every account open the running-app mutex for SYNCHRONIZE (all
/// the installer needs to see it), so an installer run by another account notices the app.
#[cfg(windows)]
fn running_mutex_security() -> Option<windows_sys::Win32::Security::SECURITY_ATTRIBUTES> {
    use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    // 0x00100000 is SYNCHRONIZE, WD is Everyone. The creator keeps full access to its handle.
    let sddl: Vec<u16> = "D:(A;;0x00100000;;;WD)".encode_utf16().chain(std::iter::once(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: `sddl` is NUL-terminated; the descriptor is allocated by Windows and deliberately
    // never freed, because the mutex uses it for the life of the process.
    let ok = unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()) };
    (ok != 0).then(|| SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 })
}

/// Tell the user that this portable copy cannot start, before any window exists.
#[cfg(windows)]
fn show_startup_error(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    // SAFETY: both strings are NUL-terminated and live until the call returns.
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide("Nax-Notepad").as_ptr(), MB_OK | MB_ICONWARNING) };
}

#[cfg(not(windows))]
fn show_startup_error(text: &str) {
    eprintln!("{text}");
}

// ---- find in files ------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileHit {
    path: String,
    line: usize,
    col: usize,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkippedFile {
    path: String,
    /// "binary", "encoding" (large file that is not UTF-8) or "unreadable"
    reason: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct FindInFilesResult {
    hits: Vec<FileHit>,
    /// Files that were not searched, with the reason (at most 500 listed).
    skipped: Vec<SkippedFile>,
    skipped_count: usize,
    files_searched: usize,
    truncated: bool,
    cancelled: bool,
}

/// Files larger than this are searched through a memory map instead of being read.
const FIF_MAP_THRESHOLD: u64 = 32 * 1024 * 1024;

fn search_bytes(re: &regex::bytes::Regex, bytes: &[u8], path: &Path, hits: &mut Vec<FileHit>, max_hits: usize, cancel: &dyn Fn() -> bool) -> bool {
    let mut line_no = 0usize;
    let mut line_start = 0usize;
    for (k, m) in re.find_iter(bytes).enumerate() {
        if k % 4096 == 4095 && cancel() {
            return false;
        }
        if m.start() == m.end() {
            continue;
        }
        let nl = memchr::memchr_iter(b'\n', &bytes[line_start..m.start()]).count();
        if nl > 0 {
            line_no += nl;
            line_start = memchr::memrchr(b'\n', &bytes[..m.start()]).map(|p| p + 1).unwrap_or(0);
        }
        let line_end = memchr::memchr(b'\n', &bytes[m.start()..])
            .map(|p| m.start() + p)
            .unwrap_or(bytes.len())
            .min(line_start + 4096);
        let line_text = String::from_utf8_lossy(&bytes[line_start..line_end]).trim_end_matches('\r').to_string();
        hits.push(FileHit {
            path: path.display().to_string(),
            line: line_no,
            col: String::from_utf8_lossy(&bytes[line_start..m.start()]).chars().count(),
            text: line_text.chars().take(400).collect(),
        });
        if hits.len() >= max_hits {
            return false;
        }
    }
    true
}

#[tauri::command]
async fn find_in_files(
    root: String,
    opts: FindOpts,
    include: Option<String>,
    max_hits: Option<usize>,
) -> Result<FindInFilesResult, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let cancel = cancel_token();
    let max_hits = max_hits.unwrap_or(5000);
    let globs: Vec<String> = include
        .unwrap_or_default()
        .split([';', ','])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut res = FindInFilesResult::default();
    let skip = |res: &mut FindInFilesResult, path: &Path, reason: &str| {
        res.skipped_count += 1;
        if res.skipped.len() < 500 {
            res.skipped.push(SkippedFile { path: path.display().to_string(), reason: reason.into() });
        }
    };
    let walker = walkdir::WalkDir::new(&root).into_iter().filter_entry(|e| {
        let n = e.file_name().to_string_lossy();
        !(n == ".git" || n == "node_modules" || n == "target" || n == ".svn")
    });
    for entry in walker {
        if cancel() {
            res.cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                let p = e.path().map(|p| p.to_path_buf()).unwrap_or_default();
                skip(&mut res, &p, "unreadable");
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !globs.is_empty() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !globs.iter().any(|g| glob_match(g, &name)) {
                continue;
            }
        }
        let len = match entry.metadata() {
            Ok(m) => m.len(),
            Err(_) => {
                skip(&mut res, path, "unreadable");
                continue;
            }
        };
        let keep_going = if len > FIF_MAP_THRESHOLD {
            // Large file: search the memory map directly (UTF-8 only, no copy).
            let map = std::fs::File::open(path).and_then(|f| unsafe { memmap2::Mmap::map(&f) });
            let map = match map {
                Ok(m) => m,
                Err(_) => {
                    skip(&mut res, path, "unreadable");
                    continue;
                }
            };
            let probe = &map[..map.len().min(8192)];
            if textfmt::detect_bom(probe).0 == textfmt::Bom::None && probe.contains(&0) {
                skip(&mut res, path, "binary");
                continue;
            }
            let sample = &map[..map.len().min(1 << 20)];
            let utf8 = match std::str::from_utf8(sample) {
                Ok(_) => true,
                Err(e) => e.error_len().is_none(),
            };
            if !utf8 || matches!(textfmt::detect_bom(probe).0, textfmt::Bom::Utf16Le | textfmt::Bom::Utf16Be) {
                skip(&mut res, path, "encoding");
                continue;
            }
            res.files_searched += 1;
            search_bytes(&re, &map, path, &mut res.hits, max_hits, &cancel)
        } else {
            let raw = match std::fs::read(path) {
                Ok(b) => b,
                Err(_) => {
                    skip(&mut res, path, "unreadable");
                    continue;
                }
            };
            let (bom, _) = textfmt::detect_bom(&raw);
            let probe = &raw[..raw.len().min(8192)];
            if bom == textfmt::Bom::None && probe.contains(&0) {
                skip(&mut res, path, "binary");
                continue;
            }
            // Search decoded UTF-8 so legacy code pages and UTF-16 files match and columns are
            // character based.
            let bytes: std::borrow::Cow<[u8]> = if bom == textfmt::Bom::None && std::str::from_utf8(&raw).is_ok() {
                std::borrow::Cow::Borrowed(&raw)
            } else {
                std::borrow::Cow::Owned(textfmt::decode(&raw).text.into_bytes())
            };
            res.files_searched += 1;
            search_bytes(&re, &bytes, path, &mut res.hits, max_hits, &cancel)
        };
        if !keep_going {
            if res.hits.len() >= max_hits {
                res.truncated = true;
            } else {
                res.cancelled = true;
            }
            break;
        }
    }
    Ok(res)
}

fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    fn rec(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => rec(&p[1..], n) || (!n.is_empty() && rec(p, &n[1..])),
            (Some('?'), Some(_)) => rec(&p[1..], &n[1..]),
            (Some(a), Some(b)) if a == b => rec(&p[1..], &n[1..]),
            _ => false,
        }
    }
    rec(&p, &n)
}

// ---- misc -----------------------------------------------------------------------------------

/// Raw bytes for the hex view. Uses a seek + read so it works for any file size.
#[tauri::command]
async fn read_bytes(path: String, offset: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len.min(4 * 1024 * 1024) as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = f.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(tauri::ipc::Response::new(buf))
}

/// Fails with E_EXTERNAL_CHANGE when the file is no longer what the editor loaded.
fn ensure_unchanged(p: &Path, expected_mtime: Option<u64>, expected_len: Option<u64>) -> Result<(), String> {
    let meta = std::fs::metadata(p).map_err(|e| format!("Cannot read {}: {e}", p.display()))?;
    let now = mtime_of(p);
    // Sessions of old versions stored whole seconds; accept those when the seconds agree.
    let same_time = |m: u64| m == 0 || now == m || (m < 100_000_000_000 && now / 1000 == m);
    let changed = expected_mtime.is_some_and(|m| !same_time(m)) || expected_len.is_some_and(|l| l != meta.len());
    if changed {
        return Err(format!("{}{}", paged::E_EXTERNAL_CHANGE, p.display()));
    }
    Ok(())
}

fn saved(p: &Path) -> SaveResult {
    SaveResult {
        size: std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
        mtime: mtime_of(p),
        name: file_name(p),
        path: p.display().to_string(),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Replace a file with the bytes edited in the hex view (atomic, like every save). The body is
/// the raw content; headers carry the URI-encoded path and the modification time the editor
/// loaded, so a file changed by another program is not overwritten.
#[tauri::command]
async fn write_bytes(request: tauri::ipc::Request<'_>) -> Result<SaveResult, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("write_bytes expects raw bytes".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let path = percent_decode(&header("x-path").ok_or("missing path")?);
    let expected = header("x-mtime").and_then(|s| s.parse::<u64>().ok());
    let p = PathBuf::from(&path);
    let unchanged = || if p.exists() { ensure_unchanged(&p, expected, None) } else { Ok(()) };
    session::replace_atomic_checked(&p, unchanged, |f| std::io::Write::write_all(f, data))?;
    Ok(saved(&p))
}

/// Write `patches` (offset, byte) into a copy of the file and replace it atomically. Used for
/// files too large to edit in memory; the file is streamed, so any size works.
fn patch_file_impl(p: &Path, patches: &mut [(u64, u8)], expected_len: u64, expected_mtime: Option<u64>) -> Result<(), String> {
    use std::io::{Read, Write};
    patches.sort_by_key(|x| x.0);
    if patches.last().is_some_and(|x| x.0 >= expected_len) {
        return Err("A changed byte lies beyond the end of the file.".into());
    }
    session::replace_atomic_checked(p, || ensure_unchanged(p, expected_mtime, Some(expected_len)), |out| {
        let mut src = std::fs::File::open(p)?;
        let mut buf = vec![0u8; 1 << 20];
        let mut off = 0u64;
        let mut i = 0usize;
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            while i < patches.len() && patches[i].0 < off + n as u64 {
                buf[(patches[i].0 - off) as usize] = patches[i].1;
                i += 1;
            }
            out.write_all(&buf[..n])?;
            off += n as u64;
        }
        if off != expected_len {
            return Err(std::io::Error::other("the file changed while it was being saved"));
        }
        Ok(())
    })
}

/// Offset of the first occurrence of `pattern` at or after `from` (or the last one at or before
/// `from` when `backwards`), reading the file in blocks so files of any size can be searched.
fn find_bytes_impl(p: &Path, pattern: &[u8], from: u64, backwards: bool, cancel: &dyn Fn() -> bool) -> Result<Option<u64>, String> {
    use std::io::{Read, Seek, SeekFrom};
    if pattern.is_empty() {
        return Ok(None);
    }
    let mut f = std::fs::File::open(p).map_err(|e| format!("Cannot read {}: {e}", p.display()))?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let plen = pattern.len() as u64;
    if plen > len {
        return Ok(None);
    }
    const BLOCK: u64 = 4 << 20;
    let finder = memchr::memmem::Finder::new(pattern);
    let mut buf = Vec::new();
    let mut read_at = |start: u64, end: u64, buf: &mut Vec<u8>| -> Result<(), String> {
        buf.resize((end - start) as usize, 0);
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        f.read_exact(buf).map_err(|e| e.to_string())
    };
    if !backwards {
        let mut start = from.min(len);
        while start + plen <= len {
            if cancel() {
                return Err(paged::E_CANCELLED.to_string());
            }
            let end = (start + BLOCK + plen - 1).min(len);
            read_at(start, end, &mut buf)?;
            if let Some(i) = finder.find(&buf) {
                return Ok(Some(start + i as u64));
            }
            if end == len {
                break;
            }
            start = end + 1 - plen;
        }
    } else {
        // Last match starting at or before `from`.
        let mut end = (from.min(len - plen) + plen).min(len);
        loop {
            if cancel() {
                return Err(paged::E_CANCELLED.to_string());
            }
            let start = end.saturating_sub(BLOCK + plen - 1);
            read_at(start, end, &mut buf)?;
            if let Some(i) = memchr::memmem::rfind(&buf, pattern) {
                return Ok(Some(start + i as u64));
            }
            if start == 0 {
                break;
            }
            end = start + plen - 1;
        }
    }
    Ok(None)
}

#[tauri::command]
async fn find_bytes(path: String, pattern: Vec<u8>, from: u64, backwards: bool) -> Result<Option<u64>, String> {
    find_bytes_impl(Path::new(&path), &pattern, from, backwards, &cancel_token())
}

#[tauri::command]
async fn patch_file(path: String, mut patches: Vec<(u64, u8)>, expected_len: u64, expected_mtime: Option<u64>) -> Result<SaveResult, String> {
    let p = PathBuf::from(&path);
    patch_file_impl(&p, &mut patches, expected_len, expected_mtime)?;
    Ok(saved(&p))
}

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

/// Entries of one folder for the workspace sidebar: folders first, then files, by name.
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let mut out: Vec<DirEntryInfo> = rd
        .flatten()
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            DirEntryInfo { name: e.file_name().to_string_lossy().into_owned(), path: e.path().display().to_string(), is_dir }
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Read a (small) text file as UTF-8, for imports. Fails above `max_bytes` (default 16 MiB).
#[tauri::command]
async fn read_text_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let max = max_bytes.unwrap_or(16 << 20);
    let len = std::fs::metadata(&path).map_err(|e| format!("Cannot read {path}: {e}"))?.len();
    if len > max {
        return Err(format!("{path} is too large ({len} bytes)"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(textfmt::decode(&bytes).text)
}

/// Write UTF-8 text atomically, for exports.
#[tauri::command]
async fn write_text_file(path: String, text: String) -> Result<(), String> {
    session::write_atomic(Path::new(&path), text.as_bytes())
}

/// Decode `buf` as far as it ends with a complete character. Data written by another program
/// can stop in the middle of a character; its first bytes are left for the next read instead of
/// being turned into a replacement character.
fn decode_complete(buf: &[u8], label: &str) -> (String, usize) {
    let enc = match label {
        "UTF-8" | "UTF-8-BOM" => encoding_rs::UTF_8,
        "UTF-16LE" => encoding_rs::UTF_16LE,
        "UTF-16BE" => encoding_rs::UTF_16BE,
        other => encoding_rs::Encoding::for_label(other.as_bytes()).unwrap_or(encoding_rs::UTF_8),
    };
    let unit = if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE { 2 } else { 1 };
    let whole = buf.len() - buf.len() % unit;
    let (text, errors) = enc.decode_without_bom_handling(&buf[..whole]);
    if !errors {
        return (text.into_owned(), whole);
    }
    // Try leaving the last few bytes (an incomplete character) for later.
    for keep in (unit..=4).step_by(unit) {
        if keep > whole {
            break;
        }
        let (t, e) = enc.decode_without_bom_handling(&buf[..whole - keep]);
        if !e {
            return (t.into_owned(), whole - keep);
        }
    }
    // The bytes are invalid, not just incomplete: show them with replacement characters.
    (text.into_owned(), whole)
}

fn head_hash(path: &Path, len: u64) -> std::io::Result<u64> {
    use std::io::Read;
    let mut buf = vec![0u8; len as usize];
    std::fs::File::open(path)?.read_exact(&mut buf)?;
    // 53 bits, so the value survives a round trip through a JavaScript number.
    Ok(paged::stable_hash(&buf) & ((1u64 << 53) - 1))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TailStart {
    size: u64,
    head_hash: u64,
    head_len: u64,
}

/// Remember the current end and beginning of a file before following it.
#[tauri::command]
async fn tail_start(path: String) -> Result<TailStart, String> {
    let size = std::fs::metadata(&path).map_err(|e| format!("Cannot read {path}: {e}"))?.len();
    let head_len = size.min(64 << 10);
    let head_hash = head_hash(Path::new(&path), head_len).map_err(|e| e.to_string())?;
    Ok(TailStart { size, head_hash, head_len })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TailCheck {
    /// "same", "appended", "rotated" or "missing"
    status: String,
    /// Decoded appended text (status "appended").
    text: String,
    /// Offset up to which the file has been read.
    offset: u64,
    mtime: u64,
}

/// Read what was appended to a followed file since `offset`. Reports "rotated" when the file
/// shrank or its beginning changed, so the caller reloads it. Text is only returned up to the
/// last complete character.
#[tauri::command]
async fn tail_check(path: String, offset: u64, head_hash_value: u64, head_len: u64, encoding: String) -> Result<TailCheck, String> {
    use std::io::{Read, Seek, SeekFrom};
    let p = Path::new(&path);
    let out = |status: &str, text: String, offset: u64| TailCheck { status: status.into(), text, offset, mtime: mtime_of(p) };
    let size = match std::fs::metadata(p) {
        Ok(m) => m.len(),
        Err(_) => return Ok(out("missing", String::new(), offset)),
    };
    if size < offset || size < head_len {
        return Ok(out("rotated", String::new(), offset));
    }
    if head_hash(p, head_len).map_err(|e| e.to_string())? != head_hash_value {
        return Ok(out("rotated", String::new(), offset));
    }
    if size == offset {
        return Ok(out("same", String::new(), offset));
    }
    if size - offset > (64 << 20) {
        return Ok(out("rotated", String::new(), offset)); // too much at once: reload instead
    }
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (size - offset) as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let (text, consumed) = decode_complete(&buf, &encoding);
    Ok(out("appended", text, offset + consumed as u64))
}

/// Where settings, session and unsaved text are stored (shown in About).
#[tauri::command]
fn app_data_dir() -> String {
    session::data_dir().display().to_string()
}

/// The Notepad++ settings folder, if Notepad++ is installed for this user.
#[tauri::command]
fn npp_config_dir() -> Option<String> {
    let dir = PathBuf::from(std::env::var_os("APPDATA")?).join("Notepad++");
    dir.is_dir().then(|| dir.display().to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn collect_file_args<I: Iterator<Item = String>>(args: I, cwd: &Path) -> Vec<String> {
    args.skip(1)
        .filter(|a| is_file_argument(a, cwd))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() {
                p
            } else {
                cwd.join(p)
            }
        })
        .map(|p| p.display().to_string())
        .collect()
}

/// Arguments that name files. Options start with "-", but an existing file whose name starts
/// with "-" is still opened. Relative names are looked up in `cwd`, the folder of the instance
/// that received them.
fn is_file_argument(a: &str, cwd: &Path) -> bool {
    !a.starts_with('-') || cwd.join(a).is_file()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    // A named mutex for as long as the app runs: the installer and the uninstaller see it
    // (AppMutex) and ask to close the app first, so it cannot write its data folder again
    // after the uninstaller removed it.
    // The global name is seen from other sign-in sessions too. A portable copy is not managed by
    // the installer, so it does not create the mutex.
    #[cfg(windows)]
    if session::portable_dir().is_none() {
        // Other accounts (an administrator running the installer) may only wait on it.
        let everyone_may_wait = running_mutex_security();
        for name in ["NaxNotepadRunning", "Global\\NaxNotepadRunning"] {
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            let attrs = everyone_may_wait.as_ref().map_or(std::ptr::null(), |a| a as *const _);
            // SAFETY: the name is NUL-terminated and `attrs` is null or points to attributes
            // that live until the call returns; the handle stays open until the process ends.
            unsafe { windows_sys::Win32::System::Threading::CreateMutexW(attrs, 0, wide.as_ptr()) };
        }
    }
    // Portable mode keeps the browser profile next to the program as well.
    // The single-instance plugin is not used in portable mode, so a lock on the data folder keeps
    // a second copy from sharing (and pruning) this copy's session and unsaved text.
    let mut _data_lock = None;
    if let Some(dir) = session::portable_dir() {
        match session::lock_data_dir(&dir) {
            Ok(f) => _data_lock = Some(f),
            // ERROR_SHARING_VIOLATION: another copy holds the lock.
            Err(e) if e.raw_os_error() == Some(32) => {
                show_startup_error(
                    "Nax-Notepad is already running from this folder. Use the open window, or copy the program to another folder to run it twice.\n\nNax-Notepad läuft bereits aus diesem Ordner. Verwenden Sie das geöffnete Fenster, oder kopieren Sie das Programm in einen anderen Ordner, um es zweimal zu starten.",
                );
                return;
            }
            Err(e) => {
                show_startup_error(&format!(
                    "Nax-Notepad cannot use its data folder {}: {e}\n\nNax-Notepad kann seinen Datenordner {} nicht verwenden: {e}",
                    dir.display(),
                    dir.display()
                ));
                return;
            }
        }
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir.join("webview"));
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let initial = collect_file_args(std::env::args(), &cwd);
    let state = AppState {
        paged: Mutex::new(HashMap::new()),
        startup_files: Mutex::new(initial),
        recovery: Arc::new(Recovery::default()),
    };
    let mut builder = tauri::Builder::default();
    // A portable copy runs on its own: it must not hand its files to an installed copy (both
    // would share one single-instance lock), and it must not write window state to %APPDATA%.
    if session::portable_dir().is_none() {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
                let files = collect_file_args(argv.into_iter(), Path::new(&cwd));
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                let _ = app.emit("open-files", files);
            }))
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        // Runs after the single-instance plugin, so only the copy that stays open finishes
        // interrupted saves, and before the page can ask for them.
        .setup(|app| {
            // On its own thread, so the main thread keeps running the window while a large file
            // is repaired; the frontend waits for the result before it opens any file.
            let recovery = app.state::<AppState>().recovery.clone();
            std::thread::spawn(move || {
                let work = || {
                    let mut report = FinishedSaves::default();
                    for r in session::recover_interrupted_rewrites() {
                        let target = r.target.display().to_string();
                        if r.finished {
                            report.finished.push(target);
                        } else {
                            report.failed.push(FailedSave { target, kept: r.kept.iter().map(|p| p.display().to_string()).collect() });
                        }
                    }
                    report
                };
                // Even if the repair panics, the frontend must stop waiting.
                let report = std::panic::catch_unwind(work).unwrap_or_default();
                *recovery.state.lock().unwrap_or_else(|e| e.into_inner()) = (true, report);
                recovery.done.notify_all();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_path,
            save_text,
            file_mtime,
            encodings,
            paged_window,
            paged_commit,
            paged_save,
            paged_close,
            paged_set_eol,
            paged_disk_state,
            paged_find_all,
            write_bytes,
            patch_file,
            find_bytes,
            paged_tail_check,
            cancel_search,
            list_dir,
            read_text_file,
            write_text_file,
            tail_start,
            tail_check,
            app_data_dir,
            npp_config_dir,
            paged_set_scope,
            paged_clear_scope,
            paged_find,
            paged_count,
            paged_replace_all,
            paged_store_edits,
            paged_restore,
            session_load,
            session_save,
            session_store_buffer,
            session_load_buffer,
            session_buffer_epoch,
            session_has_recovery,
            session_drop_buffer,
            settings_load,
            settings_save,
            startup_files,
            finished_saves,
            find_in_files,
            path_exists,
            read_bytes,
            file_size,
            reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nax-Notepad");
}

#[cfg(test)]
mod tests {
    use super::js_to_rust_replacement;

    #[test]
    fn replacement_syntax_matches_javascript() {
        assert_eq!(js_to_rust_replacement("$&!", 1), "${0}!");
        assert_eq!(js_to_rust_replacement("$1-$2", 3), "${1}-${2}");
        assert_eq!(js_to_rust_replacement("$12", 13), "${12}");
        assert_eq!(js_to_rust_replacement("$12", 2), "${1}2");
        assert_eq!(js_to_rust_replacement("$<word>", 2), "${word}");
        assert_eq!(js_to_rust_replacement("$$ and $ and $9", 1), "$$ and $$ and $$9");
        let re = regex::bytes::Regex::new(r"(?P<w>\w+)@(\w+)").unwrap();
        let caps = re.captures(b"user@host").unwrap();
        let mut out = Vec::new();
        caps.expand(js_to_rust_replacement("$2 <- $<w> ($&) $$", re.captures_len()).as_bytes(), &mut out);
        assert_eq!(out, b"host <- user (user@host) $");
    }

    use super::*;
    use std::io::Write;

    /// Cancelling is global, so tests that search must not overlap with the cancel test.
    static SEARCH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn opts(p: &str) -> FindOpts {
        FindOpts { pattern: p.into(), regex: false, case_sensitive: false, whole_word: false }
    }

    #[test]
    fn find_in_files_reports_skipped_files() {
        let _g = SEARCH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "first\nneedle here\n").unwrap();
        std::fs::write(dir.path().join("b.bin"), b"needle\0\0\0binary").unwrap();
        // Legacy code page: found after decoding, with a character column.
        std::fs::write(dir.path().join("c.txt"), b"Gr\xfc\xdfe needle").unwrap();
        let res = tauri::async_runtime::block_on(find_in_files(dir.path().display().to_string(), opts("needle"), None, None)).unwrap();
        let mut hits: Vec<(String, usize, usize)> = res.hits.iter().map(|h| (Path::new(&h.path).file_name().unwrap().to_string_lossy().into_owned(), h.line, h.col)).collect();
        hits.sort();
        assert_eq!(hits, vec![("a.txt".into(), 1, 0), ("c.txt".into(), 0, 6)]);
        assert_eq!(res.skipped_count, 1);
        assert_eq!(res.skipped[0].reason, "binary");
        assert!(!res.cancelled && !res.truncated);
        assert_eq!(res.files_searched, 2);
    }

    #[test]
    fn cancel_search_stops_find_in_files() {
        let _g = SEARCH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "needle").unwrap();
        let cancel = cancel_token();
        assert!(!cancel());
        cancel_search();
        assert!(cancel(), "a running search sees the cancellation");
        // A search started afterwards runs normally.
        let res = tauri::async_runtime::block_on(find_in_files(dir.path().display().to_string(), opts("needle"), None, None)).unwrap();
        assert_eq!(res.hits.len(), 1);
    }

    #[test]
    fn tail_reads_appended_text_and_detects_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("app.log");
        let path = p.display().to_string();
        std::fs::write(&p, "one\n").unwrap();
        let st = tauri::async_runtime::block_on(tail_start(path.clone())).unwrap();
        assert_eq!(st.size, 4);
        let check = |offset: u64| tauri::async_runtime::block_on(tail_check(path.clone(), offset, st.head_hash, st.head_len, "UTF-8".into())).unwrap();
        assert_eq!(check(4).status, "same");
        // Append "two\n" plus the first byte of "ü": only complete characters are returned.
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"two\n\xc3").unwrap();
        let r = check(4);
        assert_eq!((r.status.as_str(), r.text.as_str(), r.offset), ("appended", "two\n", 8));
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"\xbc\n").unwrap();
        let r = check(8);
        assert_eq!((r.status.as_str(), r.text.as_str(), r.offset), ("appended", "ü\n", 11));
        // Rotation: the file is replaced by a new, shorter one.
        std::fs::rename(&p, dir.path().join("app.log.1")).unwrap();
        assert_eq!(check(11).status, "missing");
        std::fs::write(&p, "new\n").unwrap();
        assert_eq!(check(11).status, "rotated");
        // Same length but different beginning is also a replacement.
        std::fs::write(&p, b"xne\ntwo\n\xc3\xbc\n").unwrap();
        assert_eq!(check(11).status, "rotated");
    }

    #[test]
    fn head_hash_fits_a_javascript_number() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x");
        std::fs::write(&p, "some content").unwrap();
        assert!(head_hash(&p, 12).unwrap() < (1u64 << 53));
    }

    #[test]
    fn hex_patch_of_a_file_with_several_hard_links_is_saved_under_every_name() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("data.bin");
        let other = dir.path().join("other-name.bin");
        std::fs::write(&p, [1u8, 2, 3, 4]).unwrap();
        std::fs::hard_link(&p, &other).unwrap();
        patch_file_impl(&p, &mut vec![(2, 0xEE)], 4, Some(mtime_of(&p))).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), [1, 2, 0xEE, 4]);
        assert_eq!(std::fs::read(&other).unwrap(), [1, 2, 0xEE, 4]);
    }

    #[cfg(windows)]
    #[test]
    fn the_running_app_mutex_can_be_opened_by_everyone_for_waiting() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{CreateMutexW, OpenMutexW};
        let attrs = running_mutex_security().expect("the security descriptor must be valid");
        let name: Vec<u16> = format!("NaxNotepadTest-{}", std::process::id()).encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: valid NUL-terminated names and attributes that outlive the calls.
        unsafe {
            let created = CreateMutexW(&attrs, 0, name.as_ptr());
            assert!(!created.is_null());
            // What the installer does: open it for SYNCHRONIZE only.
            let opened = OpenMutexW(0x0010_0000, 0, name.as_ptr());
            assert!(!opened.is_null(), "SYNCHRONIZE access must be granted");
            CloseHandle(opened);
            CloseHandle(created);
        }
    }

    #[test]
    fn patch_file_changes_only_the_given_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("data.bin");
        let original: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, &original).unwrap();
        let mtime = mtime_of(&p);
        let mut patches = vec![(2_999_999u64, 0xAAu8), (0, 0xFF), (1_048_576, 0x11)];
        patch_file_impl(&p, &mut patches, original.len() as u64, Some(mtime)).unwrap();
        let after = std::fs::read(&p).unwrap();
        assert_eq!(after.len(), original.len());
        let mut expected = original.clone();
        expected[0] = 0xFF;
        expected[1_048_576] = 0x11;
        expected[2_999_999] = 0xAA;
        assert!(after == expected);
        // A stale length or time is refused and leaves the file alone.
        let err = patch_file_impl(&p, &mut vec![(1, 1)], 10, None).unwrap_err();
        assert!(err.starts_with(paged::E_EXTERNAL_CHANGE));
        let err = patch_file_impl(&p, &mut vec![(1, 1)], after.len() as u64, Some(1)).unwrap_err();
        assert!(err.starts_with(paged::E_EXTERNAL_CHANGE));
        assert!(patch_file_impl(&p, &mut vec![(after.len() as u64, 1)], after.len() as u64, None).is_err());
        assert!(std::fs::read(&p).unwrap() == expected);
        let leftovers = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary files remain");
    }

    #[test]
    fn find_bytes_across_block_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.bin");
        let mut data = vec![0u8; 9 * 1024 * 1024];
        let at1 = 4 * 1024 * 1024 - 2; // straddles the first block boundary
        let at2 = 8 * 1024 * 1024 + 5;
        data[at1..at1 + 4].copy_from_slice(b"NAX!");
        data[at2..at2 + 4].copy_from_slice(b"NAX!");
        std::fs::write(&p, &data).unwrap();
        let never = || false;
        let f = |from: u64, back: bool| find_bytes_impl(&p, b"NAX!", from, back, &never).unwrap();
        assert_eq!(f(0, false), Some(at1 as u64));
        assert_eq!(f(at1 as u64 + 1, false), Some(at2 as u64));
        assert_eq!(f(at2 as u64 + 1, false), None);
        assert_eq!(f(data.len() as u64, true), Some(at2 as u64));
        assert_eq!(f(at2 as u64 - 1, true), Some(at1 as u64));
        assert_eq!(f(at1 as u64 - 1, true), None);
        assert_eq!(f(at1 as u64, true), Some(at1 as u64));
    }

    #[test]
    fn percent_decoding_of_paths() {
        assert_eq!(percent_decode("C%3A%5CData%20Files%5C%C3%BC.bin"), r"C:\Data Files\ü.bin");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn saving_refuses_to_overwrite_a_file_another_program_changed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("notes.txt");
        std::fs::write(&p, b"from another program").unwrap();
        let known = mtime_of(&p) - 5_000; // the editor loaded an older version
        let save = |m: Option<u64>| tauri::async_runtime::block_on(save_text(p.display().to_string(), "mine".into(), "UTF-8".into(), Eol::Lf, None, m));
        let err = save(Some(known)).err().expect("must refuse");
        assert!(err.starts_with(paged::E_EXTERNAL_CHANGE), "{err}");
        assert_eq!(std::fs::read(&p).unwrap(), b"from another program");
        // With the current time (or no known time, for Save As) the save goes through.
        save(Some(mtime_of(&p))).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"mine");
        // Sessions of old versions stored seconds; those still match.
        save(Some(mtime_of(&p) / 1000)).unwrap();
    }

    #[test]
    fn follow_mode_leaves_an_incomplete_character_for_the_next_read() {
        // UTF-8: "Aü" with the second byte of ü still missing.
        assert_eq!(decode_complete(&[0x41, 0xc3], "UTF-8"), ("A".to_string(), 1));
        // UTF-16LE: "A" followed by only the high surrogate of an emoji.
        assert_eq!(decode_complete(&[0x41, 0x00, 0x3d, 0xd8], "UTF-16LE"), ("A".to_string(), 2));
        // UTF-16 with an odd trailing byte.
        assert_eq!(decode_complete(&[0x41, 0x00, 0x42], "UTF-16LE"), ("A".to_string(), 2));
        // GBK: "A" and the first byte of a two-byte character.
        assert_eq!(decode_complete(&[0x41, 0xd6], "GBK"), ("A".to_string(), 1));
        // Complete data is consumed entirely; genuinely invalid data is not held back forever.
        assert_eq!(decode_complete("Grüße\n".as_bytes(), "UTF-8").1, 8);
        assert_eq!(decode_complete(&[0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0x41], "UTF-8").1, 6);
    }

    #[test]
    fn file_names_starting_with_a_dash_are_opened_from_the_command_line() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("-notes.txt");
        std::fs::write(&p, b"x").unwrap();
        let elsewhere = Path::new("C:\\");
        assert!(is_file_argument(&p.display().to_string(), elsewhere));
        // A relative name is looked up in the folder of the instance that received it.
        assert!(is_file_argument("-notes.txt", dir.path()));
        assert!(!is_file_argument("-notes.txt", elsewhere));
        assert!(is_file_argument("plain.txt", elsewhere));
        assert!(!is_file_argument("--some-option", dir.path()));
    }

    #[test]
    fn list_dir_puts_folders_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.txt"), "").unwrap();
        std::fs::write(dir.path().join("A.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("zdir")).unwrap();
        let names: Vec<String> = tauri::async_runtime::block_on(list_dir(dir.path().display().to_string())).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["zdir", "A.txt", "b.txt"]);
    }
}
