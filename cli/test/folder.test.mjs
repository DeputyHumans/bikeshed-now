// SPDX-License-Identifier: Apache-2.0
// A folder publishes as one document, loose files replace their namesakes, and what is left out is said (SPEC §2).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { folderProblems, isLeftOut, resolveEntry, walkFolder } from "../src/folder.mjs";
import { readStoredZip, storedZip } from "../src/zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "index.mjs");
const RULES = JSON.parse(readFileSync(join(here, "..", "..", "functions", "test", "fixtures", "bundle-rules.json"), "utf8"));
const VECTORS = JSON.parse(readFileSync(join(here, "..", "..", "tools", "fixtures", "zip-vectors.json"), "utf8"));

test("the CLI leaves out what the deployment leaves out, and finds a page where it does", () => {
  for (const rel of RULES.leftOut.kept) assert.equal(isLeftOut(rel), false, rel);
  for (const rel of RULES.leftOut.out) assert.equal(isLeftOut(rel), true, rel);
  for (const c of RULES.entries) {
    assert.equal(resolveEntry(c.files) !== null, c.entry !== null, c.files.join(","));
  }
});

test("the CLI's zip is the golden bytes", () => {
  for (const v of VECTORS.vectors) {
    const zip = storedZip(v.entries.map((e) => ({ name: e.name, data: Buffer.from(e.utf8, "utf8") })));
    assert.equal(zip.length, v.bytes, v.name);
    assert.equal(createHash("sha256").update(zip).digest("hex"), v.sha256, v.name);
  }
});

/** A folder on disk, from `{path: text}`, and a way to remove it. */
function folder(files) {
  const root = mkdtempSync(join(tmpdir(), "bshd-folder-"));
  const dir = join(root, "Q3 review");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a folder's walk keeps the page and its files, and names what it leaves out, links included", () => {
  const f = folder({ "index.html": "<p>", "style.css": "p{}", "img/a.png": "1", ".env": "KEY=secret", ".git/config": "x", "node_modules/x/i.js": "1" });
  try {
    symlinkSync(tmpdir(), join(f.dir, "home"));
    const { files, leftOut } = walkFolder(f.dir);
    assert.deepEqual(files.map((x) => x.rel), ["img/a.png", "index.html", "style.css"]);
    assert.deepEqual(leftOut.map((l) => l.rel).sort(), [".env", ".git/", "home", "node_modules/"]);
    assert.equal(leftOut.find((l) => l.rel === "home").why, "a link", "a link is never followed");
    assert.deepEqual(folderProblems(files), []);
  } finally { f.done(); }
});

test("a folder that would be refused is refused before anything is sent", () => {
  const sized = (rel, size = 1) => ({ rel, size });
  assert.match(folderProblems([sized("img/a.png")])[0], /no page to open: add index.html/);
  assert.match(folderProblems([sized("a.html"), sized("b.html")])[0], /2 pages could open first \(a.html, b.html\)/);
  assert.match(folderProblems([sized("index.html", 26 * 1024 * 1024)])[0], /comes to 26 MB; a document can be up to 25 MB/);
  assert.match(folderProblems([sized("index.html"), sized(`${"a".repeat(300)}.png`)])[0], /longer than 256 bytes/);
});

/** Run the CLI in `cwd` against a server that records every request. */
async function cli(args, { cwd, reply = { docId: "deck", versionId: "v2", fileCount: 3, bytes: 9, deduped: false } }) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: new URL(req.url, "http://x"), body: Buffer.concat(chunks) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const out = await promisify(execFile)(process.execPath, [CLI, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" },
    }).catch((e) => e);
    return { seen, stdout: out.stdout, stderr: out.stderr, code: out.code ?? 0 };
  } finally { server.close(); }
}

test("publish <folder> sends one zip of exactly what it keeps, and says what it left out", async () => {
  const f = folder({ "index.html": "<p>", "Screen Shot.png": "1", ".env": "KEY=secret" });
  try {
    const r = await cli(["publish", f.dir], { cwd: f.root, reply: { docId: "q3", versionId: "v1", fileCount: 2, bytes: 4 } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.seen.length, 1);
    assert.equal(r.seen[0].url.pathname, "/publish");
    assert.equal(r.seen[0].url.searchParams.get("filename"), "Q3 review.zip", "the folder's name is the title's fallback");
    assert.deepEqual(readStoredZip(r.seen[0].body).map((e) => e.name), ["Screen Shot.png", "index.html"]);
    assert.match(r.stderr, /left out \.env/);
    assert.match(r.stderr, /sending 2 file\(s\)/);
  } finally { f.done(); }
});

test("publish <folder> with no page sends nothing", async () => {
  const f = folder({ "img/a.png": "1" });
  try {
    const r = await cli(["publish", f.dir], { cwd: f.root });
    assert.equal(r.code, 1);
    assert.equal(r.seen.length, 0);
    assert.match(r.stderr, /cannot be published: there is no page to open/);
  } finally { f.done(); }
});

test("update <id> <folder> makes the folder the whole next version", async () => {
  const f = folder({ "index.html": "<p>two", "style.css": "p{}" });
  try {
    const r = await cli(["update", "deck", f.dir, "--base", "v1"], { cwd: f.root, reply: { versionId: "v2", fileCount: 2, bytes: 9, deduped: false, changes: { changed: 1, unchanged: 1, removed: 3 } } });
    assert.equal(r.code, 0, r.stderr);
    const url = r.seen[0].url;
    assert.equal(url.searchParams.get("update"), "deck");
    assert.equal(url.searchParams.get("baseVersion"), "v1");
    assert.equal(url.searchParams.has("merge"), false);
    assert.match(r.stdout, /published v2 — 1 file\(s\) changed, 1 unchanged, 3 removed/);
  } finally { f.done(); }
});

test("update <id> <files> lays them over the current version, by path inside this folder and by name outside it", async () => {
  const f = folder({ "img/chart.png": "new chart", "notes.css": "x" });
  const outside = mkdtempSync(join(tmpdir(), "bshd-outside-"));
  writeFileSync(join(outside, "logo.png"), "logo");
  try {
    const r = await cli(["update", "deck", "img/chart.png", join(outside, "logo.png")], {
      cwd: f.dir,
      reply: { versionId: "v3", fileCount: 9, bytes: 1, deduped: false, changes: { changed: 2, unchanged: 7, removed: 0 }, placed: [{ sent: "img/chart.png", at: "img/chart.png" }, { sent: "logo.png", at: "brand/logo.png" }] },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.seen[0].url.searchParams.get("merge"), "1");
    assert.deepEqual(readStoredZip(r.seen[0].body).map((e) => [e.name, e.data.toString()]), [["img/chart.png", "new chart"], ["logo.png", "logo"]]);
    assert.match(r.stdout, /published v3 — 2 file\(s\) changed, 7 unchanged/);
    assert.match(r.stdout, /logo\.png → brand\/logo\.png/, "where each file went is printed");

    // One picture alone is laid over too; one page alone still replaces the page.
    const one = await cli(["update", "deck", "notes.css"], { cwd: f.dir });
    assert.equal(one.seen[0].url.searchParams.get("merge"), "1");
  } finally { f.done(); rmSync(outside, { recursive: true, force: true }); }
});

test("--watch follows one page, never a folder or loose files", async () => {
  const f = folder({ "index.html": "<p>" });
  try {
    const r = await cli(["publish", f.dir, "--watch"], { cwd: f.root });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--watch follows one file/);
    assert.equal(r.seen.length, 0);
  } finally { f.done(); }
});
