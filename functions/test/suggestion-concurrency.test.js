// SPDX-License-Identifier: Apache-2.0
// Pending-suggestion admission is atomic even when requests share the last available slot (SPEC §22).

const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore } = require("./fakes.js");
const { createSuggestion, SUGGESTION_LIMITS } = require("../lib/lib/suggestions.js");

test("two simultaneous creates share one remaining pending-suggestion slot", async () => {
  const limit = SUGGESTION_LIMITS.pendingPerAuthor;
  const { db, store } = fakeFirestore({
    "docs/d": { currentVersion: "v1" },
    ...Object.fromEntries(Array.from({ length: limit - 1 }, (_, i) => [
      `docs/d/versions/v1/annotations/seed-${i}`,
      { authorUid: "author", suggestion: { state: "pending", replacement: "before" } },
    ])),
  });
  const create = (replacement) => createSuggestion({
    db, docRef: db.doc("docs/d"), versionId: "v1",
    anchor: { exact: "word", prefix: "", suffix: "", start: 0, end: 4 },
    replacement, note: "", color: "blue",
    author: { uid: "author", emailLower: "author@example.com" },
    actor: { uid: "author", email: "author@example.com", channel: "web" },
  });
  const results = await Promise.all([create("first"), create("second")]);
  assert.equal(results.filter((r) => r.annId).length, 1, "only one request gets the final slot");
  assert.equal(results.filter((r) => r.status === 409).length, 1, "the other request receives the normal limit refusal");
  assert.equal([...store].filter(([p, d]) => p.includes("/annotations/") && d.suggestion?.state === "pending").length, limit);
  assert.equal([...store.keys()].filter((p) => p.includes("/comments/")).length, 1, "the refused create writes no opening comment");
});
