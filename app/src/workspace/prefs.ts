// SPDX-License-Identifier: Apache-2.0
// What the workspace remembers in this browser: its sort, each kind of page's layout, Recent's filters (SPEC §13).

import { useCallback, useState } from "react";

/**
 * Every key this module writes, defined once.
 *
 * A convenience, never state anything depends on: the storage can be blocked,
 * cleared or absent (a private window, a locked-down browser), and then each
 * choice lasts as long as the page does. Nothing here leaves the browser.
 */
export const PREF_KEYS = {
  sort: "bshd-workspace-sort",
  layoutFolders: "bshd-workspace-layout",
  layoutRecent: "bshd-workspace-layout-recent",
  layoutShared: "bshd-workspace-layout-shared",
  recentFilters: "bshd-workspace-recent-filters",
} as const;

export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

export type Layout = "grid" | "list";

export const isLayout = (v: unknown): v is Layout => v === "grid" || v === "list";

/** The stored value, when there is one this version still understands. */
export function readPref<T>(key: PrefKey, valid: (v: unknown) => v is T): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

export function writePref(key: PrefKey, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Blocked or full: the choice lasts as long as the page. */
  }
}

/**
 * A choice that survives leaving the page and coming back, in this browser.
 *
 * The key may change while the component stays mounted (one workspace page
 * serves several kinds), so the value is re-read when it does, during render
 * rather than in an effect that would paint the old layout first.
 */
export function useRemembered<T>(
  key: PrefKey,
  fallback: T,
  valid: (v: unknown) => v is T,
): [T, (next: T) => void] {
  const [state, setState] = useState(() => ({ key, value: readPref(key, valid) ?? fallback }));
  let current = state;
  if (state.key !== key) {
    current = { key, value: readPref(key, valid) ?? fallback };
    setState(current);
  }
  const set = useCallback(
    (next: T) => {
      setState({ key, value: next });
      writePref(key, next);
    },
    [key],
  );
  return [current.value, set];
}
