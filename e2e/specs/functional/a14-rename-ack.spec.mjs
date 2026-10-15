// SPDX-License-Identifier: Apache-2.0
// A rename's native commit retry preserves a later real rename and the exact two change events (SPEC §4, §19).
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish } from "../../lib/seed.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { logFile, logMark } from "../../lib/logs.mjs";
import { waitForNativeAckProof } from "../../lib/native-ack.mjs";
const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
scenario("A14.9 a rename acknowledges its own native commit without overwriting a later rename or duplicating its change event", {
  tiers: ["local"], needs: ["admin-emulator", "logs", "gates", "patch:amplify-native-ack-loss"], timeoutMs: 240_000, inconclusiveOnHttpStall: true, inconclusiveOnRequestStall: true,
}, async ctx => {
  const [account] = await cast(target, ["owner"]), owner = await openSession(target, account, { timeoutMs: 90_000, cutoffError: true });
  const made = await publish(owner.http, { name: "rename-ack", title: "Original", filename: "index.html", body: "<!doctype html><p>Rename only changes metadata.</p>", timeoutMs: 90_000 });
  precondition(made.status === 200, "rename ACK fixture has an owned document");
  const docId = made.docId, operation = "doc-rename", gate = "ack-after-commit", key = `${operation}:${docId}`, g = gates(target);
  const file = logFile(target.runId), since = logMark(file);
  const events = async () => (await readCollection(target, `docs/${docId}/events`)).filter(e => e.data.type === "doc.renamed").map(e => ({ id: e.id, from: e.data.data?.from, to: e.data.data?.to })).sort((a, b) => a.id.localeCompare(b.id));
  const rename = name => owner.http.postJson("/organize", { kind: "doc", id: docId, op: "rename", name }, { timeoutMs: 120_000 }).catch(error => ({ status: null, error: String(error?.message ?? error) }));
  let first, second, originalFinished = false;
  try {
    await g.hold(gate, { key });
    first = rename("First").then(result => { originalFinished = true; return result; });
    const held = await requireHeld(ctx, g, gate, 1, { key, timeoutMs: 90_000 });
    const caller = held.callers[0].caller;
    precondition(!originalFinished && (await readDoc(target, `docs/${docId}`)).title === "First", "rename ACK original title committed before its answer");
    second = rename("Newer");
    await requireHeld(ctx, g, gate, 2, { key, timeoutMs: 90_000, distinct: "caller" });
    const preserved = await events();
    precondition((await readDoc(target, `docs/${docId}`)).title === "Newer" && preserved.length === 2 && preserved.some(e => e.from === "Original" && e.to === "First") && preserved.some(e => e.from === "First" && e.to === "Newer"), "rename ACK later real rename and both change events committed");
    ctx.ev.json("rename-ack-held", { docId, caller, preserved });
    await g.release(gate, { key, count: 1, disarm: false });
    const response = await first;
    const [ack] = await waitForNativeAckProof({ file, since, held, operation, id: docId });
    ctx.ev.json("rename-ack-retry", { docId, ack });
    const row = await readDoc(target, `docs/${docId}`);
    assert.deepEqual({ title: row.title, slug: row.slug, events: await events() }, { title: "Newer", slug: "newer", events: preserved }, "ACK rename: original retry preserves the newer title and exact two events");
    assert.equal(response.status, 200, "ACK rename: original committed rename returns success");
  } finally {
    await g.release(gate, { key }).catch(() => undefined);
    if (first) await first;
    if (second) await second;
  }
});
