// SPDX-License-Identifier: Apache-2.0
// Personal tokens follow their owner's current verified Auth identity (SPEC §19).

const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeFirestore, fakeToken, withFakeAdmin } = require("./fakes.js");
const { verifyToken } = require("../lib/lib/tokens.js");

const owner = { uid: "u1", email: "owner@example.com", emailVerified: true, disabled: false };

function world() {
  const token = fakeToken({ uid: owner.uid, email: owner.email, channel: "mcp" });
  const { db, store } = fakeFirestore({ [token.path]: token.record });
  const users = { [owner.uid]: { ...owner } };
  return { token, db, store, users };
}

test("a personal token follows disable and re-enable in one process, without caching the account", async () => {
  const w = world();
  await withFakeAdmin(w, async () => {
    assert.equal((await verifyToken(w.db, w.token.bearer)).emailLower, owner.email);
    w.users[owner.uid].disabled = true;
    assert.equal(await verifyToken(w.db, w.token.bearer), null, "a disabled owner cannot use a personal token");
    w.users[owner.uid].disabled = false;
    assert.equal((await verifyToken(w.db, w.token.bearer)).uid, owner.uid);
  });
});

for (const [state, user] of [
  ["deleted", undefined],
  ["unverified", { ...owner, emailVerified: false }],
  ["changed email", { ...owner, email: "new@example.com" }],
  ["missing email", { ...owner, email: undefined }],
  ["lookup unavailable", new Error("Auth unavailable")],
]) {
  test(`a ${state} owner cannot use a personal token or update its last-used record`, async () => {
    const w = world();
    w.users[owner.uid] = user;
    await withFakeAdmin(w, async () => {
      assert.equal(await verifyToken(w.db, w.token.bearer), null, `${state}: the token is refused`);
      assert.equal(w.store.get(w.token.path).lastUsedAt, undefined, "a refused token was not used");
      assert.equal(w.store.has(`users/${owner.uid}/${w.token.path}`), false);
    });
  });
}

test("a malformed or wrong-secret token is refused before looking up the account", async () => {
  const w = world();
  let lookups = 0;
  await withFakeAdmin({ ...w, users() { lookups++; return owner; } }, async () => {
    assert.equal(await verifyToken(w.db, "bad-token"), null);
    const secret = w.token.bearer.split(".")[1];
    const wrong = `${w.token.bearer.split(".")[0]}.${secret[0] === "a" ? "b" : "a"}${secret.slice(1)}`;
    assert.equal(await verifyToken(w.db, wrong), null);
    assert.equal(lookups, 0, "unproven credentials do not look up an account");
  });
});
