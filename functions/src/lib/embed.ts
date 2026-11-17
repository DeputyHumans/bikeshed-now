// SPDX-License-Identifier: Apache-2.0
// The embed page another site frames: its frame, its link and its one refusal (SPEC §2 "GET /embed/…", ADR 0031).

/**
 * `docShell` answers `/embed/**` with a page built from `app/embed.html`, the
 * embed entry's own template. It is not the app shell: it holds no router and
 * no sign-in, so a site that frames it cannot reach `/signup` or the consent
 * page through it, which is the whole reason every app-shell path refuses to
 * be framed (SPEC §23).
 *
 * The decision is `decideShell`'s, made in the handler. Everything here is
 * pure string work on the template, with `indexOf` and `slice` only: a
 * replacement string given to `String.replace` expands `$&` and friends, and a
 * title is the author's to choose.
 */

import { escapeAttr, escapeText } from "./html";
import { safeSegment } from "./http";
import type { DocumentDecision } from "./shell";

/** Where Hosting serves the built template. */
export const EMBED_TEMPLATE_PATH = "/embed.html";

/** What makes a body the embed template rather than some other page. */
export const EMBED_MARKER = 'id="embed"';

/** Where the page's body goes, in `app/embed.html`. */
const SLOT = "<!--embed-->";

/**
 * The reading frame's sandbox, as the viewer sets it (`READING_SANDBOX` in
 * `app/src/viewer/frameMode.ts`; a test holds the two equal). No
 * `allow-scripts`: the document's own response carries its lock as well, and
 * only the run variant, which only this origin may frame, could lift it.
 */
export const EMBED_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * The segments after `/embed`, or null when the path is not the embed page's.
 *
 * The prefix is compared decoded and without regard to case. Whatever Hosting
 * sends this function under any spelling of `/embed` must get the embed page
 * or its refusal, never the app shell `docShell` serves for `/d/**`, because
 * every path but `/embed/**` and the byte routes is framed only behind `DENY`
 * and a casing Hosting matched differently would otherwise be an app shell
 * anybody could frame.
 */
export function embedSegments(path: string): string[] | null {
  const raw = path.split("/").filter((p) => p.length > 0);
  if (raw.length === 0) return null;
  let first: string;
  try {
    first = decodeURIComponent(raw[0]);
  } catch {
    return null;
  }
  if (first.toLowerCase() !== "embed") return null;
  try {
    return raw.slice(1).map((s) => decodeURIComponent(s));
  } catch {
    return [];
  }
}

/** True when `path` names the embed page, under any spelling of its prefix. */
export function isEmbedPath(path: string): boolean {
  return embedSegments(path) !== null;
}

export interface EmbedPage {
  docId: string;
  versionId: string;
  /** The version the address pinned, or null when it asked for the current one. */
  requestedVersion: string | null;
  /** The version's entry file, already through `safeRelPath`. */
  entry: string;
  title: string;
  format: "html" | "markdown";
  /** The key that opened it, and only when a key did: a public document's page carries none. */
  token: string | null;
}

/** What the page says, from the decision. */
export function embedPage(input: {
  docId: string;
  requestedVersion: string | null;
  decision: DocumentDecision;
  entry: string;
  /** The stored workspace title; the caller passes "Untitled" when the record has none. */
  docTitle: string;
  format: unknown;
  k: string;
}): EmbedPage {
  const { decision, k } = input;
  return {
    docId: input.docId,
    versionId: decision.versionId,
    requestedVersion: input.requestedVersion,
    entry: input.entry,
    title: input.docTitle,
    format: input.format === "markdown" ? "markdown" : "html",
    // `noindex` is exactly "a key in the URL opened it" (`decideShell`).
    token: decision.noindex && k.length > 0 ? k : null,
  };
}

const segment = (value: string): string => encodeURIComponent(value);

/** The frame's address: the version's files, with the key in the path as the viewer puts it (SPEC §2). */
export function frameSrc(page: EmbedPage): string {
  const key = page.token !== null ? `~${segment(page.token)}/` : "";
  const entry = page.entry.split("/").map(segment).join("/");
  return `/content/${key}${segment(page.docId)}/${segment(page.versionId)}/${entry}`;
}

/** The document's own page, where its comments are. */
export function documentHref(docId: string, requestedVersion: string | null, token: string | null): string {
  return (
    `/d/${segment(docId)}` +
    (requestedVersion !== null ? `/${segment(requestedVersion)}` : "") +
    (token !== null ? `?k=${segment(token)}` : "")
  );
}

/** A link out of the embed, which leaves the host page alone. */
function openLink(href: string): string {
  return `<a id="embed-open" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">Open in Bikeshed</a>`;
}

function splice(template: string, at: string, replacement: string): string {
  const start = template.indexOf(at);
  if (start < 0) throw new Error(`embed template has no ${at}`);
  return template.slice(0, start) + replacement + template.slice(start + at.length);
}

function withTitle(template: string, title: string): string {
  const open = template.indexOf("<title>");
  const close = template.indexOf("</title>", open);
  if (open < 0 || close < 0) throw new Error("embed template has no <title>");
  return template.slice(0, open) + `<title>${escapeText(title)}</title>` + template.slice(close + "</title>".length);
}

/**
 * The page for a document: its frame, and the link to it.
 *
 * The frame is in the markup rather than made by the script, so the document
 * shows before the script arrives, and shows if it never does. The script
 * reads what it needs from the frame's own `data-` attributes.
 */
export function renderEmbed(template: string, page: EmbedPage): string {
  const attrs = [
    `id="embed-frame"`,
    `src="${escapeAttr(frameSrc(page))}"`,
    `sandbox="${EMBED_SANDBOX}"`,
    `title="${escapeAttr(page.title)}"`,
    `data-doc="${escapeAttr(page.docId)}"`,
    `data-version="${escapeAttr(page.versionId)}"`,
    `data-format="${page.format}"`,
    ...(page.token !== null ? [`data-k="${escapeAttr(page.token)}"`] : []),
  ];
  const body = `<iframe ${attrs.join(" ")}></iframe>${openLink(documentHref(page.docId, page.requestedVersion, page.token))}`;
  return splice(withTitle(template, page.title), SLOT, body);
}

/**
 * The one answer for everything that is not a document this page may show:
 * absent, private, expired, in the Trash, a version that does not exist, a
 * malformed path. It names the document only by the id the address already
 * carried, so a private document and an absent one get the same bytes
 * (SPEC §1.4b). Its link is for a member, who can open it in Bikeshed.
 */
export function renderEmbedRefusal(template: string, docId: string | null): string {
  const link = docId !== null && safeSegment(docId) ? openLink(documentHref(docId, null, null)) : "";
  return splice(template, SLOT, `<p id="embed-gone">This document isn’t available here.</p>${link}`);
}
