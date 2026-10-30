// SPDX-License-Identifier: Apache-2.0
// Reading time is the word count over a reading speed, rounded up, never less than a minute (SPEC §4).

import { describe, expect, it } from "vitest";
import { readingMinutes, readingTime } from "./readingTime";

describe("reading time", () => {
  it("rounds up, so a document is never shorter than it says", () => {
    expect(readingTime(2380)).toBe("10 min read");
    expect(readingTime(2381)).toBe("11 min read");
  });

  it("is at least a minute, even for a document with nothing in it", () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingTime(40)).toBe("1 min read");
  });

  it("says nothing until the words are counted", () => {
    expect(readingTime(undefined)).toBeNull();
    expect(readingTime(null)).toBeNull();
  });
});
