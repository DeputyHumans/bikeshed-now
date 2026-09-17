// SPDX-License-Identifier: Apache-2.0
// Downloading a document as its own files (SPEC §2, §11).

/**
 * A single-file document downloads its entry directly through the gated proxy.
 * A multi-file bundle comes from the server as a .zip, because assembling one
 * in the browser would mean a zip library — and the app ships with no zip
 * library, no PDF library and no UI kit, which is the discipline worth keeping.
 */

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(name: string): string {
  return (name || "document").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Download the entry file, named from the document's title. */
export async function downloadEntry(
  docId: string,
  versionId: string,
  entry: string,
  title: string,
  extension = "html",
): Promise<void> {
  const res = await fetch(`/content/${docId}/${versionId}/${entry}`, {
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "Your session expired — sign in again."
        : `Could not fetch the document (${res.status}).`,
    );
  }
  saveBlob(await res.blob(), `${safeFilename(title)}.${extension}`);
}

/**
 * Download the Markdown SOURCE of a Markdown-authored document.
 *
 * Served from the same gated path as everything else, because the source is
 * part of the bundle rather than a separate artifact — which is also why
 * republishing it is idempotent.
 */
export function downloadSource(
  docId: string,
  versionId: string,
  sourceEntry: string,
  title: string,
): Promise<void> {
  const extension = sourceEntry.split(".").pop() || "md";
  return downloadEntry(docId, versionId, sourceEntry, title, extension);
}

/** Download a multi-file bundle as a .zip, assembled by the server. */
export function downloadZip(docId: string, versionId: string): void {
  // The endpoint sets Content-Disposition, so a same-origin anchor click
  // downloads it with the session cookie attached.
  const a = document.createElement("a");
  a.href = `/download/${docId}/${versionId}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
