// SPDX-License-Identifier: Apache-2.0
// Where a document is filed, who can read it there, and an update that cannot replace a newer version (SPEC §13, §19).

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { setAccess, setFolderAccess } = require("../lib/index.js");
const { TOOLS } = require("../lib/mcp/tools.js");
const { UNNAMED_TEAM, inheritedGrants } = require("../lib/lib/audience.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const ANA = { uid: "u-ana", emailLower: "ana@example.com" };
const CY = { uid: "u-cy", emailLower: "cy@example.com" };
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };

const HTML = "<!DOCTYPE html><html><body><section id=\"plan\"><p>Cut over in two weekends.</p></section></body></html>";

/**
 * Engineering is shared with ana and the Platform team (owner and bo);
 * Reviews, inside it, adds cy and a team only zed and dee are in. A document
 * filed in Reviews is therefore readable by all of them, and nobody was told.
 */
function world(extra = {}) {
  const grants = { viewers: [], suggesters: [], editors: [], approvers: [] };
  const { db, store } = fakeFirestore({
    "folders/eng": {
      name: "Engineering",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      parentId: null,
      ancestors: [],
      ...grants,
      viewers: [ANA.emailLower, "team:platform"],
      members: [OWNER.emailLower, ANA.emailLower, "bo@example.com"].sort(),
      editorMembers: [OWNER.emailLower],
      createdAt: Timestamp.fromMillis(1),
    },
    "folders/reviews": {
      name: "Reviews",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      parentId: "eng",
      ancestors: ["eng"],
      ...grants,
      viewers: [CY.emailLower],
      editors: ["team:secret"],
      members: [OWNER.emailLower, ANA.emailLower, "bo@example.com", CY.emailLower, "dee@example.com", "zed@example.com"].sort(),
      editorMembers: [OWNER.emailLower, "dee@example.com", "zed@example.com"].sort(),
      createdAt: Timestamp.fromMillis(2),
    },
    "teams/platform": { name: "Platform", ownerEmail: OWNER.emailLower, members: [OWNER.emailLower, "bo@example.com"] },
    "teams/secret": { name: "Secret", ownerEmail: "zed@example.com", members: ["zed@example.com", "dee@example.com"] },
    ...extra,
  });
  const ctx = (who) => ({
    db,
    caller: { ...who, channel: "mcp", tokenId: "t1" },
    actor: { uid: who.uid, email: who.emailLower, channel: "mcp", tokenId: "t1" },
  });
  const objects = new Map(Object.entries({ "docs/d1/v1/index.html": HTML, "docs/d1/v2/index.html": HTML }).map(([k, v]) => [k, Buffer.from(v)]));
  const call = (name, who, args) => withStorage(objects, () => tool(name).run(ctx(who), args));
  return { db, store, call };
}

/** Storage in memory, and no Realtime Database, for the length of `fn`. */
async function withStorage(objects, fn) {
  const saved = ["storage", "database"].map((k) => [k, Object.getOwnPropertyDescriptor(admin, k)]);
  const before = process.env.BIKESHED_BUCKET;
  process.env.BIKESHED_BUCKET = "test-bucket";
  const object = (name) => ({
    name,
    download: async () => {
      if (!objects.has(name)) throw Object.assign(new Error(`no object ${name}`), { code: 404 });
      return [objects.get(name)];
    },
    save: async (data) => void objects.set(name, Buffer.from(data)),
    exists: async () => [objects.has(name)],
  });
  Object.defineProperty(admin, "storage", {
    configurable: true,
    value: () => ({
      bucket: () => ({
        file: object,
        getFiles: async ({ prefix }) => [[...objects.keys()].filter((k) => k.startsWith(prefix)).map(object)],
      }),
    }),
  });
  Object.defineProperty(admin, "database", {
    configurable: true,
    value: () => {
      throw new Error("no Realtime Database configured");
    },
  });
  try {
    return await fn();
  } finally {
    for (const [k, d] of saved) if (d) Object.defineProperty(admin, k, d);
    if (before === undefined) delete process.env.BIKESHED_BUCKET;
    else process.env.BIKESHED_BUCKET = before;
  }
}

// --- Who can read a folder ------------------------------------------------

test("get_folder names everyone who can read a folder, inherited readers included", async () => {
  const w = world();
  const folder = await w.call("get_folder", OWNER, { id: "reviews" });
  assert.equal(folder.path, "Engineering/Reviews");
  assert.equal(folder.readers, 6);
  // ana comes from Engineering, cy from Reviews itself.
  assert.ok(folder.people.includes(ANA.emailLower) && folder.people.includes(CY.emailLower));
  assert.equal(folder.morePeople, 0);
  assert.deepEqual(folder.editors, ["dee@example.com", OWNER.emailLower, "zed@example.com"]);
  assert.equal(folder.canWrite, true);
});

test("a team is named only to its members, and never sized", async () => {
  const w = world();
  // The owner is in Platform, granted on Engineering, and not in Secret.
  assert.deepEqual((await w.call("get_folder", OWNER, { id: "reviews" })).teams, ["Platform", UNNAMED_TEAM]);
  // cy is in neither: both are "a team you are not in", and nothing counts them.
  const seen = await w.call("get_folder", CY, { id: "reviews" });
  assert.deepEqual(seen.teams, [UNNAMED_TEAM, UNNAMED_TEAM]);
  assert.doesNotMatch(JSON.stringify(seen.teams), /Secret|Platform|\d/);
});

test("a level the caller cannot read is …, and a folder they cannot read does not exist for them", async () => {
  const w = world({
    // cy can read Reviews through a grant on it, and not Engineering.
    "folders/eng": {
      name: "Engineering",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      ancestors: [],
      viewers: [],
      members: [OWNER.emailLower],
      editorMembers: [OWNER.emailLower],
    },
  });
  assert.equal((await w.call("get_folder", CY, { id: "reviews" })).path, "…/Reviews");
  await assert.rejects(w.call("get_folder", CY, { id: "eng" }), { message: 'no folder with id "eng"' });
  await assert.rejects(w.call("get_folder", STRANGER, { id: "reviews" }), { message: 'no folder with id "reviews"' });
});

test("list_folders counts the readers of each folder, and says whether it is shared", async () => {
  const w = world({
    "folders/mine": {
      name: "Drafts",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      ancestors: [],
      members: [OWNER.emailLower],
      editorMembers: [OWNER.emailLower],
      createdAt: Timestamp.fromMillis(3),
    },
  });
  const { folders } = await w.call("list_folders", OWNER, {});
  const by = Object.fromEntries(folders.map((f) => [f.path, f]));
  assert.deepEqual([by["Drafts"].readers, by["Drafts"].shared], [1, false]);
  assert.deepEqual([by["Engineering/Reviews"].readers, by["Engineering/Reviews"].shared], [6, true]);
});

// --- Which folder each inherited grant comes from --------------------------

test("inherited grants come nearest folder first, highest role first, each with its folder's path", async () => {
  const w = world();
  assert.deepEqual(await inheritedGrants(w.db, OWNER, "reviews"), [
    { folderId: "reviews", path: "Engineering/Reviews", principal: "team:secret", role: "editor" },
    { folderId: "reviews", path: "Engineering/Reviews", principal: CY.emailLower, role: "viewer" },
    { folderId: "eng", path: "Engineering", principal: ANA.emailLower, role: "viewer" },
    { folderId: "eng", path: "Engineering", principal: "team:platform", role: "viewer" },
  ]);
});

test("a folder the caller cannot read gives its grants under …, never its name", async () => {
  const w = world();
  // cy reads Reviews through its own grant and is not in Engineering's members.
  const rows = await inheritedGrants(w.db, CY, "reviews");
  assert.deepEqual([...new Set(rows.map((r) => r.path))], ["…/Reviews", "…"]);
  assert.doesNotMatch(JSON.stringify(rows), /Engineering/);
});

/** Ask an endpoint with GET as one of the world's people, signed in on the web. */
function asking(w) {
  const sessions = Object.fromEntries(
    [OWNER, ANA, CY, STRANGER].map((p) => [`s-${p.uid}`, { uid: p.uid, email: p.emailLower, email_verified: true }]),
  );
  return (handler, who, query) =>
    withFakeAdmin({ db: w.db, sessions }, () =>
      invoke(handler, { method: "GET", headers: { cookie: `__session=s-${who.uid}` }, query }),
    );
}

test("GET /access tells the owner what a document inherits, and no cache may keep the answer", async () => {
  const w = world({
    "docs/d1": {
      docId: "d1",
      title: "Memo",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      folderId: "reviews",
      viewers: [],
      members: [OWNER.emailLower, ANA.emailLower, CY.emailLower],
      editorMembers: [OWNER.emailLower],
    },
  });
  const ask = asking(w);
  const ok = await ask(setAccess, OWNER, { docId: "d1" });
  assert.equal(ok.status, 200);
  assert.deepEqual(
    ok.body.inherited.map((r) => [r.path, r.principal, r.role]),
    [
      ["Engineering/Reviews", "team:secret", "editor"],
      ["Engineering/Reviews", CY.emailLower, "viewer"],
      ["Engineering", ANA.emailLower, "viewer"],
      ["Engineering", "team:platform", "viewer"],
    ],
  );
  assert.equal(ok.headers["cache-control"], "private, no-store");
  // Owner-only, as changing it is: a reader is refused, a stranger is not told
  // it exists, and neither refusal may be held by a CDN for the next caller.
  const reader = await ask(setAccess, CY, { docId: "d1" });
  assert.equal(reader.status, 403);
  assert.equal(reader.headers["cache-control"], "private, no-store");
  const stranger = await ask(setAccess, STRANGER, { docId: "d1" });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.headers["cache-control"], "private, no-store");
});

test("GET /folder-access gives what a folder inherits from the folders above it, not its own grants", async () => {
  const w = world();
  const ask = asking(w);
  const ok = await ask(setFolderAccess, OWNER, { folderId: "reviews" });
  assert.equal(ok.status, 200);
  assert.deepEqual([...new Set(ok.body.inherited.map((r) => r.folderId))], ["eng"]);
  assert.equal(ok.headers["cache-control"], "private, no-store");
  assert.deepEqual((await ask(setFolderAccess, OWNER, { folderId: "eng" })).body, { inherited: [] });
  assert.equal((await ask(setFolderAccess, CY, { folderId: "reviews" })).status, 403);
  assert.equal((await ask(setFolderAccess, STRANGER, { folderId: "reviews" })).status, 404);
});

test("a folder with no grants adds no rows, and an unfiled record has none", async () => {
  const w = world({
    "folders/eng": { name: "Engineering", ownerUid: OWNER.uid, ownerEmail: OWNER.emailLower, ancestors: [], members: [OWNER.emailLower] },
  });
  const rows = await inheritedGrants(w.db, OWNER, "reviews");
  assert.deepEqual([...new Set(rows.map((r) => r.folderId))], ["reviews"]);
  assert.deepEqual(await inheritedGrants(w.db, OWNER, null), []);
});

// --- What a write says about where it landed -------------------------------

test("publish_document says where it filed the document and who can read it, as the record has it", async () => {
  const w = world();
  const published = await w.call("publish_document", OWNER, {
    title: "Storage review",
    content: "# Storage review\n\nTwo weekends.",
    folder: "reviews",
    id: "2026-10-09-storage-review",
  });
  assert.deepEqual(published.filedIn, { id: "reviews", path: "Engineering/Reviews" });
  const record = w.store.get(`docs/${published.docId}`);
  assert.equal(published.access.readers, record.members.length);
  assert.deepEqual(published.access.people, [...record.members].sort());
  assert.deepEqual(published.access.teams, ["Platform", UNNAMED_TEAM]);
  assert.equal(published.access.alsoReadableBy, undefined, "a new document is private");
  assert.deepEqual([published.requestedId, published.idTaken], ["2026-10-09-storage-review", false]);
});

test("a taken id is reported, whether it was asked for or came from the title", async () => {
  const w = world({ "docs/storage-review": { docId: "storage-review" }, "docs/plan": { docId: "plan" } });
  const asked = await w.call("publish_document", OWNER, { title: "Anything", content: "# A", id: "plan" });
  assert.notEqual(asked.docId, "plan");
  assert.deepEqual([asked.requestedId, asked.idTaken], ["plan", true]);
  const fromTitle = await w.call("publish_document", OWNER, { title: "Storage review", content: "# B" });
  assert.deepEqual([fromTitle.requestedId, fromTitle.idTaken], ["storage-review", true]);
  assert.equal(fromTitle.filedIn, null, "with no folder it is at the root");
});

test("a move reports who can now read it, keeps `folder` as the id, and names a public audience in words", async () => {
  const w = world({
    "docs/d1": {
      docId: "d1",
      title: "Memo",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      viewers: [],
      suggesters: [],
      editors: [],
      approvers: [],
      members: [OWNER.emailLower],
      editorMembers: [OWNER.emailLower],
      approverMembers: [OWNER.emailLower],
      visibility: "public",
    },
  });
  const moved = await w.call("move_document", OWNER, { id: "d1", folder: "eng" });
  assert.equal(moved.folder, "eng", "an installed CLI prints this as the destination");
  assert.deepEqual(moved.filedIn, { id: "eng", path: "Engineering" });
  assert.equal(moved.access.readers, 3);
  assert.equal(moved.access.alsoReadableBy, "anyone signed in");
});

test("list_documents and get_document say where a document is filed", async () => {
  const w = world({
    "docs/d1": {
      docId: "d1",
      title: "Memo",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      folderId: "reviews",
      members: [OWNER.emailLower, CY.emailLower],
      editorMembers: [OWNER.emailLower],
      createdAt: Timestamp.fromMillis(5),
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
  });
  // cy reads Reviews through its own grant, not Engineering's, so the level above is not cy's to name.
  const { documents } = await w.call("list_documents", CY, {});
  assert.deepEqual(documents[0].filedIn, { id: "reviews", path: "…/Reviews" });
  const doc = await w.call("get_document", OWNER, { id: "d1" });
  assert.deepEqual(doc.filedIn, { id: "reviews", path: "Engineering/Reviews" });
  // The address comes before the source, which may be 200,000 characters long.
  const keys = Object.keys(doc);
  if ("url" in doc) assert.ok(keys.indexOf("url") < keys.indexOf("source"));
});

// --- An update that knows what it revised ---------------------------------

function editable(extra = {}) {
  return world({
    "docs/d1": {
      docId: "d1",
      title: "Memo",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v2",
      viewers: [],
      suggesters: [],
      editors: [],
      approvers: [],
      members: [OWNER.emailLower],
      editorMembers: [OWNER.emailLower],
      approverMembers: [OWNER.emailLower],
      visibility: "private",
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html", contentHash: "h1" },
    "docs/d1/versions/v2": { versionId: "v2", entry: "index.html", format: "html", contentHash: "h2" },
    "docs/d1/versions/v2/annotations/open1": { resolved: false, anchor: { exact: "two" }, createdAt: Timestamp.fromMillis(1) },
    "docs/d1/versions/v2/annotations/open2": { resolved: false, anchor: { exact: "weekends" }, createdAt: Timestamp.fromMillis(2) },
    "docs/d1/versions/v2/annotations/done": { resolved: true, anchor: { exact: "Cut" }, createdAt: Timestamp.fromMillis(3) },
    ...extra,
  });
}

test("an update revised from an older version is refused, and names the current one", async () => {
  const w = editable();
  await assert.rejects(
    w.call("update_document", OWNER, { id: "d1", content: "<p>Mine.</p>", baseVersion: "v1" }),
    /the document is at v2 now, not v1/,
  );
  assert.equal(w.store.get("docs/d1").currentVersion, "v2", "nothing was published over v2");
});

test("an update from the current version publishes, and counts the threads it leaves behind", async () => {
  const w = editable();
  const updated = await w.call("update_document", OWNER, { id: "d1", content: "<p>Mine.</p>", baseVersion: "v2" });
  assert.equal(updated.versionId, "v3");
  assert.equal(updated.threadsLeftBehind, 2, "two open threads stay on v2; the resolved one is not counted");
  // Without a base version an older client keeps working as before.
  const again = await w.call("update_document", OWNER, { id: "d1", content: "<p>Mine, again.</p>" });
  assert.equal(again.versionId, "v4");
});

// --- get_comments: in order, and saying when it stopped ---------------------

function discussed(threads, { current = "v1" } = {}) {
  const entries = {
    "docs/d1": {
      docId: "d1",
      title: "Memo",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: current,
      members: [OWNER.emailLower, ANA.emailLower],
      editorMembers: [OWNER.emailLower],
      visibility: "private",
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html" },
    "docs/d1/versions/v2": { versionId: "v2", entry: "index.html", format: "html" },
  };
  for (const [id, t] of Object.entries(threads)) {
    entries[`docs/d1/versions/v1/annotations/${id}`] = {
      resolved: t.resolved ?? false,
      anchor: { exact: id, elementId: "plan" },
      createdAt: Timestamp.fromMillis(t.at),
    };
    (t.comments ?? []).forEach((c, i) => {
      entries[`docs/d1/versions/v1/annotations/${id}/comments/c${i}`] = {
        body: c.body ?? "x",
        authorEmail: c.by ?? ANA.emailLower,
        actor: { channel: c.channel ?? "web" },
        ...(c.generated ? { generated: true } : {}),
        createdAt: Timestamp.fromMillis(t.at + i + 1),
      };
    });
  }
  return world(entries);
}

test("threads come oldest first, and a cut is said rather than silent", async () => {
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`t${String(i).padStart(2, "0")}`, { at: 1000 + (50 - i) }]));
  const w = discussed(many);
  const { threads, truncated } = await w.call("get_comments", OWNER, { id: "d1" });
  assert.equal(threads.length, 50);
  assert.equal(truncated, true);
  assert.equal(threads[0].threadId, "t50", "the oldest thread comes first");
  const few = await discussed({ a: { at: 2 }, b: { at: 1 } }).call("get_comments", OWNER, { id: "d1" });
  assert.deepEqual([few.threads.map((t) => t.threadId), few.truncated], [["b", "a"], false]);
});

test("a thread awaits a reply when a person spoke last in it, on the version you can still answer", async () => {
  const threads = {
    asked: { at: 1, comments: [{ channel: "mcp" }, { channel: "web" }] },
    answered: { at: 2, comments: [{ channel: "web" }, { channel: "mcp" }] },
    decided: { at: 3, comments: [{ channel: "web" }, { channel: "web", generated: true, body: "Accepted." }] },
    closed: { at: 4, resolved: true, comments: [{ channel: "web" }] },
  };
  const w = discussed(threads);
  const { threads: got } = await w.call("get_comments", OWNER, { id: "d1", includeResolved: true });
  const awaiting = Object.fromEntries(got.map((t) => [t.threadId, t.awaitingReply]));
  // "decided" ends in a note the server wrote, which is never a person speaking; the person's comment
  // before it is the last word, and while the thread is open it still awaits an answer.
  assert.deepEqual(awaiting, { asked: true, answered: false, decided: true, closed: false });
  // On an earlier version nothing can be answered (reply_to_comment refuses it).
  const old = discussed(threads, { current: "v2" });
  const { threads: older } = await old.call("get_comments", OWNER, { id: "d1", version: "v1" });
  assert.ok(older.every((t) => t.awaitingReply === false));
});

test("threads fetches only the ids named, whatever their state", async () => {
  const w = discussed({ a: { at: 1 }, b: { at: 2, resolved: true }, c: { at: 3 } });
  const { threads, truncated } = await w.call("get_comments", OWNER, { id: "d1", threads: ["b", "c", "missing"] });
  assert.deepEqual(threads.map((t) => t.threadId).sort(), ["b", "c"]);
  assert.equal(truncated, false);
});

test("until its index is built, get_comments gives the same answer the slow way", async () => {
  // A deploy ships the functions before the index finishes building, and in
  // between Firestore refuses the filtered, ordered query outright.
  const w = discussed({ old: { at: 1 }, closed: { at: 2, resolved: true }, recent: { at: 3 } });
  const real = w.db.collection.bind(w.db);
  const db = {
    ...w.db,
    collection: (name) => {
      const docs = real(name);
      return {
        ...docs,
        doc: (id) => {
          const d = docs.doc(id);
          return { ...d, get: d.get, collection: (sub) => wrapVersions(d.collection(sub)) };
        },
      };
    },
  };
  function wrapVersions(versions) {
    return {
      ...versions,
      doc: (v) => {
        const vRef = versions.doc(v);
        return {
          ...vRef,
          get: vRef.get,
          collection: (sub) => {
            const anns = vRef.collection(sub);
            if (sub !== "annotations") return anns;
            const refuse = { orderBy: () => refuse, limit: () => refuse, get: async () => {
              throw Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index."), { code: 9 });
            } };
            return { ...anns, where: () => refuse };
          },
        };
      },
    };
  }
  const { threads, truncated } = await tool("get_comments").run(
    { db, caller: { ...OWNER, channel: "mcp", tokenId: "t1" }, actor: { uid: OWNER.uid, email: OWNER.emailLower, channel: "mcp" } },
    { id: "d1" },
  );
  assert.deepEqual([threads.map((t) => t.threadId), truncated], [["old", "recent"], false]);
});

test("the get_comments query has the composite index production needs", () => {
  // The emulator answers a filtered, ordered query without one; production
  // refuses it with FAILED_PRECONDITION. So the index is pinned here.
  const { indexes } = JSON.parse(readFileSync(join(__dirname, "..", "..", "firestore.indexes.json"), "utf8"));
  const match = indexes.find(
    (i) =>
      i.collectionGroup === "annotations" &&
      i.queryScope === "COLLECTION" &&
      JSON.stringify(i.fields) ===
        JSON.stringify([
          { fieldPath: "resolved", order: "ASCENDING" },
          { fieldPath: "createdAt", order: "ASCENDING" },
        ]),
  );
  assert.ok(match, "firestore.indexes.json has no (resolved, createdAt) index on annotations");
});
