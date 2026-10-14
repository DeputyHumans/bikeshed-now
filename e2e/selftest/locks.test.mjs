// SPDX-License-Identifier: Apache-2.0
// Self-test: functional runs share the tier lock, a concurrency run holds it alone (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E_TMP, ensureDir } from "../lib/paths.mjs";
import { TIER_MODE, acquireTierLock, tierLockStatus } from "../lib/locks.mjs";

const tmp = () => mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-tier-"));
const opts = (dir, runId, extra = {}) => ({ runId, dir, pollMs: 20, timeoutMs: 400, ...extra });

test("the tiers map to the modes the plan fixes", () => {
  assert.equal(TIER_MODE.functional, "shared");
  assert.equal(TIER_MODE.concurrency, "exclusive");
});

test("two shared holders coexist", async () => {
  const dir = tmp();
  try {
    const a = await acquireTierLock("shared", opts(dir, "selftest-a"));
    const b = await acquireTierLock("shared", opts(dir, "selftest-b"));
    assert.equal(tierLockStatus(dir).shared.length, 2);
    a.release();
    b.release();
    assert.equal(tierLockStatus(dir).shared.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NEGATIVE: exclusive waits out a shared holder, and shared waits out an exclusive one", async () => {
  const dir = tmp();
  try {
    const s = await acquireTierLock("shared", opts(dir, "selftest-s"));
    await assert.rejects(acquireTierLock("exclusive", opts(dir, "selftest-x")), /timed out waiting for the exclusive tier lock/);
    assert.equal(tierLockStatus(dir).exclusive, null, "a timed-out exclusive leaves no intent behind");
    s.release();
    const x = await acquireTierLock("exclusive", opts(dir, "selftest-x"));
    await assert.rejects(acquireTierLock("shared", opts(dir, "selftest-s2")), /timed out waiting for the shared tier lock/);
    await assert.rejects(acquireTierLock("exclusive", opts(dir, "selftest-x2")), /timed out/);
    x.release();
    const s2 = await acquireTierLock("shared", opts(dir, "selftest-s2"));
    s2.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an exclusive request queued behind a shared holder gets the lock once it is released", async () => {
  const dir = tmp();
  try {
    const s = await acquireTierLock("shared", opts(dir, "selftest-s"));
    const pending = acquireTierLock("exclusive", opts(dir, "selftest-x", { timeoutMs: 3000 }));
    setTimeout(() => s.release(), 150);
    const x = await pending;
    assert.equal(tierLockStatus(dir).exclusive.runId, "selftest-x");
    x.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock and stack roots are machine-wide: the same under two different TMPDIRs, and inside neither", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync: mk } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const paths = new URL("../lib/paths.mjs", import.meta.url).href;
  const roots = [mk(join(tmpdir(), "e2e-tmpdir-a-")), mk(join(tmpdir(), "e2e-tmpdir-b-"))];
  try {
    const seen = roots.map((t) => {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(paths)}); console.log(JSON.stringify([m.LOCKS_DIR, m.STACKS_DIR]));`], { env: { ...process.env, TMPDIR: t }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    });
    assert.deepEqual(seen[0], seen[1], "a terminal and a sandboxed session see the same locks and stacks");
    for (const [i, t] of roots.entries()) for (const p of seen[i]) assert.ok(!p.startsWith(t) && !p.startsWith(join("/private", t)), `${p} is not under TMPDIR ${t}`);
  } finally {
    for (const t of roots) rmSync(t, { recursive: true, force: true });
  }
});
