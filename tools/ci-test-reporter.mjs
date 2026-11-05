// SPDX-License-Identifier: Apache-2.0
// A node:test reporter writing what CI's job summary reads, one JSON record per line (SPEC §12).

/**
 * Passed as a second reporter beside `spec`, so the log stays as it was:
 *   --test-reporter=spec --test-reporter-destination=stdout
 *   --test-reporter=<this file> --test-reporter-destination=<report>.jsonl
 *
 * Records, read back by parseNodeReport in ci-summary.mjs:
 *   case      one test, or a suite that failed in its own right
 *   file      a test file's counts and duration
 *   total     the whole run's counts; a report without one was cut short
 *   coverage  per-file coverage, under --experimental-test-coverage
 *   stderr    the end of a file's stderr, only for a file that failed as a whole
 *
 * A FILE THAT FAILS AS A WHOLE, from an import error or a top-level throw, is
 * reported as one test named after the file, with the message "test failed".
 * The reason is only on its stderr, so that is kept here. It has no order
 * relative to the failure, which is why it is written once the run has ended.
 *
 * Test names are data from the tree being tested, and a fork's pull request
 * controls them. This file only records them. Escaping is the renderer's job.
 */

const STDERR_LINES = 30;
const LINE_CHARS = 500;
const MESSAGE_CHARS = 4000;
const FRAMES = 5;

/** The real failure. node:test wraps it in an ERR_TEST_FAILURE whose cause is what was thrown. */
function failureOf(error) {
  const cause = error?.cause;
  const message = typeof cause === "string" ? cause : (cause?.message ?? error?.message ?? "");
  const stack = typeof cause?.stack === "string" ? cause.stack : "";
  return {
    failureType: error?.failureType ?? null,
    message: String(message).slice(0, MESSAGE_CHARS),
    frames: stack
      .split("\n")
      .filter((line) => /^\s+at /.test(line) && !/node:|node_modules/.test(line))
      .slice(0, FRAMES)
      .map((line) => line.trim().slice(0, LINE_CHARS)),
  };
}

function statusOf(type, data) {
  // First, because a todo that throws arrives as a failure and fails nothing.
  if (data.todo !== undefined) return "todo";
  if (type === "test:fail") return data.details?.error?.failureType === "cancelledByParent" ? "cancelled" : "fail";
  if (data.skip !== undefined) return "skip";
  return "pass";
}

const reasonOf = (value) => (typeof value === "string" ? value : null);

const line = (record) => `${JSON.stringify(record)}\n`;

export default async function* ciTestReporter(source) {
  /** The names open at each depth, per file. An event carries its own name and depth, not its parents'. */
  const open = new Map();
  const stderr = new Map();
  /** By the failure's name, which is the path as given, because stderr events carry that and not `file`. */
  const wholeFileFailures = new Map();

  for await (const { type, data } of source) {
    if (type === "test:start") {
      const stack = open.get(data.file) ?? [];
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
      open.set(data.file, stack);
    } else if (type === "test:pass" || type === "test:fail") {
      const kind = data.details?.type ?? "test";
      // A suite that passed says nothing its tests did not.
      if (kind === "suite" && type === "test:pass") continue;
      const parents = (open.get(data.file) ?? []).slice(0, data.nesting);
      const failure = type === "test:fail" ? failureOf(data.details?.error) : null;
      const wholeFile =
        data.nesting === 0 &&
        failure?.failureType === "testCodeFailure" &&
        failure.message === "test failed" &&
        Boolean(data.file?.endsWith(data.name));
      if (wholeFile) wholeFileFailures.set(data.name, data.file);
      yield line({
        kind: "case",
        type: kind,
        file: data.file ?? null,
        line: data.line ?? null,
        path: [...parents, data.name],
        status: statusOf(type, data),
        reason: reasonOf(data.skip) ?? reasonOf(data.todo),
        durationMs: data.details?.duration_ms ?? 0,
        wholeFile,
        ...failure,
      });
    } else if (type === "test:summary") {
      yield line({
        kind: data.file ? "file" : "total",
        file: data.file ?? null,
        counts: data.counts,
        durationMs: data.duration_ms,
      });
    } else if (type === "test:coverage") {
      const { totals, files } = data.summary;
      yield line({
        kind: "coverage",
        totals,
        files: files.map((file) => ({
          path: file.path,
          totalLineCount: file.totalLineCount,
          coveredLineCount: file.coveredLineCount,
          coveredLinePercent: file.coveredLinePercent,
          totalBranchCount: file.totalBranchCount,
          coveredBranchCount: file.coveredBranchCount,
          coveredBranchPercent: file.coveredBranchPercent,
          totalFunctionCount: file.totalFunctionCount,
          coveredFunctionCount: file.coveredFunctionCount,
          coveredFunctionPercent: file.coveredFunctionPercent,
          uncovered: file.lines.filter((entry) => entry.count === 0).map((entry) => entry.line),
        })),
      });
    } else if (type === "test:stderr") {
      const tail = stderr.get(data.file) ?? [];
      tail.push(...String(data.message).split("\n").filter(Boolean).map((text) => text.slice(0, LINE_CHARS)));
      stderr.set(data.file, tail.slice(-STDERR_LINES));
    }
  }

  for (const [name, file] of wholeFileFailures) {
    if (stderr.has(name)) yield line({ kind: "stderr", file, lines: stderr.get(name) });
  }
}
