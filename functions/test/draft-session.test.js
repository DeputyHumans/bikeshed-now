// SPDX-License-Identifier: Apache-2.0
// A prepared editor snapshot is opaque and its content read refuses intervening draft changes (SPEC §6a).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { getDraft } = require("../lib/index.js");
const { storedCausalStamp } = require("../lib/lib/causal.js");
const { draftRevision } = require("../lib/lib/draft.js");

const owner = { uid: "owner", email: "owner@example.com", email_verified: true };
function world() {
  return fakeFirestore({
    "docs/d": { currentVersion: "v1", liveEpoch: "first", ownerUid: owner.uid, ownerEmail: owner.email, draft: { baseVersion: "v1", entry: "index.html", storagePrefix: "docs/d/bundles/private-path", updatedByEmail: owner.email } },
    "docs/d/versions/v1": { entry: "index.html", format: "html" },
  });
}
const req = { method: "GET", path: "/draft/d", headers: { cookie: "__session=s" } };

test("editor session contains only the entry and checked opaque identities, never private draft metadata", async () => {
  const { db, store } = world();
  await withFakeAdmin({ db, sessions: { s: owner } }, async () => {
    const response = await invoke(getDraft, { ...req, query: { session: "1", baseVersion: "v1" } });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ["baseVersion", "draftRevision", "entry", "liveEpoch"]);
    assert.deepEqual(response.body, { baseVersion: "v1", draftRevision: draftRevision(store.get("docs/d")), entry: "index.html", liveEpoch: "first" });
    assert.match(response.body.draftRevision, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(response.body).includes("private-path"));
    assert.ok(!JSON.stringify(response.body).includes(owner.email));
    assert.match(response.headers["cache-control"], /no-store/);
    const denied = await invoke(getDraft, { ...req, headers: {}, query: { session: "1" } });
    assert.equal(denied.status, 401);
  });
});

for (const [field, value] of [["draftRevision", "0".repeat(64)], ["liveEpoch", "stale"], ["baseVersion", "v0"]]) {
  test(`an editor frame with an outdated ${field} refuses before reading storage`, async () => {
    const { db, store } = world();
    const query = { draftRevision: draftRevision(store.get("docs/d")), liveEpoch: "first", baseVersion: "v1", [field]: value };
    const descriptor = Object.getOwnPropertyDescriptor(admin, "storage");
    let touched = false;
    Object.defineProperty(admin, "storage", { configurable: true, value: () => { touched = true; throw new Error("stale frame reached bytes"); } });
    try {
      await withFakeAdmin({ db, sessions: { s: owner } }, async () => {
        const response = await invoke(getDraft, { ...req, path: "/draft/d/index.html", query });
        assert.equal(response.status, 409);
        assert.equal(response.body.draftChanged, true);
        assert.equal(touched, false);
      });
    } finally { if (descriptor) Object.defineProperty(admin, "storage", descriptor); else delete admin.storage; }
  });
}

for (const [reason, change, headers, status] of [
  ["signed out", {}, {}, 401],
  ["revoked", { ownerEmail: "someone@example.com", ownerUid: "someone" }, req.headers, 404],
  ["expired", { expiresAt: 1 }, req.headers, 409],
]) test(`a ${reason} editor read cannot masquerade as empty editable HTML`, async () => {
  const { db } = world();
  await db.doc("docs/d").update(change);
  await withFakeAdmin({ db, sessions: { s: owner } }, async () => {
    const response = await invoke(getDraft, { ...req, headers });
    assert.equal(response.status, status);
    assert.match(response.headers["content-type"], /^application\/json/);
  });
});

test("a draft deleted between existence check and stream is refused as non-HTML", async () => {
  const { db } = world();
  const descriptor = Object.getOwnPropertyDescriptor(admin, "storage");
  const env = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({ file: () => ({
    exists: async () => [true],
    createReadStream: () => {
      let error;
      return { on: (_name, fn) => { error = fn; }, pipe: () => queueMicrotask(() => error({ code: 404 })) };
    },
  }) }) }) });
  try {
    await withFakeAdmin({ db, sessions: { s: owner } }, async () => {
      const response = await invoke(getDraft, { ...req, path: "/draft/d/index.html" });
      assert.equal(response.status, 404);
      assert.match(response.headers["content-type"], /^application\/json/);
    });
  } finally {
    if (descriptor) Object.defineProperty(admin, "storage", descriptor); else delete admin.storage;
    if (env === undefined) delete process.env.BIKESHED_BUCKET; else process.env.BIKESHED_BUCKET = env;
  }
});

test("the HTTP draft path enforces the supplied revision and retires successful unclocked snapshots", async () => {
  const { saveDraft } = require("../lib/index.js");
  const { db, store } = world();
  const objects = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(admin, "storage");
  const env = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({
    file: (name) => ({ save: async (data) => { objects.set(name, Buffer.from(data)); } }),
    deleteFiles: async ({ prefix }) => { for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key); },
  }) }) });
  try {
    await withFakeAdmin({ db, sessions: { s: owner } }, async () => {
      const opened = draftRevision(store.get("docs/d"));
      const call = (body) => invoke(saveDraft, { headers: req.headers, body: { docId: "d", baseVersion: "v1", html: "<p>solo work</p>", ...body } });
      const stale = await call({ liveEpoch: "first", draftRevision: "0".repeat(64) });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.draftChanged, true);
      assert.equal(stale.body.reloadRequired, true);
      const first = await call({ liveEpoch: "first", draftRevision: opened });
      assert.equal(first.status, 200);
      assert.notEqual(first.body.draft.liveEpoch, "first");
      assert.equal(first.body.draft.liveEpoch, store.get("docs/d").liveEpoch);
      const second = await call({ liveEpoch: first.body.draft.liveEpoch, draftRevision: first.body.draft.draftRevision, html: "<p>more solo work</p>" });
      assert.equal(second.status, 200);
      const member = await call({ liveEpoch: "first", causal: { generation: "a".repeat(64), vector: { 1: 1 }, deletes: {} }, html: "<p>stale member</p>" });
      assert.equal(member.status, 409);
      assert.equal(member.body.liveReset, true);
      assert.equal(objects.get(`${store.get("docs/d").draft.storagePrefix}/index.html`).toString(), "<p>more solo work</p>");
    });
  } finally {
    if (descriptor) Object.defineProperty(admin, "storage", descriptor); else delete admin.storage;
    if (env === undefined) delete process.env.BIKESHED_BUCKET; else process.env.BIKESHED_BUCKET = env;
  }
});


test("session carries the validated saved causal frontier without its private draft metadata", async () => {
  const { db } = world();
  const causal = { generation: "a".repeat(64), vector: { "12": 9 }, deletes: { "12": [[2, 3]] } };
  await db.doc("docs/d").update({ "draft.causal": { ...storedCausalStamp(causal), private: "not-for-the-client" } });
  await withFakeAdmin({ db, sessions: { s: owner } }, async () => {
    const response = await invoke(getDraft, { ...req, query: { session: "1", baseVersion: "v1" } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.causal, causal);
    assert.match(response.headers["cache-control"], /no-store/);
    assert.ok(!JSON.stringify(response.body).includes("private-path"));
    assert.ok(!JSON.stringify(response.body).includes("not-for-the-client"));
  });
});
