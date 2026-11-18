// SPDX-License-Identifier: Apache-2.0
// Large media go straight to Storage in chunks that resume, and an unchanged film is named, never sent again (SPEC §24).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isStageable, splitForSessions } from "../src/folder.mjs";
import { sendToSession } from "../src/client.mjs";
import { readStoredZip } from "../src/zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "index.mjs");
const RULES = JSON.parse(readFileSync(join(here, "..", "..", "functions", "test", "fixtures", "bundle-rules.json"), "utf8"));
const MB = 1024 * 1024;

test("the CLI sends on its own what the deployment stages, the largest first", () => {
  for (const rel of RULES.stageable.yes) assert.equal(isStageable(rel), true, rel);
  for (const rel of RULES.stageable.no) assert.equal(isStageable(rel), false, rel);
  const files = [{ rel: "index.html", size: 1000 }, { rel: "still.png", size: 20 * MB }, { rel: "film.mp4", size: 30 * MB }];
  assert.deepEqual(splitForSessions(files).staged.map((f) => f.rel), ["film.mp4"]);
});

/**
 * A resumable session as Storage runs one: 308 with `Range: bytes=0-N` for
 * what it holds, 200 when it has it all. `keep` decides how much of each
 * chunk it keeps; `drop` hangs up on the chosen request.
 */
async function session({ keep = (chunk) => chunk.length, drop = () => false } = {}) {
  const held = [];
  let size = 0;
  let requests = 0;
  const server = createServer((req, res) => {
    const n = ++requests;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (drop(n)) { req.socket.destroy(); return; }
      const range = req.headers["content-range"] ?? "";
      const asked = /bytes \*\/(\d+)/.exec(range);
      const sent = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (sent) {
        size = Number(sent[3]);
        const start = Number(sent[1]);
        const body = Buffer.concat(chunks);
        if (start === Buffer.concat(held).length) held.push(body.subarray(0, keep(body, n)));
      } else if (asked) size = Number(asked[1]);
      const have = Buffer.concat(held).length;
      if (have === size && size > 0) { res.statusCode = 200; res.end("{}"); return; }
      res.statusCode = 308;
      if (have > 0) res.setHeader("Range", `bytes=0-${have - 1}`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/upload?upload_id=s`, held: () => Buffer.concat(held), requests: () => requests, close: () => server.close() };
}

function tempFile(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "bshd-media-"));
  const path = join(dir, "film.mp4");
  writeFileSync(path, bytes);
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a session that keeps fewer bytes than were sent is resumed from where it says it is", async () => {
  const bytes = randomBytes(3 * MB + 17);
  const f = tempFile(bytes);
  // Every other chunk, it keeps only half; Storage keeps what it can and says so.
  const s = await session({ keep: (chunk, n) => (n % 2 === 1 ? Math.floor(chunk.length / 2) : chunk.length) });
  try {
    const seen = [];
    await sendToSession(s.url, f.path, bytes.length, { chunkBytes: MB, onProgress: (n) => seen.push(n) });
    assert.ok(s.held().equals(bytes), "every byte arrived, in order");
    assert.ok(seen.every((n, i) => n >= (seen[i - 1] ?? 0)), "progress only goes forward");
  } finally { s.close(); f.done(); }
});

test("a session that keeps nothing more is given up on, not tried for ever", async () => {
  const bytes = randomBytes(MB);
  const f = tempFile(bytes);
  const s = await session({ keep: () => 0 });
  try {
    await assert.rejects(sendToSession(s.url, f.path, bytes.length, { chunkBytes: MB, attempts: 2 }), /stopped moving/);
  } finally { s.close(); f.done(); }
});

test("a dropped connection asks the session what it holds, and goes on from there", async () => {
  const bytes = randomBytes(3 * MB);
  const f = tempFile(bytes);
  const s = await session({ drop: (n) => n === 2 });
  try {
    await sendToSession(s.url, f.path, bytes.length, { chunkBytes: MB });
    assert.ok(s.held().equals(bytes));
  } finally { s.close(); f.done(); }
});

/** The deployment and its sessions, as far as the CLI talks to them. */
async function deployment({ have = false } = {}) {
  const seen = [];
  const stored = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url, body });
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/media") {
        const ask = JSON.parse(body.toString());
        if (have && ask.sha256) { res.end(JSON.stringify({ have: true })); return; }
        res.end(JSON.stringify({ stagingId: "st-1", uploadUrl: `http://127.0.0.1:${server.address().port}/upload`, chunkBytes: 8 * MB }));
      } else if (url.pathname === "/upload") {
        stored.push(body);
        const [, , end, size] = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers["content-range"]);
        if (Number(end) + 1 === Number(size)) { res.statusCode = 200; res.end("{}"); }
        else { res.statusCode = 308; res.setHeader("Range", `bytes=0-${end}`); res.end(); }
      } else {
        res.end(JSON.stringify({ docId: "deck", versionId: "v2", fileCount: 2, bytes: 1, deduped: false }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, stored, close: () => server.close() };
}

async function run(args, cwd, origin) {
  return promisify(execFile)(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" } }).catch((e) => e);
}

test("a folder with a film sends the film through a session and the rest as one zip naming it", async () => {
  const root = mkdtempSync(join(tmpdir(), "bshd-film-"));
  const dir = join(root, "talk");
  mkdirSync(dir);
  const film = randomBytes(26 * MB);
  writeFileSync(join(dir, "index.html"), "<video src=film.mp4 controls></video>");
  writeFileSync(join(dir, "film.mp4"), film);
  const d = await deployment();
  try {
    const r = await run(["publish", dir], root, d.origin);
    assert.equal(r.code ?? 0, 0, r.stderr);
    const ask = d.seen.find((x) => x.url.pathname === "/media");
    assert.deepEqual(JSON.parse(ask.body.toString()), { path: "film.mp4", size: film.length }, "a new document has nothing stored to name");
    assert.ok(Buffer.concat(d.stored).equals(film));
    const publish = d.seen.find((x) => x.url.pathname === "/publish");
    assert.deepEqual(publish.url.searchParams.getAll("media"), ["st-1"]);
    assert.deepEqual(readStoredZip(publish.body).map((e) => e.name), ["index.html"], "the film is not in the zip");
    assert.match(r.stderr, /sent film\.mp4, 26 MB/);
  } finally { d.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an update names a film the document already stores, and sends none of it", async () => {
  const root = mkdtempSync(join(tmpdir(), "bshd-film-"));
  const dir = join(root, "talk");
  mkdirSync(dir);
  const film = randomBytes(26 * MB);
  writeFileSync(join(dir, "index.html"), "<p>new words <video src=film.mp4></video>");
  writeFileSync(join(dir, "film.mp4"), film);
  const d = await deployment({ have: true });
  try {
    const r = await run(["update", "deck", dir], root, d.origin);
    assert.equal(r.code ?? 0, 0, r.stderr);
    const ask = JSON.parse(d.seen.find((x) => x.url.pathname === "/media").body.toString());
    assert.equal(ask.sha256, createHash("sha256").update(film).digest("hex"));
    assert.equal(ask.docId, "deck");
    assert.equal(d.stored.length, 0, "not one byte of it sent");
    const publish = d.seen.find((x) => x.url.pathname === "/publish");
    assert.deepEqual(publish.url.searchParams.getAll("have"), [`film.mp4:${ask.sha256}`]);
    assert.match(r.stderr, /film\.mp4: already stored, not sent again/);
  } finally { d.close(); rmSync(root, { recursive: true, force: true }); }
});
