//! Memory-mapped document with a piece table, for files too large to hold in the editor.
//!
//! The original file is mapped read-only. A sparse index records how many line breaks occur
//! before every 1 MiB boundary, so any line <-> byte offset query scans at most one megabyte.
//! Edits are appended to an "add" buffer and the document is described by a list of pieces
//! referencing either the original mapping or the add buffer. Saving streams the pieces to a
//! temporary file and then replaces the original.

use crate::textfmt::{detect_bom, detect_eol, Bom, Eol};
use memchr::memchr_iter;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

const CHUNK: usize = 1 << 20;

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

pub struct PagedDoc {
    pub path: PathBuf,
    mmap: Mmap,
    /// lines_before[i] = number of '\n' bytes in orig[0 .. i*CHUNK]
    lines_before: Vec<usize>,
    orig_newlines: usize,
    add: Vec<u8>,
    pieces: Vec<Piece>,
    pub eol: Eol,
    pub bom: Bom,
    total_len: usize,
    total_newlines: usize,
    pub file_len: u64,
    pub file_mtime: u64,
}

#[derive(Serialize)]
pub struct Match {
    pub line: usize,
    pub col: usize,
    pub len: usize,
    pub offset: usize,
}

impl PagedDoc {
    pub fn open(path: &Path) -> Result<PagedDoc, String> {
        let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        let file_len = meta.len();
        let file_mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // SAFETY: the mapping is read-only; concurrent external modification of the file is a
        // documented limitation (the editor re-checks size and mtime before saving).
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| format!("mmap failed: {e}"))?;
        let bytes: &[u8] = &mmap;
        let (bom, skip) = detect_bom(bytes);
        let eol = detect_eol(&bytes[skip..bytes.len().min(skip + (1 << 16))]);

        let n_chunks = bytes.len() / CHUNK + 2;
        let mut lines_before = Vec::with_capacity(n_chunks);
        lines_before.push(0usize);
        let mut acc = 0usize;
        let mut pos = 0usize;
        while pos < bytes.len() {
            let end = (pos + CHUNK).min(bytes.len());
            acc += memchr_iter(b'\n', &bytes[pos..end]).count();
            lines_before.push(acc);
            pos = end;
        }
        let orig_newlines = acc;
        let body_len = bytes.len() - skip;
        let pieces = vec![Piece {
            src: Src::Orig,
            start: skip,
            len: body_len,
            newlines: orig_newlines,
        }];
        Ok(PagedDoc {
            path: path.to_path_buf(),
            mmap,
            lines_before,
            orig_newlines,
            add: Vec::new(),
            pieces,
            eol,
            bom,
            total_len: body_len,
            total_newlines: orig_newlines,
            file_len,
            file_mtime,
        })
    }

    pub fn line_count(&self) -> usize {
        self.total_newlines + 1
    }

    pub fn is_dirty(&self) -> bool {
        !(self.pieces.len() == 1 && self.pieces[0].src == Src::Orig && self.add.is_empty())
    }

    // ---- original-file index helpers -------------------------------------------------

    /// Number of '\n' in orig[0..off).
    fn orig_lines_at(&self, off: usize) -> usize {
        let off = off.min(self.mmap.len());
        let chunk = off / CHUNK;
        let base = chunk * CHUNK;
        self.lines_before[chunk] + memchr_iter(b'\n', &self.mmap[base..off]).count()
    }

    /// Byte offset in orig where line `line` (0-based, counted from the file start) begins.
    fn orig_line_start(&self, line: usize) -> usize {
        if line == 0 {
            return 0;
        }
        if line > self.orig_newlines {
            return self.mmap.len();
        }
        // We need the position of the `line`-th newline (1-based). Find the last chunk whose
        // prefix count is strictly below it; that newline lies inside that chunk.
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
        let mut it = memchr_iter(b'\n', &self.mmap[base..end]);
        match it.nth(need - 1) {
            Some(p) => base + p + 1,
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

    /// Position (relative to piece start) of the k-th newline (1-based) inside the piece.
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

    /// Document byte offset where the content of line `line` ends (before its EOL bytes).
    pub fn line_end(&self, line: usize) -> usize {
        if line >= self.total_newlines {
            return self.total_len;
        }
        let nl = self.line_start(line + 1) - 1;
        if nl > 0 && self.byte_at(nl - 1) == Some(b'\r') {
            nl - 1
        } else {
            nl
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
                let n = match p.src {
                    Src::Add => memchr_iter(b'\n', &self.add[p.start..p.start + rel]).count(),
                    Src::Orig => self.orig_count_newlines(p.start, p.start + rel),
                };
                return acc_lines + n;
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

    /// Text of lines [first, first+count) without the trailing EOL of the last line.
    /// Returns the text and the number of lines actually returned.
    pub fn read_lines(&self, first: usize, count: usize) -> (String, usize, usize) {
        let total = self.line_count();
        let first = first.min(total.saturating_sub(1));
        let count = count.min(total - first).max(1);
        let from = self.line_start(first);
        let to = self.line_end(first + count - 1);
        let bytes = self.read(from, to);
        (String::from_utf8_lossy(&bytes).into_owned(), first, count)
    }

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
                let left_nl = match p.src {
                    Src::Add => memchr_iter(b'\n', &self.add[p.start..p.start + rel]).count(),
                    Src::Orig => self.orig_count_newlines(p.start, p.start + rel),
                };
                let left = Piece {
                    src: p.src,
                    start: p.start,
                    len: rel,
                    newlines: left_nl,
                };
                let right = Piece {
                    src: p.src,
                    start: p.start + rel,
                    len: p.len - rel,
                    newlines: p.newlines - left_nl,
                };
                self.pieces[i] = left;
                self.pieces.insert(i + 1, right);
                return;
            }
            o += len;
        }
    }

    /// Replace document bytes [from, to) with `bytes`.
    pub fn replace(&mut self, from: usize, to: usize, bytes: &[u8]) {
        let to = to.min(self.total_len);
        let from = from.min(to);
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
        let removed_nl: usize = removed.iter().map(|p| p.newlines).sum();
        let removed_len: usize = removed.iter().map(|p| p.len).sum();
        self.total_newlines -= removed_nl;
        self.total_len -= removed_len;
        if !bytes.is_empty() {
            let nl = memchr_iter(b'\n', bytes).count();
            let start = self.add.len();
            self.add.extend_from_slice(bytes);
            self.pieces.insert(
                i0,
                Piece {
                    src: Src::Add,
                    start,
                    len: bytes.len(),
                    newlines: nl,
                },
            );
            self.total_newlines += nl;
            self.total_len += bytes.len();
        }
        self.pieces.retain(|p| p.len > 0);
        if self.pieces.is_empty() {
            self.pieces.push(Piece {
                src: Src::Add,
                start: self.add.len(),
                len: 0,
                newlines: 0,
            });
        }
    }

    /// Replace lines [first, first+count) with `text` (uses "\n" separators) converted to the
    /// document's EOL. Returns the new total line count.
    pub fn replace_lines(&mut self, first: usize, count: usize, text: &str) -> usize {
        let total = self.line_count();
        let first = first.min(total.saturating_sub(1));
        let count = count.min(total - first).max(1);
        let from = self.line_start(first);
        let to = self.line_end(first + count - 1);
        let converted: std::borrow::Cow<[u8]> = if self.eol == Eol::Lf {
            std::borrow::Cow::Borrowed(text.as_bytes())
        } else {
            let eol = std::str::from_utf8(self.eol.bytes()).unwrap();
            std::borrow::Cow::Owned(text.replace('\n', eol).into_bytes())
        };
        self.replace(from, to, &converted);
        self.line_count()
    }

    /// Write the current content to `target`, then re-open it as the backing file.
    pub fn save_to(&mut self, target: &Path) -> Result<(), String> {
        let dir = target.parent().unwrap_or(Path::new("."));
        let tmp = dir.join(format!(
            ".{}.naxtmp",
            target.file_name().and_then(|s| s.to_str()).unwrap_or("file")
        ));
        {
            let f = File::create(&tmp).map_err(|e| format!("Cannot create temp file: {e}"))?;
            let mut w = BufWriter::with_capacity(8 << 20, f);
            match self.bom {
                Bom::Utf8 => w.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?,
                Bom::Utf16Le => w.write_all(&[0xFF, 0xFE]).map_err(|e| e.to_string())?,
                Bom::Utf16Be => w.write_all(&[0xFE, 0xFF]).map_err(|e| e.to_string())?,
                Bom::None => {}
            }
            for p in &self.pieces {
                w.write_all(self.piece_bytes(p)).map_err(|e| e.to_string())?;
            }
            w.flush().map_err(|e| e.to_string())?;
        }
        // Release the mapping of the old file before replacing it (Windows refuses otherwise).
        let tmp_file = File::open(&tmp).map_err(|e| e.to_string())?;
        self.mmap = unsafe { Mmap::map(&tmp_file) }.map_err(|e| e.to_string())?;
        self.pieces.clear();
        std::fs::rename(&tmp, target).map_err(|e| format!("Cannot replace file: {e}"))?;
        let fresh = PagedDoc::open(target)?;
        *self = fresh;
        Ok(())
    }

    pub fn find(&self, re: &regex::bytes::Regex, from: usize, backwards: bool) -> Option<Match> {
        let mut o = 0usize;
        if !backwards {
            for p in &self.pieces {
                let pe = o + p.len;
                if pe > from {
                    let bytes = self.piece_bytes(p);
                    let rel = from.saturating_sub(o);
                    for m in re.find_iter(&bytes[rel..]) {
                        if m.start() == m.end() {
                            continue;
                        }
                        let off = o + rel + m.start();
                        return Some(self.match_at(off, m.end() - m.start()));
                    }
                }
                o = pe;
            }
            None
        } else {
            let mut best: Option<Match> = None;
            for p in &self.pieces {
                let pe = o + p.len;
                if o >= from {
                    break;
                }
                let bytes = self.piece_bytes(p);
                let limit = (from - o).min(bytes.len());
                let mut last: Option<(usize, usize)> = None;
                for m in re.find_iter(&bytes[..limit]) {
                    if m.start() != m.end() {
                        last = Some((m.start(), m.end()));
                    }
                }
                if let Some((s, e)) = last {
                    best = Some(self.match_at(o + s, e - s));
                }
                o = pe;
            }
            best
        }
    }

    fn match_at(&self, off: usize, len: usize) -> Match {
        let line = self.offset_to_line(off);
        let col = off - self.line_start(line);
        Match {
            line,
            col,
            len,
            offset: off,
        }
    }

    pub fn count_matches(&self, re: &regex::bytes::Regex, limit: usize) -> usize {
        let mut n = 0usize;
        for p in &self.pieces {
            n += re
                .find_iter(self.piece_bytes(p))
                .filter(|m| m.start() != m.end())
                .count();
            if n >= limit {
                return limit;
            }
        }
        n
    }

    /// Replace every match; returns the number of replacements. Works piece by piece.
    pub fn replace_all(&mut self, re: &regex::bytes::Regex, replacement: &[u8]) -> usize {
        let mut count = 0usize;
        let mut new_pieces: Vec<Piece> = Vec::new();
        let mut new_add: Vec<u8> = Vec::new();
        let mut total_len = 0usize;
        let mut total_nl = 0usize;
        for p in &self.pieces {
            let bytes = self.piece_bytes(p);
            let mut last = 0usize;
            let mut buf: Vec<u8> = Vec::new();
            let mut any = false;
            for caps in re.captures_iter(bytes) {
                let m = caps.get(0).unwrap();
                if m.start() == m.end() {
                    continue;
                }
                any = true;
                count += 1;
                buf.extend_from_slice(&bytes[last..m.start()]);
                caps.expand(replacement, &mut buf);
                last = m.end();
            }
            if any {
                buf.extend_from_slice(&bytes[last..]);
                let nl = memchr_iter(b'\n', &buf).count();
                let start = new_add.len();
                new_add.extend_from_slice(&buf);
                total_len += buf.len();
                total_nl += nl;
                new_pieces.push(Piece {
                    src: Src::Add,
                    start,
                    len: buf.len(),
                    newlines: nl,
                });
            } else {
                let mut q = p.clone();
                if q.src == Src::Add {
                    let start = new_add.len();
                    new_add.extend_from_slice(bytes);
                    q.start = start;
                }
                total_len += q.len;
                total_nl += q.newlines;
                new_pieces.push(q);
            }
        }
        if count > 0 {
            self.pieces = new_pieces;
            self.add = new_add;
            self.total_len = total_len;
            self.total_newlines = total_nl;
        }
        count
    }

    // ---- session persistence -------------------------------------------------------------

    pub fn export_edits(&self) -> (Vec<Piece>, Vec<u8>) {
        (self.pieces.clone(), self.add.clone())
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
    use std::io::Write as _;

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
        let n = doc.replace_lines(1, 2, "X\nY\nZ");
        assert_eq!(n, 5);
        assert_eq!(doc.read_lines(0, 5).0, "a\r\nX\r\nY\r\nZ\r\nend");
        let n = doc.replace_lines(0, 5, "one");
        assert_eq!(n, 1);
        assert_eq!(doc.read_lines(0, 1).0, "one");
    }

    #[test]
    fn find_and_replace() {
        let (_d, mut doc) = make(b"foo bar\nbaz foo\n");
        let re = regex::bytes::Regex::new("foo").unwrap();
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
                let n_new = (next() % 60) as usize;
                let new: Vec<String> = (0..n_new).map(|k| format!("new{k}-{}", next() % 1000)).collect();
                let text = new.join("\n");
                let total = doc.replace_lines(first, count, &text);
                lines.splice(first..first + count, if n_new == 0 { vec![String::new()] } else { new });
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
}
