// SPDX-License-Identifier: Apache-2.0
// Markdown documents: the constrained palette, both files at rest, editing that normalises once and then never again, the format-aware download menu (SPEC §11).

/**
 * Catalogue A10, one scenario per case, each with its own accounts and
 * documents:
 *
 *   10.1 in the editor of a Markdown document the five presentation controls
 *        (Underline, Font, Text colour, Align left, Align centre) are
 *        disabled, each with the tooltip EditToolbar.tsx writes, shown on
 *        hover; nothing else in the palette is; on an HTML document the same
 *        five are enabled with their plain titles
 *   10.1b the same palette from the editor's FIRST render: the toolbar takes
 *        the format from the version record, which the viewer reads after
 *        the frame can load, so on a slow read Edit offers the HTML palette
 *        on a Markdown document — X-a10-markdown-2, see the case
 *   10.2 a `.md` upload records format markdown, entry index.html,
 *        sourceEntry index.md and the pinned rendererVersion; Storage and the
 *        zip hold exactly those two files, index.md byte for byte as
 *        uploaded and index.html what /content serves; the rendering wraps
 *        each heading in a section with a GitHub slug (deduped -1) and names
 *        no external URL
 *   10.3 an in-app commit changes index.md by the edit and SPEC §11's
 *        first-pass normalisation and by nothing else; every comment (SPDX
 *        included) survives, and the text of a script, a style and a
 *        textarea comes back byte for byte; a no-op commit after it is
 *        `deduped: true` on the same version and mints nothing
 *   10.3b an HTML commit preserves the parsed authored DOM plus the edit,
 *        including all attributes and whitespace within authored elements.
 *        Browser parsing can move document-boundary whitespace; X-a10-markdown-1
 *        retains that harmless established behavior rather than requiring a
 *        raw-source editor beneath contentEditable
 *   10.4 idempotence after the first pass, through the browser's own
 *        serialization: md' (the first in-app save of the markdown-reference
 *        sample, published as v2) equals md'' (the draft the editor writes
 *        when md', published as a document of its own whose rendering is
 *        v2's index.html byte for byte, is saved unchanged); a second
 *        session on the first document would adopt the live log the commit
 *        left behind (S8), see the case
 *   10.5 the More menu of a Markdown document offers exactly "Download the
 *        rendered HTML", "Download the Markdown source" and "Download
 *        everything as a .zip", and each downloads the stored bytes; a
 *        single-file HTML document offers "Download the HTML" alone;
 *        get_document returns the Markdown source, never the rendering
 *
 * Expected behaviour is SPEC §2 (POST /commit), §6a and §11, ADR 0003 and
 * 0007, docs/development/verification.md §2, §8 and §9, and the product
 * source cited at each oracle. Only e2e/lib/ talks to the stack.
 *
 * HTML is edited as the authored DOM (ADR 0007), then serialized by the
 * browser. Document-boundary whitespace therefore follows HTML parsing rules;
 * raw source bytes are not its identity boundary. 10.3b compares the complete
 * parsed DOM without stripping attributes or normalising element text, so it
 * still catches lost structure, meaningful whitespace and leaked decoration.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { publish, readFixture, readSample } from "../../lib/seed.mjs";
import { readDraftObject, draftStoragePrefix, closeAdmin, listObjects, readCollection, readDoc, readObject } from "../../lib/admin.mjs";
import { eventually, lineHunks } from "../../lib/assert.mjs";
import { rehashZip } from "../../lib/bytes.mjs";
import { holdListen } from "../../lib/sync.mjs";
import { zipFiles } from "../../lib/zipread.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const sha = (b) => createHash("sha256").update(b).digest("hex");
const tag = () => `${runTag(target.runId)}-${rand4()}`;

/** EditToolbar.tsx MARKDOWN_UNAVAILABLE, the tooltip of every control Markdown cannot express (SPEC §11, verification §8). */
const MARKDOWN_UNAVAILABLE =
  "Markdown cannot express this, so it would be lost the next time you save. Publish this document as HTML to use it.";
/** The sentence docs/development/verification.md §8 quotes; the tooltip must begin with it. */
const DOCUMENTED_TOOLTIP = "Markdown cannot express this, so it would be lost the next time you save.";
/** The presentation controls, by accessible name, and their titles on an HTML document (EditToolbar.tsx). */
const PRESENTATION = Object.freeze({
  Underline: "Underline",
  Font: "Font",
  "Text colour": "Text colour",
  "Align left": "Alignment",
  "Align centre": "Alignment",
});
/** RENDERER_VERSION's shape: markdown-it pinned to an exact version, plus the renderer's own revision (render.ts, SPEC §11). */
const RENDERER_VERSION_RE = /^markdown-it@\d+\.\d+\.\d+\+bikeshed-\d+$/;
/** The commit toast for a dedup (DocViewer.tsx). */
const NO_CHANGES = "No changes to publish — the content is identical.";

// --- fixtures -----------------------------------------------------------------

/** 10.2: a preamble, then three headings, two of them the same. */
const STORED_MD = [
  "<!-- SPDX-License-Identifier: Apache-2.0 -->",
  "",
  "# Stored twice",
  "",
  "A Markdown document is kept as its source and as its rendering.",
  "",
  "## Notes",
  "",
  "The first notes.",
  "",
  "## Notes",
  "",
  "The second notes, under the same heading.",
  "",
].join("\n");

/**
 * 10.3: one of each first-pass normalisation SPEC §11 names (setext → ATX,
 * `*` bullets → `-`, a hard-wrapped paragraph → one line), two comments, a
 * script, a style and a textarea whose whitespace is meaning (trailing
 * spaces, a blank line, indentation, a `//` comment ending at its line), and
 * constructs already in their normal form, which must come back unchanged:
 * the lossy-but-idempotent shape serialize.ts names (a strikethrough with one
 * tilde) is invisible to 10.4 and visible only here.
 */
const CANONICAL = [
  "Marks: *emphasis*, **strong**, ~~struck~~, `code`, and [a link](https://example.com/a10).",
  "",
  "1. first",
  "2. second",
  "   - nested under second",
  "",
  "- [x] done",
  "- [ ] open",
  "",
  "| Column | Means |",
  "| --- | --- |",
  "| left | the first |",
  "| right | the second |",
];
const SCRIPT_BLOCK = [
  "<script>",
  "// A line comment ends at its line break.",
  "window.e2eProbe = 1;",
  "",
  '  var indented = "kept as typed";   ',
  "</script>",
].join("\n");
const STYLE_BLOCK = ["<style>", ".probe  {", "  color: teal;   ", "}", "", "</style>"].join("\n");
const TEXTAREA_BLOCK = ['<textarea rows="4">first line', "  indented second line   ", "", "after a blank line</textarea>"].join("\n");
const SPDX = "<!-- SPDX-License-Identifier: Apache-2.0 -->";
const NOTE = "<!-- An author's note: this comment must survive every save. -->";
const PROBE_TITLE = "Normalisation probe";
const TARGET_SENTENCE = "The edit lands at the end of this sentence.";

const PROBE_MD = [
  SPDX,
  "",
  PROBE_TITLE,
  "===================",
  "",
  "This paragraph is hard wrapped in the source,",
  "so the first save joins its two lines into one.",
  "",
  "* a starred bullet",
  "* another starred bullet",
  "",
  NOTE,
  "",
  "Edit target",
  "-----------",
  "",
  TARGET_SENTENCE,
  "",
  ...CANONICAL,
  "",
  SCRIPT_BLOCK,
  "",
  STYLE_BLOCK,
  "",
  TEXTAREA_BLOCK,
  "",
  "Closing paragraph.",
  "",
].join("\n");

/** PROBE_MD after SPEC §11's first pass, written from the SPEC's rules, with `edit` appended to the target sentence. */
function probeNormalised(edit) {
  return [
    SPDX,
    "",
    `# ${PROBE_TITLE}`,
    "",
    "This paragraph is hard wrapped in the source, so the first save joins its two lines into one.",
    "",
    "- a starred bullet",
    "- another starred bullet",
    "",
    NOTE,
    "",
    "## Edit target",
    "",
    `${TARGET_SENTENCE}${edit}`,
    "",
    ...CANONICAL,
    "",
    SCRIPT_BLOCK,
    "",
    STYLE_BLOCK,
    "",
    TEXTAREA_BLOCK,
    "",
    "Closing paragraph.",
    "",
  ].join("\n");
}

/** 10.1 and 10.5: a small Markdown document. */
const SMALL_MD = ["# Small probe", "", "One paragraph of *Markdown*.", ""].join("\n");

// --- helpers ------------------------------------------------------------------

/** An owner with a session and their account (with the password, for the UI). */
async function castOwner() {
  const [acct] = await cast(target, ["owner"]);
  const session = await openSession(target, acct);
  return { acct, session };
}

/** One browser user, signed in through the UI. */
async function signedIn(ctx, acct, name = "owner") {
  const u = await ctx.users.user({ name });
  const s = await u.signInUi(acct.email, acct.password);
  precondition(s.status === "ok", `${name} signed in through /signup`);
  return u;
}

/** GET /download as `http`: the files by name, REHASH, and the version record. */
async function stored(http, docId, versionId) {
  const r = await http.get(`/download/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}`, { expect: 200 });
  const files = Object.fromEntries(zipFiles(r.buffer).map((f) => [f.rel, f.data]));
  const rehash = await rehashZip(r.buffer, { target });
  const record = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  return { files, rehash: rehash.contentHash, record, zip: r.buffer };
}

/** A recorded response's JSON body, or null. */
const bodyJson = (entry) => entry.response.json().catch(() => null);

/**
 * Press "Save as new version" and return both the toast outcome and the
 * POST /commit answer, taken from the user's response log from a mark set
 * before the press, so a fast answer is never missed.
 */
async function commitInApp(u) {
  const mark = u.responseMark();
  const toast = await u.saveAsNewVersion();
  const entry = await u.waitForResponse({ method: "POST", path: "/commit" }, { since: mark, timeout: 10_000 });
  return { toast, commit: { status: entry.status, json: await bodyJson(entry) } };
}

/** The Formatting toolbar's controls, outside its trailing save group. */
async function paletteControls(u) {
  const bar = u.page.getByRole("toolbar", { name: "Formatting" });
  return bar.evaluate((el) =>
    Array.from(el.querySelectorAll(".toolbar-group button, .toolbar-group select, .toolbar-group input")).map((c) => {
      const wrap = c.parentElement;
      return {
        name: c.getAttribute("aria-label") ?? c.id,
        disabled: c.disabled,
        title: c.getAttribute("title"),
        wrapUnavailable: wrap?.classList.contains("toolbar-unavailable") ?? false,
        wrapReason: wrap?.getAttribute("data-reason") ?? null,
      };
    }),
  );
}

/** Hover the wrapper of the control named `name` and read the tooltip its ::after draws. */
async function hoverTooltip(u, name) {
  const control = u.page.getByRole("toolbar", { name: "Formatting" }).locator(`[aria-label="${name}"]`);
  const wrap = control.locator("xpath=..");
  await wrap.hover();
  return eventually(async () => {
    const t = await wrap.evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return { content: s.content, opacity: s.opacity };
    });
    if (t.opacity !== "1") throw new Error(`the tooltip of ${name} is not shown: ${JSON.stringify(t)}`);
    return t;
  }, { timeout: 5_000, interval: 100, message: `the tooltip of ${name} shows on hover` });
}

/**
 * The download choices ("Download …") of the More menu's "Download" group,
 * read until they are `want` on 2 reads running or 15 s have passed:
 * {last, reads}. The menu's entries follow the version record (DocViewer.tsx:
 * the label needs `format`, the source entry `version.sourceEntry`, the zip
 * `version.fileCount`), which can load after the frame does (the race 10.1b
 * pins for the palette), so the case asserts on the settled read, `last`,
 * and keeps every read for evidence. Never throws on a mismatch: the caller's
 * assertion is the oracle.
 */
async function settledDownloads(u, want) {
  const reads = [];
  let last = null;
  await eventually(async () => {
    last = ((await u.menuGroup("Download")) ?? []).filter((l) => l.startsWith("Download "));
    reads.push(last);
    return isDeepStrictEqual(last, want) ? last : false;
  }, { timeout: 15_000, interval: 250, stableSamples: 2, message: `the Download group offers ${JSON.stringify(want)}` }).catch(() => undefined);
  return { last, reads };
}

// --- 10.1 ---------------------------------------------------------------------

/** The names of the disabled controls once they are `expected` on 3 samples running; the last sample in the error otherwise. */
async function waitDisabled(u, expected, { timeout = 15_000 } = {}) {
  const want = [...expected].sort();
  return eventually(async () => {
    const got = (await paletteControls(u)).filter((c) => c.disabled).map((c) => c.name).sort();
    if (!isDeepStrictEqual(got, want)) throw new Error(`disabled ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    return got;
  }, { timeout, interval: 200, stableSamples: 3, message: `the palette disables ${JSON.stringify(want)}` });
}

scenario("A10.1 a Markdown document's editor disables Underline, Font, Text colour and both Align controls with the tooltip \"Markdown cannot express this, so it would be lost the next time you save.\", and nothing else; an HTML document's editor enables them", { tiers: ["local", "prod"], timeoutMs: 180_000 }, async (ctx) => {
  const { acct, session } = await castOwner();
  const md = await publish(session.http, { body: SMALL_MD, filename: "small.md", title: "Small probe", name: "a101-md" });
  const html = await publish(session.http, { fixture: "crdt-paragraphs.html", title: "Palette contrast", name: "a101-html" });
  const u = await signedIn(ctx, acct);

  ctx.step("open the Markdown document and press Edit; read the palette once it has settled (the first render is 10.1b's)");
  await u.open(md.docId);
  await u.enterEdit();
  // The palette follows the version record, which loads after the frame can
  // (X-a10-markdown-2, case 10.1b). Here the settled palette is the oracle.
  await waitDisabled(u, Object.keys(PRESENTATION));
  const mdControls = await paletteControls(u);
  ctx.ev.json("palette-markdown", mdControls);
  assert.deepEqual(mdControls.filter((c) => c.disabled).map((c) => c.name).sort(), Object.keys(PRESENTATION).sort(), "exactly the presentation controls are disabled on Markdown (SPEC §11)");
  for (const c of mdControls.filter((x) => x.disabled)) {
    assert.ok(c.title.startsWith(DOCUMENTED_TOOLTIP), `${c.name}: the title begins with the sentence verification §8 quotes: ${JSON.stringify(c.title)}`);
    assert.deepEqual({ title: c.title, wrapUnavailable: c.wrapUnavailable, wrapReason: c.wrapReason }, { title: MARKDOWN_UNAVAILABLE, wrapUnavailable: true, wrapReason: MARKDOWN_UNAVAILABLE }, `${c.name}: disabled with the explanation, not hidden`);
  }
  for (const name of Object.keys(PRESENTATION)) {
    const t = await hoverTooltip(u, name);
    assert.equal(JSON.parse(t.content), MARKDOWN_UNAVAILABLE, `${name}: the tooltip drawn on hover`);
  }
  await u.done();

  ctx.step("open the HTML document and press Edit: the same five controls are enabled with their own titles");
  await u.open(html.docId);
  await u.enterEdit();
  await waitDisabled(u, []);
  const htmlControls = await paletteControls(u);
  assert.deepEqual(htmlControls.filter((c) => c.disabled).map((c) => c.name), [], "nothing is disabled on HTML");
  ctx.ev.json("palette-html", htmlControls);
  for (const [name, title] of Object.entries(PRESENTATION)) {
    const c = htmlControls.find((x) => x.name === name);
    assert.ok(c, `the HTML palette has ${name}`);
    assert.deepEqual({ title: c.title, wrapUnavailable: c.wrapUnavailable, wrapReason: c.wrapReason }, { title, wrapUnavailable: false, wrapReason: null }, `${name} on HTML`);
  }
  assert.deepEqual(htmlControls.map((c) => c.name), mdControls.map((c) => c.name), "both formats show the same controls in the same order: disabled, never hidden");
  await u.done();
});

/**
 * The longest 10.1b holds the app's request for the version record: the
 * window a slow connection opens. The case releases it itself as soon as it
 * has read the first palette and the harm; this cap only bounds the hold.
 */
const VERSION_READ_DELAY_MS = 8_000;

scenario("A10.1b the constrained palette is in place from the editor's first render: on a Markdown document whose version record arrives late, Edit never offers the presentation controls enabled", { tiers: ["local", "prod"], defect: "X-a10-markdown-2", timeoutMs: 180_000 }, async (ctx) => {
  const { acct, session } = await castOwner();
  const md = await publish(session.http, { body: SMALL_MD, filename: "small.md", title: "Late version probe", name: "a101b" });
  const u = await signedIn(ctx, acct);

  ctx.step(`hold (at most ${VERSION_READ_DELAY_MS} ms) the browser's Firestore listen requests that ask for this document's versions: a slow connection, with the product untouched`);
  const gate = await holdListen(u, (body) => body.includes(`/docs/${md.docId}`) && /"collectionId":"versions"|\/versions\/v\d+"/.test(body), VERSION_READ_DELAY_MS);
  try {
    await u.open(md.docId);
    const openedAt = Date.now();
    const gated = await eventually(() => gate.heldAt.length > 0, { timeout: 10_000, interval: 50, message: "the app's version read reaches the gate" }).catch(() => false);
    precondition(gated, "the version read was held (the app asked for the version over the listen channel)");
    await u.enterEdit();
    const first = await paletteControls(u);
    const firstAt = Date.now();
    const stillHeld = gate.records[0].releasedAt === null;
    ctx.ev.json("first-palette", { msAfterOpen: firstAt - openedAt, heldAt: gate.heldAt.map((t) => t - openedAt), stillHeld, controls: first });
    precondition(stillHeld, "the first palette was read while the version read was still held");
    ctx.step(`first palette ${firstAt - openedAt} ms after the frame loaded, the version read still held: disabled ${JSON.stringify(first.filter((c) => c.disabled).map((c) => c.name))}`);

    // Evidence of the harm, never an oracle: while the window is open, centre
    // the paragraph the way an author would, and see what the draft keeps.
    const harm = { pressed: false };
    try {
      const centre = u.page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Align centre" });
      if (await centre.isEnabled()) {
        await u.typeInFrame('[id="small-probe"] > p', "");
        await centre.click({ timeout: 2_000 });
        const after = Date.now();
        harm.pressed = true;
        harm.stillHeldWhenPressed = gate.records[0].releasedAt === null;
        harm.alignedInEditor = await (await u.frame()).locator('[id="small-probe"] > p').evaluate((p) => getComputedStyle(p).textAlign);
        // What the draft keeps does not depend on the window staying open:
        // the save carries the HTML as it was when pressed.
        harm.draftStatus = (await u.waitForAutosave({ after, timeout: 15_000, expectStatus: null })).status;
        const draftMd = (await session.http.get(`/draft/${encodeURIComponent(md.docId)}/index.md`)).text;
        harm.draftMd = draftMd;
        harm.alignmentInDraft = /center/i.test(draftMd);
      }
    } catch (e) {
      harm.error = String(e?.message ?? e).slice(0, 300);
    }
    ctx.ev.json("harm", harm);
    ctx.step(`harm while the window was open: ${JSON.stringify({ pressed: harm.pressed, stillHeldWhenPressed: harm.stillHeldWhenPressed, alignedInEditor: harm.alignedInEditor, alignmentInDraft: harm.alignmentInDraft, error: harm.error })}`);

    // Once the held read is let through, the palette must become Markdown's:
    // that is what ties the first palette to the version record, and it is the
    // product's own steady state (10.1), so a timeout here is not this defect.
    gate.release();
    await waitDisabled(u, Object.keys(PRESENTATION), { timeout: 20_000 });
    ctx.step(`after the held read went through (held ${gate.records[0].releasedAt - gate.records[0].at} ms) the palette is Markdown's`);
    assert.deepEqual(
      first.filter((c) => c.disabled).map((c) => c.name).sort(),
      Object.keys(PRESENTATION).sort(),
      "the editor's first palette on a Markdown document (SPEC §11: disabled, never silently dropped)",
    );
  } finally {
    ctx.ev.json("gate", (await gate.stop()).map((r) => ({ i: r.i, at: r.at, releasedAt: r.releasedAt, body: r.body.slice(0, 400) })));
  }
});

// --- 10.2 ---------------------------------------------------------------------

scenario("A10.2 a .md upload records format markdown, entry index.html, sourceEntry index.md and the pinned rendererVersion; Storage and the zip hold exactly both files, index.md as uploaded; headings are sections with GitHub slugs and no URL is external", { tiers: ["local", "prod"], timeoutMs: 90_000 }, async (ctx) => {
  const { session } = await castOwner();
  const bytes = Buffer.from(STORED_MD, "utf8");

  ctx.step("POST /publish with notes.md");
  const up = await publish(session.http, { body: bytes, filename: "notes.md", title: "Stored twice", name: "a102" });
  assert.equal(up.versionId, "v1");
  const docId = up.docId;

  ctx.step("the version record (verification §2)");
  const record = await readDoc(target, `docs/${docId}/versions/v1`);
  ctx.ev.json("v1-record", record);
  assert.deepEqual(
    { format: record.format, entry: record.entry, sourceEntry: record.sourceEntry, files: [...record.files].sort(), fileCount: record.fileCount },
    { format: "markdown", entry: "index.html", sourceEntry: "index.md", files: ["index.html", "index.md"], fileCount: 2 },
  );
  assert.match(String(record.rendererVersion), RENDERER_VERSION_RE, "rendererVersion names the pinned renderer");

  ctx.step("Storage holds exactly the two files under the version prefix");
  assert.deepEqual(await listObjects(target, `docs/${docId}/v1/`), [`docs/${docId}/v1/index.html`, `docs/${docId}/v1/index.md`]);
  const objMd = await readObject(target, `docs/${docId}/v1/index.md`);
  const objHtml = await readObject(target, `docs/${docId}/v1/index.html`);
  assert.equal(sha(objMd), sha(bytes), "Storage's index.md is the uploaded source, byte for byte (authored source, canonical)");

  ctx.step("GET /download: the zip holds both files, the same bytes, and REHASH holds");
  const s = await stored(session.http, docId, "v1");
  assert.deepEqual(Object.keys(s.files).sort(), ["index.html", "index.md"], "the zip holds both files");
  assert.equal(sha(s.files["index.md"]), sha(bytes), "the zip's index.md is the upload");
  assert.equal(sha(s.files["index.html"]), sha(objHtml), "the zip's index.html is Storage's");
  assert.equal(s.rehash, record.contentHash, "REHASH v1: both files are inside the hashed bundle");

  ctx.step("GET /content serves the rendered entry");
  const c = await session.http.get(`/content/${encodeURIComponent(docId)}/v1/index.html`, { expect: 200 });
  assert.equal(sha(c.buffer), sha(objHtml), "what the iframe loads is the stored index.html");
  const html = objHtml.toString("utf8");
  ctx.ev.text("v1-index.html", html);

  ctx.step("the rendering: a section per heading, GitHub slugs deduped with -1, the preamble scoped, an embedded stylesheet, no external URL");
  const ids = [...html.matchAll(/<section id="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["preamble", "stored-twice", "notes", "notes-1"], "section ids in document order");
  assert.match(html, /<style id="[^"]+">/, "the stylesheet is embedded");
  assert.doesNotMatch(html, /(?:src|href|action|poster)\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i, "no attribute points at another origin");
  assert.doesNotMatch(html, /url\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)?\/\/|@import/i, "the stylesheet loads nothing");
});

// --- 10.3 ---------------------------------------------------------------------

scenario("A10.3 an in-app commit changes index.md by the edit and the first-pass normalisation only, keeping every comment (SPDX included) and the script, style and textarea text byte for byte; a no-op commit after it is deduped:true on the same version", { tiers: ["local", "prod"], timeoutMs: 240_000 }, async (ctx) => {
  const { acct, session } = await castOwner();
  const up = await publish(session.http, { body: PROBE_MD, filename: "probe.md", title: PROBE_TITLE, name: "a103" });
  const docId = up.docId;
  const v1 = await stored(session.http, docId, "v1");
  precondition(sha(v1.files["index.md"]) === sha(Buffer.from(PROBE_MD)), "v1 stores the probe source as uploaded");

  const u = await signedIn(ctx, acct);
  await u.open(docId);
  await u.enterEdit();
  const token = `⟦r${tag()}-a103⟧`;
  ctx.step(`the owner types ${token} at the end of the target sentence and the autosave takes it`);
  await u.typeAndAutosave('[id="edit-target"] > p', token);

  ctx.step("Save as new version mints v2");
  const first = await commitInApp(u);
  assert.equal(first.toast.outcome, "published", `commit toast: ${first.toast.text}`);
  assert.deepEqual({ status: first.commit.status, versionId: first.commit.json?.versionId, deduped: first.commit.json?.deduped }, { status: 200, versionId: "v2", deduped: false });

  const v2 = await stored(session.http, docId, "v2");
  const md2 = v2.files["index.md"].toString("utf8");
  ctx.ev.text("v1-index.md", PROBE_MD);
  ctx.ev.text("v2-index.md", md2);
  ctx.ev.text("v2-index.html", v2.files["index.html"].toString("utf8"));
  assert.equal(v2.rehash, v2.record.contentHash, "REHASH v2");
  assert.deepEqual(
    { format: v2.record.format, entry: v2.record.entry, sourceEntry: v2.record.sourceEntry, files: [...v2.record.files].sort(), parentVersion: v2.record.parentVersion, publishedVia: v2.record.publishedVia },
    { format: "markdown", entry: "index.html", sourceEntry: "index.md", files: ["index.html", "index.md"], parentVersion: "v1", publishedVia: "editor" },
  );
  assert.match(String(v2.record.rendererVersion), RENDERER_VERSION_RE, "the commit records the renderer");

  ctx.step("every comment survives, the SPDX header first; script, style and textarea text is byte for byte");
  assert.ok(md2.startsWith(`${SPDX}\n`), `the SPDX header still opens the source: ${JSON.stringify(md2.slice(0, 80))}`);
  assert.equal(md2.split(NOTE).length, 2, "the author's note is there, once");
  for (const [what, block] of [["script", SCRIPT_BLOCK], ["style", STYLE_BLOCK], ["textarea", TEXTAREA_BLOCK]]) {
    assert.ok(md2.includes(`\n\n${block}\n\n`), `the ${what} is byte for byte, on lines of its own`);
  }
  assert.equal(md2.split(token).length, 2, "the edit is in the source, once");

  ctx.step("the whole diff v1 → v2 is the edit plus SPEC §11's first pass, nothing more");
  assert.deepEqual(lineHunks(probeNormalised(token), md2), [], "index.md v2 is v1 + the edit + SPEC §11's first pass, and nothing else");

  ctx.step("open v2 again, type one character and delete it; the autosave takes the no-op; Save as new version");
  // While S8 stands this session adopts the live log the commit left behind,
  // so it re-saves the pre-commit DOM rather than v2's rendering: either way
  // the content is v2's and must mint nothing. Idempotence from v2's own
  // rendering is 10.4's, which starts from a document nobody has edited.
  await u.open(docId);
  await u.enterEdit();
  await u.typeAndAutosave('[id="edit-target"] > p', "x", { thenBackspace: 1 });
  const retiring = (await readDoc(target, `docs/${docId}`)).draft;
  const second = await commitInApp(u);
  assert.deepEqual(
    { status: second.commit.status, versionId: second.commit.json?.versionId, deduped: second.commit.json?.deduped, toast: second.toast.text },
    { status: 200, versionId: "v2", deduped: true, toast: NO_CHANGES },
    "a no-op commit is deduped on the same version (SPEC §2 POST /commit, verification §9)",
  );
  const versions = (await readCollection(target, `docs/${docId}/versions`)).map((v) => v.id).sort();
  const doc = await readDoc(target, `docs/${docId}`);
  assert.deepEqual({ versions, currentVersion: doc.currentVersion, draft: doc.draft ?? null }, { versions: ["v1", "v2"], currentVersion: "v2", draft: null }, "nothing minted, the draft cleared");
  assert.deepEqual(await listObjects(target, `${draftStoragePrefix(docId, retiring)}/`), [], "the draft's objects are gone");
});

// --- 10.3b --------------------------------------------------------------------

scenario("A10.3b an in-app HTML commit preserves the complete parsed authored DOM plus the edit, including attributes and element whitespace", { tiers: ["local", "prod"], timeoutMs: 180_000 }, async (ctx) => {
  const { acct, session } = await castOwner();
  const fixture = readFixture("crdt-paragraphs.html", { raw: true }).toString("utf8");
  precondition(fixture.endsWith("</p>\n</body>\n</html>\n"), "the fixture ends as authored HTML usually does");
  const up = await publish(session.http, { fixture: "crdt-paragraphs.html", title: "Bytes outside the edit", name: "a103b" });
  const docId = up.docId;

  const u = await signedIn(ctx, acct);
  await u.open(docId);
  await u.enterEdit();
  const token = `⟦r${tag()}-a103b⟧`;
  ctx.step(`the owner types ${token} at the end of #e2e-1, the autosave takes it, Save as new version`);
  await u.typeAndAutosave("#e2e-1", token);
  const done = await commitInApp(u);
  assert.equal(done.toast.outcome, "published", `commit toast: ${done.toast.text}`);
  assert.equal(done.commit.json?.versionId, "v2");

  // X-a10-markdown-1 retained behavior: parsing moves document-boundary
  // whitespace before editing starts. Compare the complete parsed DOM, not a
  // filtered fingerprint: author attributes and whitespace inside elements
  // remain part of the oracle, and editor overrides must not reach the save.
  const v2 = await stored(session.http, docId, "v2");
  const html2 = v2.files["index.html"].toString("utf8");
  ctx.ev.text("v2-index.html", html2);
  const at = fixture.indexOf("</p>", fixture.indexOf('id="e2e-1"'));
  const expected = `${fixture.slice(0, at)}${token}${fixture.slice(at)}`;
  const parser = await ctx.users.parser();
  const [before, after] = await parser.evaluate((sources) => sources.map((html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { doctype: doc.doctype ? [doc.doctype.name, doc.doctype.publicId, doc.doctype.systemId] : null, html: doc.documentElement.outerHTML };
  }), [expected, html2]);
  ctx.ev.json("parsed-documents", { expected: before, stored: after });
  assert.deepEqual(after, before, "v2 preserves the complete parsed authored DOM plus the edit");
});

// --- 10.4 ---------------------------------------------------------------------

/*
 * Why the second pass runs on a second document. An in-app commit leaves the
 * document's live log behind (S8: clearLog removes `status/{doc}/y`, which the
 * RTDB rules refuse, and app/src/crdt/rtdb.ts:69-76 swallows the refusal), and
 * the next editor to join ADOPTS that log over the bytes it loaded
 * (app/src/crdt/sync.ts, "their document wins"). So a second session on the
 * same document edits the DOM of the session before the commit, not html', and
 * its draft would be md'' only by accident: a control that made the second pass
 * non-idempotent stayed green that way. md' published as a document of its own
 * renders to v2's index.html byte for byte (a precondition below), and nobody
 * has edited it, so its editor starts from html' itself.
 */
scenario("A10.4 idempotence after the first pass: md' (the first in-app save of the markdown-reference sample) equals md'' (the draft the editor writes from md' published and saved unchanged)", { tiers: ["local", "prod"], timeoutMs: 240_000 }, async (ctx) => {
  const { acct, session } = await castOwner();
  const sample = readSample(target, "markdown-reference");
  const up = await publish(session.http, { body: sample.bytes, filename: sample.filename, title: sample.title, name: "a104" });
  const docId = up.docId;
  const u = await signedIn(ctx, acct);

  ctx.step("md → html → md': enter the editor on v1 and Save as new version without typing");
  await u.open(docId);
  await u.enterEdit();
  const first = await commitInApp(u);
  precondition(first.toast.outcome === "published" && first.commit.json?.versionId === "v2", `the first save normalised and minted v2 (${first.toast.text})`);
  const v2 = await stored(session.http, docId, "v2");
  const md1 = v2.files["index.md"].toString("utf8");
  ctx.ev.text("md-prime.md", md1);
  ctx.step(`md' is ${md1.length} characters; md was ${sample.bytes.length} bytes`);

  ctx.step("md' → html': publish md' as a document of its own, whose rendering must be v2's index.html");
  const second = await publish(session.http, { body: v2.files["index.md"], filename: sample.filename, title: sample.title, name: "a104-second" });
  const html1 = await stored(session.http, second.docId, "v1");
  precondition(
    sha(html1.files["index.md"]) === sha(v2.files["index.md"]) && sha(html1.files["index.html"]) === sha(v2.files["index.html"]),
    "md' published alone is stored as md' and renders to v2's index.html byte for byte (the second pass starts from html')",
  );

  ctx.step("html' → md'': open it, type one character and delete it, let the autosave write the draft");
  await u.open(second.docId);
  await u.enterEdit();
  await u.typeAndAutosave('[id="markdown-in-bikeshed"] > p', "x", { thenBackspace: 1 });
  // The draft's own object, never GET /draft: that falls back to v1's file
  // for anything the draft lacks, and would compare md' with itself.
  const doc = await readDoc(target, `docs/${second.docId}`);
  precondition(doc.draft?.baseVersion === "v1" && doc.draft?.sourceEntry === "index.md", `the autosave wrote a Markdown draft of md': ${JSON.stringify(doc.draft ?? null)}`);
  const draftObject = await readDraftObject(target, second.docId, "index.md");
  precondition(draftObject !== null, "the draft holds its own index.md");
  const md2 = draftObject.toString("utf8");
  ctx.ev.text("md-second.md", md2);
  const served = await session.http.get(`/draft/${encodeURIComponent(second.docId)}/index.md`, { expect: 200 });
  assert.equal(sha(served.buffer), sha(draftObject), "GET /draft serves the draft's own index.md");
  assert.deepEqual(lineHunks(md1, md2), [], "md'' === md' (SPEC §11)");
  await u.done();
});

// --- 10.5 ---------------------------------------------------------------------

scenario("A10.5 the More menu of a Markdown document offers the rendered HTML, the Markdown source and a zip, each the stored bytes; a single-file HTML document offers the HTML alone; get_document returns the Markdown source", { tiers: ["local", "prod"], timeoutMs: 180_000 }, async (ctx) => {
  const { acct, session } = await castOwner();
  const mdBytes = Buffer.from(SMALL_MD, "utf8");
  const md = await publish(session.http, { body: mdBytes, filename: "small.md", title: "Download probe", name: "a105-md" });
  const html = await publish(session.http, { fixture: "crdt-paragraphs.html", title: "Download contrast", name: "a105-html" });
  const mdStored = await stored(session.http, md.docId, "v1");
  const htmlStored = await stored(session.http, html.docId, "v1");
  const u = await signedIn(ctx, acct);

  ctx.step("the Markdown document's Download group, once the version record has loaded");
  await u.open(md.docId);
  const MD_CHOICES = ["Download the rendered HTML", "Download the Markdown source", "Download everything as a .zip"];
  const mdGroup = await settledDownloads(u, MD_CHOICES);
  ctx.ev.json("download-group-markdown", mdGroup);
  assert.deepEqual(mdGroup.last, MD_CHOICES, "the three choices (verification §8)");
  const rendered = await u.download("Download the rendered HTML");
  assert.deepEqual({ ext: rendered.filename.endsWith(".html"), sha: sha(rendered.bytes) }, { ext: true, sha: sha(mdStored.files["index.html"]) }, `the rendered HTML is the stored index.html (${rendered.filename})`);
  const source = await u.download("Download the Markdown source");
  assert.deepEqual({ ext: source.filename.endsWith(".md"), sha: sha(source.bytes) }, { ext: true, sha: sha(mdBytes) }, `the source is the uploaded index.md (${source.filename})`);
  const zip = await u.download("Download everything as a .zip");
  const inZip = Object.fromEntries(zipFiles(zip.bytes).map((f) => [f.rel, sha(f.data)]));
  assert.deepEqual({ ext: zip.filename.endsWith(".zip"), files: inZip }, { ext: true, files: { "index.html": sha(mdStored.files["index.html"]), "index.md": sha(mdBytes) } }, `the zip holds both stored files (${zip.filename})`);

  ctx.step("the single-file HTML document's Download group");
  await u.open(html.docId);
  const htmlGroup = await settledDownloads(u, ["Download the HTML"]);
  ctx.ev.json("download-group-html", htmlGroup);
  assert.deepEqual(htmlGroup.last, ["Download the HTML"], "the HTML alone");
  const entry = await u.download("Download the HTML");
  assert.equal(sha(entry.bytes), sha(htmlStored.files["index.html"]), "the HTML is the stored entry");

  ctx.step("get_document over MCP returns the Markdown source, never the rendering");
  const { token } = await mintToken(session, { name: "e2e a10.5 mcp", channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: "owner-mcp" });
  await mcp.initialize();
  const got = await mcp.ok("get_document", { id: md.docId });
  assert.deepEqual(
    { version: got.version, format: got.format, sourceFile: got.sourceFile, truncated: got.truncated, sha: sha(Buffer.from(got.source, "utf8")) },
    { version: "v1", format: "markdown", sourceFile: "index.md", truncated: false, sha: sha(mdBytes) },
    "get_document returns the uploaded Markdown source, never the rendering (verification §10)",
  );
  const asHtml = await mcp.ok("get_document", { id: html.docId });
  assert.deepEqual({ format: asHtml.format, sourceFile: asHtml.sourceFile }, { format: "html", sourceFile: "index.html" }, "an HTML document's source is its entry");
});
