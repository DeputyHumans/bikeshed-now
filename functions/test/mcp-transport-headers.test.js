// SPDX-License-Identifier: Apache-2.0
// Hosting protects MCP responses rejected by the runtime before the handler runs (SPEC §23).

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function transportHeaders() {
  const config = JSON.parse(readFileSync(join(__dirname, '../../firebase.json'), 'utf8'));
  const rules = config.hosting.headers.filter((entry) => entry.source === '/mcp');
  return Object.fromEntries(rules.flatMap((rule) => rule.headers).map((header) => [header.key.toLowerCase(), header.value]));
}

test('Hosting makes pre-handler MCP failures private and non-cacheable', () => {
  assert.equal(transportHeaders()['cache-control'], 'private, no-store', 'runtime failures need /mcp no-store independently of the function handler');
});

test('Hosting exposes the MCP authentication challenge even on pre-handler failures', () => {
  assert.equal(transportHeaders()['access-control-expose-headers'], 'WWW-Authenticate', 'runtime failures need /mcp exposed authentication headers independently of the function handler');
});
