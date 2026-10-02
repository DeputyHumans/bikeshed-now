// SPDX-License-Identifier: Apache-2.0
// Downloading a document as its own files (SPEC §2, §11).

/**
 * A single-file document downloads its entry directly through the gated proxy.
 * A multi-file bundle comes from the server as a .zip, because assembling one
 * in the browser would mean a zip library — and the app ships with no zip
 * library, no PDF library and no UI kit, which is the discipline worth keeping.
 */

import { contentBase } from "../viewer/frameMode";

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

/**
 * A filename derived from a title the user chose.
 *
 * Separators are replaced rather than removed, so a title reads the same in the
 * download. Leading dots and dashes are then stripped too: a file called
 * `..-..-etc-passwd` is hidden on Unix, confusing everywhere, and tells the
 * reader nothing about what they downloaded.
 */
function safeFilename(name: string): string {
  const cleaned = (name || "document")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "document";
}

/**
 * Download the entry file, named from the document's title. `linkKey` is an
 * unlisted document's token, for a reader whose only access is the link.
 */
export async function downloadEntry(
  docId: string,
  versionId: string,
  entry: string,
  title: string,
  { extension = "html", linkKey }: { extension?: string; linkKey?: string } = {},
): Promise<void> {
  const res = await fetch(`${contentBase(docId, versionId, linkKey)}${entry}`, {
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
  linkKey?: string,
): Promise<void> {
  const extension = sourceEntry.split(".").pop() || "md";
  return downloadEntry(docId, versionId, sourceEntry, title, { extension, linkKey });
}

/** Download a multi-file bundle as a .zip, assembled by the server. */
export function downloadZip(docId: string, versionId: string, linkKey?: string): void {
  // The endpoint sets Content-Disposition, so a same-origin anchor click
  // downloads it with the session cookie attached. One request, so the token
  // can ride in the query.
  const a = document.createElement("a");
  const key = linkKey ? `?k=${encodeURIComponent(linkKey)}` : "";
  a.href = `/download/${docId}/${versionId}${key}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
