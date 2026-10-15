// SPDX-License-Identifier: Apache-2.0
// Self-test: the harness writes the RTDB presence/edit mirror that scripts/set-access.mjs leaves missing (suspect S16), for run documents and run accounts only, and the joins go on (SPEC §6b, §12, §16).

/**
 * scripts/set-access.mjs writes no presenceAccess/editAccess mirror (S16,
 * proved live on 2026-10-13), so on the operator path (production's) every
 * granted editor shows "Shared" while each write it makes to the live log
 * is refused, and joinShared ends every C-scenario INCONCLUSIVE there. The
 * plan prescribes writing the mirror the way functions/src/lib/presence.ts
 * syncPresenceAccess does, for run documents only. These cases cover:
 *   - mirrorUpdate as a legacy boolean fixture, distinct from the product revision fence;
 *   - mirrorWriteVerdict, the write's own narrow guard, request by request;
 *   - writeMirror end to end against a loopback stand-in database (one
 *     ETag read and conditional node writes, the admin credential, redacted traces, the
 *     finding), and every refusal sending nothing;
 *   - grantEditors' `mirror` (one write after every grant, each missing
 *     grantee read back; the old call unchanged), and joinShared/addMember
 *     driven through `impl` stand-ins and a recording ctx, so the order of
 *     what they do is observed: the write before any browser, INCONCLUSIVE
 *     only when the mirror is still missing after it;
 *   - the README.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIRROR_MODES, mirrorUpdate, mirrorWriteVerdict, writeMirror } from "../lib/grant.mjs";
import { appendLedger } from "../lib/ledger.mjs";
import { addMember, grantEditors, joinShared } from "../lib/live.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const repo = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const OWNER_EMAIL = "owner-mw@example.test";
const P2 = "p2.mw@example.test";
const P3 = "p3-mw@example.test";
const DOC = "e2e-mw0001-doc";
const REVISION = "000000000001:000000000";
const NEWER = "000000000002:000000000";

/** A target with its own run dir and ledger: the run's document DOC and accounts OWNER_EMAIL, P2, P3. */
function targetWith(fields) {
  const target = { runId: "2610130000-mwrite", runDir: tempDir("e2e-mirror-"), projectId: "demo-bikeshed", capabilities: new Set([]), ...fields };
  appendLedger(target, { kind: "doc", docId: DOC, ownerEmail: OWNER_EMAIL, via: "publish" });
  for (const email of [OWNER_EMAIL, P2, P3]) appendLedger(target, { kind: "account", role: "x", email, uid: `uid-${email}`, tier: target.kind, via: "rest" });
  return target;
}

/** A loopback RTDB stand-in implementing per-node ETag compare-and-set. */
async function standInDatabase({ status = 200, initial = {}, race = false } = {}) {
  const seen = [], nodes = new Map(Object.entries(initial));
  const versions = new Map();
  let raced = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const path = new URL(req.url, 'http://localhost').pathname;
      const etag = () => `"${versions.get(path) ?? 0}"`;
      if (status !== 200) { res.writeHead(status); res.end('{}'); return; }
      if (req.method === 'PUT' && race && !raced) {
        raced = true;
        nodes.set(path, { __revision: NEWER, [key(OWNER_EMAIL)]: true });
        versions.set(path, 1);
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', etag: etag() });
        res.end(JSON.stringify(nodes.get(path) ?? null)); return;
      }
      if (req.method !== 'PUT' || req.headers['if-match'] !== etag()) {
        res.writeHead(412, { 'content-type': 'application/json', etag: etag() });
        res.end(JSON.stringify(nodes.get(path) ?? null)); return;
      }
      nodes.set(path, JSON.parse(body)); versions.set(path, (versions.get(path) ?? 0) + 1);
      res.writeHead(200, { 'content-type': 'application/json', etag: etag() }); res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, seen, nodes, close: () => new Promise((resolve) => server.close(resolve)) };
}

function localTarget(port) {
  return targetWith({ kind: "local", origin: `http://127.0.0.1:${port}`, databaseURL: `http://127.0.0.1:${port}?ns=demo-bikeshed`, stack: { ports: { database: port } }, capabilities: new Set(["local"]) });
}

const record = (over = {}) => ({ ownerEmail: OWNER_EMAIL, members: [OWNER_EMAIL, P2, P3], editorMembers: [OWNER_EMAIL, P2], editors: [P2], viewers: [P3], ...over });
/** lib/admin.mjs's readDoc, standing in: the record above for DOC, counted. */
function readerOf(rec = record(), extra = {}) {
  const calls = [];
  return { calls, readDocRevision: async (t, path) => (calls.push(path), path === `docs/${DOC}` && rec ? { data: rec, revision: extra.revision ?? REVISION } : null), ...extra };
}
const findings = (target) => (existsSync(join(target.runDir, "findings.jsonl")) ? readFileSync(join(target.runDir, "findings.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const key = (e) => e.toLowerCase().split(".").join(",");

test("mirrorUpdate stages a legacy access fixture: both nodes, email keys, no revision or open-edit key", () => {
  assert.deepEqual(mirrorUpdate(DOC, { members: ["Owner-MW@Example.test", P2, ""], editorMembers: [OWNER_EMAIL] }), {
    [`presenceAccess/${DOC}`]: { [key(OWNER_EMAIL)]: true, [key(P2)]: true },
    [`editAccess/${DOC}`]: { [key(OWNER_EMAIL)]: true },
  }, "an empty key is left out, as keyed() does");
  assert.deepEqual(mirrorUpdate(DOC, {}), { [`presenceAccess/${DOC}`]: {}, [`editAccess/${DOC}`]: {} }, "empty lists: {} (the product's whole-node replace removes the node)");
  for (const bad of ["", "a/b", "a.b", "a#b", "a[b", 7, null]) assert.throws(() => mirrorUpdate(bad, {}), TypeError, JSON.stringify(bad));
  for (const lists of [{ members: "x" }, { editorMembers: [1] }, { members: [null] }]) assert.throws(() => mirrorUpdate(DOC, lists), TypeError, JSON.stringify(lists));

  // This opt-in harness repair writes a legacy boolean fixture. The product
  // uses revision-fenced transactions; its ordering is tested in presence-races.
  assert.deepEqual(MIRROR_MODES, ["stop", "write-missing"]);
  const live = readFileSync(repo("e2e/lib/live.mjs"), "utf8");
  assert.ok(live.includes(`const MIRROR_MODES = Object.freeze(${JSON.stringify(MIRROR_MODES).replace(/,/g, ", ")});`), "live.mjs's copy of MIRROR_MODES is grant.mjs's");
});

test("mirrorWriteVerdict allows only scoped ETag reads and conditional fenced replacements", () => {
  const target = { kind: 'local', databaseURL: 'http://127.0.0.1:39001?ns=demo-bikeshed' };
  const docs = new Set([DOC]), accounts = [OWNER_EMAIL, P2, P3];
  const body = { __revision: REVISION, __expiresAt: 0, __owner: OWNER_EMAIL, [key(OWNER_EMAIL)]: true };
  const req = (over = {}) => ({ method: 'PUT', url: `http://127.0.0.1:39001/editAccess/${DOC}.json?ns=demo-bikeshed`, headers: { 'if-match': '"0"' }, body, ...over });
  const judge = (request, over = {}) => mirrorWriteVerdict(request, { target, docs, accounts, ...over });
  assert.equal(judge(req()).allow, true);
  assert.equal(judge(req({ method: 'GET', body: undefined })).allow, true);
  assert.equal(judge(req({ body: { ...body, '*': true } }), { publicEdit: true }).allow, true);
  for (const [request, rule] of [
    [req({ method: 'PATCH' }), 'mirror-method'],
    [req({ method: 'POST' }), 'mirror-method'],
    [req({ method: 'DELETE' }), 'mirror-method'],
    [req({ headers: {} }), 'mirror-condition'],
    [req({ headers: { 'if-match': '*' } }), 'mirror-condition'],
    [req({ url: 'http://127.0.0.1:39001/.json?ns=demo-bikeshed' }), 'mirror-url'],
    [req({ url: `http://127.0.0.1:39001/status/${DOC}.json?ns=demo-bikeshed` }), 'mirror-url'],
    [req({ url: `http://127.0.0.1:39002/editAccess/${DOC}.json?ns=demo-bikeshed` }), 'mirror-url'],
    [req({ url: `http://127.0.0.1:39001/editAccess/${DOC}.json?ns=other` }), 'mirror-url'],
    [req({ url: 'http://127.0.0.1:39001/editAccess/other.json?ns=demo-bikeshed' }), 'mirror-ledger'],
    [req({ body: { [key(OWNER_EMAIL)]: true } }), 'mirror-body'],
    [req({ body: { ...body, __revision: true } }), 'mirror-body'],
    [req({ body: { ...body, __expiresAt: -1 } }), 'mirror-body'],
    [req({ body: { ...body, __expiresAt: 'never' } }), 'mirror-body'],
    [req({ body: { ...body, __owner: 'not an email' } }), 'mirror-body'],
    [req({ body: { ...body, __owner: 'outsider@example.test' } }), 'mirror-account'],
    [req({ body: { ...body, [key(P2)]: false } }), 'mirror-body'],
    [req({ body: { ...body, '*': true } }), 'mirror-account'],
    [req({ body: { ...body, stranger: true } }), 'mirror-account'],
  ]) {
    const result = judge(request);
    assert.equal(result.allow, false, JSON.stringify(request)); assert.equal(result.rule, rule);
  }
  assert.equal(judge(req(), { docId: 'different' }).rule, 'mirror-body');
  assert.throws(() => judge(req(), { docs: [] }), TypeError);
  assert.throws(() => judge(req(), { accounts: null }), TypeError);
});

test("writeMirror uses guarded GET/conditional PUT for edit then presence and records the repair", async () => {
  const db = await standInDatabase();
  try {
    const target = localTarget(db.port), rows = [], reader = readerOf();
    const result = await writeMirror(target, { doc: DOC, admin: reader, evidence: (line) => rows.push(JSON.parse(line)) });
    assert.deepEqual(reader.calls, [`docs/${DOC}`]);
    assert.deepEqual(db.seen.map((request) => request.method), ['GET', 'PUT', 'GET', 'PUT']);
    assert.match(db.seen[0].url, /^\/editAccess\//); assert.match(db.seen[2].url, /^\/presenceAccess\//);
    assert.equal(db.seen[1].headers['if-match'], '"0"');
    for (const request of db.seen) { assert.equal(request.headers.authorization, 'Bearer owner'); assert.equal(request.headers.cookie, undefined); }
    const update = mirrorUpdate(DOC, record());
    for (const node of Object.values(update)) Object.assign(node, { __revision: REVISION, __expiresAt: 0, __owner: OWNER_EMAIL, __liveEpoch: "initial" });
    assert.deepEqual(db.nodes.get(`/editAccess/${DOC}.json`), update[`editAccess/${DOC}`]);
    assert.deepEqual(db.nodes.get(`/presenceAccess/${DOC}.json`), update[`presenceAccess/${DOC}`]);
    assert.deepEqual(result, { docId: DOC, members: [OWNER_EMAIL, P2, P3], editorMembers: [OWNER_EMAIL, P2], update, status: 200 });
    assert.equal(rows.length, 4); assert.equal(rows[1].method, 'PUT'); assert.equal(rows[1].actor, 'operator-mirror');
    assert.deepEqual(findings(target).map((row) => [row.kind, row.suspect, row.docId, row.members, row.editors, row.by]), [['mirror-written', 'S16', DOC, 3, 2, 'harness']]);
  } finally { await db.close(); }
});

test("a competing newer mirror wins the conditional write and the repair retries without reopening access", async () => {
  const newer = { __revision: NEWER, [key(OWNER_EMAIL)]: true };
  const db = await standInDatabase({ race: true, initial: { [`/presenceAccess/${DOC}.json`]: newer } });
  try {
    await writeMirror(localTarget(db.port), { doc: DOC, admin: readerOf() });
    assert.deepEqual(db.nodes.get(`/editAccess/${DOC}.json`), newer);
    assert.deepEqual(db.nodes.get(`/presenceAccess/${DOC}.json`), newer);
    assert.deepEqual(db.seen.map((request) => request.method), ['GET', 'PUT', 'GET', 'GET']);
  } finally { await db.close(); }
});

test("writeMirror sends nothing unless every check holds: a document outside the ledger, a member outside the run, a missing or malformed record; a refusal or no answer is E2E_MIRROR, with no finding", async () => {
  const db = await standInDatabase();
  try {
    const target = localTarget(db.port);
    const auth = [];
    const stand = (rec) => readerOf(rec, { authorization: async () => (auth.push(1), "Bearer owner") });
    const notOurs = stand();
    await assert.rejects(writeMirror(target, { doc: "e2e-not-ours", admin: notOurs }), (e) => e.code === "E2E_GUARD" && e.rule === "mirror-ledger" && /not a document this run created/.test(e.message));
    assert.deepEqual(notOurs.calls, [], "the ledger first: not even the record is read");
    const stranger = await writeMirror(target, { doc: DOC, admin: stand(record({ members: [OWNER_EMAIL, P2, "stranger@example.test"] })) }).catch((e) => e);
    assert.equal(stranger.code, "E2E_GUARD");
    assert.equal(stranger.rule, "mirror-account");
    assert.ok(!/stranger/.test(stranger.message), "never names a person outside the run");
    await assert.rejects(writeMirror(target, { doc: DOC, admin: stand(null) }), (e) => e.code === "E2E_MIRROR" && /does not exist/.test(e.message));
    await assert.rejects(writeMirror(target, { doc: DOC, admin: stand(record({ members: "everyone" })) }), (e) => e.code === "E2E_MIRROR" && /members is not a list/.test(e.message));
    await assert.rejects(writeMirror(target, { doc: DOC, admin: stand(record({ editorMembers: [OWNER_EMAIL, 5] })) }), (e) => e.code === "E2E_MIRROR" && /editorMembers is not a list/.test(e.message));
    assert.equal(db.seen.length, 0, "nothing was sent");
    assert.equal(auth.length, 0, "no credential was even fetched");
    for (const bad of [{ doc: "" }, { doc: "a/b" }, { doc: DOC, admin: {} }, { doc: DOC, admin: { readDoc() {}, authorization: "x" } }, { doc: DOC, fetchImpl: "fetch" }, { doc: DOC, actor: "" }]) {
      await assert.rejects(writeMirror(target, bad), TypeError, JSON.stringify(Object.keys(bad)));
    }
    assert.deepEqual(findings(target), [], "no finding for a write never made");
  } finally {
    await db.close();
  }
  const refusing = await standInDatabase({ status: 401 });
  const target = localTarget(refusing.port);
  try {
    const err = await writeMirror(target, { doc: DOC, admin: readerOf() }).catch((e) => e);
    assert.equal(err.code, "E2E_MIRROR");
    assert.equal(err.status, 401);
    assert.match(err.message, /answered 401/);
    assert.equal(refusing.seen.length, 1);
  } finally {
    await refusing.close();
  }
  const silent = await writeMirror(target, { doc: DOC, admin: readerOf(), timeoutMs: 2_000 }).catch((e) => e);
  assert.equal(silent.code, "E2E_MIRROR", "a database that is gone: no answer");
  assert.equal(silent.status, null);
  assert.deepEqual(findings(target), [], "nothing written, nothing recorded");
});

test("writeMirror on a production-shaped target: the credential from the admin (here a stand-in, never ADC in a self-test), redacted in the row; a member outside the run refused there too", async () => {
  const target = targetWith({ kind: "prod", origin: "https://app.example.test", databaseURL: "https://db.example.test" });
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(init.method === 'GET' ? 'null' : init.body, { status: 200, headers: { 'content-type': 'application/json', etag: '"0"' } });
  };
  const rows = [];
  const r = await writeMirror(target, { doc: { docId: DOC }, admin: readerOf(record(), { authorization: async () => "Bearer stand-in-access-token" }), fetchImpl, evidence: (l) => rows.push(JSON.parse(l)) });
  assert.equal(r.status, 200);
  assert.deepEqual(sent.map((request) => request.method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.ok(sent.every((request) => request.headers.authorization === 'Bearer stand-in-access-token'));
  assert.ok(!JSON.stringify(rows).includes("stand-in-access-token"), "the token is redacted in the row");
  assert.equal(rows[0].reqHeaders.authorization, "Bearer ‹redacted›");
  // A member outside the run: refused on this target too, before the credential, with nothing sent.
  const before = sent.length;
  const err = await writeMirror(target, { doc: DOC, admin: readerOf(record({ members: [OWNER_EMAIL], editorMembers: [OWNER_EMAIL, "stranger@example.test"] }), { authorization: async () => "Bearer t" }), fetchImpl }).catch((e) => e);
  assert.equal(err.code, "E2E_GUARD");
  assert.equal(sent.length, before, "nothing sent");
});

// --- grantEditors, joinShared, addMember -----------------------------------------

const LOCAL = Object.freeze({ kind: "local", runId: "2610130000-mwloc", capabilities: new Set(["local"]) });
const PROD = Object.freeze({ kind: "prod", runId: "2610130000-mwprd", capabilities: new Set([]) });

/**
 * Stand-ins for grant.mjs (and, for joinShared/addMember, the other modules),
 * recording into `log`. `noMirror` lists the emails whose mirror reads back
 * missing after the grant; `stillMissing` those still missing after the
 * write; `writeError` makes writeMirror throw it.
 */
function stand(log, { noMirror = [], stillMissing = [], writeError = null } = {}) {
  const mirror = (email, ok) => (ok ? { presence: true, edit: true, expectEdit: true, ok: true } : { presence: false, edit: false, expectEdit: true, ok: false });
  let k = 0;
  return {
    async cast(target, labels, o) {
      log.push({ fn: "cast", labels: [...labels] });
      return labels.map((label) => Object.freeze({ role: label, email: `${label}-${(k += 1)}@example.test`, password: "pw", uid: `uid-${label}-${k}` }));
    },
    async openSession(target, account) {
      log.push({ fn: "openSession" });
      return { account, http: {} };
    },
    async publish() {
      log.push({ fn: "publish" });
      return { status: 200, docId: "doc-mw", versionId: "v1" };
    },
    async signInMany(users) {
      log.push({ fn: "signInMany", users: users.map((u) => u.name) });
    },
    async shareMany(target, o) {
      log.push({ fn: "shareMany", grants: o.grants.map((g) => [g.account.email ?? g.account, g.role]) });
      return { status: 200, mirrors: o.grants.map((g) => mirror(g.account.email, !noMirror.includes(g.account.email))) };
    },
    async share(target, o) {
      const email = typeof o.account === "string" ? o.account.toLowerCase() : o.account.email;
      log.push({ fn: "share", grant: [email, o.role], via: o.via });
      await new Promise((r) => setTimeout(r, 2));
      return { status: 200, mirror: mirror(email, !noMirror.includes(email)) };
    },
    async writeMirror(target, o) {
      log.push({ fn: "writeMirror", doc: o.doc, target: target.kind });
      if (writeError) throw writeError;
      return { docId: o.doc, members: ["m"], editorMembers: ["m"], update: {}, status: 200 };
    },
    async readMirror(target, docId, email, role) {
      log.push({ fn: "readMirror", docId, email, role });
      return mirror(email, !stillMissing.includes(email));
    },
  };
}

function recordingCtx(target, log) {
  const made = [];
  const user = (name) => ({
    name,
    async open() {
      log.push({ fn: "open", name });
    },
    async enterEdit() {
      log.push({ fn: "enterEdit", name });
      return { share: "shared" };
    },
    async shareState() {
      return "shared";
    },
    async signInUi() {
      log.push({ fn: "signInUi", name });
      return { status: "ok" };
    },
  });
  return {
    target,
    steps: [],
    step(s) {
      this.steps.push(s);
    },
    http: (o) => ({ actor: o?.actor }),
    get usersSoFar() {
      return made;
    },
    users: {
      async many(n, o) {
        log.push({ fn: "users.many", n });
        return o.names.map(user);
      },
      async user(o) {
        log.push({ fn: "users.user", name: o.name });
        const u = user(o.name);
        made.push(u);
        return u;
      },
    },
    inconclusive(reason) {
      log.push({ fn: "inconclusive", reason });
      const err = new Error(`INCONCLUSIVE: ${reason}`);
      err.code = "E2E_INCONCLUSIVE";
      err.reason = reason;
      throw err;
    },
  };
}

const fns = (log) => log.map((e) => e.fn);
const A = ["a@example.test", "b@example.test", "c@example.test"].map((email) => Object.freeze({ email }));

test("grantEditors: mirror \"stop\" is the old call exactly; \"write-missing\" writes ONCE after every grant on the operator path and reads each missing grantee back with its role", async () => {
  const old = [];
  const plain = await grantEditors(PROD, { owner: {}, doc: "doc-1", accounts: A, impl: stand(old, { noMirror: [A[0].email] }) });
  assert.deepEqual(Object.keys(plain).sort(), ["missing", "requests", "results", "via"], "the old result's keys exactly");
  assert.deepEqual(fns(old), ["share", "share", "share"], "nothing written by default");
  assert.deepEqual(plain.missing.map((m) => m.email), [A[0].email]);

  const log = [];
  const r = await grantEditors(PROD, { owner: {}, doc: "doc-1", accounts: A, roles: ["editor", "approver", "editor"], mirror: "write-missing", impl: stand(log, { noMirror: [A[0].email, A[1].email] }) });
  assert.deepEqual(fns(log), ["share", "share", "share", "writeMirror", "readMirror", "readMirror"], "ONE write, after every grant (a whole-node replace from the record: between grants it would be stale)");
  assert.deepEqual(log[3], { fn: "writeMirror", doc: "doc-1", target: "prod" });
  assert.deepEqual(log.slice(4).map((e) => [e.docId, e.email, e.role]), [["doc-1", A[0].email, "editor"], ["doc-1", A[1].email, "approver"]], "each missing grantee read back, with its own role");
  assert.deepEqual(r.missing.map((m) => m.email), [A[0].email, A[1].email], "`missing` still says what the grants left (the S16 evidence)");
  assert.equal(r.mirrored.written, true);
  assert.equal(r.mirrored.docId, "doc-1");
  assert.equal(r.mirrored.ok, true);
  assert.equal(r.mirrored.write.status, 200);
  assert.deepEqual(r.mirrored.accounts.map((a) => [a.email, a.role, a.before.ok, a.after.ok]), [[A[0].email, "editor", false, true], [A[1].email, "approver", false, true]]);

  const still = await grantEditors(PROD, { owner: {}, doc: { docId: "doc-2" }, accounts: A, mirror: "write-missing", impl: stand([], { noMirror: [A[2].email], stillMissing: [A[2].email] }) });
  assert.equal(still.mirrored.ok, false, "a mirror still missing after the write");
  assert.equal(still.mirrored.docId, "doc-2", "the doc as {docId}");

  const none = [];
  const clean = await grantEditors(PROD, { owner: {}, doc: "doc-1", accounts: A, mirror: "write-missing", impl: stand(none) });
  assert.equal(clean.mirrored, null);
  assert.deepEqual(fns(none), ["share", "share", "share"], "nothing missing, nothing written");

  const local = [];
  const access = await grantEditors(LOCAL, { owner: {}, doc: "doc-1", accounts: A, mirror: "write-missing", impl: stand(local, { noMirror: [A[0].email] }) });
  assert.deepEqual(fns(local), ["shareMany"], "the access path writes nothing: the product writes the mirror there, and a local case measures it");
  assert.equal(access.mirrored, null);
  assert.equal(access.missing.length, 1);
  assert.deepEqual(await grantEditors(PROD, { owner: {}, doc: "d", accounts: [], mirror: "write-missing", impl: stand([]) }), { via: "operator", requests: 0, results: [], missing: [], mirrored: null });

  const broken = new Error("writeMirror: PATCH answered 401");
  broken.code = "E2E_MIRROR";
  await assert.rejects(grantEditors(PROD, { owner: {}, doc: "doc-1", accounts: A, mirror: "write-missing", impl: stand([], { noMirror: [A[0].email], writeError: broken }) }), { code: "E2E_MIRROR" });

  const refused = [];
  const g = stand(refused);
  for (const mirror of ["write", "", null, true]) await assert.rejects(grantEditors(PROD, { owner: {}, doc: "d", accounts: A, mirror, impl: g }), (e) => e instanceof TypeError && /mirror is "stop" .* or "write-missing"/.test(e.message), JSON.stringify(mirror));
  await assert.rejects(grantEditors(PROD, { owner: {}, doc: "d", accounts: A, mirror: "write-missing", impl: { share: g.share, shareMany: g.shareMany } }), (e) => e instanceof TypeError && /impl also has writeMirror and readMirror/.test(e.message));
  await grantEditors(PROD, { owner: {}, doc: "d", accounts: [], impl: { share: g.share, shareMany: g.shareMany } });
  assert.deepEqual(refused, [], "nothing sent for a bad mode or an incomplete stand-in");
});

test("joinShared, operator path: \"write-missing\" writes the joiners' mirror before any browser and joins; still missing, or a write the database refused, is INCONCLUSIVE before any browser; the default is the old stop", async () => {
  const p2 = "editor-p2-2@example.test";

  const oldLog = [];
  const stop = await joinShared(recordingCtx(PROD, oldLog), { n: 2, enter: false, impl: stand(oldLog, { noMirror: [p2] }) }).catch((e) => e);
  assert.equal(stop.code, "E2E_INCONCLUSIVE");
  assert.match(stop.reason, /^the sync precondition did not hold: after scripts\/set-access\.mjs granted doc-mw, the RTDB mirror \(presenceAccess\/editAccess\) of editor-p2-2@example\.test is missing \(suspect S16, recorded in findings\.jsonl\), so their writes to the live log would be refused while they show "Shared"$/, "the default: the old stop, its old words");
  assert.ok(!fns(oldLog).includes("writeMirror") && !fns(oldLog).includes("users.many"));

  const log = [];
  const ctx = recordingCtx(PROD, log);
  const r = await joinShared(ctx, { n: 2, seedFirst: false, mirror: "write-missing", impl: stand(log, { noMirror: [p2] }) });
  assert.deepEqual(fns(log), ["cast", "openSession", "publish", "share", "writeMirror", "readMirror", "users.many", "signInMany", "open", "open", "enterEdit", "enterEdit"], "the write and its read-back before any browser; then the join as ever");
  assert.equal(r.grantVia, "operator");
  assert.equal(r.mirrored.ok, true);
  assert.deepEqual(r.mirrored.accounts.map((a) => a.email), [p2]);
  assert.deepEqual(Object.keys(r).sort(), ["accounts", "docId", "extra", "grantVia", "joinMs", "mirrored", "names", "owner", "role", "staged", "users"]);
  assert.match(ctx.steps[0], /one grant at a time through the operator script; an RTDB mirror the script leaves missing \(S16\) is written by the harness$/);
  assert.ok(ctx.steps.some((s) => /^suspect S16: scripts\/set-access\.mjs left the RTDB mirror of editor-p2-2@example\.test missing \(recorded in findings\.jsonl\); the harness wrote presenceAccess\/doc-mw and editAccess\/doc-mw from docs\/doc-mw/.test(s)), ctx.steps.join("\n"));

  const stillLog = [];
  const still = await joinShared(recordingCtx(PROD, stillLog), { n: 3, enter: false, mirror: "write-missing", impl: stand(stillLog, { noMirror: [p2, "editor-p3-3@example.test"], stillMissing: ["editor-p3-3@example.test"] }) }).catch((e) => e);
  assert.equal(still.code, "E2E_INCONCLUSIVE");
  assert.match(still.reason, /after the harness wrote it from docs\/doc-mw the mirror of editor-p3-3@example\.test still reads \[\{"presence":false/, "names the joiner still missing, and what it read");
  assert.doesNotMatch(still.reason.split("still reads")[0].split("the mirror of ").at(-1), /editor-p2/, "not the one the write fixed");
  assert.equal(fns(stillLog).indexOf("users.many"), -1, "no browser was made");

  const refusedLog = [];
  const refusal = Object.assign(new Error("writeMirror: PATCH of presenceAccess/doc-mw and editAccess/doc-mw answered 401: x"), { code: "E2E_MIRROR", status: 401 });
  const refused = await joinShared(recordingCtx(PROD, refusedLog), { n: 2, enter: false, mirror: "write-missing", impl: stand(refusedLog, { noMirror: [p2], writeError: refusal }) }).catch((e) => e);
  assert.equal(refused.code, "E2E_INCONCLUSIVE");
  assert.match(refused.reason, /an RTDB mirror read back missing \(suspect S16, recorded in findings\.jsonl\) and the harness could not write it: writeMirror: PATCH .* answered 401/);
  assert.equal(fns(refusedLog).indexOf("users.many"), -1);

  const guardLog = [];
  const guard = Object.assign(new Error("writeMirror: the harness's mirror write: 1 key(s) … are not run accounts"), { code: "E2E_GUARD", rule: "mirror-account" });
  await assert.rejects(joinShared(recordingCtx(PROD, guardLog), { n: 2, enter: false, mirror: "write-missing", impl: stand(guardLog, { noMirror: [p2], writeError: guard }) }), { code: "E2E_GUARD" }, "a guard refusal is the harness refusing, never INCONCLUSIVE");

  const extraLog = [];
  const okExtra = await joinShared(recordingCtx(PROD, extraLog), { n: 2, enter: false, extra: [{ role: "suggester" }], mirror: "write-missing", impl: stand(extraLog, { noMirror: ["suggester-3@example.test"], stillMissing: ["suggester-3@example.test"] }) });
  assert.equal(okExtra.mirrored.ok, false, "an extra's mirror is written too (the whole record), and reported");
  assert.ok(fns(extraLog).includes("users.many"), "but an extra never stops the join, as before");

  const localLog = [];
  const local = await joinShared(recordingCtx(LOCAL, localLog), { n: 2, enter: false, mirror: "write-missing", impl: stand(localLog, { noMirror: [p2] }) });
  assert.deepEqual(fns(localLog), ["cast", "openSession", "publish", "shareMany", "users.many", "signInMany", "open", "open"], "the access path: nothing written, nothing stopped (as before)");
  assert.equal(local.mirrored, null);

  const badLog = [];
  const six = stand(badLog);
  await assert.rejects(joinShared(recordingCtx(PROD, badLog), { n: 2, mirror: "on", impl: six }), (e) => e instanceof TypeError && /joinShared: mirror is "stop"/.test(e.message));
  const { writeMirror: _w, readMirror: _r, ...sixOnly } = six;
  await assert.rejects(joinShared(recordingCtx(PROD, badLog), { n: 2, mirror: "write-missing", impl: sixOnly }), (e) => e instanceof TypeError && /joinShared: with mirror "write-missing", impl also has writeMirror and readMirror/.test(e.message));
  assert.deepEqual(badLog, [], "checked before anything is cast");
});

test("addMember, operator path: \"write-missing\" writes the mirror before the browser; still missing is INCONCLUSIVE; the default keeps the old stop and its words", async () => {
  const owner = { account: { email: OWNER_EMAIL }, http: {} };
  const email = "editor-p3-1@example.test";
  const oldLog = [];
  const stop = await addMember(recordingCtx(PROD, oldLog), { owner, docId: "doc-am", name: "p3", impl: stand(oldLog, { noMirror: [email] }) }).catch((e) => e);
  assert.equal(stop.code, "E2E_INCONCLUSIVE");
  assert.match(stop.reason, /^the sync precondition did not hold: after scripts\/set-access\.mjs granted doc-am to p3 \(editor\), the RTDB mirror \(presenceAccess\/editAccess\) of editor-p3-1@example\.test is not what an editor needs, .*\(suspect S16, recorded in findings\.jsonl\), so its presence and its writes to the live log would be refused$/);
  assert.deepEqual(fns(oldLog), ["cast", "share", "inconclusive"]);

  const log = [];
  const ctx = recordingCtx(PROD, log);
  const r = await addMember(ctx, { owner, docId: "doc-am", name: "p3", mirror: "write-missing", impl: stand(log, { noMirror: [email] }) });
  assert.deepEqual(fns(log), ["cast", "share", "writeMirror", "readMirror", "users.user", "signInUi", "open"]);
  assert.equal(r.granted.mirrored.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ["account", "grantVia", "granted", "opened", "role", "signIn", "user"], "addMember's keys unchanged: `granted` carries `mirrored`");
  assert.ok(ctx.steps.some((s) => /^suspect S16: scripts\/set-access\.mjs left p3's RTDB mirror missing/.test(s)));

  const stillLog = [];
  const still = await addMember(recordingCtx(PROD, stillLog), { owner, docId: "doc-am", name: "p3", role: "viewer", mirror: "write-missing", impl: stand(stillLog, { noMirror: ["viewer-p3-1@example.test"], stillMissing: ["viewer-p3-1@example.test"] }) }).catch((e) => e);
  assert.equal(still.code, "E2E_INCONCLUSIVE");
  assert.match(still.reason, /the RTDB mirror \(presenceAccess\) of viewer-p3-1@example\.test was not what a viewer needs .* after the harness wrote it from docs\/doc-am it still reads .*so its presence would be refused$/);
  assert.equal(fns(stillLog).indexOf("users.user"), -1);

  const badLog = [];
  const three = stand(badLog);
  await assert.rejects(addMember(recordingCtx(PROD, badLog), { owner, docId: "doc-am", name: "p3", mirror: "write-missing", impl: { cast: three.cast, share: three.share, shareMany: three.shareMany } }), (e) => e instanceof TypeError && /addMember: with mirror "write-missing"/.test(e.message));
  await assert.rejects(addMember(recordingCtx(PROD, badLog), { owner, docId: "doc-am", name: "p3", mirror: "yes", impl: three }), (e) => e instanceof TypeError && /addMember: mirror is "stop"/.test(e.message));
  assert.deepEqual(badLog, [], "checked before anything is cast");
});

test("the README documents the mirror write and the `mirror` option", () => {
  // Line breaks read as spaces; booleans, not assert.match: a failing match prints the whole README.
  const readme = readFileSync(repo("e2e/README.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes('`writeMirror(target, {doc, actor = "operator-mirror", evidence, timeoutMs = 60_000, admin = null, fetchImpl = null})` → `{docId, members, editorMembers, update, status}`'), "README: writeMirror's signature (Seed, fixtures and grants)");
  assert.ok(readme.includes("`mirrorUpdate(docId, {members, editorMembers})`"), "README: mirrorUpdate");
  assert.ok(readme.includes("`mirrorWriteVerdict(req, {target, docs, accounts, docId = null})` → `{allow, rule[, reason]}`"), "README: mirrorWriteVerdict");
  assert.ok(readme.includes('`MIRROR_MODES` = `["stop", "write-missing"]`'), "README: MIRROR_MODES");
  assert.ok(readme.includes('impl = null, mirror = "stop"})` → `{via, requests, results, missing[, mirrored]}`'), "README: grantEditors' mirror");
  assert.ok(readme.includes('beforeJoin = null, impl = null, mirror = "stop"})` → `{docId, owner, accounts, users, names, joinMs, grantVia, role, extra, staged[, mirrored]}`'), "README: joinShared's mirror");
  assert.ok(readme.includes('timeoutMs = 120_000, impl = null, mirror = "stop"})` → `{account, user, role, grantVia, granted, signIn, opened}`'), "README: addMember's mirror");
  assert.ok(readme.includes("The one Realtime Database write outside `status/<id>` is the harness's own"), "README: production safety names the write");
  assert.ok(!readme.includes("Writing the mirror from the harness, as the plan proposes for run documents, has not been done"), "README: the old 'not done' sentence is gone");
});
