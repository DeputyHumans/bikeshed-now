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
  return `Expires ${new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
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
