// SPDX-License-Identifier: Apache-2.0
// Self-tests cannot launch browsers during an exclusive measurement and retain their lease until child shutdown (SPEC §12).

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { acquireTierLock, tierLockStatus } from "../lib/locks.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = readFileSync(new URL("../run.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("async function selfTest() {"), source.indexOf("\nfunction aliveCheck("));

function harness(t, { spawnError = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bikeshed-selftest-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = new EventEmitter(), parent = new EventEmitter();
  parent.pid = process.pid;
  const record = { spawned: 0, stopped: 0, exit: null, options: null };
  parent.exit = code => { record.exit = code; };
  const run = runInNewContext(`${body}\nselfTest`, {
    selfTestToolchain: () => ({ node: { executable: process.execPath }, firebase: {}, env: {} }),
    fail: message => { throw new Error(message); }, log: () => {},
    readdirSync: () => ["fixture.test.mjs"], SELFTEST_DIR: dir, REPO_ROOT: dir, join,
    acquireTierLock: (mode, options) => acquireTierLock(mode, { ...options, dir, timeoutMs: 2000, pollMs: 5 }),
    process: parent, SIGNALS: ["SIGINT", "SIGTERM", "SIGHUP"],
    stopChildGroup: async actual => { assert.equal(actual, child); record.stopped++; },
    spawn: (_executable, _args, options) => {
      record.spawned++; record.options = options;
      if (spawnError) throw spawnError;
      return child;
    },
  });
  return { dir, child, parent, record, run };
}

async function launched(h) {
  for (let i = 0; i < 100 && !h.record.spawned; i++) await sleep(5);
  assert.equal(h.record.spawned, 1, "the self-test child launched");
}

test("the actual self-test entry waits for an exclusive measurement before launching its child", async t => {
  const h = harness(t);
  const exclusive = await acquireTierLock("exclusive", { dir: h.dir, runId: "measurement" });
  t.after(() => exclusive.release());
  const pending = h.run();
  await sleep(50);
  assert.equal(h.record.spawned, 0, "no browser-capable child may start during the measurement");
  exclusive.release();
  await launched(h);
  assert.equal(tierLockStatus(h.dir).shared[0].tier, "selftest");
  h.child.emit("close", 0);
  await pending;
  assert.equal(h.record.exit, 0);
  assert.equal(tierLockStatus(h.dir).shared.length, 0);
});

test("the shared lease remains while the child runs, preserves failure status, and releases on close", async t => {
  const h = harness(t), pending = h.run();
  await launched(h);
  await assert.rejects(acquireTierLock("exclusive", { dir: h.dir, runId: "measurement", timeoutMs: 40, pollMs: 5 }), /timed out/);
  h.child.emit("close", 7);
  await pending;
  assert.equal(h.record.exit, 7);
  const exclusive = await acquireTierLock("exclusive", { dir: h.dir, runId: "next-measurement", timeoutMs: 100 });
  exclusive.release();
});

for (const mode of ["throw", "event"]) test(`a child spawn ${mode} releases the lease and preserves the error`, async t => {
  const error = new Error("spawn failed"), h = harness(t, { spawnError: mode === "throw" ? error : null });
  const pending = h.run(), rejected = assert.rejects(pending, actual => actual === error);
  if (mode === "event") { await launched(h); h.child.emit("error", error); }
  await rejected;
  assert.equal(tierLockStatus(h.dir).shared.length, 0);
  assert.equal(h.parent.listenerCount("SIGINT"), 0);
});

test("interrupts stop the detached child group without releasing its lease before close", async t => {
  const h = harness(t), pending = h.run();
  await launched(h);
  assert.equal(h.record.options.detached, true);
  h.parent.emit("SIGTERM");
  assert.equal(h.record.stopped, 1);
  assert.equal(tierLockStatus(h.dir).shared.length, 1, "child shutdown must precede lease release");
  h.child.emit("close", null);
  await pending;
  assert.equal(h.record.exit, 1);
  assert.equal(tierLockStatus(h.dir).shared.length, 0);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(h.parent.listenerCount(signal), 0);
});
