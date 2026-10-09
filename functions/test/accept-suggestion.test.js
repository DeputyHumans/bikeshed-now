// SPDX-License-Identifier: Apache-2.0
// An approver's agent accepts suggestions into the draft and publishes it as one version (SPEC §19, §22).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

const { fakeFirestore } = require("./fakes.js");
const { TOOLS } = require("../lib/mcp/tools.js");
const { renderMarkdown } = require("../lib/lib/markdown/render.js");

const tool = (name) => TOOLS.find((t) => t.name === name);

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const APPROVER = { uid: "u-appr", emailLower: "appr@example.com" };
const EDITOR = { uid: "u-ed", emailLower: "ed@example.com" };
const SUGGESTER = { uid: "u-sug", emailLower: "sug@example.com" };

const HTML =
  "<!DOCTYPE html><html><head><title>Migration</title></head><body>\n" +
  '<section id="plan">\n' +
  "  <p>We can cut over in a single weekend, and yes,\n     a single weekend is enough.</p>\n" +
  "  <p>Compare vs. OpenAI Codex &amp; friends.</p>\n" +
  "  <p>Ship it with <em>care</em> today.</p>\n" +
  "</section>\n</body></html>\n";

const MARKDOWN = "# Migration\n\nWe can cut over in a single\nweekend, and yes, that is enough.\n\nCompare vs. OpenAI Codex today.\n";

const V1 = "docs/d1/versions/v1/annotations";

function suggestion(annId, exact, prefix, suffix, replacement, state = "pending") {
  return {
    annId,
    anchor: { elementId: "plan", exact, prefix, suffix, start: 0, end: 0 },
    authorUid: SUGGESTER.uid,
    authorEmail: SUGGESTER.emailLower,
    resolved: state !== "pending",
    suggestion: { replacement, state },
  };
}

/**
 * The document, its storage and its live editing node. `format` picks an HTML
 * or a Markdown document; `rtdb` is what the Realtime Database holds, or
 * `false` for a deployment without one.
 */
function world({ format = "html", doc = {}, anns = {}, files = {}, rtdb = false } = {}) {
  const entry = format === "markdown"
    ? { entry: "index.html", format: "markdown", sourceEntry: "index.md" }
    : { entry: "index.html", format: "html" };
  const { db, store } = fakeFirestore({
    "docs/d1": {
      docId: "d1",
      title: "Migration",
      ownerUid: OWNER.uid,
      ownerEmail: OWNER.emailLower,
      currentVersion: "v1",
      suggesters: [SUGGESTER.emailLower],
      editors: [EDITOR.emailLower],
      approvers: [APPROVER.emailLower],
      members: [OWNER.emailLower, SUGGESTER.emailLower, EDITOR.emailLower, APPROVER.emailLower],
      suggesterMembers: [OWNER.emailLower, SUGGESTER.emailLower, EDITOR.emailLower, APPROVER.emailLower],
      editorMembers: [OWNER.emailLower, EDITOR.emailLower, APPROVER.emailLower],
      approverMembers: [OWNER.emailLower, APPROVER.emailLower],
      visibility: "private",
      ...doc,
    },
    "docs/d1/versions/v1": { versionId: "v1", contentHash: "v1-hash", ...entry },
    ...Object.fromEntries(Object.entries(anns).map(([id, a]) => [`${V1}/${id}`, a])),
  });
  const objects = new Map(
    Object.entries(
      format === "markdown"
        ? {
            "docs/d1/v1/index.md": MARKDOWN,
            "docs/d1/v1/index.html": renderMarkdown(MARKDOWN, { title: "Migration" }).html,
            ...files,
          }
        : { "docs/d1/v1/index.html": HTML, ...files },
    ).map(([k, v]) => [k, Buffer.from(v)]),
  );
  const ctx = (who) => ({
    db,
    caller: { ...who, channel: "mcp", tokenId: "t1" },
    actor: { uid: who.uid, email: who.emailLower, channel: "mcp", tokenId: "t1" },
  });
  const call = (name, who, args) =>
    withFakes(objects, rtdb, () => tool(name).run(ctx(who), { id: "d1", ...args }));
  const text = (key) => objects.get(key)?.toString("utf8");
  const notes = (annId) =>
    [...store.entries()].filter(([p]) => p.startsWith(`${V1}/${annId}/comments/`)).map(([, d]) => d);
  return { db, store, objects, call, text, notes, ann: (id) => store.get(`${V1}/${id}`), doc: () => store.get("docs/d1") };
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
      const at = (path) => path.split("/").reduce((node, k) => (node == null ? undefined : node[k]), rtdb);
      const ref = (path) => ({
        once: async () => ({ val: () => at(path) ?? null, exists: () => at(path) != null }),
        limitToFirst: () => ref(path),
        remove: async () => {
          const parts = path.split("/");
          const parent = at(parts.slice(0, -1).join("/"));
          if (parent) delete parent[parts[parts.length - 1]];
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

const S1 = suggestion("s1", "a single weekend", "We can cut over in ", ", and yes,", "two weekends");
const S2 = suggestion("s2", "OpenAI", "Compare vs. ", " Codex", "");
const S3 = suggestion("s3", "a single fortnight", "cut over in ", ", and", "a month");
const C1 = { annId: "c1", anchor: { exact: "Ship it" }, authorEmail: OWNER.emailLower, resolved: false };

test("an approver's agent accepts two, rejects one, closes the thread, and publishes them as one version", async () => {
  // The sequence a review takes, as one run: every decision lands in the
  // draft, nothing is minted until the draft is published, and the version
  // that is published holds all of it.
  const w = world({ anns: { s1: S1, s2: S2, s3: S3, c1: C1 } });

  const first = await w.call("accept_suggestion", APPROVER, { threadId: "s1" });
  assert.deepEqual(
    { threadId: first.threadId, version: first.version, state: first.state, inDraft: first.inDraft },
    { threadId: "s1", version: "v1", state: "accepted", inDraft: true },
  );
  assert.equal(w.doc().currentVersion, "v1", "accepting mints no version");
  assert.equal(w.doc().draft.baseVersion, "v1");
  assert.match(w.text("docs/d1/draft/index.html"), /We can cut over in two weekends, and yes,\n {5}a single weekend is enough\./);

  await w.call("accept_suggestion", APPROVER, { threadId: "s2" });
  const draft = w.text("docs/d1/draft/index.html");
  assert.match(draft, /two weekends/, "the second lands on top of the first, not over it");
  assert.match(draft, /<p>Compare vs\. Codex &amp; friends\.<\/p>/, "a deletion takes the space it would leave doubled");
  assert.equal(
    draft,
    HTML.replace("in a single weekend, and", "in two weekends, and").replace("vs. OpenAI Codex", "vs. Codex"),
    "and not one other byte changes",
  );

  // A retry after a dropped response reports the outcome and writes nothing.
  assert.equal((await w.call("accept_suggestion", APPROVER, { threadId: "s1" })).state, "accepted");
  assert.equal(w.notes("s1").length, 1);

  await w.call("reject_suggestion", APPROVER, { threadId: "s3", reason: "Not this one." });
  await assert.rejects(w.call("commit_draft", APPROVER, {}), /Resolve all comments/, "the app's own gate");
  await w.call("resolve_thread", APPROVER, { threadId: "c1" });

  const published = await w.call("commit_draft", APPROVER, {});
  assert.equal(published.versionId, "v2");
  assert.equal(published.deduped, false);
  assert.equal(w.doc().currentVersion, "v2");
  assert.equal(w.doc().draft, undefined, "the draft became the version");
  const v2 = w.text("docs/d1/v2/index.html");
  assert.match(v2, /cut over in two weekends/);
  assert.match(v2, /Compare vs\. Codex/);
  assert.equal(w.text("docs/d1/draft/index.html"), undefined);
  const version = w.store.get("docs/d1/versions/v2");
  assert.equal(version.publishedVia, "mcp", "published through an agent, and says so");
  assert.ok(version.editSessions.some((s) => s.actor.channel === "mcp"), "who wrote the draft is kept");

  for (const id of ["s1", "s2"]) {
    const a = w.ann(id);
    assert.equal(a.suggestion.state, "accepted");
    assert.equal(a.resolved, true);
    assert.equal(a.suggestion.decidedBy.channel, "mcp");
    assert.equal(a.suggestion.claim, undefined, "the claim is let go");
    const [note] = w.notes(id);
    assert.equal(note.body, "Accepted.");
    assert.equal(note.actor.channel, "mcp");
  }
});

test("a Markdown document is changed in its source, which stays as written around the change", async () => {
  const w = world({
    format: "markdown",
    anns: {
      s1: suggestion("s1", "a single weekend", "We can cut over in ", ", and yes,", "two *busy* weekends"),
      s2: suggestion("s2", "OpenAI", "Compare vs. ", " Codex", ""),
    },
  });
  await w.call("accept_suggestion", OWNER, { threadId: "s1" });
  await w.call("accept_suggestion", OWNER, { threadId: "s2" });
  assert.equal(
    w.text("docs/d1/draft/index.md"),
    "# Migration\n\nWe can cut over in two \\*busy\\* weekends, and yes, that is enough.\n\nCompare vs. Codex today.\n",
    "the line it was wrapped across is joined, emphasis it did not ask for is escaped, and nothing else moves",
  );
  assert.match(w.text("docs/d1/draft/index.html"), /two \*busy\* weekends/, "and the draft's rendering follows");
});

test("an accept lands on top of what a person already has in the draft", async () => {
  const theirs = HTML.replace("Ship it with", "Ship it, carefully, with");
  const w = world({
    anns: { s1: S1 },
    doc: { draft: { baseVersion: "v1", entry: "index.html", editSessions: [] } },
    files: { "docs/d1/draft/index.html": theirs },
  });
  await w.call("accept_suggestion", APPROVER, { threadId: "s1" });
  const draft = w.text("docs/d1/draft/index.html");
  assert.match(draft, /Ship it, carefully, with/, "their edit is kept");
  assert.match(draft, /cut over in two weekends/, "and the change is made beside it");
});

test("nothing is written while somebody has the editor open, and a log nobody is using is dropped", async () => {
  const live = {
    status: { d1: { peers: { "u-ed": { mode: "edit" }, "u-x": { mode: "view" } }, y: { e1: "AAEC" } } },
  };
  const busy = world({ anns: { s1: S1 }, rtdb: live });
  await assert.rejects(busy.call("accept_suggestion", APPROVER, { threadId: "s1" }), /Somebody has this document open in the editor/);
  await assert.rejects(busy.call("commit_draft", APPROVER, {}), /open in the editor/);
  assert.equal(busy.text("docs/d1/draft/index.html"), undefined);
  assert.equal(busy.ann("s1").suggestion.state, "pending");
  assert.equal(busy.ann("s1").suggestion.claim, undefined, "and nobody is kept off it");

  const idle = { status: { d1: { peers: { "u-x": { mode: "view" } }, y: { e1: "AAEC" } } } };
  const quiet = world({ anns: { s1: S1 }, rtdb: idle });
  await quiet.call("accept_suggestion", APPROVER, { threadId: "s1" });
  assert.equal(idle.status.d1.y, undefined, "the log would have won over the draft, so it goes");
  assert.ok(idle.status.d1.peers["u-x"], "and the readers stay");
  assert.match(quiet.text("docs/d1/draft/index.html"), /two weekends/);
});

test("what cannot be made for certain without the page is refused, and nothing is written or held", async () => {
  const cases = [
    [S3, /stale: .* can only be rejected/],
    [suggestion("s9", "with care today", "Ship it ", "", "now"), /runs across formatting or markup/],
    // The browser would settle for one side of the context; the server does not.
    [suggestion("s9", "a single weekend", "We can cut over in ", " was", "x"), /cannot be placed for certain/],
  ];
  for (const [ann, message] of cases) {
    const w = world({ anns: { [ann.annId]: ann } });
    await assert.rejects(w.call("accept_suggestion", APPROVER, { threadId: ann.annId }), message);
    assert.equal(w.text("docs/d1/draft/index.html"), undefined, String(message));
    assert.equal(w.ann(ann.annId).suggestion.state, "pending");
    assert.equal(w.ann(ann.annId).suggestion.claim, undefined);
  }
});

test("only the owner or an approver accepts, and only a pending suggestion nobody else is applying", async () => {
  const w = world({ anns: { s1: S1 } });
  for (const who of [EDITOR, SUGGESTER]) {
    await assert.rejects(w.call("accept_suggestion", who, { threadId: "s1" }), /only the owner or an approver/);
  }
  const withdrawn = world({ anns: { s1: suggestion("s1", "a single weekend", "cut over in ", ", and", "x", "withdrawn") } });
  await assert.rejects(withdrawn.call("accept_suggestion", APPROVER, { threadId: "s1" }), { message: "it has already been withdrawn" });

  const until = admin.firestore.Timestamp.fromMillis(Date.now() + 60_000);
  const held = world({
    anns: { s1: { ...S1, suggestion: { ...S1.suggestion, claim: { uid: OWNER.uid, email: OWNER.emailLower, until } } } },
  });
  await assert.rejects(held.call("accept_suggestion", APPROVER, { threadId: "s1" }), { message: "owner@example.com is applying it right now" });
  assert.equal(held.text("docs/d1/draft/index.html"), undefined, "the change is not made under someone else's claim");

  const expired = world({ anns: { s1: S1 }, doc: { expiresAt: Date.now() - 1000 } });
  await assert.rejects(expired.call("accept_suggestion", OWNER, { threadId: "s1" }), /expired/);
  await assert.rejects(w.call("commit_draft", SUGGESTER, {}), /you cannot publish that document's draft/);
  await assert.rejects(w.call("commit_draft", APPROVER, {}), /There is no draft to publish/);
});

test("an update is refused while the draft holds an accepted change, and says to publish the draft", async () => {
  const w = world({ anns: { s1: S1 } });
  await w.call("accept_suggestion", APPROVER, { threadId: "s1" });
  await assert.rejects(
    w.call("update_document", APPROVER, { content: "<p>Something else entirely.</p>" }),
    /holds 1 accepted suggestion, .* Publish the draft first, with commit_draft/,
  );
  assert.match(w.text("docs/d1/draft/index.html"), /two weekends/, "and the draft is kept");
});
