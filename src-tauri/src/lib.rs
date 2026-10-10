mod paged;
mod session;
mod textfmt;

use paged::{Match, PagedDoc, Piece};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager, State};
use textfmt::Eol;

/// Files larger than this are opened in paged (memory-mapped) mode.
const PAGED_THRESHOLD: u64 = 48 * 1024 * 1024;

#[derive(Default)]
pub struct AppState {
    paged: Mutex<HashMap<String, PagedDoc>>,
    startup_files: Mutex<Vec<String>>,
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
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
async fn open_path(
    state: State<'_, AppState>,
    id: String,
    path: String,
    force_paged: Option<bool>,
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
        let doc = PagedDoc::open(&p)?;
        let res = OpenResult {
            kind: "paged".into(),
            path: p.display().to_string(),
            name: file_name(&p),
            text: None,
            encoding: match doc.bom {
                textfmt::Bom::Utf8 => "UTF-8-BOM".into(),
                textfmt::Bom::Utf16Le => "UTF-16LE (raw)".into(),
                textfmt::Bom::Utf16Be => "UTF-16BE (raw)".into(),
                textfmt::Bom::None => "UTF-8".into(),
            },
            eol: doc.eol,
            size,
            line_count: Some(doc.line_count()),
            had_errors: false,
            read_only,
            mtime: doc.file_mtime,
            binary,
        };
        state.paged.lock().insert(id, doc);
        return Ok(res);
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("Cannot read {}: {e}", p.display()))?;
    let dec = textfmt::decode(&bytes);
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
) -> Result<SaveResult, String> {
    let p = PathBuf::from(&path);
    let bytes = textfmt::encode(&text, &encoding, eol)?;
    if let Some(dir) = p.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create folder: {e}"))?;
        }
    }
    session::write_atomic(&p, &bytes)?;
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
}

#[tauri::command]
async fn paged_window(
    state: State<'_, AppState>,
    id: String,
    first_line: usize,
    count: usize,
) -> Result<Window, String> {
    let docs = state.paged.lock();
    let doc = docs.get(&id).ok_or("document not open")?;
    let (text, first, n) = doc.read_lines(first_line, count);
    Ok(Window {
        text,
        first_line: first,
        count: n,
        total_lines: doc.line_count(),
        dirty: doc.is_dirty(),
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
    let mut docs = state.paged.lock();
    let doc = docs.get_mut(&id).ok_or("document not open")?;
    Ok(doc.replace_lines(first_line, count, &text))
}

#[tauri::command]
async fn paged_save(
    state: State<'_, AppState>,
    id: String,
    path: Option<String>,
) -> Result<SaveResult, String> {
    let mut docs = state.paged.lock();
    let doc = docs.get_mut(&id).ok_or("document not open")?;
    let target = path.map(PathBuf::from).unwrap_or_else(|| doc.path.clone());
    doc.save_to(&target)?;
    Ok(SaveResult {
        size: doc.file_len,
        mtime: doc.file_mtime,
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
    let mut docs = state.paged.lock();
    let doc = docs.get_mut(&id).ok_or("document not open")?;
    doc.eol = eol;
    Ok(())
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
) -> Result<Option<Match>, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let docs = state.paged.lock();
    let doc = docs.get(&id).ok_or("document not open")?;
    let from = doc.line_start(from_line) + from_col;
    Ok(doc.find(&re, from, backwards))
}

#[tauri::command]
async fn paged_count(state: State<'_, AppState>, id: String, opts: FindOpts) -> Result<usize, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let docs = state.paged.lock();
    let doc = docs.get(&id).ok_or("document not open")?;
    Ok(doc.count_matches(&re, 1_000_000))
}

#[tauri::command]
async fn paged_replace_all(
    state: State<'_, AppState>,
    id: String,
    opts: FindOpts,
    replacement: String,
) -> Result<usize, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let rep = if opts.regex {
        replacement
    } else {
        replacement.replace('$', "$$")
    };
    let mut docs = state.paged.lock();
    let doc = docs.get_mut(&id).ok_or("document not open")?;
    Ok(doc.replace_all(&re, rep.as_bytes()))
}

#[tauri::command]
async fn paged_store_edits(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let docs = state.paged.lock();
    let doc = docs.get(&id).ok_or("document not open")?;
    let (pieces_path, add_path) = session::edits_paths(&id);
    if !doc.is_dirty() {
        let _ = std::fs::remove_file(&pieces_path);
        let _ = std::fs::remove_file(&add_path);
        return Ok(());
    }
    let (pieces, add) = doc.export_edits();
    #[derive(Serialize)]
    struct Log<'a> {
        file_len: u64,
        file_mtime: u64,
        pieces: &'a [Piece],
    }
    let log = Log {
        file_len: doc.file_len,
        file_mtime: doc.file_mtime,
        pieces: &pieces,
    };
    std::fs::create_dir_all(session::buffers_dir()).map_err(|e| e.to_string())?;
    session::write_atomic(&add_path, &add)?;
    session::write_atomic(&pieces_path, &serde_json::to_vec(&log).map_err(|e| e.to_string())?)
}

/// Re-open a paged document from the session and restore its unsaved edits, if the file on
/// disk is unchanged. Returns (restored_edits, line_count).
#[tauri::command]
async fn paged_restore(state: State<'_, AppState>, id: String, path: String) -> Result<OpenResult, String> {
    let mut res = open_path(state.clone(), id.clone(), path, None).await?;
    if res.kind != "paged" {
        return Ok(res);
    }
    let (pieces_path, add_path) = session::edits_paths(&id);
    #[derive(Deserialize)]
    struct Log {
        file_len: u64,
        file_mtime: u64,
        pieces: Vec<Piece>,
    }
    if let (Ok(pj), Ok(add)) = (std::fs::read(&pieces_path), std::fs::read(&add_path)) {
        if let Ok(log) = serde_json::from_slice::<Log>(&pj) {
            let mut docs = state.paged.lock();
            if let Some(doc) = docs.get_mut(&id) {
                if log.file_len == doc.file_len && log.file_mtime == doc.file_mtime {
                    if doc.import_edits(log.pieces, add).is_ok() {
                        res.line_count = Some(doc.line_count());
                        res.had_errors = false;
                    }
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
async fn session_store_buffer(id: String, text: String) -> Result<(), String> {
    session::store_buffer(&id, &text)
}

#[tauri::command]
fn session_load_buffer(id: String) -> Option<String> {
    session::load_buffer(&id)
}

#[tauri::command]
fn session_drop_buffer(id: String) {
    session::drop_buffer(&id)
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

// ---- find in files ------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileHit {
    path: String,
    line: usize,
    col: usize,
    text: String,
}

#[tauri::command]
async fn find_in_files(
    root: String,
    opts: FindOpts,
    include: Option<String>,
    max_hits: Option<usize>,
) -> Result<Vec<FileHit>, String> {
    let re = build_regex(&opts.pattern, opts.regex, opts.case_sensitive, opts.whole_word)?;
    let max_hits = max_hits.unwrap_or(5000);
    let globs: Vec<String> = include
        .unwrap_or_default()
        .split([';', ','])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut hits = Vec::new();
    let walker = walkdir::WalkDir::new(&root).into_iter().filter_entry(|e| {
        let n = e.file_name().to_string_lossy();
        !(n == ".git" || n == "node_modules" || n == "target" || n == ".svn")
    });
    'outer: for entry in walker.flatten() {
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
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > 32 * 1024 * 1024 {
            continue;
        }
        let raw = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let (bom, _) = textfmt::detect_bom(&raw);
        let probe = &raw[..raw.len().min(8192)];
        if bom == textfmt::Bom::None && probe.contains(&0) {
            continue; // binary
        }
        // Search decoded UTF-8 so legacy code pages and UTF-16 files match and columns are
        // character based.
        let bytes: std::borrow::Cow<[u8]> = if bom == textfmt::Bom::None && std::str::from_utf8(&raw).is_ok() {
            std::borrow::Cow::Borrowed(&raw)
        } else {
            std::borrow::Cow::Owned(textfmt::decode(&raw).text.into_bytes())
        };
        let bytes: &[u8] = &bytes;
        let mut line_no = 0usize;
        let mut line_start = 0usize;
        let mut matches = re.find_iter(&bytes).peekable();
        if matches.peek().is_none() {
            continue;
        }
        for m in matches {
            // advance line counter to m.start()
            let nl = memchr::memchr_iter(b'\n', &bytes[line_start..m.start()]).count();
            if nl > 0 {
                line_no += nl;
                line_start = memchr::memrchr(b'\n', &bytes[..m.start()]).map(|p| p + 1).unwrap_or(0);
            }
            let line_end = memchr::memchr(b'\n', &bytes[m.start()..])
                .map(|p| m.start() + p)
                .unwrap_or(bytes.len());
            let line_text = String::from_utf8_lossy(&bytes[line_start..line_end])
                .trim_end_matches('\r')
                .to_string();
            hits.push(FileHit {
                path: path.display().to_string(),
                line: line_no,
                col: String::from_utf8_lossy(&bytes[line_start..m.start()]).chars().count(),
                text: line_text.chars().take(400).collect(),
            });
            if hits.len() >= max_hits {
                break 'outer;
            }
        }
    }
    Ok(hits)
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

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
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
        .filter(|a| !a.starts_with('-'))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let cwd = std::env::current_dir().unwrap_or_default();
    let initial = collect_file_args(std::env::args(), &cwd);
    let state = AppState {
        paged: Mutex::new(HashMap::new()),
        startup_files: Mutex::new(initial),
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = collect_file_args(argv.into_iter(), Path::new(&cwd));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let _ = app.emit("open-files", files);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
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
            paged_find,
            paged_count,
            paged_replace_all,
            paged_store_edits,
            paged_restore,
            session_load,
            session_save,
            session_store_buffer,
            session_load_buffer,
            session_drop_buffer,
            settings_load,
            settings_save,
            startup_files,
            find_in_files,
            path_exists,
            read_bytes,
            file_size,
            reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nax-Notepad");
}
