// SPDX-License-Identifier: Apache-2.0
// Control pairs share only named capability setup; product mutants stay exclusive to the red side (SPEC §12).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseStackOptionArgs, CONTROL_CAPABILITY_PATCHES } from "../lib/options.mjs";
import { greenGroups, greenRunArgs, redRunArgs, readControl } from "../lib/controls.mjs";

function assertSetup(parse) {
  for (const name of CONTROL_CAPABILITY_PATCHES) {
    assert.deepEqual(parse(["--patches", name]).patches, [name], "a named capability setup is preserved");
  }
  for (const name of ["controls-a19-route-privacy", "a19-export-mark-default", "arbitrary-product-fix", "a19-analytics-live-extra"]) {
    assert.throws(() => parse(["--patches", name]), /not a stack option/, "a product mutant or unreviewed patch cannot make the green side pass");
  }
  assert.throws(() => parse(["--keep"]), /not a stack option/);
}
test("stack setup admits only amplifiers and the explicit capability patch allowlist", () => assertSetup(parseStackOptionArgs));
test("postcommit projection controls share the precise dependency fault on both sides", () => {
  assert.deepEqual(parseStackOptionArgs(["--patches", "a12-projection-unavailable"]).patches, ["a12-projection-unavailable"]);
  const control = readControl("controls-a12-projection-refusal");
  const patches = (args) => args.flatMap((arg, i) => arg === "--patches" ? [args[i + 1]] : []);
  assert.deepEqual(patches(greenRunArgs(greenGroups([control])[0])), ["a12-projection-unavailable"]);
  assert.deepEqual(patches(redRunArgs(control)), ["a12-projection-unavailable", control.set]);
  assert.throws(() => parseStackOptionArgs(["--patches", "a12-projection-unavailable-extra"]), /not a stack option/);
});
test("A19 live controls put identical capability setup on green and red, adding only their own mutant on red", () => {
  const control = readControl("controls-a19-route-privacy");
  const green = greenRunArgs(greenGroups([control])[0]);
  const red = redRunArgs(control);
  const patches = (args) => args.flatMap((arg, i) => arg === "--patches" ? [args[i + 1]] : []);
  assert.deepEqual(patches(green), ["a19-analytics-live"]);
  assert.deepEqual(patches(red), ["a19-analytics-live", control.set]);
});
test("negative controls reject both a missing setup allowance and an unrestricted patch allowance", async () => {
  const url = new URL("../lib/options.mjs", import.meta.url);
  const source = readFileSync(url, "utf8").replace('"./gates.mjs"', JSON.stringify(new URL("./gates.mjs", url).href));
  const before = "CONTROL_CAPABILITY_PATCHES.includes(args[i + 1])";
  assert.ok(source.includes(before));
  for (const replacement of ["false", "true"]) {
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(before, replacement)).toString("base64")}`);
    assert.throws(() => assertSetup(mutant.parseStackOptionArgs), undefined, "the same admission oracle rejects the mutated parser");
  }
});
