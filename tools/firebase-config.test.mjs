// SPDX-License-Identifier: Apache-2.0
// Operator database configuration is explicit, validated and isolated from ambient deployment files (SPEC §9, §16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const source = readFileSync(new URL('../scripts/lib/firebase.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '')
  .replace('const __dirname = dirname(fileURLToPath(import.meta.url));', 'const __dirname = "/isolated/scripts/lib";');
function fixture(env = {}, deployment = {}) {
  let options;
  const fakeAdmin = { initializeApp: (value) => (options = value), database: (app) => ({ app }), firestore: { FieldValue: {} } };
  const api = new Function('admin', 'existsSync', 'readFileSync', 'join', 'process', `${source}\nreturn { getRtdb };`)(
    fakeAdmin, () => true, () => JSON.stringify(deployment), join, { env: { GCLOUD_PROJECT: 'demo-bikeshed', ...env } },
  );
  return { ...api, options: () => options };
}
test('operator RTDB uses explicit environment before deployment configuration', () => {
  const x = fixture({ BIKESHED_DATABASE_URL: 'https://database.example.test' }, { databaseURL: 'https://configured.example.test' });
  x.getRtdb(); assert.equal(x.options().databaseURL, 'https://database.example.test');
  const y = fixture({}, { databaseURL: 'https://configured.example.test' });
  y.getRtdb(); assert.equal(y.options().databaseURL, 'https://configured.example.test');
});
test('absent database configuration remains optional instead of guessing a target', () => {
  const x = fixture(); x.getRtdb(); assert.equal(x.options().databaseURL, undefined);
});
test('malformed operator database URLs fail before initializing Admin', () => {
  for (const value of ['not a URL', 'http://database.example.test', 'https://user:secret@database.example.test', 'https://database.example.test/a', 'https://database.example.test?ns=other', 'https://database.example.test#part', 123]) {
    const x = fixture({}, { databaseURL: value });
    assert.throws(() => x.getRtdb(), /databaseURL|database URL/);
    assert.equal(x.options(), undefined);
  }
});
test('emulator use ignores deployment URLs and requires a demo project', () => {
  const x = fixture({ FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9000', BIKESHED_DATABASE_URL: 'https://database.example.test' });
  x.getRtdb(); assert.equal(x.options().databaseURL, undefined);
  const y = fixture({ FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9000', GCLOUD_PROJECT: 'unsafe-project' });
  assert.throws(() => y.getRtdb(), /demo-/);
});
