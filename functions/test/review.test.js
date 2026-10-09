// SPDX-License-Identifier: Apache-2.0
// No new version while a suggestion is undecided, on any channel (SPEC §6a).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const admin = require("firebase-admin");

const { commitNewVersion } = require("../lib/lib/publish.js");
const { pendingSuggestionsMessage, refuseIfPending } = require("../lib/lib/review.js");

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
    doc: () => ({ collection: (name) => (assert.equal(name, "annotations"), annotations) }),
  };
  return { id: "d1", collection: () => versions, asked };
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
  const dedup = update.indexOf('where("contentHash", "==", contentHash)');
  const gate = update.indexOf("refuseIfPending(");
  const upload = update.indexOf("uploadBundle(");
  assert.ok(dedup >= 0 && gate > dedup, "the gate must come after the dedup, so a retry stays a no-op");
  assert.ok(upload > gate, "the gate must come before the upload, so a refusal leaves no bytes");

  const commit = between(src("index.ts"), "export const commitVersion = onRequest(", "\nexport const ");
  const asks = commit.indexOf("pendingSuggestions(docRef, baseVersion)");
  const writes = commit.indexOf("runTransaction(");
  assert.ok(asks >= 0 && writes > asks, "the in-app commit must ask before its transaction");
});
