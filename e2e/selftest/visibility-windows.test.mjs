// SPDX-License-Identifier: Apache-2.0
// Self-test: setVisibility opens and closes windows, and scenario() makes every document a case opened private when the case ends, pass, fail or timeout (SPEC §12, §17).

/**
 * A local server stands in for POST /visibility and records what it was
 * sent. The first tests drive grant.mjs directly. The last runs a generated
 * fixture spec through `node --test` with the real reporter, as run.mjs does,
 * and reads both the results and the server's record: a window is closed
 * only if the server was told so.
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
import { VISIBILITIES, closeWindows, openWindows, setVisibility, trackWindow, withWindowScope } from "../lib/grant.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const runId = `selftest-win-${process.pid}`;

/** What the fake server was sent: {owner, docId, visibility, body}. */
const seen = [];
/** docId → how to answer a close (POST private): a status, or "hang". */
const closeAnswer = new Map();
let failNext = 0;
let server;
let target;
let runDir;
let tmp;

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-windows-"));
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/seen")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(seen));
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const owner = req.headers["x-owner"] ?? null;
      seen.push({ owner, docId: body.docId, visibility: body.visibility, body });
      const answer = (status, json) => {
        res.statusCode = status;
        if (json) res.setHeader("content-type", "application/json");
        res.end(json ? JSON.stringify(json) : undefined);
      };
      if (body.visibility === "private" && closeAnswer.has(body.docId)) {
        const a = closeAnswer.get(body.docId);
        if (a === "hang") return; // never answers
        if (typeof a === "number" && a !== 200) return answer(a, a >= 500 ? { error: "unavailable" } : null);
      }
      if (body.visibility === "private" && failNext > 0) {
        failNext -= 1;
        return answer(503, { error: "unavailable" });
      }
      if (body.docId === "doc-refused") return answer(403);
      if (owner === "stranger") return answer(404);
      return answer(200, { visibility: body.visibility, publicEdit: body.publicEdit === true && body.visibility !== "private", linkToken: body.visibility === "unlisted" ? "k".repeat(22) : null, expiresAt: body.expiresAt ?? null });
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

const ownerSession = (name, extra = {}) => ({ account: { email: `${name}@example.com` }, http: createHttp(target, { actor: name, evidence: false, headers: { "x-owner": name }, ...extra }) });
const sentFor = (docId) => seen.filter((s) => s.docId === docId).map((s) => s.visibility);
const findings = () => (existsSync(join(runDir, "findings.jsonl")) ? readFileSync(join(runDir, "findings.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("setVisibility: sends only the keys given, returns the answer's fields, and opens or closes the window", async () => {
  await withWindowScope(new Map(), async () => {
    const o = ownerSession("o1");
    const u = await setVisibility(target, { owner: o, doc: "doc-a", visibility: "unlisted" });
    assert.deepEqual(seen.at(-1).body, { docId: "doc-a", visibility: "unlisted" }, "no expiresAt or publicEdit unless given (S25)");
    assert.deepEqual([u.status, u.visibility, u.linkToken, u.publicEdit, u.expiresAt], [200, "unlisted", "k".repeat(22), false, null]);
    assert.deepEqual(openWindows().map((w) => [w.docId, w.visibility]), [["doc-a", "unlisted"]]);
    const since = openWindows()[0].since;

    await setVisibility(target, { owner: o, doc: { docId: "doc-a" }, visibility: "public", publicEdit: true, expiresAt: null });
    assert.deepEqual(seen.at(-1).body, { docId: "doc-a", visibility: "public", publicEdit: true, expiresAt: null });
    assert.deepEqual(openWindows().map((w) => [w.docId, w.visibility, w.since]), [["doc-a", "public", since]], "one window per document, open since it first opened");

    await setVisibility(target, { owner: o, doc: "doc-a", visibility: "private" });
    assert.deepEqual(openWindows(), [], "made private: the window is closed");
    assert.deepEqual(VISIBILITIES, ["private", "unlisted", "public"]);
    await assert.rejects(setVisibility(target, { owner: o, doc: "doc-a", visibility: "hidden" }), /visibility must be one of/);
    await assert.rejects(setVisibility(target, { doc: "doc-a", visibility: "public" }), /owner's session/);
  });
});

test("NEGATIVE: a refusal leaves the registry as it was; a request with no answer leaves the document open, to close later", async () => {
  await withWindowScope(new Map(), async () => {
    const o = ownerSession("o1");
    await assert.rejects(setVisibility(target, { owner: o, doc: "doc-refused", visibility: "public" }), (e) => e.code === "E2E_STATUS");
    assert.deepEqual(openWindows(), [], "a refused open is no window: the server did not open it");
    const r = await setVisibility(target, { owner: o, doc: "doc-refused", visibility: "public", expect: 403 });
    assert.equal(r.status, 403);
    assert.deepEqual(openWindows(), [], "nor when the refusal was the expected answer");

    await setVisibility(target, { owner: o, doc: "doc-b", visibility: "public" });
    await assert.rejects(setVisibility(target, { owner: ownerSession("stranger"), doc: "doc-b", visibility: "private" }), (e) => e.code === "E2E_STATUS");
    assert.deepEqual(openWindows().map((w) => w.docId), ["doc-b"], "a refused close leaves it open");

    closeAnswer.set("doc-c", "hang");
    await setVisibility(target, { owner: o, doc: "doc-c", visibility: "public" });
    await assert.rejects(setVisibility(target, { owner: o, doc: "doc-c", visibility: "private", timeoutMs: 300 }));
    assert.deepEqual(openWindows().map((w) => w.docId).sort(), ["doc-b", "doc-c"], "a close with no answer leaves it open");
    closeAnswer.delete("doc-c");
    await closeWindows();
  });
});

test("closeWindows: private as each owner; a 404 is gone; a 5xx is tried again; a refusal stays open, is recorded, and nothing throws", async () => {
  const scope = new Map();
  const o = ownerSession("o1");
  await withWindowScope(scope, async () => {
    for (const d of ["doc-d", "doc-gone", "doc-flaky", "doc-locked"]) await setVisibility(target, { owner: o, doc: d, visibility: "public" });
  });
  closeAnswer.set("doc-gone", 404);
  closeAnswer.set("doc-locked", 401);
  failNext = 1;
  const before = seen.length;
  const out = await closeWindows({ scope });
  assert.deepEqual(out.closed.map((c) => [c.docId, c.status]).sort(), [["doc-d", 200], ["doc-flaky", 200], ["doc-gone", 404]].sort());
  assert.deepEqual(out.failed.map((f) => [f.docId, f.visibility, f.status]), [["doc-locked", "public", 401]]);
  assert.match(out.failed[0].error, /answered 401/);
  assert.deepEqual([...scope.keys()], ["doc-locked"], "only the window that would not close stays registered");
  const sent = seen.slice(before);
  assert.ok(sent.every((s) => s.visibility === "private" && s.owner === "o1"), "every close is a POST private as the owner");
  assert.equal(sent.filter((s) => s.docId === "doc-locked").length, 1, "a 401 is not retried");
  assert.equal(sent.length, 5, "four windows, one retry after a 503");
  const f = findings().filter((x) => x.kind === "window-open" && x.docId === "doc-locked");
  assert.equal(f.length, 1, "the window left open is in findings.jsonl");
  assert.equal((await closeWindows({ scope })).failed.length, 1, "still open, and still no throw");
  closeAnswer.clear();
  scope.clear();
});

test("scopes: a window belongs to the scope it was opened in, and trackWindow registers one opened elsewhere", async () => {
  const a = new Map();
  const b = new Map();
  const o = ownerSession("o1");
  await withWindowScope(a, () => setVisibility(target, { owner: o, doc: "doc-in-a", visibility: "public" }));
  await withWindowScope(b, async () => {
    trackWindow(target, { owner: o, doc: "doc-ui", visibility: "unlisted" });
    assert.deepEqual(openWindows().map((w) => w.docId), ["doc-ui"], "b sees only its own");
  });
  assert.deepEqual([...a.keys()], ["doc-in-a"]);
  assert.deepEqual(openWindows(), [], "outside any scope: the process registry, empty");
  assert.throws(() => trackWindow(target, { doc: "x", visibility: "public" }), /owner's session/);
  assert.throws(() => withWindowScope({}, () => {}), /Map/);
  const before = seen.length;
  await closeWindows({ scope: b });
  assert.deepEqual(seen.slice(before).map((s) => [s.docId, s.visibility]), [["doc-ui", "private"]], "closing b never touches a's window");
  await closeWindows({ scope: a });
});

/** A fixture spec: windows opened by cases that pass, fail, time out, or cannot be closed. */
const FIXTURE = `// fixture spec, generated by selftest/visibility-windows.test.mjs
import assert from "node:assert/strict";
import { createHttp } from ${JSON.stringify(lib("http.mjs"))};
import { currentTarget, scenario } from ${JSON.stringify(lib("test.mjs"))};
import { openWindows, setVisibility, trackWindow } from ${JSON.stringify(lib("grant.mjs"))};
const target = currentTarget();
const owner = (name) => ({ account: { email: name + "@example.com" }, http: createHttp(target, { actor: name, headers: { "x-owner": name } }) });
const seenFor = async (docId) => (await createHttp(target, { actor: "probe" }).get("/seen")).json.filter((s) => s.docId === docId).map((s) => s.visibility);
scenario("opens and passes", {}, async () => {
  await setVisibility(target, { owner: owner("o1"), doc: "fx-pass", visibility: "public" });
  assert.equal(openWindows().length, 1);
});
scenario("opens and fails", {}, async () => {
  await setVisibility(target, { owner: owner("o1"), doc: "fx-fail", visibility: "unlisted" });
  throw new Error("boom");
});
scenario("opens a window in the browser's way", {}, async () => {
  trackWindow(target, { owner: owner("o1"), doc: "fx-ui", visibility: "unlisted" });
});
scenario("closes its own window", {}, async () => {
  const o = owner("o1");
  await setVisibility(target, { owner: o, doc: "fx-self", visibility: "public" });
  await setVisibility(target, { owner: o, doc: "fx-self", visibility: "private" });
  assert.equal(openWindows().length, 0);
});
scenario("cannot close its window", {}, async () => {
  await setVisibility(target, { owner: owner("stranger-opener"), doc: "fx-stuck", visibility: "public" });
});
scenario("a known defect whose window cannot close", { defect: "S0" }, async () => {
  await setVisibility(target, { owner: owner("o1"), doc: "fx-stuck-defect", visibility: "public" });
});
scenario("times out holding a window", { timeoutMs: 1500 }, async () => {
  await setVisibility(target, { owner: owner("o1"), doc: "fx-timeout", visibility: "public" });
  await new Promise(() => { setInterval(() => {}, 1000); }); // never settles, and keeps the loop alive
});
scenario("the next case starts with no window and sees the timed-out one closed", {}, async () => {
  assert.deepEqual(openWindows(), []);
  const deadline = Date.now() + 10000;
  while (!(await seenFor("fx-timeout")).includes("private")) {
    if (Date.now() > deadline) throw new Error("fx-timeout was never made private");
    await new Promise((r) => setTimeout(r, 100));
  }
});
`;

function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

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

test("scenario() closes every window its case opened — pass, fail, timeout — and a window that will not close FAILS a passing case", async () => {
  closeAnswer.set("fx-stuck", 403);
  closeAnswer.set("fx-stuck-defect", 403);
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify({ ...target, capabilities: ["local"] }));
  const spec = join(tmp, "windows.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const resultsFile = join(inv.dir, "results-functional.jsonl");
  // ASYNC: the fixture's requests come back to this process's server.
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile, reporter: join(E2E_DIR, "lib", "reporter.mjs"), concurrency: 1 }), {
    cwd: REPO_ROOT,
    timeout: 90_000,
    env: { ...childEnv(), E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir },
  });
  closeAnswer.clear();
  assert.equal(proc.status, 1, `the fixture run fails (some cases fail on purpose) and does not hang: ${proc.stdout.slice(-600)}`);
  const results = Object.fromEntries(readFileSync(resultsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.name, r]));
  const status = (name) => results[name]?.status;

  assert.equal(status("opens and passes"), "pass");
  assert.deepEqual(sentFor("fx-pass"), ["public", "private"], "closed when the case passed");
  assert.equal(status("opens and fails"), "fail");
  assert.equal(results["opens and fails"].error.message, "boom", "the body's own error, not a teardown's");
  assert.deepEqual(sentFor("fx-fail"), ["unlisted", "private"], "closed when the case failed");
  assert.equal(status("opens a window in the browser's way"), "pass");
  assert.deepEqual(sentFor("fx-ui"), ["private"], "a tracked window is closed too");
  assert.equal(status("closes its own window"), "pass");
  assert.deepEqual(sentFor("fx-self"), ["public", "private"], "closed once: the case closed it itself");

  assert.equal(status("cannot close its window"), "fail", "a window left open fails a case whose body passed");
  assert.equal(results["cannot close its window"].error.code, "E2E_WINDOW_OPEN");
  assert.match(results["cannot close its window"].error.message, /window left open: fx-stuck \(public\)/);
  assert.equal(status("a known defect whose window cannot close"), "fail", "not the defect's oracle: a FAIL, never a TODO");
  assert.ok(sentFor("fx-stuck").filter((v) => v === "private").length >= 1);
  assert.ok(findings().some((f) => f.kind === "window-open" && f.docId === "fx-stuck"), "and it is recorded");

  assert.equal(status("times out holding a window"), "fail");
  assert.equal(status("the next case starts with no window and sees the timed-out one closed"), "pass", "the timed-out case's window was closed, by its own teardown");
  assert.deepEqual(sentFor("fx-timeout"), ["public", "private"]);
});
