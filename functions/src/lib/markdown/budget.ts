// SPDX-License-Identifier: Apache-2.0
// A reading made within a time and memory budget, in a worker, one at a time per instance (SPEC §19, ADR 0034).

import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { noneLeftOut, READ_PARSE_CHARS, STOPS_EARLY, TOO_COMPLEX, UNREADABLE, type LeftOut, type Reading, type ReadingContext } from "./reading";

/**
 * Why this exists
 * ---------------
 * What a reading costs is not its length. Measured on one vCPU, 2M characters
 * of a dense tracker page read in 0.5 s, but 2M characters of bare `<p>`
 * elements take 23 s, because turndown copies its whole output for every
 * sibling it joins, and 100,000 nested `<div>`s take 48 s just to parse before
 * the converter overflows its stack. Converting on the request's own thread,
 * a page like that stalled every other request the instance was serving, ran
 * past the 60 s a function may take, and was never kept, so every read paid
 * it again.
 *
 * So a reading is made in a worker, which can be stopped and whose heap has a
 * ceiling, and each attempt has a deadline. An attempt that runs out of time
 * or memory, or throws, is followed by one on a shorter part of the page, and
 * when none fits the reading says the page could not be read. Every outcome
 * is a reading, which `stored.ts` keeps, so a page costs its budget once.
 *
 * One conversion at a time
 * ------------------------
 * A worker at its ceiling holds about 550 MiB beside the bundle's 150, so two
 * of them would reach the instance's 1 GiB. `oneAtATime` queues them; callers
 * hold it around everything a miss does (`stored.ts`).
 */

export interface Rung {
  /** Characters parsed after the strip. */
  chars: number;
  /** How long the attempt may take, from starting its worker. */
  ms: number;
  /** The worker's old-generation heap, in MiB. */
  heapMb: number;
}

/**
 * The attempts, in order: 40 s at worst, inside the 60 s Hosting gives a
 * function. The first parses as much as any reading does; the last is short
 * enough that bare paragraphs, the worst case measured, read in about 0.3 s.
 */
export const LADDER: readonly Rung[] = [
  { chars: READ_PARSE_CHARS, ms: 20_000, heapMb: 512 },
  { chars: 2_000_000, ms: 12_000, heapMb: 512 },
  { chars: 250_000, ms: 8_000, heapMb: 512 },
];

/** The compiled worker entry, beside this file. */
export const WORKER_FILE = join(__dirname, "worker.js");

/** How many workers are alive now, and the most there have been at once. For tests. */
export const workers = { live: 0, most: 0 };

type Why = "time" | "memory" | "error";
type Outcome = { reading: Reading } | { why: Why };

/** What the worker said about the stripped page before it parsed: known even when the parse is killed. */
interface Seen {
  length?: number;
  leftOut?: LeftOut;
}

/** One attempt in a fresh worker. Settles once the worker has exited, so its memory is gone before the next. */
function attempt(html: string, ctx: ReadingContext, rung: Rung, seen: Seen, file: string): Promise<Outcome> {
  return new Promise((resolve) => {
    let outcome: Outcome | null = null;
    let worker: Worker;
    try {
      worker = new Worker(file, {
        workerData: { html, ctx, limit: rung.chars },
        resourceLimits: { maxOldGenerationSizeMb: rung.heapMb },
      });
    } catch {
      resolve({ why: "error" });
      return;
    }
    workers.live += 1;
    workers.most = Math.max(workers.most, workers.live);
    const settle = (o: Outcome) => {
      if (outcome) return;
      outcome = o;
      void worker.terminate();
    };
    const timer = setTimeout(() => settle({ why: "time" }), rung.ms);
    worker.on("message", (msg: { type: string; length?: number; leftOut?: LeftOut; reading?: Reading }) => {
      if (msg.type === "stripped") {
        seen.length = msg.length;
        seen.leftOut = msg.leftOut;
      } else if (msg.type === "reading" && msg.reading) settle({ reading: msg.reading });
      else settle({ why: "error" });
    });
    worker.on("error", (err: Error & { code?: string }) => {
      settle({ why: err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "error" });
    });
    worker.on("exit", () => {
      clearTimeout(timer);
      workers.live -= 1;
      resolve(outcome ?? { why: "error" });
    });
  });
}

/**
 * A page's reading within the ladder's budgets. Never throws: a page that
 * fits no rung reads as `UNREADABLE`, with the counts the strip made. Hold
 * `oneAtATime` around it.
 */
export async function budgetedReading(
  html: string,
  ctx: ReadingContext,
  ladder: readonly Rung[] = LADDER,
  file: string = WORKER_FILE,
): Promise<Reading> {
  const seen: Seen = {};
  for (const [i, rung] of ladder.entries()) {
    // A shorter rung that would still parse the whole page fails as the last did.
    if (i > 0 && seen.length !== undefined && rung.chars >= seen.length) continue;
    const outcome = await attempt(html, ctx, rung, seen, file);
    if ("reading" in outcome) {
      const reading = outcome.reading;
      if (i === 0) return reading;
      const warnings = reading.warnings.filter((w) => w !== STOPS_EARLY && w !== TOO_COMPLEX);
      return { ...reading, warnings: [...warnings, TOO_COMPLEX], cut: true };
    }
    console.warn("reading: over budget", outcome.why);
  }
  return { body: "", leftOut: seen.leftOut ?? noneLeftOut(), warnings: [UNREADABLE], cut: true };
}

let tail: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every `fn` queued before it on this instance has settled, whatever they settled to. */
export function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
