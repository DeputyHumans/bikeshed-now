// SPDX-License-Identifier: Apache-2.0
// The one consent this product asks for, and only when it has something to ask (SPEC §15).

import { useEffect, useState } from "react";
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
  const [consent, setConsent] = useState<Consent>("unset");

  useEffect(() => {
    setConsent(readConsent());
  }, []);

  if (!analyticsConfigured() || consent !== "unset") return null;

  const answer = (value: "granted" | "denied") => {
    writeConsent(value);
    setConsent(value);
    if (value === "granted") initAnalytics();
  };

  return (
    <aside className="consent" role="region" aria-label="Cookie choices">
      <p className="consent__text">
        We would like to count page views to see which parts of Bikeshed get
        used. No document titles, addresses or contents are ever sent — see the{" "}
        <Link to="/privacy">privacy policy</Link>. Documents work either way.
      </p>
      <div className="consent__actions">
        <button type="button" className="btn" onClick={() => answer("denied")}>
          No thanks
        </button>
        <button type="button" className="btn btn--primary" onClick={() => answer("granted")}>
          Allow
        </button>
      </div>
    </aside>
  );
}
