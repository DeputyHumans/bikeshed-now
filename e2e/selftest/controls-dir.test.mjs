// SPDX-License-Identifier: Apache-2.0
// Self-test: every `controls` invocation gets an output directory of its own, even two started in the same second (SPEC §12).

/**
 * The directory used to be `controls-<stamp>` at one-second resolution, made
 * with a recursive mkdir that succeeds on an existing directory, so two
 * invocations started in the same second wrote one ledger.json over the
 * other. makeControlsDir creates the leaf exclusively and takes a suffixed
 * name when the stamp's is held.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlsStamp, makeControlsDir } from "../lib/controls.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const AT = new Date("2026-10-11T05:12:59.987Z");

test("controlsStamp: the one-second stamp the directories have always carried", () => {
  assert.equal(controlsStamp(AT), "20261011-051259z");
});

test("makeControlsDir: the stamp's own name first, then a fresh directory for every later call in the same second", () => {
  const root = join(tempDir("e2e-ctldir-"), "out");
  const first = makeControlsDir(root, AT);
  assert.equal(first, join(root, "controls-20261011-051259z"), "the root is made, and the first call keeps the plain name");
  const more = Array.from({ length: 5 }, () => makeControlsDir(root, AT));
  const all = [first, ...more];
  assert.equal(new Set(all).size, 6, all.join("\n"));
  for (const d of more) assert.match(d, /controls-20261011-051259z-[a-z0-9]{4}$/);
  assert.ok(all.every((d) => statSync(d).isDirectory()));
  assert.equal(readdirSync(root).length, 6);
});

test("makeControlsDir: six processes started together with the same clock get six directories, and no ledger is overwritten", async () => {
  const root = join(tempDir("e2e-ctldir-par-"), "out");
  const mod = fileURLToPath(new URL("../lib/controls.mjs", import.meta.url));
  const child = (i) =>
    new Promise((resolve, reject) => {
      const src = `import { makeControlsDir } from ${JSON.stringify(mod)}; import { writeFileSync } from "node:fs"; import { join } from "node:path";
        const dir = makeControlsDir(${JSON.stringify(root)}, new Date(${JSON.stringify(AT.toISOString())}));
        writeFileSync(join(dir, "ledger.json"), JSON.stringify({ who: ${i} }));
        process.stdout.write(dir);`;
      const p = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (err += c));
      p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`child ${i}: ${code} ${err}`))));
    });
  const dirs = await Promise.all(Array.from({ length: 6 }, (_, i) => child(i)));
  assert.equal(new Set(dirs).size, 6, dirs.join("\n"));
  const whos = dirs.map((d) => JSON.parse(readFileSync(join(d, "ledger.json"), "utf8")).who).sort();
  assert.deepEqual(whos, [0, 1, 2, 3, 4, 5], "each invocation's ledger survives in its own directory");
});

test("makeControlsDir: an error that is not a collision is thrown at once, never retried under another name", () => {
  const root = tempDir("e2e-ctldir-err-");
  chmodSync(root, 0o555);
  try {
    assert.throws(() => makeControlsDir(root, AT), (e) => e.code === "EACCES");
  } finally {
    chmodSync(root, 0o755);
  }
  assert.deepEqual(readdirSync(root), []);
});
