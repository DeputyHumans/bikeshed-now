// SPDX-License-Identifier: Apache-2.0
// Fork ordering probes retain early requests and distinguish authenticated unlocks (SPEC §21).

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeForkOrder } from '../lib/fork-order.mjs';

function setup({ hold = true } = {}) {
  const page = new EventEmitter(); let handler, unrouted = false;
  page.url = () => 'http://localhost/d/source?k=key';
  page.route = async (_match, h) => { handler = h; };
  page.unroute = async () => { unrouted = true; };
  const req = (path, body, cookie = '') => ({ url: () => `http://localhost${path}`, method: () => 'POST', postDataJSON: () => body, allHeaders: async () => ({ cookie }) });
  const create = () => page.emit('request', req('/fork', { op: 'create', docId: 'source', k: 'key' }));
  let held = false, released = false, release, fallbacks = 0;
  const sleep = async () => { held = true; if (hold) await new Promise((r) => { release = r; }); };
  const unlock = async (cookie = '__session=valid') => {
    const request = req('/unlock', { docId: 'source', k: 'key' }, cookie);
    return handler({ request: () => request, fallback: async () => { fallbacks++; }, fetch: async () => ({ dispose: async () => {} }), fulfill: async () => { released = true; page.emit('response', { request: () => request, status: () => 200 }); } });
  };
  return { page, create, unlock, sleep, unrouted: () => unrouted, release: () => release(), held: () => held, released: () => released, fallbacks: () => fallbacks };
}

test('an early create stays early after the authenticated unlock answers', async () => {
  const f = setup(), probe = await observeForkOrder(f.page, { origin: 'http://localhost', docId: 'source', key: 'key', sleep: f.sleep });
  probe.beginSignIn(); const pending = f.unlock();
  for (let n = 0; n < 10 && !f.held(); n++) await Promise.resolve();
  assert.equal(f.held(), true); assert.equal(f.released(), false, 'the signed-in answer is held');
  f.create(); assert.equal(probe.creates[0].unlockAnswered, false);
  f.release(); await pending; f.create();
  assert.deepEqual(probe.creates.map((r) => r.unlockAnswered), [false, true], 'later completion cannot relabel the earlier create');
  await probe.restore(); f.create(); assert.equal(probe.creates.length, 2);
});

test('signed-out and unrelated unlock responses do not satisfy ordering', async () => {
  const f = setup({ hold: false }), probe = await observeForkOrder(f.page, { origin: 'http://localhost', docId: 'source', key: 'key', sleep: f.sleep });
  await f.unlock(); probe.beginSignIn(); await f.unlock('');
  f.page.emit('response', { request: () => ({}), status: () => 200 }); f.create();
  assert.equal(f.fallbacks(), 2); assert.equal(f.held(), false);
  assert.equal(probe.creates[0].unlockAnswered, false);
  await probe.restore();
});

test('restoring the fork probe drains a held unlock before browser teardown', async () => {
  const f = setup(), probe = await observeForkOrder(f.page, { origin: 'http://localhost', docId: 'source', key: 'key', sleep: f.sleep });
  probe.beginSignIn();
  const pending = f.unlock();
  for (let n = 0; n < 10 && !f.held(); n++) await Promise.resolve();
  assert.equal(f.held(), true);
  let restored = false;
  const restoring = probe.restore().then(() => { restored = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restored, false, 'restore must wait while an unlock callback still owns a response');
    assert.equal(f.unrouted(), false, 'an active route must remain registered until its response is fulfilled');
  } finally { f.release(); await pending; await restoring; }
  assert.equal(f.released(), true);
  assert.equal(restored, true);
  assert.equal(f.unrouted(), true);
});
