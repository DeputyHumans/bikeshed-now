// SPDX-License-Identifier: Apache-2.0
// Self-test: the installed resend SDK, pointed at the shim, delivers into Mailpit; without the variable it cannot; failures inject per recipient (SPEC §14).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR, E2E_TMP, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { isLoopbackAddress, startShim } from "../lib/mail/shim.mjs";
import { shimControl } from "../lib/mail/shimctl.mjs";
import { scrubEnv } from "../lib/proc.mjs";

const KEY = "re_e2e_selftest0123456789abcdef";
const FUNCTIONS_PKG = join(REPO_ROOT, "functions", "package.json");
const CHILD = join(E2E_DIR, "selftest", "helpers", "resend-child.mjs");

let fake; // a stand-in Mailpit that records /api/v1/send bodies
let shim;
let dir;
const received = [];

before(async () => {
  dir = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-shim-"));
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/v1/send") {
        received.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ID: `fake-${received.length}` }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => fake.listen({ host: "127.0.0.1", port: 0 }, r));
  shim = await startShim({ port: 0, mailpitUrl: `http://127.0.0.1:${fake.address().port}`, logFile: join(dir, "shim.jsonl"), apiKey: KEY });
});

after(async () => {
  await shim?.close();
  await new Promise((r) => fake?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** Run the SDK in a child whose env is built here, so nothing ambient leaks in. */
function sendFromChild({ baseUrl, subject, to = "someone@e2e.bikeshed.invalid" }) {
  const env = { ...scrubEnv(process.env), E2E_SELFTEST_KEY: KEY, E2E_SELFTEST_SUBJECT: subject, E2E_SELFTEST_TO: to };
  delete env.RESEND_BASE_URL; // scrubbed anyway; explicit, because it is the variable under test
  if (baseUrl !== undefined) env.RESEND_BASE_URL = baseUrl;
  return new Promise((resolveChild, rejectChild) => {
    execFile(process.execPath, [CHILD, FUNCTIONS_PKG], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) return rejectChild(new Error(`${err.message}\n${stderr}`));
      resolveChild(JSON.parse(stdout.trim().split("\n").pop()));
    });
  });
}

test("the installed functions/node_modules/resend SDK is what the child loads", async () => {
  const out = await sendFromChild({ baseUrl: shim.url, subject: "resolve check" });
  assert.equal(realpathSync(out.resolved).startsWith(realpathSync(join(REPO_ROOT, "functions", "node_modules", "resend"))), true, out.resolved);
});

test("RESEND_BASE_URL → shim → Mailpit: the payload arrives intact and the SDK sees success", async () => {
  received.length = 0;
  shim.requests.length = 0;
  const subject = `shim self-test ${Date.now()}`;
  const out = await sendFromChild({ baseUrl: shim.url, subject });
  assert.equal(out.result.error, null, JSON.stringify(out.result));
  assert.match(out.result.data.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(out.attempts, [`${shim.url}/emails`]);
  assert.equal(received.length, 1, "Mailpit got exactly one message");
  const m = received[0];
  assert.equal(m.Subject, subject);
  assert.deepEqual(m.To, [{ Email: "someone@e2e.bikeshed.invalid", Name: "" }]);
  assert.deepEqual(m.From, { Email: "noreply@e2e.bikeshed.invalid", Name: "Bikeshed E2E" });
  assert.equal(m.HTML, "<p>self-test <b>html</b></p>");
  assert.equal(m.Text, "self-test text");
  assert.equal(m.Headers["X-E2E-Shim-Id"], out.result.data.id);
  const logged = readFileSync(join(dir, "shim.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  assert.equal(logged.status, 200);
  assert.equal(logged.id, out.result.data.id);
  assert.equal(logged.mailpitId, "fake-1");
  assert.ok(!JSON.stringify(logged).includes(KEY), "the key is never logged");
});

test("NEGATIVE: with RESEND_BASE_URL unset the SDK goes for Resend's real API, never the shim", async () => {
  received.length = 0;
  shim.requests.length = 0;
  const out = await sendFromChild({ baseUrl: undefined, subject: "must not arrive" });
  assert.equal(out.attempts.length, 1);
  assert.equal(new URL(out.attempts[0]).host, "api.resend.com", "the SDK's fallback is the real API — which is why a stack must set the variable");
  assert.notEqual(out.result.error, null, "the guard refused it, so the SDK reports an error");
  assert.equal(shim.requests.length, 0, "the shim was not reached");
  assert.equal(received.length, 0, "nothing reached Mailpit");
});

test("NEGATIVE: Resend-shaped refusals — no Bearer, wrong key, unknown route", async () => {
  const post = (path, headers, body) => fetch(`${shim.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
  const noAuth = await post("/emails", {}, { from: "a@b.invalid", to: "c@d.invalid", subject: "x" });
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json()).name, "missing_api_key");
  const wrong = await post("/emails", { authorization: "Bearer re_wrong" }, { from: "a@b.invalid", to: "c@d.invalid", subject: "x" });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).name, "invalid_api_key");
  const missing = await post("/emails", { authorization: `Bearer ${KEY}` }, { from: "a@b.invalid", subject: "x" });
  assert.equal(missing.status, 422);
  const unknown = await post("/domains", { authorization: `Bearer ${KEY}` });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { statusCode: 404, name: "not_found", message: "The requested endpoint does not exist." });
});

test("fail-next injects one failure the SDK reports as an error, then delivery resumes", async () => {
  received.length = 0;
  const q = await fetch(`${shim.url}/__e2e/fail-next`, { method: "POST", body: JSON.stringify({ status: 500 }) });
  assert.equal(q.status, 200);
  const failed = await sendFromChild({ baseUrl: shim.url, subject: "injected" });
  assert.notEqual(failed.result.error, null);
  assert.equal(failed.result.error.name, "application_error");
  assert.equal(received.length, 0, "an injected failure delivers nothing");
  const ok = await sendFromChild({ baseUrl: shim.url, subject: "after injection" });
  assert.equal(ok.result.error, null);
  assert.equal(received.length, 1);
});

test("fail-recipient: the next sends naming ONE address fail; every other recipient is delivered, on the same shim at the same time", async () => {
  received.length = 0;
  shim.requests.length = 0;
  const ctl = (method, path, body) => fetch(`${shim.url}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const send = (to, extra = {}) => fetch(`${shim.url}/emails`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ from: "a@e2e.bikeshed.invalid", to, subject: "s", text: "t", ...extra }) });
  const queued = await (await ctl("POST", "/__e2e/fail-recipient", { to: "Victim@E2E.invalid", status: 503, count: 2 })).json();
  assert.deepEqual(queued, { to: "victim@e2e.invalid", pending: 2 });
  assert.equal((await (await ctl("GET", "/__e2e/fail-recipient?to=victim@e2e.invalid")).json()).pending, 2);
  const [other, victim, viaCc] = await Promise.all([
    send("bystander@e2e.invalid"),
    send("Name <VICTIM@e2e.invalid>"),
    send("someone@e2e.invalid", { cc: ["victim@e2e.invalid"] }),
  ]);
  assert.equal(other.status, 200, "another recipient is untouched");
  assert.equal(victim.status, 503, "the exact address, whatever its case and display name");
  assert.equal(viaCc.status, 503, "a Cc counts as naming it");
  assert.equal((await send("victim@e2e.invalid")).status, 200, "after `count` failures it is delivered again");
  assert.deepEqual(received.map((m) => m.To[0].Email).sort(), ["bystander@e2e.invalid", "victim@e2e.invalid"]);
  const forVictim = (await (await ctl("GET", "/__e2e/requests?to=VICTIM@e2e.invalid")).json()).requests;
  assert.deepEqual(forVictim.map((r) => [r.status, r.injected ?? false, r.injectedFor ?? null]), [[503, true, "victim@e2e.invalid"], [503, true, "victim@e2e.invalid"], [200, false, null]]);
  await ctl("POST", "/__e2e/fail-recipient", { to: "victim@e2e.invalid", status: 500, count: 5 });
  assert.deepEqual(await (await ctl("DELETE", "/__e2e/fail-recipient?to=victim@e2e.invalid")).json(), { to: "victim@e2e.invalid", dropped: 5 });
  assert.equal((await send("victim@e2e.invalid")).status, 200, "a cleared queue injects nothing");
  assert.equal((await ctl("POST", "/__e2e/fail-recipient", { to: "a@b.invalid, c@d.invalid", status: 500 })).status, 400, "one exact address, not a list");
  assert.equal((await ctl("POST", "/__e2e/fail-recipient", { to: "a@b.invalid", status: 200 })).status, 400);
});

test("a refused send still records its recipients (an email-off check needs to see the product TRIED); health reports the guard and features", async () => {
  shim.requests.length = 0;
  const r = await fetch(`${shim.url}/emails`, { method: "POST", headers: { authorization: "Bearer", "content-type": "application/json" }, body: JSON.stringify({ from: "a@b.invalid", to: "Tried <tried@e2e.invalid>", subject: "x" }) });
  assert.equal(r.status, 401);
  assert.deepEqual(shim.requests.map((x) => [x.status, x.recipients]), [[401, ["tried@e2e.invalid"]]]);
  const health = await (await fetch(`${shim.url}/__e2e/health`)).json();
  assert.equal(health.guard, false, "no egress guard is preloaded in this test process");
  assert.ok(health.features.includes("fail-recipient"));
});

test("the control routes answer loopback peers only, and the shim never binds anything else", async () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["192.0.2.1", "::ffff:192.0.2.1", "10.0.0.2", "", undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
  await assert.rejects(startShim({ host: "0.0.0.0", port: 0, mailpitUrl: "http://127.0.0.1:1" }), /loopback only/);
});

test("shimControl: a spec's client for one recipient, through http.mjs, refusing a stack without the feature", async () => {
  const port = Number(new URL(shim.url).port);
  const target = { kind: "local", runId: "selftest-shimctl", origin: `http://127.0.0.1:${port}`, runDir: dir, capabilities: new Set(["local", "mail-fail-recipient"]), mail: { shimUrl: shim.url }, stack: { ports: { shim: port } } };
  const ctl = shimControl(target, { evidence: false, http: undefined });
  assert.deepEqual(await ctl.failRecipient("Spec@E2E.invalid", { status: 500 }), { to: "spec@e2e.invalid", pending: 1 });
  assert.equal(await ctl.pending("spec@e2e.invalid"), 1);
  assert.deepEqual(await ctl.clear("spec@e2e.invalid"), { to: "spec@e2e.invalid", dropped: 1 });
  assert.deepEqual(await ctl.requests({ to: "nobody@e2e.invalid" }), []);
  await assert.rejects(() => ctl.failRecipient("a@b.invalid, c@d.invalid"), /not one exact address/);
  assert.throws(() => shimControl({ ...target, capabilities: new Set(["local"]) }), (e) => e.code === "E2E_CAPABILITY");
});
