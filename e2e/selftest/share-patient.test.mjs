// SPDX-License-Identifier: Apache-2.0
// Self-test: share() with `patient` sends a grant the stack did not answer again only when the record does not show it, ledgers and verifies one it does, and pins GRANT_LIST to the product's (SPEC §12, §13, §17).

/**
 * A local server stands in for POST /access, doing to an in-memory record
 * what functions/src/lib/folders.ts persistDocMembership does (the grant
 * lists and `updatedAt` in one write, then the RTDB mirrors) and then
 * answering, or not: per docId it answers at once, never answers (the
 * http client's 400 ms deadline is then the non-answer), answers a quick 504,
 * or does only part of the work. The Admin stand-in reads the same record.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { OUT_DIR, REPO_ROOT } from "../lib/paths.mjs";
import { createHttp } from "../lib/http.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { GRANT_LIST, ROLES, share } from "../lib/grant.mjs";

const runId = `selftest-share-patient-${process.pid}`;

/** A ctx with only what untilLanded uses: its steps and its evidence's text files. */
function fakeCtx() {
  const steps = [];
  const texts = [];
  return { steps, texts, step: (t) => steps.push(t), ev: { text: (name, value) => texts.push([name, value]) } };
}

const OWNER = "owner@example.com";
const store = new Map();
const rtdb = new Map();
const emailKey = (e) => String(e).toLowerCase().split(".").join(",");
const admin = { readDoc: async (_t, path) => store.get(path) ?? null, rtdbGet: async (_t, path) => rtdb.get(path) ?? null, emailKey };
/**
 * docId → how POST /access is treated:
 *   "hang"          does all the work, never answers;
 *   "hang-late"     the record 450 ms in (after the client gave up at 400 ms),
 *                   the mirrors 300 ms after it, never answers;
 *   "hang-nothing"  does nothing, never answers (the function never ran);
 *   "hang-other"    grants someone else instead (another writer moved updatedAt), never answers;
 *   "hang-twice"    adds the role but leaves the old one, never answers;
 *   504             does nothing, answers a quick 504;
 *   anything else   does all the work, answers 200.
 * A "hang…" mode is used once: the next request is answered.
 */
const mode = new Map();
const seen = [];
let stamp = 1000;
let server;
let target;
let runDir;

function record(docId) {
  return store.get(`docs/${docId}`) ?? { docId, ownerEmail: OWNER, viewers: [], suggesters: [], editors: [], approvers: [], members: [OWNER], updatedAt: stamp };
}

/** POST /access's write: each principal into its role's list and out of the others; `keepOld` leaves it where it was too. */
function land(docId, add, { mirror = true, keepOld = false } = {}) {
  const d = { ...record(docId) };
  for (const r of ROLES) d[GRANT_LIST[r]] = [...(d[GRANT_LIST[r]] ?? [])];
  for (const { principal, role } of add) {
    if (!keepOld) for (const r of ROLES) d[GRANT_LIST[r]] = d[GRANT_LIST[r]].filter((p) => p !== principal);
    if (!d[GRANT_LIST[role]].includes(principal)) d[GRANT_LIST[role]].push(principal);
  }
  d.members = [OWNER, ...new Set(ROLES.flatMap((r) => d[GRANT_LIST[r]]))];
  d.updatedAt = (stamp += 1);
  store.set(`docs/${docId}`, d);
  const mirrors = () => {
    for (const { principal, role } of add) {
      if (principal.startsWith("team:")) continue;
      rtdb.set(`presenceAccess/${docId}/${emailKey(principal)}`, true);
      if (role === "editor" || role === "approver") rtdb.set(`editAccess/${docId}/${emailKey(principal)}`, true);
    }
  };
  if (mirror === true) mirrors();
  else if (typeof mirror === "number") setTimeout(mirrors, mirror);
  return d;
}

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const answer = (status, json) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(json));
      };
      const body = JSON.parse(raw || "{}");
      const add = (body.add ?? []).map((a) => ({ principal: a.principal ?? a.email, role: a.role }));
      seen.push([body.docId, ...add.map((a) => `${a.principal}=${a.role}`)]);
      const how = mode.get(body.docId);
      if (typeof how === "string" && how.startsWith("hang")) {
        mode.delete(body.docId);
        if (how === "hang") land(body.docId, add);
        else if (how === "hang-late") setTimeout(() => land(body.docId, add, { mirror: 300 }), 450);
        else if (how === "hang-other") land(body.docId, [{ principal: "someone-else@example.com", role: "viewer" }]);
        else if (how === "hang-twice") land(body.docId, add, { keepOld: true });
        return; // never answers
      }
      if (how === 504) return answer(504, { error: "Timed out waiting for function to respond." });
      const d = land(body.docId, add);
      answer(200, { viewers: d.viewers, suggesters: d.suggesters, editors: d.editors, approvers: d.approvers, members: d.members });
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
});

const owner = () => ({ account: { email: OWNER }, http: createHttp(target, { actor: "owner", evidence: false, timeoutMs: 400 }) });
const QUICK = { lookupMs: 1_000, intervalMs: 20 };
const grantRows = (docId) => readLedger(target).filter((r) => r.kind === "grant" && r.docId === docId).map((r) => [r.email, r.role, r.via]);
const sentFor = (docId) => seen.filter(([d]) => d === docId).map(([, ...a]) => a.join(" "));
const findings = (docId) => (existsSync(join(runDir, "findings.jsonl")) ? readFileSync(join(runDir, "findings.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.docId === docId) : []);

test("share {patient}: a grant the stack never answered is taken from the record (its role, and no other, after updatedAt moved), ledgered and verified once, and never sent twice", async () => {
  const docId = "sp-hang";
  mode.set(docId, "hang");
  const ctx = fakeCtx();
  const r = await share(target, { owner: owner(), doc: docId, account: "Suggester-1@Example.com", role: "suggester", patient: { ctx, ...QUICK }, admin });
  assert.deepEqual([r.status, r.json, r.response, r.landed], [null, null, null, true]);
  assert.deepEqual(r.members, [OWNER, "suggester-1@example.com"], "the record's members");
  assert.deepEqual(r.mirror, { presence: true, edit: false, expectEdit: false, ok: true });
  assert.deepEqual(sentFor(docId), ["suggester-1@example.com=suggester"], "sent once, lower-cased as share() always sends it");
  assert.deepEqual(grantRows(docId), [["suggester-1@example.com", "suggester", "access"]], "ledgered as an answered grant is");
  assert.ok(ctx.steps.some((s) => /^environment: POST \/access suggester suggester-1@example\.com \(sp-hang\): a request to the stack got no answer: timeout after 400 ms; looking for its effect/.test(s)), ctx.steps.join("\n"));
  assert.ok(ctx.steps.some((s) => /had taken effect though the stack never answered it/.test(s)));
  assert.deepEqual(findings(docId), []);
});

test("share {patient}: an answer is share()'s own, with its response and landed: false; the record is never read for it", async () => {
  const docId = "sp-ok";
  let reads = 0;
  const counting = { ...admin, readDoc: async (t, p) => ((reads += 1), admin.readDoc(t, p)) };
  const r = await share(target, { owner: owner(), doc: docId, account: "editor-1@example.com", role: "editor", patient: { ctx: fakeCtx() }, admin: counting });
  assert.deepEqual([r.status, r.landed, r.response?.status], [200, false, 200]);
  assert.deepEqual(r.mirror, { presence: true, edit: true, expectEdit: true, ok: true });
  assert.equal(reads, 1, "one read, for updatedAt before the request; no look");
  assert.deepEqual(grantRows(docId), [["editor-1@example.com", "editor", "access"]]);

  const plain = await share(target, { owner: owner(), doc: docId, account: "viewer-1@example.com", admin });
  assert.equal(plain.response.status, 200, "without patient too, the answer is on `response`");
  assert.deepEqual(plain.json.viewers, ["viewer-1@example.com"]);
  assert.ok(!("landed" in plain), "and without patient, no `landed`: the shape as before, plus response");
});

test("share {patient}: a grant whose record lands before its mirrors waits for them, so no false S16 finding is recorded; a team's principal keeps its case", async () => {
  const docId = "sp-late";
  mode.set(docId, "hang-late");
  const late = { found: null, at: null };
  const watching = {
    ...admin,
    readDoc: async (t, p) => {
      const d = await admin.readDoc(t, p);
      if (p === `docs/${docId}` && d?.approvers?.includes("approver-1@example.com")) late.found ??= Date.now();
      return d;
    },
    rtdbGet: async (t, p) => {
      const v = await admin.rtdbGet(t, p);
      if (p.startsWith(`editAccess/${docId}/`) && v === true) late.at ??= Date.now();
      return v;
    },
  };
  const r = await share(target, { owner: owner(), doc: docId, account: "approver-1@example.com", role: "approver", patient: { ctx: fakeCtx(), ...QUICK }, admin: watching });
  assert.equal(r.landed, true);
  assert.deepEqual(r.mirror, { presence: true, edit: true, expectEdit: true, ok: true }, "read again until the function's next write was there");
  assert.ok(late.at - late.found >= 200, `the mirror came ${late.at - late.found} ms after the record was found: the wait was exercised`);
  assert.deepEqual(findings(docId), []);

  const teamDoc = "sp-team";
  mode.set(teamDoc, "hang");
  const t = await share(target, { owner: owner(), doc: teamDoc, team: "TeAm_9x-Q", role: "viewer", verify: false, patient: { ctx: fakeCtx(), ...QUICK }, admin });
  assert.deepEqual([t.landed, t.mirror], [true, null]);
  assert.deepEqual(sentFor(teamDoc), ["team:TeAm_9x-Q=viewer"]);
  assert.deepEqual(grantRows(teamDoc), [["team:TeAm_9x-Q", "viewer", "access"]]);
});

test("share {patient}: no effect, so it is sent again, and that answer is taken: one ledger row, from the answer", async () => {
  const docId = "sp-again";
  mode.set(docId, "hang-nothing");
  const ctx = fakeCtx();
  const r = await share(target, { owner: owner(), doc: docId, account: "viewer-2@example.com", patient: { ctx, lookupMs: 150, intervalMs: 20 }, admin });
  assert.deepEqual([r.status, r.landed], [200, false]);
  assert.deepEqual(sentFor(docId), ["viewer-2@example.com=viewer", "viewer-2@example.com=viewer"]);
  assert.deepEqual(grantRows(docId), [["viewer-2@example.com", "viewer", "access"]]);
  assert.ok(ctx.steps.some((s) => /and no effect within 150 ms; sending it again \(attempt 2 of 3\)/.test(s)), ctx.steps.join("\n"));
});

test("NEGATIVE: share {patient}: a grant already held before the call (updatedAt never moved), the role left beside another, or someone else's write is not this call's effect: INCONCLUSIVE, nothing ledgered", async () => {
  const held = "sp-held";
  land(held, [{ principal: "editor-2@example.com", role: "editor" }]);
  mode.set(held, "hang-nothing");
  const e1 = await share(target, { owner: owner(), doc: held, account: "editor-2@example.com", role: "editor", patient: { ctx: fakeCtx(), attempts: 1, lookupMs: 150, intervalMs: 20 }, admin }).then(() => null, (e) => e);
  assert.equal(e1?.code, "E2E_INCONCLUSIVE", "the record shows the role, but not by this call's write");
  assert.match(e1.reason, /^the stack did not answer, so nothing was measured: POST \/access editor editor-2@example\.com \(sp-held\) got no answer 1 time\(s\) \(the last: a request to the stack got no answer: timeout after 400 ms\), and it had not taken effect 150 ms after it$/);

  const twice = "sp-twice";
  land(twice, [{ principal: "viewer-3@example.com", role: "viewer" }]);
  mode.set(twice, "hang-twice");
  const e2 = await share(target, { owner: owner(), doc: twice, account: "viewer-3@example.com", role: "editor", patient: { ctx: fakeCtx(), attempts: 1, lookupMs: 150, intervalMs: 20 }, admin }).then(() => null, (e) => e);
  assert.equal(e2?.code, "E2E_INCONCLUSIVE", "editor, but still a viewer too: a principal holds one role");

  const other = "sp-other";
  land(other, [{ principal: "viewer-4@example.com", role: "viewer" }]);
  mode.set(other, "hang-other");
  const e3 = await share(target, { owner: owner(), doc: other, account: "viewer-4@example.com", role: "suggester", patient: { ctx: fakeCtx(), attempts: 1, lookupMs: 150, intervalMs: 20 }, admin }).then(() => null, (e) => e);
  assert.equal(e3?.code, "E2E_INCONCLUSIVE", "updatedAt moved, by another grant: still a viewer");
  for (const d of [held, twice, other]) assert.deepEqual(grantRows(d), [], d);
});

test("NEGATIVE: share {patient}: an answer is never sent again and its effect never looked for: a quick 504 is the product's, thrown as it is", async () => {
  const docId = "sp-504";
  mode.set(docId, 504);
  const ctx = fakeCtx();
  const err = await share(target, { owner: owner(), doc: docId, account: "viewer-5@example.com", patient: { ctx, ...QUICK }, admin }).then(() => null, (e) => e);
  assert.equal(err?.code, "E2E_STATUS");
  assert.equal(err.response.status, 504);
  assert.deepEqual(sentFor(docId), ["viewer-5@example.com=viewer"]);
  assert.deepEqual(ctx.steps, []);
  assert.deepEqual(grantRows(docId), []);
});

test("share {patient}: refused before anything is sent: a malformed patient or admin, or a target whose record cannot be read", async () => {
  const before = seen.length;
  await assert.rejects(share(target, { owner: owner(), doc: "sp-x", account: "a@example.com", patient: { attempts: 2 }, admin }), /share: patient\.ctx is the case's ctx/);
  await assert.rejects(share(target, { owner: owner(), doc: "sp-x", account: "a@example.com", patient: { ctx: {}, lookup: 5 }, admin }), /share: patient has unknown field "lookup"/);
  await assert.rejects(share(target, { owner: owner(), doc: "sp-x", account: "a@example.com", patient: "yes", admin }), /share: patient is \{ctx, attempts, lookupMs, intervalMs, stopAt\}/);
  await assert.rejects(share(target, { owner: owner(), doc: "sp-x", account: "a@example.com", patient: { ctx: {} }, admin: {} }), /share: admin is a stand-in \{readDoc, rtdbGet\}/);
  await assert.rejects(share(target, { owner: owner(), doc: "sp-x", account: "a@example.com", patient: { ctx: {} } }), /share: patient reads the grant back from the document's record through the Admin SDK, which this target does not allow \(no admin-emulator capability\)/);
  assert.equal(seen.length, before, "nothing was sent");
});

test("GRANT_LIST is functions/src/lib/access.ts's, role for role", () => {
  const src = readFileSync(join(REPO_ROOT, "functions", "src", "lib", "access.ts"), "utf8");
  const m = /export const GRANT_LIST = \{([^}]*)\}/.exec(src);
  assert.ok(m, "access.ts still declares GRANT_LIST as an object literal");
  const product = Object.fromEntries([...m[1].matchAll(/(\w+):\s*"(\w+)"/g)].map(([, k, v]) => [k, v]));
  assert.deepEqual(product, { ...GRANT_LIST });
  assert.deepEqual(Object.keys(GRANT_LIST), [...ROLES]);
  assert.ok(Object.isFrozen(GRANT_LIST));
});
