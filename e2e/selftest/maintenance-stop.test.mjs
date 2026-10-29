// SPDX-License-Identifier: Apache-2.0
// A failed maintenance boundary prevents later bodies from measuring a poisoned stack (SPEC §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR } from "../lib/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("maintenance failure stays failed and subsequent cases are explicitly not run", t => {
  const dir = tempDir("e2e-maintenance-stop-"), file = join(dir, "fixture.mjs");
  const runDir = join(OUT_DIR, `selftest-maintenance-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const helper = new URL("../lib/test.mjs", import.meta.url).href;
  writeFileSync(file, `import { scenario, setTarget } from ${JSON.stringify(helper)};
setTarget({ kind: "local", runId: "maintenance-fixture", runDir: ${JSON.stringify(runDir)}, origin: "http://127.0.0.1:9", capabilities: new Set(), stack: {} });
scenario("first", { tiers: ["local"] }, async () => { throw new Error("body must not run"); });
scenario("second", { tiers: ["local"] }, async () => { throw new Error("body must not run"); });
`);
  const env = { ...process.env, E2E_INVOCATION_DIR: "", E2E_RTDB_COVERAGE_RECYCLE: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", timeout: 10_000, env });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout, /not ok 1 - first/);
  assert.match(child.stdout, /ok 2 - second # SKIP NOT RUN: prior maintenance or cleanup failed/);
  assert.doesNotMatch(child.stdout, /body must not run/);
});
