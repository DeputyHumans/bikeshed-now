// SPDX-License-Identifier: Apache-2.0
// Self-test: listObjects with {meta: true} lists each object's generation, metageneration, md5 and size, so a rewrite in place shows; without it, names as before (SPEC §6a, §12).

/**
 * Hermetic. A stand-in Bucket (getFiles over an in-memory store whose saves
 * stamp a generation, as Storage does) shows what the rows are for: a save
 * of the same bytes and a delete followed by a save leave the NAME list as
 * it was and change the generation. The real SDK path is firebase-admin's
 * own Storage client (getStorage(app).bucket(), as adminFor builds it)
 * pointed at a stand-in Storage JSON API on a loopback port (port 0), which
 * answers in two pages: every page read, each item's metadata taken from the
 * listing. Pins: the installed Storage emulator stamps generations with its
 * millisecond clock and lists the four fields as the rows read them (the
 * README's claim), and the README states the export.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listObjects } from "../lib/admin.mjs";

const README = fileURLToPath(new URL("../README.md", import.meta.url));
const TARGET = Object.freeze({ kind: "local", runId: "2610131900-objm" });
const BUCKET = "demo-bikeshed-content";
const md5 = (bytes) => createHash("md5").update(bytes).digest("base64");

/** An in-memory bucket: save/remove/setMetadata stamp generation and metageneration; getFiles lists as the SDK's File objects carry it. */
function fakeBucket({ clock }) {
  const objects = new Map();
  const calls = [];
  return {
    calls,
    save(name, bytes) {
      objects.set(name, { generation: String(clock()), metageneration: "1", md5Hash: md5(bytes), size: String(Buffer.byteLength(bytes)) });
    },
    remove(name) {
      objects.delete(name);
    },
    setMetadata(name) {
      const o = objects.get(name);
      o.metageneration = String(Number(o.metageneration) + 1);
    },
    async getFiles(query) {
      calls.push(structuredClone(query));
      const files = [...objects.entries()].filter(([name]) => name.startsWith(query.prefix ?? "")).map(([name, m]) => ({ name, metadata: { kind: "storage#object", name, bucket: BUCKET, ...m } }));
      return [files.reverse(), null, {}];
    },
  };
}

/** A bucket whose getFiles answers exactly these File objects. */
function listing(files) {
  const calls = [];
  return { calls, async getFiles(query) { calls.push(structuredClone(query)); return [files, null, {}]; } };
}

test("without meta, listObjects is what it was: the names, sorted, from one getFiles({prefix})", async () => {
  const b = listing([{ name: "docs/d/draft/z.css", metadata: { generation: "3" } }, { name: "docs/d/draft/B.html", metadata: { generation: "1" } }, { name: "docs/d/draft/a.html", metadata: { generation: "2" } }]);
  assert.deepEqual(await listObjects(TARGET, "docs/d/draft/", { bucket: b }), ["docs/d/draft/B.html", "docs/d/draft/a.html", "docs/d/draft/z.css"]);
  assert.deepEqual(await listObjects(TARGET, "docs/d/draft/", { bucket: b, meta: false }), ["docs/d/draft/B.html", "docs/d/draft/a.html", "docs/d/draft/z.css"]);
  assert.deepEqual(b.calls, [{ prefix: "docs/d/draft/" }, { prefix: "docs/d/draft/" }], "one getFiles each, with the prefix alone");
});

test("meta: each object as {name, generation, metageneration, md5, size}, in the names' order", async () => {
  const b = listing([
    { name: "p/é.txt", metadata: { generation: "1760000000000003", metageneration: "2", md5Hash: "q1w2e3==", size: "12" } },
    { name: "p/B.txt", metadata: { generation: 1760000000001, metageneration: 1, md5Hash: "", size: 0 } },
    { name: "p/a.txt", metadata: { generation: "17", size: "x" } },
  ]);
  const rows = await listObjects(TARGET, "p/", { bucket: b, meta: true });
  assert.deepEqual(rows, [
    { name: "p/B.txt", generation: "1760000000001", metageneration: "1", md5: null, size: 0 },
    { name: "p/a.txt", generation: "17", metageneration: null, md5: null, size: null },
    { name: "p/é.txt", generation: "1760000000000003", metageneration: "2", md5: "q1w2e3==", size: 12 },
  ]);
  assert.deepEqual(rows.map((r) => r.name), await listObjects(TARGET, "p/", { bucket: b }), "the same order as the name list (UTF-16 code units)");
  assert.deepEqual(b.calls, [{ prefix: "p/" }, { prefix: "p/" }], "the same single getFiles({prefix})");
});

test("a save of the same bytes and a delete then a save: the names stand still, the generations move, untouched objects compare equal", async () => {
  let ms = 1_760_000_000_000;
  const b = fakeBucket({ clock: () => (ms += 7) });
  b.save("docs/d/draft/index.html", "<p>one</p>");
  b.save("docs/d/draft/style.css", "p{}");
  b.save("docs/d/v1/index.html", "<p>v1</p>");
  const names0 = await listObjects(TARGET, "docs/d/draft/", { bucket: b });
  const meta0 = await listObjects(TARGET, "docs/d/draft/", { bucket: b, meta: true });
  assert.deepEqual(await listObjects(TARGET, "docs/d/draft/", { bucket: b, meta: true }), meta0, "nothing written: equal");

  b.save("docs/d/draft/index.html", "<p>one</p>");
  assert.deepEqual(await listObjects(TARGET, "docs/d/draft/", { bucket: b }), names0, "the name list cannot see a rewrite");
  const meta1 = await listObjects(TARGET, "docs/d/draft/", { bucket: b, meta: true });
  assert.notDeepEqual(meta1, meta0, "a save of the same bytes shows");
  assert.equal(meta1[0].md5, meta0[0].md5, "same bytes, same md5");
  assert.ok(BigInt(meta1[0].generation) > BigInt(meta0[0].generation), "a later generation");
  assert.deepEqual(meta1[1], meta0[1], "the object not written is equal");

  b.remove("docs/d/draft/style.css");
  b.save("docs/d/draft/style.css", "p{}");
  assert.deepEqual(await listObjects(TARGET, "docs/d/draft/", { bucket: b }), names0, "nor a delete then a save");
  const meta2 = await listObjects(TARGET, "docs/d/draft/", { bucket: b, meta: true });
  assert.notEqual(meta2[1].generation, meta1[1].generation, "a delete then a save shows");

  b.setMetadata("docs/d/draft/index.html");
  const meta3 = await listObjects(TARGET, "docs/d/draft/", { bucket: b, meta: true });
  assert.deepEqual([meta3[0].generation, meta3[0].metageneration], [meta2[0].generation, "2"], "a metadata-only update moves metageneration alone");
});

test("an object listed with no generation throws E2E_STORAGE_META; a bad meta or bucket is a TypeError before anything is listed", async () => {
  for (const generation of [undefined, null, "", "abc", -1, 1.5]) {
    const b = listing([{ name: "p/a", metadata: { generation: "1" } }, { name: "p/b", metadata: generation === undefined ? {} : { generation } }]);
    await assert.rejects(listObjects(TARGET, "p/", { bucket: b, meta: true }), (err) => {
      assert.equal(err.code, "E2E_STORAGE_META");
      assert.equal(err.object, "p/b");
      assert.match(err.message, /^listObjects: p\/b was listed with no generation \(.*\): a comparison by generation would hold for nothing$/);
      return true;
    }, `generation ${JSON.stringify(generation)}`);
    assert.deepEqual(await listObjects(TARGET, "p/", { bucket: b }), ["p/a", "p/b"], "the name list does not care");
  }
  const noMeta = listing([{ name: "p/a" }]);
  await assert.rejects(listObjects(TARGET, "p/", { bucket: noMeta, meta: true }), { code: "E2E_STORAGE_META" });

  const b = listing([]);
  for (const meta of ["true", 1, null]) await assert.rejects(listObjects(TARGET, "p/", { bucket: b, meta }), TypeError, `meta ${JSON.stringify(meta)}`);
  for (const bucket of [{}, 5, "bucket"]) await assert.rejects(listObjects(TARGET, "p/", { bucket, meta: true }), TypeError);
  assert.equal(b.calls.length, 0, "nothing listed");
});

// --- firebase-admin's own Storage client against a stand-in JSON API --------------------------

/** A stand-in Storage JSON API: GET …/b/<bucket>/o?prefix&pageToken, two items per page. */
async function standInJsonApi(items, { pageSize = 2 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization ?? null });
    const m = /\/b\/([^/]+)\/o$/.exec(u.pathname);
    if (req.method !== "GET" || !m || decodeURIComponent(m[1]) !== BUCKET) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"code":404}}');
      return;
    }
    const prefix = u.searchParams.get("prefix") ?? "";
    const all = items.filter((i) => i.name.startsWith(prefix)).sort((a, b) => (a.name < b.name ? -1 : 1));
    const from = Number(u.searchParams.get("pageToken") ?? 0);
    const page = all.slice(from, from + pageSize);
    const body = { kind: "storage#objects", items: page.map((i) => ({ kind: "storage#object", bucket: BUCKET, id: `${BUCKET}/${i.name}/${i.generation}`, ...i })) };
    if (from + pageSize < all.length) body.nextPageToken = String(from + pageSize);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { requests, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test("through firebase-admin's Storage client: every page is read and each row comes from the listing's metadata", async (t) => {
  const items = [
    { name: "docs/d/draft/a.html", generation: "1760000000000101", metageneration: "1", md5Hash: md5("a"), size: "1" },
    { name: "docs/d/draft/b.css", generation: "1760000000000102", metageneration: "3", md5Hash: md5("bb"), size: "2" },
    { name: "docs/d/draft/c.js", generation: "1760000000000103", metageneration: "1", md5Hash: md5("ccc"), size: "3" },
    { name: "docs/d/draft/d.svg", generation: "1760000000000104", metageneration: "1", md5Hash: md5("dddd"), size: "4" },
    { name: "docs/d/draft/e.png", generation: "1760000000000105", metageneration: "1", md5Hash: md5("eeeee"), size: "5" },
    { name: "docs/d/v1/index.html", generation: "1760000000000001", metageneration: "1", md5Hash: md5("v1"), size: "2" },
  ];
  const api = await standInJsonApi(items);
  after(() => api.close());
  // The SDK reads its endpoint from the environment when the client is made; this file runs in a process of its own.
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${api.port}`;
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = `127.0.0.1:${api.port}`;
  const { initializeApp, deleteApp } = await import("firebase-admin/app");
  const { getStorage } = await import("firebase-admin/storage");
  const app = initializeApp({ projectId: "demo-bikeshed", storageBucket: BUCKET }, `selftest-objects-meta-${process.pid}`);
  t.after(() => deleteApp(app));
  const bucket = getStorage(app).bucket(BUCKET);

  const rows = await listObjects(TARGET, "docs/d/draft/", { bucket, meta: true });
  assert.deepEqual(rows, items.slice(0, 5).map((i) => ({ name: i.name, generation: i.generation, metageneration: i.metageneration, md5: i.md5Hash, size: Number(i.size) })));
  const lists = api.requests.filter((r) => r.method === "GET");
  assert.deepEqual(lists.map((r) => r.query.pageToken ?? null), [null, "2", "4"], "three pages, each from the last one's token");
  assert.ok(lists.every((r) => r.query.prefix === "docs/d/draft/"), "the prefix on every page");
  assert.ok(lists.every((r) => r.auth === null), "no credential sent to an emulator endpoint");
  assert.deepEqual(await listObjects(TARGET, "docs/d/draft/", { bucket }), items.slice(0, 5).map((i) => i.name), "the name list over the same pages");
});

// --- pins ---------------------------------------------------------------------------------------

test("the installed Storage emulator stamps a save's generation with its millisecond clock and lists the fields the rows read (the README's claim)", (t) => {
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
  if (!existsSync(join(dir, "metadata.js")) || !existsSync(join(dir, "files.js"))) {
    t.skip(`no ${dir}/metadata.js and files.js`);
    return;
  }
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const metadata = readFileSync(join(dir, "metadata.js"), "utf8");
  const files = readFileSync(join(dir, "files.js"), "utf8");
  t.diagnostic(`firebase-tools ${version}`);
  const why = `firebase-tools ${version}'s Storage emulator no longer stamps generations as README (listObjects) and lib/admin.mjs say: update both`;
  assert.match(metadata, /\n\s*this\.generation = opts\.generation \|\| Date\.now\(\);\n/, why);
  const upload = files.slice(files.indexOf("async uploadObject("), files.indexOf("copyObject("));
  assert.ok(upload.length > 0, "uploadObject found");
  const made = upload.slice(upload.indexOf("new metadata_1.StoredFileMetadata({"), upload.indexOf("}, this._cloudFunctions,"));
  assert.ok(made.length > 0, "uploadObject makes a StoredFileMetadata");
  assert.doesNotMatch(made, /generation/, `${why}: an upload now passes a generation of its own`);
  const listed = metadata.slice(metadata.indexOf("class CloudStorageObjectMetadata"), metadata.indexOf("exports.CloudStorageObjectMetadata = CloudStorageObjectMetadata;"));
  assert.ok(listed.length > 0, "CloudStorageObjectMetadata found");
  for (const line of ["this.generation = metadata.generation.toString();", "this.metageneration = metadata.metageneration.toString();", "this.size = metadata.size.toString();", "this.md5Hash = metadata.md5Hash;"]) {
    assert.ok(listed.includes(line), `the listing's object carries ${line}`);
  }
});

test("README states listObjects' {meta: true} rows, E2E_STORAGE_META and the emulator's millisecond generation", () => {
  const readme = readFileSync(README, "utf8");
  for (const s of ["listObjects(target, prefix, {meta: true})", "{name, generation, metageneration, md5, size}", "E2E_STORAGE_META", "Date.now()", "selftest/admin-objects-meta.test.mjs"]) {
    assert.ok(readme.includes(s), `README lacks ${s}`);
  }
});
