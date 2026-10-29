// SPDX-License-Identifier: Apache-2.0
// Reaping atomically replaces its retained stack record so concurrent cleanup cannot leave mixed JSON (SPEC §12).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../lib/stack.mjs", import.meta.url), "utf8");
test("the actual reaper publishes a complete record only through an atomic rename", () => {
  const helper = source.match(/function writeAtomic\(path, text\) \{[\s\S]*?\n\}/)?.[0];
  const publish = source.match(/rec\.reapedAt = new Date\(\)\.toISOString\(\);\s*try \{([\s\S]*?)\} catch \{\}/)?.[1];
  assert.ok(helper && publish, "exercise the actual record publication code");
  const rec = { runDir: "/run", state: "reaped", reapedAt: "now" };
  const destination = "/run/stack.json";
  const old = JSON.stringify({ state: "stopped", description: "a longer earlier record" });
  const files = new Map([[destination, old]]);
  const writes = [], renames = [];
  runInNewContext(`${helper}\n${publish}`, {
    rec, join, process: { pid: 123 },
    writeFileSync(path, bytes) {
      writes.push(path);
      assert.notEqual(path, destination, "reap must never truncate the shared destination in place");
      assert.equal(files.get(destination), old, "readers retain the complete previous record until rename");
      files.set(path, bytes);
    },
    renameSync(from, to) { renames.push([from, to]); files.set(to, files.get(from)); files.delete(from); },
  });
  assert.deepEqual(writes, ["/run/stack.json.123.tmp"]);
  assert.deepEqual(renames, [["/run/stack.json.123.tmp", destination]]);
  assert.deepEqual(JSON.parse(files.get(destination)), rec);
});
