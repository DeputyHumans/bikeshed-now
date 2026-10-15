// SPDX-License-Identifier: Apache-2.0
// A completed suggestion lease operation cannot undo a later same-account operation after native ACK loss (SPEC §22).
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish } from "../../lib/seed.mjs";
import { closeAdmin, readDoc } from "../../lib/admin.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark, waitForLog } from "../../lib/logs.mjs";

const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
const CASE = { tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true };
const HTTP_MS = 90_000;
const NAMES = {
  claim: "A8.11a a completed suggestion claim does not resurrect a lease released before its native retry",
  release: "A8.11b a completed suggestion release does not erase a newer same-account lease before its native retry",
};

for (const op of ["claim", "release"]) scenario(NAMES[op], CASE, async ctx => {
  const [account] = await cast(target, ["owner"]);
  const owner = await openSession(target, account, { timeoutMs: HTTP_MS, cutoffError: true });
  const made = await publish(owner.http, { title: `Suggestion ${op} acknowledgement`, name: `suggestion-${op}-ack`, filename: "index.html", body: '<!doctype html><p id="phrase">old phrase</p>', timeoutMs: HTTP_MS });
  precondition(made.status === 200 && made.versionId === "v1", "lease ACK fixture has a current version");
  const docId = made.docId;
  const send = body => owner.http.postJson("/suggestion", { docId, versionId: "v1", ...body }, { timeoutMs: HTTP_MS });
  const suggestion = await send({ op: "create", anchor: { exact: "old phrase", elementId: "phrase", prefix: "", suffix: "", start: 0, end: 10 }, replacement: "new phrase", note: "One proposal" });
  precondition(suggestion.status === 200 && suggestion.json?.annId, "lease ACK fixture has one pending suggestion");
  const annId = suggestion.json.annId, path = `docs/${docId}/versions/v1/annotations/${annId}`;
  if (op === "release") {
    const claimed = await send({ op: "claim", annId });
    precondition(claimed.status === 200 && (await readDoc(target, path)).suggestion?.claim, "release ACK starts with a real claim");
  }
  const g = gates(target), gate = "ack-after-commit", operation = `suggestion-${op}`, key = `${operation}:${docId}`;
  const file = logFile(target.runId), since = logMark(file);
  let pending, answered = false;
  try {
    await g.hold(gate, { key });
    pending = send({ op, annId }).catch(error => ({ status: null, error: String(error?.message ?? error) })).then(response => { answered = true; return response; });
    const held = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: HTTP_MS });
    precondition(!answered, "lease ACK original request is held after its actual commit");
    const first = (await readDoc(target, path)).suggestion?.claim ?? null;
    precondition((first !== null) === (op === "claim"), "lease ACK original lease operation committed");
    // A different operation key stays unarmed: the later real request finishes
    // before the original native retry, so no second retry can mask a replay.
    const laterOp = op === "claim" ? "release" : "claim";
    const laterResponse = await send({ op: laterOp, annId });
    precondition(laterResponse.status === 200, "lease ACK later opposite operation succeeds");
    const later = (await readDoc(target, path)).suggestion?.claim ?? null;
    precondition((later !== null) === (op === "release"), "lease ACK later lease state is durable before retry");
    ctx.ev.json(`lease-ack-held-${op}`, { docId, annId, held, first, later });
    await g.release(gate, { key });
    const response = await pending;
    const { match: loss } = await waitForLog(new RegExp(`E2E_ACK_LOSS ${operation} ${docId} ([a-f0-9-]+)`), { file, since });
    await waitForLog(`E2E_ACK_RETRY ${operation} ${docId} ${loss[1]} callback2`, { file, since });
    const current = await readDoc(target, path);
    ctx.ev.json(`lease-ack-result-${op}`, { docId, annId, caller: loss[1], response, later, current });
    assert.deepEqual(current.suggestion?.claim ?? null, later, `ACK suggestion ${op}: native retry preserves the later lease operation`);
    assert.equal(response.status, 200, `ACK suggestion ${op}: its own durable operation is acknowledged with 200`);
    assert.deepEqual(current.transactionReceipts ?? {}, {}, `ACK suggestion ${op}: completed requests retire only their own receipts`);
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
  }
});
