// SPDX-License-Identifier: Apache-2.0
// The line that tells someone Google renamed their account, and what became of it (SPEC §14).

import { useAuth } from "../auth";

/** What the waiting screen says while the gate is `loading`: a move takes longer than a sign-in. */
export function signingInLabel(movingTo: string | null | undefined): string {
  return movingTo ? `Moving your account to ${movingTo}` : "Signing in";
}

/**
 * Shown above every page once the person is in.
 *
 * `drift` is the one that matters most: an account signed in before its
 * Google address changed learns of it only here, and until it moves, nothing
 * shared with the new address shows up anywhere.
 */
export function AddressNotice() {
  const { gate, emailLower, addressNotice, moveToGoogleAddress, dismissAddressNotice } = useAuth();
  if (gate !== "ready" || !addressNotice) return null;
  const { kind, address } = addressNotice;

  if (kind === "drift") {
    return (
      <div className="banner banner-warn address-notice" role="status">
        <span>
          Google now knows you as <strong>{address}</strong>, but you're signed in here as{" "}
          {emailLower}. Move your account to see what's shared with your new address.
        </span>
        <button type="button" className="btn btn-sm" onClick={() => void moveToGoogleAddress()}>
          Move my account
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={dismissAddressNotice}>
          Not now
        </button>
      </div>
    );
  }

  return (
    <div className={`banner ${kind === "moved" ? "banner-success" : "banner-warn"} address-notice`} role="status">
      <span>
        {kind === "moved" ? (
          <>
            Your account now uses <strong>{address}</strong>. Apps you connected and personal
            tokens were signed out, so connect them again.
          </>
        ) : (
          <>
            Google knows you as <strong>{address}</strong>, but another account here already uses
            it, so you're still {emailLower}. Ask whoever runs this site to merge them.
          </>
        )}
      </span>
      <button type="button" className="btn btn-sm btn-quiet" onClick={dismissAddressNotice}>
        Dismiss
      </button>
    </div>
  );
}
