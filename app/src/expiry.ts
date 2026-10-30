// SPDX-License-Identifier: Apache-2.0
// When a document stops being readable, and how that is said (SPEC §17).

import type { Timestamp } from "firebase/firestore";

/**
 * Expiry ends access to the CONTENT. It never deletes anything.
 *
 * This product does not delete documents — that is a decision, stated in
 * docs/architecture/overview.md, not a missing button. So an expiry cannot mean removal,
 * and the interface must not imply it does: the bytes, the versions and the
 * comments all survive, and the owner can move the date or clear it.
 *
 * The enforcement lives on the server, on the one path every byte takes. What
 * is here is the SAYING of it, in one place, so the workspace chip, the viewer
 * banner and the dialog cannot describe the same moment three different ways.
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
 * How an expiry reads to a person, or null when there is nothing to say.
 *
 * Deliberately vague past a week and precise inside a day, which is the shape
 * of what somebody actually needs to know. "Expires in 43 days" is noise;
 * "Expires today" changes what they do next.
 */
export function expiryLabel(
  value: Timestamp | number | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  const at = expiryMs(value);
  if (at === null) return null;
  if (at <= nowMs) return "Expired";

  const left = at - nowMs;
  if (left < DAY) return "Expires today";
  const days = Math.floor(left / DAY);
  if (days === 1) return "Expires tomorrow";
  if (days < 14) return `Expires in ${days} days`;
  return `Expires ${formatDay(at)}`;
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
 * denies a deletion in those words, and tells the reader whose action this is
 * — the owner is the only person who can open an expired document, so "only
 * you can open it" is flatly untrue for anybody else, and the thing they
 * actually need is who to ask.
 */
export function expiryExplanation(
  value: Timestamp | number | null | undefined,
  isOwner: boolean,
  nowMs: number = Date.now(),
): string | null {
  const at = expiryMs(value);
  if (at === null) return null;
  if (at > nowMs) {
    return isOwner
      ? `Readable until ${formatDay(at)}. Nothing is deleted then — only you can open it after that, and it cannot be edited until you change or clear the date.`
      : `Readable until ${formatDay(at)}. Nothing is deleted then — only its owner can open it after that.`;
  }
  return isOwner
    ? "This document has expired. Nothing has been deleted — only you can open it now, and it cannot be edited until you change or clear the date."
    : "This document has expired and is no longer readable. Nothing has been deleted — its owner can restore it by changing the date.";
}

/** True inside the last week, which is when a chip should start insisting. */
/**
 * A folder's date, which ends its link and its public level and nothing else
 * (SPEC §17 "A folder's reach"). It must not say "expires": the folder, its
 * documents and everybody it is shared with by name are untouched.
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
    return `Its link works until ${formatDay(at)}. Nothing is deleted then: the link stops working, and ${who} keep their access.`;
  }
  return isOwner
    ? `Its link stopped working on ${formatDay(at)}. Nothing has been deleted, and ${who} still have access. Change or clear the date to share it again.`
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

export function expiringSoon(
  value: Timestamp | number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const at = expiryMs(value);
  return at !== null && at > nowMs && at - nowMs < 7 * DAY;
}

/**
 * `<input type="date">` speaks "YYYY-MM-DD" and means MIDNIGHT — the instant a
 * day begins. A person choosing the first of October means the document is
 * readable through that day, so the value is the END of it: taking midnight
 * literally would expire it a day early, and the report would be that expiry is
 * off by one rather than that a date input has a convention.
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
