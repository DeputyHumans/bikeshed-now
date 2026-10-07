// SPDX-License-Identifier: Apache-2.0
// The access decision table, and the grant algebra behind it (SPEC §2, §17, §18).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canEdit,
  canManageSharing,
  canSuggest,
  canManageTeam,
  canRead,
  canEditFolder,
  canManageFolder,
  canReadFolder,
  expiryMs,
  isDocApprover,
  isDocEditor,
  isExpired,
  isMember,
  isNonPrivate,
  isTeamMember,
  keepsTrust,
  opensEditingToAnyAccount,
  readBasis,
  visibilityOf,
} = require("../lib/lib/acl.js");
const {
  applyAccessDelta,
  invalidPrincipals,
  isTeamRef,
  isValidPrincipal,
  parseAccessDelta,
  parseExpiry,
  teamIdOf,
} = require("../lib/lib/access.js");

const OWNER = { uid: "u-owner", emailLower: "owner@example.com" };
const EDITOR = { uid: "u-editor", emailLower: "ed@example.com" };
const VIEWER = { uid: "u-viewer", emailLower: "viewer@example.com" };
const STRANGER = { uid: "u-stranger", emailLower: "stranger@example.com" };

function doc(overrides = {}) {
  return {
    ownerUid: OWNER.uid,
    ownerEmail: OWNER.emailLower,
    viewers: [VIEWER.emailLower],
    editors: [EDITOR.emailLower],
    members: [OWNER.emailLower, VIEWER.emailLower, EDITOR.emailLower],
    editorMembers: [OWNER.emailLower, EDITOR.emailLower],
    ...overrides,
  };
}

// --- Reading ---------------------------------------------------------------

test("a private document is readable only by its members", () => {
  const d = doc();
  assert.equal(canRead(d, OWNER), true);
  assert.equal(canRead(d, EDITOR), true);
  assert.equal(canRead(d, VIEWER), true);
  assert.equal(canRead(d, STRANGER), false);
  assert.equal(canRead(d, null), false, "anonymous must not read a private document");
});

test("absent visibility means private", () => {
  assert.equal(visibilityOf(doc()), "private");
  assert.equal(isNonPrivate(doc()), false);
  assert.equal(visibilityOf(doc({ visibility: "nonsense" })), "private");
});

test("a public document is readable by anyone", () => {
  const d = doc({ visibility: "public" });
  assert.equal(canRead(d, null), true);
  assert.equal(canRead(d, STRANGER), true);
  assert.equal(readBasis(d, null), "public");
  assert.equal(readBasis(d, VIEWER), "member", "a member reads as a member whatever the level");
});

// An unlisted document needs its link. Without the key, anyone who is not a
// member learns exactly what a private document would tell them: nothing
// (SPEC §17).
const TOKEN = "tok_0123456789abcdefghijk";

test("an unlisted document is unreadable without its key", () => {
  const d = doc({ visibility: "unlisted", linkToken: TOKEN });
  assert.equal(canRead(d, null), false, "anonymous, no key");
  assert.equal(canRead(d, STRANGER), false, "signed in, no key");
  assert.equal(canRead(d, VIEWER), true, "a member needs no key");
  assert.equal(readBasis(d, STRANGER), null);
});

test("the unlisted key must match exactly", () => {
  const d = doc({ visibility: "unlisted", linkToken: TOKEN });
  assert.equal(readBasis(d, null, { k: TOKEN }), "link");
  assert.equal(readBasis(d, STRANGER, { k: TOKEN }), "link");
  const refused = [
    ["wrong", "tok_0123456789abcdefghijX"],
    ["prefix", TOKEN.slice(0, 10)],
    ["longer", `${TOKEN}x`],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    // Same length in characters, longer in bytes: a byte-length mismatch must
    // refuse, not throw out of timingSafeEqual.
    ["multi-byte", `${TOKEN.slice(0, -1)}é`],
  ];
  for (const [label, k] of refused) {
    assert.equal(readBasis(d, null, { k }), null, label);
    assert.equal(canRead(d, STRANGER, { k }), false, label);
  }
});

test("a document without a stored token opens to no key", () => {
  for (const linkToken of [undefined, null, "", 12345]) {
    const d = doc({ visibility: "unlisted", linkToken });
    for (const k of ["", "undefined", "null", "12345"]) {
      assert.equal(readBasis(d, null, { k }), null, `${String(linkToken)} / ${k}`);
    }
  }
});

test("a key opens nothing on a private or public document it was not minted for", () => {
  // A private document keeps a stale token only by accident; it must not
  // matter. setVisibility deletes it, but the predicate does not rely on that.
  const priv = doc({ visibility: "private", linkToken: TOKEN });
  assert.equal(readBasis(priv, null, { k: TOKEN }), null);
  assert.equal(readBasis(priv, STRANGER, { grantToken: TOKEN }), null);
});

test("a link grant counts only under the current token, and only for a caller", () => {
  const d = doc({ visibility: "unlisted", linkToken: TOKEN });
  assert.equal(readBasis(d, STRANGER, { grantToken: TOKEN }), "grant");
  assert.equal(readBasis(d, STRANGER, { grantToken: "tok_rotated_away_long_ago" }), null, "rotated");
  assert.equal(readBasis(d, null, { grantToken: TOKEN }), null, "a grant belongs to an account");
  assert.equal(readBasis(d, STRANGER, { grantToken: "" }), null);
});

test("the key ladder prefers membership, then public, then the key, then a grant", () => {
  const d = doc({ visibility: "unlisted", linkToken: TOKEN });
  assert.equal(readBasis(d, VIEWER, { k: TOKEN, grantToken: TOKEN }), "member");
  assert.equal(readBasis(d, STRANGER, { k: TOKEN, grantToken: TOKEN }), "link");
});

test("membership is by uid OR by email, and is case-exact on stored values", () => {
  assert.equal(isMember(doc(), OWNER.uid, "someone@else.com"), true, "owner by uid");
  // Members are stored lowercased as an invariant; a mixed-case entry grants
  // nothing, which is what keeps the Firestore list rule exact rather than
  // merely close (SPEC §5).
  const mixed = doc({ members: ["Viewer@Example.com"], ownerUid: null });
  assert.equal(isMember(mixed, VIEWER.uid, VIEWER.emailLower), false);
});

test("a missing document denies everything", () => {
  for (const d of [null, undefined]) {
    assert.equal(canRead(d, OWNER), false);
    assert.equal(canEdit(d, OWNER), false);
    assert.equal(isDocEditor(d, OWNER.uid, OWNER.emailLower), false);
    assert.equal(canManageSharing(d, OWNER.emailLower), false);
  }
});

// --- Editing ---------------------------------------------------------------

test("editing is owner, direct editors, or effective editors", () => {
  const d = doc();
  assert.equal(canEdit(d, OWNER), true);
  assert.equal(canEdit(d, EDITOR), true);
  assert.equal(canEdit(d, VIEWER), false);
  assert.equal(canEdit(d, STRANGER), false);
});

test("legacy documents without editorMembers fall back to editors", () => {
  const d = doc({ editorMembers: undefined });
  assert.equal(canEdit(d, EDITOR), true);
});

test("inherited editors edit through editorMembers alone", () => {
  const d = doc({ editors: [], editorMembers: [OWNER.emailLower, "inherited@example.com"] });
  assert.equal(canEdit(d, { uid: "u-i", emailLower: "inherited@example.com" }), true);
});

test("publicEdit widens WHO may edit, never to anyone", () => {
  const d = doc({ visibility: "public", publicEdit: true });
  assert.equal(canEdit(d, STRANGER), true, "any verified account may edit");
  assert.equal(canEdit(d, null), false, "anonymous is read-only, always");
});

test("publicEdit on a private document does nothing", () => {
  const d = doc({ visibility: "private", publicEdit: true });
  assert.equal(canEdit(d, STRANGER), false);
});

test("publicEdit on an unlisted document needs the key or a grant", () => {
  const d = doc({ visibility: "unlisted", linkToken: TOKEN, publicEdit: true });
  assert.equal(canEdit(d, STRANGER), false, "no key, no editing");
  assert.equal(canEdit(d, STRANGER, { grantToken: TOKEN }), true);
  assert.equal(canEdit(d, STRANGER, { k: TOKEN }), true);
  assert.equal(canEdit(d, null, { k: TOKEN }), false, "anonymous is read-only, key or not");
  assert.equal(canEdit(d, VIEWER), true, "a viewer member edits an open-editing document");
});

test("only a PUBLIC open-editing document opens editing to any account", () => {
  // The realtime `*` key is written from this, and the realtime rules cannot
  // see a key. An unlisted document therefore never gets it (SPEC §16).
  assert.equal(opensEditingToAnyAccount(doc({ visibility: "public", publicEdit: true })), true);
  assert.equal(opensEditingToAnyAccount(doc({ visibility: "unlisted", publicEdit: true })), false);
  assert.equal(opensEditingToAnyAccount(doc({ visibility: "private", publicEdit: true })), false);
  assert.equal(opensEditingToAnyAccount(doc({ visibility: "public" })), false);
});

test("publicEdit does NOT make a stranger a document editor", () => {
  // isDocEditor gates the per-person reading statistics and the activity feed.
  // Open editing must not hand a stranger the reading history of everyone who
  // opened the document.
  const d = doc({ visibility: "public", publicEdit: true });
  assert.equal(canEdit(d, STRANGER), true);
  assert.equal(isDocEditor(d, STRANGER.uid, STRANGER.emailLower), false);
});

// --- Sharing, folders, teams ----------------------------------------------

test("sharing, trust, visibility and marking are owner-only", () => {
  assert.equal(canManageSharing(doc(), OWNER.emailLower), true);
  assert.equal(canManageSharing(doc(), EDITOR.emailLower), false);
  assert.equal(canManageSharing(doc({ ownerEmail: "Owner@Example.com" }), OWNER.emailLower), true);
});

test("folder gates mirror document gates", () => {
  const folder = {
    ownerUid: null,
    ownerEmail: OWNER.emailLower,
    members: [OWNER.emailLower, VIEWER.emailLower],
    editorMembers: [OWNER.emailLower],
  };
  assert.equal(canReadFolder(folder, VIEWER.uid, VIEWER.emailLower), true);
  assert.equal(canReadFolder(folder, STRANGER.uid, STRANGER.emailLower), false);
  assert.equal(canEditFolder(folder, OWNER.uid, OWNER.emailLower), true);
  assert.equal(canEditFolder(folder, VIEWER.uid, VIEWER.emailLower), false);
  assert.equal(canManageFolder(folder, OWNER.emailLower), true);
  assert.equal(canManageFolder(folder, VIEWER.emailLower), false);
});

test("a team is managed by its owner or an admin", () => {
  const team = {
    ownerEmail: OWNER.emailLower,
    admins: [OWNER.emailLower, EDITOR.emailLower],
    members: [OWNER.emailLower, EDITOR.emailLower, VIEWER.emailLower],
  };
  assert.equal(canManageTeam(team, OWNER.emailLower), true);
  assert.equal(canManageTeam(team, EDITOR.emailLower), true);
  assert.equal(canManageTeam(team, VIEWER.emailLower), false);
  assert.equal(isTeamMember(team, VIEWER.emailLower), true);
  assert.equal(isTeamMember(team, STRANGER.emailLower), false);
});

// --- Suggesting and deciding (SPEC §13) -------------------------------------

const SUGGESTER = { uid: "u-suggester", emailLower: "sug@example.com" };
const APPROVER = { uid: "u-approver", emailLower: "appr@example.com" };

function ladderDoc(overrides = {}) {
  return doc({
    suggesters: [SUGGESTER.emailLower],
    approvers: [APPROVER.emailLower],
    members: [OWNER, VIEWER, SUGGESTER, EDITOR, APPROVER].map((c) => c.emailLower),
    suggesterMembers: [OWNER, SUGGESTER, EDITOR, APPROVER].map((c) => c.emailLower),
    editorMembers: [OWNER, EDITOR, APPROVER].map((c) => c.emailLower),
    approverMembers: [OWNER, APPROVER].map((c) => c.emailLower),
    ...overrides,
  });
}

test("suggesting is for suggesters and everyone who may edit", () => {
  const d = ladderDoc();
  assert.equal(canSuggest(d, VIEWER), false);
  assert.equal(canSuggest(d, SUGGESTER), true);
  assert.equal(canSuggest(d, EDITOR), true);
  assert.equal(canSuggest(d, APPROVER), true);
  assert.equal(canSuggest(d, OWNER), true);
  assert.equal(canSuggest(d, STRANGER), false);
  assert.equal(canSuggest(d, null), false, "anonymous never suggests");
});

test("an inherited suggester suggests through suggesterMembers alone", () => {
  const d = ladderDoc({ suggesters: [], suggesterMembers: [SUGGESTER.emailLower] });
  assert.equal(canSuggest(d, SUGGESTER), true);
});

test("an open editor may suggest, having been able to make the change outright", () => {
  const d = ladderDoc({ visibility: "public", publicEdit: true });
  assert.equal(canSuggest(d, STRANGER), true);
});

test("deciding on a suggestion is for the owner and approvers, and nobody it was widened to", () => {
  const d = ladderDoc({ visibility: "public", publicEdit: true });
  assert.equal(isDocApprover(d, OWNER.uid, OWNER.emailLower), true);
  assert.equal(isDocApprover(d, APPROVER.uid, APPROVER.emailLower), true);
  assert.equal(isDocApprover(d, EDITOR.uid, EDITOR.emailLower), false, "an editor is not an approver");
  assert.equal(isDocApprover(d, SUGGESTER.uid, SUGGESTER.emailLower), false);
  assert.equal(isDocApprover(d, STRANGER.uid, STRANGER.emailLower), false, "open editing never reaches deciding");
});

test("an inherited approver decides through approverMembers alone", () => {
  const d = ladderDoc({ approvers: [], approverMembers: [OWNER.emailLower, "folder@example.com"] });
  assert.equal(isDocApprover(d, "u-folder", "folder@example.com"), true);
});

test("an approver edits, through the direct list as well as the effective set", () => {
  // Accepting a suggestion is an edit in the approver's own session, so an
  // approver who could not edit could not accept anything.
  const d = ladderDoc({ editorMembers: [OWNER.emailLower, EDITOR.emailLower] });
  assert.equal(isDocEditor(d, APPROVER.uid, APPROVER.emailLower), true);
  assert.equal(canEdit(d, APPROVER), true);
  assert.equal(isDocEditor(d, SUGGESTER.uid, SUGGESTER.emailLower), false);
});

// --- Grant algebra ---------------------------------------------------------

test("a principal holds exactly one role, across all four lists", () => {
  let state = applyAccessDelta({}, OWNER.emailLower, {
    add: [{ principal: "a@example.com", role: "suggester" }],
    remove: [],
  });
  assert.deepEqual(state, { viewers: [], suggesters: ["a@example.com"], editors: [], approvers: [] });
  state = applyAccessDelta(state, OWNER.emailLower, {
    add: [{ principal: "a@example.com", role: "approver" }],
    remove: [],
  });
  assert.deepEqual(state, { viewers: [], suggesters: [], editors: [], approvers: ["a@example.com"] });
  state = applyAccessDelta(state, OWNER.emailLower, { add: [], remove: ["a@example.com"] });
  assert.deepEqual(state, { viewers: [], suggesters: [], editors: [], approvers: [] });
});

test("every role is accepted on the wire, and a refusal names them all", () => {
  for (const role of ["viewer", "suggester", "editor", "approver"]) {
    const parsed = parseAccessDelta({ add: [{ email: "a@example.com", role }] });
    assert.ok("delta" in parsed, role);
  }
  const bad = parseAccessDelta({ add: [{ email: "a@example.com", role: "owner" }] });
  assert.match(bad.error, /"viewer", "suggester", "editor", "approver"/);
});

test("a principal holds exactly one role", () => {
  const next = applyAccessDelta(
    { viewers: ["a@example.com"], editors: [] },
    OWNER.emailLower,
    { add: [{ principal: "a@example.com", role: "editor" }], remove: [] },
  );
  assert.deepEqual(next.viewers, []);
  assert.deepEqual(next.editors, ["a@example.com"]);
});

test("the owner is never removed and never stored in a role", () => {
  const next = applyAccessDelta({ viewers: [], editors: [] }, OWNER.emailLower, {
    add: [{ principal: OWNER.emailLower, role: "editor" }],
    remove: [OWNER.emailLower],
  });
  assert.deepEqual(next.viewers, []);
  assert.deepEqual(next.editors, []);
});

test("applying the same delta twice converges", () => {
  const delta = { add: [{ principal: "A@Example.com", role: "viewer" }], remove: [] };
  const once = applyAccessDelta({ viewers: [], editors: [] }, OWNER.emailLower, delta);
  const twice = applyAccessDelta(once, OWNER.emailLower, delta);
  assert.deepEqual(once, twice);
  assert.deepEqual(once.viewers, ["a@example.com"], "emails are lowercased");
});

test("team references survive normalization with their case intact", () => {
  // Firestore document ids are case-sensitive, so lowercasing a team id would
  // point the grant at a team that does not exist.
  const next = applyAccessDelta({ viewers: [], editors: [] }, OWNER.emailLower, {
    add: [{ principal: "team:DesignTeam", role: "viewer" }],
    remove: [],
  });
  assert.deepEqual(next.viewers, ["team:DesignTeam"]);
  assert.equal(isTeamRef("team:DesignTeam"), true);
  assert.equal(teamIdOf("team:DesignTeam"), "DesignTeam");
  assert.equal(teamIdOf("ana@example.com"), null);
});

test("principal validation accepts emails and team ids and nothing else", () => {
  assert.equal(isValidPrincipal("a@example.com"), true);
  assert.equal(isValidPrincipal("team:abc123"), true);
  assert.equal(isValidPrincipal("not an email"), false);
  assert.equal(isValidPrincipal("team:"), false);
  assert.equal(isValidPrincipal("team:has spaces"), false);
  assert.equal(isValidPrincipal("a@evil.com/../x"), false);
});

test("an open policy still rejects a malformed address", () => {
  // The default policy accepts any DOMAIN, not any string. Without the shape
  // check, garbage would flow straight into an ACL array.
  assert.deepEqual(
    invalidPrincipals({ add: [{ principal: "nonsense", role: "viewer" }], remove: [] }),
    ["nonsense"],
  );
});

test("body parsing rejects the shapes that would otherwise write junk", () => {
  assert.ok("error" in parseAccessDelta(null));
  assert.ok("error" in parseAccessDelta({ add: "a@example.com" }));
  assert.ok("error" in parseAccessDelta({ add: [{ email: "a@example.com" }] }));
  assert.ok("error" in parseAccessDelta({ add: [{ email: "a@example.com", role: "admin" }] }));
  assert.ok("error" in parseAccessDelta({}), "an empty delta is a mistake, not a no-op");
  assert.ok("error" in parseAccessDelta({ remove: [""] }));
});

test("an expiry must be a future instant, or nothing", () => {
  const hour = 60 * 60 * 1000;
  assert.deepEqual(parseExpiry(undefined), { value: null }, "absent clears it");
  assert.deepEqual(parseExpiry(null), { value: null });
  assert.deepEqual(parseExpiry(""), { value: null }, "an emptied form field clears it");

  const soon = Date.now() + hour;
  assert.deepEqual(parseExpiry(soon), { value: soon });

  // A past date is refused rather than applied. Accepting one would turn a typo
  // in a year into an immediate, silent takedown — and the way to take a
  // document down now is to make it private, which is reversible in a way an
  // accidental expiry is not.
  assert.ok("error" in parseExpiry(Date.now() - hour));
  assert.ok("error" in parseExpiry(Date.now()), "now is already too late");

  // Seconds pasted where milliseconds were meant reads as 1970; milliseconds
  // pasted where seconds were meant reads as the year 55000. Both are refused.
  assert.ok("error" in parseExpiry(Math.floor(Date.now() / 1000)));
  assert.ok("error" in parseExpiry(Date.now() * 1000));

  for (const bad of ["soon", {}, [], NaN, Infinity, true, 1.5]) {
    assert.ok("error" in parseExpiry(bad), JSON.stringify(String(bad)));
  }
});

test("body parsing accepts `email` as an alias for `principal`", () => {
  const parsed = parseAccessDelta({ add: [{ email: "a@example.com", role: "viewer" }] });
  assert.deepEqual(parsed.delta.add, [{ principal: "a@example.com", role: "viewer" }]);
});

// --- Expiry ----------------------------------------------------------------

test("an expiry reads from a number, a Timestamp, or nothing at all", () => {
  assert.equal(expiryMs({ expiresAt: 1700000000000 }), 1700000000000);
  assert.equal(expiryMs({ expiresAt: { toMillis: () => 1700000000000 } }), 1700000000000);
  assert.equal(expiryMs({}), null, "a document written before the field existed");
  assert.equal(expiryMs(null), null);
  assert.equal(expiryMs({ expiresAt: null }), null);
});

test("anything unreadable is NOT an expiry", () => {
  // The failure direction matters. A malformed value that read as "expired"
  // would take a document away from everyone but its owner, with no error
  // anywhere and nothing to point at. Unreadable means no expiry, always.
  for (const bad of ["soon", {}, [], NaN, Infinity, true, { toMillis: () => NaN }]) {
    assert.equal(expiryMs({ expiresAt: bad }), null, JSON.stringify(String(bad)));
    assert.equal(isExpired({ expiresAt: bad }, Date.now()), false);
  }
});

test("expiry is a moment, and the moment itself counts as expired", () => {
  const at = 1700000000000;
  assert.equal(isExpired({ expiresAt: at }, at - 1), false);
  assert.equal(isExpired({ expiresAt: at }, at), true, "at the stroke, it is over");
  assert.equal(isExpired({ expiresAt: at }, at + 1), true);
  assert.equal(isExpired({}, at), false, "no expiry never expires");
});

test("expiry is not part of canRead, and that is deliberate", () => {
  // canRead mirrors firestore.rules canRead, and the rules cannot carry a date:
  // the workspace list rule must be statically provable from the query, and a
  // query cannot filter on a field most documents do not have without dropping
  // every document that does not have it (SPEC §5). Expiry gates the CONTENT,
  // in the functions, on the one path every byte takes.
  const expired = {
    ownerEmail: "owner@example.com",
    ownerUid: "u-owner",
    members: ["owner@example.com", "ana@example.com"],
    expiresAt: 1,
  };
  assert.equal(canRead(expired, { uid: "u-ana", emailLower: "ana@example.com" }), true);
  assert.equal(isExpired(expired, Date.now()), true);
});

// --- Trust across versions ---------------------------------------------------

test("only the owner, editing in the app, keeps a document's trust in a new version", () => {
  // Trust is the owner vouching for the scripts they saw. A version anybody
  // else wrote, or one that arrived through a token, is content nobody vouched
  // for: on a trusted document with open editing, any account could otherwise
  // post a <script> to /draft, commit it, and run it in every reader's session.
  const d = doc({ trusted: true, visibility: "public", publicEdit: true });
  assert.equal(keepsTrust(d, { ...OWNER, channel: "web" }), true);
  assert.equal(keepsTrust(d, { ...EDITOR, channel: "web" }), false, "an editor is not the owner");
  assert.equal(keepsTrust(d, { ...STRANGER, channel: "web" }), false, "nor is open editing");
  for (const channel of ["cli", "mcp", "api"]) {
    assert.equal(keepsTrust(d, { ...OWNER, channel }), false, `a token update (${channel}) is an upload`);
  }
});
