// SPDX-License-Identifier: Apache-2.0
// When a document's date makes it private, and how that is said (SPEC §17).

import type { Timestamp } from "firebase/firestore";
import type { Visibility } from "./types";

/**
 * A date makes a document PRIVATE. It never deletes anything.
 *
 * When the date passes, an hourly job makes the document private and clears
 * the date: its link stops working, open editing goes off, and the people it
 * was shared with by name keep it (ADR 0029). Until the job runs, at most an
 * hour, it is its owner's alone. "Expire" reads as "delete" to almost
 * everybody, so the interface never says it: the bytes, the versions and the
 * comments all survive.
 *
 * The enforcement lives on the server. What is here is the SAYING of it, in
 * one place, so the workspace chip, the viewer's toolbar and the dialog cannot
 * describe the same moment three different ways. `level` is the document's own
 * visibility where the caller knows it: on a document already private, a date
 * changes nothing worth a chip.
 */

/** Firestore hands back a Timestamp; the public projection carries a number. */
export function expiryMs(
  value: Timestamp | number | null | undefined,
): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = typeof value.toMillis === "function" ? value.toMillis() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function isExpired(
  value: Timestamp | number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const at = expiryMs(value);
  return at !== null && at <= nowMs;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * How a date reads to a person, or null when there is nothing to say.
 *
 * Deliberately vague past a week and precise inside a day, which is the shape
 * of what somebody actually needs to know. "Goes private in 43 days" is noise;
 * "Goes private today" changes what they do next. Past the date it is the
 * hour before the job runs.
 */
export function expiryLabel(
  value: Timestamp | number | null | undefined,
  nowMs: number = Date.now(),
  level?: Visibility | null,
): string | null {
  const at = expiryMs(value);
  if (at === null) return null;
  if (at <= nowMs) return level === "private" ? "Date passed" : "Going private";
  if (level === "private") return null;

  const left = at - nowMs;
  if (left < DAY) return "Goes private today";
  const days = Math.floor(left / DAY);
  if (days === 1) return "Goes private tomorrow";
  if (days < 14) return `Goes private in ${days} days`;
  return `Goes private on ${formatDay(at)}`;
}

/** A day as the app writes one: "Oct 29, 2026". `timeZone` for a day that is already a UTC date. */
export function formatDay(at: number, timeZone?: string): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * The sentence behind the chip: its tooltip, and what a tap says to somebody
 * who cannot change the date. Two things it always does, whatever the state:
 * denies a deletion in those words, and tells the reader where they stand —
 * a reader cannot tell whether they hold the link or were named, so the
 * sentence says what happens to each.
 */
export function expiryExplanation(
  value: Timestamp | number | null | undefined,
  isOwner: boolean,
  nowMs: number = Date.now(),
  level?: Visibility | null,
): string | null {
  const at = expiryMs(value);
  if (at === null) return null;
  if (at > nowMs) {
    if (level === "private") return null;
    return isOwner
      ? `Shared until ${formatDay(at)}. Nothing is deleted then: it becomes private, its link stops working and open editing goes off, and the people you shared it with by name keep it.`
      : `Shared until ${formatDay(at)}. Nothing is deleted then: it becomes private, a link to it stops working, and the people it is shared with by name keep it.`;
  }
  if (level === "private") {
    return isOwner
      ? "Its date has passed and is cleared within the hour. Nothing has been deleted. Until then only you can open it; then the people you shared it with have it again."
      : "Its date has passed. Nothing has been deleted, and you can open it again within the hour.";
  }
  return isOwner
    ? "Its date has passed, and it becomes private within the hour. Nothing has been deleted. Until then only you can open it; change or clear the date to keep it shared."
    : "Its date has passed, and it is becoming private. Nothing has been deleted. If it was shared with you by name, you can open it again within the hour; a link to it has stopped working.";
}

/**
 * A folder's date, which makes the folder private: its link and its public
 * level end, and nothing else (SPEC §17 "A folder's reach"). It must not say
 * "expires": the folder, its documents and everybody it is shared with by name
 * are untouched.
 */
export function sharingLabel(
  value: Timestamp | number | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  const at = expiryMs(value);
  if (at === null) return null;
  if (at <= nowMs) return "Sharing ended";
  const left = at - nowMs;
  if (left < DAY) return "Sharing ends today";
  const days = Math.floor(left / DAY);
  if (days === 1) return "Sharing ends tomorrow";
  if (days < 14) return `Sharing ends in ${days} days`;
  return `Sharing ends ${formatDay(at)}`;
}

/** The sentence behind a folder's chip, for its owner and for its members. */
export function sharingExplanation(
  value: Timestamp | number | null | undefined,
  isOwner: boolean,
  nowMs: number = Date.now(),
): string | null {
  const at = expiryMs(value);
  if (at === null) return null;
  const who = isOwner ? "the people you shared it with" : "everyone it is shared with by name";
  if (at > nowMs) {
    return `Its link works until ${formatDay(at)}. Nothing is deleted then: the folder becomes private, the link stops working for good, and ${who} keep their access.`;
  }
  return isOwner
    ? `Its link stopped working on ${formatDay(at)}, and the folder becomes private within the hour. Nothing has been deleted, and ${who} still have access. Change or clear the date to keep it shared.`
    : `Its link stopped working on ${formatDay(at)}. Nothing has been deleted, and ${who} still have access.`;
}

/**
 * What a reader who came through a folder's link is told: their access ends,
 * the document does not, and they cannot tell who else may still read it.
 */
export function throughFolderExplanation(
  value: Timestamp | number | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  const at = expiryMs(value);
  if (at === null) return null;
  return at > nowMs
    ? `You can read this through a shared folder until ${formatDay(at)}. Nothing is deleted then: the link just stops working.`
    : "The shared link to this folder has stopped working. Nothing has been deleted. Ask whoever shared it for a new link.";
}

/** True inside the last week, which is when a chip should start insisting. */
export function expiringSoon(
  value: Timestamp | number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const at = expiryMs(value);
  return at !== null && at > nowMs && at - nowMs < 7 * DAY;
}

/**
 * `<input type="date">` speaks "YYYY-MM-DD" and means MIDNIGHT — the instant a
 * day begins. A person choosing the first of October means the document stays
 * shared through that day, so the value is the END of it: taking midnight
 * literally would make it private a day early, and the report would be that
 * expiry is off by one rather than that a date input has a convention.
 *
 * Local time, because the person picking it is thinking in theirs.
 */
export function endOfDayMs(dateInput: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  if (!m) return null;
  const at = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    23,
    59,
    59,
    999,
  );
  return Number.isNaN(at.getTime()) ? null : at.getTime();
}

/** The reverse, for filling the field from a stored value. */
export function toDateInput(
  value: Timestamp | number | null | undefined,
): string {
  const at = expiryMs(value);
  if (at === null) return "";
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
