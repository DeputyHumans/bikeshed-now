// SPDX-License-Identifier: Apache-2.0
// Self-test: clientFirestore.set sends setDoc's write, with and without merge, and a session is the caller it names (SPEC §6c, §12).

/**
 * The app's own client writes are mostly setDoc: personal trust
 * (app/src/trust.ts), annotations and comments (app/src/firestore.ts), and
 * the account record with `{merge: true}` (saveUserProfile). The write the
 * web SDK sends for each (its parseSetData and toMutation): without merge a
 * whole document and NO precondition, so the rules judge a create or an
 * update by what is stored; with merge a mask of every leaf path of the data,
 * server timestamps as transforms outside the mask. The expected writes here
 * are written out by hand from those two functions, not taken from this lib.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { clientFirestore, mergeMask } from "../lib/firestore-client.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PROJECT = "demo-fsset";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const LOCAL = Object.freeze({
  kind: "local",
  runId: "2610110300-fsst",
  runDir: tempDir("e2e-fsst-"),
  projectId: PROJECT,
  origin: "http://127.0.0.1:39011",
  firestoreUrl: "http://127.0.0.1:39013",
  stack: { ports: { hosting: 39011, auth: 39012, firestore: 39013 } },
});
const COMMIT = `${LOCAL.firestoreUrl}/v1/${ROOT}:commit`;

function recorder() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return new Response(JSON.stringify({ writeResults: [{}] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

const s = (v) => ({ stringValue: v });

test("set: setDoc's write — the whole document, no precondition and no mask, each serverTime field a REQUEST_TIME transform", async () => {
  const rec = recorder();
  const fs = clientFirestore(LOCAL, { idToken: "tok-1", http: createHttp(LOCAL, { evidence: false, fetch: rec.fetch }) });
  const trust = "docs/d1/trust/uid-1";
  const r = await fs.set(trust, { uid: "uid-1", email: "reader@example.com" }, { serverTime: ["trustedAt"] });
  assert.deepEqual([r.status, r.verdict], [200, "ALLOW"]);
  assert.equal(rec.calls[0].url, COMMIT);
  assert.equal(rec.calls[0].headers.authorization, "Bearer tok-1");
  assert.deepEqual(rec.calls[0].body, {
    writes: [{
      update: { name: `${ROOT}/${trust}`, fields: { uid: s("uid-1"), email: s("reader@example.com") } },
      updateTransforms: [{ fieldPath: "trustedAt", setToServerValue: "REQUEST_TIME" }],
    }],
  }, "app/src/trust.ts setPersonalTrust, as the SDK sends it");

  await fs.set("docs/d1/versions/v1/annotations/a1", { annId: "a1", resolved: false });
  assert.deepEqual(rec.calls[1].body.writes[0], { update: { name: `${ROOT}/docs/d1/versions/v1/annotations/a1`, fields: { annId: s("a1"), resolved: { booleanValue: false } } } }, "no serverTime by default: no transforms at all");

  assert.throws(() => fs.set(trust, { trustedAt: new Date() }, { serverTime: ["trustedAt"] }), /trustedAt is both in the data and a server time/);
  assert.throws(() => fs.set(trust, { a: 1 }, { serverTime: "trustedAt" }), /serverTime is a list of field names/);
  assert.throws(() => fs.set(trust, { a: 1 }, { merge: "yes" }), /merge is true or false, got "yes"/);
  assert.throws(() => fs.set("docs/d1/trust", { a: 1 }), /collection, not a document/);
  assert.throws(() => fs.set(trust, ["a"]), /plain object/);
  assert.equal(rec.calls.length, 2, "a refused call sends nothing");
});

test("set with merge: the mask is every leaf path (a nested map recursed into, an array or an empty map a leaf, odd names backquoted), the server time outside it", async () => {
  const rec = recorder();
  const fs = clientFirestore(LOCAL, { idToken: "tok-1", http: createHttp(LOCAL, { evidence: false, fetch: rec.fetch }) });
  const when = new Date("2026-10-11T00:00:00Z");
  const data = { uid: "u1", email: "a@example.com", prefs: { theme: "dark", deep: { on: true } }, providers: ["password"], empty: {}, "odd-name": 1, at: when, raw: Buffer.from("x") };
  await fs.set("users/u1", data, { serverTime: ["updatedAt"], merge: true });
  const w = rec.calls[0].body.writes[0];
  assert.deepEqual(w.updateMask, { fieldPaths: ["uid", "email", "prefs.theme", "prefs.deep.on", "providers", "empty", "`odd-name`", "at", "raw"] });
  assert.deepEqual(w.updateTransforms, [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }]);
  assert.equal(w.currentDocument, undefined, "setDoc with merge has no precondition either");
  assert.deepEqual(w.update.fields.prefs, { mapValue: { fields: { theme: s("dark"), deep: { mapValue: { fields: { on: { booleanValue: true } } } } } } });
  assert.deepEqual(w.update.fields.empty, { mapValue: { fields: {} } });

  await fs.set("users/u1", {}, { serverTime: ["updatedAt"], merge: true });
  assert.deepEqual(rec.calls[1].body.writes[0].updateMask, { fieldPaths: [] }, "only a server time: an empty mask, the transform alone");
  assert.deepEqual(mergeMask({ "a.b": { c: 1 } }), ["`a.b`.c"], "a dot inside a name is one segment");
  assert.throws(() => mergeMask([1]), /plain object/);
});

test("session: the caller is the session's account — its ID token, read per request, and its http client; an explicit idToken or http wins; a non-session throws", async () => {
  const rec = recorder();
  const http = createHttp(LOCAL, { evidence: false, fetch: rec.fetch });
  const session = { account: { email: "reader@example.com" }, uid: "uid-1", idToken: "tok-a", http };
  const fs = clientFirestore(LOCAL, { session });
  await fs.get("docs/d1/trust/uid-1");
  session.idToken = "tok-b";
  await fs.set("docs/d1/trust/uid-1", { uid: "uid-1", email: "reader@example.com" }, { serverTime: ["trustedAt"] });
  assert.deepEqual(rec.calls.map((c) => c.headers.authorization), ["Bearer tok-a", "Bearer tok-b"], "the session's token, as it is at each request");
  assert.equal(fs.http, http, "the session's own client");

  const other = recorder();
  const http2 = createHttp(LOCAL, { evidence: false, fetch: other.fetch });
  await clientFirestore(LOCAL, { session, idToken: "explicit", http: http2 }).get("docs/d1");
  assert.deepEqual(other.calls.map((c) => c.headers.authorization), ["Bearer explicit"]);
  await clientFirestore(LOCAL, { session, idToken: null, http: http2 }).get("docs/d1");
  assert.equal(other.calls[1].headers.authorization, undefined, "idToken: null beside a session is anonymous");

  for (const bad of [null, {}, { idToken: "t" }, { idToken: "", http }, { idToken: "t", http: {} }]) {
    assert.throws(() => clientFirestore(LOCAL, { session: bad }), /session is an openSession result/, JSON.stringify(bad));
  }
  await assert.rejects(clientFirestore(LOCAL, { session: { ...session, idToken: "owner" } }).get("docs/d1"), /admin credential/);
});
