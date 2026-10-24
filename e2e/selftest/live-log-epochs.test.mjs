// SPDX-License-Identifier: Apache-2.0
// Epoch-aware oracles never erase old bytes or conflate same-named entries from different sessions (SPEC §6b, §16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenLiveLogs, readLiveLogsPatient } from '../lib/live-log.mjs';
test('retired, current and legacy logs remain independently observable', () => {
  assert.deepEqual(flattenLiveLogs({ initial: { _seed: 'old', x: 'old delta' }, current: { _seed: 'new', x: 'new delta' }, oldFlat: 'legacy bytes' }), {
    'initial/_seed': 'old', 'initial/x': 'old delta', 'current/_seed': 'new', 'current/x': 'new delta', 'legacy/oldFlat': 'legacy bytes',
  });
});
test('an empty current epoch cannot hide a retired log from a cleanup oracle', () => {
  assert.equal(Object.keys(flattenLiveLogs({ retired: { _seed: 'old' }, current: {} })).length, 1);
  assert.deepEqual(flattenLiveLogs(null), {});
});
test('malformed wire state cannot be mistaken for an empty log', () => {
  assert.throws(() => flattenLiveLogs({ bad: 123 }), /invalid live log epoch/);
  assert.throws(() => flattenLiveLogs({ initial: { bad: {} } }), /invalid live log entry/);
});

test('patient epoch reads retain transient retry semantics and every retired entry', async () => {
  let reads = 0, retries = 0;
  const result = await readLiveLogsPatient({ kind: 'local' }, 'd', {
    intervalMs: 0, retryMs: 100,
    onRetry: () => retries++,
    read: async (_target, path) => {
      assert.equal(path, 'status/d/y');
      if (++reads === 1) throw new Error('rtdbGet status/d/y: 503 unavailable');
      return { retired: { _seed: 'old' }, current: { _seed: 'new' } };
    },
  });
  assert.equal(reads, 2); assert.equal(retries, 1);
  assert.deepEqual(result, { 'retired/_seed': 'old', 'current/_seed': 'new' });
});
