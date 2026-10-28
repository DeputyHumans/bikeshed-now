// SPDX-License-Identifier: Apache-2.0
// A25 Folder links: a folder's link or public level opens everything beneath it, to read, and nothing else (SPEC §13, §17; ADR 0019).

/**
 * Catalogue A25.1–A25.4, each case with its own accounts, folders and documents.
 *
 *   A25.1  HTTP: a folder made unlisted opens a private document two levels
 *          down: /unlock in both forms, the bytes cacheable at the keyed URL
 *          and noindex, the folder's /folder/** shell named and noindex; every
 *          refusal is the one empty 404 or the generic no-store shell; a
 *          signed-in stranger gets no link grant and cannot write
 *   A25.2  rotation (private, then unlisted) kills the old key on every
 *          surface at once, and a document moved out stops answering to it
 *   A25.3  a folder's date ends its link and nothing else: the key holder is
 *          told it ended, the owner still reads, the document is not frozen
 *   A25.4  the browser: a signed-out visitor opens the folder link, steps into
 *          a document, and is offered no comments
 *
 * Local only. Every case opens a folder to strangers, and the window registry
 * in lib/grant.mjs tracks documents, not folders, so each case closes its own
 * folder in a `finally` rather than leaving one open on a shared target.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { createFolder, publish } from "../../lib/seed.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { cacheControl, eventually, sameHeadersExceptDate } from "../../lib/assert.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const LOCAL = { tiers: ["local"], inconclusiveOnStackTimeout: true };
const NO_STORE = "private, no-store";

async function castSessions(roles) {
  const accounts = await cast(target, roles);
  return Promise.all(accounts.map((a) => openSession(target, a)));
}

function page(title) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n<h1>${title}</h1>\n<p id="a25-p">Two weekends, and the shed is done.</p>\n</body>\n</html>\n`;
}

/** Top › Sub, and a private document in Sub, all the owner's. */
async function tree(owner, name) {
  const tag = `${runTag(target.runId)}-${rand4()}`;
  const top = await createFolder(owner.http, { name: `A25 top ${tag}` });
  const sub = await createFolder(owner.http, { name: `A25 sub ${tag}`, parentId: top.folderId });
  precondition(top.folderId && sub.folderId, `folders: ${top.status} ${sub.status}`);
  const title = `A25 ${name} ${tag}`;
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, folderId: sub.folderId, name: `a25-${name}` });
  precondition(doc.versionId === "v1", `publish: ${doc.status} ${JSON.stringify(doc.json)}`);
  return { top, sub, doc, title };
}

/** POST /visibility for a folder, as its owner. */
async function folderLevel(owner, folderId, visibility, expiresAt = null) {
  const r = await owner.http.postJson("/visibility", { folderId, visibility, expiresAt });
  precondition(r.status === 200, `POST /visibility ${folderId} ${visibility}: ${r.status} ${r.text?.slice(0, 200)}`);
  return r.json;
}

/** Run `fn`, then make the folder private whatever happened. */
async function closing(owner, folderId, fn) {
  try {
    return await fn();
  } finally {
    await owner.http.postJson("/visibility", { folderId, visibility: "private", expiresAt: null }).catch(() => undefined);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const keyed = (k, docId, v = "v1") => `/content/~${encodeURIComponent(k)}/${encodeURIComponent(docId)}/${v}/`;

// --- A25.1 ------------------------------------------------------------------------

scenario("A25.1 a folder link opens a private document two levels down, to read: /unlock in both forms, keyed bytes cacheable and noindex, the folder shell named; every refusal alike; a signed-in stranger gets no grant and cannot write", { ...LOCAL, timeoutMs: 300_000 }, async (ctx) => {
  const [owner, stranger] = await castSessions(["owner", "stranger"]);
  const anon = ctx.http({ actor: "anon" });
  const { top, sub, doc, title } = await tree(owner, "read");

  await closing(owner, top.folderId, async () => {
    const k = (await folderLevel(owner, top.folderId, "unlisted")).linkToken;
    precondition(typeof k === "string" && k.length >= 22, `link token: ${k}`);

    ctx.step("the folder form of /unlock lists the subfolder's document, its path starting at the shared folder");
    const level = await anon.postJson("/unlock", { folderId: sub.folderId, k });
    assert.equal(level.status, 200);
    assert.equal(level.headers.get("cache-control"), NO_STORE);
    assert.deepEqual(level.json.path.map((p) => p.folderId), [top.folderId, sub.folderId]);
    assert.deepEqual(level.json.documents.map((d) => d.docId), [doc.docId]);
    assert.ok(!level.text.includes(owner.account.email), "the listing names nobody");

    ctx.step("the document form: the reader projection, marked viaFolder and read-only");
    const reader = await anon.postJson("/unlock", { docId: doc.docId, k });
    assert.equal(reader.status, 200);
    assert.deepEqual([reader.json.viaFolder, reader.json.visibility, reader.json.publicEdit], [true, "unlisted", false]);

    ctx.step("the bytes at the keyed URL: public max-age=300 and noindex");
    const bytes = await anon.get(keyed(k, doc.docId));
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get("cache-control"), "public, max-age=300");
    assert.equal(bytes.headers.get("x-robots-tag"), "noindex");
    assert.ok(bytes.text.includes(title));

    ctx.step("the folder's page names it for a pasted link, noindex; a wrong key is the generic shell, no-store");
    const shell = await anon.get(`/folder/${top.folderId}`, { query: { k } });
    assert.equal(shell.status, 200);
    assert.match(shell.text, new RegExp(`<title>${escapeRe(top.name)}</title>`));
    assert.equal(shell.headers.get("x-robots-tag"), "noindex");
    assert.match(String(shell.headers.get("cache-control")), /^public, max-age=\d+$/);
    const generic = await anon.get(`/folder/${top.folderId}`, { query: { k: "not-the-key" } });
    const absentShell = await anon.get("/folder/a25-no-such-folder");
    for (const [label, r] of [["wrong key", generic], ["absent", absentShell]]) {
      assert.equal(r.headers.get("cache-control"), NO_STORE, `${label}: no-store`);
      assert.equal(r.headers.get("x-robots-tag"), null, `${label}: no robots header`);
      assert.ok(!r.text.includes(top.name), `${label}: names nothing`);
    }

    ctx.step("refusals are one empty 404, alike");
    const absent = await anon.postJson("/unlock", { docId: "a25-no-such-doc" });
    for (const [label, r] of [
      ["doc, no key", await anon.postJson("/unlock", { docId: doc.docId })],
      ["doc, wrong key", await anon.postJson("/unlock", { docId: doc.docId, k: "not-the-key" })],
      ["folder, wrong key", await anon.postJson("/unlock", { folderId: sub.folderId, k: "not-the-key" })],
      ["bytes, no key", await anon.get(`/content/${doc.docId}/v1/`)],
    ]) {
      assert.equal(r.status, 404, `${label}: status`);
      assert.equal(r.buffer.length, 0, `${label}: empty`);
      if (label !== "bytes, no key") {
        const same = sameHeadersExceptDate(r, absent);
        assert.ok(same.equal, `${label}: headers differ from an absent id's: ${JSON.stringify(same.diff)}`);
      }
    }

    ctx.step("a signed-in stranger with the key: read, no grant, no write");
    assert.equal((await stranger.http.postJson("/unlock", { docId: doc.docId, k })).status, 200);
    assert.deepEqual(await readCollection(target, `docs/${doc.docId}/linkGrants`), [], "a folder's key never grants");
    const suggestion = await stranger.http.postJson("/suggestion", {
      op: "create", docId: doc.docId, versionId: "v1", k,
      anchor: { exact: "Two weekends", prefix: "", suffix: "" }, replacement: "Three weekends",
    });
    assert.equal(suggestion.status, 404, "a suggestion through a folder's key");
    const { token } = await mintToken(stranger, { name: "e2e a25 stranger", channel: "mcp" });
    const mcp = ctx.mcp({ actor: "stranger-mcp", token });
    await mcp.initialize();
    const read = await mcp.call("get_document", { id: doc.docId, k });
    assert.equal(read.isError, false, read.text);
    assert.equal(read.json.viaFolder, true);
    const comment = await mcp.call("add_comment", { id: doc.docId, k, exact: "Two weekends", body: "?" });
    assert.equal(comment.isError, true);
    assert.match(comment.text, /through a folder's link, which lets you read it and nothing else/);
  });
});

// --- A25.2 ------------------------------------------------------------------------

scenario("A25.2 rotating a folder's link kills the old key on every surface at once, and a document moved out stops answering to the new one", { ...LOCAL, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const anon = ctx.http({ actor: "anon" });
  const { top, sub, doc } = await tree(owner, "rotate");

  await closing(owner, top.folderId, async () => {
    const old = (await folderLevel(owner, top.folderId, "unlisted")).linkToken;
    assert.equal((await anon.postJson("/unlock", { docId: doc.docId, k: old })).status, 200, "the first key reads");

    ctx.step("private, then unlisted again");
    await folderLevel(owner, top.folderId, "private");
    const fresh = (await folderLevel(owner, top.folderId, "unlisted")).linkToken;
    assert.notEqual(fresh, old);
    for (const [label, r] of [
      ["unlock doc", await anon.postJson("/unlock", { docId: doc.docId, k: old })],
      ["unlock folder", await anon.postJson("/unlock", { folderId: sub.folderId, k: old })],
      ["bytes", await anon.get(keyed(old, doc.docId))],
    ]) assert.equal(r.status, 404, `old key, ${label}`);
    const shell = await anon.get(`/folder/${top.folderId}`, { query: { k: old } });
    assert.equal(shell.headers.get("cache-control"), NO_STORE, "old key, folder shell: generic");
    assert.equal((await anon.postJson("/unlock", { docId: doc.docId, k: fresh })).status, 200, "the new key reads");

    ctx.step("moved to the root, the document no longer answers to the folder's key");
    const moved = await owner.http.postJson("/organize", { kind: "doc", id: doc.docId, op: "move", targetFolderId: null });
    precondition(moved.status === 200, `move: ${moved.status}`);
    assert.equal((await anon.postJson("/unlock", { docId: doc.docId, k: fresh })).status, 404);
  });
});

// --- A25.3 ------------------------------------------------------------------------

scenario("A25.3 a folder's date ends its link and nothing else: the key holder is told it ended, the owner still reads and edits", { ...LOCAL, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const anon = ctx.http({ actor: "anon" });
  const { top, sub, doc } = await tree(owner, "expire");

  await closing(owner, top.folderId, async () => {
    const endsAt = Date.now() + 8_000;
    const k = (await folderLevel(owner, top.folderId, "unlisted", endsAt)).linkToken;
    const early = await anon.get(keyed(k, doc.docId));
    assert.equal(early.status, 200);
    const maxAge = cacheControl(String(early.headers.get("cache-control"))).maxAge;
    assert.ok(maxAge !== null && maxAge <= 9, `max-age ${maxAge} outlives the link`);

    ctx.step("after the date: the key is refused, the folder says it ended");
    await eventually(async () => (await anon.postJson("/unlock", { docId: doc.docId, k })).status === 404, { timeout: 30_000, message: "the link ends at its date" });
    const told = await anon.postJson("/unlock", { folderId: sub.folderId, k });
    assert.deepEqual([told.status, told.json?.expired, told.json?.documents], [200, true, undefined]);

    ctx.step("the owner reads the bytes, and the document carries no expiry of its own");
    const own = await owner.http.get(`/content/${doc.docId}/v1/`);
    assert.deepEqual([own.status, own.headers.get("cache-control")], [200, NO_STORE]);
    const record = await readDoc(target, `docs/${doc.docId}`);
    assert.equal(record?.expiresAt, undefined, "the folder's date froze nothing beneath it");
  });
});

// --- A25.4 ------------------------------------------------------------------------

scenario("A25.4 a signed-out visitor opens a folder's link, steps into a document through it, and is offered no comments", { ...LOCAL, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const { top, sub, doc, title } = await tree(owner, "browse");

  await closing(owner, top.folderId, async () => {
    const k = (await folderLevel(owner, top.folderId, "unlisted")).linkToken;

    ctx.step("the folder page: the shared folder's crumb, the document card, every link keyed");
    const a = await ctx.users.user({ name: "anon" });
    await a.goto(`/folder/${sub.folderId}?k=${encodeURIComponent(k)}`);
    await a.page.getByRole("heading", { name: sub.name }).waitFor({ timeout: 45_000 });
    const card = a.page.getByRole("link", { name: title });
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute("href"), `/d/${doc.docId}?k=${encodeURIComponent(k)}`);
    assert.equal(await a.page.getByRole("link", { name: top.name }).getAttribute("href"), `/folder/${top.folderId}?k=${encodeURIComponent(k)}`);
    assert.equal(await a.page.getByRole("button", { name: /actions/i }).count(), 0, "nothing to change");

    ctx.step("into the document: it renders, and there is nothing to comment with");
    await card.click();
    await a.page.waitForURL((url) => url.pathname === `/d/${doc.docId}`);
    const frame = await a.waitForFrame({ timeout: 45_000 });
    ctx.ev.json("frame", frame);
    await eventually(
      () => a.page.evaluate(() => Boolean(document.querySelector("iframe.doc-frame")?.contentDocument?.getElementById("a25-p"))),
      { timeout: 20_000, message: "the document's text is in the frame" },
    );
    assert.equal(await a.page.getByRole("button", { name: /^comments$/i }).count(), 0, "no comments toggle for a folder's reader");
  });
});
