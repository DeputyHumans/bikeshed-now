// SPDX-License-Identifier: Apache-2.0
// Self-test: joinShared grants its joiners a role of the case's choosing, casts and grants accounts that get no browser, and stages the document before anyone opens it (SPEC §6b, §12, §22).

/**
 * A case that decides suggestions in the app (C10b, C10c) needs approvers in
 * the live session, a suggester with no browser, and suggestions already
 * pending when the editors open the document. joinShared({role, extra,
 * notifications, beforeJoin}) does it: the joiners granted `role`, the extras
 * cast with them and granted in the SAME grant request (one POST /access
 * locally; share() per account through the operator script elsewhere), and
 * beforeJoin run after the grants and before any browser is made. These
 * cases drive the real joinShared with stand-ins for the modules it calls
 * (`impl`) and a recording ctx, so the order of everything it does is
 * observed, not read from its source; the old call (no new option) is pinned
 * to its old cast labels, cast options and grant call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { grantEditors, joinAccountsPlan, joinShared } from "../lib/live.mjs";
import { ROLES } from "../lib/grant.mjs";

const LOCAL = Object.freeze({ kind: "local", runId: "2610130000-jrloc", capabilities: new Set(["local"]) });
const PROD = Object.freeze({ kind: "prod", runId: "2610130000-jrprd", capabilities: new Set([]) });

/** grant.mjs EDITING_ROLES, read from its source (it is not exported). */
function editingRoles() {
  const src = readFileSync(fileURLToPath(new URL("../lib/grant.mjs", import.meta.url)), "utf8");
  const m = /^const EDITING_ROLES = new Set\(\[([^\]]*)\]\);$/m.exec(src);
  assert.ok(m, "grant.mjs still declares EDITING_ROLES");
  return JSON.parse(`[${m[1]}]`);
}

/**
 * Stand-ins for every module joinShared calls, recording into `log` in call
 * order. `noMirror` lists the emails whose RTDB mirror reads back missing
 * (S16). Accounts are made from the cast labels, so an email names its label.
 */
function stand(log, { noMirror = [] } = {}) {
  const mirror = (email) => (noMirror.includes(email) ? { presence: false, edit: false, ok: false } : { presence: true, edit: true, ok: true });
  let k = 0;
  return {
    async cast(target, labels, o) {
      log.push({ fn: "cast", labels: [...labels], options: Object.keys(o).sort(), notifications: o.notifications });
      return labels.map((label) => Object.freeze({ role: label, email: `${label}-${(k += 1)}@example.test`, password: "pw", uid: `uid-${label}-${k}` }));
    },
    async openSession(target, account) {
      log.push({ fn: "openSession", email: account.email });
      return { account, uid: account.uid, http: { who: account.email } };
    },
    async publish(http, o) {
      log.push({ fn: "publish", by: http.who, options: { ...o } });
      return { status: 200, docId: "doc-jr", versionId: "v1" };
    },
    async signInMany(users, accounts) {
      log.push({ fn: "signInMany", users: users.map((u) => u.name), emails: accounts.map((a) => a.email) });
    },
    async shareMany(target, o) {
      log.push({ fn: "shareMany", grants: o.grants.map((g) => [g.account.email, g.role]), timeoutMs: o.timeoutMs });
      return { status: 200, mirrors: o.grants.map((g) => mirror(g.account.email)) };
    },
    async share(target, o) {
      log.push({ fn: "share", grant: [o.account.email, o.role], via: o.via });
      await new Promise((r) => setTimeout(r, 5));
      return { status: 200, mirror: mirror(o.account.email) };
    },
  };
}

/** A recording ctx: steps, the users it makes (each records open/enterEdit), and an inconclusive that throws as test.mjs's does. */
function recordingCtx(target, log) {
  const user = (name) => ({
    name,
    async open(docId) {
      log.push({ fn: "open", name, docId });
    },
    async enterEdit() {
      log.push({ fn: "enterEdit", name });
      return { share: "shared" };
    },
    async shareState() {
      return "shared";
    },
  });
  return {
    target,
    steps: [],
    step(s) {
      this.steps.push(s);
    },
    http: (o) => ({ actor: o?.actor }),
    users: {
      async many(n, o) {
        log.push({ fn: "users.many", n, names: [...o.names] });
        return o.names.map(user);
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
const at = (log, fn) => log.findIndex((e) => e.fn === fn);

test("joinAccountsPlan: the old labels and no roles by default; approver joiners; extras cast after them; ungranted extras never granted", () => {
  assert.deepEqual(joinAccountsPlan({ n: 3 }), { labels: ["owner", "editor-p2", "editor-p3"], roles: null, extra: [], cast: {} }, "the old labels exactly, and roles null: the joiners' grant is the old call");
  assert.deepEqual(joinAccountsPlan({ n: 3, role: "approver" }).labels, ["owner", "approver-p2", "approver-p3"]);
  assert.deepEqual(joinAccountsPlan({ n: 3, role: "approver" }).roles, null, "no extra granted: `role` for every joiner");
  const p = joinAccountsPlan({ n: 3, role: "approver", extra: [{ role: "suggester" }, { role: "viewer", name: "reader" }, { role: "link", grant: false }], notifications: false });
  assert.deepEqual(p.labels, ["owner", "approver-p2", "approver-p3", "suggester", "reader", "link"]);
  assert.deepEqual(p.roles, ["approver", "approver", "suggester", "viewer"], "one role per grantee: the joiners, then each GRANTED extra");
  assert.deepEqual(p.extra, [{ name: "suggester", role: "suggester", grant: true }, { name: "reader", role: "viewer", grant: true }, { name: "link", role: "link", grant: false }]);
  assert.deepEqual(p.cast, { notifications: false });
  assert.deepEqual(joinAccountsPlan({ n: 1, extra: [{ role: "suggester" }] }).roles, ["suggester"], "a lone owner and an extra: only the extra is granted");
});

test("joinAccountsPlan refuses, before anything is made: a role that is not one of grant.mjs's four, joiners that cannot edit live while entering, a malformed extra, a bad label or notifications", () => {
  const edit = editingRoles();
  assert.deepEqual(edit, ["editor", "approver"]);
  for (const role of ROLES) {
    if (edit.includes(role)) assert.equal(joinAccountsPlan({ n: 2, role }).labels[1], `${role}-p2`, `${role} edits live`);
    else {
      assert.throws(() => joinAccountsPlan({ n: 2, role }), /cannot enter edit .*pass enter: false/, `${role} joiners cannot enter edit`);
      assert.equal(joinAccountsPlan({ n: 2, role, enter: false }).labels[1], `${role}-p2`, `${role} joiners in reading mode`);
    }
  }
  assert.equal(joinAccountsPlan({ n: 1, role: "viewer" }).labels.length, 1, "no joiner, nothing to refuse");
  const bad = [
    [{ n: 0 }, /n is a whole number/],
    [{ n: 2, role: "owner" }, /role is one of viewer, suggester, editor, approver/],
    [{ n: 2, role: "Editor" }, /role is one of/],
    [{ n: 2, extra: { role: "suggester" } }, /extra is a list/],
    [{ n: 2, extra: [null] }, /extra\[0\] is \{role, grant, name\}/],
    [{ n: 2, extra: [{ role: "suggester", browser: true }] }, /extra\[0\] has browser/],
    [{ n: 2, extra: [{ role: "commenter" }] }, /extra\[0\]\.role is one of/],
    [{ n: 2, extra: [{ role: "suggester", grant: "yes" }] }, /extra\[0\]\.grant is true or false/],
    [{ n: 2, extra: [{ role: "Link Holder", grant: false }] }, /extra\[0\]\.role is a label/],
    [{ n: 2, extra: [{ role: "suggester", name: "the suggester" }] }, /extra\[0\]\.name is a cast label/],
    [{ n: 2, extra: [{ role: "suggester", name: "s".repeat(25) }] }, /extra\[0\]\.name is a cast label/],
    [{ n: 2, notifications: "off" }, /notifications is true or false/],
  ];
  for (const [o, re] of bad) assert.throws(() => joinAccountsPlan(o), (e) => e instanceof TypeError && re.test(e.message), JSON.stringify(o));
});

test("grantEditors roles: one shareMany with each account's own role locally, share() per account with its own role (one after another) elsewhere; a bad list throws before anything", async () => {
  const log = [];
  const g = stand(log);
  const A = [{ email: "a@example.test" }, { email: "b@example.test" }, { email: "c@example.test" }];
  const r = await grantEditors(LOCAL, { owner: {}, doc: "d", accounts: A, roles: ["approver", "approver", "suggester"], impl: g });
  assert.deepEqual(log, [{ fn: "shareMany", grants: [["a@example.test", "approver"], ["b@example.test", "approver"], ["c@example.test", "suggester"]], timeoutMs: 120_000 }], "ONE request, mixed roles");
  assert.deepEqual({ via: r.via, requests: r.requests, missing: r.missing }, { via: "access", requests: 1, missing: [] });
  log.length = 0;
  const p = await grantEditors(PROD, { owner: {}, doc: "d", accounts: A, roles: ["approver", "approver", "suggester"], impl: g });
  assert.deepEqual(log.map((e) => [e.fn, ...e.grant, e.via]), [["share", "a@example.test", "approver", "operator"], ["share", "b@example.test", "approver", "operator"], ["share", "c@example.test", "suggester", "operator"]]);
  assert.equal(p.requests, 3);
  log.length = 0;
  await grantEditors(LOCAL, { owner: {}, doc: "d", accounts: A, role: "approver", roles: null, impl: g });
  assert.deepEqual(log[0].grants.map((x) => x[1]), ["approver", "approver", "approver"], "roles null: `role` for everyone (the old call)");
  log.length = 0;
  for (const roles of [["approver"], "approver", ["approver", "", "x"], [1, 2, 3]]) {
    await assert.rejects(grantEditors(LOCAL, { owner: {}, doc: "d", accounts: A, roles, impl: g }), (e) => e instanceof TypeError && /roles is one role per account \(3\)/.test(e.message), JSON.stringify(roles));
  }
  assert.equal(log.length, 0, "nothing sent for a bad roles list");
});

test("joinShared's old call: the old cast labels and options, ONE shareMany of editors, no staging; the result keeps its keys and gains role, extra and staged", async () => {
  const log = [];
  const ctx = recordingCtx(LOCAL, log);
  const r = await joinShared(ctx, { n: 3, title: "jr old", enter: false, impl: stand(log) });
  assert.deepEqual(log[0], { fn: "cast", labels: ["owner", "editor-p2", "editor-p3"], options: ["http"], notifications: undefined }, "cast exactly as before: the old labels, {http} alone");
  const grants = log.filter((e) => e.fn === "shareMany" || e.fn === "share");
  assert.deepEqual(grants, [{ fn: "shareMany", grants: [[r.accounts[1].email, "editor"], [r.accounts[2].email, "editor"]], timeoutMs: 120_000 }]);
  assert.deepEqual(fns(log), ["cast", "openSession", "publish", "shareMany", "users.many", "signInMany", "open", "open", "open"]);
  assert.deepEqual(Object.keys(r).sort(), ["accounts", "docId", "extra", "grantVia", "joinMs", "names", "owner", "role", "staged", "users"]);
  assert.deepEqual({ docId: r.docId, n: r.accounts.length, users: r.users.map((u) => u.name), grantVia: r.grantVia, role: r.role, extra: r.extra, staged: r.staged }, { docId: "doc-jr", n: 3, users: ["p1", "p2", "p3"], grantVia: "access", role: "editor", extra: [], staged: undefined });
  assert.match(ctx.steps[0], /^cast an owner and 2 editor\(s\); the owner publishes crdt-paragraphs\.html and shares it for editing$/, "the old step's words");
});

test("approvers, a suggester with no browser, email off and a staging hook: one cast, ONE shareMany with mixed roles, the hook after the grant and before any browser", async () => {
  const log = [];
  const ctx = recordingCtx(LOCAL, log);
  let seen = null;
  const r = await joinShared(ctx, {
    n: 3,
    role: "approver",
    extra: [{ role: "suggester" }, { role: "link", grant: false }],
    notifications: false,
    enter: false,
    impl: stand(log),
    beforeJoin: async (s) => {
      seen = s;
      log.push({ fn: "beforeJoin" });
      return { pending: ["ann-1", "ann-2"] };
    },
  });
  assert.deepEqual(log[0], { fn: "cast", labels: ["owner", "approver-p2", "approver-p3", "suggester", "link"], options: ["http", "notifications"], notifications: false }, "ONE cast, joiners first, every account opted out of email");
  assert.equal(log.filter((e) => e.fn === "cast").length, 1);
  const [sm, ...more] = log.filter((e) => e.fn === "shareMany" || e.fn === "share");
  assert.deepEqual(more, [], "ONE grant request for joiners and extras together");
  assert.deepEqual(sm.grants, [[r.accounts[1].email, "approver"], [r.accounts[2].email, "approver"], [r.extra[0].account.email, "suggester"]], "the ungranted extra is not in it");
  assert.ok(at(log, "shareMany") < at(log, "beforeJoin") && at(log, "beforeJoin") < at(log, "users.many"), `the hook runs after the grant and before any browser: ${fns(log).join(" → ")}`);
  assert.deepEqual(Object.keys(seen).sort(), ["accounts", "docId", "extra", "owner", "publish"]);
  assert.equal(seen.docId, "doc-jr");
  assert.equal(seen.owner.account, r.accounts[0], "the owner's session");
  assert.deepEqual(seen.accounts.map((a) => a.role), ["owner", "approver-p2", "approver-p3"], "the joiners' accounts only");
  assert.deepEqual(seen.extra.map((e) => [e.name, e.role, e.grant, e.account.role]), [["suggester", "suggester", true, "suggester"], ["link", "link", false, "link"]]);
  assert.deepEqual(seen.publish, { status: 200, docId: "doc-jr", versionId: "v1" });
  assert.deepEqual(r.staged, { pending: ["ann-1", "ann-2"] });
  assert.equal(r.role, "approver");
  assert.deepEqual(r.users.map((u) => u.name), ["p1", "p2", "p3"], "browsers for the joiners only");
  assert.deepEqual(log.find((e) => e.fn === "signInMany").emails, r.accounts.map((a) => a.email));
  assert.match(ctx.steps[0], /2 approver\(s\) and a suggester, an ungranted link \(no browser\).*shares it \(approver\)/);
});

test("the operator path: share() per grantee with its own role, in order; a suggester's missing mirror does not stop the join, a joiner's ends it INCONCLUSIVE before the hook and any browser", async () => {
  const log = [];
  const okRun = await joinShared(recordingCtx(PROD, log), { n: 2, role: "approver", extra: [{ role: "suggester" }], enter: false, impl: stand(log, { noMirror: ["suggester-3@example.test"] }), beforeJoin: async () => log.push({ fn: "beforeJoin" }) });
  assert.equal(okRun.grantVia, "operator");
  assert.deepEqual(log.filter((e) => e.fn === "share").map((e) => [...e.grant, e.via]), [["approver-p2-2@example.test", "approver", "operator"], ["suggester-3@example.test", "suggester", "operator"]]);
  assert.ok(!log.some((e) => e.fn === "inconclusive"), "an extra's missing mirror is not the live session's precondition");
  assert.ok(at(log, "users.many") > at(log, "beforeJoin"));
  const log2 = [];
  const err = await joinShared(recordingCtx(PROD, log2), { n: 3, role: "approver", extra: [{ role: "suggester" }], enter: false, impl: stand(log2, { noMirror: ["approver-p3-3@example.test", "suggester-4@example.test"] }), beforeJoin: async () => log2.push({ fn: "beforeJoin" }) }).catch((e) => e);
  assert.equal(err?.code, "E2E_INCONCLUSIVE");
  assert.match(err.reason, /the RTDB mirror \(presenceAccess\/editAccess\) of approver-p3-3@example\.test is missing \(suspect S16/, "names the joiner, and only the joiner");
  assert.doesNotMatch(err.reason, /suggester/);
  assert.equal(at(log2, "beforeJoin"), -1, "the hook never ran");
  assert.equal(at(log2, "users.many"), -1, "no browser was made");
});

test("joinShared checks everything before casting anyone; a hook that throws stops it before any browser", async () => {
  const log = [];
  const bad = [
    [{ n: 2, role: "viewer" }, /cannot enter edit/],
    [{ n: 2, extra: [{ role: "nobody" }] }, /extra\[0\]\.role/],
    [{ n: 2, notifications: 0 }, /notifications/],
    [{ n: 2, beforeJoin: "stage" }, /beforeJoin is an async function/],
    [{ n: 2, impl: { cast() {} } }, /impl is \{cast, openSession, publish, signInMany, share, shareMany\}/],
  ];
  for (const [o, re] of bad) {
    await assert.rejects(joinShared(recordingCtx(LOCAL, log), { impl: stand(log), ...o }), (e) => e instanceof TypeError && re.test(e.message), JSON.stringify(Object.keys(o)));
  }
  await assert.rejects(joinShared(recordingCtx(PROD, log), { n: 2, grantVia: "access", impl: stand(log) }), { code: "E2E_LOCAL_ONLY" });
  assert.deepEqual(log, [], "nothing cast, published or granted");
  const thrown = await joinShared(recordingCtx(LOCAL, log), { n: 2, enter: false, impl: stand(log), beforeJoin: async () => { throw new Error("staging failed"); } }).catch((e) => e);
  assert.equal(thrown.message, "staging failed");
  assert.deepEqual(fns(log), ["cast", "openSession", "publish", "shareMany"], "no browser after a failed staging");
});

test("entering with approvers: every joiner enters edit after the staging (seedFirst off here: the seed wait reads the live log)", async () => {
  const log = [];
  const r = await joinShared(recordingCtx(LOCAL, log), { n: 2, role: "approver", seedFirst: false, impl: stand(log), beforeJoin: async () => log.push({ fn: "beforeJoin" }) });
  assert.deepEqual(fns(log), ["cast", "openSession", "publish", "shareMany", "beforeJoin", "users.many", "signInMany", "open", "open", "enterEdit", "enterEdit"]);
  assert.deepEqual(r.users.map((u) => u.name), ["p1", "p2"]);
});
