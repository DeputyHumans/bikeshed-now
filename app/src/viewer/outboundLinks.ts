// SPDX-License-Identifier: Apache-2.0
// A link out of the document opens beside it instead of replacing it (SPEC §6).

import { LINK_ATTR } from "../brand/dom";
import { refusesListeners } from "./frameWatch";

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
  if (refusesListeners(doc)) return retargetOutboundLinks(doc);
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

/**
 * Where the frame delivers the viewer no clicks (viewer/frameWatch.ts), the
 * link has to say it for itself: each one that leaves the document gets
 * `target="_blank" rel="noopener noreferrer"`, which the reading frame's
 * `allow-popups-to-escape-sandbox` lets it act on (frameMode.ts). The
 * author's own values are saved in `LINK_ATTR` first and put back by the
 * cleanup, by the strip legs (`restoreLinks`) and so before any edit, seed or
 * save, because they are the author's markup, not ours.
 */
export function retargetOutboundLinks(doc: Document): () => void {
  const apply = () => {
    for (const link of Array.from(doc.querySelectorAll("a[href], area[href]"))) {
      // Ours already, or the author's own attribute of that name, which is
      // theirs to keep: never overwritten, so such a link keeps its own target.
      if (link.hasAttribute(LINK_ATTR)) continue;
      if ((link.getAttribute("href") ?? "").startsWith("#")) continue;
      if (!leavesDocument((link as HTMLAnchorElement).href, doc.URL)) continue;
      link.setAttribute(LINK_ATTR, JSON.stringify({ target: link.getAttribute("target"), rel: link.getAttribute("rel") }));
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  };
  apply();
  const MO = doc.defaultView?.MutationObserver;
  const observer = MO && doc.body ? new MO(apply) : null;
  if (observer && doc.body) observer.observe(doc.body, { childList: true, subtree: true });
  return () => {
    observer?.disconnect();
    restoreLinks(doc.documentElement);
  };
}

/** What `retargetOutboundLinks` saved on `link`, or null when the attribute is absent or is not ours. */
function savedLink(link: Element): { target: string | null; rel: string | null } | null {
  const raw = link.getAttribute(LINK_ATTR);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const keys = Object.keys(v).sort().join(",");
    const { target, rel } = v as { target?: unknown; rel?: unknown };
    const ok = (x: unknown) => x === null || typeof x === "string";
    return keys === "rel,target" && ok(target) && ok(rel) ? { target: target as string | null, rel: rel as string | null } : null;
  } catch {
    return null;
  }
}

/**
 * Put the author's own `target` and `rel` back wherever `LINK_ATTR` saved them,
 * under `root`. By VALUE, like every strip: an author's own attribute of that
 * name whose value is not what this module writes is left exactly as it is.
 */
export function restoreLinks(root: ParentNode): void {
  for (const link of Array.from(root.querySelectorAll(`[${LINK_ATTR}]`))) {
    const saved = savedLink(link);
    if (saved === null) continue;
    for (const name of ["target", "rel"] as const) {
      const value = saved[name];
      if (value === null) link.removeAttribute(name);
      else link.setAttribute(name, value);
    }
    link.removeAttribute(LINK_ATTR);
  }
}

/** True when `root` still holds a link this module retargeted. */
export function hasRetargetedLinks(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll(`[${LINK_ATTR}]`)).some((link) => savedLink(link) !== null);
}

/** Open an address in a new tab that cannot reach back into the viewer. */
export function openBeside(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
