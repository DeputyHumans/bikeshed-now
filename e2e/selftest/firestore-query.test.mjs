// SPDX-License-Identifier: Apache-2.0
// Self-test: clientFirestore.runQuery sends the app's query as a signed-in or anonymous client, decodes the stream, and stays a read to the production guard (SPEC §4, §5, §12).

/**
 * The request is judged against what the Firestore REST API takes for
 * documents:runQuery (POST, `{structuredQuery}`, the parent's path before the
 * colon) and the answer against what it streams back: an array of
 * `{document?, readTime}` rows, or an error. A rules refusal is a 403 whose
 * array holds the error, and is DENY; an error inside a 200 is never ALLOW.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { evaluate } from "../lib/guard.mjs";
import { FIRESTORE_PUBLIC_ORIGIN, clientFirestore, toValue } from "../lib/firestore-client.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PROJECT = "demo-fsquery";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const LOCAL = Object.freeze({
  kind: "local",
  runId: "2610102300-fsq",
  runDir: tempDir("e2e-fsq-"),
  projectId: PROJECT,
  origin: "http://127.0.0.1:39011",
  firestoreUrl: "http://127.0.0.1:39013",
  stack: { ports: { hosting: 39011, auth: 39012, firestore: 39013 } },
});
const PROD = Object.freeze({ kind: "prod", runId: "2610102300-fsqp", runDir: tempDir("e2e-fsqp-"), projectId: PROJECT, origin: "https://fsq-selftest.invalid" });

/** The app's workspace query (app/src/firestore.ts listMyDocs). */
const WORKSPACE = (email) => ({
  from: [{ collectionId: "docs" }],
  where: { fieldFilter: { field: { fieldPath: "members" }, op: "ARRAY_CONTAINS", value: toValue(email) } },
  orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return reply(String(url), init);
  };
  return { calls, fetch };
}

const docRow = (rel, fields) => ({ document: { name: `${ROOT}/${rel}`, fields, createTime: "c", updateTime: "u" }, readTime: "r" });

test("runQuery: POST <documents>:runQuery with {structuredQuery} and the caller's token; the stream's documents are decoded, its bare readTime rows skipped", async () => {
  const rec = recorder(() => json(200, [docRow("docs/a", { title: { stringValue: "A" } }), docRow("docs/b", { title: { stringValue: "B" } }), { readTime: "r" }]));
  const http = createHttp(LOCAL, { evidence: false, fetch: rec.fetch });
  const fs = clientFirestore(LOCAL, { idToken: "tok-q", http });
  const q = WORKSPACE("owner@example.com");
  const r = await fs.runQuery(q);
  assert.deepEqual([r.status, r.ok, r.verdict, r.denied, r.code], [200, true, "ALLOW", false, null]);
  assert.deepEqual(r.docs.map((d) => [d.path, d.id, d.data.title]), [["docs/a", "a", "A"], ["docs/b", "b", "B"]]);
  assert.equal(rec.calls[0].method, "POST");
  assert.equal(rec.calls[0].url, `${LOCAL.firestoreUrl}/v1/${ROOT}:runQuery`);
  assert.deepEqual(rec.calls[0].body, { structuredQuery: q });
  assert.equal(rec.calls[0].headers.authorization, "Bearer tok-q");
  assert.equal(rec.calls[0].headers.cookie, undefined);

  await fs.runQuery({ from: [{ collectionId: "annotations" }] }, { parent: "docs/d 1/versions/v1" });
  assert.equal(rec.calls[1].url, `${LOCAL.firestoreUrl}/v1/${ROOT}/docs/d%201/versions/v1:runQuery`, "a subcollection query names its parent document, encoded");

  const anon = recorder(() => json(200, [{ readTime: "r" }]));
  const empty = await clientFirestore(LOCAL, { idToken: null, http: createHttp(LOCAL, { evidence: false, fetch: anon.fetch }) }).runQuery({ from: [{ collectionId: "public" }] });
  assert.deepEqual([empty.verdict, empty.docs], ["ALLOW", []], "an empty result is still an ALLOW");
  assert.equal(anon.calls[0].headers.authorization, undefined, "anonymous: no Authorization at all");
});

test("NEGATIVE: a rules refusal is DENY with no documents; an error inside a 200 is never ALLOW; a bad query or parent never goes", async () => {
  const denied = recorder(() => json(403, [{ error: { code: 403, status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." } }]));
  const r = await clientFirestore(LOCAL, { idToken: null, http: createHttp(LOCAL, { evidence: false, fetch: denied.fetch }) }).runQuery({ from: [{ collectionId: "public" }] });
  assert.deepEqual([r.status, r.ok, r.verdict, r.denied, r.code, r.docs], [403, false, "DENY", true, "PERMISSION_DENIED", []]);

  const midstream = recorder(() => json(200, [docRow("docs/a", {}), { error: { code: 403, status: "PERMISSION_DENIED", message: "late" } }]));
  const m = await clientFirestore(LOCAL, { idToken: "t", http: createHttp(LOCAL, { evidence: false, fetch: midstream.fetch }) }).runQuery(WORKSPACE("x@example.com"));
  assert.deepEqual([m.status, m.ok, m.verdict, m.denied, m.code, m.message, m.docs], [200, false, null, false, "PERMISSION_DENIED", "late", []]);

  const none = recorder(() => json(200, []));
  const fs = clientFirestore(LOCAL, { idToken: "t", http: createHttp(LOCAL, { evidence: false, fetch: none.fetch }) });
  await assert.rejects(fs.runQuery(null), /structuredQuery/);
  await assert.rejects(fs.runQuery([{ from: [] }]), /structuredQuery/);
  await assert.rejects(fs.runQuery({ from: [] }, { parent: "docs" }), /collection, not a document/);
  assert.equal(none.calls.length, 0, "nothing was sent");
});

test("the production guard reads runQuery as a read, at the root and under a parent", () => {
  const base = `${FIRESTORE_PUBLIC_ORIGIN}/v1/${ROOT}`;
  const ctx = { target: PROD, ledgerDocs: new Set(), ledgerFolders: new Set(), ledgerAbsent: new Set(), ledgerUids: new Set() };
  for (const url of [`${base}:runQuery`, `${base}/docs/someone-elses/versions/v1:runQuery`]) {
    const v = evaluate({ method: "POST", url, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "annotations" }] } }) }, ctx);
    assert.deepEqual([v.allow, v.rule], [true, "firestore-read"], url);
  }
  assert.equal(clientFirestore(PROD, { http: createHttp(PROD, { evidence: false }) }).base, base, "and that is where runQuery goes on production");
});
