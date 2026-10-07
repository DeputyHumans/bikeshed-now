// SPDX-License-Identifier: Apache-2.0
// The width a script-scaled deck is laid out at in the editor, and its scale (SPEC §6a, §6d).

import { describe, expect, it } from "vitest";
import { fitLayoutWidth, fitStyle } from "./useFrameFit";

describe("fitLayoutWidth", () => {
  it("brings back a centred slide cut off on both sides", () => {
    // A 1920px slide centred in a 1045px frame: 437.5px lost either side.
    const width = fitLayoutWidth(1045, [{ left: -437.5, right: 1482.5 }]);
    expect(width).toBe(1952);
    // Laid out that wide, the same centred slide starts at the gutter.
    expect((width! - 1920) / 2).toBe(16);
  });

  it("widens enough for content that only runs off the right", () => {
    const width = fitLayoutWidth(1000, [{ left: 24, right: 1944 }]);
    expect(width).toBe(1976);
    expect(1944).toBeLessThanOrEqual(width! - 16);
  });

  it("leaves a deck that already fits alone", () => {
    expect(fitLayoutWidth(1045, [{ left: 16, right: 1029 }])).toBeNull();
  });

  it("measures the widest reach across every slide", () => {
    expect(fitLayoutWidth(1000, [{ left: 0, right: 900 }, { left: -100, right: 1100 }])).toBe(1232);
  });

  it("does nothing without slides or a frame", () => {
    expect(fitLayoutWidth(1000, [])).toBeNull();
    expect(fitLayoutWidth(0, [{ left: -10, right: 2000 }])).toBeNull();
  });
});

describe("fitStyle", () => {
  it("scales the laid-out frame down to exactly the stage", () => {
    const style = fitStyle(2000, { width: 1000, height: 800 })!;
    expect(style.transform).toBe("scale(0.5)");
    expect(style.width).toBe(2000);
    // Scaled by a half, twice the stage's height fills it exactly.
    expect(style.height).toBe(1600);
    expect(style.transformOrigin).toBe("0 0");
  });

  it("never enlarges, when the stage has grown past the laid-out width", () => {
    expect(fitStyle(900, { width: 1200, height: 800 })!.transform).toBe("scale(1)");
  });

  it("waits for the stage to be measured", () => {
    expect(fitStyle(2000, { width: 0, height: 0 })).toBeUndefined();
  });
});
