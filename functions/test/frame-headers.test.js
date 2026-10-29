// SPDX-License-Identifier: Apache-2.0
// Every app-shell route retains framing protection during client-side navigation (SPEC §23).

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('Hosting denies frames for the app shell including aliases, without restricting document iframe routes', () => {
  const config = JSON.parse(readFileSync(join(__dirname, '../../firebase.json'), 'utf8'));
  // Hosting expands negated brace alternatives differently from its emulator:
  // the old brace pattern sent DENY even on successful content responses.
  // Keep one extglob alternative group; verify it against real Hosting.
  const source = '!/@(content|draft|thumb)/**';
  const rule = config.hosting.headers.find((entry) => entry.source === source);
  assert.ok(rule, 'all shell paths, including unknown paths that client-side redirect, need frame headers');
  const headers = Object.fromEntries(rule.headers.map((header) => [header.key, header.value]));
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Content-Security-Policy'], "frame-ancestors 'none'");
  // Explicit byte-route headers remain unchanged. Broadly denying every path
  // would prevent the same-origin iframe the editor needs.
  for (const path of ['/content/**', '/draft/**', '/thumb/**']) {
    const bytes = config.hosting.headers.filter((entry) => entry.source === path);
    assert.equal(bytes.some((entry) => entry.headers.some((header) => /^(X-Frame-Options|Content-Security-Policy)$/i.test(header.key))), false, path);
  }
});
