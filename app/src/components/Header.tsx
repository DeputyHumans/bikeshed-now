// SPDX-License-Identifier: Apache-2.0
// The application header (SPEC §7).

import { useState } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "../brand/Wordmark";
import { useAuth } from "../auth";
import { useIsPhone } from "../hooks/useMediaQuery";
import { AccountMenu } from "./AccountMenu";

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
              <span className="header-email" title={emailLower}>
                {emailLower}
              </span>
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
