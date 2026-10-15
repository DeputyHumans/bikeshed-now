// SPDX-License-Identifier: Apache-2.0
// Functional smoke: UI sign-in and a comment, two-peer live edit to a clean version, MCP, the CLI, one invitation in Mailpit (SPEC §12).

/**
 * One pass over the paths everything else stands on, each as a person or an
 * agent would take it, each with its own accounts and documents so a failure
 * in one says nothing about the next:
 *
 *   1  owner and viewer sign in at /signup; the owner publishes the B sample
 *      through POST /publish; the viewer drags over a passage, presses
 *      Comment and sends from the reply box; the owner sees that thread
 *   2  owner and editor edit live, each typing a token into a different
 *      paragraph; both frames converge; the owner saves a new version, whose
 *      stored bytes pass DECOR and REHASH
 *   2b BODYATTR on that version: neither editor override reaches the bytes.
 *      The attributes must exactly match the authored version; if scenario
 *      2 saved no version, 2b FAILS on its precondition instead
 *   3  MCP with a minted token: 23 tools, get_document returns the bytes
 *   4  `bikeshed list --json` lists the owner's document
 *   5  sharing with a new address sends exactly one invitation, held 10 s
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { createHash } from "node:crypto";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, localEmail, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { publish, readFixture, readSample } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { runCli } from "../../lib/cli.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { bodyHash, frameText } from "../../lib/frame.mjs";
import { bodyAttrDiff, diffFingerprint, entryHtml, fingerprint, rehashZip, summarize } from "../../lib/bytes.mjs";
import { zipFiles } from "../../lib/zipread.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

/** The plan's live-editing deadline for N = 2. */
const SETTLE_N2_MS = 15_000;
/** The keys a web annotation has, exactly (A6.1). */
const ANNOTATION_KEYS = ["actor", "anchor", "annId", "authorEmail", "authorUid", "color", "createdAt", "resolved"];

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

/** An owner with a session, and the rest of the cast as bare accounts. */
async function castWithOwner(roles) {
  const accounts = await cast(target, ["owner", ...roles]);
  const owner = await openSession(target, accounts[0]);
  return { owner, accounts };
}

/** The version as stored: GET /download as `http`, its entry HTML, and REHASH against the version record. */
async function storedVersion(http, docId, versionId) {
  const r = await http.get(`/download/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}`, { expect: 200 });
  const html = entryHtml(zipFiles(r.buffer));
  const rehash = await rehashZip(r.buffer, { target });
  const record = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  return { html, rehash: rehash.contentHash, record };
}

// --- 1 ----------------------------------------------------------------------

const QUOTE = "shareable links that resolve fast";

scenario("smoke: owner and viewer sign in through the UI, the viewer comments on a passage, the owner sees the thread", { timeoutMs: 180_000 }, async (ctx) => {
  ctx.step("cast an owner and a viewer; the owner publishes the B sample through POST /publish and shares it with the viewer");
  const { owner, accounts } = await castWithOwner(["viewer"]);
  const viewerAcct = accounts[1];
  const b = readSample(target, "design-review-shortener");
  const up = await publish(owner.http, { body: b.bytes, filename: b.filename, title: b.title, name: "design-review" });
  assert.equal(up.versionId, "v1");
  const docId = up.docId;
  const granted = await share(target, { owner, doc: docId, account: viewerAcct, role: "viewer" });
  assert.ok(granted.members.includes(viewerAcct.email), `members: ${JSON.stringify(granted.members)}`);
  if (target.kind === "local") assert.deepEqual({ presence: granted.mirror.presence, edit: granted.mirror.edit }, { presence: true, edit: false }, "RTDB mirror for a viewer");

  ctx.step("both sign in at /signup in their own browser contexts and open the document");
  const [o, v] = await Promise.all([ctx.users.user({ name: "owner" }), ctx.users.user({ name: "viewer" })]);
  const signed = await Promise.all([o.signInUi(accounts[0].email, accounts[0].password), v.signInUi(viewerAcct.email, viewerAcct.password)]);
  for (const s of signed) assert.deepEqual([s.status, s.already], ["ok", false]);
  await Promise.all([o.open(docId), v.open(docId)]);
  assert.match(await frameText(await v.frame()), /A link shortener/, "the viewer's frame shows the document");

  ctx.step(`the viewer drags over "${QUOTE}", presses Comment and sends from the reply box`);
  const sel = await v.selectText("#s-summary .lede", QUOTE);
  assert.deepEqual({ via: sel.via, text: sel.text }, { via: "drag", text: QUOTE }, "a real mouse drag selected exactly the passage");
  const body = `Smoke comment ${runTag(target.runId)}-${rand4()}`;
  const made = await v.comment(body);
  assert.ok(made.quote?.includes(QUOTE), `the thread quotes the passage (got ${JSON.stringify(made.quote)})`);
  await eventually(async () => (await (await v.frame()).locator("mark.bshd-hl").count()) >= 1, { timeout: 10_000, message: "the viewer's frame highlights the passage" });

  ctx.step("the stored annotation and comment are the viewer's, on v1, from the web channel");
  const anns = await eventually(async () => {
    const rows = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
    return rows.length === 1 ? rows : false;
  }, { timeout: 10_000, message: "exactly one annotation on v1" });
  const ann = anns[0].data;
  assert.deepEqual(Object.keys(ann).sort(), ANNOTATION_KEYS, "annotation keys (A6.1)");
  assert.deepEqual(
    { exact: ann.anchor.exact, authorEmail: ann.authorEmail, authorUid: ann.authorUid, actor: ann.actor, resolved: ann.resolved },
    { exact: QUOTE, authorEmail: viewerAcct.email, authorUid: viewerAcct.uid, actor: { uid: viewerAcct.uid, email: viewerAcct.email, channel: "web" }, resolved: false },
  );
  const comments = await readCollection(target, `docs/${docId}/versions/v1/annotations/${anns[0].id}/comments`);
  assert.deepEqual(comments.map((c) => ({ body: c.data.body, authorEmail: c.data.authorEmail })), [{ body, authorEmail: viewerAcct.email }]);

  ctx.step("the owner, who had the document open already, opens the comments panel and sees the thread and its highlight");
  await o.openComments();
  await o.thread(QUOTE).first().locator(".comment-body", { hasText: body }).waitFor({ state: "visible", timeout: 15_000 });
  await eventually(async () => (await (await o.frame()).locator("mark.bshd-hl").count()) >= 1, { timeout: 10_000, message: "the owner's frame highlights the passage" });
  noPageErrors([o, v]);
});

// --- 2 and 2b ---------------------------------------------------------------

/** What scenario 2 leaves for 2b: the BODYATTR comparison of v1 and the saved version. */
const live = { bodyAttr: null, versionId: null };

scenario("smoke: owner and editor live-edit different paragraphs, converge, and Save as new version stores clean bytes (DECOR, REHASH)", { timeoutMs: 240_000 }, async (ctx) => {
  ctx.step("cast an owner and an editor; the owner publishes the paragraphs fixture and shares it for editing");
  const { owner, accounts } = await castWithOwner(["editor"]);
  const editorAcct = accounts[1];
  const fixture = readFixture("crdt-paragraphs.html", { raw: true });
  const up = await publish(owner.http, { fixture: "crdt-paragraphs.html", title: "Smoke live edit", name: "live-edit" });
  const docId = up.docId;
  const granted = await share(target, { owner, doc: docId, account: editorAcct, role: "editor" });
  if (target.kind === "local") assert.deepEqual({ presence: granted.mirror.presence, edit: granted.mirror.edit }, { presence: true, edit: true }, "RTDB mirror for an editor");

  ctx.step("both sign in through the UI, open the document and enter edit mode until the toolbar says Shared");
  const [o, e] = await Promise.all([ctx.users.user({ name: "owner" }), ctx.users.user({ name: "editor" })]);
  await Promise.all([o.signInUi(accounts[0].email, accounts[0].password), e.signInUi(editorAcct.email, editorAcct.password)]);
  await Promise.all([o.open(docId), e.open(docId)]);
  const reading = await o.frame();
  const p1 = await reading.locator("#e2e-1").textContent();
  const p2 = await reading.locator("#e2e-2").textContent();
  for (const u of [o, e]) {
    const { share: state } = await u.enterEdit({ waitShared: true });
    assert.equal(state, "shared", `${u.name} joined the live session`);
  }

  const tag = runTag(target.runId);
  const tokO = `⟦r${tag}-o-0001⟧`;
  const tokE = `⟦r${tag}-e-0001⟧`;
  ctx.step(`at the same time, the owner types ${tokO} at the end of #e2e-1 and the editor types ${tokE} at the end of #e2e-2`);
  await Promise.all([o.typeInFrame("#e2e-1", tokO, { delay: 20 }), e.typeInFrame("#e2e-2", tokE, { delay: 20 })]);

  ctx.step("I2: on both peers each token is in its own paragraph, once and whole");
  for (const u of [o, e]) {
    await eventually(async () => {
      const f = await u.frame();
      const [a, b] = [await f.locator("#e2e-1").textContent(), await f.locator("#e2e-2").textContent()];
      if (a !== p1 + tokO || b !== p2 + tokE) throw new Error(`${u.name}: #e2e-1=${JSON.stringify(a.slice(-40))} #e2e-2=${JSON.stringify(b.slice(-40))}`);
      return true;
    }, { timeout: SETTLE_N2_MS, interval: 100, message: `${u.name} holds both tokens in place` });
  }

  ctx.step("I1: both frames' body.innerHTML hashes are equal on 3 consecutive samples, and neither editor has unsaved work");
  const converged = await eventually(async () => {
    const [a, b] = await Promise.all([bodyHash(await o.frame()), bodyHash(await e.frame())]);
    if (a.hash !== b.hash) throw new Error(`hashes differ: ${a.hash.slice(0, 12)} (${a.length}) vs ${b.hash.slice(0, 12)} (${b.length})`);
    return a.hash;
  }, { timeout: SETTLE_N2_MS, interval: 250, stableSamples: 3, message: "I1 convergence" });
  ctx.step(`converged on ${converged.slice(0, 16)}`);
  await eventually(async () => {
    const states = await Promise.all([o.saveState(), e.saveState()]);
    if (states.some((s) => s === "dirty" || s === "saving" || s === "error")) throw new Error(`save states ${JSON.stringify(states)}`);
    return states;
  }, { timeout: 20_000, interval: 1000, stableSamples: 3, message: "both editors settled" });

  ctx.step("the owner presses Save as new version");
  const commit = await o.saveAsNewVersion();
  assert.equal(commit.outcome, "published", `commit toast: ${commit.text}`);
  assert.equal(commit.versionId, "v2");

  ctx.step("download v1 and v2 as the owner; REHASH both; fingerprint both with Chrome's DOMParser");
  const [s1, s2] = await Promise.all([storedVersion(owner.http, docId, "v1"), storedVersion(owner.http, docId, "v2")]);
  assert.equal(sha(Buffer.from(s1.html)), sha(fixture), "v1's stored bytes are the upload's");
  assert.equal(s1.rehash, s1.record.contentHash, "REHASH v1");
  assert.equal(s2.rehash, s2.record.contentHash, "REHASH v2");
  assert.deepEqual({ parentVersion: s2.record.parentVersion, publishedVia: s2.record.publishedVia }, { parentVersion: "v1", publishedVia: "editor" });
  const parser = await ctx.users.parser();
  const fp1 = await fingerprint(parser, s1.html);
  const fp2 = await fingerprint(parser, s2.html);
  ctx.ev.json("fingerprints", { v1: summarize(fp1), v2: summarize(fp2) });
  ctx.ev.text("v2.html", s2.html);

  ctx.step("DECOR: no decoration, nothing of the author's lost, the same structure, and the only text change is the two tokens");
  const diff = diffFingerprint(fp1, fp2, { contains: [tokO, tokE] }, { ignoreBodyAttr: true });
  assert.deepEqual(diff.decoration, [], "DECOR: decoration in v2");
  assert.deepEqual(diff.lost, [], "DECOR: lost author markers");
  assert.deepEqual(diff.structure, [], "DECOR: structure changed");
  assert.equal(diff.text.allowed, true, "the text change is exactly the two tokens");
  for (const [id, tok] of [["e2e-1", tokO], ["e2e-2", tokE]]) {
    const at = s2.html.indexOf(`id="${id}"`);
    const para = s2.html.slice(at, s2.html.indexOf("</p>", at));
    assert.ok(at >= 0 && para.includes(tok) && s2.html.split(tok).length === 2, `v2 holds ${tok} once, inside #${id}`);
  }

  live.bodyAttr = bodyAttrDiff(fp1, fp2);
  live.versionId = commit.versionId;
  ctx.ev.json("bodyattr", live.bodyAttr);
  ctx.t.diagnostic(`BODYATTR v1→v2: ${JSON.stringify({ body: live.bodyAttr.body, html: live.bodyAttr.html })}`);
  assert.equal(live.bodyAttr.equal, true, `BODYATTR: saved root attributes differ from the author: ${JSON.stringify(live.bodyAttr)}`);
  noPageErrors([o, e]);
});

scenario("smoke: the saved version's <html> and <body> attributes equal v1's (BODYATTR)", { timeoutMs: 30_000 }, async (ctx) => {
  precondition(live.bodyAttr, "the live-edit scenario did not save a version, so there is nothing to compare");
  ctx.step(`BODYATTR v1→${live.versionId}: ${JSON.stringify(live.bodyAttr)}`);
  assert.equal(live.bodyAttr.equal, true, `BODYATTR: ${JSON.stringify({ body: live.bodyAttr.body, html: live.bodyAttr.html })}`);
});

// --- 3 ----------------------------------------------------------------------

scenario("smoke: MCP with a minted token: initialize, exactly 23 tools, get_document returns the stored source", { timeoutMs: 60_000 }, async (ctx) => {
  const { owner } = await castWithOwner([]);
  const bytes = readFixture("foreign-marker.html", { raw: true });
  const title = "Smoke MCP read";
  const up = await publish(owner.http, { fixture: "foreign-marker.html", title, name: "mcp-read" });

  ctx.step("mint an mcp token with the owner's session, initialize, list the tools");
  const { token } = await mintToken(owner, { name: "e2e smoke mcp", channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: "owner-mcp" });
  const init = await mcp.initialize();
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal(mcp.serverVersion, target.expectVersion, "serverInfo.version is the tree's");
  const tools = await mcp.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 23, names.join(", "));
  assert.equal(new Set(names).size, 23, "tool names are unique");
  for (const n of names) assert.doesNotMatch(n, /delete|remove|share|grant|access/, "no destructive or sharing tool");

  ctx.step("get_document on the published document");
  const doc = await mcp.ok("get_document", { id: up.docId });
  assert.deepEqual(
    { id: doc.id, title: doc.title, version: doc.version, format: doc.format, canEdit: doc.canEdit, truncated: doc.truncated },
    { id: up.docId, title, version: "v1", format: "html", canEdit: true, truncated: false },
  );
  assert.equal(sha(Buffer.from(doc.source)), sha(bytes), "the source is the uploaded bytes");
});

// --- 4 ----------------------------------------------------------------------

scenario("smoke: the CLI's list --json, run against the stack with a minted token, lists the owner's document", { timeoutMs: 60_000 }, async (ctx) => {
  const { owner } = await castWithOwner([]);
  const title = "Smoke CLI list";
  const up = await publish(owner.http, { fixture: "crdt-paragraphs.html", title, name: "cli-list" });
  const { token } = await mintToken(owner, { name: "e2e smoke cli", channel: "cli" });

  ctx.step("bikeshed list --json, with BIKESHED_ORIGIN forced to the stack");
  const r = await runCli(target, ["list", "--json"], { token });
  assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
  assert.ok(r.json && Array.isArray(r.json.documents), `stdout is the JSON listing: ${r.stdout.slice(0, 300)}`);
  assert.deepEqual(
    r.json.documents.map((d) => ({ id: d.id, version: d.version, title: d.title })),
    [{ id: up.docId, version: "v1", title }],
    "a new owner's listing is exactly the one document",
  );
  assert.deepEqual(r.opened, [], "the CLI opened no browser");
});

// --- 5 ----------------------------------------------------------------------

scenario("smoke: sharing with a new address sends exactly one invitation, with the product's subject and link", {
  effects: ["email:POST /access"],
  needs: ["email", "mailpit"],
  timeoutMs: 90_000,
}, async (ctx) => {
  const { owner } = await castWithOwner([]);
  const title = `Smoke invitation ${runTag(target.runId)}-${rand4()}`;
  const up = await publish(owner.http, { fixture: "crdt-paragraphs.html", title, name: "invite" });
  const invitee = localEmail(target, "invitee");
  const box = mailbox(target);
  assert.deepEqual(await box.find({ to: invitee }), [], "nothing for the new address before the share");

  ctx.step(`the owner shares with ${invitee}, who has never signed up, through POST /access`);
  const granted = await share(target, { owner, doc: up.docId, account: invitee, role: "viewer" });
  assert.equal(granted.status, 200);
  assert.ok(granted.members.includes(invitee), `members: ${JSON.stringify(granted.members)}`);

  ctx.step("exactly one message reaches Mailpit for that address, and the count holds for 10 s");
  const { messages, waitedMs } = await box.expectMail({ to: invitee, count: 1 });
  ctx.step(`one message after ${waitedMs} ms`);
  const subject = `${owner.account.email} shared “${title}” with you`;
  assert.equal(messages[0].Subject, subject, "the subject notify.ts writes");
  const full = await box.message(messages[0].ID);
  assert.ok(String(full.Text).includes(`${target.origin}/d/${up.docId}`), `the text part links to the document on this origin: ${String(full.Text).slice(0, 400)}`);
  assert.deepEqual(await box.find({ to: owner.account.email }), [], "the person sharing is not invited");
});
