// SPDX-License-Identifier: Apache-2.0
// Provenance, the public projection, and export marking (SPEC §17, §20).

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { actedThrough, actorFrom, isAutomated, viaLabel } = require("../lib/lib/actor.js");
const { originOf, publishedViaOf } = require("../lib/lib/versions.js");
const { appendEditSession } = require("../lib/lib/draft.js");
const { projectPublicDoc, projectReader } = require("../lib/lib/publicdoc.js");
const { resolveMarking, markingIsVisible, MARKING_OFF } = require("../lib/lib/marking.js");
const { emailKey } = require("../lib/lib/presence.js");

function request(headers = {}) {
  return { headers, query: {}, method: "POST", path: "/x" };
}

// --- Actor -----------------------------------------------------------------

test("the channel comes from the credential, never from the request", () => {
  const web = actorFrom({ uid: "u1", emailLower: "a@example.com", channel: "web" }, request());
  assert.equal(web.channel, "web");

  // A token minted as a CLI token reads as "cli" wherever it is presented,
  // /mcp included. The caller cannot relabel their own traffic, because the
  // label lives in the token record on the server.
  const cli = actorFrom(
    { uid: "u1", emailLower: "a@example.com", channel: "cli", tokenId: "t1" },
    request({ "x-bikeshed-client": "bikeshed-cli/0.5.0" }),
  );
  assert.equal(cli.channel, "cli");
  assert.equal(cli.tokenId, "t1");
});

test("what acted is named in words, from the credential, and stored with the action", () => {
  // ADR 0023: the CLI, a personal token and an app that signed in all used to
  // read "mcp" on /mcp, so the Activity panel could not tell them apart.
  const as = (channel, credentialName) =>
    actorFrom({ uid: "u1", emailLower: "a@example.com", channel, tokenId: "t1", credentialName }, request());
  assert.equal(as("cli", "CLI on mbp").via, "CLI on mbp", "what bikeshed login mints reads as itself");
  assert.equal(as("cli", "Command line").via, "the command line");
  assert.equal(as("cli", "deploy").via, "CLI token “deploy”", "a CLI token somebody named");
  assert.equal(as("mcp", "laptop agent").via, "personal token “laptop agent”");
  assert.equal(as("api", "nightly").via, "personal token “nightly”");
  assert.equal(as("app", "Claude").via, "“Claude” (connected app)");
  assert.equal(as("app", "Claude").channel, "app");
  assert.ok(!("via" in as("web", undefined)), "a person in the browser needs no words");
});

test("an app is always called an app, whatever name it registered under", () => {
  // The name is the app's own claim, so it is quoted and marked, never shown bare.
  assert.equal(viaLabel("app", "Web"), "“Web” (connected app)");
  assert.equal(viaLabel("app", `Cla${String.fromCharCode(10)}ude`), "“Claude” (connected app)", "no control characters");
  assert.equal(viaLabel("app", ""), "a connected app");
  assert.equal(viaLabel("app", "x".repeat(500)).length, "“” (connected app)".length + 120, "bounded");
  assert.equal(viaLabel("operator"), "an operator script");
  assert.equal(viaLabel("web", "anything"), undefined);
});

test("a version says how its content arrived apart from who sent it, and the old field follows from both", () => {
  const web = { channel: "web" };
  assert.equal(publishedViaOf("upload", web), "upload");
  assert.equal(publishedViaOf("edit", web), "editor");
  assert.equal(publishedViaOf("fork", web), "fork");
  // `bikeshed publish` used to read "upload", and its update "cli".
  assert.equal(publishedViaOf("upload", { channel: "cli" }), "cli");
  assert.equal(publishedViaOf("edit", { channel: "app" }), "app", "an agent's commit of an edit");
  assert.equal(publishedViaOf("fork", { channel: "mcp" }), "fork", "a fork stays a fork");
  assert.equal(publishedViaOf("upload", { channel: "operator" }), "operator");
});

test("a version written before origin was stored reads its origin from the old field, a duplicate as the fork it was", () => {
  assert.equal(originOf({ origin: "edit", publishedVia: "mcp" }), "edit", "origin, where stored, is the answer");
  assert.equal(originOf({ publishedVia: "editor" }), "edit");
  assert.equal(originOf({ publishedVia: "fork" }), "fork");
  assert.equal(originOf({ publishedVia: "duplicate" }), "fork", "the older name of a fork");
  assert.equal(originOf({ publishedVia: "cli" }), "upload");
  assert.equal(originOf({}), null);
  assert.equal(originOf(undefined), null);
});

test("what acted reads the same words on the server as in the browser (via-vectors.json)", () => {
  const { cases } = JSON.parse(readFileSync(join(__dirname, "fixtures", "via-vectors.json"), "utf8"));
  for (const c of cases) assert.equal(actedThrough(c.actor).via ?? null, c.via, c.name);
  assert.deepEqual(actedThrough({ channel: "web", via: "ignored" }), { channel: "web" }, "a person in the browser carries no words");
  assert.deepEqual(actedThrough(undefined), { channel: "web" });
});

test("a draft's session log keeps two agents of one person apart", () => {
  // The merge key was email and channel, so two MCP tokens of one person
  // writing in turn read as one session.
  const by = (tokenId) => ({ uid: "u1", email: "a@example.com", channel: "mcp", tokenId });
  let log = appendEditSession([], by("t1"));
  log = appendEditSession(log, by("t1"));
  assert.equal(log.length, 1, "the same token extends its own entry");
  log = appendEditSession(log, by("t2"));
  assert.deepEqual(log.map((s) => s.actor.tokenId), ["t1", "t2"]);
});

test("client and agent are self-reported, stored, and bounded", () => {
  const actor = actorFrom(
    { uid: "u1", emailLower: "a@example.com", channel: "mcp", tokenId: "t1" },
    request({ "x-bikeshed-client": "bikeshed-cli/0.3.1", "x-bikeshed-agent": "some-model" }),
  );
  assert.equal(actor.client, "bikeshed-cli/0.3.1");
  assert.equal(actor.agent, "some-model");
});

test("self-reported values cannot smuggle control characters or unbounded text", () => {
  const actor = actorFrom(
    { uid: "u1", emailLower: "a@example.com", channel: "api" },
    request({
      "x-bikeshed-client": `line1${String.fromCharCode(10)}line2`,
      "x-bikeshed-agent": "x".repeat(500),
    }),
  );
  assert.equal(actor.client, "line1line2");
  assert.equal(actor.agent.length, 120);
});

test("absent headers produce no key at all, rather than an empty string", () => {
  const actor = actorFrom({ uid: "u1", emailLower: "a@example.com", channel: "web" }, request());
  assert.ok(!("client" in actor));
  assert.ok(!("agent" in actor));
  assert.ok(!("tokenId" in actor));
});

test("automation is exactly everything that is not the web channel", () => {
  const base = { uid: "u", email: "a@example.com" };
  assert.equal(isAutomated({ ...base, channel: "web" }), false);
  for (const channel of ["cli", "mcp", "api", "app", "operator"]) {
    assert.equal(isAutomated({ ...base, channel }), true, channel);
  }
});

// --- Public projection -----------------------------------------------------

const PRIVATE_FIELDS = [
  "latest",
  "members",
  "viewers",
  "editors",
  "editorMembers",
  "ownerEmail",
  "ownerUid",
  "stats",
  "linkToken",
  "draft",
  "folderId",
];

function storedDoc(overrides = {}) {
  return {
    title: "Memo",
    slug: "memo",
    currentVersion: "v2",
    entry: "index.html",
    format: "markdown",
    trusted: false,
    publicEdit: true,
    ownerEmail: "owner@example.com",
    ownerUid: "u-owner",
    members: ["owner@example.com", "ana@example.com"],
    viewers: ["ana@example.com"],
    editors: [],
    editorMembers: ["owner@example.com"],
    stats: { views: 42, totalMs: 1000 },
    linkToken: "s3cret-token-value-22ch",
    marking: { enabled: true, label: "CONFIDENTIAL", footer: "x" },
    folderId: "f1",
    ...overrides,
  };
}

test("a private document has no projection at all", () => {
  assert.equal(projectPublicDoc("d1", storedDoc()), null, "absent visibility is private");
  assert.equal(projectPublicDoc("d1", storedDoc({ visibility: "private" })), null);
  assert.equal(projectReader("d1", storedDoc({ visibility: "private" })), null);
});

test("an unlisted document is never in the world-readable projection", () => {
  // public/{docId} is readable by anyone who knows an id. An unlisted document
  // there would tell a keyless visitor its title and that it exists — the
  // exact thing its link is meant to guard (SPEC §17). Its readers get the
  // same shape from POST /unlock, which checks the key.
  assert.equal(projectPublicDoc("d1", storedDoc({ visibility: "unlisted" })), null);
  assert.notEqual(projectReader("d1", storedDoc({ visibility: "unlisted" })), null);
});

test("the projection carries render fields and nothing else", () => {
  // Firestore rules cannot project fields, which is the entire reason this
  // collection exists. If a future field rides along, the world reads it.
  const p = projectPublicDoc("d1", storedDoc({ visibility: "public" }));
  assert.ok(p, "a public document is projected");
  assert.deepEqual(Object.keys(p).sort(), [
    "currentVersion",
    "liveEpoch",
    "docId",
    "entry",
    "expiresAt",
    "forked",
    "format",
    "fileCount",
    "sourceEntry",
    "marking",
    "publicEdit",
    "publishedAt",
    "slug",
    "title",
    "trusted",
    "viaFolder",
    "visibility",
    "words",
  ].sort());
  for (const field of PRIVATE_FIELDS) {
    assert.ok(!(field in p), `${field} leaked into the public projection`);
  }
});

test("the reader projection an unlisted document unlocks carries render fields and nothing else", () => {
  // What POST /unlock returns to a link holder. Same rule: a field that rides
  // along reaches every holder of the link.
  const p = projectReader("d1", storedDoc({ visibility: "unlisted" }));
  assert.ok(p, "an unlisted document has a reader projection");
  assert.deepEqual(Object.keys(p).sort(), [
    "currentVersion",
    "liveEpoch",
    "docId",
    "entry",
    "expiresAt",
    "forked",
    "format",
    "fileCount",
    "sourceEntry",
    "marking",
    "publicEdit",
    "publishedAt",
    "slug",
    "title",
    "trusted",
    "viaFolder",
    "visibility",
    "words",
  ].sort());
  for (const field of PRIVATE_FIELDS) {
    assert.ok(!(field in p), `${field} leaked into the reader projection`);
  }
});

test("a reader is told when the current version was published and how long it is, never by whom", () => {
  const at = admin.firestore.Timestamp.fromMillis(Date.UTC(2026, 9, 29));
  const latest = { version: "v3", at, byEmail: "author@example.com", channel: "cli", via: "CLI on mbp", origin: "upload", words: 1234 };
  for (const [project, visibility] of [[projectPublicDoc, "public"], [projectReader, "unlisted"]]) {
    const p = project("d1", storedDoc({ visibility, latest, updatedAt: admin.firestore.Timestamp.fromMillis(Date.UTC(2026, 9, 30)) }));
    assert.equal(p.words, 1234, visibility);
    assert.equal(p.publishedAt.toMillis(), at.toMillis(), `${visibility}: the publish, not the last rename or re-share`);
    assert.doesNotMatch(JSON.stringify(p), /author@example\.com|CLI on mbp|latest/, `${visibility}: nobody is named`);
  }
  // Before the summary exists, the projection falls back and counts nothing.
  assert.equal(projectReader("d1", storedDoc({ visibility: "unlisted" })).words, null);
});

test("reader projections carry only the bounded document marking, including explicit off", () => {
  for (const [project, visibility] of [[projectPublicDoc, "public"], [projectReader, "unlisted"]]) {
    const marking = { enabled: true, label: "OWNER", footer: "For {user}", privateNote: "never project" };
    assert.deepEqual(project("d1", storedDoc({ visibility, marking })).marking,
      { enabled: true, label: "OWNER", footer: "For {user}" }, "the reader receives the owner's export policy without extra fields");
    assert.deepEqual(project("d1", storedDoc({ visibility, marking: { enabled: false, label: "old", footer: "old" } })).marking,
      MARKING_OFF, "turning marking off is authoritative for every reader");
  }
});

test("a fork is projected as a fork, and nothing about where it came from", () => {
  // The parent lives in the server-only forks/ collection precisely so that
  // neither the world nor a link holder learns it from a projection (SPEC §21).
  const stored = storedDoc({ visibility: "public", forked: true, parentId: "layoffs-plan-q3" });
  for (const p of [projectPublicDoc("d1", stored), projectReader("d1", { ...stored, visibility: "unlisted" })]) {
    assert.equal(p.forked, true);
    assert.ok(!JSON.stringify(p).includes("layoffs"), "the parent rode along");
  }
  assert.equal(projectPublicDoc("d1", storedDoc({ visibility: "public" })).forked, false);
});

test("the link token is never projected", () => {
  // An unlisted document's token IS its access control. Handing it back from
  // /unlock would let a link holder mint links after a rotation.
  const p = projectReader("d1", storedDoc({ visibility: "unlisted" }));
  assert.ok(p, "the check is vacuous against a null projection");
  assert.ok(!JSON.stringify(p).includes("s3cret"));
});

test("the projection carries trust so an anonymous reader is sandboxed the same way", () => {
  const p = projectPublicDoc("d1", storedDoc({ visibility: "public" }));
  assert.equal(p.trusted, false);
  const t = projectPublicDoc("d1", storedDoc({ visibility: "public", trusted: true }));
  assert.equal(t.trusted, true);
});

test("only trusted: true is trust; a missing flag fails closed, as it does everywhere else (ADR 0021)", () => {
  assert.equal(projectPublicDoc("d1", storedDoc({ visibility: "public", trusted: undefined })).trusted, false);
  assert.equal(projectPublicDoc("d1", storedDoc({ visibility: "public", trusted: "yes" })).trusted, false);
  assert.equal(projectPublicDoc("d1", storedDoc({ visibility: "public", trusted: true })).trusted, true);
});

// --- Export marking --------------------------------------------------------

test("marking is off unless explicitly enabled", () => {
  assert.deepEqual(resolveMarking(null), MARKING_OFF);
  assert.deepEqual(resolveMarking({}), MARKING_OFF);
  assert.deepEqual(resolveMarking({ label: "X", footer: "Y" }), MARKING_OFF);
  assert.deepEqual(resolveMarking({ enabled: "yes" }), MARKING_OFF);
});

test("marking values are clamped and stripped of control characters", () => {
  const m = resolveMarking({
    enabled: true,
    label: `CONF${String.fromCharCode(9)}IDENTIAL ${"x".repeat(100)}`,
    footer: "y".repeat(500),
  });
  assert.equal(m.label.length, 40);
  assert.equal(m.footer.length, 300);
  assert.ok(!m.label.includes(String.fromCharCode(9)));
});

test("an enabled but empty marking renders nothing", () => {
  assert.equal(markingIsVisible(resolveMarking({ enabled: true })), false);
  assert.equal(markingIsVisible(resolveMarking({ enabled: true, label: "X" })), true);
});

// --- Presence keys ---------------------------------------------------------

test("every dot in an address becomes a comma, so it is a legal RTDB key", () => {
  assert.equal(emailKey("a.b.c@sub.example.com"), "a,b,c@sub,example,com");
  assert.equal(emailKey("A@Example.COM"), "a@example,com");
});

test("the email validator guarantees the remaining illegal key characters cannot occur", async () => {
  // RTDB keys may not contain . $ # [ ] / — dots are replaced above, and the
  // other five are rejected at validation. That is why presence can never
  // half-work for an address the ACL happily accepted.
  const { isEmailShapeValid } = require("../lib/generated/policy.js");
  for (const ch of ["$", "#", "[", "]", "/"]) {
    assert.equal(isEmailShapeValid(`a${ch}b@example.com`), false, ch);
  }
});

test("the projection carries the expiry, so a reader is told rather than shown nothing", () => {
  // There is no scheduler here, so nothing deletes this row when the moment
  // arrives — the date travels with it and the app says "expired" instead of
  // rendering an empty frame against a 404.
  const at = Date.UTC(2030, 0, 1);
  const p = projectPublicDoc("d1", storedDoc({ visibility: "public", expiresAt: at }));
  assert.equal(p.expiresAt, at);
  assert.equal(
    projectPublicDoc("d1", storedDoc({ visibility: "public" })).expiresAt,
    null,
    "a document with no expiry says so explicitly",
  );
});

test("reader projections carry the current live generation, defaulting older documents to initial", () => {
  for (const visibility of ["public", "unlisted"]) {
    assert.equal(projectReader("d1", storedDoc({ visibility, liveEpoch: "epoch-next" })).liveEpoch, "epoch-next");
    assert.equal(projectReader("d1", storedDoc({ visibility })).liveEpoch, "initial");
  }
});
