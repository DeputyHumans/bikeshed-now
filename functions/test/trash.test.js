// SPDX-License-Identifier: Apache-2.0
// The Trash: who may trash and restore, what a trashed item is to everyone else, and what restore gives back (SPEC §4).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { toolByName } = require("../lib/mcp/tools.js");
const { emptyGrants } = require("../lib/lib/access.js");
const { computeMembership, persistDocMembership, recomputeSubtree, refanTeam } = require("../lib/lib/folders.js");
const { trashDocument, trashFolder, restoreDocument, restoreFolder } = require("../lib/lib/trash.js");
const acl = require("../lib/lib/acl.js");
const presence = require("../lib/lib/presence.js");
const notify = require("../lib/email/notify.js");
const http = require("../lib/index.js");

const saved = { presence: presence.syncPresenceAccess, mail: notify.sendInvitations };
let mirrors, invitations;
beforeEach(() => {
  mirrors = [];
  invitations = [];
  presence.syncPresenceAccess = async (...args) => mirrors.push(args);
  notify.sendInvitations = async (...args) => invitations.push(args);
});
afterEach(() => {
  presence.syncPresenceAccess = saved.presence;
  notify.sendInvitations = saved.mail;
});

const owner = "owner@example.com", editor = "editor@example.com", viewer = "viewer@example.com", other = "other@example.com";
const uidOf = (email) => (email === owner ? "u-owner" : `u-${email}`);

function owned(email, extra = {}) {
  const grants = { ...emptyGrants(), editors: [editor], viewers: [viewer], ...extra };
  return { ownerUid: uidOf(email), ownerEmail: email, ...grants, ...computeMembership(email, grants, null, new Map()), ...extra };
}

/**
 * The owner's folder `top` holds `sub` and their document `doc`; `sub` holds
 * the owner's `nested` and `theirs`, which another account owns. `loose` is
 * the owner's, at the root, public, with a team grant.
 */
function world() {
  const { db, store } = fakeFirestore({
    "folders/top": owned(owner, { name: "Top", parentId: null }),
    "folders/sub": owned(owner, { name: "Sub", parentId: "top", ancestors: ["top"] }),
    "docs/doc": owned(owner, { title: "Plan", currentVersion: "v1", folderId: "top" }),
    "docs/doc/versions/v1": { entry: "index.html" },
    "docs/nested": owned(owner, { title: "Nested", currentVersion: "v1", folderId: "sub" }),
    "docs/nested/versions/v1": { entry: "index.html" },
    "docs/theirs": owned(other, { title: "Theirs", currentVersion: "v1", folderId: "sub" }),
    "docs/theirs/versions/v1": { entry: "index.html" },
    "docs/loose": owned(owner, { title: "Loose", currentVersion: "v1", visibility: "public", editors: [editor, "team:design"] }),
    "docs/loose/versions/v1": { entry: "index.html" },
    "teams/design": { name: "Design", members: ["designer@example.com"] },
  });
  const ctx = (email = owner) => ({ db, caller: { uid: uidOf(email), emailLower: email, channel: "web" }, actor: { uid: uidOf(email), channel: "web" } });
  const events = (id) => [...store.keys()].filter((k) => k.startsWith(`docs/${id}/events/`)).map((k) => store.get(k));
  return { db, store, ctx, events };
}

async function refused(promise) {
  try {
    await promise;
    return "allowed";
  } catch (e) {
    return e.status ?? e.message;
  }
}

test("only a document's owner moves it to the Trash: an editor is refused, a stranger is told it is not there", async () => {
  const w = world();
  const results = [await refused(trashDocument(w.ctx(editor), "doc")), await refused(trashDocument(w.ctx("stranger@example.com"), "doc"))];
  assert.deepEqual({ results, trashed: acl.isTrashed(w.store.get("docs/doc")) }, { results: [403, 404], trashed: false });
});

test("a trashed document is its owner's alone, keeps its grants for Restore, loses its public row, and says who did it", async () => {
  const w = world();
  w.store.set("public/loose", { title: "Loose" });
  const { batch } = await trashDocument(w.ctx(), "loose");
  const d = w.store.get("docs/loose");
  assert.deepEqual(
    {
      members: d.members, editorMembers: d.editorMembers, approverMembers: d.approverMembers, suggesterMembers: d.suggesterMembers,
      grants: d.editors, trashed: { by: d.trashed.by, batch: d.trashed.batch, at: typeof d.trashed.at?.toMillis, with: d.trashed.with },
      public: w.store.has("public/loose"), presence: mirrors.at(-1).slice(1, 3), events: w.events("loose").map((e) => [e.type, e.data?.batch]),
    },
    {
      members: [owner], editorMembers: [owner], approverMembers: [owner], suggesterMembers: [owner],
      grants: [editor, "team:design"], trashed: { by: "u-owner", batch, at: "function", with: undefined },
      public: false, presence: [[owner], [owner]], events: [["doc.trashed", batch]],
    },
  );
});

test("trashing twice is one trashing: the second answers the first batch and records nothing", async () => {
  const w = world();
  const first = await trashDocument(w.ctx(), "doc");
  const second = await trashDocument(w.ctx(), "doc");
  assert.deepEqual({ same: second.batch === first.batch, events: w.events("doc").length }, { same: true, events: 1 });
});

test("in the Trash, no way in but membership: public, a key, a grant, open editing and the direct grant lists all count for nothing", () => {
  const trashed = { ...owned(owner, { visibility: "unlisted", linkToken: "tok", publicEdit: true, suggesters: ["s@example.com"], approvers: ["a@example.com"] }), members: [owner], editorMembers: [owner], suggesterMembers: [owner], approverMembers: [owner], trashed: { batch: "b" } };
  const as = (email) => ({ uid: uidOf(email), emailLower: email });
  const pub = { ...trashed, visibility: "public" };
  assert.deepEqual(
    {
      owner: acl.readBasis(trashed, as(owner)),
      key: acl.readBasis(trashed, as(viewer), { k: "tok" }),
      grant: acl.readBasis(trashed, as(viewer), { grantToken: "tok" }),
      public: acl.readBasis(pub, as(viewer)),
      anyone: acl.opensEditingToAnyAccount(pub),
      editor: acl.isDocEditor(trashed, uidOf(editor), editor),
      approver: acl.isDocApprover(trashed, "u-a", "a@example.com"),
      suggester: acl.canSuggest(trashed, { uid: "u-s", emailLower: "s@example.com" }),
      ownerEdits: acl.isDocEditor(trashed, "u-owner", owner),
      frozen: acl.frozenForReader(trashed, as(viewer)),
      ownerReads: acl.frozenForReader(trashed, as(owner)),
      write: acl.frozenWrite(trashed, Date.now()),
    },
    {
      owner: "member", key: null, grant: null, public: null, anyone: false, editor: false, approver: false, suggester: false, ownerEdits: true,
      frozen: true, ownerReads: false, write: { trashed: true, error: acl.TRASHED_WRITE },
    },
  );
  // A negative control on the same record, not in the Trash.
  const live = { ...trashed, trashed: null, ...computeMembership(owner, { ...emptyGrants(), editors: [editor], viewers: [viewer], suggesters: ["s@example.com"], approvers: ["a@example.com"] }, null, new Map()) };
  assert.deepEqual([acl.readBasis(live, as(viewer), { k: "tok" }), acl.isDocEditor(live, uidOf(editor), editor), acl.frozenWrite(live, Date.now())], ["member", true, null]);
});

test("an expired document that is also in the Trash says the Trash first, which is the first thing to undo", () => {
  const both = { ...owned(owner), trashed: { batch: "b" }, expiresAt: Date.now() - 1000 };
  assert.deepEqual([acl.frozenWrite(both, Date.now()), acl.frozenWrite({ ...both, trashed: null }, Date.now())], [
    { trashed: true, error: acl.TRASHED_WRITE },
    { expired: true, error: acl.EXPIRED_WRITE },
  ]);
});

test("no recompute hands a trashed document back: a folder cascade, a team change and a plain recompute all leave it its owner's", async () => {
  const w = world();
  await trashDocument(w.ctx(), "doc");
  await trashDocument(w.ctx(), "loose");
  w.store.set("teams/design", { name: "Design", members: ["designer@example.com", "late@example.com"] });
  await recomputeSubtree(w.db, "top");
  await refanTeam(w.db, "design");
  await persistDocMembership(w.db, w.db.collection("docs").doc("doc"));
  assert.deepEqual([w.store.get("docs/doc").members, w.store.get("docs/loose").members, w.store.get("docs/loose").editorMembers], [[owner], [owner], [owner]]);
});

test("while trashed, sharing, visibility, trust, marking, rename and move are refused, the owner's included", async () => {
  const w = world();
  await trashDocument(w.ctx(), "doc");
  const sessions = { owner: { uid: "u-owner", email: owner, email_verified: true } };
  const as = (handler, body) => withFakeAdmin({ db: w.db, sessions }, () => invoke(handler, { headers: { cookie: "__session=owner" }, body }));
  const results = [
    await as(http.setAccess, { docId: "doc", add: [{ email: "new@example.com", role: "editor" }] }),
    await as(http.setVisibility, { docId: "doc", visibility: "public" }),
    await as(http.setMarking, { docId: "doc", marking: { label: "Draft" } }),
    await as(http.trustDoc, { docId: "doc", trusted: false }),
    await as(http.organize, { kind: "doc", id: "doc", op: "rename", name: "Renamed" }),
    await as(http.organize, { kind: "doc", id: "doc", op: "move", targetFolderId: "" }),
  ].map((r) => [r.status, r.body?.error ?? null]);
  const d = w.store.get("docs/doc");
  assert.deepEqual({ results, mail: invitations.length, title: d.title, folderId: d.folderId, visibility: d.visibility ?? "private" }, {
    results: Array(6).fill([409, acl.TRASHED_WRITE]), mail: 0, title: "Plan", folderId: "top", visibility: "private",
  });
});

test("restore gives back every grant and its folder, and says so in the log", async () => {
  const w = world();
  const { batch } = await trashDocument(w.ctx(), "doc");
  const result = await restoreDocument(w.ctx(), "doc");
  const d = w.store.get("docs/doc");
  assert.deepEqual({ result, trashed: d.trashed, members: d.members, editorMembers: d.editorMembers, events: w.events("doc").map((e) => [e.type, e.data?.batch, e.data?.to]) }, {
    result: { id: "doc", folderId: "top" }, trashed: null, members: [editor, owner, viewer], editorMembers: [editor, owner],
    events: [["doc.trashed", batch, undefined], ["doc.restored", batch, "top"]],
  });
});

test("only the owner restores (to the folder's owner, someone else's trashed document is not there), and it comes back at its owner's root while its folder is in the Trash", async () => {
  const w = world();
  await trashFolder(w.ctx(), "top");
  const refusals = [await refused(restoreDocument(w.ctx(editor), "doc")), await refused(restoreDocument(w.ctx(owner), "theirs"))];
  const result = await restoreDocument(w.ctx(other), "theirs");
  const t = w.store.get("docs/theirs");
  assert.deepEqual({ refusals, result, members: t.members, top: acl.isTrashed(w.store.get("folders/top")) }, {
    refusals: [404, 404], result: { id: "theirs", folderId: null }, members: [editor, other, viewer], top: true,
  });
});

test("a folder goes to the Trash with everything in it, other people's documents too, each named as gone with it", async () => {
  const w = world();
  // Public, so its link reaches everything beneath it until it is trashed.
  w.store.set("folders/top", { ...w.store.get("folders/top"), visibility: "public" });
  await recomputeSubtree(w.db, "top");
  assert.deepEqual(w.store.get("folders/sub").reach.map((e) => e.folderId), ["top"], "precondition: sub is reached through top's link");
  const { batch, folders, documents } = await trashFolder(w.ctx(), "top");
  const marks = ["folders/top", "folders/sub", "docs/doc", "docs/nested", "docs/theirs"].map((p) => [p, w.store.get(p).trashed.batch === batch, w.store.get(p).trashed.with?.name ?? null]);
  assert.deepEqual({ folders, documents, marks, reach: [w.store.get("folders/top").reach, w.store.get("folders/sub").reach], theirs: w.store.get("docs/theirs").members, top: w.store.get("folders/top").members }, {
    folders: 2, documents: 3,
    marks: [["folders/top", true, null], ["folders/sub", true, "Top"], ["docs/doc", true, "Top"], ["docs/nested", true, "Top"], ["docs/theirs", true, "Top"]],
    reach: [[], []], theirs: [other], top: [owner],
  });
});

test("restoring a folder brings back what went with it, not what its owner already took back or what went to the Trash on its own before", async () => {
  const w = world();
  const early = await trashDocument(w.ctx(), "nested");
  await trashFolder(w.ctx(), "top");
  await restoreDocument(w.ctx(other), "theirs");
  const result = await restoreFolder(w.ctx(), "top");
  assert.deepEqual(
    {
      result,
      top: w.store.get("folders/top").trashed, sub: w.store.get("folders/sub").trashed, doc: w.store.get("docs/doc").trashed,
      nested: w.store.get("docs/nested").trashed?.batch === early.batch, theirs: w.store.get("docs/theirs").folderId,
      members: w.store.get("docs/doc").members,
    },
    { result: { id: "top", parentId: null, folders: 2, documents: 1 }, top: null, sub: null, doc: null, nested: true, theirs: null, members: [editor, owner, viewer] },
  );
});

test("a subfolder that went to the Trash on its own before stays there, with its contents, when its parent is restored", async () => {
  const w = world();
  const early = await trashFolder(w.ctx(), "sub");
  await trashFolder(w.ctx(), "top");
  const result = await restoreFolder(w.ctx(), "top");
  assert.deepEqual(
    { result, top: w.store.get("folders/top").trashed, sub: w.store.get("folders/sub").trashed?.batch === early.batch, nested: w.store.get("docs/nested").trashed?.batch === early.batch, doc: w.store.get("docs/doc").trashed },
    { result: { id: "top", parentId: null, folders: 1, documents: 1 }, top: null, sub: true, nested: true, doc: null },
  );
});

test("a subfolder restored on its own goes to its owner's root and takes its contents from the same batch", async () => {
  const w = world();
  await trashFolder(w.ctx(), "top");
  const result = await restoreFolder(w.ctx(), "sub");
  assert.deepEqual({ result, top: acl.isTrashed(w.store.get("folders/top")), ancestors: w.store.get("folders/sub").ancestors, nested: w.store.get("docs/nested").trashed }, {
    result: { id: "sub", parentId: null, folders: 1, documents: 2 }, top: true, ancestors: [], nested: null,
  });
});

test("nothing goes into a folder in the Trash, and a trashed folder cannot be renamed or moved", async () => {
  const w = world();
  await trashFolder(w.ctx(), "sub");
  const sessions = { owner: { uid: "u-owner", email: owner, email_verified: true } };
  const as = (handler, body) => withFakeAdmin({ db: w.db, sessions }, () => invoke(handler, { headers: { cookie: "__session=owner" }, body }));
  const results = [
    await as(http.organize, { kind: "doc", id: "loose", op: "move", targetFolderId: "sub" }),
    await as(http.organize, { kind: "folder", id: "sub", op: "rename", name: "Again" }),
    await as(http.createFolder, { name: "Inside", parentId: "sub" }),
  ].map((r) => r.status);
  assert.deepEqual({ results, loose: w.store.get("docs/loose").folderId ?? null, name: w.store.get("folders/sub").name }, { results: [409, 409, 409], loose: null, name: "Sub" });
});

test("POST /organize trashes and restores both kinds for their owner; a folder's delete is a trash; a document's delete says to trash it", async () => {
  const w = world();
  const sessions = { owner: { uid: "u-owner", email: owner, email_verified: true } };
  const as = (body) => withFakeAdmin({ db: w.db, sessions }, () => invoke(http.organize, { headers: { cookie: "__session=owner" }, body }));
  const docDelete = await as({ kind: "doc", id: "loose", op: "delete" });
  const trash = await as({ kind: "doc", id: "loose", op: "trash" });
  const restore = await as({ kind: "doc", id: "loose", op: "restore" });
  const folder = await as({ kind: "folder", id: "sub", op: "delete" });
  assert.deepEqual(
    { docDelete: [docDelete.status, docDelete.body?.error], trash: [trash.status, typeof trash.body.batch], restore: restore.body, folder: [folder.status, folder.body.documents, acl.isTrashed(w.store.get("folders/sub"))], subExists: w.store.has("folders/sub") },
    { docDelete: [400, 'a document is not deleted: move it to the Trash with op "trash"'], trash: [200, "string"], restore: { ok: true, id: "loose", folderId: null }, folder: [200, 2, true], subExists: true },
  );
});

/**
 * Every place that computes a membership, named: each passes the record's own
 * Trash state, or writes a record that has just been created and so cannot be
 * in the Trash yet. A new writer that does neither would hand a trashed
 * document back to its grantees, and fails here until it is named.
 */
test("every membership writer passes the record's Trash state, or makes a record too new to be in it", () => {
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const root = path.resolve(__dirname, "../..");
  const hits = execFileSync("git", ["grep", "-n", "-E", "compute(Doc)?Membership\\(", "--", "functions/src", "scripts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((l) => !/export (function|const)|^\S+:\d+:\s*(\*|\/\/)/.test(l));
  const NEW_RECORDS = {
    "functions/src/lib/folders.ts": "createFolderRecord: a folder that does not exist yet",
    "functions/src/lib/fork.ts": "the fork, a document that does not exist yet",
    "functions/src/lib/publish.ts": "publishNewDocument: a document that does not exist yet",
  };
  const unnamed = hits.filter((l) => {
    const file = l.split(":")[0];
    const call = l.slice(l.indexOf(":", file.length + 1) + 1);
    if (/isTrashed\(/.test(call)) return false;
    return !(file in NEW_RECORDS && /emptyGrants\(\)|computeDocMembership\(\s*$/.test(call));
  });
  assert.deepEqual({ unnamed, seen: hits.length >= 7 }, { unnamed: [], seen: true });
});

test("through MCP: trash_document and restore_from_trash act for the owner, and list_trash shows each owner their own, newest first", async () => {
  const w = world();
  const run = (tool, args, email = owner) => toolByName(tool).run(w.ctx(email), args);
  await run("trash_document", { id: "loose" });
  await run("delete_folder", { id: "sub" });
  const mine = await run("list_trash", {});
  const theirs = await run("list_trash", {}, other);
  const badKind = await refused(run("restore_from_trash", { id: "loose", kind: "doc" }));
  const byEditor = await refused(run("trash_document", { id: "doc" }, editor));
  const restored = await run("restore_from_trash", { id: "sub", kind: "folder" });
  assert.deepEqual(
    {
      mine: { documents: mine.documents.map((d) => [d.id, d.with?.name ?? null, d.was]), folders: mine.folders.map((f) => [f.id, f.was]), dated: mine.documents.every((d) => typeof d.trashedAt === "number") },
      theirs: theirs.documents.map((d) => [d.id, d.with?.name ?? null, d.was]),
      badKind, byEditor, restored: [restored.id, restored.parentId, restored.documents],
      after: (await run("list_trash", {})).documents.map((d) => d.id),
    },
    {
      mine: { documents: [["nested", "Sub", "sub"], ["loose", null, null]], folders: [["sub", "top"]], dated: true },
      theirs: [["theirs", "Sub", "sub"]],
      badKind: 400, byEditor: 403, restored: ["sub", "top", 2],
      after: ["loose"],
    },
  );
});

test("list_documents and list_folders leave the Trash out: a trashed item is list_trash's, never something to work on or file into", async () => {
  const w = world();
  const run = (tool, args) => toolByName(tool).run(w.ctx(), args);
  await trashDocument(w.ctx(), "loose");
  await trashFolder(w.ctx(), "sub");
  const docs = (await run("list_documents", {})).documents.map((d) => d.id).sort();
  const folders = (await run("list_folders", {})).folders.map((f) => f.id);
  assert.deepEqual({ docs, folders }, { docs: ["doc"], folders: ["top"] });
});

test("a trash that stopped part way is finished by asking again, with the folder's own batch", async () => {
  const w = world();
  // As if the walk died after the root: the folder is trashed, nothing in it is.
  w.store.set("folders/top", { ...w.store.get("folders/top"), trashed: { batch: "b-stopped", by: "u-owner", at: null } });
  const again = await trashFolder(w.ctx(), "top");
  const marks = ["folders/sub", "docs/doc", "docs/nested", "docs/theirs"].map((p) => [w.store.get(p).trashed?.batch, w.store.get(p).trashed?.with?.folderId]);
  assert.deepEqual({ batch: again.batch, documents: again.documents, marks }, { batch: "b-stopped", documents: 3, marks: Array(4).fill(["b-stopped", "top"]) });
});

test("a restore that stopped part way is finished by asking again: what is left still names the folder it went with", async () => {
  const w = world();
  await trashFolder(w.ctx(), "top");
  // As if the walk died after the root: the folder is out, its contents are not.
  w.store.set("folders/top", { ...w.store.get("folders/top"), trashed: null });
  const again = await restoreFolder(w.ctx(), "top");
  assert.deepEqual(
    { again: [again.folders, again.documents], left: ["folders/sub", "docs/doc", "docs/nested", "docs/theirs"].map((p) => w.store.get(p).trashed), members: w.store.get("docs/doc").members },
    { again: [1, 3], left: [null, null, null, null], members: [editor, owner, viewer] },
  );
});

test("a folder's reach opens nothing in the Trash, even where the document's own basis would have fallen through to it", () => {
  const folder = { reach: [{ folderId: "top", visibility: "public", expiresAt: null }] };
  const doc = { ...owned(owner), members: [owner], trashed: { batch: "b" } };
  const live = { ...owned(owner), trashed: null };
  const stranger = { uid: "u-x", emailLower: "x@example.com" };
  assert.deepEqual([acl.readAccess(doc, stranger, {}, folder), acl.readAccess(live, stranger, {}, folder)?.basis ?? null], [null, acl.readAccess(live, stranger, {}, folder)?.basis ?? null]);
  assert.notEqual(acl.readAccess(live, stranger, {}, folder), null, "the negative control: the same folder opens the live document");
});

test("sharing and visibility refuse a trashed document with the same body every write path gives it", async () => {
  const w = world();
  await trashDocument(w.ctx(), "doc");
  const sessions = { owner: { uid: "u-owner", email: owner, email_verified: true } };
  const as = (handler, body) => withFakeAdmin({ db: w.db, sessions }, () => invoke(handler, { headers: { cookie: "__session=owner" }, body }));
  const bodies = [
    (await as(http.setAccess, { docId: "doc", add: [{ email: "new@example.com", role: "viewer" }] })).body,
    (await as(http.setVisibility, { docId: "doc", visibility: "public" })).body,
  ];
  assert.deepEqual(bodies, Array(2).fill({ trashed: true, error: acl.TRASHED_WRITE }));
});
