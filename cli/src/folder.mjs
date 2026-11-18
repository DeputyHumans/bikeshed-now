// SPDX-License-Identifier: Apache-2.0
// A folder as one document: what it holds, what it leaves out, and which page opens first (SPEC §2).

/**
 * `bikeshed publish <folder>` and `update <id> <folder>` send a folder as one
 * `.zip`, so the deployment reads it exactly as it reads an uploaded zip. The
 * rules here are the server's (`functions/src/lib/bundle.ts`), checked before
 * anything is sent, so a folder over a limit or with no page fails at once
 * rather than after the upload. A shared table,
 * `functions/test/fixtures/bundle-rules.json`, holds the two to one rule.
 *
 * Symbolic links are never followed: a link to a home directory would
 * otherwise publish it. Everything left out is reported, so nothing vanishes
 * without a word.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 2000;
export const MAX_PATH_BYTES = 256;

/** A file or folder name the deployment leaves out: dotfiles, `__MACOSX`, `node_modules`, `Thumbs.db`. */
export function isLeftOut(rel) {
  return rel.split("/").some((seg) =>
    seg.startsWith(".") || seg === "__MACOSX" || seg === "node_modules" || seg.toLowerCase() === "thumbs.db");
}

const HTML_RE = /\.html?$/i;
const MD_RE = /\.(md|markdown)$/i;

/** The page a set of paths opens with, by the server's rule, or null. */
export function resolveEntry(paths) {
  const rootHtml = paths.find((p) => p.toLowerCase() === "index.html");
  if (rootHtml) return rootHtml;
  const rootMd = paths.find((p) => /^index\.(md|markdown)$/i.test(p));
  if (rootMd) return rootMd;
  const htmls = paths.filter((p) => HTML_RE.test(p));
  if (htmls.length === 1) return htmls[0];
  const nestedIndex = htmls.find((p) => /(^|\/)index\.html?$/i.test(p));
  if (nestedIndex) return nestedIndex;
  const mds = paths.filter((p) => MD_RE.test(p));
  if (mds.length === 1) return mds[0];
  const nestedMd = mds.find((p) => /(^|\/)index\.(md|markdown)$/i.test(p));
  return nestedMd ?? null;
}

/**
 * Every file under `dir` that would be published, by path relative to it, and
 * what was left out and why. Reads no file's bytes.
 */
export function walkFolder(dir) {
  const files = [];
  const leftOut = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const abs = join(at, name);
      const rel = relative(dir, abs).split(sep).join("/");
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) { leftOut.push({ rel, why: "a link" }); continue; }
      if (isLeftOut(rel)) { leftOut.push({ rel: st.isDirectory() ? `${rel}/` : rel, why: "left out" }); continue; }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files.push({ rel, abs, size: st.size });
    }
  };
  walk(dir);
  return { files, leftOut };
}

/** What stops a folder publishing, each in words that say what to change. */
export function folderProblems(files) {
  const problems = [];
  if (files.length === 0) problems.push("the folder has nothing to publish");
  if (files.length > MAX_BUNDLE_FILES) problems.push(`it holds ${files.length} files; a document can hold ${MAX_BUNDLE_FILES}`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BUNDLE_BYTES) problems.push(`it comes to ${megabytes(total)}; a document can be up to ${megabytes(MAX_BUNDLE_BYTES)}`);
  for (const f of files) {
    if (Buffer.byteLength(f.rel, "utf8") > MAX_PATH_BYTES) problems.push(`${f.rel.slice(0, 60)}… has a path longer than ${MAX_PATH_BYTES} bytes`);
  }
  if (files.length > 0 && !resolveEntry(files.map((f) => f.rel))) {
    const pages = files.filter((f) => HTML_RE.test(f.rel) || MD_RE.test(f.rel)).map((f) => f.rel);
    problems.push(pages.length > 1
      ? `${pages.length} pages could open first (${pages.slice(0, 3).join(", ")}${pages.length > 3 ? ", …" : ""}); name the one that should index.html or index.md`
      : "there is no page to open: add index.html or index.md");
  }
  return problems;
}

/** The files' bytes, as the zip writer takes them. */
export function readEntries(files) {
  return files.map((f) => ({ name: f.rel, data: readFileSync(f.abs) }));
}

/** One line for what a walk left out: "left out .env, .git/, and 2 more". */
export function describeLeftOut(leftOut) {
  if (leftOut.length === 0) return null;
  const named = leftOut.slice(0, 4).map((l) => (l.why === "a link" ? `${l.rel} (a link)` : l.rel));
  const more = leftOut.length - named.length;
  return `left out ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

export function megabytes(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
