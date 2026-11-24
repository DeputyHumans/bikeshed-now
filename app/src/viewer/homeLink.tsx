// SPDX-License-Identifier: Apache-2.0
// Where the wordmark goes: Recent, or from a document the place it is filed (SPEC §13).

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/** Signed in, Recent; signed out, the landing page. Every page but a document. */
const HOME = "/";

/** One page's say in where the wordmark goes, told apart from another's that names the same place. */
interface Claim {
  readonly to: string;
}

type Claimer = (claim: Claim, holds: boolean) => void;

const HomeContext = createContext<string>(HOME);
const ClaimContext = createContext<Claimer>(() => {});

/**
 * Around the header and the routes, because the header is outside every page:
 * the viewer knows where its document is filed and the header does not.
 *
 * The setter has a context of its own, so a claim re-renders the two links that
 * read it and nothing else.
 */
export function HomeLinkProvider({ children }: { children: ReactNode }) {
  const [claim, setClaim] = useState<Claim | null>(null);
  const claimer = useCallback<Claimer>((next, holds) => {
    // A page lets go of its own claim only. One that took over in the meantime
    // keeps the wordmark: the page leaving is not the page arriving.
    setClaim((was) => (holds ? next : was === next ? null : was));
  }, []);
  return (
    <ClaimContext.Provider value={claimer}>
      <HomeContext.Provider value={claim?.to ?? HOME}>{children}</HomeContext.Provider>
    </ClaimContext.Provider>
  );
}

/** Where the wordmark goes from the page that is open. */
export const useHomeTo = () => useContext(HomeContext);

/**
 * Send the wordmark to `to` for as long as the calling page is mounted, and
 * back to Recent once it goes, so leaving a document by the wordmark leaves
 * the wordmark pointing at Recent on the page it lands on.
 */
export function useClaimHome(to: string) {
  const claimer = useContext(ClaimContext);
  useEffect(() => {
    const mine: Claim = { to };
    claimer(mine, true);
    return () => claimer(mine, false);
  }, [claimer, to]);
}
