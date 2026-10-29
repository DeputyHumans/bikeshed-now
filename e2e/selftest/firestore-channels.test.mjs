// SPDX-License-Identifier: Apache-2.0
// Challenge orphaned Listen cleanup scope, protocol capture, acknowledgement and idle admission (SPEC §12).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { observeFirestoreContext, retireFirestoreChannels, channelFrames } from "../lib/firestore-channels.mjs";
let sequence = 0;
const frame = rows => { const text = JSON.stringify(rows); return `${text.length}\n${text}`; };
function fixture() {
  const target = { kind: "local", projectId: "demo-bikeshed", runId: `channels-${++sequence}`, firestoreUrl: "http://127.0.0.1:38128", stack: { ports: { firestore: 38128 } } };
  const context = new EventEmitter(); observeFirestoreContext(target, context);
  const db = "projects/demo-bikeshed/databases/(default)", base = `${target.firestoreUrl}/google.firestore.v1.Firestore/Listen/channel?VER=8&database=${encodeURIComponent(db)}`;
  function send({ sid = null, rid = 71, offset = 0, messages = [{ database: db, addTarget: { targetId: 8, documents: { documents: ["secret document path"] } } }], response = frame([[0, ["c", "session=="]]]), status = 200 } = {}) {
    const body = new URLSearchParams({ count: String(messages.length), ofs: String(offset), headers: "Authorization: private credential" });
    messages.forEach((m, i) => body.set(`req${i}___data__`, JSON.stringify(m)));
    const req = { url: () => `${base}&RID=${rid}${sid ? `&SID=${encodeURIComponent(sid)}` : ""}`, method: () => "POST", postData: () => body.toString() };
    context.emit("request", req); context.emit("response", { request: () => req, status: () => status, text: async () => response });
  }
  const calls = []; let gets = 0;
  const fetchImpl = async (href, options) => {
    const u = new URL(href); calls.push({ url: u, options });
    if (u.searchParams.get("TYPE") === "terminate") return new Response("");
    if (options.method === "POST") return new Response("7\n[0,7,7]");
    if (++gets === 1) return new Response(frame([[12, [{ targetChange: { targetChangeType: "REMOVE", targetIds: [8] } }]], [13, [{ targetChange: { targetChangeType: "REMOVE", targetIds: [9] } }]]]));
    return new Response("");
  };
  return { target, context, db, base, send, calls, options: { assertIdle: () => {}, fetchImpl } };
}

test("observed subscription cleanup uses captured sequencing and acknowledges before terminating without retaining private content", async () => {
  const f = fixture(); f.send();
  const row = await retireFirestoreChannels(f.target, f.options);
  assert.equal(row.observed, 1); assert.equal(row.retired[0].subscriptions, 1);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[0].url.searchParams.get("RID"), "72");
  const body = new URLSearchParams(f.calls[0].options.body);
  assert.equal(body.get("ofs"), "1");
  assert.deepEqual(JSON.parse(body.get("req0___data__")), { database: f.db, removeTarget: 8 });
  assert.equal(body.get("count"), "3");
  const barrier = JSON.parse(body.get("req1___data__"));
  assert.equal(barrier.database, f.db); assert.equal(barrier.addTarget.targetId, 9);
  assert.match(barrier.addTarget.documents.documents[0], /^projects\/demo-bikeshed\/databases\/\(default\)\/documents\/__e2e_channel_cleanup\/[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(body.get("req2___data__")), { database: f.db, removeTarget: 9 });
  assert.equal(f.calls[2].url.searchParams.get("AID"), "13");
  assert.equal(f.calls[2].url.searchParams.get("RID"), "rpc");
  assert.equal(f.calls[3].url.searchParams.get("TYPE"), "terminate");
  assert.ok(!JSON.stringify({ row, calls: f.calls }).includes("private credential"));
  assert.ok(!JSON.stringify({ row, calls: f.calls }).includes("secret document path"));
  assert.equal((await retireFirestoreChannels(f.target, f.options)).observed, 0);
});

test("forward replays are deduplicated and out-of-order completion respects message offsets", async () => {
  const f = fixture(); f.send(); f.send();
  f.send({ sid: "session==", rid: 73, offset: 2, messages: [{ database: f.db, addTarget: { targetId: 8 } }] });
  f.send({ sid: "session==", rid: 72, offset: 1, messages: [{ database: f.db, removeTarget: 8 }] });
  await retireFirestoreChannels(f.target, f.options);
  assert.equal(f.calls[0].url.searchParams.get("RID"), "74");
  assert.equal(new URLSearchParams(f.calls[0].options.body).get("ofs"), "3");
});

test("frame parser handles split lengths, split Unicode and multiple frames and refuses malformed framing", () => {
  const parse = channelFrames(), text = frame([[1, ["🌲"]]]) + frame([[2, ["done"]]]), rows = [];
  for (const char of text.split("")) rows.push(...parse(char));
  assert.deepEqual(rows, [[[1, ["🌲"]]], [[2, ["done"]]]]);
  assert.throws(() => channelFrames()("bad\n"), /frame length/);
  assert.throws(() => channelFrames()("999999999\n"), /frame size/);
});

test("cleanup refuses active work, foreign targets and incomplete protocol capture before requests", async () => {
  for (const mode of ["active", "foreign", "uncaptured", "malformed", "conflict"]) {
    const f = fixture();
    if (mode === "uncaptured") f.context.emit("request", { url: () => `${f.base}&SID=orphan&AID=3` });
    else f.send();
    if (mode === "active") f.options.assertIdle = () => { throw Error("active work"); };
    if (mode === "foreign") f.target.kind = "prod";
    if (mode === "malformed") f.send({ messages: [{ database: "foreign", addTarget: { targetId: 9 } }] });
    if (mode === "conflict") f.send({ messages: [{ database: f.db, addTarget: { targetId: 9 } }] });
    await assert.rejects(retireFirestoreChannels(f.target, f.options), /refused|active work/, mode);
    assert.equal(f.calls.length, 0, mode);
  }
});

test("missing removals, HTTP failure and lost idle admission cannot be reported as cleanup", async () => {
  for (const mode of ["remove", "drain", "ack", "terminate", "missing", "idle"]) {
    const f = fixture(); f.send(); const normal = f.options.fetchImpl; let count = 0;
    f.options.fetchImpl = async (url, options) => {
      count++;
      if (count === { remove: 1, drain: 2, ack: 3, terminate: 4 }[mode]) return new Response("failed", { status: 503 });
      if (mode === "missing" && count === 2) return new Response(frame([[12, [{ targetChange: { targetChangeType: "REMOVE", targetIds: [99] } }]]]));
      if (mode === "idle" && count === 1) f.options.assertIdle = () => { throw Error("active work"); };
      return normal(url, options);
    };
    // Closure checks the mutable fixture callback on every network and stream operation.
    await assert.rejects(retireFirestoreChannels(f.target, { ...f.options, assertIdle: () => f.options.assertIdle() }), /refused|active work/, mode);
    assert.ok(count <= (mode === "idle" ? 1 : 4));
  }
});

test("the ordered removal barrier handles a target already revoked without requiring a second removal reply", async () => {
  for (const cause of [undefined, { code: 7, message: "permission denied" }]) {
    const f = fixture(); f.send(); const normal = f.options.fetchImpl; let count = 0;
    f.options.fetchImpl = async (url, options) => ++count === 2
      ? new Response(frame([[13, [{ targetChange: { targetChangeType: "REMOVE", targetIds: [9], ...(cause ? { cause } : {}) } }]]]))
      : normal(url, options);
    const row = await retireFirestoreChannels(f.target, f.options);
    assert.equal(row.retired[0].acknowledgedEnvelope, 13);
  }
});

test("unrelated removals and unexpected barrier errors cannot confirm ordered cleanup", async () => {
  for (const change of [
    { targetChangeType: "REMOVE", targetIds: [8] },
    { targetChangeType: "ADD", targetIds: [9] },
    { targetChangeType: "REMOVE", targetIds: [9], cause: { code: 13 } },
  ]) {
    const f = fixture(); f.send(); const normal = f.options.fetchImpl; let count = 0;
    f.options.fetchImpl = async (url, options) => ++count === 2
      ? new Response(frame([[13, [{ targetChange: change }]]])) : normal(url, options);
    await assert.rejects(retireFirestoreChannels(f.target, f.options), /ordered removal barrier/);
    assert.equal(count, 2);
  }
});
