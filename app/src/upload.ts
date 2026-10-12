// SPDX-License-Identifier: Apache-2.0
// Client for the browser-upload endpoint (SPEC §2, §11).

import type { Marking } from "./types";

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

export interface UploadOptions {
  title?: string;
  /** The id to publish at. Taken means a suffixed id, so read `docId` back. */
  id?: string;
  folderId?: string | null;
  marking?: Marking;
  onProgress?: (fraction: number) => void;
}

export function uploadDoc(file: File, opts: UploadOptions = {}): Promise<UploadResult> {
  const params = new URLSearchParams();
  params.set("filename", file.name);
  if (opts.title) params.set("title", opts.title);
  if (opts.id) params.set("id", opts.id);
  if (opts.folderId) params.set("folderId", opts.folderId);
  if (opts.marking?.enabled) params.set("marking", JSON.stringify(opts.marking));
  return send<UploadResult>(file, params, {
    forbidden: "You cannot upload to that folder.",
    onProgress: opts.onProgress,
  });
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
  opts: { docId: string; baseVersion: string; onProgress?: (fraction: number) => void },
): Promise<VersionUploadResult> {
  const params = new URLSearchParams();
  params.set("filename", file.name);
  params.set("update", opts.docId);
  if (opts.baseVersion) params.set("baseVersion", opts.baseVersion);
  try {
    return await send<VersionUploadResult>(file, params, {
      forbidden: "You can no longer publish to this document.",
      onProgress: opts.onProgress,
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

function send<T>(
  file: File,
  params: URLSearchParams,
  opts: { forbidden: string; onProgress?: (fraction: number) => void },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/publish?${params.toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
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

    xhr.send(file);
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

/** File types the uploader accepts. Mirrors functions/src/lib/bundle.ts. */
export function isUploadable(file: File): boolean {
  return /\.(html?|md|markdown|zip)$/i.test(file.name);
}

/** A human description of what can be uploaded, for the dropzone. */
export const UPLOAD_HINT =
  "A self-contained .html file, a .md file, or a .zip bundle";
