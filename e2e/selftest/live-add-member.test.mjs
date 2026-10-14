// SPDX-License-Identifier: Apache-2.0
// Self-test: addMember joins one more person to a document already joined, on its own device, in its own role or none (a link holder opening the link with its key), granted as joinShared grants and left reading (SPEC §6b, §12, §16).

/**
 * joinShared makes every user a desktop context and every joiner a granted
 * editor who enters edit with the rest. C18 needs one of the N on a 400 px
 * phone, C22 an editor who stays reading, C23 an account with no grant that
 * opens the link with `?k=`, and the serial controls people who arrive one
 * after another. addMember(ctx, {owner, docId, name, role, device, k, via,
 * open}) is that one person. These cases drive the real addMember with
 * stand-ins for the modules it calls (`impl`) and a recording ctx, so the
 * order of everything it does is observed, not read from its source: every
 * argument checked before anything is cast, the grant before the browser,
 * the S16 stop on the operator path before the browser, the device to the
 * pool, the key to open(), and nothing granted to a link holder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addMember, joinAccountsPlan } from "../lib/live.mjs";

const LOCAL = Object.freeze({ kind: "local", runId: "2610130000-amloc", capabilities: new Set(["local"]) });
const PROD = Object.freeze({ kind: "prod", runId: "2610130000-amprd", capabilities: new Set([]) });
const PHONE = Object.freeze({ width: 400, height: 800, touch: true });
const KEY = "k3yOfTheLinkHolder_0123456789";
const OWNER = Object.freeze({ account: { email: "owner@example.test" }, http: { who: "owner" } });

/** Stand-ins for accounts.mjs cast and grant.mjs share/shareMany, recording into `log`. `noMirror` lists emails whose mirror reads back missing (S16). */
function stand(log, { noMirror = [] } = {}) {
  const mirror = (email, role) => (noMirror.includes(email) ? { presence: false, edit: false, expectEdit: role === "editor" || role === "approver", ok: false } : { presence: true, edit: role === "editor" || role === "approver", ok: true });
  let k = 0;
  return {
    async cast(target, labels, o) {
      log.push({ fn: "cast", labels: [...labels], options: Object.keys(o).sort(), notifications: o.notifications, actor: o.http?.actor });
      return labels.map((label) => Object.freeze({ role: label, email: `${label}-${(k += 1)}@example.test`, password: `pw-${label}`, uid: `uid-${label}` }));
    },
    async shareMany(target, o) {
      log.push({ fn: "shareMany", grants: o.grants.map((g) => [g.account.email, g.role]), owner: o.owner, timeoutMs: o.timeoutMs });
      return { status: 200, mirrors: o.grants.map((g) => mirror(g.account.email, g.role)) };
    },
    async share(target, o) {
      log.push({ fn: "share", grant: [o.account.email, o.role], via: o.via, timeoutMs: o.timeoutMs });
      return { status: 200, mirror: mirror(o.account.email, o.role) };
    },
  };
}

/** A recording ctx: steps, users made by users.user (each records signInUi and open), and an inconclusive that throws as test.mjs's does. */
function recordingCtx(target, log, { present = [], signIn = null } = {}) {
  const made = [];
  return {
    target,
    steps: [],
    step(s) {
      this.steps.push(s);
    },
    http: (o) => ({ actor: o?.actor }),
    get usersSoFar() {
      return [...present.map((name) => ({ name })), ...made];
    },
    users: {
      async user(o) {
        log.push({ fn: "users.user", options: o });
        const u = {
          name: o.name,
          device: o.device,
          async signInUi(email, password, opts) {
            log.push({ fn: "signInUi", name: o.name, email, password, opts });
            if (signIn) return signIn();
            return { status: "ok", already: false };
          },
          async open(docId, opts) {
            log.push({ fn: "open", name: o.name, docId, opts });
            return { src: `/d/${docId}`, editable: false };
          },
        };
        made.push(u);
        return u;
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

test("a phone editor on a local stack: one cast, ONE POST /access, then the user on its device (consent denied), signed in through the UI and the document opened with its key, left reading", async () => {
  const log = [];
  const ctx = recordingCtx(LOCAL, log, { present: ["p1", "p2", "p3", "p4"] });
  const r = await addMember(ctx, { owner: OWNER, docId: "doc-am", name: "p5", device: PHONE, k: KEY, impl: stand(log) });
  assert.deepEqual(fns(log), ["cast", "shareMany", "users.user", "signInUi", "open"], "cast, grant, and only then the browser");
  assert.deepEqual(log[0], { fn: "cast", labels: ["editor-p5"], options: ["http"], notifications: undefined, actor: "harness" }, "{http} alone, as joinShared casts");
  assert.equal(joinAccountsPlan({ n: 5 }).labels[4], "editor-p5", "the label joinShared would give p5");
  assert.deepEqual(log[1], { fn: "shareMany", grants: [[r.account.email, "editor"]], owner: OWNER, timeoutMs: 120_000 }, "the owner's ONE grant request, as joinShared grants");
  assert.ok(log[2].options.device === PHONE, "the device reaches the pool as given");
  assert.deepEqual(log[2].options, { name: "p5", device: PHONE, consent: "denied" });
  assert.deepEqual({ email: log[3].email, password: log[3].password, opts: log[3].opts }, { email: r.account.email, password: r.account.password, opts: undefined }, "signInUi with the account's own credentials, its default: a status other than ok throws");
  assert.deepEqual(log[4], { fn: "open", name: "p5", docId: "doc-am", opts: { k: KEY, timeout: 90_000 } }, "opened with the link key and joinShared's open timeout");
  assert.deepEqual(Object.keys(r).sort(), ["account", "grantVia", "granted", "opened", "role", "signIn", "user"]);
  assert.deepEqual({ role: r.role, grantVia: r.grantVia, requests: r.granted.requests, missing: r.granted.missing, signIn: r.signIn.status, opened: r.opened }, { role: "editor", grantVia: "access", requests: 1, missing: [], signIn: "ok", opened: { src: "/d/doc-am", editable: false } });
  assert.equal(r.user.name, "p5");
  assert.equal(ctx.steps.length, 1);
  assert.match(ctx.steps[0], /^one more person, p5: an editor, cast as editor-p5, granted editor on doc-am; a 400×800 touch browser signs in through the UI and opens doc-am with its link key, reading$/);
  assert.ok(!ctx.steps.join("\n").includes(KEY), "the link key is never in a step");
  assert.ok(!log.some((e) => e.fn === "enterEdit"), "never enters edit");
});

test("a link holder: role null casts link-<name>, grants nothing on any target, and opens the link with its key; no owner needed", async () => {
  for (const target of [LOCAL, PROD]) {
    const log = [];
    const ctx = recordingCtx(target, log);
    const r = await addMember(ctx, { docId: "doc-am", name: "p4", role: null, k: KEY, impl: stand(log) });
    assert.deepEqual(fns(log), ["cast", "users.user", "signInUi", "open"], `${target.kind}: no grant call at all`);
    assert.deepEqual(log[0].labels, ["link-p4"]);
    assert.deepEqual(log[1].options, { name: "p4", device: null, consent: "denied" }, "the desktop");
    assert.deepEqual(log[3].opts, { k: KEY, timeout: 90_000 });
    assert.deepEqual({ role: r.role, grantVia: r.grantVia, granted: r.granted }, { role: null, grantVia: null, granted: null });
    assert.match(ctx.steps[0], /an account with no grant \(a link holder\), cast as link-p4; a desktop browser signs in through the UI and opens doc-am with its link key, reading$/);
  }
});

test("a reader in another role, its own label, email off, and open: false (signed in, nothing opened)", async () => {
  const log = [];
  const ctx = recordingCtx(LOCAL, log);
  const r = await addMember(ctx, { owner: OWNER, docId: "doc-am", name: "next", role: "viewer", label: "reader", notifications: false, open: false, impl: stand(log) });
  assert.deepEqual(fns(log), ["cast", "shareMany", "users.user", "signInUi"], "no open");
  assert.deepEqual(log[0], { fn: "cast", labels: ["reader"], options: ["http", "notifications"], notifications: false, actor: "harness" });
  assert.deepEqual(log[1].grants, [[r.account.email, "viewer"]]);
  assert.equal(r.opened, null);
  assert.equal(r.role, "viewer");
  assert.match(ctx.steps[0], /a viewer, cast as reader, granted viewer on doc-am; a desktop browser signs in through the UI$/);
});

test("the operator path: one share() through the operator script; a mirror not what the role needs ends the case INCONCLUSIVE (S16) before any browser, whatever the role; the local POST /access path never stops on it", async () => {
  const log = [];
  const ok = await addMember(recordingCtx(PROD, log), { owner: OWNER, docId: "doc-am", name: "p3", device: PHONE, impl: stand(log) });
  assert.deepEqual(log.filter((e) => e.fn === "share" || e.fn === "shareMany"), [{ fn: "share", grant: [ok.account.email, "editor"], via: "operator", timeoutMs: 120_000 }], "share() once, through the operator script, never shareMany");
  assert.equal(ok.grantVia, "operator");
  assert.ok(fns(log).includes("users.user"));

  for (const [target, role, via, mirrorWords] of [[PROD, "editor", null, "presenceAccess/editAccess"], [PROD, "viewer", null, "presenceAccess"], [LOCAL, "approver", "operator", "presenceAccess/editAccess"]]) {
    const l = [];
    const err = await addMember(recordingCtx(target, l), { owner: OWNER, docId: "doc-am", name: "p3", role, via, impl: stand(l, { noMirror: [`${role}-p3-1@example.test`] }) }).catch((e) => e);
    assert.equal(err?.code, "E2E_INCONCLUSIVE", `${target.kind} ${role}: INCONCLUSIVE`);
    assert.match(err.reason, new RegExp(`after scripts/set-access\\.mjs granted doc-am to p3 \\(${role}\\), the RTDB mirror \\(${mirrorWords}\\) of ${role}-p3-1@example\\.test is not what an? ${role} needs, .*suspect S16, recorded in findings\\.jsonl`));
    assert.match(err.reason, role === "viewer" ? /so its presence would be refused$/ : /so its presence and its writes to the live log would be refused$/);
    assert.deepEqual(fns(l), ["cast", "share", "inconclusive"], `${target.kind} ${role}: no browser was made`);
  }

  const local = [];
  const r = await addMember(recordingCtx(LOCAL, local), { owner: OWNER, docId: "doc-am", name: "p3", impl: stand(local, { noMirror: ["editor-p3-1@example.test"] }) });
  assert.deepEqual(fns(local), ["cast", "shareMany", "users.user", "signInUi", "open"], "the local path goes on, as joinShared's does");
  assert.equal(r.granted.missing.length, 1, "and reports the missing mirror in `granted`");
});

test("every argument is checked before anything is cast: TypeError (the device by browser.mjs checkDevice), E2E_LOCAL_ONLY for POST /access off a local stack", async () => {
  const log = [];
  const base = { owner: OWNER, docId: "doc-am", name: "p5" };
  const bad = [
    [{ docId: "" }, /docId is the document's id/],
    [{ name: "" }, /name is the user's name/],
    [{ name: " p5" }, /name is the user's name/],
    [{ name: "p2" }, /p2 already names a user of this case/],
    [{ role: "owner" }, /role is one of viewer, suggester, editor, approver, or null/],
    [{ role: "Editor" }, /role is one of/],
    [{ role: undefined, name: "pJ" }, /cast label "editor-pJ" is not a short lower-case word.*; pass label$/],
    [{ label: "The Reader" }, /cast label "The Reader" is not a short lower-case word.*at most 24: it starts the account's email\)$/],
    [{ label: "r".repeat(25) }, /cast label/],
    [{ k: "" }, /k is the document's link key/],
    [{ k: 5 }, /k is the document's link key/],
    [{ open: "yes" }, /open is true or false/],
    [{ open: false, k: KEY }, /k is the key the document is opened with, and open: false opens nothing/],
    [{ openMs: 0 }, /openMs is a number of ms above 0/],
    [{ timeoutMs: -1 }, /timeoutMs is a number of ms above 0/],
    [{ notifications: "off" }, /notifications is true or false/],
    [{ impl: { cast() {} } }, /impl is \{cast, share, shareMany\}/],
    [{ role: null, via: "operator" }, /via names how a grant is made, and role null grants nothing/],
    [{ owner: null }, /owner \(the owner's session\) is required to grant a role/],
    [{ device: { width: 0, height: 800 } }, /^addMember: device\.width is a whole number of CSS px/],
    [{ device: { width: 400, height: 800, touch: "yes" } }, /^addMember: device\.touch is true/],
    [{ device: { width: 400, height: 800, mobile: true } }, /^addMember: device takes width, height and touch, not "mobile"/],
    [{ device: "phone" }, /^addMember: device is \{width, height, touch\} or null/],
    [{ via: "post" }, /grantVia is "access", "operator" or null/],
  ];
  for (const [o, re] of bad) {
    await assert.rejects(addMember(recordingCtx(LOCAL, log, { present: ["p1", "p2"] }), { impl: stand(log), ...base, ...o }), (e) => e instanceof TypeError && re.test(e.message), JSON.stringify(o));
  }
  await assert.rejects(addMember(recordingCtx(PROD, log), { ...base, via: "access", impl: stand(log) }), { code: "E2E_LOCAL_ONLY" });
  await assert.rejects(addMember({ target: LOCAL, step() {}, http() {} }, { ...base, impl: stand(log) }), (e) => e instanceof TypeError && /ctx is the scenario's/.test(e.message));
  await assert.rejects(addMember(null, base), TypeError);
  assert.deepEqual(log, [], "nothing cast, granted or made");
});

test("a sign-in that throws propagates before the document is opened", async () => {
  const log = [];
  const ctx = recordingCtx(LOCAL, log, { signIn: () => Promise.reject(Object.assign(new Error("p5: POST /session answered 403"), { code: "E2E_REFUSED" })) });
  await assert.rejects(addMember(ctx, { owner: OWNER, docId: "doc-am", name: "p5", impl: stand(log) }), /POST \/session answered 403/);
  assert.deepEqual(fns(log), ["cast", "shareMany", "users.user", "signInUi"], "no open after a failed sign-in");
});

test("the README documents addMember and the exported checkDevice", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  // A boolean, not assert.match: a failing match prints the whole README.
  assert.ok(/addMember\(ctx, \{owner, docId, name, role = "editor"/.test(readme), "README: addMember's signature (Concurrency specs, One more person)");
  assert.ok(/checkDevice\(device, who\)/.test(readme), "README: checkDevice (Users and the browser, A phone or a tablet)");
});
