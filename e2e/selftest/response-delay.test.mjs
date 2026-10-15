// SPDX-License-Identifier: Apache-2.0
// Real Chrome proves response delays follow backend completion and preserve routing order (SPEC §12).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { BrowserPool } from '../lib/browser.mjs';
const { delayHostingResponse } = await import(process.env.E2E_RESPONSE_DELAY_SOURCE ?? '../lib/response-delay.mjs');
import { eventually } from '../lib/assert.mjs';

let server, pool, user, origin;
const hits = [];
before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/redirect') { res.writeHead(302, { location: '/landing' }); res.end(); }
    else if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><p>Response delay test</p>'); }
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; origin = `http://127.0.0.1:${port}`;
  pool = new BrowserPool({ target: { kind: 'local', origin, runId: 'selftest-response-delay', capabilities: new Set(['local']), stack: { ports: { hosting: port } } } });
  user = await pool.user(); await user.page.goto(origin);
});
after(async () => { await pool?.close(); await new Promise((resolve) => server?.close(resolve)); });
const launch = (path) => user.page.evaluate((path) => { window.responseValue = null; window.responseError = null; fetch(path, { method: 'POST' }).then(r => r.json()).then(value => { window.responseValue = value; }).catch(e => { window.responseError = String(e); }); }, path);
const answered = (hold) => eventually(() => hold.rows[0]?.backendAnsweredAt ?? false, { timeout: 5_000, interval: 5, message: 'the backend answered before response release' });

test('the server receives requests immediately but the browser waits for its already-completed response', async () => {
  const hold = await delayHostingResponse(user, '/commit', { delayMs: 500 });
  try {
    await launch('/commit'); await answered(hold);
    assert.ok(hits.includes('/commit'), 'backend received the commit before the hold');
    assert.equal(await user.page.evaluate(() => window.responseValue), null, 'browser has not received the held response');
    assert.deepEqual(await user.page.evaluate(() => fetch('/draft', { method: 'POST' }).then(r => r.json())), { path: '/draft' }, 'other requests keep their send order');
    assert.deepEqual(await user.page.evaluate(() => fetch('/commit').then(r => r.json())), { path: '/commit' }, 'another method on the same path is not held');
    assert.equal(hold.rows.length, 1, 'only the requested method is intercepted');
    await eventually(() => user.page.evaluate(() => window.responseValue ?? false), { timeout: 5_000, interval: 10, message: 'response released' });
    assert.ok(hold.rows[0].releasedAt - hold.rows[0].backendAnsweredAt >= 500, 'only the response is held for the requested duration');
    assert.equal(hold.rows[0].error, null);
  } finally { await hold.restore(); }
});

test('restore releases a held response and removes only its own interception', async () => {
  const hold = await delayHostingResponse(user, '/restore', { delayMs: 5_000 });
  await launch('/restore'); await answered(hold); await hold.restore();
  await eventually(() => user.page.evaluate(() => window.responseValue ?? false), { timeout: 5_000, interval: 10, message: 'restored response released' });
  assert.equal(hold.rows[0].release, 'restore', 'restore explicitly releases its completed backend response');
  assert.equal(hits.filter(path => path === '/restore').length, 1, 'restore never sends the completed request twice');
  assert.deepEqual(await user.page.evaluate(() => fetch('/restore', { method: 'POST' }).then(r => r.json())), { path: '/restore' });
  assert.equal(hold.rows.length, 1, 'a restored interceptor takes no further requests');
});

test('a redirected response is returned to the browser before its destination is requested', async () => {
  const hold = await delayHostingResponse(user, '/redirect', { delayMs: 5_000 });
  try {
    await launch('/redirect'); await answered(hold);
    assert.equal(hold.rows[0].status, 302, 'the fetch does not follow the redirect behind the isolation route');
    assert.equal(hits.includes('/landing'), false, 'no redirect destination is fetched while the response is held');
    await hold.restore();
    await eventually(() => user.page.evaluate(() => window.responseValue ?? false), { timeout: 5_000, interval: 10, message: 'browser follows released redirect' });
    assert.deepEqual(await user.page.evaluate(() => window.responseValue), { path: '/landing' });
  } finally { await hold.restore(); }
});

test('invalid pathname and duration cannot install a route', async () => {
  for (const path of ['https://example.invalid/commit', '//example.invalid/commit', '/commit?x=1']) await assert.rejects(delayHostingResponse(user, path, { delayMs: 10 }), /exact hosting pathname/);
  for (const delayMs of [0, -1, Infinity, 30_001]) await assert.rejects(delayHostingResponse(user, '/commit', { delayMs }), /30000/);
});
