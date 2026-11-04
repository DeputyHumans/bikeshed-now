// SPDX-License-Identifier: Apache-2.0
// Management authorization, inherited access and sparse settings (SPEC §13, §17, §19).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin/firestore");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { toolByName } = require("../lib/mcp/tools.js");
const { emptyGrants } = require("../lib/lib/access.js");
const { computeMembership, recomputeSubtree } = require("../lib/lib/folders.js");
const presence = require("../lib/lib/presence.js");
const notify = require("../lib/email/notify.js");
const http = require("../lib/index.js");
const saved = { presence: presence.syncPresenceAccess, mail: notify.sendInvitations, origin: process.env.BIKESHED_PUBLIC_ORIGIN };
let mirrors, invitations;
beforeEach(() => {
  mirrors = []; invitations = [];
  presence.syncPresenceAccess = async (...args) => mirrors.push(args);
  notify.sendInvitations = async (...args) => invitations.push(args);
  process.env.BIKESHED_PUBLIC_ORIGIN = "https://example.test";
});
afterEach(() => {
  presence.syncPresenceAccess = saved.presence; notify.sendInvitations = saved.mail;
  if (saved.origin === undefined) delete process.env.BIKESHED_PUBLIC_ORIGIN;
  else process.env.BIKESHED_PUBLIC_ORIGIN = saved.origin;
});
const owner = "owner@example.com", editor = "editor@example.com", viewer = "viewer@example.com";
function owned(extra = {}) {
  const grants = { ...emptyGrants(), editors: [editor], viewers: [viewer], ...extra };
  return { ownerUid: "u-owner", ownerEmail: owner, ...grants, ...computeMembership(owner, grants, null, new Map()), ...extra };
}
function world(extra = {}) {
  const { db, store } = fakeFirestore({
    "docs/doc": owned({ title: "Plan", currentVersion: "v1", visibility: "private", folderId: "child" }),
    "docs/doc/versions/v1": { entry: "index.html" },
    "folders/parent": owned({ name: "Parent", parentId: null }),
    "folders/child": owned({ name: "Child", parentId: "parent" }),
    "folders/grandchild": owned({ name: "Grandchild", parentId: "child" }),
    "docs/nested": owned({ title: "Nested", currentVersion: "v1", folderId: "grandchild" }),
    "teams/design": { name: "Design", members: ["designer@example.com"] },
    ...extra,
  });
  const ctx = (email = owner) => ({ db, caller: { uid: email === owner ? "u-owner" : `u-${email}`, emailLower: email, channel: "mcp" }, actor: { uid: `u-${email}`, email, channel: "mcp", tokenId: "token" } });
  return { db, store, ctx, run: (tool, args, email) => toolByName(tool).run(ctx(email), args) };
}

test("management owner gates deny editors, viewers and strangers without changes", async () => {
  const w = world();
  const cases = [
    ["get_document_access", { id: "doc" }], ["set_document_access", { id: "doc", remove: [viewer] }],
    ["get_folder_access", { id: "child" }], ["set_folder_access", { id: "child", remove: [viewer] }],
    ["set_document_visibility", { id: "doc", visibility: "public" }], ["delete_folder", { id: "child" }],
  ];
  const results = [];
  for (const email of [editor, viewer, "stranger@example.com"]) for (const [tool, args] of cases) {
    try { await w.run(tool, args, email); results.push("allowed"); } catch (e) { results.push(e.status); }
  }
  assert.deepEqual({ results, mail: invitations.length, folder: w.store.has("folders/child"), visibility: w.store.get("docs/doc").visibility }, {
    results: [...Array(12).fill(403), ...Array(6).fill(404)], mail: 0, folder: true, visibility: "private",
  });
});

test("direct roles replace, inherited access remains, owners survive and invitations are idempotent", async () => {
  const w = world();
  await recomputeSubtree(w.db, "parent");
  const roles = ["viewer", "suggester", "editor", "approver"], observed = [];
  for (const role of roles) {
    const result = await w.run("set_document_access", { id: "doc", add: [{ principal: "New@Example.com", role }] });
    observed.push(Object.entries(result.direct).filter(([, people]) => people.includes("new@example.com")).map(([key]) => key));
  }
  await w.run("set_document_access", { id: "doc", add: [{ principal: "new@example.com", role: "approver" }] });
  const out = await w.run("set_document_access", { id: "doc", remove: [viewer, owner] });
  assert.deepEqual({ observed, sent: invitations.flatMap(i => i[1].map(t => t.email)), directViewer: out.direct.viewers, inheritedViewer: out.effective.members.includes(viewer), owner: out.effective.approverMembers.includes(owner), inherited: out.inherited.some(g => g.principal === viewer), mirror: mirrors.at(-1)[1].includes(viewer), roleEvents: [...w.store.keys()].filter(k => k.startsWith("docs/doc/acl/")).length }, {
    observed: [["viewers"], ["suggesters"], ["editors"], ["approvers"]], sent: ["new@example.com"], directViewer: [], inheritedViewer: true, owner: true, inherited: true, mirror: true, roleEvents: 5,
  });
});

test("folder team grants cascade and revocation updates descendants and mirrors", async () => {
  const w = world({ "docs/nested": owned({ title: "Nested", currentVersion: "v1", folderId: "grandchild", visibility: "public", publicEdit: true }) });
  const added = await w.run("set_folder_access", { id: "parent", add: [{ principal: "team:design", role: "editor" }] });
  const nestedBefore = w.store.get("docs/nested").editorMembers.includes("designer@example.com");
  const removed = await w.run("set_folder_access", { id: "parent", remove: ["team:design"] });
  assert.deepEqual({ team: added.direct.editors.includes("team:design"), nestedBefore, after: removed.effective.members.includes("designer@example.com"), nestedAfter: w.store.get("docs/nested").members.includes("designer@example.com"), mirror: mirrors.filter(m => m[0] === "nested").at(-1)?.[1]?.includes("designer@example.com"), openEdit: mirrors.filter(m => m[0] === "nested").at(-1)?.[3], public: w.store.get("public/nested")?.title, invited: invitations.flatMap(i => i[1].map(t => t.email)) }, {
    team: true, nestedBefore: true, after: false, nestedAfter: false, mirror: false, openEdit: true, public: "Nested", invited: ["designer@example.com"],
  });
});

test("sparse visibility preserves expiry and unlisted key, clears expiry and disables private editing", async () => {
  const w = world();
  const expiry = Date.now() + 86400000;
  const first = await w.run("set_document_visibility", { id: "doc", visibility: "unlisted", publicEdit: true, expiresAt: expiry });
  const next = await w.run("set_document_visibility", { id: "doc", publicEdit: false });
  const cleared = await w.run("set_document_visibility", { id: "doc", expiresAt: null });
  const priv = await w.run("set_document_visibility", { id: "doc", visibility: "private", publicEdit: true });
  assert.deepEqual({ keyStable: first.linkToken === next.linkToken && next.linkToken === cleared.linkToken, url: new URL(next.url).searchParams.get("k"), expiry: next.expiresAt, cleared: cleared.expiresAt, private: [priv.visibility, priv.publicEdit, priv.linkToken], mirrorPublic: mirrors.at(-1)[3] }, {
    keyStable: true, url: first.linkToken, expiry, cleared: null, private: ["private", false, null], mirrorPublic: false,
  });
});

test("owners recover expired documents and invalid patches cannot change settings", async () => {
  const w = world({ "docs/doc": owned({ visibility: "private", expiresAt: Timestamp.fromMillis(1) }) });
  const read = await w.run("get_document_access", { id: "doc" });
  const errors = [];
  for (const patch of [{}, { publicEdit: "false" }, { expiresAt: 1 }, { expiresAt: "2027" }, { visibility: "secret" }, { visibility: ["public"] }]) {
    try { await w.run("set_document_visibility", { id: "doc", ...patch }); errors.push("allowed"); } catch (e) { errors.push(e.status); }
  }
  const recovered = await w.run("set_document_visibility", { id: "doc", expiresAt: null });
  assert.deepEqual({ read: read.expiresAt, errors, recovered: recovered.expiresAt }, { read: 1, errors: [400, 400, 400, 400, 400, 400], recovered: null });
});

test("folder editors rename; only the owner moves, and cycles and read-only destinations are refused", async () => {
  // Moving a folder shares everything in it with its new parent's readers,
  // so an editor who could move someone's folder under their own could then
  // share or publish what is inside (SPEC §13).
  const w = world({
    "folders/readonly": owned({ editors: [], editorMembers: [owner] }),
    "folders/editors-own": { ownerUid: "u-editor", ownerEmail: editor, ...emptyGrants(), ...computeMembership(editor, emptyGrants(), null, new Map()), name: "Mine", parentId: null },
  });
  await recomputeSubtree(w.db, "parent");
  const renamed = await w.run("rename_folder", { id: "child", name: "  Reviews  " }, editor);
  const codes = [];
  for (const [args, email] of [
    [{ id: "child", parent: "editors-own" }, editor],
    [{ id: "child" }, editor],
    [{ id: "child" }, viewer],
    [{ id: "child", parent: "grandchild" }, owner],
  ]) {
    try { await w.run("move_folder", args, email); codes.push("allowed"); } catch (e) { codes.push(e.status); }
  }
  assert.equal(w.store.get("folders/child").parentId, "parent", "no refused move changed anything");
  const moved = await w.run("move_folder", { id: "child" }, owner);
  assert.deepEqual({ name: renamed.name, codes, parent: moved.parent, descendants: w.store.get("folders/grandchild").ancestors, mail: invitations.length }, { name: "Reviews", codes: [403, 403, 403, 400], parent: null, descendants: ["child"], mail: 0 });
});

test("only a document's owner moves it: an editor cannot file it into their own folder", async () => {
  const w = world({
    "folders/editors-own": { ownerUid: "u-editor", ownerEmail: editor, ...emptyGrants(), ...computeMembership(editor, emptyGrants(), null, new Map()), name: "Mine", parentId: null, visibility: "public" },
  });
  await assert.rejects(w.run("move_document", { id: "doc", folder: "editors-own" }, editor), /only its owner can move/);
  await assert.rejects(w.run("move_document", { id: "doc" }, editor), /only its owner can move/);
  assert.equal(w.store.get("docs/doc").folderId, "child", "the document stays where its owner filed it");
  const moved = await w.run("move_document", { id: "doc" }, owner);
  assert.equal(w.store.get("docs/doc").folderId ?? null, null, `the owner may: ${JSON.stringify(moved)}`);

  // And through HTTP, which the browser uses.
  const sessions = { editor: { uid: "u-editor", email: editor, email_verified: true } };
  const r = await withFakeAdmin({ db: w.db, sessions }, () => invoke(http.organize, { headers: { cookie: "__session=editor" }, body: { kind: "doc", id: "doc", op: "move", targetFolderId: "editors-own" } }));
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Only its owner can move this/);
  assert.equal(w.store.get("docs/doc").folderId ?? null, null);
});

test("HTTP preserves full-form settings and access response contracts through shared handlers", async () => {
  const w = world();
  const sessions = { owner: { uid: "u-owner", email: owner, email_verified: true } };
  const invokeAs = (handler, body) => withFakeAdmin({ db: w.db, sessions }, () => invoke(handler, { headers: { cookie: "__session=owner" }, body }));
  const grant = await invokeAs(http.setAccess, { docId: "doc", add: [{ email: "new@example.com", role: "editor" }] });
  const visibility = await invokeAs(http.setVisibility, { docId: "doc", visibility: "public" });
  const folder = await invokeAs(http.organize, { kind: "folder", id: "child", op: "rename", name: "From web" });
  assert.deepEqual({ grant: grant.status, editors: grant.body.editors, visibility: visibility.body, folder: folder.body, name: w.store.get("folders/child").name }, {
    grant: 200, editors: [editor, "new@example.com"], visibility: { visibility: "public", publicEdit: false, expiresAt: null, linkToken: null }, folder: { ok: true }, name: "From web",
  });
});

test("HTTP management refusals use identical empty 404s for unreadable and absent resources", async () => {
  const w = world();
  const sessions = { stranger: { uid: "u-stranger", email: "stranger@example.com", email_verified: true } };
  const results = [];
  for (const missing of [false, true]) {
    const docId = missing ? "absent" : "doc", folderId = missing ? "absent-folder" : "child";
    for (const [handler, options] of [
      [http.setAccess, { body: { docId, remove: [viewer] } }],
      [http.setAccess, { method: "GET", query: { docId } }],
      [http.setVisibility, { body: { docId, visibility: "private" } }],
      [http.setFolderAccess, { body: { folderId, remove: [viewer] } }],
      [http.setFolderAccess, { method: "GET", query: { folderId } }],
      [http.organize, { body: { kind: "folder", id: folderId, op: "delete" } }],
    ]) {
      const res = await withFakeAdmin({ db: w.db, sessions }, () => invoke(handler, { ...options, headers: { cookie: "__session=stranger" } }));
      results.push({ status: res.status, body: res.body });
    }
  }
  assert.deepEqual(results, Array.from({ length: 12 }, () => ({ status: 404, body: undefined })));
});
