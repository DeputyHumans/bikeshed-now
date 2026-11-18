// SPDX-License-Identifier: Apache-2.0
// What a stranger or a crawler can reach: the sitemap, the document shell, its Markdown, the embed (SPEC §2, §17).

import { versionStoragePrefix } from "../lib/storage";
import { onRequest, type Request } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { PUBLIC_CACHE_SECONDS, publicOrigin } from "../config";
import { isExpired, readBasis, type DocAclData, type FolderAclData } from "../lib/acl";
import { folderOfDoc } from "../lib/reach";
import { resolveCaller } from "../lib/actor";
import {
  composeReading,
  contentAddress,
  readerAddress,
  readingPreamble,
} from "../lib/markdown/reading";
import { storedReading } from "../lib/markdown/stored";
import { HEAD_SCAN_BYTES, readHead } from "../lib/head";
import {
  collectPrefix,
  composeFolderPage,
  composePage,
  decideFolderShell,
  decideShell,
  loadShell,
  renderShell,
  type ShellDoc,
} from "../lib/shell";
import { sitemapXml } from "../lib/sitemap";
import {
  EMBED_MARKER,
  EMBED_TEMPLATE_PATH,
  embedPage,
  embedSegments,
  renderEmbed,
  renderEmbedRefusal,
} from "../lib/embed";
import {
  noStore,
  pathSegments,
  rejectMethod,
  safeRelPath,
  safeSegment,
  strParam,
} from "../lib/http";
import { db, bucket, PLAIN, READS_PAGES, WARM } from "./runtime";
import { contentTypeOf, readGate, setContentCache } from "./content";

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

/**
 * GET /sitemap.xml — the site's own public pages, and public documents.
 *
 * Unlisted documents are deliberately absent: they carry `X-Robots-Tag: noindex`
 * and exist to be shared by link, so listing them here would defeat the entire
 * distinction between the two levels.
 */
export const sitemap = onRequest(PLAIN, async (req, res) => {
  if (rejectMethod(req, res, ["GET"])) return;
  const snap = await db()
    .collection("public")
    .where("visibility", "==", "public")
    .orderBy("publishedAt", "desc")
    .limit(5000)
    .get();

  const documents = snap.docs
    // An expired document is not served, so listing it would be advertising a
    // 404 to a crawler. The projection carries the date precisely so this can
    // be decided without a second read per row. A trashed one has no
    // projection at all (publicdoc.ts), so it is never in this list.
    .filter((d) => !isExpired(d.data() as DocAclData, Date.now()))
    .map((d) => {
      const at = d.data()?.publishedAt as admin.firestore.Timestamp | undefined;
      return { id: d.id, lastmod: at?.toDate ? at.toDate().toISOString().slice(0, 10) : "" };
    });

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", `public, max-age=${PUBLIC_CACHE_SECONDS}`);
  res.status(200).send(sitemapXml(publicOrigin(), documents));
});

/**
 * `GET /folder/:folderId` — the shell, naming the folder when its own public
 * level or its key opens it. Its own function so `docShell`'s staged fallback
 * stays the document's alone. Nothing inside the folder is read, so the only
 * step that can throw is the one read of the folder and the render; either
 * way the answer is the generic shell, uncacheable.
 */
async function serveFolderShell(
  req: Request,
  res: import("express").Response,
  segments: string[],
  template: string,
  serveGeneric: () => void,
): Promise<void> {
  if (segments.length !== 1) {
    serveGeneric();
    return;
  }
  const [folderId] = segments;
  const k = strParam(req, "k");
  try {
    const folderSnap = await db().collection("folders").doc(folderId).get();
    const folder = folderSnap.exists ? (folderSnap.data() as FolderAclData & { name?: unknown }) : null;
    const decision = decideFolderShell({ folder, k, now: Date.now() });
    if (decision.kind === "generic" || folder === null) {
      serveGeneric();
      return;
    }
    const html = renderShell(template, composeFolderPage({
      origin: publicOrigin(),
      folderId,
      name: typeof folder.name === "string" && folder.name ? folder.name : "Untitled folder",
      decision,
      k,
    }));
    // ONLY NOW, as for a document: the page exists, so this URL may be cached with it.
    res.setHeader("Cache-Control", `public, max-age=${decision.maxAge}`);
    if (decision.noindex) res.setHeader("X-Robots-Tag", "noindex");
    res.status(200);
    if (req.method === "HEAD") res.end();
    else res.send(html);
  } catch (err) {
    console.warn("docShell: generic fallback at folder", (err as { code?: unknown })?.code ?? (err as Error)?.name);
    noStore(res);
    res.removeHeader("X-Robots-Tag");
    serveGeneric();
  }
}

/**
 * GET /d/:docId[/:versionId] — the app shell for a document page, with the
 * document's own head for crawlers (SPEC §17).
 *
 * Hosting would answer with the static shell, whose head says "Bikeshed" and
 * nothing about the document; crawlers run no JS, so a pasted link unfurled
 * as the product. This serves the same shell to everyone and, only when
 * `decideShell` says the document is readable without an account, with its
 * title, description, keywords and Open Graph tags spliced in.
 *
 * It never authenticates. The response may be cached at a public URL, so
 * whatever it carries is what a stranger may see; a member's tab title comes
 * from the client. Two invariants, each pinned by a structural test:
 * `noStore` is the first thing to touch headers, so no early exit inherits
 * Hosting's max-age=600; and `public, max-age` is set only once the page is
 * built, so a throw before then falls back to a generic shell that is still
 * uncacheable — never a broken page pinned at a public URL for the window.
 */
/**
 * GET /embed/:docId[/:versionId] — the page another site frames (SPEC §2
 * "GET /embed/…", ADR 0031). Never authenticates, and decides as `/d/**` does:
 * `decideShell`, anonymous. A document is its frame and a link, cacheable at
 * this URL for the content window; every other answer is the one neutral
 * refusal, `private, no-store`. No answer carries a frame header: framing is
 * what this page is for.
 */
async function serveEmbed(
  req: Request,
  res: import("express").Response,
  segments: string[],
): Promise<void> {
  // Always: the page repeats one a crawler is meant to cite at /d/.
  res.setHeader("X-Robots-Tag", "noindex");
  const template = await loadShell({ origin: publicOrigin(), path: EMBED_TEMPLATE_PATH, marker: EMBED_MARKER }).catch(
    (err: unknown) => {
      console.warn("docShell: no embed template to serve:", (err as { reason?: unknown })?.reason ?? (err as Error)?.name);
      return null;
    },
  );
  if (template === null) {
    res.status(503).end();
    return;
  }
  const isHead = req.method === "HEAD";
  const send = (status: number, body: string): void => {
    res.status(status);
    if (isHead) res.end();
    else res.send(body);
  };
  const refuse = (docId: string | null): void => {
    noStore(res);
    send(404, renderEmbedRefusal(template, docId));
  };

  if (segments.length < 1 || segments.length > 2 || !segments.every(safeSegment)) {
    refuse(null);
    return;
  }
  const [docId] = segments;
  const pinned = segments.length === 2 ? segments[1] : null;
  const k = strParam(req, "k");

  try {
    const docSnap = await db().collection("docs").doc(docId).get();
    const doc = docSnap.exists ? (docSnap.data() as ShellDoc) : null;
    // The folder is read only when the document's own level has said no.
    const folder = doc && readBasis(doc, null, { k }) === null ? await folderOfDoc(db(), doc) : null;
    const decision = decideShell({ doc, folder, k, versionId: pinned, now: Date.now() });
    if (decision.kind === "generic") {
      refuse(docId);
      return;
    }
    const versionSnap = await docSnap.ref.collection("versions").doc(decision.versionId).get();
    const data = versionSnap.exists ? versionSnap.data() || {} : null;
    const entry = data === null ? null : safeRelPath(String(data.entry ?? "index.html"));
    if (data === null || entry === null) {
      refuse(docId);
      return;
    }
    const page = embedPage({
      docId,
      requestedVersion: pinned,
      decision,
      entry,
      docTitle: typeof doc?.title === "string" ? doc.title : "Untitled",
      format: data.format,
      k,
    });
    const html = renderEmbed(template, page);
    // ONLY NOW: the page exists, so this URL may be cached with it.
    res.setHeader("Cache-Control", `public, max-age=${decision.maxAge}`);
    send(200, html);
  } catch (err) {
    // A code or a name only: a Firestore message can name the document path.
    console.warn("docShell: embed refused on error", (err as { code?: unknown })?.code ?? (err as Error)?.name);
    refuse(docId);
  }
}

export const docShell = onRequest(WARM, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "HEAD"])) return;

  // Uncacheable until the page is built and says otherwise. See noStore().
  noStore(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Before anything that could serve the app shell: under no spelling may
  // `/embed` answer with a page this function serves for `/d/**` (lib/embed.ts).
  const embed = embedSegments(req.path);
  if (embed !== null) {
    await serveEmbed(req, res, embed);
    return;
  }

  const template = await loadShell({ origin: publicOrigin() }).catch((err: unknown) => {
    // A 503 with nothing beside it is undiagnosable. The reason is
    // `loadShell`'s own wording — a status and a content type, or the fetch
    // error's class and code — never a URL or k: the fetch is to the
    // configured origin's `/`.
    console.warn("docShell: no shell to serve:", (err as { reason?: unknown })?.reason ?? (err as Error)?.name);
    return null;
  });
  if (template === null) {
    res.status(503).end();
    return;
  }

  const isHead = req.method === "HEAD";
  /** The shell as Hosting would serve it: the three headers above, no more. */
  const serveGeneric = (): void => {
    res.status(200);
    if (isHead) res.end();
    else res.send(template);
  };

  // A folder's page: its name for a pasted link (SPEC §17 "A folder's reach").
  const folderSegments = pathSegments(req, "folder");
  if (folderSegments) {
    await serveFolderShell(req, res, folderSegments, template, serveGeneric);
    return;
  }

  const segments = pathSegments(req, "d");
  if (!segments || segments.length < 1 || segments.length > 2) {
    serveGeneric();
    return;
  }
  const [docId] = segments;
  const pinned = segments.length === 2 ? segments[1] : null;
  const k = strParam(req, "k");

  const docSnap = await db().collection("docs").doc(docId).get();
  const doc = docSnap.exists ? (docSnap.data() as ShellDoc) : null;
  // The folder is read only when the document's own level has said no.
  const folder = doc && readBasis(doc, null, { k }) === null ? await folderOfDoc(db(), doc) : null;
  const decision = decideShell({ doc, folder, k, versionId: pinned, now: Date.now() });
  if (decision.kind === "generic") {
    serveGeneric();
    return;
  }

  // Which step the catch is reporting on. A code or name alone cannot tell
  // this repo's own throws apart — a template missing its `</head>` and a
  // scanner bug are both a plain `Error` — and the message may name the
  // object path, so the step is logged instead.
  let stage = "version";
  try {
    const versionSnap = await docSnap.ref.collection("versions").doc(decision.versionId).get();
    if (!versionSnap.exists) {
      serveGeneric();
      return;
    }
    const data = versionSnap.data() || {};
    const entry = safeRelPath(String(data.entry ?? "index.html"));
    if (entry === null) {
      serveGeneric();
      return;
    }
    const files: string[] = Array.isArray(data.files)
      ? data.files.filter((f: unknown): f is string => typeof f === "string")
      : [];

    // Only the prefix the scanner reads; `collectPrefix` enforces the cap
    // even where the range is ignored.
    stage = "stream";
    const stream = bucket()
      .file(`${versionStoragePrefix(docId, decision.versionId, data)}/${entry}`)
      .createReadStream({ start: 0, end: HEAD_SCAN_BYTES - 1 });
    const bytes = await collectPrefix(stream, HEAD_SCAN_BYTES);
    stage = "scan";
    const html = bytes.toString("utf8");
    const head = readHead(html);

    stage = "render";
    const page = composePage({
      origin: publicOrigin(),
      docId,
      requestedVersion: pinned,
      decision,
      docTitle: typeof doc?.title === "string" ? doc.title : "Untitled",
      head,
      entry,
      files,
      k,
      html,
    });
    const rendered = renderShell(template, page);

    // ONLY NOW: the page exists, so this URL may be cached with it.
    res.setHeader("Cache-Control", `public, max-age=${decision.maxAge}`);
    if (decision.noindex) res.setHeader("X-Robots-Tag", "noindex");
    res.status(200);
    if (isHead) res.end();
    else res.send(rendered);
  } catch (err) {
    // The generic shell is a 200, so without this line a runtime identity
    // that cannot read the bucket would serve the product's head for every
    // document and the request log would show nothing. The step and a code
    // or name only: a GCS message names the object path, which holds the
    // document id.
    console.warn("docShell: generic fallback at", stage, (err as { code?: unknown })?.code ?? (err as Error)?.name);
    // A throw between the public header and the send lands here with that
    // header — and, for an unlisted document, X-Robots-Tag — already set.
    // The generic shell carries neither.
    noStore(res);
    res.removeHeader("X-Robots-Tag");
    serveGeneric();
  }
});

/**
 * GET /d/:docId.md, GET /d/:docId/:versionId.md — the document as an agent
 * reads it: a Markdown reading made from the entry, opening with the front
 * matter that says it is one and where the original is (SPEC §2, §19, ADR 0030).
 *
 * For an agent that has only an address. Unlike the shell beside it, this
 * path authenticates and refuses, because its body IS the document's
 * content: the same gate, the same single 404 and the same cache policy as
 * `/content` (SPEC §1.4b, §17). A function of its own rather than a branch
 * of the warm ones: the conversion is synchronous, and a large page would
 * stall the instance every document open waits on.
 */
export const docMarkdown = onRequest({ ...PLAIN, ...READS_PAGES }, async (req, res) => {
  if (rejectMethod(req, res, ["GET", "HEAD"])) return;

  // Uncacheable until something deliberately says otherwise. See noStore().
  noStore(res);
  res.setHeader("X-Content-Type-Options", "nosniff");

  const segments = pathSegments(req, "d");
  const last = segments ? segments[segments.length - 1] : "";
  if (!segments || segments.length < 1 || segments.length > 2 || !last.endsWith(".md") || last.length <= 3) {
    res.status(404).end();
    return;
  }
  const [docId, pinnedRaw] = [...segments.slice(0, -1), last.slice(0, -3)];
  const pinned = segments.length === 2 ? pinnedRaw : null;

  const caller = await resolveCaller(req);
  const k = strParam(req, "k") || null;
  const gate = await readGate(caller, docId, k);
  if (!gate) {
    res.status(404).end();
    return;
  }

  try {
    const versionId = pinned ?? String((gate.docData as { currentVersion?: unknown }).currentVersion ?? "");
    const versionSnap = versionId ? await gate.docSnap.ref.collection("versions").doc(versionId).get() : null;
    const v = versionSnap?.exists ? versionSnap.data() ?? {} : null;
    const entry = v ? safeRelPath(String(v.entry ?? "index.html")) : null;
    if (!v || entry === null) {
      res.status(404).end();
      return;
    }
    // A Markdown document's original is its Markdown; the reading is made
    // from the HTML either way, so its addresses are absolute.
    const sourceRel = typeof v.sourceEntry === "string" && safeRelPath(v.sourceEntry) ? v.sourceEntry : entry;
    const storagePrefix = versionStoragePrefix(docId, versionId, v);

    const keyed = gate.basis === "link" || gate.basis === "folder-link" ? k : null;
    const origin = publicOrigin();
    const place = { origin, docId, versionId, entry, k: keyed };
    // Made once for this version's bytes and kept (ADR 0033).
    const reading = await storedReading({
      store: bucket(),
      place,
      version: v,
      storagePrefix,
      source: async () => {
        const [bytes] = await bucket().file(`${storagePrefix}/${entry}`).download();
        return bytes.toString("utf8");
      },
    });
    const documentUrl = readerAddress(origin, docId, pinned, keyed);
    const original = contentAddress(place, sourceRel);
    const text = composeReading(
      readingPreamble({
        title: String((gate.docData as { title?: unknown }).title ?? docId),
        document: documentUrl,
        version: versionId,
        original,
        leftOut: reading.leftOut,
        warnings: reading.warnings,
      }),
      reading,
    );

    // ONLY NOW: the reading exists, so this URL may be cached with it.
    setContentCache(res, gate);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Link",
      `<${documentUrl}>; rel="canonical", <${original}>; rel="alternate"; type="${contentTypeOf(sourceRel).split(";")[0]}"`,
    );
    if (reading.cut) res.setHeader("Bikeshed-Cut", "1");
    res.status(200);
    if (req.method === "HEAD") res.end();
    else res.send(text);
  } catch (err) {
    // A code or name only: a Storage message names the object path, which
    // holds the document id.
    console.warn("docMarkdown: failed", (err as { code?: unknown })?.code ?? (err as Error)?.name);
    noStore(res);
    res.removeHeader("X-Robots-Tag");
    res.removeHeader("Link");
    res.removeHeader("Bikeshed-Cut");
    res.status(500).end();
  }
});
