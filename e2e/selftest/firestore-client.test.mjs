// SPDX-License-Identifier: Apache-2.0
// Self-test: Firestore REST as a signed-in client, and the production guard's classification of every such write (SPEC §4, §12).

/**
 * clientFirestore must send exactly what the app's SDK sends (so a rules
 * verdict is the rules' verdict), never the emulator's admin credential and
 * never a cookie; and on production every Firestore REST write must pass the
 * guard: the run's own documents only, and anything under a document's
 * annotations only after assertQuietDoc. The parity test derives the comment
 * path from TRIGGER_COVERAGE and carries its own negative control: with the
 * Firestore rule removed from the policy, the same writes go unguarded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CookieJar, createHttp } from "../lib/http.mjs";
import { DEFAULT_POLICY, TRIGGER_COVERAGE, createGuard, evaluate, installGuard } from "../lib/guard.mjs";
import { FIRESTORE_PUBLIC_ORIGIN, clientFirestore, fieldPath, firestoreOrigin, firestoreResult, fromFields, fromValue, toFields, toValue } from "../lib/firestore-client.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PROJECT = "demo-fsrest";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const LOCAL = Object.freeze({
  kind: "local",
  runId: "2610101200-fscl",
  runDir: tempDir("e2e-fscl-"),
  projectId: PROJECT,
  origin: "http://127.0.0.1:39001",
  firestoreUrl: "http://127.0.0.1:39003",
  stack: { ports: { hosting: 39001, auth: 39002, firestore: 39003 } },
});
const PROD = Object.freeze({ kind: "prod", runId: "2610101200-fsprd", runDir: tempDir("e2e-fsprd-"), projectId: PROJECT, origin: "https://fs-selftest.invalid" });

const OWN = "e2e-0fsprd-mine-abcd";
const ABSENT = "e2e-0fsprd-absent-wxyz";
const RUN_UID = "uid-run-1";
const CTX = Object.freeze({ target: PROD, ledgerDocs: new Set([OWN]), ledgerFolders: new Set(["folder-mine"]), ledgerAbsent: new Set([ABSENT]), ledgerUids: new Set([RUN_UID]) });

const FS = `${FIRESTORE_PUBLIC_ORIGIN}/v1/${ROOT}`;
const commit = (writes, base = FS) => ({ method: "POST", url: `${base}:commit`, body: JSON.stringify({ writes }) });
const put = (rel) => ({ update: { name: `${ROOT}/${rel}`, fields: {} } });
const del = (rel) => ({ delete: `${ROOT}/${rel}` });
const ann = (doc) => `docs/${doc}/versions/v1/annotations/a1`;
const cmt = (doc) => `${ann(doc)}/comments/c1`;

/** A fetch that records every request and answers from `reply(url, init)`. */
function recorder(reply = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return reply(String(url), init);
  };
  return { calls, fetch };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("values: toValue and fromValue round-trip, and what has no Firestore value is refused", () => {
  const when = new Date("2026-10-11T05:12:59.000Z");
  const data = { s: "x", i: 3, d: 1.5, b: false, n: null, t: when, a: [1, "two", { deep: true }], m: { k: "v" }, bytes: Buffer.from("hi") };
  const fields = toFields(data);
  assert.deepEqual(fields.i, { integerValue: "3" });
  assert.deepEqual(fields.d, { doubleValue: 1.5 });
  assert.deepEqual(fields.t, { timestampValue: "2026-10-11T05:12:59.000Z" });
  assert.deepEqual(fields.n, { nullValue: null });
  assert.deepEqual(fields.m, { mapValue: { fields: { k: { stringValue: "v" } } } });
  const back = fromFields(fields);
  assert.equal(back.t.getTime(), when.getTime());
  assert.deepEqual({ ...back, t: null, bytes: back.bytes.toString() }, { ...data, t: null, bytes: "hi" });
  assert.equal(fromValue({ integerValue: "9007199254740993" }), "9007199254740993", "an unsafe integer stays a string");
  assert.throws(() => toValue(undefined), /undefined/);
  assert.throws(() => toValue(Number.NaN), /finite/);
  assert.throws(() => toValue(() => 1), /function/);
  assert.throws(() => fromValue({ martian: 1 }), /unknown/);
  assert.equal(fieldPath("createdAt"), "createdAt");
  assert.equal(fieldPath("a-b"), "`a-b`", "a name that is not simple is backquoted");
});

test("clientFirestore sends the app's requests: commit with REQUEST_TIME, updateMask, delete, and decoded reads", async () => {
  const docJson = { name: `${ROOT}/docs/d 1/versions/v1/annotations/a1`, fields: { body: { stringValue: "hi" }, createdAt: { timestampValue: "2026-10-11T05:12:59Z" } }, createTime: "c", updateTime: "u" };
  const rec = recorder((url, init) => (init.method === "GET" && url.includes("pageSize") ? json(200, { documents: [docJson], nextPageToken: "p2" }) : init.method === "GET" ? json(200, docJson) : json(200, { writeResults: [{}] })));
  const http = createHttp(LOCAL, { evidence: false, fetch: rec.fetch });
  const fs = clientFirestore(LOCAL, { idToken: "tok-1", http });
  const commitUrl = `${LOCAL.firestoreUrl}/v1/${ROOT}:commit`;

  const created = await fs.create(ann("d1"), { annId: "a1", resolved: false });
  assert.deepEqual([created.status, created.verdict, created.ok, created.denied, created.code], [200, "ALLOW", true, false, null]);
  assert.equal(rec.calls[0].url, commitUrl);
  assert.equal(rec.calls[0].method, "POST");
  assert.equal(rec.calls[0].headers.authorization, "Bearer tok-1");
  assert.deepEqual(rec.calls[0].body, {
    writes: [{
      update: { name: `${ROOT}/${ann("d1")}`, fields: { annId: { stringValue: "a1" }, resolved: { booleanValue: false } } },
      currentDocument: { exists: false },
      updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
    }],
  });

  await fs.create(ann("d1"), { createdAt: new Date("2026-10-11T00:00:00Z") }, { serverTime: [] });
  assert.deepEqual(rec.calls[1].body.writes[0], { update: { name: `${ROOT}/${ann("d1")}`, fields: { createdAt: { timestampValue: "2026-10-11T00:00:00.000Z" } } }, currentDocument: { exists: false } }, "a client clock, and no transform");
  assert.throws(() => fs.create(ann("d1"), { createdAt: new Date() }), /both in the data and a server time/);

  await fs.update(cmt("d1"), { body: "again", "odd-name": 1 });
  assert.deepEqual(rec.calls[2].body.writes[0], {
    update: { name: `${ROOT}/${cmt("d1")}`, fields: { body: { stringValue: "again" }, "odd-name": { integerValue: "1" } } },
    updateMask: { fieldPaths: ["body", "`odd-name`"] },
    currentDocument: { exists: true },
  });
  await fs.remove(cmt("d1"));
  assert.deepEqual(rec.calls[3].body.writes, [{ delete: `${ROOT}/${cmt("d1")}`, currentDocument: { exists: true } }]);
  await fs.commit([{ delete: `${ROOT}/${cmt("d1")}` }, { delete: `${ROOT}/${cmt("d2")}` }]);
  assert.equal(rec.calls[4].body.writes.length, 2, "commit sends a batch as given");

  const got = await fs.get("docs/d 1/versions/v1/annotations/a1");
  assert.equal(rec.calls[5].method, "GET");
  assert.equal(rec.calls[5].url, `${LOCAL.firestoreUrl}/v1/${ROOT}/docs/d%201/versions/v1/annotations/a1`, "segments are encoded");
  assert.deepEqual({ ...got.doc, data: { ...got.doc.data, createdAt: got.doc.data.createdAt.toISOString() } }, { name: docJson.name, path: "docs/d 1/versions/v1/annotations/a1", id: "a1", data: { body: "hi", createdAt: "2026-10-11T05:12:59.000Z" }, createTime: "c", updateTime: "u" });
  const listed = await fs.list("docs/d1/versions/v1/annotations", { pageSize: 5 });
  assert.equal(new URL(rec.calls[6].url).searchParams.get("pageSize"), "5");
  assert.deepEqual([listed.docs.length, listed.docs[0].id, listed.nextPageToken], [1, "a1", "p2"]);

  for (const c of rec.calls) assert.equal(c.headers.cookie, undefined, "a client never sends a cookie");
  await assert.rejects(fs.get("docs/d1/versions"), /collection, not a document/);
  assert.throws(() => fs.remove("/docs/d1"), /relative/);
  assert.throws(() => fs.remove("docs/../d1"), /segment/);
  await assert.rejects(fs.list("docs/d1"), /document, not a collection/);
});

test("clientFirestore: an anonymous caller sends no Authorization at all; the admin credential and stray cookies never go", async () => {
  const rec = recorder();
  const jar = new CookieJar();
  jar.store(`${LOCAL.firestoreUrl}/`, ["__session=SESSIONVALUE123; Path=/"]);
  const http = createHttp(LOCAL, { evidence: false, fetch: rec.fetch, jar, headers: { authorization: "Bearer from-the-client-defaults" } });
  await clientFirestore(LOCAL, { idToken: null, http }).get("docs/d1");
  assert.equal(rec.calls[0].headers.authorization, undefined, "anonymous means no header, not the client's default");
  assert.equal(rec.calls[0].headers.cookie, undefined, "the jar's cookie is not sent");
  let n = 0;
  await clientFirestore(LOCAL, { idToken: async () => `tok-${++n}`, http }).get("docs/d1");
  assert.equal(rec.calls[1].headers.authorization, "Bearer tok-1", "a token function is asked per request");
  assert.throws(() => clientFirestore(LOCAL, { idToken: "owner", http }), /admin credential/);
  await assert.rejects(clientFirestore(LOCAL, { idToken: () => "owner", http }).get("docs/d1"), /admin credential/);
  assert.equal(rec.calls.length, 2, "the admin credential never reached fetch");
});

test("clientFirestore: where the API is — the stack's emulator locally, the public origin on production, and a local target without one throws", () => {
  assert.equal(firestoreOrigin(LOCAL), LOCAL.firestoreUrl);
  assert.equal(firestoreOrigin(PROD), FIRESTORE_PUBLIC_ORIGIN);
  assert.equal(firestoreOrigin({ ...PROD, firestoreUrl: "https://fs.example.invalid/x" }), "https://fs.example.invalid");
  assert.throws(() => firestoreOrigin({ ...LOCAL, firestoreUrl: undefined }), /no firestoreUrl/);
  assert.throws(() => clientFirestore({ ...LOCAL, projectId: undefined }), /projectId/);
  assert.equal(clientFirestore(PROD, { http: createHttp(PROD, { evidence: false }) }).base, `${FIRESTORE_PUBLIC_ORIGIN}/v1/${ROOT}`);
});

test("clientFirestore: a local target's isolation still holds — another port is refused before anything is sent", async () => {
  const rec = recorder();
  const http = createHttp(LOCAL, { evidence: false, fetch: rec.fetch });
  const stray = { ...LOCAL, firestoreUrl: "http://127.0.0.1:39999" };
  await assert.rejects(clientFirestore(stray, { http }).get("docs/d1"), (e) => e.code === "E2E_ISOLATION");
  assert.equal(rec.calls.length, 0);
});

test("verdict: ALLOW only for a 200, DENY only for a 403 PERMISSION_DENIED, nothing else for anything else", () => {
  const r = (status, body) => firestoreResult({ status, json: body });
  const err = (code, status) => ({ error: { code, status, message: `${status} because` } });
  assert.deepEqual(pick(r(200, {})), { verdict: "ALLOW", ok: true, denied: false, code: null });
  assert.deepEqual(pick(r(403, err(403, "PERMISSION_DENIED"))), { verdict: "DENY", ok: false, denied: true, code: "PERMISSION_DENIED" });
  assert.deepEqual(pick(r(403, [err(403, "PERMISSION_DENIED")])), { verdict: "DENY", ok: false, denied: true, code: "PERMISSION_DENIED" }, "an error array");
  assert.deepEqual(pick(r(404, err(404, "NOT_FOUND"))), { verdict: null, ok: false, denied: false, code: "NOT_FOUND" });
  assert.deepEqual(pick(r(403, err(403, "UNAUTHENTICATED"))), { verdict: null, ok: false, denied: false, code: "UNAUTHENTICATED" }, "a 403 for another reason is not a rules denial");
  assert.deepEqual(pick(r(400, err(400, "FAILED_PRECONDITION"))), { verdict: null, ok: false, denied: false, code: "FAILED_PRECONDITION" });
  assert.deepEqual(pick(r(500, undefined)), { verdict: null, ok: false, denied: false, code: null });
  assert.equal(r(403, err(403, "PERMISSION_DENIED")).message, "PERMISSION_DENIED because");
});

function pick(x) {
  return { verdict: x.verdict, ok: x.ok, denied: x.denied, code: x.code };
}

test("evaluate: on production a Firestore REST write goes only under the run's own documents, folders and accounts", () => {
  const v = (r, ctx = CTX) => evaluate(r, ctx);
  const rule = (r, ctx) => v(r, ctx).rule;
  // Comment-capable: anything under a document's annotations, quiet-gated.
  for (const w of [put(cmt(OWN)), put(ann(OWN)), del(cmt(OWN)), del(ann(OWN))]) {
    const x = v(commit([w]));
    assert.deepEqual([x.allow, x.rule, x.quietDocs], [true, "comment", [OWN]], JSON.stringify(w));
  }
  assert.deepEqual(v(commit([{ transform: { document: `${ROOT}/${ann(OWN)}`, fieldTransforms: [] } }])).quietDocs, [OWN], "a legacy transform write");
  const trust = v(commit([put(`docs/${OWN}/trust/${RUN_UID}`)]));
  assert.deepEqual([trust.allow, trust.rule, trust.quietDocs], [true, "firestore-write", undefined], "a write that cannot comment needs no quiet proof");
  assert.equal(v(commit([put(`users/${RUN_UID}`)])).allow, true, "a run account's own record");
  assert.equal(v(commit([put("folders/folder-mine")])).allow, true);

  assert.equal(rule(commit([put(cmt("someone-elses"))])), "ledger");
  assert.equal(rule(commit([put(cmt(ABSENT))])), "ledger", "absent-id probes are not taken by Firestore writes");
  assert.equal(rule(commit([put(cmt(OWN)), put(cmt("someone-elses"))])), "ledger", "a batch is judged write by write");
  assert.equal(rule(commit([put(`public/someone-elses`)])), "ledger");
  assert.equal(rule(commit([put("users/someone-else")])), "ledger-account");
  assert.equal(rule(commit([put(`users/${RUN_UID}`)]), { ...CTX, ledgerUids: undefined }), "ledger-account", "no uids given, no account writes");
  assert.equal(rule(commit([put("folders/theirs")])), "ledger-folder");
  assert.equal(rule(commit([put("teams/t1")])), "firestore-path");
  assert.equal(rule(commit([put("forks/f1")])), "firestore-path");
  assert.equal(rule(commit([put("docs")])), "firestore-path", "a collection, not a document");
  assert.equal(rule(commit([{ update: { name: `projects/other-project/databases/(default)/documents/${cmt(OWN)}` } }])), "firestore-project");
  assert.equal(rule({ ...commit([put(cmt(OWN))]), url: `${FIRESTORE_PUBLIC_ORIGIN}/v1/projects/other-project/databases/(default)/documents:commit` }), "firestore-project");
  assert.equal(rule(commit([put(cmt(OWN))]), { ...CTX, target: { ...PROD, projectId: undefined } }), "firestore-project", "a target with no project writes nowhere");
  assert.equal(rule(commit([])), "firestore-unclassified", "a commit with no writes");
  assert.equal(rule({ method: "POST", url: `${FS}:commit`, body: "not json" }), "firestore-unclassified");
  assert.equal(rule(commit([{ verify: { name: `${ROOT}/${cmt(OWN)}` } }])), "firestore-unclassified", "a write the guard cannot read");

  // The other write forms.
  const restQuiet = (method, rel, q = "") => v({ method, url: `${FS}/${rel}${q}`, body: "{}" });
  assert.deepEqual(restQuiet("PATCH", cmt(OWN), "?updateMask.fieldPaths=body").quietDocs, [OWN]);
  assert.deepEqual(restQuiet("DELETE", cmt(OWN)).quietDocs, [OWN]);
  assert.deepEqual(restQuiet("POST", `${ann(OWN)}/comments`, "?documentId=c9").quietDocs, [OWN], "createDocument");
  assert.equal(restQuiet("PATCH", cmt("someone-elses")).rule, "ledger");
  assert.equal(restQuiet("POST", "docs").rule, "ledger", "createDocument of a document with a server-chosen id");
  assert.equal(restQuiet("PUT", cmt(OWN)).rule, "firestore-unclassified");

  // Reads go; transactions and unknown methods do not.
  assert.deepEqual([v({ method: "GET", url: `${FS}/${cmt("someone-elses")}` }).allow, v({ method: "GET", url: `${FS}/${cmt("someone-elses")}` }).rule], [true, "firestore-read"]);
  for (const m of ["runQuery", "batchGet", "listCollectionIds", "runAggregationQuery"]) assert.equal(v({ method: "POST", url: `${FS}:${m}`, body: "{}" }).rule, "firestore-read", m);
  for (const m of ["beginTransaction", "rollback", "write", "frobnicate"]) assert.equal(v({ method: "POST", url: `${FS}:${m}`, body: "{}" }).rule, "firestore-unclassified", m);

  // Escapes that only look like the API once decoded.
  assert.equal(rule({ ...commit([put(cmt(OWN))]), url: `${FS.replace("/documents", "/documents%3Acommit")}` }), "firestore-unclassified", "an escaped colon");
  assert.equal(v({ method: "PATCH", url: `${FS}/docs%2F${OWN}/versions/v1` }).rule, "firestore-path", "an escaped slash is one segment, not docs/<id>");

  // Any host: the app origin, the emulator, the public API.
  assert.equal(rule(commit([put(cmt("someone-elses"))], `${PROD.origin}/v1/${ROOT}`)), "ledger");
  assert.equal(rule(commit([put(cmt("someone-elses"))], `http://127.0.0.1:39003/v1/${ROOT}`)), "ledger");
  // A local target is unchanged.
  assert.deepEqual(evaluate(commit([put(cmt("someone-elses"))]), { ...CTX, target: LOCAL }), { allow: true, rule: "local" });
});

/** Every Firestore REST form of writing `rel`. */
function restWrites(rel) {
  const parent = rel.split("/").slice(0, -1).join("/");
  const id = rel.split("/").at(-1);
  return [
    ["commit update", commit([put(rel)])],
    ["commit delete", commit([del(rel)])],
    ["batchWrite", { method: "POST", url: `${FS}:batchWrite`, body: JSON.stringify({ writes: [put(rel)] }) }],
    ["PATCH", { method: "PATCH", url: `${FS}/${rel}`, body: "{}" }],
    ["DELETE", { method: "DELETE", url: `${FS}/${rel}` }],
    ["createDocument", { method: "POST", url: `${FS}/${parent}?documentId=${id}`, body: "{}" }],
  ];
}

/** Gaps: REST writes of the comment trigger's document that go without a quiet proof. */
function restGaps(policy) {
  const gaps = [];
  for (const [path, coverage] of Object.entries(TRIGGER_COVERAGE)) {
    if (coverage !== "quiet-doc") continue;
    const rel = path.replace("{docId}", OWN).replace(/\{(\w+)\}/g, (_, k) => `${k}-1`);
    for (const [form, r] of restWrites(rel)) {
      const x = evaluate(r, { ...CTX, policy });
      if (!(x.allow === false || x.quietDocs?.includes(OWN))) gaps.push(`${form} of ${path} goes without a quiet proof (rule ${x.rule})`);
    }
  }
  return gaps;
}

test("parity: the comment trigger's document, written over Firestore REST in any form, is quiet-gated", () => {
  assert.ok(Object.values(TRIGGER_COVERAGE).includes("quiet-doc"), "the comment trigger is covered");
  assert.deepEqual(restGaps(DEFAULT_POLICY), []);
  assert.deepEqual(restGaps({ ...DEFAULT_POLICY, firestoreRest: undefined }), [], "a policy that omits the rule still has it (fail-closed)");
});

test("NEGATIVE: without the Firestore REST rule every one of those writes goes unguarded", () => {
  const gaps = restGaps({ ...DEFAULT_POLICY, firestoreRest: null });
  assert.equal(gaps.length, restWrites("x/y").length, gaps.join("\n"));
  assert.equal(evaluate(commit([put(cmt("someone-elses"))]), { ...CTX, policy: { ...DEFAULT_POLICY, firestoreRest: null } }).rule, "other-host");
});

test("check(): a REST comment write waits for assertQuietDoc; a loud document and a foreign one are refused", async () => {
  const ledger = () => ({ docs: new Set([OWN]), folders: new Set(), absent: new Set(), accounts: new Map([["run@example.com", { uid: RUN_UID }]]) });
  const asked = [];
  const quiet = createGuard(PROD, { ledger, quietCheck: async (d) => void asked.push(d) });
  assert.equal((await quiet.check(commit([put(cmt(OWN))]))).allow, true);
  assert.deepEqual(asked, [OWN]);
  assert.equal((await quiet.check(commit([put(`users/${RUN_UID}`)]))).allow, true, "the ledger's account uids reach evaluate");
  assert.deepEqual(asked, [OWN], "an account write needs no quiet proof");
  const loud = createGuard(PROD, { ledger, quietCheck: async () => { throw new Error("owner has not opted out"); } });
  const r = await loud.check(commit([put(cmt(OWN))]));
  assert.deepEqual([r.allow, r.rule], [false, "quiet-doc"]);
  assert.match(r.reason, /owner has not opted out/);
});

test("choke point: clientFirestore on production goes through the guard — a refused write never reaches fetch", async () => {
  const rec = recorder();
  const loudDoc = "e2e-0fsprd-loud-abcd";
  const guard = createGuard(PROD, {
    ledger: () => ({ docs: new Set([OWN, loudDoc]), folders: new Set(), absent: new Set([ABSENT]), accounts: new Map() }),
    quietCheck: async (d) => { if (d === loudDoc) throw new Error("not quiet"); },
  });
  const fs = clientFirestore(PROD, { idToken: "tok", http: createHttp(PROD, { guard, evidence: false, fetch: rec.fetch }) });
  assert.equal((await fs.create(cmt(OWN), { body: "b" })).verdict, "ALLOW");
  assert.equal(rec.calls[0].url, `${FIRESTORE_PUBLIC_ORIGIN}/v1/${ROOT}:commit`);
  await assert.rejects(fs.create(cmt("someone-elses"), { body: "b" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger");
  await assert.rejects(fs.update(cmt(ABSENT), { body: "b" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger");
  await assert.rejects(fs.remove(cmt(loudDoc)), (e) => e.code === "E2E_GUARD" && e.rule === "quiet-doc");
  assert.equal(rec.calls.length, 1, "only the quiet write on the run's own document was sent");
  assert.equal((await fs.get(cmt("someone-elses"))).verdict, "ALLOW", "a read names anything");
});

test("choke point: the browser routes Firestore REST too — a foreign write is aborted, a read falls through", async () => {
  const routes = [];
  const g = createGuard(PROD, { ledger: () => ({ docs: new Set([OWN]), folders: new Set(), accounts: new Map() }), quietCheck: async () => {} });
  await installGuard({ route: async (pattern, handler) => routes.push({ pattern, handler }) }, PROD, { guard: g });
  const fire = async (r) => {
    const hit = routes.find((x) => x.pattern.test(r.url));
    if (!hit) return "unrouted";
    let outcome = null;
    await hit.handler({ request: () => ({ method: () => r.method, url: () => r.url, postDataBuffer: () => (r.body ? Buffer.from(r.body) : null) }), abort: async () => (outcome = "abort"), fallback: async () => (outcome = "fallback") });
    return outcome;
  };
  assert.equal(await fire(commit([put(cmt("someone-elses"))])), "abort");
  assert.equal(await fire(commit([put(cmt(OWN))])), "fallback");
  assert.equal(await fire({ method: "GET", url: `${FS}/${cmt("someone-elses")}` }), "fallback");
});
