// SPDX-License-Identifier: Apache-2.0
// The app shell for a document page, and the head injected into it for crawlers (SPEC §17).

/**
 * Hosting answers every `/d/**` request with the SPA shell, whose `<head>`
 * says "Bikeshed" and nothing about the document, so a pasted link unfurls as
 * the product rather than the page. `docShell` puts a function in that path.
 * It serves the same shell to everyone, and — only when the document is
 * readable without an account — with the document's own title, description,
 * keywords and Open Graph tags spliced in.
 *
 * Everything that decides or builds lives here, pure and unit-tested; the
 * handler is glue. The decision is deliberately anonymous: no caller, cookie
 * or member check, because the response may be cached at a public URL and
 * whatever it carries is what a stranger may see (SPEC §17 "Caching").
 *
 * Every refusal is the one frozen `GENERIC` object, so a generic answer can
 * carry no document-specific byte by construction (SPEC §1.4b).
 */

import { PUBLIC_CACHE_SECONDS } from "../config";
import { type DocAclData, expiryMs, isExpired, visibilityOf } from "./acl";
import type { DocHead } from "./head";
import { escapeAttr, escapeText } from "./html";

/* ------------------------------------------------------------------------ */
/* The decision                                                              */

export const GENERIC: Readonly<{ kind: "generic" }> = Object.freeze({ kind: "generic" as const });

export interface DocumentDecision {
  kind: "document";
  versionId: string;
  /** Seconds the page may be cached publicly: the content window, cut at expiry. */
  maxAge: number;
  /** True for an unlisted document: served, but not for crawlers to index. */
  noindex: boolean;
}

export type ShellDecision = typeof GENERIC | DocumentDecision;

/** The stored fields this decision reads, all untrusted in shape. */
export interface ShellDoc extends DocAclData {
  linkToken?: unknown;
  currentVersion?: unknown;
  title?: unknown;
}

/**
 * Whether to render the document's head into the shell, and for which version.
 *
 * The rules mirror `contentProxy` for an anonymous caller: private and expired
 * documents are refused (the owner included — their tab title comes from the
 * client), unlisted needs the link token, and the cache window is the content
 * window capped at the time left before expiry, so `max-age` never outlives
 * the date. A `k` that is absent must never match a token that is absent,
 * which is why both sides are checked for being a non-empty string first.
 */
export function decideShell(input: {
  doc: ShellDoc | null;
  k: string;
  versionId: string | null;
  now: number;
}): ShellDecision {
  const { doc, k, now } = input;
  if (doc === null) return GENERIC;
  const visibility = visibilityOf(doc);
  if (visibility === "private") return GENERIC;
  if (isExpired(doc, now)) return GENERIC;
  if (visibility === "unlisted") {
    if (k.length === 0 || typeof doc.linkToken !== "string" || k !== doc.linkToken) return GENERIC;
  }
  const versionId = input.versionId ?? doc.currentVersion;
  if (typeof versionId !== "string" || versionId.length === 0) return GENERIC;

  const at = expiryMs(doc);
  const left = at === null ? PUBLIC_CACHE_SECONDS : Math.floor((at - now) / 1000);
  const maxAge = Math.max(0, Math.min(PUBLIC_CACHE_SECONDS, left));
  return { kind: "document", versionId, maxAge, noindex: visibility === "unlisted" };
}

/* ------------------------------------------------------------------------ */
/* The image                                                                 */

/** The brand card, served by Hosting, for a document that declares no usable image. */
export const DEFAULT_CARD = Object.freeze({ path: "/brand/og-default.png", width: 1200, height: 630 });

export interface ImageContext {
  origin: string;
  docId: string;
  versionId: string;
  entry: string;
  files: readonly string[];
  /** The link token to carry on a same-origin image, or null for none. */
  k: string | null;
}

/**
 * The absolute URL a crawler may fetch for the document's image.
 *
 * One rule: resolve the reference against the entry's own URL under the
 * content proxy, as a browser would. A same-origin result must stay inside
 * this version's prefix and name a file the version actually contains — the
 * proxy would refuse anything else, and a preview that points at a 404 is
 * worse than the brand card. It carries the link token when there is one,
 * because the proxy needs it for an unlisted document. A cross-origin http(s)
 * URL is the author's to point wherever they like. Anything else — no image,
 * `data:`, `javascript:`, an escape from the prefix, a file not in the
 * version, a reference the parser rejects — is the default card.
 */
export function resolveImage(raw: string | null, ctx: ImageContext): { url: string; isDefault: boolean } {
  const fallback = { url: `${ctx.origin}${DEFAULT_CARD.path}`, isDefault: true };
  if (raw === null) return fallback;
  try {
    const prefix = `/content/${ctx.docId}/${ctx.versionId}/`;
    const u = new URL(raw, `${ctx.origin}${prefix}${ctx.entry}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return fallback;
    if (u.origin !== ctx.origin) return { url: u.href, isDefault: false };
    if (!u.pathname.startsWith(prefix)) return fallback;
    const rel = decodeURIComponent(u.pathname.slice(prefix.length));
    if (!ctx.files.includes(rel)) return fallback;
    const query = typeof ctx.k === "string" && ctx.k.length > 0 ? `?k=${encodeURIComponent(ctx.k)}` : "";
    return { url: `${u.origin}${u.pathname}${query}`, isDefault: false };
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------------ */
/* The page and its rendering                                                */

export interface ShellPage {
  title: string;
  description: string | null;
  keywords: string | null;
  /** The canonical URL of this page, as `og:url`. */
  url: string;
  image: string;
  imageIsDefault: boolean;
  noindex: boolean;
}

/** Everything the shell says about a document, from the decision and the document's own head. */
export function composePage(input: {
  origin: string;
  docId: string;
  requestedVersion: string | null;
  decision: DocumentDecision;
  /** The stored workspace title; the caller passes "Untitled" when the record has none. */
  docTitle: string;
  head: DocHead;
  entry: string;
  files: readonly string[];
  k: string;
}): ShellPage {
  const { origin, docId, requestedVersion, decision, head, k } = input;
  const noindex = decision.noindex;
  // The token belongs on an unlisted document's links and nowhere else: a
  // public document's page must not carry whatever `k` a request happened to.
  const token = noindex && k.length > 0 ? k : null;
  const url =
    `${origin}/d/${docId}` +
    (requestedVersion !== null ? `/${requestedVersion}` : "") +
    (token !== null ? `?k=${encodeURIComponent(token)}` : "");
  const image = resolveImage(head.image, {
    origin,
    docId,
    versionId: decision.versionId,
    entry: input.entry,
    files: input.files,
    k: token,
  });
  return {
    title: head.title ?? input.docTitle,
    description: head.description,
    keywords: head.keywords,
    url,
    image: image.url,
    imageIsDefault: image.isDefault,
    noindex,
  };
}

/** The first `<title …>…</title>`, attributes and newlines allowed, any case. */
const TITLE = /<title(?:\s[^>]*)?>[\s\S]*?<\/title\s*>/i;
/** Every `<meta …>`; which one is the description is decided per tag, so attribute order is free. */
const META = /<meta\s[^>]*>/gi;
const NAME_IS_DESCRIPTION = /\sname\s*=\s*(?:"description"|'description')/i;
const HEAD_END = /<\/head\s*>/i;

/**
 * The shell with this page's head spliced in.
 *
 * Pure string surgery on the template, and only ever with `indexOf`/`slice`:
 * `String.replace` with a replacement STRING expands `$&`, `` $` ``, `$'` and
 * `$1` inside it, so a title of `$'` would paste the rest of the template into
 * itself. Every value goes through `lib/html.ts` on the way in.
 *
 * Throws when the template lacks a `<title>`, a description meta or `</head>`,
 * so the handler serves the untouched template rather than half a page.
 */
export function renderShell(template: string, page: ShellPage): string {
  const title = TITLE.exec(template);
  if (title === null) throw new Error("shell template has no <title>");
  let html = splice(template, title.index, title.index + title[0].length, `<title>${escapeText(page.title)}</title>`);

  const description = findDescriptionMeta(html);
  if (description === null) throw new Error("shell template has no description meta");
  html = splice(
    html,
    description.start,
    description.end,
    page.description === null ? "" : `<meta name="description" content="${escapeAttr(page.description)}" />`,
  );

  const headEnd = HEAD_END.exec(html);
  if (headEnd === null) throw new Error("shell template has no </head>");
  const lines = [
    `<meta property="og:site_name" content="Bikeshed" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${escapeAttr(page.title)}" />`,
  ];
  if (page.description !== null) {
    lines.push(`<meta property="og:description" content="${escapeAttr(page.description)}" />`);
  }
  lines.push(
    `<meta property="og:url" content="${escapeAttr(page.url)}" />`,
    `<meta property="og:image" content="${escapeAttr(page.image)}" />`,
  );
  if (page.imageIsDefault) {
    lines.push(
      `<meta property="og:image:width" content="${DEFAULT_CARD.width}" />`,
      `<meta property="og:image:height" content="${DEFAULT_CARD.height}" />`,
    );
  }
  lines.push(`<meta name="twitter:card" content="summary_large_image" />`);
  if (page.keywords !== null) lines.push(`<meta name="keywords" content="${escapeAttr(page.keywords)}" />`);
  if (page.noindex) lines.push(`<meta name="robots" content="noindex" />`);

  // Aligned with `</head>` when it sits on its own line, so the output reads
  // like the template did; otherwise inserted flush against it.
  const lineStart = html.lastIndexOf("\n", headEnd.index) + 1;
  const before = html.slice(lineStart, headEnd.index);
  const indent = /^[ \t]*$/.test(before) ? before : "";
  return splice(html, headEnd.index, headEnd.index, `${lines.join(`\n${indent}`)}\n${indent}`);
}

/** The first `<meta …>` whose attributes include `name="description"`. */
function findDescriptionMeta(html: string): { start: number; end: number } | null {
  META.lastIndex = 0;
  for (let m = META.exec(html); m !== null; m = META.exec(html)) {
    if (NAME_IS_DESCRIPTION.test(m[0])) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** `text` in place of `[start, end)`. Literal: nothing in `text` is a pattern. */
function splice(s: string, start: number, end: number, text: string): string {
  return s.slice(0, start) + text + s.slice(end);
}

/* ------------------------------------------------------------------------ */
/* Reading the entry's prefix                                                */

/**
 * The first `cap` bytes of a stream, or all of it when it is shorter.
 *
 * The handler asks Storage for a byte range, but a proxy or the emulator may
 * ignore the range and send the whole object; the cap is enforced here
 * regardless, and the stream is destroyed the moment it is reached so a large
 * document is not read to the end for the sake of its head.
 */
export function collectPrefix(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    stream.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = cap - total;
      if (bytes.length < room) {
        chunks.push(bytes);
        total += bytes.length;
        return;
      }
      chunks.push(bytes.subarray(0, room));
      settled = true;
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      resolve(Buffer.concat(chunks));
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/* ------------------------------------------------------------------------ */
/* The shell itself                                                          */

export interface ShellSource {
  origin: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** How long one request for the shell may take before the cached copy answers instead. */
const SHELL_FETCH_TIMEOUT_MS = 5000;

/** The adopted shell and the ETag Hosting gave it, for the whole process. */
let cached: { etag: string | null; body: string } | null = null;
let originLogged = false;

/**
 * The SPA shell, as Hosting serves it at `/`.
 *
 * Fetched on every call so a deploy is picked up, but revalidated by ETag so
 * the usual answer is a 304 with no body. A body is adopted only when it is
 * evidently this app's shell: `res.ok`, `text/html`, and both the root marker
 * and a hashed module asset present. Hosting answers `/` with an HTML 404
 * page before the site is deployed, and a misconfigured origin can be a
 * stranger's site; neither may become the copy this process pins. Any other
 * outcome — non-ok, wrong type, no markers, network error, timeout — serves
 * the cached copy, or throws when there is none yet.
 */
export async function loadShell(source: ShellSource): Promise<string> {
  const log = source.log ?? console.log;
  if (!originLogged) {
    originLogged = true;
    log(`shell origin: ${source.origin}`);
  }
  const fetchImpl = source.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: "text/html" };
  if (cached !== null && cached.etag !== null) headers["If-None-Match"] = cached.etag;

  let refused: string;
  try {
    const res = await fetchImpl(`${source.origin}/`, {
      headers,
      signal: AbortSignal.timeout(SHELL_FETCH_TIMEOUT_MS),
    });
    if (res.status === 304 && cached !== null) return cached.body;
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.toLowerCase().startsWith("text/html")) {
      const body = await res.text();
      if (body.includes('id="root"') && body.includes("/assets/")) {
        cached = { etag: res.headers.get("etag"), body };
        return body;
      }
      refused = `${res.status} without the app's markers`;
    } else {
      refused = `${res.status} ${type || "(no content type)"}`;
    }
  } catch (error) {
    if (cached !== null) return cached.body;
    throw error;
  }
  if (cached !== null) return cached.body;
  throw new Error(`shell not adopted: ${refused}`);
}

/** Forgets the adopted shell and the logged origin, so each test starts clean. */
export function resetShellCacheForTests(): void {
  cached = null;
  originLogged = false;
}

/**
 * One line at start-up when the emulator has no origin to fetch the shell
 * from, because the symptom — every `/d/**` answers 503 — is far from the
 * cause. Silent in production: there `publicOrigin()` derives one.
 */
export function warnIfOriginUnconfigured(env: NodeJS.ProcessEnv, emulated: boolean, log: (line: string) => void): void {
  if (emulated && !env.BIKESHED_PUBLIC_ORIGIN) {
    log(
      "docShell: BIKESHED_PUBLIC_ORIGIN is unset — /d/** will answer 503; set BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050 in functions/.env.local",
    );
  }
}
