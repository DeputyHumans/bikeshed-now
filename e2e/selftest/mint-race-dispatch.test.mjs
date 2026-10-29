// SPDX-License-Identifier: Apache-2.0
// Exercise the actual C8 browser-to-server gate handoff without awaiting its deliberately held responses (SPEC §12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function scenarioBody() {
  const source = readFileSync(new URL('../specs/concurrency/c08-mint-races.spec.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('scenario("C8 S4b a late losing Save');
  const body = source.indexOf('async (ctx) => {', start) + 'async (ctx) => {'.length;
  const end = source.indexOf('  const rows = await outcomesOf', body);
  assert.ok(start >= 0 && end > body);
  return source.slice(body, end);
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function exercise({ rejectArrival = false } = {}) {
  const responses = [deferred(), deferred(), deferred()];
  const outcomes = [deferred(), deferred(), deferred()];
  const users = outcomes.map((_, i) => ({ name: `p${i}`, page: i }));
  const waiting = new Set(), afterRead = new Set(), dispatched = [], arrivals = [];
  let releasedAll = false, freshDraft = false;
  const finish = i => { responses[i].resolve({}); outcomes[i].resolve({ ok: true, value: { outcome: i === 0 ? 'published' : 'conflict', versionId: 'v2' } }); };
  const g = {
    hold: async () => {},
    release: async (name, { count } = {}) => {
      if (name === 'commit-before-read') {
        const ids = [...waiting].slice(0, count ?? waiting.size);
        for (const i of ids) { waiting.delete(i); if (i === 0) finish(i); else afterRead.add(i); }
      } else { for (const i of afterRead) finish(i); afterRead.clear(); }
    },
  };
  const env = {
    gates: () => g, liveSession: async () => ({ docId: 'doc', entry: 'index.html', users }),
    tokenLog: () => ({}), target: { runId: 'run' }, typeAndSettle: async () => {},
    captureSaves: () => ({}), runTag: () => 'run', rand4: () => 'tag', HELD_MS: 100,
    holdRequests: page => ({ installed: Promise.resolve(), held: Promise.resolve(), release: () => {
      dispatched.push(page); waiting.add(page); return responses[page].promise;
    } }),
    pressSave: u => outcomes[u.page].promise,
    requireHeld: async (_ctx, _g, name, count) => {
      arrivals.push([name, count]);
      if (rejectArrival) throw new Error('injected arrival refusal');
      assert.equal((name === 'commit-before-read' ? waiting : afterRead).size, count);
    },
    readDraftObject: async () => ({ html: 'retained' }), precondition: assert.ok,
    saveFreshDraft: async () => { assert.equal(afterRead.size, 2); freshDraft = true; },
    releaseAll: async () => { releasedAll = true; for (let i = 0; i < 3; i++) finish(i); waiting.clear(); afterRead.clear(); },
  };
  const run = new Function(...Object.keys(env), `return async (ctx) => {${scenarioBody()}\n}`)(...Object.values(env));
  let timer;
  try {
    await Promise.race([run({ n: 3, target: env.target, step() {} }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('response awaited before server gate release')), 500); })]);
  } finally { clearTimeout(timer); }
  return { dispatched, arrivals, releasedAll, freshDraft };
}

test('C8 dispatches requests into each server gate before awaiting their responses', async () => {
  const result = await exercise();
  assert.deepEqual(result.dispatched, [0, 1, 2]);
  assert.deepEqual(result.arrivals, [['commit-before-read', 1], ['commit-before-read', 3], ['commit-after-read', 2]]);
  assert.equal(result.freshDraft, true);
  assert.equal(result.releasedAll, true);
});

test('C8 opens server gates before draining responses when arrival verification refuses', async () => {
  await assert.rejects(exercise({ rejectArrival: true }), /injected arrival refusal/);
});
