// SPDX-License-Identifier: Apache-2.0
// Bound release concurrency evidence to the explicit reviewed participant scope without changing historical cases (SPEC §12).
import assert from 'node:assert/strict';
export function concurrencyNs(campaign) {
  const scope = campaign.acceptance?.concurrencyScope;
  if (scope === undefined) return [2, 5, 10, 20];
  assert.deepEqual(scope, { maxParticipants: 10, authorization: 'user-2026-10-26', reason: 'User explicitly limited this release concurrency qualification to at most ten participants; twenty-participant coverage is deferred, not passed.' }, 'unreviewed concurrency scope');
  return [2, 5, 10];
}
export function inConcurrencyScope(campaign, row) {
  return row.n == null || concurrencyNs(campaign).includes(row.n);
}

/** One historical emulator-only finding remains open beyond the approved cap. */
export function deferredConcurrencyItems(campaign) {
  if (concurrencyNs(campaign).includes(20)) return [];
  const id = 'W2-c18-N20-firestore-oom';
  const item = campaign.items.find(row => row.id === id);
  assert.ok(item && item.classification === 'E' && item.requiredCases?.length > 0 && item.requiredCases.every(row => row.n === 20), 'only the original twenty-participant emulator limitation may be deferred');
  return [id];
}
