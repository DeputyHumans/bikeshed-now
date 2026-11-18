// SPDX-License-Identifier: Apache-2.0
// What a drop or a pick holds, and what publishing it would do, worked out before anything is sent (SPEC §2).

/**
 * A document is a page and the files it uses. People bring them four ways:
 * one page, one `.zip`, a folder, or several files at once. This module turns
 * any of them into a plan the dialogs can show before anything is sent: what
 * will be published, which page opens first, what is left out and why, what
 * an update replaces, keeps or drops, and every problem with its fix.
 *
 * The rules are the server's (`functions/src/lib/bundle.ts`, `lib/files.ts`),
 * held to it by `functions/test/fixtures/bundle-rules.json`, so what a person
 * is told here is what the deployment then does.
 */

export interface PickedFile {
  /** The path it will have in the document. */
  path: string;
  file: File;
}

/** What one drop or pick brought. */
export interface Pick {
  files: PickedFile[];
  /** What was left out, by path, a folder ending in `/`. */
  leftOut: string[];
  /** The folder's name, when the whole pick is one folder. */
  folder: string | null;
  /** True when a folder was dropped or chosen, rather than files. */
  fromFolder: boolean;
}

export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 2000;
export const MAX_PATH_BYTES = 256;

/** A name the deployment leaves out of a folder or a zip: dotfiles, `__MACOSX`, `node_modules`, `Thumbs.db`. */
export function isLeftOut(path: string): boolean {
  return path.split("/").some((seg) =>
    seg.startsWith(".") || seg === "__MACOSX" || seg === "node_modules" || seg.toLowerCase() === "thumbs.db");
}

const HTML_RE = /\.html?$/i;
const MD_RE = /\.(md|markdown)$/i;
const ZIP_RE = /\.zip$/i;
export const isPagePath = (path: string) => HTML_RE.test(path) || MD_RE.test(path);

/** Strip one folder every path shares, as the server does with a zip of one. */
export function stripCommonFolder(paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const top = paths[0].split("/")[0];
  const all = paths.every((p) => p.startsWith(`${top}/`) && p.length > top.length + 1);
  const rootPage = paths.some((p) => /^index\.(html?|md|markdown)$/i.test(p));
  return all && !rootPage ? paths.map((p) => p.slice(top.length + 1)) : paths;
}

/** The page a set of paths opens with, by the server's rule, or null. */
export function resolveEntry(paths: readonly string[]): string | null {
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
  return mds.find((p) => /(^|\/)index\.(md|markdown)$/i.test(p)) ?? null;
}

// --- Reading what was dropped or chosen ---------------------------------------

/**
 * Every item of a drop, read into one pick each: a file, or a folder with all
 * it holds. The entries are taken from the event at once, as a browser allows
 * only while the drop is being handled; the reading after that is async.
 */
export function captureDrop(dt: DataTransfer | null): Promise<Pick[]> {
  const items = Array.from(dt?.items ?? []).filter((i) => i.kind === "file");
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null));
  const files = Array.from(dt?.files ?? []);
  if (entries.length === 0 || entries.some((e) => e === null)) {
    return Promise.resolve(files.map((file) => ({ files: [{ path: file.name, file }], leftOut: [], folder: null, fromFolder: false })));
  }
  return Promise.all(entries.map((entry) => readEntry(entry as FileSystemEntry)));
}

async function readEntry(entry: FileSystemEntry): Promise<Pick> {
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    return { files: [{ path: file.name, file }], leftOut: [], folder: null, fromFolder: false };
  }
  const files: PickedFile[] = [];
  const leftOut: string[] = [];
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string) => {
    for (const child of await listAll(dir)) {
      const path = `${prefix}${child.name}`;
      if (isLeftOut(path)) {
        leftOut.push(child.isDirectory ? `${path}/` : path);
      } else if (child.isDirectory) {
        await walk(child as FileSystemDirectoryEntry, `${path}/`);
      } else {
        files.push({ path, file: await fileOf(child as FileSystemFileEntry) });
      }
    }
  };
  await walk(entry as FileSystemDirectoryEntry, `${entry.name}/`);
  return { files, leftOut, folder: entry.name, fromFolder: true };
}

/** A directory reader answers in batches, and an empty batch means the end. */
async function listAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    out.push(...batch);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** What a file input chose: several files, or, with `webkitdirectory`, a folder. */
export function pickFromInput(list: FileList | readonly File[]): Pick {
  const chosen = Array.from(list);
  const relative = chosen.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || "");
  if (chosen.length > 0 && relative.every((r) => r.includes("/"))) {
    const folder = relative[0].split("/")[0];
    const files: PickedFile[] = [];
    const leftOut = new Set<string>();
    chosen.forEach((file, i) => {
      const path = relative[i];
      const out = leftOutAncestor(path);
      if (out) leftOut.add(out);
      else files.push({ path, file });
    });
    return { files, leftOut: [...leftOut], folder, fromFolder: true };
  }
  return combine(chosen.map((file) => ({ files: [{ path: file.name, file }], leftOut: [], folder: null, fromFolder: false })));
}

/** The first left-out part of a path, as it is reported: `node_modules/` rather than every file in it. */
function leftOutAncestor(path: string): string | null {
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    if (isLeftOut(parts.slice(0, i + 1).join("/"))) return i < parts.length - 1 ? `${parts.slice(0, i + 1).join("/")}/` : path;
  }
  return null;
}

/** Several items of one drop, as one pick: what a dialog does with everything dropped on it. */
export function combine(picks: readonly Pick[]): Pick {
  if (picks.length === 1) return picks[0];
  return {
    files: picks.flatMap((p) => p.files),
    leftOut: picks.flatMap((p) => p.leftOut),
    folder: null,
    fromFolder: picks.some((p) => p.fromFolder),
  };
}

// --- What publishing it would do -------------------------------------------------

/** What the current version holds, for an update to be measured against. */
export interface BaseFiles {
  files: string[];
  entry: string;
  sourceEntry?: string | null;
  format: "html" | "markdown";
}

/** What a version record says it holds, as an update is measured against it. */
export function baseFilesOf(version: { files?: string[]; entry: string; sourceEntry?: string | null; format?: "html" | "markdown" }): BaseFiles {
  return {
    files: version.files && version.files.length > 0 ? version.files : [version.entry],
    entry: version.entry,
    sourceEntry: version.sourceEntry ?? null,
    format: version.format === "markdown" ? "markdown" : "html",
  };
}

export type Plan =
  /** One page: a new document, or the page of the next version, every other file kept. */
  | { action: "page"; file: File; bytes: number; problems: string[]; keeps: number }
  /** One `.zip`: the whole document, or the whole next version. */
  | { action: "zip"; file: File; bytes: number; problems: string[] }
  /** A folder, or files making a document: sent as one zip, the whole document or version. */
  | { action: "bundle"; name: string; files: PickedFile[]; entry: string | null; bytes: number; problems: string[]; drops: string[] }
  /** Loose files laid over the current version, each replacing its namesake or added. */
  | { action: "merge"; files: Placement[]; bytes: number; problems: string[] };

export interface Placement {
  sent: PickedFile;
  /** Where it lands, by the server's rule (`resolveLoose`). */
  at: string;
  does: "replaces" | "adds" | "replaces the page";
}

function bytesOf(files: readonly PickedFile[]): number {
  return files.reduce((n, f) => n + f.file.size, 0);
}

function limitProblems(files: readonly PickedFile[], bytes: number): string[] {
  const problems: string[] = [];
  if (files.length > MAX_BUNDLE_FILES) problems.push(`That’s ${files.length.toLocaleString()} files. A document holds up to ${MAX_BUNDLE_FILES.toLocaleString()}.`);
  if (bytes > MAX_BUNDLE_BYTES) problems.push(`That comes to ${formatBytes(bytes)}. A document can be up to ${formatBytes(MAX_BUNDLE_BYTES)}.`);
  const encoder = new TextEncoder();
  const long = files.find((f) => encoder.encode(f.path).length > MAX_PATH_BYTES);
  if (long) problems.push(`The path ${long.path.slice(0, 60)}… is too long. Shorten a folder or file name in it.`);
  return problems;
}

/** The whole of a new document, or of the next version, from a folder or several files. */
function asBundle(pick: Pick, base: BaseFiles | null): Plan {
  const paths = stripCommonFolder(pick.files.map((f) => f.path));
  const files = pick.files.map((f, i) => ({ path: paths[i], file: f.file }));
  const bytes = bytesOf(files);
  const problems = limitProblems(files, bytes);
  const entry = resolveEntry(paths);
  if (files.length === 0) problems.push("There’s nothing in it to publish.");
  else if (!entry) {
    const pages = paths.filter(isPagePath);
    problems.push(pages.length > 1
      ? `${pages.length} pages could open first: ${pages.slice(0, 3).join(", ")}${pages.length > 3 ? ", …" : ""}. Rename the one you want to open as index.html.`
      : "There’s no page to open. Add an index.html or index.md.");
  } else if (base && (MD_RE.test(entry) ? "markdown" : "html") !== base.format) {
    const kind = base.format === "markdown" ? "Markdown" : "HTML";
    problems.push(`This document is ${kind}, so its next version has to be ${kind} too.`);
  }
  const kept = new Set(paths);
  const drops = base ? base.files.filter((p) => !kept.has(p) && !(base.format === "markdown" && p === base.entry)) : [];
  return { action: "bundle", name: pick.folder ?? "files", files, entry, bytes, problems, drops };
}

/** What publishing a pick would do for a NEW document. */
export function planNew(pick: Pick): Plan {
  if (!pick.fromFolder && pick.files.length === 1) {
    const { file } = pick.files[0];
    if (ZIP_RE.test(file.name)) return { action: "zip", file, bytes: file.size, problems: limitProblems([], file.size) };
    if (isPagePath(file.name)) return { action: "page", file, bytes: file.size, problems: limitProblems([], file.size), keeps: 0 };
    return {
      action: "page", file, bytes: file.size, keeps: 0,
      problems: [`${file.name} isn’t a page. To publish a page with its pictures, choose the folder they’re in, or pick the page and the pictures together.`],
    };
  }
  return asBundle(pick, null);
}

/**
 * What publishing a pick would do as the NEXT VERSION of a document holding
 * `base`: a page replaces the page; a zip or a folder is the whole version;
 * loose files each replace the file of their name or are added.
 */
export function planVersion(pick: Pick, base: BaseFiles): Plan {
  const page = base.sourceEntry ?? (base.format === "markdown" ? "index.md" : base.entry);
  const others = base.files.filter((p) => p !== page && !(base.format === "markdown" && p === base.entry)).length;
  if (!pick.fromFolder && pick.files.length === 1) {
    const { file } = pick.files[0];
    if (ZIP_RE.test(file.name)) return { action: "zip", file, bytes: file.size, problems: limitProblems([], file.size) };
    if (isPagePath(file.name)) {
      const problems = limitProblems([], file.size);
      if (MD_RE.test(file.name) !== (base.format === "markdown")) {
        const kind = base.format === "markdown" ? "Markdown" : "HTML";
        problems.push(`This document is ${kind}, so its page has to be ${kind} too.`);
      }
      return { action: "page", file, bytes: file.size, problems, keeps: others };
    }
  }
  if (pick.fromFolder) return asBundle(pick, base);
  return asMerge(pick.files, base);
}

/** Loose files by the server's rule (`lib/files.ts resolveLoose`). */
function asMerge(files: readonly PickedFile[], base: BaseFiles): Plan {
  const byName = new Map<string, string[]>();
  for (const p of base.files) {
    const name = p.slice(p.lastIndexOf("/") + 1);
    byName.set(name, [...(byName.get(name) ?? []), p]);
  }
  const page = base.sourceEntry ?? (base.format === "markdown" ? "index.md" : base.entry);
  const problems = limitProblems(files, bytesOf(files));
  const placements: Placement[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) problems.push(`Two of these are called ${f.path}. Remove one.`);
    seen.add(f.path);
    if (isLeftOut(f.path)) { problems.push(`${f.path} would be left out, as hidden files never go into a document. Rename it.`); continue; }
    if (base.format === "markdown" && f.path === base.entry) {
      problems.push(`${base.entry} is made from the Markdown, so it can’t be replaced on its own. Drop the Markdown instead.`);
      continue;
    }
    const found = byName.get(f.path) ?? [];
    if (found.length > 1) {
      problems.push(`${found.length} files are called ${f.path}: ${found.join(", ")}. Drop the folder instead, so it’s clear which one you mean.`);
      continue;
    }
    if (found.length === 1) placements.push({ sent: f, at: found[0], does: found[0] === page ? "replaces the page" : "replaces" });
    else placements.push({ sent: f, at: f.path, does: "adds" });
  }
  return { action: "merge", files: placements, bytes: bytesOf(files), problems };
}

/** "41.2 MB", "820 KB", "12 bytes": what a person reads, never "204800 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? "" : "s"}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = (n / 1024 / 1024).toFixed(1);
  return `${mb.endsWith(".0") ? mb.slice(0, -2) : mb} MB`;
}

/** One line for what a pick left out: ".env, .git/ and 2 more were left out". */
export function describeLeftOut(leftOut: readonly string[]): string | null {
  if (leftOut.length === 0) return null;
  const named = leftOut.slice(0, 3);
  const more = leftOut.length - named.length;
  const list = more > 0 ? `${named.join(", ")} and ${more} more` : named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : named[0];
  return `Left out: ${list}. Hidden files and node_modules never go into a document.`;
}
