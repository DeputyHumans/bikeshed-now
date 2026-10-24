// SPDX-License-Identifier: Apache-2.0
// Session-aware presence oracles retain every tab and distinguish wire records from people (SPEC §16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionsFor, presenceModes, presenceFor } from '../lib/presence.mjs';
const raw = {
  a: { uid: 'u', mode: 'edit', lastChanged: 1, focus: { exact: 'old' } },
  c: { uid: 'u', mode: 'edit', lastChanged: 10, focus: { exact: 'new' } },
  b: { uid: 'u', mode: 'view', lastChanged: 20 },
  legacy: { mode: 'view' },
};
test('session inventory preserves keys and every tab, including legacy records', () => {
  assert.deepEqual(sessionsFor(raw, 'u').map((p) => p.key), ['a', 'c', 'b']);
  assert.equal(sessionsFor(raw, 'legacy')[0].key, 'legacy');
  assert.deepEqual(sessionsFor(raw, 'absent'), []);
});
test('a reader cannot hide an editing sibling and only the last editing departure changes mode', () => {
  assert.deepEqual(presenceModes(raw), { u: 'edit', legacy: 'view' });
  const after = { ...raw }; delete after.a; delete after.c;
  assert.deepEqual(presenceModes(after), { u: 'view', legacy: 'view' });
});
test('focus selects the newest editing tab, then the newest reading tab', () => {
  assert.equal(presenceFor(raw, 'u')?.focus?.exact, 'new');
  const after = { ...raw }; delete after.a; delete after.c;
  assert.equal(presenceFor(after, 'u')?.key, 'b');
  assert.equal(presenceFor(raw, 'absent'), null);
});
