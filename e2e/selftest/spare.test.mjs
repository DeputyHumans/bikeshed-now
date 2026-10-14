// SPDX-License-Identifier: Apache-2.0
// Self-test: the spare-port pool gives concurrent spec files distinct ports, waits when it is empty, and frees what dead claimers held (SPEC §12).

/**
 * A real 24-port block is claimed through the machine-wide lock directory (so
 * no stack can be handed these ports while the test holds them), and a fake
 * local target is built on it with a run directory of its own. Every claim
 * below goes through the same files real specs use.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_TMP, ensureDir } from "../lib/paths.mjs";
import { BLOCK_SIZE, PORT_ROLES, allocateBlock } from "../lib/ports.mjs";
import { SPARE_ROLES, claimSparePort, spareClaims, sparePorts, withSparePort } from "../lib/spare.mjs";
import { startReceiver } from "../lib/oauth.mjs";
import { startProxy } from "../lib/proxy.mjs";

const RECEIVERS = fileURLToPath(new URL("./helpers/receivers.mjs", import.meta.url));
let block;
let dir;
let target;
let targetFile;

before(async () => {
  dir = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-spare-"));
  block = await allocateBlock({ runId: `selftest-spare-${process.pid}` });
  target = { kind: "local", runId: `selftest-spare-${process.pid}`, runDir: dir, stack: { ports: block.named } };
  targetFile = join(dir, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
});

after(() => {
  block?.release();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function racer(count, holdMs, startAt, tag) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [RECEIVERS, targetFile, String(count), String(holdMs), String(startAt), tag], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => {
      try {
        resolveRun(JSON.parse(out));
      } catch {
        rejectRun(new Error(`racer ${tag} exited ${code}: ${err || out}`));
      }
    });
  });
}

/** For each port, the holders' intervals must never overlap. */
function assertNoSharedPort(rows) {
  const byPort = new Map();
  for (const r of rows) byPort.set(r.port, [...(byPort.get(r.port) ?? []), r]);
  for (const [port, list] of byPort) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].start >= list[i - 1].end, `port ${port} held by ${list[i - 1].code} and ${list[i].code} at once`);
    }
  }
}

test("a block has nine spare roles; an old 16-port target reads as a pool of one", async () => {
  assert.equal(BLOCK_SIZE, PORT_ROLES.length);
  assert.deepEqual(SPARE_ROLES, ["spare", "spare2", "spare3", "spare4", "spare5", "spare6", "spare7", "spare8", "spare9"]);
  assert.equal(sparePorts(target).length, 9);
  assert.deepEqual(sparePorts({ stack: { ports: { hub: 30000, spare: 30015 } } }), [30015]);
  assert.deepEqual(sparePorts(undefined), []);
  await assert.rejects(claimSparePort({ kind: "local", stack: { ports: block.named } }), /runDir/);
  await assert.rejects(claimSparePort(target, { port: block.named.hosting }), /not in stack .* spare pool/);
});

test("two concurrent spec files starting receivers on one stack each get their own ports, never a shared one", async () => {
  const startAt = Date.now() + 1500;
  const [a, b] = await Promise.all([racer(4, 400, startAt, "A"), racer(4, 400, startAt, "B")]);
  assert.deepEqual([...a.errors, ...b.errors], [], "no EADDRINUSE, no timeout");
  const rows = [...a.ok, ...b.ok];
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((r) => r.port)).size, 8, `8 receivers held at once on 8 distinct ports: ${rows.map((r) => r.port).join(", ")}`);
  for (const r of rows) assert.ok(sparePorts(target).includes(r.port), `${r.port} is a pool port`);
  assertNoSharedPort(rows);
  assert.deepEqual(spareClaims(target), [], "every claim was released on close()");
});

test("more claimers than ports: the extra ones wait for a release instead of colliding", async () => {
  const startAt = Date.now() + 1500;
  const [a, b] = await Promise.all([racer(7, 600, startAt, "A"), racer(7, 600, startAt, "B")]);
  assert.deepEqual([...a.errors, ...b.errors], []);
  const rows = [...a.ok, ...b.ok];
  assert.equal(rows.length, 14, "all fourteen ran on a pool of nine");
  assert.ok(new Set(rows.map((r) => r.port)).size <= 9);
  assertNoSharedPort(rows);
  assert.deepEqual(spareClaims(target), []);
});

test("a dead claimer's claim is taken over; a foreign listener's port is skipped; release is by token", async () => {
  const pool = sparePorts(target);
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const deadPid = Number(dead.stdout);
  ensureDir(join(dir, "spare"));
  writeFileSync(join(dir, "spare", `${pool[0]}.lock`), JSON.stringify({ pid: deadPid, port: pool[0], token: "x", purpose: "crashed" }));
  const taken = await claimSparePort(target, { port: pool[0], timeoutMs: 2000 });
  assert.equal(taken.port, pool[0]);

  // The claim file now carries a different token: release must leave it.
  const content = JSON.parse(readFileSync(taken.lockPath, "utf8"));
  writeFileSync(taken.lockPath, JSON.stringify({ ...content, token: "someone-else" }));
  assert.equal(taken.release(), false, "a claim is released only by its own token");
  assert.equal(JSON.parse(readFileSync(taken.lockPath, "utf8")).token, "someone-else", "the other holder's claim is still there");
  rmSync(taken.lockPath);
  assert.deepEqual(spareClaims(target), []);

  const foreign = createServer();
  await new Promise((r) => foreign.listen(pool[1], "127.0.0.1", r));
  try {
    await assert.rejects(claimSparePort(target, { port: pool[1], timeoutMs: 600 }), (e) => e.code === "E2E_SPARE_TIMEOUT" && /held by something else: \d+/.test(e.message));
    const other = await withSparePort(target, async (p) => p);
    assert.notEqual(other, pool[1]);
    assert.deepEqual(spareClaims(target), [], "withSparePort released it");
  } finally {
    await new Promise((r) => foreign.close(r));
  }
});

test("startProxy and startReceiver claim from the pool and release on close", async () => {
  const upstream = createServer((s) => s.end("hi"));
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = await startProxy({ upstreamPort: upstream.address().port, target });
  const receiver = await startReceiver({ target });
  try {
    assert.ok(sparePorts(target).includes(proxy.port) && sparePorts(target).includes(receiver.port));
    assert.notEqual(proxy.port, receiver.port);
    assert.deepEqual(spareClaims(target).map((c) => c.purpose).sort(), ["oauth-receiver", "proxy"]);
  } finally {
    await proxy.close();
    await receiver.close();
    await new Promise((r) => upstream.close(r));
  }
  assert.deepEqual(spareClaims(target), []);
});
