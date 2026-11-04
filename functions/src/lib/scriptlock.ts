// SPDX-License-Identifier: Apache-2.0
// Whether a document's own script may run in a response, and the header that says so (SPEC §2, §6c; ADR 0021).

import { canManageSharing, type DocAclData } from "./acl";

/**
 * Why the server says this at all
 * -------------------------------
 * The app's frame sandboxes an untrusted document, but the sandbox is an
 * attribute of the FRAME. The same bytes opened any other way — a pasted
 * `/content/…` address, a popup, an `<object>` — were a page on this origin
 * with its scripts running, able to act as whoever opened it. So every
 * response a browser could render as a scripted document carries the sandbox
 * itself, and the one way a document's script runs is a URL that asks for it
 * and a server that agrees.
 */

/**
 * The response types a browser never renders as a document that runs script.
 * Everything else is locked, a type nobody thought of included.
 *
 * This was once the other way round: a list of the scriptable types, five of
 * them. Browsers render ANY `+xml` type as an XML document, and an element in
 * the XHTML namespace runs there, so `.atom`, `.rss`, `.rdf`, `.xslt` and some
 * hundred more were served unlocked on this origin, as whoever opened them.
 * A list of the dangerous types has to be complete to be safe; a list of the
 * harmless ones only has to be right. A lock on a subresource (a script, a
 * stylesheet, a picture) is ignored, so locking too much costs nothing.
 */
const INERT = new Set([
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/json",
  "text/json",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/pdf",
  "application/octet-stream",
  "application/zip",
  "application/wasm",
]);

/** Pictures, sound, video and type: never a document, except a picture that is XML. */
const INERT_FAMILY = /^(image|audio|video|font)\//;

/**
 * The lock: rendered, readable by the app on `contentDocument`, and inert.
 * `allow-same-origin` without `allow-scripts` is what the frame already sets,
 * so inside the app it changes nothing.
 */
export const SCRIPT_LOCK = "sandbox allow-same-origin";

/**
 * The run variant may only be framed by this origin's own pages. Its
 * unlocked answer depends on who asks, and a page elsewhere has no business
 * putting that answer in front of anyone.
 */
export const RUN_ANCESTORS = "frame-ancestors 'self'";

/**
 * The path segment that asks for a document's script to run, after any key
 * and before the document id: `/content/[~key/]!run/{docId}/{versionId}/…`.
 * A path segment, so every relative reference inherits it; `!` can never
 * begin a document id (`isValidDocId`), so it can never be mistaken for one.
 */
export const RUN_SEGMENT = "!run";

/**
 * True unless the type is one a browser never renders as a scripted document.
 * Parameters and case are ignored. An XML type is scriptable whatever its
 * family (`image/svg+xml`); a JSON one is shown as text.
 */
export function isScriptable(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.endsWith("+xml") || base.endsWith("/xml")) return true;
  if (base.endsWith("+json")) return false;
  if (INERT_FAMILY.test(base)) return false;
  return !INERT.has(base);
}

/**
 * The Content-Security-Policy for one content response, or null for none.
 *
 * Every scriptable response is locked unless it was asked for as the run
 * variant AND the server agreed (`unlocked`). The run variant carries
 * `frame-ancestors` whatever the answer.
 */
export function contentSecurityPolicy(input: {
  contentType: string;
  run: boolean;
  unlocked: boolean;
}): string | null {
  const parts: string[] = [];
  if (isScriptable(input.contentType) && !(input.run && input.unlocked)) parts.push(SCRIPT_LOCK);
  if (input.run) parts.push(RUN_ANCESTORS);
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Global trust is `trusted === true` and nothing else. An absent flag was once
 * read as trusted, for documents older than the flag; it now fails closed.
 */
export function globallyTrusted(doc: object | null | undefined): boolean {
  return (doc as { trusted?: unknown } | null | undefined)?.trusted === true;
}

/**
 * May this caller trust the document for EVERYONE?
 *
 * Running a document's script for every reader lets its author act as each of
 * them, so it is no longer the owner's call alone: only a superadmin, named in
 * deployment configuration and never in this repository, and only on a
 * document they own. Every other reader decides for themselves.
 */
export function canTrustForEveryone(
  doc: DocAclData | null | undefined,
  emailLower: string,
  superadmins: ReadonlySet<string>,
): boolean {
  return canManageSharing(doc, emailLower) && superadmins.has(emailLower.toLowerCase());
}

/**
 * A browser fetching a service worker's script says so in this header. No
 * document may register one from content: a worker outlives the page, and the
 * responses it builds would carry no lock.
 */
export function isServiceWorkerFetch(header: string | undefined): boolean {
  return typeof header === "string" && header.trim().toLowerCase() === "script";
}
