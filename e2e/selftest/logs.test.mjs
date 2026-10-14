// SPDX-License-Identifier: Apache-2.0
// Self-test: log waits read only after their mark, time out loudly, and refuse to prove absence too fast (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_TMP, ensureDir } from "../lib/paths.mjs";
import { expectNoLog, grepLog, logMark, waitForLog } from "../lib/logs.mjs";

const withLog = async (fn) => {
  const dir = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-logs-"));
  const file = join(dir, "emulators.log");
  writeFileSync(file, "");
  try {
    await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("waitForLog finds a line written after the mark, even one that arrives late", () =>
  withLog(async (file) => {
    const mark = logMark(file);
    setTimeout(() => appendFileSync(file, `>  [email] skipped "Hello" to a@b.invalid: no API key configured\n`), 300);
    const hit = await waitForLog(/\[email\] skipped "Hello"/, { file, since: mark, timeout: 5000, pollMs: 50 });
    assert.match(hit.line, /a@b\.invalid/);
    assert.ok(hit.waitedMs >= 250);
  }));

test("NEGATIVE: a matching line from BEFORE the mark never satisfies a wait", () =>
  withLog(async (file) => {
    appendFileSync(file, "[email] skipped \"Old\" to x@y.invalid\n");
    const mark = logMark(file);
    appendFileSync(file, "unrelated line\n");
    await assert.rejects(waitForLog(/skipped "Old"/, { file, since: mark, timeout: 400, pollMs: 50 }), (err) => err.code === "E2E_LOG_TIMEOUT" && /tail/.test(err.message));
    assert.equal(grepLog(/skipped "Old"/, { file }).length, 1, "the line is there, just before the mark");
    assert.equal(grepLog(/skipped "Old"/, { file, since: mark }).length, 0);
  }));

test("NEGATIVE: expectNoLog refuses a settle too short to prove absence, and fails on a present line", () =>
  withLog(async (file) => {
    await assert.rejects(expectNoLog(/x/, { file, settle: 1000 }), /cannot prove absence/);
    appendFileSync(file, "boom\n");
    await assert.rejects(expectNoLog(/boom/, { file, since: 0, settle: 200, allowShort: true, pollMs: 50 }), (err) => err.code === "E2E_LOG_PRESENT");
    const ok = await expectNoLog(/never/, { file, since: 0, settle: 200, allowShort: true, pollMs: 50 });
    assert.equal(ok.absent, true);
  }));
