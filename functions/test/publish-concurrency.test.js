// SPDX-License-Identifier: Apache-2.0
// Concurrent version uploads preserve the winning record's own immutable bundle bytes (SPEC §2, §6a).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { commitNewVersion } = require("../lib/lib/publish.js");
const { hashBundleFiles } = require("../lib/lib/hash.js");

const actor = { uid: "owner", email: "owner@example.com", channel: "mcp" };

test("concurrent uploads cannot replace the winning version's bytes", async () => {
  const { db, store } = fakeFirestore({
    "docs/d": { currentVersion: "v1", ownerEmail: actor.email, visibility: "private" },
    "docs/d/versions/v1": { entry: "index.html", contentHash: "old" },
  });
  const objects = new Map();
  const saved = ["storage", "database"].map((key) => [key, Object.getOwnPropertyDescriptor(admin, key)]);
  const before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  let uploads = 0;
  let release;
  const bothUploaded = new Promise((resolve) => { release = resolve; });
  Object.defineProperty(admin, "database", { configurable: true, value: () => { throw new Error("not configured"); } });
  Object.defineProperty(admin, "storage", { configurable: true, value: () => ({ bucket: () => ({
    file: (name) => ({ save: async (data) => {
      objects.set(name, Buffer.from(data));
      if (++uploads === 2) release();
      await bothUploaded;
    } }),
    deleteFiles: async ({ prefix }) => { for (const name of objects.keys()) if (name.startsWith(prefix)) objects.delete(name); },
  }) }) });
  try {
    await withFakeAdmin({ db }, async () => {
      const update = (text) => commitNewVersion({
        db, docRef: db.doc("docs/d"), actor, authorEmail: actor.email, baseVersion: "v1", via: "mcp",
        compiled: { entry: "index.html", format: "html", files: [{ rel: "index.html", data: Buffer.from(text) }] },
      });
      const results = await Promise.all([update("<p>first upload</p>"), update("<p>second upload</p>")]);
      assert.equal(results.filter((r) => r.versionId === "v2").length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 1);
      const version = store.get("docs/d/versions/v2");
      const prefix = `${version.storagePrefix}/`;
      const bytes = [...objects].filter(([name]) => name.startsWith(prefix)).map(([name, data]) => ({ rel: name.slice(prefix.length), data }));
      assert.equal(hashBundleFiles(bytes).contentHash, version.contentHash, "published hash belongs to the bytes actually served");
      assert.equal(bytes.length, version.fileCount);
      assert.equal(bytes.reduce((n, f) => n + f.data.length, 0), version.bytes);
    });
  } finally {
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(admin, key, descriptor); else delete admin[key]; }
    if (before === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = before;
  }
});
