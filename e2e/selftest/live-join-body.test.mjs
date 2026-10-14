// SPDX-License-Identifier: Apache-2.0
// Self-test: joinShared publishes a generated body in place of its fixture, and a fixture exactly as before (SPEC §6b, §12).

/**
 * joinShared({body}) must send the BODY's bytes: seed.mjs publish reads a
 * fixture in place of a body, so a fixture passed beside one wins there.
 * joinPublishOptions decides what reaches publish; these cases feed its
 * options to the real publish over a recording stand-in for the HTTP client
 * and read the bytes and the filename it would POST. The last case pins
 * joinShared to it (a structural check: joinShared itself needs a stack).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { joinPublishOptions } from "../lib/live.mjs";
import { publish, readFixture } from "../lib/seed.mjs";

/** A stand-in for session.http: records each request and answers 200 with no document (so nothing is ledgered). */
function recordingHttp() {
  const sent = [];
  return {
    sent,
    target: { kind: "local", runId: "selftest-join-body", capabilities: new Set(["local"]) },
    actor: "selftest",
    async request(method, path, o = {}) {
      sent.push({ method, path, query: o.query, body: Buffer.from(o.body) });
      return { status: 200, json: {} };
    },
  };
}

/** What publish POSTs for joinShared's options: {path, filename, bytes}. */
async function posted(o) {
  const http = recordingHttp();
  await publish(http, { ...joinPublishOptions(o).options, title: "t", name: "live", timeoutMs: 1_000 });
  assert.equal(http.sent.length, 1);
  const [r] = http.sent;
  return { path: r.path, filename: r.query.filename, bytes: r.body };
}

const BODY = '<!doctype html><html><body><p id="gen-1">GENERATED-MARKER-7f3</p></body></html>';

test("a body is what publish sends, as index.html, even beside a fixture (the body wins)", async () => {
  const fixture = readFixture("crdt-paragraphs.html", { raw: true });
  const one = await posted({ body: BODY });
  assert.deepEqual([one.path, one.filename, one.bytes.toString("utf8")], ["/publish", "index.html", BODY]);
  const both = await posted({ fixture: "crdt-paragraphs.html", body: BODY });
  assert.equal(both.bytes.toString("utf8"), BODY, "NEGATIVE CONTROL: with the fixture passed beside the body, publish would send the fixture's bytes");
  assert.notDeepEqual(both.bytes, fixture);
  assert.equal(both.filename, "index.html");
  const named = await posted({ body: Buffer.from(BODY), filename: "deck.html" });
  assert.deepEqual([named.filename, named.bytes.toString("utf8")], ["deck.html", BODY], "a Buffer and a named file");
  assert.deepEqual(Object.keys(joinPublishOptions({ fixture: "crdt-paragraphs.html", body: BODY }).options).sort(), ["body", "filename"], "no fixture reaches publish beside a body");
});

test("no body: the fixture exactly as before (its own name as the filename, the same options)", async () => {
  assert.deepEqual(joinPublishOptions({}), { options: { fixture: "crdt-paragraphs.html" }, label: "crdt-paragraphs.html" }, "the default, unchanged");
  assert.deepEqual(joinPublishOptions({ fixture: "large-doc.html" }).options, { fixture: "large-doc.html" });
  const p = await posted({ fixture: "large-doc.html" });
  assert.equal(p.filename, "large-doc.html");
  assert.deepEqual(p.bytes, readFixture("large-doc.html", { raw: true }));
  assert.deepEqual(joinPublishOptions({ fixture: "large-doc.html", filename: "index.html" }).options, { fixture: "large-doc.html", filename: "index.html" }, "a named filename rides along");
  assert.equal((await posted({ fixture: "large-doc.html", filename: "index.html" })).filename, "index.html");
});

test("the step names the body's size; empty or non-byte bodies and bad names are refused", () => {
  assert.equal(joinPublishOptions({ body: BODY }).label, `a ${Buffer.byteLength(BODY)}-byte index.html`);
  assert.equal(joinPublishOptions({ body: "x".repeat(81_000) }).label, "a 79 KB index.html");
  assert.throws(() => joinPublishOptions({ body: "" }), /body is empty/);
  assert.throws(() => joinPublishOptions({ body: 42 }), /body is the document's bytes/);
  assert.throws(() => joinPublishOptions({ body: BODY, filename: "" }), /filename is a file name/);
  assert.throws(() => joinPublishOptions({ fixture: null }), /give a fixture or a body/);
});

test("joinShared takes body and filename and publishes through joinPublishOptions (structural pin)", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/live.mjs", import.meta.url)), "utf8");
  const start = src.indexOf("export async function joinShared(");
  assert.ok(start >= 0);
  const fn = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(fn.split("\n")[0], /\{ n, fixture = "crdt-paragraphs\.html", body = null, filename = null, title = "e2e live", batch = 5, enter = true, waitShared = true, seedFirst = true, sharedMs = 90_000, openMs = 90_000(?:, grantVia = null(?:, role = "editor", extra = \[\], notifications = undefined, beforeJoin = null, impl = null(?:, mirror = "stop")?)?)? \} = \{\}/, "the signature: body and filename beside the old options and defaults (and grantVia, pinned by live-join-grants.test.mjs; role, extra, notifications, beforeJoin and impl by live-join-roles.test.mjs; mirror by mirror-write.test.mjs)");
  assert.match(fn, /const doc = joinPublishOptions\(\{ fixture, body, filename \}\);/);
  assert.match(fn, /await publish\(owner\.http, \{ \.\.\.doc\.options, title, name: "live", timeoutMs: 120_000 \}\)/, "NEGATIVE CONTROL: the old call, publish(owner.http, {fixture, …}), ignores a body");
  assert.doesNotMatch(fn, /publish\(owner\.http, \{ fixture/);
  // enter: false returns before the seed precondition (C7 enters each editor itself).
  const enterAt = fn.indexOf("if (enter) {");
  assert.ok(enterAt > 0 && fn.indexOf("status/${docId}/y") > enterAt, "the seed wait is inside the enter branch");
});
