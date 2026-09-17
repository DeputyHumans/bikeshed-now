// SPDX-License-Identifier: Apache-2.0
// Where the comment affordance goes (SPEC §6).

import { describe, expect, it } from "vitest";
import { fabPosition } from "./SelectionFab";

/**
 * Extracted into a pure function precisely because jsdom's
 * getBoundingClientRect returns zeros, so the placement is untestable in the
 * component — and placement is the part with the edge cases.
 */
const FRAME = { width: 1000, height: 800 };
const FAB = { width: 150, height: 34 };

describe("fabPosition", () => {
  it("sits above the selection and centred on it", () => {
    const pos = fabPosition({ top: 300, left: 400, width: 200, height: 20 }, FRAME, FAB);
    expect(pos.top).toBe(300 - 34 - 8);
    expect(pos.left).toBe(400 + 100 - 75);
  });

  it("flips BELOW when there is no room above", () => {
    // A selection at the top of the document is the common case on a first
    // read, not an edge case.
    const pos = fabPosition({ top: 4, left: 400, width: 200, height: 20 }, FRAME, FAB);
    expect(pos.top).toBe(4 + 20 + 8);
  });

  it("clamps to the left edge", () => {
    const pos = fabPosition({ top: 300, left: 0, width: 20, height: 20 }, FRAME, FAB);
    expect(pos.left).toBe(8);
  });

  it("clamps to the right edge", () => {
    const pos = fabPosition({ top: 300, left: 980, width: 20, height: 20 }, FRAME, FAB);
    expect(pos.left).toBe(FRAME.width - FAB.width - 8);
  });

  it("never runs off the bottom", () => {
    const pos = fabPosition({ top: 790, left: 400, width: 200, height: 20 }, FRAME, FAB);
    expect(pos.top).toBeLessThanOrEqual(FRAME.height - FAB.height - 8);
  });

  it("copes with a frame narrower than the button", () => {
    const pos = fabPosition(
      { top: 300, left: 10, width: 20, height: 20 },
      { width: 100, height: 400 },
      FAB,
    );
    expect(pos.left).toBe(8);
  });
});
