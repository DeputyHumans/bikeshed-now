// SPDX-License-Identifier: Apache-2.0
// Concurrency C17, C19, C20: one identity under concurrent requests — N publishes at one id, N forks, N thumbnail captures and N anonymous views (C17); a burst of wrong verification codes and of code requests by one account (C19); N spends of one OAuth code and of one refresh token (C20) (SPEC §2, §4, §14, §17, §21, §23).

/**
 * THE SCENARIOS (each n: [2, 5, 10, 20]; races and gated cases K trials per
 * N by the plan, serial positive controls 2/1/1/1). Every case is HTTP only:
 * no browser. A race is N requests fired from N worker threads at one
 * instant (lib/sync.mjs syncHttp with the target: every request checked by
 * the isolation tripwire and the guard and traced into the case's
 * http.jsonl; spread ≤ 15 ms and the overlap proof max(send) <
 * min(firstByte), or INCONCLUSIVE), after N concurrent requests the function
 * answers without changing anything warmed one function worker per racer.
 * Each racer's socket is warmed on a static file (lib/workers.mjs
 * staticWarmUrl), which starts no worker.
 *
 * C17a  same id. N accounts POST /publish at one requested id. Oracles: every
 *       request 200; one document has the id and the other N−1 have it with
 *       a random six-character suffix, all distinct (SPEC §4); each is owned
 *       by its publisher, under its title, at v1, and its v1 is the bytes its
 *       publisher sent, whose hash is the version's contentHash (REHASH, I7);
 *       the Storage objects under the id belong to those N documents only;
 *       on a stack with the Storage shim, every object of each document's
 *       v1 reached Storage as a create-only write that Storage judged and
 *       stored (SPEC §4 "a new document's bytes are written only where no
 *       object exists yet"; judgeCreateOnly).
 *         race (SYNC-T; needs storage-preconditions, see below), serial
 *         positive control (the same publishes one after another: every
 *         one after the first finds the id's record and is suffixed, SPEC §4
 *         "An id is taken if a record holds it"; runs on every stack).
 * C17b  N forks. N readers of an unlisted link POST /fork {op: "create", k}.
 *         own titles   each fork titled its own: no id is contended, so this
 *              measures the count alone.
 *         one-click    no title, as the app's one-click Fork sends: every
 *              fork takes the source's title, so its id is contended too.
 *       Oracles: every request 200; N distinct forks (one-click: one at the
 *       title's slug and N−1 suffixed, SPEC §4, §21 "Its title"); stats.forks
 *       up by exactly N and N fork.created events on the source's log (SPEC
 *       §21 "The count therefore never disagrees with the forks that
 *       exist"); each forks/{id} names the source, v1 and its contentHash;
 *       each fork is the forker's, private, trusted:false, forked, its v1
 *       publishedVia "fork" holding the source's bytes (REHASH); with the
 *       Storage shim, each fork's v1 objects were copied in create-only.
 *         own titles (SYNC-T), one-click (SYNC-T; needs
 *         storage-preconditions), one-click serial positive control (the
 *         same forks one after another, suffixed through the record check;
 *         runs on every stack).
 * C17c  thumbnails. The owner and N−1 editors POST /thumb kind=cover for v1
 *       at one instant (each a distinct JPEG), then kind=slides (two images
 *       each). Oracles: every request 200; per kind exactly one {stored:
 *       true}; the record is {versionId: v1, rev, cover: K1, slides: {key:
 *       K2, count: 2}}; Storage under the version's thumbnails holds exactly
 *       K1's cover and K2's two slides, so every loser deleted what it wrote
 *       (SPEC §2); GET /thumb serves the bytes of every upload told
 *       {stored: true}, since that answer says its key is the record;
 *       updatedAt untouched.
 * C17d  anonymous views. N anonymous readers of an unlisted link POST /view
 *       with sessions of their own, at one instant. Oracles: every request
 *       200 with its own ms; stats.views up by N and stats.totalMs by their
 *       sum, stats.viewers unchanged; N views/{sessionId} with uid and email
 *       null, via "unlisted"; no viewers/{uid}; updatedAt untouched (SPEC §4,
 *       §17).
 * C19a  wrong codes at once (LOCAL: mails a code). One unverified account
 *       starts a verification (one code mailed, read from Mailpit), then
 *       sends WRONG_AT_ONCE[N] wrong codes, then wrong codes one at a time
 *       until one is refused. S22's own oracle: at most VERIFY_MAX_ATTEMPTS
 *       (5) guesses at the code are evaluated (answered 400 "that code is
 *       not right"). Others: every guess is refused as wrong, too many or
 *       none in progress; the guesses end in the lockout (429); no code is
 *       left in progress; the right code is refused after it; the account
 *       stays unverified; one code mail in all (I11).
 *         race (SYNC-T), S22 (SYNC-P: the burst held at
 *         verify-complete-after-read, every guess having read the count, let
 *         go one at a time; the transaction must re-read), serial positive control.
 * C19b  code requests at once (LOCAL). One unverified account sends
 *       STARTS_AT_ONCE[N] POST /verify/start. S23's own oracle: one 200 and
 *       one code mail (the rest 429, the 60 s resend gap). Others: every
 *       answer 200 {sent: true} or 429; at least one 200; the code stored is
 *       one of those mailed, and it verifies the account.
 *         race (SYNC-T), S23 (SYNC-P: the requests held at
 *         verify-start-after-read, each having read the verification in
 *         progress, let go one at a time; the transaction must re-read), serial positive control.
 * C20a  N exchanges of one code. An app (DCR, a loopback redirect never
 *       followed) is approved through the API; the code is spent N times at
 *       once. Oracles: every exchange 200 with the identical bsa_/bsr_ pair
 *       (SPEC §23: spent in the transaction that mints the grant; a retry
 *       within 60 s gets the identical pair); one grant, generation 0, not
 *       revoked, its mirror; the code names it; the bsa_ initializes /mcp.
 * C20b  N refreshes of one bsr_. The pair from one exchange is refreshed N
 *       times at once. Oracles: every refresh 200 with the identical pair,
 *       rotated from the first; one grant, rotated once (generation 1), its
 *       hashes the new pair's and the spent one's, not revoked; the new bsa_
 *       initializes /mcp; the new bsr_ refreshes again (generation 2: the
 *       chain did not fork).
 *
 * SIZES. C19's catalogue numbers, 50 wrong codes and 10 code requests, are
 * the N=20 sizes; below it they scale with N (WRONG_AT_ONCE,
 * STARTS_AT_ONCE), as every other scenario's burst does. Six wrong codes at
 * N=2 is one more than the limit, so the burst alone can exceed it; a lost
 * update shows at any size through the guesses sent one at a time after it.
 *
 * FUNCTION WORKERS (lib/workers.mjs, README "Function workers in an
 * HTTP-only case"). Every concurrent request to a function is a
 * Functions-emulator worker of about 216 MB that the emulator never reaps,
 * so this file at N=5 once held 58 processes (11.46 GB) with no browser.
 * Each case therefore starts by handing back the idle workers the cases
 * before it left (retireIdleWorkers: the emulator's own reload, between
 * cases, never mid-race), and before each burst waits for room for one
 * worker per concurrent request (admitWorkers, else INCONCLUSIVE). What the
 * stack holds after the warm-up and after the burst is kept as evidence
 * (functionWorkers). Production resolves all three at once.
 *
 * STORAGE PRECONDITIONS. C17a and the one-click forks rest on Storage
 * refusing a second create-only write (functions/src/lib/publish.ts:276,
 * CREATE_ONLY = ifGenerationMatch: 0, used by placeNewDocument and fork.ts).
 * Both declare `needs: ["storage-preconditions"]`: only a Storage that the
 * stack's readiness probe saw refuse a second create-only write and copy
 * gives that capability (lib/storage-preconditions.mjs).
 *   - A PLAIN local stack lacks it: the Storage emulator of firebase-tools
 *     15.25.1 has no generation preconditions at all, so both races are
 *     SKIPPED there, declaratively. (Run there, the race shows what an
 *     unguarded create does: the losers answer 500, and a loser's bytes can
 *     replace the winner's v1.)
 *   - A stack built with --storage-shim HAS it: the aux process runs a
 *     loopback proxy in front of the emulator, which every function worker
 *     dials, and which judges each ifGenerationMatch write and copy under
 *     one lock per object and answers 412 as Cloud Storage does
 *     (lib/storage-shim.mjs). The races RUN there. The cases also read the
 *     shim's decisions (shimMark, shimSince): a race says whether a loser
 *     was refused by Storage at the contended id (the bytes half of SPEC
 *     §4's rule), found the winner's record first (the record half) or sent
 *     no precondition at all (unguarded), and
 *     every C17a and C17b case judges that each new document's v1 objects
 *     reached Storage create-only (judgeCreateOnly), which no other target
 *     lets a spec observe: elsewhere a step says it was not checked.
 *   - Production's Cloud Storage implements the preconditions itself, but
 *     prodTarget() is not built yet (lib/target.mjs throws
 *     PROD_NOT_IMPLEMENTED). Both races stay on the production phase's
 *     must-run list.
 * The serial positive controls (C17a serial, C17b one-click serial) send the
 * same publishes and forks one after another, so each after the first finds
 * the id's record (functions/src/lib/folders.ts:179-185 uniqueDocId) and is
 * suffixed: the record half alone, with the race's own oracles, on every
 * stack.
 *
 * STACK. The races at one id need the Storage shim, and the gated cases the
 * gate service and this unit's amplify set:
 *   node e2e/run.mjs run --suite concurrency --spec c17-identity.spec.mjs \
 *     --patches amplify-c17-identity --storage-shim --n 2 --trials 2
 * Without --storage-shim, C17a's race and the one-click race are SKIPPED (no
 * storage-preconditions); without the amplify set, the gated cases are
 * (no gates, no patch:amplify-c17-identity). Every other case runs on any
 * stack. On a patched one the unarmed pause points cost each verification
 * request one loopback round trip between its read and its write, which the
 * race steps note. On a shim stack every product write of one Storage
 * object waits for the one before it (the shim's lock per object), and each
 * create-only write costs one loopback metadata read.
 *
 * SPEC (docs/architecture/spec.md):
 *   §4 (l. 596–603) "If the id is taken the document is still created, at
 *     {id}-{six random [a-z0-9]}. An id is taken if a record holds it or if
 *     bytes are already stored under it: a new document's bytes are written
 *     only where no object exists yet, and a refused write moves the
 *     document to a suffixed id. … The returned docId is the answer".
 *   §21 (l. 2396) "Its title | the source's, unless one is given. The id
 *     comes from it and takes the random suffix when taken (§4)"; (l.
 *     2400–2403) "Everything is written in ONE batch: the fork's record, its
 *     v1, its forks/{forkDocId} record, and stats.forks incremented on the
 *     source. The count therefore never disagrees with the forks that exist".
 *   §2 POST /thumb (l. 254–256) "The objects go in under a key minted per
 *     upload, and a transaction makes that key the record's only if this kind
 *     is not yet stored for v by this revision; a loser deletes what it
 *     wrote"; (l. 260) "Never touches updatedAt".
 *   §4 (l. 560–565) stats "always as a nested map under set(…, {merge:
 *     true}) so the view writer and the edit writer never clobber each
 *     other. recordView deliberately does NOT touch updatedAt"; §17 (l.
 *     1894–1896) "Anonymous sessions record uid: null, count toward
 *     stats.views and stats.totalMs, and are never rolled into
 *     viewers/{uid}"; §2 (l. 419–421) POST /view "Carries k in the body for
 *     an unlisted document".
 *   §14 verification challenges: at most five wrong comparisons per code,
 *     one resend reservation per account in sixty seconds, checked and
 *     updated transactionally; mail and Auth calls stay outside retries.
 *   §23 (l. 2768–2775) "The code is spent in the transaction that mints the
 *     grant. Rotation: … A retry of the same spend within 60 s receives the
 *     identical pair, so a timeout cannot fork the chain".
 *
 * REGRESSION HISTORY. Before the transaction repair, S22 evaluated 8–10
 * guesses at N=2 and 15–17 at N=5 because requests read one stale attempt
 * count, then wrote count + 1. S23 mailed several competing codes after
 * concurrent requests passed one stale resend check. The authorized repair
 * treats both as concrete security/correctness harm and §14 now names the
 * limits. These cases are normal assertions; the historical Q classification
 * is retained only in campaign baseline evidence.
 *
 * In a `defect:` case only that defect's own oracle is an AssertionError (a
 * TODO); every other oracle that fails there is a plain error, a FAIL, so one
 * defect never hides another failure. A failed sync precondition (a spread
 * over 15 ms, no overlap, a gate that never held its callers) is
 * INCONCLUSIVE, never FAIL.
 */

import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { after } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { answered, currentTarget, escapeRe, precondition, scenario } from "../../lib/test.mjs";
import { cast, castUnverified, rand4, runTag } from "../../lib/accounts.mjs";
import { idToken, openSessions } from "../../lib/session.mjs";
import { docIdFor, ledgerDoc, publish } from "../../lib/seed.mjs";
import { setVisibility } from "../../lib/grant.mjs";
import { grantEditors } from "../../lib/live.mjs";
import { adminFor, closeAdmin, listObjects, queryCollection, readCollection, readDoc } from "../../lib/admin.mjs";
import { mailbox, MAIL_SETTLE_MS } from "../../lib/mail/reader.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { requireConclusive, syncHttp } from "../../lib/sync.mjs";
import { measure } from "../../lib/evidence.mjs";
import { eventually, settleStill } from "../../lib/assert.mjs";
import { rehashVersion } from "../../lib/bytes.mjs";
import { jpegSkeleton, thumbPath, thumbRevision } from "../../lib/thumbs.mjs";
import { approveViaApi, authorizeParams, pkce, register } from "../../lib/oauth.mjs";
import { appendLedger } from "../../lib/ledger.mjs";
import { treeConstant } from "../../lib/target.mjs";
import { admitWorkers, functionWorkers, retireIdleWorkers, staticWarmUrl } from "../../lib/workers.mjs";
import { STORAGE_PRECONDITIONS } from "../../lib/storage-preconditions.mjs";
import { STORAGE_SHIM, storageShim } from "../../lib/storage-shim.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const BOTH = ["local", "prod"];
const LOCAL = ["local"];
const NS = [2, 5, 10, 20];
/** A serial positive control shows the oracles pass without the race: no statistics needed. */
const SERIAL_TRIALS = { 2: 2, 5: 1, 10: 1, 20: 1 };
const GATED = ["gates", "patch:amplify-c17-identity"];
const VERIFY_MAIL = ["email:POST /verify/start"];
const CASE_MS = 420_000;
/** A request of the case's own, past Hosting's cut-off so a stalled one ends in its 504. */
const HTTP_MS = 150_000;
/** How long a gate may wait for its callers: well inside Hosting's 60 s cut-off for those already held. */
const HELD_MS = 40_000;
/** The plan's server settle: counts stable for 10 s (lib/assert.mjs settleStill's defaults, named here because the plan names them). */
const SERVER_STABLE_MS = 10_000;
const SERVER_DEADLINE_MS = 120_000;
const MAIL_MS = 90_000;
const MEASURE = "c17-identity";

/** functions/src/index.ts: the guesses one code allows, read from the tree the stack runs. */
const VERIFY_MAX_ATTEMPTS = target ? Number(treeConstant(target, "functions/src/index.ts", "VERIFY_MAX_ATTEMPTS")) : 5;
/** C19's burst sizes per N: the catalogue's 50 wrong codes and 10 code requests at N=20 (see SIZES). */
const WRONG_AT_ONCE = Object.freeze({ 2: 6, 5: 13, 10: 25, 20: 50 });
const STARTS_AT_ONCE = Object.freeze({ 2: 2, 5: 5, 10: 10, 20: 10 });
const wrongAtOnce = (n) => WRONG_AT_ONCE[n] ?? Math.max(VERIFY_MAX_ATTEMPTS + 1, Math.ceil(2.5 * n));
const startsAtOnce = (n) => STARTS_AT_ONCE[n] ?? Math.max(2, Math.min(n, 10));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAssertion = (err) => err instanceof AssertionError || err?.code === "ERR_ASSERTION";
/** A promise that never rejects: {ok, value} or {ok: false, error}. */
const settled = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const emailOf = (s) => String(s.account.email).toLowerCase();
const tagOf = () => `${runTag(target.runId)} ${rand4()}`;
const sorted = (xs) => [...xs].sort();
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const brief = (x, n = 300) => String(typeof x === "string" ? x : JSON.stringify(x)).slice(0, n);
const stamp = (v) => (v == null ? null : JSON.stringify(v));

/** functions/src/lib/folders.ts slugify, pinned. */
function slugifyPinned(name) {
  const base = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return base || "untitled";
}

/** The id a fork's title asks for: fork.ts places it at slugify(title), and uniqueDocId slugifies that again. */
const productSlug = (title) => slugifyPinned(slugifyPinned(title));

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
    err.code = "E2E_C17_OTHER_ORACLE";
    throw err;
  }
  if (ownMsgs.length) throw new AssertionError({ message: ownMsgs.join(" | "), actual: ownMsgs, expected: [], operator: defect });
}

// --- people and documents -----------------------------------------------------------------

/** Cast `roles` and open a session for each, five at a time: [{account, http, idToken, uid}] in order. */
async function people(ctx, roles) {
  const accounts = await cast(target, roles, { http: ctx.http({ actor: "harness" }) });
  return openSessions(target, accounts, { timeoutMs: HTTP_MS, cutoffError: true });
}

function docHtml(title, marker) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<p id="c17-1">One name, many hands at once: ${marker}.</p>
</body>
</html>
`;
}

/** A document `owner` publishes → {docId, title, html}. */
async function newDoc(owner, label) {
  const title = `${label} ${tagOf()}`;
  const html = docHtml(title, `source-${rand4()}`);
  const up = await publish(owner.http, { body: html, filename: "index.html", title, name: "c17", ownerEmail: emailOf(owner), timeoutMs: HTTP_MS });
  precondition(up.status === 200 && up.docId, `publishing ${label}: ${up.status} ${JSON.stringify(up.json)}`);
  return { docId: up.docId, title, html };
}

/** The owner makes `docId` unlisted (closed again when the case ends) → its link key. */
async function unlisted(owner, docId) {
  const vis = await setVisibility(target, { owner, doc: docId, visibility: "unlisted", timeoutMs: HTTP_MS });
  precondition(vis.status === 200 && typeof vis.linkToken === "string" && vis.linkToken.length > 0, `making ${docId} unlisted: ${vis.status}`);
  return vis.linkToken;
}

// --- the requests ------------------------------------------------------------------------------

/**
 * One racing request. `raw()` is it for syncHttp's worker threads (with the
 * session's cookie when `s` is given; syncHttp adds the agent headers and
 * warms the racer's socket on the static file); `send()` the same request
 * through the case's own traced client (`s.http`, or `http`). A Buffer body
 * goes as its bytes either way.
 */
function racer(name, { s = null, http = null, method = "POST", path, query = null, headers = {}, body, contentType = "application/json" }) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString() : "";
  const url = `${target.origin}${path}${qs ? `?${qs}` : ""}`;
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const client = http ?? s?.http;
  return {
    name,
    path,
    raw: () => {
      const h = { "content-type": contentType, ...headers };
      if (s) {
        const cookie = s.http.jar.header(url);
        precondition(typeof cookie === "string" && cookie.includes("__session="), `${name}: ${s.account.role} holds a session cookie for ${path}`);
        h.cookie = cookie;
      }
      return { url, method, headers: h, body: payload, warm: staticWarmUrl(target) };
    },
    send: () => client.request(method, path, { query: query ?? undefined, headers: { "content-type": contentType, ...headers }, body: payload, timeoutMs: HTTP_MS }),
  };
}

function parsed(body) {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return String(body).slice(0, 200);
  }
}

// --- function workers (lib/workers.mjs) -------------------------------------------------------

const GIB = 2 ** 30;

/** The stack's Functions-emulator workers now, kept as evidence and told as a step (a local stack; null elsewhere). */
function workersNow(ctx, label) {
  let w;
  try {
    w = functionWorkers(target);
  } catch (err) {
    ctx.step(`${label}: the stack's function workers could not be read (${brief(err?.message ?? err, 160)})`);
    return null;
  }
  if (!w) return null;
  ctx.ev.json(`workers-${slug(label)}`, w);
  ctx.step(`${label}: ${w.count} function worker(s), ${(w.rssBytes / GIB).toFixed(2)} GB (${Object.entries(w.byEntryPoint).map(([e, x]) => `${e} ${x.count}`).join(", ") || "none"})`);
  return w;
}

/**
 * The first thing every case does: hand back the idle workers the cases
 * before it left, through the emulator's own reload (an idle worker exits, a
 * busy one finishes first; nothing is signalled). Between cases only, never
 * mid-race: the concurrency tier runs one file, and its cases one at a time.
 * A reload that did not happen is a step, not a failure: admitWorkers still
 * waits for the room each burst needs.
 */
async function handBack(ctx) {
  const r = await retireIdleWorkers(target);
  if (r.skipped) return r;
  ctx.ev.json("workers-handed-back", r);
  ctx.step(`environment: ${r.summary} (${Math.round(r.ms / 1000)} s)`);
  return r;
}

/** Wait for room for `requests` concurrent requests to a function, one worker each (admitWorkers), or end INCONCLUSIVE. */
async function roomFor(ctx, requests, what) {
  const a = await admitWorkers(ctx, { requests, what });
  if (!a.skipped) ctx.ev.json(`workers-admitted-${slug(what)}`, { requests, needBytes: a.needBytes, waitedMs: a.waitedMs, availableBytes: a.sample?.availableBytes ?? null });
  return a;
}

/**
 * Warm one function worker per racing request: `calls` concurrent requests
 * the function answers without changing anything (a read, or a refusal), so
 * the race's requests each find an idle worker instead of a cold start, as
 * concurrent requests to one Cloud Run instance do in production. First it
 * waits for room for them: the warm-up starts the workers, and the race
 * finds them idle.
 */
async function warm(ctx, calls, what) {
  await roomFor(ctx, calls.length, `${calls.length} concurrent ${what} and the race after them`);
  const t0 = Date.now();
  const rs = await Promise.all(calls.map((f) => settled(f())));
  const statuses = rs.map((r) => (r.ok ? r.value.status : `error ${String(r.error?.message ?? r.error).slice(0, 60)}`));
  ctx.step(`warm-up: ${calls.length} concurrent ${what} answered ${statuses.join(", ")} in ${Date.now() - t0} ms`);
  workersNow(ctx, "after the warm-up");
}

/**
 * Fire `reqs` at one instant (SYNC-T, guarded and traced: syncHttp with the
 * target), then require the race (spread and overlap, or INCONCLUSIVE).
 * Resolves {rows: [{name, status, json}], run}; a Hosting cut-off is
 * INCONCLUSIVE. `show(json)` is what the evidence keeps of an answer
 * (default: the answer, redacted by Evidence).
 */
async function fire(ctx, reqs, label, { show = (j) => j } = {}) {
  const raws = reqs.map((r) => r.raw());
  const run = await syncHttp(raws, { target, timeoutMs: HTTP_MS });
  const rows = run.results.map((r, i) => ({ name: reqs[i].name, status: r.error ? null : r.status, json: r.error ? null : parsed(r.body), error: r.error ?? null }));
  ctx.ev.json(`fire-${slug(label)}`, {
    spreadMs: run.spreadMs,
    limit: run.limit,
    overlap: run.overlap,
    guarded: run.guarded === true,
    rows: rows.map((r) => ({ ...r, json: show(r.json) })),
    wire: run.results.map((r, i) => ({ name: reqs[i].name, path: reqs[i].path, status: r.status, firedAt: r.firedAt, sentAt: r.sentAt, firstByteAt: r.firstByteAt, endAt: r.endAt, error: r.error })),
  });
  ctx.step(`${label}: ${reqs.length} request(s) fired within ${Number(run.spreadMs).toFixed(1)} ms (overlap ${run.overlap.ok ? `proved, margin ${Number(run.overlap.marginMs).toFixed(0)} ms` : run.overlap.reason}); answers ${rows.map((r) => `${r.name} ${r.status ?? r.error}`).join("; ")}`);
  workersNow(ctx, `after ${label}`);
  const cut = rows.filter((r) => r.status === 504);
  if (cut.length) ctx.inconclusive(`the stack did not answer, so nothing was measured: Hosting answered 504 to ${cut.map((r) => r.name).join(", ")}`);
  const dropped = rows.filter((r) => r.status === null);
  if (dropped.length) ctx.inconclusive(`the stack did not answer, so nothing was measured: ${dropped.map((r) => `${r.name}: ${brief(r.error, 120)}`).join("; ")}`);
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  return { rows, run };
}

/** Send `reqs` one after another, each answered before the next is sent. */
async function sendSerially(ctx, reqs, label) {
  const rows = [];
  for (const q of reqs) {
    const r = answered(await q.send(), `${q.name} (POST ${q.path})`);
    rows.push({ name: q.name, status: r.status, json: r.json });
  }
  ctx.step(`${label}: one after another, ${rows.map((r) => `${r.name} ${r.status}`).join("; ")}`);
  return rows;
}

/** Send `reqs` concurrently through their clients without waiting: [{q, p (settled), answered: boolean}]. */
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
      e.code = "E2E_C17_UNHELD";
      throw e;
    }
    throw err;
  }
}

/**
 * Let the callers held at `name` go ONE AT A TIME (FIFO), each answered
 * before the next is let go: every one of them read before any wrote, and
 * their writes follow one another, so the stale read is the only race left.
 */
async function releaseInTurn(ctx, g, name, key, pending) {
  for (let k = 1; k <= pending.length; k += 1) {
    const r = await g.release(name, { count: 1, key });
    if (!r.released?.length) ctx.inconclusive(`the sync precondition did not hold: release ${k} of ${pending.length} at ${name} let nobody go`);
    await eventually(() => pending.filter((x) => x.answered).length >= k, { timeout: HELD_MS, interval: 100, message: `request ${k} of ${pending.length} answered after its release` });
  }
}

/** Release (and so disarm) every gate this case armed, whatever happened. */
async function releaseAll(g, names) {
  for (const name of names) await g.release(name).catch(() => undefined);
}

/** Every request answered 200. */
function judgeStatuses(rows, label) {
  const bad = rows.filter((r) => r.status !== 200);
  assert.ok(bad.length === 0, `${label}: every request answered 200 — ${bad.map((r) => `${r.name}: ${r.status ?? r.error} ${brief(r.json, 160)}`).join("; ")}`);
}

/**
 * The plan's server settle (lib/assert.mjs settleStill): `read()` unchanged
 * for SERVER_STABLE_MS, the value kept as evidence. One that never holds
 * still within SERVER_DEADLINE_MS throws E2E_SETTLE_TIMEOUT, which these
 * cases (no page, so no stall judge) FAIL on: something kept writing after
 * every request had been answered.
 */
async function stable(ctx, read, what) {
  const value = await settleStill(read, { quietMs: SERVER_STABLE_MS, deadlineMs: SERVER_DEADLINE_MS, what, step: (line) => ctx.step(line) });
  ctx.ev.json(`server-${slug(what)}`, value);
  return value;
}

/** One id `base` and N−1 `base-<six [a-z0-9]>`, all distinct (SPEC §4). */
function idsOneAndSuffixed(ids, base, n, label) {
  const re = new RegExp(`^${escapeRe(base)}-[a-z0-9]{6}$`);
  const at = ids.filter((d) => d === base).length;
  const suffixed = ids.filter((d) => re.test(d)).length;
  assert.ok(ids.length === n && new Set(ids).size === n && at === 1 && suffixed === n - 1, `${label}: one document at ${base} and ${n - 1} at ${base}-<six [a-z0-9]>, all distinct (SPEC §4) — got ${JSON.stringify(ids)}`);
}

// --- what the functions asked of Storage (the Storage shim, lib/storage-shim.mjs) ------------

/**
 * Mark the Storage shim's decisions before a case's writes: {shim, seq,
 * stats} on a stack built with --storage-shim; null on any other target,
 * which a step says (there nothing the functions send to Storage is seen).
 */
async function shimMark(ctx, label) {
  if (!target.capabilities?.has?.(STORAGE_SHIM)) {
    ctx.step(`${label}: this target has no Storage shim (${target.kind === "local" ? "a stack built without --storage-shim" : `a ${target.kind} target`}), so what the functions ask of Storage is not observed and the create-only oracle is not checked`);
    return null;
  }
  const shim = storageShim(target);
  const { stats } = await shim.stats();
  return { shim, seq: stats.seq, stats };
}

/**
 * The shim's decisions since `mark` on the objects of the documents `ids`
 * and of the contended id `base` (docs/<id>/…), kept as evidence and told as
 * a step. With a `base`, it says which half of SPEC §4's rule the trial
 * exercised: a create-only write refused 412 at the base is a loser that
 * found no record yet and was moved by Storage ("bytes"); none refused while
 * the base's own write went in create-only means every loser found the
 * winner's record first ("record"); no create-only write at the base at all
 * means its bytes went in without the precondition ("unguarded", which
 * judgeCreateOnly fails), so neither half was tested by Storage. A decision
 * the shim could not make (a precondition it does not judge, a metadata read
 * that failed) means the stack, not Cloud Storage, answered the product:
 * INCONCLUSIVE. Resolves {decisions, refusedAtBase, forwarded, half} or null.
 */
async function shimSince(ctx, mark, label, { ids, base = null }) {
  if (!mark) return null;
  const { stats, decisions } = await mark.shim.stats({ since: mark.seq });
  const prefixes = [...new Set([...(base ? [base] : []), ...ids])].map((id) => `docs/${id}/`);
  const mine = decisions.filter((d) => prefixes.some((p) => String(d.name ?? "").startsWith(p)));
  const refusedAtBase = base ? mine.filter((d) => d.decision === "refuse" && d.name.startsWith(`docs/${base}/`)) : [];
  const forwarded = mine.filter((d) => d.decision === "forward");
  // A forward the emulator never answered (status 0 or none) is the stack's failure too.
  const unmade = mine.filter((d) => (d.decision !== "forward" && d.decision !== "refuse") || (d.decision === "forward" && !d.status));
  const atBase = base ? mine.filter((d) => d.name.startsWith(`docs/${base}/`)) : [];
  const half = !base ? null : refusedAtBase.length ? "bytes" : atBase.some((d) => d.decision === "forward") ? "record" : "unguarded";
  const delta = Object.fromEntries(["requests", "locked", "waited", "judged", "forwarded", "refused", "unjudged", "invalid", "errors", "timeouts"].map((k) => [k, Number(stats[k] ?? 0) - Number(mark.stats[k] ?? 0)]));
  ctx.ev.json(`storage-shim-${slug(label)}`, { since: mark.seq, delta, held: stats.held ?? null, half, decisions: mine });
  const said = {
    bytes: () => `${refusedAtBase.length} create-only write(s) at docs/${base}/ refused 412 (${refusedAtBase.map((d) => `${d.kind} ${d.name.slice(`docs/${base}/`.length)}, current generation ${d.current}, waited ${d.waitedMs} ms`).join("; ")}): a loser found no record yet and Storage moved it, the bytes half of SPEC §4's rule`,
    record: () => `no create-only write at docs/${base}/ refused, and the one there went in create-only: every loser found the winner's record first, the record half of SPEC §4's rule`,
    unguarded: () => `no create-only write at docs/${base}/ reached Storage at all: its bytes went in without the precondition, so Storage tested neither half of SPEC §4's rule`,
  }[half]?.() ?? "no contended id";
  ctx.step(`${label}: Storage (the shim) stored ${forwarded.length} create-only write(s) under the ${ids.length} document(s) made; ${said}`);
  if (unmade.length) ctx.inconclusive(`the Storage shim, not Cloud Storage, answered the product: ${unmade.map((d) => `${d.decision} ${d.status} ${d.kind} ${d.name} (${brief(d.reason, 120)})`).join("; ")}`);
  return { decisions: mine, refusedAtBase: refusedAtBase.length, forwarded: forwarded.length, half };
}

/**
 * SPEC §4 "a new document's bytes are written only where no object exists
 * yet": every object of each new document's v1 reached Storage as a
 * create-only write (an upload or a copy with ifGenerationMatch=0) that the
 * shim judged and stored. A write sent without the precondition is never
 * judged, so it leaves no decision, and its object is named here. Only where
 * the shim is (`view` null elsewhere: not checked, as shimMark said).
 */
async function judgeCreateOnly(view, ids, label) {
  if (!view) return;
  const bad = [];
  let total = 0;
  for (const id of ids) {
    const objects = await listObjects(target, `docs/${id}/v1/`);
    if (objects.length === 0) bad.push(`docs/${id}/v1/ (no object at all)`);
    total += objects.length;
    for (const name of objects) {
      const ok = view.decisions.some((d) => d.name === name && d.decision === "forward" && d.ifGenerationMatch === "0" && d.status === 200 && ["upload", "rewrite", "copy"].includes(d.kind));
      if (!ok) bad.push(name);
    }
  }
  assert.ok(bad.length === 0, `${label}: every object of each new document's v1 reached Storage create-only (ifGenerationMatch=0), judged and stored by Storage (SPEC §4: "a new document's bytes are written only where no object exists yet") — of ${total} object(s) under ${ids.length} document(s), not: ${brief(bad, 400)}`);
}

/** What the measurement keeps of shimSince's view: null where there is no shim. */
const shimRow = (view) => (view ? { half: view.half, refusedAtBase: view.refusedAtBase, forwarded: view.forwarded } : null);

// =====================================================================================
// C17a — N publishes at one requested id
// =====================================================================================

async function c17aSetup(ctx, label) {
  const publishers = await people(ctx, Array.from({ length: ctx.n }, (_, i) => `publisher${i + 1}`));
  const id = docIdFor(target, "c17a");
  const tag = tagOf();
  const plan = publishers.map((s, i) => {
    const title = `${label} ${i + 1} ${tag}`;
    const html = docHtml(title, `c17a-${i + 1}-${rand4()}`);
    return { s, title, html, req: racer(`publish ${i + 1}`, { s, path: "/publish", query: { filename: "index.html", title, id }, contentType: "application/octet-stream", body: html }) };
  });
  ctx.step(`${ctx.n} publisher(s) each publish a document of their own at the id ${id}`);
  return { id, plan };
}

async function judgeC17a(ctx, s, rows, label, mark) {
  const others = oracleSet();
  const made = rows.map((r, i) => ({ r, p: s.plan[i] })).filter(({ r }) => r.status === 200 && typeof r.json?.docId === "string");
  for (const { r, p } of made) ledgerDoc(target, { docId: r.json.docId, via: "upload", ownerEmail: emailOf(p.s), actor: p.s.account.role, versionId: r.json.versionId ?? null });
  const ids = made.map(({ r }) => r.json.docId);
  const view = await shimSince(ctx, mark, label, { ids, base: s.id });
  await others.check(() => judgeStatuses(rows, label));
  await others.check(() => idsOneAndSuffixed(ids, s.id, s.plan.length, label));
  for (const { r, p } of made) {
    const docId = r.json.docId;
    await others.check(async () => {
      const rec = await readDoc(target, `docs/${docId}`);
      assert.ok(rec, `${label}: docs/${docId} exists`);
      assert.deepEqual({ owner: String(rec.ownerEmail).toLowerCase(), title: rec.title, currentVersion: rec.currentVersion }, { owner: emailOf(p.s), title: p.title, currentVersion: "v1" }, `${label}: ${docId} is ${p.s.account.role}'s document`);
      const v = await readDoc(target, `docs/${docId}/versions/v1`);
      const re = await rehashVersion({ target, http: p.s.http, docId, versionId: "v1" });
      const html = re.entries.find((f) => f.rel === "index.html")?.data.toString("utf8") ?? null;
      assert.ok(html === p.html, `I7: ${docId}'s v1 is the bytes ${p.s.account.role} sent (it holds ${html === null ? "no index.html" : `"${brief(html.match(/c17a-[0-9]+-[a-z0-9]+/)?.[0] ?? html, 80)}"`}, sent "${p.html.match(/c17a-[0-9]+-[a-z0-9]+/)[0]}")`);
      assert.equal(re.contentHash, v?.contentHash, `I7: REHASH of ${docId}/v1 equals its contentHash`);
    });
  }
  const objects = await listObjects(target, `docs/${s.id}`);
  const holders = sorted(new Set(objects.map((k) => k.split("/")[1])));
  await others.check(() => assert.deepEqual(holders, sorted(ids), `${label}: the Storage objects under ${s.id} belong to the documents made, and to nothing else (${objects.length} object(s): ${brief(objects, 400)})`));
  await others.check(() => judgeCreateOnly(view, ids, label));
  measure(ctx, MEASURE, { scenario: label, made: made.length, of: rows.length, statuses: rows.map((r) => r.status), storage: shimRow(view) });
  verdict({ others });
}

scenario("C17a same id (SYNC-T): N accounts publish at one requested id at one instant; one document has the id and the other N−1 have it with a random six-character suffix, each owned by its publisher and holding the bytes it sent (SPEC §4)", {
  tiers: BOTH,
  needs: [STORAGE_PRECONDITIONS],
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  await handBack(ctx);
  const s = await c17aSetup(ctx, "C17a race");
  await warm(ctx, s.plan.map(({ s: p }) => () => p.http.request("POST", "/publish", { query: { filename: "index.html" }, headers: { "content-type": "application/octet-stream" }, body: "", timeoutMs: HTTP_MS })), "POST /publish with no file (400)");
  const mark = await shimMark(ctx, "C17a race");
  const { rows } = await fire(ctx, s.plan.map((p) => p.req), "C17a race");
  await judgeC17a(ctx, s, rows, "C17a race", mark);
});

// The race above runs where Storage refuses a second create-only write: on a
// local stack built with --storage-shim (lib/storage-shim.mjs), and on Cloud
// Storage once a production target exists; on a plain stack it is skipped.
// The serial positive control below needs neither: it measures the record
// half of SPEC §4's rule on every stack, and on a shim stack the create-only
// oracle too.

scenario("C17a serial positive control: N accounts publish at one requested id one after another; one document has the id and the other N−1 have it with a random six-character suffix, each owned by its publisher and holding the bytes it sent (SPEC §4: an id is taken if a record holds it)", {
  tiers: BOTH,
  n: NS,
  trials: SERIAL_TRIALS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C17a serial";
  await handBack(ctx);
  const s = await c17aSetup(ctx, label);
  const mark = await shimMark(ctx, label);
  const rows = await sendSerially(ctx, s.plan.map((p) => p.req), label);
  await judgeC17a(ctx, s, rows, label, mark);
});

// =====================================================================================
// C17b — N forks of one document
// =====================================================================================

async function c17bSetup(ctx, label, { ownTitles }) {
  const [owner, ...forkers] = await people(ctx, ["owner", ...Array.from({ length: ctx.n }, (_, i) => `forker${i + 1}`)]);
  const src = await newDoc(owner, `${label} source`);
  const k = await unlisted(owner, src.docId);
  const v1 = await readDoc(target, `docs/${src.docId}/versions/v1`);
  precondition(typeof v1?.contentHash === "string" && v1.contentHash.length > 0, `${src.docId}/v1 has a contentHash`);
  const before = await forkCounts(src.docId);
  const tag = tagOf();
  const plan = forkers.map((s, i) => {
    const title = ownTitles ? `${label} fork ${i + 1} ${tag}` : null;
    return { s, title: title ?? src.title, req: racer(`fork ${i + 1}`, { s, path: "/fork", body: { op: "create", docId: src.docId, k, ...(title ? { title } : {}) } }) };
  });
  ctx.step(`${src.docId} is unlisted; ${ctx.n} reader(s) of its link fork it${ownTitles ? ", each under a title of its own" : " under its own title (one-click)"}; stats.forks ${before.stats}, fork.created events ${before.events}`);
  return { owner, src, k, v1, before, plan };
}

/** The source's fork count and its fork.created events. */
async function forkCounts(docId) {
  const rec = await readDoc(target, `docs/${docId}`);
  const events = await readCollection(target, `docs/${docId}/events`);
  return { stats: Number(rec?.stats?.forks ?? 0), events: events.filter((e) => e.data?.type === "fork.created").length };
}

async function judgeC17b(ctx, s, rows, label, { ownTitles, mark }) {
  const others = oracleSet();
  const made = rows.map((r, i) => ({ r, p: s.plan[i] })).filter(({ r }) => r.status === 200 && typeof r.json?.docId === "string");
  for (const { r, p } of made) ledgerDoc(target, { docId: r.json.docId, via: "fork", ownerEmail: emailOf(p.s), actor: p.s.account.role, versionId: r.json.versionId ?? null, forkOf: s.src.docId });
  const ids = made.map(({ r }) => r.json.docId);
  const view = await shimSince(ctx, mark, label, { ids, base: ownTitles ? null : productSlug(s.src.title) });
  await others.check(() => judgeStatuses(rows, label));
  await others.check(() => {
    if (ownTitles) {
      assert.deepEqual(made.map(({ r, p }) => [r.json.docId, r.json.title]), made.map(({ p }) => [productSlug(p.title), p.title]), `${label}: each fork has its own title and the id its title asks for (SPEC §21 "Its title")`);
    } else {
      idsOneAndSuffixed(ids, productSlug(s.src.title), s.plan.length, label);
      assert.ok(made.every(({ r }) => r.json.title === s.src.title), `${label}: every one-click fork takes the source's title (SPEC §21 "Its title")`);
    }
  });
  const after = await stable(ctx, () => forkCounts(s.src.docId), `${label} fork count`);
  await others.check(() => assert.deepEqual({ stats: after.stats - s.before.stats, events: after.events - s.before.events }, { stats: made.length, events: made.length }, `${label}: stats.forks and the fork.created events each rose by the ${made.length} fork(s) made (SPEC §21: "The count therefore never disagrees with the forks that exist")`));
  for (const { r, p } of made) {
    const docId = r.json.docId;
    await others.check(async () => {
      const ptr = await readDoc(target, `forks/${docId}`);
      assert.deepEqual(ptr && { parentId: ptr.parentId, parentVersion: ptr.parentVersion, parentContentHash: ptr.parentContentHash }, { parentId: s.src.docId, parentVersion: "v1", parentContentHash: s.v1.contentHash }, `${label}: forks/${docId} names the source, v1 and its hash`);
      const rec = await readDoc(target, `docs/${docId}`);
      assert.deepEqual(rec && { owner: String(rec.ownerEmail).toLowerCase(), visibility: rec.visibility, trusted: rec.trusted, forked: rec.forked, currentVersion: rec.currentVersion }, { owner: emailOf(p.s), visibility: "private", trusted: false, forked: true, currentVersion: "v1" }, `${label}: ${docId} is ${p.s.account.role}'s private, untrusted fork at v1 (SPEC §21)`);
      const v = await readDoc(target, `docs/${docId}/versions/v1`);
      assert.deepEqual(v && { publishedVia: v.publishedVia, contentHash: v.contentHash }, { publishedVia: "fork", contentHash: s.v1.contentHash }, `${label}: ${docId}/v1 is published via fork with the source's hash`);
      const re = await rehashVersion({ target, http: p.s.http, docId, versionId: "v1" });
      assert.equal(re.contentHash, s.v1.contentHash, `I7: REHASH of ${docId}/v1 (as its forker) equals the source's contentHash`);
    });
  }
  await others.check(() => judgeCreateOnly(view, ids, label));
  measure(ctx, MEASURE, { scenario: label, made: made.length, of: rows.length, forksDelta: after.stats - s.before.stats, eventsDelta: after.events - s.before.events, storage: shimRow(view) });
  verdict({ others });
}

async function c17bRace(ctx, label, { ownTitles }) {
  await handBack(ctx);
  const s = await c17bSetup(ctx, label, { ownTitles });
  await warm(ctx, s.plan.map(({ s: p }) => () => p.http.postJson("/fork", { op: "lineage", docId: s.src.docId, k: s.k }, { timeoutMs: HTTP_MS })), "POST /fork lineage (a read)");
  const mark = await shimMark(ctx, label);
  const { rows } = await fire(ctx, s.plan.map((p) => p.req), label);
  await judgeC17b(ctx, s, rows, label, { ownTitles, mark });
}

scenario("C17b N forks (SYNC-T): N readers of an unlisted link fork it at one instant, each under a title of its own; stats.forks and the source's fork.created events rise by exactly N, N fork records name the source, and every fork holds its bytes (SPEC §21)", {
  tiers: BOTH,
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => c17bRace(ctx, "C17b race", { ownTitles: true }));

scenario("C17b one-click forks (SYNC-T): N readers of an unlisted link fork it at one instant under the source's own title; one fork has the title's slug and the other N−1 have it with a random suffix, and stats.forks rises by exactly N (SPEC §4, §21)", {
  tiers: BOTH,
  needs: [STORAGE_PRECONDITIONS],
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => c17bRace(ctx, "C17b one-click race", { ownTitles: false }));

scenario("C17b one-click serial positive control: N readers of an unlisted link fork it one after another under the source's own title; one fork has the title's slug and the other N−1 have it with a random suffix, and stats.forks rises by exactly N (SPEC §4, §21)", {
  tiers: BOTH,
  n: NS,
  trials: SERIAL_TRIALS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C17b one-click serial";
  await handBack(ctx);
  const s = await c17bSetup(ctx, label, { ownTitles: false });
  const mark = await shimMark(ctx, label);
  const rows = await sendSerially(ctx, s.plan.map((p) => p.req), label);
  await judgeC17b(ctx, s, rows, label, { ownTitles: false, mark });
});

// =====================================================================================
// C17c — N captures of one version's thumbnails
// =====================================================================================

async function c17cSetup(ctx, label) {
  const [owner, ...editors] = await people(ctx, ["owner", ...Array.from({ length: ctx.n - 1 }, (_, i) => `editor${i + 1}`)]);
  const doc = await newDoc(owner, label);
  if (editors.length) {
    const gr = await grantEditors(target, { owner, doc: doc.docId, accounts: editors.map((e) => e.account), role: "editor", timeoutMs: HTTP_MS });
    ctx.step(`${editors.length} editor(s) granted on ${doc.docId} (${gr.via}, ${gr.requests} request(s))`);
  }
  const rev = thumbRevision(target);
  const capturers = [owner, ...editors];
  const thumbReq = (s, i, kind, images) => racer(`${kind} ${i + 1}`, { s, path: "/thumb", query: { doc: doc.docId, v: "v1", kind, sizes: images.map((b) => b.length).join(","), r: rev }, contentType: "application/octet-stream", body: Buffer.concat(images) });
  const covers = capturers.map((s, i) => {
    const images = [jpegSkeleton({ pad: 32 + i })];
    return { s, images, req: thumbReq(s, i, "cover", images) };
  });
  const slides = capturers.map((s, i) => {
    const images = [jpegSkeleton({ pad: 400 + 2 * i }), jpegSkeleton({ pad: 401 + 2 * i })];
    return { s, images, req: thumbReq(s, i, "slides", images) };
  });
  const rec = await readDoc(target, `docs/${doc.docId}`);
  precondition(rec && rec.thumb == null, `${doc.docId} has no thumbnails yet (${brief(rec?.thumb)})`);
  ctx.step(`${doc.docId}: the owner and ${editors.length} editor(s) each capture v1's cover (a JPEG of its own), all at once, then its slides`);
  return { owner, doc, rev, capturers, covers, slides, updatedAt: stamp(rec.updatedAt) };
}

/** The served bytes of one stored image, as the owner reads it. */
async function served(owner, docId, key, slot) {
  const path = thumbPath(docId, "v1", key, slot);
  const r = answered(await owner.http.get(path, { timeoutMs: HTTP_MS }), `GET ${path}`);
  return r;
}

async function judgeC17c(ctx, s, coverRows, slideRows, label) {
  const others = oracleSet();
  const d = s.doc.docId;
  /** Per kind, every upload answered {stored: true}: each was told its key is the record. */
  const told = {};
  for (const [kind, rows] of [["cover", coverRows], ["slides", slideRows]]) {
    await others.check(() => judgeStatuses(rows, `${label} ${kind}`));
    const won = rows.map((r, i) => (r.json?.stored === true ? i : -1)).filter((i) => i >= 0);
    const lost = rows.filter((r) => r.json?.stored === false).length;
    told[kind] = won;
    await others.check(() => assert.ok(won.length === 1 && lost === rows.length - 1, `${label}: exactly one ${kind} upload became the record ({stored: true}) and the other ${rows.length - 1} answered {stored: false} (SPEC §2) — ${rows.map((r) => `${r.name} ${r.status} ${brief(r.json, 60)}`).join("; ")}`));
  }
  const state = await stable(ctx, async () => {
    const rec = await readDoc(target, `docs/${d}`);
    return { thumb: rec?.thumb ?? null, updatedAt: stamp(rec?.updatedAt), objects: await listObjects(target, `docs/${d}/thumbs/`) };
  }, `${label} thumbnails`);
  const t = state.thumb;
  const okRecord = Boolean(t && t.versionId === "v1" && t.rev === s.rev && /^[0-9a-f]{16}$/.test(t.cover ?? "") && /^[0-9a-f]{16}$/.test(t.slides?.key ?? "") && t.slides?.count === 2);
  await others.check(() => assert.ok(okRecord, `${label}: docs/${d}.thumb is {versionId: v1, rev: ${s.rev}, cover: <key>, slides: {key: <key>, count: 2}} — got ${brief(t)}`));
  const want = okRecord ? sorted([`docs/${d}/thumbs/v1/${t.cover}/cover.jpg`, `docs/${d}/thumbs/v1/${t.slides.key}/s0.jpg`, `docs/${d}/thumbs/v1/${t.slides.key}/s1.jpg`]) : null;
  await others.check(() => assert.deepEqual(state.objects, want ?? [], `${label}: Storage holds the record's cover and slides and nothing else: every loser deleted what it wrote (SPEC §2 "a loser deletes what it wrote") — ${state.objects.length} object(s) under docs/${d}/thumbs/`));
  // An upload told {stored: true} was told its key became the record (SPEC
  // §2 "a transaction makes that key the record's"), so what GET /thumb
  // serves is the bytes it sent, for EVERY such upload: with one winner this
  // is "the winner's bytes are served", and two uploads each told so cannot
  // both hold.
  if (okRecord && told.cover.length) {
    await others.check(async () => {
      const r = await served(s.owner, d, t.cover, "cover");
      const not = told.cover.filter((i) => !(r.status === 200 && Buffer.compare(r.buffer, s.covers[i].images[0]) === 0));
      assert.ok(not.length === 0, `${label}: GET /thumb serves the cover that every upload told {stored: true} sent — not ${not.map((i) => coverRows[i].name).join(", ")}'s (served ${r.status}, ${r.buffer?.length} bytes; ${told.cover.map((i) => `${coverRows[i].name} sent ${s.covers[i].images[0].length}`).join(", ")})`);
    });
  }
  if (okRecord && told.slides.length) {
    await others.check(async () => {
      for (const slot of [0, 1]) {
        const r = await served(s.owner, d, t.slides.key, slot);
        const not = told.slides.filter((i) => !(r.status === 200 && Buffer.compare(r.buffer, s.slides[i].images[slot]) === 0));
        assert.ok(not.length === 0, `${label}: GET /thumb serves slide ${slot} that every upload told {stored: true} sent — not ${not.map((i) => slideRows[i].name).join(", ")}'s (served ${r.status}, ${r.buffer?.length} bytes; ${told.slides.map((i) => `${slideRows[i].name} sent ${s.slides[i].images[slot].length}`).join(", ")})`);
      }
    });
  }
  await others.check(() => assert.equal(state.updatedAt, s.updatedAt, `${label}: storing thumbnails never touches updatedAt (SPEC §2)`));
  measure(ctx, MEASURE, { scenario: label, coverStored: coverRows.filter((r) => r.json?.stored === true).length, slidesStored: slideRows.filter((r) => r.json?.stored === true).length, objects: state.objects.length, of: coverRows.length });
  verdict({ others });
}

scenario("C17c thumbnails (SYNC-T): the owner and N−1 editors store v1's cover at one instant, then its slides; one cover key and one slides key are recorded and served, every loser's images are deleted, and updatedAt is untouched (SPEC §2, §4)", {
  tiers: BOTH,
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C17c race";
  await handBack(ctx);
  const s = await c17cSetup(ctx, label);
  await warm(ctx, s.capturers.map((p) => () => p.http.request("POST", "/thumb", { query: { doc: s.doc.docId, v: "v1", kind: "e2e-warm-up", sizes: "1", r: s.rev }, headers: { "content-type": "application/octet-stream" }, body: "x", timeoutMs: HTTP_MS })), "POST /thumb of an unknown kind (400)");
  const cover = await fire(ctx, s.covers.map((c) => c.req), `${label} covers`);
  const slides = await fire(ctx, s.slides.map((c) => c.req), `${label} slides`);
  await judgeC17c(ctx, s, cover.rows, slides.rows, label);
});

// =====================================================================================
// C17d — N anonymous readers open a session at once
// =====================================================================================

async function c17dSetup(ctx, label) {
  const [owner] = await people(ctx, ["owner"]);
  const doc = await newDoc(owner, label);
  const k = await unlisted(owner, doc.docId);
  const anon = ctx.http({ actor: "anonymous", timeoutMs: HTTP_MS, cutoffError: true });
  const readers = Array.from({ length: ctx.n }, (_, i) => ({ sessionId: `c17d-${randomBytes(10).toString("hex")}`, ms: 1_000 + 37 * i }));
  const reqs = readers.map((r, i) => racer(`reader ${i + 1}`, { http: anon, path: "/view", body: { docId: doc.docId, versionId: "v1", sessionId: r.sessionId, ms: r.ms, k } }));
  const rec = await readDoc(target, `docs/${doc.docId}`);
  ctx.step(`${doc.docId} is unlisted; ${ctx.n} anonymous reader(s) of its link each open a session, claiming ${readers.map((r) => r.ms).join(", ")} ms`);
  return { owner, doc, k, anon, readers, reqs, before: { views: Number(rec?.stats?.views ?? 0), totalMs: Number(rec?.stats?.totalMs ?? 0), viewers: Number(rec?.stats?.viewers ?? 0), updatedAt: stamp(rec?.updatedAt) } };
}

async function judgeC17d(ctx, s, rows, label) {
  const others = oracleSet();
  const d = s.doc.docId;
  await others.check(() => judgeStatuses(rows, label));
  await others.check(() => assert.deepEqual(rows.map((r) => r.json?.ms ?? null), s.readers.map((r) => r.ms), `${label}: each session's answer is its own ms`));
  const state = await stable(ctx, async () => {
    const rec = await readDoc(target, `docs/${d}`);
    const views = await readCollection(target, `docs/${d}/views`);
    const viewers = await readCollection(target, `docs/${d}/viewers`);
    return {
      views: Number(rec?.stats?.views ?? 0),
      totalMs: Number(rec?.stats?.totalMs ?? 0),
      viewers: Number(rec?.stats?.viewers ?? 0),
      updatedAt: stamp(rec?.updatedAt),
      sessions: views.map((v) => ({ id: v.id, uid: v.data.uid ?? null, email: v.data.email ?? null, via: v.data.via ?? null, ms: v.data.ms ?? null, versionId: v.data.versionId ?? null, automated: v.data.automated ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
      viewerRows: viewers.map((v) => v.id).sort(),
    };
  }, `${label} stats`);
  const sum = s.readers.reduce((a, r) => a + r.ms, 0);
  await others.check(() => assert.deepEqual({ views: state.views - s.before.views, totalMs: state.totalMs - s.before.totalMs, viewers: state.viewers - s.before.viewers }, { views: s.readers.length, totalMs: sum, viewers: 0 }, `${label}: stats.views rose by the ${s.readers.length} session(s) and totalMs by their sum, with no viewer counted (SPEC §4, §17)`));
  const want = s.readers.map((r) => ({ id: r.sessionId, uid: null, email: null, via: "unlisted", ms: r.ms, versionId: "v1", automated: false })).sort((a, b) => a.id.localeCompare(b.id));
  await others.check(() => assert.deepEqual(state.sessions, want, `${label}: one anonymous session per reader (uid and email null, via unlisted, its own ms) (SPEC §17)`));
  await others.check(() => assert.deepEqual(state.viewerRows, [], `${label}: no viewers/{uid} for an anonymous reader (SPEC §17)`));
  await others.check(() => assert.equal(state.updatedAt, s.before.updatedAt, `${label}: recordView never touches updatedAt (SPEC §4)`));
  measure(ctx, MEASURE, { scenario: label, viewsDelta: state.views - s.before.views, of: s.readers.length, sessions: state.sessions.length });
  verdict({ others });
}

scenario("C17d anonymous views (SYNC-T): N anonymous readers of an unlisted link each open a reading session at one instant; stats.views rises by exactly N and totalMs by their sum, N anonymous sessions are recorded and no viewer (SPEC §4, §17)", {
  tiers: BOTH,
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C17d race";
  await handBack(ctx);
  const s = await c17dSetup(ctx, label);
  await warm(ctx, s.readers.map(() => () => s.anon.postJson("/view", { docId: s.doc.docId, versionId: "v1", sessionId: "x", k: s.k }, { timeoutMs: HTTP_MS })), "POST /view with a malformed session (400)");
  const { rows } = await fire(ctx, s.reqs, label);
  await judgeC17d(ctx, s, rows, label);
});

// =====================================================================================
// C19 — a burst of wrong codes, and of code requests, by one account (LOCAL)
// =====================================================================================

/** The subject notify.ts writes for a verification code. */
const CODE_SUBJECT = /^\d{6} is your Bikeshed verification code$/;
/** The product's words (functions/src/index.ts verifyEmail). */
const VERIFY_MSG = Object.freeze({
  notRight: "that code is not right",
  tooMany: "too many attempts; request a new code",
  none: "no verification in progress",
  justSent: "a code was just sent; wait a minute",
});
const isNotRight = (r) => r.status === 400 && r.json?.error === VERIFY_MSG.notRight;

function codeOf(subject) {
  const m = /^(\d{6}) is your Bikeshed verification code$/.exec(subject ?? "");
  if (!m) throw new Error(`not a verification subject: ${JSON.stringify(subject)}`);
  return m[1];
}

/** `n` six-digit codes that are not `code` and not in `avoid`, all different. */
function wrongCodes(code, n, avoid = []) {
  const out = [];
  const skip = new Set([code, ...avoid]);
  let k = Number(code);
  while (out.length < n) {
    k = (k + 104_729) % 1_000_000;
    const c = String(k).padStart(6, "0");
    if (!skip.has(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** An unverified account, its client and an ID token: what /verify/* takes. */
async function verifier(ctx, role) {
  const http = ctx.http({ actor: role, timeoutMs: HTTP_MS, cutoffError: true });
  const acct = await castUnverified(target, role, { http });
  const token = await idToken(target, acct, { http });
  return { acct, http, token, uid: acct.uid, email: String(acct.email).toLowerCase() };
}

async function verifyCall(v, action, json) {
  return answered(await v.http.postJson(`/verify/${action}`, json, { headers: { authorization: `Bearer ${v.token}` }, timeoutMs: HTTP_MS }), `POST /verify/${action}`);
}

const verifyRacer = (v, name, action, json) => racer(name, { http: v.http, path: `/verify/${action}`, headers: { authorization: `Bearer ${v.token}` }, body: json });

/** Warm one verifyEmail worker per racer: POST /verify/complete with no token, refused 401 before anything is read. */
async function warmVerify(ctx, v, n) {
  await warm(ctx, Array.from({ length: n }, () => () => v.http.postJson("/verify/complete", { code: "000000" }, { timeoutMs: HTTP_MS })), "POST /verify/complete with no token (401)");
}

/** The code mails to `to`, counted until the count holds still for MAIL_SETTLE_MS (at least one). */
async function settledMail(ctx, to) {
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const t0 = Date.now();
  let last = -1;
  let since = t0;
  let msgs = [];
  for (;;) {
    msgs = await box.find({ to, subject: CODE_SUBJECT });
    const now = Date.now();
    if (msgs.length !== last) {
      last = msgs.length;
      since = now;
    } else if (msgs.length > 0 && now - since >= MAIL_SETTLE_MS) {
      ctx.step(`${msgs.length} code mail(s) to ${to}, held for ${MAIL_SETTLE_MS / 1000} s`);
      return msgs;
    }
    if (now - t0 > MAIL_MS) {
      const err = new Error(`no code mail to ${to} held still within ${MAIL_MS} ms (saw ${msgs.length})`);
      err.code = "E2E_C17_MAIL";
      throw err;
    }
    await sleep(500);
  }
}

/** POST /verify/start once and read its code from Mailpit. */
async function startOnce(ctx, v) {
  const st = await verifyCall(v, "start", {});
  precondition(st.status === 200 && st.json?.sent === true, `POST /verify/start: ${st.status} ${brief(st.json)}`);
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const msg = await box.waitFor({ to: v.email, subject: CODE_SUBJECT, timeout: MAIL_MS });
  return codeOf(msg.Subject);
}

/** Wrong codes one at a time, after a burst, until one is answered otherwise than "not right" (at most the limit + 2). */
async function followUp(ctx, v, code, used, label) {
  const rows = [];
  for (const [i, c] of wrongCodes(code, VERIFY_MAX_ATTEMPTS + 2, used).entries()) {
    const r = await verifyCall(v, "complete", { code: c });
    rows.push({ name: `then ${i + 1}`, status: r.status, json: r.json });
    if (!isNotRight(r)) break;
  }
  ctx.step(`${label}: then wrong codes one at a time until refused: ${rows.map((r) => `${r.status} ${r.json?.error ?? ""}`).join("; ")}`);
  return rows;
}

async function c19aSetup(ctx, label) {
  const v = await verifier(ctx, "guesser");
  const code = await startOnce(ctx, v);
  const wrong = wrongCodes(code, wrongAtOnce(ctx.n));
  const reqs = wrong.map((c, i) => verifyRacer(v, `guess ${i + 1}`, "complete", { code: c }));
  ctx.step(`${label}: ${v.email} has a code in progress; ${wrong.length} wrong guesses at it (VERIFY_MAX_ATTEMPTS ${VERIFY_MAX_ATTEMPTS}); stack patches ${JSON.stringify(target.patches ?? [])}`);
  return { v, code, wrong, reqs };
}

async function judgeC19a(ctx, s, burst, label, { defect = null } = {}) {
  const others = oracleSet();
  const own = oracleSet();
  const { v } = s;
  const storedAfterBurst = (await readDoc(target, `users/${v.uid}`))?.verification?.attempts ?? null;
  const follow = await followUp(ctx, v, s.code, s.wrong, label);
  const all = [...burst, ...follow];
  const evaluatedInBurst = burst.filter(isNotRight).length;
  const evaluated = all.filter(isNotRight).length;
  ctx.step(`${label}: ${evaluatedInBurst} of the ${burst.length} guesses at once were evaluated, and ${evaluated} in all; the stored attempt count after the burst was ${storedAfterBurst}`);
  const allowed = (r) => isNotRight(r) || (r.status === 429 && r.json?.error === VERIFY_MSG.tooMany) || (r.status === 409 && r.json?.error === VERIFY_MSG.none);
  await others.check(() => {
    const bad = all.filter((r) => !allowed(r));
    assert.ok(bad.length === 0, `${label}: every wrong guess is refused as wrong (400), too many (429) or none in progress (409) — ${bad.map((r) => `${r.name}: ${r.status} ${brief(r.json, 100)}`).join("; ")}`);
  });
  await others.check(() => assert.ok(all.some((r) => r.status === 429 && r.json?.error === VERIFY_MSG.tooMany), `${label}: the guesses end in the lockout (429 "${VERIFY_MSG.tooMany}")`));
  const rec = await readDoc(target, `users/${v.uid}`);
  await others.check(() => assert.ok(!rec?.verification?.hash, `${label}: after the lockout no code is in progress (users/{uid}.verification ${brief(rec?.verification)})`));
  const right = await verifyCall(v, "complete", { code: s.code });
  await others.check(() => assert.ok((right.status === 409 && right.json?.error === VERIFY_MSG.none) || (right.status === 429 && right.json?.error === VERIFY_MSG.tooMany), `${label}: the right code after the lockout is refused (${right.status} ${brief(right.json)})`));
  const user = await adminFor(target).auth.getUser(v.uid);
  await others.check(() => assert.equal(user.emailVerified, false, `${label}: the account stays unverified`));
  await others.check(async () => {
    const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
    await box.expectMail({ to: v.email, subject: CODE_SUBJECT, count: 1, timeout: MAIL_MS });
  });
  await own.check(() => assert.ok(evaluated <= VERIFY_MAX_ATTEMPTS, `S22: ${evaluated} wrong guesses at one code were evaluated (answered 400 "${VERIFY_MSG.notRight}"), more than VERIFY_MAX_ATTEMPTS ${VERIFY_MAX_ATTEMPTS}: ${evaluatedInBurst} of ${burst.length} sent at once, after which the stored attempt count read ${storedAfterBurst}, then ${evaluated - evaluatedInBurst} more one at a time before the lockout`));
  measure(ctx, MEASURE, { scenario: label, burst: burst.length, evaluatedInBurst, storedAfterBurst, evaluated, limit: VERIFY_MAX_ATTEMPTS });
  verdict({ defect, others, own });
}

scenario("C19a wrong codes at once (SYNC-T): one account sends a burst of wrong verification codes at one instant, then wrong codes one at a time until refused; at most five guesses at the code are evaluated, it dies, and the account stays unverified (SPEC §14)", {
  tiers: LOCAL,
  effects: VERIFY_MAIL,
  needs: ["email", "mailpit", "admin-emulator"],
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C19a race";
  await handBack(ctx);
  const s = await c19aSetup(ctx, label);
  await warmVerify(ctx, s.v, s.reqs.length);
  const { rows } = await fire(ctx, s.reqs, label);
  await judgeC19a(ctx, s, rows, label);
});

scenario("C19a S22 (SYNC-P): the burst of wrong codes held after every guess has read the attempt count and before any is compared, then let go one at a time; at most five guesses at the code are evaluated, it dies, and the account stays unverified (SPEC §14)", {
  tiers: LOCAL,
  effects: VERIFY_MAIL,
  needs: ["email", "mailpit", "admin-emulator", ...GATED],
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C19a S22";
  await handBack(ctx);
  const g = gates(ctx.target);
  const s = await c19aSetup(ctx, label);
  const gate = "verify-complete-after-read";
  await roomFor(ctx, s.reqs.length, `${s.reqs.length} requests held at ${gate}`);
  let pending = [];
  try {
    await g.hold(gate, { key: s.v.uid });
    pending = sendAll(s.reqs);
    const h = await held(ctx, g, gate, s.reqs.length, s.v.uid, pending);
    ctx.step(`${label}: all ${s.reqs.length} guesses are held in verifyEmail, each having read the attempt count (seq ${h.callers.map((c) => c.seq).join(", ")}); let go one at a time, each answered before the next`);
    await releaseInTurn(ctx, g, gate, s.v.uid, pending);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = await rowsOf(ctx, pending, label);
  workersNow(ctx, `after ${label}`);
  await judgeC19a(ctx, s, rows, label);
});

scenario("C19a serial positive control: the same wrong codes one after another; at most five guesses at the code are evaluated, it dies, and the account stays unverified (SPEC §14)", {
  tiers: LOCAL,
  effects: VERIFY_MAIL,
  needs: ["email", "mailpit", "admin-emulator"],
  n: NS,
  trials: SERIAL_TRIALS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C19a serial";
  await handBack(ctx);
  const s = await c19aSetup(ctx, label);
  const rows = await sendSerially(ctx, s.reqs, label);
  await judgeC19a(ctx, s, rows, label);
});

async function c19bSetup(ctx, label) {
  const v = await verifier(ctx, "requester");
  const reqs = Array.from({ length: startsAtOnce(ctx.n) }, (_, i) => verifyRacer(v, `start ${i + 1}`, "start", {}));
  ctx.step(`${label}: ${v.email} has no code yet; ${reqs.length} code request(s); stack patches ${JSON.stringify(target.patches ?? [])}`);
  return { v, reqs };
}

async function judgeC19b(ctx, s, rows, label, { defect = null } = {}) {
  const others = oracleSet();
  const own = oracleSet();
  const { v } = s;
  const sent = rows.filter((r) => r.status === 200 && r.json?.sent === true);
  await others.check(() => {
    const bad = rows.filter((r) => !((r.status === 200 && r.json?.sent === true && String(r.json?.email).toLowerCase() === v.email) || (r.status === 429 && r.json?.error === VERIFY_MSG.justSent)));
    assert.ok(bad.length === 0, `${label}: every code request answers 200 {sent: true} or 429 "${VERIFY_MSG.justSent}" — ${bad.map((r) => `${r.name}: ${r.status} ${brief(r.json, 100)}`).join("; ")}`);
  });
  await others.check(() => assert.ok(sent.length >= 1, `${label}: at least one code request is answered 200`));
  const mails = await settledMail(ctx, v.email);
  const codes = mails.map((m) => codeOf(m.Subject));
  const rec = await readDoc(target, `users/${v.uid}`);
  const stored = codes.filter((c) => sha256(`${v.uid}:${c}`) === rec?.verification?.hash);
  await others.check(() => assert.equal(stored.length, 1, `${label}: the code stored is one of the ${codes.length} mailed (${stored.length} match)`));
  if (stored.length === 1) {
    const done = await verifyCall(v, "complete", { code: stored[0] });
    await others.check(() => assert.deepEqual({ status: done.status, json: done.json }, { status: 200, json: { verified: true, email: v.email } }, `${label}: the code stored verifies the account`));
  }
  await own.check(() => assert.ok(sent.length === 1 && mails.length === 1, `S23: ${rows.length} code requests at once were answered 200 ${sent.length} time(s) and mailed ${mails.length} code(s), ${mails.length - stored.length} of which can never verify; one code mail and one 200 expected, the rest refused 429 by the ${"60 s"} resend gap`));
  measure(ctx, MEASURE, { scenario: label, requests: rows.length, sent: sent.length, mails: mails.length, deadCodes: mails.length - stored.length });
  verdict({ defect, others, own });
}

scenario("C19b code requests at once (SYNC-T): one account asks for a verification code several times at one instant; one code is mailed and the rest are refused 429 by the resend gap, and the code mailed verifies the account (SPEC §14)", {
  tiers: LOCAL,
  effects: VERIFY_MAIL,
  needs: ["email", "mailpit", "admin-emulator"],
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C19b race";
  await handBack(ctx);
  const s = await c19bSetup(ctx, label);
  await warmVerify(ctx, s.v, s.reqs.length);
  const { rows } = await fire(ctx, s.reqs, label);
  await judgeC19b(ctx, s, rows, label);
});

scenario("C19b S23 (SYNC-P): the code requests held after every one has read the verification in progress and before any stores a code, then let go one at a time; one code is mailed and the rest are refused 429 by the resend gap, and the code mailed verifies the account (SPEC §14)", {
  tiers: LOCAL,
  effects: VERIFY_MAIL,
  needs: ["email", "mailpit", "admin-emulator", ...GATED],
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C19b S23";
  await handBack(ctx);
  const g = gates(ctx.target);
  const s = await c19bSetup(ctx, label);
  const gate = "verify-start-after-read";
  await roomFor(ctx, s.reqs.length, `${s.reqs.length} requests held at ${gate}`);
  let pending = [];
  try {
    await g.hold(gate, { key: s.v.uid });
    pending = sendAll(s.reqs);
    const h = await held(ctx, g, gate, s.reqs.length, s.v.uid, pending);
    ctx.step(`${label}: all ${s.reqs.length} code requests are held in verifyEmail, each having read the verification in progress (seq ${h.callers.map((c) => c.seq).join(", ")}); let go one at a time, each answered before the next`);
    await releaseInTurn(ctx, g, gate, s.v.uid, pending);
  } finally {
    await releaseAll(g, [gate]);
  }
  const rows = await rowsOf(ctx, pending, label);
  workersNow(ctx, `after ${label}`);
  await judgeC19b(ctx, s, rows, label);
});

scenario("C19b serial positive control: the same code requests one after another; one code is mailed and the rest are refused 429 by the resend gap, and the code mailed verifies the account (SPEC §14)", {
  tiers: LOCAL,
  effects: VERIFY_MAIL,
  needs: ["email", "mailpit", "admin-emulator"],
  n: NS,
  trials: SERIAL_TRIALS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C19b serial";
  await handBack(ctx);
  const s = await c19bSetup(ctx, label);
  const rows = await sendSerially(ctx, s.reqs, label);
  await judgeC19b(ctx, s, rows, label);
});

// =====================================================================================
// C20 — N spends of one OAuth code, and of one refresh token
// =====================================================================================

/** A loopback redirect registered with no port; nothing ever follows it here. */
const LOOPBACK_CB = "http://127.0.0.1/callback";
const RESOURCE = () => `${target.origin}/mcp`;
const ACCESS_RE = /^bsa_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;
const REFRESH_RE = /^bsr_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

/** A token answer as {tokenId, access, refresh, accessSecret, refreshSecret}, or null when it is not one grant's pair. */
function pairOf(json) {
  const a = ACCESS_RE.exec(json?.access_token ?? "");
  const r = REFRESH_RE.exec(json?.refresh_token ?? "");
  if (!a || !r || a[1] !== r[1] || json?.token_type !== "Bearer") return null;
  return { tokenId: a[1], access: json.access_token, refresh: json.refresh_token, accessSecret: a[2], refreshSecret: r[2] };
}

/** What the evidence keeps of a token answer: the grant id and short digests, never a secret. */
function showPair(json) {
  const p = pairOf(json);
  if (!p) return json?.error ? { error: json.error, error_description: json.error_description } : { shape: "not a pair" };
  return { tokenId: p.tokenId, access: sha256(p.access).slice(0, 12), refresh: sha256(p.refresh).slice(0, 12), expires_in: json.expires_in };
}

const tokenForm = (fields) => new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)).toString();

function tokenRacer(http, name, fields) {
  return racer(name, { http, path: "/oauth/token", headers: { accept: "application/json" }, contentType: "application/x-www-form-urlencoded", body: tokenForm(fields) });
}

/** Warm one oauth worker per racer: an unsupported grant type, refused 400 before anything is read. */
async function warmToken(ctx, http, n) {
  await warm(ctx, Array.from({ length: n }, () => () => http.request("POST", "/oauth/token", { form: { grant_type: "e2e_warm_up" }, headers: { accept: "application/json" }, timeoutMs: HTTP_MS })), "POST /oauth/token of an unsupported grant type (400)");
}

/** POST /mcp initialize with a bearer → its status. */
async function mcpInit(ctx, token, actor) {
  const m = ctx.mcp({ token, actor });
  const r = await m.raw({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bikeshed-e2e", version: "1" } } });
  answered(r.response, `POST /mcp initialize (${actor})`);
  return r.status;
}

/** A person who approves an app through the API (as the consent page does), and the code it gets. */
async function c20Setup(ctx, label) {
  const [s] = await people(ctx, ["connector"]);
  const http = ctx.http({ actor: "oauth-app", timeoutMs: HTTP_MS, cutoffError: true });
  const reg = await register(http, { redirectUris: [LOOPBACK_CB], clientName: `E2E C20 app ${tagOf()}` });
  precondition(reg.status === 201 && /^bsdcr_[A-Za-z0-9_-]+$/.test(reg.clientId ?? ""), `POST /oauth/register answered ${reg.status} ${brief(reg.json)}`);
  const p = pkce();
  const approved = await approveViaApi(http, s.idToken, authorizeParams({ clientId: reg.clientId, redirectUri: LOOPBACK_CB, challenge: p.challenge, resource: RESOURCE() }));
  precondition(approved.status === 200 && approved.code, `approve: ${approved.status} ${brief(approved.json)}`);
  ctx.step(`${label}: ${s.account.role} approved app ${reg.clientId} (DCR, redirect ${LOOPBACK_CB}, never followed)`);
  return { s, http, clientId: reg.clientId, code: approved.code, verifier: p.verifier };
}

const exchangeFields = (c) => ({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.clientId, redirect_uri: LOOPBACK_CB, resource: RESOURCE() });

/** The account's grants: tokens/* rows and the users/{uid}/tokens mirror. */
async function grantState(uid) {
  const rows = await queryCollection(target, "tokens", [["uid", "==", uid]]);
  const mirror = await readCollection(target, `users/${uid}/tokens`);
  return {
    grants: rows.map((r) => ({ id: r.id, kind: r.data.kind ?? null, client: r.data.client?.id ?? null, generation: r.data.generation ?? null, revoked: r.data.revokedAt != null, accessHash: r.data.accessHash ?? null, refreshHash: r.data.refreshHash ?? null, prevRefreshHash: r.data.prevRefreshHash ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
    mirror: mirror.map((m) => ({ id: m.id, revoked: m.data.revokedAt != null })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Every answer 200 with one and the same pair; resolves the pair (or null). */
async function samePair(others, rows, label) {
  await others.check(() => judgeStatuses(rows, label));
  const pairs = rows.map((r) => pairOf(r.json));
  const distinct = new Set(pairs.filter(Boolean).map((p) => `${p.access} ${p.refresh}`));
  await others.check(() => assert.ok(pairs.every(Boolean) && distinct.size === 1, `${label}: the ${rows.length} spends got ${distinct.size} distinct pair(s) (${rows.map((r) => `${r.name}: ${r.status} ${brief(showPair(r.json), 120)}`).join("; ")}); SPEC §23: a retry of the same spend within 60 s receives the identical pair, so a timeout cannot fork the chain`));
  return pairs.find(Boolean) ?? null;
}

scenario("C20a N exchanges of one code (SYNC-T): an app spends one authorization code N times at one instant; every exchange answers the identical bsa_/bsr_ pair, one grant exists and the code names it, and the pair reaches /mcp (SPEC §23)", {
  tiers: BOTH,
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C20a race";
  await handBack(ctx);
  const c = await c20Setup(ctx, label);
  const reqs = Array.from({ length: ctx.n }, (_, i) => tokenRacer(c.http, `exchange ${i + 1}`, exchangeFields(c)));
  await warmToken(ctx, c.http, reqs.length);
  const { rows } = await fire(ctx, reqs, label, { show: showPair });
  const others = oracleSet();
  const pair = await samePair(others, rows, label);
  if (pair) appendLedger(target, { kind: "oauth", tokenId: pair.tokenId, uid: c.s.uid, clientId: c.clientId });
  const st = await stable(ctx, () => grantState(c.s.uid), `${label} grants`);
  await others.check(() => assert.deepEqual(st.grants.map((x) => ({ id: x.id, kind: x.kind, client: x.client, generation: x.generation, revoked: x.revoked })), [{ id: pair?.tokenId ?? "<no pair>", kind: "oauth", client: c.clientId, generation: 0, revoked: false }], `${label}: one grant, the pair's, never rotated or revoked (SPEC §23: the code is spent in the transaction that mints the grant)`));
  await others.check(() => assert.deepEqual(st.mirror, [{ id: pair?.tokenId ?? "<no pair>", revoked: false }], `${label}: the account screen's mirror lists that one grant`));
  const spent = await readDoc(target, `oauthCodes/${sha256(c.code)}`);
  await others.check(() => assert.ok(spent?.usedAt != null && spent.tokenId === pair?.tokenId, `${label}: the code is spent and names the grant (tokenId ${spent?.tokenId ?? null})`));
  if (pair) {
    const status = await mcpInit(ctx, pair.access, "c20a-app");
    await others.check(() => assert.equal(status, 200, `${label}: the bsa_ initializes /mcp`));
  }
  measure(ctx, MEASURE, { scenario: label, spends: rows.length, distinctPairs: new Set(rows.map((r) => pairOf(r.json)?.access ?? null)).size, grants: st.grants.length });
  verdict({ others });
});

scenario("C20b N refreshes of one bsr_ (SYNC-T): an app spends one refresh token N times at one instant; every refresh answers the identical rotated pair, the grant rotated once and stays connected, the new bsa_ reaches /mcp and the new bsr_ refreshes again (SPEC §23)", {
  tiers: BOTH,
  n: NS,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const label = "C20b race";
  await handBack(ctx);
  const c = await c20Setup(ctx, label);
  const first = answered(await c.http.request("POST", "/oauth/token", { form: exchangeFields(c), headers: { accept: "application/json" }, timeoutMs: HTTP_MS }), "POST /oauth/token (the exchange)");
  const pair0 = pairOf(first.json);
  precondition(first.status === 200 && pair0, `the exchange: ${first.status} ${brief(showPair(first.json))}`);
  appendLedger(target, { kind: "oauth", tokenId: pair0.tokenId, uid: c.s.uid, clientId: c.clientId });
  const reqs = Array.from({ length: ctx.n }, (_, i) => tokenRacer(c.http, `refresh ${i + 1}`, { grant_type: "refresh_token", refresh_token: pair0.refresh, client_id: c.clientId }));
  await warmToken(ctx, c.http, reqs.length);
  const { rows } = await fire(ctx, reqs, label, { show: showPair });
  const others = oracleSet();
  const pair = await samePair(others, rows, label);
  await others.check(() => assert.ok(pair && pair.tokenId === pair0.tokenId && pair.access !== pair0.access && pair.refresh !== pair0.refresh, `${label}: the refreshes answer the same grant's pair, rotated from the one spent`));
  const st = await stable(ctx, () => grantState(c.s.uid), `${label} grants`);
  await others.check(() => assert.deepEqual(st.grants.map((x) => ({ id: x.id, kind: x.kind, generation: x.generation, revoked: x.revoked })), [{ id: pair0.tokenId, kind: "oauth", generation: 1, revoked: false }], `${label}: one grant, rotated exactly once by the ${rows.length} spends of one refresh token, and still connected`));
  const g = st.grants[0];
  await others.check(() => assert.deepEqual(g && { accessHash: g.accessHash, refreshHash: g.refreshHash, prevRefreshHash: g.prevRefreshHash }, { accessHash: pair ? sha256(pair.accessSecret) : null, refreshHash: pair ? sha256(pair.refreshSecret) : null, prevRefreshHash: sha256(pair0.refreshSecret) }, `${label}: the grant holds the answered pair's hashes and the spent refresh token's as the previous one`));
  if (pair) {
    const status = await mcpInit(ctx, pair.access, "c20b-app");
    await others.check(() => assert.equal(status, 200, `${label}: the rotated bsa_ initializes /mcp`));
    const again = answered(await c.http.request("POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: pair.refresh, client_id: c.clientId }, headers: { accept: "application/json" }, timeoutMs: HTTP_MS }), "POST /oauth/token (the next refresh)");
    const next = pairOf(again.json);
    const gen = (await readDoc(target, `tokens/${pair0.tokenId}`))?.generation ?? null;
    await others.check(() => assert.ok(again.status === 200 && next && next.tokenId === pair0.tokenId && next.refresh !== pair.refresh && gen === 2, `${label}: the rotated bsr_ refreshes again (${again.status} ${brief(showPair(again.json))}, generation ${gen}): the chain did not fork`));
  }
  measure(ctx, MEASURE, { scenario: label, spends: rows.length, distinctPairs: new Set(rows.map((r) => pairOf(r.json)?.access ?? null)).size, generation: g?.generation ?? null });
  verdict({ others });
});
