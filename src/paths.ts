// Windows path helpers for the frontend, and the rules for which images Live Preview may load.

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function joinPath(dir: string, rel: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("\\\\") || rel.startsWith("/")) return rel;
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  // \\server\share keeps its two leading separators, and ".." never leaves the share.
  const unc = /^[\\/]{2}/.test(dir);
  const parts = (dir + sep + rel).split(/[\\/]+/);
  if (unc) parts.shift();
  const root = unc ? 2 : 1;
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (out.length > root) out.pop();
    } else if (part !== ".") out.push(part);
  }
  return (unc ? sep + sep : "") + out.join(sep);
}

/** `decodeURIComponent` that keeps the text as it is when it is not valid percent-encoding. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
/** \\server\share, //server/share and device paths such as \\?\ and \\.\ */
const NETWORK_OR_DEVICE = /^[\\/]{2}/;

/**
 * What Live Preview may load for an image reference in the document at `docPath`: a data URL,
 * an http(s) URL when `remote` is allowed, or a local file path. Null means the image is not
 * loaded. Network shares and device paths are refused, because only looking at a document
 * would make Windows connect to another computer (and send the user's credentials to it).
 */
export function imageSource(src: string, docPath: string | null, remote: boolean): { url: string } | { path: string } | null {
  if (/^data:image\//i.test(src)) return { url: src };
  if (/^https?:/i.test(src)) return remote ? { url: src } : null;
  let path: string;
  if (/^file:/i.test(src)) {
    // file:///C:/x is a local file; file://server/share/x is a network share.
    const m = /^file:\/*([a-zA-Z]:[\\/].*)$/i.exec(src);
    if (!m) return null;
    path = safeDecode(m[1]);
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(src)) {
    return null; // other schemes (asset:, javascript:, ...)
  } else {
    const rel = safeDecode(src);
    path = DRIVE_PATH.test(rel) || NETWORK_OR_DEVICE.test(rel) ? rel : docPath ? joinPath(dirname(docPath), rel) : rel;
  }
  if (NETWORK_OR_DEVICE.test(path)) {
    // A document that itself lives on a share may show images from the same share.
    const share = docPath ? /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/.exec(docPath)?.[0] : undefined;
    const sameShare = share && path.toLowerCase().replace(/\//g, "\\").startsWith(share.toLowerCase().replace(/\//g, "\\") + "\\");
    return sameShare && !path.includes("..") ? { path } : null;
  }
  return DRIVE_PATH.test(path) ? { path } : null;
}
