// SPDX-License-Identifier: Apache-2.0
// Restore account analytics consent and seed an absent export default once per account (SPEC §15, §20).

import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import { setAnalyticsOptOut } from "./analytics";
import { DEPLOYMENT_MARKING } from "./config";
import { seedDefaultMarking, watchUser } from "./firestore";

export function useAccountPreferences(): boolean {
  const { user, gate, emailLower } = useAuth();
  const uid = user?.uid;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    void setAnalyticsOptOut(true);
    if (gate === "signed_out") {
      void setAnalyticsOptOut(false);
      setReady(true);
      return;
    }
    if (gate !== "ready" || !uid) return;
    let active = true;
    const stop = watchUser(uid, (record) => {
      if (!active) return;
      void setAnalyticsOptOut(record?.analyticsOptOut === true);
      setReady(true);
      if (record?.defaultMarking === undefined && DEPLOYMENT_MARKING.enabled) {
        // Account reads keep working if an offline write cannot seed yet. The
        // transaction re-reads the record, so another tab's choice wins.
        void seedDefaultMarking(uid, emailLower, DEPLOYMENT_MARKING).catch(() => {});
      }
    }, () => {
      if (!active) return;
      void setAnalyticsOptOut(true);
      setReady(false);
    });
    return () => { active = false; stop(); void setAnalyticsOptOut(true); };
  }, [gate, uid, emailLower]);
  return ready;
}
