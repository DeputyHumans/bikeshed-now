// SPDX-License-Identifier: Apache-2.0
// The Activity panel's feed: one list, newest first, saying who acted and through what, for editors only (SPEC §17, ADR 0023).

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin/firestore");
const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { recordView } = require("../lib/index.js");
const { ACTIVITY_PAGE } = require("../lib/lib/changefeed.js");

const OWNER = { uid: "u-own", email: "own@example.com", email_verified: true };
const EDITOR = { uid: "u-ed", email: "ed@example.com", email_verified: true };
const VIEWER = { uid: "u-vi", email: "vi@example.com", email_verified: true };
const STRANGER = { uid: "u-st", email: "st@example.com", email_verified: true };
const SESSIONS = { own: OWNER, ed: EDITOR, vi: VIEWER, st: STRANGER };

const at = (minute) => Timestamp.fromMillis(Date.UTC(2026, 9, 29, 12, minute));
const DOC = {
  title: "Plan", ownerUid: OWNER.uid, ownerEmail: OWNER.email, currentVersion: "v2",
  editors: [EDITOR.email], viewers: [VIEWER.email],
  members: [OWNER.email, EDITOR.email, VIEWER.email], editorMembers: [OWNER.email, EDITOR.email],
};

function world(extra = {}) {
  return fakeFirestore({
    "docs/d": DOC,
    [`users/${OWNER.uid}`]: { email: OWNER.email },
    [`users/${EDITOR.uid}`]: { email: EDITOR.email },
    "docs/d/versions/v1": { publishedByEmail: OWNER.email, publishedVia: "upload" },
    "docs/d/versions/v2": { publishedByEmail: OWNER.email, origin: "upload", publishedVia: "cli" },
    "docs/d/events/e1": { at: at(1), type: "version.published", audience: "readers", version: "v1", actor: { uid: OWNER.uid, channel: "web" } },
    "docs/d/views/s1": { startedAt: at(2), email: VIEWER.email, versionId: "v1", ms: 5000, automated: false, actor: { uid: VIEWER.uid, email: VIEWER.email, channel: "web" } },
    "docs/d/events/e2": { at: at(3), type: "version.published", audience: "readers", version: "v2", actor: { uid: OWNER.uid, channel: "cli", tokenId: "t1", via: "CLI on mbp" } },
    "docs/d/events/e3": { at: at(4), type: "fork.created", audience: "owner", version: "v2" },
    "docs/d/events/e4": { at: at(5), type: "doc.renamed", audience: "editors", actor: { uid: EDITOR.uid, channel: "app", tokenId: "g1", via: "“Claude” (connected app)" }, data: { from: "Draft", to: "Plan" } },
    "docs/d/views/api-t9-v2": { startedAt: at(6), email: OWNER.email, versionId: "v2", ms: 0, reads: 3, automated: true, actor: { uid: OWNER.uid, channel: "mcp", tokenId: "t9", via: "personal token “agent”" } },
    ...extra,
  });
}

function get(as, query = {}) {
  return invoke(recordView, { method: "GET", path: "/activity", headers: as ? { cookie: `__session=${as}` } : {}, query: { docId: "d", ...query } });
}

test("the feed is one list, newest first, and every row says who acted and through what", async () => {
  const { db } = world();
  await withFakeAdmin({ db, sessions: SESSIONS }, async () => {
    const r = await get("own");
    assert.equal(r.status, 200);
    assert.match(r.headers["cache-control"], /no-store/, "who read a document is never cached");
    const rows = r.body.items.map((i) => [i.type, i.by ?? null, i.via ?? null, i.automated ?? null]);
    assert.deepEqual(rows, [
      ["read", OWNER.email, "personal token “agent”", true],
      ["doc.renamed", EDITOR.email, "“Claude” (connected app)", true],
      ["fork.created", null, null, null],
      ["version.published", OWNER.email, "CLI on mbp", true],
      ["read", VIEWER.email, null, false],
      ["version.published", OWNER.email, null, false],
    ]);
    const [, , , v2, , v1] = r.body.items;
    assert.equal(v2.origin, "upload");
    assert.equal(v2.channel, "cli");
    assert.equal(v1.origin, "upload", "a version written before origin was stored reads it from publishedVia");
    assert.equal(r.body.next, null, "one page holds it all");
  });
});

test("an editor sees everything but the owner's own news that a fork was made", async () => {
  const { db } = world();
  await withFakeAdmin({ db, sessions: SESSIONS }, async () => {
    const r = await get("ed");
    assert.equal(r.status, 200);
    assert.ok(!r.body.items.some((i) => i.type === "fork.created"), "who forks is never told, and that one was is the owner's (SPEC §21)");
    assert.equal(r.body.items.length, 5);
  });
});

test("only editors see it: a reader is refused, a stranger is told nothing exists", async () => {
  const { db } = world();
  await withFakeAdmin({ db, sessions: SESSIONS }, async () => {
    assert.equal((await get(null)).status, 401);
    assert.equal((await get("vi")).status, 403);
    assert.equal((await get("st")).status, 404);
    assert.equal((await get("st", { docId: "absent" })).status, 404, "the same answer as an absent id");
    assert.equal((await get("own", { docId: "../x" })).status, 400);
    assert.equal((await get("own", { before: "not-a-cursor" })).status, 400);
  });
});

test("an expired document's activity is its owner's alone, as its content is", async () => {
  const { db } = world({ "docs/d": { ...DOC, expiresAt: Timestamp.fromMillis(1) } });
  await withFakeAdmin({ db, sessions: SESSIONS }, async () => {
    assert.equal((await get("ed")).status, 404);
    assert.equal((await get("own")).status, 200);
  });
});

test("pages meet exactly: rows of one instant are neither repeated nor skipped", async () => {
  // Sixty events and sixty sessions, all in the same instant, so a page ends
  // inside each source's run of that instant, and only each source's own
  // position, never the time alone, can say where.
  const extra = {};
  for (let i = 0; i < 60; i++) extra[`docs/d/events/x${String(i).padStart(2, "0")}`] = { at: at(30), type: "doc.renamed", audience: "editors", actor: { uid: OWNER.uid, channel: "web" }, data: { from: "a", to: "b" } };
  for (let i = 0; i < 60; i++) extra[`docs/d/views/r${String(i).padStart(2, "0")}`] = { startedAt: at(30), email: VIEWER.email, versionId: "v2", ms: 1000, automated: false, actor: { channel: "web" } };
  const { db } = world(extra);
  await withFakeAdmin({ db, sessions: SESSIONS }, async () => {
    const seen = [];
    let before;
    for (let page = 0; page < 10; page++) {
      const r = await get("own", before ? { before } : {});
      assert.equal(r.status, 200);
      assert.ok(r.body.items.length <= ACTIVITY_PAGE);
      seen.push(...r.body.items.map((i) => i.id));
      if (!r.body.next) break;
      before = r.body.next;
    }
    assert.equal(new Set(seen).size, seen.length, "no row twice");
    assert.equal(seen.length, 60 + 60 + 6, "every row once");
  });
});

test("a last page that is exactly full is the last: no empty page is asked for after it", async () => {
  // The six rows of the world, then older events enough to fill two pages to
  // the row, so the second page's events end exactly where a page does.
  const extra = {};
  const older = 2 * ACTIVITY_PAGE - 6;
  for (let i = 0; i < older; i++) {
    extra[`docs/d/events/o${String(i).padStart(3, "0")}`] = { at: Timestamp.fromMillis(Date.UTC(2026, 9, 29, 11, 0, 0, i)), type: "doc.renamed", audience: "editors", actor: { uid: OWNER.uid, channel: "web" }, data: { from: "a", to: "b" } };
  }
  const { db } = world(extra);
  await withFakeAdmin({ db, sessions: SESSIONS }, async () => {
    const first = await get("own");
    assert.equal(first.body.items.length, ACTIVITY_PAGE);
    assert.ok(first.body.next, "a second page");
    const second = await get("own", { before: first.body.next });
    assert.equal(second.body.items.length, ACTIVITY_PAGE);
    assert.equal(second.body.next, null, "nothing is left, and the feed says so rather than offering an empty page");
  });
});
