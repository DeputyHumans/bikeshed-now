// SPDX-License-Identifier: Apache-2.0
// Self-test: a stack starts only at normal memory pressure, with nothing swapping and enough memory free; a browser pool only with room for its contexts (SPEC §12).

/**
 * The gate's readings are parsed from the tools' own output, then the gate is
 * driven by an injected sampler: critical pressure refuses at once, warn
 * pressure, live swapping and too little free memory each make it wait, and
 * healthy readings let it through at once. Every wait and refusal is a
 * load.jsonl line carrying all three readings. One real reading, too.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GIB, MEMORY_DEFAULTS, memoryThresholds, memoryVerdict, parseFreePct, parsePressureLevel, parseVmStat, poolNeedBytes, readMemory, sampleMemory, stackNeed, waitForMemory } from "../lib/load.mjs";
import { ADMISSION_CODE, admitStack } from "../lib/admission.mjs";
import { BrowserPool } from "../lib/browser.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const MEM = 64 * GIB;
const reading = (o = {}) => {
  const r = { level: 1, swapoutsDelta: 0, windowMs: 5000, freePct: 80, memsize: MEM, swapUsedBytes: 19 * GIB, swapTotalBytes: 20 * GIB, ...o };
  return { ...r, availableBytes: Math.floor((r.freePct / 100) * r.memsize) };
};
const HEALTHY = reading();
const CRITICAL = reading({ level: 4 });
const WARN = reading({ level: 2 });
const SWAPPING = reading({ swapoutsDelta: 257 });
const SHORT = reading({ freePct: 10 });
const SMALL = reading({ freePct: 30, memsize: 16 * GIB }); // 30 % of 16 GB is 4.8 GB

/** A sampler that returns these readings in turn (the last one forever). */
const seq = (...rs) => {
  let i = 0;
  return async () => rs[Math.min(i++, rs.length - 1)];
};
const lines = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("the readings come from the tools' own output", () => {
  const vm = parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                  1858011.\nPageouts:                                    5644874.\nSwapins:                                    73919040.\nSwapouts:                                   85503781.\n`);
  assert.deepEqual(vm, { pageSize: 16384, swapouts: 85503781, pageouts: 5644874 });
  assert.equal(parseFreePct("Pageouts: 5644874 \n\nSystem-wide memory free percentage: 81%\n"), 81);
  assert.equal(parsePressureLevel("4\n"), 4);
  assert.throws(() => parseFreePct("no such line"), /System-wide memory free percentage/);
});

test("a real reading: pressure level, free share, and the available bytes it makes", async () => {
  const r = readMemory();
  assert.ok([1, 2, 4].includes(r.level), `level ${r.level}`);
  assert.ok(r.freePct >= 0 && r.freePct <= 100 && r.memsize > GIB);
  assert.equal(r.availableBytes, Math.floor((r.freePct / 100) * r.memsize));
  const instant = await sampleMemory({ windowMs: 0 });
  assert.equal(instant.swapoutsDelta, null, "a pool's reading has no window");
  const windowed = await sampleMemory({ windowMs: 300 });
  assert.ok(Number.isInteger(windowed.swapoutsDelta) && windowed.swapoutsDelta >= 0);
});

test("the thresholds: free ≥ 25 % and ≥ 8 GB, at most 256 pages swapped out in 5 s; configurable", () => {
  assert.deepEqual(MEMORY_DEFAULTS, { minFreePct: 25, minAvailableGb: 8, maxSwapouts: 256, poolBaseGb: 2, poolContextMb: 600, stackPeerMb: 700 });
  assert.deepEqual(stackNeed(memoryThresholds({})), { pressure: true, maxSwapouts: 256, minFreePct: 25, minAvailableBytes: 8 * GIB });
  assert.equal(memoryThresholds({ E2E_MIN_FREE_PCT: "40" }).minFreePct, 40);
  assert.throws(() => memoryThresholds({ E2E_MIN_FREE_PCT: "120" }), /0 to 100/);
  assert.equal(poolNeedBytes(4, { thresholds: memoryThresholds({}) }), 2 * GIB + 4 * 600 * 1024 ** 2);
  assert.equal(poolNeedBytes(1, { withBase: false, thresholds: memoryThresholds({}) }), 600 * 1024 ** 2);
});

test("the verdict: each reading alone can hold the stack gate; healthy ones pass", () => {
  const need = stackNeed(memoryThresholds({}));
  assert.deepEqual(memoryVerdict(HEALTHY, need), { ok: true, critical: false, reasons: [] });
  const v = (r) => memoryVerdict(r, need);
  assert.deepEqual([v(CRITICAL).ok, v(CRITICAL).critical], [false, true]);
  assert.deepEqual([v(WARN).ok, v(WARN).critical], [false, false]);
  assert.match(v(SWAPPING).reasons.join(), /swapping: 257 pages swapped out in 5000 ms > 256/);
  assert.match(v(SHORT).reasons.join(), /memory free 10% < 25%/);
  assert.match(v(SMALL).reasons.join(), /available memory 4\.8 GB \(30% of 16\.0 GB\) < 8\.0 GB/);
  assert.equal(memoryVerdict(reading({ swapUsedBytes: 20 * GIB, swapTotalBytes: 20 * GIB }), need).ok, true, "swap USE is logged, never judged");
});

test("NEGATIVE: critical pressure refuses at once, without waiting, and says why in load.jsonl", async () => {
  const log = join(tempDir("e2e-gate-"), "load.jsonl");
  const r = await waitForMemory({ need: stackNeed(memoryThresholds({})), gate: "stack", sample: seq(CRITICAL), pollMs: 10, timeoutMs: 60_000, logFile: log });
  assert.deepEqual([r.ok, r.critical], [false, true]);
  assert.ok(r.waitedMs < 1000, `refused in ${r.waitedMs} ms`);
  const [row] = lines(log);
  assert.equal(row.event, "memory-refused");
  assert.deepEqual([row.level, row.swapoutsDelta, row.freePct, row.availableBytes], [4, 0, 80, CRITICAL.availableBytes], "all three readings");
  assert.equal(row.swapUsedBytes, 19 * GIB, "swap used, for the record");
});

for (const [name, bad] of [["warn pressure", WARN], ["live swapping", SWAPPING], ["10 % free", SHORT]]) {
  test(`NEGATIVE: ${name} holds the gate until it clears, logging the wait and the opening`, async () => {
    const log = join(tempDir("e2e-gate-"), "load.jsonl");
    const r = await waitForMemory({ need: stackNeed(memoryThresholds({})), gate: "stack", sample: seq(bad, bad, HEALTHY), pollMs: 10, timeoutMs: 60_000, logFile: log });
    assert.equal(r.ok, true);
    const rows = lines(log);
    assert.deepEqual(rows.map((x) => x.event), ["memory-wait", "memory-gate-open"]);
    for (const k of ["level", "swapoutsDelta", "freePct", "availableBytes"]) assert.ok(k in rows[0], `${k} in the wait line`);
  });
  test(`NEGATIVE: ${name} that never clears refuses at the timeout`, async () => {
    const r = await waitForMemory({ need: stackNeed(memoryThresholds({})), gate: "stack", sample: seq(bad), pollMs: 10, timeoutMs: 100 });
    assert.deepEqual([r.ok, r.critical], [false, false]);
    assert.ok(r.waitedMs >= 100);
  });
}

test("healthy readings pass the gate at once, with nothing logged", async () => {
  const log = join(tempDir("e2e-gate-"), "load.jsonl");
  const r = await waitForMemory({ need: stackNeed(memoryThresholds({})), gate: "stack", sample: seq(HEALTHY), logFile: log });
  assert.deepEqual([r.ok, r.waitedMs], [true, 0]);
});

test("admission: critical pressure refuses a stack at once (E2E_ADMISSION, exit 3 in run.mjs); healthy readings admit it", async () => {
  const dir = tempDir("e2e-admit-gate-");
  const log = join(dir, "load.jsonl");
  let claimed = 0;
  const base = { stacksDir: join(dir, "stacks"), locksDir: join(dir, "locks"), live: () => [], logFile: log, pollMs: 10, claim: () => claimed++ };
  const t0 = Date.now();
  await assert.rejects(admitStack({ ...base, runId: "selftest-gate-a", sample: seq(CRITICAL), timeoutMs: 60_000 }), (err) => err.code === ADMISSION_CODE && /pressure level 4 \(critical\)/.test(err.message));
  assert.ok(Date.now() - t0 < 1000, "at once");
  await assert.rejects(admitStack({ ...base, runId: "selftest-gate-b", sample: seq(SWAPPING), timeoutMs: 200 }), (err) => err.code === ADMISSION_CODE && /swapping/.test(err.message));
  assert.equal(claimed, 0, "no record written for a refused stack");
  const ok = await admitStack({ ...base, runId: "selftest-gate-c", sample: seq(HEALTHY), timeoutMs: 1000 });
  assert.equal(claimed, 1);
  assert.equal(ok.waitedMs < 1000, true);
  assert.deepEqual(lines(log).map((r) => r.event), ["memory-refused", "memory-wait", "admission-refused", "admitted"]);
  for (const r of lines(log).filter((x) => x.event !== "admission-refused")) assert.ok("level" in r && "swapoutsDelta" in r && "freePct" in r, JSON.stringify(r));
});

test("a browser pool waits for 2 GB + 600 MB per context on the same figure, then ends INCONCLUSIVE; enough memory lets it make contexts", async () => {
  const saved = { ...process.env };
  try {
    process.env.E2E_POOL_BASE_GB = "100000";
    process.env.E2E_POOL_WAIT_MS = "0";
    const pool = new BrowserPool({ target: { kind: "local", origin: "http://127.0.0.1:9", runId: "selftest-pool" } });
    await assert.rejects(pool.admitContexts(3), (err) => err.code === "E2E_INCONCLUSIVE" && /never had room for 3 more browser context/.test(err.message) && /100000 GB \+ 3 × 600 MB/.test(err.message));
    assert.equal(pool.browsers.length, 0, "no Chrome was launched");
    delete process.env.E2E_POOL_BASE_GB;
    await pool.admitContexts(3); // 2 GB + 3 × 600 MB: the machine running this has that free
    assert.equal(pool.memoryGated, true, "the base is asked for once per pool");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("the pool reserves what a context was measured at: 600 MB, so 2 GB + 20 × 600 MB = 13.7 GB for N=20, not 8 GB", () => {
  const t = memoryThresholds({});
  assert.equal(t.poolContextBytes, 600 * 1024 ** 2);
  assert.equal(poolNeedBytes(20, { thresholds: t }), 2 * GIB + 20 * 600 * 1024 ** 2);
});

test("a case with N >= 10 needs the pool AND the stack's growth (0.7 GB per peer) available; below 10 only the pool's own gate applies", async () => {
  const load = await import("../lib/load.mjs");
  assert.equal(typeof load.liveNeedBytes, "function", "load.mjs sizes a live case's need");
  const t = memoryThresholds({});
  assert.equal(load.LIVE_RESERVE_MIN_N, 10);
  assert.equal(load.stackGrowthBytes(5, { thresholds: t }), 0);
  assert.equal(load.stackGrowthBytes(10, { thresholds: t }), 10 * 700 * 1024 ** 2);
  assert.equal(load.liveNeedBytes(20, { thresholds: t }), 2 * GIB + 20 * 600 * 1024 ** 2 + 20 * 700 * 1024 ** 2, "about 27.4 GB: the measured N=20 peak was 24.3–27.6 GB");
  assert.equal(memoryThresholds({ E2E_STACK_PEER_MB: "900" }).stackPeerBytes, 900 * 1024 ** 2);
  // 40 GB free: N=20 (27.4 GB) is admitted at once; 20 GB free is not, and the wait ends with the reason.
  const free = (gb) => reading({ freePct: (gb / 64) * 100 });
  const ok = await load.admitLive({ n: 20, thresholds: t, sample: seq(free(40)), timeoutMs: 1_000, pollMs: 10 });
  assert.deepEqual([ok.ok, ok.needBytes], [true, load.liveNeedBytes(20, { thresholds: t })]);
  const short = await load.admitLive({ n: 20, thresholds: t, sample: seq(free(20)), timeoutMs: 100, pollMs: 10 });
  assert.equal(short.ok, false);
  assert.match(short.reason, /N=20 needs 27\.4 GB available \(2 GB \+ 20 × 600 MB for the browsers, 20 × 700 MB for the stack's growth\), and the machine has 20\.0 GB/);
  const waited = await load.admitLive({ n: 10, thresholds: t, sample: seq(free(10), free(10), free(40)), timeoutMs: 5_000, pollMs: 10 });
  assert.equal(waited.ok, true, "it waits for the room to come");
  assert.ok(waited.waitedMs > 0);
  const small = await load.admitLive({ n: 5, thresholds: t, sample: () => assert.fail("N < 10 reads nothing") });
  assert.deepEqual([small.ok, small.needBytes], [true, 0]);
});
