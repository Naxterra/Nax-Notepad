//! Session persistence: open tabs, unsaved buffers, settings. Everything lives under
//! %APPDATA%\Nax-Notepad so the app can be reinstalled without losing state.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
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

/// Atomic write: write to a sibling temp file, then rename over the target.
pub fn write_atomic(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Cannot replace {}: {e}", path.display()))
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

/// Remove buffer files that belong to no tab in `s`.
pub fn prune_buffers(s: &Session) {
    let keep: std::collections::HashSet<String> = s.tabs.iter().map(|t| sanitize(&t.id)).collect();
    if let Ok(rd) = fs::read_dir(buffers_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
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
