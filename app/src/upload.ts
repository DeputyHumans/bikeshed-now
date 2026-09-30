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
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams();
    params.set("filename", file.name);
    if (opts.title) params.set("title", opts.title);
    if (opts.id) params.set("id", opts.id);
    if (opts.folderId) params.set("folderId", opts.folderId);
    if (opts.marking?.enabled) params.set("marking", JSON.stringify(opts.marking));

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
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new Error("The upload succeeded but the reply was unreadable."));
        }
        return;
      }
      let message = `Upload failed (${xhr.status}).`;
      if (xhr.status === 401) message = "Your session expired — sign in again.";
      else if (xhr.status === 403) message = "You cannot upload to that folder.";
      else {
        try {
          const data = JSON.parse(xhr.responseText) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          /* keep the generic message */
        }
      }
      reject(new Error(message));
    };

    xhr.send(file);
  });
}

/** File types the uploader accepts. Mirrors functions/src/lib/bundle.ts. */
export function isUploadable(file: File): boolean {
  return /\.(html?|md|markdown|zip)$/i.test(file.name);
}

/** A human description of what can be uploaded, for the dropzone. */
export const UPLOAD_HINT =
  "A self-contained .html file, a .md file, or a .zip bundle";
