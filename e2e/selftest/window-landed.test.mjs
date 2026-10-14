// SPDX-License-Identifier: Apache-2.0
// Self-test: a POST /visibility answered 504 leaves its window registered, and a close the stack did not answer is judged by the document's record before the window is called open (SPEC §12, §17).

/**
 * A local server stands in for POST /visibility, answering each document as
 * it is told (a status at once, or never), and for the record: GET /record
 * reads the in-memory documents, projections and RTDB gates that the Admin
 * stand-in reads. First setVisibility's registry after a 504, then
 * closeWindows' look at the record, then a generated fixture spec through
 * `node --test` and the reporter: a case whose close is answered 504 while
 * the function made the document private anyway passes, and its teardown says
 * how it knew.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { createHttp } from "../lib/http.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { closeWindows, openWindows, setVisibility, trackWindow, withVisibility, withWindowScope } from "../lib/grant.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const runId = `selftest-winland-${process.pid}`;

/** docId → how POST /visibility answers an open (unlisted or public) of it: a status, or "hang". */
const opening = new Map();
/** docId → how POST /visibility answers a close (private) of it: a status, or "hang"; at 504 or "hang" the function still does what `lands` says. */
const closing = new Map();
/** docId → what the function does to the record when its close goes unanswered: "private" (all of it), "projection-left", "gate-left", or nothing. */
const lands = new Map();
const store = new Map();
const rtdb = new Map();
const seen = [];
let server;
let target;
let runDir;
let tmp;

function setOpen(docId, visibility = "public", { gate = false } = {}) {
  store.set(`docs/${docId}`, { docId, visibility, publicEdit: gate });
  if (visibility === "public") store.set(`public/${docId}`, { docId });
  if (gate) rtdb.set(`editAccess/${docId}/*`, true);
}

function land(docId, how) {
  if (!how) return;
  store.set(`docs/${docId}`, { docId, visibility: "private", publicEdit: false });
  if (how !== "projection-left") store.delete(`public/${docId}`);
  if (how !== "gate-left") rtdb.delete(`editAccess/${docId}/*`);
}

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-winland-"));
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const answer = (status, json) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(json === undefined ? "" : JSON.stringify(json));
      };
      if (u.pathname === "/record") {
        const path = u.searchParams.get("path");
        return answer(200, (path.startsWith("rtdb:") ? rtdb.get(path.slice(5)) : store.get(path)) ?? null);
      }
      const body = JSON.parse(raw || "{}");
      seen.push({ docId: body.docId, visibility: body.visibility });
      const closes = body.visibility === "private";
      const a = (closes ? closing : opening).get(body.docId);
      if (closes && (a === 504 || a === "hang")) {
        land(body.docId, lands.get(body.docId));
        if (a === "hang") return; // never answers
        return answer(504, { error: "Timed out waiting for function to respond." });
      }
      if (a === "hang") return;
      if (typeof a === "number") return answer(a, a >= 500 ? { error: "x" } : undefined);
      if (body.visibility !== "private") setOpen(body.docId, body.visibility);
      else land(body.docId, "private");
      answer(200, { visibility: body.visibility, publicEdit: false, linkToken: body.visibility === "unlisted" ? "k".repeat(22) : null, expiresAt: null });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = Object.freeze({ kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: new Set(["local"]), stack: { ports: { hosting: port } } });
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(runDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const admin = { readDoc: async (_t, path) => store.get(path) ?? null, rtdbGet: async (_t, path) => rtdb.get(path) ?? null };
const owner = (extra = {}) => ({ account: { email: "owner@example.com" }, http: createHttp(target, { actor: "owner", evidence: false, timeoutMs: 400, ...extra }) });
const sentFor = (docId) => seen.filter((s) => s.docId === docId).map((s) => s.visibility);
const findings = () => (existsSync(join(runDir, "findings.jsonl")) ? readFileSync(join(runDir, "findings.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("setVisibility: a request answered 504 leaves its window registered, as one with no answer does, whether expect refused it or let it through", async () => {
  await withWindowScope(new Map(), async () => {
    opening.set("w-open-504", 504);
    await assert.rejects(setVisibility(target, { owner: owner(), doc: "w-open-504", visibility: "unlisted" }), (e) => e.code === "E2E_STATUS" && e.response.status === 504);
    assert.deepEqual(openWindows().map((w) => w.docId), ["w-open-504"], "the function may still open it: registered, to close");

    opening.set("w-open-504b", 504);
    const r = await setVisibility(target, { owner: owner(), doc: "w-open-504b", visibility: "public", expect: [200, 504] });
    assert.equal(r.status, 504);
    assert.deepEqual(openWindows().map((w) => w.docId).sort(), ["w-open-504", "w-open-504b"]);

    closing.set("w-open-504", 504);
    await assert.rejects(setVisibility(target, { owner: owner(), doc: "w-open-504", visibility: "private" }), (e) => e.code === "E2E_STATUS");
    assert.ok(openWindows().some((w) => w.docId === "w-open-504"), "a close answered 504 may not have closed it: still registered");

    opening.set("w-refused", 403);
    await assert.rejects(setVisibility(target, { owner: owner(), doc: "w-refused", visibility: "public" }), (e) => e.code === "E2E_STATUS");
    assert.ok(!openWindows().some((w) => w.docId === "w-refused"), "NEGATIVE: a refusal opened nothing, so nothing is registered");
    opening.clear();
    closing.clear();
  });
});

test("closeWindows: after a close answered 504, or none at all, the record is read before anything is sent again; private with no projection and no gate is closed, via the record", async () => {
  const scope = new Map();
  const o = owner();
  for (const d of ["c-504", "c-hang", "c-ok"]) {
    setOpen(d, "public", { gate: d === "c-hang" });
    trackWindow(target, { owner: o, doc: d, visibility: "public", scope, admin });
  }
  closing.set("c-504", 504);
  lands.set("c-504", "private");
  closing.set("c-hang", "hang");
  lands.set("c-hang", "private");
  const before = seen.length;
  const out = await closeWindows({ scope, lookupMs: 500, intervalMs: 20 });
  assert.deepEqual(out.closed.map((c) => [c.docId, c.status, c.via]).sort(), [["c-504", 504, "record"], ["c-hang", null, "record"], ["c-ok", 200, "answer"]].sort());
  assert.deepEqual(out.failed, []);
  assert.deepEqual(seen.slice(before).map((s) => s.docId).sort(), ["c-504", "c-hang", "c-ok"].sort(), "each close sent once: the record answered for the two the stack did not");
  assert.equal(scope.size, 0);
  opening.clear();
  closing.clear();
  lands.clear();
});

test("NEGATIVE: closeWindows: a record still public, a projection or an open-edit gate left behind, keeps the window open after a second try, recorded with what the record said (never its token)", async () => {
  const scope = new Map();
  const o = owner();
  for (const [d, how] of [["n-none", null], ["n-projection", "projection-left"], ["n-gate", "gate-left"]]) {
    setOpen(d, "public", { gate: true });
    trackWindow(target, { owner: o, doc: d, visibility: "public", scope, admin });
    closing.set(d, 504);
    lands.set(d, how);
  }
  store.get("docs/n-none").linkToken = "secret-link-token-value-xyz";
  const before = seen.length;
  const out = await closeWindows({ scope, lookupMs: 120, intervalMs: 20 });
  assert.deepEqual(out.closed, []);
  assert.deepEqual(out.failed.map((f) => [f.docId, f.status, f.record]).sort(), [
    ["n-gate", 504, { visibility: "private", projection: false, openEdit: true }],
    ["n-none", 504, { visibility: "public", projection: true, openEdit: true }],
    ["n-projection", 504, { visibility: "private", projection: true, openEdit: false }],
  ].sort());
  assert.match(out.failed.find((f) => f.docId === "n-none").error, /^POST \/visibility private answered 504; its record still said \{"visibility":"public","projection":true,"openEdit":true\} 120 ms later$/);
  assert.equal(seen.slice(before).length, 6, "two tries each: the look did not find it closed");
  assert.deepEqual([...scope.keys()].sort(), ["n-gate", "n-none", "n-projection"], "all still registered");
  const rows = findings().filter((f) => f.kind === "window-open" && f.docId?.startsWith("n-"));
  assert.equal(rows.length, 3);
  assert.ok(!JSON.stringify(rows).includes("secret-link-token"), "the link token never reaches findings");
  opening.clear();
  closing.clear();
  lands.clear();
});

test("NEGATIVE: no look without a way to read the record (no admin-emulator capability, no stand-in), or after an answer that is a refusal or a 503", async () => {
  const scope = new Map();
  const o = owner();
  setOpen("x-nolook", "public");
  trackWindow(target, { owner: o, doc: "x-nolook", visibility: "public", scope });
  closing.set("x-nolook", 504);
  lands.set("x-nolook", "private"); // closed in truth, but nobody may read it
  const t0 = Date.now();
  const out = await closeWindows({ scope, lookupMs: 5_000, intervalMs: 20 });
  assert.ok(Date.now() - t0 < 4_000, "no look was waited for");
  assert.deepEqual(out.failed.map((f) => [f.docId, f.status, f.record]), [["x-nolook", 504, null]]);
  assert.equal(out.failed[0].error, "POST /visibility private answered 504", "the error as before");

  const s2 = new Map();
  for (const [d, a] of [["x-403", 403], ["x-503", 503]]) {
    setOpen(d, "public");
    trackWindow(target, { owner: o, doc: d, visibility: "public", scope: s2, admin });
    closing.set(d, a);
  }
  let reads = 0;
  const counting = { readDoc: async (...a) => (reads += 1, admin.readDoc(...a)), rtdbGet: admin.rtdbGet };
  const out2 = await closeWindows({ scope: s2, lookupMs: 5_000, intervalMs: 20, admin: counting });
  assert.deepEqual(out2.failed.map((f) => [f.docId, f.status]).sort(), [["x-403", 403], ["x-503", 503]]);
  assert.equal(reads, 0, "an answer is judged as it is: no look");
  assert.throws(() => trackWindow(target, { owner: o, doc: "x", visibility: "public", admin: {} }), /admin is a stand-in \{readDoc, rtdbGet\}/);
  await assert.rejects(closeWindows({ scope: new Map(), admin: { readDoc() {} } }), /admin is a stand-in/);
  opening.clear();
  closing.clear();
  lands.clear();
});

test("withVisibility: a close answered 504 that the function finished anyway is judged by the record when the record can be read (fn's value, nothing thrown), and is E2E_WINDOW_OPEN as before when it cannot", async () => {
  await withWindowScope(new Map(), async () => {
    const value = await withVisibility(target, { owner: owner(), doc: "wv-504", visibility: "unlisted" }, async () => {
      closing.set("wv-504", 504);
      lands.set("wv-504", "private");
      return 42;
    });
    // No stand-in on the window and no admin-emulator capability: nothing may read the record, so the close is judged by its 504 alone.
    assert.equal(value, 42);
  }).then(() => assert.fail("the close was not judged by a record nobody may read"), (e) => assert.equal(e.code, "E2E_WINDOW_OPEN"));
  await withWindowScope(new Map(), async () => {
    opening.clear();
    closing.clear();
    const value = await withVisibility(target, { owner: owner(), doc: "wv-504b", visibility: "unlisted" }, async () => {
      trackWindow(target, { owner: owner(), doc: "wv-504b", visibility: "unlisted", admin });
      closing.set("wv-504b", 504);
      lands.set("wv-504b", "private");
      return 43;
    });
    assert.equal(value, 43, "closed by the record: fn's value, nothing thrown");
    assert.deepEqual(openWindows(), []);
  });
  opening.clear();
  closing.clear();
  lands.clear();
});

/** A fixture spec: its close is answered 504 while the function makes it private anyway. */
const FIXTURE = `// fixture spec, generated by selftest/window-landed.test.mjs
import { createHttp } from ${JSON.stringify(lib("http.mjs"))};
import { currentTarget, scenario } from ${JSON.stringify(lib("test.mjs"))};
import { setVisibility } from ${JSON.stringify(lib("grant.mjs"))};
const target = currentTarget();
const probe = createHttp(target, { actor: "probe" });
const read = async (path) => (await probe.get("/record", { query: { path } })).json ?? null;
const admin = { readDoc: (_t, path) => read(path), rtdbGet: (_t, path) => read("rtdb:" + path) };
const owner = { account: { email: "o@example.com" }, http: createHttp(target, { actor: "owner" }) };
scenario("its close is answered 504, but the function closed it", {}, async () => {
  await setVisibility(target, { owner, doc: "fx-close-504", visibility: "public", admin });
});
`;

function runAsync(cmd, args, { env, cwd, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("through node --test and the reporter: a case whose window's close got Hosting's 504 while the function closed it PASSES, and its teardown step says the record showed it", async () => {
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify({ ...target, capabilities: ["local"] }));
  const spec = join(tmp, "winland.spec.mjs");
  writeFileSync(spec, FIXTURE);
  closing.set("fx-close-504", 504); // the close only: the open is answered 200
  lands.set("fx-close-504", "private");
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const resultsFile = join(inv.dir, "results-functional.jsonl");
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir, E2E_EVIDENCE: "always" };
  delete env.NODE_TEST_CONTEXT;
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile, reporter: join(E2E_DIR, "lib", "reporter.mjs"), concurrency: 1 }), { cwd: REPO_ROOT, timeout: 90_000, env });
  opening.clear();
  closing.clear();
  lands.clear();
  const [r] = readFileSync(resultsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(r?.status, "pass", `${JSON.stringify(r?.error)}\n${proc.stdout.slice(-600)}`);
  assert.deepEqual(sentFor("fx-close-504"), ["public", "private"], "one close, answered 504: the record said the rest");
  const steps = readFileSync(join(REPO_ROOT, r.evidenceDir, "steps.md"), "utf8");
  assert.match(steps, /teardown: fx-close-504 is private again \(POST \/visibility 504, but its record then said private, with no public projection and no open-edit gate\)/);
});
