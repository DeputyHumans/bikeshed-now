// SPDX-License-Identifier: Apache-2.0
// A26 the Trash: a trashed document is its owner's alone and frozen, every way in, and Restore gives it all back (SPEC §4, ADR 0024).

/**
 * Cases
 *   A26.1  every way into a trashed document is refused as for an absent id,
 *          and Restore opens each one again
 *   A26.2  nobody writes it, its owner included, and nothing changes
 *   A26.3  a team change while it is trashed hands it to nobody
 *   A26.4  its owner reads it under a banner with Restore and no Edit
 *   A26.5  someone else's document that went with a folder is in their Trash,
 *          and comes back at their root
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { createFolder, createTeam, publish } from "../../lib/seed.mjs";
import { setVisibility, share } from "../../lib/grant.mjs";
import { closeAdmin, readDoc } from "../../lib/admin.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { eventually } from "../../lib/assert.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const LOCAL = { tiers: ["local"], inconclusiveOnStackTimeout: true };
const TRASHED_WRITE = "this document is in the Trash — restore it to edit it";

async function castSessions(roles) {
  const accounts = await cast(target, roles);
  return Promise.all(accounts.map((a) => openSession(target, a)));
}

function page(title, words = "Two weekends, and the shed is done.") {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n<h1>${title}</h1>\n<p>${words}</p>\n</body>\n</html>\n`;
}

const tagged = (name) => `A26 ${name} ${runTag(target.runId)}-${rand4()}`;

async function organize(session, body, what) {
  const r = await session.http.postJson("/organize", body);
  precondition(r.status === 200, `${what}: ${r.status} ${r.text?.slice(0, 200)}`);
  return r.json;
}

async function mcpAs(ctx, session, actor) {
  const { token } = await mintToken(session, { name: `e2e a26 ${actor}`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: `${actor}-mcp` });
  await mcp.initialize();
  return mcp;
}

// --- A26.1 ------------------------------------------------------------------------

scenario("A26.1 a document in the Trash is its owner's alone: a viewer, its key, a link grant, a folder's link, MCP and a direct Firestore read are each refused as for an absent id, and Restore opens every one again", { ...LOCAL, timeoutMs: 300_000 }, async (ctx) => {
  const [owner, viewer, holder] = await castSessions(["owner", "viewer", "holder"]);
  const anon = ctx.http({ actor: "anon" });
  const top = await createFolder(owner.http, { name: tagged("top") });
  const sub = await createFolder(owner.http, { name: tagged("sub"), parentId: top.folderId });
  const title = tagged("gates");
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, folderId: sub.folderId, name: "a26-gates" });
  precondition(doc.versionId === "v1", `publish: ${doc.status}`);
  await share(target, { owner, doc: doc.docId, account: viewer.account, role: "viewer" });
  const k = (await setVisibility(target, { owner, doc: doc.docId, visibility: "unlisted" })).linkToken;
  precondition((await holder.http.postJson("/unlock", { docId: doc.docId, k })).status === 200, "the holder takes a link grant with the key");
  const fk = (await owner.http.postJson("/visibility", { folderId: top.folderId, visibility: "unlisted" })).json?.linkToken;
  precondition(typeof fk === "string", "the top folder has a link");
  const mcp = await mcpAs(ctx, viewer, "viewer");
  const fs = clientFirestore(target, { idToken: viewer.idToken, http: ctx.http({ actor: "viewer-fs" }) });
  const content = `/content/${doc.docId}/v1/index.html`;

  const ways = async () => ({
    owner: (await owner.http.get(content)).status,
    viewer: (await viewer.http.get(content)).status,
    key: (await anon.postJson("/unlock", { docId: doc.docId, k })).status,
    grant: (await holder.http.get(content)).status,
    folderLink: ((await anon.postJson("/unlock", { folderId: sub.folderId, k: fk })).json?.documents ?? []).some((d) => d.docId === doc.docId),
    mcp: (await mcp.call("get_document", { id: doc.docId })).isError,
    firestore: (await fs.get(`docs/${doc.docId}`)).verdict,
  });

  const before = await ways();
  precondition(
    JSON.stringify(before) === JSON.stringify({ owner: 200, viewer: 200, key: 200, grant: 200, folderLink: true, mcp: false, firestore: "ALLOW" }),
    `every way in works before it is trashed: ${JSON.stringify(before)}`,
  );

  ctx.step("the owner moves it to the Trash");
  await organize(owner, { kind: "doc", id: doc.docId, op: "trash" }, "trash");
  assert.deepEqual(await ways(), { owner: 200, viewer: 404, key: 404, grant: 404, folderLink: false, mcp: true, firestore: "DENY" }, "in the Trash: its owner's alone, every other way in refused");
  const absent = await mcp.call("get_document", { id: doc.docId });
  assert.equal(absent.text, `no document with id "${doc.docId}"`, "MCP answers as for an absent id");

  ctx.step("Restore opens every way in again");
  await organize(owner, { kind: "doc", id: doc.docId, op: "restore" }, "restore");
  assert.deepEqual(await ways(), before, "restored: every way in works again");
  await owner.http.postJson("/visibility", { folderId: top.folderId, visibility: "private" });
});

// --- A26.2 ------------------------------------------------------------------------

scenario("A26.2 in the Trash nobody writes, its owner included: a draft, a share, visibility, trust and an MCP update are each refused with the Trash's 409, and nothing changes", { ...LOCAL, timeoutMs: 240_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const title = tagged("frozen");
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, name: "a26-frozen" });
  precondition(doc.versionId === "v1", `publish: ${doc.status}`);
  const mcp = await mcpAs(ctx, owner, "owner");
  await organize(owner, { kind: "doc", id: doc.docId, op: "trash" }, "trash");
  const before = await readDoc(target, `docs/${doc.docId}`);

  const answers = await Promise.all([
    owner.http.postJson("/draft", { docId: doc.docId, baseVersion: "v1", html: page(title, "Edited in the Trash.") }),
    owner.http.postJson("/access", { docId: doc.docId, add: [{ email: `a26-${rand4()}@example.com`, role: "viewer" }] }),
    owner.http.postJson("/visibility", { docId: doc.docId, visibility: "public" }),
    owner.http.postJson("/trust", { docId: doc.docId, trusted: false }),
  ]);
  const update = await mcp.call("update_document", { id: doc.docId, content: "# Edited by an agent in the Trash" });
  assert.deepEqual(
    { http: answers.map((r) => [r.status, r.json?.error]), mcp: [update.isError, update.text] },
    { http: Array(4).fill([409, TRASHED_WRITE]), mcp: [true, TRASHED_WRITE] },
  );
  const after = await readDoc(target, `docs/${doc.docId}`);
  assert.deepEqual(
    { version: after.currentVersion, visibility: after.visibility ?? "private", members: after.members, draft: after.draft ?? null },
    { version: before.currentVersion, visibility: before.visibility ?? "private", members: before.members, draft: before.draft ?? null },
    "nothing changed",
  );
});

// --- A26.3 ------------------------------------------------------------------------

scenario("A26.3 a team change while a document is in the Trash hands it to nobody, and Restore gives the team its access", { ...LOCAL, timeoutMs: 240_000 }, async (ctx) => {
  const [owner, member] = await castSessions(["owner", "member"]);
  const title = tagged("team");
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, name: "a26-team" });
  const team = await createTeam(owner.http, { name: tagged("team") });
  precondition(doc.versionId === "v1" && team.teamId, `setup: ${doc.status} ${team.status}`);
  const mcp = await mcpAs(ctx, owner, "owner");
  const granted = await mcp.call("set_document_access", { id: doc.docId, add: [{ principal: `team:${team.teamId}`, role: "viewer" }] });
  precondition(!granted.isError, `the team is a viewer: ${granted.text}`);
  await organize(owner, { kind: "doc", id: doc.docId, op: "trash" }, "trash");

  ctx.step("the member joins the team while the document is in the Trash");
  const joined = await owner.http.postJson("/team-members", { teamId: team.teamId, add: [member.account.email] });
  precondition(joined.status === 200, `POST /team-members: ${joined.status}`);
  const content = `/content/${doc.docId}/v1/index.html`;
  const trashed = await readDoc(target, `docs/${doc.docId}`);
  assert.deepEqual({ members: trashed.members, read: (await member.http.get(content)).status }, { members: [owner.account.email.toLowerCase()], read: 404 }, "the team's re-fan gave the trashed document to nobody");

  await organize(owner, { kind: "doc", id: doc.docId, op: "restore" }, "restore");
  assert.equal((await member.http.get(content)).status, 200, "restored: the team's new member reads it");
});

// --- A26.4 ------------------------------------------------------------------------

scenario("A26.4 its owner reads a trashed document under a banner with Restore and no Edit, and Restore from the banner brings it back", { ...LOCAL, timeoutMs: 300_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const title = tagged("banner");
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, name: "a26-banner" });
  precondition(doc.versionId === "v1", `publish: ${doc.status}`);
  await organize(owner, { kind: "doc", id: doc.docId, op: "trash" }, "trash");

  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(owner.account.email, owner.account.password);
  await u.open(doc.docId);
  const banner = u.page.locator(".banner").filter({ hasText: "This document is in your Trash." });
  await banner.waitFor({ timeout: 60_000 });
  const toolbar = u.page.locator(".viewer-toolbar");
  assert.deepEqual(
    { edit: await toolbar.getByRole("button", { name: /^Edit/ }).count(), share: await toolbar.getByRole("button", { name: /^Share/ }).count() },
    { edit: 0, share: 0 },
    "no Edit and no Share while it is in the Trash",
  );
  await banner.getByRole("button", { name: "Restore" }).click();
  await eventually(async () => (await readDoc(target, `docs/${doc.docId}`))?.trashed === null, { timeout: 60_000, message: "the record is restored" });
  await banner.waitFor({ state: "detached", timeout: 60_000 });
  await toolbar.getByRole("button", { name: /^Edit/ }).first().waitFor({ timeout: 60_000 });
});

// --- A26.5 ------------------------------------------------------------------------

scenario("A26.5 someone else's document that went with a folder is in their Trash, not the folder owner's, and comes back at their root while the folder stays in the Trash", { ...LOCAL, timeoutMs: 300_000 }, async (ctx) => {
  const [owner, other] = await castSessions(["owner", "other"]);
  const folder = await createFolder(owner.http, { name: tagged("shared") });
  const ownerMcp = await mcpAs(ctx, owner, "owner");
  const otherMcp = await mcpAs(ctx, other, "other");
  const shared = await ownerMcp.call("set_folder_access", { id: folder.folderId, add: [{ principal: other.account.email, role: "editor" }] });
  precondition(!shared.isError, `the other account edits the folder: ${shared.text}`);
  const theirs = await publish(other.http, { body: page(tagged("theirs")), filename: "index.html", title: tagged("theirs"), folderId: folder.folderId, name: "a26-theirs" });
  const mine = await publish(owner.http, { body: page(tagged("mine")), filename: "index.html", title: tagged("mine"), folderId: folder.folderId, name: "a26-mine" });
  precondition(theirs.versionId === "v1" && mine.versionId === "v1", "both documents published into the folder");

  ctx.step("the folder's owner moves it to the Trash, with both documents");
  const trashed = await ownerMcp.call("delete_folder", { id: folder.folderId });
  precondition(!trashed.isError, `delete_folder: ${trashed.text}`);
  const [ownerTrash, otherTrash] = await Promise.all([ownerMcp.call("list_trash", {}), otherMcp.call("list_trash", {})]);
  assert.deepEqual(
    { owner: ownerTrash.json.documents.map((d) => d.id), other: otherTrash.json.documents.map((d) => [d.id, d.with?.folderId]), theirs: (await other.http.get(`/content/${theirs.docId}/v1/index.html`)).status, byOwner: (await owner.http.get(`/content/${theirs.docId}/v1/index.html`)).status },
    { owner: [mine.docId], other: [[theirs.docId, folder.folderId]], theirs: 200, byOwner: 404 },
    "each owner's Trash holds their own; the folder's owner cannot read the other's",
  );

  ctx.step("the other owner restores theirs: it comes back at their root, while the folder stays in the Trash");
  const back = await otherMcp.call("restore_from_trash", { id: theirs.docId, kind: "document" });
  assert.deepEqual({ error: back.isError, folderId: back.json?.folderId, folder: typeof (await readDoc(target, `folders/${folder.folderId}`))?.trashed?.batch }, { error: false, folderId: null, folder: "string" });
  const refused = await ownerMcp.call("restore_from_trash", { id: theirs.docId, kind: "document" });
  assert.equal(refused.isError, true, "the folder's owner restores nobody else's document");

  ctx.step("the folder's owner restores the folder: their own document comes back into it, the other's stays at its owner's root");
  await ownerMcp.call("restore_from_trash", { id: folder.folderId, kind: "folder" });
  const [m, t] = await Promise.all([readDoc(target, `docs/${mine.docId}`), readDoc(target, `docs/${theirs.docId}`)]);
  assert.deepEqual({ mine: [m.trashed, m.folderId], theirs: [t.trashed, t.folderId] }, { mine: [null, folder.folderId], theirs: [null, null] });
});
