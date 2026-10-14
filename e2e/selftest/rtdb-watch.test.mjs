// SPDX-License-Identifier: Apache-2.0
// Self-test: watchRtdb keeps every value an RTDB listener raises, the removal of a node refilled at once included, and fails as the stack not answering when no first value comes (SPEC §6b, §12).

/**
 * Hermetic. Two handles stand in for the Database:
 *   - a stand-in with ref(path).on/off that the test drives value by value,
 *     counting listeners, for what the watch must do around them (first
 *     value, stop, timeout, cancel, pick, refusals);
 *   - firebase-admin's OWN Database handle (getDatabase(app), as adminFor
 *     builds it), pointed at a loopback port whose server closes every
 *     connection, so the SDK never reaches a database. Its local writes
 *     still raise value events at once, the removal of a node and its refill
 *     in the same tick included, through the same ref().on("value") the
 *     watch binds on a stack. So the call shape and the snapshot methods are
 *     the SDK's, and a watch that merges or samples values fails here.
 * What the emulator itself sends a listener is checked live (the lib owner's
 * report). Pins: the default handle is adminFor(target).rtdb, and the README
 * states the export.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RTDB_WATCH_FIRST_MS, watchRtdb } from "../lib/admin.mjs";
import { stackDidNotAnswer } from "../lib/test.mjs";

const ADMIN_SRC = fileURLToPath(new URL("../lib/admin.mjs", import.meta.url));
const README = fileURLToPath(new URL("../README.md", import.meta.url));
const LOCAL = Object.freeze({ kind: "local", runId: "2610131900-rtwt" });
const PROD = Object.freeze({ kind: "prod", runId: "2610131900-rtwp" });
const tick = () => new Promise((r) => setImmediate(r));

const snapOf = (value) => ({
  val: () => (value === undefined ? null : structuredClone(value)),
  exists: () => value !== null && value !== undefined,
  numChildren: () => (value && typeof value === "object" ? Object.keys(value).length : 0),
});

/** A Database stand-in: ref(path).on/off record and hold listeners; emit/cancel drive them. */
function fakeDb() {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    ref(path) {
      calls.push(["ref", path]);
      return {
        on(event, cb, cancel) {
          calls.push(["on", path, event, typeof cancel]);
          if (!listeners.has(path)) listeners.set(path, []);
          listeners.get(path).push({ event, cb, cancel });
          return cb;
        },
        off(event, cb) {
          calls.push(["off", path, event]);
          const l = listeners.get(path) ?? [];
          const i = l.findIndex((x) => x.event === event && x.cb === cb);
          if (i >= 0) l.splice(i, 1);
        },
      };
    },
    emit(path, value) {
      for (const { cb } of [...(listeners.get(path) ?? [])]) cb(snapOf(value));
    },
    cancel(path, err) {
      const l = listeners.get(path) ?? [];
      listeners.delete(path);
      for (const { cancel } of l) cancel?.(err);
    },
    count(path) {
      return (listeners.get(path) ?? []).length;
    },
  };
}

const keys = (n, tag = "k") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${tag}${i}`, i]));

test("it resolves on the first value and not before; first is rows[0]; the path is bound without its slashes", async () => {
  const db = fakeDb();
  let clock = 1000;
  let resolved = false;
  const p = watchRtdb(LOCAL, "/status/d1/y/", { rtdb: db, now: () => (clock += 5) }).then((w) => {
    resolved = true;
    return w;
  });
  await tick();
  await tick();
  assert.equal(resolved, false, "no value yet: not watching");
  assert.deepEqual(db.calls, [["ref", "status/d1/y"], ["on", "status/d1/y", "value", "function"]], "one value listener, with a cancel callback");
  db.emit("status/d1/y", keys(2));
  const w = await p;
  assert.equal(w.path, "status/d1/y");
  assert.deepEqual(w.first, { t: 1005, n: 2, exists: true });
  const { rows, error } = w.stop();
  assert.deepEqual(rows, [{ t: 1005, n: 2, exists: true }]);
  assert.equal(error, null);
  assert.equal(RTDB_WATCH_FIRST_MS, 15_000);
});

test("every value is a row, in order: a removal refilled in the same tick, and values that repeat a count, are never merged", async () => {
  const db = fakeDb();
  const p = watchRtdb(LOCAL, "status/d2/y", { rtdb: db });
  db.emit("status/d2/y", keys(3));
  const w = await p;
  db.emit("status/d2/y", keys(3, "j"));
  db.emit("status/d2/y", null);
  db.emit("status/d2/y", keys(1));
  for (let i = 0; i < 40; i += 1) db.emit("status/d2/y", i % 2 ? keys(2) : null); // one synchronous burst
  db.emit("status/d2/y", "leaf");
  const { rows } = w.stop();
  assert.deepEqual(rows.map((r) => r.n), [3, 3, 0, 1, ...Array.from({ length: 40 }, (_, i) => (i % 2 ? 2 : 0)), 0]);
  assert.deepEqual(rows.map((r) => r.exists), [true, true, false, true, ...Array.from({ length: 40 }, (_, i) => i % 2 === 1), true], "a leaf exists with no children");
  assert.ok(rows.every((r) => Object.keys(r).join() === "t,n,exists"), "no v without pick");
  assert.equal(rows.filter((r) => r.n === 0 && !r.exists).length, 21, "every removal is there");
});

test("stop() detaches the listener, records nothing after, returns a copy, and the same object every time", async () => {
  const db = fakeDb();
  const p = watchRtdb(LOCAL, "status/d3/peers", { rtdb: db });
  db.emit("status/d3/peers", keys(2));
  const w = await p;
  db.emit("status/d3/peers", keys(1));
  assert.equal(db.count("status/d3/peers"), 1);
  const out = w.stop();
  assert.equal(db.count("status/d3/peers"), 0, "no listener left");
  assert.deepEqual(db.calls.at(-1), ["off", "status/d3/peers", "value"]);
  db.emit("status/d3/peers", null);
  assert.equal(w.stop(), out, "the same object");
  assert.deepEqual(out.rows.map((r) => r.n), [2, 1], "nothing after stop()");
  assert.equal(db.calls.filter((c) => c[0] === "off").length, 1, "detached once");
  assert.deepEqual(out, { path: "status/d3/peers", rows: out.rows, error: null });
});

test("no first value within firstMs: E2E_RTDB_WATCH with stackCut (the stack did not answer), and no listener left", async () => {
  for (const [target, db] of [[LOCAL, "the Database emulator"], [PROD, "the Realtime Database"]]) {
    const fake = fakeDb();
    const t0 = Date.now();
    const err = await watchRtdb(target, "status/d4/y", { rtdb: fake, firstMs: 60 }).then(() => null, (e) => e);
    assert.ok(err, "rejected");
    assert.ok(Date.now() - t0 >= 55, "after firstMs");
    assert.equal(err.code, "E2E_RTDB_WATCH");
    assert.equal(err.message, `watchRtdb: ${db} gave no value of status/d4/y within 60 ms`);
    assert.equal(err.stackCut, `${db} gave no value of status/d4/y within 60 ms`);
    assert.equal(stackDidNotAnswer(err), err.stackCut, "lib/test.mjs reads it as the stack not answering");
    assert.deepEqual([err.path, err.firstMs, err.error], ["status/d4/y", 60, null]);
    assert.equal(fake.count("status/d4/y"), 0, "detached");
    fake.emit("status/d4/y", keys(1)); // a value too late changes nothing and throws nowhere
  }
});

test("a cancel before the first value is E2E_RTDB_WATCH without stackCut; a cancel after it ends the rows and is stop()'s error", async () => {
  const db = fakeDb();
  const p = watchRtdb(LOCAL, "status/d5/y", { rtdb: db, firstMs: 5_000 });
  db.cancel("status/d5/y", new Error("permission_denied at /status/d5/y: Client doesn't have permission\nsecond line"));
  const err = await p.then(() => null, (e) => e);
  assert.equal(err.code, "E2E_RTDB_WATCH");
  assert.equal(err.stackCut, undefined);
  assert.equal(stackDidNotAnswer(err), null, "not the stack not answering");
  assert.equal(err.error, "the listener was cancelled: permission_denied at /status/d5/y: Client doesn't have permission");
  assert.match(err.message, /^watchRtdb: the Database emulator cancelled the watch of status\/d5\/y before its first value \(the listener was cancelled: permission_denied/);

  const db2 = fakeDb();
  const p2 = watchRtdb(LOCAL, "status/d6/y", { rtdb: db2 });
  db2.emit("status/d6/y", keys(4));
  const w = await p2;
  db2.emit("status/d6/y", keys(5));
  db2.cancel("status/d6/y", new Error("the app was deleted"));
  const out = w.stop();
  assert.deepEqual(out.rows.map((r) => r.n), [4, 5]);
  assert.equal(out.error, "the listener was cancelled after 2 value(s): the app was deleted");
});

test("pick keeps what it returns as v; its first throw is the error and the watch goes on", async () => {
  const db = fakeDb();
  let calls = 0;
  const p = watchRtdb(LOCAL, "status/d7/peers", {
    rtdb: db,
    pick: (value, snap) => {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error(`boom ${calls}\nstack`);
      assert.equal(typeof snap.numChildren, "function", "the snapshot too");
      return value ? Object.keys(value).sort() : [];
    },
  });
  db.emit("status/d7/peers", { u2: 1, u1: 1 });
  const w = await p;
  assert.deepEqual(w.first.v, ["u1", "u2"]);
  assert.doesNotThrow(() => db.emit("status/d7/peers", { u1: 1 }), "a throw never leaves the listener");
  db.emit("status/d7/peers", null);
  db.emit("status/d7/peers", { u3: 1 });
  const out = w.stop();
  assert.deepEqual(out.rows.map((r) => [r.n, r.v]), [[2, ["u1", "u2"]], [1, undefined], [0, undefined], [1, ["u3"]]]);
  assert.ok(out.rows.every((r) => "v" in r), "every row has v");
  assert.equal(out.error, "pick threw on value 2: boom 2");
});

test("a bad path, firstMs, pick, rtdb or now is a TypeError before anything is bound", async () => {
  const db = fakeDb();
  for (const path of [undefined, null, 5, "", "/", "//", "status/../y", "status/./y"]) {
    await assert.rejects(watchRtdb(LOCAL, path, { rtdb: db }), TypeError, `path ${JSON.stringify(path)}`);
  }
  for (const firstMs of [0, -1, NaN, Infinity, "15000", null]) {
    await assert.rejects(watchRtdb(LOCAL, "status/d/y", { rtdb: db, firstMs }), TypeError, `firstMs ${JSON.stringify(firstMs)}`);
  }
  await assert.rejects(watchRtdb(LOCAL, "status/d/y", { rtdb: db, pick: "keys" }), TypeError);
  await assert.rejects(watchRtdb(LOCAL, "status/d/y", { rtdb: {} }), TypeError);
  await assert.rejects(watchRtdb(LOCAL, "status/d/y", { rtdb: db, now: 5 }), TypeError);
  assert.deepEqual(db.calls, [], "nothing bound");
});

// --- firebase-admin's own Database handle, offline on loopback ---------------------------------

test("through firebase-admin's own Database handle: the SDK's value events, a removal refilled in the same tick included, are every row", async (t) => {
  const refused = [];
  const server = net.createServer((s) => {
    refused.push(s.remoteAddress);
    s.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  // The SDK reads the emulator host from the environment; this file runs in a process of its own.
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = `127.0.0.1:${port}`;
  const { initializeApp, deleteApp } = await import("firebase-admin/app");
  const { getDatabase } = await import("firebase-admin/database");
  const app = initializeApp({
    projectId: "demo-selftest",
    databaseURL: `http://127.0.0.1:${port}?ns=demo-selftest`,
    credential: { getAccessToken: async () => ({ access_token: "owner", expires_in: 3600 }) },
  }, `selftest-rtdb-watch-${process.pid}`);
  t.after(() => deleteApp(app));
  const rtdb = getDatabase(app);
  const write = (path, value) => {
    rtdb.ref(path).set(value).catch(() => {}); // never acknowledged: nothing answers
  };

  const p = watchRtdb(LOCAL, "status/sdk1/y", { rtdb, firstMs: 5_000, pick: (v) => (v && typeof v === "object" ? Object.keys(v).sort().join(",") : v) });
  await tick();
  write("status/sdk1/y", keys(3)); // the SDK raises the local value at once
  const w = await p;
  assert.deepEqual([w.first.n, w.first.exists, w.first.v], [3, true, "k0,k1,k2"]);
  // A removal refilled within the same tick, as editors refill status/{d}/y.
  rtdb.ref("status/sdk1/y").remove().catch(() => {});
  write("status/sdk1/y/a", 1);
  write("status/sdk1/y/b", 2);
  write("status/sdk1/y", keys(3, "j"));
  write("status/sdk1/y", keys(3, "j")); // the same value again: the SDK raises nothing for it
  write("status/sdk1/y/j0", null);
  await tick();
  const out = w.stop();
  write("status/sdk1/y", null);
  assert.equal(out.error, null);
  assert.deepEqual(out.rows.map((r) => [r.n, r.exists, r.v]), [
    [3, true, "k0,k1,k2"],
    [0, false, null],
    [1, true, "a"],
    [2, true, "a,b"],
    [3, true, "j0,j1,j2"],
    [2, true, "j1,j2"],
  ]);
  assert.equal(w.stop().rows.length, 6, "nothing after stop()");
  assert.ok(refused.every((a) => a === "127.0.0.1"), "only the loopback stand-in was dialled");

  const silent = await watchRtdb(LOCAL, "status/sdk2/y", { rtdb, firstMs: 150 }).then(() => null, (e) => e);
  assert.equal(silent?.code, "E2E_RTDB_WATCH", "nothing answers and nothing was written: no first value");
  assert.ok(silent.stackCut);
});

// --- pins ---------------------------------------------------------------------------------------

test("the default handle is adminFor(target).rtdb, the socket closeAdmin ends", () => {
  const src = readFileSync(ADMIN_SRC, "utf8");
  const body = src.slice(src.indexOf("export async function watchRtdb("), src.indexOf("\n}\n", src.indexOf("export async function watchRtdb(")));
  assert.ok(body.length > 0, "watchRtdb found");
  assert.match(body, /const ref = \(rtdb \?\? adminFor\(target\)\.rtdb\)\.ref\(where\);/);
  assert.match(body, /ref\.on\("value", onValue, onCancel\);/);
});

test("README states watchRtdb, its rows, E2E_RTDB_WATCH and closeAdmin", () => {
  const readme = readFileSync(README, "utf8");
  for (const s of ["watchRtdb(target, path, {firstMs = 15_000, pick = null, rtdb = null, now = Date.now} = {})", "{t, n, exists}", "E2E_RTDB_WATCH", "RTDB_WATCH_FIRST_MS", "selftest/rtdb-watch.test.mjs"]) {
    assert.ok(readme.includes(s), `README lacks ${s}`);
  }
});
