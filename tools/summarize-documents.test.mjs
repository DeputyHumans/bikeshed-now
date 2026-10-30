// SPDX-License-Identifier: Apache-2.0
// The summary backfill asks only for documents the trigger has not yet counted and summarized (SPEC §4, §17).

import test from "node:test";
import assert from "node:assert/strict";
import { summaryWanted } from "../scripts/summarize-documents.mjs";

test("a document is asked for until its current version is counted and summarized, and never after", () => {
  const doc = { currentVersion: "v3" };
  assert.equal(summaryWanted(doc, { entry: "index.html" }), "its current version is not counted");
  assert.equal(summaryWanted(doc, { words: 120 }), "it has no summary of its current version");
  assert.equal(summaryWanted({ ...doc, latest: { version: "v2", words: 120 } }, { words: 120 }), "it has no summary of its current version", "a summary of an older version");
  assert.equal(summaryWanted({ ...doc, latest: { version: "v3" } }, { words: 120 }), "its summary has not caught up with the count");
  assert.equal(summaryWanted({ ...doc, latest: { version: "v3", words: 120 } }, { words: 120 }), null, "done: a second run finds nothing");
});

test("a document with no current version, or none on record, is left alone", () => {
  assert.equal(summaryWanted({}, { words: 1 }), null);
  assert.equal(summaryWanted({ currentVersion: "v1" }, undefined), null);
});
