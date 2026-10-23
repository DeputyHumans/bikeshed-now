// SPDX-License-Identifier: Apache-2.0
// Health proves fresh dependency reads, failure, recovery and no-store through Hosting (SPEC §2, §12).
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, scenario } from "../../lib/test.mjs";
import { createHttp } from "../../lib/http.mjs";
import { healthMarker } from "../../lib/health.mjs";
import { closeAdmin } from "../../lib/admin.mjs";
const target = currentTarget();
after(() => target ? closeAdmin(target) : undefined);
scenario("health: valid → corrupt → missing → valid reads recover without a restart", { timeoutMs: 90_000 }, async () => {
  const http = createHttp(target, { actor: "health" });
  try {
    for (const state of ["valid", "corrupt", "missing", "valid"]) {
      await healthMarker(target, state);
      const res = await http.get("/health");
      assert.equal(res.status, state === "valid" ? 200 : 503);
      assert.deepEqual(res.json, { status: state === "valid" ? "ok" : "degraded" });
      assert.equal(res.headers.get("cache-control"), "private, no-store");
    }
    const head = await http.head("/health");
    assert.equal(head.status, 200); assert.equal(head.text, "");
    assert.equal(head.headers.get("cache-control"), "private, no-store");
    const post = await http.post("/health");
    assert.equal(post.status, 405); assert.equal(post.headers.get("cache-control"), "private, no-store");
  } finally { await healthMarker(target, "valid"); }
});
