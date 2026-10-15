// SPDX-License-Identifier: Apache-2.0
// A role-change wait may excuse only a new Firestore listener outage with no later successful Listen answer (SPEC §12, §13).
const LISTEN = "/google.firestore.v1.Firestore/Listen/channel";

/** Evidence is scoped to the tested user's page and the write being judged. */
export function unrecoveredListenerLoss(user, since) {
  if (!Number.isFinite(since)) throw new TypeError("listener loss requires the write's start time");
  const faults = [
    ...(user.log?.console ?? []).filter((row) => row.t >= since && /Could not reach Cloud Firestore backend/.test(row.text ?? "")),
    ...(user.log?.sdkProbes ?? []).filter((row) => row.t >= since),
  ];
  if (!faults.length) return null;
  const lastFault = Math.max(...faults.map((row) => row.t));
  // A fresh 200 Listen response is transport recovery; even if the UI stays
  // stale after it, an earlier outage cannot excuse that product assertion.
  const recovered = (user.responses ?? []).some((row) => row.path === LISTEN && row.status === 200 && row.at > lastFault);
  if (recovered) return null;
  return { since, lastFault, signs: faults.length };
}
