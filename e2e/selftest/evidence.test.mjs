// SPDX-License-Identifier: Apache-2.0
// Self-test: evidence lines are redacted like http.mjs and withheld when a shape survives; redirects are checked hop by hop; downloads go through http.mjs; traces stay local (SPEC §12).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, ensureDir } from "../lib/paths.mjs";
import { Evidence, WITHHELD, redactString, safeLine } from "../lib/evidence.mjs";
import { LEAK_RE, createHttp } from "../lib/http.mjs";
import { downloadVersion, rehashVersion } from "../lib/bytes.mjs";
import { BrowserPool } from "../lib/browser.mjs";
import { zipBundle } from "../lib/seed.mjs";
import { rmSync } from "node:fs";

const BSK = `bsk_${"a".repeat(32)}.${"S".repeat(30)}`;
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const LINK_KEY = "LinkKey0123456789abcdef";
const SECRETS = [BSK.split(".")[1], JWT, LINK_KEY, "SESSIONSESSIONSESSION", "hunter2hunter2"];
const runDir = ensureDir(join(OUT_DIR, `selftest-evidence-${process.pid}`));
const allow = { check: async () => ({ allow: true }) };

/** Two loopback servers: `own` (the stack) and `foreign` (any other port), each recording what reached it. */
let own;
let foreign;
let zip;
const hits = { own: [], foreign: [] };
function server(name, handler) {
  const s = createServer((req, res) => {
    hits[name].push({ method: req.method, url: req.url, cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null });
    handler(req, res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

before(async () => {
  zip = await zipBundle({ "index.html": "<!doctype html><p>v1</p>" });
  foreign = await server("foreign", (req, res) => res.end("you should never see this"));
  own = await server("own", (req, res) => {
    const u = new URL(req.url, "http://x");
    const fport = foreign.address().port;
    if (u.pathname === "/a") return res.writeHead(302, { location: "/b", "set-cookie": "hop=one; Path=/" }).end();
    if (u.pathname === "/b") return res.writeHead(303, { location: `http://127.0.0.1:${own.address().port}/c?k=${LINK_KEY}` }).end();
    if (u.pathname === "/c") return res.writeHead(200, { "content-type": "text/plain" }).end(`at c via ${req.method}`);
    if (u.pathname === "/out") return res.writeHead(302, { location: `http://127.0.0.1:${fport}/stolen` }).end();
    if (u.pathname === "/away") return res.writeHead(307, { location: "https://example.invalid/x" }).end();
    if (u.pathname === "/loop") return res.writeHead(302, { location: "/loop" }).end();
    if (u.pathname.startsWith("/download/")) {
      if (u.searchParams.get("k") !== LINK_KEY) return res.writeHead(403).end();
      return res.writeHead(200, { "content-type": "application/zip" }).end(zip);
    }
    res.writeHead(404).end();
  });
});

after(async () => {
  await new Promise((r) => own?.close(r));
  await new Promise((r) => foreign?.close(r));
  rmSync(runDir, { recursive: true, force: true });
});

const targetOf = () => {
  const port = own.address().port;
  return { kind: "local", runId: "selftest-evidence", origin: `http://127.0.0.1:${port}`, runDir, stack: { ports: { hosting: port }, treeDir: null } };
};

function allFiles(dir) {
  return readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);
}

test("every evidence line is redacted with http.mjs's rules: link keys, /content/~k/, cookies, bearer tokens, JWTs, password fields", async () => {
  const ev = new Evidence({ runDir, slug: "redaction", always: true });
  ev.step(`opened /d/doc?k=${LINK_KEY} and /content/~${LINK_KEY}/doc/v1/index.html`);
  ev.httpSink()({ method: "GET", url: `http://127.0.0.1:1/x?k=${LINK_KEY}`, reqHeaders: { cookie: "__session=SESSIONSESSIONSESSION", authorization: `Bearer ${BSK}` } });
  ev.json("attached", { idToken: JWT, note: `token ${BSK}`, password: "hunter2hunter2" });
  ev.text("notes.txt", `cookie __session=SESSIONSESSIONSESSION\njwt ${JWT}`);
  const user = {
    name: "u1",
    closed: true,
    log: {
      console: [{ t: 1, type: "log", text: `fetched /content/~${LINK_KEY}/x and ${JWT}` }],
      errors: [{ t: 2, message: `failed at ?k=${LINK_KEY}` }],
      toasts: [],
      breaches: [],
      external: [],
      websockets: [],
      requests: [{ t: 3, method: "GET", url: `http://127.0.0.1:1/d/doc?k=${LINK_KEY}`, failure: "net::ERR" }],
    },
  };
  await ev.captureUser(user);
  const dir = ev.flush({ error: new Error(`boom at /d/x?k=${LINK_KEY} with ${BSK}`) });
  for (const [file, text] of allFiles(dir)) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${file} holds a secret: ${secret}`);
    for (const line of text.split("\n")) assert.doesNotMatch(line, LEAK_RE, `${file}: ${line}`);
  }
  const requests = readFileSync(join(dir, "requests-u1.jsonl"), "utf8");
  assert.ok(requests.includes("k=‹redacted›"), `the link key is REDACTED, not withheld: ${requests}`);
  assert.ok(readFileSync(join(dir, "steps.md"), "utf8").includes("/content/~‹redacted›/"));
  assert.equal(ev.withheld, 0, "nothing needed withholding: redaction caught every shape");
});

test("fail-closed: a line in which a credential shape survived is never written; a marker and a count are", () => {
  assert.equal(safeLine("ok line"), "ok line");
  assert.equal(safeLine("__session=abcdefghijklmnop"), null);
  const ev = new Evidence({ runDir, slug: "withheld", always: true });
  assert.equal(ev.checked(`raw __session=abcdefghijklmnop`, "step"), `${WITHHELD} (step)`);
  assert.equal(JSON.parse(ev.checked(`{"k":"x?k=abcdefghijk"}`, "json")).withheld, WITHHELD);
  ev.steps.push(ev.checked("- raw re_e2e_0123456789abcdef", "step"));
  const dir = ev.flush();
  const steps = readFileSync(join(dir, "steps.md"), "utf8");
  assert.ok(!steps.includes("re_e2e_0123456789abcdef"));
  assert.match(steps, /3 line\(s\) withheld/);
  assert.equal(redactString(`x?k=${LINK_KEY}`), "x?k=‹redacted›", "evidence's redactString now has http.mjs's URL rules");
});

test("redirect: 'follow' is followed HERE, hop by hop: cookies per hop, 303 becomes GET, each hop traced", async () => {
  const rows = [];
  const http = createHttp(targetOf(), { guard: allow, evidence: (l) => rows.push(JSON.parse(l)) });
  const r = await http.request("POST", "/a", { json: { x: 1 }, redirect: "follow" });
  assert.equal(r.status, 200);
  assert.equal(r.text, "at c via GET", "302 after POST and 303 both became GET");
  assert.deepEqual(r.redirects.map((h) => h.status), [302, 303]);
  assert.equal(new URL(r.url).pathname, "/c");
  assert.equal(hits.own.at(-1).cookie, "hop=one", "the cookie set on hop 1 was sent on hop 3");
  assert.deepEqual(rows.map((x) => [x.method, new URL(x.url).pathname, x.status, x.hop ?? 0]), [["POST", "/a", 302, 0], ["GET", "/b", 303, 1], ["GET", "/c", 200, 2]]);
  assert.ok(rows.every((x) => !LEAK_RE.test(JSON.stringify(x))), "the hop carrying ?k= is traced redacted");
  const manual = await http.get("/a");
  assert.equal(manual.status, 302, "without follow, the 3xx itself is the answer");
  assert.deepEqual(manual.redirects, []);
});

test("NEGATIVE: a redirect to a port or host outside the stack is refused before anything is sent there", async () => {
  const http = createHttp(targetOf(), { guard: allow, evidence: false });
  const before = hits.foreign.length;
  await assert.rejects(http.get("/out", { redirect: "follow" }), (e) => e.code === "E2E_ISOLATION" && /port \d+ is not one of run/.test(e.message));
  await assert.rejects(http.get("/away", { redirect: "follow" }), (e) => e.code === "E2E_ISOLATION" && /not loopback/.test(e.message));
  assert.equal(hits.foreign.length, before, "the foreign server never saw a request");
  await assert.rejects(http.get("/loop", { redirect: "follow", maxRedirects: 3 }), (e) => e.code === "E2E_REDIRECTS");
});

test("downloadVersion goes through http.mjs: the key travels, the trace redacts it, the sink gets a redacted URL", async () => {
  const target = targetOf();
  const rows = [];
  const http = createHttp(target, { guard: allow, evidence: (l) => rows.push(l) });
  const seen = [];
  const got = await downloadVersion({ http, docId: "doc-1", versionId: "v1", k: LINK_KEY, sink: (x) => seen.push(x) });
  assert.deepEqual(got.files.map((f) => f.rel), ["index.html"]);
  assert.equal(hits.own.at(-1).url, `/download/doc-1/v1?k=${LINK_KEY}`, "the server got the real key");
  assert.equal(rows.length, 1, "one traced row");
  assert.ok(!rows[0].includes(LINK_KEY) && seen.length === 1 && !JSON.stringify(seen).includes(LINK_KEY), "nothing written holds the key");
  await assert.rejects(downloadVersion({ http, docId: "doc-1", versionId: "v1" }), (e) => e.status === 403);
  await assert.rejects(downloadVersion({ http, origin: "http://127.0.0.1:1", docId: "d", versionId: "v1" }), /not the target's/);
  const elsewhere = { ...target, stack: { ports: { hosting: 1 } } };
  await assert.rejects(downloadVersion({ target: elsewhere, docId: "d", versionId: "v1", k: LINK_KEY }), (e) => e.code === "E2E_ISOLATION", "a target whose own ports exclude the origin cannot be read");
  const re = await rehashVersion({ http, docId: "doc-1", versionId: "v1", k: LINK_KEY });
  assert.equal(re.fileCount, 1);
});

test("E2E_TRACE is refused on any target but a local one", () => {
  assert.throws(() => new BrowserPool({ target: { kind: "prod", runId: "x" }, trace: true }), (e) => e.code === "E2E_TRACE_REFUSED");
  assert.doesNotThrow(() => new BrowserPool({ target: { kind: "prod", runId: "x" }, trace: false }));
  assert.equal(new BrowserPool({ target: targetOf(), trace: true }).trace, true, "a local stack may trace");
});
