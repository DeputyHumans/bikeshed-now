// SPDX-License-Identifier: Apache-2.0
// Byte oracles over stored versions: DECOR (no app decoration), BODYATTR (root attributes) and REHASH (SPEC §10.1, §9.1).

/**
 * DECOR — a structural fingerprint of an HTML document, parsed by Chrome's own
 * DOMParser in a scratch page (no HTML-parser dependency, and the same parser
 * the product's bytes are read with), plus a raw regex scan of the bytes.
 *
 * It PINS THE `bshd` PREFIX ITSELF and does not import the app's OWN_MARKERS:
 * an oracle that reads the product's own list of what to strip passes when a
 * new marker is added to the injector and forgotten in that list. Instead it
 * counts EVERYTHING in the namespace — `data-bshd` by value, any `data-bshd-*`
 * attribute, `bshd-` ids and classes, `--bshd-` custom properties, comments
 * naming it — and judges a version against its v1 baseline: what the author
 * uploaded is theirs, what appeared since is decoration. That is also why a
 * document's own `data-bshd="whatever"` is not flagged: it is in v1 too
 * (CLAUDE.md, "stripped by VALUE"), and its LOSS is reported separately.
 * Without a baseline, only values this file itself knows to be the app's
 * (KNOWN_OWN_VALUES, a pinned literal, not an import) count as decoration.
 *
 * BODYATTR — the attributes of <html> and <body> compared with v1's. DECOR
 * looks at descendants only; root attributes are their own oracle because
 * the editor sets them directly (`contenteditable`, and `spellcheck`, suspect
 * S3), and an innerHTML comparison cannot see them at all.
 *
 * REHASH — recompute a version's contentHash (SPEC §9.1) from the files of
 * `GET /download/<doc>/<v>` with the TREE's own scripts/lib/hash.mjs, so a
 * stack is checked against the hash its own code defines.
 *
 * ONE PROBE, TWO PLACES. `parseAndRun(parser, html, fn, arg)` runs a spec's
 * own `fn(doc, arg)` against `html` as Chrome's DOMParser parses it, in the
 * parser page; frame.mjs `inFrameDoc(page, fn, arg)` runs the same function
 * against the live document frame. So one structural probe (the formatting
 * an edit left, an attribute, a count) is asked of the editor's DOM and of
 * the bytes that were stored, and the two answers compared. The function is
 * sent as SOURCE (`probeSource`), inside the evaluated expression, as
 * capturePrint's `extract` is: it may use nothing from the spec's scope but
 * `arg` (JSON).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./paths.mjs";
import { zipFiles } from "./zipread.mjs";
import { createHttp, redactString } from "./http.mjs";

export const PREFIX = "bshd";

/** The app's `data-bshd` values as of this suite's writing — a pinned literal, never an import. */
export const KNOWN_OWN_VALUES = Object.freeze(["hl-style", "edit-placeholders", "edit-fonts", "peers", "peer-style"]);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Runs inside the parser page. Must be self-contained. */
function fingerprintInPage(html) {
  const PREFIX = "bshd";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const bump = (o, k, by = 1) => {
    o[k] = (o[k] ?? 0) + by;
  };
  const attrs = (el) => (el ? Object.fromEntries(el.getAttributeNames().map((n) => [n, el.getAttribute(n)])) : null);
  const roots = new Set([doc.documentElement, doc.body, doc.head].filter(Boolean));
  const fp = {
    doctype: doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : null,
    htmlAttrs: attrs(doc.documentElement),
    bodyAttrs: attrs(doc.body),
    headAttrs: attrs(doc.head),
    dataBshd: {},
    dataBshdAttrs: {},
    bshdIds: {},
    bshdClasses: {},
    bshdStyleVars: 0,
    bshdComments: 0,
    contenteditable: {},
    spellcheck: {},
    hl: { mark: 0, tspan: 0 },
    tags: {},
    ids: { count: 0, duplicates: [] },
    topLevel: { head: doc.head ? doc.head.children.length : 0, body: doc.body ? doc.body.children.length : 0 },
  };
  const idCount = {};
  for (const el of doc.querySelectorAll("*")) {
    const tag = el.localName;
    if (["script", "style", "section", "details", "svg", "mark", "tspan", "link", "template", "iframe", "font", "meta"].includes(tag)) bump(fp.tags, tag);
    if (roots.has(el)) continue; // root attributes are BODYATTR's, never DECOR's
    for (const name of el.getAttributeNames()) {
      const value = el.getAttribute(name);
      if (name === "data-bshd") bump(fp.dataBshd, value);
      else if (name.startsWith(`data-${PREFIX}-`)) bump(fp.dataBshdAttrs, name);
      if (name === "contenteditable") bump(fp.contenteditable, tag);
      if (name === "spellcheck") bump(fp.spellcheck, tag);
      if (name === "id") {
        bump(idCount, value);
        if (value.toLowerCase().startsWith(`${PREFIX}-`)) bump(fp.bshdIds, value);
      }
      if (name === "class") for (const c of el.classList) if (c.toLowerCase().startsWith(`${PREFIX}-`)) bump(fp.bshdClasses, c);
      if (name === "style" && value.toLowerCase().includes(`--${PREFIX}-`)) fp.bshdStyleVars += 1;
    }
    if ((tag === "mark" || tag === "tspan") && el.classList.contains(`${PREFIX}-hl`)) fp.hl[tag] += 1;
  }
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.toLowerCase().includes(PREFIX)) fp.bshdComments += 1;
  for (const [id, c] of Object.entries(idCount)) {
    fp.ids.count += c;
    if (c > 1) fp.ids.duplicates.push(id);
  }
  fp.ids.duplicates.sort();
  return { fp, text: doc.body ? doc.body.textContent : "", bodyHtml: doc.body ? doc.body.innerHTML : "" };
}

/** The raw scan: counts in the bytes outside the <html>/<body>/<head> start tags. */
export function rawScan(html) {
  const s = String(html);
  const stripped = s.replace(/<(html|body|head)(\s[^>]*)?>/gi, "<$1>");
  const count = (re) => (stripped.match(re) ?? []).length;
  return {
    bytes: Buffer.byteLength(s),
    sha256: sha256(s),
    bshd: count(/bshd/gi),
    contenteditable: count(/contenteditable/gi),
    spellcheck: count(/spellcheck/gi),
    rootTags: (s.match(/<(html|body|head)(\s[^>]*)?>/gi) ?? []).join(""),
  };
}

/**
 * Fingerprint one HTML document. `page` is a scratch Playwright page (from
 * BrowserPool.parser() or openParser()); nothing is navigated or loaded.
 */
export async function fingerprint(page, html) {
  const { fp, text, bodyHtml } = await page.evaluate(fingerprintInPage, String(html));
  fp.text = { length: text.length, sha256: sha256(text) };
  fp.bodyInnerHtml = { length: bodyHtml.length, sha256: sha256(bodyHtml) };
  fp.raw = rawScan(html);
  fp._text = text; // kept for allowedTextChange; dropped by summarize()
  return fp;
}

/** A parser page of its own, for callers without a BrowserPool. */
export async function openParser() {
  const { launchChrome } = await import("./browser.mjs");
  const { browser, via } = await launchChrome();
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route(() => true, (route) => route.abort("blockedbyclient"));
  const page = await context.newPage();
  return {
    page,
    via,
    fingerprint: (html) => fingerprint(page, html),
    close: () => browser.close(),
  };
}

// --- one probe on the bytes ----------------------------------------------------

/**
 * A function's source as an expression a page can call, for sending a spec's
 * own probe into a page (method shorthand, `probe(doc) {…}`, included). It
 * throws when the function has no source a page could compile (a bound or
 * native function), naming `what`. The source is checked for syntax here and
 * never run in this process.
 */
export function probeSource(fn, what = "the probe") {
  if (typeof fn !== "function") throw new Error(`${what} is a function of (doc, arg), got ${fn === null ? "null" : typeof fn}`);
  const src = Function.prototype.toString.call(fn).trim();
  const forms = [src, src.startsWith("async ") ? `async function ${src.slice(6)}` : `function ${src}`];
  for (const s of forms) {
    try {
      new Function(`return (${s});`); // eslint-disable-line no-new-func -- a syntax check only, nothing runs
      return `(${s})`;
    } catch {
      /* the next form */
    }
  }
  throw new Error(`${what} is a function written in the spec (its source is sent to the page), got one with no source: ${src.slice(0, 80)}`);
}

/** `arg` as the JSON literal a probe receives; anything JSON cannot carry throws, naming `what`. */
export function probeArg(arg, what = "the probe") {
  let json;
  try {
    json = JSON.stringify(arg ?? null);
  } catch (e) {
    throw new Error(`${what}: arg must be JSON: ${e.message}`);
  }
  if (json === undefined) throw new Error(`${what}: arg must be JSON, got ${typeof arg}`);
  return json;
}

/**
 * Runs in the parser page, sent as source with the probe. Parses `html` as
 * fingerprintInPage does and calls the probe on it; a throw or a DOM node
 * returned is an error, never a value.
 */
async function parsedDocRunner(html, fn, arg) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  try {
    const value = await fn(doc, arg);
    if (value && typeof value === "object" && typeof value.nodeType === "number" && typeof value.nodeName === "string") {
      return { error: "the probe returned a DOM node: return plain data" };
    }
    return { value };
  } catch (e) {
    return { error: `the probe threw: ${String(e?.message ?? e)}` };
  }
}

/** A Page from a Page, an openParser() result ({page}) or a BrowserPool (its parser()). */
async function parserPage(parser) {
  if (parser && typeof parser.evaluate === "function") return parser;
  if (parser && parser.page && typeof parser.page.evaluate === "function") return parser.page;
  if (parser && typeof parser.parser === "function") return parser.parser();
  throw new Error("parseAndRun: parser is a Playwright Page (BrowserPool.parser()), an openParser() result or a BrowserPool");
}

/**
 * Parse `html` (a string, or a Buffer read as UTF-8) with Chrome's DOMParser
 * in the parser page, exactly as `fingerprint` does, and resolve `fn(doc,
 * arg)` run there: the probe's return value, which must be plain data (JSON,
 * as Playwright returns it). `fn` may be async. `parser` is the parser page
 * (`BrowserPool.parser()`), an `openParser()` result, or the BrowserPool
 * itself (`ctx.users`).
 *
 * The document is parsed, never rendered: no script ran in it, it has no
 * window (`doc.defaultView` is null), no layout and no computed style. A
 * probe meant for both the parsed bytes and the live frame (frame.mjs
 * `inFrameDoc`) reads structure only: elements, attributes, text.
 *
 * Throws "parseAndRun: the probe threw: …" when it throws, and refuses a DOM
 * node as the result.
 */
export async function parseAndRun(parser, html, fn, arg = null) {
  if (typeof html !== "string" && !Buffer.isBuffer(html)) throw new Error(`parseAndRun: html is a string or a Buffer, got ${html === null ? "null" : typeof html}`);
  const src = probeSource(fn, "parseAndRun: fn");
  const argJson = probeArg(arg, "parseAndRun");
  const page = await parserPage(parser);
  const text = Buffer.isBuffer(html) ? html.toString("utf8") : html;
  const r = await page.evaluate(`(${parsedDocRunner.toString()})(${JSON.stringify(text)}, ${src}, ${argJson})`);
  if (!r || r.error) throw new Error(`parseAndRun: ${r?.error ?? "the page returned nothing"}`);
  return r.value;
}

/** A fingerprint without the private text, for evidence files. */
export function summarize(fp) {
  const { _text, ...rest } = fp;
  return rest;
}

const excess = (now = {}, base = {}) =>
  Object.entries(now)
    .filter(([k, v]) => v > (base[k] ?? 0))
    .map(([k, v]) => ({ key: k, count: v, baseline: base[k] ?? 0 }));

/**
 * Decoration in `fp`: everything in the `bshd` namespace (or editor state)
 * beyond `baseline`. Without a baseline, unknown `data-bshd` values are the
 * document's own and are listed under `foreign`, never as decoration.
 */
export function decorations(fp, baseline = null) {
  const out = [];
  const add = (kind, rows) => rows.forEach((r) => out.push({ kind, ...r }));
  if (baseline) add("data-bshd", excess(fp.dataBshd, baseline.dataBshd));
  else add("data-bshd", excess(Object.fromEntries(Object.entries(fp.dataBshd).filter(([v]) => KNOWN_OWN_VALUES.includes(v))), {}));
  add("data-bshd-*", excess(fp.dataBshdAttrs, baseline?.dataBshdAttrs));
  add("bshd-id", excess(fp.bshdIds, baseline?.bshdIds));
  add("bshd-class", excess(fp.bshdClasses, baseline?.bshdClasses));
  add("bshd-style-var", excess({ style: fp.bshdStyleVars }, { style: baseline?.bshdStyleVars ?? 0 }));
  add("bshd-comment", excess({ comment: fp.bshdComments }, { comment: baseline?.bshdComments ?? 0 }));
  add("highlight", excess(fp.hl, baseline?.hl));
  add("contenteditable", excess(fp.contenteditable, baseline?.contenteditable));
  add("spellcheck", excess(fp.spellcheck, baseline?.spellcheck));
  // The raw scan catches what the parser hides (a malformed tag, a namespace
  // spelled in text). Without a baseline the document's own foreign markers
  // each explain their occurrences of the prefix.
  const foreign = Object.entries(fp.dataBshd).filter(([v]) => !KNOWN_OWN_VALUES.includes(v));
  const explained = baseline
    ? baseline.raw.bshd
    : foreign.reduce((n, [v, c]) => n + c * (1 + (v.match(/bshd/gi) ?? []).length), 0);
  if (fp.raw.bshd > explained && out.length === 0) out.push({ kind: "raw-bshd", key: "bshd", count: fp.raw.bshd, baseline: explained });
  if (fp.raw.contenteditable > (baseline?.raw.contenteditable ?? 0) && !out.some((o) => o.kind === "contenteditable")) {
    out.push({ kind: "raw-contenteditable", key: "contenteditable", count: fp.raw.contenteditable, baseline: baseline?.raw.contenteditable ?? 0 });
  }
  return out;
}

/** Foreign (document-owned) `data-bshd` values, by count. */
export function foreignMarkers(fp) {
  return Object.fromEntries(Object.entries(fp.dataBshd).filter(([v]) => !KNOWN_OWN_VALUES.includes(v)));
}

/** BODYATTR: compare two attribute maps → {equal, added, removed, changed}. */
export function compareAttrs(a = {}, b = {}) {
  const added = {};
  const removed = {};
  const changed = {};
  for (const [k, v] of Object.entries(b ?? {})) {
    if (!(k in (a ?? {}))) added[k] = v;
    else if (a[k] !== v) changed[k] = { from: a[k], to: v };
  }
  for (const [k, v] of Object.entries(a ?? {})) if (!(k in (b ?? {}))) removed[k] = v;
  const equal = !Object.keys(added).length && !Object.keys(removed).length && !Object.keys(changed).length;
  return { equal, added, removed, changed };
}

/** BODYATTR between two fingerprints: <body> and <html>. */
export function bodyAttrDiff(v1, vN) {
  const body = compareAttrs(v1.bodyAttrs, vN.bodyAttrs);
  const html = compareAttrs(v1.htmlAttrs, vN.htmlAttrs);
  return { equal: body.equal && html.equal, body, html };
}

/**
 * Compare a later version's fingerprint with v1's.
 *
 * allowedTextChange:
 *   false (default)       body text must be identical
 *   true                  any text change
 *   {contains: [tokens]}  vN text must contain every token, and v1's text
 *                         must be what is left after removing one copy of each
 *   (v1Text, vNText)=>bool
 *
 * Returns {ok, decoration, lost, structure, bodyAttr, text}. `ok` needs no
 * decoration, nothing of the document's own lost, an unchanged structure,
 * an allowed text change and (unless ignoreBodyAttr) equal root attributes.
 */
export function diffFingerprint(v1, vN, allowedTextChange = false, { ignoreBodyAttr = false } = {}) {
  const decoration = decorations(vN, v1);
  const lost = [];
  for (const [v, c] of Object.entries(foreignMarkers(v1))) {
    if ((vN.dataBshd[v] ?? 0) < c) lost.push({ kind: "foreign-data-bshd", key: v, count: vN.dataBshd[v] ?? 0, baseline: c });
  }
  const structure = [];
  const tagNames = new Set([...Object.keys(v1.tags), ...Object.keys(vN.tags)]);
  for (const t of tagNames) {
    if (["mark", "tspan"].includes(t)) continue; // highlights are DECOR's
    if ((v1.tags[t] ?? 0) !== (vN.tags[t] ?? 0)) structure.push({ kind: "tag-count", key: t, count: vN.tags[t] ?? 0, baseline: v1.tags[t] ?? 0 });
  }
  if (v1.topLevel.body !== vN.topLevel.body) structure.push({ kind: "body-children", count: vN.topLevel.body, baseline: v1.topLevel.body });
  if (v1.topLevel.head !== vN.topLevel.head) structure.push({ kind: "head-children", count: vN.topLevel.head, baseline: v1.topLevel.head });
  const newDup = vN.ids.duplicates.filter((d) => !v1.ids.duplicates.includes(d));
  if (newDup.length) structure.push({ kind: "duplicate-ids", key: newDup.join(","), count: newDup.length, baseline: 0 });
  if (v1.doctype !== vN.doctype) structure.push({ kind: "doctype", key: String(vN.doctype), baseline: String(v1.doctype) });

  const changed = v1.text.sha256 !== vN.text.sha256;
  let allowed = !changed;
  if (changed) {
    if (allowedTextChange === true) allowed = true;
    else if (typeof allowedTextChange === "function") allowed = Boolean(allowedTextChange(v1._text, vN._text));
    else if (allowedTextChange && Array.isArray(allowedTextChange.contains)) {
      let rest = vN._text ?? "";
      allowed = allowedTextChange.contains.every((tok) => {
        const at = rest.indexOf(tok);
        if (at < 0) return false;
        rest = rest.slice(0, at) + rest.slice(at + tok.length);
        return true;
      }) && rest === v1._text;
    }
  }
  const bodyAttr = bodyAttrDiff(v1, vN);
  const ok = decoration.length === 0 && lost.length === 0 && structure.length === 0 && allowed && (ignoreBodyAttr || bodyAttr.equal);
  return { ok, decoration, lost, structure, bodyAttr, text: { changed, allowed } };
}

// --- REHASH ------------------------------------------------------------------

const hashModules = new Map();

/** The hash module a target defines: the stack tree's own, or this checkout's for prod. */
export async function hashModule(target = null) {
  const root = target?.kind === "local" && target.stack?.treeDir ? target.stack.treeDir : REPO_ROOT;
  const file = join(root, "scripts", "lib", "hash.mjs");
  if (!hashModules.has(file)) hashModules.set(file, import(pathToFileURL(file).href));
  return hashModules.get(file);
}

/** Recompute {contentHash, fileCount, bytes} over a zip's files. */
export async function rehashZip(zip, { target = null } = {}) {
  const files = zipFiles(zip);
  const { hashBundleFiles } = await hashModule(target);
  return { ...hashBundleFiles(files), files: files.map((f) => ({ rel: f.rel, bytes: f.data.length })), entries: files };
}

/**
 * GET /download/<doc>/<v> and return the zip and its files. Through http.mjs,
 * like every request a spec makes: held to the target's ports, guarded,
 * traced with the link key redacted.
 *
 * @param {object} o
 * @param {object} [o.http]     a client from createHttp()/a session (its jar and headers apply)
 * @param {object} [o.target]   else a fresh client for this target
 * @param {string} [o.origin]   legacy: must equal the target's origin (E2E_TARGET's when no target is given)
 * @param {object} [o.headers]  extra headers (a bearer)
 * @param {string} [o.k]        the link key, if any
 * @param {Function} [o.sink]   gets {t, ms, method, url (redacted), status, bytes}
 */
export async function downloadVersion({ http = null, target = null, origin = null, docId, versionId, headers = {}, k = null, sink = null }) {
  let client = http;
  if (!client) {
    const t = target ?? (await import("./target.mjs")).loadTarget();
    client = createHttp(t, { actor: "download" });
  }
  if (origin && origin.replace(/\/+$/, "") !== client.target.origin) throw new Error(`downloadVersion: origin ${origin} is not the target's (${client.target.origin})`);
  const path = `/download/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}`;
  const t0 = Date.now();
  const res = await client.get(path, { headers, ...(k ? { query: { k } } : {}) });
  sink?.({ t: t0, ms: res.ms, method: "GET", url: redactString(res.url), status: res.status, bytes: res.buffer.length });
  if (res.status !== 200) {
    const err = new Error(`GET ${redactString(res.url)} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { zip: res.buffer, files: zipFiles(res.buffer), headers: Object.fromEntries(res.headers) };
}

/** REHASH: download a version and recompute its hash with the target's own module. */
export async function rehashVersion({ target, http = null, docId, versionId, headers = {}, k = null, sink = null }) {
  const { zip } = await downloadVersion({ target, http, docId, versionId, headers, k, sink });
  return rehashZip(zip, { target: target ?? http?.target ?? null });
}

/** The entry file's bytes (index.html unless told otherwise) from a downloaded version. */
export function entryHtml(files, entry = "index.html") {
  const f = files.find((x) => x.rel === entry);
  if (!f) throw new Error(`no ${entry} in the bundle (files: ${files.map((x) => x.rel).join(", ")})`);
  return f.data.toString("utf8");
}
