// SPDX-License-Identifier: Apache-2.0
// Upload bundle handling: extract, validate, resolve the entry (SPEC §2, §11, §13).

/**
 * A `.zip` upload is the ONLY place attacker-controlled relative paths enter
 * Storage, so every entry is validated before any write and the total is capped.
 * This module assembles bytes; it does not decide trust — the caller marks
 * browser uploads `trusted: false`.
 */

import AdmZip from "adm-zip";

export type SourceFormat = "html" | "markdown";

export interface BundleEntry {
  /** POSIX relpath within the bundle. */
  rel: string;
  data: Buffer;
}

export interface ExtractedBundle {
  files: BundleEntry[];
  /** The source file the document is authored in. */
  entry: string;
  format: SourceFormat;
  /**
   * Whether the upload was a `.zip`. A one-file archive and a bare file extract
   * to the same files, but an update reads them differently: an archive is the
   * whole new bundle, a bare file replaces only the entry (SPEC §19).
   */
  archive: boolean;
}

/**
 * Validate one relpath for Storage: no traversal, no absolute path, no NUL.
 * Returns the normalized path, or null to reject.
 */
export function safeBundleRelPath(rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0) return null;
  if (rel.includes("\\") || rel.includes("\0")) return null;
  if (rel.startsWith("/")) return null;
  const parts = rel.split("/");
  for (const seg of parts) {
    if (seg.length === 0) return null; // "a//b" or a trailing slash
    if (seg === "." || seg === "..") return null;
  }
  return parts.join("/");
}

const HTML_RE = /\.html?$/i;
const MD_RE = /\.(md|markdown)$/i;
const JUNK_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/i;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}

/** Strip a single shared top-level directory (e.g. "deck/index.html"). */
function stripCommonPrefix(files: BundleEntry[]): BundleEntry[] {
  if (files.length === 0) return files;
  const top = files[0].rel.split("/")[0];
  if (!top) return files;
  const allShare = files.every(
    (f) => f.rel.startsWith(`${top}/`) && f.rel.length > top.length + 1,
  );
  const hasRootEntry = files.some((f) =>
    /^index\.(html?|md|markdown)$/i.test(f.rel),
  );
  if (!allShare || hasRootEntry) return files;
  return files.map((f) => ({ ...f, rel: f.rel.slice(top.length + 1) }));
}

/**
 * Pick the source entry.
 *
 * HTML wins over Markdown at the root, because a bundle that ships both has
 * already been compiled and the `.md` is the source of record we would
 * regenerate anyway — re-rendering it would silently discard whatever the
 * author did to the HTML.
 */
function resolveEntry(files: BundleEntry[]): { entry: string; format: SourceFormat } | null {
  const rootHtml = files.find((f) => f.rel.toLowerCase() === "index.html");
  if (rootHtml) return { entry: rootHtml.rel, format: "html" };

  const rootMd = files.find((f) => /^index\.(md|markdown)$/i.test(f.rel));
  if (rootMd) return { entry: rootMd.rel, format: "markdown" };

  const htmls = files.filter((f) => HTML_RE.test(f.rel));
  if (htmls.length === 1) return { entry: htmls[0].rel, format: "html" };
  const nestedIndex = htmls.find((f) => /(^|\/)index\.html?$/i.test(f.rel));
  if (nestedIndex) return { entry: nestedIndex.rel, format: "html" };

  const mds = files.filter((f) => MD_RE.test(f.rel));
  if (mds.length === 1) return { entry: mds[0].rel, format: "markdown" };
  const nestedMd = mds.find((f) => /(^|\/)index\.(md|markdown)$/i.test(f.rel));
  if (nestedMd) return { entry: nestedMd.rel, format: "markdown" };

  return null;
}

/**
 * Turn an uploaded file into a validated bundle. `filename` decides the mode,
 * with a zip-magic sniff as a fallback for a mislabelled upload.
 */
export function extractBundle(
  buffer: Buffer,
  filename: string,
  maxBytes: number,
): ExtractedBundle | { error: string } {
  if (buffer.length === 0) return { error: "uploaded file is empty" };
  if (buffer.length > maxBytes) return { error: "uploaded file is too large" };

  const name = (filename || "").toLowerCase();
  const isZip = name.endsWith(".zip") || looksLikeZip(buffer);

  if (!isZip) {
    if (MD_RE.test(name)) {
      return {
        files: [{ rel: "index.md", data: buffer }],
        entry: "index.md",
        format: "markdown",
        archive: false,
      };
    }
    if (!HTML_RE.test(name) && name.length > 0) {
      return {
        error: "upload a self-contained .html, a .md file, or a .zip bundle",
      };
    }
    // Single self-contained HTML: normalize the entry name.
    return {
      files: [{ rel: "index.html", data: buffer }],
      entry: "index.html",
      format: "html",
      archive: false,
    };
  }

  // The entries are read inside the guard too: adm-zip parses the central
  // directory lazily, so a damaged one throws from here, not the constructor.
  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch {
    return { error: "could not read the .zip archive" };
  }

  const files: BundleEntry[] = [];
  let total = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (JUNK_RE.test(e.entryName)) continue;
    const safe = safeBundleRelPath(e.entryName);
    if (safe == null) return { error: `unsafe path in archive: ${e.entryName}` };

    // Zip-bomb guard, on the DECLARED uncompressed size from the central
    // directory, BEFORE decompressing. adm-zip allocates a Buffer of that size
    // and its inflater only bounds output when the declared size is > 0, so a
    // spoofed entry declaring 0 while carrying a real payload would decompress
    // unbounded. A genuinely empty file compresses to a handful of bytes, so
    // "declares 0 but ships more than 64 compressed bytes" is malformed.
    const declared =
      e.header && typeof e.header.size === "number" ? e.header.size : 0;
    const compressed =
      e.header && typeof e.header.compressedSize === "number"
        ? e.header.compressedSize
        : 0;
    if (declared > maxBytes || total + declared > maxBytes) {
      return { error: "bundle is too large" };
    }
    if (declared === 0 && compressed > 64) {
      return { error: "malformed archive (suspicious entry size)" };
    }

    let data: Buffer;
    try {
      data = e.getData();
    } catch {
      return { error: "could not read an entry in the archive" };
    }
    total += data.length;
    if (total > maxBytes) return { error: "bundle is too large" };
    files.push({ rel: safe, data });
  }

  if (files.length === 0) return { error: "the .zip contained no files" };

  const stripped = stripCommonPrefix(files);
  const resolved = resolveEntry(stripped);
  if (!resolved) {
    return { error: "no index.html, index.md, or single source file found in the bundle" };
  }
  return { files: stripped, entry: resolved.entry, format: resolved.format, archive: true };
}

/** Assemble bundle files into a .zip buffer, for download. */
export function zipBundle(files: BundleEntry[]): Buffer {
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.rel, f.data);
  return zip.toBuffer();
}

/** True for a filename the uploader accepts. Mirrors `app/src/upload.ts`. */
export function isUploadableName(name: string): boolean {
  return /\.(html?|md|markdown|zip)$/i.test(name);
}
