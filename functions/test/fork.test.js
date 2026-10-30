// SPDX-License-Identifier: Apache-2.0
// What a fork copies and records, and who may follow its lineage (SPEC §21).

const test = require("node:test");
const assert = require("node:assert/strict");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");

const { forkDocument, lineageFor } = require("../lib/lib/fork.js");

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const READER = { uid: "u-reader", emailLower: "reader@example.com" };
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };
const LINK = "tok_0123456789abcdefghijk";

function actorOf(caller) {
  return { uid: caller.uid, email: caller.emailLower, channel: "web" };
}

/**
 * Enough of Firestore for the fork paths: documents by path, batches that
 * record what they committed together, getAll, and one equality `where`.
 */
function fakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  const commits = [];

  function snap(path) {
    const data = store.get(path);
    return {
      id: path.split("/").pop(),
      exists: data !== undefined,
      ref: ref(path),
      data: () => (data === undefined ? undefined : { ...data }),
      get: (field) => (data === undefined ? undefined : data[field]),
    };
  }
  function ref(path) {
    return {
      id: path.split("/").pop(),
      path,
      get: async () => snap(path),
      collection: (name) => collection(`${path}/${name}`),
    };
  }
  function collection(path) {
    const depth = path.split("/").length + 1;
    return {
      doc: (id) => ref(`${path}/${id}`),
      get: async () => ({ docs: [...store.keys()].filter((p) => p.startsWith(`${path}/`) && p.split("/").length === depth).map(snap) }),
      where: (field, op, value) => {
        assert.equal(op, "==");
        return {
          get: async () => {
            const docs = [...store.keys()]
              .filter((p) => p.startsWith(`${path}/`) && p.split("/").length === depth)
              .filter((p) => store.get(p)[field] === value)
              .map(snap);
            return { docs, size: docs.length, empty: docs.length === 0 };
          },
        };
      },
    };
  }

  const db = {
    collection,
    getAll: async (...refs) => refs.map((r) => snap(r.path)),
    batch() {
      const writes = [];
      return {
        create(r, data) {
          writes.push({ op: "create", path: r.path, data });
        },
        set(r, data, opts) {
          writes.push({ op: "set", path: r.path, data, opts });
        },
        async commit() {
          for (const w of writes) {
            if (w.op === "create" && store.has(w.path)) throw new Error(`${w.path} exists`);
          }
          for (const w of writes) {
            if (w.op === "create") store.set(w.path, w.data);
          }
          commits.push(writes);
        },
      };
    },
  };
  return { db, store, commits };
}

/** Storage, as far as `getFiles` and a create-only `copy`. */
function fakeBucket(objects = {}) {
  const store = new Map(Object.entries(objects));
  return {
    store,
    async getFiles({ prefix }) {
      const files = [...store.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({
          name,
          async copy(dest, opts) {
            if (opts?.preconditionOpts?.ifGenerationMatch === 0 && store.has(dest)) {
              const e = new Error("precondition failed");
              e.code = 412;
              throw e;
            }
            store.set(dest, store.get(name));
          },
        }));
      return [files];
    },
  };
}

/**
 * The source is named `layoffs-plan-q3` and has since been renamed "Notes".
 * That is the case the server-only pointer exists for: the id says more than
 * the title, so anything that carried the id onto the fork would show here.
 */
const SRC = "layoffs-plan-q3";

function sourceDoc(overrides = {}) {
  return {
    docId: SRC,
    title: "Notes",
    slug: "notes",
    ownerUid: OWNER.uid,
    ownerEmail: OWNER.emailLower,
    members: [OWNER.emailLower, READER.emailLower],
    viewers: [READER.emailLower],
    editors: [],
    editorMembers: [OWNER.emailLower],
    currentVersion: "v3",
    visibility: "private",
    trusted: true,
    ...overrides,
  };
}

function version(versionId, contentHash, overrides = {}) {
  return {
    versionId,
    entry: "index.html",
    format: "html",
    contentHash,
    fileCount: 1,
    bytes: 5,
    files: ["index.html"],
    ...overrides,
  };
}

function world({ source = {}, extra = {} } = {}) {
  const { db, store, commits } = fakeDb({
    [`docs/${SRC}`]: sourceDoc(source),
    [`docs/${SRC}/versions/v2`]: version("v2", "h2"),
    [`docs/${SRC}/versions/v3`]: version("v3", "h3"),
    ...extra,
  });
  const bucket = fakeBucket({
    [`docs/${SRC}/v2/index.html`]: "two",
    [`docs/${SRC}/v3/index.html`]: "three",
  });
  return { db, store, commits, bucket };
}

function fork(w, caller, extra = {}) {
  return forkDocument({
    db: w.db,
    bucket: w.bucket,
    caller,
    actor: actorOf(caller),
    sourceId: SRC,
    ...extra,
  });
}

function writeTo(commit, path) {
  return commit.find((w) => w.path === path);
}

// --- What a fork copies and records ----------------------------------------

test("a fork copies the version asked for, into a private document the caller owns", async () => {
  const w = world();
  const out = await fork(w, READER, { versionId: "v2" });
  assert.equal(out.ok, true, JSON.stringify(out));

  // The same title as the original; the id comes from it.
  assert.equal(out.title, "Notes");
  assert.equal(out.docId, "notes");
  assert.equal(w.bucket.store.get("docs/notes/v1/index.html"), "two", "v2's bytes, not current");

  assert.equal(w.commits.length, 1);
  const [commit] = w.commits;
  const meta = writeTo(commit, "docs/notes").data;
  assert.equal(meta.ownerEmail, READER.emailLower);
  assert.equal(meta.ownerUid, READER.uid);
  assert.equal(meta.visibility, "private");
  assert.equal(meta.trusted, false, "trust is the source owner's to give, not the fork's");
  assert.equal(meta.forked, true);
  assert.deepEqual(meta.members, [READER.emailLower]);
  assert.equal(meta.stats.commits, 1, "its first version is one of the versions published");

  const v1 = writeTo(commit, "docs/notes/versions/v1").data;
  assert.equal(v1.origin, "fork");
  assert.equal(v1.publishedVia, "fork");
  assert.equal(v1.contentHash, "h2");
  assert.equal(v1.parentVersion, null);
});

test("the fork's own records name nothing about where it came from", async () => {
  const w = world();
  const out = await fork(w, READER);
  assert.equal(out.ok, true);
  const [commit] = w.commits;
  for (const path of [`docs/${out.docId}`, `docs/${out.docId}/versions/v1`]) {
    const json = JSON.stringify(writeTo(commit, path).data);
    assert.ok(!json.includes("layoffs"), `${path} carries the parent's id: ${json}`);
  }
});

test("the pointer goes to the server-only collection, pinned by hash as well as version", async () => {
  const w = world();
  const out = await fork(w, READER, { versionId: "v2" });
  const rec = writeTo(w.commits[0], `forks/${out.docId}`);
  assert.equal(rec.op, "create");
  assert.equal(rec.data.parentId, SRC);
  assert.equal(rec.data.parentVersion, "v2");
  assert.equal(rec.data.parentContentHash, "h2");
});

test("the original's fork count moves in the same batch as the fork", async () => {
  const w = world();
  await fork(w, READER);
  const bump = writeTo(w.commits[0], `docs/${SRC}`);
  assert.ok(bump, "the counter is written in the batch that creates the fork");
  assert.equal(bump.op, "set");
  assert.deepEqual(bump.opts, { merge: true });
  assert.ok(bump.data.stats.forks.isEqual(FieldValue.increment(1)));
  assert.ok(!("updatedAt" in bump.data), "a fork is not a publish of the original");
  const event = w.commits[0].find((x) => x.path.startsWith(`docs/${SRC}/events/`));
  assert.equal(event.data.type, "fork.created");
  const forked = w.commits[0].find((x) => x.path.startsWith("forks/")).data.parentVersion;
  assert.equal(event.data.version, forked, "which version was forked is said");
  assert.ok(!("actor" in event.data), "who forked it never is (SPEC §21)");
});

test("a fork's first version keeps its source's word count, since its bytes are the same, and has none when the source was not counted", async () => {
  const counted = world({ extra: { [`docs/${SRC}/versions/v2`]: version("v2", "h2", { words: 812 }) } });
  assert.equal((await fork(counted, READER, { versionId: "v2" })).ok, true);
  assert.equal(writeTo(counted.commits[0], "docs/notes/versions/v1").data.words, 812, "not counted again from the same bytes");
  const uncounted = world();
  assert.equal((await fork(uncounted, READER, { versionId: "v2" })).ok, true);
  assert.ok(!("words" in writeTo(uncounted.commits[0], "docs/notes/versions/v1").data), "the trigger counts it, as any new version");
});

test("a fork defaults to the current version", async () => {
  const w = world();
  const out = await fork(w, READER);
  assert.equal(w.bucket.store.get(`docs/${out.docId}/v1/index.html`), "three");
  assert.equal(writeTo(w.commits[0], `forks/${out.docId}`).data.parentVersion, "v3");
});

test("the fork's marking is its new owner's account default, not the original's", async () => {
  // The source carries none in this world; the original's policy never follows
  // the content, because the marking is its owner's decision (SPEC §20).
  const marked = { enabled: true, label: "INTERNAL", footer: "{user}" };
  const w = world({ extra: { [`users/${READER.uid}`]: { uid: READER.uid, defaultMarking: marked } } });
  const out = await fork(w, READER);
  assert.deepEqual(writeTo(w.commits[0], `docs/${out.docId}`).data.marking, marked);

  const plain = world({ source: { marking: { enabled: true, label: "SECRET", footer: "" } } });
  const bare = await fork(plain, READER);
  assert.equal(writeTo(plain.commits[0], `docs/${bare.docId}`).data.marking.enabled, false);
});

test("a taken id gets a suffix, and the title stays the original's", async () => {
  const w = world({ extra: { "docs/notes": { title: "Someone else's notes" } } });
  const out = await fork(w, READER);
  assert.match(out.docId, /^notes-[a-z0-9]{6}$/);
  assert.equal(out.title, "Notes");
});

test("a title can be given, within the rename limit", async () => {
  const w = world();
  const out = await fork(w, READER, { title: "  My take  " });
  assert.equal(out.title, "My take");
  assert.equal(out.docId, "my-take");

  const long = await fork(world(), READER, { title: "x".repeat(201) });
  assert.deepEqual([long.ok, long.status], [false, 400]);
});

// --- Who may fork -----------------------------------------------------------

function assertNothingWritten(w) {
  assert.equal(w.commits.length, 0, "nothing committed");
  assert.equal(w.bucket.store.size, 2, "no bytes copied");
}

test("a document the caller cannot read is a 404, and nothing is written", async () => {
  const w = world();
  const out = await fork(w, STRANGER);
  assert.deepEqual([out.ok, out.status], [false, 404]);
  assertNothingWritten(w);
});

test("an unlisted document forks with its key or a link grant, and not without", async () => {
  const unlisted = { visibility: "unlisted", linkToken: LINK, members: [OWNER.emailLower] };

  const bare = world({ source: unlisted });
  assert.equal((await fork(bare, STRANGER)).status, 404);
  assertNothingWritten(bare);

  assert.equal((await fork(world({ source: unlisted }), STRANGER, { k: LINK })).ok, true);

  const granted = world({
    source: unlisted,
    extra: { [`docs/${SRC}/linkGrants/${STRANGER.uid}`]: { uid: STRANGER.uid, token: LINK } },
  });
  assert.equal((await fork(granted, STRANGER)).ok, true);
});

test("an expired document cannot be forked out from behind its date, except by its owner", async () => {
  const expired = { expiresAt: Date.now() - 60_000 };
  const w = world({ source: expired });
  assert.equal((await fork(w, READER)).status, 404);
  assertNothingWritten(w);
  assert.equal((await fork(world({ source: expired }), OWNER)).ok, true);
});

test("a folder the caller cannot edit is refused, not silently dropped", async () => {
  const folder = {
    ownerUid: "u-other",
    ownerEmail: "other@example.com",
    members: ["other@example.com", READER.emailLower],
    editorMembers: ["other@example.com"],
  };
  const w = world({ extra: { "folders/f1": folder } });
  const out = await fork(w, READER, { folderId: "f1" });
  assert.deepEqual([out.ok, out.status], [false, 403]);
  assertNothingWritten(w);

  const ok = world({
    extra: { "folders/f1": { ...folder, editorMembers: ["other@example.com", READER.emailLower] } },
  });
  const filed = await fork(ok, READER, { folderId: "f1" });
  assert.equal(filed.ok, true);
  const meta = writeTo(ok.commits[0], `docs/${filed.docId}`).data;
  assert.equal(meta.folderId, "f1");
  assert.ok(meta.members.includes("other@example.com"), "the folder's members are the fork's");
});

test("only a refused read is the bare 404; a missing folder says what is missing", async () => {
  // Both are 404s. The first must be indistinguishable from an absent id; the
  // second is about the request and has to say so, or the person sees "That
  // did not work (404)" and an agent is told the DOCUMENT does not exist.
  const unreadable = await fork(world(), STRANGER);
  assert.equal(unreadable.unreadable, true);

  const w = world();
  const noFolder = await fork(w, READER, { folderId: "nope" });
  assert.deepEqual([noFolder.ok, noFolder.status], [false, 404]);
  assert.equal(noFolder.unreadable, undefined);
  assert.match(noFolder.error, /folder/);
  assertNothingWritten(w);
});

test("a version that is not there is a 409", async () => {
  const w = world();
  const out = await fork(w, READER, { versionId: "v9" });
  assert.deepEqual([out.ok, out.status], [false, 409]);
  assertNothingWritten(w);
});

// --- Lineage ----------------------------------------------------------------

const A = { uid: "u-a", emailLower: "a@example.com" };
const B = { uid: "u-b", emailLower: "b@example.com" };

/**
 * alpha ← beta ← gamma. The reader owns gamma, is a member of beta, and is a
 * stranger to alpha unless an override says otherwise.
 */
function chain({ alpha = {}, beta = {}, gamma = {}, extra = {} } = {}) {
  const at = (ms) => Timestamp.fromMillis(ms);
  return fakeDb({
    "docs/alpha": {
      title: "Alpha",
      ownerUid: A.uid,
      ownerEmail: A.emailLower,
      members: [A.emailLower],
      currentVersion: "v3",
      ...alpha,
    },
    "docs/alpha/versions/v3": version("v3", "h3"),
    "docs/beta": {
      title: "Beta",
      ownerUid: B.uid,
      ownerEmail: B.emailLower,
      members: [B.emailLower, READER.emailLower, A.emailLower],
      currentVersion: "v1",
      forked: true,
      ...beta,
    },
    "docs/beta/versions/v1": version("v1", "h2"),
    "forks/beta": { parentId: "alpha", parentVersion: "v2", parentContentHash: "h2", forkedAt: at(1) },
    "docs/gamma": {
      title: "Gamma",
      ownerUid: READER.uid,
      ownerEmail: READER.emailLower,
      members: [READER.emailLower],
      currentVersion: "v1",
      forked: true,
      ...gamma,
    },
    "forks/gamma": { parentId: "beta", parentVersion: "v1", parentContentHash: "h2", forkedAt: at(2) },
    ...extra,
  }).db;
}

async function lineage(db, caller, docId, k = null) {
  const out = await lineageFor({ db, caller, docId, k });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.lineage;
}

test("the walk shows each hop the reader can open, and stops at the first they cannot", async () => {
  const l = await lineage(chain(), READER, "gamma");
  assert.equal(l.forked, true);
  assert.deepEqual(
    l.ancestors.map((a) => a.docId),
    ["beta"],
  );
  assert.equal(l.hiddenAncestor, true, "alpha exists and is not the reader's to see");
  assert.equal(l.ancestors[0].title, "Beta");
  assert.equal(l.ancestors[0].versionId, "v1");

  const open = await lineage(chain({ alpha: { visibility: "public" } }), READER, "gamma");
  assert.deepEqual(open.ancestors.map((a) => a.docId), ["beta", "alpha"]);
  assert.equal(open.hiddenAncestor, false);
});

test("an unreadable hop hides everything above it, even an ancestor the reader could open", async () => {
  // Skipping the hop instead would tell the reader alpha is where a document
  // they cannot see came from.
  const db = chain({ beta: { members: [B.emailLower] }, alpha: { visibility: "public" } });
  const l = await lineage(db, READER, "gamma");
  assert.deepEqual(l.ancestors, []);
  assert.equal(l.hiddenAncestor, true);
});

test("an expired ancestor stops the walk", async () => {
  const l = await lineage(chain({ beta: { expiresAt: Date.now() - 60_000 } }), READER, "gamma");
  assert.deepEqual(l.ancestors, []);
  assert.equal(l.hiddenAncestor, true);
});

test("an ancestor's owner is named only to a member of that ancestor", async () => {
  const l = await lineage(chain({ alpha: { visibility: "public" } }), READER, "gamma");
  const [beta, alpha] = l.ancestors;
  assert.equal(beta.ownerEmail, B.emailLower, "the reader is a member of beta");
  assert.ok(!("ownerEmail" in alpha), "a public reader of alpha is not told who owns it");
});

test("'changed' compares content hashes, so a re-minted version id cannot hide a change", async () => {
  // beta was forked from alpha v2 (h2). Alpha has since been withdrawn back and
  // re-minted, so its current version is called v2 again with other bytes.
  const reminted = chain({
    alpha: { currentVersion: "v2" },
    extra: { "docs/alpha/versions/v2": version("v2", "h9") },
  });
  const l = await lineage(reminted, A, "beta");
  assert.equal(l.ancestors[0].changed, true);

  const moved = await lineage(chain(), A, "beta");
  assert.equal(moved.ancestors[0].changed, true, "alpha is at v3 now");

  const same = chain({ extra: { "docs/alpha/versions/v3": version("v3", "h2") } });
  assert.equal((await lineage(same, A, "beta")).ancestors[0].changed, false);
});

test("only the first hop says whether it changed", async () => {
  const l = await lineage(chain({ alpha: { visibility: "public" } }), READER, "gamma");
  assert.equal(typeof l.ancestors[0].changed, "boolean");
  assert.ok(!("changed" in l.ancestors[1]));
});

test("a document that is not a fork has no ancestors and nothing hidden", async () => {
  const l = await lineage(chain(), A, "alpha");
  assert.deepEqual([l.forked, l.ancestors, l.hiddenAncestor], [false, [], false]);
});

test("lineage of a document the caller cannot read is the 404 an absent id gets", async () => {
  const out = await lineageFor({ db: chain(), caller: STRANGER, docId: "gamma", k: null });
  assert.deepEqual([out.ok, out.status], [false, 404]);
});

// --- The owner's inventory --------------------------------------------------

function inventoryWorld() {
  const fork = (id, doc, ms) => ({
    [`docs/${id}`]: { title: id, ownerUid: `u-${id}`, ownerEmail: `${id}@example.com`, ...doc },
    [`forks/${id}`]: { parentId: "alpha", parentVersion: "v3", parentContentHash: "h3", forkedAt: Timestamp.fromMillis(ms) },
  });
  return chain({
    extra: {
      ...fork("f-public", { members: ["f-public@example.com"], visibility: "public" }, 10),
      ...fork("f-shared", { members: ["f-shared@example.com", A.emailLower] }, 20),
      ...fork("f-private", { members: ["f-private@example.com"] }, 30),
      ...fork("f-unlisted", { members: ["f-unlisted@example.com"], visibility: "unlisted", linkToken: LINK }, 40),
      ...fork(
        "f-granted",
        { members: ["f-granted@example.com"], visibility: "unlisted", linkToken: LINK },
        50,
      ),
      [`docs/f-granted/linkGrants/${A.uid}`]: { uid: A.uid, token: LINK },
      ...fork(
        "f-expired",
        { members: ["f-expired@example.com"], visibility: "public", expiresAt: Date.now() - 60_000 },
        60,
      ),
    },
  });
}

test("the owner sees every fork counted and the ones they can open listed", async () => {
  const l = await lineage(inventoryWorld(), A, "alpha");
  // beta is a fork of alpha too, and A is a member of it.
  assert.equal(l.forks.total, 7);
  assert.deepEqual(
    l.forks.visible.map((f) => f.docId),
    ["f-granted", "f-shared", "f-public", "beta"],
    "newest first",
  );
  assert.equal(l.forks.hidden, 3, "private, unlisted without a grant, and expired");
});

test("a fork's owner is named to the original's owner only where they are a member", async () => {
  const l = await lineage(inventoryWorld(), A, "alpha");
  const byId = new Map(l.forks.visible.map((f) => [f.docId, f]));
  assert.equal(byId.get("f-shared").ownerEmail, "f-shared@example.com");
  assert.ok(!("ownerEmail" in byId.get("f-public")));
  assert.ok(!("ownerEmail" in byId.get("f-granted")));
  assert.equal(byId.get("f-public").visibility, "public");
  assert.equal(byId.get("f-public").forkedAt, 10);
});

test("nobody but the owner gets the inventory", async () => {
  // A member of alpha who does not own it is told nothing about its forks.
  const member = chain({ alpha: { members: [A.emailLower, READER.emailLower] } });
  assert.ok(!("forks" in (await lineage(member, READER, "alpha"))));

  // beta's owner gets beta's: gamma exists, and is the reader's private fork.
  const owner = await lineage(chain(), B, "beta");
  assert.deepEqual(owner.forks, { total: 1, hidden: 1, visible: [] });
});


test("forking one older version copies neither feedback nor other version records or objects", async () => {
  const w = world({ extra: { [`docs/${SRC}/versions/v2/annotations/thread`]: { body: "source feedback" } } });
  const out = await fork(w, READER, { versionId: "v2" });
  assert.equal(out.ok, true);
  const prefix = `docs/${out.docId}/`;
  assert.deepEqual([...w.store.keys()].filter((p) => p.startsWith(prefix)).sort(), [`${prefix}versions/v1`], "only the selected version record, with no feedback");
  assert.deepEqual([...w.bucket.store.keys()].filter((p) => p.startsWith(prefix)).sort(), [`${prefix}v1/index.html`], "only the selected bundle objects");
});

test("editors and approvers do not receive the owner's descendant inventory", async () => {
  for (const role of ["editors", "approvers"]) {
    const member = chain({ alpha: { members: [A.emailLower, READER.emailLower], [role]: [READER.emailLower], editorMembers: [READER.emailLower], approverMembers: [READER.emailLower] } });
    assert.ok(!("forks" in await lineage(member, READER, "alpha")), `${role}: no owner inventory`);
  }
});
