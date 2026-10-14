// SPDX-License-Identifier: Apache-2.0
// Self-test: port blocks are exclusive, proven free on every address, never on a denied port, never over a live block of another size (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_TMP, ensureDir } from "../lib/paths.mjs";
import {
  BLOCK_SIZE, DEFAULT_DENY, RANGE_END, RANGE_START, allocateBlock, assertStackPort, blockLockPath,
  claimLockFile, denySet, isPortFree, overlappingLock, parseDenyList, releaseLockFile,
} from "../lib/ports.mjs";

const tmpLocks = () => mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-locks-"));

function listen(host, port) {
  return new Promise((resolveListen, rejectListen) => {
    const s = createServer();
    s.once("error", rejectListen);
    s.listen({ host, port, ipv6Only: host === "::1" }, () => resolveListen(s));
  });
}
const close = (s) => new Promise((r) => s.close(() => r()));

/** Two adjacent aligned blocks that are both free right now. */
async function freePair() {
  for (let tries = 0; tries < 50; tries++) {
    const slot = Math.floor(Math.random() * (Math.floor((RANGE_END - RANGE_START + 1) / BLOCK_SIZE) - 1));
    const base = RANGE_START + slot * BLOCK_SIZE;
    let ok = true;
    for (let p = base; p < base + 2 * BLOCK_SIZE && ok; p++) ok = await isPortFree(p);
    if (ok) return base;
  }
  throw new Error("no free pair of blocks to test with");
}

test("the deny list holds every default port and parses E2E_DENY_PORTS", () => {
  for (const p of [9099, 8088, 9000, 5001, 5050, 9199, 4040, 4400, 4500, 9150, 9299, 9499]) {
    assert.ok(DEFAULT_DENY.includes(p), `default ${p} denied`);
  }
  assert.deepEqual([...parseDenyList("31000, 31010-31012")].sort(), [31000, 31010, 31011, 31012]);
  assert.throws(() => parseDenyList("abc"), /not a port or range/);
  const deny = denySet("31000");
  assert.ok(deny.has(31000) && deny.has(9099));
});

test("assertStackPort refuses defaults, 1xxxx/2xxxx and anything outside 30000-39999", () => {
  for (const p of [9099, 8088, 5050, 19000, 29099, 29999, 40000]) {
    assert.throws(() => assertStackPort(p), /outside the e2e range|deny list/, `port ${p}`);
  }
  assert.throws(() => assertStackPort(30005, new Set([30005])), /deny list/);
  assert.equal(assertStackPort(30000, new Set()), 30000);
});

test("a port held on any one address is not free", async () => {
  const base = await freePair();
  for (const [i, host] of ["127.0.0.1", "::1", "0.0.0.0"].entries()) {
    const port = base + i;
    assert.equal(await isPortFree(port), true, `${port} free before`);
    const s = await listen(host, port);
    try {
      assert.equal(await isPortFree(port), false, `${port} held on ${host}`);
    } finally {
      await close(s);
    }
    assert.equal(await isPortFree(port), true, `${port} free after`);
  }
});

test("allocation skips a block with one busy port and takes the next", async () => {
  const base = await freePair();
  const dir = tmpLocks();
  const s = await listen("127.0.0.1", base + 7);
  try {
    const block = await allocateBlock({ runId: "selftest-busy", rangeStart: base, rangeEnd: base + 2 * BLOCK_SIZE - 1, locksDir: dir, random: () => 0 });
    assert.equal(block.base, base + BLOCK_SIZE);
    assert.equal(block.ports.length, BLOCK_SIZE);
    assert.ok(block.skipped.some((x) => x.base === base && /busy/.test(x.why)));
    assert.ok(!existsSync(blockLockPath(base, dir)), "the busy block's lock was released");
    block.release();
  } finally {
    await close(s);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a denied port removes its whole block from consideration", async () => {
  const base = await freePair();
  const dir = tmpLocks();
  try {
    const block = await allocateBlock({ runId: "selftest-deny", deny: new Set([base + 3]), rangeStart: base, rangeEnd: base + 2 * BLOCK_SIZE - 1, locksDir: dir, random: () => 0 });
    assert.equal(block.base, base + BLOCK_SIZE);
    assert.ok(!block.ports.includes(base + 3));
    block.release();
    await assert.rejects(
      allocateBlock({ runId: "selftest-deny", deny: new Set([base + 3, base + BLOCK_SIZE]), rangeStart: base, rangeEnd: base + 2 * BLOCK_SIZE - 1, locksDir: dir }),
      /no free 24-port block/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a block overlapping a LIVE lock of another size (an older 16-port block) is skipped; a dead one is not", async () => {
  const base = await freePair();
  const dir = tmpLocks();
  try {
    // A 16-port block at base+8 straddles this run's first 24-port slot.
    writeFileSync(join(dir, `ports-${base + 8}.lock`), JSON.stringify({ pid: process.pid, runId: "selftest-old", base: base + 8, size: 16 }));
    assert.equal(overlappingLock(base, BLOCK_SIZE, { locksDir: dir })?.base, base + 8);
    assert.equal(overlappingLock(base + BLOCK_SIZE, BLOCK_SIZE, { locksDir: dir }), null, "the next slot does not overlap it");
    const block = await allocateBlock({ runId: "selftest-overlap", rangeStart: base, rangeEnd: base + 2 * BLOCK_SIZE - 1, locksDir: dir, random: () => 0 });
    assert.equal(block.base, base + BLOCK_SIZE, "the overlapping slot was skipped");
    assert.ok(block.skipped.some((x) => x.base === base && /overlaps live block/.test(x.why)), JSON.stringify(block.skipped));
    assert.ok(!existsSync(blockLockPath(base, dir)), "the skipped slot's own lock was released");
    block.release();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    writeFileSync(join(dir, `ports-${base + 8}.lock`), JSON.stringify({ pid: dead, runId: "selftest-old", base: base + 8, size: 16 }));
    const again = await allocateBlock({ runId: "selftest-overlap", rangeStart: base, rangeEnd: base + 2 * BLOCK_SIZE - 1, locksDir: dir, random: () => 0 });
    assert.equal(again.base, base, "a dead holder's overlapping lock does not block");
    again.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two runs racing for one block: exactly one wins", async () => {
  const base = await freePair();
  const dir = tmpLocks();
  try {
    const range = { rangeStart: base, rangeEnd: base + BLOCK_SIZE - 1, locksDir: dir };
    const results = await Promise.allSettled([
      allocateBlock({ runId: "selftest-race-a", ...range }),
      allocateBlock({ runId: "selftest-race-b", ...range }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.match(results.find((r) => r.status === "rejected").reason.message, /no free 24-port block/);
    const holder = JSON.parse(readFileSync(blockLockPath(base, dir), "utf8"));
    assert.equal(holder.runId, won[0].value.runId, "the lock names the winner");
    assert.equal(holder.pid, process.pid);
    won[0].value.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock held by a live process is exclusive; a dead holder's lock is taken over", async () => {
  const dir = tmpLocks();
  const path = join(dir, "ports-39984.lock");
  // A real other process holds it. Killed in `finally`, so a failing assertion
  // cannot leave it running (and the test file hanging on it).
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((r) => child.on("exit", r));
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(claimLockFile(path, { pid: child.pid, runId: "selftest-child", createdAt: "t0" }), true);
    assert.equal(claimLockFile(path, { pid: process.pid, runId: "selftest-me", createdAt: "t1" }), false, "live holder keeps it");
    assert.equal(releaseLockFile(path, "selftest-me"), false, "a non-holder cannot release it");
    child.kill("SIGKILL");
    await exited;
    assert.equal(claimLockFile(path, { pid: process.pid, runId: "selftest-me", createdAt: "t2" }), true, "dead holder's lock is taken over");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).runId, "selftest-me");
    assert.equal(releaseLockFile(path, "selftest-me"), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
