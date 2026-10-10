//! Encoding and line-ending detection / conversion shared by memory and paged documents.

use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Eol {
    Lf,
    CrLf,
    Cr,
}

impl Eol {
    pub fn bytes(self) -> &'static [u8] {
        match self {
            Eol::Lf => b"\n",
            Eol::CrLf => b"\r\n",
            Eol::Cr => b"\r",
        }
    }
}

/// Detect the dominant line ending from a sample of bytes. Defaults to CRLF (Windows) when
/// the sample has no line breaks at all.
pub fn detect_eol(sample: &[u8]) -> Eol {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let mut i = 0;
    while i < sample.len() {
        match sample[i] {
            b'\n' => lf += 1,
            b'\r' => {
                if i + 1 < sample.len() && sample[i + 1] == b'\n' {
                    crlf += 1;
                    i += 1;
                } else {
                    cr += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    if crlf == 0 && lf == 0 && cr == 0 {
        Eol::CrLf
    } else if crlf >= lf && crlf >= cr {
        Eol::CrLf
    } else if lf >= cr {
        Eol::Lf
    } else {
        Eol::Cr
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bom {
    None,
    Utf8,
    Utf16Le,
    Utf16Be,
}

pub fn detect_bom(bytes: &[u8]) -> (Bom, usize) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (Bom::Utf8, 3)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (Bom::Utf16Le, 2)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (Bom::Utf16Be, 2)
    } else {
        (Bom::None, 0)
    }
}

/// Result of decoding a file into a Rust string.
pub struct Decoded {
    pub text: String,
    /// Encoding label as used by the UI, e.g. "UTF-8", "UTF-8-BOM", "UTF-16LE", "windows-1252".
    pub encoding: String,
    pub eol: Eol,
    pub had_errors: bool,
}

pub fn decode(bytes: &[u8]) -> Decoded {
    let (bom, skip) = detect_bom(bytes);
    let body = &bytes[skip..];
    let (text, encoding, had_errors) = match bom {
        Bom::Utf8 => {
            let (cow, had) = encoding_rs::UTF_8.decode_without_bom_handling(body);
            (cow.into_owned(), "UTF-8-BOM".to_string(), had)
        }
        Bom::Utf16Le => {
            let (cow, had) = encoding_rs::UTF_16LE.decode_without_bom_handling(body);
            (cow.into_owned(), "UTF-16LE".to_string(), had)
        }
        Bom::Utf16Be => {
            let (cow, had) = encoding_rs::UTF_16BE.decode_without_bom_handling(body);
            (cow.into_owned(), "UTF-16BE".to_string(), had)
        }
        Bom::None => {
            if let Ok(s) = std::str::from_utf8(body) {
                (s.to_string(), "UTF-8".to_string(), false)
            } else {
                let mut det = chardetng::EncodingDetector::new();
                det.feed(body, true);
                let enc = det.guess(None, true);
                let (cow, had) = enc.decode_without_bom_handling(body);
                (cow.into_owned(), enc.name().to_string(), had)
            }
        }
    };
    // Detect line endings on the decoded text so UTF-16 input is handled correctly.
    let sample_end = text
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= 1 << 16)
        .unwrap_or(text.len());
    let eol = detect_eol(text[..sample_end].as_bytes());
    Decoded {
        text,
        encoding,
        eol,
        had_errors,
    }
}

/// Encode `text` (which uses "\n" line separators) into bytes using `encoding` and `eol`.
pub fn encode(text: &str, encoding: &str, eol: Eol) -> Result<Vec<u8>, String> {
    let normalized: std::borrow::Cow<str> = if eol == Eol::Lf {
        std::borrow::Cow::Borrowed(text)
    } else {
        let eol_str = std::str::from_utf8(eol.bytes()).unwrap();
        std::borrow::Cow::Owned(text.replace('\n', eol_str))
    };
    let mut out = Vec::with_capacity(normalized.len() + 4);
    match encoding {
        "UTF-8" => out.extend_from_slice(normalized.as_bytes()),
        "UTF-8-BOM" => {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(normalized.as_bytes());
        }
        "UTF-16LE" => {
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in normalized.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
        }
        "UTF-16BE" => {
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in normalized.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
        }
        label => {
            let enc = Encoding::for_label(label.as_bytes())
                .ok_or_else(|| format!("Unknown encoding: {label}"))?;
            let (cow, _, _) = enc.encode(&normalized);
            out.extend_from_slice(&cow);
        }
    }
    Ok(out)
}

/// Encodings offered in the UI, in display order.
pub const ENCODINGS: &[&str] = &[
    "UTF-8",
    "UTF-8-BOM",
    "UTF-16LE",
    "UTF-16BE",
    "windows-1252",
    "windows-1250",
    "windows-1251",
    "ISO-8859-1",
    "ISO-8859-2",
    "ISO-8859-15",
    "Shift_JIS",
    "GBK",
    "EUC-KR",
    "KOI8-R",
    "macintosh",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_roundtrip_crlf() {
        let d = decode("a\r\nb\u{e9}\r\n".as_bytes());
        assert_eq!(d.encoding, "UTF-8");
        assert_eq!(d.eol, Eol::CrLf);
        let out = encode("a\nb\u{e9}\n", "UTF-8", Eol::CrLf).unwrap();
        assert_eq!(out, "a\r\nb\u{e9}\r\n".as_bytes());
    }

    #[test]
    fn bom_and_utf16() {
        let d = decode(&[0xEF, 0xBB, 0xBF, b'h', b'i']);
        assert_eq!((d.encoding.as_str(), d.text.as_str()), ("UTF-8-BOM", "hi"));
        let le = encode("hi\n", "UTF-16LE", Eol::Lf).unwrap();
        assert_eq!(le, vec![0xFF, 0xFE, b'h', 0, b'i', 0, b'\n', 0]);
        let d = decode(&le);
        assert_eq!((d.encoding.as_str(), d.text.as_str()), ("UTF-16LE", "hi\n"));
        let be = encode("hi", "UTF-16BE", Eol::Lf).unwrap();
        assert_eq!(decode(&be).text, "hi");
    }

    #[test]
    fn legacy_codepage() {
        let bytes = b"Gr\xfc\xdfe aus M\xfcnchen \x80";
        let d = decode(bytes);
        assert_eq!(d.text, "Grüße aus München €");
        assert_eq!(d.encoding, "windows-1252");
        let back = encode(&d.text, "windows-1252", Eol::Lf).unwrap();
        assert_eq!(back, bytes);
    }

    #[test]
    fn eol_detection() {
        assert_eq!(detect_eol(b"a\nb\nc"), Eol::Lf);
        assert_eq!(detect_eol(b"a\r\nb\nc\r\n"), Eol::CrLf);
        assert_eq!(detect_eol(b"a\rb\r"), Eol::Cr);
        assert_eq!(detect_eol(b"no breaks"), Eol::CrLf);
    }
}
