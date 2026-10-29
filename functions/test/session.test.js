// SPDX-License-Identifier: Apache-2.0
// Signing in leaves the account record every email finds people by (SPEC §14).

const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { session } = require("../lib/index.js");
const { uidForEmail } = require("../lib/email/notify.js");

const GOOGLE = { uid: "u-ana", email: "Ana@Example.com", email_verified: true };
const UNVERIFIED = { uid: "u-bo", email: "bo@example.com", email_verified: false };

function signIn(db, token) {
  return withFakeAdmin({ db, idTokens: { google: GOOGLE, unverified: UNVERIFIED } }, () =>
    invoke(session, { body: { idToken: token } }),
  );
}

test("a sign-in whose address arrived verified creates the account record", async () => {
  // The case that used to have no record at all: nothing asked for a code, and
  // nobody had opened the account screen, so no email could ever find them.
  const { db, store } = fakeFirestore();
  const r = await signIn(db, "google");
  assert.equal(r.status, 200);
  assert.deepEqual(store.get("users/u-ana"), { uid: "u-ana", email: "ana@example.com" });
  assert.equal(await withFakeAdmin({ db }, () => uidForEmail(db, "ana@example.com")), "u-ana");
});

test("signing in again keeps what the person already chose", async () => {
  const { db, store } = fakeFirestore({
    "users/u-ana": { uid: "u-ana", email: "ana@example.com", emailNotifications: false, defaultMarking: { enabled: true } },
  });
  await signIn(db, "google");
  assert.equal(store.get("users/u-ana").emailNotifications, false);
  assert.deepEqual(store.get("users/u-ana").defaultMarking, { enabled: true });
});

test("an unverified address gets no session, and no record", async () => {
  const { db, store } = fakeFirestore();
  const r = await signIn(db, "unverified");
  assert.deepEqual(r.body, { status: "unverified" });
  assert.equal(store.has("users/u-bo"), false);
});

// --- An address Google renamed (SPEC §14, ADR 0020) ---------------------------

const { generateKeyPairSync, sign } = require("node:crypto");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "s1", alg: "RS256", use: "sig" };
const SUB = "g-ana";
const RENAMED = { ...GOOGLE, firebase: { identities: { "google.com": [SUB] } } };

function googleToken(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64({ alg: "RS256", kid: "s1", typ: "JWT" })}.${b64(claims)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
}
const says = (over = {}) =>
  googleToken({
    iss: "https://accounts.google.com",
    sub: SUB,
    email: "ana@renamed.example.com",
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...over,
  });

const env = { fetch: globalThis.fetch, emulator: process.env.FIREBASE_AUTH_EMULATOR_HOST };
function withGoogleKeys(fn, ok = true) {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  globalThis.fetch = async () =>
    ok
      ? { ok: true, headers: new Headers({ "cache-control": "max-age=3600" }), json: async () => ({ keys: [JWK] }) }
      : { ok: false, status: 503, headers: new Headers(), json: async () => ({}) };
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = env.fetch;
    if (env.emulator === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = env.emulator;
  });
}

function post(db, body) {
  return withFakeAdmin({ db, idTokens: { renamed: RENAMED } }, () =>
    invoke(session, { body: { idToken: "renamed", ...body } }),
  );
}

// First of these, while no key is cached: the keys come from Google once per
// process, and a sign-in must not fail because Google could not be reached.
test("a sign-in goes ahead as before when Google's keys cannot be fetched", async () => {
  const { db, store } = fakeFirestore();
  const r = await withGoogleKeys(() => post(db, { googleIdToken: says() }), false);
  assert.deepEqual(r.body, { status: "ok" });
  assert.ok(r.headers["set-cookie"]);
  assert.equal([...store.keys()].some((k) => k.startsWith("accountMoves/")), false);
});

test("a Google rename starts a move, and the old address gets no cookie", async () => {
  const { db, store } = fakeFirestore();
  const r = await withGoogleKeys(() => post(db, { googleIdToken: says() }));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "moving");
  assert.equal(r.body.to, "ana@renamed.example.com");
  assert.equal(r.headers["set-cookie"], undefined, "a cookie here would carry the address being left");
  const job = store.get(`accountMoves/${r.body.jobId}`);
  assert.deepEqual(
    { uid: job.uid, from: job.from, to: job.to, state: job.state },
    { uid: "u-ana", from: "ana@example.com", to: "ana@renamed.example.com", state: "pending" },
  );
});

test("two tabs asking at once start one move", async () => {
  const { db, store } = fakeFirestore();
  const [a, b] = await withGoogleKeys(() =>
    Promise.all([post(db, { googleIdToken: says() }), post(db, { googleIdToken: says() })]),
  );
  assert.equal(a.body.jobId, b.body.jobId);
  assert.equal([...store.keys()].filter((k) => k.startsWith("accountMoves/")).length, 1);
});

test("anything short of Google's signed word signs in as before", async () => {
  const cases = {
    "the same address": says({ email: "Ana@Example.com" }),
    "another Google account": says({ sub: "g-someone-else" }),
    "an unverified address": says({ email_verified: "false" }),
    "an expired token": says({ exp: Math.floor(Date.now() / 1000) - 5 }),
    "no token at all": "garbage",
  };
  for (const [name, googleIdToken] of Object.entries(cases)) {
    const { db, store } = fakeFirestore();
    const r = await withGoogleKeys(() => post(db, { googleIdToken }));
    assert.deepEqual(r.body, { status: "ok" }, name);
    assert.ok(r.headers["set-cookie"], `${name}: no cookie`);
    assert.equal([...store.keys()].some((k) => k.startsWith("accountMoves/")), false, name);
  }
});
