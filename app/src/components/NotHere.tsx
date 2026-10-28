// SPDX-License-Identifier: Apache-2.0
// The page for a document the reader cannot open, and the way back in (SPEC §1.4, §3).

import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

/**
 * "Not here", plus the one thing that can change the answer: signing in with
 * the address the document was shared with.
 *
 * It takes no props, and that is the point. "Absent" and "you may not read
 * this" must look the same (SPEC §1.4b), so what it offers is decided by the
 * reader's own sign-in state and the URL they typed. It is never handed the
 * document, so it cannot tell anyone anything about it.
 */
export function NotHere() {
  const { gate, emailLower, signOut } = useAuth();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  // Back to this exact URL: the version, the link key, the hash.
  const signIn = `/signup?next=${encodeURIComponent(`${pathname}${search}${hash}`)}`;

  return (
    <div className="empty-state">
      <h1>Not here</h1>
      <p>
        {/* Deliberately indistinguishable from "you may not read this": with
            no domain gate, a difference between the two would let anyone walk
            the slug space. */}
        This document does not exist, or you do not have access to it.
      </p>
      {gate === "loading" ? null : gate === "ready" ? (
        <>
          <p>
            You are signed in as <strong>{emailLower}</strong>. If somebody
            shared it with another of your addresses, sign in with that one.
          </p>
          {/* Signed out FIRST: /signup sends anyone still signed in straight
              back to `next`, which is this page. */}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void signOut().then(() => navigate(signIn))}
          >
            Use a different account
          </button>
        </>
      ) : (
        <>
          <p>
            If somebody shared it with you, sign in with the address they used.
            Signing in creates your account if you do not have one yet.
          </p>
          {/* Part-way through signing in, /signup resumes the step they left. */}
          <Link className="btn btn-primary" to={signIn}>
            {gate === "signed_out" ? "Sign in" : "Finish signing in"}
          </Link>
        </>
      )}
    </div>
  );
}
