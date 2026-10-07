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
