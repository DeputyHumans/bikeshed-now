// SPDX-License-Identifier: Apache-2.0
// Concurrency cleanup and commit oracles follow immutable metadata and retain evidence after pointer deletion (SPEC §6a, §12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { draftStoragePrefix } from '../lib/admin.mjs';

const c12 = readFileSync(new URL('../specs/concurrency/c12-agent-vs-editors.spec.mjs', import.meta.url), 'utf8');
const c08 = readFileSync(new URL('../specs/concurrency/c08-mint-races.spec.mjs', import.meta.url), 'utf8');
const between = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function c12Fixture() {
  const objects = new Set(['docs/d/bundles/version/index.html', 'docs/d/bundles/retired/index.html']);
  const metadata = new Map([
    ['docs/d', { currentVersion: 'v2', draft: { baseVersion: 'v1', storagePrefix: 'docs/d/bundles/retired' } }],
    ['docs/d/versions/v2', { storagePrefix: 'docs/d/bundles/version' }],
  ]);
  const versions = [{ id: 'v2', storagePrefix: 'docs/d/bundles/version' }];
  const listObjects = async (_target, prefix, options) => [...objects].filter((name) => name.startsWith(prefix)).map((name) => options?.meta ? { name, generation: '1' } : name);
  const helperSource = between(c12, 'const retiredDraftPrefixes =', '/** What an update leaves behind:');
  const footprintSource = between(c12, 'async function footprint(', '/**\n * Every POST /draft');
  const api = new Function('listObjects', 'draftStoragePrefix', 'readDoc', 'readVersions', 'target', 'millis', `${helperSource}\n${footprintSource}\nreturn { rememberDraft, draftObjects, footprint };`)(listObjects, draftStoragePrefix, async (_target, key) => metadata.get(key) ?? null, async () => versions, {}, (value) => value ?? null);
  return { objects, metadata, versions, ...api };
}

test('C12 retains concrete retired paths after metadata disappears and excludes every published snapshot', async () => {
  const f = c12Fixture();
  f.rememberDraft('d', f.metadata.get('docs/d').draft);
  f.metadata.set('docs/d', { currentVersion: 'v2' });
  assert.deepEqual(await f.draftObjects('d', null, f.versions), ['docs/d/bundles/retired/index.html']);
  f.objects.delete('docs/d/bundles/retired/index.html');
  assert.deepEqual(await f.draftObjects('d', null, f.versions), []);
});

test('C12 also detects a failed save allocation that never returned draft metadata', async () => {
  const f = c12Fixture();
  f.objects.delete('docs/d/bundles/retired/index.html');
  f.objects.add('docs/d/bundles/refused/index.html');
  assert.deepEqual(await f.draftObjects('d', null, f.versions), ['docs/d/bundles/refused/index.html']);
});

test('C12 refusal footprint follows both draft and version pointers instead of empty legacy directories', async () => {
  const f = c12Fixture();
  const result = await f.footprint('d');
  assert.equal(result.v2Objects, 1);
  assert.deepEqual(result.objects, [{ name: 'docs/d/bundles/retired/index.html', generation: '1' }]);
  assert.equal(result.draft.storagePrefix, 'docs/d/bundles/retired');
});

test('C8 captures nonempty retiring objects before the write and still inspects them after draft metadata is deleted', async () => {
  let draft = { storagePrefix: 'docs/d/bundles/retired', baseVersion: 'v1' };
  const source = between(c08, 'async function captureRetiringDraft(', '/**\n * C9b S4b');
  const api = new Function('readDoc', 'listObjects', 'draftStoragePrefix', 'target', 'precondition', `${source}\nreturn { captureRetiringDraft, draftState };`)(async () => ({ currentVersion: 'v2', draft }), async (_target, prefix) => prefix === 'docs/d/bundles/retired/' ? [`${prefix}index.html`] : [], draftStoragePrefix, {}, (ok, why) => { assert.ok(ok, why); });
  const session = { docId: 'd' };
  await api.captureRetiringDraft(session);
  draft = null;
  const state = await api.draftState(session);
  assert.deepEqual(state.files, ['docs/d/bundles/retired/index.html']);
  assert.deepEqual(state.currentFiles, []);
});

test('C8 accepts only an explicit retryable draftChanged 409 as the superseded-snapshot toast', () => {
  const source = between(c08, 'function toastSplit(', 'const toastsWanted');
  const judge = new Function('CONFLICT_OUTCOME', `${source}\nreturn toastSplit;`)('conflict');
  const published = { name: 'latest', outcome: 'published', text: 'Published v2.', answer: { status: 200 } };
  const staleDraft = { name: 'old', outcome: 'error', text: 'draft changed; retry', answer: { status: 409, json: { draftChanged: true } } };
  assert.deepEqual(judge([published, staleDraft]), { s4b: [], other: [] });
  assert.equal(judge([published, { ...staleDraft, answer: { status: 409, json: {} } }]).other.length, 1);
  assert.equal(judge([published, { ...staleDraft, answer: { status: 500, json: { draftChanged: true } } }]).other.length, 1);
});

test('C8 separates selected version/draft bundles from refused candidates in a complete object inventory', async () => {
  const source = between(c08, 'async function serverSnapshot(', '/**\n * The plan\'s server settle');
  const snapshot = new Function('readDoc', 'readVersions', 'listObjects', 'draftStoragePrefix', 'target', 'short', `${source}\nreturn serverSnapshot;`)(
    async () => ({ currentVersion: 'v2', draft: { baseVersion: 'v2', storagePrefix: 'docs/d/bundles/draft' } }),
    async () => [{ id: 'v2', storagePrefix: 'docs/d/bundles/version' }],
    async () => ['docs/d/bundles/version/index.html', 'docs/d/bundles/draft/index.html', 'docs/d/bundles/refused/index.html'],
    draftStoragePrefix, {}, (value) => value,
  );
  assert.deepEqual((await snapshot('d')).orphanedObjects, ['docs/d/bundles/refused/index.html']);
});

test('readVersions retains the storage prefix required to distinguish published objects from orphans', async () => {
  const all = readFileSync(new URL('../lib/invariants.mjs', import.meta.url), 'utf8');
  const source = between(all, 'export async function readVersions(', '/**\n * I7:').replace('export ', '').replace('await import("./admin.mjs")', 'provider');
  const read = new Function('provider', `${source}\nreturn readVersions;`)({ readCollection: async () => [{ id: 'v2', data: { storagePrefix: 'docs/d/bundles/version' } }] });
  assert.equal((await read({}, 'd'))[0].storagePrefix, 'docs/d/bundles/version');
});
