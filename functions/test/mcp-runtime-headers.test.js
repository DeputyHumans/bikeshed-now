// SPDX-License-Identifier: Apache-2.0
// Exercise MCP transport protection before an HTTP listener can reject a body (SPEC §23).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
require('../lib/lib/mcp-transport');

async function request(t, path, target) {
  const previous = process.env.FUNCTION_TARGET;
  if (target === undefined) delete process.env.FUNCTION_TARGET;
  else process.env.FUNCTION_TARGET = target;
  t.after(() => {
    if (previous === undefined) delete process.env.FUNCTION_TARGET;
    else process.env.FUNCTION_TARGET = previous;
  });
  let entryHeaders;
  const server = createServer((req, res) => {
    entryHeaders = res.getHeaders();
    req.resume();
    res.statusCode = 400;
    res.end('Bad Request');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(response.status, 400);
  await response.text();
  return { entryHeaders, headers: response.headers };
}

for (const [path, target] of [['/mcp'], ['/mcp?probe=1'], ['/mcp/'], ['/', 'mcp']]) {
  test(`MCP refusal at ${path} (target ${target ?? 'unset'}) has headers before dispatch`, async (t) => {
    const { entryHeaders, headers } = await request(t, path, target);
    assert.equal(entryHeaders['cache-control'], 'private, no-store', 'MCP must be non-cacheable before the runtime listener');
    assert.equal(entryHeaders['access-control-expose-headers'], 'WWW-Authenticate', 'MCP must expose authentication before the runtime listener');
    assert.equal(headers.get('cache-control'), 'private, no-store');
    assert.equal(headers.get('access-control-expose-headers'), 'WWW-Authenticate');
  });
}

test('unrelated function routes retain their own caching policy', async (t) => {
  const { entryHeaders } = await request(t, '/content/example/v1/', 'contentProxy');
  assert.equal(entryHeaders['cache-control'], undefined);
  assert.equal(entryHeaders['access-control-expose-headers'], undefined);
});
