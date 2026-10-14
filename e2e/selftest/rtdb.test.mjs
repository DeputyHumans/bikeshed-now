// SPDX-License-Identifier: Apache-2.0
// Self-test: RTDB rules bound to the app's namespace, REST as a user (?auth= only) and as the emulator's admin, and the production guard's RTDB rules (SPEC §6b, §12).

/**
 * Four defects this file exists to keep out:
 *
 *  - firebase-tools binds a plain `database: {rules}` to `<projectId>-default-rtdb`
 *    while the app and the functions use `ns=<projectId>`, which then ran
 *    with no rules: every RTDB denial a spec asserted was blind. The binding
 *    is checked against firebase-tools' OWN resolver, and readiness and
 *    rtdbRulesStatus must refuse a namespace that reads back other rules or
 *    lets an anonymous read through.
 *  - the RTDB emulator takes ANY `Authorization: Bearer …` as its admin, so a
 *    user-level request that carries one is not a user-level request. rtdbAs
 *    must send the ID token only as ?auth=, even through a client that
 *    carries a default Authorization header.
 *  - the RTDB emulator never says a token is bad: one with no JWT shape, or
 *    whose payload lacks `sub` or `iat`, is evaluated as NO token, so the
 *    rules' DENY comes back for an anonymous caller and reads as the
 *    account's. rtdbAs must refuse such a token before sending anything, and
 *    must still send every token the emulator does read as its user (it
 *    ignores the signature, `exp` and `aud`).
 *  - on production an RTDB REST write used to be an "other host" the guard
 *    let through; it now goes only under status/<id> of the run's documents.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { PROJECT_ID, patchFirebaseJson, rtdbRulesConfig, rtdbRulesFile } from "../lib/patch.mjs";
import { checkRtdbRules } from "../lib/stack.mjs";
import { capabilitiesFor } from "../lib/options.mjs";
import { CookieJar, createHttp } from "../lib/http.mjs";
import { DEFAULT_POLICY, RTDB_REST, createGuard, evaluate } from "../lib/guard.mjs";
import { RTDB_ADMIN_BEARER, RTDB_DENIED, rtdbAdmin, rtdbAs, rtdbNamespace, rtdbResult, rtdbRulesStatus, rtdbTokenProblem, rtdbUrl } from "../lib/rtdb.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const NS = "demo-rtdbst";
const DB_PORT = 39005;
const LOCAL = Object.freeze({
  kind: "local",
  runId: "2610110130-rtdb",
  runDir: tempDir("e2e-rtdb-"),
  projectId: NS,
  origin: "http://127.0.0.1:39001",
  databaseURL: `http://127.0.0.1:${DB_PORT}?ns=${NS}`,
  capabilities: new Set(["local", "admin-emulator"]),
  stack: { ports: { hosting: 39001, auth: 39002, database: DB_PORT } },
});
// A production-shaped database host, built here so no source line spells one.
const PROD_DB = `https://${NS}-default-rtdb.${["firebaseio", "com"].join(".")}`;
const PROD = Object.freeze({ kind: "prod", runId: "2610110130-rtprd", runDir: tempDir("e2e-rtprd-"), projectId: NS, origin: "https://rtdb-selftest.invalid", databaseURL: `${PROD_DB}/`, capabilities: new Set([]) });
const OWN = "e2e-0rtprd-mine-abcd";
const CTX = Object.freeze({ target: PROD, ledgerDocs: new Set([OWN]), ledgerFolders: new Set() });

// An emulator-shaped ID token (alg none, empty signature, the claims the Auth
// emulator issues) and a legacy-secret-shaped one.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const CLAIMS = Object.freeze({ iss: `https://securetoken.google.com/${NS}`, aud: NS, auth_time: 1760140800, user_id: "uid-rtdb-selftest", sub: "uid-rtdb-selftest", iat: 1760140800, exp: 1760144400, email: "x@example.com", email_verified: true });
const jwt = (claims, { header = { alg: "none", typ: "JWT" }, signature = "" } = {}) => `${b64(header)}.${b64(claims)}.${signature}`;
const TOKEN = jwt(CLAIMS);
const LEGACY = "LegacySecret0123456789abcdef";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** A fetch that records every request and answers from `reply(url, init)`. */
function recorder(reply = () => json(200, null)) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: new URL(String(url)), method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return reply(String(url), init);
  };
  return { calls, fetch };
}

// --- The binding -----------------------------------------------------------------

test("rtdbRulesConfig binds the tree's rules to ns=<projectId> as well as the default instance; anything it cannot read throws", () => {
  const plain = rtdbRulesConfig({ rules: "database.rules.json" }, NS);
  assert.deepEqual(plain.config, [{ instance: NS, rules: "database.rules.json" }, { instance: `${NS}-default-rtdb`, rules: "database.rules.json" }]);
  assert.deepEqual(plain.namespaces, [NS, `${NS}-default-rtdb`]);
  assert.equal(plain.rules, "database.rules.json");
  const list = [{ instance: NS, rules: "a.json" }, { instance: "other", rules: "b.json" }];
  assert.equal(rtdbRulesConfig(list, NS).config, list, "a list that already binds the namespace is left alone");
  assert.equal(rtdbRulesConfig(list, NS).rules, "a.json");
  assert.deepEqual(rtdbRulesConfig(undefined, NS), { config: undefined, namespaces: [], rules: null }, "a tree without RTDB rules binds nothing");
  for (const [what, bad] of [
    ["no rules file", {}],
    ["a list without the namespace", [{ instance: `${NS}-default-rtdb`, rules: "x.json" }]],
    ["a deploy target", [{ target: "main", rules: "x.json" }]],
    ["an entry without rules", [{ instance: NS }]],
  ]) {
    assert.throws(() => rtdbRulesConfig(bad, NS), (e) => e.code === "E2E_RTDB_RULES", what);
  }
  assert.equal(rtdbRulesFile({ database: list }, "other"), "b.json");
  assert.equal(rtdbRulesFile({ database: list }, "nobody"), null);
  assert.equal(rtdbRulesFile({ database: { rules: "r.json" } }, "anything"), "r.json", "the plain form: the file the tree means");
  assert.equal(rtdbRulesFile({}, NS), null);
});

test("patchFirebaseJson writes the binding into the copy of the checkout's real firebase.json", () => {
  const dir = tempDir("e2e-rtdb-fb-");
  copyFileSync(join(REPO_ROOT, "firebase.json"), join(dir, "firebase.json"));
  const before = JSON.parse(readFileSync(join(dir, "firebase.json"), "utf8"));
  const ports = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 34560 + i));
  const r = patchFirebaseJson(dir, ports);
  const after = JSON.parse(readFileSync(join(dir, "firebase.json"), "utf8"));
  assert.equal(typeof before.database.rules, "string", "the checkout's firebase.json has the plain form this fixes");
  assert.deepEqual(after.database, [{ instance: PROJECT_ID, rules: before.database.rules }, { instance: `${PROJECT_ID}-default-rtdb`, rules: before.database.rules }]);
  assert.deepEqual(r.database, { namespaces: [PROJECT_ID, `${PROJECT_ID}-default-rtdb`], rules: before.database.rules });
  assert.ok(existsSync(join(REPO_ROOT, before.database.rules)), "the bound rules file exists in the tree");
});

/** firebase-tools' own database rules resolver, or null when firebase is not installed here. */
function firebaseToolsResolver() {
  const which = (process.env.PATH ?? "").split(":").map((d) => join(d, "firebase")).find((p) => existsSync(p));
  const bin = process.env.E2E_FIREBASE_BIN || which;
  if (!bin) return null;
  let dir = dirname(realpathSync(bin));
  while (dir !== dirname(dir) && !existsSync(join(dir, "lib", "database", "rulesConfig.js"))) dir = dirname(dir);
  const file = join(dir, "lib", "database", "rulesConfig.js");
  return existsSync(file) ? createRequire(file)(file) : null;
}

test("firebase-tools' own resolver: the plain form binds only <projectId>-default-rtdb, the patched form binds ns=<projectId>", (t) => {
  const resolver = firebaseToolsResolver();
  if (!resolver) return t.skip("firebase-tools is not installed here");
  // As `emulators:start --only auth,firestore,database,…` calls it.
  const resolve = (database) => resolver.getRulesConfig(PROJECT_ID, { config: { src: { database } }, only: "auth,firestore,database,functions,hosting,storage", project: PROJECT_ID, rc: {} });
  const real = JSON.parse(readFileSync(join(REPO_ROOT, "firebase.json"), "utf8")).database;
  assert.deepEqual(resolve(real).map((c) => c.instance), [`${PROJECT_ID}-default-rtdb`], "the defect: the app's namespace gets no rules");
  const bound = resolve(rtdbRulesConfig(real, PROJECT_ID).config);
  assert.deepEqual(bound.map((c) => c.instance), [PROJECT_ID, `${PROJECT_ID}-default-rtdb`]);
  assert.ok(bound.every((c) => c.rules === real.rules));
});

// --- Readiness and the live check ---------------------------------------------------

function rulesTree({ plain = false } = {}) {
  const tree = tempDir("e2e-rtdb-tree-");
  const rules = '// a comment the emulator keeps — byte for byte\n{ "rules": { ".read": false, ".write": false } }\n';
  writeFileSync(join(tree, "database.rules.json"), rules);
  const database = plain ? { rules: "database.rules.json" } : rtdbRulesConfig({ rules: "database.rules.json" }, NS).config;
  writeFileSync(join(tree, "firebase.json"), JSON.stringify({ database }));
  return { tree, rules: Buffer.from(rules) };
}

/** A database that answers the rules read and the anonymous read as told. */
function fakeDatabase({ stored, anonymous = json(401, { error: RTDB_DENIED }), storedFor = {} }) {
  return recorder((url) => {
    const u = new URL(url);
    if (u.pathname === "/.settings/rules.json") {
      const body = storedFor[u.searchParams.get("ns")] ?? stored;
      return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return anonymous.clone();
  });
}

test("checkRtdbRules (readiness): every bound namespace reads the rules back byte-equal, and ns=<projectId> refuses an anonymous read", async () => {
  const { tree, rules } = rulesTree();
  const rec = { runId: "x", projectId: NS, treeDir: tree, ports: { database: DB_PORT }, rtdbBinding: { namespaces: [NS, `${NS}-default-rtdb`], rules: "database.rules.json" } };
  const good = fakeDatabase({ stored: rules });
  const r = await checkRtdbRules(rec, { fetchImpl: good.fetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.equal, r.unequal, r.anonymousStatus, r.bytes], [true, [], 401, rules.length]);
  const reads = good.calls.filter((c) => c.url.pathname === "/.settings/rules.json");
  assert.deepEqual(reads.map((c) => c.url.searchParams.get("ns")), [NS, `${NS}-default-rtdb`]);
  assert.ok(reads.every((c) => c.headers.authorization === "Bearer owner"), "the rules are read as the admin");
  const anon = good.calls.find((c) => c.url.pathname === "/.json");
  assert.equal(anon.headers.authorization, undefined, "the anonymous read carries no credential");
  assert.equal(anon.url.searchParams.get("ns"), NS);

  const off = Buffer.from(rules.toString().replace("false", "true"));
  const unequal = await checkRtdbRules(rec, { fetchImpl: fakeDatabase({ stored: rules, storedFor: { [NS]: off } }).fetch });
  assert.deepEqual([unequal.ok, unequal.unequal], [false, [NS]], "the app's namespace running other rules is not ready");
  const open = await checkRtdbRules(rec, { fetchImpl: fakeDatabase({ stored: rules, anonymous: json(200, { status: true }) }).fetch });
  assert.deepEqual([open.ok, open.equal, open.anonymousStatus], [false, true, 200], "an open namespace is not ready, whatever its rules read back");
});

test("rtdbRulesStatus (live): ok only when the bound file reads back byte-equal AND an anonymous read is a rules denial", async () => {
  const { tree, rules } = rulesTree();
  const target = { ...LOCAL, stack: { ...LOCAL.stack, treeDir: tree } };
  const status = async (db, o = {}) => rtdbRulesStatus(target, { http: createHttp(target, { fetch: db.fetch, evidence: false }), ...o });

  const good = fakeDatabase({ stored: rules });
  const ok = await status(good);
  assert.deepEqual([ok.ok, ok.checked, ok.namespace, ok.file, ok.equal, ok.rulesStatus, ok.anonymousStatus, ok.reason], [true, true, NS, "database.rules.json", true, 200, 401, null]);
  const anon = good.calls.find((c) => c.url.pathname === "/.json");
  assert.equal(anon.headers.authorization, undefined);
  assert.equal(anon.url.searchParams.get("auth"), null);

  const differs = await status(fakeDatabase({ stored: Buffer.concat([rules, Buffer.from(" ")]) }));
  assert.equal(differs.ok, false);
  assert.match(differs.reason, /are not database\.rules\.json/);
  const open = await status(fakeDatabase({ stored: rules, anonymous: json(200, null) }));
  assert.deepEqual([open.ok, open.equal], [false, true]);
  assert.match(open.reason, /anonymous read .* answered 200/);
  const badToken = await status(fakeDatabase({ stored: rules, anonymous: json(401, { error: "Could not parse auth token." }) }));
  assert.equal(badToken.ok, false, "a 401 that is not the rules' is not proof");

  const plain = rulesTree({ plain: true });
  const old = await rtdbRulesStatus({ ...LOCAL, stack: { ...LOCAL.stack, treeDir: plain.tree } }, { http: createHttp(LOCAL, { fetch: fakeDatabase({ stored: plain.rules }).fetch, evidence: false }) });
  assert.equal(old.ok, true, "a copy made before the binding still names the file the tree means");
  assert.deepEqual(await rtdbRulesStatus(PROD), { ok: false, checked: false, namespace: `${NS}-default-rtdb`, file: null, reason: "only a local stack's RTDB rules can be read back" });
});

test("capability rtdb-rules: only a stack whose readiness proved the binding", () => {
  const has = (rtdbRules) => capabilitiesFor({ rtdbRules }).has("rtdb-rules");
  assert.equal(has({ equal: true, anonymousStatus: 401 }), true);
  assert.equal(has(undefined), false, "an older stack's record");
  assert.equal(has({ equal: false, anonymousStatus: 401 }), false);
  assert.equal(has({ equal: true, anonymousStatus: 200 }), false);
});

// --- REST as a user, and as the admin ---------------------------------------------------

test("rtdbUrl: the target's own query (ns), encoded segments, the root, and no dot segments", () => {
  assert.equal(rtdbUrl(LOCAL, "status/d 1/y/e,1"), `http://127.0.0.1:${DB_PORT}/status/d%201/y/e%2C1.json?ns=${NS}`);
  assert.equal(rtdbUrl(LOCAL, ""), `http://127.0.0.1:${DB_PORT}/.json?ns=${NS}`);
  assert.equal(rtdbUrl(LOCAL, "/a//b/", { shallow: true, orderBy: '"$key"', skip: undefined }), `http://127.0.0.1:${DB_PORT}/a/b.json?ns=${NS}&shallow=true&orderBy=%22%24key%22`);
  assert.throws(() => rtdbUrl(LOCAL, "status/../presenceAccess"), /"\." or "\.\."/);
  assert.equal(rtdbNamespace(LOCAL), NS);
  assert.equal(rtdbNamespace(PROD), `${NS}-default-rtdb`, "a production URL names its instance by host");
  assert.throws(() => rtdbUrl({ ...LOCAL, databaseURL: undefined }, "x"), /no databaseURL/);
});

test("rtdbAs sends the ID token only as ?auth= — never an Authorization header or a cookie, even one the client carries by default", async () => {
  const db = recorder();
  const jar = new CookieJar();
  jar.store(`http://127.0.0.1:${DB_PORT}/`, ["__session=cookie-value-0123456789"]);
  // A client that would otherwise send a Bearer header with every request.
  const http = createHttp(LOCAL, { fetch: db.fetch, evidence: false, jar, headers: { Authorization: "Bearer default-header-token" } });
  const as = rtdbAs(LOCAL, { idToken: TOKEN, http });
  await as.put("status/d1/y/e1", "AAA=");
  await as.get("status/d1/y", { query: { shallow: true } });
  await as.patch("status/d1/peers/u1", { mode: "view" });
  await as.post("status/d1/y", "BBB=");
  await as.delete("status/d1/y/e1");
  await as.request("GET", "presenceAccess/d1");
  assert.deepEqual(db.calls.map((c) => c.method), ["PUT", "GET", "PATCH", "POST", "DELETE", "GET"]);
  for (const c of db.calls) {
    assert.equal(c.headers.authorization, undefined, `${c.method} ${c.url.pathname} carries no Authorization`);
    assert.equal(c.headers.cookie, undefined, `${c.method} ${c.url.pathname} carries no cookie`);
    assert.equal(c.url.searchParams.get("auth"), TOKEN, "the token is ?auth=");
    assert.equal(c.url.searchParams.get("ns"), NS);
  }
  assert.equal(db.calls[0].body, "AAA=");
  assert.deepEqual(db.calls[2].body, { mode: "view" });
  assert.equal(db.calls[1].url.searchParams.get("shallow"), "true");
  assert.equal(db.calls[4].body, undefined);

  const anon = recorder();
  await rtdbAs(LOCAL, { idToken: null, http: createHttp(LOCAL, { fetch: anon.fetch, evidence: false, headers: { authorization: "Bearer x" } }) }).get("status/d1");
  assert.equal(anon.calls[0].url.searchParams.has("auth"), false, "anonymous: no auth at all");
  assert.equal(anon.calls[0].headers.authorization, undefined);

  let asked = 0;
  const lazy = recorder();
  const viaFn = rtdbAs(LOCAL, { idToken: async () => (asked++, TOKEN), http: createHttp(LOCAL, { fetch: lazy.fetch, evidence: false }) });
  await viaFn.get("a");
  await viaFn.get("b");
  assert.equal(asked, 2, "a token function is asked per request");

  assert.throws(() => rtdbAs(LOCAL, { idToken: RTDB_ADMIN_BEARER }), /admin credential/);
  await assert.rejects(rtdbAs(LOCAL, { idToken: () => RTDB_ADMIN_BEARER, http }).get("x"), /admin credential/);
  await assert.rejects(rtdbAs(LOCAL, { idToken: "", http }).get("x"), /non-empty string/);
  await assert.rejects(as.get("x", { query: { auth: TOKEN } }), /pass idToken/);
});

test("rtdbAs refuses, before sending, a token the emulator would read as nobody; it sends every token the emulator reads as its user", async () => {
  // Each row was measured on a stack's emulator under the tree's rules,
  // reading status/<doc> where the claims' email is a member: "nobody" rows
  // answered 401 Permission denied (an anonymous caller), "user" rows 200.
  const { sub: _s, ...noSub } = CLAIMS;
  const { iat: _i, ...noIat } = CLAIMS;
  const { exp: _e, ...noExp } = CLAIMS;
  const std = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const nobody = [
    ["not-a-token", "not-a-token"],
    ["a legacy secret", LEGACY],
    ["two segments", jwt(CLAIMS).slice(0, -1)],
    ["header not JSON", `bm90.${b64(CLAIMS)}.`],
    ["payload not JSON", `${b64({ alg: "none" })}.bm90.`],
    ["payload an array", `${b64({ alg: "none" })}.${b64([1])}.`],
    ["no sub", jwt(noSub)],
    ["an empty sub", jwt({ ...CLAIMS, sub: "" })],
    ["no iat", jwt(noIat)],
  ];
  const user = [
    ["the Auth emulator's shape", TOKEN],
    ["expired", jwt({ ...CLAIMS, exp: 1 })],
    ["no exp", jwt(noExp)],
    ["another aud", jwt({ ...CLAIMS, aud: "other-project" })],
    ["a signature that is not one", jwt(CLAIMS, { header: { alg: "RS256", typ: "JWT" }, signature: "garbage" })],
    ["standard base64, padded", `${std({ alg: "none" })}.${std(CLAIMS)}.`],
  ];
  for (const [label, t] of nobody) {
    assert.equal(typeof rtdbTokenProblem(t), "string", `${label}: a problem`);
    assert.ok(!rtdbTokenProblem(t).includes(t), `${label}: the reason does not carry the token`);
    const db = recorder();
    const http = createHttp(LOCAL, { fetch: db.fetch, evidence: false });
    await assert.rejects(rtdbAs(LOCAL, { idToken: t, http }).get("status/d1"), (e) => e.code === "E2E_RTDB_TOKEN" && !e.message.includes(t), label);
    await assert.rejects(rtdbAs(LOCAL, { idToken: async () => t, http }).put("status/d1/y/e", "v"), (e) => e.code === "E2E_RTDB_TOKEN", `${label} (from a function)`);
    assert.equal(db.calls.length, 0, `${label}: nothing was sent`);
  }
  for (const [label, t] of user) {
    assert.equal(rtdbTokenProblem(t), null, label);
    const db = recorder();
    await rtdbAs(LOCAL, { idToken: t, http: createHttp(LOCAL, { fetch: db.fetch, evidence: false }) }).get("status/d1");
    assert.equal(db.calls.length, 1, `${label}: sent`);
    assert.equal(db.calls[0].url.searchParams.get("auth"), t, label);
  }
});

test("rtdbAdmin sends Bearer owner and nothing else; a target without the emulator's admin is refused", async () => {
  const db = recorder((url) => (new URL(url).pathname === "/.settings/rules.json" ? new Response("// r\n{}", { status: 200 }) : json(200, { v: 1 })));
  const admin = rtdbAdmin(LOCAL, { http: createHttp(LOCAL, { fetch: db.fetch, evidence: false, headers: { authorization: "Bearer other" } }) });
  const got = await admin.get("presenceAccess/d1", { query: { shallow: true } });
  assert.deepEqual([got.verdict, got.json], ["ALLOW", { v: 1 }]);
  const rules = await admin.rules();
  assert.deepEqual([rules.status, rules.text], [200, "// r\n{}"]);
  for (const c of db.calls) {
    assert.equal(c.headers.authorization, "Bearer owner");
    assert.equal(c.url.searchParams.has("auth"), false);
    assert.equal(c.headers.cookie, undefined);
  }
  assert.equal(db.calls[1].url.pathname, "/.settings/rules.json");
  assert.equal(db.calls[1].url.searchParams.get("ns"), NS);
  await admin.rules({ namespace: "other-ns" });
  assert.equal(db.calls[2].url.searchParams.get("ns"), "other-ns");
  await assert.rejects(admin.get("x", { query: { auth: "t" } }), /Bearer owner/);
  assert.throws(() => rtdbAdmin(PROD), (e) => e.code === "E2E_CAPABILITY");
  assert.throws(() => rtdbAdmin({ ...LOCAL, capabilities: new Set(["local"]) }), (e) => e.code === "E2E_CAPABILITY");
});

test("rtdbResult: ALLOW is a 200, DENY only the rules' 401; a bad token, a 400 and a 404 are no verdict", () => {
  const r = (status, body) => rtdbResult({ status, json: body });
  assert.deepEqual([r(200, null).verdict, r(200, null).ok], ["ALLOW", true]);
  assert.equal(r(200, { error: "a stored value named error" }).error, null, "a 200's body is data");
  assert.deepEqual([r(401, { error: RTDB_DENIED }).verdict, r(401, { error: RTDB_DENIED }).denied], ["DENY", true]);
  assert.deepEqual([r(401, { error: "Could not parse auth token." }).verdict, r(401, { error: "Could not parse auth token." }).error], [null, "Could not parse auth token."]);
  assert.equal(r(400, { error: "Invalid data; couldn't parse JSON object" }).verdict, null);
  assert.equal(r(404, "Not Found").verdict, null);
  assert.equal(r(403, { error: RTDB_DENIED }).verdict, null, "only a 401 is the rules' answer");
});

test("?auth= never reaches a trace: a JWT and a secret that has no JWT shape are both redacted", async () => {
  const rows = [];
  const db = recorder();
  const http = createHttp(LOCAL, { fetch: db.fetch, evidence: (l) => rows.push(l) });
  await rtdbAs(LOCAL, { idToken: TOKEN, http }).get("status/d1");
  // rtdbAs refuses a legacy secret (it is no user); the trace must still hide one sent by hand.
  await http.request("PUT", rtdbUrl(LOCAL, "status/d1/y/e", { auth: LEGACY }), { json: "v", noCookies: true });
  assert.equal(rows.length, 2);
  for (const line of rows) {
    assert.ok(!line.includes(TOKEN.split(".")[1]) && !line.includes(LEGACY), `no credential in ${line.slice(0, 200)}`);
    assert.match(JSON.parse(line).url, /[?&]auth=‹redacted›/);
  }
});

// --- The production guard ------------------------------------------------------------

test("guard: on production RTDB reads go; a write goes only under status/<own doc>; .settings, other subtrees, databases and namespaces are refused", () => {
  const v = (method, path, query = "", base = PROD_DB) => evaluate({ method, url: `${base}${path}${query}` }, CTX);
  assert.equal(v("GET", `/status/someone-elses/y.json`, "?auth=t").rule, "rtdb-read", "a read is a read");
  assert.equal(v("PUT", `/status/${OWN}/y/e1.json`, "?auth=t").rule, "rtdb-write");
  assert.equal(v("DELETE", `/status/${OWN}/peers/u1.json`).rule, "rtdb-write");
  assert.equal(v("POST", `/status/${OWN}/y.json`).rule, "rtdb-write");
  assert.equal(v("PUT", `/status/someone-elses/y/e1.json`).rule, "ledger");
  assert.equal(v("PATCH", `/status.json`).rule, "rtdb-path", "a multi-path update above the documents");
  assert.equal(v("PATCH", `/.json`).rule, "rtdb-path", "the root");
  assert.equal(v("PUT", `/presenceAccess/${OWN}/x.json`).rule, "rtdb-path", "the server's mirror");
  assert.equal(v("PUT", `/.settings/rules.json`).rule, "rtdb-path", "the rules themselves");
  assert.equal(v("PUT", `/status/${OWN}%2F..%2Fx/y.json`).rule, "rtdb-unclassified", "an escaped slash");
  assert.equal(v("PUT", `/status/${OWN}/y/e1`).rule, "rtdb-unclassified", "not a REST path");
  assert.equal(v("GET", `/status/someone-elses/y/e1.json`, "?x-http-method=DELETE").rule, "ledger", "a GET that says DELETE is a write");
  assert.equal(v("GET", `/status/${OWN}.json`, `?ns=${NS}-other`).rule, "rtdb-namespace");
  assert.equal(v("GET", `/status/${OWN}.json`, `?ns=${NS}-default-rtdb`).rule, "rtdb-read", "its own namespace, named");
  const elsewhere = `https://demo-elsewhere.${["firebaseio", "com"].join(".")}`;
  assert.equal(v("GET", `/status/${OWN}.json`, "", elsewhere).rule, "rtdb-project", "another database, even for a read");
  assert.equal(evaluate({ method: "PUT", url: `${elsewhere}/status/${OWN}/y/e.json` }, { ...CTX, target: { ...PROD, databaseURL: undefined } }).rule, "rtdb-project", "a target naming no database writes to none");
  assert.equal(evaluate({ method: "PUT", url: `${LOCAL.databaseURL.replace(`?ns=${NS}`, "")}/.settings/rules.json?ns=${NS}` }, { ...CTX, target: LOCAL }).allow, true, "a local target allows everything");
  assert.equal(DEFAULT_POLICY.rtdbRest, RTDB_REST);
});

test("NEGATIVE: with the RTDB rule taken out of the policy, the same production writes are let through as another host", () => {
  const off = { ...DEFAULT_POLICY, rtdbRest: null };
  for (const path of ["/status/someone-elses/y/e1.json", "/.settings/rules.json", "/presenceAccess/x/y.json"]) {
    assert.equal(evaluate({ method: "PUT", url: `${PROD_DB}${path}` }, { ...CTX, policy: off }).allow, true, path);
    assert.equal(evaluate({ method: "PUT", url: `${PROD_DB}${path}` }, CTX).allow, false, path);
  }
});

test("through http.mjs a refused RTDB write never reaches fetch, and the refusal is traced", async () => {
  const db = recorder();
  const rows = [];
  const guard = createGuard(PROD, { ledger: () => ({ docs: new Set([OWN]), folders: new Set(), accounts: new Map() }) });
  const http = createHttp(PROD, { guard, fetch: db.fetch, evidence: (l) => rows.push(JSON.parse(l)) });
  const as = rtdbAs(PROD, { idToken: TOKEN, http });
  await assert.rejects(as.put("status/someone-elses/y/e1", "v"), (e) => e.code === "E2E_GUARD" && e.rule === "ledger");
  assert.equal(db.calls.length, 0);
  assert.equal(rows.at(-1).guard.refused, true);
  await as.put(`status/${OWN}/y/e1`, "v");
  assert.equal(db.calls.length, 1, "the run's own document goes");
  assert.equal(db.calls[0].url.origin, PROD_DB);
});
