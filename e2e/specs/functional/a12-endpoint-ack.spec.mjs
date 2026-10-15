// SPDX-License-Identifier: Apache-2.0
// Native transaction retries preserve verification limits, reading caps and team invitation results (SPEC §14, §17, §18).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, castUnverified } from "../../lib/accounts.mjs";
import { idToken, openSession } from "../../lib/session.mjs";
import { adminFor, closeAdmin, readDoc } from "../../lib/admin.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark, waitForLog } from "../../lib/logs.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { publish, createTeam } from "../../lib/seed.mjs";
import { setVisibility } from "../../lib/grant.mjs";

const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
const HTTP = { timeoutMs: 90_000 };
const CASE = { tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };
const MAIL_CASE = { ...CASE, needs: [...CASE.needs, "email", "mailpit"], effects: ["email"] };
const hash = (uid, code) => createHash("sha256").update(`${uid}:${code}`).digest("hex");
async function lost(ctx, id, operation, send, inspect) {
  const g = gates(target), gate = "ack-after-commit", key = `${operation}:${id}`, file = logFile(target.runId), since = logMark(file);
  let pending, outcome, answered = false;
  try {
    await g.hold(gate, { key });
    pending = send().then(response => { answered = true; return { response }; }, error => ({ error }));
    const held = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    precondition(!answered, "endpoint ACK: response remains pending after the real commit");
    const durable = await inspect();
    ctx.ev.json(`ack-held-${operation}`, { operation, id, held, durable });
    await g.release(gate, { key });
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (pending) outcome = await pending;
  }
  if (outcome?.error) throw outcome.error;
  const response = outcome.response;
  const { match } = await waitForLog(new RegExp(`E2E_ACK_LOSS ${operation} ${id} ([a-f0-9-]+)`), { file, since });
  await waitForLog(`E2E_ACK_RETRY ${operation} ${id} ${match[1]} callback2`, { file, since });
  ctx.ev.json(`ack-response-${operation}`, { status: response.status, json: response.json, caller: match[1] });
  return response;
}
async function oneMail(box, to, assertion) {
  try { return await box.expectMail({ to, count: 1 }); }
  catch (error) {
    if (error?.code !== "E2E_MAIL" || !Array.isArray(error.seen)) throw error;
    assert.equal(error.seen.length, 1, assertion);
    throw error;
  }
}
async function unverified(ctx, role) {
  const account = await castUnverified(target, role), http = ctx.http({ actor: role });
  const options = { ...HTTP, headers: { authorization: `Bearer ${await idToken(target, account, { http })}` } };
  return { account, http, options };
}
async function ownerSession() {
  const [account] = await cast(target, ["owner"]);
  return openSession(target, account, { ...HTTP, cutoffError: true });
}
scenario("A12.11a a verification reservation survives native acknowledgement loss and mails its current code exactly once", MAIL_CASE, async ctx => {
  const { account, http, options } = await unverified(ctx, "ackverify");
  const response = await lost(ctx, account.uid, "verification-start", () => http.postJson("/verify/start", {}, options), async () => {
    const v = (await readDoc(target, `users/${account.uid}`))?.verification;
    precondition(v?.hash && v.email === account.email && v.attempts === 0, "verification reservation is durable before ACK loss");
    return { email: v.email, attempts: v.attempts, sentAt: v.sentAt };
  });
  assert.equal(response.status, 200, "ACK verification start: its durable reservation returns200");
  const box = mailbox(target), { messages } = await oneMail(box, account.email, "ACK verification start: its reserved code is mailed exactly once");
  const mail = await box.message(messages[0].ID), code = mail.Text?.match(/\b\d{6}\b/)?.[0];
  assert.ok(code, "ACK verification start: the delivered mail contains its code");
  const v = (await readDoc(target, `users/${account.uid}`)).verification;
  assert.equal(v.hash, hash(account.uid, code), "ACK verification start: the mailed code matches the committed challenge");
  const completed = await http.postJson("/verify/complete", { code }, options);
  assert.equal(completed.status, 200, "ACK verification start: its mailed code actually verifies");
});
scenario("A12.11b a wrong verification request spends one guess through native acknowledgement loss including the final slot", CASE, async ctx => {
  for (const attempts of [0, 4]) {
    const { account, http, options } = await unverified(ctx, `ackwrong${attempts}`), ref = adminFor(target).db.doc(`users/${account.uid}`);
    await ref.set({ verification: { hash: hash(account.uid, "123456"), email: account.email, expiresAt: Date.now() + 900_000, sentAt: Date.now(), attempts } }, { merge: true });
    const response = await lost(ctx, account.uid, "verification-complete", () => http.postJson("/verify/complete", { code: "000000" }, options), async () => {
      const v = (await ref.get()).data().verification;
      precondition(v.attempts === attempts + 1, "the first wrong attempt committed once before ACK loss");
      return { attempts: v.attempts };
    });
    assert.equal(response.status, 400, `ACK wrong code ${attempts}: its completed attempt retains the original refusal`);
    assert.equal((await ref.get()).data().verification?.attempts, attempts + 1, `ACK wrong code ${attempts}: one request spends one guess`);
  }
});
scenario("A12.11c a retried wrong code cannot spend a replacement challenge's guess budget", CASE, async ctx => {
  const { account, http, options } = await unverified(ctx, "ackreplace"), ref = adminFor(target).db.doc(`users/${account.uid}`);
  const initial = { hash: hash(account.uid, "123456"), email: account.email, expiresAt: Date.now() + 900_000, sentAt: Date.now(), attempts: 0 };
  const replacement = { ...initial, hash: hash(account.uid, "654321"), sentAt: initial.sentAt + 1 };
  await ref.set({ verification: initial }, { merge: true });
  const response = await lost(ctx, account.uid, "verification-complete", () => http.postJson("/verify/complete", { code: "000000" }, options), async () => {
    precondition((await ref.get()).data().verification.attempts === 1, "the old challenge spent one guess before replacement");
    await ref.update({ verification: replacement });
    return { replaced: true, attempts: 0 };
  });
  assert.equal(response.status, 409, "ACK replacement: the original checked challenge changed");
  assert.deepEqual((await ref.get()).data().verification, replacement, "ACK replacement: the newer challenge retains its guess budget");
});
scenario("A12.11d member and public reading beats consume their five-minute cap once after native acknowledgement loss", CASE, async ctx => {
  for (const member of [false, true]) {
    const owner = await ownerSession(), created = await publish(owner.http, { title: `ACK reading ${member}`, name: "ack-reading", filename: "index.html", body: "<!doctype html><p>Reading acknowledgement</p>", ...HTTP });
    precondition(created.status === 200, "reading ACK setup publishes a concrete document");
    const docId = created.docId, sessionId = `ack-session-${member}`, mode = member ? "member" : "public";
    if (!member) precondition((await setVisibility(target, { owner, doc: docId, visibility: "public", ...HTTP })).status === 200, "reading ACK setup permits anonymous reads");
    const http = member ? owner.http : ctx.http({ actor: "anonymous" });
    const before = await readDoc(target, `docs/${docId}`);
    const response = await lost(ctx, docId, "reading-beat", () => http.postJson("/view", { docId, versionId: "v1", sessionId, ms: 1_200_000 }, HTTP), async () => {
      const v = await readDoc(target, `docs/${docId}/views/${sessionId}`);
      precondition(v?.ms === 300_000, "the first capped beat committed before ACK loss");
      return { ms: v.ms, sessionId };
    });
    assert.equal(response.status, 200, `ACK reading ${mode}: the accepted beat returns200`);
    assert.equal(response.json?.ms, 300_000, `ACK reading ${mode}: one request consumes one cap`);
    const after = await readDoc(target, `docs/${docId}`);
    assert.equal(after.stats.totalMs - (before.stats?.totalMs ?? 0), 300_000, `ACK reading ${mode}: totals count one capped delta`);
    assert.equal(after.stats.views - (before.stats?.views ?? 0), 1, `ACK reading ${mode}: one session adds one view`);
    if (member) assert.equal((await readDoc(target, `docs/${docId}/viewers/${owner.account.uid}`)).totalMs, 300_000, "ACK reading member: viewer totals count one capped delta");
  }
});
async function team(owner, title) {
  const made = await createTeam(owner.http, { name: title, ownerEmail: owner.account.email, ...HTTP });
  precondition(made.status === 200 && made.teamId, "team ACK setup creates a team");
  return made.teamId;
}
scenario("A12.11e an administrator acknowledges self-removal after native transaction acknowledgement loss", MAIL_CASE, async ctx => {
  const owner = await ownerSession(), [account] = await cast(target, ["teamadmin"]), admin = await openSession(target, account, { ...HTTP, cutoffError: true });
  const teamId = await team(owner, "ACK team self-removal");
  precondition((await owner.http.postJson("/team-members", { teamId, add: [account.email], admin: { email: account.email, isAdmin: true } }, HTTP)).status === 200, "team ACK setup grants administrator authority");
  const response = await lost(ctx, teamId, "team-members", () => admin.http.postJson("/team-members", { teamId, remove: [account.email] }, HTTP), async () => {
    const t = await readDoc(target, `teams/${teamId}`);
    precondition(!t.members.includes(account.email) && !t.admins.includes(account.email), "self-removal committed before ACK loss");
    return { members: t.members, admins: t.admins };
  });
  assert.equal(response.status, 200, "ACK team: self-removal acknowledges the completed authorized change");
  const held = await readDoc(target, `teams/${teamId}`);
  assert.deepEqual(held.members, [owner.account.email], "ACK team: self-removal retains only the owner");
  assert.deepEqual(Object.keys(held.transactionReceipts ?? {}), [], "ACK team: completed request clears its temporary receipt");
});
scenario("A12.11f a committed team addition keeps its invitation delta through native acknowledgement loss", MAIL_CASE, async ctx => {
  const owner = await ownerSession(), [account] = await cast(target, ["teaminvitee"]), teamId = await team(owner, "ACK team invitation");
  const response = await lost(ctx, teamId, "team-members", () => owner.http.postJson("/team-members", { teamId, add: [account.email] }, HTTP), async () => {
    const t = await readDoc(target, `teams/${teamId}`);
    precondition(t.members.includes(account.email), "the new team member committed before ACK loss");
    return { members: t.members };
  });
  assert.equal(response.status, 200, "ACK team: the committed addition returns200");
  const box = mailbox(target), { messages } = await oneMail(box, account.email, "ACK team: the winning addition sends exactly one invitation");
  assert.equal(messages.length, 1, "ACK team: the winning addition sends exactly one invitation");
  assert.deepEqual((await readDoc(target, `teams/${teamId}`)).members, [owner.account.email, account.email].sort(), "ACK team: the successful addition retains both members");
});
