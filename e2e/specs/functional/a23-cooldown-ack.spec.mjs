// SPDX-License-Identifier: Apache-2.0
// Native cooldown retries deliver the winning notice once and recheck a reader's expiry at the retry clock (SPEC §14, §22).
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish } from "../../lib/seed.mjs";
import { shareMany, setVisibility } from "../../lib/grant.mjs";
import { adminFor, closeAdmin, readDoc } from "../../lib/admin.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { anchorIn, webThread, webReply } from "../../lib/web.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark, waitForLog } from "../../lib/logs.mjs";
const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
const CASE = { tiers: ["local"], needs: ["admin-emulator", "email", "mailpit", "logs", "gates", "patch:amplify-native-ack-loss"], effects: ["email:comment", "email:suggestion", "email:POST /access"], timeoutMs: 300_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };
const phrase = "A unique cooldown phrase", anchor = anchorIn(phrase, "phrase", phrase);
async function setup(ctx, roles) {
  const accounts = await cast(target, roles), sessions = await Promise.all(accounts.map(a => openSession(target, a, { timeoutMs: 90_000, cutoffError: true })));
  const [owner, author] = sessions, title = `Cooldown acknowledgement ${owner.uid}`;
  const created = await publish(owner.http, { title, name: "cooldown-ack", filename: "index.html", body: `<!doctype html><p id="phrase">${phrase}</p>`, timeoutMs: 90_000 });
  precondition(created.status === 200, "cooldown ACK fixture has a current document");
  const docId = created.docId;
  await shareMany(target, { owner, doc: docId, grants: sessions.slice(1).map(account => ({ account: account.account, role: "editor" })), verify: false, timeoutMs: 90_000 });
  const fs = who => clientFirestore(target, { idToken: who.idToken, http: ctx.http({ actor: `${who.account.role}-cooldown` }) });
  return { owner, author, sessions, docId, title, fs, box: mailbox(target) };
}
async function claimWithLoss(ctx, s, recipient, kind, trigger, duringHold = async () => {}) {
  const operation = "email-cooldown", id = `${recipient.uid}:${s.docId}:${kind}`, key = `${operation}:${id}`, gate = "ack-after-commit", g = gates(target);
  const file = logFile(target.runId), since = logMark(file); let sent;
  try {
    await g.hold(gate, { key });
    sent = await trigger();
    const held = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    const own = kind === "suggestion" ? `${s.docId}:suggestions` : s.docId;
    const user = await readDoc(target, `users/${recipient.uid}`);
    precondition(typeof user?.emailCooldowns?.[own] === "number" && typeof user?.emailCooldownClaims?.[own] === "string", "cooldown ACK numeric timestamp and unique claim really committed before loss");
    ctx.ev.json(`cooldown-ack-held-${kind}`, { docId: s.docId, recipientUid: recipient.uid, kind, held, claimAt: user.emailCooldowns[own] });
    await duringHold(user.emailCooldowns[own]);
    await g.release(gate, { key });
  } finally { await g.release(gate, { key }).catch(() => undefined); }
  const { match: loss } = await waitForLog(new RegExp(`E2E_ACK_LOSS ${operation} ${id} ([a-f0-9-]+)`), { file, since });
  await waitForLog(`E2E_ACK_RETRY ${operation} ${id} ${loss[1]} callback2`, { file, since });
  const { match: completed } = await waitForLog(new RegExp(`E2E_COOLDOWN_RESULT ${id} (true|false)`), { file, since });
  ctx.ev.json(`cooldown-ack-retry-${kind}`, { docId: s.docId, recipientUid: recipient.uid, kind, caller: loss[1], permitted: completed[1] === "true" });
  return { sent, permitted: completed[1] === "true" };
}
async function noticeCount(s, to, subject, count, message) {
  let messages;
  try { ({ messages } = await s.box.expectMail({ to, subject, count, timeout: 120_000 })); }
  catch (error) {
    if (error?.code !== "E2E_MAIL" || !Array.isArray(error.seen)) throw error;
    messages = error.seen;
  }
  assert.equal(messages.length, count, message);
}
scenario("A23.8a a comment cooldown claim surviving native ACK loss still delivers its winning notice exactly once", CASE, async ctx => {
  const s = await setup(ctx, ["owner", "author"]);
  await claimWithLoss(ctx, s, s.owner, "comment", () => webThread(s.fs(s.author), s.author.account, { docId: s.docId, versionId: "v1", anchor, body: "The committed comment notice." }));
  await noticeCount(s, s.owner.account.email, `${s.author.account.email} commented on “${s.title}”`, 1, "ACK comment cooldown: the winning committed claim delivers exactly one notice");
});
scenario("A23.8b a suggestion cooldown claim surviving native ACK loss still delivers its winning notice exactly once", CASE, async ctx => {
  const s = await setup(ctx, ["owner", "author"]);
  await claimWithLoss(ctx, s, s.owner, "suggestion", async () => {
    const result = await s.author.http.postJson("/suggestion", { op: "create", docId: s.docId, versionId: "v1", anchor, replacement: "A replacement phrase" }, { timeoutMs: 90_000 });
    precondition(result.status === 200, "cooldown ACK suggestion trigger was created"); return result;
  });
  await noticeCount(s, s.owner.account.email, `${s.author.account.email} suggested an edit to “${s.title}”`, 1, "ACK suggestion cooldown: the winning committed claim delivers exactly one notice");
});
scenario("A23.8c a reader whose document expires while its committed cooldown ACK is held receives no comment bytes after retry", CASE, async ctx => {
  const s = await setup(ctx, ["owner", "author", "reader"]), reader = s.sessions[2];
  const { db } = await adminFor(target);
  await db.doc(`users/${s.owner.uid}`).update({ emailNotifications: false });
  const thread = await webThread(s.fs(reader), reader.account, { docId: s.docId, versionId: "v1", anchor, body: "Reader joined this thread." });
  const claim = await claimWithLoss(ctx, s, reader, "comment", () => webReply(s.fs(s.author), s.author.account, { docId: s.docId, versionId: "v1", annId: thread.annId, body: "Private bytes must not cross expiry." }), async claimAt => {
    let expiry;
    for (const lead of [3000, 10_000, 30_000]) {
      const proposed = Date.now() + lead;
      const changed = await setVisibility(target, { owner: s.owner, doc: s.docId, visibility: "private", expiresAt: proposed, expect: [200, 400], timeoutMs: 90_000 });
      if (changed.status === 200) { expiry = proposed; break; }
    }
    precondition(expiry && claimAt < expiry, "cooldown ACK document expires strictly after the captured claim clock");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry + 50 - Date.now())));
    precondition(Date.now() > expiry, "cooldown ACK retry will observe the expired clock boundary");
  });
  assert.equal(claim.permitted, false, "ACK cooldown expiry: the expired reader receives no private comment notice");
  await noticeCount(s, reader.account.email, `${s.author.account.email} commented on “${s.title}”`, 0, "ACK cooldown expiry: the expired reader receives no private comment notice");
});
