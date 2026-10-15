// SPDX-License-Identifier: Apache-2.0
// An owner's changed export policy reaches public readers without exposing account or version metadata (SPEC §17, §20).

const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { setMarking } = require("../lib/index.js");
const { readerProjection, syncPublicProjection } = require("../lib/lib/publicdoc.js");

test("reader projections provide the version's download choices and no private version fields", async () => {
  const meta = { visibility: "unlisted", currentVersion: "v2", sourceEntry: "stale.md", fileCount: 99 };
  const { db } = fakeFirestore({
    "docs/d": meta,
    "docs/d/versions/v2": { entry: "index.html", format: "markdown", sourceEntry: "index.md", fileCount: 2, uploadedByEmail: "private@example.com", storagePrefix: "private-prefix" },
  });
  const projection = await readerProjection(db.doc("docs/d"), meta);
  assert.equal(projection.sourceEntry, "index.md");
  assert.equal(projection.fileCount, 2);
  assert.ok(!JSON.stringify(projection).includes("private"));
});

test("changing public marking refreshes the reader mirror, including explicit off", async () => {
  const old = { enabled: true, label: "Old", footer: "Old footer" };
  const { db, store } = fakeFirestore({
    "docs/d": { ownerUid: "owner", ownerEmail: "owner@example.com", members: ["owner@example.com"], visibility: "public", currentVersion: "v1", title: "Public", marking: old },
    "docs/d/versions/v1": { entry: "index.html", format: "html", fileCount: 3 },
  });
  await withFakeAdmin({ db, sessions: { s: { uid: "owner", email: "owner@example.com", email_verified: true } } }, async () => {
    await syncPublicProjection(db, "d");
    for (const marking of [{ enabled: true, label: "Changed", footer: "New footer" }, { enabled: false, label: "", footer: "" }]) {
      const response = await invoke(setMarking, { headers: { cookie: "__session=s" }, body: { docId: "d", marking } });
      assert.equal(response.status, 200);
      assert.deepEqual(store.get("public/d").marking, marking);
      assert.equal(store.get("public/d").fileCount, 3);
      assert.ok(!("ownerEmail" in store.get("public/d")));
    }
  });
});
