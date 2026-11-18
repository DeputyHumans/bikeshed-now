// SPDX-License-Identifier: Apache-2.0
// Client for the browser-upload endpoint (SPEC §2, §11).

import type { Marking } from "./types";
import { storedZip } from "./zip";
import type { Plan } from "./bundleInput";

/**
 * The file bytes ARE the request body; metadata rides in the query string.
 *
 * XHR rather than fetch, because a dialog that shows real progress is the
 * difference between "it works" and "did it freeze" on a 20 MB deck, and fetch
 * still cannot report upload progress.
 *
 * Uploaded documents are created `trusted: false` server-side: the uploader is
 * not necessarily the author, so the viewer sandboxes their scripts until
 * somebody with standing says otherwise (SPEC §6c).
 */

export interface UploadResult {
  docId: string;
  versionId: string;
  title: string;
  fileCount: number;
  bytes: number;
  format: "html" | "markdown";
}

/** How a send is watched and stopped. */
export interface SendControl {
  onProgress?: (fraction: number) => void;
  /** Every byte has gone; the deployment is publishing now. */
  onSent?: () => void;
  /** Aborting stops the upload; nothing is published. */
  signal?: AbortSignal;
}

export interface UploadOptions extends SendControl {
  title?: string;
  /** The id to publish at. Taken means a suffixed id, so read `docId` back. */
  id?: string;
  folderId?: string | null;
  marking?: Marking;
}

export function uploadDoc(file: File, opts: UploadOptions = {}): Promise<UploadResult> {
  return uploadNamed(file, file.name, opts);
}

function uploadNamed(body: Blob, filename: string, opts: UploadOptions): Promise<UploadResult> {
  const params = new URLSearchParams();
  params.set("filename", filename);
  if (opts.title) params.set("title", opts.title);
  if (opts.id) params.set("id", opts.id);
  if (opts.folderId) params.set("folderId", opts.folderId);
  if (opts.marking !== undefined) params.set("marking", JSON.stringify(opts.marking));
  return send<UploadResult>(body, params, { forbidden: "You cannot upload to that folder.", ...opts });
}

/** Files as the one `.zip` the deployment takes, each at its path. */
async function zipOf(files: ReadonlyArray<{ path: string; file: File }>): Promise<Blob> {
  const entries = await Promise.all(files.map(async (f) => ({ name: f.path, data: new Uint8Array(await f.file.arrayBuffer()) })));
  return new Blob([storedZip(entries) as BlobPart], { type: "application/zip" });
}

/** Publish a planned NEW document: a page, a zip, or a folder sent as one zip (SPEC §2). */
export async function publishNew(plan: Plan, opts: UploadOptions = {}): Promise<UploadResult> {
  if (plan.action === "page" || plan.action === "zip") return uploadNamed(plan.file, plan.file.name, opts);
  if (plan.action === "bundle") return uploadNamed(await zipOf(plan.files), `${plan.name}.zip`, opts);
  throw new Error("Loose files are laid over a document that already exists.");
}

export interface VersionUploadResult {
  docId: string;
  /** The version now current, or the earlier one these bytes already are. */
  versionId: string;
  contentHash: string;
  fileCount: number;
  bytes: number;
  /** True when the file is a version the document already has: nothing changed. */
  deduped: boolean;
  /** Against the version it replaced, when the deployment could tell without reading it. */
  changes?: { changed: number; unchanged: number; removed: number };
  /** For loose files: where each one went. */
  placed?: Array<{ sent: string; at: string }>;
}

/**
 * Somebody published while the file was being chosen or sent, so it was not
 * put on top of their version. The message says which version is current.
 */
export class StaleUploadError extends Error {
  constructor(readonly currentVersion: string) {
    super(
      currentVersion
        ? `Somebody published ${currentVersion} while this was open, so the file was not published over it. Look at ${currentVersion} first.`
        : "Somebody published a newer version while this was open, so the file was not published over it.",
    );
    this.name = "StaleUploadError";
  }
}

/**
 * Publish a file as the next version of a document the caller edits (SPEC §2).
 *
 * `baseVersion` is the version the uploader was looking at as current. If
 * another has been published since, the server refuses rather than put the
 * file on top of a version they have not seen.
 */
export async function uploadVersion(
  file: File,
  opts: { docId: string; baseVersion: string } & SendControl,
): Promise<VersionUploadResult> {
  return sendVersion(file, file.name, false, opts);
}

/**
 * Publish a planned next version (SPEC §2): a page replaces the page, a zip or
 * a folder is the whole version, and loose files are laid over the current
 * one, each replacing the file of its name.
 */
export async function publishVersion(
  plan: Plan,
  opts: { docId: string; baseVersion: string } & SendControl,
): Promise<VersionUploadResult> {
  if (plan.action === "page" || plan.action === "zip") return sendVersion(plan.file, plan.file.name, false, opts);
  if (plan.action === "bundle") return sendVersion(await zipOf(plan.files), `${plan.name}.zip`, false, opts);
  // Sent by the names they were dropped with; the deployment places each by
  // the rule the dialog showed (SPEC §2, `merge=1`).
  return sendVersion(await zipOf(plan.files.map((p) => p.sent)), "files.zip", true, opts);
}

async function sendVersion(
  body: Blob,
  filename: string,
  merge: boolean,
  opts: { docId: string; baseVersion: string } & SendControl,
): Promise<VersionUploadResult> {
  const params = new URLSearchParams();
  params.set("filename", filename);
  params.set("update", opts.docId);
  if (opts.baseVersion) params.set("baseVersion", opts.baseVersion);
  if (merge) params.set("merge", "1");
  try {
    return await send<VersionUploadResult>(body, params, {
      forbidden: "You can no longer publish to this document.",
      ...opts,
    });
  } catch (e) {
    const detail = e instanceof UploadRefused ? e.detail : null;
    if (e instanceof UploadRefused && e.status === 409 && typeof detail?.currentVersion === "string") {
      throw new StaleUploadError(detail.currentVersion);
    }
    throw e;
  }
}

/** A refusal with the reply's body, so a caller can read more than the sentence. */
class UploadRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

/** The upload was stopped by the person sending it; nothing was published. */
export class UploadStopped extends Error {
  constructor() {
    super("The upload was stopped. Nothing was published.");
    this.name = "UploadStopped";
  }
}

function send<T>(
  body: Blob,
  params: URLSearchParams,
  opts: { forbidden: string } & SendControl,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new UploadStopped());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/publish?${params.toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    const stop = () => xhr.abort();
    opts.signal?.addEventListener("abort", stop, { once: true });
    xhr.onloadend = () => opts.signal?.removeEventListener("abort", stop);
    xhr.onabort = () => reject(new UploadStopped());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.upload.onload = () => opts.onSent?.();
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new Error("The upload succeeded but the reply was unreadable."));
        }
        return;
      }
      let message = `Upload failed (${xhr.status}).`;
      let detail: Record<string, unknown> | null = null;
      if (xhr.status === 401) message = "Your session expired — sign in again.";
      else if (xhr.status === 403) message = opts.forbidden;
      else {
        try {
          const data = JSON.parse(xhr.responseText) as Record<string, unknown> | null;
          if (data && typeof data === "object") detail = data;
          if (typeof data?.error === "string" && data.error) message = sentence(data.error);
        } catch {
          /* keep the generic message */
        }
      }
      reject(new UploadRefused(message, xhr.status, detail));
    };

    xhr.send(body);
  });
}

/**
 * The server's refusals are written to be read by an agent as well, often as a
 * clause: "this document is HTML, so an update to it cannot be Markdown". A
 * person is shown it as a sentence.
 */
function sentence(text: string): string {
  const t = text.trim();
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}

/** File types the uploader accepts on their own. Mirrors functions/src/lib/bundle.ts. */
export function isUploadable(file: File): boolean {
  return /\.(html?|md|markdown|zip)$/i.test(file.name);
}

/** A human description of what can be uploaded, for the dropzone. */
export const UPLOAD_HINT =
  "A page (.html or .md), a .zip, or a folder with a page and its files";
