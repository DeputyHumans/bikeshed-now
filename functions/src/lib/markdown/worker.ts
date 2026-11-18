// SPDX-License-Identifier: Apache-2.0
// The worker one reading is made in, so a page that costs too much costs only the worker (SPEC §19, ADR 0034).

import { parentPort, workerData } from "node:worker_threads";
import { readStripped, stripped, type ReadingContext } from "./reading";

/**
 * Run by `budget.ts`, never imported. It says how long the stripped page is
 * before it parses anything, because the strip is linear and the parse may be
 * killed: the budget needs the length and the counts either way.
 *
 * Messages, in order: `{ type: "stripped", length, leftOut }`, then either
 * `{ type: "reading", reading }` or `{ type: "error", code }` (a stack overflow
 * from deep nesting is a `RangeError`). A worker that runs out of memory or
 * time sends nothing more; the parent sees its exit.
 */
if (parentPort && workerData) {
  const { html, ctx, limit } = workerData as { html: string; ctx: ReadingContext; limit: number };
  const page = stripped(html);
  parentPort.postMessage({ type: "stripped", length: page.text.length, leftOut: page.leftOut });
  try {
    parentPort.postMessage({ type: "reading", reading: readStripped(page, ctx, limit) });
  } catch (err) {
    parentPort.postMessage({ type: "error", code: (err as Error)?.name ?? "Error" });
  }
}
