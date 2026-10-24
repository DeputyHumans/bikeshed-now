// SPDX-License-Identifier: Apache-2.0
// No new version while a suggestion is undecided, on any channel (SPEC §6a).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const admin = require("firebase-admin");

const { commitNewVersion } = require("../lib/lib/publish.js");
const { fakeFirestore } = require("./fakes.js");
const { acceptedInDraftMessage, pendingSuggestionsMessage, refuseIfPending } = require("../lib/lib/review.js");

/**
 * A document ref with just enough Firestore for commitNewVersion up to the
 * point it uploads: the dedup query, the version listing, and the pending
 * count under the base version's annotations.
 */
function fakeDocRef({ duplicateOf = null, pending = 0 } = {}) {
  const asked = [];
  const annotations = {
    where(field, op, value) {
      asked.push([field, op, value]);
      return { count: () => ({ get: async () => ({ data: () => ({ count: pending }) }) }) };
    },
  };
  const versions = {
    where: () => ({
      limit: () => ({
        get: async () =>
          duplicateOf
            ? { empty: false, docs: [{ id: duplicateOf }] }
            : { empty: true, docs: [] },
      }),
    }),
    get: async () => ({ docs: [{ id: "v1" }] }),
    doc: (id) => ({ id, get: async () => ({ id, exists: id === duplicateOf, data: () => ({ contentHash: require("../lib/lib/hash.js").hashBundleFiles(COMPILED.files).contentHash }) }), collection: (name) => (assert.equal(name, "annotations"), annotations) }),
  };
  // No draft: the accepted-in-draft guard has nothing to ask about.
  return { id: "d1", collection: () => versions, get: async () => ({ data: () => ({}) }), asked };
}

/** Make the upload observable: reaching Storage at all is what is asserted. */
function withStorageSentinel(fn) {
  const original = Object.getOwnPropertyDescriptor(admin, "storage");
  const previousBucket = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => {
      throw new Error("UPLOAD_REACHED");
    },
  });
  return fn().finally(() => {
    if (original) Object.defineProperty(admin, "storage", original);
    if (previousBucket === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = previousBucket;
  });
}

const COMPILED = { entry: "index.html", format: "html", files: [{ rel: "index.html", data: Buffer.from("<p>new</p>") }] };
const ACTOR = { uid: "u1", email: "ed@example.com", channel: "mcp" };

function update(docRef) {
  return commitNewVersion({
    db: {},
    docRef,
    compiled: COMPILED,
    actor: ACTOR,
    authorEmail: "ed@example.com",
    baseVersion: "v1",
    via: "mcp",
  });
}

test("an update over a pending suggestion is refused before a byte is uploaded", async () => {
  await withStorageSentinel(async () => {
    const docRef = fakeDocRef({ pending: 2 });
    const result = await update(docRef);
    assert.deepEqual(result, {
      error: pendingSuggestionsMessage(2),
      status: 409,
      pendingSuggestions: 2,
    });
    assert.deepEqual(docRef.asked, [["suggestion.state", "==", "pending"]]);
  });
});

test("an identical update is still a no-op, whatever is pending", async () => {
  // The dedup rule is what makes an update safe to retry; a refusal there
  // would make retrying a finished update look like a failure.
  await withStorageSentinel(async () => {
    const result = await update(fakeDocRef({ duplicateOf: "v1", pending: 3 }));
    assert.equal(result.deduped, true);
    assert.equal(result.versionId, "v1");
  });
});

test("with nothing pending, an update goes on to upload", async () => {
  await withStorageSentinel(async () => {
    await assert.rejects(update(fakeDocRef({ pending: 0 })), /UPLOAD_REACHED/);
  });
});

test("a version with no id has nothing pending, and is not queried", async () => {
  const docRef = fakeDocRef({ pending: 5 });
  assert.equal(await refuseIfPending(docRef, ""), null);
  assert.deepEqual(docRef.asked, []);
});

test("the refusal says who can clear it, in the singular and the plural", () => {
  assert.equal(
    pendingSuggestionsMessage(1),
    "1 suggested edit is waiting for a decision. Only the owner or an approver can accept or reject it, and no new version can be published until then. If it is yours, you may withdraw it.",
  );
  assert.match(pendingSuggestionsMessage(3), /^3 suggested edits are waiting .* reject them,/);
  assert.match(pendingSuggestionsMessage(3), /Any that are yours you may withdraw\.$/, "and that its author may take one back");
});

test("both version-minting endpoints ask about pending suggestions, in the right place", () => {
  /**
   * The behaviour above is checked on commitNewVersion; the in-app commit runs
   * inside an HTTP handler and a transaction, so its shape is pinned instead.
   * Each must ask before it can write: the update before uploading, the commit
   * before its transaction moves currentVersion.
   */
  const src = (...p) => readFileSync(join(__dirname, "..", "src", ...p), "utf8");
  const between = (text, from, to) => {
    const start = text.indexOf(from);
    assert.ok(start >= 0, `${from} not found`);
    const end = text.indexOf(to, start + from.length);
    return text.slice(start, end < 0 ? undefined : end);
  };

  const update = between(src("lib", "publish.ts"), "export async function commitNewVersion(", "\nexport ");
  const dedup = update.indexOf("if (dup?.exists");
  const gate = update.indexOf("refuseIfPending(");
  const upload = update.indexOf("uploadBundle(");
  assert.ok(dedup >= 0 && gate > dedup, "the gate must come after the dedup, so a retry stays a no-op");
  assert.ok(upload > gate, "the gate must come before the upload, so a refusal leaves no bytes");

  // The in-app commit and commit_draft both publish through commitDraft.
  const commit = between(src("lib", "draft.ts"), "export async function commitDraft(", "\nexport ");
  const asks = commit.indexOf("openThreadsRefusal(docRef, baseVersion)");
  const writes = commit.indexOf("runTransaction(");
  assert.ok(asks >= 0 && writes > asks, "the in-app commit must ask before its transaction");
  const helper = between(src("lib", "draft.ts"), "export async function openThreadsRefusal(", "\n}\n");
  assert.ok(helper.includes("pendingSuggestions(docRef, baseVersion)"), "and say whether a suggestion is what holds it");
});

/**
 * A real-enough Firestore and a Storage whose every save runs `during`: what
 * somebody else does while this version's bytes are uploading.
 */
async function updateWhile(during) {
  const { db, store } = fakeFirestore({
    "docs/d1": { docId: "d1", currentVersion: "v1", ownerEmail: "ed@example.com" },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", contentHash: "old" },
  });
  const original = Object.getOwnPropertyDescriptor(admin, "storage");
  const previousBucket = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  let ran = false;
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({
        file: () => ({
          save: async () => {
            if (!ran) during(store);
            ran = true;
          },
        }),
      }),
    }),
  });
  try {
    const result = await commitNewVersion({
      db,
      docRef: db.collection("docs").doc("d1"),
      compiled: COMPILED,
      actor: ACTOR,
      authorEmail: "ed@example.com",
      baseVersion: "v1",
      via: "mcp",
    });
    return { result, store };
  } finally {
    if (original) Object.defineProperty(admin, "storage", original);
    if (previousBucket === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = previousBucket;
  }
}

test("a suggestion made while an update uploads still holds it back", async () => {
  // The gate counted before the upload; the version became current after it.
  const { result, store } = await updateWhile((store) =>
    store.set("docs/d1/versions/v1/annotations/late", { annId: "late", resolved: false, suggestion: { state: "pending" } }),
  );
  assert.equal(result.status, 409);
  assert.equal(result.pendingSuggestions, 1);
  assert.equal(store.get("docs/d1").currentVersion, "v1", "no version left the suggestion behind");
});

test("an update that another publish overtook is refused, not stacked on the old base", async () => {
  const { result, store } = await updateWhile((store) => {
    store.set("docs/d1/versions/v2", { versionId: "v2", entry: "index.html", contentHash: "theirs" });
    store.set("docs/d1", { ...store.get("docs/d1"), currentVersion: "v2" });
  });
  assert.equal(result.status, 409);
  assert.match(result.error, /newer version/);
  assert.equal(store.get("docs/d1").currentVersion, "v2", "theirs stays current");
});

test("the in-app commit asks again inside the transaction that makes the version current", () => {
  // Its count runs before the upload; a thread opened during the upload would
  // otherwise be left on a version nobody reads any more.
  const src = readFileSync(join(__dirname, "..", "src", "lib", "draft.ts"), "utf8");
  const start = src.indexOf("export async function commitDraft(");
  assert.ok(start >= 0, "commitDraft not found");
  const commit = src.slice(start, src.indexOf("\nexport ", start + 1));
  const tx = commit.slice(commit.indexOf("runTransaction("));
  const asks = tx.indexOf("anyOpenThread(tx,");
  const moves = tx.indexOf("currentVersion: versionId");
  assert.ok(asks >= 0 && moves > asks, "the transaction must look for open threads before it moves currentVersion");
});

/** A document whose current version has a draft, and an accepted suggestion on it. */
function acceptedWorld({ draft = { baseVersion: "v1", entry: "index.html" }, state = "accepted" } = {}) {
  return fakeFirestore({
    "docs/d1": { docId: "d1", currentVersion: "v1", ownerEmail: "ed@example.com", ...(draft ? { draft } : {}) },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", contentHash: "old" },
    "docs/d1/versions/v1/annotations/s1": { annId: "s1", resolved: state !== "pending", suggestion: { state } },
  });
}

function updateIn(db) {
  return commitNewVersion({
    db,
    docRef: db.collection("docs").doc("d1"),
    compiled: COMPILED,
    actor: ACTOR,
    authorEmail: "ed@example.com",
    baseVersion: "v1",
    via: "mcp",
  });
}

test("an update that would replace a draft holding an accepted change is refused before a byte is uploaded", async () => {
  // Accepting puts the change in the draft; this path deletes the draft.
  await withStorageSentinel(async () => {
    const { db, store } = acceptedWorld();
    const result = await updateIn(db);
    assert.deepEqual(result, { error: acceptedInDraftMessage(1), status: 409, acceptedInDraft: 1 });
    assert.ok(store.get("docs/d1").draft, "the draft is kept");
    assert.match(acceptedInDraftMessage(2), /holds 2 accepted suggestions, .* lose them\. Publish the draft first/);
  });
});

test("an accepted suggestion with no draft to lose, or a draft with nothing accepted, does not hold an update", async () => {
  await withStorageSentinel(async () => {
    await assert.rejects(updateIn(acceptedWorld({ draft: null }).db), /UPLOAD_REACHED/, "the draft was published or discarded");
    await assert.rejects(updateIn(acceptedWorld({ state: "rejected" }).db), /UPLOAD_REACHED/, "a person's draft with nothing accepted in it");
    await assert.rejects(
      updateIn(acceptedWorld({ draft: { baseVersion: "v0", entry: "index.html" } }).db),
      /UPLOAD_REACHED/,
      "a draft of another version holds nothing accepted on this one",
    );
  });
});

test("a change accepted into the draft while an update uploads still holds it back", async () => {
  const { result, store } = await updateWhile((store) => {
    store.set("docs/d1", { ...store.get("docs/d1"), draft: { baseVersion: "v1", entry: "index.html" } });
    store.set("docs/d1/versions/v1/annotations/s1", { annId: "s1", resolved: true, suggestion: { state: "accepted" } });
  });
  assert.equal(result.status, 409);
  assert.equal(result.acceptedInDraft, 1);
  assert.equal(store.get("docs/d1").currentVersion, "v1", "no version replaced the draft");
  assert.ok(store.get("docs/d1").draft, "and the draft is still there");
});
