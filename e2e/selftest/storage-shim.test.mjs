// SPDX-License-Identifier: Apache-2.0
// Self-test: the Storage shim (--storage-shim) refuses a second create-only write or copy under one lock per object, passes everything else through byte for byte, refuses what it cannot judge, and the stack's preload, readiness, options and aux process put it in front of the functions (SPEC §4, §12, §21).

/**
 * A stand-in Storage JSON API on a loopback port behaves as the Storage
 * emulator of firebase-tools 15.25.1 does: it IGNORES every precondition,
 * stamps a new generation on each write, answers md5Hash and crc32c (so the
 * Node SDK's upload validation passes), and can be told to take a while over
 * each write (`writeDelayMs`), which is what makes an unguarded race lose. The
 * shim stands in front of it. Covered: the request table; refusals and
 * forwards, raw and through firebase-admin's own Storage client (the
 * product's path: `save(…, {resumable: false, preconditionOpts:
 * {ifGenerationMatch: 0}})`, `copy(…, CREATE_ONLY)`); races of N writers at
 * one name (exactly one wins; straight at the stand-in all do); locks per
 * object; bytes and the Host header passed through; 501, 400, 503; the probe
 * honoured through the shim and not without it; the preload in a child
 * process (moved only in a function worker, only from this stack's emulator)
 * and a child "worker" whose registry env names the stand-in, moved onto the
 * shim and refused there; shimRedirects; options, ports, capabilities, the
 * live status; the aux process, in this process and as a process; pins on
 * stack.mjs, run.mjs, firebase-tools and the Storage SDK; the README.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { sparePorts } from "../lib/spare.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";
import { STORAGE_SHIM_ROLES, withAuxPorts } from "../lib/stack.mjs";
import { capabilitiesFor, normalizeStackOptions, parseStackOptionArgs, stackOptionArgs } from "../lib/options.mjs";
import { localTarget } from "../lib/target.mjs";
import { startAux } from "../lib/stackaux.mjs";
import { probeStoragePreconditions, storagePreconditionsStatus } from "../lib/storage-preconditions.mjs";
import {
  PRECONDITION_PARAMS, SHIM_DECISIONS_KEPT, STORAGE_SHIM, STORAGE_SHIM_ENV, STORAGE_SHIM_LOG_ENV, STORAGE_SHIM_PRELOAD_IN_TREE, STORAGE_SHIM_PRELOAD_SOURCE,
  STORAGE_SHIM_ROLE, STORAGE_SHIM_SPARE, STORAGE_SHIM_UPSTREAM_ENV, describeStorageShimPreload, installStorageShimPreload, readStorageShimLog, shimRedirects,
  startStorageShim, storageRequestKind, storageShim, storageShimEnv,
} from "../lib/storage-shim.mjs";
import { tempDir } from "./helpers/tmp.mjs";
import { firebaseTools } from "../lib/prerequisites.mjs";
import { firebaseBehavior, PROBE_PARENT_ENV, PROBE_STORAGE_HOST } from "./helpers/firebase-probes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");
const BUCKET = "demo-bikeshed-content";
const PORTS = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 37000 + i));
const work = tempDir("e2e-storage-shim-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const sha = (b) => createHash("sha256").update(b).digest("hex");

// --- a stand-in Storage emulator (ignores every precondition, as firebase-tools 15.25.1 does) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32c(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  const out = Buffer.alloc(4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return out.toString("base64");
}

/** The JSON part and the data part of a multipart/related upload (the Node SDK's simple upload). */
function parseMultipart(contentType, body) {
  const boundary = /boundary="?([^";]+)"?/.exec(contentType ?? "")?.[1];
  if (!boundary) throw new Error(`no boundary in ${contentType}`);
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let at = body.indexOf(sep);
  while (at !== -1) {
    const next = body.indexOf(sep, at + sep.length);
    if (next === -1) break;
    let part = body.subarray(at + sep.length, next);
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(-2).toString() === "\r\n") part = part.subarray(0, -2);
    const split = part.indexOf("\r\n\r\n");
    parts.push({ headers: part.subarray(0, split).toString("utf8"), data: part.subarray(split + 4) });
    at = next;
  }
  const meta = JSON.parse(parts[0].data.toString("utf8"));
  const ct = /content-type:\s*([^\r\n]+)/i.exec(parts[1].headers)?.[1] ?? null;
  return { meta, data: parts[1].data, contentType: ct };
}

async function standInStorage() {
  const objects = new Map();
  const requests = [];
  let gen = 1760000000000000;
  const s = { objects, requests, writeDelayMs: 0, beforeWrite: null, failMeta: false };
  const meta = (bucket, name, o) => ({ kind: "storage#object", bucket, name, generation: o.generation, metageneration: "1", size: String(o.data.length), md5Hash: createHash("md5").update(o.data).digest("base64"), crc32c: crc32c(o.data), contentType: o.contentType });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const u = new URL(req.url, "http://x");
      const q = Object.fromEntries(u.searchParams);
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, path: u.pathname, query: q, host: req.headers.host ?? null, auth: req.headers.authorization ?? null, bytes: body.length, sha: sha(body) });
      const json = (status, o) => {
        const text = o === undefined ? "" : JSON.stringify(o);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(text);
      };
      try {
        let m = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname);
        if (m && req.method === "POST") {
          const bucket = decodeURIComponent(m[1]);
          if (q.uploadType === "resumable") {
            res.writeHead(200, { location: `http://${req.headers.host}/upload/storage/v1/b/${bucket}/o?name=${enc(q.name)}&uploadType=resumable&upload_id=u-${gen}` });
            return res.end();
          }
          let data = body;
          let contentType = req.headers["content-type"] ?? null;
          let name = q.name;
          if (q.uploadType === "multipart") {
            const mp = parseMultipart(contentType, body);
            data = mp.data;
            contentType = mp.contentType;
            name ??= mp.meta.name;
          }
          if (s.beforeWrite) await s.beforeWrite(name);
          if (s.writeDelayMs) await sleep(s.writeDelayMs);
          const o = { data, generation: String((gen += 1)), contentType };
          objects.set(`${bucket}/${name}`, o);
          return json(200, meta(bucket, name, o));
        }
        m = /^\/b\/([^/]+)\/o\/([^/]+)\/(rewriteTo|copyTo)\/b\/([^/]+)\/o\/([^/]+)$/.exec(u.pathname);
        if (m && req.method === "POST") {
          const from = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
          const [db, dn] = [decodeURIComponent(m[4]), decodeURIComponent(m[5])];
          if (!objects.has(from)) return json(404, { error: { code: 404 } });
          if (s.writeDelayMs) await sleep(s.writeDelayMs);
          const o = { ...objects.get(from), generation: String((gen += 1)) };
          objects.set(`${db}/${dn}`, o);
          return json(200, m[3] === "rewriteTo" ? { kind: "storage#rewriteResponse", done: true, resource: meta(db, dn, o) } : meta(db, dn, o));
        }
        m = /^\/b\/([^/]+)\/o\/([^/]+)$/.exec(u.pathname);
        if (m) {
          const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
          const o = objects.get(key);
          if (req.method === "GET") {
            if (s.failMeta && q.alt !== "media") return json(500, { error: { code: 500 } });
            if (!o) return json(404, { error: { code: 404, message: "Not Found" } });
            if (q.alt === "media") {
              res.writeHead(200, { "content-type": o.contentType ?? "application/octet-stream", "content-length": o.data.length });
              return res.end(o.data);
            }
            return json(200, meta(decodeURIComponent(m[1]), decodeURIComponent(m[2]), o));
          }
          if (req.method === "DELETE") {
            if (!o) return json(404, { error: { code: 404 } });
            objects.delete(key);
            res.writeHead(204);
            return res.end();
          }
        }
        m = /^\/b\/([^/]+)\/o$/.exec(u.pathname);
        if (m && req.method === "GET") return json(200, { kind: "storage#objects", items: [...objects.keys()].filter((k) => k.startsWith(`${decodeURIComponent(m[1])}/`)).map((k) => ({ name: k.slice(k.indexOf("/") + 1) })) });
        json(501, { error: { code: 501 } });
      } catch (err) {
        json(500, { error: { code: 500, message: err.message } });
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  s.port = server.address().port;
  s.url = `http://127.0.0.1:${s.port}`;
  s.close = () => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  });
  return s;
}

const store = await standInStorage();
const shim = await startStorageShim({ upstreamPort: store.port, metaTimeoutMs: 2_000, log: () => {} });
after(async () => {
  await shim.close();
  await store.close();
});

/** A raw request; {status, headers, body: Buffer, json}. */
function call(base, method, path, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const r = http.request({ host: u.hostname, port: u.port, method, path: `${u.pathname}${u.search}`, headers: { ...(body ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const b = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(b.toString("utf8"));
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: b, json });
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const upload = (base, name, bytes, extra = "") => call(base, "POST", `/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${enc(name)}${extra}`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
const rewrite = (base, from, to, extra = "") => call(base, "POST", `/b/${BUCKET}/o/${enc(from)}/rewriteTo/b/${BUCKET}/o/${enc(to)}${extra}`, { body: "{}", headers: { "content-type": "application/json" } });
const objectOf = (name) => store.objects.get(`${BUCKET}/${name}`) ?? null;
const unique = (what) => `selftest/${what}-${randomBytes(4).toString("hex")}`;
const seen = (name, since) => store.requests.slice(since).filter((r) => r.path.includes(enc(name)) || r.query.name === name);

// --- the request table ---------------------------------------------------------------------------

test("storageRequestKind: what each request is, what it locks, what it judges, and what it refuses to judge", () => {
  const k = (m, u, h) => storageRequestKind(m, u, h);
  const up = k("POST", `/upload/storage/v1/b/${BUCKET}/o?uploadType=multipart&name=docs%2Fa%2Fv1%2Findex.html&ifGenerationMatch=0`);
  assert.deepEqual({ kind: up.kind, bucket: up.bucket, name: up.name, lock: up.lock, gm: up.ifGenerationMatch, judge: up.judge, unjudged: up.unjudged }, { kind: "upload", bucket: BUCKET, name: "docs/a/v1/index.html", lock: `${BUCKET}/docs/a/v1/index.html`, gm: "0", judge: true, unjudged: null });
  const plain = k("POST", `/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=x`);
  assert.deepEqual([plain.kind, plain.lock, plain.judge], ["upload", `${BUCKET}/x`, false], "a plain write takes the lock, judges nothing");
  const rw = k("POST", `/b/${BUCKET}/o/docs%2Fs%2Fv1%2Fa/rewriteTo/b/${BUCKET}/o/docs%2Ff%2Fv1%2Fa?ifGenerationMatch=0`);
  assert.deepEqual([rw.kind, rw.source, rw.name, rw.lock, rw.judge], ["rewrite", { bucket: BUCKET, name: "docs/s/v1/a" }, "docs/f/v1/a", `${BUCKET}/docs/f/v1/a`, true]);
  assert.equal(k("POST", `/storage/v1/b/${BUCKET}/o/a/copyTo/b/${BUCKET}/o/b?ifGenerationMatch=7`).kind, "copy", "the /storage/v1 form and copyTo");
  assert.equal(k("POST", `/storage/v1/b/${BUCKET}/o/a/copyTo/b/${BUCKET}/o/b?ifGenerationMatch=7`).judge, true);
  for (const [m, kind] of [["DELETE", "delete"], ["PATCH", "patch"]]) {
    const d = k(m, `/b/${BUCKET}/o/docs%2Fa`);
    assert.deepEqual([d.kind, d.lock, d.judge], [kind, `${BUCKET}/docs/a`, false]);
  }
  const read = k("GET", `/b/${BUCKET}/o/docs%2Fa?alt=media`);
  assert.deepEqual([read.kind, read.lock, read.judge], ["read", null, false], "reads take no lock");
  assert.deepEqual([k("GET", `/b/${BUCKET}/o?prefix=docs%2F`).kind, k("GET", `/b/${BUCKET}/o?prefix=docs%2F`).lock], ["other", null], "a listing passes");
  const rs = k("POST", `/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&name=x`);
  assert.deepEqual([rs.kind, rs.lock, rs.unjudged], ["resumable-start", null, null], "a session writes nothing");
  assert.equal(k("POST", `/upload/storage/v1/b/${BUCKET}/o?name=x`, { "x-goog-upload-protocol": "resumable" }).kind, "resumable-start", "X-Goog-Upload-Protocol stands in for uploadType");
  const put = k("PUT", `/upload/storage/v1/b/${BUCKET}/o?name=x&uploadType=resumable&upload_id=u1`);
  assert.deepEqual([put.kind, put.lock], ["resumable-put", `${BUCKET}/x`]);
  // What it will not judge: 501, never a silent pass.
  for (const [m, u, why] of [
    ["POST", `/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&name=x&ifGenerationMatch=0`, /resumable upload's ifGenerationMatch/],
    ["POST", `/upload/storage/v1/b/${BUCKET}/o?uploadType=multipart&ifGenerationMatch=0`, /no \?name=/],
    ["POST", `/upload/storage/v1/b/${BUCKET}/o?name=x&ifGenerationMatch=0&ifMetagenerationMatch=1`, /ifMetagenerationMatch on an upload/],
    ["POST", `/upload/storage/v1/b/${BUCKET}/o?name=x&ifGenerationNotMatch=3`, /ifGenerationNotMatch on an upload/],
    ["POST", `/b/${BUCKET}/o/a/rewriteTo/b/${BUCKET}/o/b?ifSourceGenerationMatch=1`, /ifSourceGenerationMatch on a rewrite/],
    ["DELETE", `/b/${BUCKET}/o/a?ifGenerationMatch=4`, /on a delete/],
    ["GET", `/b/${BUCKET}/o/a?ifGenerationMatch=4`, /on a read/],
    ["GET", `/download/storage/v1/b/${BUCKET}/o/a?ifGenerationMatch=4`, /on GET \/download/],
  ]) assert.match(k(m, u).unjudged ?? "", why, `${m} ${u}`);
  assert.equal(PRECONDITION_PARAMS.length, 8);
  assert.match(k("POST", `/upload/storage/v1/b/${BUCKET}/o?name=x&ifGenerationMatch=abc`).invalid, /a decimal number/);
  assert.match(k("POST", `/upload/storage/v1/b/${BUCKET}/o?name=x&ifGenerationMatch=`).invalid, /a decimal number/);
  assert.match(k("POST", `/b/${BUCKET}/o/a/rewriteTo/b/${BUCKET}/o/%E0%A4%A?ifGenerationMatch=0`).invalid, /malformed object path/);
});

// --- judged writes --------------------------------------------------------------------------------

test("a create-only upload: forwarded while the object does not exist, refused with Cloud Storage's 412 once it does; the emulator never sees the refused one", async () => {
  const name = unique("upload");
  const base = store.requests.length;
  const before = shim.stats;
  const first = await upload(shim.url, name, "first", "&ifGenerationMatch=0");
  assert.equal(first.status, 200, first.body.toString());
  const second = await upload(shim.url, name, "second", "&ifGenerationMatch=0");
  assert.equal(second.status, 412);
  assert.equal(second.headers["x-e2e-storage-shim"], "refused");
  assert.deepEqual(second.json.error.code, 412);
  assert.equal(second.json.error.errors[0].reason, "conditionNotMet");
  assert.equal(second.json.error.message, "At least one of the pre-conditions you specified did not hold.");
  assert.equal(objectOf(name).data.toString(), "first", "the first bytes are kept");
  const uploads = seen(name, base).filter((r) => r.method === "POST");
  assert.equal(uploads.length, 1, "the refused write never reached the emulator");
  const metas = seen(name, base).filter((r) => r.method === "GET");
  assert.equal(metas.length, 2, "one metadata read per judged write");
  assert.ok(metas.every((r) => r.auth === "Bearer owner"), "as the emulator's admin");
  const after = shim.stats;
  assert.deepEqual([after.judged - before.judged, after.forwarded - before.forwarded, after.refused - before.refused], [2, 1, 1]);
  const ds = shim.decisions({ since: before.seq });
  assert.deepEqual(ds.map((d) => [d.kind, d.name, d.decision, d.status, d.current === null]), [["upload", name, "forward", 200, true], ["upload", name, "refuse", 412, false]]);
  assert.equal(ds[1].current, objectOf(name).generation, "the refusal names the generation it found");
  assert.match(ds[1].reason, /exists at generation/);
});

test("ifGenerationMatch=<g>: forwarded when the object is at g, refused otherwise and when it does not exist", async () => {
  const name = unique("gen");
  assert.equal((await upload(shim.url, name, "one")).status, 200);
  const g = objectOf(name).generation;
  assert.equal((await upload(shim.url, name, "stale", `&ifGenerationMatch=${BigInt(g) - 1n}`)).status, 412, "an older generation");
  assert.equal(objectOf(name).data.toString(), "one");
  assert.equal((await upload(shim.url, name, "two", `&ifGenerationMatch=${g}`)).status, 200, "the current generation");
  assert.equal(objectOf(name).data.toString(), "two");
  assert.equal((await upload(shim.url, unique("absent"), "x", `&ifGenerationMatch=${g}`)).status, 412, "a generation of an object that does not exist");
});

test("a create-only rewrite (the SDK's copy): refused onto an object that exists, forwarded onto one that does not", async () => {
  const src = unique("src");
  const dst = unique("dst");
  await upload(shim.url, src, "source");
  await upload(shim.url, dst, "destination");
  const refused = await rewrite(shim.url, src, dst, "?ifGenerationMatch=0");
  assert.equal(refused.status, 412);
  assert.equal(objectOf(dst).data.toString(), "destination");
  const fresh = unique("fresh");
  const ok = await rewrite(shim.url, src, fresh, "?ifGenerationMatch=0");
  assert.equal(ok.status, 200, ok.body.toString());
  assert.equal(ok.json.done, true);
  assert.equal(objectOf(fresh).data.toString(), "source");
  const plain = await rewrite(shim.url, src, dst);
  assert.equal(plain.status, 200, "a copy without a precondition passes (under the lock)");
  assert.equal(objectOf(dst).data.toString(), "source");
});

test("RACE: N create-only writes of one name at once, each taking 40 ms at the emulator: exactly one is stored and N−1 are refused; straight at the emulator every one is accepted", async () => {
  const N = 8;
  store.writeDelayMs = 40;
  try {
    const name = unique("race");
    const before = shim.stats;
    const bodies = Array.from({ length: N }, (_, i) => `racer-${i}-${randomBytes(3).toString("hex")}`);
    const rows = await Promise.all(bodies.map((b) => upload(shim.url, name, b, "&ifGenerationMatch=0")));
    const statuses = rows.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 1, `one winner: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 412).length, N - 1, `${statuses}`);
    const winner = bodies[statuses.indexOf(200)];
    assert.equal(objectOf(name).data.toString(), winner, "the object holds the winner's bytes");
    const after = shim.stats;
    assert.equal(after.refused - before.refused, N - 1);
    assert.ok(after.waited - before.waited >= N - 1, `every loser waited for the lock (${after.waited - before.waited})`);
    assert.ok(after.maxWaitMs >= 30, `the longest wait (${after.maxWaitMs} ms) covers the winner's write`);
    assert.equal(after.held, 0, "every lock released");

    const copies = unique("race-copy");
    const src = unique("race-src");
    await upload(shim.url, src, "copied");
    const rw = await Promise.all(Array.from({ length: N }, () => rewrite(shim.url, src, copies, "?ifGenerationMatch=0")));
    assert.deepEqual(rw.map((r) => r.status).sort(), [200, ...Array(N - 1).fill(412)], "copies race the same way");

    // NEGATIVE: the emulator itself, with no shim in front: every create-only write is accepted.
    const bare = unique("race-bare");
    const direct = await Promise.all(bodies.map((b) => upload(store.url, bare, b, "&ifGenerationMatch=0")));
    assert.deepEqual(direct.map((r) => r.status), Array(N).fill(200), "the emulator accepts them all, so the last bytes win");
  } finally {
    store.writeDelayMs = 0;
  }
});

test("locks are per object: a slow write of one name does not hold back a write of another; writes of one name go in order", async () => {
  store.writeDelayMs = 150;
  try {
    const a = unique("slow");
    const b = unique("other");
    let release, entered;
    const held = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    store.beforeWrite = async (name) => { if (name === a) { entered(); await held; } };
    const waitedBefore = shim.stats.waited;
    const pa = upload(shim.url, a, "a", "&ifGenerationMatch=0");
    await reached;
    let timer;
    const pb = upload(shim.url, b, "b", "&ifGenerationMatch=0");
    try {
      const rb = await Promise.race([pb, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3_000); })]);
      assert.ok(rb, "another object completes while the first object's write is explicitly held");
      assert.equal(rb.status, 200);
      assert.equal(objectOf(a), null, "the first write is still held, proving overlap");
      assert.equal(shim.stats.waited, waitedBefore, "different objects did not contend for a lock");
    } finally {
      clearTimeout(timer);
      release();
      store.beforeWrite = null;
      await Promise.all([pa, pb]);
    }
    // One name: three plain writes in flight land in the order they came.
    const c = unique("order");
    const order = [];
    await Promise.all(["1", "2", "3"].map(async (v, i) => {
      await sleep(i * 10);
      const r = await upload(shim.url, c, v);
      order.push(v);
      return r;
    }));
    assert.deepEqual(order, ["1", "2", "3"]);
    assert.equal(objectOf(c).data.toString(), "3");
  } finally {
    store.writeDelayMs = 0;
  }
});

test("a client that leaves mid-body while it waits for the lock never holds the object: the next writer goes on as soon as the one before it is done", { timeout: 30_000 }, async () => {
  store.writeDelayMs = 300;
  try {
    const name = unique("leaver");
    const base = store.requests.length;
    const first = upload(shim.url, name, "first");
    await sleep(30);
    const sock = net.connect(shim.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write(`POST /upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${enc(name)} HTTP/1.1\r\nHost: 127.0.0.1:${shim.port}\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\npartial...`);
    await sleep(50);
    sock.destroy();
    await sleep(20);
    const t0 = Date.now();
    const third = await upload(shim.url, name, "third");
    const ms = Date.now() - t0;
    assert.equal((await first).status, 200);
    assert.equal(third.status, 200);
    assert.ok(ms < 2_000, `the next writer finished ${ms} ms after it began, not after a hold timeout`);
    assert.equal(objectOf(name).data.toString(), "third");
    assert.deepEqual(seen(name, base).filter((r) => r.method === "POST").map((r) => r.bytes), [5, 5], "the leaver's partial body never reached the emulator");
    await sleep(20);
    assert.equal(shim.stats.held, 0);
  } finally {
    store.writeDelayMs = 0;
  }
});

// --- passing through ------------------------------------------------------------------------------

test("everything else passes through unchanged: bytes both ways (binary), statuses, the listing, deletes, and the Host header (the emulator's resumable Location names the shim)", async () => {
  const name = unique("bytes");
  const bin = randomBytes(300_000);
  const base = store.requests.length;
  const up = await upload(shim.url, name, bin);
  assert.equal(up.status, 200);
  assert.equal(seen(name, base).find((r) => r.method === "POST").sha, sha(bin), "the body reached the emulator byte for byte");
  const down = await call(shim.url, "GET", `/b/${BUCKET}/o/${enc(name)}?alt=media`);
  assert.equal(down.status, 200);
  assert.equal(sha(down.body), sha(bin), "and came back byte for byte");
  assert.equal(down.headers["content-length"], String(bin.length));
  assert.equal((await call(shim.url, "GET", `/b/${BUCKET}/o/${enc(unique("nothing"))}`)).status, 404, "a 404 passes");
  const list = await call(shim.url, "GET", `/b/${BUCKET}/o?prefix=selftest%2F`);
  assert.equal(list.status, 200);
  assert.ok(list.json.items.some((i) => i.name === name));
  assert.equal((await call(shim.url, "DELETE", `/b/${BUCKET}/o/${enc(name)}`)).status, 204);
  assert.equal(objectOf(name), null);
  const session = await call(shim.url, "POST", `/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&name=${enc(unique("session"))}`, { body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(session.status, 200);
  assert.equal(new URL(session.headers.location).port, String(shim.port), "the session's Location names the shim, so its bytes come back through it");
  assert.ok(store.requests.slice(base).every((r) => r.host === `127.0.0.1:${shim.port}` || r.auth === "Bearer owner"), "forwarded with the client's Host");
});

test("what it cannot judge it refuses (501), a bad generation is 400, and a metadata read that fails is 503: never a forward", async () => {
  const base = store.requests.length;
  const before = shim.stats;
  const r1 = await call(shim.url, "POST", `/upload/storage/v1/b/${BUCKET}/o?uploadType=resumable&name=x&ifGenerationMatch=0`, { body: "{}" });
  assert.equal(r1.status, 501);
  assert.equal(r1.headers["x-e2e-storage-shim"], "unjudged");
  assert.match(r1.json.error.message, /e2e storage shim: cannot judge a resumable upload's ifGenerationMatch/);
  assert.equal((await upload(shim.url, unique("nm"), "x", "&ifMetagenerationMatch=1")).status, 501);
  assert.equal((await call(shim.url, "DELETE", `/b/${BUCKET}/o/x?ifGenerationMatch=3`)).status, 501);
  assert.equal((await upload(shim.url, unique("bad"), "x", "&ifGenerationMatch=zero")).status, 400);
  assert.equal(store.requests.length, base, "none of them reached the emulator");
  store.failMeta = true;
  try {
    const name = unique("blind");
    const r = await upload(shim.url, name, "x", "&ifGenerationMatch=0");
    assert.equal(r.status, 503);
    assert.match(r.json.error.message, /could not judge .*the emulator answered 500 to the metadata read/);
    assert.equal(objectOf(name), null, "not forwarded");
  } finally {
    store.failMeta = false;
  }
  const after = shim.stats;
  assert.deepEqual([after.unjudged - before.unjudged, after.invalid - before.invalid, after.errors - before.errors], [3, 1, 1]);
  assert.equal(after.held, 0);
  assert.ok(SHIM_DECISIONS_KEPT >= 100);
});

// --- the probe and the product's own client ---------------------------------------------------------

test("the readiness probe through the shim finds honoured: true (the capability); straight at the emulator it finds false", async () => {
  const through = await probeStoragePreconditions({ storageUrl: shim.url, bucket: BUCKET, label: "2610131800-sh01", timeoutMs: 3_000 });
  assert.equal(through.honoured, true, JSON.stringify(through));
  assert.equal(through.cleaned, true);
  const direct = await probeStoragePreconditions({ storageUrl: store.url, bucket: BUCKET, label: "2610131800-sh02", timeoutMs: 3_000 });
  assert.equal(direct.honoured, false, "the stand-in, like the emulator, accepts both");
});

test("through firebase-admin's own Storage client (the product's path): a second save(…, CREATE_ONLY) and a copy(…, CREATE_ONLY) onto an existing object reject with code 412; N concurrent saves leave one; without the shim all succeed", async (t) => {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.METADATA_SERVER_DETECTION = "none";
  const { initializeApp, deleteApp } = await import("firebase-admin/app");
  const { getStorage } = await import("firebase-admin/storage");
  const bucketVia = (port, label) => {
    // The SDK reads its endpoint when the client is made: set, make, and leave it.
    process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${port}`;
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = `127.0.0.1:${port}`;
    const app = initializeApp({ projectId: "demo-bikeshed", storageBucket: BUCKET }, `selftest-shim-${label}-${process.pid}`);
    t.after(() => deleteApp(app));
    return getStorage(app).bucket(BUCKET);
  };
  const CREATE_ONLY = { preconditionOpts: { ifGenerationMatch: 0 } };
  const viaShim = bucketVia(shim.port, "shim");
  const direct = bucketVia(store.port, "direct");
  const name = unique("sdk");
  await viaShim.file(name).save(Buffer.from("v1 bytes"), { contentType: "text/html", resumable: false, ...CREATE_ONLY });
  await assert.rejects(viaShim.file(name).save(Buffer.from("loser"), { contentType: "text/html", resumable: false, ...CREATE_ONLY }), (e) => e.code === 412, "isPreconditionFailure(e): e.code === 412");
  assert.equal(objectOf(name).data.toString(), "v1 bytes");
  const dst = unique("sdk-dst");
  await viaShim.file(dst).save(Buffer.from("there"), { resumable: false });
  await assert.rejects(viaShim.file(name).copy(dst, CREATE_ONLY), (e) => e.code === 412);
  assert.equal(objectOf(dst).data.toString(), "there");
  await viaShim.file(name).copy(unique("sdk-new"), CREATE_ONLY);

  store.writeDelayMs = 30;
  try {
    const racers = Array.from({ length: 6 }, (_, i) => Buffer.from(`racer ${i}`));
    const contested = unique("sdk-race");
    const settled = await Promise.allSettled(racers.map((b) => viaShim.file(contested).save(b, { resumable: false, ...CREATE_ONLY })));
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1, settled.map((s) => s.status === "fulfilled" ? "ok" : s.reason.code).join(","));
    assert.ok(settled.filter((s) => s.status === "rejected").every((s) => s.reason.code === 412));
    const bare = unique("sdk-race-bare");
    const unguarded = await Promise.allSettled(racers.map((b) => direct.file(bare).save(b, { resumable: false, ...CREATE_ONLY })));
    assert.equal(unguarded.filter((s) => s.status === "fulfilled").length, 6, "NEGATIVE: straight at the emulator every create-only save succeeds");
  } finally {
    store.writeDelayMs = 0;
  }
});

// --- the preload and the redirect check ------------------------------------------------------------

/** Run node with the preload; print the env the "product" would see. */
function runPreloaded(env, { extraRequire = [], script = null } = {}) {
  const code = script ?? `process.stdout.write(JSON.stringify({ s: process.env.STORAGE_EMULATOR_HOST ?? null, f: process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? null }))`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: [...extraRequire.map((f) => `--require=${f}`), `--require=${STORAGE_SHIM_PRELOAD_SOURCE}`].join(" "), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out || "null")) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

test("the preload moves both Storage hosts onto the shim in a function worker whose hosts name this stack's emulator, and nowhere else; one line per realm says what it did", async () => {
  const log = join(work, `preload-${randomBytes(3).toString("hex")}.jsonl`);
  const up = "127.0.0.1:37008";
  const shimHost = "127.0.0.1:37021";
  const base = { [STORAGE_SHIM_ENV]: shimHost, [STORAGE_SHIM_UPSTREAM_ENV]: up, [STORAGE_SHIM_LOG_ENV]: log };
  const registry = { STORAGE_EMULATOR_HOST: `http://${up}`, FIREBASE_STORAGE_EMULATOR_HOST: up };
  const worker = await runPreloaded({ ...base, ...registry, FUNCTIONS_EMULATOR: "true", FUNCTION_TARGET: "appConfig" });
  assert.deepEqual(worker, { s: `http://${shimHost}`, f: shimHost });
  const cli = await runPreloaded({ ...base, ...registry });
  assert.deepEqual(cli, { s: `http://${up}`, f: up }, "the emulator's own process (no FUNCTIONS_EMULATOR) is left alone");
  const elsewhere = await runPreloaded({ ...base, STORAGE_EMULATOR_HOST: "http://127.0.0.1:9199", FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FUNCTIONS_EMULATOR: "true", FUNCTION_TARGET: "mcp" });
  assert.deepEqual(elsewhere, { s: "http://127.0.0.1:9199", f: "127.0.0.1:9199" }, "a host it does not know is left as it was");
  const none = await runPreloaded({ ...base, FUNCTIONS_EMULATOR: "true", FUNCTION_TARGET: "session" });
  assert.deepEqual(none, { s: null, f: null });
  const bad = await runPreloaded({ ...base, [STORAGE_SHIM_ENV]: "example.com:80", ...registry, FUNCTIONS_EMULATOR: "true", FUNCTION_TARGET: "publish" });
  assert.deepEqual(bad, { s: `http://${up}`, f: up }, "a shim that is not on loopback moves nothing");
  const half = await runPreloaded({ ...base, FIREBASE_STORAGE_EMULATOR_HOST: up, FUNCTIONS_EMULATOR: "true", FUNCTION_TARGET: "fork" });
  assert.deepEqual(half, { s: `http://${shimHost}`, f: shimHost }, "one host set (firebase-admin derives the other from it): both on the shim");
  // A worker thread inherits the moved env: its own line is still a good one.
  const threads = await runPreloaded({ ...base, ...registry, FUNCTIONS_EMULATOR: "true", FUNCTION_TARGET: "thumb" }, {
    script: `const { Worker } = require("node:worker_threads"); const w = new Worker("require('node:worker_threads').parentPort.postMessage(process.env.STORAGE_EMULATOR_HOST)", { eval: true }); w.on("message", (m) => { process.stdout.write(JSON.stringify({ thread: m })); w.terminate(); });`,
  });
  assert.deepEqual(threads, { thread: `http://${shimHost}` });
  const lines = readStorageShimLog(log);
  assert.deepEqual(lines.map((l) => [l.target, l.thread, l.redirected, l.already]), [["appConfig", 0, true, false], ["mcp", 0, false, false], ["session", 0, false, false], ["publish", 0, false, false], ["fork", 0, true, false], ["thumb", 0, true, false], ["thumb", 1, true, true]], "no line from the emulator's own process");
  assert.deepEqual(lines[0].from, registry);
  assert.deepEqual(lines[0].to, { STORAGE_EMULATOR_HOST: `http://${shimHost}`, FIREBASE_STORAGE_EMULATOR_HOST: shimHost });
  assert.match(lines[1].why, /FIREBASE_STORAGE_EMULATOR_HOST is "127\.0\.0\.1:9199", not the stack's Storage emulator/);
  assert.match(lines[2].why, /no Storage emulator host/);
  assert.match(lines[3].why, /127\.0\.0\.1:<port>/);
  assert.deepEqual(readStorageShimLog(join(work, "no-such.jsonl")), []);
});

test("a child that dials Storage as a function worker does, from the emulator's registry env, lands on the shim under the preload and is refused there", async () => {
  const log = join(work, `child-${randomBytes(3).toString("hex")}.jsonl`);
  const name = unique("child");
  await upload(store.url, name, "already there");
  const base = store.requests.length;
  const script = `
    const { initializeApp } = require("firebase-admin/app");
    const { getStorage } = require("firebase-admin/storage");
    const b = getStorage(initializeApp({ projectId: "demo-bikeshed", storageBucket: ${JSON.stringify(BUCKET)} })).bucket(${JSON.stringify(BUCKET)});
    b.file(${JSON.stringify(name)}).save(Buffer.from("loser"), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } })
      .then(() => process.stdout.write(JSON.stringify({ saved: true })), (e) => process.stdout.write(JSON.stringify({ saved: false, code: e.code })));`;
  const env = {
    [STORAGE_SHIM_ENV]: `127.0.0.1:${shim.port}`, [STORAGE_SHIM_UPSTREAM_ENV]: `127.0.0.1:${store.port}`, [STORAGE_SHIM_LOG_ENV]: log,
    STORAGE_EMULATOR_HOST: `http://127.0.0.1:${store.port}`, FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${store.port}`,
    FUNCTIONS_EMULATOR: "true", FUNCTION_TARGET: "publish", METADATA_SERVER_DETECTION: "none", NODE_PATH: join(REPO_ROOT, "node_modules"),
  };
  const r = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { cwd: REPO_ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: `--require=${STORAGE_SHIM_PRELOAD_SOURCE}`, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && out ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`))));
  });
  assert.deepEqual(r, { saved: false, code: 412 });
  assert.equal(objectOf(name).data.toString(), "already there");
  assert.ok(store.requests.slice(base).every((q) => q.method === "GET"), "only the shim's metadata read reached the emulator");
  assert.equal(shimRedirects(readStorageShimLog(log), { shimPort: shim.port, upstreamPort: store.port }).ok, true);
});

test("shimRedirects: ok only with a function worker moved onto the shim and none left elsewhere", () => {
  const good = { pid: 1, thread: 0, target: "appConfig", redirected: true, upstream: "127.0.0.1:37008", to: { STORAGE_EMULATOR_HOST: "http://127.0.0.1:37021", FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:37021" } };
  const o = { shimPort: 37021, upstreamPort: 37008 };
  assert.deepEqual(shimRedirects([good], o), { ok: true, workers: 1, redirected: 1, refused: [], reason: null });
  const none = shimRedirects([], o);
  assert.equal(none.ok, false);
  assert.match(none.reason, /no function worker has started/);
  assert.equal(shimRedirects([{ ...good, target: null }], o).ok, false, "a discovery line (no FUNCTION_TARGET) is no worker");
  assert.equal(shimRedirects([good, { ...good, thread: 2, redirected: false }], o).ok, true, "a worker thread's line is not judged");
  const left = shimRedirects([good, { pid: 2, thread: 0, target: "mcp", redirected: false, why: "FIREBASE_STORAGE_EMULATOR_HOST is …" }], o);
  assert.equal(left.ok, false);
  assert.match(left.reason, /1 function worker\(s\) not pointed at the shim: mcp \(pid 2\)/);
  assert.equal(shimRedirects([{ ...good, to: { ...good.to, STORAGE_EMULATOR_HOST: "http://127.0.0.1:37008" } }], o).ok, false, "both hosts must name the shim");
  assert.equal(shimRedirects([{ ...good, upstream: "127.0.0.1:9199" }], o).ok, false, "from this stack's emulator");
  assert.equal(shimRedirects([good], { shimPort: 37022, upstreamPort: 37008 }).ok, false, "the shim of this stack");
});

test("the stack's copy of the preload and the emulator's env: NODE_OPTIONS keeps the egress guard first", () => {
  const tree = tempDir("e2e-shim-tree-");
  const installed = installStorageShimPreload(tree);
  assert.equal(installed.file, join(tree, STORAGE_SHIM_PRELOAD_IN_TREE));
  assert.equal(installed.sha256, sha(readFileSync(STORAGE_SHIM_PRELOAD_SOURCE)));
  writeFileSync(installed.file, readFileSync(installed.file, "utf8") + "\n// patched\n");
  assert.notEqual(describeStorageShimPreload(installed.file).sha256, installed.sha256, "re-read after a patch set");
  const env = storageShimEnv({ preload: installed.file, shimPort: PORTS.spare7, upstreamPort: PORTS.storage, log: join(tree, "storage-shim.jsonl"), nodeOptions: "--require=/x/.e2e/egress-guard.mjs" });
  assert.deepEqual(env, {
    NODE_OPTIONS: `--require=/x/.e2e/egress-guard.mjs --require=${installed.file}`,
    [STORAGE_SHIM_ENV]: `127.0.0.1:${PORTS.spare7}`,
    [STORAGE_SHIM_UPSTREAM_ENV]: `127.0.0.1:${PORTS.storage}`,
    [STORAGE_SHIM_LOG_ENV]: join(tree, "storage-shim.jsonl"),
  });
  assert.throws(() => storageShimEnv({ preload: join(tree, "a b", "p.mjs"), shimPort: 1, upstreamPort: 2, log: "/x" }), /NODE_OPTIONS/);
  assert.throws(() => storageShimEnv({ preload: installed.file, shimPort: 0, upstreamPort: 2, log: "/x" }), TypeError);
});

// --- options, ports, capabilities, the live status ------------------------------------------------

test("--storage-shim: parses, round-trips, normalizes; spare7 becomes storageShim (and spare8 the aux control port); the capability needs the aux, the role and a proved redirect", () => {
  assert.deepEqual(parseStackOptionArgs(["--storage-shim"]), { emailOff: false, appEnv: {}, storageShim: true });
  assert.deepEqual(parseStackOptionArgs(["--email-off"]), { emailOff: true, appEnv: {} }, "a list without it parses as it always did");
  const both = parseStackOptionArgs(["--rtdb-proxy", "--storage-shim", "--patches", "amplify-mint-join"]);
  assert.deepEqual(parseStackOptionArgs(stackOptionArgs(both)), both);
  assert.equal(normalizeStackOptions({ storageShim: true }).storageShim, true);
  assert.equal(normalizeStackOptions({}).storageShim, false);
  assert.throws(() => parseStackOptionArgs(["--storage-shims"]), /allowed: .*--storage-shim/);

  assert.deepEqual(STORAGE_SHIM_ROLES, { [STORAGE_SHIM_ROLE]: STORAGE_SHIM_SPARE });
  assert.equal(withAuxPorts(PORTS, {}), PORTS, "no option: the block as it was");
  const ports = withAuxPorts(PORTS, { storageShim: true });
  assert.deepEqual([ports.storageShim, ports.gate, ports.spare7, ports.spare8, ports.rtdbProxy, ports.spare9], [PORTS.spare7, PORTS.spare8, undefined, undefined, undefined, PORTS.spare9]);
  const all = withAuxPorts(PORTS, { gates: true, rtdbProxy: true, storageShim: true });
  assert.deepEqual([all.storageShim, all.gate, all.rtdbProxy], [PORTS.spare7, PORTS.spare8, PORTS.spare9]);
  assert.deepEqual(withAuxPorts(PORTS, { gates: true, rtdbProxy: true }), Object.fromEntries(Object.entries(all).filter(([k]) => k !== "storageShim").concat([["spare7", PORTS.spare7]])), "without the shim, exactly as before");
  const pool = sparePorts({ kind: "local", runDir: work, stack: { ports } });
  assert.ok(!pool.includes(PORTS.spare7) && !pool.includes(PORTS.spare8) && pool.length === 7, `the spare pool loses the two (${pool})`);

  const rec = { ports, options: { storageShim: true }, processes: [{ name: "aux" }], aux: { gates: false, proxy: null, storageShim: ports.storageShim }, storageShim: { redirect: { ok: true } } };
  const has = (r) => capabilitiesFor(r).has(STORAGE_SHIM);
  assert.equal(has(rec), true);
  assert.equal(capabilitiesFor(rec).has("gates"), false, "the shim alone runs no gate service");
  assert.equal(has({ ...rec, storageShim: { redirect: null } }), false, "NEGATIVE: no proved redirect");
  assert.equal(has({ ...rec, storageShim: { redirect: { ok: false } } }), false);
  assert.equal(has({ ...rec, processes: [] }), false, "NEGATIVE: no aux process");
  assert.equal(has({ ...rec, aux: { ...rec.aux, storageShim: null } }), false);
  assert.equal(has({ ports: PORTS, options: {} }), false, "an older record");
  const t = localTarget({ ...rec, runId: "2610131800-sh03", runDir: work, projectId: "demo-bikeshed", bucket: BUCKET, logs: {}, treeDir: work, stackDir: work });
  assert.equal(t.options.storageShim, true);
  assert.equal(t.storageUrl, `http://127.0.0.1:${PORTS.storage}`, "storageUrl stays the emulator's");
  assert.equal(t.stack.ports.storageShim, PORTS.spare7);
});

test("storagePreconditionsStatus probes the Storage the functions use: the shim on a --storage-shim stack, the emulator elsewhere", async () => {
  const shimTarget = { kind: "local", runId: "2610131800-sh04", storageUrl: store.url, bucket: BUCKET, options: { storageShim: true }, stack: { ports: { storage: store.port, storageShim: shim.port } } };
  const via = await storagePreconditionsStatus(shimTarget, { timeoutMs: 3_000 });
  assert.deepEqual([via.checked, via.via, via.storageUrl, via.honoured], [true, "shim", shim.url, true]);
  const plain = await storagePreconditionsStatus({ ...shimTarget, options: { storageShim: false } }, { timeoutMs: 3_000 });
  assert.deepEqual([plain.via, plain.storageUrl, plain.honoured], ["emulator", store.url, false]);
  const prod = await storagePreconditionsStatus({ ...shimTarget, kind: "prod" });
  assert.deepEqual([prod.checked, prod.honoured], [false, null], "a production target is never probed, shim or not");
});

// --- the aux process -------------------------------------------------------------------------------

const auxTarget = (aux) => ({ kind: "local", runId: "2610131800-sh05", storageUrl: store.url, capabilities: new Set([STORAGE_SHIM]), stack: { ports: { gate: aux.controlPort, storageShim: aux.storageShim.port, storage: store.port } } });

test("the aux process serves the shim: /health names it, /storage-shim/stats its counters and decisions after a seq, and storageShim(target) reads them", async () => {
  const aux = await startAux({ controlPort: 0, storageShim: { listenPort: 0, upstreamPort: store.port }, log: () => {} });
  try {
    const health = await (await fetch(`http://127.0.0.1:${aux.controlPort}/health`)).json();
    assert.deepEqual(health.storageShim, { port: aux.storageShim.port, upstream: store.port });
    assert.equal(health.proxy, null);
    const client = storageShim(auxTarget(aux));
    assert.deepEqual([client.port, client.url, client.upstreamUrl], [aux.storageShim.port, `http://127.0.0.1:${aux.storageShim.port}`, store.url]);
    const { stats: before } = await client.stats();
    const name = unique("aux");
    await upload(client.url, name, "a", "&ifGenerationMatch=0");
    await upload(client.url, name, "b", "&ifGenerationMatch=0");
    const { stats, decisions, upstream } = await client.stats({ since: before.seq });
    assert.equal(upstream, store.port);
    assert.deepEqual([stats.refused - before.refused, stats.forwarded - before.forwarded], [1, 1]);
    assert.deepEqual(decisions.map((d) => d.decision), ["forward", "refuse"]);
    assert.deepEqual((await client.stats({ since: stats.seq })).decisions, [], "nothing after the last seq");
    assert.equal((await fetch(`http://127.0.0.1:${aux.controlPort}/storage-shim/stats?since=x`)).status, 400);
    await assert.rejects(client.stats({ since: -1 }), TypeError);
  } finally {
    await aux.close();
  }
  const plain = await startAux({ controlPort: 0, log: () => {} });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${plain.controlPort}/storage-shim/stats`)).status, 404);
    assert.equal((await (await fetch(`http://127.0.0.1:${plain.controlPort}/health`)).json()).storageShim, null);
  } finally {
    await plain.close();
  }
  assert.throws(() => storageShim({ kind: "local", runId: "r", capabilities: new Set() }), (e) => e.code === "E2E_CAPABILITY" && /--storage-shim/.test(e.message));
  assert.throws(() => storageShim({ kind: "prod", capabilities: new Set([STORAGE_SHIM]) }), (e) => e.code === "E2E_CAPABILITY");
});

async function freePorts(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    out.push(s.address().port);
    await new Promise((r) => s.close(r));
  }
  return out;
}

test("stackaux.mjs as a process with --storage-shim: answers /health with the shim, refuses a second create-only write through it, exits on SIGTERM", async () => {
  const [control, port] = await freePorts(2);
  const child = spawn(process.execPath, [join(LIB, "stackaux.mjs"), "--control", String(control), "--storage-shim", String(port), "--storage-upstream", String(store.port)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  try {
    let health = null;
    for (let i = 0; i < 100 && !health; i += 1) {
      try {
        health = await (await fetch(`http://127.0.0.1:${control}/health`)).json();
      } catch {
        await sleep(50);
      }
    }
    assert.ok(health, `no /health from the aux process: ${out}`);
    assert.deepEqual(health.storageShim, { port, upstream: store.port });
    const name = unique("proc");
    assert.equal((await upload(`http://127.0.0.1:${port}`, name, "a", "&ifGenerationMatch=0")).status, 200);
    assert.equal((await upload(`http://127.0.0.1:${port}`, name, "b", "&ifGenerationMatch=0")).status, 412);
    assert.match(out, /"kind":"storage-shim","decision":"refuse"/, "the refusal is a line of the aux log");
    const code = await new Promise((resolve) => {
      child.once("exit", (c) => resolve(c));
      child.kill("SIGTERM");
    });
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

// --- pins ------------------------------------------------------------------------------------------

test("stack.mjs: --storage-shim reaches the ports, the aux, the emulator's env and readiness, which probes the preconditions THROUGH the shim after proving the workers dial it", () => {
  const src = readFileSync(join(LIB, "stack.mjs"), "utf8");
  assert.match(src, /const options = normalizeStackOptions\(\{ emailOff, appEnv, rtdbProxy, gates, storageShim \}\);/);
  assert.match(src, /withAuxPorts\(block\.named, \{ gates: options\.gates, rtdbProxy: options\.rtdbProxy, storageShim: options\.storageShim \}\)/);
  assert.match(src, /storageShim: options\.storageShim \? ports\.storageShim : null \}/, "rec.aux names the shim's port");
  assert.match(src, /\.\.\.\(rec\.aux\.storageShim \? \["--storage-shim", String\(ports\.storageShim\), "--storage-upstream", String\(ports\.storage\)\] : \[\]\)/, "the aux is told where the emulator is");
  assert.match(src, /if \(options\.storageShim\) installStorageShimPreload\(rec\.treeDir\);\n {4}rec\.patches = \[\];/, "the preload goes in before the patch sets");
  assert.match(src, /if \(rec\.storageShim\) Object\.assign\(emuSet, storageShimEnv\(\{ preload: rec\.storageShim\.preload\.file, shimPort: ports\.storageShim, upstreamPort: ports\.storage, log: rec\.logs\.storageShim, nodeOptions: guarded\.NODE_OPTIONS \}\)\);/);
  assert.ok(src.indexOf("Object.assign(emuSet, storageShimEnv(") < src.indexOf("const emu = spawnDetached(firebaseBin,"), "before the emulator starts");
  const ready = src.slice(src.indexOf("export async function waitReady("), src.indexOf("/** The shim's dummy key"));
  const config = ready.indexOf("marks.config = Date.now() - t0;");
  const redirect = ready.indexOf("shimRedirects(readStorageShimLog(rec.logs.storageShim)");
  const probe = ready.indexOf("probeStoragePreconditions(");
  assert.ok(config > 0 && redirect > config && probe > redirect, "after /config (a worker exists), then the probe");
  assert.match(ready, /probeStoragePreconditions\(\{ storageUrl: u\(rec\.aux\?\.storageShim \? p\.storageShim : p\.storage\), bucket: rec\.bucket, label: rec\.runId \}\)/);
  assert.match(ready, /\(!rec\.aux\.storageShim \|\| body\?\.storageShim\?\.port === p\.storageShim\)/, "the aux's /health names the shim");
  assert.match(ready, /if \(r\.refused\.length > 0\) throw new Error/, "a worker left on the emulator fails the start at once");
  const run = readFileSync(join(LIB, "..", "run.mjs"), "utf8");
  assert.equal((run.match(/"storage-shim": \{ type: "boolean", default: false \}/g) ?? []).length, 2, "run and stack up take it");
  assert.match(run, /storageShim: values\["storage-shim"\], jvmHeap/);
  assert.match(run, /\n {8}storageShim: values\["storage-shim"\],\n {8}jvmHeap,/);
  assert.match(run, /if \(values\.attach && values\["storage-shim"\]\) fail\(/);
});

test("the installed firebase-tools hands a worker its Storage hosts after the functions' .env.local, from its registry, and the CLI's own env with them (why the preload, not a dotenv line)", async (t) => {
  const firebase = firebaseTools({ optional: true });
  if (!firebase) return t.skip("firebase-tools is not installed here");
  t.diagnostic(`firebase-tools ${firebase.version}: ${firebase.bin}`);
  const judge = ({ runtimeEnv, spawned }) => {
    assert.equal(runtimeEnv.STORAGE_EMULATOR_HOST, `http://${PROBE_STORAGE_HOST}`, "the registry's Storage host replaces dotenv");
    assert.equal(runtimeEnv.FIREBASE_STORAGE_EMULATOR_HOST, PROBE_STORAGE_HOST, "both Storage hosts come from the registry");
    assert.equal(runtimeEnv.FROM_DOTENV, "kept", "unrelated user env survives");
    assert.equal(runtimeEnv.FUNCTIONS_EMULATOR, "true", "the worker is marked as an emulator");
    assert.equal(spawned.length, 1, "one worker was requested");
    const env = spawned[0].options.env;
    assert.equal(env.STORAGE_EMULATOR_HOST, `http://${PROBE_STORAGE_HOST}`, "runtime env wins over the parent's Storage host");
    assert.equal(env.NODE_OPTIONS, PROBE_PARENT_ENV.NODE_OPTIONS, "the worker inherits the preload");
    assert.equal(env.E2E_STORAGE_SHIM_HOST, PROBE_PARENT_ENV.E2E_STORAGE_SHIM_HOST, "the worker inherits the shim's host");
  };
  judge(await firebaseBehavior(firebase.root));
  const source = readFileSync(join(firebase.root, "lib", "emulator", "functionsEmulator.js"), "utf8");
  const noRegistry = source.replace("getRuntimeEnvs(backend, trigger) {", "getRuntimeEnvs(backend, trigger) { return this.getUserEnvs(backend);");
  assert.notEqual(noRegistry, source, "the env-order control was planted");
  const lostRegistry = await firebaseBehavior(firebase.root, { source: noRegistry });
  assert.throws(() => judge(lostRegistry), /the registry's Storage host replaces dotenv/, "NEGATIVE: dotenv winning is detected");
  const noParent = source.replaceAll("process.env", "({})");
  assert.notEqual(noParent, source, "the inheritance control was planted");
  const lostParent = await firebaseBehavior(firebase.root, { source: noParent });
  assert.throws(() => judge(lostParent), /the worker inherits the preload/, "NEGATIVE: dropping the parent env is detected");
});

test("the product's Storage SDK dials what the shim routes: its endpoint is STORAGE_EMULATOR_HOST itself, a simple upload POSTs /upload/storage/v1/b/<b>/o?name=, a copy POSTs …/rewriteTo/b/<b>/o/<n>?ifGenerationMatch=", (t) => {
  const dir = join(REPO_ROOT, "functions", "node_modules", "@google-cloud", "storage", "build", "cjs", "src");
  if (!existsSync(join(dir, "file.js"))) return t.skip("functions/node_modules has no @google-cloud/storage");
  const file = readFileSync(join(dir, "file.js"), "utf8");
  const storage = readFileSync(join(dir, "storage.js"), "utf8");
  assert.match(storage, /const baseUrl = EMULATOR_HOST \|\| `\$\{options\.apiEndpoint\}\/storage\/v1`;/);
  assert.match(file, /const uri = `\$\{apiEndpoint\}\/upload\/storage\/v1\/b\/\$\{bucketName\}\/o`;\s*const reqOpts = \{\s*qs: \{\s*name: this\.name,/);
  assert.match(file, /Object\.assign\(reqOpts\.qs, this\.instancePreconditionOpts, options\.preconditionOpts\);/, "the precondition goes in the query");
  assert.match(file, /query\.ifGenerationMatch = \(_b = options\.preconditionOpts\) === null \|\| _b === void 0 \? void 0 : _b\.ifGenerationMatch;/);
  assert.match(file, /uri: `\/rewriteTo\/b\/\$\{destBucket\.name\}\/o\/\$\{encodeURIComponent\(newFile\.name\)\}`,/);
  const pkg = JSON.parse(readFileSync(join(dir, "..", "..", "..", "package.json"), "utf8"));
  t.diagnostic(`@google-cloud/storage ${pkg.version}`);
});

test("the README documents --storage-shim, its capability and storageShim(target)", () => {
  const readme = readFileSync(join(HERE, "..", "README.md"), "utf8");
  // assert.ok, not match: a failing match prints the whole README.
  for (const [re, what] of [
    [/\| `--storage-shim` \|/, "the stack options table"],
    [/`storageShim\(target, \{fetchImpl\}\)` → `\{port, url, controlUrl, upstreamUrl, stats\(\{since\}\)\}`/, "the client's signature"],
    [/`startStorageShim\(\{listenPort = 0, host = "127\.0\.0\.1", upstreamPort, upstreamHost = "127\.0\.0\.1", metaTimeoutMs = 10000, holdMaxMs = 120000, log\}\)`/, "the shim's signature"],
    [/`storage-shim` \(/, "the capabilities list"],
    [/node e2e\/run\.mjs run --suite concurrency --storage-shim/, "how to run a case that needs storage-preconditions"],
  ]) assert.ok(re.test(readme), `README: ${what} (${re})`);
});
