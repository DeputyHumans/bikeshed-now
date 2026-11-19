// SPDX-License-Identifier: Apache-2.0
// A page's files: their types, an agent's `files`, and where a loose file lands (SPEC §2, §19, §24).

/**
 * A document is a page and the files it uses: stylesheets, scripts, fonts,
 * pictures, video, audio, captions (SPEC §24, ADR 0037). Three ways bring
 * files into a version without a whole new bundle, and this module is the
 * rule each follows:
 *
 *   - an agent's `files` on `publish_document` and `update_document`, at exact
 *     paths, as text or base64 (`decodeAgentFiles`);
 *   - loose files dropped on a document in the browser, or named to
 *     `bikeshed update`, which replace the file of the same name (`resolveLoose`);
 *   - video and audio, which the proxy hands to a short-lived Storage link
 *     instead of streaming (`isStreamedMedia`).
 */

import * as mime from "mime-types";
import { safeBundleRelPath, isLeftOut, MAX_PATH_BYTES, type BundleEntry } from "./bundle";

/** Served through a short-lived Storage link, which answers ranges, rather than streamed (SPEC §24). */
export function isStreamedMedia(rel: string): boolean {
  return /^(video|audio)\//.test(mime.lookup(rel) || "");
}

/** What an agent may send as base64 only: bytes a model cannot write as text. */
export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico",
  "mp4", "m4v", "webm", "mov", "ogv", "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac",
  "woff", "woff2", "ttf", "otf",
  "pdf",
]);

/** What an agent may send as text (or base64): what a model writes anyway. */
export const TEXT_EXTENSIONS = new Set([
  "css", "js", "mjs", "json", "svg", "vtt", "txt", "csv", "md", "markdown", "html", "htm", "xml",
]);

/** The most an agent's `files` may decode to, in all. Larger media go through the CLI with a folder. */
export const AGENT_FILES_BYTES = 10 * 1024 * 1024;

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function extensionOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What a path may not be, for whichever page the document has. */
export interface PageSlots {
  /** The file the frame loads. For Markdown, the compiled HTML, which is made, never sent. */
  entry: string;
  /** For Markdown, the source, which is the page. */
  sourceEntry?: string;
  format: "html" | "markdown";
}

/**
 * An agent's `files`, checked and decoded, or the first thing wrong with them
 * in words an agent can act on. `page` names the paths the page itself holds,
 * which `content` sets and `files` may not.
 */
export function decodeAgentFiles(input: unknown, page: PageSlots): { files: BundleEntry[] } | { error: string } {
  if (input === undefined) return { files: [] };
  if (!Array.isArray(input)) return { error: "files must be an array of {path, content, encoding?}" };
  // The size is bounded from the strings, before anything is decoded.
  const declared = input.reduce((n: number, f: unknown) => n + String((f as { content?: unknown })?.content ?? "").length, 0);
  if (declared > Math.ceil(AGENT_FILES_BYTES * 4 / 3) + 4 * input.length) {
    return { error: `files come to more than ${AGENT_FILES_BYTES / 1024 / 1024} MB; publish a folder with bikeshed publish instead` };
  }
  const reserved = new Set([page.sourceEntry ?? page.entry, ...(page.format === "markdown" ? [page.entry] : [])]);
  const seen = new Set<string>();
  const files: BundleEntry[] = [];
  let total = 0;
  for (const raw of input) {
    const f = raw as { path?: unknown; content?: unknown; encoding?: unknown };
    const path = typeof f?.path === "string" ? safeBundleRelPath(f.path) : null;
    if (!path) return { error: `not a usable path: ${JSON.stringify(f?.path)}; use a relative path such as img/chart.png` };
    if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return { error: `${path.slice(0, 80)}… is longer than ${MAX_PATH_BYTES} bytes` };
    if (isLeftOut(path)) return { error: `${path} would be left out of a folder (a name starting with a dot, or node_modules); name it differently` };
    if (seen.has(path)) return { error: `${path} is in files twice` };
    seen.add(path);
    if (reserved.has(path)) {
      return {
        error: page.format === "markdown" && path === page.entry
          ? `${path} is made from the Markdown; send the Markdown as content instead`
          : `${path} is the page itself; send it as content instead`,
      };
    }
    if (typeof f.content !== "string") return { error: `${path}: content must be a string` };
    const encoding = f.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") return { error: `${path}: encoding is "utf8" or "base64"` };
    const ext = extensionOf(path);
    if (!BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
      return { error: `${path}: .${ext || "(none)"} is not a type files takes; it takes ${[...TEXT_EXTENSIONS].join(", ")} as text and ${[...BINARY_EXTENSIONS].join(", ")} as base64` };
    }
    if (BINARY_EXTENSIONS.has(ext) && encoding !== "base64") return { error: `${path} is binary; send it with encoding: "base64"` };
    let data: Buffer;
    if (encoding === "base64") {
      if (/^\s*data:/i.test(f.content)) {
        return { error: `${path}: send the base64 alone, without a data: prefix; the file is referenced by its path, which is the point of sending it as a file` };
      }
      if (!STRICT_BASE64.test(f.content)) return { error: `${path}: not valid base64 (no line breaks, padding where needed)` };
      data = Buffer.from(f.content, "base64");
    } else {
      data = Buffer.from(f.content, "utf8");
    }
    total += data.length;
    if (total > AGENT_FILES_BYTES) return { error: `files come to more than ${AGENT_FILES_BYTES / 1024 / 1024} MB; publish a folder with bikeshed publish instead` };
    files.push({ rel: path, data });
  }
  return { files };
}

const PAGE_RE = /\.(html?|md|markdown)$/i;

/**
 * Where each loose file lands in a document whose current files are `paths`
 * (SPEC §2, `merge=1`): what a person dropping files on a document means.
 *
 *   - A path with a folder in it is taken exactly when the document has it:
 *     `img/chart.png`. When it does not, it lands on the longest of the
 *     document's paths it ends with, because that is a file named from the
 *     folder above (`site/img/chart.png` after publishing `site`), and is
 *     added where it says only when it ends with none.
 *   - A bare name replaces the one file of that name, wherever it is.
 *   - A bare name nothing has is added at the top, except that one page file
 *     on its own replaces the page, as uploading a page has always done.
 *   - A bare name two files share is refused, naming both, because guessing
 *     would replace the wrong picture.
 */
export function resolveLoose<T extends { rel: string }>(
  paths: readonly string[],
  loose: readonly T[],
  page: PageSlots,
): { files: T[] } | { error: string; matches: string[] } {
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    const name = p.slice(p.lastIndexOf("/") + 1);
    byName.set(name, [...(byName.get(name) ?? []), p]);
  }
  const lonePage = loose.length === 1 && PAGE_RE.test(loose[0].rel) && !loose[0].rel.includes("/");
  const has = new Set(paths);
  const out: T[] = [];
  for (const f of loose) {
    if (f.rel.includes("/")) {
      const under = has.has(f.rel) ? null : paths.filter((p) => f.rel.endsWith(`/${p}`)).sort((a, b) => b.length - a.length)[0];
      out.push(under ? { ...f, rel: under } : f);
      continue;
    }
    const found = byName.get(f.rel) ?? [];
    if (found.length > 1) {
      return { error: `${found.length} files are called ${f.rel}: ${found.join(", ")}. Drop the folder instead, or give the path`, matches: found };
    }
    if (found.length === 1) out.push({ ...f, rel: found[0] });
    else if (lonePage) {
      const markdown = /\.(md|markdown)$/i.test(f.rel);
      if (markdown !== (page.format === "markdown")) {
        const kind = page.format === "markdown" ? "Markdown" : "HTML";
        return { error: `this document is ${kind}, so the page that replaces its own must be ${kind} too`, matches: [] };
      }
      out.push({ ...f, rel: page.sourceEntry ?? (page.format === "markdown" ? "index.md" : page.entry) });
    } else out.push(f);
  }
  return { files: out };
}
