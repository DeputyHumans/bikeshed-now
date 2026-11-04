// SPDX-License-Identifier: Apache-2.0
// `viewers` names exactly one collection, which the own-reading rule relies on (SPEC §4, ADR 0027).

/**
 * The rule that lets a person list their own reading is a recursive match,
 * `/{path=**}/viewers/{viewerId}`, because that is the only block a
 * collection-group query consults, and a recursive match cannot name its
 * parent. So it holds only while docs/{docId}/viewers is the one collection of
 * that name. A second one, anywhere, would be listable by its `uid` field the
 * day it was written.
 *
 * This pins every place the source names it. Adding a place is fine when it is
 * the same collection; adding a different collection called `viewers` means
 * the rule in config/templates/firestore.rules.tmpl must change first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["functions/src", "app/src", "scripts", "cli/src", "tools"];
const SKIP = /(^|\/)(node_modules|generated|dist)(\/|$)|\.test\.[cm]?[jt]sx?$/;

function* sources(dir) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SKIP.test(path)) continue;
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) yield path;
  }
}

/** A collection call naming `viewers`, or a path literal with a `viewers` segment. */
const NAMES = [
  /\.collection\(\s*(["'`])viewers\1\s*\)/g,
  /(?<!\.)\bcollection(?:Group)?\([^()]*?(["'`])viewers\1\s*\)/g,
  /(["'`])[^"'`\n]*\/viewers(?:\/[^"'`\n]*)?\1/g,
];

function occurrences() {
  const found = [];
  for (const dir of DIRS) {
    for (const file of sources(dir)) {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        for (const pattern of NAMES) {
          for (const m of code.matchAll(pattern)) {
            found.push(`${relative(ROOT, join(ROOT, file))}: ${m[0].replace(/\s+/g, "")}`);
          }
        }
      });
    }
  }
  return [...new Set(found)].sort();
}

test("every collection named `viewers` is docs/{docId}/viewers", () => {
  assert.deepEqual(
    occurrences(),
    [
      // Its one writer, recordView, under `docRef = db().collection("docs").doc(docId)`.
      'functions/src/index.ts: .collection("viewers")',
      // The editor's per-document breakdown.
      'app/src/firestore.ts: collection(db,"docs",docId,"viewers")',
      // Recent's own reads: the same collection, as a group (SPEC §5).
      'app/src/firestore.ts: collectionGroup(db,"viewers")',
    ].sort(),
    "A new place names a `viewers` collection. If it is docs/{docId}/viewers, add it here. If it is any other collection, the recursive own-reading rule in config/templates/firestore.rules.tmpl would let anyone list its rows by uid: change that rule first (ADR 0027).",
  );
});

test("the writer's parent is the docs collection", () => {
  const source = readFileSync(join(ROOT, "functions/src/index.ts"), "utf8");
  const writer = source.indexOf('docRef.collection("viewers")');
  const parent = source.lastIndexOf('const docRef = db().collection("docs").doc(docId);', writer);
  assert.ok(writer > 0 && parent > 0 && writer - parent < 4000, "recordView's viewers rows live under docs/{docId}");
});
