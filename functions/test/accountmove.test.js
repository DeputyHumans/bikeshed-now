// SPDX-License-Identifier: Apache-2.0
// An account follows the address Google renamed it to, and so does everything that names it (SPEC §14).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { fakeFirestore, withFakeAdmin } = require("./fakes.js");
const { emptyGrants } = require("../lib/lib/access.js");
const { computeMembership } = require("../lib/lib/folders.js");
const presence = require("../lib/lib/presence.js");
const { googleAddress, moveJobId, requestMove, runMove } = require("../lib/lib/accountmove.js");

const OLD = "victoria@old.example.com";
const NEW = "victoria@new.example.com";
const OTHER = "olu@example.com";
const SUB = "google-sub-1";

// --- Google's token -----------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function googleToken(claims, key = privateKey, header = { alg: "RS256", kid: "k1", typ: "JWT" }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64(header)}.${b64(claims)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}

const valid = (over = {}) => ({
  iss: "https://accounts.google.com",
  sub: SUB,
  email: "Victoria@New.Example.com",
  email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 600,
  ...over,
});

const saved = {
  fetch: globalThis.fetch,
  emulator: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  presence: presence.syncPresenceAccess,
};
let keyFetches;
beforeEach(() => {
  keyFetches = 0;
  // Ambient emulator config would switch signature checking off: these tests
  // say which mode they mean.
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  globalThis.fetch = async () => {
    keyFetches += 1;
    return {
      ok: true,
      headers: new Headers({ "cache-control": "public, max-age=3600" }),
      json: async () => ({ keys: [JWK] }),
    };
  };
  presence.syncPresenceAccess = async () => {};
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  if (saved.emulator === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  else process.env.FIREBASE_AUTH_EMULATOR_HOST = saved.emulator;
  presence.syncPresenceAccess = saved.presence;
});

test("Google's signed word for the address is believed, lowercased", async () => {
  assert.equal(await googleAddress(googleToken(valid()), [SUB]), NEW);
  // Both issuer spellings Google uses, and email_verified as the string the
  // tokeninfo shape carries.
  assert.equal(
    await googleAddress(googleToken(valid({ iss: "accounts.google.com", email_verified: "true" })), [SUB]),
    NEW,
  );
});

test("an unverified address is refused, including the string \"false\"", async () => {
  // "false" is truthy: a check written as `if (!claims.email_verified)`
  // would admit an address Google never verified.
  assert.equal(await googleAddress(googleToken(valid({ email_verified: "false" })), [SUB]), null);
  assert.equal(await googleAddress(googleToken(valid({ email_verified: false })), [SUB]), null);
  assert.equal(await googleAddress(googleToken(valid({ email_verified: undefined })), [SUB]), null);
});

test("a token for another Google account, or none of this account's, is refused", async () => {
  assert.equal(await googleAddress(googleToken(valid({ sub: "someone-else" })), [SUB]), null);
  assert.equal(await googleAddress(googleToken(valid()), []), null);
});

test("an expired, misissued or badly signed token is refused", async () => {
  assert.equal(await googleAddress(googleToken(valid({ exp: Math.floor(Date.now() / 1000) - 5 })), [SUB]), null);
  assert.equal(await googleAddress(googleToken(valid({ iss: "https://evil.example.com" })), [SUB]), null);
  assert.equal(await googleAddress(googleToken(valid(), stranger), [SUB]), null);
  assert.equal(await googleAddress(googleToken(valid(), privateKey, { alg: "none", kid: "k1" }), [SUB]), null);
  assert.equal(await googleAddress("not a token", [SUB]), null);
  assert.equal(await googleAddress(undefined, [SUB]), null);
});

test("an address this system cannot store is refused", async () => {
  assert.equal(await googleAddress(googleToken(valid({ email: "a$b@example.com" })), [SUB]), null);
});

test("an unsigned token counts only under the Auth emulator", async () => {
  // The emulator's Google tokens are strict JSON that nobody signs. The switch
  // is FIREBASE_AUTH_EMULATOR_HOST, the one firebase-admin itself trusts
  // unsigned tokens under; without it, the same token is nothing.
  const unsigned = JSON.stringify({ sub: SUB, email: NEW, email_verified: true });
  assert.equal(await googleAddress(unsigned, [SUB]), null);
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
  assert.equal(await googleAddress(unsigned, [SUB]), NEW);
  assert.equal(
    await googleAddress(JSON.stringify({ sub: SUB, email: NEW, email_verified: false }), [SUB]),
    null,
  );
});

test("Google's keys are fetched once and reused", async () => {
  // Earlier tests may have warmed the cache; either way two checks fetch at most once.
  await googleAddress(googleToken(valid()), [SUB]);
  await googleAddress(googleToken(valid()), [SUB]);
  assert.ok(keyFetches <= 1, `fetched ${keyFetches} times`);
});

// --- The move -----------------------------------------------------------------

const STAMP = Timestamp.fromMillis(1_700_000_000_000);

function node(owner, grants = {}, parent = null, teams = new Map(), extra = {}) {
  const g = { ...emptyGrants(), ...grants };
  return { ownerEmail: owner, ...g, ...computeMembership(owner, g, parent, teams), updatedAt: STAMP, ...extra };
}

function world(over = {}) {
  const team = [OTHER, OLD];
  const teams = new Map([["t", team]]);
  const folder = node(OTHER, { viewers: [OLD] }, null, new Map(), { parentId: null, depth: 0, ancestors: [] });
  const seed = {
    // Hers, and one the operator published in her name with no uid.
    "docs/own": node(OLD, { viewers: [OTHER] }, null, new Map(), { ownerUid: "u-vic", title: "Own" }),
    "docs/ops": node(OLD, {}, null, new Map(), { ownerUid: null, title: "Operator" }),
    // Someone else's, shared with both of her addresses: the higher role wins.
    "docs/shared": node(OTHER, { editors: [OLD], viewers: [NEW] }, null, new Map(), { ownerUid: "u-olu" }),
    // Reaching her only through a team, and only through a folder.
    "teams/t": { teamId: "t", ownerEmail: OTHER, admins: [OTHER, OLD].sort(), members: team.sort() },
    "docs/viateam": node(OTHER, { viewers: ["team:t"] }, null, teams, { ownerUid: "u-olu" }),
    "folders/f": folder,
    "docs/infolder": node(OTHER, {}, computeMembership(OTHER, { ...emptyGrants(), viewers: [OLD] }, null, new Map()), new Map(), {
      ownerUid: "u-olu",
      folderId: "f",
    }),
    // A team she owns.
    "teams/mine": { teamId: "mine", ownerEmail: OLD, admins: [OLD], members: [OLD, OTHER].sort() },
    // Somebody nothing to do with her.
    "docs/unrelated": node(OTHER, { viewers: ["x@example.com"] }, null, new Map(), { ownerUid: "u-olu" }),
    // History, which keeps the address it was written under.
    "docs/own/versions/v1/annotations/a1/comments/c1": { authorUid: "u-vic", authorEmail: OLD, body: "hi" },
    // Credentials: one minted under the old address, one under the new.
    "tokens/p-old": { tokenId: "p-old", uid: "u-vic", email: OLD, revokedAt: null, hash: "h" },
    "users/u-vic/tokens/p-old": { tokenId: "p-old", revokedAt: null },
    "tokens/p-new": { tokenId: "p-new", uid: "u-vic", email: NEW, revokedAt: null, hash: "h" },
    "users/u-vic": { uid: "u-vic", email: OLD, verification: { hash: "x", email: OLD } },
    ...over,
  };
  const { db, store } = fakeFirestore(seed);
  const users = {
    "u-vic": { uid: "u-vic", email: OLD, emailVerified: true, providerData: [{ providerId: "google.com" }] },
  };
  return { db, store, users };
}

const job = { uid: "u-vic", from: OLD, to: NEW, state: "pending" };
const jobId = moveJobId("u-vic", NEW);

async function move(w, j = job) {
  w.store.set(`accountMoves/${jobId}`, { ...j });
  return withFakeAdmin({ db: w.db, users: w.users }, () => runMove(w.db, jobId, j));
}

const ADDRESS_FIELDS = ["ownerEmail", "viewers", "suggesters", "editors", "approvers", "members", "suggesterMembers", "editorMembers", "approverMembers", "admins"];

function naming(store, email) {
  const out = [];
  for (const [path, data] of store) {
    if (!/^(docs|folders|teams)\/[^/]+$/.test(path)) continue;
    for (const f of ADDRESS_FIELDS) {
      const v = data[f];
      if (v === email || (Array.isArray(v) && v.includes(email))) out.push(`${path}.${f}`);
    }
  }
  return out;
}

test("everything that named the old address names the new one, and nothing names the old", async () => {
  const w = world();
  assert.equal(await move(w), "done");
  assert.deepEqual(naming(w.store, OLD), []);

  assert.equal(w.users["u-vic"].email, NEW);
  assert.equal(w.users["u-vic"].emailVerified, true);
  assert.ok(w.users["u-vic"].tokensValidAfterTime, "signed out everywhere");
  assert.equal(w.store.get(`accountMoves/${jobId}`).state, "done");
  assert.equal(w.store.get("users/u-vic").email, NEW);
  assert.equal(w.store.get("users/u-vic").verification, undefined, "a pending code cannot undo the move");

  const own = w.store.get("docs/own");
  assert.equal(own.ownerEmail, NEW);
  assert.ok(own.members.includes(NEW) && own.approverMembers.includes(NEW));
  assert.ok(!own.approvers.includes(NEW), "an owner is never also a grant");
  assert.equal(w.store.get("docs/ops").ownerEmail, NEW);

  const shared = w.store.get("docs/shared");
  assert.deepEqual(shared.editors, [NEW], "the higher of her two roles");
  assert.deepEqual(shared.viewers, []);
  assert.ok(shared.editorMembers.includes(NEW));

  assert.deepEqual(w.store.get("teams/t").members, [NEW, OTHER].sort());
  assert.ok(w.store.get("teams/t").admins.includes(NEW));
  assert.ok(w.store.get("docs/viateam").members.includes(NEW), "through the team");
  assert.ok(w.store.get("docs/infolder").members.includes(NEW), "through the folder");
  assert.equal(w.store.get("teams/mine").ownerEmail, NEW);
  assert.ok(w.store.get("teams/mine").members.includes(NEW));
  assert.deepEqual(w.store.get("docs/unrelated").members, [OTHER, "x@example.com"].sort());
});

test("a move is not an edit: nobody's document reads as updated", async () => {
  const w = world();
  await move(w);
  for (const id of ["own", "shared", "viateam", "infolder", "unrelated"]) {
    assert.ok(w.store.get(`docs/${id}`).updatedAt.isEqual(STAMP), `docs/${id} was stamped`);
  }
  assert.ok(w.store.get("folders/f").updatedAt.isEqual(STAMP));
});

test("history keeps the address it was written under", async () => {
  const w = world();
  await move(w);
  assert.equal(w.store.get("docs/own/versions/v1/annotations/a1/comments/c1").authorEmail, OLD);
});

test("a token minted under the old address is revoked; one under the new is not", async () => {
  const w = world();
  await move(w);
  assert.ok(w.store.get("tokens/p-old").revokedAt, "would act as the old address forever");
  assert.ok(w.store.get("users/u-vic/tokens/p-old").revokedAt);
  assert.equal(w.store.get("tokens/p-new").revokedAt, null);
});

test("each owner's log says the address moved, where it was named, once", async () => {
  const w = world();
  await move(w);
  const entry = `moved-${jobId}`;
  for (const path of ["docs/own", "docs/ops", "docs/shared", "folders/f"]) {
    const e = w.store.get(`${path}/acl/${entry}`);
    assert.ok(e, `${path} has no entry`);
    assert.equal(e.reason, "address-moved");
    assert.deepEqual([e.added, e.removed], [[NEW], [OLD]]);
  }
  assert.equal(w.store.get(`docs/shared/events/${entry}`).type, "access.changed");
  // Reached only through the team or the folder: nothing about it changed.
  assert.equal(w.store.has(`docs/viateam/acl/${entry}`), false);
  assert.equal(w.store.has(`docs/infolder/acl/${entry}`), false);

  // A redelivery after it finished writes nothing twice, and rewrites nothing
  // either: an event whose `at` moved would be reported again past a cursor.
  // Someone shares with the old address again before it arrives, so the
  // redelivery rewrites a record it has already logged.
  const logged = [...w.store.keys()].filter((k) => k.includes("/acl/") || k.includes("/events/"));
  for (const k of logged) w.store.set(k, { ...w.store.get(k), at: "first" });
  const shared = w.store.get("docs/shared");
  w.store.set("docs/shared", { ...shared, viewers: [OLD], members: [...shared.members, OLD].sort() });
  w.store.set(`accountMoves/${jobId}`, { ...job });
  await withFakeAdmin({ db: w.db, users: w.users }, () => runMove(w.db, jobId, job));
  const after = [...w.store.keys()].filter((k) => k.includes("/acl/") || k.includes("/events/"));
  assert.deepEqual(after, logged);
  for (const k of logged) assert.equal(w.store.get(k).at, "first", `${k} was rewritten`);
  assert.ok(!w.store.get("docs/shared").members.includes(OLD), "the late share was moved too");
});

test("a job that dies before the commit leaves both addresses with access", async () => {
  const w = world();
  // The Auth backend fails the commit once.
  let failed = false;
  const users = w.users;
  await assert.rejects(
    withFakeAdmin({ db: w.db, users }, async () => {
      const admin = require("firebase-admin");
      const real = admin.auth();
      const auth = admin.auth;
      Object.defineProperty(admin, "auth", {
        configurable: true,
        value: () => ({
          ...real,
          updateUser: async () => {
            failed = true;
            throw new Error("backend unavailable");
          },
        }),
      });
      try {
        return await runMove(w.db, jobId, job);
      } finally {
        Object.defineProperty(admin, "auth", { configurable: true, value: auth });
      }
    }),
    /backend unavailable/,
  );
  assert.ok(failed);
  assert.equal(w.users["u-vic"].email, OLD);
  const shared = w.store.get("docs/shared");
  assert.ok(shared.editorMembers.includes(OLD) && shared.editorMembers.includes(NEW));
  assert.equal(w.store.get("docs/own").ownerEmail, OLD, "still hers, under the address she still signs in with");
  assert.ok(w.store.get("docs/own").members.includes(NEW));

  // The redelivery finishes it.
  assert.equal(await move(w), "done");
  assert.deepEqual(naming(w.store, OLD), []);
});

test("a job that dies after the commit is finished by its redelivery", async () => {
  const w = world();
  let calls = 0;
  presence.syncPresenceAccess = async () => {
    // The first presence refresh after the commit fails the job, mid-cascade.
    if (w.users["u-vic"].email === NEW && calls++ === 0) throw new Error("rtdb unavailable");
  };
  await assert.rejects(move(w), /rtdb unavailable/);
  assert.equal(w.users["u-vic"].email, NEW);
  assert.notDeepEqual(naming(w.store, OLD), [], "the crash left work behind");

  presence.syncPresenceAccess = async () => {};
  assert.equal(await move(w), "done");
  assert.deepEqual(naming(w.store, OLD), []);
  assert.ok(w.store.get("docs/own/acl/moved-" + jobId), "what the crashed run rewrote is still logged");
});

test("a team rewritten but never re-expanded is still found", async () => {
  // A run that died between rewriting the team and re-expanding it: the team
  // no longer names the old address, but the document it grants still does.
  const w = world({ "teams/t": { teamId: "t", ownerEmail: OTHER, admins: [OTHER, NEW].sort(), members: [NEW, OTHER].sort() } });
  w.users["u-vic"].email = NEW;
  assert.ok(w.store.get("docs/viateam").members.includes(OLD));
  assert.equal(await move(w), "done");
  assert.ok(!w.store.get("docs/viateam").members.includes(OLD));
  assert.ok(w.store.get("docs/viateam").members.includes(NEW));
});

test("an account that never proved the new address does not stand in the way", async () => {
  const w = world({ "users/u-squat": { uid: "u-squat", verification: { hash: "y", email: NEW } } });
  w.users["u-squat"] = { uid: "u-squat", email: NEW, emailVerified: false, providerData: [{ providerId: "password" }] };
  assert.equal(await move(w), "done");
  assert.equal(w.users["u-squat"], undefined);
  assert.equal(w.store.has("users/u-squat"), false);
  assert.equal(w.users["u-vic"].email, NEW);
});

test("an account that did prove the new address blocks the move, and nothing changes", async () => {
  const w = world();
  w.users["u-twin"] = { uid: "u-twin", email: NEW, emailVerified: true, providerData: [{ providerId: "password" }] };
  assert.equal(await move(w), "blocked");
  assert.equal(w.store.get(`accountMoves/${jobId}`).reason, "address-taken");
  assert.equal(w.users["u-vic"].email, OLD);
  assert.ok(w.users["u-twin"]);
  assert.ok(!w.store.get("docs/own").members.includes(NEW), "no access was handed to the other account");
});

test("a job for an address the account no longer has does nothing", async () => {
  const w = world();
  w.users["u-vic"].email = "victoria@third.example.com";
  assert.equal(await move(w), "blocked");
  assert.equal(w.store.get(`accountMoves/${jobId}`).reason, "stale");
  assert.ok(w.store.get("docs/own").members.includes(OLD));
});

test("asking twice while a move is pending is the same move", async () => {
  const { db, store } = fakeFirestore();
  const a = await requestMove(db, "u-vic", OLD, NEW);
  store.set(`accountMoves/${a}`, { ...store.get(`accountMoves/${a}`), marker: 1 });
  const b = await requestMove(db, "u-vic", OLD, NEW);
  assert.equal(a, b);
  assert.equal(store.get(`accountMoves/${a}`).marker, 1, "the pending job was not replaced");
  store.set(`accountMoves/${a}`, { ...store.get(`accountMoves/${a}`), state: "blocked" });
  await requestMove(db, "u-vic", OLD, NEW);
  assert.equal(store.get(`accountMoves/${a}`).state, "pending", "a blocked one is asked again");
});
