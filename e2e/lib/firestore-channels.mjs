// SPDX-License-Identifier: Apache-2.0
// Retire observed emulator Listen subscriptions only at the pinned exclusive quiescent maintenance boundary (SPEC §12).
import { createHash } from "node:crypto";
import { assertReachable } from "./http.mjs";

const runs = new Map();
const path = "/google.firestore.v1.Firestore/Listen/channel";
const need = (ok, why) => { if (!ok) throw new Error(`Firestore channel cleanup refused: ${why}`); };
const database = target => `projects/${target.projectId}/databases/(default)`;
const key = target => `${target.runId}\0${new URL(target.firestoreUrl).origin}`;
const integer = value => Number.isSafeInteger(value) && value >= 0;
function scope(target, href) {
  if (target?.kind !== "local" || target.projectId !== "demo-bikeshed" || !target.firestoreUrl) return null;
  const origin = new URL(target.firestoreUrl), url = new URL(href);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || url.origin !== origin.origin || url.pathname !== path) return null;
  need(url.searchParams.get("VER") === "8" && url.searchParams.get("database") === database(target), "unrecognized Listen protocol or database");
  return url;
}
function run(target) {
  if (!runs.has(key(target))) runs.set(key(target), { channels: new Map(), pending: new Set(), errors: [] });
  return runs.get(key(target));
}
function channel(state, sid) {
  need(typeof sid === "string" && /^[A-Za-z0-9_-]{1,510}={0,2}$/.test(sid), "invalid session identity");
  if (!state.channels.has(sid)) state.channels.set(sid, { sid, rid: -1, offset: 0, aid: 0, messages: new Map(), handshake: false });
  return state.channels.get(sid);
}

/** WebChannel lengths count UTF-16 characters, as the pinned server's String.length does. */
export function channelFrames() {
  let buffered = "";
  return text => {
    buffered += text;
    need(buffered.length <= 128 * 1024 * 1024, "oversized channel frame");
    const frames = [];
    while (buffered.includes("\n")) {
      const end = buffered.indexOf("\n"), prefix = buffered.slice(0, end);
      need(/^\d+$/.test(prefix), "invalid channel frame length");
      const length = Number(prefix);
      need(integer(length) && length <= 128 * 1024 * 1024, "invalid channel frame size");
      if (buffered.length < end + 1 + length) break;
      frames.push(JSON.parse(buffered.slice(end + 1, end + 1 + length)));
      buffered = buffered.slice(end + 1 + length);
    }
    return frames;
  };
}

/** Observe only. Successful forward requests retain numeric routing metadata, never query content or credentials. */
export function observeFirestoreContext(target, context) {
  if (target?.kind !== "local" || target.projectId !== "demo-bikeshed" || !target.firestoreUrl) return;
  const state = run(target);
  context.on("request", req => {
    try {
      const url = scope(target, req.url());
      if (!url?.searchParams.has("SID")) return;
      const c = channel(state, url.searchParams.get("SID"));
      const aid = Number(url.searchParams.get("AID") ?? 0);
      need(integer(aid), "invalid acknowledgement"); c.aid = Math.max(c.aid, aid);
    } catch { state.errors.push("unrecognized observed Listen request"); }
  });
  context.on("response", response => {
    let url, meta;
    try {
      const req = response.request(); url = scope(target, req.url());
      if (!url || req.method() !== "POST" || response.status() !== 200) return;
      const body = new URLSearchParams(req.postData() ?? ""), rid = Number(url.searchParams.get("RID"));
      const offset = Number(body.get("ofs")), count = Number(body.get("count"));
      need(integer(rid) && integer(offset) && integer(count) && count <= 10000, "invalid forward sequence");
      const messages = [];
      for (let i = 0; i < count; i++) {
        const message = JSON.parse(body.get(`req${i}___data__`));
        need(message?.database === database(target), "foreign subscription database");
        const id = message.addTarget?.targetId ?? message.removeTarget;
        need(integer(id) && id > 0, "unrecognized subscription request");
        messages.push([offset + i, { id, add: !!message.addTarget }]);
      }
      meta = { rid, offset: offset + count, messages };
    } catch { state.errors.push("unrecognized successful Listen forward request"); return; }
    // Handshake responses are finite. Never read the long-lived GET response body.
    const pending = (async () => {
      let sid = url.searchParams.get("SID");
      if (!sid) {
        const frames = channelFrames()(await response.text());
        sid = frames.flat().find(row => Array.isArray(row?.[1]) && row[1][0] === "c")?.[1][1];
      }
      const c = channel(state, sid);
      if (!url.searchParams.has("SID")) c.handshake = true;
      c.rid = Math.max(c.rid, meta.rid); c.offset = Math.max(c.offset, meta.offset);
      for (const [offset, message] of meta.messages) {
        const old = c.messages.get(offset);
        need(!old || old.id === message.id && old.add === message.add, "conflicting forward replay");
        c.messages.set(offset, message);
      }
    })().catch(() => state.errors.push("Listen handshake or sequence could not be captured"));
    state.pending.add(pending); void pending.finally(() => state.pending.delete(pending));
  });
}

/** The caller pins the stock JAR and asserts exclusive ownership, no live browsers, cases or requests. */
export async function retireFirestoreChannels(target, { assertIdle, fetchImpl = fetch } = {}) {
  need(typeof assertIdle === "function", "an explicit quiescence assertion is required");
  await assertIdle();
  need(scope(target, `${target.firestoreUrl}${path}?VER=8&database=${encodeURIComponent(database(target))}`), "only the isolated loopback demo emulator qualifies");
  const state = runs.get(key(target));
  if (!state) return { observed: 0, retired: [] };
  await Promise.all([...state.pending]);
  need(state.errors.length === 0, state.errors[0]);
  const retired = [];
  const request = async (url, options = {}) => {
    await assertIdle(); assertReachable(target, url.href);
    return fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(30_000), ...options });
  };
  for (const [sid, c] of state.channels) {
    need(c.handshake && c.rid >= 0, "session has no captured handshake");
    const targets = new Set();
    for (const [, m] of [...c.messages].sort(([a], [b]) => a - b)) { if (m.add) targets.add(m.id); else targets.delete(m.id); }
    const url = new URL(path, target.firestoreUrl);
    for (const [name, value] of Object.entries({ database: database(target), VER: "8", SID: sid, AID: c.aid })) url.searchParams.set(name, String(value));
    let last = c.aid;
    if (targets.size) {
      url.searchParams.set("RID", String(c.rid + 1));
      // The pinned handler processes forward messages in order. An already
      // revoked target produces no second REMOVE; confirm a fresh final target
      // instead, after every removal has been processed. This read-only target
      // is immediately removed and never changes a document or a security rule.
      let marker = 1;
      for (const message of c.messages.values()) marker = Math.max(marker, message.id + 1);
      need(marker <= 2147483647, "no fresh subscription identity for removal barrier");
      const body = new URLSearchParams({ count: String(targets.size + 2), ofs: String(c.offset) });
      [...targets].forEach((id, i) => body.set(`req${i}___data__`, JSON.stringify({ database: database(target), removeTarget: id })));
      body.set(`req${targets.size}___data__`, JSON.stringify({ database: database(target), addTarget: { targetId: marker, documents: { documents: [`${database(target)}/documents/__e2e_channel_cleanup/${createHash("sha256").update(sid).digest("hex")}`] } } }));
      body.set(`req${targets.size + 1}___data__`, JSON.stringify({ database: database(target), removeTarget: marker }));
      const remove = await request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
      await remove.text(); need(remove.status === 200, `unsubscribe returned HTTP ${remove.status}`);
      url.searchParams.set("RID", "rpc"); url.searchParams.set("TYPE", "xmlhttp"); url.searchParams.set("CI", "0");
      const stream = await request(url);
      need(stream.status === 200, `drain returned HTTP ${stream.status}`);
      const reader = stream.body.getReader(), decode = new TextDecoder(), parse = channelFrames(), remaining = new Set([marker]);
      try {
        while (remaining.size) {
          await assertIdle();
          const { done, value } = await reader.read(); need(!done, "drain ended before the ordered removal barrier");
          for (const rows of parse(decode.decode(value, { stream: true }))) for (const row of rows) {
            need(integer(row[0]), "invalid drained envelope identity"); last = Math.max(last, row[0]);
            for (const message of row[1]) {
              const change = message?.targetChange;
              if (change?.targetChangeType === "REMOVE" && (!change.cause || change.cause.code === 7)) for (const id of change.targetIds ?? []) remaining.delete(id);
            }
          }
        }
      } finally { await reader.cancel(); }
      // The pinned processBackChannel acknowledges AID before sending HTTP 200 headers.
      // A timeout is not success: require those headers, then cancel the idle response body.
      url.searchParams.set("AID", String(last));
      const ack = await request(url); need(ack.status === 200, `acknowledgement returned HTTP ${ack.status}`); await ack.body.cancel();
    }
    url.searchParams.set("RID", String(c.rid + 2)); url.searchParams.set("TYPE", "terminate");
    const terminate = await request(url), text = await terminate.text();
    need(terminate.status === 200 || terminate.status === 400 && text.trim() === "Unknown SID", `termination returned HTTP ${terminate.status}`);
    await assertIdle();
    state.channels.delete(sid);
    retired.push({ channelSha256: createHash("sha256").update(sid).digest("hex"), subscriptions: targets.size, acknowledgedEnvelope: last });
  }
  runs.delete(key(target));
  return { observed: retired.length, retired };
}
