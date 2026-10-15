// SPDX-License-Identifier: Apache-2.0
// Email (A23): invitations per kind, who a comment or suggestion notice reaches, plain-text bodies and links, cooldowns per kind, decision notes, a failing send, email off (SPEC §14).

/**
 * Every message here is read where a person would read it — Mailpit, behind
 * the stack's Resend shim — and matched on this spec's own recipients only.
 * Nothing drives a browser: a comment by a person is the rules-evaluated
 * Firestore writes the app's SDK makes (lib/web.mjs webThread / webReply:
 * createAnnotation then addComment as app/src/firestore.ts does, channel
 * "web"), an agent's goes through MCP, a suggestion through POST /suggestion.
 *
 *   A23.1  one invitation per new member: a document, a folder (the documents
 *          filed in it send none of their own), a team, a team granted on a
 *          document; a re-grant and a role change send nothing
 *   A23.2  a comment notice: the owner and the thread's participants, less
 *          the author, less anyone with no account record or opted out, never
 *          another thread's author; `<b>x</b>` literal in the text part and
 *          escaped in the HTML part; the link is /d/{doc}/{version}; an
 *          agent's says "via MCP"
 *   A23.2b a participant whose access was REMOVED is told nothing of later
 *          comments (the notice carries the passage and the comment): the
 *          X-a23-email-1 regression
 *   A23.3  a suggestion notice: the owner and every approver, less the author
 *   A23.4  cooldowns: per recipient and document, comments and suggestions
 *          apart; a second of either inside 30 min sends nothing
 *   A23.5  a decision (reject, accept, withdraw) is mailed as a comment
 *   A23.6  a send the provider refuses (shim 500) never fails the request
 *   A23.7  email off (its own stack, --email-off): nothing reaches the shim
 *          or Mailpit, each send is the product's logged no-op, and every
 *          operation still answers as it does with email on
 *
 * How a silence is shown. onCommentCreated (functions/src/index.ts) reads the
 * thread's comments ONCE, when it starts, and then decides its recipients one
 * by one, in a fixed order: the owner, the approvers for a new suggestion,
 * then the comment authors by comment id (the siblings query has no orderBy,
 * so Firestore returns them by document id). Each send is awaited, through the
 * shim into Mailpit, before the next recipient is decided. So:
 *   - a notice to W proves every recipient ordered before W was decided in
 *     that run, and any mail to them is already in Mailpit; this spec names
 *     the comment ids it writes, so the order is known;
 *   - a trigger's sibling set is fixed once any mail of its run has arrived;
 *     a later comment is written only after that, or it could join an
 *     earlier trigger's set when the stack is slow (seen on the shared
 *     stack: an earlier reply's trigger, run late, told a participant who
 *     had replied after it, and used up their cooldown).
 * Each case then holds every address it mailed to its exact subjects through
 * one 10 s settle at the end (mailbox.expectMailboxes).
 *
 * The invitation sends are awaited inside the request (setAccess,
 * setFolderAccess, manageTeamMembers), so the shim's record for a recipient
 * is final when the request answers: "a re-grant sends nothing" is read there.
 *
 * When the stack, not the product, failed to measure (lib/test.mjs,
 * `inconclusiveOnFunctionKill`): a request Hosting cut off at 60 s with its
 * own 504, or that http.mjs's deadline ended, and a notice that never came
 * while the emulator killed functions under load (a transaction lock timeout,
 * or its 60 s limit beside Hosting's 504s), end a case INCONCLUSIVE, never
 * PASS. A mailbox holding anything EXTRA is never excused, nor is any
 * assertion. A response this spec reads itself goes through `answered()`
 * first. A23.6 judges a cut-off on its own three requests by the send under
 * test: INCONCLUSIVE only when the refusal cannot have caused it (the
 * provider had not been asked for the send when the request was cut off);
 * FAIL otherwise.
 *
 * Cooldowns are 30 min (COMMENT_EMAIL_COOLDOWN_MS): every case makes its own
 * accounts and documents, so a rerun inside the window starts clean.
 *
 * Negative controls (e2e/patches/): controls-a23-cooldown (no window: A23.4
 * red), controls-a23-recipients (a participant with no users/{uid} mailed:
 * A23.2 red), controls-a23-plaintext (the body rendered as markup: A23.2 red).
 * A23.7 turns red on a --email-off stack built with controls-email-off.
 * A23.2b catches a recipient path that omits the current read-access check.
 * A23.6's judgement of an unanswered request was checked by mutating a copy:
 * a refusal recorded before the cut-off FAILS, a cut-off before the send is
 * INCONCLUSIVE; and a notice that never comes on a quiet stack FAILS.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { answered, currentTarget, isHostingCutoff, precondition, scenario } from "../../lib/test.mjs";
import { cast, castUnverified, localEmail, rand4, runTag } from "../../lib/accounts.mjs";
import { idToken, mintToken, openSession } from "../../lib/session.mjs";
import { createFolder, createTeam, publish, readFixture, updateUpload } from "../../lib/seed.mjs";
import { shareFolder, shareMany, teamMembers, unshare } from "../../lib/grant.mjs";
import { closeAdmin, readDoc } from "../../lib/admin.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { logMark, waitForLog } from "../../lib/logs.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { shimControl } from "../../lib/mail/shimctl.mjs";
import { anchorIn as anchorInText, webReply, webThread as webThreadAt } from "../../lib/web.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const LOCAL = ["local"];
/** A trigger's notice on a shared, loaded stack: functions were seen taking 40–50 s each there. */
const TRIGGER_MS = 180_000;
/** The emulator's log flushes late: a line has appeared > 30 s after its request. */
const LOG_MS = 120_000;
/** http.mjs's own deadline running out: an answer of nothing (A23.6 judges it). */
const CLIENT_TIMEOUT = /^timeout after \d+ ms$/;
/**
 * The mailing requests wait past Hosting's own 60 s cut-off, so its 504 (or
 * the answer of a function that finished at 59 s) is what a case sees, not
 * http.mjs giving up first. Measured on the shared stack: POST /access 20–45 s,
 * POST /folder-access up to 39 s and once past 60 s.
 */
const SLOW = { timeoutMs: 120_000 };

const tag = () => `${runTag(target.runId)}-${rand4()}`;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sharedSubject = (inviter, title) => `${inviter} shared “${title}” with you`;
const commentedSubject = (author, title) => `${author} commented on “${title}”`;
const suggestedSubject = (author, title) => `${author} suggested an edit to “${title}”`;
const COMMENTED = / commented on “/;
const SUGGESTED = / suggested an edit to “/;

/** The paragraphs of crdt-paragraphs.html by id, as their textContent. */
const PARAGRAPHS = (() => {
  const html = String(readFixture("crdt-paragraphs.html", { raw: true }));
  const out = new Map();
  for (const m of html.matchAll(/<p id="(e2e-\d+)">([^<]*)<\/p>/g)) out.set(m[1], m[2]);
  return out;
})();

/** An anchor for `exact` inside paragraph `elementId` of crdt-paragraphs.html, as the app measures it (lib/web.mjs). */
const anchorIn = (elementId, exact) => anchorInText(PARAGRAPHS.get(elementId) ?? "", elementId, exact);

// --- Setup helpers ------------------------------------------------------------------

/** Cast `roles` and open a session for each (a session writes users/{uid}). */
async function people(roles, o = {}) {
  const accts = await cast(target, roles, o);
  const sessions = await Promise.all(accts.map((a) => openSession(target, a)));
  return Object.fromEntries(roles.map((r, i) => [r, sessions[i]]));
}

/** A new document owned by `owner` (a session); returns its id. publish() expects 200, so a cut-off throws as the lib judges it. */
async function newDoc(owner, name, title, o = {}) {
  const up = await publish(owner.http, { fixture: o.fixture ?? "crdt-paragraphs.html", title, name, folderId: o.folderId, ...SLOW });
  precondition(up.docId, `POST /publish ${name}: ${up.status} ${JSON.stringify(up.json)}`);
  return up.docId;
}

/**
 * POST /access as the owner with several grants in ONE request (shareMany:
 * separate concurrent grants would race, S18), each `{account | team, role}`.
 * Each new member is sent one invitation inside the request. The response,
 * whatever its status: the caller judges it (A23.6 judges a cut-off itself).
 * The RTDB mirrors are a13's to check, not this spec's.
 */
async function access(owner, docId, grants) {
  const r = await shareMany(target, { owner, doc: docId, grants, verify: false, expect: null, ...SLOW });
  return r.response;
}

/** `access` that must answer 200 with every grantee a member: setup, not the thing under test. */
async function shareAll(owner, docId, grants) {
  const r = await shareMany(target, { owner, doc: docId, grants, verify: false, ...SLOW });
  const missing = r.principals.filter((p) => !r.members?.includes(p));
  precondition(missing.length === 0, `POST /access ${grants.length} grant(s): not members afterwards: ${missing.join(", ")}`);
}

/** A folder the owner owns (createFolder, ledgered, expects 200); returns its id. */
async function newFolder(owner, name) {
  const r = await createFolder(owner.http, { name, ownerEmail: owner.account.email, ...SLOW });
  precondition(typeof r.folderId === "string", `POST /folder: ${r.status} ${r.response.text.slice(0, 200)}`);
  return r.folderId;
}

/** A team the owner owns (createTeam, ledgered, expects 200); returns its id. */
async function newTeam(owner, name) {
  const r = await createTeam(owner.http, { name, ownerEmail: owner.account.email, ...SLOW });
  precondition(typeof r.teamId === "string", `POST /team: ${r.status} ${r.response.text.slice(0, 200)}`);
  return r.teamId;
}

/** POST /folder-access adding one principal (shareFolder, ledgered): the response, whatever its status. */
async function folderGrant(owner, folderId, email, role = "viewer") {
  const r = await shareFolder(target, { owner, folder: folderId, account: email, role, expect: null, ...SLOW });
  return r.response;
}

/** POST /team-members adding `emails` (teamMembers): the response, whatever its status. */
async function teamAdd(owner, teamId, emails) {
  const r = await teamMembers(owner.http, teamId, { add: emails, expect: null, ...SLOW });
  return r.response;
}

/** An MCP client for `session`'s account, through a freshly minted mcp token. */
async function agentOf(ctx, session, label) {
  const { token } = await mintToken(session, { name: `e2e a23 ${label} ${tag()}`, channel: "mcp" });
  const m = ctx.mcp({ token, actor: `${label}-mcp` });
  await m.initialize();
  return m;
}

/** A rules-evaluated Firestore client for an account, as the app's SDK (channel "web"). */
async function webClient(ctx, acct) {
  const http = ctx.http({ actor: `${acct.role}-firestore` });
  return clientFirestore(target, { idToken: await idToken(target, acct, { http }), http });
}

/**
 * Open a thread as the app does, createAnnotation then addComment (lib/web.mjs
 * webThread: the app's own writes, through the rules), on a passage named by
 * paragraph and text. Replies are lib/web.mjs webReply. This spec names the
 * comment ids, which fix the order a trigger decides its recipients in.
 */
const webThread = (fs, acct, { elementId, exact, ...o }) => webThreadAt(fs, acct, { ...o, anchor: anchorIn(elementId, exact) });

/** POST /suggestion {op: create} as a session (channel "web"); returns the annId. */
async function webSuggest(session, { docId, versionId = "v1", elementId, exact, replacement, note }) {
  const r = answered(await session.http.postJson("/suggestion", { op: "create", docId, versionId, anchor: anchorIn(elementId, exact), replacement, ...(note ? { note } : {}) }, SLOW), "POST /suggestion create");
  precondition(r.status === 200 && typeof r.json?.annId === "string", `${session.account.role}'s POST /suggestion: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.annId;
}

/** Ids that sort in the order given: k = 1, 2, 3 … (Firestore orders a query with no orderBy by document id). */
const idsFor = (prefix) => {
  const salt = `${rand4()}${rand4()}`;
  return (k) => `${prefix}-${k}-${salt}`;
};

// --- Reading mail ---------------------------------------------------------------

/** A message's text part as lines (CRLF folded). */
const linesOf = (msg) => String(msg?.Text ?? "").replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd());
const htmlOf = (msg) => String(msg?.HTML ?? "");

/**
 * The newest message with exactly this subject to `to`, once it has arrived
 * (mailbox.waitFor: no settle; the case's final expectMailboxes holds the
 * counts), with how long it took in steps.md. Waiting on one subject is how a
 * case knows a trigger has run.
 */
async function arrived(ctx, box, to, subject) {
  const t0 = Date.now();
  const m = await box.waitFor({ to, subject, timeout: TRIGGER_MS });
  ctx.step(`  arrived after ${Date.now() - t0} ms: ${subject} → ${to}`);
  return m;
}

/** The subjects of the messages to `to` that match `subject` now, sorted (no waiting). */
async function subjectsTo(box, to, subject = null) {
  return (await box.find({ to, subject })).map((m) => m.Subject).sort();
}

/** Every address's whole mailbox is exactly these subjects, through one 10 s settle (mailbox.expectMailboxes). */
const settleAll = (box, expected) => box.expectMailboxes(expected, { timeout: TRIGGER_MS });

// --- A23.1 ----------------------------------------------------------------------

scenario("A23.1 one invitation per new member for a document, a folder and a team, each with the subject \"<inviter> shared “<title>” with you\", its kind in the text and its own link; a team granted on a document invites its members to that document; filing, a re-grant and a role change send nothing", {
  tiers: LOCAL,
  effects: ["email:POST /access", "email:POST /folder-access", "email:POST /team-members"],
  needs: ["email", "mailpit", "mail-fail-recipient"],
  timeoutMs: 900_000,
  inconclusiveOnFunctionKill: true,
}, async (ctx) => {
  const t = tag();
  const { owner: O } = await people(["owner"]);
  const me = O.account.email;
  const origin = target.origin;
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const shim = shimControl(target, { http: ctx.http({ actor: "shim" }) });
  /** What the shim received for `to`: [subject, status] per send, oldest first. */
  const sends = async (to) => (await shim.requests({ to })).map((r) => [r.subject, r.status]);
  const [iEdit, iView, iFolder, iTeam, iLate] = ["invedit", "invview", "invfolder", "invteam", "invlate"].map((r) => localEmail(target, r));

  ctx.step("a document: the owner adds two new addresses in one POST /access, one as an editor and one as a viewer");
  const title = `A23.1 document ${t}`;
  const docId = await newDoc(O, "a231-doc", title);
  const added = answered(await access(O, docId, [{ account: iEdit, role: "editor" }, { account: iView, role: "viewer" }]), "POST /access");
  assert.equal(added.status, 200, `POST /access: ${added.text.slice(0, 200)}`);
  assert.ok(added.json.members.includes(iEdit) && added.json.members.includes(iView), `members: ${JSON.stringify(added.json.members)}`);
  assert.deepEqual(await sends(iEdit), [[sharedSubject(me, title), 200]], "one invitation to the new editor, sent before POST /access answered");
  assert.deepEqual(await sends(iView), [[sharedSubject(me, title), 200]], "one invitation to the new viewer");

  ctx.step("re-grant: the same add again, then a role change (viewer → editor): both 200, and neither sends anything");
  const again = answered(await access(O, docId, [{ account: iEdit, role: "editor" }]), "the repeated POST /access");
  assert.equal(again.status, 200, `the repeated add: ${again.text.slice(0, 200)}`);
  const promoted = answered(await access(O, docId, [{ account: iView, role: "editor" }]), "the role change's POST /access");
  assert.equal(promoted.status, 200, `the role change: ${promoted.text.slice(0, 200)}`);
  assert.ok(promoted.json.editors.includes(iView), `the role change was stored: editors ${JSON.stringify(promoted.json.editors)}`);
  assert.equal((await sends(iEdit)).length, 1, "a re-grant of the same role sent another invitation");
  assert.equal((await sends(iView)).length, 1, "a role change sent another invitation");

  ctx.step("each says what the role allows, names the kind and links to /d/<doc>");
  const [mEdit, mView] = await Promise.all([arrived(ctx, box, iEdit, sharedSubject(me, title)), arrived(ctx, box, iView, sharedSubject(me, title))]);
  for (const [m, can] of [[mEdit, "edit"], [mView, "read"]]) {
    const lines = linesOf(m);
    assert.ok(lines.includes(`${me} shared "${title}" with you on Bikeshed.`), `the text part names the document: ${JSON.stringify(lines)}`);
    assert.ok(lines.includes(`You can now ${can} it. Open it here:`), `the text part says what the role allows (${can}): ${JSON.stringify(lines)}`);
    assert.ok(lines.includes(`${origin}/d/${docId}`), `the text part links to the document on this origin: ${JSON.stringify(lines)}`);
    assert.ok(htmlOf(m).includes(`${can} the document &quot;${title}&quot;`), "the HTML part names the kind: the document");
    assert.ok(htmlOf(m).includes(`href="${origin}/d/${docId}"`), "the HTML part's button links to the document");
    assert.ok(!htmlOf(m).includes("everything shared with the team"), "a document invitation says nothing about a team");
  }

  ctx.step("a folder holding a filed document: the owner shares the folder with a new address; one invitation, the folder's, and none for the document filed in it; a re-grant sends nothing");
  const fname = `A23.1 folder ${t}`;
  const folderId = await newFolder(O, fname);
  const filed = await newDoc(O, "a231-filed", `A23.1 filed ${t}`, { folderId });
  const fshare = answered(await folderGrant(O, folderId, iFolder), "POST /folder-access");
  assert.equal(fshare.status, 200, `POST /folder-access: ${fshare.text.slice(0, 200)}`);
  assert.ok((await readDoc(target, `docs/${filed}`)).members.includes(iFolder), "the filed document reached the folder's new reader");
  assert.deepEqual(await sends(iFolder), [[sharedSubject(me, fname), 200]], "one invitation, the folder's: the filed document sends none of its own");
  const fagain = answered(await folderGrant(O, folderId, iFolder), "the repeated POST /folder-access");
  assert.equal(fagain.status, 200, `the folder re-grant: ${fagain.text.slice(0, 200)}`);
  assert.equal((await sends(iFolder)).length, 1, "a folder re-grant sent another invitation");
  const mFolder = await arrived(ctx, box, iFolder, sharedSubject(me, fname));
  const fl = linesOf(mFolder);
  assert.ok(fl.includes(`${me} shared "${fname}" with you on Bikeshed.`), `the folder invitation's text: ${JSON.stringify(fl)}`);
  assert.ok(fl.includes("You can now read it. Open it here:"), `a folder viewer can read: ${JSON.stringify(fl)}`);
  assert.ok(fl.includes(`${origin}/folder/${folderId}`), `the folder invitation links to /folder/<id>: ${JSON.stringify(fl)}`);
  assert.ok(htmlOf(mFolder).includes(`read the folder &quot;${fname}&quot;`), "the HTML part names the kind: the folder");

  ctx.step("a team: the owner adds a new address to a team; one invitation naming the team and linking to /account; adding them again sends nothing");
  const tname = `A23.1 team ${t}`;
  const teamId = await newTeam(O, tname);
  const tadd = answered(await teamAdd(O, teamId, [iTeam]), "POST /team-members");
  assert.equal(tadd.status, 200, `POST /team-members: ${tadd.text.slice(0, 200)}`);
  assert.ok(tadd.json.members.includes(iTeam), `team members: ${JSON.stringify(tadd.json.members)}`);
  assert.deepEqual(await sends(iTeam), [[sharedSubject(me, tname), 200]], "one team invitation");
  const tagain = answered(await teamAdd(O, teamId, [iTeam]), "the repeated POST /team-members");
  assert.equal(tagain.status, 200, `the repeated team add: ${tagain.text.slice(0, 200)}`);
  assert.equal((await sends(iTeam)).length, 1, "re-adding a team member sent another invitation");
  const mTeam = await arrived(ctx, box, iTeam, sharedSubject(me, tname));
  const tl = linesOf(mTeam);
  assert.ok(tl.includes(`${me} shared the ${tname} team with you on Bikeshed.`), `the team invitation's text: ${JSON.stringify(tl)}`);
  assert.ok(tl.includes("You can now read it. Open it here:"), `a team member can read: ${JSON.stringify(tl)}`);
  assert.ok(tl.includes(`${origin}/account`), `the team invitation links to /account: ${JSON.stringify(tl)}`);
  assert.ok(htmlOf(mTeam).includes(`read the ${tname} team`), "the HTML part names the kind: the team");
  assert.ok(htmlOf(mTeam).includes("That includes everything shared with the team, now and later."), "the team branch of the template");

  ctx.step("the team granted on a new document: its member gains access and gets that document's invitation; a member added to the team afterwards gets the team's invitation only");
  const t2 = `A23.1 team document ${t}`;
  const doc2 = await newDoc(O, "a231-teamdoc", t2);
  const granted = answered(await access(O, doc2, [{ team: teamId, role: "viewer" }]), "POST /access for the team");
  assert.equal(granted.status, 200, `POST /access team: ${granted.text.slice(0, 200)}`);
  assert.ok(granted.json.members.includes(iTeam), `the team's member is a member of the document: ${JSON.stringify(granted.json.members)}`);
  assert.deepEqual(await sends(iTeam), [[sharedSubject(me, tname), 200], [sharedSubject(me, t2), 200]], "the team grant invited the team's member to the document, once");
  const late = answered(await teamAdd(O, teamId, [iLate]), "the late POST /team-members");
  assert.equal(late.status, 200, `the late team add: ${late.text.slice(0, 200)}`);
  assert.ok((await readDoc(target, `docs/${doc2}`)).members.includes(iLate), "the late member reached the team's document");
  assert.deepEqual(await sends(iLate), [[sharedSubject(me, tname), 200]], "the late member: the team's invitation, and nothing for the document it reaches through the team");
  const teamDocMail = await arrived(ctx, box, iTeam, sharedSubject(me, t2));
  assert.ok(linesOf(teamDocMail).includes(`${origin}/d/${doc2}`), "the team member's document invitation links to the document");

  ctx.step("held 10 s: every mailbox is exactly its invitations, and the owner, who did the sharing, has none");
  await settleAll(box, {
    [iEdit]: [sharedSubject(me, title)],
    [iView]: [sharedSubject(me, title)],
    [iFolder]: [sharedSubject(me, fname)],
    [iTeam]: [sharedSubject(me, tname), sharedSubject(me, t2)],
    [iLate]: [sharedSubject(me, tname)],
    [me]: [],
  });
});

// --- A23.2 ----------------------------------------------------------------------

scenario("A23.2 a comment notice reaches the owner and the thread's participants, less its author, anyone with no account record, anyone opted out and other threads' authors; the text part carries <b>x</b> literally and the HTML part escapes it; it links to /d/<doc>/<version>; an agent's says via MCP", {
  tiers: LOCAL,
  effects: ["email:POST /access", "email:comment"],
  needs: ["email", "mailpit"],
  timeoutMs: 900_000,
  inconclusiveOnFunctionKill: true,
}, async (ctx) => {
  const t = tag();
  ctx.step("cast: the owner O, a witness W, a replier K (also an agent), another thread's author Q, P2 with no account record (an ID token, never a session) and P3, opted out");
  const { owner: O, witness: W, replier: K, other: Q } = await people(["owner", "witness", "replier", "other"]);
  const [P2] = await cast(target, ["norecord"]);
  const [P3] = await cast(target, ["optedout"], { notifications: false });
  const me = O.account.email;
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });

  // D: P2's thread, at v2 so the link names a version that is not v1. D3: P3's thread. D2: the agent's.
  const title = `A23.2 no record ${t}`;
  const title3 = `A23.2 opted out ${t}`;
  const title2 = `A23.2 agent ${t}`;
  // One request at a time: a warm function worker answers faster than several cold ones on a loaded stack.
  const docId = await newDoc(O, "a232-norecord", title, { fixture: "foreign-marker.html" });
  const doc3 = await newDoc(O, "a232-optout", title3);
  const doc2 = await newDoc(O, "a232-agent", title2);
  const v2 = await updateUpload(O.http, docId, { fixture: "crdt-paragraphs.html", baseVersion: "v1", expect: 200, ...SLOW });
  precondition(v2.json?.versionId === "v2", `the second version: ${v2.status} ${v2.response.text.slice(0, 200)}`);
  await shareAll(O, docId, [{ account: P2 }, { account: W.account }, { account: K.account }, { account: Q.account }]);
  await shareAll(O, doc3, [{ account: P3 }, { account: W.account }, { account: K.account }]);
  await shareAll(O, doc2, [{ account: K.account }]);
  const [fs2, fs3, fsW, fsK, fsQ] = await Promise.all([P2, P3, W.account, K.account, Q.account].map((a) => webClient(ctx, a)));
  precondition((await readDoc(target, `users/${P2.uid}`)) === null, "P2 has no users/{uid} record");
  precondition((await readDoc(target, `users/${P3.uid}`))?.emailNotifications === false, "P3 is opted out");

  // Comment ids fix the order a trigger decides the participants in: the opener (1), W (2), K (3).
  const id = idsFor("a232");
  const annA = `a232a${rand4()}${rand4()}`;
  const annB = `a232b${rand4()}${rand4()}`;
  const QUOTE = "Estuary quill lantern walnut";
  const QUOTE3 = "Thistle hollow thistle ochre";
  const opening = `A23.2 opening ${t}`;
  const agentBody = `A23.2 <b>x</b> & "agent" ${t}`;

  ctx.step(`P2 opens a thread on D's v2 (web) on "${QUOTE}"; P3 opens one on D3; the agent opens one on D2 through MCP with ${JSON.stringify(agentBody)}; the owner gets each notice`);
  const mcp = await agentOf(ctx, K, "replier");
  await Promise.all([
    webThread(fs2, P2, { docId, versionId: "v2", elementId: "e2e-4", exact: QUOTE, body: opening, annId: annA, commentId: id(1) }),
    webThread(fs3, P3, { docId: doc3, versionId: "v1", elementId: "e2e-4", exact: QUOTE3, body: `A23.2 opening D3 ${t}`, annId: annB, commentId: id(1) }),
    mcp.ok("add_comment", { id: doc2, exact: "Russet orchard harbor glacier", body: agentBody }),
  ]);
  const [m1, , m2] = await Promise.all([
    arrived(ctx, box, me, commentedSubject(P2.email, title)),
    arrived(ctx, box, me, commentedSubject(P3.email, title3)),
    arrived(ctx, box, me, commentedSubject(K.account.email, title2)),
  ]);

  ctx.step("a web comment's notice: no via marker, the quote, the comment, and a link to /d/<doc>/<version>");
  const l1 = linesOf(m1);
  assert.equal(l1[0], `${P2.email} commented on "${title}".`, "a web comment's notice carries no via marker");
  assert.ok(l1.includes(`On: "${QUOTE}"`), `the notice quotes the passage: ${JSON.stringify(l1)}`);
  assert.ok(l1.includes(opening), `the notice carries the comment: ${JSON.stringify(l1)}`);
  assert.ok(l1.includes(`Reply in context: ${target.origin}/d/${docId}/v2`), `the link is /d/<doc>/<version>: ${JSON.stringify(l1)}`);
  assert.ok(htmlOf(m1).includes(`href="${target.origin}/d/${docId}/v2"`), "the HTML button links to /d/<doc>/<version>");
  assert.ok(!/Posted via/.test(htmlOf(m1)), "a web comment's HTML carries no via line");

  ctx.step("an agent's notice: via MCP in both parts, <b>x</b> literal in the text part and escaped in the HTML part");
  const l2 = linesOf(m2);
  assert.equal(l2[0], `${K.account.email} commented on "${title2}" (via MCP).`, "an agent's notice says via MCP");
  assert.match(htmlOf(m2), /Posted via (?:<!-- -->)?MCP(?:<!-- -->)? — this comment came from\s+automation/, "and so does its HTML part");
  assert.ok(l2.includes(agentBody), `the text part carries the body literally, <b>x</b> included: ${JSON.stringify(l2)}`);
  assert.ok(!htmlOf(m2).includes("<b>x</b>"), "the HTML part carries <b>x</b> as markup: a comment body was rendered as HTML");
  assert.ok(htmlOf(m2).includes("&lt;b&gt;x&lt;/b&gt;"), "the HTML part shows <b>x</b> escaped, as text");
  assert.ok(l2.includes(`Reply in context: ${target.origin}/d/${doc2}/v1`), `the agent's notice links to /d/<doc>/<version>: ${JSON.stringify(l2)}`);

  ctx.step("Q opens another thread on D; W, then K reply in P2's thread on D and in P3's on D3");
  await webThread(fsQ, Q.account, { docId, versionId: "v2", elementId: "e2e-5", exact: "Quill orchard russet yarrow", body: `A23.2 elsewhere ${t}`, annId: `a232q${rand4()}${rand4()}`, commentId: id(0) });
  await Promise.all([
    webReply(fsW, W.account, { docId, versionId: "v2", annId: annA, commentId: id(2), body: `A23.2 W on D ${t}` }),
    webReply(fsW, W.account, { docId: doc3, versionId: "v1", annId: annB, commentId: id(2), body: `A23.2 W on D3 ${t}` }),
  ]);
  await Promise.all([
    webReply(fsK, K.account, { docId, versionId: "v2", annId: annA, commentId: id(3), body: `A23.2 K on D ${t}` }),
    webReply(fsK, K.account, { docId: doc3, versionId: "v1", annId: annB, commentId: id(3), body: `A23.2 K on D3 ${t}` }),
  ]);

  ctx.step("K's replies reach W, the participant decided after the opener: on D after P2 (no record), on D3 after P3 (opted out); neither opener was sent a notice");
  await Promise.all([
    arrived(ctx, box, W.account.email, commentedSubject(K.account.email, title)),
    arrived(ctx, box, W.account.email, commentedSubject(K.account.email, title3)),
  ]);
  assert.deepEqual(await subjectsTo(box, P2.email, COMMENTED), [], "a participant with no users/{uid} record was sent a comment notice");
  assert.deepEqual(await subjectsTo(box, P3.email, COMMENTED), [], "an opted-out participant was sent a comment notice");

  ctx.step("held 10 s: every mailbox is exactly its invitations and these notices; the author of a comment is never told of it; Q, in another thread, is told nothing");
  await settleAll(box, {
    [me]: [commentedSubject(P2.email, title), commentedSubject(P3.email, title3), commentedSubject(K.account.email, title2)],
    [P2.email]: [sharedSubject(me, title)],
    [P3.email]: [sharedSubject(me, title3)],
    [W.account.email]: [sharedSubject(me, title), sharedSubject(me, title3), commentedSubject(K.account.email, title), commentedSubject(K.account.email, title3)],
    [Q.account.email]: [sharedSubject(me, title)],
  });
  // K may be told of W's reply when W's trigger runs after K replied (it reads the thread when it starts): never of K's own.
  const kOwn = (await subjectsTo(box, K.account.email, COMMENTED)).filter((s) => s.startsWith(`${K.account.email} commented on`));
  assert.deepEqual(kOwn, [], "the author was sent a notice of their own comment");
  assert.equal(await readDoc(target, `users/${P2.uid}`), null, "nothing created a record for P2");
  assert.equal((await readDoc(target, `users/${P3.uid}`))?.emailCooldowns, undefined, "no cooldown was claimed for the opted-out P3");
});

// --- A23.2b ---------------------------------------------------------------------

/** Notices carry private content, so a former participant must still be able to read it (SPEC §14, §17). */
scenario("A23.2b a participant whose access to the document was removed is told nothing of later comments in their thread (a notice carries the passage and the comment)", {
  tiers: LOCAL,
  effects: ["email:POST /access", "email:comment"],
  needs: ["email", "mailpit"],
  timeoutMs: 600_000,
  inconclusiveOnFunctionKill: true,
}, async (ctx) => {
  const t = tag();
  const { owner: O, removed: R, witness: V, replier: K } = await people(["owner", "removed", "witness", "replier"]);
  const title = `A23.2b revoked ${t}`;
  const docId = await newDoc(O, "a232b-revoked", title);
  await shareAll(O, docId, [{ account: R.account }, { account: V.account }, { account: K.account }]);
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const [fsR, fsV, fsK] = await Promise.all([R, V, K].map((s) => webClient(ctx, s.account)));
  const ann = `a232r${rand4()}${rand4()}`;
  const id = idsFor("a232r");
  const QUOTE = "Glacier yarrow anchor delta";
  const later = [`A23.2b V after R left ${t}`, `A23.2b K after R left ${t}`];

  ctx.step("R opens a thread; the owner gets the notice (and so is in the cooldown from here)");
  await webThread(fsR, R.account, { docId, versionId: "v1", elementId: "e2e-6", exact: QUOTE, body: `A23.2b opening ${t}`, annId: ann, commentId: id(1) });
  await arrived(ctx, box, O.account.email, commentedSubject(R.account.email, title));
  const content = `/content/${encodeURIComponent(docId)}/v1/index.html`;
  const before = answered(await R.http.get(content, SLOW), "R's GET of the document");
  precondition(before.status === 200, `R can read the document while a member: ${before.status} ${before.text.slice(0, 120)}`);

  ctx.step("the owner removes R from the document; R can no longer read it");
  await unshare(target, { owner: O, doc: docId, account: R.account, ...SLOW }); // expects 200, and throws otherwise
  precondition(!(await readDoc(target, `docs/${docId}`)).members.includes(R.account.email), "R is no longer a member");
  const probe = answered(await R.http.get(content, SLOW), "R's GET of the document after removal");
  precondition(probe.status === 404, `R's read of the document after removal: ${probe.status} ${probe.text.slice(0, 120)}`);

  ctx.step("V replies, then K; K's notice reaches V, whom the trigger decides after R");
  await webReply(fsV, V.account, { docId, versionId: "v1", annId: ann, commentId: id(2), body: later[0] });
  await webReply(fsK, K.account, { docId, versionId: "v1", annId: ann, commentId: id(3), body: later[1] });
  await arrived(ctx, box, V.account.email, commentedSubject(K.account.email, title));

  ctx.step("held 10 s: R, who can no longer read the document, was sent none of what was said after they left");
  await box.expectMail({ to: R.account.email, subject: COMMENTED, count: 0 }).catch(() => undefined);
  const leaked = [];
  for (const m of await box.find({ to: R.account.email, subject: COMMENTED })) {
    const text = String((await box.message(m.ID)).Text);
    leaked.push({ subject: m.Subject, quotesThePassage: text.includes(QUOTE), carriesALaterComment: later.some((b) => text.includes(b)) });
  }
  ctx.ev.json("removed-participant-mail", leaked);
  assert.deepEqual(leaked, [], "a removed reader receives no later comments or quoted document bytes");
});

// --- A23.3 ----------------------------------------------------------------------

scenario("A23.3 a suggestion notice reaches the owner and every approver, less its author: not an editor, a viewer or the suggester; it shows the quote, the replacement and the author's note, never a generated restatement", {
  tiers: LOCAL,
  effects: ["email:POST /access", "email:suggestion"],
  needs: ["email", "mailpit"],
  timeoutMs: 600_000,
  inconclusiveOnFunctionKill: true,
}, async (ctx) => {
  const t = tag();
  const { owner: O, approver1: AP1, approver2: AP2, editor: E, viewer: V, suggester: S } = await people(["owner", "approver1", "approver2", "editor", "viewer", "suggester"]);
  const me = O.account.email;
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const title = `A23.3 suggestion ${t}`;
  const t2 = `A23.3 approver suggests ${t}`;
  const docId = await newDoc(O, "a233-suggest", title);
  const doc2 = await newDoc(O, "a233-approver", t2);
  await shareAll(O, docId, [{ account: AP1.account, role: "approver" }, { account: AP2.account, role: "approver" }, { account: E.account, role: "editor" }, { account: V.account }, { account: S.account, role: "suggester" }]);
  await shareAll(O, doc2, [{ account: AP1.account, role: "approver" }, { account: AP2.account, role: "approver" }]);

  const QUOTE = "Russet pepper slate quill";
  const replacement = "Russet pepper granite quill";
  const note = `A23.3 because granite ${t}`;
  const DEL = "Basil walnut quarry jasper";
  ctx.step(`the suggester suggests "${QUOTE}" → "${replacement}" with a note (POST /suggestion, web); on a second document an approver suggests deleting "${DEL}" through MCP, with no note`);
  const mcp = await agentOf(ctx, AP1, "approver1");
  const [, made] = await Promise.all([
    webSuggest(S, { docId, elementId: "e2e-9", exact: QUOTE, replacement, note }),
    mcp.ok("suggest_edit", { id: doc2, exact: DEL, replacement: "" }),
  ]);
  precondition(typeof made?.threadId === "string", `suggest_edit: ${JSON.stringify(made)}`);

  ctx.step("the owner and both approvers are told of the suggester's: the quote, the replacement, the note and a link to /d/<doc>/v1");
  const subject = suggestedSubject(S.account.email, title);
  const subject2 = suggestedSubject(AP1.account.email, t2);
  const [got, got2] = await Promise.all([
    Promise.all([O, AP1, AP2].map((s) => arrived(ctx, box, s.account.email, subject))),
    Promise.all([O, AP2].map((s) => arrived(ctx, box, s.account.email, subject2))),
  ]);
  for (const m of got) {
    const l = linesOf(m);
    assert.equal(l[0], `${S.account.email} suggested an edit to "${title}".`);
    assert.ok(l.includes(`On: "${QUOTE}"`), `the quote: ${JSON.stringify(l)}`);
    assert.ok(l.includes(`Suggested replacement: ${replacement}`), `the replacement: ${JSON.stringify(l)}`);
    assert.ok(l.includes(note), `the author's note: ${JSON.stringify(l)}`);
    assert.ok(l.includes(`Review it in context: ${target.origin}/d/${docId}/v1`), `the link: ${JSON.stringify(l)}`);
    assert.ok(htmlOf(m).includes("You received this because you can accept or reject edits to this document."), "the suggestion branch's footnote");
  }

  ctx.step("the approver's deletion: the owner and the other approver are told, via MCP, with no generated restatement as its body");
  for (const m of got2) {
    const l = linesOf(m);
    assert.equal(l[0], `${AP1.account.email} suggested an edit to "${t2}" (via MCP).`);
    assert.ok(l.includes(`On: "${DEL}"`), `the quote: ${JSON.stringify(l)}`);
    assert.ok(l.includes("Suggested: delete this."), `a deletion says so: ${JSON.stringify(l)}`);
    assert.ok(!l.some((x) => x.startsWith("Suggested deleting")), `the generated opener is not repeated as a body: ${JSON.stringify(l)}`);
  }

  ctx.step("held 10 s: an editor, a viewer and the suggester are told nothing; the approver who suggested is not told of their own suggestion");
  await settleAll(box, {
    [me]: [subject, subject2],
    [AP1.account.email]: [sharedSubject(me, title), sharedSubject(me, t2), subject],
    [AP2.account.email]: [sharedSubject(me, title), sharedSubject(me, t2), subject, subject2],
    [E.account.email]: [sharedSubject(me, title)],
    [V.account.email]: [sharedSubject(me, title)],
    [S.account.email]: [sharedSubject(me, title)],
  });
});

// --- A23.4 ----------------------------------------------------------------------

scenario("A23.4 cooldowns: a second comment on a document within 30 min sends the owner nothing; a suggestion right after a comment is still sent; a second suggestion within 30 min is not; a comment on a different document is", {
  tiers: LOCAL,
  effects: ["email:POST /access", "email:comment", "email:suggestion"],
  needs: ["email", "mailpit"],
  timeoutMs: 600_000,
  inconclusiveOnFunctionKill: true,
}, async (ctx) => {
  const t = tag();
  const { owner: O, commenter: C, witness: W, approver: AP } = await people(["owner", "commenter", "witness", "approver"]);
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const t1 = `A23.4 first ${t}`;
  const t2 = `A23.4 second ${t}`;
  const d1 = await newDoc(O, "a234-one", t1);
  const d2 = await newDoc(O, "a234-two", t2);
  await shareAll(O, d1, [{ account: C.account, role: "suggester" }, { account: W.account }]);
  await shareAll(O, d2, [{ account: C.account, role: "suggester" }]);
  const [fsC, fsW] = await Promise.all([webClient(ctx, C.account), webClient(ctx, W.account)]);
  const me = O.account.email;
  const ann = `a234${rand4()}${rand4()}`;
  const id = idsFor("a234");

  ctx.step("the commenter opens a thread on the first document: the owner gets one comment notice");
  await webThread(fsC, C.account, { docId: d1, versionId: "v1", elementId: "e2e-7", exact: "Garnet delta orchard hollow", body: `A23.4 first comment ${t}`, annId: ann, commentId: id(1) });
  await arrived(ctx, box, me, commentedSubject(C.account.email, t1));
  const claimed = (await readDoc(target, `users/${O.uid}`))?.emailCooldowns?.[d1];
  precondition(typeof claimed === "number", "the owner's cooldown for the first document was claimed");

  ctx.step("within the window, the witness replies: the commenter (decided after the owner) is told, the owner is not");
  await webReply(fsW, W.account, { docId: d1, versionId: "v1", annId: ann, commentId: id(2), body: `A23.4 second comment ${t}` });
  await arrived(ctx, box, C.account.email, commentedSubject(W.account.email, t1));
  assert.deepEqual(await subjectsTo(box, me, COMMENTED), [commentedSubject(C.account.email, t1)], "a second comment within 30 min sent the owner another notice");
  assert.equal((await readDoc(target, `users/${O.uid}`))?.emailCooldowns?.[d1], claimed, "the skipped notice left the owner's cooldown as it was");

  ctx.step("right after the comment, the commenter suggests an edit on the same document: the owner IS told (suggestions have a cooldown of their own)");
  await webSuggest(C, { docId: d1, elementId: "e2e-8", exact: "Basil walnut quarry jasper", replacement: "Basil walnut quarry agate" });
  await arrived(ctx, box, me, suggestedSubject(C.account.email, t1));

  ctx.step("an approver joins (after that notice, so the first suggestion's trigger read the approvers before them); the commenter suggests again within 30 min: the approver (decided after the owner) is told, the owner is not");
  await shareAll(O, d1, [{ account: AP.account, role: "approver" }]);
  await webSuggest(C, { docId: d1, elementId: "e2e-10", exact: "Basil marble saffron lantern", replacement: "Basil marble saffron candle" });
  await arrived(ctx, box, AP.account.email, suggestedSubject(C.account.email, t1));
  assert.deepEqual(await subjectsTo(box, me, SUGGESTED), [suggestedSubject(C.account.email, t1)], "a second suggestion within 30 min sent the owner another notice");

  ctx.step("the commenter comments on the second document: the owner is told (the cooldown is per document)");
  await webThread(fsC, C.account, { docId: d2, versionId: "v1", elementId: "e2e-11", exact: "Cedar kestrel estuary fennel", body: `A23.4 other document ${t}`, annId: `a234o${rand4()}${rand4()}`, commentId: id(3) });
  await arrived(ctx, box, me, commentedSubject(C.account.email, t2));

  ctx.step("held 10 s: the owner's mail is exactly those three notices; one cooldown key per document and kind");
  await settleAll(box, {
    [me]: [commentedSubject(C.account.email, t1), suggestedSubject(C.account.email, t1), commentedSubject(C.account.email, t2)],
    [C.account.email]: [sharedSubject(me, t1), sharedSubject(me, t2), commentedSubject(W.account.email, t1)],
    [W.account.email]: [sharedSubject(me, t1)],
    [AP.account.email]: [sharedSubject(me, t1), suggestedSubject(C.account.email, t1)],
  });
  const keys = Object.keys((await readDoc(target, `users/${O.uid}`))?.emailCooldowns ?? {}).sort();
  assert.deepEqual(keys, [d1, `${d1}:suggestions`, d2].sort(), "the owner's cooldown keys");
});

// --- A23.5 ----------------------------------------------------------------------

scenario("A23.5 a decision is mailed as a comment: a rejection reaches the suggester with its reason, an agent's acceptance says via MCP, a withdrawal reaches the owner; none as a suggestion notice, none to the decider", {
  tiers: LOCAL,
  effects: ["email:POST /access", "email:comment", "email:suggestion"],
  needs: ["email", "mailpit"],
  timeoutMs: 600_000,
  inconclusiveOnFunctionKill: true,
}, async (ctx) => {
  const t = tag();
  const { owner: O, suggester: S } = await people(["owner", "suggester"]);
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const me = O.account.email;
  const title = `A23.5 decide ${t}`;
  const t2 = `A23.5 accept ${t}`;
  const docId = await newDoc(O, "a235-decide", title);
  const doc2 = await newDoc(O, "a235-accept", t2);
  await shareAll(O, docId, [{ account: S.account, role: "suggester" }]);
  await shareAll(O, doc2, [{ account: S.account, role: "suggester" }]);

  ctx.step("the suggester suggests on each document; the owner gets both suggestion notices");
  const [a1, a3] = await Promise.all([
    webSuggest(S, { docId, elementId: "e2e-12", exact: "Fennel garnet delta nectar", replacement: "Fennel garnet delta honey", note: `A23.5 please ${t}` }),
    webSuggest(S, { docId: doc2, elementId: "e2e-14", exact: "Nickel vellum estuary anchor", replacement: "Nickel vellum estuary harbour" }),
  ]);
  await Promise.all([arrived(ctx, box, me, suggestedSubject(S.account.email, title)), arrived(ctx, box, me, suggestedSubject(S.account.email, t2))]);

  const reason = `A23.5 not this time ${t}`;
  ctx.step(`the owner rejects the first in the app (POST /suggestion reject, "${reason}"), and their agent accepts the second through MCP`);
  const mcp = await agentOf(ctx, O, "owner");
  const [rej, acc] = await Promise.all([
    O.http.postJson("/suggestion", { op: "reject", docId, versionId: "v1", annId: a1, reason }, SLOW).then((r) => answered(r, "POST /suggestion reject")),
    mcp.ok("accept_suggestion", { id: doc2, threadId: a3 }),
  ]);
  assert.deepEqual({ status: rej.status, state: rej.json?.state }, { status: 200, state: "rejected" }, `reject: ${rej.text.slice(0, 200)}`);
  precondition(acc?.state === "accepted", `accept_suggestion: ${JSON.stringify(acc)}`);
  const [mr, ma] = await Promise.all([arrived(ctx, box, S.account.email, commentedSubject(me, title)), arrived(ctx, box, S.account.email, commentedSubject(me, t2))]);
  const lr = linesOf(mr);
  assert.equal(lr[0], `${me} commented on "${title}".`, "a rejection is a comment notice, from the decider, with no via marker");
  assert.ok(lr.includes(`Rejected: ${reason}`), `the decision note and its reason: ${JSON.stringify(lr)}`);
  assert.ok(lr.includes(`Reply in context: ${target.origin}/d/${docId}/v1`), `the comment branch's link: ${JSON.stringify(lr)}`);
  assert.ok(!lr.some((l) => l.startsWith("Suggested")), `no suggestion line in a decision: ${JSON.stringify(lr)}`);
  assert.ok(htmlOf(mr).includes("You received this because you own this document or replied in this thread."), "the comment branch's footnote");
  const la = linesOf(ma);
  assert.equal(la[0], `${me} commented on "${t2}" (via MCP).`, "an agent's acceptance is a comment notice that says via MCP");
  assert.ok(la.includes("Accepted."), `the decision note: ${JSON.stringify(la)}`);
  assert.ok(la.includes(`Reply in context: ${target.origin}/d/${doc2}/v1`), `the link: ${JSON.stringify(la)}`);

  ctx.step("the suggester suggests again on the first document and withdraws it: the owner (their suggestion notice still cooling down) gets the withdrawal as a comment notice");
  const a2 = await webSuggest(S, { docId, elementId: "e2e-13", exact: "Zephyr saffron marble meadow", replacement: "Zephyr saffron granite meadow" });
  const wd = answered(await S.http.postJson("/suggestion", { op: "withdraw", docId, versionId: "v1", annId: a2 }, SLOW), "POST /suggestion withdraw");
  assert.deepEqual({ status: wd.status, state: wd.json?.state }, { status: 200, state: "withdrawn" }, `withdraw: ${wd.text.slice(0, 200)}`);
  const mw = await arrived(ctx, box, me, commentedSubject(S.account.email, title));
  const lw = linesOf(mw);
  assert.ok(lw.includes("Withdrawn."), `the withdrawal note: ${JSON.stringify(lw)}`);
  assert.ok(lw.includes(`Reply in context: ${target.origin}/d/${docId}/v1`), `the link: ${JSON.stringify(lw)}`);

  ctx.step("held 10 s: the suggester's mail is two invitations and two decisions; the owner's two suggestion notices and the withdrawal; no decision as a suggestion notice, none to its decider");
  await settleAll(box, {
    [S.account.email]: [sharedSubject(me, title), sharedSubject(me, t2), commentedSubject(me, title), commentedSubject(me, t2)],
    [me]: [suggestedSubject(S.account.email, title), suggestedSubject(S.account.email, t2), commentedSubject(S.account.email, title)],
  });
});

// --- A23.6 ----------------------------------------------------------------------

/**
 * A23.6's own requests: a status that is not 200 FAILS, but for Hosting's
 * cut-off, which `timedOut` judges. An assertion: the lib never excuses one.
 */
function notAnswered200(r, what) {
  return new assert.AssertionError({ message: `${what} answered ${r.status} when the provider refused the send: ${r.text.slice(0, 200)}`, actual: r.status, expected: 200, operator: "strictEqual" });
}

/**
 * One of A23.6's requests got no answer (Hosting's cut-off 504 at 60 s, or
 * http.mjs's deadline): could the refused send have caused it? Only if the
 * provider refused it BEFORE the request was cut off. So the cut-off is the
 * stack's load, and the case INCONCLUSIVE, when the shim had seen no send to
 * the refused recipient by the time the request was answered (the product had
 * not reached the send under test: setAccess grants, then awaits the
 * invitations, then answers). A refusal the shim recorded before that FAILS
 * the case: the request was refused a send and then not answered for the rest
 * of the 60 s. This is why A23.6 never passes these three through answered().
 * @returns {Promise<string>} why the cut-off is INCONCLUSIVE
 */
async function timedOut({ shim, to, what, sentAt, answeredAt }) {
  const seen = await shim.requests({ to });
  const before = seen.filter((x) => Date.parse(x.at) <= answeredAt);
  if (before.length === 0) {
    const later = seen.length ? `${Math.round((Date.parse(seen[0].at) - answeredAt) / 1000)} s after the cut-off` : "not at all yet";
    return `${what}: no answer after ${Math.round((answeredAt - sentAt) / 1000)} s (Hosting's cut-off 504 or http.mjs's deadline), and the product had not yet reached the send under test (the shim saw it ${later})`;
  }
  throw new assert.AssertionError({ message: `${what} got no answer (Hosting's cut-off 504 or http.mjs's deadline): the provider refused its send ${Math.round((Date.parse(before[0].at) - sentAt) / 1000)} s in, and the request was not answered by ${Math.round((answeredAt - sentAt) / 1000)} s`, actual: 504, expected: 200, operator: "strictEqual" });
}

scenario("A23.6 when the provider refuses a send (shim 500), POST /access, /folder-access and /team-members still answer 200 with the grant made, the next recipient in the same request still gets theirs, and the product logs the failure", {
  tiers: LOCAL,
  effects: ["email:POST /access", "email:POST /folder-access", "email:POST /team-members"],
  needs: ["email", "mailpit", "mail-fail-recipient", "logs"],
  timeoutMs: 600_000,
  inconclusiveOnFunctionKill: true,
}, async (ctx) => {
  const t = tag();
  const { owner: O } = await people(["owner"]);
  const me = O.account.email;
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const shim = shimControl(target, { http: ctx.http({ actor: "shim" }) });
  const [fDoc, okDoc, fFolder, fTeam] = ["faildoc", "okdoc", "failfolder", "failteam"].map((r) => localEmail(target, r));
  const failing = [fDoc, fFolder, fTeam];
  const message = (what) => `e2e A23.6 ${t} ${what} injected`;
  const title = `A23.6 failing ${t}`;
  const docId = await newDoc(O, "a236-fail", title);
  const folderId = await newFolder(O, `A23.6 folder ${t}`);
  const teamId = await newTeam(O, `A23.6 team ${t}`);
  const mark = logMark({ target });
  try {
    for (const [to, what] of [[fDoc, "access"], [fFolder, "folder"], [fTeam, "team"]]) {
      const q = await shim.failRecipient(to, { status: 500, count: 1, body: { statusCode: 500, name: "application_error", message: message(what) } });
      precondition(q.pending === 1, `the shim queued the failure for ${to}`);
    }

    ctx.step("POST /access adds two new addresses, the first refused by the provider; POST /folder-access and POST /team-members each add one the provider refuses");
    /** Each request with the times it was sent and answered (the shim's clock is this machine's); http.mjs's own deadline is an answer of nothing. */
    const timed = async (what, to, send) => {
      const sentAt = Date.now();
      try {
        return { res: await send(), what, to, sentAt, answeredAt: Date.now() };
      } catch (err) {
        if (!CLIENT_TIMEOUT.test(String(err?.message ?? "")) && !CLIENT_TIMEOUT.test(String(err?.cause?.message ?? ""))) throw err;
        return { res: { status: 0, text: String(err.message) }, clientTimeout: true, what, to, sentAt, answeredAt: Date.now() };
      }
    };
    const asked = [
      await timed("POST /access", fDoc, () => access(O, docId, [{ account: fDoc }, { account: okDoc }])),
      await timed("POST /folder-access", fFolder, () => folderGrant(O, folderId, fFolder)),
      await timed("POST /team-members", fTeam, () => teamAdd(O, teamId, [fTeam])),
    ];
    const gaveUp = (a) => a.clientTimeout === true || isHostingCutoff(a.res);
    for (const a of asked) if (a.res.status !== 200 && !gaveUp(a)) throw notAnswered200(a.res, a.what);
    const load = [];
    for (const a of asked) if (gaveUp(a)) load.push(await timedOut({ shim, ...a }));
    if (load.length > 0) ctx.inconclusive(`the stack's load, not the refusal: ${load.join("; ")}`);
    const [r, , tr] = asked.map((a) => a.res);
    assert.ok(r.json.members.includes(fDoc) && r.json.members.includes(okDoc), `both were granted: ${JSON.stringify(r.json.members)}`);
    assert.ok((await readDoc(target, `docs/${docId}`)).members.includes(fDoc), "the stored record holds the refused recipient's grant");
    assert.ok((await readDoc(target, `folders/${folderId}`)).members.includes(fFolder), "the folder grant was made");
    assert.ok(tr.json.members.includes(fTeam), "the team member was added");

    ctx.step("the shim: each refused recipient's one send was the injected 500, used up and not retried; the other recipient's was delivered");
    for (const to of failing) {
      const got = await shim.requests({ to });
      assert.deepEqual(got.map((x) => [x.status, x.injected === true, x.injectedFor]), [[500, true, to]], `what the shim saw for ${to}: ${JSON.stringify(got.map((x) => ({ status: x.status, subject: x.subject })))}`);
      assert.equal(await shim.pending(to), 0, `the failure queued for ${to} was used`);
    }
    assert.deepEqual((await shim.requests({ to: okDoc })).map((x) => [x.subject, x.status]), [[sharedSubject(me, title), 200]], "the next recipient in the same request was still sent theirs");

    ctx.step("the product logged each failure with the provider's message (send.ts)");
    for (const what of ["access", "folder", "team"]) {
      await waitForLog(new RegExp(`\\[email\\] send failed: ${escapeRe(message(what))}`), { target, since: mark, timeout: LOG_MS });
    }

    ctx.step("held 10 s: the delivered invitation arrived once; the refused ones never did");
    await settleAll(box, { [okDoc]: [sharedSubject(me, title)], [fDoc]: [], [fFolder]: [], [fTeam]: [], [me]: [] });
  } finally {
    for (const to of failing) await shim.clear(to).catch(() => undefined);
  }
});

// --- A23.7 ----------------------------------------------------------------------

scenario("A23.7 email off: invitations, a comment, a suggestion, a decision and a verification code each answer as with email on, each send is the product's logged no-op, and nothing reaches the shim or Mailpit", {
  tiers: LOCAL,
  needs: ["email-off", "mailpit", "mail-fail-recipient", "logs"],
  timeoutMs: 420_000,
  inconclusiveOnFunctionKill: true,
}, async (ctx) => {
  const t = tag();
  const { owner: O, suggester: S } = await people(["owner", "suggester"]);
  const me = O.account.email;
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const shim = shimControl(target, { http: ctx.http({ actor: "shim" }) });
  const [iDoc, iFolder, iTeam] = ["offdoc", "offfolder", "offteam"].map((r) => localEmail(target, r));
  const skipped = (subject, to) => new RegExp(`\\[email\\] skipped "${escapeRe(subject)}" to ${escapeRe(to)}: no API key configured`);
  const mark = logMark({ target });

  ctx.step("invitations: POST /access (a new address and the suggester), /folder-access and /team-members each answer 200 with the grant made");
  const title = `A23.7 off ${t}`;
  const docId = await newDoc(O, "a237-off", title);
  const r = answered(await access(O, docId, [{ account: iDoc }, { account: S.account, role: "suggester" }]), "POST /access");
  assert.equal(r.status, 200, `POST /access: ${r.text.slice(0, 200)}`);
  assert.ok(r.json.members.includes(iDoc) && r.json.members.includes(S.account.email), `members: ${JSON.stringify(r.json.members)}`);
  const fname = `A23.7 folder ${t}`;
  const folderId = await newFolder(O, fname);
  const fr = answered(await folderGrant(O, folderId, iFolder), "POST /folder-access");
  assert.equal(fr.status, 200, `POST /folder-access: ${fr.text.slice(0, 200)}`);
  assert.ok((await readDoc(target, `folders/${folderId}`)).members.includes(iFolder), "the folder grant was made");
  const tname = `A23.7 team ${t}`;
  const teamId = await newTeam(O, tname);
  const tr = answered(await teamAdd(O, teamId, [iTeam]), "POST /team-members");
  assert.equal(tr.status, 200, `POST /team-members: ${tr.text.slice(0, 200)}`);
  assert.ok(tr.json.members.includes(iTeam), "the team member was added");

  ctx.step("a comment by the suggester's agent (MCP), a suggestion (web), the owner's rejection (web): each stored as with email on");
  const mcp = await agentOf(ctx, S, "suggester");
  const thread = await mcp.ok("add_comment", { id: docId, exact: "Jasper willow linen walnut", body: `A23.7 comment ${t}` });
  precondition(typeof thread?.threadId === "string", `add_comment: ${JSON.stringify(thread)}`);
  const stored = await readDoc(target, `docs/${docId}/versions/v1/annotations/${thread.threadId}`);
  assert.ok(stored && stored.anchor?.exact === "Jasper willow linen walnut", "the comment's thread is stored");
  const annId = await webSuggest(S, { docId, elementId: "e2e-15", exact: "Glacier nectar fennel hollow", replacement: "Glacier nectar fennel valley" });
  const rej = answered(await O.http.postJson("/suggestion", { op: "reject", docId, versionId: "v1", annId, reason: `A23.7 no ${t}` }, SLOW), "POST /suggestion reject");
  assert.deepEqual({ status: rej.status, state: rej.json?.state }, { status: 200, state: "rejected" }, `the rejection: ${rej.text.slice(0, 200)}`);

  ctx.step("a verification code for an unverified account: POST /verify/start answers {sent: true} as with email on");
  const U = await castUnverified(target, "offverify");
  const uh = ctx.http({ actor: "offverify" });
  const start = answered(await uh.postJson("/verify/start", {}, { headers: { authorization: `Bearer ${await idToken(target, U, { http: uh })}` }, ...SLOW }), "POST /verify/start");
  assert.deepEqual({ status: start.status, json: start.json }, { status: 200, json: { sent: true, email: U.email } }, `POST /verify/start with email off: ${start.text.slice(0, 200)}`);

  ctx.step("each send is the product's logged no-op (send.ts), naming its subject and recipient");
  const lines = [
    [sharedSubject(me, title), iDoc],
    [sharedSubject(me, title), S.account.email],
    [sharedSubject(me, fname), iFolder],
    [sharedSubject(me, tname), iTeam],
    [commentedSubject(S.account.email, title), me],
    [suggestedSubject(S.account.email, title), me],
    [commentedSubject(me, title), S.account.email],
  ];
  for (const [subject, to] of lines) await waitForLog(skipped(subject, to), { target, since: mark, timeout: LOG_MS });
  // The verification subject holds the code itself: match its shape, never print it.
  await waitForLog(new RegExp(`\\[email\\] skipped "\\d{6} is your Bikeshed verification code" to ${escapeRe(U.email)}: no API key configured`), { target, since: mark, timeout: LOG_MS });

  ctx.step("nothing reached the shim or Mailpit for any recipient (held 10 s)");
  const everyone = [iDoc, iFolder, iTeam, me, S.account.email, U.email];
  for (const to of everyone) assert.deepEqual(await shim.requests({ to }), [], `with email off the shim received a send for ${to}`);
  await settleAll(box, Object.fromEntries(everyone.map((to) => [to, []])));
});
