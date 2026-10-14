// SPDX-License-Identifier: Apache-2.0
// Sharing a run document, folder or team with run accounts, and a document's link or public window, which always closes: POST /access or the operator script, /folder-access, /team-members, POST /visibility (SPEC §13, §16, §17, §18).

/**
 * share(target, {owner, doc, account | team, role})
 *
 *   LOCAL  the real path: POST /access as the owner, {docId, add:[{email, role}]}
 *          for a person, {docId, add:[{principal: "team:<id>", role}]} for a
 *          team. That sends an invitation into Mailpit, which is what local
 *          is for.
 *   PROD   POST /access emails the grantee, so it is refused by the guard.
 *          Instead the operator's scripts/set-access.mjs (Admin credentials,
 *          no email; it takes `team:<id>` too) — implemented here, not run in
 *          this build.
 *
 * Either way the RTDB mirrors are then read back through Admin:
 * presenceAccess/{doc}/{emailKey} for every member, editAccess/{doc}/{emailKey}
 * for editors and approvers; for a team, every member the team record names
 * (readTeamMirror). A missing mirror is recorded in
 * <runDir>/findings.jsonl (it is suspect S16 on production) rather than
 * thrown, so the caller decides what it means; `mirror.ok` says.
 * `timeoutMs` (share, unshare) is the request's: POST /access locally (the
 * http client's 60 s otherwise), the operator script on production (120 s
 * otherwise). share() returns {status, json, members, mirror, response}:
 * `response` the http.mjs answer to POST /access (null from the operator
 * script).
 *
 * PATIENT. share(target, {…, patient: {ctx, attempts, lookupMs, intervalMs,
 * stopAt}}) sends a grant the stack did not answer again, through
 * lib/test.mjs untilLanded, after looking for its effect in the record:
 * POST /access writes the grant lists into docs/<id> (with a new `updatedAt`)
 * in one batch, then the RTDB mirrors, then answers (functions/src/lib/
 * folders.ts persistDocMembership). The effect is the record's `updatedAt`
 * moved since just before the first request and the principal in
 * docs/<id>[GRANT_LIST[role]] and in no other role's list (a principal holds
 * one role: a change of role moves it). Found, the grant is ledgered as an
 * answered one is, its mirror is read (`verify`) until it is there or
 * `lookupMs` pass, since the function writes it next, and share returns
 * {status: null, json: null, members (the record's), mirror, response: null,
 * landed: true}; an answer is returned as before, with `landed: false`. The
 * record is read through Admin, so only on a target with the
 * "admin-emulator" capability, on production, or with `admin`, a stand-in
 * {readDoc, rtdbGet[, emailKey]} (self-tests); anything else throws before
 * anything is sent, as does a malformed `patient`.
 *
 * SEVERAL AT ONCE. shareMany(target, {owner, doc, grants: [{account | team,
 * role}], …}) is ONE POST /access {docId, add: [...]} as the owner, each
 * entry as share() sends it, in the order given: the shape the product
 * handles as one request (each new member is invited inside it, so "the next
 * recipient in the same request" is testable), and one request instead of
 * several racing grants (S18). LOCAL ONLY: the endpoint emails every new
 * member, so on any other target it throws E2E_LOCAL_ONLY before sending
 * anything (production's path is share() per grant, through the operator
 * script). A 200 (also one `expect` refused) ledgers one row per principal,
 * {kind: "grant", docId, email: <principal>, role, via: "access"}; `verify`
 * reads each grant's mirror as share() does.
 *
 * FOLDERS AND TEAMS. shareFolder / unshareFolder are POST /folder-access as
 * the owner, LOCAL ONLY: the endpoint emails every new member, and
 * scripts/set-access.mjs takes documents only, so production has no path at
 * all and they throw E2E_LOCAL_ONLY there before sending anything (a case
 * declares effects: ["email:POST /folder-access"] and is skipped there). A
 * folder grant is ledgered as {kind: "grant", folderId, email: <principal>,
 * role, via: "folder-access"}. teamMembers is POST /team-members (refused on
 * production by the guard, as createTeam's POST /team is). A principal is an
 * email or `team:<teamId>` (principalOf).
 *
 * WINDOWS. A document made unlisted or public is open to people outside the
 * run, so it stays open no longer than the case that opened it (production
 * keeps such windows to minutes):
 *
 *   setVisibility(target, {owner, doc, visibility, expiresAt, publicEdit, expect = 200, timeoutMs, patient, admin})
 *       POST /visibility as the owner, sending `expiresAt` and `publicEdit`
 *       only when given (S25: an absent expiresAt CLEARS the expiry). An
 *       unlisted or public answer opens a WINDOW on the document; a private
 *       one closes it. Returns {status, json, visibility, publicEdit,
 *       linkToken, expiresAt, response}. With `patient: {ctx, attempts,
 *       lookupMs, intervalMs, stopAt}`, a request the stack did not answer
 *       is sent again through lib/test.mjs untilLanded, after looking for
 *       its effect in the record (see WHEN THE STACK DID NOT ANSWER), and
 *       the result also has `landed` (true when the effect was found instead
 *       of an answer: then `status`, `json` and `response` are null and the
 *       rest is read from the record).
 *   trackWindow(target, {owner, doc, visibility = "public", admin})
 *       register a window opened some other way (the Share dialog), so it is
 *       closed the same way.
 *   openWindows({scope})  → [{docId, visibility, since}]
 *   closeWindows({scope, attempts = 2, lookupMs = 60_000, intervalMs = 2_000, admin})
 *         → {closed: [{docId, status, via}], failed: [{docId, visibility, status, error, record}]}
 *       POST /visibility {visibility: "private"} as each window's owner. A
 *       200 that says private closes it, and so does a 404 (an owner's 404
 *       means the document is gone): `via` "answer". A 5xx or no answer is
 *       tried again. After a 504 or no answer at all, the function may still
 *       be closing it, so the record is read (every `intervalMs`, for up to
 *       `lookupMs`) before anything is sent again: the window is closed, `via`
 *       "record", once docs/<id> says private (or is gone), public/<id> is
 *       gone and the RTDB gate editAccess/<id>/* that opens live editing to
 *       any account is not set. A window that would not close stays
 *       registered and is recorded in findings.jsonl (kind "window-open"),
 *       with `record` what the record last said ({visibility, projection,
 *       openEdit}; never its link token). Never throws.
 *   withVisibility(target, {owner, doc, visibility, expiresAt, publicEdit, timeoutMs}, fn)  → what fn returns
 *       a window for the length of `fn` only: setVisibility opens it
 *       (unlisted or public; anything but a 200 throws and fn never runs),
 *       fn(answer) runs with setVisibility's answer, and the document is made
 *       private again (as closeWindows does it) as soon as fn returns or
 *       throws, so the case's next line runs on a private document. fn's own
 *       error is what the block throws. When fn returned and the close fails,
 *       the block throws E2E_WINDOW_OPEN (err.failed as closeWindows' failed),
 *       and the window stays registered for the case's end to try again.
 *
 * Each scenario() case has its own registry (withWindowScope): it closes the
 * case's windows when the case ends, pass or fail, and a window that will not
 * close FAILS a case that otherwise passed (E2E_WINDOW_OPEN). A window opened
 * outside any case (a before() hook) is the process's: close it with
 * closeWindows() in after(). A request that got no answer leaves a window
 * open, because the document may be open, and so does one answered 504 (the
 * product never answers 504: it is Hosting's cut-off, and the function may go
 * on to open the document); a refusal leaves it as it was.
 *
 * WHEN THE STACK DID NOT ANSWER. The record is read through the Admin SDK
 * (lib/admin.mjs: a local stack's emulators, or production's ADC), so only on
 * a target with the "admin-emulator" capability, on production, or with
 * `admin`, a stand-in {readDoc, rtdbGet} for self-tests (setVisibility and
 * trackWindow keep it on the window, for its close). POST /visibility writes
 * docs/<id> (with a new `updatedAt`), then public/<id> (made for a public
 * document, deleted otherwise), then the RTDB gate, and answers only after
 * all three, so a patient setVisibility takes its effect only when all three
 * say what was asked: the record's `updatedAt` moved since just before the
 * first request, its visibility (and `publicEdit`, when given) is the one
 * asked, an unlisted one has a link token, the projection exists exactly
 * when public, and the open-edit gate is set exactly when public with
 * publicEdit.
 *
 * THE MIRROR, WRITTEN BY THE HARNESS (suspect S16). scripts/set-access.mjs
 * writes no presenceAccess/editAccess mirror today (its Admin app has no
 * databaseURL, so getRtdb() is null), so a grant made through the operator
 * script leaves the grantee out of both, and the realtime rules refuse its
 * presence and every write it makes to the live log while it shows
 * "Shared". The plan ("Sharing without email"): record the finding, then
 * write the mirror the way functions/src/lib/presence.ts syncPresenceAccess
 * does, for run documents only. writeMirror(target, {doc}) reads docs/<id>
 * through Admin and writes ONE multi-path update at the database root,
 * {"presenceAccess/<id>": its members keyed, "editAccess/<id>": its
 * editorMembers keyed} (mirrorUpdate: what the grant path,
 * persistDocMembership, and set-access.mjs's own twin would have written;
 * no open-edit key), as the database's admin (the emulator's `Bearer
 * owner` on a local stack, the operator's ADC elsewhere). It goes through
 * createHttp (the isolation check, a redacted row in the case's http.jsonl)
 * with its own narrow guard, mirrorWriteVerdict, in place of the zero-email
 * guard (whose RTDB_REST lets a run write only under status/<run doc>): a
 * PATCH of the database root, with the target's own query, of exactly the
 * two nodes of a document in the run's ledger, naming run accounts only.
 * Anything else is E2E_GUARD with nothing sent, on every target. A write
 * made is recorded in findings.jsonl ({kind: "mirror-written", suspect:
 * "S16"}) beside share()'s "mirror-missing". live.mjs grantEditors calls
 * it with `mirror: "write-missing"`, on the operator path only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.mjs";
import { appendLedger, ledgerAccounts, ledgerDocIds } from "./ledger.mjs";
import { createHttp } from "./http.mjs";
import { spawnCapture } from "./cli.mjs";
import { scrubEnv } from "./proc.mjs";

export const ROLES = Object.freeze(["viewer", "suggester", "editor", "approver"]);
/**
 * The field of a document's (or folder's) record that holds each role's
 * direct grants: functions/src/lib/access.ts GRANT_LIST, pinned here
 * (selftest/share-patient.test.mjs reads the product's and compares).
 */
export const GRANT_LIST = Object.freeze({ viewer: "viewers", suggester: "suggesters", editor: "editors", approver: "approvers" });
const EDITING_ROLES = new Set(["editor", "approver"]);
/** A team id the product accepts in a principal (functions/src/lib/access.ts TEAM_ID_RE). */
const TEAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function docIdOf(doc) {
  const id = typeof doc === "string" ? doc : doc?.docId;
  if (!id) throw new Error("share: a document id is required");
  return id;
}

function emailOf(account) {
  const e = typeof account === "string" ? account : account?.email;
  if (!e) throw new Error("share: an account (or an email) is required");
  return String(e).toLowerCase();
}

/** Record a finding the run should report (never thrown). */
export function recordFinding(target, finding) {
  mkdirSync(target.runDir, { recursive: true });
  const row = { t: new Date().toISOString(), runId: target.runId, ...finding };
  appendFileSync(join(target.runDir, "findings.jsonl"), JSON.stringify(row) + "\n");
  return row;
}

/**
 * share()'s and unshare()'s grantee: a person (`account`: an email or
 * {email}, lower-cased as before) or a team (`team`: a team id, `team:<id>`
 * or a createTeam result; or an `account` that is one of those last two),
 * whose id keeps its case. → {principal, teamId (null for a person)}.
 */
function granteeOf({ account, team }, who) {
  const teamRef = (v) => (typeof v === "string" && v.trim().startsWith("team:")) || (v !== null && typeof v === "object" && "teamId" in v);
  if (team !== undefined && team !== null) {
    if (account !== undefined && account !== null) throw new Error(`${who}: give an account or a team, not both`);
  } else if (teamRef(account)) {
    team = account;
  } else {
    return { principal: emailOf(account), teamId: null };
  }
  const raw = typeof team === "string" ? team.trim() : team?.teamId;
  const teamId = typeof raw === "string" && raw.startsWith("team:") ? raw.slice("team:".length) : raw;
  if (typeof teamId !== "string" || !TEAM_ID_RE.test(teamId)) {
    throw new Error(`${who}: a team is a team id, "team:<id>" or a createTeam result (the id ${TEAM_ID_RE}), got ${JSON.stringify(typeof team === "object" ? team?.teamId : team)}`);
  }
  return { principal: `team:${teamId}`, teamId };
}

/**
 * Read the RTDB mirrors for one member: {presence, edit, expectEdit, ok}.
 * `admin` replaces lib/admin.mjs's {rtdbGet, emailKey} (a self-test's stand-in).
 */
export async function readMirror(target, docId, email, role, { admin = null } = {}) {
  const { rtdbGet, emailKey } = admin ?? (await import("./admin.mjs"));
  const key = emailKey(email);
  const [presence, edit] = await Promise.all([rtdbGet(target, `presenceAccess/${docId}/${key}`), rtdbGet(target, `editAccess/${docId}/${key}`)]);
  const expectEdit = EDITING_ROLES.has(role);
  return { presence: presence === true, edit: edit === true, expectEdit, ok: presence === true && (edit === true) === expectEdit };
}

/**
 * The RTDB mirrors of every member of a team granted `role` on `docId`: the
 * team record (teams/<id>, read through Admin) names the members, and each
 * must be in presenceAccess/{doc}; for an editing role, in editAccess/{doc}
 * too. For a viewer or suggester grant a member's edit mirror is NOT judged
 * (`expectEdit: null`): another grant may give them more (the document's
 * owner, who is in the team, edits whatever the team holds). `ok` is false
 * when the team record is missing or names nobody. `admin` replaces
 * lib/admin.mjs's {readDoc, rtdbGet, emailKey} (a self-test's stand-in).
 *
 * @returns {Promise<{teamId, found, members: Array<{email, presence, edit, expectEdit, ok}>, ok}>}
 */
export async function readTeamMirror(target, docId, team, role = "viewer", { admin = null } = {}) {
  if (!ROLES.includes(role)) throw new Error(`readTeamMirror: role must be one of ${ROLES.join(", ")}`);
  const { teamId } = granteeOf({ team }, "readTeamMirror");
  const { readDoc, rtdbGet, emailKey } = admin ?? (await import("./admin.mjs"));
  const record = await readDoc(target, `teams/${teamId}`);
  const emails = Array.isArray(record?.members) ? record.members.map((e) => String(e).toLowerCase()) : [];
  const expectEdit = EDITING_ROLES.has(role) ? true : null;
  const members = await Promise.all(emails.map(async (email) => {
    const key = emailKey(email);
    const [presence, edit] = await Promise.all([rtdbGet(target, `presenceAccess/${docId}/${key}`), rtdbGet(target, `editAccess/${docId}/${key}`)]);
    const row = { email, presence: presence === true, edit: edit === true, expectEdit };
    return { ...row, ok: row.presence && (expectEdit === null || row.edit) };
  }));
  return { teamId, found: record != null, members, ok: record != null && members.length > 0 && members.every((m) => m.ok) };
}

/**
 * Give `account` (a person) or `team` `role` on `doc`.
 *
 * @param {object} target
 * @param {object} o
 * @param {object} o.owner      the owner's session (local)
 * @param {string|object} o.doc docId or {docId}
 * @param {object|string} [o.account]  an email or {email}; or a team as below
 * @param {string|object} [o.team]     a team id, `team:<id>` or a createTeam result (its id's case kept)
 * @param {string} o.role       viewer | suggester | editor | approver
 * @param {boolean} [o.verify]  read the RTDB mirror back (default true): for a team, every member's (readTeamMirror)
 * @param {number} [o.timeoutMs] the request's timeout (POST /access, or the operator script)
 * @param {{ctx: object, attempts?: number, lookupMs?: number, intervalMs?: number, stopAt?: number|"budget"|null}|null} [o.patient]
 *        send it again when the stack did not answer, after looking for its effect (see PATIENT in the header)
 * @param {{readDoc: Function, rtdbGet: Function, emailKey?: Function}|null} [o.admin]  a stand-in for lib/admin.mjs's reads (self-tests)
 * @returns {Promise<{status, json, members, mirror, response, landed?}>}
 */
export async function share(target, { owner, doc, account, team, role = "viewer", verify = true, expect = 200, timeoutMs, via = target.kind === "local" ? "access" : "operator", patient = null, admin = null } = {}) {
  if (!ROLES.includes(role)) throw new Error(`share: role must be one of ${ROLES.join(", ")}`);
  if (target.kind !== "local" && via !== "operator") throw new Error("share: on production only the operator script shares (POST /access sends email)");
  const docId = docIdOf(doc);
  const { principal, teamId } = granteeOf({ account, team }, "share");
  const stand = adminStandIn(admin, "share");
  if (patient !== null && patient !== undefined) return sharePatiently(target, { owner, docId, principal, teamId, role, verify, expect, timeoutMs, via, patient, admin: stand });
  const email = principal; // a person's email, or `team:<id>` (the ledger's and set-access.mjs's principal)
  let status;
  let json;
  let response = null;
  if (via === "access") {
    if (!owner?.http) throw new Error("share: the owner's session is required on a local target");
    // A person as {email, role}, as before; a team as the product names it, {principal, role}.
    const entry = teamId ? { principal, role } : { email, role };
    const r = await owner.http.postJson("/access", { docId, add: [entry] }, { expect, timeoutMs });
    status = r.status;
    json = r.json;
    response = r;
  } else {
    // Production: the console identity is always the operator's. Locally any
    // address will do, and the owner's is the one a reader would expect.
    const operator = target.kind === "local" ? (owner?.account?.email ?? process.env.E2E_OPERATOR_ACCOUNT) : process.env.E2E_OPERATOR_ACCOUNT;
    const r = await operatorSetAccess(target, { docId, email, role, operator, ...(timeoutMs ? { timeoutMs } : {}) });
    status = r.code === 0 ? 200 : 500;
    json = { stdout: r.stdout, stderr: r.stderr };
    if (r.code !== 0) throw new Error(`set-access.mjs exited ${r.code}: ${r.stderr.slice(-400)}`);
  }
  appendLedger(target, { kind: "grant", docId, email, role, via: via === "access" ? "access" : "set-access" });
  let mirror = null;
  if (verify && status === 200) {
    const reads = stand ? { admin: await mirrorReader(stand) } : undefined;
    mirror = teamId ? await readTeamMirror(target, docId, teamId, role, reads) : await readMirror(target, docId, email, role, reads);
    if (!mirror.ok) {
      recordFinding(target, { kind: "mirror-missing", suspect: "S16", docId, email, role, mirror, via: via === "access" ? "POST /access" : "scripts/set-access.mjs" });
    }
  }
  return { status, json, members: json?.members, mirror, response };
}

/** Remove `account` (a person) or `team` from `doc` (local: POST /access {remove: [principal]}). */
export async function unshare(target, { owner, doc, account, team, expect = 200, timeoutMs } = {}) {
  const docId = docIdOf(doc);
  const { principal: email } = granteeOf({ account, team }, "unshare");
  if (target.kind !== "local") {
    const r = await operatorSetAccess(target, { docId, email, remove: true, ...(timeoutMs ? { timeoutMs } : {}) });
    if (r.code !== 0) throw new Error(`set-access.mjs exited ${r.code}: ${r.stderr.slice(-400)}`);
    return { status: 200, json: { stdout: r.stdout } };
  }
  const r = await owner.http.postJson("/access", { docId, remove: [email] }, { expect, timeoutMs });
  return { status: r.status, json: r.json };
}

const NO_MANY_PROD_PATH = "several grants in ONE request exist only as POST /access, which emails every new member (the guard refuses it on production); share() per grant goes through the operator script there";

/**
 * Give several people or teams their roles on `doc` in ONE request. See
 * SEVERAL AT ONCE in the header. LOCAL ONLY: on any other target it throws
 * E2E_LOCAL_ONLY before anything is sent; so does a malformed grant (an
 * Error naming it by its place, 1-based) before the request.
 *
 * @param {object} target
 * @param {object} o
 * @param {object} o.owner             the owner's session ({http})
 * @param {string|object} o.doc        docId or {docId}
 * @param {Array<{account?: string|object, team?: string|object, role?: string}>} o.grants
 *        a non-empty list; each names a person (`account`: an email or {email},
 *        sent lower-cased) or a team (`team`, or an `account` that is
 *        `team:<id>` or a createTeam result), and a role (default viewer).
 *        A principal named twice is sent twice, as given.
 * @param {boolean} [o.verify]         read each grant's RTDB mirror back after a 200 (default true)
 * @param {number|number[]|null} [o.expect]  default 200; null expects nothing
 * @param {number} [o.timeoutMs]       the request's
 * @param {object} [o.admin]           a stand-in for lib/admin.mjs's reads (self-tests)
 * @returns {Promise<{status, json, members, principals, mirrors, response}>}
 *   `principals` in the order sent; `mirrors` one per grant (readMirror's or
 *   readTeamMirror's), or null when not verified or not a 200. A missing
 *   mirror is recorded in findings.jsonl (S16), never thrown.
 */
export async function shareMany(target, { owner, doc, grants, verify = true, expect = 200, timeoutMs, admin = null } = {}) {
  localOnly(target, "shareMany", NO_MANY_PROD_PATH);
  const docId = docIdOf(doc);
  if (!Array.isArray(grants) || grants.length === 0) throw new Error(`shareMany: grants is a non-empty list of {account | team, role}, got ${JSON.stringify(grants) ?? String(grants)}`);
  const rows = grants.map((g, i) => {
    const who = `shareMany: grant ${i + 1}`;
    if (g === null || typeof g !== "object" || Array.isArray(g)) throw new Error(`${who} is {account | team, role}, got ${JSON.stringify(g) ?? String(g)}`);
    if ((g.account === undefined || g.account === null) && (g.team === undefined || g.team === null)) throw new Error(`${who} names no account or team`);
    const role = g.role ?? "viewer";
    if (!ROLES.includes(role)) throw new Error(`${who}: role must be one of ${ROLES.join(", ")}, got ${JSON.stringify(role)}`);
    const { principal, teamId } = granteeOf({ account: g.account, team: g.team }, who);
    return { principal, teamId, role };
  });
  if (!owner?.http) throw new Error("shareMany: the owner's session (with its http client) is required");
  // A person as {email, role}, a team as {principal, role}: exactly as share() sends each.
  const add = rows.map(({ principal, teamId, role }) => (teamId ? { principal, role } : { email: principal, role }));
  const ledger = () => {
    for (const { principal, role } of rows) appendLedger(target, { kind: "grant", docId, email: principal, role, via: "access" });
  };
  let r;
  try {
    r = await owner.http.postJson("/access", { docId, add }, { expect: expect ?? undefined, timeoutMs });
  } catch (err) {
    if (err?.code === "E2E_STATUS" && err.response?.status === 200) ledger(); // granted, though the case did not expect it
    throw err;
  }
  if (r.status === 200) ledger();
  let mirrors = null;
  if (verify && r.status === 200) {
    mirrors = await Promise.all(rows.map(async ({ principal, teamId, role }) => {
      const mirror = teamId ? await readTeamMirror(target, docId, teamId, role, { admin }) : await readMirror(target, docId, principal, role, { admin });
      if (!mirror.ok) recordFinding(target, { kind: "mirror-missing", suspect: "S16", docId, email: principal, role, mirror, via: "POST /access" });
      return mirror;
    }));
  }
  const j = r.json && typeof r.json === "object" ? r.json : null;
  return { status: r.status, json: r.json, members: j?.members ?? null, principals: rows.map((x) => x.principal), mirrors, response: r };
}

// --- The RTDB mirror, written by the harness (suspect S16, SPEC §16) ----------------

/**
 * What a grant made through the operator script does with a mirror that
 * reads back missing (live.mjs grantEditors, joinShared, addMember): "stop"
 * reports it in `missing` and writes nothing (joinShared then ends the case
 * INCONCLUSIVE); "write-missing" has the harness write it (writeMirror).
 */
export const MIRROR_MODES = Object.freeze(["stop", "write-missing"]);

/** The two RTDB nodes of a document's mirror: who may be present, who may write the live log. */
const MIRROR_ROOTS = Object.freeze(["presenceAccess", "editAccess"]);
/** A document id as one RTDB key: no . $ # [ ] /, no control character, at most 768 characters. */
const MIRROR_KEY_RE = /^[^.$#[\]/\u0000-\u001f\u007f]{1,768}$/;
/** The RTDB key of an address, as the product makes it (functions/src/lib/presence.ts emailKey; admin.mjs's twin). */
const mirrorKey = (email) => String(email).toLowerCase().split(".").join(",");

function mirrorError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * The mirror of `docId` as functions/src/lib/presence.ts syncPresenceAccess
 * writes it on a grant (persistDocMembership; scripts/lib/presence.mjs, the
 * twin set-access.mjs calls, the same): ONE multi-path update,
 * {"presenceAccess/<docId>": {<key>: true} for each of `members`,
 * "editAccess/<docId>": the same for `editorMembers`}, a key being the
 * address lower-cased with its dots made commas; an entry whose key is
 * empty is left out, and an empty list is {} (which removes the node, as
 * the product's does). No open-edit key ("*"): the grant path never passes
 * publicEdit. TypeError for a docId that is not one RTDB key, or a list
 * that is not an array of strings.
 *
 * @param {string} docId
 * @param {{members?: string[], editorMembers?: string[]}} [lists]
 * @returns {{[path: string]: {[key: string]: true}}}
 */
export function mirrorUpdate(docId, { members = [], editorMembers = [] } = {}) {
  if (typeof docId !== "string" || !MIRROR_KEY_RE.test(docId)) throw new TypeError(`mirrorUpdate: docId is one RTDB key (no . $ # [ ] /), got ${JSON.stringify(docId)}`);
  const keyed = (list, what) => {
    if (!Array.isArray(list) || list.some((m) => typeof m !== "string")) throw new TypeError(`mirrorUpdate: ${what} is a list of addresses, got ${JSON.stringify(list)}`);
    const out = {};
    for (const m of list) {
      const key = mirrorKey(m);
      if (key.length > 0) out[key] = true;
    }
    return out;
  };
  return { [`presenceAccess/${docId}`]: keyed(members, "members"), [`editAccess/${docId}`]: keyed(editorMembers, "editorMembers") };
}

function mirrorBodyOf(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      return undefined;
    }
  }
  return typeof body === "object" ? body : undefined;
}

/** The database root's REST URL on `target`: `<origin of databaseURL>/.json` with the databaseURL's own query (`?ns=` locally). */
function mirrorRootUrl(target) {
  let base;
  try {
    base = new URL(target?.databaseURL);
  } catch {
    throw mirrorError("E2E_MIRROR", `writeMirror: target ${target?.runId ?? "(no run id)"} has no usable databaseURL`);
  }
  const u = new URL(`${base.origin}/.json`);
  for (const [k, v] of base.searchParams) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * The harness's own guard for its one write outside status/<run doc>: may
 * this request go as the mirror write? Pure. Asked by writeMirror before it
 * fetches a credential, and again (through createHttp) on the request as it
 * is sent, on EVERY target, local included.
 *
 *   req       {method, url, body} (createHttp's: the body as the JSON string sent)
 *   target    its databaseURL is the one database the write may reach
 *   docs      the run's documents (ledger.mjs ledgerDocIds)
 *   accounts  the run accounts' addresses (ledger.mjs ledgerAccounts, or its keys)
 *   docId     when given, the one document the write may be about
 *
 * Allowed only as a PATCH of `<origin of databaseURL>/.json` with exactly
 * the databaseURL's own query (rule "mirror-url"; another method
 * "mirror-method") whose JSON body is an object of exactly the keys
 * presenceAccess/<d> and editAccess/<d> for ONE document d ("mirror-body"),
 * which is `docId` when given and a document of the run's ledger
 * ("mirror-ledger"), each value an object of `<key>: true` ("mirror-body")
 * whose every key is a run account's ("mirror-account": a reason that
 * counts the others and never names them, since they would be people
 * outside the run). → {allow: true, rule: "mirror-write"} or {allow: false,
 * rule, reason}.
 */
export function mirrorWriteVerdict(req, { target, docs, accounts, docId = null } = {}) {
  const refuse = (rule, reason) => ({ allow: false, rule, reason: `the harness's mirror write: ${reason}` });
  if (!(docs instanceof Set)) throw new TypeError("mirrorWriteVerdict: docs is the Set of the run's document ids (ledgerDocIds)");
  if (accounts === null || typeof accounts?.[Symbol.iterator] !== "function") throw new TypeError("mirrorWriteVerdict: accounts is the run accounts' addresses (an iterable)");
  const method = String(req?.method ?? "").toUpperCase();
  if (method !== "PATCH") return refuse("mirror-method", `${method || "(no method)"} is not the one multi-path update (PATCH)`);
  let u;
  let want;
  try {
    u = new URL(req.url);
    want = new URL(mirrorRootUrl(target));
  } catch (err) {
    return refuse("mirror-url", `${String(err?.message ?? err).split("\n")[0]}`);
  }
  const query = (x) => JSON.stringify([...x.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (u.origin !== want.origin || u.pathname !== "/.json" || query(u) !== query(want) || u.hash) {
    return refuse("mirror-url", `${u.origin}${u.pathname} with its query is not this target's database root (${want.origin}/.json with its own query)`);
  }
  const body = mirrorBodyOf(req.body);
  if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) return refuse("mirror-body", "the body is not a JSON object");
  const keys = Object.keys(body);
  const ids = new Set(keys.map((k) => /^(?:presenceAccess|editAccess)\/(.+)$/.exec(k)?.[1] ?? null));
  const d = ids.size === 1 ? [...ids][0] : null;
  if (d === null || !MIRROR_KEY_RE.test(d) || keys.length !== 2 || !MIRROR_ROOTS.every((root) => Object.hasOwn(body, `${root}/${d}`))) {
    return refuse("mirror-body", `the body names ${JSON.stringify(keys.slice(0, 4))}, not exactly presenceAccess/<d> and editAccess/<d> of one document`);
  }
  if (docId !== null && d !== docId) return refuse("mirror-body", `the body is about ${d}, not ${docId}`);
  if (!docs.has(d)) return refuse("mirror-ledger", `${d} is not a document this run created`);
  const runKeys = new Set([...(accounts instanceof Map ? accounts.keys() : accounts)].map(mirrorKey));
  let others = 0;
  for (const root of MIRROR_ROOTS) {
    const node = body[`${root}/${d}`];
    if (node === null || typeof node !== "object" || Array.isArray(node) || Object.values(node).some((v) => v !== true)) {
      return refuse("mirror-body", `${root}/${d} is not an object of <key>: true`);
    }
    others += Object.keys(node).filter((k) => !runKeys.has(k)).length;
  }
  if (others > 0) return refuse("mirror-account", `${others} key(s) of ${d}'s mirror are not run accounts, and the harness grants nobody outside the run`);
  return { allow: true, rule: "mirror-write" };
}

/** The database admin's Authorization: the emulator's `Bearer owner` on a local stack, the operator's ADC access token elsewhere (as admin.mjs rtdbGet reads). */
async function databaseAdminAuthorization(target) {
  if (target.kind === "local") return "Bearer owner";
  const { adminFor } = await import("./admin.mjs");
  const token = await adminFor(target).app.options.credential.getAccessToken();
  return `Bearer ${token.access_token}`;
}

/**
 * Write `doc`'s RTDB mirror from its record, as the product would have:
 * see THE MIRROR, WRITTEN BY THE HARNESS in the header. In order, and
 * nothing is sent unless every check holds:
 *   1. `doc` is in the run's ledger (else E2E_GUARD, rule "mirror-ledger");
 *   2. docs/<id> is read through Admin; a record that is missing, or whose
 *      members/editorMembers are not lists of addresses, is E2E_MIRROR;
 *   3. mirrorUpdate(id, record) is asked of mirrorWriteVerdict (E2E_GUARD
 *      with its rule: a member who is not a run account is "mirror-account");
 *   4. the credential (databaseAdminAuthorization);
 *   5. ONE PATCH of the database root through createHttp, whose guard is
 *      mirrorWriteVerdict again (so the request as sent is the one judged),
 *      traced as `actor`; an answer that is not 200, or no answer, is
 *      E2E_MIRROR (`status`, `cause`);
 *   6. a findings.jsonl row {kind: "mirror-written", suspect: "S16", docId,
 *      members, editors (counts), by: "harness"}.
 * Resolves {docId, members, editorMembers, update, status}: the record's
 * lists as written, and the update sent. It writes what the record says
 * whatever the mirror holds now (a whole-node replace, as the product's):
 * call it after the grants, not between them.
 *
 * @param {object} target
 * @param {object} o
 * @param {string|object} o.doc        docId or {docId}
 * @param {string} [o.actor]           the trace label ("operator-mirror")
 * @param {*} [o.evidence]             createHttp's evidence (default: the running case's sink)
 * @param {number} [o.timeoutMs]       the PATCH's timeout (60 s)
 * @param {{readDoc: Function, authorization?: Function}|null} [o.admin]
 *        a self-test's stand-in for lib/admin.mjs's readDoc, and for the credential (`authorization(target)` → the header value)
 * @param {Function|null} [o.fetchImpl] createHttp's fetch (a self-test's)
 * @returns {Promise<{docId, members, editorMembers, update, status}>}
 */
export async function writeMirror(target, { doc, actor = "operator-mirror", evidence = undefined, timeoutMs = 60_000, admin = null, fetchImpl = null } = {}) {
  const docId = typeof doc === "string" ? doc : doc?.docId;
  if (typeof docId !== "string" || !MIRROR_KEY_RE.test(docId)) throw new TypeError(`writeMirror: doc is a document id (or {docId}), got ${JSON.stringify(doc)}`);
  if (admin !== null && (typeof admin?.readDoc !== "function" || (admin.authorization !== undefined && typeof admin.authorization !== "function"))) {
    throw new TypeError("writeMirror: admin is a stand-in {readDoc, authorization?} for lib/admin.mjs (self-tests), or null");
  }
  if (fetchImpl !== null && typeof fetchImpl !== "function") throw new TypeError("writeMirror: fetchImpl is a fetch (self-tests), or null");
  if (typeof actor !== "string" || !actor) throw new TypeError("writeMirror: actor is a non-empty trace label");
  const docs = ledgerDocIds(target);
  if (!docs.has(docId)) {
    throw mirrorError("E2E_GUARD", `writeMirror: ${docId} is not a document this run created (the ledger), so the harness writes no mirror for it`, { rule: "mirror-ledger" });
  }
  const reader = admin ?? (await import("./admin.mjs"));
  const record = await reader.readDoc(target, `docs/${docId}`);
  if (record === null || record === undefined) throw mirrorError("E2E_MIRROR", `writeMirror: docs/${docId} does not exist, so there is no membership to mirror`);
  const lists = {};
  for (const field of ["members", "editorMembers"]) {
    const v = record[field] ?? [];
    if (!Array.isArray(v) || v.some((m) => typeof m !== "string")) throw mirrorError("E2E_MIRROR", `writeMirror: docs/${docId}.${field} is not a list of addresses`);
    lists[field] = [...v];
  }
  const update = mirrorUpdate(docId, lists);
  const url = mirrorRootUrl(target);
  const judge = { target, docs, accounts: [...ledgerAccounts(target).keys()], docId };
  const before = mirrorWriteVerdict({ method: "PATCH", url, body: JSON.stringify(update) }, judge);
  if (!before.allow) throw mirrorError("E2E_GUARD", `writeMirror: ${before.reason}`, { rule: before.rule, verdict: before });
  const authorization = admin?.authorization ? await admin.authorization(target) : await databaseAdminAuthorization(target);
  const http = createHttp(target, { actor, evidence, timeoutMs, guard: { check: async (req) => mirrorWriteVerdict(req, judge) }, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  let r;
  try {
    r = await http.request("PATCH", url, { json: update, headers: { authorization, cookie: null }, noCookies: true });
  } catch (err) {
    if (err?.code === "E2E_GUARD" || err?.code === "E2E_ISOLATION" || err?.code === "E2E_REDACTION") throw err;
    throw mirrorError("E2E_MIRROR", `writeMirror: PATCH of ${MIRROR_ROOTS.map((root) => `${root}/${docId}`).join(" and ")} got no answer: ${String(err?.message ?? err).split("\n")[0]}`, { status: null, cause: err });
  }
  if (r.status !== 200) {
    throw mirrorError("E2E_MIRROR", `writeMirror: PATCH of ${MIRROR_ROOTS.map((root) => `${root}/${docId}`).join(" and ")} answered ${r.status}: ${String(r.text ?? "").slice(0, 200)}`, { status: r.status });
  }
  recordFinding(target, { kind: "mirror-written", suspect: "S16", docId, members: lists.members.length, editors: lists.editorMembers.length, by: "harness", via: "lib/grant.mjs writeMirror" });
  return { docId, members: lists.members, editorMembers: lists.editorMembers, update, status: r.status };
}

// --- Folders and teams (SPEC §13, §18) -----------------------------------------

function folderIdOf(folder, who) {
  const id = typeof folder === "string" ? folder : folder?.folderId;
  if (typeof id !== "string" || !id) throw new Error(`${who}: a folder id (or a createFolder result) is required`);
  return id;
}

/**
 * A grant's principal, as the product stores it: an email lower-cased (as
 * share() sends it), or `team:<teamId>` with the id's case kept (Firestore ids
 * are case-sensitive; access.ts normalizePrincipal). `account` is an email, a
 * `team:<id>` string, an account ({email}) or a team ({teamId}, as
 * createTeam returns it).
 */
export function principalOf(account, who = "principal") {
  if (typeof account === "string") {
    const p = account.trim();
    if (!p) throw new Error(`${who}: an account, an email or a team is required`);
    return p.startsWith("team:") ? p : p.toLowerCase();
  }
  if (typeof account?.teamId === "string" && account.teamId) return `team:${account.teamId}`;
  if (typeof account?.email === "string" && account.email.trim()) return account.email.trim().toLowerCase();
  throw new Error(`${who}: an account, an email or a team is required`);
}

function localOnly(target, who, why) {
  if (target.kind === "local") return;
  const err = new Error(`${who}: local only — ${why}`);
  err.code = "E2E_LOCAL_ONLY";
  throw err;
}

const NO_FOLDER_PROD_PATH = "POST /folder-access emails every new member (the guard refuses it on production) and scripts/set-access.mjs takes documents only, so there is no production path; declare effects: [\"email:POST /folder-access\"] and the case is skipped there";

/**
 * Give `account` `role` on a folder, and through it on everything filed
 * beneath it (SPEC §13): POST /folder-access {folderId, add: [{principal,
 * role}]} as the owner. LOCAL ONLY — on any other target it throws
 * E2E_LOCAL_ONLY before anything is sent. A 200 (also one `expect` refused)
 * is ledgered as {kind: "grant", folderId, email: <principal>, role, via:
 * "folder-access"}. `json` is the folder's four grant lists as the server
 * answered them.
 *
 * @param {object} target
 * @param {object} o
 * @param {object} o.owner                 the owner's session ({http})
 * @param {string|object} o.folder         folderId or {folderId}
 * @param {string|object} o.account        an email, `team:<id>`, {email} or {teamId}
 * @param {string} [o.role]                viewer | suggester | editor | approver
 * @param {number|number[]|null} [o.expect]  default 200; null expects nothing
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{status, json, folderId, principal, response}>}
 */
export async function shareFolder(target, { owner, folder, account, role = "viewer", expect = 200, timeoutMs } = {}) {
  if (!ROLES.includes(role)) throw new Error(`shareFolder: role must be one of ${ROLES.join(", ")}`);
  localOnly(target, "shareFolder", NO_FOLDER_PROD_PATH);
  const folderId = folderIdOf(folder, "shareFolder");
  const principal = principalOf(account, "shareFolder");
  if (!owner?.http) throw new Error("shareFolder: the owner's session (with its http client) is required");
  const ledger = () => appendLedger(target, { kind: "grant", folderId, email: principal, role, via: "folder-access" });
  let r;
  try {
    r = await owner.http.postJson("/folder-access", { folderId, add: [{ principal, role }] }, { expect: expect ?? undefined, timeoutMs });
  } catch (err) {
    if (err?.code === "E2E_STATUS" && err.response?.status === 200) ledger(); // granted, though the case did not expect it
    throw err;
  }
  if (r.status === 200) ledger();
  return { status: r.status, json: r.json, folderId, principal, response: r };
}

/** Take `account` off a folder: POST /folder-access {folderId, remove: [principal]}. LOCAL ONLY, as shareFolder. */
export async function unshareFolder(target, { owner, folder, account, expect = 200, timeoutMs } = {}) {
  localOnly(target, "unshareFolder", NO_FOLDER_PROD_PATH);
  const folderId = folderIdOf(folder, "unshareFolder");
  const principal = principalOf(account, "unshareFolder");
  if (!owner?.http) throw new Error("unshareFolder: the owner's session (with its http client) is required");
  const r = await owner.http.postJson("/folder-access", { folderId, remove: [principal] }, { expect: expect ?? undefined, timeoutMs });
  return { status: r.status, json: r.json, folderId, principal, response: r };
}

/**
 * POST /team-members {teamId, add?, remove?, admin?} as the client's actor
 * (an owner or admin of the team, SPEC §18): `add` and `remove` are emails
 * or accounts, sent lower-cased and only when non-empty; `admin` is
 * {email, isAdmin} and sent only when given. The product re-fans the team's
 * grants (`affected` counts the documents and folders it rewrote) and emails
 * whoever was added, so the guard refuses this on production (rule
 * "team-members"): a local-stack helper in practice, as createTeam is.
 *
 * @param {object} http                    from session.http
 * @param {string|object} team             teamId or {teamId} (createTeam's result)
 * @param {object} [o]
 * @param {Array<string|object>} [o.add]
 * @param {Array<string|object>} [o.remove]
 * @param {{email: string, isAdmin: boolean}} [o.admin]
 * @param {number|number[]|null} [o.expect]  default 200; null expects nothing
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{status, json, members, admins, affected, response}>}
 */
export async function teamMembers(http, team, { add = [], remove = [], admin, expect = 200, timeoutMs } = {}) {
  const teamId = typeof team === "string" ? team : team?.teamId;
  if (typeof teamId !== "string" || !teamId) throw new Error("teamMembers: a team id (or a createTeam result) is required");
  const emails = (list, what) => {
    if (!Array.isArray(list)) throw new Error(`teamMembers: ${what} is a list of emails or accounts`);
    return list.map((a) => {
      const e = typeof a === "string" ? a : a?.email;
      if (typeof e !== "string" || !e.trim()) throw new Error(`teamMembers: every ${what} entry is an email or an account`);
      return e.trim().toLowerCase();
    });
  };
  const body = { teamId };
  const adds = emails(add, "add");
  const removes = emails(remove, "remove");
  if (adds.length) body.add = adds;
  if (removes.length) body.remove = removes;
  if (admin !== undefined) body.admin = admin;
  const r = await http.postJson("/team-members", body, { expect: expect ?? undefined, timeoutMs });
  const j = r.json && typeof r.json === "object" ? r.json : null;
  return { status: r.status, json: r.json, members: j?.members ?? null, admins: j?.admins ?? null, affected: j?.affected ?? null, response: r };
}

/**
 * scripts/set-access.mjs, as the operator runs it.
 *
 * PRODUCTION: this checkout's script with the operator's ADC; the project from
 * the target and the console identity from E2E_OPERATOR_ACCOUNT, so nothing
 * deployment-specific is in a tracked file.
 * LOCAL: the stack TREE's script against this stack's emulators (the emulator
 * hosts are given explicitly — without them the Admin SDK would go to Google),
 * with `operator` defaulting to E2E_OPERATOR_ACCOUNT.
 */
export async function operatorSetAccess(target, { docId, email, role = "viewer", remove = false, operator = process.env.E2E_OPERATOR_ACCOUNT, timeoutMs = 120_000 }) {
  if (!operator) throw new Error("set-access needs an operator account (E2E_OPERATOR_ACCOUNT, from e2e/.env.prod)");
  if (!target.projectId || /^demo-/.test(target.projectId) === (target.kind === "prod")) {
    throw new Error(`set-access: project ${target.projectId} does not match a ${target.kind} target`);
  }
  const flags = ["--doc", docId, remove ? "--remove" : "--add", email, "--role", role, "--project", target.projectId, "--account", operator];
  if (target.kind === "local") {
    // operator.mjs: the tree's script with the stack's HOME, never the user's.
    const { runOperator } = await import("./operator.mjs");
    return runOperator(target, "set-access.mjs", flags, { timeoutMs });
  }
  return spawnCapture(process.execPath, [join(REPO_ROOT, "scripts", "set-access.mjs"), ...flags], { cwd: REPO_ROOT, env: scrubEnv(process.env), timeoutMs });
}

// --- Windows: unlisted and public documents (SPEC §17) -------------------------

export const VISIBILITIES = Object.freeze(["private", "unlisted", "public"]);

/** The running case's window registry (scenario() gives each case one), else the process's. */
const windowScope = new AsyncLocalStorage();
const processWindows = new Map(); // docId → {docId, target, owner, visibility, since}

function windowsIn(scope) {
  if (scope === undefined || scope === null) return windowScope.getStore() ?? processWindows;
  if (!(scope instanceof Map)) throw new Error("windows: a scope is a Map, from withWindowScope's caller");
  return scope;
}

/** Run `fn` with `scope` (a Map) as the registry of every window opened under it. scenario() does this per case. */
export function withWindowScope(scope, fn) {
  if (!(scope instanceof Map)) throw new Error("withWindowScope: the scope is a Map");
  return windowScope.run(scope, fn);
}

/** `admin` as setVisibility and trackWindow take it: null, or a stand-in {readDoc, rtdbGet} for lib/admin.mjs. */
function adminStandIn(admin, who) {
  if (admin === null || admin === undefined) return null;
  if (typeof admin?.readDoc !== "function" || typeof admin?.rtdbGet !== "function") {
    throw new Error(`${who}: admin is a stand-in {readDoc, rtdbGet} for lib/admin.mjs (self-tests), or null`);
  }
  return admin;
}

/** Register a window opened some other way (the Share dialog in a browser), so the case closes it too. */
export function trackWindow(target, { owner, doc, visibility = "public", scope, admin = null } = {}) {
  const docId = docIdOf(doc);
  if (!VISIBILITIES.includes(visibility)) throw new Error(`trackWindow: visibility must be one of ${VISIBILITIES.join(", ")}`);
  const stand = adminStandIn(admin, "trackWindow");
  const registry = windowsIn(scope);
  if (visibility === "private") {
    registry.delete(docId);
    return null;
  }
  if (!owner?.http) throw new Error("trackWindow: the owner's session (with its http client) is required to close the window");
  const prev = registry.get(docId);
  const w = { docId, target, owner, visibility, since: prev?.since ?? Date.now(), admin: stand ?? prev?.admin ?? null };
  registry.set(docId, w);
  return w;
}

/** The windows open in the running case (or the process, outside any case): [{docId, visibility, since}]. */
export function openWindows({ scope } = {}) {
  return [...windowsIn(scope).values()].map(({ docId, visibility, since }) => ({ docId, visibility, since }));
}

/**
 * POST /visibility as the owner. See WINDOWS in the header.
 *
 * @param {object} target
 * @param {object} o
 * @param {object} o.owner            the owner's session ({http})
 * @param {string|object} o.doc       docId or {docId}
 * @param {"private"|"unlisted"|"public"} o.visibility
 * @param {number|string|null} [o.expiresAt]  sent only when given; null clears an expiry
 * @param {boolean} [o.publicEdit]    sent only when given
 * @param {number|number[]} [o.expect]  default 200; another status throws E2E_STATUS
 * @param {number} [o.timeoutMs]      the request's
 * @param {{ctx: object, attempts?: number, lookupMs?: number, intervalMs?: number, stopAt?: number|"budget"|null}|null} [o.patient]
 *        send it again when the stack did not answer, after looking for its effect (see WHEN THE STACK DID NOT ANSWER)
 * @param {{readDoc: Function, rtdbGet: Function}|null} [o.admin]  a stand-in for lib/admin.mjs's reads (self-tests)
 * @returns {Promise<{status, json, visibility, publicEdit, linkToken, expiresAt, response, landed?}>}
 */
export async function setVisibility(target, { owner, doc, visibility, expiresAt, publicEdit, expect = 200, timeoutMs, patient = null, admin = null } = {}) {
  if (!VISIBILITIES.includes(visibility)) throw new Error(`setVisibility: visibility must be one of ${VISIBILITIES.join(", ")}, got ${JSON.stringify(visibility)}`);
  if (!owner?.http) throw new Error("setVisibility: the owner's session (with its http client) is required");
  const docId = docIdOf(doc);
  const stand = adminStandIn(admin, "setVisibility");
  if (patient !== null && patient !== undefined) return setVisibilityPatiently(target, { owner, docId, visibility, expiresAt, publicEdit, expect, timeoutMs, patient, admin: stand });
  const body = { docId, visibility };
  if (publicEdit !== undefined) body.publicEdit = publicEdit;
  if (expiresAt !== undefined) body.expiresAt = expiresAt;
  const registry = windowsIn();
  const before = registry.get(docId) ?? null;
  // Registered BEFORE the request: from the moment it is sent the document
  // may be open, so a request that never answers still leaves it to close.
  if (visibility !== "private") trackWindow(target, { owner, doc: docId, visibility, scope: registry, admin: stand });
  const settle = (status) => {
    if (status === 200) {
      if (visibility === "private") registry.delete(docId);
      return;
    }
    // No answer, or Hosting's 504 (the product never answers 504: the function
    // may still be running): the document may be open, or still open.
    if (status === null || status === 504) return;
    // Refused: nothing changed on the server.
    if (before) registry.set(docId, before);
    else registry.delete(docId);
  };
  let r;
  try {
    r = await owner.http.postJson("/visibility", body, { expect, timeoutMs });
  } catch (err) {
    settle(err?.code === "E2E_STATUS" && typeof err.response?.status === "number" ? err.response.status : null);
    throw err;
  }
  settle(r.status);
  const j = r.json && typeof r.json === "object" ? r.json : null;
  return {
    status: r.status,
    json: j,
    visibility: j?.visibility ?? null,
    publicEdit: j?.publicEdit ?? null,
    linkToken: j?.linkToken ?? null,
    expiresAt: j?.expiresAt ?? null,
    response: r,
  };
}

// --- What the record says, when the stack did not answer (SPEC §17) ---------------

/** The RTDB key that opens a public document's live editing to any account: functions/src/lib/presence.ts OPEN_EDIT_KEY, pinned here. */
const OPEN_EDIT_KEY = "*";
/** How long a close the stack did not answer is followed by reading the record, by default: Hosting's own minute again. */
const CLOSE_LOOKUP_MS = 60_000;
const LOOKUP_INTERVAL_MS = 2_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Firestore Timestamp (or a stand-in's number or string) as a string that compares: "<seconds>.<nanoseconds>", or null. */
function stampOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && Number.isFinite(v.seconds) && Number.isFinite(v.nanoseconds)) return `${v.seconds}.${String(v.nanoseconds).padStart(9, "0")}`;
  if (typeof v?.toMillis === "function") return String(v.toMillis());
  return JSON.stringify(v);
}

/** An expiry as epoch ms, read as the product reads it (functions/src/lib/acl.ts expiryMs): a number, or a Timestamp's millis; else null. */
function msOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v?.toMillis === "function") {
    const ms = v.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Whether this target's records can be read through lib/admin.mjs: a local stack's emulators ("admin-emulator"), or production's ADC. */
function canReadRecords(target) {
  if (target?.kind === "prod") return true;
  const caps = target?.capabilities;
  return caps instanceof Set ? caps.has("admin-emulator") : Array.isArray(caps) && caps.includes("admin-emulator");
}

/** The record reader: a stand-in {readDoc, rtdbGet}, else lib/admin.mjs. */
async function recordReader(stand) {
  return stand ?? (await import("./admin.mjs"));
}

/**
 * What decides whether `docId` is open, read through Admin: its record's
 * visibility (as the product reads it: anything but "public" or "unlisted"
 * is private), publicEdit, linkToken, expiry and `updatedAt` (as stampOf);
 * whether public/<id>, its projection for anonymous readers, exists; and
 * whether the RTDB gate editAccess/<id>/* that opens live editing to any
 * account is set.
 */
async function windowState(target, docId, reader) {
  const [record, projection, openEdit] = await Promise.all([
    reader.readDoc(target, `docs/${docId}`),
    reader.readDoc(target, `public/${docId}`),
    reader.rtdbGet(target, `editAccess/${docId}/${OPEN_EDIT_KEY}`),
  ]);
  const v = record?.visibility;
  return {
    exists: record !== null && record !== undefined,
    visibility: record === null || record === undefined ? null : v === "public" || v === "unlisted" ? v : "private",
    publicEdit: record?.publicEdit === true,
    linkToken: typeof record?.linkToken === "string" ? record.linkToken : null,
    expiresAt: msOf(record?.expiresAt),
    updatedAt: stampOf(record?.updatedAt),
    projection: projection !== null && projection !== undefined,
    openEdit: openEdit === true,
  };
}

/** Closed: the record private (or gone), no public projection, no open-edit gate. */
const isClosed = (s) => (!s.exists || s.visibility === "private") && !s.projection && !s.openEdit;
/** A state without its link token, for a reason or a finding. */
const stateSummary = (s) => ({ visibility: s.visibility, projection: s.projection, openEdit: s.openEdit });

/** Read the window's state until it is closed or `lookupMs` pass: {closed, state, error}. A read that throws is "not yet". */
async function lookClosed(w, reader, lookupMs, intervalMs) {
  const t0 = Date.now();
  let state = null;
  let error = null;
  for (;;) {
    try {
      state = await windowState(w.target, w.docId, reader);
      error = null;
      if (isClosed(state)) return { closed: true, state, error };
    } catch (err) {
      error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
    }
    const left = lookupMs - (Date.now() - t0);
    if (left <= 0) return { closed: false, state, error };
    await sleep(Math.min(intervalMs, left));
  }
}

const PATIENT_FIELDS = Object.freeze(["ctx", "attempts", "lookupMs", "intervalMs", "stopAt"]);

/** `patient` checked: {ctx, opts} for untilLanded. */
function patience(patient, who) {
  if (patient === null || typeof patient !== "object" || Array.isArray(patient)) throw new TypeError(`${who}: patient is {${PATIENT_FIELDS.join(", ")}}, got ${JSON.stringify(patient) ?? String(patient)}`);
  const unknown = Object.keys(patient).filter((k) => !PATIENT_FIELDS.includes(k));
  if (unknown.length > 0) throw new TypeError(`${who}: patient has unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${PATIENT_FIELDS.join(", ")})`);
  if (patient.ctx === null || typeof patient.ctx !== "object") throw new TypeError(`${who}: patient.ctx is the case's ctx (its steps say what was sent again; it ends the case INCONCLUSIVE), got ${patient.ctx === null ? "null" : typeof patient.ctx}`);
  const { ctx, ...rest } = patient;
  return { ctx, opts: Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
}

/**
 * setVisibility with `patient` (see WHEN THE STACK DID NOT ANSWER): the
 * request through lib/test.mjs untilLanded, its effect read from the record.
 * The window registry is setVisibility's own (each request settles it);
 * an effect found instead of an answer settles it too.
 */
async function setVisibilityPatiently(target, { owner, docId, visibility, expiresAt, publicEdit, expect, timeoutMs, patient, admin }) {
  const { ctx, opts } = patience(patient, "setVisibility");
  const reader = await recordReader(admin);
  const { untilLanded } = await import("./test.mjs");
  // This call's write is the one that moves `updatedAt` past what it is now.
  const before = stampOf((await reader.readDoc(target, `docs/${docId}`))?.updatedAt);
  const wantEdit = publicEdit === undefined ? null : publicEdit === true && visibility !== "private";
  const registry = windowsIn();
  const r = await untilLanded(
    ctx,
    `POST /visibility ${visibility} (${docId})`,
    () => setVisibility(target, { owner, doc: docId, visibility, expiresAt, publicEdit, expect, timeoutMs, admin }),
    async () => {
      const s = await windowState(target, docId, reader);
      if (!s.exists || s.updatedAt === before || s.visibility !== visibility) return null;
      if (wantEdit !== null && s.publicEdit !== wantEdit) return null;
      if (visibility === "unlisted" && !(typeof s.linkToken === "string" && s.linkToken.length >= 22)) return null;
      if (s.projection !== (visibility === "public") || s.openEdit !== (visibility === "public" && s.publicEdit)) return null;
      return s;
    },
    opts,
  );
  if (r.out) return { ...r.out, landed: false };
  const s = r.landed;
  if (visibility === "private") registry.delete(docId);
  else trackWindow(target, { owner, doc: docId, visibility, scope: registry, admin });
  return { status: null, json: null, visibility: s.visibility, publicEdit: s.publicEdit, linkToken: s.linkToken, expiresAt: s.expiresAt, response: null, landed: true };
}

/** A stand-in's reads for readMirror and readTeamMirror: its own emailKey, else lib/admin.mjs's (the RTDB key of an address). */
async function mirrorReader(stand) {
  if (typeof stand.emailKey === "function") return stand;
  const { emailKey } = await import("./admin.mjs");
  return { ...stand, emailKey };
}

/**
 * Who holds `principal` on `docId`, read through Admin: {exists, holds (the
 * roles whose list names it, in ROLES order), updatedAt (as stampOf),
 * members (the record's, or null)}. The lists are as the product stores
 * them (access.ts normalizePrincipal): an address lower-cased, a team's id
 * with its case kept, which is what granteeOf gives.
 */
async function grantState(target, docId, principal, reader) {
  const d = await reader.readDoc(target, `docs/${docId}`);
  if (d === null || d === undefined) return { exists: false, holds: [], updatedAt: null, members: null };
  const holds = ROLES.filter((r) => Array.isArray(d[GRANT_LIST[r]]) && d[GRANT_LIST[r]].includes(principal));
  return { exists: true, holds, updatedAt: stampOf(d.updatedAt), members: Array.isArray(d.members) ? d.members : null };
}

/**
 * The grant's RTDB mirror once it is there, or as it was when `lookupMs`
 * ran out: POST /access writes the mirrors right after the record, so a
 * grant found in the record before them is given that long. A read that
 * throws is "not yet"; the last read stands.
 */
async function settledMirror(target, { docId, principal, teamId, role, reads, lookupMs, intervalMs }) {
  const t0 = Date.now();
  let mirror = null;
  let error = null;
  for (;;) {
    try {
      mirror = teamId ? await readTeamMirror(target, docId, teamId, role, reads) : await readMirror(target, docId, principal, role, reads);
      error = null;
      if (mirror.ok) return mirror;
    } catch (err) {
      error = err;
    }
    const left = lookupMs - (Date.now() - t0);
    if (left <= 0) {
      if (mirror === null && error) throw error;
      return mirror;
    }
    await sleep(Math.min(intervalMs, left));
  }
}

/**
 * share with `patient` (see PATIENT in the header): the request through
 * lib/test.mjs untilLanded, its effect read from the record. Ledgered and
 * verified as an answered grant is, when its effect is taken instead.
 */
async function sharePatiently(target, { owner, docId, principal, teamId, role, verify, expect, timeoutMs, via, patient, admin }) {
  const { ctx, opts } = patience(patient, "share");
  if (admin === null && !canReadRecords(target)) {
    throw new Error("share: patient reads the grant back from the document's record through the Admin SDK, which this target does not allow (no admin-emulator capability); pass admin, or send it without patient");
  }
  const reader = await recordReader(admin);
  const { untilLanded } = await import("./test.mjs");
  // This call's write is the one that moves `updatedAt` past what it is now.
  const before = (await grantState(target, docId, principal, reader)).updatedAt;
  const grantee = teamId ? { team: principal } : { account: principal };
  const r = await untilLanded(
    ctx,
    `${via === "access" ? "POST /access" : "set-access.mjs"} ${role} ${principal} (${docId})`,
    () => share(target, { owner, doc: docId, ...grantee, role, verify, expect, timeoutMs, via, admin }),
    async () => {
      const s = await grantState(target, docId, principal, reader);
      return s.exists && s.updatedAt !== before && s.holds.length === 1 && s.holds[0] === role ? s : null;
    },
    opts,
  );
  if (r.out) return { ...r.out, landed: false };
  appendLedger(target, { kind: "grant", docId, email: principal, role, via: via === "access" ? "access" : "set-access" });
  let mirror = null;
  if (verify) {
    const reads = admin ? { admin: await mirrorReader(admin) } : undefined;
    mirror = await settledMirror(target, { docId, principal, teamId, role, reads, lookupMs: opts.lookupMs ?? CLOSE_LOOKUP_MS, intervalMs: opts.intervalMs ?? LOOKUP_INTERVAL_MS });
    if (!mirror.ok) {
      recordFinding(target, { kind: "mirror-missing", suspect: "S16", docId, email: principal, role, mirror, via: via === "access" ? "POST /access" : "scripts/set-access.mjs" });
    }
  }
  return { status: null, json: null, members: r.landed.members, mirror, response: null, landed: true };
}

/**
 * Make one window private: {ok, status, via, error, record}. `via` "answer"
 * (a 200 saying private, or an owner's 404) or "record" (after a 504 or no
 * answer, the record said closed: see closeWindows).
 */
async function closeWindow(w, attempts, { lookupMs = CLOSE_LOOKUP_MS, intervalMs = LOOKUP_INTERVAL_MS, admin = null } = {}) {
  let status = null;
  let error = null;
  let record = null;
  const stand = admin ?? w.admin ?? null;
  const canLook = stand !== null || canReadRecords(w.target);
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    let unanswered = false;
    try {
      const r = await w.owner.http.postJson("/visibility", { docId: w.docId, visibility: "private" });
      status = r.status;
      if (r.status === 200 && r.json?.visibility === "private") return { ok: true, status, via: "answer" };
      if (r.status === 404) return { ok: true, status, via: "answer" }; // an owner's 404: the document is gone
      error = `POST /visibility private answered ${r.status}${r.status === 200 ? ` ${JSON.stringify(r.json)}` : ""}`;
      if (r.status === 504) unanswered = true;
      else if (r.status < 500) break;
    } catch (err) {
      status = null;
      error = String(err?.message ?? err).slice(0, 300);
      unanswered = true;
    }
    if (unanswered && canLook) {
      let seen;
      try {
        seen = await lookClosed(w, await recordReader(stand), lookupMs, intervalMs);
      } catch (err) {
        seen = { closed: false, state: null, error: String(err?.message ?? err).split("\n")[0].slice(0, 200) };
      }
      if (seen.closed) return { ok: true, status, via: "record" };
      record = seen.state ? stateSummary(seen.state) : null;
      error = `${error}; ${record ? `its record still said ${JSON.stringify(record)}` : `its record could not be read${seen.error ? ` (${seen.error})` : ""}`} ${lookupMs} ms later`;
    }
  }
  return { ok: false, status, error, record };
}

/** Make every registered window private. See WINDOWS in the header; never throws. */
export async function closeWindows({ scope, attempts = 2, lookupMs = CLOSE_LOOKUP_MS, intervalMs = LOOKUP_INTERVAL_MS, admin = null } = {}) {
  const registry = windowsIn(scope);
  const stand = adminStandIn(admin, "closeWindows");
  const closed = [];
  const failed = [];
  for (const w of [...registry.values()]) {
    const out = await closeWindow(w, attempts, { lookupMs, intervalMs, admin: stand });
    if (out.ok) {
      if (registry.get(w.docId) === w) registry.delete(w.docId);
      closed.push({ docId: w.docId, status: out.status, via: out.via });
      continue;
    }
    const f = { docId: w.docId, visibility: w.visibility, status: out.status, error: out.error, record: out.record };
    failed.push(f);
    try {
      recordFinding(w.target, { kind: "window-open", ...f, openSince: new Date(w.since).toISOString() });
    } catch {}
  }
  return { closed, failed };
}

/**
 * Open a window for the length of `fn`, then make the document private
 * again. See WINDOWS in the header.
 *
 *   const out = await withVisibility(ctx.target, { owner, doc: docId, visibility: "unlisted" }, async ({ linkToken: k }) => {
 *     // … read with ?k=
 *   });
 *   // docId is private here, pass or fail
 *
 * @param {object} target
 * @param {object} o  setVisibility's options: {owner, doc, visibility: "unlisted"|"public", expiresAt, publicEdit, timeoutMs}
 * @param {(answer: object) => any} fn  given setVisibility's answer
 * @returns {Promise<any>} what fn returns
 */
export async function withVisibility(target, { owner, doc, visibility, expiresAt, publicEdit, timeoutMs } = {}, fn) {
  if (visibility === "private" || !VISIBILITIES.includes(visibility)) throw new Error(`withVisibility: visibility is "unlisted" or "public", got ${JSON.stringify(visibility)}`);
  if (typeof fn !== "function") throw new Error("withVisibility: fn is the block to run while the window is open");
  if (!owner?.http) throw new Error("withVisibility: the owner's session (with its http client) is required");
  const docId = docIdOf(doc);
  const registry = windowsIn();
  let result;
  let thrown = null; // the open's or fn's own error, which wins over the close's
  try {
    const answer = await setVisibility(target, { owner, doc: docId, visibility, expiresAt, publicEdit, timeoutMs });
    result = await fn(answer);
  } catch (err) {
    thrown = { err };
  }
  // Still registered: the block opened it (or a request got no answer), and
  // fn did not make it private itself.
  const w = registry.get(docId);
  if (w) {
    const out = await closeWindow(w, 2);
    if (out.ok) {
      if (registry.get(docId) === w) registry.delete(docId);
    } else if (!thrown) {
      const err = new Error(`withVisibility: ${docId} (${w.visibility}) is not private again: ${out.error}`);
      err.code = "E2E_WINDOW_OPEN";
      err.failed = [{ docId, visibility: w.visibility, status: out.status, error: out.error, record: out.record }];
      throw err;
    }
  }
  if (thrown) throw thrown.err;
  return result;
}
