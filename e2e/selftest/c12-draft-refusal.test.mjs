// SPDX-License-Identifier: Apache-2.0
// Pin C12's safe snapshot refusal without admitting unrelated errors (SPEC §2).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const source = readFileSync(new URL('../specs/concurrency/c12-agent-vs-editors.spec.mjs', import.meta.url), 'utf8');
const expression = source.match(/const odd = (drafts\.filter\([^\n]+\));/)[1];
const judge = new Function('drafts', 'DRAFT_STALE', `return ${expression};`);
const error = 'The draft changed while this request was running. Retry with the current draft.';
test('C12 permits the exact snapshot refusal and rejects malformed or unrelated failures', () => {
  assert.equal(judge([{ status: 409, json: { error, draftChanged: true } }], 'stale').length, 0);
  for (const row of [
    { status: 500, json: { error, draftChanged: true } },
    { status: 409, json: { error } },
    { status: 409, json: { error, draftChanged: 'true' } },
    { status: 409, json: { error: 'unrelated failure', draftChanged: true } },
  ]) assert.equal(judge([row], 'stale').length, 1, JSON.stringify(row));
});
