// SPDX-License-Identifier: Apache-2.0
// Expiry wording, and the date-input convention that would be off by one (SPEC §17).

import { describe, expect, test } from "vitest";
import {
  endOfDayMs,
  expiringSoon,
  expiryLabel,
  expiryMs,
  isExpired,
  toDateInput,
} from "./expiry";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

describe("reading a stored expiry", () => {
  test("accepts a number, a Timestamp, or nothing", () => {
    expect(expiryMs(1700000000000)).toBe(1700000000000);
    expect(expiryMs({ toMillis: () => 1700000000000 } as never)).toBe(1700000000000);
    expect(expiryMs(null)).toBeNull();
    expect(expiryMs(undefined)).toBeNull();
  });

  test("anything unreadable is not an expiry", () => {
    // The failure direction matters: a value that read as "expired" would hide
    // a document from everybody but its owner with nothing to point at.
    expect(expiryMs(NaN)).toBeNull();
    expect(expiryMs(Infinity)).toBeNull();
    expect(expiryMs({} as never)).toBeNull();
    expect(isExpired(NaN, NOW)).toBe(false);
  });

  test("the moment itself counts as expired", () => {
    expect(isExpired(NOW, NOW - 1)).toBe(false);
    expect(isExpired(NOW, NOW)).toBe(true);
    expect(isExpired(null, NOW)).toBe(false);
  });
});

describe("what it says", () => {
  test("precise inside a day, vague beyond a fortnight", () => {
    expect(expiryLabel(null, NOW)).toBeNull();
    expect(expiryLabel(NOW - HOUR, NOW)).toBe("Expired");
    expect(expiryLabel(NOW + HOUR, NOW)).toBe("Expires today");
    expect(expiryLabel(NOW + DAY + HOUR, NOW)).toBe("Expires tomorrow");
    expect(expiryLabel(NOW + 5 * DAY, NOW)).toBe("Expires in 5 days");
    // Past a fortnight a countdown is noise, so it becomes a date.
    expect(expiryLabel(NOW + 60 * DAY, NOW)).toMatch(/^Expires \w/);
  });

  test("soon means the last week, and never means already gone", () => {
    expect(expiringSoon(NOW + 3 * DAY, NOW)).toBe(true);
    expect(expiringSoon(NOW + 30 * DAY, NOW)).toBe(false);
    expect(expiringSoon(NOW - DAY, NOW)).toBe(false);
    expect(expiringSoon(null, NOW)).toBe(false);
  });
});

describe("the date field", () => {
  test("a chosen day expires at its END, not at its start", () => {
    // <input type="date"> yields midnight, the instant a day BEGINS. Taking it
    // literally would expire a document a whole day before the date shown on
    // the control that set it.
    const at = endOfDayMs("2026-10-01");
    expect(at).not.toBeNull();
    const d = new Date(at as number);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);

    // The whole of the chosen day is still readable.
    expect(isExpired(at, new Date(2026, 9, 1, 18, 0, 0).getTime())).toBe(false);
    expect(isExpired(at, new Date(2026, 9, 2, 0, 0, 1).getTime())).toBe(true);
  });

  test("a malformed date is not a date", () => {
    expect(endOfDayMs("")).toBeNull();
    expect(endOfDayMs("tomorrow")).toBeNull();
    expect(endOfDayMs("2026-10")).toBeNull();
  });

  test("filling the field back in round-trips the day", () => {
    const at = endOfDayMs("2026-10-01") as number;
    expect(toDateInput(at)).toBe("2026-10-01");
    expect(toDateInput(null)).toBe("");
  });
});
