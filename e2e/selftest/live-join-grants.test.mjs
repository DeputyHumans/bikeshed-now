// SPDX-License-Identifier: Apache-2.0
// Self-test: joinShared grants its editors in one POST /access only on a local stack, and through the operator script one grant at a time anywhere else (SPEC §12, §13, §16).

/**
 * POST /access emails every new member, so grant.mjs shareMany (one POST
 * /access) throws E2E_LOCAL_ONLY on any target but a local stack, and a
 * joinShared that granted through it could never join editors on
 * production. grantEditors picks the path (joinGrantVia): shareMany on a
 * local stack, share() per grant with via "operator" elsewhere, one after
 * another. These cases drive it with recording stand-ins for grant.mjs, then
 * with the real grant.mjs on a production-shaped target that cannot reach
 * anything (a demo- project, which operatorSetAccess refuses for production
 * before it spawns), and pin joinShared to it (joinShared itself needs a
 * stack; the live proof is in lib-changes.md). On the operator path a mirror
 * that reads back missing (suspect S16: scripts/set-access.mjs writes none,
 * proved live) is reported in `missing`, and joinShared ends the case
 * INCONCLUSIVE on it before any browser is made.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { grantEditors, joinGrantVia } from "../lib/live.mjs";
import { shareMany } from "../lib/grant.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const LOCAL = Object.freeze({ kind: "local", runId: "2610130000-grloc", capabilities: new Set(["local"]) });
const PROD = Object.freeze({ kind: "prod", runId: "2610130000-grprd", runDir: tempDir("e2e-grants-"), projectId: "demo-selftest-grants", capabilities: new Set([]) });
const OWNER = Object.freeze({ account: { email: "owner@example.test" }, http: { postJson() { throw new Error("no request may be sent"); } } });
const A2 = Object.freeze({ email: "p2@example.test" });
const A3 = Object.freeze({ email: "p3@example.test" });
const A4 = Object.freeze({ email: "p4@example.test" });

/** Stand-ins for grant.mjs: each call recorded with its options; share() takes `shareMs` to answer, and overlaps are counted. `noMirror` lists the emails whose mirror reads back missing. */
function recordingGrants({ shareMs = 20, noMirror = [] } = {}) {
  const mirror = (email) => (noMirror.includes(email) ? { presence: false, edit: false, expectEdit: true, ok: false } : { presence: true, edit: true, expectEdit: true, ok: true });
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    async share(target, o) {
      calls.push({ fn: "share", target: target.kind, ...o });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, shareMs));
      inFlight -= 1;
      const email = typeof o.account === "string" ? o.account.toLowerCase() : o.account.email;
      return { status: 200, account: email, mirror: mirror(email) };
    },
    async shareMany(target, o) {
      calls.push({ fn: "shareMany", target: target.kind, ...o });
      return { status: 200, principals: o.grants.map((g) => g.account.email), mirrors: o.grants.map((g) => mirror(g.account.email)) };
    },
  };
}

test("joinGrantVia: access on a local stack, operator anywhere else; access off a local stack is E2E_LOCAL_ONLY", () => {
  assert.equal(joinGrantVia(LOCAL), "access", "local: the product's one-request path, unchanged");
  assert.equal(joinGrantVia(PROD), "operator", "NEGATIVE CONTROL: production through POST /access would email every editor (and the guard refuses it)");
  assert.equal(joinGrantVia(LOCAL, "operator"), "operator", "the production path, proved on a local stack");
  assert.equal(joinGrantVia(PROD, "operator"), "operator");
  assert.equal(joinGrantVia(LOCAL, "access"), "access");
  assert.throws(() => joinGrantVia(PROD, "access"), (e) => e.code === "E2E_LOCAL_ONLY" && /local only — "access" is ONE POST \/access, which emails every new member/.test(e.message));
  assert.throws(() => joinGrantVia({}, "access"), { code: "E2E_LOCAL_ONLY" }, "a target that is not local is not local");
  for (const bad of ["Access", "mail", 1, true]) assert.throws(() => joinGrantVia(LOCAL, bad), TypeError);
});

test("local: ONE shareMany with every editor's grant in order, the old call exactly; never share()", async () => {
  const g = recordingGrants();
  const r = await grantEditors(LOCAL, { owner: OWNER, doc: "doc-1", accounts: [A2, A3, A4], role: "editor", timeoutMs: 120_000, impl: g });
  assert.deepEqual(g.calls, [{ fn: "shareMany", target: "local", owner: OWNER, doc: "doc-1", grants: [{ account: A2, role: "editor" }, { account: A3, role: "editor" }, { account: A4, role: "editor" }], timeoutMs: 120_000 }]);
  assert.deepEqual({ via: r.via, requests: r.requests, n: r.results.length }, { via: "access", requests: 1, n: 1 });
  assert.deepEqual(r.results[0].principals, [A2.email, A3.email, A4.email]);
  assert.deepEqual(r.missing, []);
  const gap = await grantEditors(LOCAL, { owner: OWNER, doc: "doc-1", accounts: [A2, A3], impl: recordingGrants({ noMirror: [A3.email] }) });
  assert.deepEqual(gap.missing.map((m) => [m.email, m.mirror.ok]), [[A3.email, false]], "shareMany's mirrors, by place");
});

test("production: share() per editor, in order, via the operator script, one after another; never shareMany", async () => {
  const g = recordingGrants({ shareMs: 30 });
  const r = await grantEditors(PROD, { owner: OWNER, doc: "doc-1", accounts: [A2, A3, A4], role: "editor", timeoutMs: 120_000, impl: g });
  assert.deepEqual(g.calls.map((c) => c.fn), ["share", "share", "share"], "NEGATIVE CONTROL: shareMany on production throws E2E_LOCAL_ONLY, so no editor could join");
  assert.deepEqual(g.calls.map((c) => [c.account.email, c.role, c.via, c.doc, c.timeoutMs, c.owner === OWNER]), [
    [A2.email, "editor", "operator", "doc-1", 120_000, true],
    [A3.email, "editor", "operator", "doc-1", 120_000, true],
    [A4.email, "editor", "operator", "doc-1", 120_000, true],
  ]);
  assert.equal(g.maxInFlight, 1, "NEGATIVE CONTROL: two set-access runs at once each rewrite the grant lists, and one grant can be lost");
  assert.deepEqual({ via: r.via, requests: r.requests, results: r.results.map((x) => x.account), missing: r.missing }, { via: "operator", requests: 3, results: [A2.email, A3.email, A4.email], missing: [] });
  const forced = recordingGrants();
  await grantEditors(LOCAL, { owner: OWNER, doc: "doc-2", accounts: [A2], via: "operator", impl: forced });
  assert.deepEqual(forced.calls.map((c) => [c.fn, c.target, c.via, c.role, c.timeoutMs]), [["share", "local", "operator", "editor", 120_000]], "grantVia operator on a local stack takes the same per-grant path (defaults: editor, 120 s)");
});

test("S16 on the operator path: each editor whose mirror reads back missing is in `missing` (email lower-cased, its mirror), in order", async () => {
  const g = recordingGrants({ noMirror: [A2.email, "p3@example.test"] });
  const r = await grantEditors(PROD, { owner: OWNER, doc: "doc-1", accounts: [A2, "P3@Example.TEST", A4], impl: g });
  assert.deepEqual(r.missing.map((m) => m.email), [A2.email, "p3@example.test"], "NEGATIVE CONTROL: an empty `missing` lets joinShared hand back editors whose every live write is refused");
  assert.deepEqual(r.missing[0].mirror, { presence: false, edit: false, expectEdit: true, ok: false });
  const unread = await grantEditors(PROD, { owner: OWNER, doc: "doc-1", accounts: [A2], impl: { shareMany() {}, share: async () => ({ status: 200, mirror: null }) } });
  assert.deepEqual(unread.missing, [], "a mirror that was not read (verify off, or no 200) is not counted as missing");
});

test("no editors: nothing is sent; a malformed call throws before anything", async () => {
  const g = recordingGrants();
  assert.deepEqual(await grantEditors(PROD, { owner: OWNER, doc: "d", accounts: [], impl: g }), { via: "operator", requests: 0, results: [], missing: [] });
  assert.deepEqual(await grantEditors(LOCAL, { owner: OWNER, doc: "d", accounts: [], impl: g }), { via: "access", requests: 0, results: [], missing: [] });
  await assert.rejects(grantEditors(PROD, { owner: OWNER, doc: "d", accounts: [A2], via: "access", impl: g }), { code: "E2E_LOCAL_ONLY" });
  await assert.rejects(grantEditors(LOCAL, { owner: OWNER, doc: "d", accounts: "p2@example.test", impl: g }), TypeError);
  await assert.rejects(grantEditors(LOCAL, { owner: OWNER, doc: "d", accounts: [A2], impl: { share() {} } }), TypeError);
  assert.equal(g.calls.length, 0);
});

test("the real grant.mjs on a production-shaped target: grantEditors reaches the operator script's checks, never shareMany's E2E_LOCAL_ONLY", async () => {
  const saved = process.env.E2E_OPERATOR_ACCOUNT;
  delete process.env.E2E_OPERATOR_ACCOUNT;
  try {
    // What joinShared did before: shareMany refuses production before sending anything.
    await assert.rejects(shareMany(PROD, { owner: OWNER, doc: "doc-1", grants: [{ account: A2, role: "editor" }] }), { code: "E2E_LOCAL_ONLY" });
    // What it does now: share() per grant through operatorSetAccess, which refuses here (no operator account; a demo- project is no production project) before it spawns anything.
    const err = await grantEditors(PROD, { owner: OWNER, doc: "doc-1", accounts: [A2, A3] }).catch((e) => e);
    assert.ok(err instanceof Error, "it threw (nothing here can grant)");
    assert.notEqual(err.code, "E2E_LOCAL_ONLY", "NEGATIVE CONTROL: the old path's refusal");
    assert.match(err.message, /^set-access needs an operator account/);
    process.env.E2E_OPERATOR_ACCOUNT = "operator@example.test";
    const err2 = await grantEditors(PROD, { owner: OWNER, doc: "doc-1", accounts: [A2] }).catch((e) => e);
    assert.match(err2.message, /^set-access: project demo-selftest-grants does not match a prod target/);
  } finally {
    if (saved === undefined) delete process.env.E2E_OPERATOR_ACCOUNT;
    else process.env.E2E_OPERATOR_ACCOUNT = saved;
  }
});

test("joinShared decides the path before making anything, grants through grantEditors and returns it (structural pin)", () => {
  const src = readFileSync(fileURLToPath(new URL("../lib/live.mjs", import.meta.url)), "utf8");
  const start = src.indexOf("export async function joinShared(");
  assert.ok(start >= 0);
  const fn = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(fn.split("\n")[0], /sharedMs = 90_000, openMs = 90_000, grantVia = null(?:, role = "editor", extra = \[\], notifications = undefined, beforeJoin = null, impl = null(?:, mirror = "stop")?)? \} = \{\}\) \{$/, "grantVia beside the old options (and the roles, extras and staging hook: live-join-roles.test.mjs; the mirror mode: mirror-write.test.mjs)");
  const decided = fn.indexOf("const via = joinGrantVia(ctx.target, grantVia);");
  assert.ok(decided > 0 && decided < fn.indexOf("await cast("), "the path is decided (and a bad grantVia refused) before any account is cast");
  // The joiners (accounts.slice(1)) and any granted extra, in one grantEditors call; with no extra, `roles` is null and `role` "editor": the old call (live-join-roles.test.mjs drives it).
  assert.match(fn, /const grantees = \[\.\.\.accounts\.slice\(1\), \.\.\.extras\.filter\(\(e\) => e\.grant\)\.map\(\(e\) => e\.account\)\];/);
  assert.match(fn, /const granted = await grantEditors\(ctx\.target, \{ owner, doc: docId, accounts: grantees, role, roles: plan\.roles, via, timeoutMs: 120_000, impl: [^}]+\} : null(?:, mirror)? \}\)(?:;|\.catch\(\(err\) => \{)/, "one grantEditors call (its mirror mode passed through: mirror-write.test.mjs drives it)");
  assert.match(fn, /const missing = granted\.missing\.filter\(\(m\) => joiners\.has\(m\.email\)\);/, "the S16 stop is about the joiners, who write the live log");
  const s16 = fn.indexOf('if (via === "operator" && missing.length > 0) {');
  assert.ok(s16 > 0, "NEGATIVE CONTROL: without it, an editor with no mirror (S16) shows Shared and every live write it makes is refused");
  assert.match(fn.slice(s16, s16 + 600), /ctx\.inconclusive\(`the sync precondition did not hold: after scripts\/set-access\.mjs granted \$\{docId\}, the RTDB mirror .*suspect S16/);
  assert.ok(s16 < fn.indexOf("await ctx.users.many("), "INCONCLUSIVE before any browser is made");
  assert.doesNotMatch(fn, /shareMany\(/, "NEGATIVE CONTROL: the old joinShared called shareMany itself, local only");
  assert.match(fn, /await rtdbGetPatient\(ctx\.target, `status\/\$\{docId\}\/y`\)/, "the seed wait reads y through a 503");
  assert.doesNotMatch(fn, /\brtdbGet\(/);
  assert.match(fn, /return \{ docId, owner, accounts, users, names, joinMs: Date\.now\(\) - t0, grantVia: via(?:, role, extra: extras, staged(?:, \.\.\.\(mirror === "stop" \? \{\} : \{ mirrored \}\))?)? \};/, "the old keys, and `mirrored` only beside a mirror mode that writes");
});
