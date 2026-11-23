// SPDX-License-Identifier: Apache-2.0
// Whether this tab shows comments and other people's activity over a document, for the tab alone (SPEC §6, §16).

import { useCallback, useSyncExternalStore } from "react";

/**
 * One switch hides every comment highlight, every suggestion's label and every
 * other person's cursor, selection and name, for a clean page (SPEC §6, §16).
 * Presence keeps going underneath: the reader still shows up for others,
 * following still moves them, and the slide list still shows who is where.
 *
 * Held in this module, so it lasts across documents opened in the tab — the
 * viewer remounts for each — and is forgotten on reload. Deliberately not on
 * the account with the other view choices (ADR 0041): it is a quiet moment
 * somebody asks for, not a layout they prefer, and a tab that came back to an
 * empty page would look like a document with no comments. Pavel chose this.
 */
let shown = true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setOthersShown(next: boolean): void {
  if (next === shown) return;
  shown = next;
  for (const listener of [...listeners]) listener();
}

/** The switch, and a way to flip it. */
export function useOthersShown(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => shown, () => true);
  return [value, useCallback((next: boolean) => setOthersShown(next), [])];
}

/** The ⋮ menu's entry for the switch, there for every reader, alone or not. */
export function othersMenuEntry(shown: boolean, set: (next: boolean) => void): { id: string; label: string; onSelect: () => void } {
  return {
    id: "others",
    label: shown ? "Hide comments and others' activity" : "Show comments and others' activity",
    onSelect: () => set(!shown),
  };
}
