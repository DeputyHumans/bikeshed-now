// SPDX-License-Identifier: Apache-2.0
// Self-test: the Storage create-only probe (ifGenerationMatch=0 on a write and on a copy), its readiness record, and the capability storage-preconditions only when both are refused (SPEC §4, §12, §21).

/**
 * A stand-in Storage JSON API on a loopback port (port 0) in one of four
 * modes: `honour` refuses a create-only write or rewrite onto an object that
 * exists (412, as Cloud Storage does), `ignore` accepts both (as the Storage
 * emulator of firebase-tools 15.25.1 does), `write-only` honours the write but
 * not the copy, `lie` answers 412 and overwrites anyway; `broken` answers 500
 * to every upload. What the probe must decide for each, that it cleans up
 * after itself, that it only ever writes to a loopback emulator, and that
 * the capability follows `honoured === true` alone. Pins: waitReady records
 * the probe without ever failing on it, and the installed emulator has no
 * generation preconditions (the README's claim).
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { capabilitiesFor } from "../lib/options.mjs";
import {
  STORAGE_ADMIN_BEARER, STORAGE_PRECONDITIONS, STORAGE_PROBE_PREFIX, probeStoragePreconditions, storagePreconditionsLine, storagePreconditionsStatus,
} from "../lib/storage-preconditions.mjs";

const STACK_SRC = fileURLToPath(new URL("../lib/stack.mjs", import.meta.url));
const BUCKET = "demo-bikeshed-content";

/** A stand-in Storage JSON API; `mode` may be changed between probes. */
function fakeStorage() {
  const objects = new Map();
  const requests = [];
  const s = { mode: "honour", objects, requests };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const q = Object.fromEntries(u.searchParams);
      requests.push({ method: req.method, path: u.pathname, query: q, auth: req.headers.authorization ?? null });
      const body = Buffer.concat(chunks).toString("utf8");
      const send = (status, text = "") => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(text);
      };
      let m = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname);
      if (req.method === "POST" && m) {
        if (s.mode === "broken") return send(500, "{}");
        const key = `${decodeURIComponent(m[1])}/${q.name}`;
        const createOnly = q.ifGenerationMatch === "0";
        const refuse = createOnly && objects.has(key) && (s.mode === "honour" || s.mode === "write-only" || s.mode === "lie");
        if (refuse && s.mode === "lie") objects.set(key, body);
        if (refuse) return send(412, '{"error":{"code":412}}');
        objects.set(key, body);
        return send(200, JSON.stringify({ name: q.name }));
      }
      m = /^\/b\/([^/]+)\/o\/([^/]+)\/rewriteTo\/b\/([^/]+)\/o\/([^/]+)$/.exec(u.pathname);
      if (req.method === "POST" && m) {
        const from = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
        const to = `${decodeURIComponent(m[3])}/${decodeURIComponent(m[4])}`;
        if (!objects.has(from)) return send(404, "{}");
        const createOnly = q.ifGenerationMatch === "0";
        const refuse = createOnly && objects.has(to) && (s.mode === "honour" || s.mode === "lie");
        if (refuse && s.mode === "lie") objects.set(to, objects.get(from));
        if (refuse) return send(412, '{"error":{"code":412}}');
        objects.set(to, objects.get(from));
        return send(200, JSON.stringify({ done: true }));
      }
      m = /^\/b\/([^/]+)\/o\/([^/]+)$/.exec(u.pathname);
      if (m) {
        const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
        if (req.method === "GET") {
          if (!objects.has(key)) return send(404, "{}");
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end(objects.get(key));
        }
        if (req.method === "DELETE") {
          if (!objects.has(key)) return send(404, "{}");
          objects.delete(key);
          return send(204);
        }
      }
      send(501, "{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      s.url = `http://127.0.0.1:${server.address().port}`;
      s.port = server.address().port;
      s.close = () => new Promise((r) => server.close(r));
      resolve(s);
    });
  });
}

const store = await fakeStorage();
after(() => store.close());

const probe = (o = {}) => probeStoragePreconditions({ storageUrl: store.url, bucket: BUCKET, label: "2610131200-sp01", timeoutMs: 2_000, ...o });
const since = (n) => store.requests.slice(n);

test("Storage that refuses a second create-only write and copy (Cloud Storage): honoured, every create-only request said ifGenerationMatch=0 as the emulator's admin, and nothing is left", async () => {
  store.mode = "honour";
  const base = store.requests.length;
  const r = await probe();
  assert.equal(r.honoured, true, JSON.stringify(r));
  assert.equal(r.reason, null);
  assert.deepEqual({ first: r.write.first, second: r.write.second, after: r.write.after, refused: r.write.refused, kept: r.write.kept, honoured: r.write.honoured }, { first: 200, second: 412, after: "first", refused: true, kept: true, honoured: true });
  assert.deepEqual({ rewrite: r.copy.rewrite, after: r.copy.after, honoured: r.copy.honoured }, { rewrite: 412, after: "destination", honoured: true });
  assert.ok(r.prefix.startsWith(`${STORAGE_PROBE_PREFIX}/2610131200-sp01-`), r.prefix);
  assert.equal(r.cleaned, true);
  assert.deepEqual(r.left, []);
  assert.equal(store.objects.size, 0, "every probe object deleted");
  const reqs = since(base);
  assert.ok(reqs.every((q) => q.auth === STORAGE_ADMIN_BEARER), "as the emulator's admin");
  const creates = reqs.filter((q) => q.method === "POST");
  assert.equal(creates.length, 5, "four uploads and one rewrite");
  assert.ok(creates.every((q) => q.query.ifGenerationMatch === "0"), "every write and the copy are create-only");
  assert.ok(reqs.filter((q) => q.method === "POST" && q.path.startsWith("/upload/")).every((q) => q.query.uploadType === "media" && q.query.name.startsWith(r.prefix + "/")));
  assert.match(storagePreconditionsLine(r), /refuses a second create-only write and copy \(412\)/);
});

test("Storage that ignores ifGenerationMatch (the emulator): not honoured, both accepted, the reason says so, and nothing is left", async () => {
  store.mode = "ignore";
  const r = await probe();
  assert.equal(r.honoured, false);
  assert.equal(r.write.second, 200);
  assert.equal(r.write.after, "second");
  assert.equal(r.copy.rewrite, 200);
  assert.equal(r.copy.after, "source");
  assert.match(r.reason, /write: a second create-only write onto an existing object was accepted \(200\), and the object now reads "second"/);
  assert.match(r.reason, /copy: a second create-only copy onto an existing object was accepted \(200\)/);
  assert.equal(store.objects.size, 0);
  assert.match(storagePreconditionsLine(r), /does NOT honour create-only writes \(no capability storage-preconditions\)/);
});

test("a write honoured but a copy accepted is not honoured: CREATE_ONLY covers forks' copies too", async () => {
  store.mode = "write-only";
  const r = await probe();
  assert.equal(r.write.honoured, true);
  assert.equal(r.copy.honoured, false);
  assert.equal(r.honoured, false);
  assert.equal(store.objects.size, 0);
});

test("a 412 that still replaced the object, a refused set-up write, or no Storage at all: the probe cannot tell (null), never throws, and cleans what it made", async () => {
  store.mode = "lie";
  const lie = await probe();
  assert.equal(lie.honoured, null, JSON.stringify(lie));
  assert.match(lie.reason, /refused with 412, yet the object reads "second", not "first"/);
  assert.equal(store.objects.size, 0);

  store.mode = "broken";
  const broken = await probe();
  assert.equal(broken.honoured, null);
  assert.match(broken.reason, /write: a set-up write answered 500/);
  assert.equal(broken.cleaned, true, "a 404 on cleanup is an object never made");

  const closed = await fakeStorage();
  const port = closed.port;
  await closed.close();
  const gone = await probeStoragePreconditions({ storageUrl: `http://127.0.0.1:${port}`, bucket: BUCKET, label: null, timeoutMs: 1_000 });
  assert.equal(gone.honoured, null);
  assert.match(gone.reason, /set-up write answered 0/);
  assert.equal(gone.cleaned, false, "it could not delete on an unreachable Storage, and says so");
  assert.equal(gone.left.length, 3);
  assert.match(storagePreconditionsLine(gone), /could not be probed/);
});

test("it writes only to a loopback emulator: any other Storage, a bad bucket or label is a TypeError before any request", async () => {
  const base = store.requests.length;
  const prodHost = ["storage", "googleapis", "com"].join(".");
  for (const storageUrl of [`https://${prodHost}`, "http://10.0.0.5:9199", `${store.url}/storage/v1`, "not a url", undefined]) {
    await assert.rejects(probeStoragePreconditions({ storageUrl, bucket: BUCKET }), TypeError, String(storageUrl));
  }
  await assert.rejects(probeStoragePreconditions({ storageUrl: store.url, bucket: "" }), TypeError);
  await assert.rejects(probeStoragePreconditions({ storageUrl: store.url, bucket: BUCKET, label: "a/b" }), TypeError);
  await assert.rejects(probeStoragePreconditions({ storageUrl: store.url, bucket: BUCKET, timeoutMs: 0 }), TypeError);
  assert.equal(store.requests.length, base, "nothing was sent");
});

test("the capability: only a record whose probe found both refused (honoured === true)", () => {
  const has = (storagePreconditions) => capabilitiesFor({ storagePreconditions }).has(STORAGE_PRECONDITIONS);
  assert.equal(has({ honoured: true }), true);
  for (const v of [{ honoured: false }, { honoured: null }, { honoured: "true" }, { honoured: 1 }, {}, null, undefined]) assert.equal(has(v), false, JSON.stringify(v));
  assert.equal(capabilitiesFor({}).has(STORAGE_PRECONDITIONS), false, "a record from before the probe: no capability");
});

test("storagePreconditionsStatus: live on a local stack's own Storage port; never on any other target or port", async () => {
  store.mode = "ignore";
  const local = { kind: "local", runId: "2610131200-sp02", storageUrl: store.url, bucket: BUCKET, stack: { ports: { storage: store.port } } };
  const s = await storagePreconditionsStatus(local);
  assert.equal(s.checked, true);
  assert.equal(s.honoured, false);
  const base = store.requests.length;
  const prod = await storagePreconditionsStatus({ kind: "prod", runId: "2610131200-sp03", bucket: BUCKET });
  assert.deepEqual({ checked: prod.checked, honoured: prod.honoured }, { checked: false, honoured: null });
  assert.match(prod.reason, /only a local stack's Storage emulator is probed/);
  await assert.rejects(storagePreconditionsStatus({ ...local, stack: { ports: { storage: store.port + 1 } } }), /is not one of run 2610131200-sp02's ports/);
  assert.equal(store.requests.length, base, "nothing was sent for the other target or port");
});

test("waitReady probes after the stack is otherwise ready, records rec.storagePreconditions, and a probe that throws never fails a start", () => {
  const src = readFileSync(STACK_SRC, "utf8");
  const ready = src.slice(src.indexOf("export async function waitReady("), src.indexOf("/** The shim's dummy key"));
  assert.ok(ready.length > 0, "waitReady found");
  const at = ready.indexOf("probeStoragePreconditions(");
  assert.ok(at > ready.indexOf("marks.mail = Date.now() - t0;"), "after the mail round trip");
  // The Storage the functions use: the shim on a --storage-shim stack (lib/storage-shim.mjs), else the emulator.
  assert.match(ready, /try \{\n {4}rec\.storagePreconditions = await probeStoragePreconditions\(\{ storageUrl: u\(rec\.aux\?\.storageShim \? p\.storageShim : p\.storage\), bucket: rec\.bucket, label: rec\.runId \}\);\n {2}\} catch \(err\) \{\n {4}rec\.storagePreconditions = \{ honoured: null,/);
  assert.match(src, /^import \{ probeStoragePreconditions, storagePreconditionsLine \} from "\.\/storage-preconditions\.mjs";$/m);
  assert.ok(src.indexOf("rec.ready = await waitReady(rec, { log });") < src.indexOf("const target = localTarget(rec);"), "the target (and its capabilities) is made after readiness");
});

test("the installed Storage emulator has no generation preconditions (the README's claim; a firebase-tools that adds them makes the probe find honoured)", (t) => {
  let bin;
  try {
    bin = realpathSync(execFileSync("/usr/bin/which", ["firebase"], { encoding: "utf8" }).trim());
  } catch {
    t.skip("firebase-tools is not installed here");
    return;
  }
  let root = dirname(bin);
  while (root !== dirname(root) && !existsSync(join(root, "package.json"))) root = dirname(root);
  const dir = join(root, "lib", "emulator", "storage");
  if (!existsSync(dir)) {
    t.skip(`no ${dir}`);
    return;
  }
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".js")) files.push(join(d, e.name));
    }
  };
  walk(dir);
  assert.ok(files.length > 5, `the emulator's sources (${files.length})`);
  const hits = files.filter((f) => /ifGenerationMatch|ifMetagenerationMatch/.test(readFileSync(f, "utf8")));
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  t.diagnostic(`firebase-tools ${version}: ${files.length} storage emulator file(s), ${hits.length} naming a generation precondition`);
  assert.deepEqual(hits, [], `firebase-tools ${version}'s Storage emulator now handles generation preconditions: the probe decides the capability by itself, but README "Capabilities" and lib/storage-preconditions.mjs say it has none`);
});
