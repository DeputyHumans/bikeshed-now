// SPDX-License-Identifier: Apache-2.0
// Preserve the requested response hold when a timer wakes before its monotonic deadline (SPEC §12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('an early timer wake cannot release the backend response before its requested deadline', async () => {
  let now = 0, handler, fulfilled = false;
  const timers = [];
  const scope = {
    URL, Date, performance: { now: () => now },
    setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimeout() {},
  };
  const source = readFileSync(new URL('../lib/response-delay.mjs', import.meta.url), 'utf8');
  runInNewContext(source.replace('export async function', 'async function') + '\nglobalThis.holdResponse = delayHostingResponse;', scope);
  const user = { target: { origin: 'http://127.0.0.1:1' }, page: { route: async (_match, callback) => { handler = callback; }, unroute: async () => {} } };
  const hold = await scope.holdResponse(user, '/commit', { delayMs: 500 });
  const pending = handler({ request: () => ({ method: () => 'POST' }), fetch: async () => ({ status: () => 200, dispose: async () => {} }), fulfill: async () => { fulfilled = true; } });
  await new Promise(setImmediate);
  assert.equal(timers[0].ms, 500);
  now = 499; timers.shift().callback();
  await new Promise(setImmediate);
  assert.equal(fulfilled, false, 'an early timer wake must preserve the response hold');
  assert.equal(timers[0].ms, 1, 'wait only the remaining duration');
  now = 500; timers.shift().callback();
  await pending;
  assert.equal(fulfilled, true);
  assert.equal(hold.rows[0].release, 'delay');
  await hold.restore();
});
