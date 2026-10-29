// SPDX-License-Identifier: Apache-2.0
// Explicit per-person reads over raw session records, retaining legacy uid-keyed fixture support (SPEC §16).

/** Each session remains inspectable; no generic RTDB read rewrites wire data. */
export function sessionsFor(peers, uid) {
  return Object.entries(peers ?? {}).filter(([key, peer]) => (peer?.uid ?? key) === uid)
    .map(([key, peer]) => ({ key, ...peer }));
}

/** Agent refusals are about people: any of their tabs editing keeps the mode edit. */
export function presenceModes(peers) {
  const result = {};
  for (const [key, peer] of Object.entries(peers ?? {})) {
    const uid = peer?.uid ?? key;
    if (result[uid] !== 'edit') result[uid] = peer?.mode ?? null;
  }
  return result;
}

/** Focus/viewport follow the newest editing session, or newest reader if none edits. */
export function presenceFor(peers, uid) {
  return sessionsFor(peers, uid).sort((a, b) => Number(b.mode === 'edit') - Number(a.mode === 'edit') || (b.lastChanged ?? 0) - (a.lastChanged ?? 0))[0] ?? null;
}
