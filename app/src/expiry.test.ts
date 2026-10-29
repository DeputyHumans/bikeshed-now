// SPDX-License-Identifier: Apache-2.0
// Expiry wording, and the date-input convention that would be off by one (SPEC §17).

import { describe, expect, test } from "vitest";
import {
  endOfDayMs,
  expiringSoon,
  expiryExplanation,
  expiryLabel,
  expiryMs,
  isExpired,
  sharingExplanation,
  sharingLabel,
  throughFolderExplanation,
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

/**
 * The sentence behind the chip — its tooltip, and the toast a tap shows to
 * somebody who cannot change the date. This used to be a banner; the wording
 * rules did not move with the pixels.
 */
describe("what it explains", () => {
  test("nothing, when there is no expiry", () => {
    expect(expiryExplanation(null, true, NOW)).toBeNull();
    expect(expiryExplanation(undefined, false, NOW)).toBeNull();
  });

  test("before the date, says until when — the same day the label shows", () => {
    const at = NOW + 60 * DAY;
    const day = (expiryLabel(at, NOW) as string).replace(/^Expires /, "");
    expect(expiryExplanation(at, true, NOW)).toContain(`Readable until ${day}.`);
    expect(expiryExplanation(at, false, NOW)).toContain(`Readable until ${day}.`);
  });

  test("tells the owner it is theirs to undo, and a reader who to ask", () => {
    // The owner is the only person who can open an expired document, so "only
    // you can open it" is flatly untrue for anybody else — and the thing a
    // reader actually needs is who can fix it.
    expect(expiryExplanation(NOW + DAY, true, NOW)).toMatch(/only you can open it/);
    expect(expiryExplanation(NOW + DAY, false, NOW)).toMatch(/only its owner can open it/);
    expect(expiryExplanation(NOW - DAY, true, NOW)).toMatch(/only you can open it/i);
    expect(expiryExplanation(NOW - DAY, false, NOW)).toMatch(/its owner can restore it/);
  });

  test("never claims anything was deleted", () => {
    // "Expire" reads as "delete" to almost everybody, and this product does
    // not delete documents at all — the versions, the comments and the bytes
    // all survive. Every sentence has to say so, or it teaches the wrong
    // model. The one permitted use of the word is the denial, so it is
    // removed before checking that nothing else claims a removal.
    for (const at of [NOW + DAY, NOW - DAY]) {
      for (const isOwner of [true, false]) {
        const text = expiryExplanation(at, isOwner, NOW) as string;
        expect(text).toMatch(/nothing (is|has been) deleted/i);
        const rest = text.replace(/nothing (is|has been) deleted/i, "");
        expect(rest).not.toMatch(/deleted|removed|gone/i);
      }
    }
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

describe("a folder's date, which ends its link and nothing else", () => {
  test("never says the folder expires, and escalates the same way", () => {
    expect(sharingLabel(null, NOW)).toBeNull();
    expect(sharingLabel(NOW + 3 * HOUR, NOW)).toBe("Sharing ends today");
    expect(sharingLabel(NOW + DAY + HOUR, NOW)).toBe("Sharing ends tomorrow");
    expect(sharingLabel(NOW + 5 * DAY, NOW)).toBe("Sharing ends in 5 days");
    expect(sharingLabel(NOW - 1, NOW)).toBe("Sharing ended");
    for (const at of [NOW + HOUR, NOW + 40 * DAY, NOW - DAY]) {
      expect(sharingLabel(at, NOW)).not.toMatch(/expire/i);
    }
  });

  test("says nothing is deleted and the people it is shared with keep access", () => {
    for (const at of [NOW + 40 * DAY, NOW - DAY]) {
      for (const isOwner of [true, false]) {
        const said = sharingExplanation(at, isOwner, NOW) as string;
        expect(said).toMatch(/nothing (is|has been) deleted/i);
        expect(said).toMatch(/keep their access|still have access/);
      }
    }
    expect(sharingExplanation(NOW - DAY, true, NOW)).toMatch(/change or clear the date/i);
    expect(sharingExplanation(NOW - DAY, false, NOW)).not.toMatch(/change or clear/i);
  });

  test("a reader who came through the link is told their link ends, and who to ask", () => {
    expect(throughFolderExplanation(NOW + 40 * DAY, NOW)).toMatch(/through a shared folder until/);
    expect(throughFolderExplanation(NOW - 1, NOW)).toMatch(/ask whoever shared it/i);
    expect(throughFolderExplanation(null, NOW)).toBeNull();
  });
});
