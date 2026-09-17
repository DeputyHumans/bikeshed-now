// SPDX-License-Identifier: Apache-2.0
// The application header.

import { Link } from "react-router-dom";
import { Wordmark } from "../brand/Wordmark";
import { useAuth } from "../auth";
import { useIsExtraSmall } from "../hooks/useMediaQuery";

export function Header() {
  const { user, emailLower, gate, signOut } = useAuth();
  const compact = useIsExtraSmall();

  return (
    <header className="app-header">
      <Link to="/" aria-label="Bikeshed home">
        <Wordmark variant={compact ? "mark" : "full"} />
      </Link>
      <div className="header-spacer" />
      {gate === "ready" && user ? (
        <div className="header-actions">
          <span className="header-email" title={emailLower}>
            {emailLower}
          </span>
          <Link to="/account" className="btn btn-quiet btn-sm">
            Account
          </Link>
          <button type="button" className="btn btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      ) : null}
    </header>
  );
}
