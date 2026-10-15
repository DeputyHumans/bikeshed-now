// SPDX-License-Identifier: Apache-2.0
// A2 permission matrix, data plane: annotation create, suggestion create and decisions, and the live log's write and read, per actor (SPEC §2, §16, §17, §22).

/**
 * The plan's operations c6–c8 and c17–c18 for every actor, the expired row
 * included. Each cell is its own case, with its own accounts and document.
 * Each act uses the actor's OWN credential against the rules or endpoint that
 * decide it, never an admin credential:
 *
 *   c6   Firestore REST create of docs/{d}/versions/v1/annotations/{a} as the
 *        app's SDK sends it (clientFirestore, lib/firestore-client.mjs:
 *        `Bearer <the actor's ID token>`)                    firestore.rules:216
 *   c7   POST /suggestion {op: create}, with the actor's session (or the
 *        visitor's `k`)                                       index.ts:1385
 *   c8   POST /suggestion {op: claim, accept, reject}; the approver once more
 *        with a personal access token
 *   c17  RTDB REST PUT status/{d}/y/{entry} (rtdbAs, lib/rtdb.mjs: the ID
 *        token only as `?auth=`, never a header)          database.rules.json:100
 *   c18  RTDB REST GET status/{d}/y, the same way         database.rules.json:56
 *
 * Admin reads (lib/admin.mjs) only check what a request left behind: the
 * annotation, the suggestion's state, the log entry.
 *
 * Every refusal cell carries an in-case control, the same request that
 * succeeds for someone who may make it. It is the owner's identical write, or
 * the same account once it has the access, or the same account before the
 * expiry. That control is what shows a DENY is about access and not about a
 * malformed request.
 *
 * Every RTDB cell first proves, live, that ns=<projectId> (the namespace the
 * app and the functions use) enforces the tree's database.rules.json
 * (rtdbRulesStatus): on a stack whose rules are not loaded there, every DENY
 * would be blind.
 *
 * Accounts are quiet (cast with notifications and analytics off, written
 * before their first session, as production's castAdmin does), so the
 * suggestions and decisions here email nobody. Sharing goes through
 * lib/grant.mjs, which on production is the operator's script, and every
 * window a case opens closes with it (setVisibility).
 *
 * When the stack does not answer. On a loaded shared stack the setup's
 * function calls (POST /session, /publish, /access, /unlock, /suggestion) and
 * the Admin SDK's writes can go unanswered for Hosting's whole minute. Every
 * case declares inconclusiveOnStackTimeout, so such a non-answer, and only
 * such a non-answer, ends it INCONCLUSIVE instead of a FAIL that measured
 * nothing; an assertion still FAILS. Every client that calls a function waits
 * past Hosting's cut-off and throws on it (cutoffError), so a cut-off is
 * named as one and never read as the product's 504. Setup steps that are safe
 * to repeat, or whose effect can be read back, are sent again first
 * (untilLanded, the lib's `patient`), until ENV_BUDGET_MS into the case. The
 * act under test is never sent again.
 */

import { flattenLiveLogs, liveLogPath } from "../../lib/live-log.mjs";
import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { absentDocId, publish, readFixture } from "../../lib/seed.mjs";
import { setVisibility, share } from "../../lib/grant.mjs";
import { closeAdmin, emailKey, readCollection, readDoc, rtdbGet } from "../../lib/admin.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { rtdbAs, rtdbRulesStatus } from "../../lib/rtdb.mjs";
import { sameHeadersExceptDate } from "../../lib/assert.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";

/**
 * Per-case budgets. A world is about six function calls, and on a shared stack
 * serving several spec files at once each can queue for tens of seconds (one
 * POST /access took 36 s there). The budget is for that queue; nothing here
 * waits on a settle.
 */
const CASE_MS = 360_000;
const LONG_MS = 480_000;
/** One product request's budget, for the same queue (the http client's own is 60 s). */
const REQ_MS = 180_000;
const slow = Object.freeze({ timeoutMs: REQ_MS });

/**
 * A function caller's client: it waits past Hosting's 60 s cut-off, so the
 * cut-off arrives as Hosting's 504 rather than as the client's own deadline,
 * and it throws E2E_STACK_CUTOFF on that 504 (cutoffError) before any status
 * is judged. A quicker 504, or any other status, is returned and judged.
 */
const SESSION_MS = 90_000;
const fnHttp = (ctx, actor, headers) => ctx.http({ actor, timeoutMs: SESSION_MS, cutoffError: true, ...(headers ? { headers } : {}) });

/**
 * How long into a case a setup call the stack did not answer is still sent
 * again (lib/test.mjs untilLanded's `stopAt`). A non-answer costs Hosting's
 * minute, a minute looking for its effect, then the next attempt; past this,
 * one ends the case INCONCLUSIVE at once, well inside CASE_MS. A case that
 * meets none is never affected.
 */
const ENV_BUDGET_MS = 180_000;
const stopAts = new WeakMap();
/** untilLanded's options for this case: `stopAt` fixed as the case began (cell). */
const patience = (ctx) => ({ stopAt: stopAts.get(ctx) ?? Date.now() + ENV_BUDGET_MS });
/** The `patient` option of lib's publish and setVisibility, for this case. */
const patient = (ctx) => ({ ctx, ...patience(ctx) });

/**
 * The file's budget (lib/budget.mjs): the cases come from loops and a wrapper
 * the scan cannot count. 72 cases take under a minute on a fresh stack; this
 * is the shared stack's worst case, about 100 s each.
 */
export const E2E_FILE_TIMEOUT_MS = 150 * 60_000;

/** Two passages of the fixture, anchored as the app anchors them. */
const PASSAGE_1 = { anchor: { elementId: "e2e-1", exact: "Estuary amber zephyr", prefix: "Paragraph 1. ", suffix: " walnut", start: 13, end: 33 }, replacement: "Estuary amber breeze" };
const PASSAGE_2 = { anchor: { elementId: "e2e-2", exact: "Xenon delta timber", prefix: "Paragraph 2. ", suffix: " linen", start: 13, end: 31 }, replacement: "Xenon delta cedar" };

/** An empty Yjs update (0 structs, empty delete set): harmless if anyone ever replays the log. */
const EMPTY_UPDATE = "AAA=";

/** The product's exact refusal sentences (functions/src/index.ts). */
const MSG = Object.freeze({
  cannotSuggest: "You can read this document, but not suggest edits to it.",
  notApprover: "Only the owner or an approver can accept or reject a suggestion.",
  inTheApp: "Through this endpoint a suggestion is decided in the app. An agent decides one with accept_suggestion or reject_suggestion.",
  expired: "this document has expired — change or clear its expiry to edit it",
});

/**
 * The actors (plan appendix, "Shared notation"). `cast` is the account role,
 * `role` a grant on the document, `visibility`/`publicEdit` the document's
 * setting, `grant` a link grant from POST /unlock with the key.
 */
const ACTORS = Object.freeze({
  O: { label: "the owner" },
  V: { label: "a viewer", cast: "viewer", role: "viewer" },
  S: { label: "a suggester", cast: "suggester", role: "suggester" },
  E: { label: "an editor", cast: "editor", role: "editor" },
  A: { label: "an approver", cast: "approver", role: "approver" },
  X: { label: "a signed-in stranger", cast: "stranger" },
  AN: { label: "an anonymous visitor" },
  LK: { label: "an anonymous visitor with the link's key", visibility: "unlisted" },
  LKw: { label: "an anonymous visitor with a wrong key", visibility: "unlisted" },
  G: { label: "a signed-in link-grant holder, without the key", cast: "grantholder", visibility: "unlisted", grant: true },
  PE: { label: "a non-member on a public open-editing document", cast: "openeditor", visibility: "public", publicEdit: true },
  PEU: { label: "a link-grant holder on an unlisted open-editing document", cast: "linkeditor", visibility: "unlisted", publicEdit: true, grant: true },
});

// --- Setup -------------------------------------------------------------------

/** A key of the right length that is not the document's. */
function wrongKey(k) {
  const flipped = [...k].map((c) => (c === "A" ? "B" : "A")).join("");
  return flipped === k ? "B".repeat(k.length) : flipped;
}

/** Accounts for `roles`, quiet; cast again when the stack did not answer (a fresh cast is harmless). */
async function castQuiet(ctx, roles) {
  const { out } = await untilLanded(ctx, `cast ${roles.join(", ")}`, () => cast(target, roles, { notifications: false, analytics: false }), null, patience(ctx));
  return out;
}

/** A session for `acct` (POST /session, safe to send again). */
async function sessionFor(ctx, acct, actor) {
  const { out } = await untilLanded(ctx, `POST /session (${actor})`, () => openSession(target, acct, { http: fnHttp(ctx, actor) }), null, patience(ctx));
  return out;
}

/** Give `account` `role` on `docId` (POST /access, idempotent: a re-save of the same grant invites nobody, index.ts setAccess). */
async function grantRole(ctx, owner, docId, account, role) {
  const { out } = await untilLanded(ctx, `POST /access ${role} (${docId})`, () => share(target, { owner, doc: docId, account, role, timeoutMs: REQ_MS }), null, patience(ctx));
  return out;
}

/**
 * One owner, one document (the paragraphs fixture as v1), and the actor `kind`
 * with exactly the access the plan gives it. A document made unlisted or
 * public here is made private again when the case ends (setVisibility).
 * Returns {owner, ownerAcct, docId, linkToken, actor} where actor holds
 * {kind, label, http (session or anonymous), idToken?, uid?, email?, k?}.
 */
async function world(ctx, kind, { rtdb = false } = {}) {
  const spec = ACTORS[kind];
  const accounts = await castQuiet(ctx, spec.cast ? ["owner", spec.cast] : ["owner"]);
  const owner = await sessionFor(ctx, accounts[0], "owner");
  const up = await publish(owner.http, { fixture: FIXTURE, title: `A2 data ${kind} ${runTag(target.runId)}`, name: `a2d-${kind.toLowerCase()}`, timeoutMs: REQ_MS, patient: patient(ctx) });
  precondition((up.status === 200 || up.landed) && up.versionId === "v1", `the owner published v1 (got ${up.status} ${JSON.stringify(up.json)})`);
  const docId = up.docId;
  let linkToken = null;
  if (spec.visibility) {
    const v = await setVisibility(target, { owner, doc: docId, visibility: spec.visibility, publicEdit: spec.publicEdit === true, timeoutMs: REQ_MS, patient: patient(ctx) });
    precondition(v.visibility === spec.visibility && v.publicEdit === (spec.publicEdit === true), `visibility set: ${JSON.stringify(v.json)}`);
    linkToken = v.linkToken;
    if (spec.visibility === "unlisted") precondition(typeof linkToken === "string" && linkToken.length >= 22, "an unlisted document has a link token");
  }
  ctx.step(`${kind}: owner ${accounts[0].email} published ${docId}${spec.visibility ? ` (${spec.visibility}${spec.publicEdit ? ", open editing" : ""})` : " (private)"}`);

  const actor = { kind, label: spec.label };
  if (kind === "O") {
    Object.assign(actor, { session: owner, http: owner.http, idToken: owner.idToken, uid: owner.uid, email: accounts[0].email.toLowerCase() });
  } else if (spec.cast) {
    const acct = accounts[1];
    if (spec.role) {
      const g = await grantRole(ctx, owner, docId, acct, spec.role);
      precondition(g.status === 200, `share as ${spec.role}: ${g.status}`);
      if (rtdb) precondition(g.mirror?.ok, `the RTDB mirror for a ${spec.role}: ${JSON.stringify(g.mirror)}`);
    }
    const session = await sessionFor(ctx, acct, kind.toLowerCase());
    Object.assign(actor, { account: acct, session, http: session.http, idToken: session.idToken, uid: session.uid, email: acct.email.toLowerCase() });
    if (spec.grant) {
      const grantDoc = `docs/${docId}/linkGrants/${session.uid}`;
      // Its effect is the grant under the current token, read back before it is sent again.
      const u = await untilLanded(ctx, `POST /unlock (${docId})`, () => session.http.postJson("/unlock", { docId, k: linkToken }, slow), async () => ((await readDoc(target, grantDoc))?.token === linkToken ? true : null), patience(ctx));
      precondition(u.landed || u.out.status === 200, `POST /unlock with the key answered ${u.out?.status}`);
      const grant = await readDoc(target, grantDoc);
      precondition(grant?.token === linkToken, "POST /unlock with the key gave the account a link grant under the current token");
    }
    ctx.step(`${kind}: ${spec.label}, ${acct.email}${spec.role ? `, shared as ${spec.role}` : ""}${spec.grant ? ", holding a link grant" : ""}`);
  } else {
    actor.http = fnHttp(ctx, kind.toLowerCase());
    if (kind === "LK") actor.k = linkToken;
    if (kind === "LKw") actor.k = wrongKey(linkToken);
    ctx.step(`${kind}: ${spec.label}, no account${actor.k ? ", presenting a key" : ""}`);
  }

  if (rtdb && spec.cast && !spec.role) {
    // Non-members: no presence entry; only a PUBLIC open-editing document carries `*` (SPEC §16).
    const [presence, edit] = await Promise.all([rtdbGet(target, `presenceAccess/${docId}`), rtdbGet(target, `editAccess/${docId}`)]);
    precondition(!(presence ?? {})[emailKey(actor.email)], `${kind} is not in presenceAccess`);
    const star = (edit ?? {})["*"] === true;
    precondition(star === (spec.visibility === "public" && spec.publicEdit === true), `editAccess/${docId}/* is ${star}`);
  }
  return { owner, ownerAcct: accounts[0], docId, linkToken, actor };
}

/** ALLOW or DENY from a client result (lib/firestore-client.mjs, lib/rtdb.mjs); anything else is not a verdict. */
function verdictOf(r, what) {
  precondition(r.verdict === "ALLOW" || r.verdict === "DENY", `${what}: answered ${r.status} ${JSON.stringify(r.json ?? r.message ?? null).slice(0, 300)}, which is neither an allow nor a rules denial`);
  return r.verdict;
}

// --- Firestore (c6) ----------------------------------------------------------

const annPath = (docId, annId) => `docs/${docId}/versions/v1/annotations/${annId}`;

/**
 * Create an annotation as the app does (SPEC §6): exactly the eight keys the
 * rule lists, `createdAt` the request time, authored as `who`, with `idToken`
 * (null: anonymous).
 */
function createAnnotation(ctx, label, { docId, annId, who, idToken }) {
  const fs = clientFirestore(target, { idToken: idToken ?? null, http: ctx.http({ actor: `${label}-firestore` }) });
  return fs.create(
    annPath(docId, annId),
    {
      annId,
      anchor: { ...PASSAGE_1.anchor },
      authorUid: who.uid,
      authorEmail: who.email,
      actor: { uid: who.uid, email: who.email, channel: "web" },
      color: "#b5257b",
      resolved: false,
    },
    { serverTime: ["createdAt"] },
  );
}

const newAnnId = () => `e2e${runTag(target.runId)}${rand4()}${rand4()}`;

/** Who an anonymous write claims to be: there is no identity to be "self". */
const nobody = () => ({ uid: `anon-${rand4()}${rand4()}`, email: `anon-${runTag(target.runId)}-${rand4()}@example.com` });

// --- RTDB (c17, c18, A11.11) ------------------------------------------------------

/** The actor's RTDB client: rules-evaluated, the token only as `?auth=` (lib/rtdb.mjs). */
const rtdbFor = (ctx, label, idToken) => rtdbAs(target, { idToken: idToken ?? null, http: ctx.http({ actor: `${label}-rtdb` }) });

/**
 * An RTDB DENY is only evidence when ns=<projectId> enforces the tree's rules.
 * Live, per case, on a local stack (on production the deployed rules are the
 * product's own).
 */
async function rulesEnforced(ctx) {
  if (target.kind !== "local") return;
  const s = await rtdbRulesStatus(target, { http: ctx.http({ actor: "rtdb-rules" }) });
  precondition(s.ok, `RTDB rules in ns=${s.namespace}: ${s.reason}`);
  ctx.step(`RTDB ns=${s.namespace} enforces the tree's ${s.file} (${s.bytes} bytes, sha256 ${s.sha256.slice(0, 12)}; an anonymous read answers ${s.anonymousStatus})`);
}

const newEntry = (who) => `e2e-${runTag(target.runId)}-${who.toLowerCase()}-${rand4()}`;

// --- Suggestions (c7, c8) ----------------------------------------------------

function createBody(docId, { k, passage = PASSAGE_1 } = {}) {
  return { op: "create", docId, versionId: "v1", anchor: passage.anchor, replacement: passage.replacement, ...(k ? { k } : {}) };
}

/**
 * The owner proposes a change (setup for c8). A create the stack did not
 * answer is looked for (the owner's pending suggestion of this passage)
 * before it is sent again, so a late one is taken rather than doubled.
 */
async function ownerSuggests(ctx, owner, docId, passage) {
  const mine = async () => {
    const anns = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
    const hit = anns.find((a) => a.data.authorUid === owner.uid && a.data.suggestion?.replacement === passage.replacement && a.data.anchor?.exact === passage.anchor.exact);
    return hit ? hit.id : null;
  };
  const { out: r, landed } = await untilLanded(ctx, `POST /suggestion create (${docId})`, () => owner.http.postJson("/suggestion", createBody(docId, { passage }), slow), mine, patience(ctx));
  if (landed) return landed;
  precondition(r.status === 200 && typeof r.json?.annId === "string", `the owner's suggestion was created (${r.status} ${r.text.slice(0, 200)})`);
  return r.json.annId;
}

/** A refusal: the status and the exact body (an error sentence, or nothing at all). */
function assertRefusal(r, want, label) {
  assert.equal(r.status, want.status, `${label}: expected ${want.status}, got ${r.status} ${r.text.slice(0, 200)}`);
  if (want.error !== undefined) assert.deepEqual(r.json, { error: want.error }, `${label}: the body`);
  else assert.equal(r.text, "", `${label}: an empty body`);
}

/** A 404 must say nothing an absent id would not: same status, same bytes, same headers but Date. */
async function assertAbsentParity(http, body, got, label) {
  const absent = await http.postJson("/suggestion", { ...body, docId: absentDocId(target) }, slow);
  assert.equal(absent.status, 404, `${label}: an absent id answers 404`);
  assert.ok(got.buffer.equals(absent.buffer), `${label}: the body is byte-equal to an absent id's (${got.buffer.length} vs ${absent.buffer.length} bytes)`);
  const h = sameHeadersExceptDate(got, absent);
  assert.ok(h.equal, `${label}: the headers equal an absent id's: ${JSON.stringify(h.diff)}`);
}

/** The suggestion is still pending, unclaimed, undecided, with only its opener. */
async function assertUndecided(docId, annId, label) {
  const s = await readDoc(target, annPath(docId, annId));
  assert.ok(s?.suggestion, `${label}: the suggestion still exists`);
  assert.deepEqual({ state: s.suggestion.state, claim: s.suggestion.claim ?? null, decidedBy: s.suggestion.decidedBy ?? null, resolved: s.resolved }, { state: "pending", claim: null, decidedBy: null, resolved: false }, `${label}: the suggestion is untouched`);
  const comments = await readCollection(target, `${annPath(docId, annId)}/comments`);
  assert.equal(comments.length, 1, `${label}: only the opener is in the thread (${comments.map((c) => c.data.body).join(" | ")})`);
}

// --- The matrix ------------------------------------------------------------------

/** c6: the rule at firestore.rules:216, canRead plus authoredBySelf. */
const C6 = {
  O: ["ALLOW", "SPEC §22: every role reads and comments; firestore.rules canRead (owner)"],
  V: ["ALLOW", "SPEC §22 table: a viewer reads and comments"],
  S: ["ALLOW", "SPEC §22 table: a suggester reads and comments"],
  E: ["ALLOW", "SPEC §22 table: an editor reads and comments"],
  A: ["ALLOW", "SPEC §22 table: an approver reads and comments"],
  X: ["DENY", "SPEC §17: a private document is read by its owner and members only"],
  AN: ["DENY", "SPEC §17 \"Anonymous is read-only. Always.\""],
  LK: ["DENY", "SPEC §17 \"Anonymous is read-only. Always.\" The rules cannot see a key"],
  LKw: ["DENY", "SPEC §17 \"Anonymous is read-only. Always.\""],
  G: ["ALLOW", "SPEC §17: a link grant \"is what lets a link holder comment\""],
  PE: ["ALLOW", "SPEC §17: a public document is read by any verified account; SPEC §22: an open editor comments"],
  PEU: ["ALLOW", "SPEC §17: the link grant stands in for the key"],
};

/** c7: POST /suggestion create (SPEC §2 table). */
const C7 = {
  O: [200, "SPEC §22: the owner suggests"],
  V: [403, "SPEC §2: \"403 a reader who may not suggest\"", MSG.cannotSuggest],
  S: [200, "SPEC §22: a suggester suggests"],
  E: [200, "SPEC §22: an editor suggests"],
  A: [200, "SPEC §22: an approver suggests"],
  X: [404, "SPEC §2: \"a caller who may not read 404 (§1.4b)\""],
  AN: [401, "SPEC §2: \"Anonymous 401\""],
  LK: [401, "SPEC §2: \"Anonymous 401\"; SPEC §17 anonymous is read-only"],
  LKw: [401, "SPEC §2: endpoints are auth-first, \"Anonymous 401\""],
  G: [403, "SPEC §22: a link holder reads, but suggesting is a role", MSG.cannotSuggest],
  PE: [200, "SPEC §22 table: an open editor suggests"],
  PEU: [200, "SPEC §17: open editing on an unlisted document reaches its link holders"],
};

/** c8: claim, accept, reject (SPEC §2, §22). */
const C8 = {
  O: [200, "SPEC §22 table: the owner accepts and rejects"],
  V: [403, "SPEC §22 table: only the owner and approvers decide", MSG.notApprover],
  S: [403, "SPEC §22 table: only the owner and approvers decide", MSG.notApprover],
  E: [403, "SPEC §22 table: an editor does not decide", MSG.notApprover],
  A: [200, "SPEC §22 table: an approver accepts and rejects"],
  X: [404, "SPEC §2: \"a caller who may not read 404\""],
  AN: [401, "SPEC §2: \"Anonymous 401\""],
  LK: [401, "SPEC §2: \"Anonymous 401\""],
  LKw: [401, "SPEC §2: \"Anonymous 401\""],
  G: [403, "acl.ts isDocApprover: \"Never widened by open editing or by a link\"", MSG.notApprover],
  PE: [403, "SPEC §22 table: an open editor does not decide", MSG.notApprover],
  PEU: [403, "SPEC §22 table: an open editor does not decide", MSG.notApprover],
};

/** c17: write status/{d}/y/{entry}, gated on editAccess (database.rules.json:100). */
const C17 = {
  O: ["ALLOW", "SPEC §16: writes to the shared log are gated by editAccess, a mirror of editorMembers"],
  V: ["DENY", "SPEC §16 and presence.ts: a read-only member must not push edits into an editor's browser"],
  S: ["DENY", "SPEC §16: \"A suggester is not in it, and never joins the shared log\""],
  E: ["ALLOW", "SPEC §16: an editor is in editAccess"],
  A: ["ALLOW", "SPEC §16: \"approvers included, since that set contains them\""],
  X: ["DENY", "SPEC §16: only editAccess, and a stranger is not in it"],
  AN: ["DENY", "SPEC §17: anonymous is read-only"],
  LK: ["DENY", "SPEC §17: anonymous is read-only; the realtime rules cannot see a key"],
  LKw: ["DENY", "SPEC §17: anonymous is read-only"],
  G: ["DENY", "SPEC §16: a link holder is not an editor, and no unlisted document carries *"],
  PE: ["ALLOW", "SPEC §16: \"A public open-editing document also carries the key *: any verified account\""],
  PEU: ["DENY", "SPEC §16: \"An unlisted one never does\" carry *; its link holders edit through /draft"],
};

/** c18: shared draft reads require editAccess, independently of peer presence (SPEC §16). */
const C18 = {
  O: ["ALLOW", "SPEC §16: the owner edits live"],
  V: ["DENY", "S26: GET /draft is editor-gated (SPEC §2), and the rules say document state is gated on may-edit"],
  S: ["DENY", "S26: a suggester \"never joins the shared log\" (SPEC §16); GET /draft is editor-gated (SPEC §2)"],
  E: ["ALLOW", "SPEC §16: an editor edits live"],
  A: ["ALLOW", "SPEC §16: an approver edits live"],
  X: ["DENY", "SPEC §16: presence and document state are for members"],
  AN: ["DENY", "SPEC §16: presence is gated on a verified member"],
  LK: ["DENY", "SPEC §16 not built: \"live co-editing through an unlisted link\""],
  LKw: ["DENY", "SPEC §16: presence is gated on a verified member"],
  G: ["DENY", "SPEC §16 not built: \"presence for non-members · live co-editing through an unlisted link\""],
  PE: ["ALLOW", "S27: SPEC §16 lets any verified account write the log of a public open-editing document; a writer that cannot read it seeds a second copy"],
  PEU: ["DENY", "SPEC §16: an unlisted document's link holders edit through /draft, not the live log"],
};

const verb = { ALLOW: "may", DENY: "may not" };

/**
 * The cases e2e/patches/controls-* turn red, written out because run.mjs
 * controls finds a target by its literal name in this file. Every one must be
 * a name the matrix below generates; the check at the end of the file fails
 * the load if one drifts.
 */
const CONTROL_TARGETS = Object.freeze([
  "A2.c18.V a viewer may not read the live log status/{doc}/y with their own ID token: DENY",
  "A2.c18.PE a non-member on a public open-editing document may read the live log status/{doc}/y with their own ID token: ALLOW",
  "A2.c6.X a signed-in stranger may not create an annotation on v1 through the Firestore rules with their own credential: DENY",
  "A2.c7.X a signed-in stranger may not create a suggestion through POST /suggestion: 404",
  "A2.c8.E an editor may not claim, accept and reject a suggestion in the app: 403",
  "A2.c17.V a viewer may not write an entry to the live log status/{doc}/y with their own ID token: DENY",
]);
const declared = new Set();
/**
 * Every case of the file: the stack's own non-answer ends it INCONCLUSIVE
 * (see the header), and its setup's resend budget starts with it.
 */
const cell = (name, opts, fn) => {
  declared.add(name);
  scenario(name, { ...opts, inconclusiveOnStackTimeout: true }, async (ctx) => {
    stopAts.set(ctx, Date.now() + ENV_BUDGET_MS);
    return fn(ctx);
  });
};

/** A step that is only for contrast: a request the stack did not answer is noted, never the case's outcome. */
async function contrast(ctx, what, send) {
  try {
    const r = await send();
    ctx.step(`for contrast, ${what}: ${r.status}`);
  } catch (err) {
    ctx.step(`for contrast, ${what}: no answer (${String(err?.message ?? err).split("\n")[0].slice(0, 160)}); not part of the oracle`);
  }
}

// c6 ---------------------------------------------------------------------------

for (const [kind, [want, why]] of Object.entries(C6)) {
  const name = `A2.c6.${kind} ${ACTORS[kind].label} ${verb[want]} create an annotation on v1 through the Firestore rules with their own credential: ${want}`;
  cell(name, { timeoutMs: CASE_MS }, async (ctx) => {
    const { owner, ownerAcct, docId, actor } = await world(ctx, kind);
    ctx.step(`expected ${want}: ${why}`);
    const who = actor.uid ? { uid: actor.uid, email: actor.email } : nobody();
    const annId = newAnnId();
    const r = await createAnnotation(ctx, kind.toLowerCase(), { docId, annId, who, idToken: actor.idToken });
    const verdict = verdictOf(r, `${kind}'s annotation`);
    const stored = await readDoc(target, annPath(docId, annId));
    ctx.step(`${kind}'s create: ${r.status} → ${verdict}; stored: ${stored ? "yes" : "no"}`);
    if (want === "ALLOW") {
      assert.equal(verdict, "ALLOW", `c6 ${kind}: expected ALLOW, the rules refused: ${r.message}`);
      assert.deepEqual(
        { authorUid: stored?.authorUid, actor: stored?.actor, resolved: stored?.resolved, exact: stored?.anchor?.exact, hasCreatedAt: typeof stored?.createdAt?.toMillis === "function" },
        { authorUid: actor.uid, actor: { uid: actor.uid, email: actor.email, channel: "web" }, resolved: false, exact: PASSAGE_1.anchor.exact, hasCreatedAt: true },
        `c6 ${kind}: the stored annotation is the actor's`,
      );
      return;
    }
    // Control: the identical write by someone who may make it is committed.
    if (kind === "X") {
      assert.equal(verdict, "DENY", `c6 X: expected DENY, the stranger's annotation was committed`);
      assert.equal(stored, null, "c6 X: nothing was stored");
      await grantRole(ctx, owner, docId, actor.account, "viewer");
      const again = await createAnnotation(ctx, "x", { docId, annId, who, idToken: actor.idToken });
      assert.equal(verdictOf(again, "X once shared"), "ALLOW", "control: the same request is committed once X is a viewer");
      return;
    }
    const ctl = await createAnnotation(ctx, "owner", { docId, annId: newAnnId(), who: { uid: owner.uid, email: ownerAcct.email.toLowerCase() }, idToken: owner.idToken });
    precondition(verdictOf(ctl, "the owner's control") === "ALLOW", "control: the owner's identical write is committed");
    assert.equal(verdict, "DENY", `c6 ${kind}: expected DENY, the annotation was committed`);
    assert.equal(stored, null, `c6 ${kind}: nothing was stored`);
  });
}

// c7 ---------------------------------------------------------------------------

for (const [kind, [want, why, error]] of Object.entries(C7)) {
  const name = `A2.c7.${kind} ${ACTORS[kind].label} ${want === 200 ? "may" : "may not"} create a suggestion through POST /suggestion: ${want}`;
  cell(name, { timeoutMs: CASE_MS }, async (ctx) => {
    const { docId, actor } = await world(ctx, kind);
    ctx.step(`expected ${want}: ${why}`);
    const body = createBody(docId, { k: actor.k });
    const r = await actor.http.postJson("/suggestion", body, slow);
    ctx.step(`${kind}'s create: ${r.status} ${r.text.slice(0, 120)}`);
    const anns = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
    if (want === 200) {
      assert.equal(r.status, 200, `c7 ${kind}: expected 200, got ${r.status} ${r.text.slice(0, 200)}`);
      assert.deepEqual(Object.keys(r.json ?? {}).sort(), ["annId", "versionId"], "c7: the answer is {annId, versionId}");
      assert.equal(r.json.versionId, "v1");
      const s = await readDoc(target, annPath(docId, r.json.annId));
      assert.deepEqual(
        { state: s?.suggestion?.state, replacement: s?.suggestion?.replacement, authorUid: s?.authorUid, actor: s?.actor ? { uid: s.actor.uid, email: s.actor.email, channel: s.actor.channel } : null, resolved: s?.resolved },
        { state: "pending", replacement: PASSAGE_1.replacement, authorUid: actor.uid, actor: { uid: actor.uid, email: actor.email, channel: "web" }, resolved: false },
        `c7 ${kind}: the stored suggestion is the actor's, pending`,
      );
      const opener = await readCollection(target, `${annPath(docId, r.json.annId)}/comments`);
      assert.deepEqual(opener.map((c) => ({ opensSuggestion: c.data.opensSuggestion, authorUid: c.data.authorUid })), [{ opensSuggestion: true, authorUid: actor.uid }], "c7: the thread opens with the suggestion");
      return;
    }
    assertRefusal(r, { status: want, error }, `c7 ${kind}`);
    assert.equal(anns.length, 0, `c7 ${kind}: no annotation was written`);
    if (want === 404) await assertAbsentParity(actor.http, body, r, `c7 ${kind}`);
  });
}

// c8 ---------------------------------------------------------------------------

for (const [kind, [want, why, error]] of Object.entries(C8)) {
  const name = `A2.c8.${kind} ${ACTORS[kind].label} ${want === 200 ? "may" : "may not"} claim, accept and reject a suggestion in the app: ${want}`;
  cell(name, { timeoutMs: LONG_MS }, async (ctx) => {
    const { owner, docId, actor } = await world(ctx, kind);
    ctx.step(`expected ${want}: ${why}`);
    const first = await ownerSuggests(ctx, owner, docId, PASSAGE_1);
    const decide = (op, annId) => actor.http.postJson("/suggestion", { op, docId, versionId: "v1", annId, ...(actor.k ? { k: actor.k } : {}) }, slow);
    if (want === 200) {
      const second = await ownerSuggests(ctx, owner, docId, PASSAGE_2);
      const claim = await decide("claim", first);
      assert.equal(claim.status, 200, `c8 ${kind} claim: expected 200, got ${claim.status} ${claim.text.slice(0, 200)}`);
      assert.deepEqual(claim.json, { state: "pending" });
      assert.equal((await readDoc(target, annPath(docId, first)))?.suggestion?.claim?.uid, actor.uid, `c8 ${kind}: the claim is the actor's`);
      // Accepting records what the approver's editor already applied and saved (SPEC §22, ADR 0013).
      const html = readFixture(FIXTURE, { raw: true }).toString("utf8").replace(PASSAGE_1.anchor.exact, PASSAGE_1.replacement);
      const draft = await actor.http.postJson("/draft", { docId, baseVersion: "v1", html }, slow);
      precondition(draft.status === 200, `the actor's draft with the change applied was saved (${draft.status} ${draft.text.slice(0, 200)})`);
      const accept = await decide("accept", first);
      assert.equal(accept.status, 200, `c8 ${kind} accept: expected 200, got ${accept.status} ${accept.text.slice(0, 200)}`);
      assert.deepEqual(accept.json, { state: "accepted" });
      const reject = await decide("reject", second);
      assert.equal(reject.status, 200, `c8 ${kind} reject: expected 200, got ${reject.status} ${reject.text.slice(0, 200)}`);
      assert.deepEqual(reject.json, { state: "rejected" });
      for (const [annId, state, note] of [[first, "accepted", "Accepted."], [second, "rejected", "Rejected."]]) {
        const s = await readDoc(target, annPath(docId, annId));
        assert.deepEqual(
          { state: s?.suggestion?.state, decidedBy: s?.suggestion?.decidedBy ? { uid: s.suggestion.decidedBy.uid, channel: s.suggestion.decidedBy.channel } : null, claim: s?.suggestion?.claim ?? null, resolved: s?.resolved },
          { state, decidedBy: { uid: actor.uid, channel: "web" }, claim: null, resolved: true },
          `c8 ${kind}: ${state} by the actor`,
        );
        // The decision's note, not the opener (which is the owner's own when the owner decides).
        const notes = (await readCollection(target, `${annPath(docId, annId)}/comments`)).filter((c) => c.data.generated === true && c.data.opensSuggestion !== true && c.data.authorUid === actor.uid);
        assert.deepEqual(notes.map((c) => c.data.body), [note], `c8 ${kind}: the thread says ${note}`);
      }
      return;
    }
    for (const op of ["claim", "accept", "reject"]) {
      const r = await decide(op, first);
      ctx.step(`${kind} ${op}: ${r.status} ${r.text.slice(0, 120)}`);
      assertRefusal(r, { status: want, error }, `c8 ${kind} ${op}`);
      if (want === 404) await assertAbsentParity(actor.http, { op, docId, versionId: "v1", annId: first }, r, `c8 ${kind} ${op}`);
    }
    await assertUndecided(docId, first, `c8 ${kind}`);
  });
}

cell("A2.c8.A-token an approver's personal access token may not claim, accept or reject through POST /suggestion: 403", { timeoutMs: LONG_MS }, async (ctx) => {
  const { owner, docId, actor } = await world(ctx, "A");
  ctx.step("expected 403 with the in-the-app sentence: SPEC §2 \"claim, accept and reject refuse a token with 403\"");
  const annId = await ownerSuggests(ctx, owner, docId, PASSAGE_1);
  // POST /tokens may be sent again: an unanswered mint leaves at most an unused token behind.
  const { out: minted } = await untilLanded(ctx, "POST /tokens (cli)", () => mintToken(actor.session, { name: "e2e a2 approver cli", channel: "cli" }), null, patience(ctx));
  const { token } = minted;
  // The token as its only credential (what bearerHttp sends), traced into this case.
  const viaToken = fnHttp(ctx, "approver-token", { authorization: `Bearer ${token}` });
  for (const op of ["claim", "accept", "reject"]) {
    const r = await viaToken.postJson("/suggestion", { op, docId, versionId: "v1", annId }, slow);
    ctx.step(`token ${op}: ${r.status} ${r.text.slice(0, 160)}`);
    assertRefusal(r, { status: 403, error: MSG.inTheApp }, `c8 A-token ${op}`);
  }
  await assertUndecided(docId, annId, "c8 A-token");
  // Control: the same approver, with the session, holds the role.
  const claim = await actor.http.postJson("/suggestion", { op: "claim", docId, versionId: "v1", annId }, slow);
  assert.equal(claim.status, 200, `control: the approver's session claims it (${claim.status} ${claim.text.slice(0, 200)})`);
});

// c17 --------------------------------------------------------------------------

for (const [kind, [want, why]] of Object.entries(C17)) {
  const name = `A2.c17.${kind} ${ACTORS[kind].label} ${verb[want]} write an entry to the live log status/{doc}/y with their own ID token: ${want}`;
  cell(name, { timeoutMs: CASE_MS }, async (ctx) => {
    await rulesEnforced(ctx);
    const { owner, docId, actor } = await world(ctx, kind, { rtdb: true });
    ctx.step(`expected ${want}: ${why}`);
    const db = rtdbFor(ctx, kind.toLowerCase(), actor.idToken);
    const entry = newEntry(kind);
    const r = await db.put(`${await liveLogPath(target, docId)}/${entry}`, EMPTY_UPDATE);
    const verdict = verdictOf(r, `${kind}'s write`);
    const stored = await rtdbGet(target, `${await liveLogPath(target, docId)}/${entry}`);
    ctx.step(`${kind}'s write: ${r.status} → ${verdict}; stored: ${JSON.stringify(stored)}`);
    if (want === "ALLOW") {
      assert.equal(verdict, "ALLOW", `c17 ${kind}: expected ALLOW, the rules refused`);
      assert.equal(stored, EMPTY_UPDATE, `c17 ${kind}: the entry is in the log`);
      return;
    }
    if (kind === "X") {
      assert.equal(verdict, "DENY", "c17 X: expected DENY, the stranger's entry was written");
      assert.equal(stored, null, "c17 X: nothing was written");
      const g = await grantRole(ctx, owner, docId, actor.account, "editor");
      precondition(g.mirror?.ok, `X's editor mirror: ${JSON.stringify(g.mirror)}`);
      const again = await db.put(`${await liveLogPath(target, docId)}/${entry}`, EMPTY_UPDATE);
      assert.equal(verdictOf(again, "X once an editor"), "ALLOW", "control: the same write is allowed once X is an editor");
      return;
    }
    const ctl = await rtdbFor(ctx, "owner", owner.idToken).put(`${await liveLogPath(target, docId)}/${newEntry("O")}`, EMPTY_UPDATE);
    precondition(verdictOf(ctl, "the owner's control") === "ALLOW", "control: the owner's identical write is allowed");
    assert.equal(verdict, "DENY", `c17 ${kind}: expected DENY, the entry was written`);
    assert.equal(stored, null, `c17 ${kind}: nothing was written`);
  });
}

// c18 --------------------------------------------------------------------------

for (const [kind, [want, why, defect]] of Object.entries(C18)) {
  const name = `A2.c18.${kind} ${ACTORS[kind].label} ${verb[want]} read the live log status/{doc}/y with their own ID token: ${want}`;
  cell(name, { timeoutMs: CASE_MS, ...(defect ? { defect } : {}) }, async (ctx) => {
    await rulesEnforced(ctx);
    const { owner, docId, actor } = await world(ctx, kind, { rtdb: true });
    ctx.step(`expected ${want}: ${why}`);
    const db = rtdbFor(ctx, kind.toLowerCase(), actor.idToken);
    const asOwner = rtdbFor(ctx, "owner", owner.idToken);
    // An unsaved entry by the owner, so a read that is allowed shows real content.
    const entry = newEntry("O");
    const seed = await asOwner.put(`${await liveLogPath(target, docId)}/${entry}`, EMPTY_UPDATE);
    precondition(verdictOf(seed, "the owner's entry") === "ALLOW", "the owner wrote an entry to the live log");
    const r = await db.get(`status/${docId}/y`);
    const verdict = verdictOf(r, `${kind}'s read`);
    const sees = verdict === "ALLOW" && flattenLiveLogs(r.json)[`${(await liveLogPath(target, docId)).split("/").at(-1)}/${entry}`] === EMPTY_UPDATE;
    ctx.step(`${kind}'s read: ${r.status} → ${verdict}; sees the owner's unsaved entry: ${sees}`);
    if (defect === "S26") {
      // The contrast S26 is about: the endpoint that serves the draft refuses this reader (SPEC §2).
      const entryFile = (await readDoc(target, `docs/${docId}/versions/v1`))?.entry ?? "index.html";
      await contrast(ctx, `GET /draft as ${kind} (SPEC §2: editor-gated)`, () => actor.http.get(`/draft/${encodeURIComponent(docId)}/${entryFile.split("/").map(encodeURIComponent).join("/")}`, slow));
    }
    if (want === "ALLOW") {
      assert.equal(verdict, "ALLOW", `c18 ${kind}: expected ALLOW, the rules refused the read${defect ? ` (${defect})` : ""}`);
      assert.ok(sees, `c18 ${kind}: the read returns the owner's entry: ${JSON.stringify(r.json).slice(0, 200)}`);
      return;
    }
    if (kind === "X") {
      assert.equal(verdict, "DENY", "c18 X: expected DENY, the stranger read the live log");
      const g = await grantRole(ctx, owner, docId, actor.account, "editor");
      precondition(g.mirror?.ok, `X's editor mirror: ${JSON.stringify(g.mirror)}`);
      const again = await db.get(`status/${docId}/y`);
      assert.equal(verdictOf(again, "X once an editor"), "ALLOW", "control: the same read is allowed once X is an editor");
      return;
    }
    const ctl = await asOwner.get(`status/${docId}/y`);
    precondition(verdictOf(ctl, "the owner's control") === "ALLOW", "control: the owner's identical read is allowed");
    assert.equal(verdict, "DENY", `c18 ${kind}: expected DENY, ${ACTORS[kind].label} read the live log${sees ? ", including the owner's unsaved entry" : ""}${defect ? ` (${defect})` : ""}`);
  });
}

// --- Expired (the plan's "Expired" row) ------------------------------------------

/**
 * An editor and the owner on a document that has just expired. `before(w)`
 * runs while it is still live; then the owner sets an expiry 2.5 s ahead
 * (longer only when the request reached the function after that moment)
 * through POST /visibility (a past date is refused, SPEC §17) and the case
 * WAITS for it to pass: expiry is time-based and there is no scheduler, so
 * the wait is the product's own semantics, not a settle. The product itself
 * must then call it expired: the owner's POST /draft answers 409.
 */
async function expiredWorld(ctx, before) {
  const w = await world(ctx, "E", { rtdb: true });
  const pre = before ? await before(w) : null;
  // The expiry must still be in the future when the function reads its clock;
  // on a queued stack the request can arrive late, so a refused lead is retried longer.
  let at = null;
  for (const lead of [2_500, 10_000, 30_000, 90_000]) {
    const want = Date.now() + lead;
    const v = await setVisibility(target, { owner: w.owner, doc: w.docId, visibility: "private", expiresAt: want, expect: [200, 400], timeoutMs: REQ_MS });
    if (v.status === 200) {
      precondition(v.expiresAt === want, `the expiry was set (${JSON.stringify(v.json)})`);
      at = want;
      break;
    }
    precondition(v.json?.error === "an expiry must be in the future", `POST /visibility with an expiry answered 400 ${JSON.stringify(v.json)}`);
    ctx.step(`an expiry ${lead} ms ahead arrived in the past (the request queued); trying a longer lead`);
  }
  precondition(at !== null, "an expiry in the future was accepted");
  const waitMs = at + 300 - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  const doc = await readDoc(target, `docs/${w.docId}`);
  precondition(typeof doc?.expiresAt?.toMillis === "function" && doc.expiresAt.toMillis() <= Date.now(), "the document's expiry has passed");
  const html = readFixture(FIXTURE, { raw: true }).toString("utf8");
  const frozen = await w.owner.http.postJson("/draft", { docId: w.docId, baseVersion: "v1", html }, slow);
  precondition(frozen.status === 409 && frozen.json?.error === MSG.expired, `the product calls the document expired: the owner's POST /draft answered ${frozen.status} ${frozen.text.slice(0, 160)}`);
  ctx.step(`${w.docId} expired at ${new Date(at).toISOString()}; the owner's POST /draft is 409 expired`);
  return { ...w, pre };
}

cell("A2.c7.Exp-E an editor may not create a suggestion on an expired document: 409", { timeoutMs: CASE_MS }, async (ctx) => {
  ctx.step("expected 409: SPEC §2 /suggestion \"an expired document 409\"; SPEC §17 \"Writing is refused for everyone\"");
  const w = await expiredWorld(ctx, async ({ docId, actor }) => {
    const r = await actor.http.postJson("/suggestion", createBody(docId, { passage: PASSAGE_2 }), slow);
    precondition(r.status === 200, `control: before the expiry the editor's suggestion is created (${r.status})`);
  });
  const r = await w.actor.http.postJson("/suggestion", createBody(w.docId), slow);
  assertRefusal(r, { status: 409, error: MSG.expired }, "c7 Exp-E");
  assert.equal((await readCollection(target, `docs/${w.docId}/versions/v1/annotations`)).length, 1, "c7 Exp-E: only the suggestion from before the expiry exists");
});

cell("A2.c7.Exp-O the owner may not create a suggestion on an expired document: 409", { timeoutMs: CASE_MS }, async (ctx) => {
  ctx.step("expected 409: SPEC §17 \"Writing is refused for everyone, the owner included\"");
  const w = await expiredWorld(ctx);
  const r = await w.owner.http.postJson("/suggestion", createBody(w.docId), slow);
  assertRefusal(r, { status: 409, error: MSG.expired }, "c7 Exp-O");
  assert.equal((await readCollection(target, `docs/${w.docId}/versions/v1/annotations`)).length, 0, "c7 Exp-O: no annotation was written");
});

for (const who of ["O", "E"]) {
  cell(`A2.c8.Exp-${who} ${who === "O" ? "the owner" : "an editor"} may not claim, accept or reject a suggestion on an expired document: 409`, { timeoutMs: CASE_MS }, async (ctx) => {
    ctx.step("expected 409 for every decision: SPEC §2 /suggestion \"an expired document 409\", checked before the role");
    const w = await expiredWorld(ctx, async ({ owner, docId }) => ownerSuggests(ctx, owner, docId, PASSAGE_1));
    const http = who === "O" ? w.owner.http : w.actor.http;
    for (const op of ["claim", "accept", "reject"]) {
      const r = await http.postJson("/suggestion", { op, docId: w.docId, versionId: "v1", annId: w.pre }, slow);
      ctx.step(`${who} ${op}: ${r.status}`);
      assertRefusal(r, { status: 409, error: MSG.expired }, `c8 Exp-${who} ${op}`);
    }
    await assertUndecided(w.docId, w.pre, `c8 Exp-${who}`);
  });
}

/**
 * c6 on an expired document. SPEC §17: "Expiry is not in the Firestore rules,
 * and cannot be … a member still sees the row, its title and its comments";
 * annotation writes remain deliberately independent of content expiry. So
 * the rules still commit a direct annotation, for the editor and the owner
 * alike. That this sits uneasily with "Writing is refused for everyone" is
 * reported for a decision (I), not tagged as a defect.
 */
for (const who of ["E", "O"]) {
  cell(`A2.c6.Exp-${who} ${who === "O" ? "the owner" : "an editor"} may create an annotation on an expired document through the Firestore rules, which do not see expiry: ALLOW`, { timeoutMs: CASE_MS }, async (ctx) => {
    ctx.step("expected ALLOW: SPEC §17 \"Expiry is not in the Firestore rules\"; the enforcement list (isExpired in lib/acl.ts) names functions only");
    const as = (w) => (who === "O" ? { uid: w.owner.uid, email: w.ownerAcct.email.toLowerCase(), idToken: w.owner.idToken } : { uid: w.actor.uid, email: w.actor.email, idToken: w.actor.idToken });
    const w = await expiredWorld(ctx);
    const me = as(w);
    const annId = newAnnId();
    const r = await createAnnotation(ctx, who.toLowerCase(), { docId: w.docId, annId, who: { uid: me.uid, email: me.email }, idToken: me.idToken });
    const verdict = verdictOf(r, "after the expiry");
    const stored = await readDoc(target, annPath(w.docId, annId));
    ctx.step(`${who}'s create after the expiry: ${r.status} → ${verdict}; stored: ${stored ? "yes" : "no"}`);
    assert.equal(verdict, "ALLOW", `c6 Exp-${who}: expected ALLOW (the rules do not see expiry), the rules refused: ${r.message}`);
    assert.equal(stored?.authorUid, me.uid, `c6 Exp-${who}: the annotation is stored as ${who}'s`);
  });
}

cell("A2.c17.Exp-E an editor may not write to the live log of an expired document: DENY", { timeoutMs: CASE_MS }, async (ctx) => {
  await rulesEnforced(ctx);
  ctx.step("expected DENY: SPEC §17 \"An expired document is read-only\" and \"Writing is refused for everyone\"; the log replays into the draft on the next open (SPEC §6b)");
  const w = await expiredWorld(ctx, async ({ docId, actor }) => {
    const r = await rtdbFor(ctx, "e", actor.idToken).put(`${await liveLogPath(target, docId)}/${newEntry("E")}`, EMPTY_UPDATE);
    precondition(verdictOf(r, "before the expiry") === "ALLOW", "control: before the expiry the editor writes to the log");
  });
  const entry = newEntry("E");
  const r = await rtdbFor(ctx, "e", w.actor.idToken).put(`${await liveLogPath(target, w.docId)}/${entry}`, EMPTY_UPDATE);
  const verdict = verdictOf(r, "after the expiry");
  const stored = await rtdbGet(target, `${await liveLogPath(target, w.docId)}/${entry}`);
  ctx.step(`the editor's write after the expiry: ${r.status} → ${verdict}; stored: ${JSON.stringify(stored)}`);
  assert.equal(verdict, "DENY", "c17 Exp-E: expected DENY, the editor wrote to the live log of an expired (frozen) document");
  assert.equal(stored, null, "c17 Exp-E: nothing was written");
});

cell("A2.c17.Exp-O the owner may not write to the live log of an expired document: DENY", { timeoutMs: CASE_MS }, async (ctx) => {
  await rulesEnforced(ctx);
  ctx.step("expected DENY: SPEC §17 \"Writing is refused for everyone, the owner included — an expired document is frozen\"");
  const w = await expiredWorld(ctx, async ({ owner, docId }) => {
    const r = await rtdbFor(ctx, "owner", owner.idToken).put(`${await liveLogPath(target, docId)}/${newEntry("O")}`, EMPTY_UPDATE);
    precondition(verdictOf(r, "before the expiry") === "ALLOW", "control: before the expiry the owner writes to the log");
  });
  const entry = newEntry("O");
  const r = await rtdbFor(ctx, "owner", w.owner.idToken).put(`${await liveLogPath(target, w.docId)}/${entry}`, EMPTY_UPDATE);
  const verdict = verdictOf(r, "after the expiry");
  const stored = await rtdbGet(target, `${await liveLogPath(target, w.docId)}/${entry}`);
  ctx.step(`the owner's write after the expiry: ${r.status} → ${verdict}; stored: ${JSON.stringify(stored)}`);
  assert.equal(verdict, "DENY", "c17 Exp-O: expected DENY, the owner wrote to the live log of an expired (frozen) document");
  assert.equal(stored, null, "c17 Exp-O: nothing was written");
});

/** Seed one owner entry before the expiry and check `reader` saw it then; returns the entry's key. */
async function seedLogBeforeExpiry(ctx, { owner, docId, actor }, reader) {
  const entry = newEntry("O");
  const seed = await rtdbFor(ctx, "owner", owner.idToken).put(`${await liveLogPath(target, docId)}/${entry}`, EMPTY_UPDATE);
  precondition(verdictOf(seed, "the owner's entry") === "ALLOW", "the owner wrote an entry to the live log");
  const token = reader === "O" ? owner.idToken : actor.idToken;
  const r = await rtdbFor(ctx, reader.toLowerCase(), token).get(`status/${docId}/y`);
  precondition(verdictOf(r, "before the expiry") === "ALLOW" && flattenLiveLogs(r.json)[`${(await liveLogPath(target, docId)).split("/").at(-1)}/${entry}`] === EMPTY_UPDATE, `control: before the expiry ${reader} reads the log`);
  return entry;
}

cell("A2.c18.Exp-E an editor may not read the live log of an expired document: DENY", { timeoutMs: CASE_MS }, async (ctx) => {
  await rulesEnforced(ctx);
  ctx.step("expected DENY: SPEC §17 \"visible only to its owner\" and \"what they cannot get is the document\"; the log is unsaved document content");
  const w = await expiredWorld(ctx, (w0) => seedLogBeforeExpiry(ctx, w0, "E"));
  const r = await rtdbFor(ctx, "e", w.actor.idToken).get(`status/${w.docId}/y`);
  const verdict = verdictOf(r, "after the expiry");
  const sees = verdict === "ALLOW" && flattenLiveLogs(r.json)[`${(await liveLogPath(target, w.docId)).split("/").at(-1)}/${w.pre}`] === EMPTY_UPDATE;
  ctx.step(`the editor's read after the expiry: ${r.status} → ${verdict}; sees the owner's entry: ${sees}`);
  const entryFile = (await readDoc(target, `docs/${w.docId}/versions/v1`))?.entry ?? "index.html";
  await contrast(ctx, "GET /content as the editor after the expiry (SPEC §17: the same 404 as a document they may not read)", () => w.actor.http.get(`/content/${encodeURIComponent(w.docId)}/v1/${entryFile.split("/").map(encodeURIComponent).join("/")}`, slow));
  assert.equal(verdict, "DENY", `c18 Exp-E: expected DENY, the editor read the live log of an expired document${sees ? ", the owner's unsaved entry included" : ""}`);
});

cell("A2.c18.Exp-O the owner may read the live log of an expired document: ALLOW", { timeoutMs: CASE_MS }, async (ctx) => {
  await rulesEnforced(ctx);
  ctx.step("expected ALLOW: SPEC §17 \"The owner keeps reading it\"");
  const w = await expiredWorld(ctx, (w0) => seedLogBeforeExpiry(ctx, w0, "O"));
  const r = await rtdbFor(ctx, "owner", w.owner.idToken).get(`status/${w.docId}/y`);
  const verdict = verdictOf(r, "after the expiry");
  ctx.step(`the owner's read after the expiry: ${r.status} → ${verdict}`);
  assert.equal(verdict, "ALLOW", "c18 Exp-O: expected ALLOW, the rules refused the owner's read");
  assert.equal(flattenLiveLogs(r.json)[`${(await liveLogPath(target, w.docId)).split("/").at(-1)}/${w.pre}`], EMPTY_UPDATE, "c18 Exp-O: the read returns the entry from before the expiry");
});

// --- A11.11 --------------------------------------------------------------------------

cell("A11.11 the live-editing rules reject a lock node, a request node, an unknown peer field, another account's peer key and a lastChanged that is not the server's now", { timeoutMs: CASE_MS }, async (ctx) => {
  await rulesEnforced(ctx);
  const { owner, docId, actor } = await world(ctx, "E", { rtdb: true });
  ctx.step("expected: every malformed write DENY, the well-formed peer write ALLOW (database.rules.json status/$docId: peers/$uid .validate and $other; SPEC §16 withdrew lock and requests)");
  const db = rtdbFor(ctx, "e", actor.idToken);
  const now = { ".sv": "timestamp" };
  const peer = { email: actor.email, mode: "edit", lastChanged: now };
  const cells = [
    ["the withdrawn lock node", `status/${docId}/lock`, { uid: actor.uid, email: actor.email, since: now }],
    ["the withdrawn requests node", `status/${docId}/requests/${actor.uid}`, { email: actor.email, at: now }],
    ["a peer field the schema does not name", `status/${docId}/peers/${actor.uid}`, { ...peer, cursor: "x" }],
    ["another account's peer key", `status/${docId}/peers/${owner.uid}`, { ...peer }],
    ["a client-chosen lastChanged", `status/${docId}/peers/${actor.uid}`, { ...peer, lastChanged: Date.now() - 60_000 }],
    ["an email that is not the caller's", `status/${docId}/peers/${actor.uid}`, { ...peer, email: owner.account.email.toLowerCase() }],
  ];
  const got = [];
  for (const [what, path, value] of cells) {
    const r = await db.put(path, value);
    got.push({ what, verdict: verdictOf(r, what) });
  }
  ctx.step(`malformed writes: ${got.map((g) => `${g.what} → ${g.verdict}`).join("; ")}`);
  const ok = await db.put(`status/${docId}/peers/${actor.uid}`, peer);
  const okVerdict = verdictOf(ok, "the well-formed peer");
  const stored = await rtdbGet(target, `status/${docId}`);
  ctx.step(`well-formed peer: ${okVerdict}; stored status: ${JSON.stringify(stored)}`);
  assert.equal(okVerdict, "ALLOW", "control: a well-formed peer node with the server's timestamp is allowed");
  assert.deepEqual(got.filter((g) => g.verdict !== "DENY").map((g) => g.what), [], "every malformed write is rejected");
  assert.deepEqual(Object.keys(stored ?? {}).sort(), ["peers"], "nothing but peers was written under status/{doc}");
  assert.deepEqual(Object.keys(stored.peers).sort(), [actor.uid], "only the caller's own peer node exists");
  assert.deepEqual(Object.keys(stored.peers[actor.uid]).sort(), ["email", "lastChanged", "mode"], "the peer node holds exactly the fields written");
  assert.equal(typeof stored.peers[actor.uid].lastChanged, "number");
});

for (const name of CONTROL_TARGETS) {
  if (!declared.has(name)) throw new Error(`a02-matrix-data: control target ${JSON.stringify(name)} is not a case this file declares`);
}
