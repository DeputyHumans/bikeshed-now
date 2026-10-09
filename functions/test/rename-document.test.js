// SPDX-License-Identifier: Apache-2.0
// A document is renamed from the agent surface as from the workspace list (SPEC §4, §19).

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { TOOLS } = require("../lib/mcp/tools.js");
const { organize } = require("../lib/index.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const EDITOR = { uid: "u-ed", emailLower: "ed@example.com" };
const VIEWER = { uid: "u-viewer", emailLower: "viewer@example.com" };
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };

function world(extra = {}) {
  const { db, store } = fakeFirestore({
    "docs/d1": {
      docId: "d1",
      title: "Migration",
      slug: "migration",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      viewers: [VIEWER.emailLower],
      editors: [EDITOR.emailLower],
      approvers: [],
      members: [OWNER.emailLower, EDITOR.emailLower, VIEWER.emailLower],
      editorMembers: [OWNER.emailLower, EDITOR.emailLower],
      approverMembers: [OWNER.emailLower],
      visibility: "private",
      ...extra,
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
  });
  const ctx = (who) => ({
    db,
    caller: { ...who, channel: "mcp", tokenId: "t1" },
    actor: { uid: who.uid, email: who.emailLower, channel: "mcp", tokenId: "t1" },
  });
  const rename = (who, args) => tool("rename_document").run(ctx(who), { id: "d1", ...args });
  return { db, store, rename, doc: () => store.get("docs/d1") };
}

test("an editor's agent renames a document, and its address stays", async () => {
  const w = world();
  const result = await w.rename(EDITOR, { title: "  Cut-over plan  " });
  assert.equal(result.id, "d1");
  assert.equal(result.title, "Cut-over plan");
  assert.equal(w.doc().title, "Cut-over plan");
  assert.equal(w.doc().slug, "cut-over-plan");
  assert.equal(w.doc().docId, "d1", "the docId is the address and never changes");
  assert.ok(w.store.has("docs/d1/versions/v1"), "no version is minted or moved");
});

test("a reader who may not edit cannot rename, and a stranger is told the document is not there", async () => {
  const w = world();
  await assert.rejects(w.rename(VIEWER, { title: "Mine now" }), { message: "you cannot rename that document" });
  await assert.rejects(w.rename(STRANGER, { title: "Mine now" }), { message: 'no document with id "d1"' });
  assert.equal(w.doc().title, "Migration");
});

test("a title is required, and has a limit", async () => {
  const w = world();
  await assert.rejects(w.rename(OWNER, { title: "   " }), /title is required/);
  await assert.rejects(w.rename(OWNER, { title: "x".repeat(201) }), /title is required \(up to 200 characters\)/);
  assert.equal(w.doc().title, "Migration");
});

test("an expired document is frozen, its owner's rename included", async () => {
  const w = world({ expiresAt: Date.now() - 1000 });
  await assert.rejects(w.rename(OWNER, { title: "Revived" }), /expired/);
  assert.equal(w.doc().title, "Migration");
});

test("a public document's world-readable projection takes the new title", async () => {
  const w = world({ visibility: "public" });
  await w.rename(OWNER, { title: "Cut-over plan" });
  assert.equal(w.store.get("public/d1")?.title, "Cut-over plan");
});

test("the workspace list still renames through POST /organize, by the same rules", async () => {
  const w = world();
  const sessions = {
    "s-ed": { uid: EDITOR.uid, email: EDITOR.emailLower, email_verified: true },
    "s-viewer": { uid: VIEWER.uid, email: VIEWER.emailLower, email_verified: true },
  };
  const call = (session, name) =>
    withFakeAdmin({ db: w.db, sessions }, () =>
      invoke(organize, {
        headers: { cookie: `__session=${session}` },
        body: { kind: "doc", id: "d1", op: "rename", name },
      }),
    );
  assert.equal((await call("s-viewer", "Mine now")).status, 403);
  assert.equal((await call("s-ed", "")).status, 400);
  const ok = await call("s-ed", "Cut-over plan");
  assert.equal(ok.status, 200);
  assert.equal(w.doc().title, "Cut-over plan");
  assert.equal(w.doc().slug, "cut-over-plan");
});
