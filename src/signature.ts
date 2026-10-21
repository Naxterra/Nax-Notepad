// Recognizes common file types from their first bytes ("magic numbers").

const SIGNATURES: { name: string; bytes: (number | null)[]; at?: number }[] = [
  { name: "PDF", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { name: "PNG image", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "JPEG image", bytes: [0xff, 0xd8, 0xff] },
  { name: "GIF image", bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: "WebP image", bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
  { name: "WAV audio", bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x41, 0x56, 0x45] },
  { name: "BMP image", bytes: [0x42, 0x4d] },
  { name: "ICO icon", bytes: [0x00, 0x00, 0x01, 0x00] },
  { name: "ZIP archive (also DOCX, XLSX, JAR)", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: "7-Zip archive", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: "RAR archive", bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { name: "GZIP archive", bytes: [0x1f, 0x8b] },
  { name: "Windows executable or DLL (PE)", bytes: [0x4d, 0x5a] },
  { name: "ELF executable", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "Java class", bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: "WebAssembly", bytes: [0x00, 0x61, 0x73, 0x6d] },
  { name: "SQLite database", bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66] },
  { name: "MP3 audio (ID3)", bytes: [0x49, 0x44, 0x33] },
  { name: "MP4 or MOV video", bytes: [0x66, 0x74, 0x79, 0x70], at: 4 },
  { name: "OLE compound file (DOC, XLS, MSI)", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { name: "UTF-8 text with BOM", bytes: [0xef, 0xbb, 0xbf] },
  { name: "UTF-16 LE text with BOM", bytes: [0xff, 0xfe] },
  { name: "UTF-16 BE text with BOM", bytes: [0xfe, 0xff] },
];

/** A readable file type for the first bytes of a file, or null if unknown. */
export function detectSignature(head: Uint8Array): string | null {
  for (const s of SIGNATURES) {
    const at = s.at ?? 0;
    if (head.length < at + s.bytes.length) continue;
    if (s.bytes.every((b, i) => b === null || head[at + i] === b)) return s.name;
  }
  return null;
}
