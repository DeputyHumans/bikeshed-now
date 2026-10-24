// SPDX-License-Identifier: Apache-2.0
// Operator database configuration is explicit, validated and isolated from ambient deployment files (SPEC §9, §16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  x.getRtdb(); assert.equal(x.options().databaseURL, 'http://127.0.0.1:9000/?ns=demo-bikeshed');
  const y = fixture({ FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9000', GCLOUD_PROJECT: 'unsafe-project' });
  assert.throws(() => y.getRtdb(), /demo-/);
});

test('the installed Admin SDK creates an emulator handle with the exact demo namespace', () => {
  const module = new URL('../scripts/lib/firebase.mjs', import.meta.url).href;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { getApps, deleteApp } from 'firebase-admin/app';
    import { getRtdb } from ${JSON.stringify(module)};
    const db = getRtdb('demo-bikeshed-sdk-test');
    assert.notEqual(db, null, 'operator emulator RTDB handle must exist');
    db.goOffline();
    assert.equal(db.app.options.databaseURL, 'http://127.0.0.1:1/?ns=demo-bikeshed-sdk-test');
    assert.equal(new URL(db.ref().toString()).origin, 'http://127.0.0.1:1');
    await Promise.all(getApps().map(deleteApp));
  `], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', BIKESHED_BUCKET: 'demo-bikeshed-content', BIKESHED_DATABASE_URL: 'https://ignored.example.test' },
  });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
});

test('operator cleanup closes a live installed-SDK connection and lets the process exit naturally', () => {
  const module = new URL('../scripts/lib/firebase.mjs', import.meta.url).href;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    const api = await import(${JSON.stringify(module)});
    assert.equal(typeof api.closeAdmin, 'function', 'operators expose awaited cleanup');
    let connected;
    const accepted = new Promise(resolve => { connected = resolve; });
    const server = net.createServer(socket => { socket.resume(); connected(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:' + server.address().port;
    const db = api.getRtdb('demo-bikeshed-exit-test');
    db.ref('lifecycle-probe').on('value', () => {});
    await accepted;
    await api.closeAdmin();
    await api.closeAdmin();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    console.log('closed');
  `], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, BIKESHED_BUCKET: 'demo-bikeshed-content' },
  });
  assert.equal(probe.status, 0, `the SDK child exits after cleanup: ${probe.error?.code ?? ''} ${probe.stdout}${probe.stderr}`);
  assert.equal(probe.stdout.trim(), 'closed');
});

test('operator commands await client cleanup on success and before reporting failures', async () => {
  for (const command of ['publish', 'set-access', 'delete-version', 'teardown']) {
    const text = readFileSync(new URL(`../scripts/${command}.mjs`, import.meta.url), 'utf8');
    const footer = text.match(/^main\(\).*;$/m)?.[0];
    assert.ok(footer, `${command} has its command boundary`);
    for (const failed of [false, true]) {
      const events = [];
      await new Function('main', 'closeAdmin', 'fail', `return ${footer}`)(
        async () => { events.push('work'); if (failed) throw new Error('failed work'); },
        async () => { await new Promise(resolve => setImmediate(resolve)); events.push('cleanup'); },
        message => { events.push(message); },
      );
      assert.deepEqual(events, failed ? ['work', 'cleanup', 'failed work'] : ['work', 'cleanup'], `${command} cleanup follows settled work`);
    }
  }
});
