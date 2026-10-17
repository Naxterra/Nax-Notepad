//! Memory-mapped document with a piece table, for files too large to hold in the editor.
//!
//! The original file is mapped read-only. A sparse index records how many line breaks occur
//! before every 1 MiB boundary, so any line <-> byte offset query scans at most one megabyte.
//! Edits are appended to an "add" buffer and the document is described by a list of pieces
//! referencing either the original mapping or the add buffer.
//!
//! Guarantees:
//! - Only UTF-8 files (with or without BOM) are editable. UTF-16 and legacy code pages are
//!   decoded correctly for display but opened read-only, because inserted text would otherwise
//!   be written in the wrong encoding.
//! - Saving writes a uniquely named temporary file and replaces the target only when that
//!   succeeded. If the replacement fails the in-memory document is kept intact.
//! - A save over the opened file is refused when the file changed on disk since it was opened.
//! - Search, count and replace see the logical document, so matches may span piece boundaries.
//! - Replace All stores only the replacement text; unchanged text keeps referencing the file.

use crate::session;
use crate::textfmt::{detect_bom, detect_eol, Bom, Eol};
use encoding_rs::Encoding;
use memchr::memchr_iter;
use memmap2::Mmap;
use regex::bytes::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const CHUNK: usize = 1 << 20;
/// Upper bound for the text of one editor window, so a giant single line cannot exhaust memory.
pub const MAX_WINDOW_BYTES: usize = 16 << 20;
const SEARCH_BLOCK: usize = 8 << 20;
const SEARCH_CONTEXT: usize = 16;
const SEARCH_LOOKAHEAD: usize = 64 << 10;
const SEARCH_LOOKAHEAD_MAX: usize = 64 << 20;
const FINGERPRINT_BYTES: u64 = 64 << 10;
const ENCODING_SAMPLE: usize = 1 << 20;

/// Error prefix for "the file changed on disk since it was opened".
pub const E_EXTERNAL_CHANGE: &str = "E_EXTERNAL_CHANGE:";
/// Error prefix for edits to a document opened read-only because of its encoding.
pub const E_READ_ONLY_ENCODING: &str = "E_READ_ONLY_ENCODING:";
/// Error prefix for scoped operations without a scope.
pub const E_NO_SCOPE: &str = "E_NO_SCOPE:";
/// Error prefix for operations stopped by the user.
pub const E_CANCELLED: &str = "E_CANCELLED:";

/// One match of "find all": 0-based line, byte column, byte length and the line's text.
#[derive(Serialize, Clone, Debug)]
pub struct FoundLine {
    pub line: usize,
    pub col: usize,
    pub len: usize,
    pub text: String,
}

/// Result of checking a followed file for new data.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TailStatus {
    Same,
    Appended,
    Rotated,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Src {
    Orig,
    Add,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Piece {
    pub src: Src,
    pub start: usize,
    pub len: usize,
    pub newlines: usize,
}

/// How a line break is encoded in the mapped file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unit {
    Byte,
    U16Le,
    U16Be,
}

/// What the file on disk looked like when it was opened or last saved: size, modification
/// time with nanosecond resolution, and hashes of its first and last 64 KiB.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskState {
    pub len: u64,
    pub mtime_ns: u64,
    pub head: u64,
    pub tail: u64,
}

impl DiskState {
    pub fn read(path: &Path) -> std::io::Result<DiskState> {
        let mut f = File::open(path)?;
        let meta = f.metadata()?;
        let len = meta.len();
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let mut buf = vec![0u8; FINGERPRINT_BYTES.min(len) as usize];
        f.read_exact(&mut buf)?;
        let head = hash_bytes(&buf);
        let tail_len = FINGERPRINT_BYTES.min(len);
        f.seek(SeekFrom::Start(len - tail_len))?;
        let mut tbuf = vec![0u8; tail_len as usize];
        f.read_exact(&mut tbuf)?;
        let tail = hash_bytes(&tbuf);
        Ok(DiskState { len, mtime_ns, head, tail })
    }

    pub fn mtime_ms(&self) -> u64 {
        self.mtime_ns / 1_000_000
    }
}

fn hash_bytes(b: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    b.hash(&mut h);
    h.finish()
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .to_lowercase()
    };
    norm(a) == norm(b)
}

pub struct PagedDoc {
    pub path: PathBuf,
    mmap: Mmap,
    body_start: usize,
    unit: Unit,
    encoding: &'static Encoding,
    encoding_label: String,
    editable: bool,
    /// lines_before[i] = number of line breaks in orig[0 .. i*CHUNK]
    lines_before: Vec<usize>,
    orig_newlines: usize,
    add: Vec<u8>,
    pieces: Vec<Piece>,
    /// Line ending used for inserted text and, when it differs from `file_eol`, for the whole
    /// document on save.
    pub eol: Eol,
    file_eol: Eol,
    pub bom: Bom,
    total_len: usize,
    total_newlines: usize,
    disk: DiskState,
    /// Set when a failed in-place save left the document backed by its temporary copy.
    backing_temp: Option<PathBuf>,
    /// Byte range for "in selection only" operations; mapped through every edit.
    scope: Option<(usize, usize)>,
}

#[derive(Serialize)]
pub struct Match {
    pub line: usize,
    pub col: usize,
    pub len: usize,
    pub offset: usize,
}

/// Text of an editor window.
pub struct WindowText {
    pub text: String,
    pub first: usize,
    pub count: usize,
    /// The single line was longer than the byte limit and only its start is included.
    pub truncated: bool,
    /// The bytes were not valid in the document's encoding and were decoded with replacements.
    pub lossy: bool,
}

/// Streams bytes while normalising every line ending (CRLF, LF, lone CR) to one style.
struct EolConverter {
    eol: &'static [u8],
    pending_cr: bool,
}

impl EolConverter {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &b in input {
            match b {
                b'\r' => {
                    if self.pending_cr {
                        out.extend_from_slice(self.eol);
                    }
                    self.pending_cr = true;
                }
                b'\n' => {
                    self.pending_cr = false;
                    out.extend_from_slice(self.eol);
                }
                _ => {
                    if self.pending_cr {
                        out.extend_from_slice(self.eol);
                        self.pending_cr = false;
                    }
                    out.push(b);
                }
            }
        }
    }
    fn finish(&mut self, out: &mut Vec<u8>) {
        if self.pending_cr {
            out.extend_from_slice(self.eol);
            self.pending_cr = false;
        }
    }
}

impl PagedDoc {
    pub fn open(path: &Path) -> Result<PagedDoc, String> {
        Self::open_with(path, None)
    }

    /// Open `path`; `forced` is an encoding label chosen by the user ("Reopen with encoding")
    /// instead of detection.
    pub fn open_with(path: &Path, forced: Option<&str>) -> Result<PagedDoc, String> {
        let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        let disk = DiskState::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        // SAFETY: the mapping is read-only. Changes made by other programs while the file is
        // open are detected through `disk` before saving (see `disk_changed`).
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| format!("mmap failed: {e}"))?;
        let bytes: &[u8] = &mmap;
        let (detected_bom, detected_skip) = detect_bom(bytes);
        let (bom, skip, unit, encoding, label, editable): (Bom, usize, Unit, &'static Encoding, String, bool) = match forced {
            Some("UTF-8") | Some("UTF-8-BOM") => {
                if detected_bom == Bom::Utf8 {
                    (Bom::Utf8, 3, Unit::Byte, encoding_rs::UTF_8, "UTF-8-BOM".into(), true)
                } else {
                    (Bom::None, 0, Unit::Byte, encoding_rs::UTF_8, "UTF-8".into(), true)
                }
            }
            Some("UTF-16LE") => {
                let skip = if detected_bom == Bom::Utf16Le { 2 } else { 0 };
                (Bom::Utf16Le, skip, Unit::U16Le, encoding_rs::UTF_16LE, "UTF-16LE".into(), false)
            }
            Some("UTF-16BE") => {
                let skip = if detected_bom == Bom::Utf16Be { 2 } else { 0 };
                (Bom::Utf16Be, skip, Unit::U16Be, encoding_rs::UTF_16BE, "UTF-16BE".into(), false)
            }
            Some(other) => {
                let enc = Encoding::for_label(other.as_bytes()).ok_or_else(|| format!("Unknown encoding: {other}"))?;
                (Bom::None, 0, Unit::Byte, enc, enc.name().to_string(), false)
            }
            None => {
                let sample = &bytes[detected_skip..bytes.len().min(detected_skip + ENCODING_SAMPLE)];
                let (unit, encoding, label, editable): (Unit, &'static Encoding, String, bool) = match detected_bom {
                    Bom::Utf16Le => (Unit::U16Le, encoding_rs::UTF_16LE, "UTF-16LE".into(), false),
                    Bom::Utf16Be => (Unit::U16Be, encoding_rs::UTF_16BE, "UTF-16BE".into(), false),
                    Bom::Utf8 => (Unit::Byte, encoding_rs::UTF_8, "UTF-8-BOM".into(), true),
                    Bom::None => match std::str::from_utf8(sample) {
                        Ok(_) => (Unit::Byte, encoding_rs::UTF_8, "UTF-8".into(), true),
                        // Only an incomplete character at the end of the sample: still UTF-8.
                        Err(e) if e.error_len().is_none() => (Unit::Byte, encoding_rs::UTF_8, "UTF-8".into(), true),
                        Err(_) => {
                            let mut det = chardetng::EncodingDetector::new();
                            det.feed(sample, sample.len() == bytes.len() - detected_skip);
                            let enc = det.guess(None, true);
                            (Unit::Byte, enc, enc.name().to_string(), false)
                        }
                    },
                };
                (detected_bom, detected_skip, unit, encoding, label, editable)
            }
        };
        let eol_sample = &bytes[skip..bytes.len().min(skip + (1 << 16))];
        let eol = if unit == Unit::Byte {
            detect_eol(eol_sample)
        } else {
            let (text, _) = encoding.decode_without_bom_handling(eol_sample);
            detect_eol(text.as_bytes())
        };
        let mut doc = PagedDoc {
            path: path.to_path_buf(),
            mmap,
            body_start: skip,
            unit,
            encoding,
            encoding_label: label,
            editable,
            lines_before: Vec::new(),
            orig_newlines: 0,
            add: Vec::new(),
            pieces: Vec::new(),
            eol,
            file_eol: eol,
            bom,
            total_len: 0,
            total_newlines: 0,
            disk,
            backing_temp: None,
            scope: None,
        };
        doc.build_index();
        let body_len = doc.mmap.len() - skip;
        doc.pieces = vec![Piece {
            src: Src::Orig,
            start: skip,
            len: body_len,
            newlines: doc.orig_newlines,
        }];
        doc.total_len = body_len;
        doc.total_newlines = doc.orig_newlines;
        Ok(doc)
    }

    fn build_index(&mut self) {
        self.build_index_from(0);
    }

    /// (Re)build the line index from chunk `chunk` onwards; earlier entries are kept. Used when
    /// a followed file grows, so only the new part is scanned.
    fn build_index_from(&mut self, chunk: usize) {
        let len = self.mmap.len();
        let chunk = chunk.min(self.lines_before.len().saturating_sub(1));
        let mut lines_before = std::mem::take(&mut self.lines_before);
        lines_before.truncate(chunk + 1);
        if lines_before.is_empty() {
            lines_before.push(0usize);
        }
        lines_before.reserve(len / CHUNK + 2);
        let mut acc = *lines_before.last().unwrap();
        let mut pos = (lines_before.len() - 1) * CHUNK;
        while pos < len {
            let end = (pos + CHUNK).min(len);
            acc += self.count_keys(pos, end);
            lines_before.push(acc);
            pos = end;
        }
        self.lines_before = lines_before;
        self.orig_newlines = acc;
    }

    pub fn line_count(&self) -> usize {
        self.total_newlines + 1
    }

    pub fn is_dirty(&self) -> bool {
        let pristine = self.pieces.len() == 1
            && self.pieces[0].src == Src::Orig
            && self.pieces[0].start == self.body_start
            && self.pieces[0].len == self.mmap.len() - self.body_start;
        !pristine || self.eol != self.file_eol || self.backing_temp.is_some()
    }

    pub fn is_editable(&self) -> bool {
        self.editable
    }

    pub fn encoding_label(&self) -> &str {
        &self.encoding_label
    }

    pub fn disk_state(&self) -> DiskState {
        self.disk
    }

    pub fn file_len(&self) -> u64 {
        self.disk.len
    }

    pub fn file_mtime_ms(&self) -> u64 {
        self.disk.mtime_ms()
    }

    /// True when the file at `path` no longer matches what was opened (or last saved).
    pub fn disk_changed(&self) -> bool {
        match DiskState::read(&self.path) {
            Ok(now) => now != self.disk,
            Err(_) => true,
        }
    }

    fn ensure_editable(&self) -> Result<(), String> {
        if self.editable {
            Ok(())
        } else {
            Err(format!("{E_READ_ONLY_ENCODING}{}", self.encoding_label))
        }
    }

    // ---- line break detection ---------------------------------------------------------

    /// Whether the '\n' byte at absolute offset `p` of the mapping is a real line break.
    fn is_key(&self, p: usize) -> bool {
        match self.unit {
            Unit::Byte => true,
            Unit::U16Le => p >= self.body_start && (p - self.body_start) % 2 == 0 && self.mmap.get(p + 1) == Some(&0),
            Unit::U16Be => p > self.body_start && (p - self.body_start) % 2 == 1 && self.mmap[p - 1] == 0,
        }
    }

    /// Line breaks whose '\n' byte lies in mapping range [a, b).
    fn count_keys(&self, a: usize, b: usize) -> usize {
        let s = &self.mmap[a..b];
        match self.unit {
            Unit::Byte => memchr_iter(b'\n', s).count(),
            _ => memchr_iter(b'\n', s).filter(|&i| self.is_key(a + i)).count(),
        }
    }

    /// Bytes from a line break's '\n' byte to the start of the next line.
    fn after_key(&self) -> usize {
        if self.unit == Unit::U16Le {
            2
        } else {
            1
        }
    }

    /// Size of one line break in bytes.
    fn nl_width(&self) -> usize {
        if self.unit == Unit::Byte {
            1
        } else {
            2
        }
    }

    // ---- original-file index helpers -------------------------------------------------

    /// Number of line breaks in orig[0..off).
    fn orig_lines_at(&self, off: usize) -> usize {
        let off = off.min(self.mmap.len());
        let chunk = off / CHUNK;
        let base = chunk * CHUNK;
        self.lines_before[chunk] + self.count_keys(base, off)
    }

    /// Byte offset in orig where line `line` (0-based, counted from the file start) begins.
    fn orig_line_start(&self, line: usize) -> usize {
        if line == 0 {
            return 0;
        }
        if line > self.orig_newlines {
            return self.mmap.len();
        }
        let target_nl = line;
        let idx = match self.lines_before.binary_search(&target_nl) {
            Ok(i) => {
                let mut j = i;
                while j > 0 && self.lines_before[j] >= target_nl {
                    j -= 1;
                }
                j
            }
            Err(i) => i - 1,
        };
        let base = idx * CHUNK;
        let need = target_nl - self.lines_before[idx];
        let end = self.mmap.len();
        let mut it = memchr_iter(b'\n', &self.mmap[base..end]).filter(|&i| self.is_key(base + i));
        match it.nth(need - 1) {
            Some(p) => base + p + self.after_key(),
            None => self.mmap.len(),
        }
    }

    fn orig_count_newlines(&self, a: usize, b: usize) -> usize {
        if b <= a {
            return 0;
        }
        self.orig_lines_at(b) - self.orig_lines_at(a)
    }

    // ---- piece helpers -----------------------------------------------------------------

    fn piece_bytes(&self, p: &Piece) -> &[u8] {
        match p.src {
            Src::Orig => &self.mmap[p.start..p.start + p.len],
            Src::Add => &self.add[p.start..p.start + p.len],
        }
    }

    fn piece_newlines(&self, src: Src, start: usize, len: usize) -> usize {
        match src {
            Src::Orig => self.orig_count_newlines(start, start + len),
            Src::Add => memchr_iter(b'\n', &self.add[start..start + len]).count(),
        }
    }

    /// Position (relative to piece start) just before the start of the line that follows the
    /// k-th line break (1-based) inside the piece.
    fn piece_kth_newline(&self, p: &Piece, k: usize) -> Option<usize> {
        match p.src {
            Src::Add => memchr_iter(b'\n', self.piece_bytes(p)).nth(k - 1),
            Src::Orig => {
                let line_at_start = self.orig_lines_at(p.start);
                let s = self.orig_line_start(line_at_start + k);
                if s == 0 || s - 1 < p.start || s - 1 >= p.start + p.len {
                    None
                } else {
                    Some(s - 1 - p.start)
                }
            }
        }
    }

    /// Document byte offset where line `line` starts.
    pub fn line_start(&self, line: usize) -> usize {
        if line == 0 {
            return 0;
        }
        if line > self.total_newlines {
            return self.total_len;
        }
        let mut acc_lines = 0usize;
        let mut off = 0usize;
        for p in &self.pieces {
            if line > acc_lines && line <= acc_lines + p.newlines {
                let k = line - acc_lines;
                let rel = self.piece_kth_newline(p, k).expect("newline accounted in piece");
                return off + rel + 1;
            }
            acc_lines += p.newlines;
            off += p.len;
        }
        self.total_len
    }

    /// Document byte offset where the content of line `line` ends (before its line break).
    pub fn line_end(&self, line: usize) -> usize {
        if line >= self.total_newlines {
            return self.total_len;
        }
        let w = self.nl_width();
        let nl = self.line_start(line + 1) - w;
        match self.unit {
            Unit::Byte => {
                if nl > 0 && self.byte_at(nl - 1) == Some(b'\r') {
                    nl - 1
                } else {
                    nl
                }
            }
            Unit::U16Le | Unit::U16Be => {
                let cr: [u8; 2] = if self.unit == Unit::U16Le { [0x0D, 0] } else { [0, 0x0D] };
                if nl >= 2 && self.read(nl - 2, nl) == cr {
                    nl - 2
                } else {
                    nl
                }
            }
        }
    }

    fn byte_at(&self, off: usize) -> Option<u8> {
        let mut o = 0usize;
        for p in &self.pieces {
            if off < o + p.len {
                return Some(self.piece_bytes(p)[off - o]);
            }
            o += p.len;
        }
        None
    }

    /// Line number (0-based) containing document offset `off`.
    pub fn offset_to_line(&self, off: usize) -> usize {
        let mut acc_lines = 0usize;
        let mut o = 0usize;
        for p in &self.pieces {
            if off < o + p.len {
                let rel = off - o;
                return acc_lines + self.piece_newlines(p.src, p.start, rel);
            }
            acc_lines += p.newlines;
            o += p.len;
        }
        self.total_newlines
    }

    pub fn read(&self, from: usize, to: usize) -> Vec<u8> {
        let to = to.min(self.total_len);
        let mut out = Vec::with_capacity(to.saturating_sub(from));
        let mut o = 0usize;
        for p in &self.pieces {
            let ps = o;
            let pe = o + p.len;
            if pe > from && ps < to {
                let s = from.max(ps) - ps;
                let e = to.min(pe) - ps;
                out.extend_from_slice(&self.piece_bytes(p)[s..e]);
            }
            if pe >= to {
                break;
            }
            o = pe;
        }
        out
    }

    fn decode(&self, bytes: &[u8]) -> (String, bool) {
        if self.encoding == encoding_rs::UTF_8 {
            match std::str::from_utf8(bytes) {
                Ok(s) => (s.to_string(), false),
                Err(_) => (String::from_utf8_lossy(bytes).into_owned(), true),
            }
        } else {
            let (cow, had_errors) = self.encoding.decode_without_bom_handling(bytes);
            (cow.into_owned(), had_errors)
        }
    }

    /// Text of lines [first, first+count) without the trailing line break of the last line.
    /// Returns the text, the first line and the number of lines actually returned.
    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests
    pub fn read_lines(&self, first: usize, count: usize) -> (String, usize, usize) {
        let w = self.read_window(first, count, usize::MAX);
        (w.text, w.first, w.count)
    }

    /// Like `read_lines`, but never returns more than `max_bytes` of text. Fewer lines are
    /// returned when needed; a single longer line is cut and flagged `truncated`.
    pub fn read_window(&self, first: usize, count: usize, max_bytes: usize) -> WindowText {
        let total = self.line_count();
        let first = first.min(total.saturating_sub(1));
        let mut count = count.min(total - first).max(1);
        let from = self.line_start(first);
        let mut to = self.line_end(first + count - 1);
        let mut truncated = false;
        if to - from > max_bytes {
            if self.line_end(first) - from > max_bytes {
                count = 1;
                truncated = true;
                to = from + max_bytes;
                match self.unit {
                    Unit::Byte => {
                        // Do not cut a UTF-8 character in half.
                        while to > from && self.byte_at(to).map_or(false, |b| b & 0xC0 == 0x80) {
                            to -= 1;
                        }
                    }
                    _ => to -= (to - from) % 2,
                }
            } else {
                let (mut lo, mut hi) = (1usize, count);
                while lo < hi {
                    let mid = (lo + hi + 1) / 2;
                    if self.line_end(first + mid - 1) - from <= max_bytes {
                        lo = mid;
                    } else {
                        hi = mid - 1;
                    }
                }
                count = lo;
                to = self.line_end(first + count - 1);
            }
        }
        let bytes = self.read(from, to);
        let (text, lossy) = self.decode(&bytes);
        WindowText { text, first, count, truncated, lossy }
    }

    // ---- editing -------------------------------------------------------------------------

    fn split_at(&mut self, off: usize) {
        let mut o = 0usize;
        for i in 0..self.pieces.len() {
            let len = self.pieces[i].len;
            if off == o {
                return;
            }
            if off < o + len {
                let rel = off - o;
                let p = self.pieces[i].clone();
                let left_nl = self.piece_newlines(p.src, p.start, rel);
                let left = Piece { src: p.src, start: p.start, len: rel, newlines: left_nl };
                let right = Piece { src: p.src, start: p.start + rel, len: p.len - rel, newlines: p.newlines - left_nl };
                self.pieces[i] = left;
                self.pieces.insert(i + 1, right);
                return;
            }
            o += len;
        }
    }

    /// Keep the search scope pointing at the same text when [from, to) becomes `new_len` bytes.
    fn map_scope(&mut self, from: usize, to: usize, new_len: usize) {
        if let Some((a, b)) = self.scope {
            let delta = new_len as isize - (to - from) as isize;
            let shift = |x: usize| (x as isize + delta).max(0) as usize;
            self.scope = if to <= a {
                Some((shift(a), shift(b)))
            } else if from >= b {
                Some((a, b))
            } else if from >= a && to <= b {
                Some((a, shift(b)))
            } else {
                None // the edit overlaps the scope boundary: the scope no longer exists
            };
        }
    }

    /// Replace document bytes [from, to) with `bytes`.
    pub fn replace(&mut self, from: usize, to: usize, bytes: &[u8]) -> Result<(), String> {
        self.ensure_editable()?;
        let to = to.min(self.total_len);
        let from = from.min(to);
        self.map_scope(from, to, bytes.len());
        self.split_at(from);
        self.split_at(to);
        let mut o = 0usize;
        let mut i0 = None;
        let mut i1 = self.pieces.len();
        for (i, p) in self.pieces.iter().enumerate() {
            if o == from && i0.is_none() {
                i0 = Some(i);
            }
            if o == to && i0.is_some() {
                i1 = i;
                break;
            }
            o += p.len;
        }
        let i0 = i0.unwrap_or(self.pieces.len());
        let i1 = i1.max(i0);
        let removed: Vec<Piece> = self.pieces.drain(i0..i1).collect();
        self.total_newlines -= removed.iter().map(|p| p.newlines).sum::<usize>();
        self.total_len -= removed.iter().map(|p| p.len).sum::<usize>();
        if !bytes.is_empty() {
            let nl = memchr_iter(b'\n', bytes).count();
            let start = self.add.len();
            self.add.extend_from_slice(bytes);
            self.pieces.insert(i0, Piece { src: Src::Add, start, len: bytes.len(), newlines: nl });
            self.total_newlines += nl;
            self.total_len += bytes.len();
        }
        self.pieces.retain(|p| p.len > 0);
        if self.pieces.is_empty() {
            self.pieces.push(Piece { src: Src::Add, start: self.add.len(), len: 0, newlines: 0 });
        }
        Ok(())
    }

    /// Replace lines [first, first+count) with `text` (uses "\n" separators). Unchanged lines
    /// at the start and end of the window are kept byte for byte, including their original
    /// line endings; only the changed lines are stored, using the document's line ending.
    /// Returns the new total line count.
    pub fn replace_lines(&mut self, first: usize, count: usize, text: &str) -> Result<usize, String> {
        self.ensure_editable()?;
        let total = self.line_count();
        let first = first.min(total.saturating_sub(1));
        let count = count.min(total - first).max(1);
        let from = self.line_start(first);
        let to = self.line_end(first + count - 1);
        let old = self.read(from, to);
        // (start, content end, end including the line break) of each old line, relative to `from`.
        let mut old_lines: Vec<(usize, usize, usize)> = Vec::new();
        let mut s = 0usize;
        for nl in memchr_iter(b'\n', &old) {
            let ce = if nl > s && old[nl - 1] == b'\r' { nl - 1 } else { nl };
            old_lines.push((s, ce, nl + 1));
            s = nl + 1;
        }
        old_lines.push((s, old.len(), old.len()));
        let new_lines: Vec<&[u8]> = text.split('\n').map(|l| l.as_bytes()).collect();
        let (n, m) = (old_lines.len(), new_lines.len());
        let same = |i: usize, j: usize| &old[old_lines[i].0..old_lines[i].1] == new_lines[j];
        let mut k = 0usize;
        while k < n && k < m && same(k, k) {
            k += 1;
        }
        if k == n && k == m {
            return Ok(self.line_count());
        }
        let mut sfx = 0usize;
        while sfx < n - k && sfx < m - k && same(n - 1 - sfx, m - 1 - sfx) {
            sfx += 1;
        }
        let eol = self.eol.bytes();
        let mid = &new_lines[k..m - sfx];
        let joined = |lines: &[&[u8]]| -> Vec<u8> {
            let mut out = Vec::new();
            for (i, l) in lines.iter().enumerate() {
                if i > 0 {
                    out.extend_from_slice(eol);
                }
                out.extend_from_slice(l);
            }
            out
        };
        let (p, q, ins): (usize, usize, Vec<u8>) = if sfx > 0 {
            // Replace whole lines k..n-sfx (with their breaks) by the new middle lines.
            let mut ins = Vec::new();
            for l in mid {
                ins.extend_from_slice(l);
                ins.extend_from_slice(eol);
            }
            (old_lines[k].0, old_lines[n - sfx].0, ins)
        } else if k < m && k < n {
            (old_lines[k].0, old.len(), joined(mid))
        } else if k < m {
            // All old lines kept; new lines appended after the last one.
            let mut ins = eol.to_vec();
            ins.extend_from_slice(&joined(mid));
            (old.len(), old.len(), ins)
        } else {
            // Trailing old lines deleted, including the break before them.
            (old_lines[k - 1].1, old.len(), Vec::new())
        };
        if p != q || !ins.is_empty() {
            self.replace(from + p, from + q, &ins)?;
        }
        Ok(self.line_count())
    }

    // ---- saving ----------------------------------------------------------------------------

    fn write_contents(&self, file: File) -> std::io::Result<()> {
        let mut w = BufWriter::with_capacity(8 << 20, file);
        if self.bom == Bom::Utf8 {
            w.write_all(&[0xEF, 0xBB, 0xBF])?;
        }
        if self.eol == self.file_eol {
            for p in &self.pieces {
                w.write_all(self.piece_bytes(p))?;
            }
        } else {
            let mut conv = EolConverter { eol: self.eol.bytes(), pending_cr: false };
            let mut out = Vec::with_capacity(CHUNK * 2);
            for p in &self.pieces {
                for chunk in self.piece_bytes(p).chunks(CHUNK) {
                    out.clear();
                    conv.feed(chunk, &mut out);
                    w.write_all(&out)?;
                }
            }
            out.clear();
            conv.finish(&mut out);
            w.write_all(&out)?;
        }
        let file = w.into_inner().map_err(|e| e.into_error())?;
        file.sync_all()
    }

    /// Write the current content to `target`, then re-open it as the backing file.
    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests
    pub fn save_to(&mut self, target: &Path) -> Result<(), String> {
        self.save_to_opts(target, false)
    }

    /// `overwrite_external` skips the check for changes made by other programs.
    pub fn save_to_opts(&mut self, target: &Path, overwrite_external: bool) -> Result<(), String> {
        self.ensure_editable()?;
        let in_place = same_path(target, &self.path);
        if in_place && !overwrite_external && self.disk_changed() {
            return Err(format!("{E_EXTERNAL_CHANGE}{}", self.path.display()));
        }
        let lock = session::target_lock(target);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let (tmp, file) = session::create_temp_sibling(target)?;
        if let Err(e) = self.write_contents(file) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("Cannot write {}: {e}", target.display()));
        }
        let old_backing = self.backing_temp.clone();
        if in_place {
            // Windows refuses to replace a mapped file, so map the temporary copy instead of the
            // original first. The pieces keep pointing at original offsets until we know the
            // outcome.
            let mapped = old_backing.clone().unwrap_or_else(|| self.path.clone());
            let mapped_len = self.mmap.len();
            let tmp_map = match File::open(&tmp).and_then(|f| unsafe { Mmap::map(&f) }) {
                Ok(m) => m,
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("Cannot prepare saving {}: {e}", target.display()));
                }
            };
            drop(std::mem::replace(&mut self.mmap, tmp_map));
            if let Err(e) = std::fs::rename(&tmp, target) {
                return Err(self.recover_after_failed_replace(&mapped, mapped_len, &tmp, target, e));
            }
        } else if let Err(e) = std::fs::rename(&tmp, target) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("Cannot replace {}: {e}", target.display()));
        }
        let eol = self.eol;
        match PagedDoc::open(target) {
            Ok(mut fresh) => {
                fresh.eol = eol;
                fresh.file_eol = eol;
                *self = fresh;
            }
            Err(e) => return Err(format!("Saved {}, but could not reopen it: {e}", target.display())),
        }
        if let Some(p) = old_backing {
            let _ = std::fs::remove_file(p);
        }
        Ok(())
    }

    /// The target was not replaced. Map the previous backing file again so every piece stays
    /// valid; if that is impossible, keep the complete temporary copy as the backing file.
    fn recover_after_failed_replace(
        &mut self,
        mapped: &Path,
        mapped_len: usize,
        tmp: &Path,
        target: &Path,
        err: std::io::Error,
    ) -> String {
        let msg = format!("Cannot replace {}: {err}", target.display());
        match File::open(mapped).and_then(|f| unsafe { Mmap::map(&f) }) {
            Ok(m) if m.len() == mapped_len => {
                self.mmap = m;
                let _ = std::fs::remove_file(tmp);
                format!("{msg}. Your changes are kept.")
            }
            _ => match PagedDoc::open(tmp) {
                Ok(mut d) => {
                    d.path = self.path.clone();
                    d.disk = self.disk;
                    d.eol = self.eol;
                    d.file_eol = self.eol;
                    d.backing_temp = Some(tmp.to_path_buf());
                    *self = d;
                    format!("{msg}. Your changes are kept in {}.", tmp.display())
                }
                Err(_) => format!("{msg}. A copy of your document was written to {}.", tmp.display()),
            },
        }
    }

    // ---- search ----------------------------------------------------------------------------

    /// End of a search block that starts at `s`: about SEARCH_BLOCK bytes, at a line start
    /// where possible, never past `hi`.
    fn block_end(&self, s: usize, hi: usize) -> usize {
        let target = (s + SEARCH_BLOCK).min(hi);
        if target >= hi {
            return hi;
        }
        let le = self.line_start(self.offset_to_line(target) + 1);
        if le > s && le <= hi && le - s <= 4 * SEARCH_BLOCK {
            le
        } else {
            target
        }
    }

    fn block_start_before(&self, e: usize, lo: usize) -> usize {
        let target = e.saturating_sub(SEARCH_BLOCK).max(lo);
        if target == lo {
            return lo;
        }
        let ls = self.line_start(self.offset_to_line(target)).max(lo);
        if ls < e {
            ls
        } else {
            target
        }
    }

    /// Calls `f(start, end, captures)` for each non-empty, non-overlapping match that starts in
    /// [start_lo, start_hi) and ends at or before `end_limit`, in document order. The document
    /// is read in blocks with context and look-ahead, so matches may span piece boundaries;
    /// look-ahead grows (up to 64 MiB) when a match reaches the end of the buffer. Stops when
    /// `f` returns false. Fails with `E_CANCELLED` when `cancel` returns true.
    fn for_each_match<F>(&self, re: &Regex, start_lo: usize, start_hi: usize, end_limit: usize, cancel: &dyn Fn() -> bool, mut f: F) -> Result<(), String>
    where
        F: FnMut(usize, usize, &Captures<'_>) -> bool,
    {
        let start_hi = start_hi.min(self.total_len);
        let end_limit = end_limit.min(self.total_len);
        let mut cursor = start_lo;
        let mut seen = 0usize;
        while cursor < start_hi {
            if cancel() {
                return Err(format!("{E_CANCELLED}search cancelled"));
            }
            let block_hi = self.block_end(cursor, start_hi);
            let mut last_end = cursor;
            let mut lookahead = SEARCH_LOOKAHEAD;
            let mut scan_from = cursor;
            'block: loop {
                let ctx = scan_from.saturating_sub(SEARCH_CONTEXT);
                let buf_end = (block_hi + lookahead).min(self.total_len);
                let buf = self.read(ctx, buf_end);
                let complete = buf_end == self.total_len;
                let hi = block_hi - ctx;
                let mut pos = scan_from - ctx;
                while pos <= hi && pos <= buf.len() {
                    let caps = match re.captures_at(&buf, pos) {
                        Some(c) => c,
                        None => break,
                    };
                    let m = caps.get(0).unwrap();
                    if m.start() >= hi {
                        break;
                    }
                    if m.end() == buf.len() && !complete && lookahead < SEARCH_LOOKAHEAD_MAX {
                        // The match may continue beyond the buffer: read more and retry it.
                        lookahead *= 8;
                        scan_from = ctx + m.start();
                        continue 'block;
                    }
                    if m.start() == m.end() {
                        pos = m.end() + 1;
                        continue;
                    }
                    let (ms, me) = (ctx + m.start(), ctx + m.end());
                    if me <= end_limit {
                        if !f(ms, me, &caps) {
                            return Ok(());
                        }
                        last_end = me;
                    }
                    pos = m.end();
                    seen += 1;
                    if seen % 4096 == 0 && cancel() {
                        return Err(format!("{E_CANCELLED}search cancelled"));
                    }
                }
                break;
            }
            cursor = block_hi.max(last_end);
        }
        Ok(())
    }

    fn search_bounds(&self, scoped: bool) -> Result<(usize, usize), String> {
        if !scoped {
            return Ok((0, self.total_len));
        }
        self.scope.ok_or_else(|| format!("{E_NO_SCOPE}no selection scope"))
    }

    pub fn set_scope(&mut self, from: usize, to: usize) -> bool {
        let (a, b) = (from.min(to).min(self.total_len), from.max(to).min(self.total_len));
        self.scope = if b > a { Some((a, b)) } else { None };
        self.scope.is_some()
    }

    pub fn clear_scope(&mut self) {
        self.scope = None;
    }

    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests

    pub fn scope(&self) -> Option<(usize, usize)> {
        self.scope
    }

    /// First match at or after `from` (forward), or last match ending at or before `from`
    /// (backwards), inside the scope when `scoped`.
    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests
    pub fn find_in(&self, re: &Regex, from: usize, backwards: bool, scoped: bool) -> Result<Option<Match>, String> {
        self.find_in_c(re, from, backwards, scoped, &|| false)
    }

    pub fn find_in_c(&self, re: &Regex, from: usize, backwards: bool, scoped: bool, cancel: &dyn Fn() -> bool) -> Result<Option<Match>, String> {
        let (lo, hi) = self.search_bounds(scoped)?;
        let from = from.clamp(lo, hi);
        if !backwards {
            let mut found = None;
            self.for_each_match(re, from, hi, hi, cancel, |ms, me, _| {
                found = Some((ms, me));
                false
            })?;
            return Ok(found.map(|(s, e)| self.match_at(s, e - s)));
        }
        let mut e = from;
        while e > lo {
            let s = self.block_start_before(e, lo);
            let mut last = None;
            self.for_each_match(re, s, e, from, cancel, |ms, me, _| {
                last = Some((ms, me));
                true
            })?;
            if let Some((ms, me)) = last {
                return Ok(Some(self.match_at(ms, me - ms)));
            }
            e = s;
        }
        Ok(None)
    }

    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests

    pub fn find(&self, re: &Regex, from: usize, backwards: bool) -> Option<Match> {
        self.find_in(re, from, backwards, false).ok().flatten()
    }

    fn match_at(&self, off: usize, len: usize) -> Match {
        let line = self.offset_to_line(off);
        let col = off - self.line_start(line);
        Match { line, col, len, offset: off }
    }

    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests

    pub fn count_in(&self, re: &Regex, limit: usize, scoped: bool) -> Result<usize, String> {
        self.count_in_c(re, limit, scoped, &|| false)
    }

    pub fn count_in_c(&self, re: &Regex, limit: usize, scoped: bool, cancel: &dyn Fn() -> bool) -> Result<usize, String> {
        let (lo, hi) = self.search_bounds(scoped)?;
        let mut n = 0usize;
        self.for_each_match(re, lo, hi, hi, cancel, |_, _, _| {
            n += 1;
            n < limit
        })?;
        Ok(n)
    }

    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests

    pub fn count_matches(&self, re: &Regex, limit: usize) -> usize {
        self.count_in(re, limit, false).unwrap_or(0)
    }

    /// Every match with its line (0-based), byte column and line text (at most 400 characters),
    /// up to `max` matches. Returns the matches and whether the list was cut at `max`.
    pub fn find_all_c(&self, re: &Regex, scoped: bool, max: usize, cancel: &dyn Fn() -> bool) -> Result<(Vec<FoundLine>, bool), String> {
        let (lo, hi) = self.search_bounds(scoped)?;
        let mut hits: Vec<(usize, usize)> = Vec::new();
        let mut truncated = false;
        self.for_each_match(re, lo, hi, hi, cancel, |ms, me, _| {
            if hits.len() >= max {
                truncated = true;
                return false;
            }
            hits.push((ms, me));
            true
        })?;
        let mut out = Vec::with_capacity(hits.len());
        let mut cached: Option<(usize, usize, String)> = None; // line, start, text
        for (ms, me) in hits {
            let line = self.offset_to_line(ms);
            let (start, text) = match &cached {
                Some((l, s, t)) if *l == line => (*s, t.clone()),
                _ => {
                    let s = self.line_start(line);
                    let e = self.line_end(line).min(s + 4096);
                    let (t, _) = self.decode(&self.read(s, e));
                    let t: String = t.chars().take(400).collect();
                    cached = Some((line, s, t.clone()));
                    (s, t)
                }
            };
            out.push(FoundLine { line, col: ms - start, len: me - ms, text });
        }
        Ok((out, truncated))
    }

    /// Pieces describing document range [a, b) without copying any text.
    fn pieces_in(&self, a: usize, b: usize) -> Vec<Piece> {
        let mut out = Vec::new();
        let mut o = 0usize;
        for p in &self.pieces {
            let (ps, pe) = (o, o + p.len);
            o = pe;
            if pe <= a || ps >= b {
                if ps >= b {
                    break;
                }
                continue;
            }
            let s = a.max(ps) - ps;
            let e = b.min(pe) - ps;
            let newlines = if s == 0 && e == p.len { p.newlines } else { self.piece_newlines(p.src, p.start + s, e - s) };
            out.push(Piece { src: p.src, start: p.start + s, len: e - s, newlines });
        }
        out
    }

    /// Replace every match (inside the scope when `scoped`); returns the number replaced.
    /// `replacement` uses the regex crate's expansion syntax (`$1`, `${name}`, `$$`).
    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests
    pub fn replace_all_in(&mut self, re: &Regex, replacement: &[u8], scoped: bool) -> Result<usize, String> {
        self.replace_all_in_c(re, replacement, scoped, &|| false)
    }

    /// Like `replace_all_in`; a cancelled run changes nothing.
    pub fn replace_all_in_c(&mut self, re: &Regex, replacement: &[u8], scoped: bool, cancel: &dyn Fn() -> bool) -> Result<usize, String> {
        self.ensure_editable()?;
        let (lo, hi) = self.search_bounds(scoped)?;
        let mut hits: Vec<(usize, usize, Vec<u8>)> = Vec::new();
        self.for_each_match(re, lo, hi, hi, cancel, |ms, me, caps| {
            let mut out = Vec::new();
            caps.expand(replacement, &mut out);
            hits.push((ms, me, out));
            true
        })?;
        if hits.is_empty() {
            return Ok(0);
        }
        let mut pieces: Vec<Piece> = Vec::new();
        let mut cursor = 0usize;
        let mut delta: isize = 0;
        let mut new_add: Vec<(usize, Vec<u8>)> = Vec::new();
        for (ms, me, out) in &hits {
            pieces.extend(self.pieces_in(cursor, *ms));
            if !out.is_empty() {
                new_add.push((pieces.len(), out.clone()));
                pieces.push(Piece { src: Src::Add, start: 0, len: out.len(), newlines: memchr_iter(b'\n', out).count() });
            }
            delta += out.len() as isize - (me - ms) as isize;
            cursor = *me;
        }
        pieces.extend(self.pieces_in(cursor, self.total_len));
        for (idx, bytes) in new_add {
            pieces[idx].start = self.add.len();
            self.add.extend_from_slice(&bytes);
        }
        self.pieces = pieces;
        self.pieces.retain(|p| p.len > 0);
        if self.pieces.is_empty() {
            self.pieces.push(Piece { src: Src::Add, start: self.add.len(), len: 0, newlines: 0 });
        }
        self.total_len = self.pieces.iter().map(|p| p.len).sum();
        self.total_newlines = self.pieces.iter().map(|p| p.newlines).sum();
        self.scope = if scoped { Some((lo, (hi as isize + delta) as usize)) } else { None };
        Ok(hits.len())
    }

    #[cfg_attr(not(test), allow(dead_code))] // convenience wrapper used by tests

    pub fn replace_all(&mut self, re: &Regex, replacement: &[u8]) -> usize {
        self.replace_all_in(re, replacement, false).unwrap_or(0)
    }

    // ---- following a growing file (tail -f) ----------------------------------------------

    /// Check the file on disk for appended data and make it part of the document. Data
    /// appended to an unmodified file is mapped and indexed incrementally; a file that
    /// shrank or whose beginning changed is reported as rotated (the caller reopens it).
    pub fn refresh_append(&mut self) -> Result<TailStatus, String> {
        let now = match DiskState::read(&self.path) {
            Ok(n) => n,
            Err(_) => return Ok(TailStatus::Missing),
        };
        if now == self.disk {
            return Ok(TailStatus::Same);
        }
        let old_len = self.disk.len;
        if now.len < old_len {
            return Ok(TailStatus::Rotated);
        }
        // The first bytes the old fingerprint covered must be unchanged.
        let head_len = FINGERPRINT_BYTES.min(old_len) as usize;
        let mut head = vec![0u8; head_len];
        File::open(&self.path)
            .and_then(|mut f| f.read_exact(&mut head))
            .map_err(|e| format!("Cannot read {}: {e}", self.path.display()))?;
        if hash_bytes(&head) != self.disk.head || now.len == old_len {
            return Ok(TailStatus::Rotated);
        }
        if self.backing_temp.is_some() {
            return Ok(TailStatus::Rotated);
        }
        let file = File::open(&self.path).map_err(|e| format!("Cannot open {}: {e}", self.path.display()))?;
        // SAFETY: as in `open_with`.
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| format!("mmap failed: {e}"))?;
        let old_mapped = self.mmap.len();
        if mmap.len() < old_mapped || mmap[..old_mapped.min(4096)] != self.mmap[..old_mapped.min(4096)] {
            return Ok(TailStatus::Rotated);
        }
        self.mmap = mmap;
        let old_newlines = self.orig_newlines;
        self.build_index_from(old_mapped / CHUNK);
        let new_bytes = self.mmap.len() - old_mapped;
        let new_lines = self.orig_newlines - old_newlines;
        // Extend the last piece when it already ends at the old end of the file.
        match self.pieces.last_mut() {
            Some(p) if p.src == Src::Orig && p.start + p.len == old_mapped => {
                p.len += new_bytes;
                p.newlines += new_lines;
            }
            _ => self.pieces.push(Piece { src: Src::Orig, start: old_mapped, len: new_bytes, newlines: new_lines }),
        }
        self.total_len += new_bytes;
        self.total_newlines += new_lines;
        self.disk = now;
        Ok(TailStatus::Appended)
    }

    // ---- session persistence -------------------------------------------------------------

    /// Pieces and add buffer for the recovery log, borrowed (no copy of the add buffer).
    pub fn edits(&self) -> (&[Piece], &[u8]) {
        (&self.pieces, &self.add)
    }

    /// The recovery log refers to the original file; it is not valid while the document is
    /// backed by a temporary copy after a failed save.
    pub fn can_log_edits(&self) -> bool {
        self.backing_temp.is_none()
    }

    pub fn import_edits(&mut self, pieces: Vec<Piece>, add: Vec<u8>) -> Result<(), String> {
        let mut len = 0usize;
        let mut nl = 0usize;
        for p in &pieces {
            match p.src {
                Src::Orig => {
                    if p.start + p.len > self.mmap.len() {
                        return Err("edit log does not match file".into());
                    }
                }
                Src::Add => {
                    if p.start + p.len > add.len() {
                        return Err("edit log is corrupt".into());
                    }
                }
            }
            len += p.len;
            nl += p.newlines;
        }
        self.pieces = pieces;
        self.add = add;
        self.total_len = len;
        self.total_newlines = nl;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(content: &[u8]) -> (tempfile::TempDir, PagedDoc) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.txt");
        std::fs::File::create(&p).unwrap().write_all(content).unwrap();
        let d = PagedDoc::open(&p).unwrap();
        (dir, d)
    }

    #[test]
    fn lines_roundtrip() {
        let (_d, mut doc) = make(b"a\r\nbb\r\nccc\r\nend");
        assert_eq!(doc.line_count(), 4);
        assert_eq!(doc.read_lines(0, 2).0, "a\r\nbb");
        assert_eq!(doc.read_lines(1, 2).0, "bb\r\nccc");
        assert_eq!(doc.read_lines(3, 5).0, "end");
        let n = doc.replace_lines(1, 2, "X\nY\nZ").unwrap();
        assert_eq!(n, 5);
        assert_eq!(doc.read_lines(0, 5).0, "a\r\nX\r\nY\r\nZ\r\nend");
        let n = doc.replace_lines(0, 5, "one").unwrap();
        assert_eq!(n, 1);
        assert_eq!(doc.read_lines(0, 1).0, "one");
    }

    #[test]
    fn find_and_replace() {
        let (_d, mut doc) = make(b"foo bar\nbaz foo\n");
        let re = Regex::new("foo").unwrap();
        let m = doc.find(&re, 0, false).unwrap();
        assert_eq!((m.line, m.col), (0, 0));
        let m2 = doc.find(&re, m.offset + 1, false).unwrap();
        assert_eq!((m2.line, m2.col), (1, 4));
        assert!(doc.find(&re, m2.offset + 1, false).is_none());
        let b = doc.find(&re, m2.offset, true).unwrap();
        assert_eq!(b.offset, 0);
        assert_eq!(doc.replace_all(&re, b"Q"), 2);
        assert_eq!(doc.read_lines(0, 3).0, "Q bar\nbaz Q\n");
    }

    /// Randomised comparison against a plain Vec<String> model on a file that spans several
    /// index chunks, so line lookups cross the 1 MiB boundaries.
    #[test]
    fn model_check_across_chunks() {
        let mut rng = 0x9e3779b97f4a7c15u64;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng
        };
        let mut lines: Vec<String> = Vec::new();
        let mut size = 0usize;
        let mut i = 0usize;
        while size < 3_500_000 {
            let len = (next() % 200) as usize;
            let l = format!("{i:07} {}", "x".repeat(len));
            size += l.len() + 1;
            lines.push(l);
            i += 1;
        }
        let content = lines.join("\n");
        let (_d, mut doc) = make(content.as_bytes());
        assert_eq!(doc.line_count(), lines.len());
        for _ in 0..300 {
            let first = (next() as usize) % lines.len();
            let count = 1 + (next() as usize) % 50;
            let count = count.min(lines.len() - first);
            let (got, f, c) = doc.read_lines(first, count);
            assert_eq!((f, c), (first, count));
            assert_eq!(got, lines[first..first + count].join("\n"), "read {first}+{count}");
            if next() % 3 == 0 {
                // Edit a few lines of the window, as the editor would.
                let mut window: Vec<String> = lines[first..first + count].to_vec();
                let action = next() % 4;
                match action {
                    0 => {
                        let j = (next() as usize) % window.len();
                        window[j] = format!("edited-{}", next() % 1000);
                    }
                    1 => {
                        let j = (next() as usize) % (window.len() + 1);
                        window.insert(j, format!("inserted-{}", next() % 1000));
                    }
                    2 if window.len() > 1 => {
                        let j = (next() as usize) % window.len();
                        window.remove(j);
                    }
                    _ => {
                        let n_new = (next() % 60) as usize;
                        window = (0..n_new).map(|k| format!("new{k}-{}", next() % 1000)).collect();
                        if window.is_empty() {
                            window.push(String::new());
                        }
                    }
                }
                let total = doc.replace_lines(first, count, &window.join("\n")).unwrap();
                lines.splice(first..first + count, window);
                assert_eq!(total, lines.len(), "line count after replace");
            }
        }
        let (all, _, _) = doc.read_lines(0, lines.len());
        assert_eq!(all, lines.join("\n"));
        let target = doc.path.clone();
        doc.save_to(&target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), lines.join("\n"));
        assert!(!doc.is_dirty());
        assert_eq!(doc.line_count(), lines.len());
    }

    // ---- regressions from the 2026-10-17 review ------------------------------------------

    #[test]
    fn search_crosses_piece_boundary() {
        let (_d, mut doc) = make(b"hello world\n");
        doc.replace(5, 5, b"!").unwrap();
        let re = Regex::new("hello! world").unwrap();
        assert!(doc.find(&re, 0, false).is_some());
        assert_eq!(doc.count_matches(&re, 100), 1);
        assert_eq!(doc.replace_all(&re, b"hi"), 1);
        assert_eq!(doc.read_lines(0, 2).0, "hi\n");
    }

    #[test]
    fn eol_setting_converts_existing_bytes_on_save() {
        let (_d, mut doc) = make(b"one\r\ntwo\r\nthree\rfour\n");
        doc.eol = Eol::Lf;
        assert!(doc.is_dirty());
        let path = doc.path.clone();
        doc.save_to(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"one\ntwo\nthree\nfour\n");
        assert_eq!(doc.eol, Eol::Lf);
        assert!(!doc.is_dirty());
    }

    #[test]
    fn utf16_window_is_decoded_and_read_only() {
        let bytes = crate::textfmt::encode("hello\r\nworld\r\n\u{0a41}x", "UTF-16LE", Eol::Lf).unwrap();
        let (_d, mut doc) = make(&bytes);
        assert_eq!(doc.encoding_label(), "UTF-16LE");
        assert!(!doc.is_editable());
        // U+0A41 contains a 0x0A byte that must not count as a line break.
        assert_eq!(doc.line_count(), 3);
        assert_eq!(doc.read_lines(0, 3).0, "hello\r\nworld\r\n\u{0a41}x");
        assert_eq!(doc.read_lines(1, 1).0, "world");
        assert!(doc.replace(0, 0, b"x").unwrap_err().starts_with(E_READ_ONLY_ENCODING));
        assert!(doc.replace_lines(0, 1, "x").is_err());
        let p = doc.path.clone();
        assert!(doc.save_to(&p).is_err());
        let be = crate::textfmt::encode("a\nb", "UTF-16BE", Eol::Lf).unwrap();
        let (_d2, doc2) = make(&be);
        assert_eq!(doc2.read_lines(0, 2).0, "a\nb");
    }

    #[test]
    fn legacy_encoding_is_decoded_and_read_only() {
        let mut content = Vec::new();
        for _ in 0..200 {
            content.extend_from_slice(b"Gr\xfc\xdfe aus M\xfcnchen \x80\n");
        }
        let (_d, doc) = make(&content);
        assert!(!doc.is_editable());
        assert_eq!(doc.read_lines(0, 1).0, "Grüße aus München €");
    }

    #[test]
    fn failed_save_keeps_document() {
        let (dir, mut doc) = make(b"original\n");
        doc.replace_lines(0, 1, "edited").unwrap();
        let before = doc.read(0, 100);
        let target = dir.path().join("existing-directory");
        std::fs::create_dir(&target).unwrap();
        assert!(doc.save_to(&target).is_err());
        assert_eq!(doc.read(0, 100), before);
        assert!(doc.is_dirty());
        // No temporary file is left behind.
        let temps = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(session::TEMP_SUFFIX))
            .count();
        assert_eq!(temps, 0);
        // Saving to the real file still works afterwards.
        let p = doc.path.clone();
        doc.save_to(&p).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"edited\n");
    }

    #[test]
    fn save_detects_external_change() {
        let (_d, mut doc) = make(b"original\n");
        doc.replace_lines(0, 1, "edited").unwrap();
        std::fs::OpenOptions::new().write(true).open(&doc.path).unwrap().write_all(b"external\n").unwrap();
        let target = doc.path.clone();
        let err = doc.save_to(&target).unwrap_err();
        assert!(err.starts_with(E_EXTERNAL_CHANGE), "{err}");
        assert!(doc.disk_changed());
        // The user can still choose to overwrite.
        doc.save_to_opts(&target, true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"edited\n");
        assert!(!doc.disk_changed());
    }

    #[test]
    fn save_does_not_touch_neighbor_files() {
        let (dir, mut doc) = make(b"x\n");
        let neighbor = dir.path().join(".t.txt.naxtmp");
        std::fs::write(&neighbor, b"keep").unwrap();
        doc.replace_lines(0, 1, "y").unwrap();
        let p = doc.path.clone();
        doc.save_to(&p).unwrap();
        assert_eq!(std::fs::read(&neighbor).unwrap(), b"keep");
    }

    #[test]
    fn replace_all_stores_only_replacements() {
        let mut content = Vec::new();
        for i in 0..20_000 {
            content.extend_from_slice(format!("line {i} needle filler filler filler\n").as_bytes());
        }
        let (_d, mut doc) = make(&content);
        let re = Regex::new("needle").unwrap();
        assert_eq!(doc.replace_all(&re, b"pin"), 20_000);
        // The add buffer holds 20k * "pin", not a copy of the ~800 KB file.
        assert_eq!(doc.add.len(), 20_000 * 3);
        assert_eq!(doc.read_lines(0, 1).0, "line 0 pin filler filler filler");
        assert_eq!(doc.read_lines(19_999, 1).0, "line 19999 pin filler filler filler");
        assert_eq!(doc.line_count(), 20_001);
    }

    #[test]
    fn scoped_operations_stay_inside_the_scope() {
        let (_d, mut doc) = make(b"cat cat\ncat cat\ncat cat\n");
        let re = Regex::new("cat").unwrap();
        assert!(doc.count_in(&re, 100, true).unwrap_err().starts_with(E_NO_SCOPE));
        // Scope: the second line.
        assert!(doc.set_scope(8, 15));
        assert_eq!(doc.count_in(&re, 100, true).unwrap(), 2);
        // An edit before the scope shifts it.
        doc.replace(0, 0, b">>").unwrap();
        assert_eq!(doc.scope(), Some((10, 17)));
        assert_eq!(doc.replace_all_in(&re, b"dogs", true).unwrap(), 2);
        assert_eq!(doc.read_lines(0, 4).0, ">>cat cat\ndogs dogs\ncat cat\n");
        assert_eq!(doc.scope(), Some((10, 19)));
        let first = doc.find_in(&re, 0, false, true).unwrap();
        assert!(first.is_none(), "no cat left in scope");
    }

    #[test]
    fn replace_lines_keeps_untouched_line_endings() {
        let (_d, mut doc) = make(b"a\r\nb\nc\r\nd");
        // CRLF detected; edit only line "c".
        doc.replace_lines(0, 4, "a\nb\nC\nd").unwrap();
        assert_eq!(doc.read(0, 100), b"a\r\nb\nC\r\nd");
        // Inserting and deleting lines.
        doc.replace_lines(0, 4, "a\nb\nnew\nC\nd").unwrap();
        assert_eq!(doc.read(0, 100), b"a\r\nb\nnew\r\nC\r\nd");
        doc.replace_lines(0, 5, "a\nb").unwrap();
        assert_eq!(doc.read(0, 100), b"a\r\nb");
        doc.replace_lines(0, 2, "a\nb\nc").unwrap();
        assert_eq!(doc.read(0, 100), b"a\r\nb\r\nc");
    }

    #[test]
    fn long_line_window_is_bounded() {
        let mut content = vec![b'x'; 5000];
        content.extend_from_slice("ü\nshort\n".as_bytes());
        let (_d, doc) = make(&content);
        let w = doc.read_window(0, 3, 1000);
        assert!(w.truncated);
        assert_eq!(w.count, 1);
        assert_eq!(w.text.len(), 1000);
        let w = doc.read_window(1, 3, 1000);
        assert!(!w.truncated);
        assert_eq!(w.text, "short\n");
        // A multi-byte character is never cut.
        let w = doc.read_window(0, 1, 5001);
        assert!(w.text.chars().all(|c| c == 'x'));
    }

    // ---- Notepad++ workflow features ----------------------------------------------------

    #[test]
    fn find_all_reports_lines_and_text() {
        let (_d, mut doc) = make(b"alpha beta\ngamma\nbeta beta\n");
        doc.replace(0, 0, b">").unwrap();
        let re = Regex::new("beta").unwrap();
        let (hits, truncated) = doc.find_all_c(&re, false, 100, &|| false).unwrap();
        assert!(!truncated);
        let got: Vec<(usize, usize, &str)> = hits.iter().map(|h| (h.line, h.col, h.text.as_str())).collect();
        assert_eq!(got, vec![(0, 7, ">alpha beta"), (2, 0, "beta beta"), (2, 5, "beta beta")]);
        let (hits, truncated) = doc.find_all_c(&re, false, 2, &|| false).unwrap();
        assert_eq!((hits.len(), truncated), (2, true));
    }

    #[test]
    fn cancelled_operations_change_nothing() {
        let (_d, mut doc) = make(b"a a a a\n");
        let re = Regex::new("a").unwrap();
        let err = doc.replace_all_in_c(&re, b"b", false, &|| true).unwrap_err();
        assert!(err.starts_with(E_CANCELLED));
        assert_eq!(doc.read_lines(0, 1).0, "a a a a");
        assert!(doc.count_in_c(&re, 10, false, &|| true).is_err());
    }

    #[test]
    fn following_appended_data() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("app.log");
        std::fs::write(&p, b"line 1\nline 2\n").unwrap();
        let mut doc = PagedDoc::open(&p).unwrap();
        assert_eq!(doc.refresh_append().unwrap(), TailStatus::Same);
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"line 3\nline 4\n").unwrap();
        assert_eq!(doc.refresh_append().unwrap(), TailStatus::Appended);
        assert_eq!(doc.line_count(), 5);
        assert_eq!(doc.read_lines(2, 2).0, "line 3\nline 4");
        assert!(!doc.is_dirty(), "appended data is part of the file, not an edit");
        // Large appends across index chunks.
        let big: String = (5..200_000).map(|i| format!("line {i}\n")).collect();
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(big.as_bytes()).unwrap();
        assert_eq!(doc.refresh_append().unwrap(), TailStatus::Appended);
        assert_eq!(doc.line_count(), 200_000);
        assert_eq!(doc.read_lines(199_998, 1).0, "line 199999");
        // Rotation as loggers do it on Windows (a mapped file cannot be truncated): the old
        // file is renamed and a new, shorter one takes its place.
        std::fs::rename(&p, dir.path().join("app.log.1")).unwrap();
        std::fs::write(&p, b"new log\n").unwrap();
        assert_eq!(doc.refresh_append().unwrap(), TailStatus::Rotated);
    }

    #[test]
    fn reopen_with_forced_encoding() {
        let (_d, doc) = make("Grüße\n".as_bytes());
        assert!(doc.is_editable());
        let p = doc.path.clone();
        drop(doc);
        let forced = PagedDoc::open_with(&p, Some("windows-1252")).unwrap();
        assert!(!forced.is_editable());
        assert_eq!(forced.encoding_label(), "windows-1252");
        assert_eq!(forced.read_lines(0, 1).0, "GrÃ¼ÃŸe");
        drop(forced);
        let utf16 = crate::textfmt::encode("hi\nyo", "UTF-16LE", Eol::Lf).unwrap();
        std::fs::write(&p, &utf16[2..]).unwrap(); // no BOM: only the forced encoding helps
        let doc = PagedDoc::open_with(&p, Some("UTF-16LE")).unwrap();
        assert_eq!(doc.read_lines(0, 2).0, "hi\nyo");
    }
}
