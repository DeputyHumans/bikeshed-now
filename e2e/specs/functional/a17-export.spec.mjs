// SPDX-License-Identifier: Apache-2.0
// Export and marking: the scrubbed, stamped print snapshot, a stamp hostile CSS cannot hide, PNG and SVG at scale, downloads, owner-only marking and its default, File → Print (SPEC §20).

/**
 * Catalogue A17, one scenario per case, each with its own accounts and
 * documents (17.2b renders the snapshot 17.2 captured, as smoke's 2b reads
 * 2's version):
 *
 *   17.1  the toolbar's Print (on a 400 px touch phone, where the bar has no
 *         room for it, More actions → "Print or save as PDF"; and Cmd/Ctrl+P
 *         with the focus in the document or app toolbar) hands print() a
 *         frame sandboxed exactly
 *         `allow-same-origin allow-modals`, whose document carries no
 *         decoration (DECOR against v1: no highlight, no injected style), no
 *         script, no on* handler and no javascript: URL, while the author's
 *         own data-bshd="whatever" survives; the label and footer stamps are
 *         the first two children of <body>, every locked property inline
 *         with !important, text only, fixed in the top layer; authored @page
 *         rules are unchanged; the footer's placeholders are filled;
 *         POST /marking clamps the label to 40 and the footer to 300
 *         characters and strips control characters; with marking off the
 *         stamps are absent and every scrub still holds
 *   17.1b an unlisted document's anonymous link holder prints it: the
 *         owner's marking must still be stamped — X-a17-export-4 (class P),
 *         see the case; the owner's own print of the same document is its
 *         positive control, and every step but the last is a precondition
 *   17.2  a document whose CSS sets every hiding vector SPEC §20 lists, with
 *         !important, on selectors matching the stamps, under print media:
 *         each locked property computes to what it computes to with no
 *         author CSS, and both stamps paint readable glyphs on the page
 *   17.2b the same snapshot with independent transforms (`scale`, `rotate`,
 *         `translate`), masking, blending and motion paths, each live alone
 *         at its own viewport width: hostile CSS cannot hide the marking
 *   17.2c html/body transforms, filters and containment retain visible
 *         authored content and both page-edge markings
 *   17.3  "Export an image…": a section's PNG at 1×, 2× and 3× is its
 *         border box × the scale, a diagram's PNG likewise, the SVG is the
 *         diagram as authored plus the owner's label; DECOR 0 on what was
 *         rasterized and on the SVG; the PNG carries the label's pixels
 *   17.3b the diagram's SVG FILE exported while the reader's comment is
 *         highlighted on its label: DECOR 0 on the file — X-a17-export-1
 *         (class P, SPEC §6 "NEVER persisted"), see the case
 *   17.3c the section's PNG exported in the same session, its comment
 *         highlighted: DECOR 0 on the markup html-to-image rasterized —
 *         X-a17-export-7 (class I: no SPEC sentence covers a picture's
 *         pixels; report and ask), judged on what 17.3b captured
 *   17.4  downloads: "Download the HTML" is the entry's bytes, named from
 *         the title; the .zip of a bundle passes REHASH and holds the
 *         uploaded files; a Markdown document offers the rendered HTML, its
 *         source and the zip, the source being index.md byte for byte and
 *         the rendered HTML the stored entry; an anonymous link holder
 *         downloads the same HTML through ~k and the same zip through ?k=,
 *         and without the key both are the absent id's 404
 *   17.4b an anonymous link holder's More menu offers a Markdown document's
 *         source and .zip as a member's does — X-a17-export-5 (class I: the
 *         SPEC keeps the version record from them and says nothing of the
 *         menu; report and ask), see the case
 *   17.5  marking is the owner's alone: POST /marking is 200 for the owner,
 *         403 for an editor, 404 for a stranger and 401 anonymous, and
 *         refusals change nothing; only the owner's More menu has "Marking
 *         on exports…", whose dialog stores exactly what it shows; no
 *         client may write docs/{id}.marking while each (owner and editor)
 *         may write their own users/{uid}.defaultMarking, and the editor
 *         not the owner's; the Account page's default
 *         seeds the Upload dialog and the uploaded document
 *   17.5b the account default seeds a document the owner publishes
 *         through MCP or the CLI, "as for any new document" —
 *         X-a17-export-3, see the case
 *   17.5c an Upload dialog opened before the workspace has the account
 *         record (the page's Firestore Listen channel held) must still seed
 *         Stamp exports once the record reaches it (the moment the workspace
 *         hands the dialog the default, read from the page) — X-a17-export-6,
 *         see the case
 *   17.6  File → Print (the browser's own print, here Page.printToPDF,
 *         which fires beforeprint and afterprint): the frame opens to its
 *         content's full height for the print and the PDF paginates; it
 *         closes again with the reader's scroll position back; no stamp, no
 *         print frame; on paper the viewer's chrome is hidden
 *
 * Expected behaviour is SPEC §20 (the mechanism, the layers, "Safety"), §2
 * (POST /marking, GET /download, /content ~k), §6 (highlights are never
 * persisted), §10.1, §17 (an unlisted document needs its link; the records
 * an anonymous reader may not read), CHANGELOG 0.3.0's "as for any new document",
 * docs/operations/config.md "Export marking" and the product source cited
 * at each oracle (app/src/export/{pdf,image,html,labels}.ts,
 * app/src/viewer/usePrinting.ts, app/src/pages/DocViewer.tsx). Only
 * e2e/lib/ talks to the stack.
 *
 * How the print is observed. printDoc (app/src/export/pdf.ts) appends a
 * sandboxed iframe, writes the snapshot into it, waits 250 ms and calls
 * contentWindow.print(). User.capturePrint (lib/browser.mjs) replaces that
 * frame's print() with a recorder, so what is captured is the document at
 * the moment print() is called, and no dialog opens; `printExtract` below
 * reads the stamps there, in the app's window. The stamp's visibility is
 * judged on that exact snapshot, rendered by pool.printRenderer() in a
 * scratch context of the same Chrome under print media, against the same
 * render with the two stamps removed (lib/png.mjs counts the pixels).
 *
 * Every account is quiet (users/{uid}.emailNotifications false before any
 * session) and every comment is preceded by quietDoc(), so no case sends
 * mail on either tier. An unlisted document is made private again by the
 * case itself before it ends, and by lib's teardown if the case does not get
 * that far.
 *
 * The loaded stack. On a shared stack a write function can take 25–58 s and
 * Hosting answers 504 at its minute while the function goes on; a page's
 * Firestore Listen channel can stall; the Admin SDK can run past its gRPC
 * deadline. None of that is the product answering, so every case declares
 * lib/test.mjs's `inconclusiveOnCaseTimeout` (and so `inconclusiveOnPageStall`
 * and `inconclusiveOnStackTimeout`): a non-answer, or a wait that ran out
 * while one of the case's pages saw the stack stall, ends it INCONCLUSIVE,
 * and nothing else does. Function calls go through lib's `untilLanded`, or
 * the `patient` option of publish, publishMcp and setVisibility, which look
 * for a call's effect in the record before sending it again; waits on what a
 * page shows go through User.waitShown, which loads the page again only when
 * that page saw the stack stall.
 *
 * Historical negative controls. The original three patch sets were red with
 * their patch and green without (`run.mjs controls`): controls-a17-print-scrub (17.1),
 * controls-a17-stamp-lock (17.2) and controls-a17-file-print (17.6). The rest
 * are spec mutants, a copy of this file with one bug planted, run with
 * --spec-file and each seen red on its own message. 17.3: the 3× export
 * made at 2×; the section exported in the diagram's place; the marking
 * off, so no label pixels; the SVG's label stripped. 17.5: the editor's
 * refusal sent as the owner; a write slipped in after the refusals; the
 * editor's menu read on the owner's page; a client with no token in the
 * editor's place; the owner's write to docs/{id}.marking sent with the
 * emulator's admin bearer; the dialog's label changed before saving; the
 * Account box never checked; the upload sent with the box unchecked. In the
 * known-defect cases only the defect's own oracle can be booked as it, and a
 * mutant of what comes before FAILS: 17.1b with POST /marking storing
 * another label, the marking off for the owner's control, the link holder's
 * snapshot unscrubbed; 17.5c with no account default, and the hand-off
 * unreadable. And those oracles can pass: the SVG file with its wrapper
 * unwrapped (17.3b) and a box checked at the hand-off (17.5c) each end
 * "passed unexpectedly". The current controls-a17-* sets additionally target
 * fixed placement, page geometry, both shortcut listeners, each independent
 * transform, authored ancestor layout, decoration, pagination, all five
 * rendered chrome classes, scroll/height cleanup, and unintended File → Print
 * stamps or frames. Their current execution proof belongs to the campaign
 * evidence, not this historical description.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { currentTarget, isHostingCutoff, precondition, scenario, stackCutoff, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { idToken, mintToken, openSession } from "../../lib/session.mjs";
import { docIdFor, ledgerDoc, publish, publishMcp, zipBundle } from "../../lib/seed.mjs";
import { setVisibility, share } from "../../lib/grant.mjs";
import { closeAdmin, readDoc } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { decorations, entryHtml, fingerprint, foreignMarkers, rehashZip, summarize } from "../../lib/bytes.mjs";
import { zipFiles } from "../../lib/zipread.mjs";
import { quietDoc } from "../../lib/guard.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { cliHome, runCli } from "../../lib/cli.mjs";
import { createHttp } from "../../lib/http.mjs";
import { colourPixels, pngSize } from "../../lib/png.mjs";
import { holdListen } from "../../lib/sync.mjs";
import { postThumb } from "../../lib/thumbs.mjs";
import { patchCapability } from "../../lib/options.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

/**
 * The file's budget (lib/budget.mjs): twelve of the cases took 14 to 25
 * minutes on the loaded shared stack, and the thirteen cases' own timeouts
 * sum to 110 minutes, past the 60 the scan caps a computed budget at; a stall
 * late in the file must end its own case, not cancel the cases after it.
 */
export const E2E_FILE_TIMEOUT_MS = 115 * 60_000;

const BOTH = ["local", "prod"];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tag = () => `${runTag(target.runId)}-${rand4()}`;

// --- pinned literals (never imported from the product) --------------------------

/** app/src/brand/dom.ts PRINT_MARK_CLASS and PRINT_FOOTER_CLASS. */
const MARK_CLASS = "bshd-print-mark";
const FOOTER_CLASS = "bshd-print-footer";
const STAMP_SELECTOR = `.${MARK_CLASS}, .${FOOTER_CLASS}`;

/** Every property app/src/export/pdf.ts LOCK sets inline with !important, as of this suite's writing. */
const LOCKED = Object.freeze([
  "display", "visibility", "opacity", "transform", "filter", "clip-path", "clip", "content-visibility",
  "position", "z-index", "margin", "border", "background", "max-height", "max-width", "height", "width", "overflow", "pointer-events", "zoom",
  "-webkit-text-fill-color", "-webkit-text-stroke", "text-indent", "text-shadow", "letter-spacing", "word-spacing",
  "white-space", "text-transform",
  "scale", "rotate", "translate", "mask-image", "mix-blend-mode", "offset-path",
]);

/** The hiding vectors SPEC §20 names, box then text: each must be among the locked ones. */
const SPEC_VECTORS = Object.freeze([
  "display", "visibility", "opacity", "transform", "filter", "clip", "clip-path", "content-visibility",
  "max-height", "max-width", "overflow", "zoom",
  "-webkit-text-fill-color", "-webkit-text-stroke", "text-indent", "text-shadow", "letter-spacing", "word-spacing",
  "white-space", "text-transform",
  "scale", "rotate", "translate", "mask-image", "mix-blend-mode", "offset-path",
]);

/** The stamp colours pdf.ts writes: the label's red and the footer's grey (the glyphs the oracle looks for). */
const LABEL_RGB = [0xb0, 0x23, 0x18];
const FOOTER_RGB = [0x4a, 0x4a, 0x55];

/** SPEC §20 / functions/src/lib/marking.ts: the caps. */
const MAX_LABEL = 40;
const MAX_FOOTER = 300;
/** app/src/export/labels.ts SUGGESTED_LABEL / SUGGESTED_FOOTER: what the Account checkbox stores. */
const SUGGESTED_LABEL = "CONFIDENTIAL";
const SUGGESTED_FOOTER = "© {year} · {title} · {version} · Confidential — for review only.";
const MARKING_OFF = Object.freeze({ enabled: false, label: "", footer: "" });

/** A print page, CSS px at 96 dpi: A4. */
const PAGE = Object.freeze({ width: 794, height: 1123 });

// --- accounts, documents, the viewer --------------------------------------------

/**
 * How long a function request may take on a loaded shared stack: past
 * Hosting's own minute, so its cut-off 504 is what is seen (and judged by
 * lib/test.mjs as the stack not answering), never a client timeout first.
 */
const FN_MS = 150_000;

/**
 * How long into a case the stack's non-answers are still worth sending again:
 * lib/test.mjs untilLanded's `stopAt`, for every function call of the case. A
 * non-answer costs up to Hosting's minute, a minute looking for its effect,
 * and FN_MS for the next attempt, and on the shared stack one case spent its
 * whole 480 s sending POST /thumb again and was cut by its timeout. Past this,
 * a non-answer whose effect does not show ends the case INCONCLUSIVE at once.
 * A case that meets none is never affected.
 */
const ENV_BUDGET_MS = 240_000;
const stopAts = new WeakMap();

/** untilLanded's options for this case: `stopAt` is fixed by its first call (each case's first is its owner's session). */
function patience(ctx) {
  if (!stopAts.has(ctx)) stopAts.set(ctx, Date.now() + ENV_BUDGET_MS);
  return { stopAt: stopAts.get(ctx) };
}

/** The `patient` option of lib's publish, publishMcp and setVisibility, for this case. */
const patient = (ctx) => ({ ctx, ...patience(ctx) });

/**
 * How long a sign-in or a document open may take: the lib's 45 s default was
 * exceeded on a shared stack whose functions answered POST /visibility in 27 s.
 * A wait on a condition, never a sleep.
 */
const SLOW = Object.freeze({ timeout: 90_000 });

/** How long a page may take to show what it shows once loaded, on a loaded stack: a wait on a condition. */
const PAGE_MS = 150_000;

/** Quiet accounts: no comment can mail any of them, on either tier. */
async function castQuiet(roles) {
  return cast(target, roles, { notifications: false, analytics: false });
}

async function ownerSession(ctx, roles = []) {
  const accounts = await castQuiet(["owner", ...roles]);
  const owner = await sessionFor(ctx, accounts[0]);
  return { owner, accounts };
}

/** A session (POST /session, safe to send again) whose client waits FN_MS for each answer. */
async function sessionFor(ctx, acct) {
  const { out } = await untilLanded(ctx, `POST /session (${acct.role})`, () => openSession(target, acct, { timeoutMs: FN_MS }), null, patience(ctx));
  return out;
}

/**
 * Sign `acct` in through /signup. The app's own POST /session got Hosting's
 * cut-off on the loaded shared stack (signInUi throws it with the answer, so
 * lib reads it as the stack not answering); signing in is safe to repeat, so
 * untilLanded tries it again. Any other outcome is the case's.
 */
async function signedIn(ctx, acct, name, opts = {}) {
  const u = await ctx.users.user({ name, ...opts });
  const { out: s } = await untilLanded(ctx, `${name}'s sign-in`, () => u.signInUi(acct.email, acct.password, SLOW), null, patience(ctx));
  precondition(s.status === "ok", `${name} signed in through /signup`);
  return u;
}

/**
 * Open a document (`k` for a link holder) and wait for its frame. The viewer
 * shows "Opening the document…" until the record arrives over the page's
 * Listen channel, which a loaded stack can stall; User.waitShown loads the
 * page once more only when this page saw that happen, and otherwise the
 * wait's failure is the case's.
 */
async function openDoc(ctx, u, docId, { k = null } = {}) {
  const path = `/d/${encodeURIComponent(docId)}${k ? `?k=${encodeURIComponent(k)}` : ""}`;
  await u.goto(path, SLOW);
  await u.waitShown(".viewer-body", { what: `the viewer of ${docId}`, path, timeout: SLOW.timeout });
  return u.waitForFrame(SLOW);
}

/** The workspace's card of `docId`. */
function workspaceCard(u, docId) {
  return u.page.locator(".doc-card", { has: u.page.locator(`a.doc-card-title[href="/d/${docId}"]`) });
}

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

/** The cleaning functions/src/lib/marking.ts applies, re-stated: drop C0 controls and DEL, trim, cut. */
function cleaned(value, max) {
  return Array.from(value).filter((ch) => {
    const c = ch.codePointAt(0);
    return c >= 0x20 && c !== 0x7f;
  }).join("").trim().slice(0, max);
}

/** app/src/export/html.ts safeFilename, re-stated. */
function safeFilename(name) {
  const c = (name || "document").replace(/[^\w.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return c || "document";
}

/**
 * POST /publish (lib/seed.mjs publish, patient): it names its own id, so a
 * request the stack did not answer is looked for in the record before it is
 * sent again, and a document it made after all is taken (and ledgered)
 * instead of being made twice.
 */
function publishDoc(ctx, http, o) {
  return publish(http, { ...o, timeoutMs: FN_MS, patient: patient(ctx) });
}

/** POST /marking as `http`, sent again when the stack did not answer it (it sets, or is refused): for the refusals. */
async function postMarking(ctx, http, docId, marking) {
  const { out } = await untilLanded(ctx, "POST /marking", () => http.postJson("/marking", { docId, marking }, { timeoutMs: FN_MS }), null, patience(ctx));
  return out;
}

/**
 * POST /marking as the owner: `{status, marking}`, the marking as answered,
 * or as stored when the stack did not answer a request that took effect (the
 * record's marking changed; every call here changes it). Anything but 200
 * fails the case on its precondition.
 */
async function ownerMarking(ctx, owner, docId, marking) {
  const before = (await readDoc(target, `docs/${docId}`))?.marking ?? null;
  const r = await untilLanded(ctx, `POST /marking ${docId}`, () => owner.http.postJson("/marking", { docId, marking }, { timeoutMs: FN_MS }), async () => {
    const now = (await readDoc(target, `docs/${docId}`))?.marking ?? null;
    return now && !isDeepStrictEqual(now, before) ? now : null; // this call's write, not the old value
  }, patience(ctx));
  if (r.landed) return { status: null, marking: r.landed };
  precondition(r.out.status === 200, `POST /marking on ${docId}: ${r.out.status} ${r.out.text.slice(0, 200)}`);
  return { status: 200, marking: r.out.json.marking };
}

/** POST /marking as the owner: the marking it set. */
async function setMarking(ctx, owner, docId, marking) {
  return (await ownerMarking(ctx, owner, docId, marking)).marking;
}

/**
 * Unlisted through lib/grant.mjs setVisibility (patient): its link token. The
 * window is registered before the request, so lib's teardown closes it
 * whatever happens; the case closes it itself first (privateAgain).
 */
async function unlisted(ctx, owner, docId) {
  const r = await setVisibility(target, { owner, doc: docId, visibility: "unlisted", timeoutMs: FN_MS, patient: patient(ctx) });
  precondition(typeof r.linkToken === "string" && r.linkToken.length > 0, `an unlisted document has a link token: ${JSON.stringify(r.json ?? { landed: r.landed })}`);
  return r.linkToken;
}

/**
 * Private again inside the case (setVisibility, patient): within the case's
 * own budget, rather than in lib's teardown, which runs after the body and
 * may wait two minutes on a close the stack did not answer.
 */
async function privateAgain(ctx, owner, docId) {
  await setVisibility(target, { owner, doc: docId, visibility: "private", timeoutMs: FN_MS, patient: patient(ctx) });
}

/**
 * The version's cover thumbnail, stored ahead of the reader as an editor's
 * browser stores it (lib/thumbs.mjs postThumb). Otherwise the owner's viewer
 * captures one itself, 2.5 s after the frame loads, by rendering the document
 * with html-to-image in an iframe of its own (app/src/viewer/useThumbCapture.ts,
 * capture.ts). A17.3 records what XMLSerializer serializes during an export,
 * and that capture serializes the same section; A17.6 counts every iframe
 * added during the browser's print. With a current cover, captureNeeds
 * (app/src/thumbs.ts) owes nothing for a document that is not a deck, so no
 * capture is made. (A print through capturePrint needs none of this: its
 * `match` ignores the capture frame.)
 */
async function coverStored(ctx, owner, docId, versionId = "v1") {
  const r = await untilLanded(ctx, `POST /thumb ${docId}`, () => postThumb(owner.http, { docId, versionId, kind: "cover", timeoutMs: FN_MS }), async () => {
    const t = (await readDoc(target, `docs/${docId}`))?.thumb;
    return t?.versionId === versionId && typeof t.cover === "string" ? t : null;
  }, patience(ctx));
  if (r.out) precondition(r.out.status === 200, `POST /thumb on ${docId}: ${r.out.status} ${String(r.out.text ?? "").slice(0, 160)}`);
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/**
 * The probe document: a passage to comment on far from the page edges, the
 * active content the print must scrub (two scripts, three on* handlers, five
 * javascript: URLs over href, src and xlink:href, case and whitespace mixed),
 * the author's own data-bshd="whatever", a fixed-size section and a titled
 * SVG diagram for the image export. No top-level <div>: hostile rules below
 * use `body > div` to reach the stamps without touching the content.
 */
function probeDoc({ title, hostile = "", extraBody = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body { margin: 32px; font: 16px/1.5 Georgia, serif; color: #222; background: #fff; }
  main { max-width: 640px; }
  #s-box { width: 400px; height: 150px; padding: 10px; border: 2px solid #345; background: #f4f7fb; box-sizing: content-box; overflow: hidden; }
  #s-box p { margin: 0; }
</style>
${hostile ? `<style id="hostile">\n${hostile}\n</style>` : ""}
<script>document.documentElement.setAttribute("data-ran", "head");</script>
</head>
<body onload="document.title = 'loaded'">
<main id="m">
<section id="s-intro">
<h1>${esc(title)}</h1>
<p id="p-1">A quiet passage to comment on, far from the edges.</p>
<p id="p-2" onclick="alert(1)" onmouseover="alert(2)">A paragraph with handlers in its markup.</p>
<p id="p-links"><a id="a-1" href="javascript:alert(3)">plain</a> · <a id="a-2" href="  JaVaScRiPt:alert(4)">mixed case</a> · <a id="a-3" href="java&#x09;script:alert(5)">a tab inside</a> · <a id="a-ok" href="#s-box">a fragment</a></p>
<img id="i-1" src="javascript:alert(6)" alt="" width="1" height="1">
<svg id="g-1" width="40" height="20" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(7)"><text x="2" y="14" font-size="10">x</text></a></svg>
<p id="foreign" data-bshd="whatever">The author's own marker, which must survive.</p>
</section>
<section id="s-box"><p id="p-box">A passage in the box, exported as an image.</p></section>
<section id="s-fig"><svg id="fig" xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><title>Diagram one</title><rect x="1" y="1" width="238" height="118" fill="#eef2fb" stroke="#335"/><text id="fig-label" x="20" y="66" font-size="16" fill="#223">Label in a figure</text></svg></section>
${extraBody}
</main>
<script>console.log("tail script")</script>
</body>
</html>
`;
}

/**
 * Select `quote` in `selector` and comment `text` on it (User.comment). The
 * loaded emulator can fail a rule's get() ("Service call error" in the app's
 * toast: the emulator failing, not the rules' verdict); `retryServiceError`
 * presses again after such a refusal, selecting the passage again first, and
 * when every press is refused so the case is INCONCLUSIVE. Any other failure
 * is the case's.
 */
async function commentOn(u, selector, quote, text) {
  await u.selectText(selector, quote);
  return u.comment(text, { timeout: 45_000, retryServiceError: 3, reselect: () => u.selectText(selector, quote) });
}

/** Wait for the reading frame to show `count`+ highlight wrappers matching `selector`. */
async function waitHighlights(u, selector, count = 1) {
  await eventually(async () => (await (await u.frame()).locator(selector).count()) >= count, { timeout: 60_000, message: `the frame highlights ${selector}` });
}

// --- the print capture ------------------------------------------------------------

/**
 * User.capturePrint's `extract`: runs in the app's window at the print()
 * call, on the print frame's document. It is sent as source, so it uses
 * nothing but its arguments (`locked` is LOCKED). The stamps as print() gets
 * them (their place in <body>, their text, each locked property's inline
 * value and priority), the first children of <body>, and the date and year by
 * the page's own clock and locale, for the footer's placeholders.
 */
function printExtract(d, locked) {
  const body = d.body;
  const kids = Array.from(body.children);
  return {
    stamps: Array.from(d.querySelectorAll('[class*="bshd-print"]')).map((el) => ({
      className: el.getAttribute("class"),
      tag: el.localName,
      text: el.textContent,
      topLayer: el.matches(":popover-open"),
      childElements: el.children.length,
      parentIsBody: el.parentElement === body,
      index: kids.indexOf(el),
      priorities: Object.fromEntries(locked.map((p) => [p, el.style.getPropertyPriority(p)])),
      values: Object.fromEntries(locked.map((p) => [p, el.style.getPropertyValue(p)])),
    })),
    pageRules: Array.from(d.styleSheets).flatMap((sheet) => {
      const collect = (rules) => Array.from(rules).flatMap((rule) => rule.type === CSSRule.PAGE_RULE ? [rule.cssText] : rule.cssRules ? collect(rule.cssRules) : []);
      return collect(sheet.cssRules);
    }),
    firstChildren: kids.slice(0, 3).map((e) => e.getAttribute("class") || e.localName),
    date: new Date().toLocaleDateString(undefined, { dateStyle: "medium" }),
    year: String(new Date().getFullYear()),
  };
}

/**
 * What a print frame is (User.capturePrint's `match`): printDoc's iframe,
 * sandboxed `allow-same-origin allow-modals` (A17.1 asserts the exact
 * value). The owner's viewer may add its thumbnail capture frame, sandboxed
 * `allow-same-origin` alone (app/src/viewer/capture.ts), in the middle of a
 * print on a loaded page; capturePrint ignores it, listed in `ignored`.
 */
const PRINT_FRAME = '[sandbox~="allow-modals"]';

/**
 * Print once through User.capturePrint (`action` a More-menu label or a
 * function): the one print frame and its one snapshot, `{html, stamps,
 * firstChildren, date, year}`. Exactly one frame printed exactly once is the
 * harness's measurement holding, so a miss is a precondition.
 */
/** The toolbar's own Print button: the way a reader prints, anywhere wider than a phone. */
const toolbarPrint = (u) => () => u.page.locator(".viewer-toolbar").getByRole("button", { name: "Print", exact: true }).click();

async function printOnce(ctx, u, action, what) {
  const rec = await u.capturePrint(action, { extract: printExtract, arg: LOCKED, match: PRINT_FRAME });
  if (rec.ignored.length > 0) ctx.step(`${what}: ${rec.ignored.length} iframe(s) added during the print were not print frames (sandbox ${JSON.stringify(rec.ignored.map((f) => f.sandbox))}): ignored`);
  precondition(rec.frames.length === 1, `${what}: ${rec.frames.length} print frames`);
  const [f] = rec.frames;
  precondition(f.hookError === null, `${what}: could not hook print(): ${f.hookError}`);
  precondition(f.printed === 1 && f.snaps.length === 1, `${what}: print() called ${f.printed} times`);
  const [s] = f.snaps;
  precondition(s.error === null && s.extractError === null && s.extra, `${what}: the print frame's document could not be read: ${s.error ?? s.extractError}`);
  return { frame: f, snap: { html: s.html, ...s.extra } };
}

/** Active content in an HTML document, parsed by Chrome: scripts, on* attributes, javascript: URLs in href/src/xlink:href. */
async function activeContent(parser, html) {
  return parser.evaluate((src) => {
    const d = new DOMParser().parseFromString(src, "text/html");
    const all = Array.from(d.querySelectorAll("*"));
    const handlers = [];
    const jsUrls = [];
    for (const el of all) {
      for (const n of el.getAttributeNames()) {
        if (n.toLowerCase().startsWith("on")) handlers.push(`${el.localName}${el.id ? `#${el.id}` : ""}[${n}]`);
        if (["href", "src", "xlink:href"].includes(n.toLowerCase())) {
          // As the URL parser reads it: control characters and spaces stripped.
          if (/^javascript:/i.test(el.getAttribute(n).replace(/[\u0000- ]/g, ""))) jsUrls.push(`${el.localName}${el.id ? `#${el.id}` : ""}[${n}]`);
        }
      }
    }
    return { scripts: d.querySelectorAll("script").length, handlers, jsUrls };
  }, html);
}

/** DECOR on a print snapshot against v1, the two stamps (once each) excepted: they are the export's own nodes. */
function printDecor(fpPrint, fpV1, { stamps }) {
  const allowed = stamps ? [MARK_CLASS, FOOTER_CLASS] : [];
  return decorations(fpPrint, fpV1).filter((d) => !(d.kind === "bshd-class" && allowed.includes(d.key) && d.count === 1));
}

// --- rendering a snapshot under print media ----------------------------------------

/**
 * Where each stamp paints on a print page `width` CSS px wide (pdf.ts: the
 * label top-right in red, the footer along the bottom in grey). With
 * printRenderer's `without: STAMP_SELECTOR` only what the stamps themselves
 * painted is counted.
 */
function stampRegions(width) {
  return {
    label: { x: width - 420, y: 0, w: 420, h: 80, color: LABEL_RGB },
    footer: { x: 0, y: PAGE.height - 60, w: width, h: 60, color: FOOTER_RGB },
  };
}

/**
 * Readable glyphs of one stamp in a render: enough stamp-coloured changed
 * pixels (lib/png.mjs colourPixels), filling at most 60% of their bounding
 * box (glyphs, not a block), and that box inside the stamp's own border box
 * as it rendered (`rect`, from `computed`, transforms included). Pixels
 * counted anywhere else are not the stamp's: in two runs a render whose
 * stamps computed `scale: 0` (a box of 0×0) still counted 656 and 728 such
 * pixels in a strip at the page's bottom left, and a replay of the same
 * snapshot counted none.
 */
function readable(p, rect, tol = 2) {
  if (!(p.count >= 20 && p.fill <= 0.6) || !p.box || !rect) return false;
  const [x, y, w, h] = rect;
  const [bx, by, bw, bh] = p.box;
  return bx >= x - tol && by >= y - tol && bx + bw <= x + w + tol && by + bh <= y + h + tol;
}

/** Whether each stamp of a renderStamps result paints readable glyphs: {label, footer}. */
function stampsVisible(out) {
  const rect = (cls) => out.elements?.find((e) => e.className === cls)?.rect ?? null;
  return { label: readable(out.pixels.label, rect(MARK_CLASS)), footer: readable(out.pixels.footer, rect(FOOTER_CLASS)) };
}

/**
 * A render of the snapshot under print media at `width`: the stamps'
 * computed locked properties and boxes, `probe`'s reading, and the pixels
 * each stamp paints. printRenderer settles the page first (its fonts ready,
 * two animation frames), so what is read and shot is the page as painted.
 */
function renderStamps(r, html, { width = PAGE.width, probe = null, openMarks = hostilePrint.openMarks } = {}) {
  return r.render(html, { width, probe: async (page) => {
    await page.evaluate((classes) => classes.forEach((name) => document.getElementsByClassName(name)[0]?.showPopover()), openMarks);
    const probed = probe ? await probe(page) : null;
    const elements = await page.evaluate(({ selector, properties }) => Array.from(document.querySelectorAll(selector)).map((el) => {
      const css = getComputedStyle(el), r = el.getBoundingClientRect();
      return { className: el.className, rect: [r.x, r.y, r.width, r.height], computed: Object.fromEntries(properties.map((p) => [p, css.getPropertyValue(p)])) };
    }), { selector: STAMP_SELECTOR, properties: LOCKED });
    return { probed, elements };
  }, without: STAMP_SELECTOR, regions: stampRegions(width) }).then((out) => ({ ...out, ...out.probed }));
}

/** A render result without its PNG buffers, for evidence. */
const renderSummary = (o) => ({ width: o.width, elements: o.elements, probed: o.probed, removed: o.removed, pixels: o.pixels });

// --- A17.1 --------------------------------------------------------------------------

const P1_QUOTE = "quiet passage to comment on";

scenario("A17.1 Print or save as PDF hands print() a frame sandboxed allow-same-origin allow-modals whose document has no decoration, script, on* handler or javascript: URL; the label and footer stamps come first with every locked property !important, placeholders filled, label ≤ 40 and footer ≤ 300 characters; Cmd/Ctrl+P prints the same; marking off removes the stamps and nothing else", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 600_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const title = `Print probe ${t}`;
  const html = probeDoc({ title, hostile: "@page { size: 200mm 120mm; margin: 9mm; }" });
  const up = await publishDoc(ctx, owner.http, { body: html, filename: "index.html", title, name: "a171-print" });
  precondition(up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)}`);
  const docId = up.docId;

  ctx.step("the owner sets a marking through POST /marking: a label with markup and control characters past 40, a footer naming every placeholder past 300");
  const rawLabel = `  <i>Top</i>\u0007 secret\u001f ${t} ${"L".repeat(60)}`;
  const rawFooter = `{year}|{date}|{title}|{version}|{user}|\u0000\t\n${"F".repeat(400)}`;
  const stored = await setMarking(ctx, owner, docId, { enabled: true, label: rawLabel, footer: rawFooter });
  const expected = { enabled: true, label: cleaned(rawLabel, MAX_LABEL), footer: cleaned(rawFooter, MAX_FOOTER) };
  assert.deepEqual(stored, expected, "POST /marking answers the cleaned, clamped marking");
  assert.ok(expected.label.length === MAX_LABEL && expected.footer.length === MAX_FOOTER, "the probe really ran past both caps");
  assert.deepEqual((await readDoc(target, `docs/${docId}`)).marking, expected, "docs/{id}.marking is the cleaned, clamped marking");

  ctx.step("the owner opens it and comments on a passage, so the reading frame holds a highlight and its injected style");
  await quietDoc(target, docId);
  const u = await signedIn(ctx, accounts[0], "owner");
  await openDoc(ctx, u, docId);
  await commentOn(u, "#p-1", P1_QUOTE, `Print probe comment ${t}`);
  await waitHighlights(u, "mark.bshd-hl");

  ctx.step("the toolbar's Print; the print frame's document is captured when print() is called");
  const { frame, snap } = await printOnce(ctx, u, toolbarPrint(u), "the toolbar's print");
  ctx.ev.text("print-snapshot.html", snap.html);
  ctx.ev.json("print-stamps", snap.stamps);

  assert.equal(frame.sandbox, "allow-same-origin allow-modals", "the print frame's sandbox (SPEC §20)");

  const parser = await ctx.users.parser();
  const [aV1, aPrint] = [await activeContent(parser, html), await activeContent(parser, snap.html)];
  precondition(aV1.scripts === 2 && aV1.handlers.length === 3 && aV1.jsUrls.length === 5, `the probe's own active content: ${JSON.stringify(aV1)}`);
  assert.deepEqual(aPrint, { scripts: 0, handlers: [], jsUrls: [] }, "no script, on* handler or javascript: URL reaches print()");

  ctx.step("DECOR against v1: no highlight, no injected style; the author's data-bshd=\"whatever\" survives");
  const fp1 = await fingerprint(parser, html);
  const fpP = await fingerprint(parser, snap.html);
  ctx.ev.json("fingerprints", { v1: summarize(fp1), print: summarize(fpP) });
  precondition((await (await u.frame()).locator("mark.bshd-hl").count()) >= 1, "the frame still holds the highlight");
  assert.deepEqual(printDecor(fpP, fp1, { stamps: true }), [], "DECOR: decoration in the print snapshot");
  assert.deepEqual(foreignMarkers(fpP), { whatever: 1 }, "the author's own data-bshd survives the print");

  ctx.step("the stamps: label then footer, the first two children of <body>, text only, every locked property !important");
  assert.deepEqual(snap.firstChildren.slice(0, 2), [MARK_CLASS, FOOTER_CLASS], "the stamps go first in <body>, label then footer");
  assert.deepEqual(snap.stamps.map((s) => ({ className: s.className, tag: s.tag, parentIsBody: s.parentIsBody, index: s.index, childElements: s.childElements })), [
    { className: MARK_CLASS, tag: "div", parentIsBody: true, index: 0, childElements: 0 },
    { className: FOOTER_CLASS, tag: "div", parentIsBody: true, index: 1, childElements: 0 },
  ], "exactly two stamps, text only");
  for (const v of SPEC_VECTORS) assert.ok(LOCKED.includes(v), `SPEC §20's vector ${v} is among the locked properties`);
  for (const s of snap.stamps) {
    assert.equal(s.topLayer, true, `${s.className}: the stamp is isolated from authored ancestor layout`);
    assert.equal(s.values.position, "fixed", `${s.className}: the stamp repeats on every printed page`);
    const notImportant = LOCKED.filter((p) => s.priorities[p] !== "important" || !s.values[p]);
    assert.deepEqual(notImportant, [], `${s.className}: locked properties not set inline with !important`);
  }

  const authoredPages = await (await u.frame()).evaluate(() => {
    const collect = (rules) => Array.from(rules).flatMap((rule) => rule.type === CSSRule.PAGE_RULE ? [rule.cssText] : rule.cssRules ? collect(rule.cssRules) : []);
    return Array.from(document.styleSheets).flatMap((sheet) => collect(sheet.cssRules));
  });
  precondition(authoredPages.length === 1, "the authored document declares one non-default page geometry");
  assert.deepEqual(snap.pageRules, authoredPages, "printing preserves authored page rules and imposes no page geometry");

  ctx.step("the label is the stored label; the footer is the stored footer with {year} {date} {title} {version} {user} filled");
  const footer = expected.footer
    .split("{year}").join(snap.year)
    .split("{date}").join(snap.date)
    .split("{title}").join(title)
    .split("{version}").join("v1")
    .split("{user}").join(accounts[0].email.toLowerCase());
  assert.equal(snap.stamps[0].text, expected.label, "the label stamp");
  assert.ok(snap.stamps[0].text.length <= MAX_LABEL, "the label is at most 40 characters");
  assert.equal(snap.stamps[1].text, footer, "the footer stamp, placeholders filled");
  assert.doesNotMatch(snap.stamps[1].text, /\{(year|date|title|version|user)\}/, "no placeholder left");

  ctx.step("Cmd/Ctrl+P with the focus inside the document frame prints the same stamped, scrubbed snapshot");
  await (await u.frame()).locator("#p-2").click();
  const { frame: keyFrame, snap: key } = await printOnce(ctx, u, () => u.page.keyboard.press("ControlOrMeta+p"), "Cmd/Ctrl+P");
  assert.equal(keyFrame.sandbox, "allow-same-origin allow-modals", "the shortcut's print frame sandbox");
  assert.deepEqual(key.stamps.map((s) => [s.className, s.text]), snap.stamps.map((s) => [s.className, s.text]), "the shortcut stamps the same label and footer");
  assert.deepEqual(await activeContent(parser, key.html), { scripts: 0, handlers: [], jsUrls: [] }, "the shortcut's snapshot is scrubbed");
  assert.deepEqual(printDecor(await fingerprint(parser, key.html), fp1, { stamps: true }), [], "DECOR: the shortcut's snapshot");

  ctx.step("Cmd/Ctrl+P with focus on the app toolbar also prints one stamped, scrubbed snapshot");
  await u.page.getByRole("button", { name: "More actions", exact: true }).focus();
  precondition(await u.page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "More actions"), "the shortcut begins on the app toolbar, outside the document iframe");
  const { frame: appFrame, snap: appPrint } = await printOnce(ctx, u, () => u.page.keyboard.press("ControlOrMeta+p"), "the app-window print shortcut");
  assert.equal(appFrame.sandbox, "allow-same-origin allow-modals", "the app shortcut's print frame sandbox");
  assert.deepEqual(appPrint.stamps.map((s) => [s.className, s.text]), snap.stamps.map((s) => [s.className, s.text]), "the app shortcut stamps the same label and footer");
  assert.deepEqual(await activeContent(parser, appPrint.html), { scripts: 0, handlers: [], jsUrls: [] }, "the app shortcut's snapshot is scrubbed");
  assert.deepEqual(printDecor(await fingerprint(parser, appPrint.html), fp1, { stamps: true }), [], "DECOR: the app shortcut's snapshot");
  assert.deepEqual(appPrint.pageRules, authoredPages, "the app shortcut preserves authored page geometry");

  ctx.step("on a 400 px touch phone Print is not on the toolbar, which has no room for it, and More actions → Print or save as PDF prints the same stamped, scrubbed snapshot");
  const phone = await signedIn(ctx, accounts[0], "owner-phone", { device: { width: 400, height: 800, touch: true } });
  await openDoc(ctx, phone, docId);
  assert.equal(await phone.page.locator(".viewer-toolbar").getByRole("button", { name: "Print", exact: true }).count(), 0, "no Print button on a phone's toolbar");
  const { frame: phoneFrame, snap: phonePrint } = await printOnce(ctx, phone, "Print or save as PDF", "the phone's More-menu print");
  assert.equal(phoneFrame.sandbox, "allow-same-origin allow-modals", "the phone's print frame sandbox");
  assert.deepEqual(phonePrint.stamps.map((s) => [s.className, s.text]), snap.stamps.map((s) => [s.className, s.text]), "the phone's print stamps the same label and footer");
  assert.deepEqual(await activeContent(parser, phonePrint.html), { scripts: 0, handlers: [], jsUrls: [] }, "the phone's snapshot is scrubbed");

  ctx.step("marking off: POST /marking {enabled:false} stores off; after a reload the print has no stamp, and every scrub still holds");
  const off = await setMarking(ctx, owner, docId, { enabled: false, label: "KEEP", footer: "KEEP" });
  assert.deepEqual(off, MARKING_OFF, "a disabled marking is stored as off, its text dropped");
  // Reloaded for a fresh read of docs/{id}.marking; the highlight's DECOR was
  // the first print's, so this one does not wait for the annotations to load.
  await openDoc(ctx, u, docId);
  const offPrint = await printOnce(ctx, u, toolbarPrint(u), "the print with marking off");
  ctx.ev.text("print-snapshot-off.html", offPrint.snap.html);
  assert.deepEqual(offPrint.snap.stamps, [], "no stamp node with marking off");
  assert.equal(offPrint.frame.sandbox, "allow-same-origin allow-modals", "the sandbox does not depend on marking");
  assert.deepEqual(await activeContent(parser, offPrint.snap.html), { scripts: 0, handlers: [], jsUrls: [] }, "the scrubs do not depend on marking");
  const fpOff = await fingerprint(parser, offPrint.snap.html);
  assert.deepEqual(printDecor(fpOff, fp1, { stamps: false }), [], "DECOR with marking off");
  assert.deepEqual(foreignMarkers(fpOff), { whatever: 1 }, "the author's own data-bshd survives with marking off");
  noPageErrors([u, phone]);
});

// --- A17.1b -------------------------------------------------------------------------

/**
 * X-a17-export-4, class P. SPEC §20, docs/architecture/spec.md:2320-2322:
 * "Exports carry an optional marking, resolved at **publish/upload time**, not
 * at export time — otherwise a reader exporting would apply *their* default,
 * when the marking is the owner's policy." and :2331, the per-document layer
 * is "(authoritative at export)". DocViewer.tsx hands the print
 * `doc.meta?.marking ?? MARKING_OFF`, and a link holder has no doc.meta (a
 * non-member cannot read docs/{id}), so the reader's side, not the owner's
 * policy, decides: off.
 *
 * Only the last assertion is that defect's oracle. Every step before it is a
 * precondition, so a regression there FAILS the case instead of being booked
 * as X-a17-export-4: POST /marking storing the marking; the owner printing
 * this same document and getting both stamps (the positive control: the
 * marking is live on this document's print path for a member); and the link
 * holder's print frame being sandboxed and scrubbed, which SPEC §20 holds for
 * every print (spec.md:2346-2347, :2377-2379) and which is not this defect.
 */
scenario("A17.1b an anonymous holder of an unlisted document's link who prints it gets the owner's marking stamped, as a member does", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const title = `Link print ${t}`;
  const up = await publishDoc(ctx, owner.http, { body: probeDoc({ title }), filename: "index.html", title, name: "a171b-link" });
  precondition(up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)}`);
  const docId = up.docId;
  const marking = { enabled: true, label: `LINK ${t}`.slice(0, MAX_LABEL), footer: "{title} · {version}" };
  const stored = await setMarking(ctx, owner, docId, marking);
  precondition(isDeepStrictEqual(stored, marking), `POST /marking stores the owner's marking as sent: ${JSON.stringify(stored)}`);
  precondition(isDeepStrictEqual((await readDoc(target, `docs/${docId}`)).marking, marking), "docs/{id}.marking is the owner's marking");
  const stamped = [[MARK_CLASS, marking.label], [FOOTER_CLASS, `${title} · v1`]];

  ctx.step("positive control: the owner prints this same document from the More menu and gets both stamps");
  const o = await signedIn(ctx, accounts[0], "owner");
  await openDoc(ctx, o, docId);
  const ours = await printOnce(ctx, o, toolbarPrint(o), "the owner's print");
  const ownerStamps = ours.snap.stamps.map((s) => [s.className, s.text]);
  ctx.ev.json("owner-stamps", ours.snap.stamps);
  precondition(isDeepStrictEqual(ownerStamps, stamped), `the owner's print of this document carries the marking (the control): ${JSON.stringify(ownerStamps)}`);
  const k = await unlisted(ctx, owner, docId);

  ctx.step("an anonymous reader opens /d/<id>?k= and prints from the More menu");
  const anon = await ctx.users.user({ name: "link-holder" });
  await openDoc(ctx, anon, docId, { k });
  const theirs = await printOnce(ctx, anon, toolbarPrint(anon), "the link holder's print");
  ctx.ev.text("print-snapshot.html", theirs.snap.html);
  ctx.ev.json("link-holder-stamps", theirs.snap.stamps);
  precondition(theirs.frame.sandbox === "allow-same-origin allow-modals", `the link holder's print frame is sandboxed allow-same-origin allow-modals (SPEC §20, spec.md:2346-2347), not ${JSON.stringify(theirs.frame.sandbox)}`);
  const active = await activeContent(await ctx.users.parser(), theirs.snap.html);
  precondition(isDeepStrictEqual(active, { scripts: 0, handlers: [], jsUrls: [] }), `the link holder's snapshot is scrubbed (SPEC §20, spec.md:2377-2379): ${JSON.stringify(active)}`);

  ctx.step("X-a17-export-4's oracle: the owner's marking is authoritative at export, so the link holder's print carries the label and footer the owner's did");
  assert.deepEqual(theirs.snap.stamps.map((s) => [s.className, s.text]), stamped, "X-a17-export-4 (SPEC §20, spec.md:2320-2322 and :2331): the link holder's print carries the owner's marking, which is authoritative at export");
  const imageDialog = await openImageDialog(anon);
  const image = await exportPng(anon, imageDialog, "s-box", 2, 'id="s-box"');
  const { width, height } = image.size;
  const red = colourPixels(image.bytes, { color: LABEL_RGB, region: { x: Math.floor(width / 2), y: 0, w: width - Math.floor(width / 2), h: Math.floor(height * 0.3) } });
  assert.ok(red.count >= 20, "the anonymous reader's PNG carries the owner's label pixels");
  const vector = await exportSvgFile(anon, imageDialog, "Diagram one");
  assert.ok(vector.bytes.toString("utf8").includes(marking.label), "the anonymous reader's SVG carries the owner's label");
  await privateAgain(ctx, owner, docId);
});

scenario("A17.1c public readers receive the owner's changed marking and explicit off without private metadata", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const { owner } = await ownerSession(ctx);
  const t = tag();
  const up = await publishDoc(ctx, owner.http, { body: probeDoc({ title: `Public export ${t}` }), filename: "index.html", title: `Public export ${t}`, name: "a171c-public" });
  await setMarking(ctx, owner, up.docId, { enabled: true, label: "First policy", footer: "First footer" });
  await setVisibility(target, { owner, doc: up.docId, visibility: "public", timeoutMs: FN_MS, patient: patient(ctx) });
  const anon = await ctx.users.user({ name: "public-reader" });
  for (const marking of [{ enabled: true, label: `Changed ${t}`.slice(0, MAX_LABEL), footer: "Changed footer" }, MARKING_OFF]) {
    await setMarking(ctx, owner, up.docId, marking);
    const projection = await readDoc(target, `public/${up.docId}`);
    assert.deepEqual(projection.marking, marking, "the public mirror follows the owner's latest marking");
    for (const key of ["members", "ownerEmail", "stats", "defaultMarking", "storagePrefix"]) assert.ok(!(key in projection), `${key} is not public`);
    await openDoc(ctx, anon, up.docId);
    const printed = await printOnce(ctx, anon, toolbarPrint(anon), "the public reader's print");
    assert.deepEqual(printed.snap.stamps.map((stamp) => stamp.text), marking.enabled ? [marking.label, marking.footer] : [], "the public reader prints the changed policy, including off");
  }
  await privateAgain(ctx, owner, up.docId);
});

// --- A17.2 and A17.2b ------------------------------------------------------------------

const STAMP_TARGETS = ".bshd-print-mark, .bshd-print-footer, body > div, #canary";

/** Every vector SPEC §20 lists, plus colour, size and position, each !important, in screen and print media. */
const LISTED_HOSTILE = [
  "display: none", "visibility: hidden", "opacity: 0", "transform: scale(0)", "filter: opacity(0)",
  "clip: rect(0 0 0 0)", "clip-path: inset(50%)", "content-visibility: hidden", "max-height: 0", "max-width: 0",
  "overflow: hidden", "zoom: 0.01",
  "-webkit-text-fill-color: transparent", "-webkit-text-stroke: 4px #fff", "text-indent: -99999px",
  "text-shadow: 0 0 0 #fff", "letter-spacing: -1em", "word-spacing: -1em", "white-space: pre", "text-transform: lowercase",
  "color: transparent", "font-size: 0", "width: 0", "height: 0", "position: absolute", "top: -99999px", "left: -99999px",
].map((d) => `${d} !important;`).join(" ");

/**
 * Vectors SPEC §20 does not list (A17.2b), each live only at its own viewport
 * width under print media, so one real snapshot measures each alone; at the
 * A4 width none is live, which is A17.2's render. A real bundle would write
 * them unconditionally.
 */
const UNLISTED = Object.freeze([
  { vector: "rotate", width: 806, css: "rotate: x 90deg", prop: "rotate", expect: "x 90deg" },
  { vector: "scale", width: 801, css: "scale: 0", prop: "scale", expect: "0" },
  { vector: "translate", width: 802, css: "translate: -100000px -100000px", prop: "translate", expect: "-100000px -100000px" },
  { vector: "mask-image", width: 803, css: "-webkit-mask-image: linear-gradient(transparent, transparent); mask-image: linear-gradient(transparent, transparent)", prop: "mask-image", expect: "linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))" },
  { vector: "mix-blend-mode", width: 804, css: "mix-blend-mode: lighten", prop: "mix-blend-mode", expect: "lighten" },
  { vector: "offset-path", width: 805, css: "offset-path: path('M 100000 100000')", prop: "offset-path", expect: 'path("M 100000 100000")' },
]);

const HOSTILE_CSS = [
  `${STAMP_TARGETS} { ${LISTED_HOSTILE} }`,
  `@media print { html body ${STAMP_TARGETS.split(", ").join(", html body ")} { ${LISTED_HOSTILE} } }`,
  ...UNLISTED.map((v) => `@media print and (width: ${v.width}px) { ${STAMP_TARGETS} { ${v.css.split("; ").map((d) => `${d} !important`).join("; ")}; } }`),
].join("\n");

/** What A17.2 leaves for A17.2b: the snapshot print() received for the hostile document. */
const hostilePrint = { html: null, openMarks: [] };

async function hostileSnapshot(ctx) {
  if (hostilePrint.html) return hostilePrint.html;
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const title = `Hostile print ${t}`;
  // The canary is the author's one `body > div`: it proves the hostile rules are live in the render.
  const html = probeDoc({ title, hostile: HOSTILE_CSS }).replace('<main id="m">', '<div id="canary">canary</div>\n<main id="m">');
  const up = await publishDoc(ctx, owner.http, { body: html, filename: "index.html", title, name: "a172-hostile" });
  await setMarking(ctx, owner, up.docId, { enabled: true, label: SUGGESTED_LABEL, footer: `Footer of ${title} at {version}` });

  ctx.step("the owner prints it; the snapshot print() receives is captured");
  const u = await signedIn(ctx, accounts[0], "owner");
  await openDoc(ctx, u, up.docId);
  const { snap } = await printOnce(ctx, u, toolbarPrint(u), "the hostile document's print");
  ctx.ev.text("print-snapshot.html", snap.html);
  precondition(snap.html.includes('id="hostile"') && snap.stamps.length === 2, "the snapshot carries the hostile stylesheet and both stamps");
  hostilePrint.html = snap.html;
  hostilePrint.openMarks = snap.stamps.filter((s) => s.topLayer).map((s) => s.className);
  return snap.html;
}

scenario("A17.2 a document whose CSS sets every hiding vector SPEC §20 lists with !important on the stamps cannot hide them: under print media each locked property computes as with no author CSS, and the label and footer paint readable glyphs", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const snap = { html: await hostileSnapshot(ctx) };

  ctx.step("render that snapshot under print media at A4 width (pool.printRenderer); again with no author CSS, for reference; and once with the stamps really hidden, the pixel oracle's own control");
  const r = await ctx.users.printRenderer();
  try {
    const live = await renderStamps(r, snap.html, { probe: (page) => page.evaluate(() => getComputedStyle(document.getElementById("canary")).display) });
    const withoutCss = await (await ctx.users.parser()).evaluate((html) => { const d = new DOMParser().parseFromString(html, "text/html"); d.querySelectorAll('style, link[rel~="stylesheet"]').forEach((e) => e.remove()); return d.documentElement.outerHTML; }, snap.html);
    const ref = await renderStamps(r, withoutCss);
    const hidden = await renderStamps(r, snap.html, {
      probe: (page) => page.evaluate((sel) => document.querySelectorAll(sel).forEach((el) => el.style.setProperty("display", "none", "important")), STAMP_SELECTOR),
    });
    ctx.ev.json("render", { live: renderSummary(live), ref: ref.elements, hidden: renderSummary(hidden) });
    precondition(live.probed === "none", `the hostile rules are live in the render (the canary computes display ${live.probed})`);
    precondition(live.removed === 2 && ref.elements.length === 2, `the render and the reference each have both stamps (${live.removed}, ${ref.elements.length})`);
    precondition(hidden.pixels.label.count === 0 && hidden.pixels.footer.count === 0, `with the stamps display:none the pixel oracle counts nothing: ${JSON.stringify(hidden.pixels)}`);

    for (const [i, st] of live.elements.entries()) {
      const differs = LOCKED.filter((p) => st.computed[p] !== ref.elements[i].computed[p]).map((p) => `${p}: ${JSON.stringify(st.computed[p])} (no author CSS: ${JSON.stringify(ref.elements[i].computed[p])})`);
      assert.deepEqual(differs, [], `${st.className}: locked properties the hostile CSS changed`);
    }
    ctx.step(`pixels: ${JSON.stringify(live.pixels)}`);
    const seen = stampsVisible(live);
    assert.ok(seen.label, `the label paints readable glyphs in its own box, top right: ${JSON.stringify({ pixels: live.pixels.label, box: live.elements[0]?.rect })}`);
    assert.ok(seen.footer, `the footer paints readable glyphs in its own box, along the bottom: ${JSON.stringify({ pixels: live.pixels.footer, box: live.elements[1]?.rect })}`);
  } finally {
    await r.close();
  }
});

scenario("A17.2b independent transforms, masks, blending and motion paths cannot hide the stamps: with scale, translate, mask-image, mix-blend-mode or offset-path set !important on them, the label and footer still paint readable glyphs", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  await hostileSnapshot(ctx);
  const r = await ctx.users.printRenderer();
  try {
    ctx.step("positive control: at the A4 width no unlisted vector is live and both stamps paint readable glyphs");
    const base = await renderStamps(r, hostilePrint.html);
    const baseSeen = stampsVisible(base);
    precondition(baseSeen.label && baseSeen.footer, `the stamps are visible with no unlisted vector live: ${JSON.stringify({ pixels: base.pixels, boxes: base.elements.map((e) => e.rect) })}`);

    const results = {};
    for (const v of UNLISTED) {
      const out = await renderStamps(r, hostilePrint.html, { width: v.width, probe: (page) => page.evaluate((p) => getComputedStyle(document.getElementById("canary")).getPropertyValue(p), v.prop) });
      precondition(out.probed === v.expect, `${v.vector} is live at ${v.width}px (the canary computes ${v.prop}: ${JSON.stringify(out.probed)})`);
      const seen = stampsVisible(out);
      results[v.vector] = { label: out.pixels.label, footer: out.pixels.footer, boxes: out.elements.map((e) => [e.className, e.rect]), seen, hides: !seen.label || !seen.footer };
    }
    ctx.ev.json("vectors", results);
    ctx.step(`per vector: ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.hides ? "hidden" : "visible"])))}`);
    const hiding = Object.entries(results).filter(([, v]) => v.hides).map(([k]) => k);
    assert.deepEqual(hiding, [], `vectors that hide the stamp: ${hiding.join(", ")}`);
  } finally {
    await r.close();
  }
});

// Ancestor layout is separate from the stamp's own style cascade. Each rule
// offsets its containing block but compensates the authored content with padding.
const ANCESTOR_VECTORS = ["body", "html"].flatMap((ancestor, i) => [
  { ancestor, vector: "transform", css: "transform: translateZ(0)", property: "transform", expected: "matrix(1, 0, 0, 1, 0, 0)", width: 807 + i * 3 },
  { ancestor, vector: "filter", css: "filter: opacity(1)", property: "filter", expected: "opacity(1)", width: 808 + i * 3 },
  { ancestor, vector: "contain", css: "contain: paint", property: "contain", expected: "paint", width: 809 + i * 3 },
]);

scenario("A17.2c authored html and body containing blocks cannot move or clip the print stamps while the document's own content still paints", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const css = ANCESTOR_VECTORS.map((v) => `@media print and (width: ${v.width}px) { ${v.ancestor} { ${v.css}; position: relative; top: -10000px; padding-top: 10000px; } }`).join("\n");
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:white}#authored{width:220px;height:80px;background:rgb(0,128,0);color:white} ${css}</style></head><body><div id="authored">Authored content remains visible</div></body></html>`;
  const up = await publishDoc(ctx, owner.http, { body: html, filename: "index.html", title: `Ancestor print ${tag()}`, name: "a172c-ancestors" });
  await setMarking(ctx, owner, up.docId, { enabled: true, label: SUGGESTED_LABEL, footer: "Visible footer" });
  const u = await signedIn(ctx, accounts[0], "owner");
  await openDoc(ctx, u, up.docId);
  const { snap } = await printOnce(ctx, u, toolbarPrint(u), "the ancestor-layout document's print");
  const openMarks = snap.stamps.filter((s) => s.topLayer).map((s) => s.className);
  ctx.ev.text("ancestor-print.html", snap.html);
  ctx.ev.json("ancestor-print-state", { openMarks });
  const renderer = await ctx.users.printRenderer();
  const results = [];
  try {
    for (const v of ANCESTOR_VECTORS) {
      const out = await renderStamps(renderer, snap.html, { width: v.width, openMarks, probe: (page) => page.evaluate(({ ancestor, property }) => getComputedStyle(document.querySelector(ancestor)).getPropertyValue(property), v) });
      precondition(out.probed === v.expected, `${v.ancestor} ${v.vector} is active: ${out.probed}`);
      const content = colourPixels(out.basePng, { color: [0, 128, 0], tol: 0 });
      precondition(content.count > 1000, `${v.ancestor} ${v.vector} leaves authored content visible, rather than blanking the document: ${content.count} green pixels`);
      const visible = stampsVisible(out);
      results.push({ ancestor: v.ancestor, vector: v.vector, content, visible, stamps: renderSummary(out) });
      ctx.ev.json("ancestor-vectors", results);
      assert.deepEqual(visible, { label: true, footer: true }, `${v.ancestor} ${v.vector}: visible authored content must retain both page-fixed export stamps`);
    }
  } finally { await renderer.close(); }
});

// --- A17.3 and A17.3b ------------------------------------------------------------------

/** Record, in the app's own window, everything XMLSerializer serializes (html-to-image's foreignObject, exportSvg's file). */
async function armSerializerCapture(u) {
  await u.page.evaluate(() => {
    window.__e2eSerialized = [];
    if (window.__e2eSerializerHooked) return;
    window.__e2eSerializerHooked = true;
    const original = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = function serializeToString(node) {
      const out = original.call(this, node);
      try {
        window.__e2eSerialized.push(out);
      } catch {}
      return out;
    };
  });
}

/** The border box html-to-image measures (clientWidth/Height plus borders), read in the reading frame. */
async function borderBox(u, selector) {
  return (await u.frame()).locator(selector).evaluate((el) => {
    const cs = getComputedStyle(el);
    const px = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    return { width: el.clientWidth + px("border-left-width") + px("border-right-width"), height: el.clientHeight + px("border-top-width") + px("border-bottom-width") };
  });
}

/** The export dialog, open; `row(text)` is the list row whose first label is `text`. */
async function openImageDialog(u) {
  await u.chooseMenu("Export an image…");
  const dlg = u.page.getByRole("dialog", { name: "Export an image" });
  await dlg.waitFor({ state: "visible", timeout: 10_000 });
  const row = (text) => dlg.locator("li.activity-row").filter({ has: u.page.locator("span", { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).first();
  return { dlg, row };
}

/** What XMLSerializer produced since the arm, as strings; the last one containing `needle`. */
async function lastSerialized(u, needle) {
  const all = await u.page.evaluate(() => window.__e2eSerialized ?? []);
  const hits = all.filter((s) => s.includes(needle));
  return hits.length ? hits[hits.length - 1] : null;
}

/** One PNG export of the row `rowText` at `scale`: its bytes, size, and the foreignObject markup html-to-image rasterized. */
async function exportPng(u, dialog, rowText, scale, needle) {
  await dialog.dlg.locator("#export-scale").selectOption(String(scale));
  await armSerializerCapture(u);
  const file = await u.download(() => dialog.row(rowText).getByRole("button", { name: "PNG", exact: true }).click());
  return { ...file, size: pngSize(file.bytes), rasterized: await lastSerialized(u, needle) };
}

async function exportSvgFile(u, dialog, rowText) {
  await armSerializerCapture(u);
  return u.download(() => dialog.row(rowText).getByRole("button", { name: "SVG", exact: true }).click());
}

scenario("A17.3 Export an image: a section's PNG at 1×, 2× and 3× and a diagram's PNG are their border box × the scale, the SVG is the diagram plus the owner's label, the PNG carries the label's pixels, and DECOR is 0 on what was rasterized and on the SVG", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const title = `Image probe ${t}`;
  const html = probeDoc({ title })
    .replace('<p id="p-box">A passage in the box, exported as an image.</p>', '<p id="p-box">A passage in the box, exported as an image.</p><canvas id="authored-chart" width="20" height="20"></canvas>');
  const up = await publishDoc(ctx, owner.http, { body: html, filename: "index.html", title, name: "a173-image" });
  await coverStored(ctx, owner, up.docId);
  const label = `IMG ${t}`.slice(0, MAX_LABEL);
  await setMarking(ctx, owner, up.docId, { enabled: true, label, footer: "" });

  const u = await signedIn(ctx, accounts[0], "owner");
  await openDoc(ctx, u, up.docId);
  // An upload is untrusted, so its scripts intentionally cannot draw. Seed the
  // authored runtime canvas from the parent driver, then prove that the source
  // pixels exist before asking the product to export them.
  const sourcePixel = await (await u.frame()).locator("#authored-chart").evaluate((canvas) => {
    const chart = canvas.getContext("2d");
    chart.fillStyle = "#00ff00";
    chart.fillRect(0, 0, canvas.width, canvas.height);
    return Array.from(chart.getImageData(0, 0, 1, 1).data);
  });
  precondition(JSON.stringify(sourcePixel) === "[0,255,0,255]", "the authored source canvas is drawn before export");
  const box = await borderBox(u, "#s-box");
  const fig = await borderBox(u, "#fig");
  ctx.step(`border boxes in the frame: #s-box ${JSON.stringify(box)}, #fig ${JSON.stringify(fig)}`);
  precondition(box.width === 424 && box.height === 174 && fig.width === 240 && fig.height === 120, "the probe's fixed sizes hold in the frame");

  const dialog = await openImageDialog(u);
  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, html);
  for (const scale of [1, 2, 3]) {
    ctx.step(`#s-box as PNG at ${scale}×`);
    const png = await exportPng(u, dialog, "s-box", scale, 'id="s-box"');
    assert.deepEqual(png.size, { width: box.width * scale, height: box.height * scale }, `the section's PNG at ${scale}× is its border box × ${scale}`);
    assert.match(png.filename, /\.png$/);
    if (scale === 2) {
      precondition(png.rasterized, "html-to-image's foreignObject markup was captured");
      ctx.ev.text("rasterized-s-box.svg", png.rasterized);
      assert.deepEqual(decorations(await fingerprint(parser, png.rasterized), fp1), [], "DECOR: what the PNG rasterized");
      const chart = colourPixels(png.bytes, { color: [0, 255, 0], tol: 0 });
      assert.ok(chart.count >= 1000, "the clean PNG preserves authored canvas drawing pixels");
      const { width: w, height: h } = png.size;
      const red = colourPixels(png.bytes, { color: LABEL_RGB, region: { x: Math.floor(w / 2), y: 0, w: w - Math.floor(w / 2), h: Math.floor(h * 0.3) } });
      ctx.step(`label-coloured pixels in the PNG's top-right: ${JSON.stringify(red)}`);
      assert.ok(red.count >= 20, `the PNG carries the owner's label in its top-right corner (${red.count} label-coloured pixels)`);
    }
  }

  ctx.step("the diagram as PNG at 3×, then as SVG");
  const figPng = await exportPng(u, dialog, "Diagram one", 3, 'id="fig"');
  assert.deepEqual(figPng.size, { width: fig.width * 3, height: fig.height * 3 }, "the diagram's PNG at 3× is its box × 3");
  const svg = await exportSvgFile(u, dialog, "Diagram one");
  const svgText = svg.bytes.toString("utf8");
  ctx.ev.text("diagram.svg", svgText);
  assert.match(svg.filename, /\.svg$/);
  assert.ok(svgText.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg'), "a standalone SVG file");
  const parsed = await parser.evaluate((src) => {
    const d = new DOMParser().parseFromString(src, "image/svg+xml");
    const root = d.documentElement;
    const last = root.lastElementChild;
    return { error: d.querySelector("parsererror")?.textContent ?? null, root: root.localName, id: root.id, ns: root.namespaceURI, title: root.querySelector("title")?.textContent, figLabel: d.getElementById("fig-label")?.textContent, last: { tag: last.localName, text: last.textContent, fill: last.getAttribute("fill") } };
  }, svgText);
  assert.deepEqual(parsed, { error: null, root: "svg", id: "fig", ns: "http://www.w3.org/2000/svg", title: "Diagram one", figLabel: "Label in a figure", last: { tag: "text", text: label, fill: "#b02318" } }, "the SVG is the diagram as authored, the owner's label appended");
  assert.deepEqual(decorations(await fingerprint(parser, svgText), fp1), [], "DECOR: the SVG file");
  noPageErrors([u]);
});

const BOX_QUOTE = "passage in the box";
const FIG_QUOTE = "Label in a figure";

/** What A17.3b leaves for A17.3c: the markup html-to-image rasterized for the section's PNG, the reader's highlight live, and the v1 bytes it is judged against. */
const highlightedPng = { rasterized: null, html: null };

/**
 * X-a17-export-1, class P: the downloaded SVG FILE. SPEC §6,
 * docs/architecture/spec.md:650-651: "Wrapping is per-text-node, so existing
 * element nodes are never destroyed or re-parented. Highlights are
 * presentational and are NEVER persisted." exportSvg
 * (app/src/export/image.ts:152, :171) clones the live diagram, highlight and
 * all, and writes it out with XMLSerializer, so the file a reader downloads
 * persists the wrapper: <tspan class="bshd-hl" data-bshd-ann="<annotation
 * id>" data-selected="true" style="--bshd-author: …">. ADR 0007's
 * "Decoration must never reach the serialized output" (:43) says the same of
 * the editor's bytes. The app's own print export strips it (pdf.ts runs
 * serializeCleanHtml), and so does a preview, SPEC §6d, spec.md:938-940: "so
 * one reader's annotations never appear in a preview". (SPEC §20's "highlights
 * included", spec.md:2364-2365, is the browser's File → Print, a path the app
 * cannot reach, not this export.) Harm: a reader's annotation id and the
 * app's own markup travel in a file pasted into slides or sent on, and what
 * the file holds depends on who exported it and which thread was selected.
 *
 * The PNG half is A17.3c: no SPEC sentence covers a picture's pixels.
 */
let highlightedExport;
async function captureHighlightedExport(ctx) {
  highlightedExport ??= (async () => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const title = `Highlighted export ${t}`;
  const html = probeDoc({ title });
  const up = await publishDoc(ctx, owner.http, { body: html, filename: "index.html", title, name: "a173b-hl" });
  await coverStored(ctx, owner, up.docId);
  await quietDoc(target, up.docId);

  ctx.step("the owner comments on a passage in #s-box and on the diagram's label");
  const u = await signedIn(ctx, accounts[0], "owner");
  await openDoc(ctx, u, up.docId);
  await commentOn(u, "#p-box", BOX_QUOTE, `Box comment ${t}`);
  await waitHighlights(u, "#s-box mark.bshd-hl");
  // The first thread is still selected: User.comment puts the text into the thread its own press makes.
  await commentOn(u, "#fig-label", FIG_QUOTE, `Figure comment ${t}`);
  await waitHighlights(u, "#fig tspan.bshd-hl");
  await waitHighlights(u, "#s-box mark.bshd-hl");

  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, html);
  const dialog = await openImageDialog(u);
  ctx.step("the section as PNG at 2× (left for A17.3c), then the diagram as an SVG file");
  const png = await exportPng(u, dialog, "s-box", 2, 'id="s-box"');
  precondition(png.rasterized, "html-to-image's foreignObject markup was captured");
  ctx.ev.text("rasterized-s-box.svg", png.rasterized);
  highlightedPng.rasterized = png.rasterized;
  highlightedPng.html = html;
  const svg = await exportSvgFile(u, dialog, "Diagram one");
  const svgText = svg.bytes.toString("utf8");
  ctx.ev.text("diagram.svg", svgText);
  // A file that is not the diagram (empty, unparsable) would show no decoration for the wrong reason.
  const shape = await parser.evaluate((src) => {
    const d = new DOMParser().parseFromString(src, "image/svg+xml");
    return { error: d.querySelector("parsererror")?.textContent ?? null, root: d.documentElement.localName, id: d.documentElement.id, label: d.getElementById("fig-label")?.textContent ?? null };
  }, svgText);
  precondition(isDeepStrictEqual(shape, { error: null, root: "svg", id: "fig", label: FIG_QUOTE }), `the SVG file is the diagram: ${JSON.stringify(shape)}`);

  const found = {
    svg: decorations(await fingerprint(parser, svgText), fp1),
    png: decorations(await fingerprint(parser, png.rasterized), fp1), // A17.3c's, recorded here too
  };
  ctx.ev.json("decorations", found);
  ctx.step(`decoration found: ${JSON.stringify(found)}`);
  return { found, html, png, svgText };
  })();
  return highlightedExport;
}

scenario("A17.3b the diagram's SVG file, exported while the reader's comment is highlighted on its label, carries no highlight wrapper or annotation id (DECOR 0 on the file)", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 600_000 }, async (ctx) => {
  const { found } = await captureHighlightedExport(ctx);
  assert.deepEqual(found.svg, [], "the downloaded SVG contains no reader decoration");
});

/** A PNG is an authored-content export, so the reader's transient highlights do not become pixels (SPEC §20). */
scenario("A17.3c the section's PNG, exported while the reader's comment is highlighted in it, is drawn from markup without the highlight (DECOR 0 on what html-to-image rasterized)", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 600_000 }, async (ctx) => {
  await captureHighlightedExport(ctx);
  const parser = await ctx.users.parser();
  const found = decorations(await fingerprint(parser, highlightedPng.rasterized), await fingerprint(parser, highlightedPng.html));
  ctx.ev.json("decorations", found);
  ctx.step(`decoration in what the PNG was drawn from: ${JSON.stringify(found)}`);
  assert.deepEqual(found, [], "the PNG is drawn from clean markup without reader highlights (SPEC §20)");
});

// --- A17.4 and A17.4b ------------------------------------------------------------------

/**
 * How long a menu is read for an entry that follows the version record: a
 * member's menu (whose read is allowed) up to MEMBER_MENU_MS, for it is a wait
 * on a load measured at over 10 s on a busy stack; an anonymous link holder's,
 * whose read A17.4b shows the rules refuse, LINK_MENU_SETTLE_MS.
 */
const MEMBER_MENU_MS = 60_000;
const LINK_MENU_SETTLE_MS = 60_000;

/** What a member is offered for a Markdown document (one version, two files): A17.4 asserts it, A17.4b expects it. */
const MD_DOWNLOADS = Object.freeze(["Download the rendered HTML", "Download the Markdown source", "Download everything as a .zip"]);

/**
 * The download entries of the More menu's "Download" group (which also holds
 * Print and Export an image), read until they include `entry` or `timeout`
 * passes; a reading at the deadline is the last one.
 */
async function downloadsOffered(u, entry, { timeout = LINK_MENU_SETTLE_MS } = {}) {
  const t0 = Date.now();
  for (;;) {
    const labels = ((await u.menuGroup("Download")) ?? []).filter((l) => l.startsWith("Download "));
    const ms = Date.now() - t0;
    if (labels.includes(entry)) return { offered: true, labels, ms };
    if (ms >= timeout) return { offered: false, labels, ms };
    await u.page.waitForTimeout(500); // a poll interval, not a settle: the loop ends on the condition or the deadline
  }
}

/**
 * A member's download entries once they include `entry`: a wait on the
 * version record the viewer reads after the frame (DocViewer.tsx
 * doc.version), whose read the rules allow a member. One that runs out
 * throws as a wait, "… within <ms> ms", which lib judges as any wait: the
 * case's failure, unless this page saw the stack stall in it.
 */
async function memberDownloads(u, entry) {
  const r = await downloadsOffered(u, entry, { timeout: MEMBER_MENU_MS });
  if (!r.offered) throw new Error(`${u.name}'s More menu did not offer "${entry}" within ${MEMBER_MENU_MS} ms (its download entries: ${JSON.stringify(r.labels)})`);
  return r;
}

const BUNDLE_CSS = "body { font-family: Georgia, serif; } .pic { width: 64px; }\n";
const BUNDLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#36c"/></svg>\n';
function bundleHtml(title) {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<h1>${esc(title)}</h1>\n<p>A bundle of three files.</p>\n<img class="pic" src="pic.svg" alt="a blue box">\n</body>\n</html>\n`;
}
const SMALL_MD = "# Download probe\n\nA paragraph with **bold** and a [link](https://example.com/).\n\n- one\n- two\n";

/** The version's files as GET /download serves them to `http`. */
async function stored(http, docId, versionId = "v1") {
  const r = await http.get(`/download/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}`, { expect: 200 });
  return { zip: r.buffer, files: zipFiles(r.buffer) };
}

const fileMap = (files) => Object.fromEntries(files.map((f) => [f.rel, sha(f.data)]).sort(([a], [b]) => a.localeCompare(b)));

scenario("A17.4 downloads: the HTML is the entry's bytes named from the title, the bundle's .zip passes REHASH and holds the uploaded files, a Markdown document's source is index.md and its rendered HTML the stored entry; an anonymous link holder gets the same HTML through ~k and the same zip through ?k=, and without the key both are 404", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 720_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const title = `Download bundle ${t}`;
  const entries = { "index.html": bundleHtml(title), "style.css": BUNDLE_CSS, "pic.svg": BUNDLE_SVG };
  const up = await publishDoc(ctx, owner.http, { body: await zipBundle(entries, target), filename: "bundle.zip", title, name: "a174-bundle" });
  precondition(up.versionId === "v1" && up.json?.fileCount === 3, `the bundle published as 3 files: ${JSON.stringify(up.json)}`);
  const mdTitle = `Download markdown ${t}`;
  const md = await publishDoc(ctx, owner.http, { body: SMALL_MD, filename: "notes.md", title: mdTitle, name: "a174-md" });
  precondition(md.versionId === "v1", `the Markdown document published: ${JSON.stringify(md.json)}`);
  const record = await readDoc(target, `docs/${up.docId}/versions/v1`);

  const u = await signedIn(ctx, accounts[0], "owner");
  ctx.step("the bundle: Download the HTML, then Download everything as a .zip");
  await openDoc(ctx, u, up.docId);
  const h = await u.download("Download the HTML");
  assert.equal(h.filename, `${safeFilename(title)}.html`, "named from the title");
  assert.equal(sha(h.bytes), sha(Buffer.from(entries["index.html"])), "the HTML download is the entry's uploaded bytes");
  await memberDownloads(u, "Download everything as a .zip");
  const z = await u.download("Download everything as a .zip");
  const rz = await rehashZip(z.bytes, { target });
  assert.equal(rz.contentHash, record.contentHash, "REHASH: the zip hashes to the version's contentHash");
  assert.deepEqual(fileMap(zipFiles(z.bytes)), fileMap(Object.entries(entries).map(([rel, data]) => ({ rel, data: Buffer.from(data) }))), "the zip holds exactly the uploaded files, byte for byte");

  ctx.step("the Markdown document: its source is index.md as uploaded, its rendered HTML the stored entry");
  await openDoc(ctx, u, md.docId);
  const mdMenu = await memberDownloads(u, "Download the Markdown source");
  ctx.step(`the owner's menu offered the Markdown source after ${mdMenu.ms} ms`);
  assert.deepEqual(mdMenu.labels, [...MD_DOWNLOADS], "a member is offered the rendered HTML, the Markdown source and the zip");
  const src = await u.download("Download the Markdown source");
  assert.equal(src.filename, `${safeFilename(mdTitle)}.md`);
  assert.equal(src.bytes.toString("utf8"), SMALL_MD, "the Markdown source is index.md, byte for byte");
  const mdFiles = (await stored(owner.http, md.docId)).files;
  const rendered = await u.download("Download the rendered HTML");
  assert.equal(rendered.filename, `${safeFilename(mdTitle)}.html`);
  assert.equal(rendered.bytes.toString("utf8"), entryHtml(mdFiles), "the rendered HTML is the stored index.html");
  const mdZip = await u.download("Download everything as a .zip");
  assert.equal((await rehashZip(mdZip.bytes, { target })).contentHash, (await readDoc(target, `docs/${md.docId}/versions/v1`)).contentHash, "REHASH: the Markdown document's zip");

  const k = await unlisted(ctx, owner, up.docId);
  ctx.step("an anonymous link holder: Download the HTML from the menu, and GET /download?k=");
  const anon = await ctx.users.user({ name: "link-holder" });
  await openDoc(ctx, anon, up.docId, { k });
  const ah = await anon.download("Download the HTML");
  assert.equal(sha(ah.bytes), sha(Buffer.from(entries["index.html"])), "the link holder's HTML download is the entry's bytes");
  const viaKey = anon.log.requests.find((r) => /\/content\/~[^/]+\//.test(r.url) && r.url.endsWith("/index.html") && r.status === 200);
  assert.ok(viaKey, "the link holder's download went through /content/~<k>/");
  // Hosting's cut-off 504 throws (the stack not answering); any other status is the product's, judged below.
  const http = createHttp(target, { actor: "link-holder", timeoutMs: FN_MS, cutoffError: true });
  const withK = await http.get(`/download/${encodeURIComponent(up.docId)}/v1`, { query: { k } });
  assert.equal(withK.status, 200, "GET /download?k= is 200 for a link holder");
  assert.equal((await rehashZip(withK.buffer, { target })).contentHash, record.contentHash, "REHASH: the zip a link holder gets");
  const noK = await http.get(`/download/${encodeURIComponent(up.docId)}/v1`);
  const wrongK = await http.get(`/download/${encodeURIComponent(up.docId)}/v1`, { query: { k: `${k.slice(0, -2)}${k.endsWith("xx") ? "yy" : "xx"}` } });
  const noContent = await http.get(`/content/${encodeURIComponent(up.docId)}/v1/index.html`);
  assert.deepEqual([noK.status, wrongK.status, noContent.status], [404, 404, 404], "without the key, or with a wrong one, the zip and the entry are 404");
  await privateAgain(ctx, owner, up.docId);
  noPageErrors([u]);
});

/** Download metadata is safe in the reader projection; the full version record remains private (SPEC §17). */
scenario("A17.4b an anonymous holder of an unlisted link is offered the Markdown source and the .zip in the More menu, as a member is", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const md = await publishDoc(ctx, owner.http, { body: SMALL_MD, filename: "notes.md", title: `Link menu ${t}`, name: "a174b-md" });
  const v1 = await readDoc(target, `docs/${md.docId}/versions/v1`);
  precondition(v1?.fileCount === 2 && v1?.sourceEntry === "index.md", `a two-file Markdown version: ${JSON.stringify({ fileCount: v1?.fileCount, sourceEntry: v1?.sourceEntry })}`);
  const k = await unlisted(ctx, owner, md.docId);

  // The entries follow the version record (DocViewer.tsx: doc.version), which
  // the viewer reads from Firestore after the frame has loaded. Whether an
  // anonymous reader can EVER have it is the rules' answer, read here first,
  // so a slow stack cannot pass for the defect.
  ctx.step("the version record under the rules: the owner may read it; an anonymous client may not");
  const fsOwner = clientFirestore(target, { idToken: () => idToken(target, accounts[0]), http: ctx.http({ actor: "owner-fs" }) });
  const fsAnon = clientFirestore(target, { idToken: null, http: ctx.http({ actor: "anonymous-fs" }) });
  const reads = { owner: (await fsOwner.get(`docs/${md.docId}/versions/v1`)).verdict, anonymous: (await fsAnon.get(`docs/${md.docId}/versions/v1`)).verdict };
  ctx.ev.json("version-reads", reads);
  ctx.step(`version record reads: ${JSON.stringify(reads)}`);
  precondition(reads.owner === "ALLOW", `the owner reads the version record: ${JSON.stringify(reads)}`);
  assert.equal(reads.anonymous, "DENY", "download choices do not expose the private version record");

  ctx.step(`the anonymous link holder's More menu, read for up to ${LINK_MENU_SETTLE_MS} ms`);
  const anon = await ctx.users.user({ name: "link-holder" });
  await openDoc(ctx, anon, md.docId, { k });
  const offered = await memberDownloads(anon, "Download the Markdown source");
  ctx.ev.json("menu", offered);
  assert.deepEqual(offered.labels, [...MD_DOWNLOADS], "the link holder is offered the Markdown source and bundle permitted by the content and download endpoints");
  await privateAgain(ctx, owner, md.docId);
});

// --- A17.5 and A17.5b ------------------------------------------------------------------

scenario("A17.5 marking is the owner's alone: POST /marking is 200 for the owner, 403 for an editor, 404 for a stranger and 401 anonymous, refusals change nothing; only the owner's menu offers Marking on exports, whose dialog stores what it shows; no client writes docs/{id}.marking; the Account default seeds the Upload dialog and the uploaded document", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 900_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx, ["editor", "stranger"]);
  const [, editorAcct, strangerAcct] = accounts;
  const t = tag();
  const title = `Marking owner ${t}`;
  const up = await publishDoc(ctx, owner.http, { body: probeDoc({ title }), filename: "index.html", title, name: "a175-owner" });
  const docId = up.docId;
  // Granting the same role again is harmless, so a POST /access the stack did not answer is simply sent again.
  await untilLanded(ctx, "POST /access", () => share(target, { owner, doc: docId, account: editorAcct, role: "editor", timeoutMs: FN_MS }), null, patience(ctx));

  ctx.step("POST /marking from each actor; the record is unchanged after every refusal");
  const want = { enabled: true, label: `OWNER ${t}`.slice(0, MAX_LABEL), footer: "Owner footer {version}" };
  // 200 (or, when Hosting cut it off, the record changed to it), else the precondition fails the case.
  const okOwner = await ownerMarking(ctx, owner, docId, want);
  assert.deepEqual(okOwner.marking, want, `the owner sets it (${okOwner.status === 200 ? "answered 200" : "Hosting cut it off; the record took it"})`);
  const [ed, st] = [await sessionFor(ctx, editorAcct), await sessionFor(ctx, strangerAcct)];
  const hostile = { enabled: true, label: "NOT YOURS", footer: "" };
  const statuses = {
    editor: (await postMarking(ctx, ed.http, docId, hostile)).status,
    stranger: (await postMarking(ctx, st.http, docId, hostile)).status,
    anonymous: (await postMarking(ctx, createHttp(target, { actor: "anonymous" }), docId, hostile)).status,
    editorOff: (await postMarking(ctx, ed.http, docId, { enabled: false })).status,
  };
  assert.deepEqual(statuses, { editor: 403, stranger: 404, anonymous: 401, editorOff: 403 }, "POST /marking refusals");
  assert.deepEqual((await readDoc(target, `docs/${docId}`)).marking, want, "no refusal changed the marking");

  ctx.step("rules: no client writes docs/{id}.marking, owner included; each writes their own users/{uid}.defaultMarking; nobody else's");
  const fsOwner = clientFirestore(target, { idToken: () => idToken(target, accounts[0]), http: ctx.http({ actor: "owner-fs" }) });
  const fsEditor = clientFirestore(target, { idToken: () => idToken(target, editorAcct), http: ctx.http({ actor: "editor-fs" }) });
  // A caller with no token, or one the rules read as unverified, is DENIED
  // everything, docs/{id}.marking included, so a DENY says nothing until the
  // same client, through the same update, is ALLOWED on its own account
  // record (firestore.rules users/{uid}: self-only update). Each client's
  // own-default ALLOW is what makes its DENY on the document the rules'.
  const rules = {
    ownerDoc: (await fsOwner.update(`docs/${docId}`, { marking: hostile })).verdict,
    editorDoc: (await fsEditor.update(`docs/${docId}`, { marking: hostile })).verdict,
    ownerDefault: (await fsOwner.update(`users/${accounts[0].uid}`, { defaultMarking: MARKING_OFF })).verdict,
    editorOwnDefault: (await fsEditor.update(`users/${editorAcct.uid}`, { defaultMarking: MARKING_OFF })).verdict,
    editorOnOwnersDefault: (await fsEditor.update(`users/${accounts[0].uid}`, { defaultMarking: hostile })).verdict,
  };
  assert.deepEqual(rules, { ownerDoc: "DENY", editorDoc: "DENY", ownerDefault: "ALLOW", editorOwnDefault: "ALLOW", editorOnOwnersDefault: "DENY" }, "Firestore rules on the two marking layers");
  assert.deepEqual((await readDoc(target, `docs/${docId}`)).marking, want, "the rules refusals changed nothing");

  ctx.step("menus: the owner's has Marking on exports…, the editor's does not, once each has the document's record (Activity shows)");
  const [o, e] = await Promise.all([signedIn(ctx, accounts[0], "owner"), signedIn(ctx, editorAcct, "editor")]);
  await Promise.all([openDoc(ctx, o, docId), openDoc(ctx, e, docId)]);
  // DocViewer.tsx lists "This document"'s Activity, and the owner's Share…,
  // Marking… and Forks…, only once doc.meta has arrived: a menu read before it
  // would show the editor no marking entry for the wrong reason.
  const menuWithRecord = (u) => eventually(async () => {
    const { labels } = await u.moreMenu();
    if (!labels.includes("Activity")) throw new Error(`${u.name}'s menu has no record yet: ${JSON.stringify(labels)}`);
    return labels;
  }, { timeout: 60_000, interval: 1_000, message: "the menu shows the document's record" });
  const [oMenu, eMenu] = [await menuWithRecord(o), await menuWithRecord(e)];
  assert.ok(oMenu.includes("Marking on exports…"), `the owner's menu: ${JSON.stringify(oMenu)}`);
  assert.ok(!eMenu.some((l) => /marking/i.test(l)), `the editor's menu has no marking entry: ${JSON.stringify(eMenu)}`);

  ctx.step("the owner's dialog shows the stored marking; a new label and footer saved there are what is stored");
  await o.chooseMenu("Marking on exports…");
  const dlg = o.page.getByRole("dialog", { name: "Marking on exports" });
  await dlg.waitFor({ state: "visible", timeout: 10_000 });
  assert.deepEqual({ enabled: await dlg.locator("#marking-enabled").isChecked(), label: await dlg.locator("#marking-label").inputValue(), footer: await dlg.locator("#marking-footer").inputValue() }, want, "the dialog shows the stored marking");
  const next = { enabled: true, label: `DIALOG ${t}`.slice(0, MAX_LABEL), footer: "Dialog footer {title}" };
  await dlg.locator("#marking-label").fill(next.label);
  await dlg.locator("#marking-footer").fill(next.footer);
  const saveMark = o.responseMark();
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  const answer = await o.waitForResponse({ method: "POST", path: "/marking" }, { since: saveMark, timeout: SLOW.timeout });
  if (isHostingCutoff(answer)) {
    // Hosting gave up after its minute; the function may still store it. The
    // dialog stays open on the error, so it is closed here once the record is read.
    ctx.step(`environment: the dialog's POST /marking got Hosting's cut-off 504 after ${answer.ms} ms; reading the record for what the function stores`);
    const stored = await eventually(async () => {
      const m = (await readDoc(target, `docs/${docId}`))?.marking;
      if (!isDeepStrictEqual(m, next)) throw new Error(`marking ${JSON.stringify(m)}`);
      return m;
    }, { timeout: 60_000, interval: 2_000, message: "the dialog's marking reaches the record" }).catch(() => null);
    if (!stored) throw stackCutoff("the Marking dialog's POST /marking (the record never took it)", answer);
    await dlg.getByRole("button", { name: "Cancel" }).click();
  } else {
    assert.equal(answer.status, 200, "the dialog's POST /marking");
  }
  await dlg.waitFor({ state: "detached", timeout: 10_000 });
  assert.deepEqual((await readDoc(target, `docs/${docId}`)).marking, next, "the dialog stored exactly what it showed");

  ctx.step("the Account page: Stamp new documents by default stores the suggested marking on users/{uid}");
  await o.goto("/account");
  const box = o.page.locator("#default-marking");
  await o.waitShown(box, { what: "the Account page's default-marking box", path: "/account", timeout: PAGE_MS });
  assert.equal(await box.isChecked(), false, "no default yet");
  await box.check();
  const seeded = { enabled: true, label: SUGGESTED_LABEL, footer: SUGGESTED_FOOTER };
  await eventually(async () => {
    const u = await readDoc(target, `users/${accounts[0].uid}`);
    if (!isDeepStrictEqual(u?.defaultMarking, seeded)) throw new Error(`defaultMarking ${JSON.stringify(u?.defaultMarking)}`);
    return true;
  }, { timeout: 60_000, message: "users/{uid}.defaultMarking is the suggested marking" });

  ctx.step("the workspace's Upload dialog starts with Stamp exports checked, and the uploaded document carries the default");
  await o.goto("/");
  await o.waitShown(workspaceCard(o, docId), { what: `the workspace's card of ${docId}`, path: "/", timeout: PAGE_MS });
  // The dialog seeds its box once, at mount, from the account record the
  // workspace listens to, and nothing on the page says when that record has
  // arrived (an early open stays unchecked: X-a17-export-6, A17.5c). So the
  // box is read on a dialog opened after the workspace's own data, and opened
  // again while it is not yet checked.
  const up2 = o.page.getByRole("dialog", { name: "Upload a document" });
  const seededOpen = await eventually(async () => {
    if (await up2.isVisible()) {
      await up2.getByRole("button", { name: "Cancel" }).click();
      await up2.waitFor({ state: "detached", timeout: 10_000 });
    }
    await o.page.locator(".workspace-toolbar").getByRole("button", { name: "Upload", exact: true }).click();
    await up2.waitFor({ state: "visible", timeout: 10_000 });
    if (!(await up2.locator("#upload-marking").isChecked())) throw new Error("the dialog's marking box is unchecked");
    return true;
  }, { timeout: 60_000, interval: 1_000, message: "the Upload dialog's marking box is seeded from the default" });
  assert.equal(seededOpen, true);
  await up2.locator('input[type="file"]').setInputFiles({ name: "seeded.html", mimeType: "text/html", buffer: Buffer.from(probeDoc({ title: `Seeded ${t}` })) });
  await up2.locator(".upload-dropzone strong", { hasText: "seeded.html" }).waitFor({ timeout: 10_000 });
  assert.equal(await up2.locator("#upload-marking").isChecked(), true, "the dialog's marking box is seeded from the default");
  const seededId = docIdFor(target, "a175-seeded");
  await up2.locator("#upload-id").fill(seededId);
  const pubMark = o.responseMark();
  await up2.getByRole("button", { name: "Upload", exact: true }).click();
  const pr = await o.waitForResponse({ method: "POST", path: "/publish" }, { since: pubMark, timeout: SLOW.timeout });
  const pj = await pr.response.json().catch(() => null);
  if (pj?.docId) ledgerDoc(target, { docId: pj.docId, via: "upload-ui", ownerEmail: accounts[0].email, actor: "owner" });
  let madeId = pj?.docId;
  if (isHostingCutoff(pr)) {
    // Hosting gave up after its minute; the function may still make the document, under the id the dialog named.
    ledgerDoc(target, { docId: seededId, via: "upload-ui", ownerEmail: accounts[0].email, actor: "owner" });
    ctx.step(`environment: the dialog's POST /publish got Hosting's cut-off 504 after ${pr.ms} ms; looking for ${seededId}`);
    const made = await eventually(async () => {
      const d = await readDoc(target, `docs/${seededId}`);
      if (!d?.currentVersion) throw new Error(`docs/${seededId} not there`);
      return d;
    }, { timeout: 60_000, interval: 2_000, message: "the dialog's upload reaches Firestore" }).catch(() => null);
    if (!made) throw stackCutoff("the Upload dialog's POST /publish (no document was made)", pr);
    madeId = seededId;
  } else {
    assert.equal(pr.status, 200, `the dialog's POST /publish: ${JSON.stringify(pj)}`);
  }
  assert.deepEqual((await readDoc(target, `docs/${madeId}`)).marking, seeded, "the uploaded document's marking is the account default");
  noPageErrors([o, e]);
});

scenario("A17.5b the account default seeds a document its owner publishes through MCP publish_document or bikeshed publish, as for any new document", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const seeded = { enabled: true, label: `DEFAULT ${t}`.slice(0, MAX_LABEL), footer: "Default footer {version}" };
  const fs = clientFirestore(target, { idToken: () => idToken(target, accounts[0]), http: ctx.http({ actor: "owner-fs" }) });
  const w = await fs.update(`users/${accounts[0].uid}`, { defaultMarking: seeded });
  precondition(w.verdict === "ALLOW", `the owner's own client sets users/{uid}.defaultMarking (${w.status} ${w.message ?? ""})`);

  ctx.step("control: an upload that names the default (as the Upload dialog seeds it) is marked");
  const viaUpload = await publishDoc(ctx, owner.http, { body: probeDoc({ title: `Upload ${t}` }), filename: "index.html", title: `Upload ${t}`, name: "a175b-upload", marking: seeded });
  precondition(isDeepStrictEqual((await readDoc(target, `docs/${viaUpload.docId}`)).marking, seeded), "an upload naming the marking stores it");

  ctx.step("MCP publish_document and bikeshed publish, each with the owner's token");
  // A token minted twice (a POST /tokens the stack did not answer, sent again) is harmless: the account is this case's alone.
  const token = (channel) => untilLanded(ctx, `POST /tokens (${channel})`, () => mintToken(owner, { name: `e2e a17 ${channel} ${t}`, channel }), null, patience(ctx)).then((r) => r.out.token);
  const mcp = ctx.mcp({ token: await token("mcp"), actor: "owner-mcp", timeoutMs: FN_MS });
  await untilLanded(ctx, "MCP initialize", () => mcp.initialize(), null, patience(ctx));
  const viaMcp = await publishMcp(mcp, { title: `Agent ${t}`, content: probeDoc({ title: `Agent ${t}` }), id: docIdFor(target, "a175b-mcp"), patient: patient(ctx) });
  const mcpDoc = viaMcp.docId;
  precondition(!viaMcp.isError && mcpDoc, `publish_document: ${viaMcp.text}`);
  ledgerDoc(target, { docId: mcpDoc, via: "mcp", ownerEmail: accounts[0].email, actor: "owner-mcp" }); // with its owner: twice is harmless

  const cliToken = await token("cli");
  const home = cliHome(target);
  writeFileSync(join(home.home, "page.html"), probeDoc({ title: `Terminal ${t}` }));
  const cliId = docIdFor(target, "a175b-cli");
  const ledgerCli = (docId) => ledgerDoc(target, { docId, via: "cli", ownerEmail: accounts[0].email, actor: "owner-cli" });
  // The CLI names its id, so a run the stack cut off ("error: Upload failed
  // (504)." after Hosting's minute: runCli's `cut`) is looked for in the
  // record before it is run again; a document it made after all is taken.
  const viaCli = await untilLanded(ctx, `bikeshed publish ${cliId}`, () => runCli(target, ["publish", "page.html", "--title", `Terminal ${t}`, "--id", cliId, "--json"], { token: cliToken, home, timeoutMs: FN_MS }), async () => {
    const d = await readDoc(target, `docs/${cliId}`);
    return d?.currentVersion ? cliId : null;
  }, { ...patience(ctx), onFail: () => ledgerCli(cliId) });
  const r = viaCli.out;
  if (r?.json?.docId) ledgerCli(r.json.docId);
  if (r) precondition(r.code === 0 && r.json?.docId, `bikeshed publish: exit ${r.code} ${r.stderr.slice(0, 300)}`);
  const cliDoc = r ? r.json.docId : viaCli.landed;

  const markings = {
    mcp: (await readDoc(target, `docs/${mcpDoc}`)).marking,
    cli: (await readDoc(target, `docs/${cliDoc}`)).marking,
  };
  ctx.ev.json("markings", markings);
  assert.deepEqual(markings, { mcp: seeded, cli: seeded }, "documents the owner's agent and CLI publish carry the owner's default marking");
});

/**
 * The open Upload dialog as the page has it, read in the page from the
 * dialog's Stamp exports box (`box`, #upload-marking): whether the box is
 * checked, and the account default the workspace has handed the dialog so
 * far, the `accountDefaultMarking` prop of UploadDialog (DocList.tsx), read
 * from React's committed tree (the HostRoot's `current`, so never a stale
 * alternate). That prop is the workspace's copy of users/{uid}.defaultMarking,
 * MARKING_OFF until its account listener (watchUser) delivers, and a listener
 * apart from the one the workspace's cards come from: it is the one place the
 * record reaching the dialog shows, for nothing on the page shows it.
 * `found` is false when no component in the tree has the prop (React's
 * internals moved, or the prop was renamed): the measurement is then blind.
 * Sent as source: it uses nothing but its argument.
 */
function uploadDialogState(box) {
  const key = Object.keys(box).find((k) => k.startsWith("__reactFiber$"));
  let f = key ? box[key] : null;
  while (f && f.tag !== 3) f = f.return; // 3: HostRoot
  const todo = f?.stateNode?.current ? [f.stateNode.current] : [];
  while (todo.length > 0) {
    const n = todo.pop();
    const p = n.memoizedProps;
    if (p && typeof p === "object" && Object.prototype.hasOwnProperty.call(p, "accountDefaultMarking")) {
      return { checked: box.checked, found: true, handed: p.accountDefaultMarking ?? null };
    }
    if (n.sibling) todo.push(n.sibling);
    if (n.child) todo.push(n.child);
  }
  return { checked: box.checked, found: false, handed: null };
}

/** How long after the workspace's card the account record may take to reach the open dialog: its own listener, on a loaded stack. */
const HANDOFF_MS = 60_000;
/** How long a dialog handed the default has to show it: one render, given ample room on a loaded browser. */
const APPLY_GRACE_MS = 10_000;

/**
 * Watch the open dialog from `since` until its box is checked, or until
 * APPLY_GRACE_MS after the workspace handed it `seeded`, or HANDOFF_MS
 * without that hand-off: `{handedMs, checkedMs}` (ms after `since`, null
 * when not seen), the samples taken, whether the prop was ever readable,
 * and the last reading.
 */
async function watchOpenDialog(u, dlg, seeded, since) {
  const box = dlg.locator("#upload-marking");
  const started = Date.now();
  const out = { handedMs: null, checkedMs: null, samples: 0, found: false, last: null };
  for (;;) {
    const s = await box.evaluate(uploadDialogState);
    const ms = Date.now() - since;
    out.samples += 1;
    out.last = s;
    out.found ||= s.found;
    if (out.handedMs === null && isDeepStrictEqual(s.handed, seeded)) out.handedMs = ms;
    if (s.checked) {
      out.checkedMs = ms;
      return out;
    }
    if (out.handedMs !== null && ms - out.handedMs >= APPLY_GRACE_MS) return out;
    if (out.handedMs === null && Date.now() - started >= HANDOFF_MS) return out;
    await u.page.waitForTimeout(250); // a poll interval, not a settle: the loop ends on the condition or a deadline
  }
}

/**
 * X-a17-export-6, class P. SPEC §20, docs/architecture/spec.md:2332: the
 * account default "(seeds new documents)". UploadDialog.tsx:29 reads its
 * prop once, at mount (`useState(accountDefaultMarking ?? MARKING_OFF)`), and
 * DocList.tsx:359 hands it MARKING_OFF until the account listener delivers,
 * so a dialog opened before then never shows the default and an upload from
 * it is stored unmarked.
 *
 * The oracle is the open dialog's box AFTER the workspace has handed the
 * dialog the default (uploadDialogState), given APPLY_GRACE_MS to show it,
 * not at the moment the workspace's card shows: the cards come from the docs
 * listener and the account record from watchUser, so a read at the card
 * could precede the record and be red for the wrong reason, on a slow stack
 * even after a fix. Before that oracle, two preconditions: a dialog opened
 * afresh is seeded (the record reached the workspace's seeding path at all),
 * and the hand-off was seen. A failure of either FAILS the case (or ends it
 * INCONCLUSIVE when a page saw the stack stall), never this defect's TODO.
 */
scenario("A17.5c an Upload dialog opened before the workspace has the account record still seeds Stamp exports from the account default once the record arrives", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const seeded = { enabled: true, label: `EARLY ${t}`.slice(0, MAX_LABEL), footer: "Early footer {version}" };
  const fs = clientFirestore(target, { idToken: () => idToken(target, accounts[0]), http: ctx.http({ actor: "owner-fs" }) });
  const w = await fs.update(`users/${accounts[0].uid}`, { defaultMarking: seeded });
  precondition(w.verdict === "ALLOW", `the owner's own client sets users/{uid}.defaultMarking (${w.status})`);
  const up = await publishDoc(ctx, owner.http, { body: probeDoc({ title: `Workspace card ${t}` }), filename: "index.html", title: `Workspace card ${t}`, name: "a175c-card" });

  const o = await signedIn(ctx, accounts[0], "owner");
  ctx.step("hold the page's Firestore listen requests (lib/sync.mjs holdListen), open the workspace and its Upload dialog before any snapshot arrives");
  // Every listen POST is held until stop(): the channel's first one carries
  // the workspace's listens (the account record among them), and nothing
  // reaches the page until it goes.
  const gate = await holdListen(o.page);
  const card = o.page.locator(".doc-card", { has: o.page.locator(`a.doc-card-title[href="/d/${up.docId}"]`) });
  const dlg = o.page.getByRole("dialog", { name: "Upload a document" });
  let held = 0;
  let records = [];
  let opened = null;
  try {
    await o.goto("/");
    await o.page.locator(".workspace-toolbar").getByRole("button", { name: "Upload", exact: true }).click();
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    held = gate.heldAt.length;
    precondition(held > 0 && (await card.count()) === 0, `the workspace has no data yet (${held} listen requests held, ${await card.count()} cards)`);
    opened = await dlg.locator("#upload-marking").evaluate(uploadDialogState);
    precondition(!opened.checked && !isDeepStrictEqual(opened.handed, seeded), `the dialog opened before the account record reached it: ${JSON.stringify(opened)}`);
    ctx.step(`the dialog opened with ${held} listen request(s) held: ${JSON.stringify(opened)}`);
  } finally {
    records = (await gate.stop()) ?? [];
  }
  const releasedAt = Date.now();
  const heldMs = records.map((r) => (r.releasedAt ?? r.at) - r.at);
  ctx.step(`released; each listen request was held ${JSON.stringify(heldMs)} ms`);

  ctx.step(`once the workspace shows its card, watch the open dialog until the workspace hands it the account default, then ${APPLY_GRACE_MS} ms more (or until its box is checked)`);
  // No reload here (waitShown is given no path): it would close the dialog under test.
  await o.waitShown(card, { what: `the workspace's card of ${up.docId}, its listen requests having been held ${JSON.stringify(heldMs)} ms`, timeout: PAGE_MS });
  const cardMs = Date.now() - releasedAt;
  const watch = await watchOpenDialog(o, dlg, seeded, releasedAt);
  ctx.step(`the open dialog, ms after the release: card ${cardMs}, handed the default ${watch.handedMs}, box checked ${watch.checkedMs} (${watch.samples} samples; last ${JSON.stringify(watch.last)})`);

  ctx.step("precondition: a dialog opened afresh is seeded, so the record reached the workspace's seeding path");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await dlg.waitFor({ state: "detached", timeout: 10_000 });
  let attempts = 0;
  // A wait for it that runs out is the case's failure, unless the page saw the stack stall in it.
  await eventually(async () => {
    attempts += 1;
    if (await dlg.isVisible()) {
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "detached", timeout: 10_000 });
    }
    await o.page.locator(".workspace-toolbar").getByRole("button", { name: "Upload", exact: true }).click();
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    if (!(await dlg.locator("#upload-marking").isChecked())) throw new Error("a fresh dialog is unchecked too");
    return true;
  }, { timeout: 60_000, interval: 1_000, message: "the account record reached the workspace: a dialog opened afresh is seeded from the default" });
  const freshMs = Date.now() - releasedAt;
  ctx.ev.json("seed", { held, heldMs, opened, cardMs, handedMs: watch.handedMs, checkedMs: watch.checkedMs, graceMs: APPLY_GRACE_MS, samples: watch.samples, found: watch.found, last: watch.last, freshMs, freshAttempts: attempts });
  precondition(watch.checkedMs !== null || watch.handedMs !== null, watch.found
    ? `the workspace never handed the open dialog the account default within ${HANDOFF_MS} ms of its card (its prop: ${JSON.stringify(watch.last?.handed)}), though a dialog opened afresh is seeded: nothing was measured`
    : "no component on the page has UploadDialog's accountDefaultMarking prop, so the hand-off cannot be seen: the measurement needs updating");

  ctx.step("an explicit unchecked choice survives a later account-default snapshot in the same dialog");
  await dlg.locator("#upload-marking").uncheck();
  const changed = { ...seeded, label: `LATER ${t}`.slice(0, MAX_LABEL) };
  const later = await fs.update(`users/${accounts[0].uid}`, { defaultMarking: changed });
  precondition(later.verdict === "ALLOW", "the owner changes their account default while the dialog stays open");
  await eventually(async () => isDeepStrictEqual((await dlg.locator("#upload-marking").evaluate(uploadDialogState)).handed, changed), { timeout: PAGE_MS, message: "the open dialog receives the later account preference" });
  await o.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await dlg.locator("#upload-marking").isChecked(), false, "a later account snapshot preserves the person's explicit unchecked choice");

  ctx.step("X-a17-export-6's oracle: the open dialog, handed the default, shows Stamp exports checked");
  assert.ok(watch.checkedMs !== null, `X-a17-export-6 (SPEC §20, spec.md:2332: the account default "seeds new documents"): the open Upload dialog was handed the account default ${watch.handedMs} ms after the release and its Stamp exports box was still unchecked ${APPLY_GRACE_MS} ms later`);
});

// --- A17.6 --------------------------------------------------------------------------

scenario("A17.6 File → Print (the browser's own print): the frame opens to its content's full height and the PDF paginates, then it closes with the reader's scroll position back; no stamp and no print frame; the viewer's chrome is hidden on paper", { tiers: BOTH, inconclusiveOnCaseTimeout: true, timeoutMs: 480_000 }, async (ctx) => {
  const { owner, accounts } = await ownerSession(ctx);
  const t = tag();
  const title = `File print ${t}`;
  const extraBody = `<section id="s-long">${Array.from({ length: 60 }, (_, i) => `<p id="long-${i + 1}">Long paragraph ${i + 1}: enough words to wrap across the frame and make the document several pages tall when it is printed.</p>`).join("\n")}</section>`;
  const up = await publishDoc(ctx, owner.http, { body: probeDoc({ title, extraBody }), filename: "index.html", title, name: "a176-file-print" });
  await coverStored(ctx, owner, up.docId);
  await setMarking(ctx, owner, up.docId, { enabled: true, label: SUGGESTED_LABEL, footer: "{title}" });

  const u = await signedIn(ctx, accounts[0], "owner");
  await openDoc(ctx, u, up.docId);
  await quietDoc(target, up.docId);
  await commentOn(u, "#p-1", P1_QUOTE, `Print chrome ${t}`);
  await u.openComments();
  const chromeSelectors = [".app-header", ".viewer-toolbar", ".viewer-banners", ".comments-panel", ".consent"];
  const chromeBefore = await u.page.evaluate((selectors) => Object.fromEntries(selectors.map((selector) => {
    const el = document.querySelector(selector);
    return [selector, el ? { display: getComputedStyle(el).display, visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 } : null];
  })), chromeSelectors);
  for (const selector of chromeSelectors.filter((s) => s !== ".consent")) precondition(chromeBefore[selector]?.visible && chromeBefore[selector]?.display !== "none", `${selector} is rendered and visible before printing`);
  if (target.capabilities.has("measurement-id") && target.capabilities.has(patchCapability("a19-analytics-live"))) precondition(chromeBefore[".consent"]?.visible, "the analytics-live target renders consent before printing");
  // The standard local build never asks for analytics consent. If this target
  // does render it, it must be hidden on paper as every other chrome surface.
  ctx.ev.json("chrome-before-print", chromeBefore);
  const frame = await u.frame();
  const before = await frame.evaluate(() => {
    const s = document.scrollingElement ?? document.documentElement;
    s.scrollTop = 1200;
    return { scrollTop: s.scrollTop, scrollHeight: document.documentElement.scrollHeight, clientHeight: s.clientHeight };
  });
  const frameHeight = await u.page.evaluate(() => {
    const f = document.querySelector("iframe.doc-frame");
    return { style: f.style.height, rect: Math.round(f.getBoundingClientRect().height) };
  });
  ctx.step(`the frame: ${JSON.stringify({ before, frameHeight })}`);
  precondition(before.scrollTop === 1200 && before.scrollHeight > 2 * PAGE.height && frameHeight.style === "", "a tall document, scrolled to 1200 inside a frame of its own height");

  // The app's beforeprint handler opens the frame; a frame with no overflow
  // forgets its scroll position, which is why afterprint puts it back
  // (usePrinting.ts). Under Page.printToPDF the on-screen frame keeps its
  // offset (measured: the same 4 pages and offset for 0, 1200 and 3000), so
  // the forgetting is emulated: after the app's handler has run, the frame is
  // scrolled to 0, as the opened frame would be. Only the restore is judged.
  ctx.step("listeners registered after the app's record the frame and the stamps at beforeprint (then scroll the opened frame to 0, as the browser forgets it) and at afterprint");
  await u.page.evaluate(() => {
    const rec = { events: [], iframesAdded: 0 };
    window.__e2eFilePrint = rec;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeName === "IFRAME") rec.iframesAdded += 1;
    }).observe(document.body, { childList: true, subtree: true });
    const snap = (type) => {
      const f = document.querySelector("iframe.doc-frame");
      const d = f.contentDocument;
      const scroller = d.scrollingElement ?? d.documentElement;
      rec.events.push({
        type,
        height: f.style.height,
        contentHeight: `${d.documentElement.scrollHeight}px`,
        scrollTop: scroller.scrollTop,
        stamps: document.querySelectorAll('[class*="bshd-print"]').length + d.querySelectorAll('[class*="bshd-print"]').length,
        iframes: document.querySelectorAll("iframe").length,
      });
      if (type === "beforeprint") scroller.scrollTop = 0;
    };
    window.addEventListener("beforeprint", () => snap("beforeprint"));
    window.addEventListener("afterprint", () => snap("afterprint"));
  });

  ctx.step("print the page with Chrome's own print (Page.printToPDF), as File → Print does");
  const pdf = await u.page.pdf({ format: "A4" });
  ctx.ev.text("print.pdf.size", String(pdf.length));
  const count = Number(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/s.exec(pdf.toString("latin1"))?.[1] ?? /\/Count\s+(\d+)/.exec(pdf.toString("latin1"))?.[1] ?? 0);
  const rec = await u.page.evaluate(() => window.__e2eFilePrint);
  const after = await u.page.evaluate(() => {
    const f = document.querySelector("iframe.doc-frame");
    const d = f.contentDocument;
    return { height: f.style.height, scrollTop: (d.scrollingElement ?? d.documentElement).scrollTop };
  });
  ctx.ev.json("file-print", { rec, after, pages: count });
  ctx.step(`events ${JSON.stringify(rec.events)}; after ${JSON.stringify(after)}; ${count} PDF pages`);
  precondition(rec.events.length === 2 && rec.events[0].type === "beforeprint" && rec.events[1].type === "afterprint", `printToPDF fired beforeprint then afterprint: ${JSON.stringify(rec.events.map((e) => e.type))}`);

  const [bp, ap] = rec.events;
  assert.equal(bp.height, bp.contentHeight, "at beforeprint the frame is opened to its content's full height");
  assert.ok(count >= 2, `the document paginates: ${count} PDF pages`);
  assert.equal(ap.height, "", "at afterprint the frame is closed again");
  assert.deepEqual(after, { height: "", scrollTop: before.scrollTop }, "after printing, the frame's height is the layout's and the reader's scroll position is back");
  assert.deepEqual({ stamps: bp.stamps, iframes: bp.iframes, added: rec.iframesAdded }, { stamps: 0, iframes: 1, added: 0 }, "no stamp and no print frame on the browser's own print");

  ctx.step("on paper the viewer's chrome is hidden (print media)");
  await u.page.emulateMedia({ media: "print" });
  const chrome = await u.page.evaluate((selectors) => Object.fromEntries(selectors.map((s) => [s, document.querySelector(s) ? getComputedStyle(document.querySelector(s)).display : "absent"])), chromeSelectors);
  await u.page.emulateMedia({ media: null });
  assert.deepEqual(chrome, Object.fromEntries(chromeSelectors.map((s) => [s, chromeBefore[s] ? "none" : "absent"])), "all rendered viewer chrome is hidden in print media");
  noPageErrors([u]);
});
