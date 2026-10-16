// SPDX-License-Identifier: Apache-2.0
// Delayed saves and commits cannot replace published bytes or delete a newer draft (SPEC §6a).
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { writeDraft, commitDraft, readWorkingCopy } = require("../lib/lib/draft.js");
const { hashBundleFiles } = require("../lib/lib/hash.js");
const actor = { uid: "u", email: "owner@example.com", channel: "mcp" };
async function world(fn) {
  const w = fakeFirestore({
    "docs/d": { currentVersion: "v1", ownerUid: "u", ownerEmail: actor.email, visibility: "private", draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/drafts/old" } },
    "docs/d/versions/v1": { entry: "index.html", format: "html", contentHash: "original" },
  });
  const objects = new Map([["docs/d/v1/index.html", Buffer.from("original")], ["docs/d/drafts/old/index.html", Buffer.from("draft")]]);
  const saved = Object.getOwnPropertyDescriptor(admin, "storage");
  const hooks = { save: () => {}, remove: () => {} };
  const file = name => ({ name, exists: async () => [objects.has(name)], download: async () => { if (!objects.has(name)) throw new Error("absent"); return [objects.get(name)]; },
    save: async (bytes, opts) => { assert.equal(opts.preconditionOpts.ifGenerationMatch, 0); if (objects.has(name)) throw new Error("overwritten"); objects.set(name, Buffer.from(bytes)); await hooks.save(name); } });
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({ file,
    getFiles: async ({ prefix }) => [[...objects.keys()].filter(k => k.startsWith(prefix)).map(file)],
    deleteFiles: async ({ prefix }) => { await hooks.remove(prefix); for (const k of objects.keys()) if (k.startsWith(prefix)) objects.delete(k); },
  }) }) });
  const docRef = w.db.doc("docs/d");
  const args = () => ({ db: w.db, docRef, baseVersion: "v1", draft: w.store.get("docs/d").draft, actor, emailLower: actor.email });
  try { await withFakeAdmin({ db: w.db }, () => fn({ ...w, objects, hooks, docRef, args })); }
  finally { if (saved) Object.defineProperty(admin, "storage", saved); else delete admin.storage; }
}
function newer(w, head = "v1") {
  w.store.set("docs/d", { ...w.store.get("docs/d"), currentVersion: head, draft: { baseVersion: head, entry: "index.html", storagePrefix: "docs/d/drafts/new" } });
  w.objects.set("docs/d/drafts/new/index.html", Buffer.from("newer draft"));
}
test("a late draft save cannot adopt bytes after its base becomes historical", () => world(async w => {
  w.hooks.save = () => newer(w, "v2");
  await assert.rejects(writeDraft({ ...w.args(), version: { entry: "index.html", format: "html" }, content: { html: "late" }, existingSessions: [] }), /read-only/);
  assert.equal(w.store.get("docs/d").draft.storagePrefix, "docs/d/drafts/new");
  assert.equal(w.objects.get("docs/d/drafts/new/index.html").toString(), "newer draft");
  assert.equal(w.objects.get("docs/d/v1/index.html").toString(), "original");
  assert.equal([...w.objects.values()].some(v => v.toString() === "late"), false);
}));
test("a commit refuses a draft replaced during upload", () => world(async w => {
  w.hooks.save = () => newer(w);
  const result = await commitDraft(w.args());
  assert.equal(result.status, 409);
  assert.equal(w.store.has("docs/d/versions/v2"), false);
  assert.equal(w.store.get("docs/d").draft.storagePrefix, "docs/d/drafts/new");
  assert.equal(w.objects.get("docs/d/v1/index.html").toString(), "original");
}));
test("post-commit cleanup deletes only the observed draft and the reader follows the new pointer", () => world(async w => {
  w.hooks.remove = () => newer(w, "v2");
  const result = await commitDraft(w.args());
  assert.equal(result.status, 200);
  assert.equal(w.objects.has("docs/d/drafts/old/index.html"), false);
  assert.equal(w.objects.get("docs/d/drafts/new/index.html").toString(), "newer draft");
  const copy = await readWorkingCopy(w.docRef, w.store.get("docs/d"));
  assert.equal(copy.html, "newer draft");
  const version = w.store.get("docs/d/versions/v2");
  assert.equal(w.objects.get(`${version.storagePrefix}/index.html`).toString(), "draft");
}));
test("a deduplicated commit cannot clear a newer draft", () => world(async w => {
  w.store.get("docs/d/versions/v1").contentHash = hashBundleFiles([{ rel: "index.html", data: Buffer.from("draft") }]).contentHash;
  const transact = w.db.runTransaction.bind(w.db);
  w.db.runTransaction = fn => { newer(w); return transact(fn); };
  assert.equal((await commitDraft(w.args())).status, 409);
  assert.equal(w.store.get("docs/d").draft.storagePrefix, "docs/d/drafts/new");
}));
