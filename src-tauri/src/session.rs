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

/// Lock `dir` for this process: the returned file stays open, and while it is open a second
/// copy of the app cannot lock the same folder. Two copies sharing one data folder would delete
/// each other's unsaved text when they save their sessions.
pub fn lock_data_dir(dir: &Path) -> std::io::Result<File> {
    fs::create_dir_all(dir)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options.open(dir.join("instance.lock"))
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
    let key = lock_key(target);
    let mut map = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// The key of a path's lock: the canonical path (symbolic links, junctions, "..", "/" and "\\"
/// resolved), or the canonical folder plus the name for a file that does not exist yet.
fn lock_key(target: &Path) -> String {
    let canonical = fs::canonicalize(target).ok().or_else(|| {
        let name = target.file_name()?;
        let dir = target.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
        fs::canonicalize(dir).ok().map(|d| d.join(name))
    });
    canonical.unwrap_or_else(|| target.to_path_buf()).to_string_lossy().to_lowercase()
}

/// Atomic write: write a unique sibling temp file, flush it to disk, then put it in place of
/// the target. On any failure the target is untouched and the temp file is removed.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    replace_atomic(path, |file| file.write_all(bytes))
}

/// Like [`write_atomic`], but the new content is produced by `write` (for streaming large files).
/// The target is only replaced when `write` and the flush to disk succeeded.
pub fn replace_atomic(path: &Path, write: impl FnOnce(&mut File) -> std::io::Result<()>) -> Result<(), String> {
    replace_atomic_checked(path, || Ok(()), write)
}

/// [`replace_atomic`] that runs `check` (for example "the file was not changed by another
/// program") while holding the lock, so two saves cannot both pass it before either writes.
pub fn replace_atomic_checked(path: &Path, check: impl FnOnce() -> Result<(), String>, write: impl FnOnce(&mut File) -> std::io::Result<()>) -> Result<(), String> {
    let lock = target_lock(path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    replace_atomic_locked_checked(path, check, write)
}

/// [`replace_atomic`] for a caller that already holds the target lock.
///
/// A symbolic link is followed, so the file it points to is updated and the link stays. A file
/// with several hard links is rewritten in place (after a backup copy), because replacing it
/// would leave the other names with the old content. Otherwise the file is replaced in a way
/// that keeps its attributes (such as Hidden) and its permissions.
fn replace_atomic_locked(path: &Path, write: impl FnOnce(&mut File) -> std::io::Result<()>) -> Result<(), String> {
    replace_atomic_locked_checked(path, || Ok(()), write)
}

fn replace_atomic_locked_checked(path: &Path, check: impl FnOnce() -> Result<(), String>, write: impl FnOnce(&mut File) -> std::io::Result<()>) -> Result<(), String> {
    let target = resolve_links(path);
    if hard_link_count(&target) > 1 {
        // Hard links give one file several paths, so the path lock is not enough: these saves
        // also lock the file itself, and `check` runs under that lock. Its identity stays the
        // same, because it is rewritten in place. This lock is always taken last, so it cannot
        // deadlock.
        let file_lock = file_lock(&target);
        let _file_guard = file_lock.as_ref().map(|l| l.lock().unwrap_or_else(|e| e.into_inner()));
        check()?;
        return rewrite_in_place(&target, write);
    }
    check()?;
    let (tmp, mut file) = create_temp_sibling(&target)?;
    let written = write(&mut file).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Cannot write {}: {e}", path.display()));
    }
    if let Err(e) = replace_file(&tmp, &target) {
        return Err(failed_replace_message(path, &target, &tmp, &e));
    }
    Ok(())
}

/// Clean up after `replace_file(tmp, target)` failed and describe the failure. ReplaceFile can
/// fail after it already moved the original away; then the temporary file holds the only copy
/// of the content and is kept.
pub fn failed_replace_message(shown: &Path, target: &Path, tmp: &Path, e: &std::io::Error) -> String {
    if target.exists() {
        let _ = fs::remove_file(tmp);
        format!("Cannot replace {}: {e}", shown.display())
    } else {
        format!("Cannot replace {}: {e}. The saved content is kept in {}", shown.display(), tmp.display())
    }
}

/// The file a path finally refers to, following symbolic links (at most 32 steps).
pub fn resolve_links(path: &Path) -> PathBuf {
    let mut p = path.to_path_buf();
    for _ in 0..32 {
        match fs::symlink_metadata(&p) {
            Ok(m) if m.file_type().is_symlink() => match fs::read_link(&p) {
                Ok(t) if t.is_absolute() => p = t,
                Ok(t) => p = p.parent().map(|d| d.join(&t)).unwrap_or(t),
                Err(_) => break,
            },
            _ => break,
        }
    }
    p
}

/// Folder with one note per in-place rewrite that is in progress (see [`rewrite_in_place`]).
fn rewrites_dir() -> PathBuf {
    #[cfg(test)]
    return std::env::temp_dir().join("nax-notepad-test-rewrites");
    #[cfg(not(test))]
    data_dir().join("rewrites")
}

/// Identity of a file (volume and file index); every hard link of a file has the same one.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
struct FileId {
    volume: u64,
    index: u64,
}

/// What an in-place rewrite needs to be finished after a crash: the complete new content in
/// `new`, the previous content in `backup`, and the identity of the file it is meant for.
#[derive(Serialize, Deserialize)]
struct RewriteNote {
    target: PathBuf,
    new: PathBuf,
    backup: PathBuf,
    id: Option<FileId>,
    /// Seconds since 1970 when the rewrite started.
    started: u64,
}

/// A note that could not be finished is dropped after this long (its files stay where they are).
const NOTE_MAX_AGE_SECS: u64 = 30 * 24 * 3600;

fn unix_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Rewrite a file in place. Used for files with several hard links, which a replacement would
/// separate.
fn rewrite_in_place(target: &Path, write: impl FnOnce(&mut File) -> std::io::Result<()>) -> Result<(), String> {
    rewrite_in_place_noted(target, write, &rewrites_dir())
}

fn rewrite_in_place_noted(target: &Path, write: impl FnOnce(&mut File) -> std::io::Result<()>, notes: &Path) -> Result<(), String> {
    // The new content and a backup are written next to the file before it is rewritten, which
    // needs about twice its size in free space.
    let size = fs::metadata(target).map(|m| m.len()).unwrap_or(0);
    ensure_free_space(target, size.saturating_mul(2).saturating_add(1 << 20))?;
    // The new content is written to a temporary copy first. The file itself is not touched yet,
    // so `write` may still read from it (a hex patch streams the file it patches).
    let (new, mut f) = create_temp_sibling(target)?;
    let written = write(&mut f).and_then(|_| f.sync_all());
    drop(f);
    if let Err(e) = written {
        let _ = fs::remove_file(&new);
        return Err(format!("Cannot write {}: {e}", target.display()));
    }
    // Now the new size is known: the backup takes the old size and the file may grow to the new.
    let new_size = fs::metadata(&new).map(|m| m.len()).unwrap_or(0);
    if let Err(e) = ensure_free_space(target, size.max(new_size).saturating_add(1 << 20)) {
        let _ = fs::remove_file(&new);
        return Err(e);
    }
    // A backup of the previous content, for a copy that fails with an error.
    let backup = match create_temp_sibling(target) {
        Ok((b, f)) => {
            drop(f);
            b
        }
        Err(e) => {
            let _ = fs::remove_file(&new);
            return Err(e);
        }
    };
    let remove_temps = || {
        let _ = fs::remove_file(&new);
        let _ = fs::remove_file(&backup);
    };
    if let Err(e) = copy_into(target, &backup) {
        remove_temps();
        return Err(format!("Cannot back up {}: {e}", target.display()));
    }
    // While the file is rewritten, a note says where the new content is, so the next start
    // finishes the save if the app or the computer stops in the middle. The note stays open
    // and locked until the end, so another running copy of the app leaves it alone.
    let note = RewriteNote { target: target.to_path_buf(), new: new.clone(), backup: backup.clone(), id: file_info(target).map(|(_, id)| id), started: unix_secs() };
    drop_notes_for(notes, &note);
    let (note_path, note_file) = match write_rewrite_note(notes, &note) {
        Ok(n) => n,
        Err(e) => {
            remove_temps();
            return Err(format!("Cannot prepare saving {}: {e}", target.display()));
        }
    };
    match copy_into(&new, target) {
        Ok(()) => {
            let _ = fs::remove_file(&note_path);
            drop(note_file);
            remove_temps();
            Ok(())
        }
        Err(e) => {
            if copy_into(&backup, target).is_ok() {
                let _ = fs::remove_file(&note_path);
                drop(note_file);
                remove_temps();
                Err(format!("Cannot write {}: {e}", target.display()))
            } else {
                // The user is told about this failure and where both versions are, so the note
                // goes: a later start must not finish a save that was reported as failed.
                let _ = fs::remove_file(&note_path);
                drop(note_file);
                Err(format!("Cannot write {}: {e}. The new content is kept in {} and the previous content in {}", target.display(), new.display(), backup.display()))
            }
        }
    }
}

/// Refuse with a clear message when the drive of `target` has less than `needed` bytes free.
fn ensure_free_space(target: &Path, needed: u64) -> Result<(), String> {
    let dir = target.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    match free_space(dir) {
        Some(free) if free < needed => Err(format!(
            "Not enough free space to save {} safely: about {} MB are needed next to it, {} MB are free.",
            target.display(),
            needed.div_ceil(1 << 20),
            free / (1 << 20)
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
thread_local! {
    /// Test hook: the free space `free_space` reports.
    static FAKE_FREE_SPACE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    #[cfg(test)]
    if let Some(v) = FAKE_FREE_SPACE.with(|f| f.get()) {
        return Some(v);
    }
    let mut free: u64 = 0;
    // SAFETY: the path is a NUL-terminated wide string; the other pointers may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide(dir).as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn free_space(_dir: &Path) -> Option<u64> {
    None
}

/// Remove the notes of earlier, unfinished rewrites of the same file: the save that is starting
/// now writes newer content, so those must never be applied later. Notes that are still open
/// belong to a save in progress and are left alone.
fn drop_notes_for(notes: &Path, current: &RewriteNote) {
    let Ok(rd) = fs::read_dir(notes) else { return };
    for e in rd.flatten() {
        let Some(old) = fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<RewriteNote>(&b).ok()) else { continue };
        let same = match (old.id, current.id) {
            (Some(a), Some(b)) => a == b,
            _ => lock_key(&old.target) == lock_key(&current.target),
        };
        if same {
            // Only the note goes. Its copies may have been listed to the user at a start where
            // the save could not be finished, and they may be the only complete versions.
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Write `note` into a new file in `notes` and keep that file open. On Windows nobody else can
/// read it while it is open, which is how a second start of the app knows the save is running.
fn write_rewrite_note(notes: &Path, note: &RewriteNote) -> Result<(PathBuf, File), String> {
    fs::create_dir_all(notes).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec(note).map_err(|e| e.to_string())?;
    let mut last_err = None;
    for _ in 0..32 {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = notes.join(format!("{}-{:x}-{n}.json", std::process::id(), unix_secs()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE);
        }
        match options.open(&path) {
            Ok(mut f) => {
                if let Err(e) = f.write_all(&json).and_then(|_| f.sync_all()) {
                    drop(f);
                    let _ = fs::remove_file(&path);
                    return Err(e.to_string());
                }
                return Ok((path, f));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                last_err = Some(e);
                break;
            }
        }
    }
    Err(last_err.map(|e| e.to_string()).unwrap_or_else(|| "name collision".into()))
}

/// Copy the content of `src` over the content of the existing file `dst` without replacing it,
/// so every hard link of `dst` sees it.
fn copy_into(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut s = File::open(src)?;
    let mut d = OpenOptions::new().write(true).truncate(true).open(dst)?;
    std::io::copy(&mut s, &mut d)?;
    d.sync_all()
}

/// A file whose interrupted in-place rewrite was dealt with at start.
#[derive(Debug, PartialEq, Eq)]
pub struct Recovered {
    pub target: PathBuf,
    /// True when the file got the content that was being saved. False when the save could not
    /// be finished safely: the file was left as it is, and `kept` lists the copies of the
    /// content that was being saved and of the previous content.
    pub finished: bool,
    pub kept: Vec<PathBuf>,
}

/// Finish in-place rewrites that were interrupted (the app or the computer stopped in the
/// middle of a save). A file only gets the content that was being saved while it is still in
/// the state such a stop leaves; a file that was changed since then is never overwritten.
pub fn recover_interrupted_rewrites() -> Vec<Recovered> {
    recover_rewrites_in(&rewrites_dir())
}

/// True when the content of `part` is the beginning of the content of `whole` (or all of it
/// when `exact`).
fn file_starts_with(whole: &Path, part: &Path, exact: bool) -> bool {
    use std::io::Read;
    let (Ok(mut w), Ok(mut p)) = (File::open(whole), File::open(part)) else { return false };
    let (Ok(wl), Ok(pl)) = (w.metadata().map(|m| m.len()), p.metadata().map(|m| m.len())) else { return false };
    if pl > wl || (exact && pl != wl) {
        return false;
    }
    let (mut a, mut b) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let n = match p.read(&mut b) {
            Ok(0) => return true,
            Ok(n) => n,
            Err(_) => return false,
        };
        if w.read_exact(&mut a[..n]).is_err() || a[..n] != b[..n] {
            return false;
        }
    }
}

fn recover_rewrites_in(notes: &Path) -> Vec<Recovered> {
    let mut finished = Vec::new();
    let Ok(rd) = fs::read_dir(notes) else { return finished };
    for e in rd.flatten() {
        // A note that cannot be read is still open: another copy of the app is saving. One that
        // stays unreadable for a long time is dropped.
        let Ok(bytes) = fs::read(e.path()) else {
            let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > NOTE_MAX_AGE_SECS);
            if old {
                let _ = fs::remove_file(e.path());
            }
            continue;
        };
        // A note that is not complete was never closed normally, but it is written before the
        // file is touched, so the file is unchanged.
        let Ok(note) = serde_json::from_slice::<RewriteNote>(&bytes) else {
            let _ = fs::remove_file(e.path());
            continue;
        };
        let kept: Vec<PathBuf> = [&note.new, &note.backup].into_iter().filter(|p| p.is_file()).cloned().collect();
        let failed = |keep_note: bool, finished: &mut Vec<Recovered>| {
            if !keep_note {
                let _ = fs::remove_file(e.path());
            }
            if !kept.is_empty() {
                finished.push(Recovered { target: note.target.clone(), finished: false, kept: kept.clone() });
            }
        };
        match file_info(&note.target) {
            // The file is not there or cannot be opened (a drive that is not connected, a file
            // another program holds): try again at a later start, for a limited time.
            None => {
                failed(unix_secs().saturating_sub(note.started) <= NOTE_MAX_AGE_SECS, &mut finished);
                continue;
            }
            // Another file now has this path: never overwrite it.
            Some((_, id)) if note.id.is_some_and(|n| n != id) => {
                failed(false, &mut finished);
                continue;
            }
            Some(_) => {}
        }
        if !note.new.is_file() {
            // Without the new content nothing can be checked or finished. If the file still has
            // its previous content, nothing was lost.
            if note.backup.is_file() && file_starts_with(&note.target, &note.backup, true) {
                let _ = fs::remove_file(e.path());
                let _ = fs::remove_file(&note.backup);
            } else {
                failed(false, &mut finished);
            }
            continue;
        }
        // A stop during the save leaves the previous content (the copy had not started) or a
        // beginning of the new content. Anything else was written after the stop.
        let untouched = (note.backup.is_file() && file_starts_with(&note.target, &note.backup, true)) || file_starts_with(&note.new, &note.target, false);
        if !untouched {
            failed(false, &mut finished);
            continue;
        }
        if copy_into(&note.new, &note.target).is_err() {
            failed(true, &mut finished);
            continue;
        }
        let _ = fs::remove_file(e.path());
        let _ = fs::remove_file(&note.new);
        let _ = fs::remove_file(&note.backup);
        finished.push(Recovered { target: note.target, finished: true, kept: Vec::new() });
    }
    finished
}

/// The lock shared by every path of an existing file (keyed by its identity). Only used for
/// files with several hard links, so the map stays small.
fn file_lock(target: &Path) -> Option<Arc<Mutex<()>>> {
    static LOCKS: OnceLock<Mutex<HashMap<FileId, Arc<Mutex<()>>>>> = OnceLock::new();
    let (_, id) = file_info(target)?;
    let mut map = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    Some(map.entry(id).or_insert_with(|| Arc::new(Mutex::new(()))).clone())
}

/// Number of hard links and identity of a file, if it can be opened.
#[cfg(windows)]
fn file_info(path: &Path) -> Option<(u32, FileId)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let f = File::open(path).ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle belongs to `f`, which lives until the end of this function.
    let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) };
    (ok != 0).then(|| {
        let id = FileId { volume: info.dwVolumeSerialNumber as u64, index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64 };
        (info.nNumberOfLinks, id)
    })
}

#[cfg(not(windows))]
fn file_info(path: &Path) -> Option<(u32, FileId)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(path).ok()?;
    Some((m.nlink() as u32, FileId { volume: m.dev(), index: m.ino() }))
}

/// Number of directory entries (hard links) that refer to the file; 1 if unknown.
pub fn hard_link_count(path: &Path) -> u32 {
    file_info(path).map(|(n, _)| n.max(1)).unwrap_or(1)
}

#[cfg(windows)]
fn wide(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// File attributes (Hidden, System, ...) of a file, if it exists.
#[cfg(windows)]
pub fn file_attributes(path: &Path) -> Option<u32> {
    use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesW, INVALID_FILE_ATTRIBUTES};
    // SAFETY: the path is a NUL-terminated wide string.
    let a = unsafe { GetFileAttributesW(wide(path).as_ptr()) };
    (a != INVALID_FILE_ATTRIBUTES).then_some(a)
}

#[cfg(not(windows))]
pub fn file_attributes(_path: &Path) -> Option<u32> {
    None
}

/// Give `path` the attributes a previous file had (only the ones a user can set).
#[cfg(windows)]
pub fn restore_attributes(path: &Path, attrs: Option<u32>) {
    use windows_sys::Win32::Storage::FileSystem::{
        SetFileAttributesW, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_SYSTEM,
    };
    if let Some(a) = attrs {
        let keep = a & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED);
        if keep != 0 {
            // SAFETY: the path is a NUL-terminated wide string.
            unsafe { SetFileAttributesW(wide(path).as_ptr(), keep) };
        }
    }
}

#[cfg(not(windows))]
pub fn restore_attributes(_path: &Path, _attrs: Option<u32>) {}

#[cfg(test)]
thread_local! {
    /// Test hook: `replace_file` behaves like ReplaceFile failing after it moved the target away.
    pub static FAIL_REPLACE_AFTER_MOVING_TARGET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Put `tmp` in place of `target`. An existing target keeps its attributes and permissions
/// (Windows ReplaceFile); a new target is created by renaming. When this fails, the caller must
/// check whether `target` still exists before removing `tmp` ([`failed_replace_message`]).
pub fn replace_file(tmp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_REPLACE_AFTER_MOVING_TARGET.with(|f| f.get()) {
        let _ = fs::remove_file(target);
        return Err(std::io::Error::other("simulated ERROR_UNABLE_TO_MOVE_REPLACEMENT"));
    }
    replace_file_os(tmp, target)
}

#[cfg(windows)]
fn replace_file_os(tmp: &Path, target: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_ACL_ERRORS, REPLACEFILE_IGNORE_MERGE_ERRORS};
    let attrs = file_attributes(target);
    if attrs.is_none() {
        return fs::rename(tmp, target);
    }
    // SAFETY: both paths are NUL-terminated wide strings; the optional pointers are null.
    let ok = unsafe {
        ReplaceFileW(
            wide(target).as_ptr(),
            wide(tmp).as_ptr(),
            std::ptr::null(),
            REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        // ReplaceFile can refuse on some file systems; a plain rename still replaces atomically.
        // It can also fail after moving the target away (ERROR_UNABLE_TO_MOVE_REPLACEMENT); the
        // rename then puts the new content in place, and if that fails too the caller keeps tmp.
        fs::rename(tmp, target)?;
    }
    restore_attributes(target, attrs);
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_os(tmp: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(tmp, target)
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

/// Highest generation dropped per buffer id. A store with an older generation started before
/// the drop (the document was saved meanwhile) and must not bring the buffer back.
fn dropped_generations() -> &'static Mutex<HashMap<String, u64>> {
    static MAP: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

/// Store unsaved text unless the buffer was dropped with this or a newer generation.
pub fn store_buffer_gen(id: &str, text: &str, generation: Option<u64>) -> Result<(), String> {
    ensure_dirs()?;
    store_generation(&buffer_path(id), id, text, generation)
}

fn store_generation(path: &Path, id: &str, text: &str, generation: Option<u64>) -> Result<(), String> {
    let lock = target_lock(path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(g) = generation {
        let dropped = dropped_generations().lock().unwrap_or_else(|e| e.into_inner()).get(id).copied().unwrap_or(0);
        if g <= dropped {
            return Ok(());
        }
    }
    replace_atomic_locked(path, |f| f.write_all(text.as_bytes()))
}

/// A new number for every page load of the frontend. Tab revisions start again after a reload,
/// so recovery-buffer generations include this number to stay above those of earlier loads.
pub fn next_buffer_epoch() -> u64 {
    static EPOCH: AtomicU64 = AtomicU64::new(0);
    EPOCH.fetch_add(1, Ordering::Relaxed) + 1
}

/// Delete the stored buffer and edit log; stores of `generation` or older are ignored afterwards.
pub fn drop_buffer_gen(id: &str, generation: Option<u64>) {
    let (pieces, add) = edits_paths(id);
    drop_generation(&buffer_path(id), &[&pieces, &add], id, generation);
}

fn drop_generation(path: &Path, extra: &[&Path], id: &str, generation: Option<u64>) {
    let lock = target_lock(path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(g) = generation {
        let mut map = dropped_generations().lock().unwrap_or_else(|e| e.into_inner());
        let e = map.entry(id.to_string()).or_insert(0);
        *e = (*e).max(g);
    }
    let _ = fs::remove_file(path);
    for p in extra {
        let _ = fs::remove_file(p);
    }
}

/// True when unsaved text or a large-file edit log is stored for `id`.
pub fn has_recovery(id: &str) -> bool {
    let (pieces, _) = edits_paths(id);
    buffer_path(id).is_file() || pieces.is_file()
}

pub fn load_buffer(id: &str) -> Option<String> {
    fs::read_to_string(buffer_path(id)).ok()
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
    fn late_recovery_write_after_save_does_not_bring_old_text_back() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("tab1.txt");
        store_generation(&p, "late-write-test", "typed before saving", Some(1)).unwrap();
        // The document is saved: the buffer is dropped with the current generation.
        drop_generation(&p, &[], "late-write-test", Some(2));
        assert!(!p.exists());
        // A write that started before the save finishes afterwards: it must be ignored.
        store_generation(&p, "late-write-test", "typed before saving", Some(2)).unwrap();
        assert!(!p.exists(), "a stale write must not leave a buffer behind");
        // New edits after the save are stored again.
        store_generation(&p, "late-write-test", "typed after saving", Some(3)).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "typed after saving");
    }

    #[test]
    fn saving_updates_every_hard_link_name_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        std::fs::write(&a, b"old").unwrap();
        std::fs::hard_link(&a, &b).unwrap();
        write_atomic(&a, b"new content").unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), b"new content");
        assert_eq!(std::fs::read(&b).unwrap(), b"new content", "the other name must see the saved text");
        let leftovers = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(TEMP_SUFFIX)).count();
        assert_eq!(leftovers, 0);
    }

    #[cfg(windows)]
    #[test]
    fn saving_keeps_the_hidden_attribute() {
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("secret.txt");
        std::fs::write(&p, b"old").unwrap();
        restore_attributes(&p, Some(FILE_ATTRIBUTE_HIDDEN));
        assert!(file_attributes(&p).unwrap() & FILE_ATTRIBUTE_HIDDEN != 0);
        write_atomic(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        assert!(file_attributes(&p).unwrap() & FILE_ATTRIBUTE_HIDDEN != 0, "the file must stay hidden");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs permission to create symbolic links (Windows Developer Mode); run with --ignored"]
    fn saving_through_a_symbolic_link_updates_the_linked_file() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.txt");
        let link = dir.path().join("link.txt");
        std::fs::write(&real, b"old").unwrap();
        if let Err(e) = std::os::windows::fs::symlink_file(&real, &link) {
            panic!("this test needs permission to create symbolic links (Developer Mode): {e}");
        }
        write_atomic(&link, b"new").unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link must stay a link");
        assert_eq!(std::fs::read(&real).unwrap(), b"new");
    }

    #[test]
    fn failed_replace_after_the_original_was_moved_away_keeps_the_new_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("doc.txt");
        std::fs::write(&p, b"old").unwrap();
        FAIL_REPLACE_AFTER_MOVING_TARGET.with(|f| f.set(true));
        let result = write_atomic(&p, b"new content");
        FAIL_REPLACE_AFTER_MOVING_TARGET.with(|f| f.set(false));
        let err = result.unwrap_err();
        assert!(!p.exists());
        let kept: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with(TEMP_SUFFIX)).collect();
        assert_eq!(kept.len(), 1, "the only copy of the new content must stay");
        assert_eq!(std::fs::read(&kept[0]).unwrap(), b"new content");
        assert!(err.contains(&kept[0].display().to_string()), "the message must say where it is: {err}");
    }

    /// The state a crash in the middle of an in-place rewrite leaves behind.
    fn crashed_rewrite(dir: &Path, notes: &Path, target: &Path) -> (PathBuf, PathBuf, File) {
        let new = dir.join(".a.txt.new.naxtmp");
        let backup = dir.join(".a.txt.backup.naxtmp");
        std::fs::write(&new, b"new content").unwrap();
        std::fs::copy(target, &backup).unwrap();
        let note = RewriteNote { target: target.to_path_buf(), new: new.clone(), backup: backup.clone(), id: file_info(target).map(|(_, id)| id), started: unix_secs() };
        let (_, handle) = write_rewrite_note(notes, &note).unwrap();
        std::fs::OpenOptions::new().write(true).truncate(true).open(target).unwrap().write_all(b"new con").unwrap();
        (new, backup, handle)
    }

    #[test]
    fn interrupted_save_of_a_hard_linked_file_is_finished_at_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        std::fs::write(&a, b"original content").unwrap();
        std::fs::hard_link(&a, &b).unwrap();
        let (new, backup, handle) = crashed_rewrite(dir.path(), &notes, &a);
        drop(handle); // the process that was saving is gone
        let finished = recover_rewrites_in(&notes);
        assert_eq!(finished, vec![Recovered { target: a.clone(), finished: true, kept: vec![] }]);
        assert_eq!(std::fs::read(&a).unwrap(), b"new content");
        assert_eq!(std::fs::read(&b).unwrap(), b"new content", "both names must show the saved content");
        assert!(!backup.exists() && !new.exists());
        assert_eq!(std::fs::read_dir(&notes).unwrap().count(), 0);
        // A completed save leaves no note behind.
        rewrite_in_place_noted(&a, |f| f.write_all(b"saved"), &notes).unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), b"saved");
        assert_eq!(std::fs::read_dir(&notes).unwrap().count(), 0);
        let leftovers = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(TEMP_SUFFIX)).count();
        assert_eq!(leftovers, 0);
    }

    #[cfg(windows)]
    #[test]
    fn a_save_in_progress_is_not_touched_by_a_second_start_of_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let a = dir.path().join("a.txt");
        std::fs::write(&a, b"original content").unwrap();
        let (new, backup, handle) = crashed_rewrite(dir.path(), &notes, &a);
        // The note is still open: the first copy of the app is in the middle of saving.
        assert!(recover_rewrites_in(&notes).is_empty());
        assert_eq!(std::fs::read(&a).unwrap(), b"new con");
        assert!(new.exists() && backup.exists());
        assert_eq!(std::fs::read_dir(&notes).unwrap().count(), 1);
        drop(handle);
    }

    #[test]
    fn an_unfinished_save_never_overwrites_a_different_file_at_the_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let a = dir.path().join("a.txt");
        std::fs::write(&a, b"original content").unwrap();
        let (new, _backup, handle) = crashed_rewrite(dir.path(), &notes, &a);
        drop(handle);
        // The file was deleted and the user made a new one with the same name.
        std::fs::remove_file(&a).unwrap();
        std::fs::write(&a, b"a different file").unwrap();
        let report = recover_rewrites_in(&notes);
        assert_eq!(report.len(), 1);
        assert!(!report[0].finished && report[0].kept.contains(&new), "the user is told where the content is");
        assert_eq!(std::fs::read(&a).unwrap(), b"a different file");
        assert_eq!(std::fs::read_dir(&notes).unwrap().count(), 0, "the note is dropped");
        assert!(new.exists(), "the content that was being saved is still there for the user");
    }

    #[test]
    fn a_failed_save_that_was_reported_is_not_finished_at_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let a = dir.path().join("a.txt");
        std::fs::write(&a, b"original content").unwrap();
        // Copying into the file fails (it is opened read-only) and so does putting it back.
        let mut perms = std::fs::metadata(&a).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&a, perms.clone()).unwrap();
        let result = rewrite_in_place_noted(&a, |f| f.write_all(b"v2"), &notes);
        perms.set_readonly(false);
        std::fs::set_permissions(&a, perms).unwrap();
        let err = result.unwrap_err();
        assert!(err.contains("The new content is kept in"), "{err}");
        assert_eq!(std::fs::read_dir(&notes).map(|d| d.count()).unwrap_or(0), 0, "no note may remain");
        assert_eq!(std::fs::read(&a).unwrap(), b"original content");
        std::fs::write(&a, b"v3 saved later").unwrap();
        assert!(recover_rewrites_in(&notes).is_empty());
        assert_eq!(std::fs::read(&a).unwrap(), b"v3 saved later");
    }

    #[test]
    fn two_names_of_one_file_share_one_save_lock() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        let c = dir.path().join("c.txt");
        std::fs::write(&a, b"x").unwrap();
        std::fs::hard_link(&a, &b).unwrap();
        std::fs::write(&c, b"y").unwrap();
        assert!(Arc::ptr_eq(&file_lock(&a).unwrap(), &file_lock(&b).unwrap()));
        assert!(!Arc::ptr_eq(&file_lock(&a).unwrap(), &file_lock(&c).unwrap()));
    }

    #[cfg(windows)]
    #[test]
    fn a_second_copy_cannot_use_the_same_portable_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_data_dir(dir.path()).unwrap();
        assert!(lock_data_dir(dir.path()).is_err(), "the folder is in use");
        drop(first);
        assert!(lock_data_dir(dir.path()).is_ok(), "free again after the first copy ends");
    }

    #[test]
    fn an_interrupted_save_whose_new_content_is_gone_is_reported_and_the_file_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let a = dir.path().join("a.txt");
        std::fs::write(&a, b"original content").unwrap();
        let (new, backup, handle) = crashed_rewrite(dir.path(), &notes, &a);
        drop(handle);
        std::fs::remove_file(&new).unwrap();
        assert_eq!(recover_rewrites_in(&notes), vec![Recovered { target: a.clone(), finished: false, kept: vec![backup.clone()] }]);
        assert_eq!(std::fs::read(&a).unwrap(), b"new con", "nothing is written without the new content to check against");
        assert!(backup.exists(), "the previous content stays for the user");
        assert_eq!(std::fs::read_dir(&notes).unwrap().count(), 0);
    }

    #[test]
    fn a_file_changed_after_a_crash_is_not_overwritten_by_the_unfinished_save() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let a = dir.path().join("a.txt");
        std::fs::write(&a, b"original content").unwrap();
        let (new, backup, handle) = crashed_rewrite(dir.path(), &notes, &a);
        drop(handle);
        // Another editor repairs the file in place before the next start.
        std::fs::OpenOptions::new().write(true).truncate(true).open(&a).unwrap().write_all(b"repaired by hand").unwrap();
        let report = recover_rewrites_in(&notes);
        assert_eq!(report, vec![Recovered { target: a.clone(), finished: false, kept: vec![new.clone(), backup.clone()] }]);
        assert_eq!(std::fs::read(&a).unwrap(), b"repaired by hand");
        assert_eq!(std::fs::read_dir(&notes).unwrap().count(), 0);
    }

    #[test]
    fn a_newer_save_of_the_same_file_replaces_an_unfinished_one() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        std::fs::write(&a, b"original content").unwrap();
        std::fs::hard_link(&a, &b).unwrap();
        let (new, backup, handle) = crashed_rewrite(dir.path(), &notes, &a);
        drop(handle);
        // The file was locked at the start, so the note stayed; the user saves again.
        rewrite_in_place_noted(&a, |f| f.write_all(b"saved later"), &notes).unwrap();
        assert!(recover_rewrites_in(&notes).is_empty());
        assert_eq!(std::fs::read(&b).unwrap(), b"saved later");
        assert!(new.exists() && backup.exists(), "copies the user may have been told about stay");
    }

    #[test]
    fn a_hard_linked_save_without_enough_free_space_is_refused_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let a = dir.path().join("a.txt");
        std::fs::write(&a, b"content").unwrap();
        FAKE_FREE_SPACE.with(|f| f.set(Some(10)));
        let result = rewrite_in_place_noted(&a, |f| f.write_all(b"new content"), &notes);
        FAKE_FREE_SPACE.with(|f| f.set(None));
        let err = result.unwrap_err();
        assert!(err.contains("Not enough free space"), "{err}");
        assert_eq!(std::fs::read(&a).unwrap(), b"content");
        let leftovers = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(TEMP_SUFFIX)).count();
        assert_eq!(leftovers, 0);
        assert_eq!(std::fs::read_dir(&notes).map(|d| d.count()).unwrap_or(0), 0);
    }

    #[test]
    fn different_spellings_of_one_path_share_one_save_lock() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let a = dir.path().join("a.txt");
        std::fs::write(&a, b"x").unwrap();
        let forward = PathBuf::from(a.display().to_string().replace('\\', "/"));
        let dotted = dir.path().join("sub").join("..").join("a.txt");
        let upper = PathBuf::from(a.display().to_string().to_uppercase());
        for other in [&forward, &dotted, &upper] {
            assert!(Arc::ptr_eq(&target_lock(&a), &target_lock(other)), "{}", other.display());
        }
        // A file that does not exist yet gets the same lock before and after it is created.
        let fresh = dir.path().join("fresh.txt");
        let before = target_lock(&fresh);
        std::fs::write(&fresh, b"y").unwrap();
        assert!(Arc::ptr_eq(&before, &target_lock(&fresh)));
    }

    #[test]
    fn each_page_load_gets_a_higher_recovery_epoch() {
        let a = next_buffer_epoch();
        let b = next_buffer_epoch();
        assert!(b > a && a >= 1);
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
