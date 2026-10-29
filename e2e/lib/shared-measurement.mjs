// SPDX-License-Identifier: Apache-2.0
// Share expensive case measurements without hiding a failed prerequisite or requiring case order (SPEC §12).

/** A dependent judge may lazily run an unselected prerequisite, but never retry an attempted one. */
export function sharedMeasurement(name, options, measure) {
  let state = "unstarted";
  let failure = null;
  const run = async (ctx) => {
    if (state !== "unstarted") return ensure(ctx);
    state = "running";
    try {
      await measure(ctx);
      // A case budget races the body. A late completion cannot become reusable
      // success after the runner has already reported its deadline.
      if (ctx.budgetEndsAt && Date.now() >= ctx.budgetEndsAt) {
        throw new Error("the measurement completed after its case budget");
      }
      state = "complete";
    } catch (err) {
      state = "failed";
      failure = String(err?.message ?? err).split("\n")[0];
      throw err;
    }
  };
  const ensure = async (ctx) => {
    if (state === "unstarted") return run(ctx);
    if (state !== "complete") {
      ctx.inconclusive(`${name}: the earlier measurement ${state === "running" ? "has not completed" : `failed (${failure})`}; it is not retried`);
    }
  };
  return Object.freeze({ options, run, ensure });
}
