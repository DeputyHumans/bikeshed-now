// SPDX-License-Identifier: Apache-2.0
// A joining log must represent every durable inserted and deleted item before it may replace saved bytes (SPEC §6b, §16).

import { describe, expect, it } from "vitest";
import { causalOrder, type CausalStamp } from "./causal";

const stamp = (vector: CausalStamp["vector"], deletes: CausalStamp["deletes"] = {}, generation = "a".repeat(64)): CausalStamp => ({ generation, vector, deletes });

describe("causal ordering at shared-log adoption", () => {
  it("distinguishes complete, older, newer and incomparable inserted histories", () => {
    const saved = stamp({ 1: 10, 2: 3 });
    expect(causalOrder(saved, saved)).toBe("same");
    expect(causalOrder(stamp({ 1: 10, 2: 2 }), saved)).toBe("behind");
    expect(causalOrder(stamp({ 1: 10, 2: 4, 3: 1 }), saved)).toBe("ahead");
    expect(causalOrder(stamp({ 1: 11, 2: 2 }), saved)).toBe("concurrent");
    expect(causalOrder(stamp({ 1: 10 }), saved)).toBe("behind");
  });

  it("rejects a different seed generation even if its clocks are newer", () => {
    expect(causalOrder(stamp({ 1: 100 }, {}, "b".repeat(64)), stamp({ 1: 10 }))).toBe("generation");
  });

  it("orders a deletion-only save without an insertion-clock increment", () => {
    const before = stamp({ 1: 10 });
    const saved = stamp({ 1: 10 }, { 1: [[2, 3]] });
    expect(causalOrder(before, saved)).toBe("behind");
    expect(causalOrder(saved, before)).toBe("ahead");
    expect(causalOrder(stamp({ 1: 11 }), saved)).toBe("concurrent");
  });

  it("recognizes adjacent intervals as coverage without filling a missing deleted item", () => {
    const saved = stamp({ 1: 10 }, { 1: [[2, 3]] });
    expect(causalOrder(stamp({ 1: 10 }, { 1: [[2, 1], [3, 2]] }), saved)).toBe("same");
    expect(causalOrder(stamp({ 1: 10 }, { 1: [[2, 1], [4, 1]] }), saved)).toBe("behind");
    expect(causalOrder(stamp({ 1: 11 }, { 1: [[1, 2], [3, 2]] }), saved)).toBe("ahead");
    expect(causalOrder(stamp({ 1: 11 }, { 1: [[2, 1], [4, 1]] }), saved)).toBe("concurrent");
  });

  it("checks every client's deleted intervals and leaves both histories intact", () => {
    const saved = stamp({ 1: 10, 2: 8 }, { 1: [[2, 3]], 2: [[1, 2], [5, 1]] });
    const complete = stamp({ 1: 10, 2: 8 }, { 1: [[2, 3]], 2: [[0, 3], [5, 1]] });
    const before = JSON.stringify([complete, saved]);
    expect(causalOrder(complete, saved)).toBe("ahead");
    expect(JSON.stringify([complete, saved])).toBe(before);
    expect(causalOrder(stamp({ 1: 10, 2: 8 }, { 1: [[2, 3]], 2: [[1, 2]] }), saved)).toBe("behind");
  });
});
