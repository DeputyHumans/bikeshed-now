// SPDX-License-Identifier: Apache-2.0
// Controls must select the suite that owns their spec before allocating a stack (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listControlSets, readControl } from "../lib/controls.mjs";

function withControl(target, check) {
  const root = mkdtempSync(join(tmpdir(), "e2e-control-suite-"));
  const set = "controls-suite";
  try {
    mkdirSync(join(root, set));
    writeFileSync(join(root, set, "10-x.patch"), "");
    writeFileSync(join(root, set, "control.json"), JSON.stringify({
      oracle: "suite selection", what: "fixture", target: { case: "fixture", ...target }, expect: { message: "fixture" },
    }));
    check(() => readControl(set, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a concurrency spec cannot silently use the default functional suite", () => {
  withControl({ spec: "e2e/specs/concurrency/example.spec.mjs" }, (read) => {
    assert.throws(read, /target\.suite functional cannot select concurrency spec/);
  });
});

test("a functional spec cannot select the concurrency suite", () => {
  withControl({ spec: "e2e/specs/functional/example.spec.mjs", suite: "concurrency" }, (read) => {
    assert.throws(read, /target\.suite concurrency cannot select functional spec/);
  });
});

test("explicit concurrency and smoke's functional spec remain valid", () => {
  withControl({ spec: "e2e/specs/concurrency/example.spec.mjs", suite: "concurrency" }, (read) => assert.equal(read().target.suite, "concurrency"));
  withControl({ spec: "e2e/specs/functional/smoke.spec.mjs", suite: "smoke" }, (read) => assert.equal(read().target.suite, "smoke"));
  withControl({ spec: "e2e/specs/functional/example.spec.mjs" }, (read) => assert.equal(read().target.suite, "functional"));
});

test("every committed concurrency control explicitly selects concurrency", () => {
  for (const set of listControlSets()) {
    const control = readControl(set);
    if (control.target.spec.startsWith("e2e/specs/concurrency/")) {
      assert.equal(control.target.suite, "concurrency", set);
    }
  }
});
