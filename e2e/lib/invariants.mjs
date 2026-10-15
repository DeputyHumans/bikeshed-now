// SPDX-License-Identifier: Apache-2.0
// The concurrency invariants I1–I16 as the plan defines them: one pure judge each, the readers that feed them, and one way to fail (SPEC §6a, §6b, §16, §22).

/**
 * Every judge takes plain data and returns a RESULT:
 *
 *   {invariant: "I6", ok, failures: ["…"], …details}
 *
 * and `assertInvariant(result)` throws an AssertionError whose message is
 * `I6: <failure>; <failure>` — an assertion, so in a `defect:` case it is the
 * defect's own oracle (TODO), and anywhere else a FAIL. A judge never throws
 * on a broken invariant; it throws TypeError on input it cannot judge (a
 * caller's bug, never a verdict). The readers (`read…`) gather what a judge
 * takes from frames, the database or the stack.
 *
 *   I1  sha256(frame body.innerHTML) equal on every peer           checkI1, checkI1Stable, readI1
 *   I2  every token exactly once, contiguous, inside its target,
 *       on every peer and in the draft (lib/tokens.mjs)             checkI2, readSegments, segmentsOfHtml
 *   I3  the v1 sentinel appears once, and the top-level child
 *       count is unchanged                                          checkI3, readI3
 *   I4  a deleted passage and the tokens typed into it are gone
 *       everywhere (lib/tokens.mjs)                                 checkI4
 *   I5  GET /draft body equals every peer's, with DECOR 0 and
 *       BODYATTR equal to v1                                        checkI5
 *   I6  exactly one version per base                                checkI6, readVersions
 *   I7  REHASH holds and the stored bytes are the winner's          checkI7
 *   I8  every accepted replacement is in the draft exactly once
 *       and, judged in place, stands in place of its quote          checkI8, elementText
 *   I9  one insertion and one note per suggestion; the losers
 *       get 409 `claimedBy`                                         checkI9
 *   I10 notes equal real flips, and the final state matches
 *       their parity                                                checkI10
 *   I11 at most one email per (to, doc, kind) per 30 min, and
 *       exactly one where eligible                                  checkI11
 *   I12 status/{d}/peers empty within 5 s of everyone leaving       checkI12, waitI12
 *   I13 a peer shown as "Shared" receives a probe keystroke
 *       within 2 s                                                  checkI13
 *   I14 the RTDB mirror equals members/editorMembers, and a
 *       revoked user's `y` write fails                              checkI14
 *   I15 get_changes reports each event once, and the counts match   checkI15
 *   I16 members equals computeMembership(...) (scripts/lib/
 *       membership.mjs); grantees get 200 and removed users 404     checkI16, expectedMembership
 *
 * Each judge has a self-test seen red against a mutant of itself
 * (selftest/invariants.test.mjs).
 */

import { AssertionError } from "node:assert";
import { KNOWN_OWN_VALUES } from "./bytes.mjs";
import { bodyHash } from "./frame.mjs";
import { analyseTokens, collectSegments } from "./tokens.mjs";

/** The plan's sentences, by invariant. */
export const INVARIANTS = Object.freeze({
  I1: "sha256(frame body.innerHTML) equal on every peer",
  I2: "every token exactly once, contiguous, inside its target, on every peer and in the draft",
  I3: "the v1 sentinel appears once, and the top-level child count is unchanged",
  I4: "a deleted passage and the tokens typed into it are gone everywhere",
  I5: "GET /draft body equals every peer's, with DECOR 0 and BODYATTR equal to v1",
  I6: "exactly one version per base",
  I7: "REHASH holds and the stored bytes are the winner's",
  I8: "every accepted replacement is in the draft exactly once",
  I9: "one insertion and one note per suggestion; the losers get 409 claimedBy",
  I10: "notes equal real flips, and the final state matches their parity",
  I11: "at most one email per (to, doc, kind) per 30 min, and exactly one where eligible",
  I12: "status/{d}/peers empty within 5 s of everyone leaving",
  I13: "a peer shown as \"Shared\" receives a probe keystroke within 2 s",
  I14: "the RTDB mirror equals members/editorMembers, and a revoked user's y write fails",
  I15: "get_changes reports each event once, and the counts match",
  I16: "members equals computeMembership(...); grantees get 200 and removed users 404",
});

/** I11's window: 30 minutes. */
export const EMAIL_WINDOW_MS = 30 * 60_000;
/** I12's bound: 5 s after everyone left. */
export const PEERS_EMPTY_MS = 5_000;
/** I13's bound: 2 s from the probe keystroke to every Shared peer. */
export const PROBE_ARRIVAL_MS = 2_000;
/** The fixture's sentinel (e2e/fixtures/crdt-paragraphs.html): the first top-level element. */
export const SENTINEL_ID = "e2e-sentinel";
/** The app's own nodes in a frame (bytes.mjs KNOWN_OWN_VALUES, by value): not the document's children. */
export const OWN_MARKER_VALUES = KNOWN_OWN_VALUES;

const short = (h) => String(h ?? "null").slice(0, 12);

function result(invariant, failures, details = {}) {
  return { invariant, ok: failures.length === 0, failures, ...details };
}

/** Throw an AssertionError `<I>: <failures>` when the result is not ok; return it otherwise. */
export function assertInvariant(r) {
  if (!r || typeof r.invariant !== "string" || !Array.isArray(r.failures)) throw new TypeError("assertInvariant: give a judge's result");
  if (r.ok) return r;
  const message = `${r.invariant}: ${r.failures.join("; ")}`;
  throw new AssertionError({ message: message.length > 4000 ? `${message.slice(0, 4000)}…` : message, actual: r.failures, expected: [], operator: r.invariant });
}

function needArray(v, what, who) {
  if (!Array.isArray(v)) throw new TypeError(`${who}: ${what} is a list, got ${JSON.stringify(v)?.slice(0, 80)}`);
  return v;
}

// --- I1 ----------------------------------------------------------------------

/** I1 on one sample: [{name, hash, length}], at least two peers, every hash equal. */
export function checkI1(samples) {
  needArray(samples, "samples", "checkI1");
  const failures = [];
  if (samples.length < 2) failures.push(`${samples.length} peer(s) sampled: convergence needs at least two`);
  const hashes = new Set(samples.map((s) => s.hash));
  if (samples.some((s) => typeof s.hash !== "string" || !s.hash)) failures.push(`a peer gave no hash (${samples.filter((s) => !s.hash).map((s) => s.name).join(", ")})`);
  else if (hashes.size > 1) {
    const groups = new Map();
    for (const s of samples) groups.set(s.hash, [...(groups.get(s.hash) ?? []), `${s.name} (${s.length ?? "?"})`]);
    failures.push(`peers differ: ${[...groups].map(([h, names]) => `${short(h)} on ${names.join(", ")}`).join(" | ")}`);
  }
  return result("I1", failures, { hash: hashes.size === 1 ? samples[0]?.hash ?? null : null, peers: samples.length });
}

/** I1 over consecutive samples: each converged, and on the same hash every time (the plan's "I1 on 3 samples"). */
export function checkI1Stable(series, { samples = 3 } = {}) {
  needArray(series, "series", "checkI1Stable");
  const tail = series.slice(-samples);
  const failures = [];
  if (tail.length < samples) failures.push(`${tail.length} of ${samples} sample(s) taken`);
  const each = tail.map((s) => checkI1(s));
  each.forEach((r, i) => {
    if (!r.ok) failures.push(`sample ${series.length - tail.length + i + 1}: ${r.failures.join("; ")}`);
  });
  const hashes = new Set(each.filter((r) => r.ok).map((r) => r.hash));
  if (failures.length === 0 && hashes.size !== 1) failures.push(`converged on ${hashes.size} different hashes across ${samples} samples: still changing`);
  return result("I1", failures, { hash: failures.length === 0 ? [...hashes][0] : null, samples: tail.length });
}

/** One I1 sample from these users' frames: [{name, hash, length}] (frame.mjs bodyHash). */
export async function readI1(users) {
  return Promise.all(users.map(async (u) => ({ name: u.name, ...(await bodyHash(await u.frame())) })));
}

// --- I2 / I4 ------------------------------------------------------------------

/** Segments of a user's frame body (tokens.mjs collectSegments, whole body: splits are detectable). */
export async function readSegments(user, ids = []) {
  const f = await user.frame();
  return f.evaluate(collectSegments, { ids });
}

/** Segments of an HTML document (a draft, a version) parsed by Chrome on `page` (a parser page: BrowserPool.parser()). */
export async function segmentsOfHtml(page, html, ids = []) {
  return page.evaluate(collectSegments, { ids, html });
}

/**
 * I2: tokens.mjs analyseTokens over every peer's segments (and the draft's,
 * when given): each typed token once, whole, inside its target; no stray,
 * no foreign token. `peers` {name: segments}; `typed` tokenLog().typed.
 */
export function checkI2({ peers, draft = null, typed, options = {} } = {}) {
  if (!peers || typeof peers !== "object") throw new TypeError("checkI2: peers is {name: segments}");
  needArray(typed, "typed", "checkI2");
  const failures = [];
  const analyses = {};
  const where = Object.entries(peers);
  if (draft) where.push(["draft", draft]);
  if (where.length === 0) failures.push("no peer and no draft to look in");
  for (const [name, segments] of where) {
    const a = analyseTokens({ segments: needArray(segments, `${name}'s segments`, "checkI2"), typed: typed.filter((t) => (t.expect ?? "present") === "present") }, options);
    analyses[name] = { ok: a.ok, counts: a.counts };
    for (const f of a.failures) failures.push(`${name}: ${f}`);
  }
  return result("I2", failures, { analyses, tokens: typed.length });
}

/**
 * I4: every token typed into a deleted passage is gone, every other typed
 * token is still ok, and the deleted passage's own text is gone, on every
 * peer and in the draft. `typed` carries expect "absent" for the deleted
 * targets (tokenLog().expectAbsent); `deletedTexts` the passage text(s).
 */
export function checkI4({ peers, draft = null, typed, deletedTexts = [], options = {} } = {}) {
  if (!peers || typeof peers !== "object") throw new TypeError("checkI4: peers is {name: segments}");
  needArray(typed, "typed", "checkI4");
  if (!typed.some((t) => t.expect === "absent") && deletedTexts.length === 0) throw new TypeError("checkI4: nothing was deleted (no token expects absent, no deleted text)");
  const failures = [];
  const where = Object.entries(peers);
  if (draft) where.push(["draft", draft]);
  for (const [name, segments] of where) {
    const a = analyseTokens({ segments: needArray(segments, `${name}'s segments`, "checkI4"), typed }, options);
    for (const f of a.failures) failures.push(`${name}: ${f}`);
    const text = segments.map((s) => s.text).join("");
    for (const d of deletedTexts) if (d && text.includes(d)) failures.push(`${name}: the deleted passage ${JSON.stringify(d.length > 60 ? `${d.slice(0, 60)}…` : d)} is still there`);
  }
  return result("I4", failures);
}

// --- I3 ------------------------------------------------------------------------

/**
 * I3: in every peer, the sentinel appears exactly once and the body's
 * top-level element count is the baseline's (v1's). `peers` {name:
 * {sentinels, children}} as readI3 gives them; `baseline` {children}.
 */
export function checkI3({ peers, baseline } = {}) {
  if (!peers || typeof peers !== "object") throw new TypeError("checkI3: peers is {name: {sentinels, children}}");
  if (!Number.isInteger(baseline?.children)) throw new TypeError("checkI3: baseline.children is v1's top-level element count");
  const failures = [];
  const entries = Object.entries(peers);
  if (entries.length === 0) failures.push("no peer to look in");
  for (const [name, p] of entries) {
    if (p.sentinels !== 1) failures.push(`${name}: the sentinel appears ${p.sentinels} time(s), not once`);
    if (p.children !== baseline.children) failures.push(`${name}: ${p.children} top-level element(s), v1 has ${baseline.children}`);
  }
  return result("I3", failures);
}

/** What I3 reads in one frame (or any page whose document is the document): {sentinels, children}. */
export async function readI3(frameOrPage, { sentinelId = SENTINEL_ID } = {}) {
  return frameOrPage.evaluate(
    ({ id, own }) => {
      const body = document.body;
      if (!body) return { sentinels: 0, children: 0 };
      const mine = new Set(own);
      const children = [...body.children].filter((el) => !mine.has(el.getAttribute("data-bshd") ?? "")).length;
      return { sentinels: document.querySelectorAll(`[id="${id}"]`).length, children };
    },
    { id: sentinelId, own: [...OWN_MARKER_VALUES] },
  );
}

/** readI3 over each user's frame: {name: {sentinels, children}}. */
export async function readI3All(users, opts = {}) {
  const out = {};
  for (const u of users) out[u.name] = await readI3(await u.frame(), opts);
  return out;
}

// --- I5 ------------------------------------------------------------------------

/**
 * I5: the draft's body equals every peer's (by hash, both read the same way),
 * DECOR finds nothing in the draft, and BODYATTR says the draft's <html> and
 * <body> attributes equal v1's. `draftHash`, `peerHashes` {name: hash},
 * `decoration` (bytes.mjs diffFingerprint(…).decoration), `bodyAttr`
 * (bytes.mjs bodyAttrDiff).
 */
export function checkI5({ draftHash, peerHashes, decoration = [], bodyAttr = null } = {}) {
  if (typeof draftHash !== "string" || !draftHash) throw new TypeError("checkI5: draftHash is the draft body's hash");
  if (!peerHashes || typeof peerHashes !== "object" || Object.keys(peerHashes).length === 0) throw new TypeError("checkI5: peerHashes is {name: hash}, one at least");
  needArray(decoration, "decoration", "checkI5");
  if (!bodyAttr || typeof bodyAttr.equal !== "boolean") throw new TypeError("checkI5: bodyAttr is bytes.mjs bodyAttrDiff(v1, draft)");
  const failures = [];
  for (const [name, h] of Object.entries(peerHashes)) if (h !== draftHash) failures.push(`${name}'s body ${short(h)} is not the draft's ${short(draftHash)}`);
  if (decoration.length) failures.push(`DECOR: ${decoration.length} decoration(s) in the draft: ${JSON.stringify(decoration.slice(0, 5))}`);
  if (!bodyAttr.equal) failures.push(`BODYATTR: the draft's <html>/<body> attributes differ from v1's: ${JSON.stringify({ body: bodyAttr.body, html: bodyAttr.html })}`);
  return result("I5", failures);
}

// --- I6 / I7 -------------------------------------------------------------------

/**
 * I6: no base has more than one version made on it; with `base`, exactly
 * one has. `versions` [{id, parentVersion}] (readVersions); v1 has no parent.
 */
export function checkI6(versions, { base = null } = {}) {
  needArray(versions, "versions", "checkI6");
  const children = new Map();
  for (const v of versions) {
    if (v.parentVersion == null) continue;
    children.set(v.parentVersion, [...(children.get(v.parentVersion) ?? []), v.id]);
  }
  const failures = [];
  for (const [parent, ids] of children) if (ids.length > 1) failures.push(`base ${parent} has ${ids.length} versions (${ids.sort().join(", ")})`);
  if (base != null && !(children.get(base)?.length >= 1)) failures.push(`base ${base} has no version`);
  return result("I6", failures, { children: Object.fromEntries(children) });
}

/** Every version record of a document, including its immutable storage prefix, by id. */
export async function readVersions(target, docId) {
  const { readCollection } = await import("./admin.mjs");
  const rows = await readCollection(target, `docs/${docId}/versions`);
  return rows
    .map((r) => ({ id: r.id, parentVersion: r.data.parentVersion ?? null, contentHash: r.data.contentHash ?? null, publishedVia: r.data.publishedVia ?? null, storagePrefix: r.data.storagePrefix ?? null }))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || a.id.localeCompare(b.id));
}

/**
 * I7: the SPEC §9.1 hash of the stored bytes equals the record's
 * contentHash, and the stored bytes are the winner's. `rehash` (bytes.mjs
 * rehashZip/rehashVersion's contentHash), `recordHash`, `storedSha` and
 * `winnerSha` (sha256 of the stored entry and of the winner's sent bytes).
 */
export function checkI7({ rehash, recordHash, storedSha, winnerSha } = {}) {
  for (const [k, v] of Object.entries({ rehash, recordHash, storedSha, winnerSha })) if (typeof v !== "string" || !v) throw new TypeError(`checkI7: ${k} is a hash`);
  const failures = [];
  if (rehash !== recordHash) failures.push(`REHASH ${short(rehash)} is not the record's contentHash ${short(recordHash)}`);
  if (storedSha !== winnerSha) failures.push(`the stored bytes ${short(storedSha)} are not the winner's ${short(winnerSha)}`);
  return result("I7", failures);
}

// --- I8 – I11 ------------------------------------------------------------------

const occurrences = (hay, needle) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n += 1;
  return n;
};

/** Elements the HTML parser gives no end tag and no content. */
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is text up to their own end tag, as written (raw text; scripting on, as in a page). */
const RAW_TEXT_ELEMENTS = new Set(["iframe", "noembed", "noframes", "noscript", "script", "style", "xmp"]);
/** Elements whose content is text up to their own end tag, character references decoded (RCDATA). */
const RCDATA_ELEMENTS = new Set(["textarea", "title"]);
/** Start tags after which the parser drops one newline. */
const DROPS_NEWLINE = new Set(["listing", "pre", "textarea"]);
/** The parser's "special" elements that stay open (void and raw-text ones aside): an implied end stops at them. */
const SPECIAL_ELEMENTS = new Set([
  "address", "applet", "article", "aside", "blockquote", "body", "button", "caption", "center", "colgroup", "dd", "details", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "html", "li", "listing",
  "main", "marquee", "menu", "nav", "object", "ol", "p", "pre", "search", "section", "select", "summary", "table", "tbody", "td", "template", "tfoot", "th",
  "thead", "tr", "ul",
]);
/** Start tags before which the parser closes an open <p> that is in button scope. */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "listing", "main", "menu", "nav", "ol", "p", "plaintext", "pre", "search",
  "section", "summary", "table", "ul", "xmp",
]);
/** Open inside a <p>, any of these keeps it out of button scope, so no start tag closes it. */
const BUTTON_SCOPE = new Set(["applet", "button", "caption", "html", "marquee", "object", "table", "td", "template", "th"]);
/** End tags that close everything open inside the element they end: met inside the element judged, they end it too. */
const ENDS_ENCLOSING = new Set([
  "address", "applet", "article", "aside", "blockquote", "body", "button", "caption", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "html", "li", "listing", "main", "marquee",
  "menu", "nav", "object", "ol", "pre", "search", "section", "select", "summary", "table", "tbody", "td", "template", "tfoot", "th", "thead", "tr", "ul",
]);
/** The named character references elementText decodes; any other stays as written. */
const NAMED_REFERENCES = Object.freeze({
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'", nbsp: "\u00a0", ensp: "\u2002", emsp: "\u2003",
  thinsp: "\u2009", zwnj: "\u200c", zwj: "\u200d", lrm: "\u200e", rlm: "\u200f", shy: "\u00ad", ndash: "\u2013", mdash: "\u2014", lsquo: "\u2018",
  rsquo: "\u2019", sbquo: "\u201a", ldquo: "\u201c", rdquo: "\u201d", bdquo: "\u201e", laquo: "\u00ab", raquo: "\u00bb", hellip: "\u2026",
  middot: "\u00b7", bull: "\u2022", copy: "\u00a9", COPY: "\u00a9", reg: "\u00ae", REG: "\u00ae", trade: "\u2122", deg: "\u00b0", times: "\u00d7",
  divide: "\u00f7", plusmn: "\u00b1", sect: "\u00a7", para: "\u00b6", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2",
});
/** Those of them the parser also takes without their `;` (legacy), longest first. */
const LEGACY_REFERENCES = Object.freeze(
  ["AMP", "amp", "LT", "lt", "GT", "gt", "QUOT", "quot", "nbsp", "COPY", "copy", "REG", "reg", "laquo", "raquo", "middot", "deg", "times", "divide", "plusmn", "sect", "para", "pound", "yen", "cent", "shy"].sort((a, b) => b.length - a.length),
);
/** A numeric reference to 0x80–0x9F means the windows-1252 character there. */
const C1_REFERENCES = Object.freeze({
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
});
const SPACE = /[\t\n\f\r ]/;
const ALPHA = /[A-Za-z]/;

/**
 * Character references decoded as the parser does: numeric ones as code
 * points (0, surrogates and beyond U+10FFFF as U+FFFD, 0x80–0x9F as
 * windows-1252), named ones from NAMED_REFERENCES, and the legacy ones
 * without their `;` too (in an attribute value, not when a letter, digit or
 * `=` follows). Any other named reference stays as written.
 */
function decodeReferences(s, { attribute = false } = {}) {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, (m, hex, dec, name, semi, at) => {
    if (name === undefined) {
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(C1_REFERENCES[cp] ?? cp);
    }
    if (semi && Object.hasOwn(NAMED_REFERENCES, name)) return NAMED_REFERENCES[name];
    const legacy = LEGACY_REFERENCES.find((l) => name.startsWith(l));
    if (!legacy) return m;
    const after = name.length > legacy.length ? name[legacy.length] : semi || (s[at + m.length] ?? "");
    if (attribute && /[A-Za-z0-9=]/.test(after)) return m;
    return NAMED_REFERENCES[legacy] + m.slice(1 + legacy.length);
  });
}

/** One tag from its `<` at `i`: {name, attrs, selfClosing, end} (end: past its `>`), or null when the input ends inside it (the parser drops such a tag). */
function scanTag(src, i, closing) {
  let k = i + (closing ? 2 : 1);
  const from = k;
  while (k < src.length && !SPACE.test(src[k]) && src[k] !== "/" && src[k] !== ">") k += 1;
  const name = src.slice(from, k).toLowerCase();
  const attrs = new Map();
  let selfClosing = false;
  while (k < src.length) {
    const c = src[k];
    if (c === ">") return { name, attrs, selfClosing, end: k + 1 };
    if (SPACE.test(c)) {
      k += 1;
      continue;
    }
    if (c === "/") {
      selfClosing = src[k + 1] === ">";
      k += 1;
      continue;
    }
    selfClosing = false;
    const at = k;
    k += 1;
    while (k < src.length && !SPACE.test(src[k]) && !"/>=".includes(src[k])) k += 1;
    const attr = src.slice(at, k).toLowerCase();
    let value = "";
    let j = k;
    while (j < src.length && SPACE.test(src[j])) j += 1;
    if (src[j] === "=") {
      j += 1;
      while (j < src.length && SPACE.test(src[j])) j += 1;
      if (src[j] === '"' || src[j] === "'") {
        const close = src.indexOf(src[j], j + 1);
        if (close === -1) return null;
        value = src.slice(j + 1, close);
        k = close + 1;
      } else {
        const v = j;
        while (j < src.length && !SPACE.test(src[j]) && src[j] !== ">") j += 1;
        value = src.slice(v, j);
        k = j;
      }
    }
    if (!attrs.has(attr)) attrs.set(attr, decodeReferences(value, { attribute: true }));
  }
  return null;
}

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Whether a start tag `name` met inside the open element ends it: the
 * parser's implied ends for p (a block, unless out of button scope; a table
 * only outside quirks mode), li, dt and dd (a next item, unless a list or
 * other special element is open inside), and a heading met by a heading
 * while nothing is open inside it.
 */
function endsImplicitly(open, name, { quirks = false } = {}) {
  const stops = () => open.inner.some((n) => SPECIAL_ELEMENTS.has(n) && n !== "address" && n !== "div" && n !== "p");
  if (open.name === "p") return CLOSES_P.has(name) && !(quirks && name === "table") && !open.inner.some((n) => BUTTON_SCOPE.has(n));
  if (open.name === "li") return name === "li" && !stops();
  if (open.name === "dt" || open.name === "dd") return (name === "dt" || name === "dd") && !stops();
  if (HEADINGS.has(open.name)) return HEADINGS.has(name) && open.inner.length === 0;
  return false;
}

/**
 * The text of the one element whose id is `id` in an HTML document's
 * source, as its textContent reads once a browser has parsed it; null when
 * no element, or more than one, has that id. Read the way the HTML parser
 * reads a document: CR LF as LF, comments, doctype and processing
 * instructions skipped; script, style and the other raw-text elements read
 * up to their own end tag (their text counts, as in textContent), title and
 * textarea with references decoded; void elements and, in svg or math,
 * self-closed ones have no content; one newline after pre, listing and
 * textarea dropped; numeric character references and the common named ones
 * decoded (decodeReferences; any other named one stays as written). The
 * element ends at its own end tag, at the end tag of an element enclosing
 * it (div, section, li, a heading, body…), where the parser closes a p, li,
 * dt, dd or heading implicitly (a block start tag, a next item, a heading;
 * a table closes a p only when the source starts with a doctype, as quirks
 * mode is read here), or at the end of the input. A template's contents
 * are its own fragment: neither text nor elements of the document; noscript
 * is raw text, as in a page with scripting on; a byte order mark is read as
 * a page load strips it. Not modelled: table foster parenting, the adoption
 * agency's reparenting, an HTML tag breaking out of svg, and quirks mode
 * beyond "no doctype". Measured against Chrome's own parse of the e2e
 * fixtures and the edge cases in selftest/invariants-i8-in-place.
 * Pure and synchronous, for checkI8's draftHtml.
 */
export function elementText(html, id) {
  if (typeof html !== "string") throw new TypeError("elementText: html is a document's source, a string");
  if (typeof id !== "string" || !id) throw new TypeError("elementText: id is a non-empty string");
  const src = html.replace(/\r\n?/g, "\n");
  const quirks = !/^\ufeff?(?:[\t\n\f\r ]|<!--[\s\S]*?-->)*<!doctype[\t\n\f\r ]/i.test(src);
  let found = 0;
  let text = null;
  let open = null;
  let foreign = 0;
  const finish = () => {
    text = open.parts.join("");
    open = null;
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const stop = lt === -1 ? src.length : lt;
    if (open && stop > i) open.parts.push(decodeReferences(src.slice(i, stop)));
    if (lt === -1) break;
    i = lt;
    const next = src[i + 1] ?? "";
    if (src.startsWith("<!--", i)) {
      if (src.startsWith(">", i + 4) || src.startsWith("->", i + 4)) {
        i = src.indexOf(">", i + 4) + 1;
        continue;
      }
      const end = /--!?>/g;
      end.lastIndex = i + 4;
      const m = end.exec(src);
      i = m ? m.index + m[0].length : src.length;
      continue;
    }
    if (next === "!" || next === "?" || (next === "/" && !ALPHA.test(src[i + 2] ?? ""))) {
      const close = src.indexOf(">", i + 2);
      i = close === -1 ? src.length : close + 1;
      continue;
    }
    const closing = next === "/";
    if (!ALPHA.test(closing ? src[i + 2] : next)) {
      if (open) open.parts.push("<");
      i += 1;
      continue;
    }
    const tag = scanTag(src, i, closing);
    if (!tag) break;
    i = tag.end;
    if (closing) {
      if ((tag.name === "svg" || tag.name === "math") && foreign > 0) foreign -= 1;
      if (!open) continue;
      const at = open.inner.lastIndexOf(tag.name);
      if (at !== -1) open.inner.length = at;
      else if (tag.name === open.name || ENDS_ENCLOSING.has(tag.name) || (tag.name === "p" && !SPECIAL_ELEMENTS.has(open.name))) finish();
      continue;
    }
    if (open && endsImplicitly(open, tag.name, { quirks })) finish();
    if (tag.name === "template") {
      // its contents are a fragment of their own: no text of the element's, no element of the document's
      const nest = /<(\/?)template[\t\n\f\r \/>]/gi;
      nest.lastIndex = i;
      let depth = 1;
      for (let m = nest.exec(src); m; m = nest.exec(src)) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) {
          const close = src.indexOf(">", m.index);
          i = close === -1 ? src.length : close + 1;
          break;
        }
      }
      if (depth > 0) i = src.length;
      if (tag.attrs.get("id") === id && ++found > 1) return null;
      if (tag.attrs.get("id") === id) text = "";
      continue;
    }
    const mine = tag.attrs.get("id") === id;
    if (mine && ++found > 1) return null;
    if (RAW_TEXT_ELEMENTS.has(tag.name) || RCDATA_ELEMENTS.has(tag.name)) {
      const end = new RegExp(`</${tag.name}[\\t\\n\\f\\r />]`, "gi");
      end.lastIndex = i;
      const m = end.exec(src);
      let body = src.slice(i, m ? m.index : src.length);
      if (DROPS_NEWLINE.has(tag.name) && body.startsWith("\n")) body = body.slice(1);
      const content = RCDATA_ELEMENTS.has(tag.name) ? decodeReferences(body) : body;
      const close = m ? src.indexOf(">", m.index) : -1;
      i = close === -1 ? src.length : close + 1;
      if (mine) text = content;
      else if (open) open.parts.push(content);
      continue;
    }
    if (DROPS_NEWLINE.has(tag.name) && src[i] === "\n") i += 1;
    const empty = VOID_ELEMENTS.has(tag.name) || (tag.selfClosing && (foreign > 0 || tag.name === "svg" || tag.name === "math"));
    if (!empty && (tag.name === "svg" || tag.name === "math")) foreign += 1;
    if (mine) {
      if (empty) text = "";
      else open = { name: tag.name, inner: [], parts: [] };
      continue;
    }
    if (open && !empty) open.inner.push(tag.name);
  }
  if (open) finish();
  return found === 1 ? text : null;
}

/** What an entry judged in place needs, checked: {elementId, text, exact, expected} (expected: text with that one span replaced), or null for an entry judged by its count alone. */
function inPlaceOf(a, draftHtml, named) {
  const given = ["elementId", "text", "exact"].filter((k) => a[k] != null);
  if (given.length === 0) return null;
  if (given.length < 3) throw new TypeError(`checkI8: ${a.annId} judged in place needs elementId, text and exact (it has ${given.join(", ")} alone)`);
  if (typeof a.elementId !== "string" || !a.elementId) throw new TypeError(`checkI8: ${a.annId}'s elementId is the id of the element its quote stands in`);
  if (typeof a.text !== "string") throw new TypeError(`checkI8: ${a.annId}'s text is its element's text before the accept`);
  if (typeof a.exact !== "string" || !a.exact) throw new TypeError(`checkI8: ${a.annId}'s exact is its quote, a non-empty string`);
  const n = occurrences(a.text, a.exact);
  if (n !== 1) throw new TypeError(`checkI8: ${a.annId}'s quote ${JSON.stringify(a.exact)} stands ${n} time(s) in its element's text, not once, so which span it replaced is not known (judge it by its count alone)`);
  if (typeof draftHtml !== "string") throw new TypeError(`checkI8: ${a.annId} names #${a.elementId}, so it is judged in place, which needs draftHtml`);
  if (named.has(a.elementId)) throw new TypeError(`checkI8: ${named.get(a.elementId)} and ${a.annId} both name #${a.elementId}: in place is judged for one accepted change per element`);
  named.set(a.elementId, a.annId);
  const at = a.text.indexOf(a.exact);
  return { elementId: a.elementId, text: a.text, exact: a.exact, expected: a.text.slice(0, at) + a.replacement + a.text.slice(at + a.exact.length) };
}

/**
 * I8: each accepted replacement occurs exactly once in the draft's text,
 * and each one judged IN PLACE stands in its own element in place of its
 * quote: that element reads its old text with that one span replaced (SPEC
 * §22: an accept replaces exactly the quote's source bytes, and keeps the
 * result only if its text is the old text with that one span replaced). So
 * a replacement put beside a quote it kept, or into another element, fails
 * here though counting finds it once.
 *
 *   draftText  the draft's text, where each replacement is counted
 *   draftHtml  the draft's source; needed when an entry is judged in place
 *   accepted   [{annId, replacement, elementId?, text?, exact?}]. An entry
 *              with elementId, text and exact (all three, or none) is
 *              judged in place: elementId is the id of the element its
 *              quote stands in (its anchor's elementId), text that
 *              element's text before the accept (elementText of v1), exact
 *              the quote, standing once in text. One entry per element.
 *              An entry without them is judged by its count alone, as before.
 *
 * Failures: `<annId>: its replacement is in the draft <n> time(s), not once`
 * for every entry, then `<annId>: its replacement is in the draft once, but
 * not in place: #<elementId> reads "<its text>", not its text with "<exact>"
 * replaced by "<replacement>"` for each entry judged in place and counted
 * once. The result's `entries` [{annId, count, elementId, reads, expected,
 * shape}] say what each one looks like: shape "in place" (counted once, the
 * element reads expected), "absent" (counted 0 and the element reads its old
 * text, untouched: a lost update) or "other"; elementId, reads, expected
 * and shape are null for an entry judged by its count alone. A caller's
 * mistake (a partial entry, a quote not once in its text, no draftHtml, two
 * entries on one element) is a TypeError, never a verdict.
 */
export function checkI8({ draftText, draftHtml = null, accepted } = {}) {
  if (typeof draftText !== "string") throw new TypeError("checkI8: draftText is the draft's text");
  needArray(accepted, "accepted", "checkI8");
  if (draftHtml != null && typeof draftHtml !== "string") throw new TypeError("checkI8: draftHtml is the draft's source, a string");
  const failures = [];
  const misplaced = [];
  const entries = [];
  const named = new Map();
  for (const a of accepted) {
    if (typeof a.replacement !== "string" || !a.replacement) throw new TypeError(`checkI8: ${a.annId}'s replacement is a non-empty string (judge a deletion by its quote instead)`);
    const place = inPlaceOf(a, draftHtml, named);
    const n = occurrences(draftText, a.replacement);
    if (n !== 1) failures.push(`${a.annId}: its replacement is in the draft ${n} time(s), not once`);
    if (!place) {
      entries.push({ annId: a.annId, count: n, elementId: null, reads: null, expected: null, shape: null });
      continue;
    }
    const reads = elementText(draftHtml, place.elementId);
    const shape = n === 1 && reads === place.expected ? "in place" : n === 0 && reads === place.text ? "absent" : "other";
    entries.push({ annId: a.annId, count: n, elementId: place.elementId, reads, expected: place.expected, shape });
    if (n === 1 && reads !== place.expected) {
      misplaced.push(`${a.annId}: its replacement is in the draft once, but not in place: #${place.elementId} reads ${reads === null ? "(no such element, or more than one)" : JSON.stringify(reads)}, not its text with ${JSON.stringify(place.exact)} replaced by ${JSON.stringify(a.replacement)}`);
    }
  }
  return result("I8", [...failures, ...misplaced], { entries });
}

/**
 * I9: every suggestion [{annId, insertions, notes}] was applied once and
 * noted once, and every losing request [{status, json}] got a 409 naming
 * who claimed it.
 */
export function checkI9({ suggestions, losers = [] } = {}) {
  needArray(suggestions, "suggestions", "checkI9");
  needArray(losers, "losers", "checkI9");
  const failures = [];
  for (const s of suggestions) {
    if (s.insertions !== 1) failures.push(`${s.annId}: ${s.insertions} insertion(s), not one`);
    if (s.notes !== 1) failures.push(`${s.annId}: ${s.notes} decision note(s), not one`);
  }
  losers.forEach((l, i) => {
    if (l.status !== 409 || !l.json?.claimedBy) failures.push(`loser ${i + 1}: answered ${l.status} ${JSON.stringify(l.json)?.slice(0, 120)}, not 409 with claimedBy`);
  });
  return result("I9", failures);
}

/**
 * I10: as many notes as real flips, and the final state is the initial one
 * flipped that many times. `flips` how many requests really flipped it,
 * `notes` the notes written, `initial`/`final` booleans (resolved or not).
 */
export function checkI10({ flips, notes, initial, final } = {}) {
  if (!Number.isInteger(flips) || flips < 0 || !Number.isInteger(notes) || notes < 0) throw new TypeError("checkI10: flips and notes are counts");
  if (typeof initial !== "boolean" || typeof final !== "boolean") throw new TypeError("checkI10: initial and final are booleans");
  const failures = [];
  if (notes !== flips) failures.push(`${notes} note(s) for ${flips} real flip(s)`);
  const want = flips % 2 === 1 ? !initial : initial;
  if (final !== want) failures.push(`final state ${final}, but ${flips} flip(s) from ${initial} make ${want}`);
  return result("I10", failures);
}

/**
 * I11: per (to, doc, kind), no two messages within `windowMs`, and exactly
 * one for each eligible tuple. `messages` [{to, docId, kind, at}] (at in ms),
 * `eligible` [{to, docId, kind}].
 */
export function checkI11({ messages, eligible = [], windowMs = EMAIL_WINDOW_MS } = {}) {
  needArray(messages, "messages", "checkI11");
  needArray(eligible, "eligible", "checkI11");
  const key = (m) => `${String(m.to).toLowerCase()}|${m.docId}|${m.kind}`;
  const by = new Map();
  for (const m of messages) {
    if (!Number.isFinite(m.at)) throw new TypeError("checkI11: every message has `at` in ms");
    by.set(key(m), [...(by.get(key(m)) ?? []), m.at].sort((a, b) => a - b));
  }
  const failures = [];
  for (const [k, ats] of by) {
    for (let i = 1; i < ats.length; i += 1) {
      if (ats[i] - ats[i - 1] < windowMs) {
        failures.push(`${k.replace(/\|/g, " · ")}: ${ats.length} message(s), two of them ${Math.round((ats[i] - ats[i - 1]) / 1000)} s apart (inside ${Math.round(windowMs / 60_000)} min)`);
        break;
      }
    }
  }
  for (const e of eligible) {
    const n = by.get(key(e))?.length ?? 0;
    if (n !== 1) failures.push(`${key(e).replace(/\|/g, " · ")}: eligible, and sent ${n} time(s), not once`);
  }
  return result("I11", failures);
}

// --- I12 / I13 -------------------------------------------------------------------

/** I12: status/{d}/peers holds nobody (null or {}). */
export function checkI12(peers, { docId = "{d}", waitedMs = null } = {}) {
  const uids = peers && typeof peers === "object" ? Object.keys(peers) : [];
  const failures = uids.length ? [`status/${docId}/peers still holds ${uids.length} peer(s)${waitedMs != null ? ` ${Math.round(waitedMs)} ms after everyone left` : ""}: ${uids.slice(0, 10).join(", ")}`] : [];
  return result("I12", failures, { peers: uids.length });
}

/**
 * Wait up to `timeoutMs` (5 s) from `since` (when the last peer left) for
 * status/{d}/peers to be empty, reading it as the emulator's admin; resolves
 * checkI12's result for the last read (with `ms`, when it emptied).
 */
export async function waitI12(target, docId, { since = Date.now(), timeoutMs = PEERS_EMPTY_MS, intervalMs = 100, read = null } = {}) {
  const get = read ?? (async () => (await import("./admin.mjs")).rtdbGet(target, `status/${docId}/peers`));
  for (;;) {
    const peers = await get();
    const waited = Date.now() - since;
    const r = checkI12(peers, { docId, waitedMs: waited });
    if (r.ok) return { ...r, ms: waited };
    if (waited >= timeoutMs) return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

/**
 * I13: every peer shown as Shared got the probe within `limitMs`.
 * `arrivals` [{name, shared, ms}] — ms from the probe's last keystroke to
 * its arrival, null when it never arrived.
 */
export function checkI13({ arrivals, limitMs = PROBE_ARRIVAL_MS } = {}) {
  needArray(arrivals, "arrivals", "checkI13");
  const failures = [];
  const shared = arrivals.filter((a) => a.shared !== false);
  if (shared.length === 0) failures.push("no peer was Shared");
  for (const a of shared) {
    if (a.ms == null) failures.push(`${a.name}: the probe never arrived`);
    else if (a.ms > limitMs) failures.push(`${a.name}: the probe arrived after ${Math.round(a.ms)} ms (over ${limitMs})`);
  }
  const ms = shared.map((a) => a.ms).filter((x) => x != null).sort((x, y) => x - y);
  return result("I13", failures, { maxMs: ms.at(-1) ?? null, medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null });
}

// --- I14 – I16 -------------------------------------------------------------------

/** The RTDB key of an email, as the product writes it (admin.mjs emailKey): lower case, dots as commas. */
const emailKey = (email) => String(email).toLowerCase().split(".").join(",");

/**
 * I14: presenceAccess/{d} holds exactly the members, editAccess/{d} exactly
 * the editor members (by email key, the open-edit `*` key aside), and every
 * revoked user's `y` write was denied. `revokedWrites` [{email, verdict}]
 * (rtdbAs: "DENY" is a denial).
 */
export function checkI14({ members, editorMembers, presenceAccess, editAccess, revokedWrites = [], ignore = ["*"] } = {}) {
  needArray(members, "members", "checkI14");
  needArray(editorMembers, "editorMembers", "checkI14");
  needArray(revokedWrites, "revokedWrites", "checkI14");
  const metadata = ["__revision", "__expiresAt", "__owner"];
  const keys = (o) => new Set(Object.keys(o ?? {}).filter((k) => !metadata.includes(k) && !ignore.includes(k)));
  const diff = (want, got) => ({ missing: [...want].filter((k) => !got.has(k)).sort(), extra: [...got].filter((k) => !want.has(k)).sort() });
  const failures = [];
  for (const [name, map] of [["presenceAccess", presenceAccess], ["editAccess", editAccess]]) {
    if (map?.__revision !== undefined && (typeof map.__revision !== "string" || !/^\d{12}:\d{9}$/.test(map.__revision))) failures.push(`${name} has an invalid revision fence`);
    if (map?.__expiresAt !== undefined && (!Number.isFinite(map.__expiresAt) || map.__expiresAt < 0)) failures.push(`${name} has an invalid expiry deadline`);
    if (map?.__owner !== undefined && (typeof map.__owner !== "string" || map.__owner !== map.__owner.toLowerCase() || !/^[^@\s]+@[^@\s]+$/.test(map.__owner))) failures.push(`${name} has an invalid owner`);
    for (const [key, value] of Object.entries(map ?? {})) if (!metadata.includes(key) && value !== true) failures.push(`${name}/${key} is not a true access grant`);
  }
  for (const [name, want, got] of [["presenceAccess", new Set(members.map(emailKey)), keys(presenceAccess)], ["editAccess", new Set(editorMembers.map(emailKey)), keys(editAccess)]]) {
    const d = diff(want, got);
    if (d.missing.length || d.extra.length) failures.push(`${name} ${d.missing.length ? `lacks ${d.missing.join(", ")}` : ""}${d.missing.length && d.extra.length ? " and " : ""}${d.extra.length ? `has extra ${d.extra.join(", ")}` : ""}`);
  }
  for (const w of revokedWrites) if (w.verdict !== "DENY") failures.push(`${w.email} was revoked, and a y write answered ${w.verdict ?? "something else"}, not DENY`);
  return result("I14", failures);
}

/**
 * I15: every event id appears once, and the count of each kind is what was
 * caused. `events` [{id, kind}], `expected` {kind: count}.
 */
export function checkI15({ events, expected } = {}) {
  needArray(events, "events", "checkI15");
  if (!expected || typeof expected !== "object") throw new TypeError("checkI15: expected is {kind: count}");
  const failures = [];
  const seen = new Map();
  for (const e of events) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  const twice = [...seen].filter(([, n]) => n > 1);
  if (twice.length) failures.push(`${twice.length} event(s) reported more than once: ${twice.slice(0, 5).map(([id, n]) => `${id} ×${n}`).join(", ")}`);
  const counts = {};
  for (const [id] of seen) {
    const kind = events.find((e) => e.id === id).kind;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  for (const kind of new Set([...Object.keys(expected), ...Object.keys(counts)])) {
    if ((counts[kind] ?? 0) !== (expected[kind] ?? 0)) failures.push(`${kind}: ${counts[kind] ?? 0} event(s), ${expected[kind] ?? 0} caused`);
  }
  return result("I15", failures, { counts });
}

/** What computeMembership (scripts/lib/membership.mjs, the product's own twin) says the sets are. */
export async function expectedMembership(ownerEmail, grants, parent = null, teams = new Map()) {
  const { computeMembership } = await import("../../scripts/lib/membership.mjs");
  return computeMembership(ownerEmail, grants, parent, teams);
}

/**
 * I16: the stored membership sets equal the computed ones, and each access
 * probe [{email, status, expect}] answered as expected (200 for a grantee,
 * 404 for a removed user). `stored` and `computed` {members,
 * suggesterMembers, editorMembers, approverMembers}.
 */
export function checkI16({ stored, computed, access = [] } = {}) {
  if (!stored || !computed) throw new TypeError("checkI16: stored and computed are membership sets");
  needArray(access, "access", "checkI16");
  const failures = [];
  for (const k of ["members", "suggesterMembers", "editorMembers", "approverMembers"]) {
    if (!Array.isArray(computed[k])) continue;
    const want = new Set(computed[k].map((e) => String(e).toLowerCase()));
    const got = new Set((stored[k] ?? []).map((e) => String(e).toLowerCase()));
    const missing = [...want].filter((e) => !got.has(e)).sort();
    const extra = [...got].filter((e) => !want.has(e)).sort();
    if (missing.length || extra.length) failures.push(`${k}: ${missing.length ? `lacks ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `has extra ${extra.join(", ")}` : ""}`);
  }
  for (const a of access) if (a.status !== a.expect) failures.push(`${a.email}: ${a.status}, expected ${a.expect}`);
  return result("I16", failures);
}
