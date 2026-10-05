// SPDX-License-Identifier: Apache-2.0
// Provenance, the public projection, and export marking (SPEC §17, §20).

const test = require("node:test");
const assert = require("node:assert/strict");

const { actorFrom, isAutomated } = require("../lib/lib/actor.js");
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

  // A token minted as a CLI token reads as "cli" wherever it is presented. The
  // caller cannot relabel their own traffic, because the label lives in the
  // token record on the server.
  const cli = actorFrom(
    { uid: "u1", emailLower: "a@example.com", channel: "cli", tokenId: "t1" },
    request({ "x-bikeshed-client": "bikeshed-cli/0.4.1" }),
  );
  assert.equal(cli.channel, "cli");
  assert.equal(cli.tokenId, "t1");
});

test("an endpoint may override the channel when it knows better", () => {
  // /mcp stamps mcp whatever the token says: the endpoint is the stronger signal.
  const actor = actorFrom(
    { uid: "u1", emailLower: "a@example.com", channel: "cli", tokenId: "t1" },
    request(),
    "mcp",
  );
  assert.equal(actor.channel, "mcp");
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
  for (const channel of ["cli", "mcp", "api"]) {
    assert.equal(isAutomated({ ...base, channel }), true, channel);
  }
});

// --- Public projection -----------------------------------------------------

const PRIVATE_FIELDS = [
  "members",
  "viewers",
  "editors",
  "editorMembers",
  "ownerEmail",
  "ownerUid",
  "stats",
  "linkToken",
  "marking",
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
    "docId",
    "entry",
    "expiresAt",
    "forked",
    "format",
    "publicEdit",
    "publishedAt",
    "slug",
    "title",
    "trusted",
    "visibility",
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
    "docId",
    "entry",
    "expiresAt",
    "forked",
    "format",
    "publicEdit",
    "slug",
    "title",
    "trusted",
    "visibility",
  ].sort());
  for (const field of PRIVATE_FIELDS) {
    assert.ok(!(field in p), `${field} leaked into the reader projection`);
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

test("a missing trusted flag is treated as trusted, as it is everywhere else", () => {
  const p = projectPublicDoc("d1", storedDoc({ visibility: "public", trusted: undefined }));
  assert.equal(p.trusted, true);
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
