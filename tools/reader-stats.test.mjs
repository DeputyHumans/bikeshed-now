// SPDX-License-Identifier: Apache-2.0
// Legacy reader redaction scans all pages without changing unrelated statistics (SPEC §4, §17).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeFirestore } from '../functions/test/fakes.js';
import { redactReaderStats as redact } from '../scripts/redact-reader-stats.mjs';
// The operator and functions deliberately install their own Admin SDK copies.
const sdk = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore');
const redactReaderStats = (db, options) => redact(db, options, sdk);

test('reader redaction previews, pages, preserves counters and is idempotent', async () => {
  const original = {
    'docs/a': { stats: { views: 3, lastViewedByEmail: 'private@example.com' } },
    'docs/b': { title: 'No stats' },
    'docs/c': { stats: { apiReads: 2, lastViewedByEmail: null, lastEditedByEmail: 'author@example.com' } },
    'docs/d': { stats: { views: 5 } },
  };
  const { db, store } = fakeFirestore(original);
  assert.deepEqual(await redactReaderStats(db, { pageSize: 1 }), { scanned: 4, affected: 2, dryRun: true });
  assert.deepEqual(Object.fromEntries(store), original, 'dry run writes nothing');
  assert.deepEqual(await redactReaderStats(db, { dryRun: false, pageSize: 1 }), { scanned: 4, affected: 2, dryRun: false });
  assert.deepEqual(Object.fromEntries(store), {
    'docs/a': { stats: { views: 3 } }, 'docs/b': original['docs/b'],
    'docs/c': { stats: { apiReads: 2, lastEditedByEmail: 'author@example.com' } }, 'docs/d': original['docs/d'],
  }, 'only the legacy reading identity is erased');
  assert.deepEqual(await redactReaderStats(db, { dryRun: false, pageSize: 2 }), { scanned: 4, affected: 0, dryRun: false });
});
