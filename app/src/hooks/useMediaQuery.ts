// SPDX-License-Identifier: Apache-2.0
// matchMedia as a hook, plus the named tiers (SPEC §7).

import { useEffect, useState } from "react";
import {
  COARSE_POINTER_QUERY,
  COMPACT_TOOLBAR_QUERY,
  CONDENSED_QUERY,
  ONE_COLUMN_QUERY,
  PHONE_QUERY,
  REDUCED_MOTION_QUERY,
} from "./breakpoints";

/**
 * Only for responsive branches CSS cannot express — the Doc/Comments segmented
 * control, the drawers, Print moving into the More menu. Layout that CSS can handle
 * stays in the stylesheets, because a media query that lives in JavaScript does
 * not apply until after hydration.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    // Re-sync immediately: the viewport can change between render and effect.
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export const useIsCompactToolbar = () => useMediaQuery(COMPACT_TOOLBAR_QUERY);
export const useIsSingleColumn = () => useMediaQuery(ONE_COLUMN_QUERY);
export const useIsPhone = () => useMediaQuery(PHONE_QUERY);
export const useIsCondensed = () => useMediaQuery(CONDENSED_QUERY);
export const useCoarsePointer = () => useMediaQuery(COARSE_POINTER_QUERY);
export const usePrefersReducedMotion = () => useMediaQuery(REDUCED_MOTION_QUERY);
