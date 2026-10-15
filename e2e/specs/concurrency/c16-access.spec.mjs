// SPDX-License-Identifier: Apache-2.0
// Concurrency C16a–d: concurrent sharing changes — grants, folder + document + team, team admins, visibility against a revoke — leave every membership set what was asked (I16) and the RTDB mirrors equal to the record, a revoked editor's live write refused (I14) (SPEC §2, §13, §16, §18).

/**
 * Local sharing races and serial controls (SPEC §4, §13, §14, §16, §18).
 * S18/S19/S20 and X-c16-access-1/-2/-3 are regression assertions, not TODOs.
 * Natural races need an unpatched stack. The amplified run pauses outside
 * Firestore transactions, since holding pessimistic document locks would
 * deadlock an N-way barrier. Unit tests separately hold actual snapshots and
 * verify conflict retries. Cascade discovery and post-commit mirror gates
 * still force older operations to finish after newer operations.
 *
 * Run this file on both an unpatched stack and one with amplify-c16-access
 * plus amplify-c16-folder-access. Serial cases run on either. Failed overlap
 * or gate preconditions are INCONCLUSIVE. Adding people sends invitations,
 * so every case is local and declares its email effects.
 */

import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { after } from "node:test";
import { answered, currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSessions } from "../../lib/session.mjs";
import { createFolder, createTeam, publish } from "../../lib/seed.mjs";
import { GRANT_LIST, ROLES, share, shareMany, teamMembers, trackWindow } from "../../lib/grant.mjs";
import { closeAdmin, readDoc, rtdbGet } from "../../lib/admin.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { eventually, settleStill } from "../../lib/assert.mjs";
import { rtdbAs, rtdbRulesStatus } from "../../lib/rtdb.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { requireConclusive, syncHttp } from "../../lib/sync.mjs";
import { measure } from "../../lib/evidence.mjs";
import { assertInvariant, checkI14, checkI16, expectedMembership } from "../../lib/invariants.mjs";
import { admitWorkers, staticWarmUrl } from "../../lib/workers.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const LOCAL = ["local"];
const GATED = ["gates", "patch:amplify-c16-access"];
const FOLDER_GATED = ["gates", "patch:amplify-c16-folder-access"];
/** A free-running race measures the product as it ships: no pause point, armed or not, inside its window (c04's rule). */
const UNPATCHED = ["!gates"];
const ACCESS_MAIL = ["email:POST /access"];
const FOLDER_MAIL = ["email:POST /folder-access"];
const ALL_MAIL = ["email:POST /access", "email:POST /folder-access", "email:POST /team-members"];
const TEAM_MAIL = ["email:POST /access", "email:POST /team-members"];
const CASE_MS = 480_000;
/** A request of the case's own, past Hosting's cut-off so a stalled one ends in its 504. */
const HTTP_MS = 150_000;
/** How long a gate may wait for its callers: well inside Hosting's 60 s cut-off for those already held. */
const HELD_MS = 40_000;
/** The plan's server settle: counts stable for 10 s. */
const SERVER_STABLE_MS = 10_000;
const SERVER_DEADLINE_MS = 120_000;
const MAIL_MS = 90_000;
const ROLE_CYCLE = ["editor", "viewer", "approver", "suggester"];
const SETS = ["members", "suggesterMembers", "editorMembers", "approverMembers"];
const MEASURE = "c16-access";

const isAssertion = (err) => err instanceof AssertionError || err?.code === "ERR_ASSERTION";
/** A promise that never rejects: {ok, value} or {ok: false, error}. */
const settled = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const emailOf = (s) => String(s.account.email).toLowerCase();
const tagOf = () => `${runTag(target.runId)} ${rand4()}`;
const sorted = (xs) => [...xs].sort();
const keysOf = (o) => {
  if (!o || typeof o !== "object") return [];
  if (o.__revision !== undefined) assert.match(o.__revision, /^\d{12}:\d{9}$/, "the reserved mirror revision is a timestamp fence");
  for (const [key, value] of Object.entries(o)) if (key !== "__revision") assert.equal(value, true, `${key} is an access grant`);
  return Object.keys(o).filter((key) => key !== "__revision").sort();
};
const asSet = (keys) => Object.fromEntries(keys.map((k) => [k, true]));
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
/** The invitation's subject, every kind (functions/src/email/notify.ts sendInvitations). */
const invited = (inviter, title) => `${inviter} shared “${title}” with you`;

// --- oracles collected, so one failing never hides another -----------------------------

/**
 * Collect oracle results. `check(fn)` runs one and keeps its AssertionError
 * (and a mailbox's E2E_MAIL, which is a judgement too); anything else is
 * thrown at once (a harness error, an INCONCLUSIVE).
 */
function oracleSet() {
  const failed = [];
  return {
    failed,
    async check(fn) {
      try {
        await fn();
      } catch (err) {
        if (isAssertion(err)) failed.push(err.message);
        else if (err?.code === "E2E_MAIL") failed.push(`I11: ${err.message}`);
        else throw err;
      }
    },
  };
}

/**
 * The case's outcome from two collections: `others` (every oracle that is
 * not the case's defect's) and `own` (the defect's). Without a defect both
 * are one AssertionError. With one, a failure in `others` is a plain error
 * (a FAIL: not this defect's oracle), and only `own` can be the TODO.
 */
function verdict({ defect = null, others, own = null }) {
  const ownMsgs = own?.failed ?? [];
  if (!defect) {
    const all = [...others.failed, ...ownMsgs];
    if (all.length) throw new AssertionError({ message: all.join(" | "), actual: all, expected: [], operator: "oracles" });
    return;
  }
  if (others.failed.length) {
    const err = new Error(`not ${defect}'s oracle: ${others.failed.join(" | ")}${ownMsgs.length ? ` (and ${defect}'s own: ${ownMsgs.join(" | ")})` : ""}`);
    err.code = "E2E_C16_OTHER_ORACLE";
    throw err;
  }
  if (ownMsgs.length) throw new AssertionError({ message: ownMsgs.join(" | "), actual: ownMsgs, expected: [], operator: defect });
}

// --- people, documents, folders, teams ---------------------------------------------------

/** Cast `roles` and open a session for each, five at a time: [{account, http, idToken, uid}] in order. */
async function people(ctx, roles) {
  const accounts = await cast(target, roles, { http: ctx.http({ actor: "harness" }) });
  return openSessions(target, accounts, { timeoutMs: HTTP_MS, cutoffError: true });
}

function docHtml(title) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<p id="c16-1">Who may read this is decided by its sharing, and only by it.</p>
</body>
</html>
`;
}

/** A document `owner` publishes (inside `folderId`, when given) → {docId, title}. */
async function newDoc(owner, label, { folderId = null } = {}) {
  const title = `${label} ${tagOf()}`;
  const up = await publish(owner.http, { body: docHtml(title), filename: "index.html", title, name: "c16", ...(folderId ? { folderId } : {}), ownerEmail: emailOf(owner), timeoutMs: HTTP_MS });
  precondition(up.status === 200 && up.docId, `publishing ${label}: ${up.status} ${JSON.stringify(up.json)}`);
  return { docId: up.docId, title };
}

/** Grant lists from [{principal, role}], each sorted: what a record holds when every grant landed. */
function grantLists(entries) {
  const g = Object.fromEntries(ROLES.map((r) => [GRANT_LIST[r], []]));
  for (const { principal, role } of entries) g[GRANT_LIST[role]].push(principal);
  for (const k of Object.keys(g)) g[k].sort();
  return g;
}

const storedGrants = (rec) => Object.fromEntries(ROLES.map((r) => [GRANT_LIST[r], sorted(rec?.[GRANT_LIST[r]] ?? [])]));
const storedSets = (rec) => Object.fromEntries(SETS.map((k) => [k, sorted(rec?.[k] ?? [])]));

/**
 * On a local stack, prove live that ns=<projectId> enforces the tree's
 * database.rules.json (byte-equal read-back, an anonymous read refused):
 * without that a DENY says nothing.
 */
async function rulesEnforced(ctx) {
  const s = await rtdbRulesStatus(target, { http: ctx.http({ actor: "rtdb-rules" }) });
  precondition(s.ok, `RTDB ns=${s.namespace} enforces the tree's rules: ${s.reason}`);
  ctx.step(`RTDB ns=${s.namespace} enforces ${s.file} (read back byte-equal; an anonymous read answers ${s.anonymousStatus})`);
}

// --- the requests ------------------------------------------------------------------------------

/**
 * One racing request: `s` (a session) POSTs `body` to `path`. `send()` sends
 * it through the session's own client (traced); `raw()` is the same request
 * for syncHttp's worker threads, with the session's cookie (syncHttp adds the
 * agent headers, and traces it under the session's actor).
 */
function request(name, s, path, body) {
  return {
    name,
    s,
    path,
    body,
    send: () => s.http.postJson(path, body, { timeoutMs: HTTP_MS }),
    raw: () => {
      const url = `${target.origin}${path}`;
      const cookie = s.http.jar.header(url);
      precondition(typeof cookie === "string" && cookie.includes("__session="), `${name}: ${s.account.role} holds a session cookie for ${path}`);
      return { url, method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body), warm: staticWarmUrl(target), actor: s.account.role ?? "account" };
    },
  };
}

function parsed(body) {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return String(body).slice(0, 200);
  }
}

/**
 * Warm one function worker per racing request: `calls` concurrent requests
 * the function answers without changing anything (a read, or a refusal), so
 * the race's requests each find an idle worker instead of a cold start, as
 * concurrent requests to one Cloud Run instance do in production.
 */
async function warm(ctx, calls, what) {
  // Room first for every worker the warm-up and the burst may start (one each), or INCONCLUSIVE.
  await admitWorkers(ctx, { requests: 2 * calls.length, what: `the warm-up (${calls.length} ${what}) and the race` });
  const t0 = Date.now();
  const rs = await Promise.all(calls.map((f) => settled(f())));
  const statuses = rs.map((r) => (r.ok ? r.value.status : `error ${String(r.error?.message ?? r.error).slice(0, 60)}`));
  ctx.step(`warm-up: ${calls.length} concurrent ${what} answered ${statuses.join(", ")} in ${Date.now() - t0} ms`);
}

/**
 * The warm-up call for a racing request's function: a read the owner may
 * make, or a POST the function refuses (400) before it reads or writes
 * anything, so each racing request has a worker of its own function waiting.
 */
function warmCall(q) {
  if (q.path === "/access") return () => q.s.http.get(`/access?docId=${encodeURIComponent(q.body.docId)}`);
  if (q.path === "/folder-access") return () => q.s.http.get(`/folder-access?folderId=${encodeURIComponent(q.body.folderId)}`);
  return () => q.s.http.postJson(q.path, {});
}

/**
 * Fire `reqs` at one instant (SYNC-T). Resolves {rows: [{name, status, json}],
 * run}; a Hosting cut-off is INCONCLUSIVE. With the target, syncHttp asks the
 * isolation check and the guard about every request and its warm-up before
 * any worker exists, and traces each hop into the case's http.jsonl (the rows
 * with a `sync` key).
 */
async function fire(ctx, reqs, label) {
  const raws = reqs.map((r) => r.raw());
  const run = await syncHttp(raws, { target: ctx.target, timeoutMs: HTTP_MS });
  const rows = run.results.map((r, i) => ({ name: reqs[i].name, status: r.error ? null : r.status, json: r.error ? null : parsed(r.body), error: r.error ?? null }));
  ctx.ev.json(`fire-${slug(label)}`, {
    spreadMs: run.spreadMs,
    limit: run.limit,
    overlap: run.overlap,
    rows,
    wire: run.results.map((r, i) => ({ name: reqs[i].name, path: reqs[i].path, status: r.status, firedAt: r.firedAt, sentAt: r.sentAt, firstByteAt: r.firstByteAt, endAt: r.endAt, error: r.error })),
  });
  ctx.step(`${label}: ${reqs.length} request(s) fired within ${Number(run.spreadMs).toFixed(1)} ms (overlap ${run.overlap.ok ? `proved, margin ${Number(run.overlap.marginMs).toFixed(0)} ms` : run.overlap.reason}); answers ${rows.map((r) => `${r.name} ${r.status ?? r.error}`).join("; ")}`);
  const cut = rows.filter((r) => r.status === 504);
  if (cut.length) ctx.inconclusive(`the stack did not answer, so nothing was measured: Hosting answered 504 to ${cut.map((r) => r.name).join(", ")}`);
  return { rows, run };
}

/** Send `reqs` one after another, each answered before the next is sent. */
async function sendSerially(ctx, reqs, label) {
  const rows = [];
  for (const q of reqs) {
    const r = answered(await q.send(), `${q.name} (POST ${q.path})`);
    rows.push({ name: q.name, status: r.status, json: r.json });
    ctx.step(`${label}: ${q.name} answered ${r.status}`);
  }
  return rows;
}

/** Send `reqs` concurrently through their sessions without waiting: [{q, p (settled), answered: boolean}]. */
function sendAll(reqs) {
  return reqs.map((q) => {
    const row = { q, answered: false, p: null };
    row.p = settled(q.send()).then((r) => {
      row.answered = true;
      return r;
    });
    return row;
  });
}

/** The rows of `pending` (sendAll's), once answered; a Hosting cut-off or a dropped request is thrown, where the case's options judge it. */
async function rowsOf(ctx, pending, label) {
  const rows = [];
  for (const { q, p } of pending) {
    const r = await p;
    if (!r.ok) throw r.error;
    const a = answered(r.value, `${q.name} (POST ${q.path})`);
    rows.push({ name: q.name, status: a.status, json: a.json });
  }
  ctx.step(`${label}: ${rows.map((r) => `${r.name} ${r.status}`).join("; ")}`);
  return rows;
}

/**
 * requireHeld, or: a request that ANSWERED before reaching the pause point
 * is no failed sync precondition but an answer, and FAILS the case with it.
 */
async function held(ctx, g, name, n, key, pending) {
  try {
    return await requireHeld(ctx, g, name, n, { key, timeoutMs: HELD_MS });
  } catch (err) {
    const early = pending.filter((x) => x.answered);
    if (early.length) {
      const said = await Promise.all(early.map(async (x) => {
        const r = await x.p;
        return `${x.q.name}: ${r.ok ? `${r.value.status} ${JSON.stringify(r.value.json)}` : String(r.error?.message ?? r.error).slice(0, 200)}`;
      }));
      const e = new Error(`${early.length} request(s) answered before reaching ${name}: ${said.join("; ")}`);
      e.code = "E2E_C16_UNHELD";
      throw e;
    }
    throw err;
  }
}

/**
 * Let the callers held at `name` go ONE AT A TIME (FIFO), each answered
 * before the next is let go: every one of them read before any wrote, and
 * their writes — the record and then its mirrors — follow one another, so
 * the lost update is the only race left (two mirrors written out of order
 * are the mirror-order case's, C16d).
 */
async function releaseInTurn(ctx, g, name, key, pending) {
  for (let k = 1; k <= pending.length; k += 1) {
    const r = await g.release(name, { count: 1, key });
    if (!r.released?.length) ctx.inconclusive(`the sync precondition did not hold: release ${k} of ${pending.length} at ${name} let nobody go`);
    await eventually(() => pending.filter((x) => x.answered).length >= k, { timeout: HELD_MS, interval: 100, message: `request ${k} of ${pending.length} answered after its release` });
  }
}

/** Release every gate this case armed, whatever happened. */
async function releaseAll(g, names) {
  for (const name of names) await g.release(name).catch(() => undefined);
}

// --- the server's state ---------------------------------------------------------------------

/** What the sharing changes leave: each record's grants and sets, each document's RTDB mirrors, each team's members and admins. */
async function snapshot({ docs = [], folders = [], teams = [] }) {
  const out = { docs: {}, folders: {}, teams: {} };
  for (const id of docs) {
    const rec = await readDoc(target, `docs/${id}`);
    out.docs[id] = rec
      ? {
          ownerEmail: String(rec.ownerEmail).toLowerCase(),
          folderId: rec.folderId ?? null,
          visibility: rec.visibility ?? "private",
          hasLink: typeof rec.linkToken === "string" && rec.linkToken.length > 0,
          grants: storedGrants(rec),
          sets: storedSets(rec),
          presence: keysOf(await rtdbGet(target, `presenceAccess/${id}`)),
          edit: keysOf(await rtdbGet(target, `editAccess/${id}`)),
        }
      : null;
  }
  for (const id of folders) {
    const rec = await readDoc(target, `folders/${id}`);
    out.folders[id] = rec ? { ownerEmail: String(rec.ownerEmail).toLowerCase(), parentId: rec.parentId ?? null, grants: storedGrants(rec), sets: storedSets(rec) } : null;
  }
  for (const id of teams) {
    const rec = await readDoc(target, `teams/${id}`);
    out.teams[id] = rec ? { members: sorted(rec.members ?? []), admins: sorted(rec.admins ?? []) } : null;
  }
  return out;
}

/**
 * The plan's server settle: the snapshot unchanged for SERVER_STABLE_MS
 * (lib/assert.mjs settleStill). One that never holds still is its
 * E2E_SETTLE_TIMEOUT, a FAIL here (these cases excuse only a stack that did
 * not answer): something kept writing after every request had been answered.
 */
async function settleServer(ctx, ids, what) {
  const state = await settleStill(() => snapshot(ids), {
    quietMs: SERVER_STABLE_MS,
    deadlineMs: SERVER_DEADLINE_MS,
    intervalMs: 1_000,
    what: `${what}: the records and mirrors`,
    step: (line) => ctx.step(line),
  });
  ctx.ev.json(`server-${slug(what)}`, state);
  return state;
}

/** The stored teams as computeMembership's team index: Map(teamId → members). */
function storedTeams(snap) {
  return new Map(Object.entries(snap.teams).map(([id, t]) => [id, t?.members ?? []]));
}

/** An I16 result with every failure prefixed by `where`. */
function labelled(r, where) {
  return { ...r, failures: r.failures.map((f) => `${where}: ${f}`) };
}

/** Each grant list that differs from what was asked, as I16 failures. */
function grantFailures(stored, asked) {
  const out = [];
  for (const k of Object.keys(asked)) {
    const want = new Set(asked[k]);
    const got = new Set(stored?.[k] ?? []);
    const missing = [...want].filter((x) => !got.has(x)).sort();
    const extra = [...got].filter((x) => !want.has(x)).sort();
    if (missing.length || extra.length) out.push(`grants ${k}: ${missing.length ? `lacks ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `has extra ${extra.join(", ")}` : ""}`);
  }
  return out;
}

/**
 * I16 CLOSURE on a document: its four sets equal computeMembership over what
 * it stores — its own grants, its folder's stored sets, the stored teams
 * (scripts/lib/membership.mjs, the product's twin).
 */
async function closureOfDoc(snap, docId) {
  const d = snap.docs[docId];
  assert.ok(d, `I16: docs/${docId} exists`);
  const parent = d.folderId ? (snap.folders[d.folderId]?.sets ?? null) : null;
  const computed = await expectedMembership(d.ownerEmail, d.grants, parent, storedTeams(snap));
  return labelled(checkI16({ stored: d.sets, computed }), `docs/${docId} against its own grants${d.folderId ? ", its folder's sets" : ""} and the stored teams`);
}

/** I16 CLOSURE on a folder at the root. */
async function closureOfFolder(snap, folderId) {
  const f = snap.folders[folderId];
  assert.ok(f, `I16: folders/${folderId} exists`);
  const parent = f.parentId ? (snap.folders[f.parentId]?.sets ?? null) : null;
  const computed = await expectedMembership(f.ownerEmail, f.grants, parent, storedTeams(snap));
  return labelled(checkI16({ stored: f.sets, computed }), `folders/${folderId} against its own grants${f.parentId ? " and its parent's sets" : ""}`);
}

/**
 * I16 AGAINST WHAT WAS ASKED: the record's grant lists are `grants` and its
 * sets computeMembership(owner, grants, parent, teams) — every request's
 * delta applied — and every access probe answered as expected.
 */
async function intentOf(rec, where, { ownerEmail, grants, parent = null, teams = new Map(), access = [] }) {
  const computed = await expectedMembership(ownerEmail, grants, parent, teams);
  const r = checkI16({ stored: rec?.sets ?? {}, computed, access });
  return labelled({ ...r, ok: r.ok && grantFailures(rec?.grants, grants).length === 0, failures: [...r.failures, ...grantFailures(rec?.grants, grants)] }, `${where} against what was asked`);
}

/** GET /content/{doc}/v1/ as each `who` ({s, expect}) → [{email, status, expect}]: I16's "grantees 200, removed 404". */
async function probes(docId, who) {
  return Promise.all(who.map(async ({ s, expect }) => {
    const r = answered(await s.http.get(`/content/${encodeURIComponent(docId)}/v1/`), `GET /content/${docId}/v1/ as ${s.account.role}`);
    return { email: emailOf(s), status: r.status, expect };
  }));
}

/** I14 on a document of the snapshot: its mirrors equal its members and editorMembers; `writes` [{email, verdict}] of revoked users must be DENY. */
function mirrorOf(snap, docId, writes = []) {
  const d = snap.docs[docId];
  return checkI14({ members: d?.sets.members ?? [], editorMembers: d?.sets.editorMembers ?? [], presenceAccess: asSet(d?.presence ?? []), editAccess: asSet(d?.edit ?? []), revokedWrites: writes });
}

/** I14's revoked-write leg alone: each of `writes` [{email, verdict}] (revoked users' y writes) is DENY. The mirror-equality leg is mirrorOf's. */
function revokedDenied(writes) {
  return checkI14({ members: [], editorMembers: [], presenceAccess: {}, editAccess: {}, revokedWrites: writes });
}

/** One y write as `s` (rtdbAs: the account's ID token as ?auth=, never a Bearer header) → {email, verdict, status}; an allowed probe is deleted again. */
async function yWrite(ctx, s, docId) {
  const db = rtdbAs(target, { idToken: s.idToken, http: ctx.http({ actor: `${s.account.role}-rtdb` }) });
  const entry = `c16-${rand4()}-${Date.now().toString(36)}`;
  const r = await db.put(`status/${docId}/y/${entry}`, `e2e c16 probe by ${s.account.role}`);
  if (r.verdict === "ALLOW") await db.delete(`status/${docId}/y/${entry}`).catch(() => undefined);
  return { email: emailOf(s), verdict: r.verdict, status: r.status };
}

/** I11 for invitations: each mailbox exactly its subjects, held for the plan's 10 s (one shared settle). */
async function mailOnce(ctx, expected) {
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const r = await box.expectMailboxes(expected, { timeout: MAIL_MS });
  ctx.step(`I11: ${Object.keys(expected).length} mailbox(es) exactly as expected, held for ${r.settledMs / 1000} s`);
}

/**
 * Each mailbox's subjects once the counts have held still for the plan's
 * 10 s (lib/assert.mjs settleStill) → {email: [subjects]}: what a case
 * MEASURES where the mail is the race's outcome rather than its oracle.
 */
async function mailSeen(ctx, emails, what) {
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  return settleStill(async () => Object.fromEntries(await Promise.all(emails.map(async (e) => [e, sorted((await box.find({ to: e })).map((m) => String(m.Subject ?? "")))]))), {
    quietMs: SERVER_STABLE_MS,
    deadlineMs: MAIL_MS,
    intervalMs: 1_000,
    what: `${what}: the mailboxes`,
    step: (line) => ctx.step(line),
  });
}

/** Every request answered 200. */
function judgeStatuses(rows, label) {
  const bad = rows.filter((r) => r.status !== 200);
  assert.ok(bad.length === 0, `${label}: every request answered 200 — ${bad.map((r) => `${r.name}: ${r.status ?? r.error} ${JSON.stringify(r.json)}`).join("; ")}`);
}

// =====================================================================================
// C16a — N concurrent grants
// =====================================================================================

/** The owner, N grantees and a document; request i grants grantee i its role. */
async function c16aSetup(ctx, label) {
  const [owner, ...grantees] = await people(ctx, ["owner", ...Array.from({ length: ctx.n }, (_, i) => `grantee${i + 1}`)]);
  const { docId, title } = await newDoc(owner, label);
  const plan = grantees.map((g, i) => ({ g, role: ROLE_CYCLE[i % ROLE_CYCLE.length] }));
  const reqs = plan.map(({ g, role }, i) => request(`grant ${i + 1} (${role})`, owner, "/access", { docId, add: [{ email: emailOf(g), role }] }));
  ctx.step(`${docId}: the owner grants ${plan.map(({ g, role }) => `${g.account.role} ${role}`).join(", ")}, one POST /access each`);
  return { owner, docId, title, plan, reqs };
}

/**
 * C16a's oracles. `own` names the case's defect's oracle: "intent" (S18: I16
 * against what was asked, and every grantee reads the document) or "mirror"
 * (X-c16-access-1: I14). `measuredOnly` names one the case records (a step
 * and a measure row) without judging it: in each race, the OTHER defect's,
 * which that race shows in some trials and not in others, so neither race's
 * verdict depends on whether the other defect happened to occur.
 */
async function judgeC16a(ctx, s, rows, label, { defect = null, own: ownOracle = "intent", measuredOnly = null } = {}) {
  const owner = emailOf(s.owner);
  const others = oracleSet();
  const own = oracleSet();
  const mail = settled(others.check(() => mailOnce(ctx, { [owner]: [], ...Object.fromEntries(s.plan.map(({ g }) => [emailOf(g), [invited(owner, s.title)]])) })));
  const snap = await settleServer(ctx, { docs: [s.docId] }, label);
  const mailed = await mail;
  if (!mailed.ok) throw mailed.error;
  const d = snap.docs[s.docId];
  await others.check(() => judgeStatuses(rows, label));
  await others.check(async () => assertInvariant(await closureOfDoc(snap, s.docId)));
  const asked = grantLists(s.plan.map(({ g, role }) => ({ principal: emailOf(g), role })));
  const access = await probes(s.docId, s.plan.map(({ g }) => ({ s: g, expect: 200 })));
  const results = { mirror: mirrorOf(snap, s.docId), intent: await intentOf(d, `docs/${s.docId}`, { ownerEmail: owner, grants: asked, access }) };
  const lost = s.plan.filter(({ g }) => !d?.sets.members.includes(emailOf(g))).map(({ g }) => g.account.role);
  ctx.step(`${label}: ${lost.length} of ${s.plan.length} grant(s) missing from members${lost.length ? ` (${lost.join(", ")})` : ""}; access ${access.map((a) => `${a.status}`).join(", ")}; mirrors ${results.mirror.ok ? "equal the record" : "differ from the record"}`);
  measure(ctx, MEASURE, { scenario: label, lost: lost.length, of: s.plan.length, mirrorEqual: results.mirror.ok, intentHeld: results.intent.ok, measuredOnly });
  for (const name of ["mirror", "intent"]) {
    const r = results[name];
    if (name === measuredOnly) {
      ctx.step(`${label}: ${name === "mirror" ? "I14" : "I16 against what was asked"} is measured here, not judged (another case's oracle): ${r.ok ? "it held" : r.failures.join("; ")}`);
      continue;
    }
    await (name === ownOracle ? own : others).check(() => assertInvariant(r));
  }
  verdict({ defect, others, own });
}

scenario("C16a N concurrent grants, S18 (SYNC-T): the owner's N POST /access, each adding one grantee, fired at one instant on the unpatched product, leave every grant in the record and every grantee reading the document (I16), and each grantee invited once (I11); the mirrors are measured, not judged", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", ...UNPATCHED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16aSetup(ctx, "C16a race S18");
  ctx.step(`stack patches: ${JSON.stringify(target.patches ?? [])}`);
  await warm(ctx, s.reqs.map(warmCall), "GET /access");
  const { rows, run } = await fire(ctx, s.reqs, "C16a race S18");
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  await judgeC16a(ctx, s, rows, "C16a race S18", { defect: null, own: "intent", measuredOnly: "mirror" });
});

scenario("C16a N concurrent grants, mirrors (SYNC-T): the owner's N POST /access, each adding one grantee, fired at one instant on the unpatched product, leave presenceAccess and editAccess equal to the record's members and editorMembers (I14), and each grantee invited once (I11); whether every grant is in the record is measured, not judged", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", ...UNPATCHED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16aSetup(ctx, "C16a race mirrors");
  ctx.step(`stack patches: ${JSON.stringify(target.patches ?? [])}`);
  await warm(ctx, s.reqs.map(warmCall), "GET /access");
  const { rows, run } = await fire(ctx, s.reqs, "C16a race mirrors");
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  await judgeC16a(ctx, s, rows, "C16a race mirrors", { defect: null, own: "mirror", measuredOnly: "intent" });
});

scenario("C16a S18 (SYNC-P): the owner's N POST /access, each adding one grantee, held before each membership transaction, then let go one at a time, leave every grant in the record and every grantee reading the document (I16)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16aSetup(ctx, "C16a S18");
  const gate = "doc-membership-before-write";
  let pending = [];
  try {
    await g.hold(gate, { key: s.docId });
    pending = sendAll(s.reqs);
    const h = await held(ctx, g, gate, s.reqs.length, s.docId, pending);
    ctx.step(`all ${s.reqs.length} grants are held in persistDocMembership, before its membership transaction (seq ${h.callers.map((c) => c.seq).join(", ")}); let go one at a time, each answered before the next`);
    await releaseInTurn(ctx, g, gate, s.docId, pending);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = await rowsOf(ctx, pending, "C16a S18");
  await judgeC16a(ctx, s, rows, "C16a S18", { defect: null });
});

scenario("C16a serial positive control: the same N POST /access one after another leave every grant in the record and every grantee reading the document (I16), the mirrors equal to the record (I14), and each grantee invited once (I11)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16aSetup(ctx, "C16a serial");
  const rows = await sendSerially(ctx, s.reqs, "C16a serial");
  await judgeC16a(ctx, s, rows, "C16a serial");
});

// =====================================================================================
// C16b — a folder grant, a document grant and team additions at once
// =====================================================================================

/**
 * The owner's folder F holding document D, and N−2 teams of the owner granted
 * on D (viewer); people: one for F (editor), one for D (viewer), one per team.
 * Request 0 is the folder grant, 1 the document grant, 2… the team additions.
 */
async function c16bSetup(ctx, label) {
  const teamsN = Math.max(0, ctx.n - 2);
  const [owner, pf, pd, ...pts] = await people(ctx, ["owner", "folderee", "docee", ...Array.from({ length: teamsN }, (_, i) => `teamee${i + 1}`)]);
  const ownerEmail = emailOf(owner);
  const F = await createFolder(owner.http, { name: `${label} folder ${tagOf()}`, ownerEmail, timeoutMs: HTTP_MS });
  precondition(F.status === 200 && typeof F.folderId === "string", `creating the folder: ${F.status} ${JSON.stringify(F.json)}`);
  const { docId, title } = await newDoc(owner, label, { folderId: F.folderId });
  const teams = [];
  for (let i = 0; i < teamsN; i += 1) {
    const t = await createTeam(owner.http, { name: `${label} team ${i + 1} ${tagOf()}`, ownerEmail, timeoutMs: HTTP_MS });
    precondition(t.status === 200 && typeof t.teamId === "string", `creating team ${i + 1}: ${t.status} ${JSON.stringify(t.json)}`);
    teams.push(t);
  }
  if (teams.length) {
    const r = await shareMany(target, { owner, doc: docId, grants: teams.map((t) => ({ team: t, role: "viewer" })), timeoutMs: HTTP_MS });
    precondition(r.status === 200, `granting the ${teams.length} team(s) on ${docId}: ${r.status}`);
  }
  const folderReq = request("folder grant (editor)", owner, "/folder-access", { folderId: F.folderId, add: [{ principal: emailOf(pf), role: "editor" }] });
  const docReq = request("document grant (viewer)", owner, "/access", { docId, add: [{ email: emailOf(pd), role: "viewer" }] });
  const teamReqs = teams.map((t, i) => request(`team ${i + 1} addition`, owner, "/team-members", { teamId: t.teamId, add: [emailOf(pts[i])] }));
  ctx.step(`${docId} is in folder ${F.folderId}${teams.length ? `, and ${teams.length} team(s) are granted on it` : ""}; at once: ${pf.account.role} editor on the folder, ${pd.account.role} viewer on the document${pts.length ? `, ${pts.map((p, i) => `${p.account.role} into team ${i + 1}`).join(", ")}` : ""}`);
  return { owner, pf, pd, pts, F, docId, title, teams, folderReq, docReq, teamReqs, reqs: [folderReq, docReq, ...teamReqs] };
}

/**
 * C16b's oracles. `mail` says how the mailboxes of the people who reach the
 * document through the folder or a team (not through the document grant) are
 * judged:
 *   "exact"     every mailbox exactly its one invitation (I11), the folder's
 *               or the team's;
 *   "tolerant"  each of them exactly one invitation of its own kind and at
 *               most one invitation to the DOCUMENT, nothing else: a document
 *               grant that read the document before a folder cascade or a
 *               team re-fan reached it counts them as newly invited
 *               (X-c16-access-2, which its own case judges); recorded here;
 *   "own"       as "tolerant", but the folder grantee's mailbox exactly the
 *               folder's invitation is the case's OWN oracle
 *               (X-c16-access-2); the membership oracles are then others.
 * The document grantee always holds exactly the document's invitation, the
 * owner nothing.
 */
async function judgeC16b(ctx, s, rows, label, { defect = null, mail: mode = "exact" } = {}) {
  const owner = emailOf(s.owner);
  const others = oracleSet();
  const own = oracleSet();
  const membership = mode === "own" ? others : own;
  const pf = emailOf(s.pf);
  const docInvite = invited(owner, s.title);
  const indirect = [{ p: s.pf, invite: invited(owner, s.F.name), kind: "folder" }, ...s.pts.map((p, i) => ({ p, invite: invited(owner, s.teams[i].name), kind: `team ${i + 1}` }))];
  const expectedMail = {
    [owner]: [],
    [emailOf(s.pd)]: [docInvite],
    ...(mode === "exact" ? Object.fromEntries(indirect.map((x) => [emailOf(x.p), [x.invite]])) : {}),
  };
  const mail = settled(others.check(() => mailOnce(ctx, expectedMail)));
  const snap = await settleServer(ctx, { docs: [s.docId], folders: [s.F.folderId], teams: s.teams.map((t) => t.teamId) }, label);
  const mailed = await mail;
  if (!mailed.ok) throw mailed.error;
  if (mode !== "exact") {
    // Their mail, read once the others have held still for 10 s (every
    // invitation is sent before its request answers).
    const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
    const seen = [];
    for (const x of indirect) {
      const to = emailOf(x.p);
      await box.waitFor({ to, subject: x.invite, timeout: MAIL_MS }).catch(() => undefined);
      seen.push({ ...x, to, got: sorted((await box.find({ to })).map((m) => String(m.Subject ?? ""))) });
    }
    const docInvited = seen.filter((x) => x.got.includes(docInvite));
    ctx.step(`${label}: invited to the DOCUMENT though they reach it through the folder or a team: ${docInvited.length ? docInvited.map((x) => `${x.p.account.role} (${x.kind})`).join(", ") : "nobody"}${docInvited.length ? " (X-c16-access-2)" : ""}`);
    ctx.ev.json(`mail-${slug(label)}`, seen.map(({ to, kind, got }) => ({ to, kind, got })));
    measure(ctx, MEASURE, { scenario: label, indirectDocInvitations: docInvited.length, foldereeDocInvitation: docInvited.some((x) => x.p === s.pf), of: indirect.length });
    for (const x of seen) {
      if (mode === "own" && x.p === s.pf) {
        await own.check(() => assert.deepEqual(x.got, [x.invite], `${label}: the folder grantee is invited once, to the folder, and to nothing else (I11): ${pf} received ${JSON.stringify(x.got)}`));
        continue;
      }
      await others.check(() => {
        const extra = x.got.filter((g) => g !== x.invite && g !== docInvite);
        assert.ok(x.got.filter((g) => g === x.invite).length === 1 && x.got.filter((g) => g === docInvite).length <= 1 && extra.length === 0, `I11: ${label}: ${x.to} (${x.kind}) holds its one ${x.kind} invitation, at most one document invitation and nothing else: ${JSON.stringify(x.got)}`);
      });
    }
  }
  await others.check(() => judgeStatuses(rows, label));
  await others.check(() => {
    const wrong = s.teams.map((t, i) => ({ t, want: sorted([owner, emailOf(s.pts[i])]), got: snap.teams[t.teamId]?.members ?? null })).filter((x) => JSON.stringify(x.want) !== JSON.stringify(x.got));
    assert.ok(wrong.length === 0, `${label}: each team holds its owner and the person added — ${wrong.map((x) => `teams/${x.t.teamId}: ${JSON.stringify(x.got)}, not ${JSON.stringify(x.want)}`).join("; ")}`);
  });
  await others.check(() => assertInvariant(mirrorOf(snap, s.docId)));

  const askedF = grantLists([{ principal: pf, role: "editor" }]);
  const parentAsked = await expectedMembership(owner, askedF, null);
  const askedD = grantLists([{ principal: emailOf(s.pd), role: "viewer" }, ...s.teams.map((t) => ({ principal: `team:${t.teamId}`, role: "viewer" }))]);
  const teamsAsked = new Map(s.teams.map((t, i) => [t.teamId, sorted([owner, emailOf(s.pts[i])])]));
  const newcomers = [s.pf, s.pd, ...s.pts];
  const access = await probes(s.docId, newcomers.map((p) => ({ s: p, expect: 200 })));
  const d = snap.docs[s.docId];
  const lost = newcomers.filter((p) => !d?.sets.members.includes(emailOf(p))).map((p) => p.account.role);
  ctx.step(`${label}: ${lost.length} of ${newcomers.length} newcomer(s) missing from the document's members${lost.length ? ` (${lost.join(", ")})` : ""}; access ${access.map((a) => a.status).join(", ")}`);
  measure(ctx, MEASURE, { scenario: label, lost: lost.length, of: newcomers.length, lostWho: lost, mirrorEqual: mirrorOf(snap, s.docId).ok });
  await membership.check(async () => assertInvariant(await closureOfDoc(snap, s.docId)));
  await membership.check(async () => assertInvariant(await closureOfFolder(snap, s.F.folderId)));
  await membership.check(async () => assertInvariant(await intentOf(snap.folders[s.F.folderId], `folders/${s.F.folderId}`, { ownerEmail: owner, grants: askedF })));
  await membership.check(async () => assertInvariant(await intentOf(d, `docs/${s.docId}`, { ownerEmail: owner, grants: askedD, parent: parentAsked, teams: teamsAsked, access })));
  verdict({ defect, others, own });
}

scenario("C16b folder + document + team grants (SYNC-T): a folder grant, a document grant and N−2 team additions reaching one document, fired at one instant, leave the document's sets equal to what was asked and to its folder, grants and teams (I16), every newcomer reading it, the mirrors equal to the record (I14), and one invitation each (I11)", {
  tiers: LOCAL,
  effects: ALL_MAIL,
  needs: ["mailpit", ...UNPATCHED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16bSetup(ctx, "C16b race");
  ctx.step(`stack patches: ${JSON.stringify(target.patches ?? [])}`);
  await warm(ctx, s.reqs.map(warmCall), "GET /folder-access, GET /access and refused POST /team-members, one per racing request");
  const { rows, run } = await fire(ctx, s.reqs, "C16b race");
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  await judgeC16b(ctx, s, rows, "C16b race", { defect: null, mail: "tolerant" });
});

scenario("C16b S18 stale parent (SYNC-P): the document grant and every team re-fan held in persistDocMembership before their membership transactions, the folder grant then answered, then they write one at a time; the document's sets still equal what was asked and its folder's (I16)", {
  tiers: LOCAL,
  effects: ALL_MAIL,
  needs: ["mailpit", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16bSetup(ctx, "C16b stale parent");
  const gate = "doc-membership-before-write";
  const docSide = [s.docReq, ...s.teamReqs];
  let pending = [];
  let folderRow = null;
  try {
    await g.hold(gate, { key: s.docId });
    pending = sendAll(docSide);
    await held(ctx, g, gate, docSide.length, s.docId, pending);
    ctx.step(`the ${docSide.length} document-side writer(s) are held in persistDocMembership, before their membership transactions; the folder grant runs to its answer`);
    const f = answered(await s.folderReq.send(), "the folder grant (POST /folder-access)");
    folderRow = { name: s.folderReq.name, status: f.status, json: f.json };
    ctx.step(`the folder grant answered ${f.status}; let the document-side writers go one at a time, each answered before the next`);
    await releaseInTurn(ctx, g, gate, s.docId, pending);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = [folderRow, ...(await rowsOf(ctx, pending, "C16b stale parent"))];
  await judgeC16b(ctx, s, rows, "C16b stale parent", { defect: null, mail: "tolerant" });
});

scenario("C16b S18 stale grants (SYNC-P): the folder grant's cascade held in recomputeSubtree after discovering the documents and before their transactions, the document grant and every team addition then answered one after another, then the cascade writes; the document's sets still equal what was asked and its grants (I16)", {
  tiers: LOCAL,
  effects: ALL_MAIL,
  needs: ["mailpit", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16bSetup(ctx, "C16b stale grants");
  const gate = "subtree-docs-before-write";
  const docSide = [s.docReq, ...s.teamReqs];
  let pending = [];
  let docRows = [];
  try {
    await g.hold(gate, { key: s.F.folderId });
    pending = sendAll([s.folderReq]);
    await held(ctx, g, gate, 1, s.F.folderId, pending);
    ctx.step(`the folder grant's cascade is held in recomputeSubtree, before recomputing ${s.docId}; the ${docSide.length} document-side writer(s) run one after another`);
    docRows = await sendSerially(ctx, docSide, "C16b stale grants, the document side");
    await g.release(gate);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = [...(await rowsOf(ctx, pending, "C16b stale grants, the folder grant")), ...docRows];
  await judgeC16b(ctx, s, rows, "C16b stale grants", { defect: null, mail: "tolerant" });
});

scenario("C16b folder grantee's invitation (SYNC-P): the folder grant's cascade held after writing the folder and before reading its documents, the document grant and every team addition then answered one after another, then the cascade goes on; the folder grantee is invited once, to the folder only (I11), as in every serial order", {
  tiers: LOCAL,
  effects: ALL_MAIL,
  needs: ["mailpit", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16bSetup(ctx, "C16b folder invitation");
  const gate = "subtree-before-docs-read";
  const docSide = [s.docReq, ...s.teamReqs];
  let pending = [];
  let docRows = [];
  try {
    await g.hold(gate, { key: s.F.folderId });
    pending = sendAll([s.folderReq]);
    await held(ctx, g, gate, 1, s.F.folderId, pending);
    ctx.step(`the folder grant wrote ${s.F.folderId}'s membership and its cascade is held before reading the documents; the ${docSide.length} document-side writer(s) run one after another`);
    docRows = await sendSerially(ctx, docSide, "C16b folder invitation, the document side");
    await g.release(gate);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = [...(await rowsOf(ctx, pending, "C16b folder invitation, the folder grant")), ...docRows];
  await judgeC16b(ctx, s, rows, "C16b folder invitation", { defect: null, mail: "own" });
});

scenario("C16b serial positive control: the same folder grant, document grant and team additions one after another leave the document's sets equal to what was asked and to its folder, grants and teams (I16), every newcomer reading it, the mirrors equal to the record (I14), and one invitation each (I11)", {
  tiers: LOCAL,
  effects: ALL_MAIL,
  needs: ["mailpit"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16bSetup(ctx, "C16b serial");
  const rows = await sendSerially(ctx, s.reqs, "C16b serial");
  await judgeC16b(ctx, s, rows, "C16b serial");
});

scenario("C16b serial positive control, the document side first: the document grant and the team additions, then the folder grant, one after another, leave the document's sets equal to what was asked and to its folder, grants and teams (I16), every newcomer reading it, the mirrors equal to the record (I14), and one invitation each, the folder grantee's to the folder only (I11)", {
  tiers: LOCAL,
  effects: ALL_MAIL,
  needs: ["mailpit"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16bSetup(ctx, "C16b serial doc first");
  // The order nearest the gated invitation case: there the document side finishes before the cascade reaches D.
  const rows = await sendSerially(ctx, [s.docReq, ...s.teamReqs, s.folderReq], "C16b serial doc first");
  await judgeC16b(ctx, s, rows, "C16b serial doc first");
});

// =====================================================================================
// C16b — folder grants: N concurrent POST /folder-access on one folder
// =====================================================================================

/**
 * The owner's folder F holding document D, and N grantees; request i grants
 * grantee i its role on F. With `child`, F also holds an empty folder C, the
 * cascade's last stop: a pause point keyed on C holds a request after it has
 * written F and re-fanned D, and before its fresh read of F.
 */
async function c16bFolderSetup(ctx, label, { child = false } = {}) {
  const [owner, ...grantees] = await people(ctx, ["owner", ...Array.from({ length: ctx.n }, (_, i) => `fgrantee${i + 1}`)]);
  const ownerEmail = emailOf(owner);
  const F = await createFolder(owner.http, { name: `${label} folder ${tagOf()}`, ownerEmail, timeoutMs: HTTP_MS });
  precondition(F.status === 200 && typeof F.folderId === "string", `creating the folder: ${F.status} ${JSON.stringify(F.json)}`);
  const C = child ? await createFolder(owner.http, { name: `${label} child ${tagOf()}`, parentId: F.folderId, ownerEmail, timeoutMs: HTTP_MS }) : null;
  if (child) precondition(C.status === 200 && typeof C.folderId === "string", `creating the child folder: ${C.status} ${JSON.stringify(C.json)}`);
  const { docId, title } = await newDoc(owner, label, { folderId: F.folderId });
  const plan = grantees.map((g, i) => ({ g, role: ROLE_CYCLE[i % ROLE_CYCLE.length] }));
  const reqs = plan.map(({ g, role }, i) => request(`folder grant ${i + 1} (${role})`, owner, "/folder-access", { folderId: F.folderId, add: [{ principal: emailOf(g), role }] }));
  ctx.step(`${docId} is in folder ${F.folderId}${C ? `, which also holds the empty folder ${C.folderId}` : ""}; the owner grants ${plan.map(({ g, role }) => `${g.account.role} ${role}`).join(", ")} on the folder, one POST /folder-access each`);
  return { owner, F, C, docId, title, plan, reqs };
}

/**
 * The folder grants' oracles. S18's own: I16 against what was asked on F
 * (grant lists and sets), on its child C when there is one, and on D (sets,
 * with F's asked membership as the parent), and every grantee reads D.
 * Others: 200s, closure on F (and C) and D, I14 on D, and I11 (each
 * grantee's mailbox exactly its folder invitation, the owner's empty). `mail`:
 *   "exact"     as above;
 *   "measured"  the race: setFolderAccess's invitees come from a fresh read
 *               of F after its own cascade, which another request's write
 *               can change either way, so each grantee's folder invitations
 *               are recorded (a step, and a measure row with the counts),
 *               never judged;
 *   "own"       the invitation case: I11 exact is the case's OWN oracle
 *               (X-c16-access-3), and the membership oracles are others.
 */
async function judgeC16bFolder(ctx, s, rows, label, { defect = null, mail: mode = "exact" } = {}) {
  const owner = emailOf(s.owner);
  const others = oracleSet();
  const own = oracleSet();
  const membership = mode === "own" ? others : own;
  const folderInvite = invited(owner, s.F.name);
  const mail = mode === "measured" ? Promise.resolve({ ok: true }) : settled((mode === "own" ? own : others).check(() => mailOnce(ctx, { [owner]: [], ...Object.fromEntries(s.plan.map(({ g }) => [emailOf(g), [folderInvite]])) })));
  const folders = [s.F.folderId, ...(s.C ? [s.C.folderId] : [])];
  const snap = await settleServer(ctx, { docs: [s.docId], folders }, label);
  const mailed = await mail;
  if (!mailed.ok) throw mailed.error;
  if (mode === "measured") {
    const seen = await mailSeen(ctx, [owner, ...s.plan.map(({ g }) => emailOf(g))], label);
    const per = s.plan.map(({ g }) => ({ who: g.account.role, folderInvitations: seen[emailOf(g)].filter((x) => x === folderInvite).length, other: seen[emailOf(g)].filter((x) => x !== folderInvite) }));
    ctx.ev.json(`mail-${slug(label)}`, { owner: seen[owner], per });
    ctx.step(`${label}: I11 measured, not judged: folder invitations per grantee ${per.map((p) => `${p.who} ${p.folderInvitations}${p.other.length ? ` (+ ${JSON.stringify(p.other)})` : ""}`).join(", ")}; the owner ${seen[owner].length}`);
    measure(ctx, MEASURE, { scenario: `${label} mail`, invitedNotOnce: per.filter((p) => p.folderInvitations !== 1).length, of: per.length, folderInvitations: per.map((p) => p.folderInvitations), otherMail: per.reduce((a, p) => a + p.other.length, 0) + seen[owner].length });
  }
  const askedF = grantLists(s.plan.map(({ g, role }) => ({ principal: emailOf(g), role })));
  const parentAsked = await expectedMembership(owner, askedF, null);
  const access = await probes(s.docId, s.plan.map(({ g }) => ({ s: g, expect: 200 })));
  const f = snap.folders[s.F.folderId];
  const d = snap.docs[s.docId];
  await others.check(() => judgeStatuses(rows, label));
  for (const id of folders) await others.check(async () => assertInvariant(await closureOfFolder(snap, id)));
  await others.check(async () => assertInvariant(await closureOfDoc(snap, s.docId)));
  await others.check(() => assertInvariant(mirrorOf(snap, s.docId)));
  const lostF = s.plan.filter(({ g }) => !Object.values(f?.grants ?? {}).flat().includes(emailOf(g))).map(({ g }) => g.account.role);
  const lostD = s.plan.filter(({ g }) => !d?.sets.members.includes(emailOf(g))).map(({ g }) => g.account.role);
  ctx.step(`${label}: ${lostF.length} of ${s.plan.length} grant(s) missing from the folder's grant lists${lostF.length ? ` (${lostF.join(", ")})` : ""}, ${lostD.length} grantee(s) missing from the document's members; access ${access.map((a) => a.status).join(", ")}; mirrors ${mirrorOf(snap, s.docId).ok ? "equal the record" : "differ from the record"}`);
  measure(ctx, MEASURE, { scenario: label, lost: lostF.length, lostFromDoc: lostD.length, of: s.plan.length, mirrorEqual: mirrorOf(snap, s.docId).ok });
  await membership.check(async () => assertInvariant(await intentOf(f, `folders/${s.F.folderId}`, { ownerEmail: owner, grants: askedF })));
  if (s.C) await membership.check(async () => assertInvariant(await intentOf(snap.folders[s.C.folderId], `folders/${s.C.folderId}`, { ownerEmail: owner, grants: grantLists([]), parent: parentAsked })));
  await membership.check(async () => assertInvariant(await intentOf(d, `docs/${s.docId}`, { ownerEmail: owner, grants: grantLists([]), parent: parentAsked, access })));
  verdict({ defect, others, own });
}

scenario("C16b folder grants (SYNC-T): the owner's N POST /folder-access on one folder, each adding one grantee, fired at one instant on the unpatched product, leave every grant in the folder's record, the folder's and its document's sets what was asked (I16) and every grantee reading the document; who is invited is measured, not judged", {
  tiers: LOCAL,
  effects: FOLDER_MAIL,
  needs: ["mailpit", ...UNPATCHED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16bFolderSetup(ctx, "C16b folder race");
  ctx.step(`stack patches: ${JSON.stringify(target.patches ?? [])}`);
  await warm(ctx, s.reqs.map(warmCall), "GET /folder-access");
  const { rows, run } = await fire(ctx, s.reqs, "C16b folder race");
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  await judgeC16bFolder(ctx, s, rows, "C16b folder race", { defect: null, mail: "measured" });
});

scenario("C16b folder grants S18 (SYNC-P): the owner's N POST /folder-access on one folder, held before each folder membership transaction, then let go one at a time, leave every grant in the folder's record, the folder's and its document's sets what was asked (I16), every grantee reading the document, and each invited once (I11)", {
  tiers: LOCAL,
  effects: FOLDER_MAIL,
  needs: ["mailpit", ...FOLDER_GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16bFolderSetup(ctx, "C16b folder S18");
  const gate = "folder-access-before-write";
  let pending = [];
  try {
    await g.hold(gate, { key: s.F.folderId });
    pending = sendAll(s.reqs);
    const h = await held(ctx, g, gate, s.reqs.length, s.F.folderId, pending);
    ctx.step(`all ${s.reqs.length} folder grants are held in setFolderAccess, before its folder membership transaction (seq ${h.callers.map((c) => c.seq).join(", ")}); let go one at a time, each answered before the next`);
    await releaseInTurn(ctx, g, gate, s.F.folderId, pending);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = await rowsOf(ctx, pending, "C16b folder S18");
  await judgeC16bFolder(ctx, s, rows, "C16b folder S18", { defect: null });
});

scenario("C16b folder grants serial positive control: the same N POST /folder-access one after another leave every grant in the folder's record, the folder's and its document's sets what was asked (I16), every grantee reading the document, the mirrors equal to the record (I14), and each invited once (I11)", {
  tiers: LOCAL,
  effects: FOLDER_MAIL,
  needs: ["mailpit"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16bFolderSetup(ctx, "C16b folder serial");
  const rows = await sendSerially(ctx, s.reqs, "C16b folder serial");
  await judgeC16bFolder(ctx, s, rows, "C16b folder serial");
});

scenario("C16b folder invitations (SYNC-P): the owner's first folder grant held at the end of its cascade (the folder and its document written, before sending its invitations), the other N−1 grants run to their answers one after another, then it goes on; nothing is lost, and each grantee is invited once, to the folder (I11), as in the serial order", {
  tiers: LOCAL,
  effects: FOLDER_MAIL,
  needs: ["mailpit", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16bFolderSetup(ctx, "C16b folder invitations", { child: true });
  // The cascade's last stop before setFolderAccess reads F afresh to find its invitees: the empty child folder C.
  const gate = "subtree-before-docs-read";
  const key = s.C.folderId;
  let first = [];
  const rest = [];
  try {
    await g.hold(gate, { key });
    first = sendAll([s.reqs[0]]);
    const h1 = await held(ctx, g, gate, 1, key, first);
    const firstCaller = h1.callers[0]?.caller;
    ctx.step(`${s.reqs[0].name} wrote ${s.F.folderId}'s grants and sets and re-fanned ${s.docId}; its cascade is held at the child folder, before sending its invitations; the other ${s.reqs.length - 1} grant(s) run to their answers one after another, each let past the child alone`);
    for (const q of s.reqs.slice(1)) {
      const p = sendAll([q]);
      rest.push(...p);
      const h = await held(ctx, g, gate, 2, key, [...first, ...p]);
      const caller = h.callers.find((c) => c.caller !== firstCaller)?.caller;
      if (!firstCaller || !caller) ctx.inconclusive(`the sync precondition did not hold: two distinct callers at ${gate} (${JSON.stringify(h.callers.map((c) => c.caller))})`);
      const rel = await g.releaseCaller(gate, { key, caller });
      if (rel.caller !== caller) ctx.inconclusive(`the sync precondition did not hold: releasing ${q.name} alone released ${rel.caller}`);
      await rowsOf(ctx, p, `C16b folder invitations, ${q.name}`);
    }
    ctx.step(`every later grant answered; let ${s.reqs[0].name} send its invitations`);
    await g.release(gate);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = [...(await rowsOf(ctx, first, "C16b folder invitations, the first grant")), ...(await rowsOf(ctx, rest, "C16b folder invitations, the others"))];
  await judgeC16bFolder(ctx, s, rows, "C16b folder invitations", { defect: null, mail: "own" });
});

scenario("C16b folder invitations serial positive control: the same N POST /folder-access on a folder holding a document and an empty child folder, one after another, leave every grant in the folder's record, every set what was asked (I16), every grantee reading the document, the mirrors equal to the record (I14), and each grantee invited once, to the folder (I11)", {
  tiers: LOCAL,
  effects: FOLDER_MAIL,
  needs: ["mailpit"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16bFolderSetup(ctx, "C16b folder invitations serial", { child: true });
  const rows = await sendSerially(ctx, s.reqs, "C16b folder invitations serial");
  await judgeC16bFolder(ctx, s, rows, "C16b folder invitations serial");
});

// =====================================================================================
// C16c — N team admins add members at once
// =====================================================================================

/** A team of the owner with N−1 more admins, granted (viewer) on the owner's document; admin i adds joiner i. */
async function c16cSetup(ctx, label) {
  const n = ctx.n;
  const all = await people(ctx, ["owner", ...Array.from({ length: n - 1 }, (_, i) => `admin${i + 1}`), ...Array.from({ length: n }, (_, i) => `joiner${i + 1}`)]);
  const [owner, ...rest] = all;
  const admins = rest.slice(0, n - 1);
  const joiners = rest.slice(n - 1);
  const ownerEmail = emailOf(owner);
  const team = await createTeam(owner.http, { name: `${label} team ${tagOf()}`, ownerEmail, timeoutMs: HTTP_MS });
  precondition(team.status === 200 && typeof team.teamId === "string", `creating the team: ${team.status} ${JSON.stringify(team.json)}`);
  if (admins.length) {
    const r = await teamMembers(owner.http, team, { add: admins.map((a) => a.account), timeoutMs: HTTP_MS });
    precondition(r.status === 200, `adding the admins as members: ${r.status}`);
    for (const a of admins) {
      const m = await teamMembers(owner.http, team, { admin: { email: emailOf(a), isAdmin: true }, timeoutMs: HTTP_MS });
      precondition(m.status === 200 && m.admins?.includes(emailOf(a)), `making ${a.account.role} an admin: ${m.status} ${JSON.stringify(m.json)}`);
    }
  }
  const { docId, title } = await newDoc(owner, label);
  const sh = await share(target, { owner, doc: docId, team, role: "viewer", timeoutMs: HTTP_MS });
  precondition(sh.status === 200, `granting the team on ${docId}: ${sh.status}`);
  const actors = [owner, ...admins];
  const reqs = actors.map((a, i) => request(`${a.account.role} adds ${joiners[i].account.role}`, a, "/team-members", { teamId: team.teamId, add: [emailOf(joiners[i])] }));
  ctx.step(`team ${team.teamId} (the owner and ${admins.length} admin(s)) is granted on ${docId}; at once, each of the ${actors.length} adds one person`);
  return { owner, admins, joiners, actors, team, docId, title, reqs };
}

async function judgeC16c(ctx, s, rows, label, { defect = null } = {}) {
  const owner = emailOf(s.owner);
  const others = oracleSet();
  const own = oracleSet();
  const expectedMail = Object.fromEntries(s.joiners.map((j, i) => [emailOf(j), [invited(emailOf(s.actors[i]), s.team.name)]]));
  const mail = settled(others.check(() => mailOnce(ctx, expectedMail)));
  const snap = await settleServer(ctx, { docs: [s.docId], teams: [s.team.teamId] }, label);
  const mailed = await mail;
  if (!mailed.ok) throw mailed.error;
  const t = snap.teams[s.team.teamId];
  const adminsAsked = sorted([owner, ...s.admins.map(emailOf)]);
  const membersAsked = sorted([owner, ...s.admins.map(emailOf), ...s.joiners.map(emailOf)]);
  await others.check(() => judgeStatuses(rows, label));
  await others.check(() => assert.deepEqual(t?.admins ?? null, adminsAsked, `${label}: the team's admins are unchanged`));
  await others.check(() => assertInvariant(mirrorOf(snap, s.docId)));
  // Closure is D's sets against the team as STORED: a lost write to teams/{t} (S19) cannot break it, since D is
  // re-fanned from whatever the team holds; only re-fan writes of D landing out of order can (S18's read-then-write
  // in refanTeam and persistDocMembership). So it is not S19's oracle, and a failure here is never filed as S19.
  await others.check(async () => assertInvariant(await closureOfDoc(snap, s.docId)));
  const access = await probes(s.docId, s.joiners.map((j) => ({ s: j, expect: 200 })));
  const lost = s.joiners.filter((j) => !(t?.members ?? []).includes(emailOf(j))).map((j) => j.account.role);
  ctx.step(`${label}: ${lost.length} of ${s.joiners.length} addition(s) missing from the team${lost.length ? ` (${lost.join(", ")})` : ""}; access ${access.map((a) => a.status).join(", ")}`);
  measure(ctx, MEASURE, { scenario: label, lost: lost.length, of: s.joiners.length, mirrorEqual: mirrorOf(snap, s.docId).ok });
  await own.check(() => {
    const missing = membersAsked.filter((e) => !(t?.members ?? []).includes(e));
    const extra = (t?.members ?? []).filter((e) => !membersAsked.includes(e));
    assert.ok(missing.length === 0 && extra.length === 0, `${label}: teams/${s.team.teamId} holds every member asked — ${missing.length ? `lacks ${missing.join(", ")}` : ""}${extra.length ? ` has extra ${extra.join(", ")}` : ""}`);
  });
  await own.check(async () => assertInvariant(await intentOf(snap.docs[s.docId], `docs/${s.docId}`, { ownerEmail: owner, grants: grantLists([{ principal: `team:${s.team.teamId}`, role: "viewer" }]), teams: new Map([[s.team.teamId, membersAsked]]), access })));
  verdict({ defect, others, own });
}

scenario("C16c N team admins (SYNC-T): the owner and N−1 admins of one team each add one person at one instant; the team holds everyone added, the document the team is granted on lets every one of them read it (I16), the mirrors equal the record (I14), and each is invited once (I11)", {
  tiers: LOCAL,
  effects: TEAM_MAIL,
  needs: ["mailpit", ...UNPATCHED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16cSetup(ctx, "C16c race");
  ctx.step(`stack patches: ${JSON.stringify(target.patches ?? [])}`);
  await warm(ctx, s.reqs.map(warmCall), "refused POST /team-members, one per admin");
  const { rows, run } = await fire(ctx, s.reqs, "C16c race");
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  await judgeC16c(ctx, s, rows, "C16c race", { defect: null });
});

scenario("C16c S19 (SYNC-P): the owner's and N−1 admins' additions to one team, held before each team membership transaction, then let go one at a time; the team holds everyone added and every one of them reads the document the team is granted on (I16)", {
  tiers: LOCAL,
  effects: TEAM_MAIL,
  needs: ["mailpit", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16cSetup(ctx, "C16c S19");
  const gate = "team-members-after-read";
  let pending = [];
  try {
    await g.hold(gate, { key: s.team.teamId });
    pending = sendAll(s.reqs);
    const h = await held(ctx, g, gate, s.reqs.length, s.team.teamId, pending);
    ctx.step(`all ${s.reqs.length} additions are held in manageTeamMembers, before its membership transaction (seq ${h.callers.map((c) => c.seq).join(", ")}); let go one at a time, each answered before the next`);
    await releaseInTurn(ctx, g, gate, s.team.teamId, pending);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = await rowsOf(ctx, pending, "C16c S19");
  await judgeC16c(ctx, s, rows, "C16c S19", { defect: null });
});

scenario("C16c serial positive control: the same N additions to one team one after another; the team holds everyone added, every one of them reads the document the team is granted on (I16), the mirrors equal the record (I14), and each is invited once (I11)", {
  tiers: LOCAL,
  effects: TEAM_MAIL,
  needs: ["mailpit"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16cSetup(ctx, "C16c serial");
  const rows = await sendSerially(ctx, s.reqs, "C16c serial");
  await judgeC16c(ctx, s, rows, "C16c serial");
});

// =====================================================================================
// C16c — a removal from a team against concurrent additions
// =====================================================================================

/**
 * A team of the owner with N−1 more admins and one more member who is no
 * admin, the leaver, granted EDITOR on the owner's document (so the leaver's
 * y write is allowed first). Request 0: the owner removes the leaver;
 * request i (1…N−1): admin i adds joiner i.
 */
async function c16cRemovalSetup(ctx, label) {
  const n = ctx.n;
  const all = await people(ctx, ["owner", ...Array.from({ length: n - 1 }, (_, i) => `admin${i + 1}`), "leaver", ...Array.from({ length: n - 1 }, (_, i) => `joiner${i + 1}`)]);
  const [owner, ...rest] = all;
  const admins = rest.slice(0, n - 1);
  const leaver = rest[n - 1];
  const joiners = rest.slice(n);
  const ownerEmail = emailOf(owner);
  const team = await createTeam(owner.http, { name: `${label} team ${tagOf()}`, ownerEmail, timeoutMs: HTTP_MS });
  precondition(team.status === 200 && typeof team.teamId === "string", `creating the team: ${team.status} ${JSON.stringify(team.json)}`);
  const r = await teamMembers(owner.http, team, { add: [...admins.map((a) => a.account), leaver.account], timeoutMs: HTTP_MS });
  precondition(r.status === 200 && r.members?.includes(emailOf(leaver)), `adding the admins and the leaver as members: ${r.status} ${JSON.stringify(r.json)}`);
  for (const a of admins) {
    const m = await teamMembers(owner.http, team, { admin: { email: emailOf(a), isAdmin: true }, timeoutMs: HTTP_MS });
    precondition(m.status === 200 && m.admins?.includes(emailOf(a)), `making ${a.account.role} an admin: ${m.status} ${JSON.stringify(m.json)}`);
  }
  const { docId, title } = await newDoc(owner, label);
  const sh = await share(target, { owner, doc: docId, team, role: "editor", timeoutMs: HTTP_MS });
  precondition(sh.status === 200, `granting the team editor on ${docId}: ${sh.status}`);
  await rulesEnforced(ctx);
  const before = await yWrite(ctx, leaver, docId);
  precondition(before.verdict === "ALLOW", `the leaver, an editor through the team, may write the live log before the removal: ${before.verdict ?? before.status}`);
  const removal = request(`${owner.account.role} removes ${leaver.account.role}`, owner, "/team-members", { teamId: team.teamId, remove: [emailOf(leaver)] });
  const additions = admins.map((a, i) => request(`${a.account.role} adds ${joiners[i].account.role}`, a, "/team-members", { teamId: team.teamId, add: [emailOf(joiners[i])] }));
  ctx.step(`team ${team.teamId} (the owner, ${admins.length} admin(s) and the leaver) is granted editor on ${docId}, and the leaver's y write is allowed; the owner removes the leaver while ${additions.map((q) => q.name).join(", ")}`);
  return { owner, admins, leaver, joiners, team, docId, title, removal, additions };
}

/**
 * S19's own oracle for the lost removal: the team holds exactly what was
 * asked (the leaver gone, every joiner in); D's sets equal computeMembership
 * over that team, every joiner reads D and the leaver gets the absent id's
 * 404 (SPEC §18 l.1954); and the leaver's own-token y write is DENIED (I14's
 * revoked-write leg). Others: 200s, the admins unchanged, I16 closure, I14's
 * mirror equality, I11 (each joiner invited once by its admin; the leaver's
 * mailbox exactly its two set-up invitations, the team's and the document's).
 */
async function judgeC16cRemoval(ctx, s, rows, label, { defect = null } = {}) {
  const owner = emailOf(s.owner);
  const leaver = emailOf(s.leaver);
  const others = oracleSet();
  const own = oracleSet();
  const expectedMail = {
    [leaver]: sorted([invited(owner, s.team.name), invited(owner, s.title)]),
    ...Object.fromEntries(s.joiners.map((j, i) => [emailOf(j), [invited(emailOf(s.admins[i]), s.team.name)]])),
  };
  const mail = settled(others.check(() => mailOnce(ctx, expectedMail)));
  const snap = await settleServer(ctx, { docs: [s.docId], teams: [s.team.teamId] }, label);
  const mailed = await mail;
  if (!mailed.ok) throw mailed.error;
  const t = snap.teams[s.team.teamId];
  const adminsAsked = sorted([owner, ...s.admins.map(emailOf)]);
  const membersAsked = sorted([owner, ...s.admins.map(emailOf), ...s.joiners.map(emailOf)]);
  await others.check(() => judgeStatuses(rows, label));
  await others.check(() => assert.deepEqual(t?.admins ?? null, adminsAsked, `${label}: the team's admins are unchanged`));
  await others.check(async () => assertInvariant(await closureOfDoc(snap, s.docId)));
  await others.check(() => assertInvariant(mirrorOf(snap, s.docId)));
  const access = await probes(s.docId, [...s.joiners.map((j) => ({ s: j, expect: 200 })), { s: s.leaver, expect: 404 }]);
  const leaverWrite = await yWrite(ctx, s.leaver, s.docId);
  const back = (t?.members ?? []).includes(leaver);
  const lost = s.joiners.filter((j) => !(t?.members ?? []).includes(emailOf(j))).map((j) => j.account.role);
  ctx.step(`${label}: the leaver is ${back ? "BACK in" : "out of"} the team; ${lost.length} of ${s.joiners.length} addition(s) missing${lost.length ? ` (${lost.join(", ")})` : ""}; access ${access.map((a) => `${a.status}`).join(", ")} (the leaver last); the leaver's y write ${leaverWrite.verdict ?? leaverWrite.status}`);
  measure(ctx, MEASURE, { scenario: label, removalLost: back, lost: lost.length, of: s.joiners.length, leaverWrite: leaverWrite.verdict ?? null, mirrorEqual: mirrorOf(snap, s.docId).ok });
  await own.check(() => {
    const missing = membersAsked.filter((e) => !(t?.members ?? []).includes(e));
    const extra = (t?.members ?? []).filter((e) => !membersAsked.includes(e));
    assert.ok(missing.length === 0 && extra.length === 0, `${label}: teams/${s.team.teamId} holds exactly the members asked —${missing.length ? ` lacks ${missing.join(", ")}` : ""}${extra.length ? ` has extra ${extra.join(", ")}` : ""}`);
  });
  await own.check(async () => assertInvariant(await intentOf(snap.docs[s.docId], `docs/${s.docId}`, { ownerEmail: owner, grants: grantLists([{ principal: `team:${s.team.teamId}`, role: "editor" }]), teams: new Map([[s.team.teamId, membersAsked]]), access })));
  await own.check(() => assertInvariant(revokedDenied([leaverWrite])));
  verdict({ defect, others, own });
}

scenario("C16c S19 lost removal (SYNC-P): the owner removes a member from a team granted editor on a document while N−1 admins each add one person, all held before their team membership transactions, the removal written first and the additions one at a time after it; the team holds exactly what was asked, the removed member reads 404 and cannot write the live log (I16, I14), and every added person reads the document", {
  tiers: LOCAL,
  effects: TEAM_MAIL,
  needs: ["mailpit", "rtdb-rules", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16cRemovalSetup(ctx, "C16c lost removal");
  const gate = "team-members-after-read";
  const key = s.team.teamId;
  let first = [];
  let rest = [];
  let removed = [];
  try {
    await g.hold(gate, { key });
    first = sendAll([s.removal]);
    const h1 = await held(ctx, g, gate, 1, key, first);
    const removalCaller = h1.callers[0]?.caller;
    rest = sendAll(s.additions);
    const all = await held(ctx, g, gate, 1 + s.additions.length, key, [...first, ...rest]);
    const addCallers = all.callers.filter((c) => c.caller !== removalCaller);
    if (!removalCaller || addCallers.length !== s.additions.length) ctx.inconclusive(`the sync precondition did not hold: the removal and ${s.additions.length} addition(s) held as distinct callers at ${gate} (${JSON.stringify(all.callers.map((c) => c.caller))})`);
    ctx.step(`the removal and the ${s.additions.length} addition(s) are held in manageTeamMembers, before its team membership transaction; let the removal go alone`);
    const rel = await g.releaseCaller(gate, { key, caller: removalCaller });
    if (rel.caller !== removalCaller) ctx.inconclusive(`the sync precondition did not hold: releasing the removal alone released ${rel.caller}`);
    removed = await rowsOf(ctx, first, "C16c lost removal, the removal");
    ctx.step("the removal wrote the team without the leaver, re-fanned the document and answered; let the additions go one at a time, each answered before the next");
    await releaseInTurn(ctx, g, gate, key, rest);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = [...removed, ...(await rowsOf(ctx, rest, "C16c lost removal, the additions"))];
  await judgeC16cRemoval(ctx, s, rows, "C16c lost removal", { defect: null });
});

scenario("C16c lost removal serial positive control: the owner's removal of a member from a team granted editor on a document, then the N−1 admins' additions one after another; the team holds exactly what was asked, the removed member reads 404 and cannot write the live log (I16, I14), every added person reads the document, and each is invited once (I11)", {
  tiers: LOCAL,
  effects: TEAM_MAIL,
  needs: ["mailpit", "rtdb-rules"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16cRemovalSetup(ctx, "C16c lost removal serial");
  const rows = await sendSerially(ctx, [s.removal, ...s.additions], "C16c lost removal serial");
  await judgeC16cRemoval(ctx, s, rows, "C16c lost removal serial");
});

// =====================================================================================
// C16d — visibility against a revoke
// =====================================================================================

/**
 * The owner and N−1 editors of a document, shared in ONE request (so the
 * setup races nothing); each editor's y write is allowed before anything
 * else. `newcomer: true` casts one more person for the mirror-order variant.
 */
async function c16dSetup(ctx, label, { newcomer = false } = {}) {
  const roles = ["owner", ...Array.from({ length: ctx.n - 1 }, (_, i) => `editor${i + 1}`), ...(newcomer ? ["newcomer"] : [])];
  const all = await people(ctx, roles);
  const owner = all[0];
  const editors = all.slice(1, ctx.n);
  const nc = newcomer ? all[ctx.n] : null;
  const { docId, title } = await newDoc(owner, label);
  const r = await shareMany(target, { owner, doc: docId, grants: editors.map((e) => ({ account: e.account, role: "editor" })), timeoutMs: HTTP_MS });
  precondition(r.status === 200, `sharing ${docId} with the ${editors.length} editor(s): ${r.status}`);
  await rulesEnforced(ctx);
  const before = await Promise.all(editors.map((e) => yWrite(ctx, e, docId)));
  precondition(before.every((w) => w.verdict === "ALLOW"), `every editor may write the live log before the revoke: ${before.map((w) => `${w.email} ${w.verdict ?? w.status}`).join(", ")}`);
  ctx.step(`${docId}: ${editors.length} editor(s), each allowed a y write before the revoke`);
  const remove = request(`remove the ${editors.length} editor(s)`, owner, "/access", { docId, remove: editors.map(emailOf) });
  const unlist = request("make it unlisted", owner, "/visibility", { docId, visibility: "unlisted" });
  const grant = nc ? request(`grant ${nc.account.role} (viewer)`, owner, "/access", { docId, add: [{ email: emailOf(nc), role: "viewer" }] }) : null;
  return { owner, editors, newcomer: nc, docId, title, remove, unlist, grant };
}

/**
 * After the revoke. `own` names the case's defect's oracle:
 *   "mirror"  (S20, X-c16-access-1) I14 — the mirrors equal the record, and
 *             every revoked editor's y write is DENIED; others: 200s, I16
 *             (closure, and the members asked: the owner, plus the newcomer
 *             when granted), each removed editor 404, the owner's own y
 *             write allowed, and, with `unlisted`, the document unlisted
 *             with a link;
 *   "record"  (S18's lost revoke) I16 against what was asked, each removed
 *             editor 404 included, and every revoked editor's y write DENIED
 *             (I14's revoked-write leg); others: the same, with I14's mirror
 *             equality in place of the record's intent.
 * With `granted`, the newcomer reads the document and is invited once (I11).
 */
async function judgeC16d(ctx, s, rows, label, { defect = null, unlisted = true, granted = false, own: ownOracle = "mirror" } = {}) {
  const owner = emailOf(s.owner);
  const others = oracleSet();
  const own = oracleSet();
  const mail = granted ? settled(others.check(() => mailOnce(ctx, { [emailOf(s.newcomer)]: [invited(owner, s.title)] }))) : Promise.resolve({ ok: true });
  const snap = await settleServer(ctx, { docs: [s.docId] }, label);
  const mailed = await mail;
  if (!mailed.ok) throw mailed.error;
  const d = snap.docs[s.docId];
  await others.check(() => judgeStatuses(rows, label));
  if (unlisted) await others.check(() => assert.ok(d?.visibility === "unlisted" && d.hasLink, `${label}: the document is unlisted, with a link (${d?.visibility}, link ${d?.hasLink})`));
  await others.check(async () => assertInvariant(await closureOfDoc(snap, s.docId)));
  const access = await probes(s.docId, [...s.editors.map((e) => ({ s: e, expect: 404 })), ...(granted ? [{ s: s.newcomer, expect: 200 }] : [])]);
  const intent = await intentOf(d, `docs/${s.docId}`, { ownerEmail: owner, grants: grantLists(granted ? [{ principal: emailOf(s.newcomer), role: "viewer" }] : []), access });
  const ownerWrite = await yWrite(ctx, s.owner, s.docId);
  await others.check(() => assert.equal(ownerWrite.verdict, "ALLOW", `${label}: the owner, an editor, may still write the live log (${ownerWrite.verdict ?? ownerWrite.status})`));
  const writes = await Promise.all(s.editors.map((e) => yWrite(ctx, e, s.docId)));
  const m = mirrorOf(snap, s.docId, writes);
  const back = s.editors.filter((e) => d?.sets.editorMembers.includes(emailOf(e))).length;
  ctx.step(`${label}: ${back} of ${s.editors.length} removed editor(s) back in the record's editorMembers; presenceAccess ${JSON.stringify(d?.presence)}, editAccess ${JSON.stringify(d?.edit)} for members ${JSON.stringify(d?.sets.members)}; the revoked editors' reads ${access.slice(0, s.editors.length).map((a) => a.status).join(", ")} and y writes ${writes.map((w) => w.verdict ?? w.status).join(", ")}`);
  measure(ctx, MEASURE, { scenario: label, revokedAllowed: writes.filter((w) => w.verdict === "ALLOW").length, of: writes.length, mirrorEqual: mirrorOf(snap, s.docId).ok, backInRecord: back });
  if (ownOracle === "record") {
    await others.check(() => assertInvariant(mirrorOf(snap, s.docId)));
    await own.check(() => assertInvariant(intent));
    await own.check(() => assertInvariant(revokedDenied(writes)));
  } else {
    await others.check(() => assertInvariant(intent));
    await own.check(() => assertInvariant(m));
  }
  verdict({ defect, others, own });
}

scenario("C16d visibility vs revoke (SYNC-T): the owner removes every editor while making the document unlisted, the two requests at one instant; the mirrors equal the record and every revoked editor's live write is refused (I14)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", "rtdb-rules", ...UNPATCHED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16dSetup(ctx, "C16d race");
  ctx.step(`stack patches: ${JSON.stringify(target.patches ?? [])}`);
  trackWindow(target, { owner: s.owner, doc: s.docId, visibility: "unlisted" });
  await warm(ctx, [s.remove, s.unlist].map(warmCall), "GET /access and a refused POST /visibility");
  const { rows, run } = await fire(ctx, [s.remove, s.unlist], "C16d race");
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  await judgeC16d(ctx, s, rows, "C16d race", { defect: null });
});

scenario("C16d S20 (SYNC-P): POST /visibility held after reading the members (the editors among them) and writing its record, the removal of every editor then answered, then the visibility change rewrites the mirrors; they still equal the record and every revoked editor's live write is refused (I14)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", "rtdb-rules", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16dSetup(ctx, "C16d S20");
  const gate = "visibility-before-mirror";
  trackWindow(target, { owner: s.owner, doc: s.docId, visibility: "unlisted" });
  let pending = [];
  let removed = null;
  try {
    await g.hold(gate, { key: s.docId });
    pending = sendAll([s.unlist]);
    await held(ctx, g, gate, 1, s.docId, pending);
    ctx.step("POST /visibility is held before it rewrites the mirrors, having read the members with the editors; the removal runs to its answer");
    const r = answered(await s.remove.send(), "the removal (POST /access)");
    removed = { name: s.remove.name, status: r.status, json: r.json };
    ctx.step(`the removal answered ${r.status}; let the visibility change go`);
    await g.release(gate);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = [removed, ...(await rowsOf(ctx, pending, "C16d S20"))];
  await judgeC16d(ctx, s, rows, "C16d S20", { defect: null });
});

scenario("C16d serial positive control: the removal of every editor, then the visibility change; the mirrors equal the record and every revoked editor's live write is refused (I14)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", "rtdb-rules"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16dSetup(ctx, "C16d serial");
  trackWindow(target, { owner: s.owner, doc: s.docId, visibility: "unlisted" });
  const rows = await sendSerially(ctx, [s.remove, s.unlist], "C16d serial");
  await judgeC16d(ctx, s, rows, "C16d serial");
});

scenario("C16d mirror order (SYNC-P): a grant to a newcomer held after writing its record and before its mirrors, the removal of every editor then reading that record and answered, then the grant refreshes the current mirrors; they still equal the record and every revoked editor's live write is refused (I14)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", "rtdb-rules", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16dSetup(ctx, "C16d mirror order", { newcomer: true });
  const gate = "doc-mirror-before-write";
  let pending = [];
  let rows = [];
  try {
    await g.hold(gate, { key: s.docId });
    pending = sendAll([s.grant]);
    const first = await held(ctx, g, gate, 1, s.docId, pending);
    const grantCaller = first.callers[0]?.caller;
    ctx.step(`the grant to ${s.newcomer.account.role} wrote its record and is held before its mirrors; the removal of every editor is sent`);
    const removal = sendAll([s.remove]);
    const both = await held(ctx, g, gate, 2, s.docId, [...pending, ...removal]);
    const removalCaller = both.callers.find((c) => c.caller !== grantCaller)?.caller;
    if (!grantCaller || !removalCaller) ctx.inconclusive(`the sync precondition did not hold: two distinct callers at ${gate} (${JSON.stringify(both.callers.map((c) => c.caller))})`);
    const rel = await g.releaseCaller(gate, { key: s.docId, caller: removalCaller });
    if (rel.caller !== removalCaller) ctx.inconclusive(`the sync precondition did not hold: releasing the removal alone released ${rel.caller}`);
    const removed = await rowsOf(ctx, removal, "C16d mirror order, the removal");
    ctx.step("the removal wrote its record and its mirrors and answered; let the grant write its mirrors");
    await g.release(gate);
    rows = [...removed, ...(await rowsOf(ctx, pending, "C16d mirror order, the grant"))];
  } finally {
    await releaseAll(g, [gate]);
  }
  await judgeC16d(ctx, s, rows, "C16d mirror order", { defect: null, unlisted: false, granted: true });
});

scenario("C16d mirror order serial positive control: the grant to a newcomer, then the removal of every editor; the mirrors equal the record and every revoked editor's live write is refused (I14)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", "rtdb-rules"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c16dSetup(ctx, "C16d mirror order serial", { newcomer: true });
  const rows = await sendSerially(ctx, [s.grant, s.remove], "C16d mirror order serial");
  await judgeC16d(ctx, s, rows, "C16d mirror order serial", { unlisted: false, granted: true });
});

scenario("C16d S18 lost revoke (SYNC-P): a grant to a newcomer held before its membership transaction, the removal of every editor then reading the same record, let past alone and answered, then the grant applies its delta to current grants; every removed editor stays out of the record and reads 404 (I16), and every revoked editor's live write is refused (I14)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", "rtdb-rules", ...GATED],
  n: [2, 5, 10, 20],
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await c16dSetup(ctx, "C16d lost revoke", { newcomer: true });
  const gate = "doc-membership-before-write";
  let pending = [];
  let rows = [];
  try {
    await g.hold(gate, { key: s.docId });
    pending = sendAll([s.grant]);
    const first = await held(ctx, g, gate, 1, s.docId, pending);
    const grantCaller = first.callers[0]?.caller;
    ctx.step(`the grant to ${s.newcomer.account.role} is held before its membership transaction; the removal of every editor is sent`);
    const removal = sendAll([s.remove]);
    const both = await held(ctx, g, gate, 2, s.docId, [...pending, ...removal]);
    const removalCaller = both.callers.find((c) => c.caller !== grantCaller)?.caller;
    if (!grantCaller || !removalCaller) ctx.inconclusive(`the sync precondition did not hold: two distinct callers at ${gate} (${JSON.stringify(both.callers.map((c) => c.caller))})`);
    const rel = await g.releaseCaller(gate, { key: s.docId, caller: removalCaller });
    if (rel.caller !== removalCaller) ctx.inconclusive(`the sync precondition did not hold: releasing the removal alone released ${rel.caller}`);
    const removed = await rowsOf(ctx, removal, "C16d lost revoke, the removal");
    ctx.step("the removal read the same record, wrote it without the editors, wrote its mirrors and answered; let the grant apply its delta to the current grants");
    await g.release(gate);
    rows = [...removed, ...(await rowsOf(ctx, pending, "C16d lost revoke, the grant"))];
  } finally {
    await releaseAll(g, [gate]);
  }
  await judgeC16d(ctx, s, rows, "C16d lost revoke", { defect: null, unlisted: false, granted: true, own: "record" });
});

scenario("C16d S18 lost revoke serial positive control: the removal of every editor, then the grant to a newcomer; every removed editor stays out of the record and reads 404 (I16), the mirrors equal the record and every revoked editor's live write is refused (I14), and the newcomer is invited once (I11)", {
  tiers: LOCAL,
  effects: ACCESS_MAIL,
  needs: ["mailpit", "rtdb-rules"],
  n: [2, 5, 10, 20],
  trials: { 2: 2, 5: 1, 10: 1, 20: 1 }, // a serial positive control shows the oracles pass without the race: no statistics needed
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  // The order the gated case lets them write in: the removal, then the grant.
  const s = await c16dSetup(ctx, "C16d lost revoke serial", { newcomer: true });
  const rows = await sendSerially(ctx, [s.remove, s.grant], "C16d lost revoke serial");
  await judgeC16d(ctx, s, rows, "C16d lost revoke serial", { unlisted: false, granted: true, own: "record" });
});
