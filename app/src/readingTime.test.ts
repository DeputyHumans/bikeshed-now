// SPDX-License-Identifier: Apache-2.0
// Reading time is the word count over a reading speed, rounded up, never less than a minute (SPEC §4).

import { describe, expect, it } from "vitest";
import { readingMinutes, readingTime, wordsOf } from "./readingTime";

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

describe("the words of the version on screen", () => {
  it("are its own count first, then a summary or a mirror only while it is of that version", () => {
    expect(wordsOf("v1", { version: { words: 300 }, latest: { version: "v1", words: 999 } })).toBe(300);
    expect(wordsOf("v1", { version: {}, latest: { version: "v1", words: 300 } })).toBe(300);
    expect(wordsOf("v1", { version: {}, latest: { version: "v2", words: 2380 } }), "the summary is of v2").toBeUndefined();
    expect(wordsOf("v2", { mirror: { currentVersion: "v2", words: 476 } })).toBe(476);
    expect(wordsOf("v1", { mirror: { currentVersion: "v2", words: 476 } }), "the mirror is of v2").toBeUndefined();
    expect(wordsOf("v1", { mirror: { currentVersion: "v1", words: null } }), "not counted yet").toBeUndefined();
  });
});
