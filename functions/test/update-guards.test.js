// SPDX-License-Identifier: Apache-2.0
// An update stays out of an open editor's way and drops the draft it replaces (SPEC §6a, §6b).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { TOOLS } = require("../lib/mcp/tools.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const HTML = "<!DOCTYPE html><html><body><p>Cut over in two weekends.</p></body></html>";
const NEXT = "<!DOCTYPE html><html><body><p>Cut over in one weekend.</p></body></html>";
const PENDING = {
  annId: "s1",
  anchor: { exact: "two weekends", prefix: "Cut over in ", suffix: ".", start: 0, end: 0 },
  authorEmail: "sug@example.com",
  resolved: false,
  suggestion: { replacement: "a month", state: "pending" },
};

/**
 * A document at v1 with a draft somebody left in the app, its files, and its
 * live node. `rtdb` is what the Realtime Database holds, `false` for a
 * deployment without one, or `"broken"` for one whose reads fail.
 */
function world({ rtdb = false, anns = {}, caller = OWNER, doc = {} } = {}) {
  const { db, store } = fakeFirestore({
    "docs/d1": {
      docId: "d1",
      title: "Memo",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      members: [OWNER.emailLower],
      editorMembers: [OWNER.emailLower],
      approverMembers: [OWNER.emailLower],
      visibility: "private",
      draft: { baseVersion: "v1", entry: "index.html", bytes: 70, updatedByEmail: OWNER.emailLower },
      ...doc,
    },
    "docs/d1/versions/v1": { versionId: "v1", entry: "index.html", format: "html", contentHash: "h1" },
    ...Object.fromEntries(Object.entries(anns).map(([id, a]) => [`docs/d1/versions/v1/annotations/${id}`, a])),
  });
  const objects = new Map(
    Object.entries({
      "docs/d1/v1/index.html": HTML,
      "docs/d1/draft/index.html": HTML.replace("two", "DRAFTMARK two"),
    }).map(([k, v]) => [k, Buffer.from(v)]),
  );
  const ctx = {
    db,
    caller: { ...caller, channel: "mcp", tokenId: "t1" },
    actor: { uid: caller.uid, email: caller.emailLower, channel: "mcp", tokenId: "t1" },
  };
  const update = (content, extra = {}) => withFakes(objects, rtdb, () => tool("update_document").run(ctx, { id: "d1", content, ...extra }));
  const upload = (content) =>
    withFakes(objects, rtdb, () =>
      withFakeAdmin({ db, sessions: { s: { uid: caller.uid, email: caller.emailLower, email_verified: true } } }, () => {
        const { createDoc } = require("../lib/index.js");
        return invoke(createDoc, {
          headers: { cookie: "__session=s", "content-type": "application/octet-stream" },
          query: { filename: "index.html", update: "d1" },
          rawBody: Buffer.from(content),
          body: Buffer.from(content),
        });
      }),
    );
  return { store, objects, update, upload, doc: () => store.get("docs/d1"), has: (key) => objects.has(key) };
}

/** Storage and the Realtime Database, in memory, for the length of `fn`. */
async function withFakes(objects, rtdb, fn) {
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
        deleteFiles: async ({ prefix }) => {
          for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
        },
      }),
    }),
  });
  Object.defineProperty(admin, "database", {
    configurable: true,
    value: () => {
      if (rtdb === false) throw new Error("no Realtime Database configured");
      const at = (path) => !path ? rtdb : path.split("/").reduce((node, k) => (node == null ? undefined : node[k]), rtdb);
      const ref = (path) => ({
        once: async () => {
          if (rtdb === "broken") throw new Error("permission denied");
          return { val: () => at(path) ?? null, exists: () => at(path) != null };
        },
        limitToFirst: () => ref(path),
        remove: async () => {
          const parts = path.split("/");
          const parent = at(parts.slice(0, -1).join("/"));
          if (parent) delete parent[parts[parts.length - 1]];
          // RTDB removes empty ancestors as well as the requested subtree.
          for (let i = parts.length - 1; i > 0; i--) {
            const node = at(parts.slice(0, i).join("/"));
            if (node && Object.keys(node).length === 0) delete at(parts.slice(0, i - 1).join("/"))[parts[i - 1]];
          }
        },
      });
      return { ref };
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

const editing = () => ({ editAccess: { d1: { "ed@example,com": true, __liveEpoch: "initial" } }, status: { d1: { peers: { "u-ed": { mode: "edit", email: "ed@example.com", liveEpoch: "initial" }, "u-x": { mode: "view" } }, y: { initial: { e1: "AAEC" } } } } });
const leftBehind = () => ({ editAccess: { d1: { "ed@example,com": true, __liveEpoch: "initial" } }, status: { d1: { peers: { "u-x": { mode: "view" } }, y: { initial: { e1: "AAEC" } } } } });

test("an update is refused while somebody has the editor open, through the tool and the upload alike", async () => {
  const live = editing();
  const w = world({ rtdb: live });
  await assert.rejects(w.update(NEXT), /Somebody has this document open in the editor, where this would be lost/);

  const res = await w.upload(NEXT);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Somebody has this document open in the editor/);
  assert.equal(res.body.editors, 1, "and says how many");

  assert.equal(w.doc().currentVersion, "v1", "nothing was published");
  assert.ok(w.doc().draft, "their draft is kept");
  assert.ok(w.has("docs/d1/draft/index.html"), "with its files");
  assert.ok(live.status.d1.y, "and their log");
  assert.deepEqual([...w.objects.keys()].sort(), ["docs/d1/draft/index.html", "docs/d1/v1/index.html"], "and no bytes were uploaded for a version that is not minted");
});

test("an update that cannot tell whether anybody is editing is refused", async () => {
  const w = world({ rtdb: "broken" });
  await assert.rejects(w.update(NEXT), /Could not tell whether anybody is editing this document, so it was not published/);
  assert.equal(w.doc().currentVersion, "v1");
});

test("identical bytes are still a no-op while somebody is editing", async () => {
  const live = leftBehind();
  const w = world({ rtdb: live });
  const first = await w.update(NEXT);
  assert.equal(first.versionId, "v2");

  live.status.d1.peers["u-ed"] = { mode: "edit", email: "ed@example.com", liveEpoch: "initial" };
  live.status.d1.peers["u-ed"].liveEpoch = w.doc().liveEpoch;
  live.editAccess.d1.__liveEpoch = w.doc().liveEpoch;
  live.status.d1.y = { [w.doc().liveEpoch]: { e9: "AAEC" } };
  const again = await w.update(NEXT);
  assert.equal(again.deduped, true, "the same content changes nothing, so there is nothing to refuse");
  assert.equal(again.versionId, "v2");
  assert.ok(live.status.d1.y, "and the log of whoever is editing now is left alone");
});

test("once the update is current, the draft it replaced loses its log and its files", async () => {
  // The log wins over the bytes the next editor loads, and the files are what
  // GET /draft serves: either would bring the replaced draft back.
  for (const route of ["update", "upload"]) {
    const live = leftBehind();
    const w = world({ rtdb: live });
    const result = route === "update" ? await w.update(NEXT) : (await w.upload(NEXT)).body;
    assert.equal(result.versionId, "v2", route);
    assert.equal(w.doc().currentVersion, "v2", route);
    assert.equal(w.doc().draft, undefined, `${route}: the draft is gone`);
    assert.equal(live.status.d1.y, undefined, `${route}: so is its log`);
    assert.ok(live.status.d1.peers["u-x"], `${route}: a reader's presence stays`);
    assert.equal(w.has("docs/d1/draft/index.html"), false, `${route}: and so are its files`);
  }
});

for (const route of ["update", "upload"]) {
test(`${route} fences a log first created after its editors check and late writes from that retired epoch`, async () => {
    const live = { editAccess: { d1: { __liveEpoch: "initial", "owner@example,com": true } }, status: { d1: { peers: { reader: { mode: "view" } } } } };
    const w = world({ rtdb: live });
    const store = w.objects.set.bind(w.objects);
    let seededDuringUpload = false;
    w.objects.set = (key, value) => {
      if (key.startsWith("docs/d1/bundles/")) {
        // The editors/log read already returned empty, but an old-session tab
        // establishes its seed before this candidate wins the transaction.
        live.status.d1.y = { initial: { _seed: "AAA=", before: "AAEC" } };
        seededDuringUpload = true;
      }
      return store(key, value);
    };
    const result = route === "update" ? await w.update(NEXT) : (await w.upload(NEXT)).body;
    assert.equal(seededDuringUpload, true, `${route}: the initially absent log is created during upload`);
    assert.equal(result.versionId, "v2");
    assert.equal(live.status.d1.y, undefined, `${route}: retirement clears the captured epoch even when the earlier log check was empty`);
    const currentEpoch = w.doc().liveEpoch ?? "initial";
    assert.notEqual(currentEpoch, "initial", `${route}: publication advances the initially empty editing epoch`);
    // Deletion alone cannot fence an old peer that appends after cleanup.
    live.status.d1.y = { initial: { after: "AAEC" } };
    assert.equal(live.status.d1.y.initial.after, "AAEC", `${route}: the old peer's late entry really exists`);
    assert.equal(live.status.d1.y[currentEpoch], undefined, `${route}: the new editor's namespace cannot adopt that late old-session entry`);
    assert.equal(w.doc().draft, undefined);
});
}

test("a refused update leaves the draft, its files and its log to the people editing them", async () => {
  const live = leftBehind();
  const w = world({ rtdb: live, anns: { s1: PENDING } });
  await assert.rejects(w.update(NEXT), /suggest/i);
  assert.equal(w.doc().currentVersion, "v1");
  assert.ok(w.doc().draft);
  assert.ok(w.has("docs/d1/draft/index.html"));
  assert.ok(live.status.d1.y);
});

test("a browser upload refused by pending or accepted suggestions changes no record or stored bytes", async () => {
  for (const state of ["pending", "accepted"]) {
    const w = world({ anns: { s1: { ...PENDING, suggestion: { ...PENDING.suggestion, state } } } });
    const beforeRecords = structuredClone([...w.store]);
    const beforeBytes = [...w.objects].map(([key, value]) => [key, value.toString("utf8")]);
    const res = await w.upload(NEXT);
    assert.equal(res.status, 409, `${state}: the browser upload is refused`);
    assert.equal(res.body[state === "pending" ? "pendingSuggestions" : "acceptedInDraft"], 1);
    assert.deepEqual([...w.store], beforeRecords, `${state}: no head, version or draft record changes on refusal`);
    assert.deepEqual([...w.objects].map(([key, value]) => [key, value.toString("utf8")]), beforeBytes, `${state}: stored bytes are unchanged`);
  }
});

test("a deployment without a Realtime Database still updates, and still drops the draft's files", async () => {
  const w = world({ rtdb: false });
  const result = await w.update(NEXT);
  assert.equal(result.versionId, "v2");
  assert.equal(w.has("docs/d1/draft/index.html"), false);
});

test("a nonmember MCP update carries its presented link key through the commit check", async () => {
  const k = "current-link-token-long-enough";
  const w = world({ caller: { uid: "u-link", emailLower: "link@example.com" }, doc: { visibility: "unlisted", publicEdit: true, linkToken: k } });
  let result;
  await assert.doesNotReject(async () => { result = await w.update(NEXT, { k }); }, "the final write accepts the current presented key");
  assert.equal(result.versionId, "v2");
  assert.equal(w.doc().currentVersion, "v2");
  assert.equal([...w.store.keys()].some((key) => key.includes("/linkGrants/")), false);
});

test("a link rotated while an MCP update uploads cannot authorize its final commit", async () => {
  const k = "current-link-token-long-enough";
  const w = world({ caller: { uid: "u-link", emailLower: "link@example.com" }, doc: { visibility: "unlisted", publicEdit: true, linkToken: k } });
  const save = w.objects.set.bind(w.objects);
  w.objects.set = (key, value) => { w.doc().linkToken = "rotated-link-token-long-enough"; return save(key, value); };
  await assert.rejects(w.update(NEXT, { k }), /no longer have permission/);
  assert.equal(w.doc().currentVersion, "v1");
});

test("a revoked real editor cannot finish a bundle replacement via public open editing", async () => {
  const caller = { uid: "u-upload", emailLower: "upload@example.com" };
  const w = world({ caller, doc: { visibility: "public", publicEdit: true, members: [OWNER.emailLower, caller.emailLower], editorMembers: [OWNER.emailLower, caller.emailLower] } });
  const save = w.objects.set.bind(w.objects);
  w.objects.set = (key, value) => { w.doc().editorMembers = [OWNER.emailLower]; return save(key, value); };
  const result = await w.upload(NEXT);
  assert.equal(result.status, 403);
  assert.equal(w.doc().currentVersion, "v1");
});
