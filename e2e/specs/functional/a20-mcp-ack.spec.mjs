// SPDX-License-Identifier: Apache-2.0
// MCP comment receipts and automated counters survive native Firestore commit acknowledgement loss without replaying effects (SPEC §17, §19).
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { publish } from "../../lib/seed.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark, readLog, waitForLog } from "../../lib/logs.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";

const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
const CASE = { tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };
const HTTP_MS = 90_000;
const HTML = '<!doctype html><p id="phrase">An exact acknowledgement passage.</p>';
async function setup(ctx) {
  const [account] = await cast(target, ["owner"]);
  const owner = await openSession(target, account, { timeoutMs: HTTP_MS, cutoffError: true });
  const made = await publish(owner.http, { title: "MCP acknowledgement", name: "mcp-ack", filename: "index.html", body: HTML, timeoutMs: HTTP_MS });
  precondition(made.status === 200 && made.versionId === "v1", "MCP ACK fixture has one current version");
  const token = await mintToken(owner, { name: "MCP ACK", channel: "mcp" });
  const mcp = ctx.mcp({ token: token.token, actor: "mcp-ack", timeoutMs: HTTP_MS, cutoffError: true });
  await mcp.initialize();
  return { docId: made.docId, tokenId: token.tokenId, mcp, owner };
}
async function loseAcks(ctx, docId, operation, send, inspect, count = 1) {
  const g = gates(target), gate = "ack-after-commit", key = `${operation}:${docId}`;
  const file = logFile(target.runId), since = logMark(file);
  let pending = [], answered = 0, committed;
  try {
    await g.hold(gate, { key });
    pending = Array.from({ length: count }, () => send().catch(error => ({ isError: true, transportError: String(error?.message ?? error) })).then(response => { answered++; return response; }));
    const held = await requireHeld(ctx, g, gate, count, { key, timeoutMs: HTTP_MS });
    precondition(answered === 0, "MCP ACK calls remain unanswered after their actual commits");
    committed = await inspect();
    ctx.ev.json(`mcp-ack-held-${operation}`, { docId, operation, held, committed });
    await g.release(gate, { key });
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    await Promise.allSettled(pending);
  }
  const responses = await Promise.all(pending);
  await waitForLog(`E2E_ACK_RETRY ${operation} ${docId}`, { file, since });
  const callers = [...readLog(file, since).matchAll(new RegExp(`E2E_ACK_LOSS ${operation} ${docId} ([a-f0-9-]+)`, "g"))].map(match => match[1]);
  precondition(new Set(callers).size === count, `MCP ACK capability injected exactly ${count} actual committed losses`);
  for (const caller of callers) await waitForLog(`E2E_ACK_RETRY ${operation} ${docId} ${caller} callback2`, { file, since });
  ctx.ev.json(`mcp-ack-result-${operation}`, { docId, operation, callers, responses, committed });
  return { responses, committed };
}

scenario("A20.7a MCP add_comment acknowledges one committed thread after native transaction acknowledgement loss", CASE, async ctx => {
  const s = await setup(ctx), path = `docs/${s.docId}/versions/v1/annotations`;
  const { responses: [answer], committed } = await loseAcks(ctx, s.docId, "mcp-comment", () => s.mcp.call("add_comment", { id: s.docId, exact: "An exact acknowledgement passage.", body: "Keep this one comment." }), async () => {
    const rows = await readCollection(target, path);
    precondition(rows.length === 1, "MCP ACK comment thread committed before its acknowledgement is lost");
    const comments = await readCollection(target, `${path}/${rows[0].id}/comments`);
    precondition(comments.length === 1 && comments[0].data.body === "Keep this one comment.", "MCP ACK opening comment committed atomically with its thread");
    return { annId: rows[0].id, commentId: comments[0].id };
  });
  assert.equal(answer.isError, false, "ACK MCP comment: the original call acknowledges its durable thread");
  assert.equal(answer.json?.threadId, committed.annId, "ACK MCP comment: response identifies its original thread");
  assert.deepEqual((await readCollection(target, path)).map(row => row.id), [committed.annId], "ACK MCP comment: retry leaves exactly one thread");
  assert.deepEqual((await readCollection(target, `${path}/${committed.annId}/comments`)).map(row => ({ id: row.id, body: row.data.body })), [{ id: committed.commentId, body: "Keep this one comment." }], "ACK MCP comment: retry leaves exactly one opening comment");
});

scenario("A20.7b overlapping MCP get_document calls count each committed read once after native transaction acknowledgement loss", CASE, async ctx => {
  const s = await setup(ctx), viewPath = `docs/${s.docId}/views/api-${s.tokenId}-v1`;
  const { responses, committed } = await loseAcks(ctx, s.docId, "mcp-read", () => s.mcp.call("get_document", { id: s.docId }), async () => {
    const view = await readDoc(target, viewPath), doc = await readDoc(target, `docs/${s.docId}`);
    precondition(view.reads === 2 && doc.stats.apiReads === 2, "MCP ACK two independent reads are committed before either acknowledgement is lost");
    precondition(Object.keys(view.transactionReceipts ?? {}).length === 2, "MCP ACK each in-flight fetch has its own durable receipt");
    return { startedAt: view.startedAt, receipts: Object.keys(view.transactionReceipts) };
  }, 2);
  for (const answer of responses) {
    assert.equal(answer.isError, false, "ACK MCP read: an actual fetch still succeeds");
    assert.equal(answer.json?.source, HTML, "ACK MCP read: a retry preserves the fetched source");
  }
  const view = await readDoc(target, viewPath), doc = await readDoc(target, `docs/${s.docId}`);
  assert.equal(view.reads, 2, "ACK MCP read: overlapping native retries count each session read once");
  assert.equal(doc.stats.apiReads, 2, "ACK MCP read: overlapping native retries count each aggregate read once");
  assert.deepEqual(Object.keys(view.transactionReceipts ?? {}), [], "ACK MCP read: successful calls remove only their completed receipts");
  assert.deepEqual(view.startedAt, committed.startedAt, "ACK MCP read: retries retain the original session start");
  assert.equal(view.ms, 0, "ACK MCP read: automation has no reading duration");
  assert.deepEqual({ views: doc.stats.views ?? 0, totalMs: doc.stats.totalMs ?? 0 }, { views: 0, totalMs: 0 }, "ACK MCP read: automation does not alter human counters");
  const later = await s.mcp.call("get_document", { id: s.docId });
  assert.equal(later.isError, false);
  assert.equal((await readDoc(target, viewPath)).reads, 3, "ACK MCP read: a later independent fetch still counts");
  assert.equal((await readDoc(target, `docs/${s.docId}`)).stats.apiReads, 3, "ACK MCP read: a later independent fetch advances the aggregate");
});

scenario("A20.7c MCP add_comment acknowledges its commit without resurrecting feedback an author deletes before the native retry", CASE, async ctx => {
  for (const removed of ["thread", "comment", "both"]) {
    const s = await setup(ctx), path = `docs/${s.docId}/versions/v1/annotations`;
    const fs = clientFirestore(target, { session: s.owner });
    const { responses: [answer], committed } = await loseAcks(ctx, s.docId, "mcp-comment", () => s.mcp.call("add_comment", { id: s.docId, exact: "An exact acknowledgement passage.", body: "The author removes this later." }), async () => {
      const rows = await readCollection(target, path);
      precondition(rows.length === 1, "MCP author deletion: one real thread committed before its acknowledgement is lost");
      const comments = await readCollection(target, `${path}/${rows[0].id}/comments`);
      precondition(comments.length === 1, "MCP author deletion: one real opening comment committed atomically");
      if (removed !== "thread") {
        const deletion = await fs.remove(`${path}/${rows[0].id}/comments/${comments[0].id}`);
        precondition(deletion.verdict === "ALLOW", "MCP author deletion: the real author client is allowed to remove its comment");
      }
      if (removed !== "comment") {
        const deletion = await fs.remove(`${path}/${rows[0].id}`);
        precondition(deletion.verdict === "ALLOW", "MCP author deletion: the real author client is allowed to remove its thread");
      }
      return { annId: rows[0].id, commentId: comments[0].id, removed };
    });
    assert.equal(answer.isError, false, "ACK MCP author deletion: the committed creation still succeeds");
    assert.equal(answer.json?.threadId, committed.annId, "ACK MCP author deletion: the answer identifies the original committed thread");
    assert.deepEqual({
      threads: (await readCollection(target, path)).map(row => row.id),
      comments: (await readCollection(target, `${path}/${committed.annId}/comments`)).map(row => row.id),
    }, {
      threads: removed === "comment" ? [committed.annId] : [],
      comments: removed === "thread" ? [committed.commentId] : [],
    }, "ACK MCP author deletion: the native retry never resurrects deleted feedback");
    assert.deepEqual(Object.keys((await readDoc(target, `docs/${s.docId}`)).transactionReceipts ?? {}), [], "ACK MCP author deletion: the completed request removes its bounded receipt");
  }
});
