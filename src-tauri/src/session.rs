//! Session persistence: open tabs, unsaved buffers, settings. Everything lives under
//! %APPDATA%\Nax-Notepad so the app can be reinstalled without losing state.
//!
//! Also home of the safe file-replacement helpers used for every save.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Portable mode: when a file named `portable.txt` sits next to the program, everything is
/// stored in the `data` folder beside it instead of %APPDATA%.
pub fn portable_dir() -> Option<PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        dir.join("portable.txt").is_file().then(|| dir.join("data"))
    })
    .clone()
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = portable_dir() {
        return dir;
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir());
    base.join("Nax-Notepad")
}

pub fn buffers_dir() -> PathBuf {
    data_dir().join("buffers")
}

fn ensure_dirs() -> Result<(), String> {
    fs::create_dir_all(buffers_dir()).map_err(|e| format!("Cannot create data dir: {e}"))
}

/// Suffix of every temporary file this app creates next to a save target.
pub const TEMP_SUFFIX: &str = ".naxtmp";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Create a new, uniquely named temporary file next to `target`. The file is created with
/// `create_new`, so an existing file is never opened or overwritten.
pub fn create_temp_sibling(target: &Path) -> Result<(PathBuf, File), String> {
    let dir = match target.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mut last_err = None;
    for _ in 0..32 {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = dir.join(format!(".{name}.{}-{nanos:x}-{n}{TEMP_SUFFIX}", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                last_err = Some(e);
                break;
            }
        }
    }
    Err(format!(
        "Cannot create a temporary file next to {}: {}",
        target.display(),
        last_err.map(|e| e.to_string()).unwrap_or_else(|| "name collision".into())
    ))
}

/// One lock per target path, so overlapping writes to the same file are serialised.
pub fn target_lock(target: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = target.to_string_lossy().to_lowercase();
    let mut map = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Atomic write: write a unique sibling temp file, flush it to disk, then rename it over the
/// target. On any failure the target is untouched and the temp file is removed.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let lock = target_lock(path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let (tmp, mut file) = create_temp_sibling(path)?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Cannot write {}: {e}", path.display()));
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Cannot replace {}: {e}", path.display()));
    }
    Ok(())
}

/// Everything the frontend needs to rebuild a tab. Opaque to Rust apart from `id`, `path`
/// and `kind`; the frontend owns the schema.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TabMeta {
    pub id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub kind: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Session {
    #[serde(default)]
    pub tabs: Vec<TabMeta>,
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub next_untitled: u32,
}

pub fn load_session() -> Session {
    let p = data_dir().join("session.json");
    match fs::read(&p) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Session::default(),
    }
}

pub fn save_session(s: &Session) -> Result<(), String> {
    ensure_dirs()?;
    let bytes = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(&data_dir().join("session.json"), &bytes)
}

pub fn buffer_path(id: &str) -> PathBuf {
    buffers_dir().join(format!("{}.txt", sanitize(id)))
}

pub fn edits_paths(id: &str) -> (PathBuf, PathBuf) {
    let base = buffers_dir();
    (
        base.join(format!("{}.pieces.json", sanitize(id))),
        base.join(format!("{}.add", sanitize(id))),
    )
}

fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

pub fn store_buffer(id: &str, text: &str) -> Result<(), String> {
    ensure_dirs()?;
    write_atomic(&buffer_path(id), text.as_bytes())
}

pub fn load_buffer(id: &str) -> Option<String> {
    fs::read_to_string(buffer_path(id)).ok()
}

pub fn drop_buffer(id: &str) {
    let _ = fs::remove_file(buffer_path(id));
    let (p, a) = edits_paths(id);
    let _ = fs::remove_file(p);
    let _ = fs::remove_file(a);
}

/// Remove buffer files that belong to no tab in `s`. Temporary files of writes that may still
/// be in progress are left alone unless they are older than an hour.
pub fn prune_buffers(s: &Session) {
    let keep: std::collections::HashSet<String> = s.tabs.iter().map(|t| sanitize(&t.id)).collect();
    if let Ok(rd) = fs::read_dir(buffers_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(TEMP_SUFFIX) {
                let stale = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map(|age| age.as_secs() > 3600)
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_file(e.path());
                }
                continue;
            }
            let stem = name.split('.').next().unwrap_or("").to_string();
            if !keep.contains(&stem) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

pub fn load_settings() -> serde_json::Value {
    let p = data_dir().join("settings.json");
    fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Object(Default::default()))
}

pub fn save_settings(v: &serde_json::Value) -> Result<(), String> {
    ensure_dirs()?;
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    write_atomic(&data_dir().join("settings.json"), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_save_preserves_neighbor_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("notes.txt");
        let neighbor = dir.path().join("notes.tmp");
        std::fs::write(&neighbor, b"unrelated valuable file").unwrap();
        write_atomic(&target, b"saved text").unwrap();
        assert_eq!(std::fs::read(&neighbor).unwrap(), b"unrelated valuable file");
        assert_eq!(std::fs::read(&target).unwrap(), b"saved text");
        // No temporary files are left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(TEMP_SUFFIX))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn same_stem_targets_do_not_share_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("report.txt");
        let b = dir.path().join("report.md");
        write_atomic(&a, b"txt").unwrap();
        write_atomic(&b, b"md").unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), b"txt");
        assert_eq!(std::fs::read(&b).unwrap(), b"md");
    }

    #[test]
    fn failed_replace_leaves_target_and_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a-directory");
        std::fs::create_dir(&target).unwrap();
        assert!(write_atomic(&target, b"x").is_err());
        assert!(target.is_dir());
        let leftovers = std::fs::read_dir(dir.path()).unwrap().flatten().count();
        assert_eq!(leftovers, 1, "only the directory itself should remain");
    }
}
