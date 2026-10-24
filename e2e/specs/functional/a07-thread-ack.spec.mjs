// SPDX-License-Identifier: Apache-2.0
// A thread decision's native retry acknowledges its original note without undoing a later real reopen (SPEC §6, §19).
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { publish } from "../../lib/seed.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { mcpClient } from "../../lib/mcp.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark } from "../../lib/logs.mjs";
import { waitForNativeAckProof } from "../../lib/native-ack.mjs";

const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
scenario("A7.8 a thread resolution acknowledges its committed note after native ACK loss without undoing a later reopen", {
  tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true,
}, async ctx => {
  const [account] = await cast(target, ["owner"]);
  const owner = await openSession(target, account, { timeoutMs: 90_000, cutoffError: true });
  const made = await publish(owner.http, { title: "Thread acknowledgement", name: "thread-ack", filename: "index.html", body: '<!doctype html><p id="phrase">old phrase</p>', timeoutMs: 90_000 });
  precondition(made.status === 200, "thread ACK fixture has a current version");
  const docId = made.docId, token = await mintToken(owner, { channel: "mcp" });
  const client = mcpClient(target, { token: token.token, timeoutMs: 90_000, cutoffError: true });
  await client.initialize();
  const opened = await client.call("add_comment", { id: docId, exact: "old phrase", body: "Please review this." });
  precondition(!opened.isError && opened.json?.threadId, "thread ACK fixture has one real comment thread");
  const threadId = opened.json.threadId, path = `docs/${docId}/versions/v1/annotations/${threadId}`;
  const notes = async () => (await readCollection(target, `${path}/comments`)).filter(row => row.data.generated).map(row => ({ id: row.id, body: row.data.body })).sort((a, b) => a.id.localeCompare(b.id));
  const g = gates(target), gate = "ack-after-commit", operation = "thread-resolve", key = `${operation}:${docId}`;
  const file = logFile(target.runId), since = logMark(file);
  let pending, answered = false, preserved;
  let ackHeld;
  try {
    await g.hold(gate, { key });
    pending = client.call("resolve_thread", { id: docId, threadId }).catch(error => ({ isError: true, text: String(error?.message ?? error) })).then(response => { answered = true; return response; });
    const held = ackHeld = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    precondition(!answered && (await readDoc(target, path)).resolved === true, "thread ACK first resolution really committed while its caller still waits");
    precondition((await notes()).filter(row => row.body === "Resolved.").length === 1, "thread ACK first decision wrote its real generated note");
    const reopened = await client.call("reopen_thread", { id: docId, threadId });
    precondition(!reopened.isError && reopened.json?.resolved === false && (await readDoc(target, path)).resolved === false, "thread ACK later real reopen committed before the old SDK retry");
    preserved = await notes();
    precondition(preserved.length === 2 && preserved.some(row => row.body === "Reopened."), "thread ACK both ordered decisions have one generated note");
    ctx.ev.json("thread-ack-held", { docId, threadId, held, preserved });
    await g.release(gate, { key });
  } finally { await g.release(gate, { key }).catch(() => undefined); }
  const response = await pending;
  const [ack] = await waitForNativeAckProof({ file, since, held: ackHeld, operation, id: docId });
  ctx.ev.json("thread-ack-result", { docId, threadId, caller: ack.caller, ack, response });
  assert.deepEqual({ resolved: (await readDoc(target, path)).resolved, notes: await notes() }, { resolved: false, notes: preserved }, "ACK thread: retry preserves the later reopen and both original notes");
  assert.equal(response.isError, false, "ACK thread: original completed resolution returns success");
  assert.equal(response.json?.resolved, true, "ACK thread: response acknowledges its original resolution");
});
