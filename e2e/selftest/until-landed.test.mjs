// SPDX-License-Identifier: Apache-2.0
// Self-test: untilLanded sends again what the stack did not answer, after looking for its effect, and ends INCONCLUSIVE when that keeps happening; publish, publishMcp and setVisibility take it as `patient` (SPEC §12, §17).

/**
 * unanswered and untilLanded are driven with calls made up here (a cut-off
 * 504 cannot be waited for in a self-test: its measured wait is written into
 * the response, as stack-stall.test.mjs does). Then the three patient
 * helpers against a local server that stands in for POST /publish, POST
 * /visibility and POST /mcp: a request it is told to "hang" on is never
 * answered (the client's own deadline is the non-answer), but it does what
 * the function would have done to an in-memory record that the Admin
 * stand-in reads, as a function the proxy gave up on goes on to finish. Last,
 * a generated fixture spec runs through `node --test` with the real
 * reporter: one case whose call never lands ends INCONCLUSIVE, one whose call
 * lands passes.
 */

import { after, before, test } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { createHttp } from "../lib/http.mjs";
import { mcpClient } from "../lib/mcp.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { publish, publishMcp } from "../lib/seed.mjs";
import { openWindows, setVisibility, withWindowScope } from "../lib/grant.mjs";
import { HOSTING_CUTOFF_MS, stackDidNotAnswer, unanswered, untilLanded } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const LEAD = "the stack did not answer, so nothing was measured: ";
const runId = `selftest-landed-${process.pid}`;

/** A response as http.mjs makes one, its wait measured as given. */
const res = (status, ms, path = "/publish") => ({ status, ok: status < 400, ms, url: `http://127.0.0.1:1${path}`, text: "", json: undefined, headers: new Headers() });
const statusError = (status, ms, path = "/publish") => Object.assign(new Error(`POST http://127.0.0.1:1${path}: expected 200, got ${status}: Timed out`), { code: "E2E_STATUS", response: res(status, ms, path) });

/** A ctx with only what untilLanded uses: its steps and its evidence's text files. */
function fakeCtx() {
  const steps = [];
  const texts = [];
  return { steps, texts, step: (t) => steps.push(t), ev: { text: (name, value) => texts.push([name, value]) } };
}

test("unanswered: Hosting's cut-off 504 (thrown or returned, on the result or its response), the client's deadline and a CLI cut are the stack's; every other answer is the product's", () => {
  assert.match(unanswered(statusError(504, 60_005)), /^POST \/publish answered 504 after 60005 ms, Hosting's cut-off/);
  assert.equal(unanswered(statusError(504, 1_200)), null, "a quicker 504 is an answer");
  assert.equal(unanswered(statusError(403, 60_005)), null, "another status at the cut-off is an answer");
  assert.match(unanswered(new Error("timeout after 60000 ms")), /^a request to the stack got no answer: timeout after 60000 ms$/);
  assert.equal(unanswered(new AssertionError({ message: "timeout after 60000 ms" })), null, "never an assertion");
  assert.match(unanswered(res(504, HOSTING_CUTOFF_MS)), /^a request to \/publish answered 504 after 59000 ms/, "a returned response at the cut-off");
  assert.match(unanswered({ status: 504, json: null, response: res(504, 60_010, "/visibility") }), /^a request to \/visibility answered 504 after 60010 ms/, "a seed or grant result, by its response");
  assert.equal(unanswered({ status: 504, response: res(504, 900) }), null);
  assert.equal(unanswered({ status: 200, response: res(200, 70_000) }), null, "a slow 200 is an answer");
  assert.equal(unanswered({ stderr: "error: Upload failed (504).", cut: "the CLI's run took 61000 ms and printed a 504" }), "the CLI's run took 61000 ms and printed a 504");
  assert.equal(unanswered({ stderr: "", cut: null }), null);
  for (const v of [null, undefined, 504, "504", true]) assert.equal(unanswered(v), null);
});

test("untilLanded: an answer is returned at once, a refusal is thrown as it is, and the effect is never looked for", async () => {
  const ctx = fakeCtx();
  let looked = 0;
  const ok = await untilLanded(ctx, "POST /x", async () => ({ status: 200, response: res(200, 70_000) }), () => (looked += 1));
  assert.deepEqual([ok.out.status, ok.landed, ok.attempts, looked, ctx.steps.length], [200, null, 1, 0, 0]);
  const refused = statusError(403, 10);
  await assert.rejects(untilLanded(ctx, "POST /x", async () => { throw refused; }, () => (looked += 1)), (e) => e === refused);
  const quick = statusError(504, 900);
  await assert.rejects(untilLanded(ctx, "POST /x", async () => { throw quick; }, () => (looked += 1)), (e) => e === quick, "NEGATIVE: a quicker 504 is an answer, never sent again");
  assert.equal(looked, 0);
});

test("untilLanded: after a non-answer the effect is looked for BEFORE anything is sent again, and taken when found", async () => {
  const ctx = fakeCtx();
  let sends = 0;
  let reads = 0;
  const failures = [];
  const r = await untilLanded(ctx, "POST /publish d1", async () => {
    sends += 1;
    throw statusError(504, 60_004);
  }, async () => {
    reads += 1;
    return reads >= 3 ? { docId: "d1" } : null;
  }, { lookupMs: 2_000, intervalMs: 20, onFail: (f) => failures.push([f.attempt, f.why]) });
  assert.deepEqual([r.out, r.landed, r.attempts, sends, reads], [null, { docId: "d1" }, 1, 1, 3], "sent once; the third look found it");
  assert.deepEqual(failures.map(([a]) => a), [1]);
  assert.match(failures[0][1], /answered 504 after 60004 ms/);
  assert.match(ctx.steps[0], /^environment: POST \/publish d1: POST \/publish answered 504 after 60004 ms, Hosting's cut-off .*; looking for its effect for up to 2000 ms before it is sent again \(attempt 1 of 3\)$/);
  assert.match(ctx.steps[1], /^environment: POST \/publish d1 had taken effect though the stack never answered it/);
});

test("untilLanded: no effect within lookupMs, so it is sent again; an answer then is returned; effect null resends after the back-off without looking", async () => {
  const ctx = fakeCtx();
  let sends = 0;
  const r = await untilLanded(ctx, "POST /x", async () => {
    sends += 1;
    if (sends === 1) throw new Error("timeout after 300 ms");
    return { status: 200, response: res(200, 5) };
  }, async () => false, { lookupMs: 100, intervalMs: 20 });
  assert.deepEqual([r.out.status, r.landed, r.attempts, sends], [200, null, 2, 2]);
  assert.match(ctx.steps.at(-1), /a request to the stack got no answer: timeout after 300 ms, and no effect within 100 ms; sending it again \(attempt 2 of 3\)$/);

  const idem = fakeCtx();
  let n = 0;
  const t0 = Date.now();
  const s = await untilLanded(idem, "POST /session", async () => (++n === 1 ? res(504, 60_001, "/session") : res(200, 4, "/session")), null, { backoffMs: 150 });
  assert.deepEqual([s.out.status, s.attempts], [200, 2]);
  assert.ok(Date.now() - t0 >= 150, "the back-off passed");
  assert.equal(idem.steps.length, 1, "no look: only the resend's step");
  assert.doesNotMatch(idem.steps[0], /looking for its effect/);
});

test("untilLanded: when it keeps happening the case is INCONCLUSIVE, the last failure its cause and in stack-did-not-answer.txt; stopAt ends it sooner", async () => {
  const ctx = fakeCtx();
  let sends = 0;
  const err = await untilLanded(ctx, "POST /visibility unlisted (d2)", async () => {
    sends += 1;
    throw statusError(504, 60_002, "/visibility");
  }, async () => {
    throw new Error("4 DEADLINE_EXCEEDED: the read itself");
  }, { attempts: 2, lookupMs: 60, intervalMs: 20 }).then(() => null, (e) => e);
  assert.equal(err?.code, "E2E_INCONCLUSIVE");
  assert.equal(sends, 2);
  assert.equal(err.reason, `${LEAD}POST /visibility unlisted (d2) got no answer 2 time(s) (the last: POST /visibility answered 504 after 60002 ms, Hosting's cut-off for a function that has not answered), and it had not taken effect 60 ms after each (the last look: 4 DEADLINE_EXCEEDED: the read itself)`);
  assert.equal(err.cause.code, "E2E_STATUS");
  assert.deepEqual(ctx.texts.map(([n]) => n), ["stack-did-not-answer.txt"]);

  const returned = await untilLanded(fakeCtx(), "POST /y", async () => ({ status: 504, response: res(504, 60_000, "/y") }), null, { attempts: 1 }).then(() => null, (e) => e);
  assert.equal(returned.cause.code, "E2E_STACK_CUTOFF", "a returned cut-off becomes the cause, as a stack cut-off");
  assert.match(returned.reason, /POST \/y got no answer 1 time\(s\) \(the last: a request to \/y answered 504 after 60000 ms/);

  let late = 0;
  const stopped = await untilLanded(fakeCtx(), "POST /z", async () => {
    late += 1;
    throw new Error("timeout after 10 ms");
  }, null, { attempts: 5, backoffMs: 0, stopAt: Date.now() - 1 }).then(() => null, (e) => e);
  assert.equal(late, 1, "nothing is sent past stopAt");
  assert.match(stopped.reason, /got no answer 1 time\(s\) .*; past its stopAt, it was not sent again$/);
});

test("untilLanded: bad arguments throw TypeError before anything is sent", async () => {
  const send = async () => assert.fail("never sent");
  await assert.rejects(untilLanded(null, "x", send, null), /ctx is the case's ctx/);
  await assert.rejects(untilLanded({}, "", send, null), /what names the call/);
  await assert.rejects(untilLanded({}, "x", "send", null), /send is async/);
  await assert.rejects(untilLanded({}, "x", send, "effect"), /effect is async/);
  await assert.rejects(untilLanded({}, "x", send, null, { attempt: 2 }), /unknown option "attempt"/);
  await assert.rejects(untilLanded({}, "x", send, null, { attempts: 0 }), /attempts is how many times/);
  await assert.rejects(untilLanded({}, "x", send, null, { lookupMs: -1 }), /lookupMs is a number of ms/);
  await assert.rejects(untilLanded({}, "x", send, null, { intervalMs: 0 }), /intervalMs is a number of ms above 0/);
  await assert.rejects(untilLanded({}, "x", send, null, { stopAt: "soon" }), /stopAt is a Date.now\(\) time or null/);
  await assert.rejects(untilLanded({}, "x", send, null, { onFail: 1 }), /onFail is/);
});

// --- the patient helpers, against a stand-in server and an in-memory record ------------

/** The records the Admin stand-in reads: Firestore paths and RTDB paths. */
const store = new Map();
const rtdb = new Map();
const admin = { readDoc: async (_t, path) => store.get(path) ?? null, rtdbGet: async (_t, path) => rtdb.get(path) ?? null };
/** How the server treats each docId: "hang" (never answers, but does what the function does), "hang-no-mirror", "hang-stale", "hang-no-projection", or answer at once. */
const mode = new Map();
const seen = [];
let server;
let target;
let runDir;
let tmp;
let stamp = 1000;

/** What POST /publish (and publish_document) does to the record. */
function landDoc(docId, { mirror = true } = {}) {
  store.set(`docs/${docId}`, { docId, title: "Probe", currentVersion: "v1", visibility: "private", updatedAt: (stamp += 1) });
  store.set(`docs/${docId}/versions/v1`, { fileCount: 1, format: "html" });
  if (mirror) rtdb.set(`presenceAccess/${docId}`, { owner: true });
}

/** What POST /visibility does to the record, unless told to leave out a part. */
function landVisibility(docId, visibility, how) {
  const d = { ...(store.get(`docs/${docId}`) ?? {}), visibility, publicEdit: false };
  if (how !== "hang-stale") d.updatedAt = (stamp += 1);
  if (visibility === "unlisted") d.linkToken = "L".repeat(22);
  else delete d.linkToken;
  store.set(`docs/${docId}`, d);
  if (visibility === "public" && how !== "hang-no-projection") store.set(`public/${docId}`, { docId });
  else store.delete(`public/${docId}`);
}

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-landed-"));
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const answer = (status, json) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(json));
      };
      if (u.pathname === "/record") {
        const path = u.searchParams.get("path");
        return answer(200, (path.startsWith("rtdb:") ? rtdb.get(path.slice(5)) : store.get(path)) ?? null);
      }
      if (u.pathname === "/publish") {
        const id = u.searchParams.get("id");
        seen.push(["publish", id]);
        const how = mode.get(id);
        if (how?.startsWith("hang")) {
          landDoc(id, { mirror: how !== "hang-no-mirror" });
          mode.delete(id); // the next request is answered
          return; // never answers
        }
        landDoc(id);
        return answer(200, { docId: id, versionId: "v1", title: "Probe", fileCount: 1, format: "html" });
      }
      if (u.pathname === "/visibility") {
        const body = JSON.parse(raw || "{}");
        seen.push(["visibility", body.docId, body.visibility]);
        const how = mode.get(body.docId);
        landVisibility(body.docId, body.visibility, how);
        if (how?.startsWith("hang")) return;
        return answer(200, { visibility: body.visibility, publicEdit: false, linkToken: body.visibility === "unlisted" ? "L".repeat(22) : null, expiresAt: null });
      }
      if (u.pathname === "/mcp") {
        const msg = JSON.parse(raw || "{}");
        const id = msg.params?.arguments?.id;
        seen.push(["mcp", id]);
        if (mode.get(id) === "hang") {
          landDoc(id);
          mode.delete(id);
          return;
        }
        landDoc(id);
        return answer(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ docId: id, versionId: "v1" }) }] } });
      }
      answer(404, { error: "no" });
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

const client = (actor = "owner") => createHttp(target, { actor, evidence: false, timeoutMs: 400 });
const owner = () => ({ account: { email: "owner@example.com" }, http: client() });
const docRows = (docId) => readLedger(target).filter((r) => r.kind === "doc" && r.docId === docId).map((r) => [r.via, r.versionId]);
const QUICK = { lookupMs: 1_000, intervalMs: 20 };

test("publish {patient}: an unanswered request whose document was made is taken from the record, ledgered at the failure and again with its version; never sent twice", async () => {
  const ctx = fakeCtx();
  const id = "e2e-landed-pub-hang";
  mode.set(id, "hang");
  const r = await publish(client(), { body: "<p>x</p>", id, patient: { ctx, ...QUICK }, admin });
  assert.deepEqual([r.status, r.docId, r.versionId, r.response, r.landed], [null, id, "v1", null, true]);
  assert.deepEqual(r.json, { docId: id, versionId: "v1", title: "Probe", fileCount: 1, format: "html" });
  assert.equal(seen.filter(([k, d]) => k === "publish" && d === id).length, 1, "sent once");
  assert.deepEqual(docRows(id), [["upload", null], ["upload", "v1"]], "ledgered when it went unanswered (it may exist), then with its version");
  assert.ok(ctx.steps.some((s) => /^environment: POST \/publish e2e-landed-pub-hang: a request to the stack got no answer: timeout after 400 ms; looking for its effect/.test(s)), ctx.steps.join("\n"));

  const answered = await publish(client(), { body: "<p>y</p>", id: "e2e-landed-pub-ok", patient: { ctx: fakeCtx() }, admin });
  assert.deepEqual([answered.status, answered.docId, answered.landed], [200, "e2e-landed-pub-ok", false], "an answer is publish's own, plus landed: false");
});

test("NEGATIVE: publish {patient}: a record without its presence mirror (the function stopped before its last write) is not the effect; the request is sent again and its answer taken", async () => {
  const id = "e2e-landed-pub-nomirror";
  mode.set(id, "hang-no-mirror");
  const r = await publish(client(), { body: "<p>z</p>", id, patient: { ctx: fakeCtx(), ...QUICK, lookupMs: 200 }, admin });
  assert.deepEqual([r.status, r.landed], [200, false]);
  assert.equal(seen.filter(([k, d]) => k === "publish" && d === id).length, 2, "sent again");
});

test("publish {patient} and publishMcp {patient}: refused before anything is sent without an id, a ctx, or with an unknown field", async () => {
  const before = seen.length;
  await assert.rejects(publish(client(), { body: "x", id: false, patient: { ctx: {} }, admin }), /patient needs the id the request names/);
  await assert.rejects(publish(client(), { body: "x", patient: { attempts: 2 }, admin }), /patient.ctx is the case's ctx/);
  await assert.rejects(publish(client(), { body: "x", patient: { ctx: {}, lookup: 5 }, admin }), /unknown field "lookup"/);
  await assert.rejects(publish(client(), { body: "x", patient: { ctx: {} }, admin: {} }), /admin is a stand-in \{readDoc, rtdbGet\}/);
  const mcp = mcpClient(target, { actor: "owner-mcp", timeoutMs: 400, evidence: false });
  await assert.rejects(publishMcp(mcp, { title: "t", content: "c", id: false, patient: { ctx: {} }, admin }), /patient needs the id the call names/);
  assert.equal(seen.length, before, "nothing was sent");
});

test("publishMcp {patient}: a publish_document the stack did not answer is taken from the record and ledgered via mcp", async () => {
  const id = "e2e-landed-mcp-hang";
  mode.set(id, "hang");
  const mcp = mcpClient(target, { actor: "owner-mcp", timeoutMs: 400, evidence: false });
  const r = await publishMcp(mcp, { title: "Agent", content: "<p>a</p>", id, patient: { ctx: fakeCtx(), ...QUICK }, admin });
  assert.deepEqual([r.isError, r.docId, r.landed, r.json.versionId], [false, id, true, "v1"]);
  assert.deepEqual(docRows(id), [["mcp", null], ["mcp", "v1"]]);
  const ok = await publishMcp(mcp, { title: "Agent", content: "<p>b</p>", id: "e2e-landed-mcp-ok", patient: { ctx: fakeCtx() }, admin });
  assert.deepEqual([ok.isError, ok.docId, ok.landed], [false, "e2e-landed-mcp-ok", false]);
});

test("setVisibility {patient}: an unanswered request is taken from the record once all of it says so; the window stays registered, or goes once private", async () => {
  await withWindowScope(new Map(), async () => {
    const docId = "e2e-landed-vis";
    store.set(`docs/${docId}`, { docId, visibility: "private", updatedAt: (stamp += 1) });
    mode.set(docId, "hang");
    const ctx = fakeCtx();
    const u = await setVisibility(target, { owner: owner(), doc: docId, visibility: "unlisted", patient: { ctx, ...QUICK }, admin });
    assert.deepEqual([u.status, u.visibility, u.linkToken, u.landed, u.response], [null, "unlisted", "L".repeat(22), true, null]);
    assert.deepEqual(openWindows().map((w) => [w.docId, w.visibility]), [[docId, "unlisted"]], "open: registered, to close");
    assert.equal(seen.filter(([k, d]) => k === "visibility" && d === docId).length, 1, "sent once");

    const p = await setVisibility(target, { owner: owner(), doc: docId, visibility: "private", patient: { ctx, ...QUICK }, admin });
    assert.deepEqual([p.visibility, p.landed], ["private", true]);
    assert.deepEqual(openWindows(), [], "private, from the record: the window is closed");
    mode.delete(docId);
    const a = await setVisibility(target, { owner: owner(), doc: docId, visibility: "public", patient: { ctx }, admin });
    assert.deepEqual([a.status, a.landed], [200, false], "an answer is setVisibility's own");
  });
});

test("NEGATIVE: setVisibility {patient}: a record whose updatedAt did not move, or a public one without its projection, is not this call's effect: INCONCLUSIVE, the window still registered", async () => {
  await withWindowScope(new Map(), async () => {
    const stale = "e2e-landed-vis-stale";
    store.set(`docs/${stale}`, { docId: stale, visibility: "private", updatedAt: (stamp += 1) });
    mode.set(stale, "hang-stale");
    const e1 = await setVisibility(target, { owner: owner(), doc: stale, visibility: "unlisted", patient: { ctx: fakeCtx(), attempts: 1, lookupMs: 150, intervalMs: 20 }, admin }).then(() => null, (e) => e);
    assert.equal(e1?.code, "E2E_INCONCLUSIVE", "the record says unlisted, but not by this call's write");
    assert.match(e1.reason, /POST \/visibility unlisted \(e2e-landed-vis-stale\) got no answer 1 time\(s\)/);

    const bare = "e2e-landed-vis-bare";
    store.set(`docs/${bare}`, { docId: bare, visibility: "private", updatedAt: (stamp += 1) });
    mode.set(bare, "hang-no-projection");
    const e2 = await setVisibility(target, { owner: owner(), doc: bare, visibility: "public", patient: { ctx: fakeCtx(), attempts: 1, lookupMs: 150, intervalMs: 20 }, admin }).then(() => null, (e) => e);
    assert.equal(e2?.code, "E2E_INCONCLUSIVE", "public in the record, but no projection yet");
    assert.deepEqual(openWindows().map((w) => w.docId).sort(), [bare, stale].sort(), "both may be open: both stay registered, to close");
    mode.clear();
  });
});

/** A fixture spec: one case's publish never lands (INCONCLUSIVE), one lands (PASS), one is refused (FAIL). */
const FIXTURE = `// fixture spec, generated by selftest/until-landed.test.mjs
import assert from "node:assert/strict";
import { createHttp } from ${JSON.stringify(lib("http.mjs"))};
import { currentTarget, scenario } from ${JSON.stringify(lib("test.mjs"))};
import { publish } from ${JSON.stringify(lib("seed.mjs"))};
const target = currentTarget();
const probe = createHttp(target, { actor: "probe" });
const read = async (path) => (await probe.get("/record", { query: { path } })).json ?? null;
const admin = { readDoc: (_t, path) => read(path), rtdbGet: (_t, path) => read("rtdb:" + path) };
const http = () => createHttp(target, { actor: "owner", timeoutMs: 400 });
scenario("never lands", {}, async (ctx) => {
  await publish(http(), { body: "x", id: "fx-never", patient: { ctx, attempts: 2, lookupMs: 150, intervalMs: 30 }, admin });
});
scenario("lands", {}, async (ctx) => {
  const r = await publish(http(), { body: "x", id: "fx-lands", patient: { ctx, lookupMs: 2000, intervalMs: 30 }, admin });
  assert.equal(r.landed, true);
});
scenario("answered and refused", {}, async (ctx) => {
  await publish(http(), { body: "x", id: "fx-refused", expect: 201, patient: { ctx }, admin });
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

test("through node --test and the reporter: what never lands is INCONCLUSIVE, with its steps; what lands passes; a refusal still FAILS", async () => {
  mode.set("fx-never", "hang-no-mirror"); // the record without its mirror: never the effect, and never answered…
  const never = setInterval(() => mode.set("fx-never", "hang-no-mirror"), 5); // …however often it is sent
  mode.set("fx-lands", "hang");
  // the server answers fx-refused 200, which `expect: 201` refuses: an answer
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify({ ...target, capabilities: ["local"] }));
  const spec = join(tmp, "landed.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const resultsFile = join(inv.dir, "results-functional.jsonl");
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir, E2E_EVIDENCE: "always" };
  delete env.NODE_TEST_CONTEXT;
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile, reporter: join(E2E_DIR, "lib", "reporter.mjs"), concurrency: 1 }), { cwd: REPO_ROOT, timeout: 90_000, env });
  clearInterval(never);
  mode.clear();
  const results = Object.fromEntries(readFileSync(resultsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.name, r]));
  const never1 = results["never lands"];
  assert.equal(never1?.status, "inconclusive", `${proc.stdout.slice(-800)}\n${proc.stderr.slice(-800)}`);
  assert.match(never1.inconclusive, /^the stack did not answer, so nothing was measured: POST \/publish fx-never got no answer 2 time\(s\) \(the last: a request to the stack got no answer: timeout after 400 ms\), and it had not taken effect 150 ms after each$/);
  assert.equal(seen.filter(([k, d]) => k === "publish" && d === "fx-never").length, 2, "sent twice, then given up");
  assert.equal(results.lands?.status, "pass");
  assert.equal(results["answered and refused"]?.status, "fail", "an answer the case did not expect stands");
  assert.equal(results["answered and refused"].error.code, "E2E_STATUS");
  const steps = readFileSync(join(REPO_ROOT, results["never lands"].evidenceDir, "steps.md"), "utf8");
  assert.match(steps, /environment: POST \/publish fx-never: a request to the stack got no answer: timeout after 400 ms; looking for its effect/);
  assert.equal(stackDidNotAnswer(new Error("timeout after 400 ms")), "a request to the stack got no answer: timeout after 400 ms", "the same words the step uses");
});
