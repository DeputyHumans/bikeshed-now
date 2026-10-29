// SPDX-License-Identifier: Apache-2.0
// Prefer the explicitly selected or SDK-matched browser without losing the system fallback (SPEC §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeCandidates } from "../lib/browser.mjs";

test("an explicit browser wins, then the installed matching build, then system Chrome", () => {
  assert.deepEqual(chromeCandidates({ configured: "/custom/chrome", cached: "/cache/chrome", exists: () => true }), [
    { via: "E2E_CHROME", executablePath: "/custom/chrome" },
    { via: "ms-playwright-cache", executablePath: "/cache/chrome" },
    { via: "channel:chrome", channel: "chrome" },
  ]);
});
test("missing matching browser keeps system Chrome available without downloading", () => {
  assert.deepEqual(chromeCandidates({ configured: "", cached: "/missing/chrome", exists: () => false }), [{ via: "channel:chrome", channel: "chrome" }]);
});
