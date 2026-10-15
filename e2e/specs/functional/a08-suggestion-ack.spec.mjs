// SPDX-License-Identifier: Apache-2.0
// One suggestion operation survives a real committed transaction losing its acknowledgement and the installed SDK retrying (SPEC §22).
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish } from "../../lib/seed.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark, waitForLog } from "../../lib/logs.mjs";

const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
const CASE = { tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };
const HTTP_MS = 90_000;
const anchor = { exact: "old phrase", elementId: "phrase", prefix: "", suffix: "", start: 0, end: 10 };
const annotations = docId => `docs/${docId}/versions/v1/annotations`;
async function setup() {
  const [account] = await cast(target, ["owner"]);
  const owner = await openSession(target, account, { timeoutMs: HTTP_MS, cutoffError: true });
  const made = await publish(owner.http, { title: "Suggestion acknowledgement", name: "suggestion-ack", filename: "index.html", body: '<!doctype html><p id="phrase">old phrase</p>', timeoutMs: HTTP_MS });
  precondition(made.status === 200 && made.versionId === "v1", "suggestion ACK fixture has a current version");
  const docId = made.docId;
  const send = body => owner.http.postJson("/suggestion", { docId, versionId: "v1", ...body }, { timeoutMs: HTTP_MS });
  return { docId, send };
}
async function loseAck(ctx, docId, op, send, inspect) {
  const g = gates(target), gate = "ack-after-commit", operation = `suggestion-${op}`, key = `${operation}:${docId}`;
  const file = logFile(target.runId), since = logMark(file);
  let pending, answered = false, committed;
  try {
    await g.hold(gate, { key });
    pending = send().catch(error => ({ status: null, error: String(error?.message ?? error) })).then(response => { answered = true; return response; });
    const held = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: HTTP_MS });
    precondition(!answered, "suggestion ACK original request remains unanswered after its actual commit");
    committed = await inspect();
    ctx.ev.json(`suggestion-ack-held-${op}`, { docId, operation, held, committed });
    await g.release(gate, { key });
  } finally { await g.release(gate, { key }).catch(() => undefined); }
  const response = await pending;
  const { match: loss } = await waitForLog(new RegExp(`E2E_ACK_LOSS ${operation} ${docId} ([a-f0-9-]+)`), { file, since });
  await waitForLog(`E2E_ACK_RETRY ${operation} ${docId} ${loss[1]} callback2`, { file, since });
  ctx.ev.json(`suggestion-ack-result-${op}`, { docId, operation, caller: loss[1], response, committed });
  return { response, committed };
}

scenario("A8.10a suggestion creation acknowledges its single committed annotation after native transaction acknowledgement loss", CASE, async ctx => {
  const s = await setup();
  const { response, committed } = await loseAck(ctx, s.docId, "create", () => s.send({ op: "create", anchor, replacement: "new phrase", note: "Opening note" }), async () => {
    const rows = await readCollection(target, annotations(s.docId));
    precondition(rows.length === 1 && rows[0].data.suggestion?.replacement === "new phrase", "suggestion ACK annotation exists before the lost acknowledgement");
    const comments = await readCollection(target, `${annotations(s.docId)}/${rows[0].id}/comments`);
    precondition(comments.length === 1 && comments[0].data.body === "Opening note", "suggestion ACK opening comment committed atomically");
    return { annId: rows[0].id, commentId: comments[0].id };
  });
  assert.equal(response.status, 200, "ACK suggestion create: its own durable annotation is acknowledged with 200");
  assert.equal(response.json?.annId, committed.annId, "ACK suggestion create: response names the already committed annotation");
  assert.deepEqual((await readCollection(target, annotations(s.docId))).map(row => row.id), [committed.annId], "ACK suggestion create: native retry creates no duplicate annotation");
  assert.deepEqual((await readCollection(target, `${annotations(s.docId)}/${committed.annId}/comments`)).map(row => ({ id: row.id, body: row.data.body })), [{ id: committed.commentId, body: "Opening note" }], "ACK suggestion create: native retry creates no duplicate opening comment");
});

scenario("A8.10b suggestion revision records exactly one history entry after native transaction acknowledgement loss", CASE, async ctx => {
  const s = await setup();
  const made = await s.send({ op: "create", anchor, replacement: "new phrase", note: "Opening note" });
  precondition(made.status === 200 && made.json?.annId, "suggestion ACK revision has one pending proposal");
  const path = `${annotations(s.docId)}/${made.json.annId}`;
  const { response, committed } = await loseAck(ctx, s.docId, "revise", () => s.send({ op: "revise", annId: made.json.annId, replacement: "newer phrase", note: "Revised note" }), async () => {
    const row = await readDoc(target, path);
    precondition(row.suggestion?.replacement === "newer phrase" && row.suggestion.revisions?.length === 1, "suggestion ACK revision exists exactly once before the lost acknowledgement");
    return row.suggestion.revisions[0];
  });
  const row = await readDoc(target, path);
  assert.deepEqual(row.suggestion?.revisions, [committed], "ACK suggestion revise: native retry records exactly one history entry");
  assert.equal(response.status, 200, "ACK suggestion revise: its own durable revision is acknowledged with 200");
  assert.equal(row.suggestion.replacement, "newer phrase", "ACK suggestion revise: new replacement is retained");
  assert.equal(committed.replacement, "new phrase", "ACK suggestion revise: history records the prior replacement");
  assert.equal(committed.note, "Opening note", "ACK suggestion revise: history records the prior author note");
  assert.deepEqual((await readCollection(target, `${path}/comments`)).map(comment => comment.data.body), ["Revised note"], "ACK suggestion revise: one opening comment holds the new note");
});
