// SPDX-License-Identifier: Apache-2.0
// The application header (SPEC §7).

import { useState } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "../brand/Wordmark";
import { useAuth } from "../auth";
import { useIsPhone } from "../hooks/useMediaQuery";
import { AccountMenu } from "./AccountMenu";
import { Person } from "./Person";

export function Header() {
  const { user, emailLower, gate, signOut } = useAuth();
  const phone = useIsPhone();
  // Signing out ends the server session first, a round trip that can be slow.
  const [signingOut, setSigningOut] = useState(false);

  return (
    <header className="app-header">
      <Link to="/" className="header-home" aria-label="Bikeshed home">
        <Wordmark />
      </Link>
      <div className="header-spacer" />
      {phone ? (
        <AccountMenu />
      ) : (
        <div className="header-actions">
          {/* A plain link, never a router <Link>: /docs is a Hosting redirect to
              the published guide, and a client-side navigation would meet the
              SPA's catch-all route instead and land on /. */}
          <a href="/docs" className="btn btn-quiet btn-sm">
            Docs
          </a>
          {gate === "ready" && user ? (
            <>
              {/* Who is signed in, as everyone else sees them: the short name
                  and its dot, the address under the pointer (ADR 0040). */}
              <Person uid={user.uid} email={emailLower} known={user.displayName} mark="chip" className="header-person" />
              <Link to="/account" className="btn btn-quiet btn-sm">
                Account
              </Link>
              <button
                type="button"
                className="btn btn-sm"
                disabled={signingOut}
                aria-busy={signingOut}
                onClick={() => {
                  setSigningOut(true);
                  void signOut().finally(() => setSigningOut(false));
                }}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      )}
    </header>
  );
}
