// SPDX-License-Identifier: Apache-2.0
// Where a reader was in a list, kept for the history entry they left it from, so Back returns there (SPEC §13 "Grid and list").

/**
 * A list unmounts while a document is open, so Back used to find it at the
 * top, 25 items long, however far down the reader had been. What it drew and
 * how far it was scrolled are kept here, per history entry, and read back when
 * the same entry comes back.
 *
 * Keyed by an id this module writes into the entry's own `history.state`, not
 * by the router's key: the router gives every freshly loaded page the same key,
 * `"default"`, so two separate visits would share one place. An entry the
 * reader returns to with Back or Forward still carries its id; a new visit has
 * none, and starts at the top.
 *
 * Kept in `sessionStorage`: this tab, this session, never sent anywhere. Like
 * the workspace's other preferences it is a convenience, so storage that is
 * blocked or full only means Back starts at the top.
 */

export const PLACES_KEY = "bshd-list-places";

/** How many entries' places a tab keeps, newest first. */
export const PLACES_KEPT = 50;

/** The field this module adds to `history.state`. */
const STATE_FIELD = "bshdPlace";

export interface Place {
  /** Which list, as its reset key: a place is only restored to the same view, folder, sort, layout and filters. */
  list: string;
  /** How many items it had drawn. */
  shown: number;
  /** How far the window was scrolled. */
  y: number;
  /** When it was kept, epoch ms, for pruning. */
  at: number;
}

const isPlace = (v: unknown): v is Place =>
  !!v &&
  typeof v === "object" &&
  typeof (v as Place).list === "string" &&
  Number.isInteger((v as Place).shown) &&
  (v as Place).shown >= 0 &&
  typeof (v as Place).y === "number" &&
  Number.isFinite((v as Place).y) &&
  typeof (v as Place).at === "number";

/** This history entry's id, written into its state the first time a list asks; null where history cannot be written. */
export function entryId(): string | null {
  try {
    const state = window.history.state as Record<string, unknown> | null;
    const known = state && typeof state[STATE_FIELD] === "string" ? (state[STATE_FIELD] as string) : null;
    if (known) return known;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.history.replaceState({ ...(state ?? {}), [STATE_FIELD]: id }, "");
    return id;
  } catch {
    return null;
  }
}

function readAll(): Record<string, Place> {
  try {
    const raw = window.sessionStorage.getItem(PLACES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, Place> = {};
    for (const [entry, place] of Object.entries(parsed as Record<string, unknown>)) if (isPlace(place)) out[entry] = place;
    return out;
  } catch {
    return {};
  }
}

/** The place kept for this entry, when there is one. */
export function readPlace(entry: string): Place | null {
  return readAll()[entry] ?? null;
}

/** Keeps this entry's place, and only the newest `PLACES_KEPT` of them. */
export function savePlace(entry: string, place: Place): void {
  try {
    const all = readAll();
    all[entry] = place;
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, PLACES_KEPT);
    window.sessionStorage.setItem(PLACES_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Blocked or full: Back starts at the top, as it did before.
  }
}
