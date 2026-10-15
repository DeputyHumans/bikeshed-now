// SPDX-License-Identifier: Apache-2.0
// Real operator commands finish their captured retirement after the native transaction retries an acknowledged-lost commit (SPEC §9).
import assert from "node:assert/strict";
import { after } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish, updateUpload } from "../../lib/seed.mjs";
import { setVisibility } from "../../lib/grant.mjs";
import { closeAdmin, emailKey, listObjects, readDoc, readObject, rtdbGet } from "../../lib/admin.mjs";
import { rtdbAs } from "../../lib/rtdb.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { assertNativeAckProof } from "../../lib/native-ack.mjs";
import { runOperator } from "../../lib/operator.mjs";

const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
const CASE = { tiers: ["local"], needs: ["admin-emulator", "operator-scripts", "rtdb-rules", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };
const record = docId => readDoc(target, `docs/${docId}`);
const version = (docId, id) => readDoc(target, `docs/${docId}/versions/${id}`);

async function setup(mode) {
  const [account] = await cast(target, ["owner"]);
  const owner = await openSession(target, account, { timeoutMs: 90_000, cutoffError: true });
  const title = `Operator ACK ${mode}`;
  const created = await publish(owner.http, { title, name: `operator-ack-${mode}`, filename: "index.html", body: "<!doctype html><p>Retained version one</p>", timeoutMs: 90_000 });
  precondition(created.status === 200 && created.versionId === "v1", "operator ACK setup creates v1");
  const docId = created.docId;
  if (mode === "withdraw") {
    const updated = await updateUpload(owner.http, docId, { baseVersion: "v1", filename: "index.html", body: "<!doctype html><p>Version two to withdraw</p>", timeoutMs: 90_000 });
    precondition(updated.status === 200 && updated.json?.versionId === "v2", "operator ACK setup creates v2");
  }
  const visibility = await setVisibility(target, { owner, doc: docId, visibility: "public", timeoutMs: 90_000 });
  precondition(visibility.status === 200, "operator ACK setup creates the public projection");
  const head = mode === "withdraw" ? "v2" : "v1";
  const draft = await owner.http.postJson("/draft", { docId, baseVersion: head, html: "<!doctype html><p>Captured operator draft</p>" }, { timeoutMs: 90_000 });
  precondition(draft.status === 200, "operator ACK setup saves a concrete draft");
  const before = await record(docId), epoch = before.liveEpoch ?? "initial";
  const logged = await rtdbAs(target, { idToken: owner.idToken }).put(`status/${docId}/y/${epoch}/operatorAckProbe`, "AAA=");
  precondition(logged.status === 200, "operator ACK setup writes a concrete retiring live entry");
  const draftObjects = await listObjects(target, `${before.draft.storagePrefix}/`);
  precondition(draftObjects.length > 0, "operator ACK setup has concrete draft objects to retire");
  return { owner, docId, before, epoch, draftObjects };
}

async function loseOperatorAck(ctx, s, operation, script, args, expectedHead, afterHeld = async () => {}) {
  const g = gates(target), gate = "ack-after-commit", key = `${operation}:${s.docId}`;
  let pending, finished = false;
  let ackHeld;
  try {
    await g.hold(gate, { key });
    pending = runOperator(target, script, args, { timeoutMs: 120_000, env: { E2E_GATE_URL: g.url } }).then(r => { finished = true; return r; });
    const held = ackHeld = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    precondition(!finished, "operator ACK: command remains pending after the real commit");
    const committed = await record(s.docId);
    precondition(committed.currentVersion === expectedHead && !committed.draft && committed.liveEpoch !== s.epoch, "operator ACK: version, draft removal and epoch committed before ACK loss");
    ctx.ev.json("operator-ack-held", { operation, docId: s.docId, held, committed });
    await afterHeld();
    await g.release(gate, { key });
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
  }
  const result = await pending;
  const [ack] = assertNativeAckProof(result.stdout, { held: ackHeld, operation, id: s.docId });
  ctx.ev.json("operator-ack-result", { operation, docId: s.docId, caller: ack.caller, ack, code: result.code, signal: result.signal });
  return result;
}

async function retired(s, expectedHead) {
  const after = await record(s.docId);
  return {
    current: after.currentVersion,
    draft: after.draft ?? null,
    epochChanged: after.liveEpoch !== s.epoch,
    oldLog: await rtdbGet(target, `status/${s.docId}/y/${s.epoch}`),
    oldDraftObjects: await listObjects(target, `${s.before.draft.storagePrefix}/`),
    presenceEpoch: (await rtdbGet(target, `presenceAccess/${s.docId}`))?.__liveEpoch === after.liveEpoch,
    editEpoch: (await rtdbGet(target, `editAccess/${s.docId}`))?.__liveEpoch === after.liveEpoch,
    publicHead: (await readDoc(target, `public/${s.docId}`))?.currentVersion === expectedHead,
    publicEpoch: (await readDoc(target, `public/${s.docId}`))?.liveEpoch === after.liveEpoch,
  };
}
const expectedRetirement = current => ({ current, draft: null, epochChanged: true, oldLog: null, oldDraftObjects: [], presenceEpoch: true, editEpoch: true, publicHead: true, publicEpoch: true });

scenario("A12.10a an operator publish completes its exact retirement after native commit acknowledgement loss without reporting its own commit as a duplicate", CASE, async ctx => {
  const s = await setup("publish");
  const bundle = join(target.stack.treeDir, "content", "bikeshed-tour", "bundle");
  const args = ["--doc", s.docId, "--dir", bundle, "--entry", "index.html", "--owner", s.owner.account.email, "--title", "Operator ACK publication", "--account", s.owner.account.email, "--project", target.projectId, "--bucket", target.bucket];
  const result = await loseOperatorAck(ctx, s, "operator-publish", "publish.mjs", args, "v2");
  assert.deepEqual(await retired(s, "v2"), expectedRetirement("v2"), "ACK operator publish: completed commit finishes its captured retirement");
  assert.equal(result.code, 0, "ACK operator publish: the real command exits successfully");
  assert.equal(result.stdout.includes("already published as"), false, "ACK operator publish: own committed upload is not reported as a duplicate");
  const v2 = await version(s.docId, "v2");
  assert.deepEqual(await readObject(target, `${v2.storagePrefix}/${v2.entry}`), readFileSync(join(bundle, "index.html")), "ACK operator publish: committed immutable entry bytes remain exact");
});

scenario("A12.10b an operator withdrawal completes its exact retirement and removes only the withdrawn version after native commit acknowledgement loss", CASE, async ctx => {
  const s = await setup("withdraw");
  const doomed = await version(s.docId, "v2"), retained = await version(s.docId, "v1");
  const retainedBytes = await readObject(target, `${retained.storagePrefix}/${retained.entry}`);
  const args = ["--doc", s.docId, "--version", "v2", "--repoint", "v1", "--drop-draft", "--yes", "--account", s.owner.account.email, "--project", target.projectId, "--bucket", target.bucket];
  const result = await loseOperatorAck(ctx, s, "operator-withdraw", "delete-version.mjs", args, "v1");
  assert.deepEqual(await retired(s, "v1"), expectedRetirement("v1"), "ACK operator withdrawal: completed repoint finishes its captured retirement");
  assert.equal(result.code, 0, "ACK operator withdrawal: the real command exits successfully");
  assert.equal(await version(s.docId, "v2"), null, "ACK operator withdrawal: the withdrawn version record is removed");
  assert.deepEqual(await listObjects(target, `${doomed.storagePrefix}/`), [], "ACK operator withdrawal: exact withdrawn objects are removed");
  assert.deepEqual(await readObject(target, `${retained.storagePrefix}/${retained.entry}`), retainedBytes, "ACK operator withdrawal: retained version bytes stay exact");
});

scenario("A12.10c an operator access grant ACK retry preserves a later real revocation and its mirrors", CASE, async ctx => {
  const accounts = await cast(target, ["owner", "reader"]);
  const [owner, reader] = await Promise.all(accounts.map(account => openSession(target, account, { timeoutMs: 90_000, cutoffError: true })));
  const created = await publish(owner.http, { title: "Operator sharing ACK", name: "operator-sharing-ack", filename: "index.html", body: "<!doctype html><p>Private operator bytes</p>", timeoutMs: 90_000 });
  precondition(created.status === 200, "operator access ACK fixture creates its document");
  const docId = created.docId, g = gates(target), gate = "ack-after-commit", operation = "operator-access", key = `${operation}:${docId}`;
  let pending, finished = false;
  let ackHeld;
  try {
    await g.hold(gate, { key });
    pending = runOperator(target, "set-access.mjs", ["--doc", docId, "--add", reader.account.email, "--role", "editor", "--account", owner.account.email, "--project", target.projectId], { timeoutMs: 120_000 }).then(result => { finished = true; return result; });
    const held = ackHeld = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    precondition(!finished && (await record(docId)).editorMembers.includes(reader.account.email), "operator access ACK grant committed before loss");
    const removed = await owner.http.postJson("/access", { docId, remove: [reader.account.email] }, { timeoutMs: 90_000 });
    precondition(removed.status === 200 && !(await record(docId)).members.includes(reader.account.email), "operator access ACK later real request revoked the reader");
    ctx.ev.json("operator-access-ack-held", { docId, held, removedStatus: removed.status });
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
  }
  const result = await pending;
  const [ack] = assertNativeAckProof(result.stdout, { held: ackHeld, operation, id: docId });
  const current = await record(docId), readerKey = emailKey(reader.account.email);
  assert.deepEqual({ members: current.members, editors: current.editors, edit: await rtdbGet(target, `editAccess/${docId}/${readerKey}`), presence: await rtdbGet(target, `presenceAccess/${docId}/${readerKey}`) }, { members: [owner.account.email], editors: [], edit: null, presence: null }, "ACK operator access: original retry preserves the later revocation and mirrors");
  assert.equal(result.code, 0, "ACK operator access: committed grant command exits successfully");
  ctx.ev.json("operator-access-ack-result", { docId, caller: ack.caller, ack, code: result.code });
});

scenario("A12.10d an operator withdrawal ACK retry finishes captured cleanup while preserving a later publication", CASE, async ctx => {
  const s = await setup("withdraw");
  const doomed = await version(s.docId, "v2"), retained = await version(s.docId, "v1"), retainedBytes = await readObject(target, `${retained.storagePrefix}/${retained.entry}`);
  const args = ["--doc", s.docId, "--version", "v2", "--repoint", "v1", "--drop-draft", "--yes", "--account", s.owner.account.email, "--project", target.projectId, "--bucket", target.bucket];
  let later, laterBytes;
  const result = await loseOperatorAck(ctx, s, "operator-withdraw", "delete-version.mjs", args, "v1", async () => {
    const updated = await updateUpload(s.owner.http, s.docId, { baseVersion: "v1", filename: "index.html", body: "<!doctype html><p>Later publication stays current</p>", timeoutMs: 90_000 });
    precondition(updated.status === 200 && updated.json?.versionId === "v3", "operator withdrawal ACK later publication replaces the mutable epoch before retry");
    later = await version(s.docId, "v3"); laterBytes = await readObject(target, `${later.storagePrefix}/${later.entry}`);
  });
  assert.deepEqual(await retired(s, "v3"), expectedRetirement("v3"), "ACK operator withdrawal later head: exact captured retirement completes without repointing the newer publication");
  assert.equal(result.code, 0, "ACK operator withdrawal later head: original command acknowledges its completed repoint");
  assert.equal(await version(s.docId, "v2"), null, "ACK operator withdrawal later head: withdrawn record is removed");
  assert.deepEqual(await listObjects(target, `${doomed.storagePrefix}/`), [], "ACK operator withdrawal later head: exact withdrawn bytes are removed");
  assert.deepEqual(await readObject(target, `${later.storagePrefix}/${later.entry}`), laterBytes, "ACK operator withdrawal later head: newer publication bytes stay exact");
  assert.deepEqual(await readObject(target, `${retained.storagePrefix}/${retained.entry}`), retainedBytes, "ACK operator withdrawal later head: retained earlier bytes stay exact");
});
