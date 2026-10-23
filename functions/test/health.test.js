// SPDX-License-Identifier: Apache-2.0
// Proves dependency failure, deadlines, redaction and uncached health responses (SPEC §2).
const test = require("node:test");
const assert = require("node:assert/strict");
const { healthHandler } = require("../lib/lib/health");

function response() {
  return { headers: {}, code: 0, body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.code = n; return this; },
    json(v) { this.body = v; }, end() {} };
}
test("fresh dependency reads, HEAD and unsupported methods retain no-store", async () => {
  let reads = 0;
  const handler = healthHandler({ firestore: async () => { reads++; }, storage: async () => { reads++; }, report() {} });
  for (const method of ["GET", "GET", "HEAD", "POST"]) {
    const res = response();
    await handler({ method }, res);
    assert.equal(res.headers["Cache-Control"], "private, no-store");
    assert.equal(res.code, method === "POST" ? 405 : 200);
    assert.deepEqual(res.body, method === "GET" ? { status: "ok" } : undefined);
  }
  assert.equal(reads, 6);
});
for (const dependency of ["firestore", "storage"]) {
  test(`${dependency} errors are degraded without leaking details, then recover in one process`, async () => {
    let broken = true;
    const events = [];
    const deps = { firestore: async () => {}, storage: async () => {}, report: (name) => events.push(name) };
    deps[dependency] = async () => { if (broken) throw new Error("private credential and object details"); };
    const handler = healthHandler(deps);
    const bad = response();
    await handler({ method: "GET" }, bad);
    assert.deepEqual({ code: bad.code, body: bad.body, cache: bad.headers["Cache-Control"] },
      { code: 503, body: { status: "degraded" }, cache: "private, no-store" });
    assert.deepEqual(events, [dependency]);
    broken = false;
    const good = response();
    await handler({ method: "GET" }, good);
    assert.equal(good.code, 200);
  });
}
test("a stalled dependency has a bounded response", async () => {
  const events = [];
  const handler = healthHandler({ firestore: () => new Promise(() => {}), storage: async () => {}, report: (x) => events.push(x) }, 15);
  const res = response();
  await handler({ method: "GET" }, res);
  assert.deepEqual([res.code, res.body, events], [503, { status: "degraded" }, ["deadline"]]);
});
