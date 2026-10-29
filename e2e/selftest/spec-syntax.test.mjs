// SPDX-License-Identifier: Apache-2.0
// Reject broken declarations before emulator startup without executing scenario code (SPEC §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/tmp.mjs";
import { assertSpecsParse } from "../lib/specfile.mjs";

test("syntax preflight rejects duplicate declarations and never executes valid bodies", () => {
  const dir = tempDir("e2e-syntax-"), file = join(dir, "spec.mjs"), touched = join(dir, "executed");
  writeFileSync(file, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(touched)}, "bad"); const x = 1;`);
  assertSpecsParse([file, file]);
  assert.equal(existsSync(touched), false);
  writeFileSync(file, "const x = 1; const x = 2;");
  assert.throws(() => assertSpecsParse([file]), /spec syntax preflight failed.*[\s\S]*already been declared/);
  assert.throws(() => assertSpecsParse([join(dir, "absent.mjs")]), /spec syntax preflight failed/);
});
