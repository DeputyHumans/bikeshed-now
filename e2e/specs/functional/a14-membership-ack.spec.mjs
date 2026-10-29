// SPDX-License-Identifier: Apache-2.0
// Native ACK retries preserve committed sharing deltas without overwriting a later revocation or duplicating its event (SPEC §13, §14, §18).
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { createFolder, publish } from "../../lib/seed.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark } from "../../lib/logs.mjs";
import { waitForNativeAckProof } from "../../lib/native-ack.mjs";
import { shimControl } from "../../lib/mail/shimctl.mjs";

const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
const CASE = { tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "email", "mail-fail-recipient", "patch:amplify-native-ack-loss"], timeoutMs: 300_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };
async function membershipAck(ctx, kind) {
  const accounts = await cast(target, ["owner", "viewer"]);
  const [owner] = await Promise.all(accounts.map(account => openSession(target, account, { timeoutMs: 120_000, cutoffError: true })));
  const reader = accounts[1].email, title = `ACK ${kind} sharing`;
  const made = kind === "folder"
    ? await createFolder(owner.http, { name: title, ownerEmail: owner.account.email, timeoutMs: 120_000 })
    : await publish(owner.http, { title, name: "membership-ack", filename: "index.html", body: "<!doctype html><p>Shared bytes</p>", timeoutMs: 120_000 });
  precondition(made.status === 200, "membership ACK fixture creates its owned entity");
  const id = kind === "folder" ? made.folderId : made.docId;
  const path = `${kind === "folder" ? "folders" : "docs"}/${id}`;
  const endpoint = kind === "folder" ? "/folder-access" : "/access", idField = kind === "folder" ? "folderId" : "docId";
  const send = delta => owner.http.postJson(endpoint, { [idField]: id, ...delta }, { timeoutMs: 120_000 }).catch(error => ({ status: null, error: String(error?.message ?? error) }));
  const g = gates(target), gate = "ack-after-commit", operation = kind === "folder" ? "folder-membership" : "doc-membership", key = `${operation}:${id}`;
  const file = logFile(target.runId), since = logMark(file), shim = shimControl(target);
  const state = async () => {
    const row = await readDoc(target, path);
    return { viewers: [...row.viewers].sort(), members: [...row.members].sort() };
  };
  const events = async () => kind === "doc" ? (await readCollection(target, `${path}/events`)).filter(row => row.data.type === "access.changed").map(row => ({ id: row.id, added: row.data.data?.added, removed: row.data.data?.removed })).sort((a, b) => a.id.localeCompare(b.id)) : [];
  let first, second, completed = false, firstCaller, committedEvents;
  try {
    await g.hold(gate, { key });
    first = send({ add: [{ principal: reader, role: "viewer" }] }).then(result => { completed = true; return result; });
    const heldFirst = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    firstCaller = heldFirst.callers[0].caller;
    precondition(!completed && (await state()).members.includes(reader), "membership ACK original grant committed while its request is unanswered");
    second = send({ remove: [reader] });
    const heldBoth = await requireHeld(ctx, g, gate, 2, { key, timeoutMs: 90_000, distinct: "caller" });
    precondition(!(await state()).members.includes(reader), "membership ACK later real revocation committed before the original SDK retry");
    committedEvents = await events();
    precondition(kind !== "doc" || (committedEvents.length === 2 && committedEvents.some(row => row.added?.includes(reader)) && committedEvents.some(row => row.removed?.includes(reader))), "membership ACK grant and revoke each wrote their own access event");
    ctx.ev.json(`membership-ack-held-${kind}`, { id, reader, heldFirst, heldBoth, committedEvents });
    // Keep the later callback held so its eventual retry cannot repair a
    // broken original callback and hide that it replayed an old grant.
    await g.release(gate, { key, count: 1, disarm: false });
    const response = await first;
    const [ack] = await waitForNativeAckProof({ file, since, held: heldFirst, operation, id });
    assert.deepEqual({ state: await state(), events: await events() }, { state: { viewers: [], members: [owner.account.email] }, events: committedEvents }, `ACK ${kind} membership: original retry preserves the later revocation and exact events`);
    assert.equal(response.status, 200, `ACK ${kind} membership: original committed grant returns success`);
    const sent = (await shim.requests({ to: reader })).map(row => ({ status: row.status, subject: row.subject }));
    assert.deepEqual(sent, [{ status: 200, subject: `${owner.account.email} shared “${title}” with you` }], `ACK ${kind} membership: original invitation delta sends exactly one message`);
    ctx.ev.json(`membership-ack-result-${kind}`, { id, reader, firstCaller, ack, response, sent });
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (second) await second;
    if (first) await first;
  }
}
scenario("A14.8a a folder grant ACK retry retains its invitation delta without regranting access revoked by a later request", CASE, ctx => membershipAck(ctx, "folder"));
scenario("A14.8b a document grant ACK retry retains its invitation and one event without regranting access revoked by a later request", CASE, ctx => membershipAck(ctx, "doc"));
