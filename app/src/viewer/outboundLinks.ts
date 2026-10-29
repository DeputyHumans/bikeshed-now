// SPDX-License-Identifier: Apache-2.0
// A link out of the document opens beside it instead of replacing it (SPEC §6).

/**
 * Why the viewer handles these clicks at all
 * -----------------------------------------
 * The document is a frame inside the viewer. A link with no target navigates
 * that frame, so a reader who followed one lost the document, its comments and
 * the viewer around it to somebody else's page — often a refusal, since most
 * sites forbid framing. `target="_blank"` was no way out: a sandboxed frame may
 * not open a tab, so those links did nothing.
 *
 * So a click on a link that leaves the document is taken by the viewer and
 * opened in a new tab from the parent, which is never sandboxed. A link within
 * the document scrolls as it always did, and a link to another file of the same
 * version — a bundle's own pages — still navigates the frame.
 */

/** `/content/[~key/][!run/]{docId}/{versionId}/` or `/draft/{docId}/`: one version's files. */
const VERSION_ROOT = /^\/content\/(?:~[^/]+\/)?(?:!run\/)?[^/]+\/[^/]+\/|^\/draft\/[^/]+\//;

/** Does following `href` from the document at `documentUrl` leave it? */
export function leavesDocument(href: string, documentUrl: string): boolean {
  let url: URL;
  let here: URL;
  try {
    url = new URL(href, documentUrl);
    here = new URL(documentUrl);
  } catch {
    return false;
  }
  // mailto:, tel:, javascript: and the rest are the browser's business, and
  // the sandbox already decides which of them may happen.
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin !== here.origin) return true;
  if (url.pathname === here.pathname && url.search === here.search) return false;
  const root = VERSION_ROOT.exec(here.pathname)?.[0];
  return !(root && url.pathname.startsWith(root));
}

/**
 * Take every click on a link that leaves `doc` and hand its address to `open`.
 *
 * On the frame's window, in the capture phase, so it runs before anything the
 * document registered and a trusted document's own handlers cannot let the
 * frame navigate first. Only the default action is taken; the click still
 * reaches the document and the annotation layer.
 */
export function attachOutboundLinks(doc: Document, open: (url: string) => void): () => void {
  const target: EventTarget = doc.defaultView ?? doc;
  const onClick = (e: Event) => {
    const el = e.target as Element | null;
    const link = el?.closest?.("a[href], area[href]") as HTMLAnchorElement | HTMLAreaElement | null;
    if (!link) return;
    // Written as a fragment, it means this document whatever a <base> says its
    // address resolves to.
    if ((link.getAttribute("href") ?? "").startsWith("#")) return;
    if (!leavesDocument(link.href, doc.URL)) return;
    e.preventDefault();
    open(link.href);
  };
  target.addEventListener("click", onClick, true);
  return () => target.removeEventListener("click", onClick, true);
}

/** Open an address in a new tab that cannot reach back into the viewer. */
export function openBeside(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
