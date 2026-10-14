// SPDX-License-Identifier: Apache-2.0
// Self-test: the traced HTTP client redacts every credential, keeps cookies per actor, and stays on the stack (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar, LEAK_RE, REDACTED, assertReachable, createHttp, redactBody, redactHeaders, redactString, traceLine } from "../lib/http.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const runDir = tempDir("e2e-http-");
const LOCAL = Object.freeze({ kind: "local", runId: "2610101200-test", origin: "http://127.0.0.1:39001", runDir, stack: { ports: { hosting: 39001, auth: 39002 } } });
const allow = { check: async () => ({ allow: true }) };

const BSK = `bsk_${"a".repeat(32)}.${"S".repeat(30)}`;
const BSA = `bsa_${"b".repeat(32)}.${"T".repeat(43)}`;
const BSR = `bsr_${"c".repeat(32)}.${"U".repeat(43)}`;
const JWT = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyIiwiZW1haWwiOiJhQGIuYyJ9.";
const JWT_SIGNED = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

test("redactString removes every credential shape and keeps what is useful", () => {
  const cases = [
    [`Bearer ${BSK}`, `bsk_${"a".repeat(32)}.${REDACTED}`],
    [BSA, `bsa_${"b".repeat(32)}.${REDACTED}`],
    [BSR, `bsr_${"c".repeat(32)}.${REDACTED}`],
    ["bsk_bogus-token", `bsk_${REDACTED}`],
    [`id ${JWT} end`, "‹jwt›"],
    [JWT_SIGNED, "‹jwt›"],
    ["__session=abcDEF123456789; Path=/", `__session=${REDACTED}`],
    ["https://x/d/doc?k=LinkKey123456&v=2", `?k=${REDACTED}&v=2`],
    ["http://127.0.0.1:1/cb?code=AuthCode12345678&state=s1", `?code=${REDACTED}&state=s1`],
    ["/content/~LinkKey123456/doc/v1/index.html", `/content/~${REDACTED}/doc`],
    ["RESEND_API_KEY=re_e2e_0123456789abcdef", `re_e2e_${REDACTED}`],
  ];
  for (const [input, mustContain] of cases) {
    const out = redactString(input);
    assert.ok(out.includes(mustContain), `${input} → ${out}`);
    assert.doesNotMatch(out, LEAK_RE, `${input} → ${out} still leaks`);
  }
  assert.equal(redactString("state=s1&v=2"), "state=s1&v=2", "non-secrets untouched");
});

test("redactBody: JSON keys by name, forms by field, binary as a digest", () => {
  const json = redactBody(JSON.stringify({ email: "a@b.c", password: "hunter2hunter2", idToken: "x", nested: { token: "t", code: "c", list: [{ k: "kk" }] }, n: { code: -32601 } }), "application/json");
  const parsed = JSON.parse(json);
  assert.equal(parsed.email, "a@b.c");
  for (const v of [parsed.password, parsed.idToken, parsed.nested.token, parsed.nested.code, parsed.nested.list[0].k]) assert.equal(v, REDACTED);
  assert.equal(parsed.n.code, -32601, "numbers are not credentials");
  const form = redactBody("grant_type=authorization_code&code=abc123456789&code_verifier=v".repeat(1), "application/x-www-form-urlencoded");
  assert.equal(form, `grant_type=authorization_code&code=${REDACTED}&code_verifier=${REDACTED}`);
  assert.match(redactBody(Buffer.from([0x50, 0x4b, 3, 4, 9, 9]), "application/zip"), /^<6 bytes sha256:[0-9a-f]{16}>$/);
  const sse = redactBody(`event: message\ndata: ${JSON.stringify({ result: { token: "zzz", text: BSK } })}\n\n`, "text/event-stream");
  assert.ok(!sse.includes("zzz") && !LEAK_RE.test(sse), sse);
});

test("redactHeaders: cookie values go, cookie attributes stay, authorization keeps only safe parts", () => {
  const h = redactHeaders({
    "Set-Cookie": "__session=SECRETSECRETSECRET; Max-Age=432000; Path=/; HttpOnly; Secure; SameSite=Strict",
    cookie: "__session=SECRETSECRET; other=val",
    authorization: `Bearer ${BSK}`,
  });
  assert.equal(h["set-cookie"], `__session=${REDACTED}; Max-Age=432000; Path=/; HttpOnly; Secure; SameSite=Strict`);
  assert.equal(h.cookie, `__session=${REDACTED}; other=${REDACTED}`);
  assert.equal(h.authorization, `Bearer bsk_${"a".repeat(32)}.${REDACTED}`);
  assert.equal(redactHeaders({ authorization: "Bearer owner" }).authorization, "Bearer owner");
  assert.equal(redactHeaders({ authorization: "Bearer opaque-value" }).authorization, `Bearer ${REDACTED}`);
  assert.equal(redactHeaders({ authorization: "Basic dXNlcjpwYXNz" }).authorization, `Basic ${REDACTED}`);
});

test("traceLine refuses a row that still holds a credential (the leak tripwire)", () => {
  for (const leak of [BSK, JWT_SIGNED, "__session=abcdefghijkl", "x?k=abcdefghij", "re_e2e_0123456789ab"]) {
    assert.throws(() => traceLine({ method: "GET", url: "/x", resBody: leak }), (e) => e.code === "E2E_REDACTION", leak);
  }
  assert.doesNotThrow(() => traceLine({ method: "GET", url: "/x", resBody: redactString(BSK) }));
});

test("CookieJar: Secure is honoured on loopback http, Max-Age=0 deletes, paths and hosts scope", () => {
  const jar = new CookieJar();
  jar.store("http://127.0.0.1:39001/session", ["__session=v1; Max-Age=432000; Path=/; HttpOnly; Secure; SameSite=Strict"]);
  assert.equal(jar.header("http://127.0.0.1:39001/content/x"), "__session=v1");
  assert.equal(jar.header("http://127.0.0.1:39001/"), "__session=v1");
  assert.equal(jar.header("http://localhost:39001/"), undefined, "host-only");
  jar.store("https://a.example/", ["s=1; Secure"]);
  assert.equal(jar.header("http://a.example/"), undefined, "Secure is not sent over http to a non-loopback host");
  jar.store("http://127.0.0.1:39001/x", ["p=1; Path=/deep"]);
  assert.equal(jar.header("http://127.0.0.1:39001/deeper"), "__session=v1", "path /deep does not match /deeper");
  assert.equal(jar.header("http://127.0.0.1:39001/deep/x"), "__session=v1; p=1");
  jar.store("http://127.0.0.1:39001/session", ["__session=; Max-Age=0; Path=/"]);
  assert.equal(jar.has("__session"), false);
});

test("assertReachable: a local target talks only to its own loopback ports", () => {
  assert.doesNotThrow(() => assertReachable(LOCAL, "http://127.0.0.1:39001/config"));
  assert.throws(() => assertReachable(LOCAL, "https://identitytoolkit.googleapis.com/v1/x"), (e) => e.code === "E2E_ISOLATION");
  assert.throws(() => assertReachable(LOCAL, "http://127.0.0.1:9099/"), (e) => e.code === "E2E_ISOLATION", "a default emulator port");
  assert.throws(() => assertReachable(LOCAL, "http://127.0.0.1:39050/"), (e) => e.code === "E2E_ISOLATION", "another stack's port");
  assert.doesNotThrow(() => assertReachable(LOCAL, "http://127.0.0.1:39050/", [39050]), "an explicitly allowed receiver");
});

test("createHttp: agent headers, guard before fetch, cookies per client, one redacted row per request", async () => {
  const order = [];
  const sent = [];
  const fakeFetch = async (url, init) => {
    order.push("fetch");
    sent.push({ url, init });
    if (url.endsWith("/session")) {
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json", "set-cookie": "__session=COOKIEVALUE123; Max-Age=432000; Path=/; HttpOnly; Secure" } });
    }
    return new Response(JSON.stringify({ token: BSK, ok: true }), { headers: { "content-type": "application/json" } });
  };
  const guard = { check: async () => (order.push("guard"), { allow: true }) };
  const file = tempDir("e2e-ev-");
  const a = createHttp(LOCAL, { actor: "a", guard, fetch: fakeFetch, evidence: file });
  const b = createHttp(LOCAL, { actor: "b", guard: allow, fetch: fakeFetch, evidence: file });
  await a.postJson("/session", { idToken: JWT });
  const r = await a.get("/tokens");
  assert.equal(r.json.ok, true);
  assert.deepEqual(order, ["guard", "fetch", "guard", "fetch"], "the guard is asked before every request");
  assert.equal(sent[0].init.headers["user-agent"], "bikeshed-e2e/2610101200-test");
  assert.equal(sent[0].init.headers["x-bikeshed-agent"], "bikeshed-e2e/2610101200-test");
  assert.equal(sent[1].init.headers.cookie, "__session=COOKIEVALUE123", "a's jar sends its cookie");
  await b.get("/tokens");
  assert.equal(sent[2].init.headers.cookie, undefined, "b has its own jar");
  const rows = readFileSync(join(file, "http.jsonl"), "utf8").trim().split("\n");
  assert.equal(rows.length, 3);
  const all = rows.join("\n");
  assert.ok(!all.includes("COOKIEVALUE123") && !all.includes(JWT) && !all.includes(BSK), "no secret in the trace");
  assert.doesNotMatch(all, LEAK_RE);
  assert.equal(JSON.parse(rows[0]).resHeaders["set-cookie"], `__session=${REDACTED}; Max-Age=432000; Path=/; HttpOnly; Secure`);
  await assert.rejects(a.get("http://127.0.0.1:9099/"), (e) => e.code === "E2E_ISOLATION");
  await assert.rejects(a.get("/x", { expect: 404 }), (e) => e.code === "E2E_STATUS");
});
