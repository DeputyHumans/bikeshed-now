// SPDX-License-Identifier: Apache-2.0
// The one consent this product asks for, and only when it has something to ask (SPEC §15).

import { useState } from "react";
import { Link } from "react-router-dom";
import { analyticsConfigured, initAnalytics } from "../analytics";
import { readConsent, writeConsent, type Consent } from "../consent";

/**
 * Deliberately small, and deliberately not a wall.
 *
 * It appears only when this deployment has a measurement id AND the visitor has
 * not answered. A self-hosted Bikeshed with analytics unconfigured never shows
 * it, because there would be nothing to consent to.
 *
 * Declining is a real decline: analytics never initializes, so the measurement
 * script is never fetched. It is not "load it and switch it off", which leaves
 * a request in somebody's logs regardless of the answer.
 *
 * The session cookie is not mentioned because it does not need consent — it is
 * strictly necessary to serve a document to the person who asked for it, and
 * asking permission for the thing that makes the page work teaches people to
 * click Accept without reading.
 */
export function CookieConsent() {
  /**
   * Read the stored answer DURING the first render, not in an effect.
   *
   * Starting at "unset" and correcting in an effect paints the card once for
   * every returning visitor who settled this months ago — a real flash, not a
   * theoretical one. `readConsent()` is synchronous and already swallows a
   * throwing store, so there is nothing to defer. There is no server render
   * here to disagree with.
   */
  const [consent, setConsent] = useState<Consent>(readConsent);

  if (!analyticsConfigured() || consent !== "unset") return null;

  const answer = (value: "granted" | "denied") => {
    writeConsent(value);
    setConsent(value);
    if (value === "granted") initAnalytics();
  };

  return (
    <aside className="consent" aria-label="Cookie choices">
      <p className="consent-text">
        We would like to count page views, to see which parts of Bikeshed get
        used. No document titles, addresses or contents are ever sent, and
        documents work either way. See the{" "}
        <Link to="/privacy">privacy policy</Link>.
      </p>
      {/* Decline first, so it is the first of the two to take focus. Neither
          carries .btn-primary: the accent means "the primary action of this
          surface", and this surface has no preferred answer. */}
      <div className="consent-actions">
        <button type="button" className="btn" onClick={() => answer("denied")}>
          No thanks
        </button>
        <button type="button" className="btn" onClick={() => answer("granted")}>
          Allow
        </button>
      </div>
    </aside>
  );
}
