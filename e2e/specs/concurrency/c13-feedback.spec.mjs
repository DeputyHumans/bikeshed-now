// SPDX-License-Identifier: Apache-2.0
// C13 the twenty-pending race, C14 comments and suggestions racing a publish, C15 a feedback storm under a get_changes poller, with their serial positive controls (SPEC §2, §6a, §14, §19, §22).

/**
 * Every case stages its own document (crdt-paragraphs.html, p#e2e-1..40) and
 * its own accounts. "N users" are N parallel MCP clients (the plan's server
 * races), each on its own token, and for the browser's channel N tabs that
 * write Firestore through the rules as the app does (lib/web.mjs).
 *
 *   C13       one author at nineteen pending suggestions on v1 has N agents
 *             (N tokens of the same person) call suggest_edit at once, on N
 *             other paragraphs. SPEC §22: "Each author may have twenty pending
 *             suggestions on one version"; §2: create is refused "409 twenty
 *             pending by this author". Variants: SYNC-T (N worker threads fire
 *             within 15 ms and every call is on the wire before any answer
 *             begins) and GATED (amplify-c13-feedback holds each create at
 *             `suggest-after-count`, past its count and before its
 *             transaction, until all N are held; then all go). WORK: every
 *             answer is a suggestion made on v1 or the twenty-pending refusal,
 *             at least one is made, each made one is stored pending. JUDGE
 *             (S7, the count is read outside the transaction,
 *             functions/src/lib/suggestions.ts:196-208): at most twenty
 *             pending. C13-serial: the same calls one after another, the
 *             first made and every other refused, twenty pending.
 *   C14       a publish and feedback on v1. The oracle every variant shares
 *             (SPEC §6a "allowed only when every comment on the current
 *             version is resolved" and "No version is minted while a
 *             suggestion on the current one is pending, through ANY account
 *             channel"; §19 a thread "holds back a new version saved in the
 *             app"; §22 a suggestion "is never left behind on a version nobody
 *             reads"): once a version is current, nothing open is left on an
 *             older one, and every thread a caller was told it opened is where
 *             it was told. The publish is the in-app mint (commitDraft, as the
 *             owner's agent's commit_draft) or the update mint (reviseDocument:
 *             update_document, POST /publish?update=), whose own guard and
 *             in-transaction recheck (functions/src/lib/publish.ts:489, :512)
 *             are separate code. Feedback is an agent's add_comment or
 *             suggest_edit, or a thread opened in the browser: the app's
 *             createAnnotation, a Firestore create through the rules, which
 *             do not ask whether its version is still current
 *             (config/templates/firestore.rules.tmpl:212-217).
 *               Against commitDraft:
 *             SYNC-T: N agents' comments and suggestions (in turn), N web
 *             threads and the commit, all at one instant. WORK: every answer
 *             is a thread made on v1, or, only once the commit published,
 *             one made on v2 or a refusal for the newer version; each is
 *             where it was told; the commit published or was held back by
 *             open feedback, consistently with the state; no suggestion is
 *             left behind (§22). JUDGES, each INCONCLUSIVE when the commit
 *             was refused (no version replaced v1, so nothing could be left):
 *             no agent comment left behind (S12), no web thread left behind
 *             (X-c13-feedback-1). COMMIT HELD: the commit is held at
 *             `commit-before-tx` (after its open-thread check and upload)
 *             while N agents' comments land on v1 (the target of
 *             controls-c14-left-behind), and a variant with N web threads in
 *             their place; released, its transaction must refuse. SUGGESTION
 *             HELD: N creates held at `suggest-after-count` while the commit
 *             publishes v2; released, each must be refused for the newer
 *             version. COMMENT HELD (S12, functions/src/mcp/tools.ts:1626-1658:
 *             add_comment reads currentVersion, finds the passage, then
 *             writes the thread in a plain batch with no check that the
 *             version is still current): N add_comment calls held at
 *             `comment-before-write` while the commit publishes v2. STALE
 *             TAB (X-c13-feedback-1): v2 is published, then N tabs that still
 *             show v1 open a thread each on v1, in order; it is the losing
 *             side of a web thread racing the commit, made deterministic.
 *               Against reviseDocument (comments are exempt there, SPEC §19:
 *             "holds back a new version saved in the app, but not
 *             update_document"): UPDATE SYNC-T: N suggestions and the owner's
 *             agent's update_document at one instant. SUGGESTION HELD,
 *             update_document: N creates held at `suggest-after-count` while
 *             update_document mints v2; each must be refused for the newer
 *             version. UPDATE HELD: the owner's upload of a new version (POST
 *             /publish?update=, the app's "Upload a new version") held at
 *             amplify-c08-mint-races's `update-after-upload`, between its
 *             upload and its transaction, while N suggestions land on v1;
 *             released, its transaction must refuse it for the pending
 *             suggestions (the target of controls-c14-update-recheck).
 *               C14-serial: agents' comments and web threads on v1, the
 *             commit (refused), each resolved (resolve_thread, the app's
 *             setResolved), the commit (v2), then comments and web threads on
 *             the version the document now names (v2): nothing left behind.
 *   C15       a feedback storm with a get_changes poller (refutation). An
 *             owner and N participants (suggesters), fresh accounts per case.
 *             The owner opens T0 in the browser (Firestore, the rules) and an
 *             owner's token starts polling get_changes from the log's head.
 *             At one instant every participant opens a thread (add_comment),
 *             replies in T0 through the rules as the app writes a reply, and
 *             suggests an edit (suggest_edit): 3N requests. Then three flip
 *             rounds on T0, each fired at once by every participant's agent:
 *             all resolve, all reopen, odd resolve and even reopen. The tools
 *             answer the state they were ASKED for (functions/src/lib/
 *             threads.ts:44, :58), so each round is also judged on what is
 *             stored: T0's state read through the Admin SDK after rounds 1
 *             and 2, and the round's own flip events in the log (each round's
 *             events settled before the next round fires): exactly one
 *             thread.resolved in round 1, one thread.reopened in round 2, at
 *             least one flip in round 3, and real flips alternate. Then the
 *             owner replies in T0. N threads, N+1 replies; I10: the generated
 *             "Resolved." and "Reopened." notes equal the real flips the log
 *             recorded, and T0's final state matches their parity; I15: the
 *             poller saw every logged event exactly once and the counts are
 *             what was caused. Two variants:
 *               C15 (LOCAL, email on): grants through one POST /access, which
 *             invites by email. I11: at most one notice per (person, document,
 *             kind) and exactly one for the owner's comment and suggestion
 *             notices and each participant's comment notice (the owner's
 *             closing reply makes every participant eligible) and invitation.
 *             Its I11 RACE judge asks whether that bound was ever raced: the
 *             Functions emulator ran every Firestore trigger one at a time in
 *             every run so far (lib/logs.mjs caseFunctionRuns over the case's
 *             window of emulators.log), so claimCommentCooldown's transaction
 *             (functions/src/email/notify.ts:42-67) was never contended. The
 *             judge is INCONCLUSIVE unless two onCommentCreated runs
 *             overlapped. The bound under contention is unproven on both
 *             tiers: C15 does not run on production, and the zero-email
 *             variant's accounts have notifications off, so the claim returns
 *             before it writes (notify.ts:55).
 *               C15 zero-email (BOTH): grants through the operator script
 *             (scripts/set-access.mjs, the production path, taken locally
 *             too), every account with notifications off, no I11. On
 *             production, where triggers run concurrently and Eventarc may
 *             redeliver, it is I15's "each event once" against events.ts's
 *             create-never-overwrite rule (functions/src/lib/events.ts:22-28).
 *
 * A failed sync precondition (a spread over 15 ms, an unproven overlap, a gate
 * that never held its callers, a call answered while it should have been held,
 * no two trigger runs at once) is INCONCLUSIVE, never FAIL. Each judge reads
 * what its work case of the same [N=n] #trial recorded, and is INCONCLUSIVE
 * when that never measured, so a defect's own assertion is the only thing a
 * judge can fail on.
 *
 * The lib does the mechanics: SYNC-T is lib/sync.mjs syncHttp given the
 * target (the isolation check and the production guard ask about every
 * request and warm-up before anything is sent, and each hop is traced into the
 * case's http.jsonl), each racer's socket warmed on a static file
 * (lib/workers.mjs staticWarmUrl, so no Functions worker starts for a
 * warm-up); a gated race is lib/gates.mjs holdCalls (its INCONCLUSIVE rules);
 * the plan's server settle, "counts stable for 10 s", is lib/assert.mjs
 * settleStill; I15's poller and readers are lib/changes.mjs startPoller,
 * logAfter and feedToLogIds (the change log read through the Admin SDK, never
 * by polling get_changes with another cursor); I11's notices per (person,
 * kind) are lib/mail/reader.mjs settleKinds; whether two trigger runs
 * overlapped is lib/logs.mjs caseFunctionRuns; a web thread is lib/web.mjs.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, functionKill, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4 } from "../../lib/accounts.mjs";
import { idToken, mintToken, openSession, openSessions } from "../../lib/session.mjs";
import { publish, readFixture, updateUpload } from "../../lib/seed.mjs";
import { shareMany } from "../../lib/grant.mjs";
import { grantEditors } from "../../lib/live.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { settleStill } from "../../lib/assert.mjs";
import { requireConclusive, syncHttp } from "../../lib/sync.mjs";
import { gates, holdCalls } from "../../lib/gates.mjs";
import { ACCEPT, DEFAULT_PROTOCOL, parseMcpBody, toolOutcome } from "../../lib/mcp.mjs";
import { assertInvariant, checkI10, checkI11, checkI15 } from "../../lib/invariants.mjs";
import { POLL_INTERVAL_MS, changeLog, eventAt, feedToLogIds, logAfter, logCounts, startPoller } from "../../lib/changes.mjs";
import { clientFirestore, firestoreOrigin, toFields } from "../../lib/firestore-client.mjs";
import { anchorIn, autoId, commentData, commentPath, webAnnotationWrite, webReply, webResolve, webThread } from "../../lib/web.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { measure } from "../../lib/evidence.mjs";
import { staticWarmUrl } from "../../lib/workers.mjs";
import { FIRESTORE_TRIGGERS, caseFunctionRuns } from "../../lib/logs.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const LOCAL = ["local"];
const BOTH = ["local", "prod"];
const N = [2, 5, 10, 20];
/** The amplify set's three pause points (e2e/patches/amplify-c13-feedback/amplify.json). */
const AMPLIFY = ["gates", "patch:amplify-c13-feedback"];
const SUGGEST_GATE = "suggest-after-count";
const COMMENT_GATE = "comment-before-write";
const COMMIT_GATE = "commit-before-tx";
/** amplify-c08-mint-races's pause point in commitNewVersion, between the upload of v(N+1)/ and its transaction (that set's amplify.json). */
const AMPLIFY_UPDATE = ["gates", "patch:amplify-c08-mint-races"];
const UPDATE_GATE = "update-after-upload";
/** C15 grants through one POST /access, which invites by email, and its comments send notices. */
const STORM_EMAIL = ["email:POST /access", "email:comment notice"];

/** One request's own deadline: past Hosting's minute, so a stalled one ends in its 504 (INCONCLUSIVE). */
const FN_MS = 120_000;
const CASE_MS = 600_000;
const STORM_MS = 1_200_000;
const JUDGE_MS = 60_000;
/** The change log's triggers ran 10–44 s each on a loaded shared stack (lib/changes.mjs LOG_SETTLE_MS). */
const LOG_MS = 240_000;
const MAIL_MS = 240_000;
/** C15's setup events (the version, the grants, T0) hold still this long before the poller's cursor is taken. */
const SETUP_QUIET_MS = 3_000;
const LIMIT = 20;
/** C13 starts the author at one short of the limit, so every racer wants the same last slot. */
const PREFILL = LIMIT - 1;
/** C14's web threads quote p#e2e-(21..40), its agents p#e2e-(1..20): no passage is quoted twice in one case. */
const WEB_FROM = 20;

const LIMIT_RE = /^You already have 20 suggestions waiting on this version\. Wait for some to be decided, or withdraw one\.$/;
const NEWER_RE = /^This document has a newer version\. Reload, then suggest the edit on it\.$/;
const OPEN_RE = /^Resolve all comments before publishing a new version\.$/;
const PENDING_RE = /^\d+ suggested edits? (is|are) waiting for a decision\./;
/** A refusal an add_comment that checked the version would plausibly give; the product gives none today (S12). */
const COMMENT_NEWER_RE = /newer version/i;
/** The rules' refusal of a client write. */
const DENIED_RE = /PERMISSION_DENIED/;

const lower = (s) => String(s ?? "").toLowerCase();
/** settleStill's report line, through the case's step. */
const stepOf = (ctx) => (line) => ctx.step(line);

// --- the fixture's passages ------------------------------------------------------------------

const FIXTURE_SRC = readFixture(FIXTURE, { raw: true }).toString("utf8");
const PARAGRAPHS = new Map([...FIXTURE_SRC.matchAll(/<p id="(e2e-\d+)">([^<]*)<\/p>/g)].map((m) => [m[1], m[2]]));
/** "Paragraph k." stands once in the document, at the start of p#e2e-k: the passage an agent quotes. */
const exactOf = (k) => `Paragraph ${k}.`;
/** The same passage as the app anchors a selection of it (POST /suggestion, a web thread). */
function anchorOf(k) {
  const text = PARAGRAPHS.get(`e2e-${k}`);
  precondition(typeof text === "string", `the fixture has p#e2e-${k}`);
  return anchorIn(text, `e2e-${k}`, exactOf(k));
}
/** The fixture with p#e2e-40 changed: the bytes of a draft or of an update. */
function withP40(said) {
  const html = FIXTURE_SRC.replace(`<p id="e2e-40">${exactOf(40)}`, `<p id="e2e-40">Paragraph 40 (${said}).`);
  precondition(html !== FIXTURE_SRC, "the new bytes change p#e2e-40");
  return html;
}

// --- what the work cases leave for their judges ------------------------------------------------

/** `${ref}|${n}|${trial}` → the observation a work case recorded. */
const observed = new Map();
const keyOf = (ref, ctx) => `${ref}|${ctx.n}|${ctx.trial}`;

/** Run a work body; an INCONCLUSIVE it ends in is told to its judge. */
async function working(ctx, ref, body) {
  const obs = { ref, n: ctx.n, trial: ctx.trial, stage: "started", inconclusive: null };
  observed.set(keyOf(ref, ctx), obs);
  try {
    return await body(obs);
  } catch (err) {
    if (err?.code === "E2E_INCONCLUSIVE") obs.inconclusive = err.reason ?? err.message;
    throw err;
  }
}

function observation(ctx, ref, field) {
  const o = observed.get(keyOf(ref, ctx));
  if (!o) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} did not run in this process, so there is nothing to judge`);
  if (o.inconclusive) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} was INCONCLUSIVE: ${o.inconclusive}`);
  if (o[field] == null) ctx.inconclusive(`the ${ref} work case [N=${ctx.n}] #${ctx.trial} stopped (${o.stage}) before it measured ${field}`);
  ctx.ev.json(`observed-${field}`, o[field]);
  return o[field];
}

/** A row per case in <invocation>/c13-feedback.jsonl: a passing case keeps no evidence. Never the case's outcome. */
function record(ctx, row) {
  try {
    measure(ctx, "c13-feedback", row);
  } catch {
    /* a measurement row is never the case's outcome */
  }
}

// --- staging ------------------------------------------------------------------------------------

/**
 * An owner (email notifications off: the owner's own comments and suggestions
 * on its own document address nobody, so nothing is emailed) and the fixture
 * published. With `draft`, the owner saves a draft of v1 that changes
 * p#e2e-40 (POST /draft), so commit_draft has something to publish.
 */
async function ownerDoc(ctx, label, { draft = false } = {}) {
  const tag = rand4();
  ctx.step(`cast an owner (email notifications off); it publishes ${FIXTURE}`);
  const [acct] = await cast(target, ["owner"], { http: ctx.http({ actor: "harness" }), notifications: false });
  const owner = await openSession(target, acct, { timeoutMs: FN_MS, cutoffError: true });
  const title = `${label} N=${ctx.n} ${tag}`;
  const up = await publish(owner.http, { fixture: FIXTURE, title, name: "c13", timeoutMs: FN_MS });
  precondition(up.status === 200 && up.versionId === "v1", `POST /publish answered ${up.status} ${JSON.stringify(up.json)}`);
  const docId = up.docId;
  const v1 = await readDoc(target, `docs/${docId}/versions/v1`);
  precondition(typeof v1?.entry === "string" && v1.entry, `v1 of ${docId} names its entry (${JSON.stringify(v1?.entry)})`);
  if (draft) {
    const html = withP40(`draft ${tag}`);
    const r = await owner.http.postJson("/draft", { docId, baseVersion: "v1", html }, { timeoutMs: FN_MS });
    precondition(r.status === 200, `POST /draft answered ${r.status} ${r.text.slice(0, 200)}`);
    const meta = await readDoc(target, `docs/${docId}`);
    precondition(meta?.draft, `docs/${docId}.draft exists after POST /draft`);
    ctx.step(`${docId}: the owner saved a draft of v1 (p#e2e-40 changed)`);
  }
  return { owner, acct, uid: owner.uid, docId, entry: v1.entry, title, tag };
}

/** `k` agents of `session`'s person: an MCP token each (channel mcp), and a client on it. */
async function agentsOf(ctx, session, k, label, prefix = "a") {
  const out = [];
  for (let i = 0; i < k; i += 1) {
    const name = `${prefix}${i + 1}`;
    const actor = `${label}-${name}`;
    const { token } = await mintToken(session, { name: `${label} ${name}`, channel: "mcp" });
    out.push({ name, actor, email: lower(session.account.email), token, mcp: ctx.mcp({ token, actor, timeoutMs: FN_MS, cutoffError: true }) });
  }
  return out;
}

/** A person's browser, for writes through the rules: its ID token and a Firestore REST client on it, traced as `actor`. */
async function webOf(ctx, session, actor) {
  const tok = await idToken(target, session.account);
  return { tok, fs: clientFirestore(target, { idToken: tok, http: ctx.http({ actor }) }) };
}

// --- firing ---------------------------------------------------------------------------------------

/** One tools/call as a raw request for syncHttp, traced under `actor` (syncHttp adds the harness's user-agent and x-bikeshed-agent). */
function toolRequest(token, name, args, id, actor) {
  return {
    url: `${target.origin}/mcp`,
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: ACCEPT, "content-type": "application/json", "mcp-protocol-version": DEFAULT_PROTOCOL },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    warm: staticWarmUrl(target),
    actor,
  };
}

/** A syncHttp row of POST /mcp tools/call → {status, isError, text, json}. */
function toolAnswer(row, id) {
  if (!row || row.error) return { status: null, isError: true, text: `transport: ${row?.error ?? "no result"}`, json: null };
  let messages;
  try {
    messages = parseMcpBody(row.headers?.["content-type"], row.body);
  } catch (e) {
    return { status: row.status, isError: true, text: `unparsable reply: ${e.message}`, json: null };
  }
  const msg = messages.find((m) => m.id === id) ?? messages[0];
  if (row.status !== 200 || !msg) return { status: row.status, isError: true, text: `HTTP ${row.status} ${String(row.body ?? "").slice(0, 200)}`, json: null };
  if (msg.error) return { status: row.status, isError: true, text: `JSON-RPC ${msg.error.code} ${msg.error.message}`, json: null };
  const out = toolOutcome(msg.result);
  return { status: row.status, isError: out.isError, text: out.text, json: out.json ?? null };
}

/** A syncHttp row of a Firestore REST :commit → {status, isError, text, json (`made` when it committed), code}. */
function firestoreAnswer(row, made) {
  if (!row || row.error) return { status: null, isError: true, text: `transport: ${row?.error ?? "no result"}`, json: null, code: null };
  let body = null;
  try {
    body = JSON.parse(row.body);
  } catch {}
  const err = Array.isArray(body) ? body[0]?.error : body?.error;
  const code = typeof err?.status === "string" ? err.status : null;
  return { status: row.status, isError: row.status !== 200, text: row.status === 200 ? "committed" : `${row.status} ${code ?? ""} ${err?.message ?? ""}`.trim(), json: row.status === 200 ? made : null, code };
}

/**
 * SYNC-T: `calls` [{who, request, parse(row, id)}] fired from N worker threads
 * at one instant, each on a socket it opened (and warmed) before the barrier.
 * A call is a tool (`tool(agent, name, args)`) or a raw request with its own
 * parser. syncHttp is given the target, so the isolation check and the
 * production guard ask about every request and warm-up before any worker
 * exists, and each hop is a row of the case's http.jsonl under its actor.
 * INCONCLUSIVE unless the spread is within 15 ms and every request was on the
 * wire before any answer began; a Hosting 504 is INCONCLUSIVE too. A call with
 * a `retry` that Firestore answered ABORTED is sent once more, as the SDK
 * does, with the same document id.
 */
async function fireAtOnce(ctx, calls, label) {
  const requests = calls.map((c) => c.request);
  const run = await syncHttp(requests, { target: ctx.target, timeoutMs: FN_MS });
  precondition(run.guarded === true, `${label}: the race went through syncHttp's guarded path`);
  const answers = calls.map((c, i) => ({ who: c.who, what: c.what, ...c.parse(run.results.find((r) => r.i === i), i + 1) }));
  const timing = run.results.map((r) => ({ i: r.i, status: r.status ?? null, error: r.error ?? null, firedAt: r.firedAt, sentAt: r.sentAt, firstByteAt: r.firstByteAt, endAt: r.endAt }));
  ctx.ev.json(`fire-${label}`, { spreadMs: run.spreadMs, conclusive: run.conclusive, overlap: run.overlap, timing, answers: answers.map(brief) });
  ctx.step(`${label}: fired ${calls.length} request(s) at once: spread ${Number(run.spreadMs).toFixed(2)} ms; overlap ${run.overlap.ok ? `proven (every request sent ${run.overlap.marginMs.toFixed(1)} ms before the first answer began)` : run.overlap.reason}`);
  const cut = answers.filter((a) => a.status === 504);
  if (cut.length) ctx.inconclusive(`the stack did not answer, so nothing was measured: Hosting answered 504 to ${cut.map((a) => `${a.who} ${a.what}`).join(", ")}`);
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  for (const [i, a] of answers.entries()) {
    if (a.code === "ABORTED" && typeof calls[i].retry === "function") {
      answers[i] = { ...a, ...(await calls[i].retry()) };
      ctx.step(`${a.who}'s ${a.what} was ABORTED once and sent again with the same id, as the SDK does: ${brief(answers[i])}`);
    }
  }
  return { answers, race: { kind: "sync-t", spreadMs: Math.round(run.spreadMs * 100) / 100, overlapMarginMs: Math.round(run.overlap.marginMs * 10) / 10 } };
}

/** A tools/call for fireAtOnce. */
const tool = (agent, name, args, id = null) => ({ who: agent.name, what: name, request: toolRequest(agent.token, name, args, id ?? 0, agent.actor ?? agent.name), parse: toolAnswer, agent, name, args });

/** Give each fireAtOnce call the JSON-RPC id its parser expects (its position, from 1). */
const numbered = (calls) => calls.map((c, i) => (c.request.body && c.name ? { ...c, request: toolRequest(c.agent.token, c.name, c.args, i + 1, c.request.actor) } : c));

/** A tool's answer through an agent's own MCP client, in the shape fireAtOnce gives. */
const answerOf = (c, out) => ({ who: c.who, what: c.name, status: 200, isError: out.isError, text: out.text, json: out.json ?? null });

/**
 * A thread opened in the browser, for fireAtOnce: the app's createAnnotation
 * (functions-free: one Firestore REST :commit through the rules, as the SDK's
 * setDoc sends it), as `acct` on its tab `web`, on `versionId` (the version
 * the tab shows) and p#e2e-k. The first comment follows when the person types;
 * the commit gate counts the annotation alone. Made: {threadId, version}.
 */
function webThreadCall(who, web, acct, { docId, versionId, k }) {
  const w = webAnnotationWrite(web.fs, acct, { docId, versionId, anchor: anchorOf(k) });
  const made = { threadId: w.annId, version: versionId };
  return {
    who,
    what: "web thread",
    request: { url: `${web.fs.base}:commit`, method: "POST", headers: { authorization: `Bearer ${web.tok}`, "content-type": "application/json" }, body: JSON.stringify({ writes: [w.write] }), warm: `${firestoreOrigin(target)}/`, actor: `${who}-firestore` },
    parse: (row) => firestoreAnswer(row, made),
    retry: async () => {
      const r = await web.fs.commit([w.write]);
      return { status: r.status, isError: !r.ok, text: r.ok ? "committed on retry (ABORTED once)" : `${r.status} ${r.code ?? ""} ${r.message ?? ""}`.trim(), json: r.ok ? made : null, code: r.code };
    },
  };
}

/** `k` threads opened in the browser, all at once (each the app's createAnnotation then addComment), on `versionId`: answers in fireAtOnce's shape. */
async function webThreads(ctx, s, versionId, label) {
  return Promise.all(
    s.feedback.map(async (a, i) => {
      const who = `${a.name}-tab`;
      try {
        const r = await webThread(s.web.fs, s.owner.account, { docId: s.docId, versionId, anchor: anchorOf(WEB_FROM + i + 1), body: `C14 ${s.tag}: ${label}, ${who} on paragraph ${WEB_FROM + i + 1}` });
        return { who, what: "web thread", status: 200, isError: false, text: "committed", json: { threadId: r.annId, version: versionId } };
      } catch (err) {
        if (err?.code !== "E2E_WEB_WRITE") throw err;
        return { who, what: "web thread", status: err.result?.status ?? null, isError: true, text: err.message, json: null };
      }
    }),
  );
}

/**
 * GATED (lib/gates.mjs holdCalls): `calls` (tools, through each agent's own
 * client) sent together, or `send()` of your own; the server gate `gate`,
 * armed for `docId` alone, holds each until all are held; then `whileHeld()`
 * runs (nothing, or the request the held calls race), and one release lets
 * them all go. holdCalls is INCONCLUSIVE when the gate never holds all of
 * them, when one answered while it should have been held, or when the release
 * let another number go.
 */
async function holdAndRun(ctx, { gate, docId, calls = null, send = null, whileHeld = null }) {
  const out = await holdCalls(ctx, gates(ctx.target), {
    gate,
    key: docId,
    send: send ?? (() => calls.map((c) => c.agent.mcp.call(c.name, c.args).then((r) => answerOf(c, r)))),
    whileHeld: whileHeld ? () => whileHeld() : null,
  });
  return { answers: out.answers, during: out.during, race: { kind: "gate", gate, held: out.held.callers.length, released: out.release.released.length } };
}

const brief = (a) => `${a.who} ${a.what}: ${a.isError ? `refused: ${String(a.text).slice(0, 160)}` : a.json ? JSON.stringify(a.json).slice(0, 200) : `status ${a.status}`}`;

// The plan's server settle is lib/assert.mjs settleStill: a read that gives the same value for 10 s,
// within 120 s. Running out is a wait ("… within <ms> ms"), which a case's stack judges may excuse.

// --- the Functions emulator's runs in a case's window ---------------------------------------------
// lib/logs.mjs caseFunctionRuns(ctx): its functionRuns over the case's own window of emulators.log (from
// ctx.logSince), read after the server settle. Every count is a LOWER bound, exact when `exact` (nothing
// in flight as the window began, no failure line, no stray end), so a peak of 2 is two runs that
// certainly overlapped, and a peak of 1 that is not exact leaves the question open.

/** A peak k, worded as exact, or as a lower bound when the window is not exact. */
const peakOf = (r, k) => (r.exact ? `${k}` : `at least ${k}`);
const runsLine = (r) =>
  r
    ? `Firestore triggers begun: ${FIRESTORE_TRIGGERS.map((t) => `${t} ${r.runs[t] ?? 0} (peak ${peakOf(r, r.peak[t] ?? 0)} at once)`).join(", ")}; ${peakOf(r, r.peakTriggers)} trigger(s) at once, while the HTTP functions reached ${peakOf(r, r.peakOther)}; ${
        r.exact
          ? "exact (nothing in flight as the case began, no failure line, no stray end)"
          : `lower bounds (${r.openAtStart ?? "an unknown number of"} run(s) in flight as the case began, ${r.failed} failure line(s), stray ends ${JSON.stringify(r.stray)})`
      }${Object.keys(r.open).length ? `; not yet finished ${JSON.stringify(r.open)}` : ""}`
    : "the emulators log was not read (not a local stack, or no logs capability)";

// =====================================================================================================
// C13 — the twenty-pending limit under a race
// =====================================================================================================

/** The author's pending suggestions on v1: {pending, ids} (sorted), through the Admin SDK. */
async function pendingOf(docId, uid) {
  const anns = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
  const ids = anns.filter((a) => a.data.authorUid === uid && a.data.suggestion?.state === "pending").map((a) => a.id).sort();
  return { pending: ids.length, ids };
}

/** An owner at nineteen pending suggestions on v1 (POST /suggestion, the app's path), and N agents of that same person. */
async function c13Stage(ctx, label) {
  const d = await ownerDoc(ctx, label);
  ctx.step(`the owner makes ${PREFILL} suggestions on v1 through POST /suggestion (p#e2e-1..${PREFILL}), five at a time`);
  for (let k = 1; k <= PREFILL; k += 5) {
    const ks = Array.from({ length: Math.min(5, PREFILL - k + 1) }, (_, j) => k + j);
    const rs = await Promise.all(ks.map((j) => d.owner.http.postJson("/suggestion", { op: "create", docId: d.docId, versionId: "v1", anchor: anchorOf(j), replacement: `Paragraph ${j} (prefill ${d.tag}).` }, { timeoutMs: FN_MS })));
    rs.forEach((r, i) => precondition(r.status === 200 && typeof r.json?.annId === "string", `POST /suggestion create on p#e2e-${ks[i]}: ${r.status} ${r.text.slice(0, 200)}`));
  }
  const before = await pendingOf(d.docId, d.uid);
  precondition(before.pending === PREFILL, `the owner holds ${PREFILL} pending suggestions on v1 before the race (${before.pending})`);
  const agents = await agentsOf(ctx, d.owner, ctx.n, "c13");
  ctx.step(`${ctx.n} agent(s) of the owner, each on its own MCP token: ${agents.map((a) => a.name).join(", ")}`);
  return { ...d, agents };
}

/** Agent i suggests on p#e2e-(20+i+1): one paragraph each, none of the nineteen. */
const c13Calls = (s) => s.agents.map((a, i) => tool(a, "suggest_edit", { id: s.docId, exact: exactOf(PREFILL + 1 + i), replacement: `Paragraph ${PREFILL + 1 + i} (${s.tag} ${a.name}).` }));
const madeOn = (a, version) => !a.isError && typeof a.json?.threadId === "string" && a.json?.version === version;

/** C13's work: stage, fire (`how`), settle; record {pending, made} for the judge; assert what no suspect predicts. */
async function c13Work(ctx, ref, how) {
  await working(ctx, ref, async (obs) => {
    const s = await c13Stage(ctx, ref);
    obs.stage = "staged";
    const calls = numbered(c13Calls(s));
    const fired = how === "gated" ? await holdAndRun(ctx, { gate: SUGGEST_GATE, docId: s.docId, calls }) : await fireAtOnce(ctx, calls, "suggest_edit");
    obs.stage = "fired";
    const answers = fired.answers;
    ctx.ev.json("answers", answers.map(brief));
    ctx.step(`answers: ${answers.map(brief).join("; ")}`);
    const settled = await settleStill(() => pendingOf(s.docId, s.uid), { what: "C13 pending suggestions", step: stepOf(ctx) });
    const made = answers.filter((a) => madeOn(a, "v1"));
    obs.result = { pending: settled.pending, made: made.length, n: ctx.n };
    obs.stage = "measured";
    ctx.step(`the author now holds ${settled.pending} pending suggestion(s) on v1; ${made.length} of ${ctx.n} call(s) made one (the judge's)`);
    record(ctx, { ref, how, race: fired.race, pending: settled.pending, made: made.length, refused: answers.length - made.length });
    const odd = answers.filter((a) => !madeOn(a, "v1") && !(a.isError && LIMIT_RE.test(a.text)));
    assert.deepEqual(odd.map(brief), [], "C13: every suggest_edit answered a suggestion made on v1, or the twenty-pending refusal");
    assert.ok(made.length >= 1, `C13: the twentieth slot was free, so at least one call makes a suggestion (${made.length} did)`);
    const lost = made.filter((a) => !settled.ids.includes(a.json.threadId));
    assert.deepEqual(lost.map(brief), [], "C13: every suggestion a call was told it made is stored pending on v1");
  });
}

/** C13's judge (S7): the author holds at most twenty pending suggestions on v1. */
function c13Judge(ctx, ref) {
  const r = observation(ctx, ref, "result");
  ctx.step(`pending on v1: ${r.pending} (limit ${LIMIT}); ${r.made} of ${r.n} racing call(s) made a suggestion at ${PREFILL} pending`);
  assert.ok(r.pending <= LIMIT, `C13 pending ≤ ${LIMIT}: the author holds ${r.pending} pending suggestions on v1, ${r.pending - LIMIT} past the limit: ${r.made} of ${r.n} calls racing for the last slot each made one`);
}

scenario("C13 SYNC-T: N agents of one author at nineteen pending suggestions call suggest_edit at one instant; every answer is a suggestion made on v1 or the twenty-pending refusal, at least one is made, and each made is stored", {
  tiers: BOTH,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, (ctx) => c13Work(ctx, "C13", "sync-t"));

scenario("C13 judge (SYNC-T): the author holds at most twenty pending suggestions on the version", {
  tiers: BOTH,
  n: N,
  defect: "S7",
  timeoutMs: JUDGE_MS,
}, async (ctx) => c13Judge(ctx, "C13"));

scenario("C13 gated: N suggest_edit calls of one author at nineteen pending, each held after its pending count and released together; every answer is a suggestion made on v1 or the twenty-pending refusal, at least one is made, and each made is stored", {
  tiers: LOCAL,
  needs: AMPLIFY,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, (ctx) => c13Work(ctx, "C13 gated", "gated"));

scenario("C13 judge (gated): the author holds at most twenty pending suggestions on the version", {
  tiers: LOCAL,
  needs: AMPLIFY,
  n: N,
  defect: "S7",
  timeoutMs: JUDGE_MS,
}, async (ctx) => c13Judge(ctx, "C13 gated"));

scenario("C13-serial: the same N suggest_edit calls one after another; the first makes the twentieth suggestion, every later one is refused with the twenty-pending message, and the author holds exactly twenty", {
  tiers: BOTH,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c13Stage(ctx, "C13 serial");
  const answers = [];
  for (const c of c13Calls(s)) {
    const out = await c.agent.mcp.call(c.name, c.args);
    const a = { who: c.who, what: c.name, status: 200, isError: out.isError, text: out.text, json: out.json ?? null };
    answers.push(a);
    ctx.step(brief(a));
  }
  const settled = await settleStill(() => pendingOf(s.docId, s.uid), { what: "C13-serial pending suggestions", step: stepOf(ctx) });
  record(ctx, { ref: "C13-serial", pending: settled.pending, made: answers.filter((a) => madeOn(a, "v1")).length });
  assert.ok(madeOn(answers[0], "v1"), `C13-serial: the first call takes the twentieth slot (${brief(answers[0])})`);
  const notRefused = answers.slice(1).filter((a) => !(a.isError && LIMIT_RE.test(a.text)));
  assert.deepEqual(notRefused.map(brief), [], "C13-serial: every later call is refused with the twenty-pending message");
  assert.equal(settled.pending, LIMIT, `C13-serial: the author holds exactly ${LIMIT} pending suggestions on v1`);
});

// =====================================================================================================
// C14 — comments and suggestions racing a publish
// =====================================================================================================

/**
 * The owner (with a saved draft unless `draft: false`), N feedback agents and
 * one publisher agent, all of the owner's person; with `web`, the owner's
 * browser too (its tabs write through the rules).
 */
async function c14Stage(ctx, label, { draft = true, web = false } = {}) {
  const d = await ownerDoc(ctx, label, { draft });
  const agents = await agentsOf(ctx, d.owner, ctx.n + 1, "c14");
  const s = { ...d, feedback: agents.slice(0, ctx.n), publisher: { ...agents[ctx.n], name: "publisher" } };
  if (web) s.web = await webOf(ctx, s.owner, "owner-firestore");
  ctx.step(`${ctx.n} feedback agent(s) (${s.feedback.map((a) => a.name).join(", ")}) and a publisher agent, each on its own MCP token${web ? "; the owner's browser writes through the rules" : ""}`);
  return s;
}

const commentArgs = (s, k, who) => ({ id: s.docId, exact: exactOf(k), body: `C14 ${s.tag}: ${who} on paragraph ${k}` });
const suggestArgs = (s, k, who) => ({ id: s.docId, exact: exactOf(k), replacement: `Paragraph ${k} (${s.tag} ${who}).` });
/** update_document of v1 with p#e2e-40 changed. */
const updateArgs = (s) => ({ id: s.docId, content: withP40(`update ${s.tag}`), baseVersion: "v1" });

/**
 * The document's current version and every thread on every version:
 * {current, versions, hasDraft, threads: [{version, annId, kind, channel,
 * resolved, state, open}]}. `open`: a comment thread not resolved, a
 * suggestion still pending.
 */
async function feedbackState(docId) {
  const meta = await readDoc(target, `docs/${docId}`);
  const versions = (await readCollection(target, `docs/${docId}/versions`)).map((v) => v.id).sort();
  const threads = [];
  for (const v of versions) {
    for (const a of await readCollection(target, `docs/${docId}/versions/${v}/annotations`)) {
      const kind = a.data.suggestion ? "suggestion" : "comment";
      const state = a.data.suggestion?.state ?? null;
      const resolved = a.data.resolved === true;
      threads.push({ version: v, annId: a.id, kind, channel: a.data.actor?.channel ?? null, resolved, state, open: kind === "suggestion" ? state === "pending" : !resolved });
    }
  }
  threads.sort((x, y) => (x.version + x.annId < y.version + y.annId ? -1 : 1));
  return { current: meta?.currentVersion ?? null, versions, hasDraft: Boolean(meta?.draft), threads };
}

const AGENT_COMMENT = (t) => t.kind === "comment" && t.channel === "mcp";
const WEB_THREAD = (t) => t.kind === "comment" && t.channel === "web";
const SUGGESTION = (t) => t.kind === "suggestion";
const threadLabel = (t) => `${t.kind} ${t.annId} on ${t.version} (${t.channel ?? "no channel"})`;
const stateLine = (state) => `current ${state.current}; threads: ${state.threads.map((t) => `${t.kind[0]}${t.channel === "web" ? "w" : ""}:${t.version}${t.open ? "" : "(closed)"}`).join(" ") || "none"}`;

/**
 * The oracle every C14 case shares: once a version is current, nothing open
 * (`pick` of them) is left on an older one (SPEC §6a, §19, §22).
 */
function assertNoneLeftBehind(state, { pick = () => true, what = null } = {}) {
  const left = state.threads.filter((t) => t.version !== state.current && t.open && pick(t));
  assert.deepEqual(
    left.map(threadLabel),
    [],
    `C14 left behind: ${left.length} unresolved thread(s) on a version that is no longer current (${state.current} is): ${left.map(threadLabel).join(", ")}${what ? ` [${what}]` : ""}`,
  );
}

/** Every thread a call was told it opened is stored on the version it was told. */
function assertWhereTold(state, answers) {
  const at = new Map(state.threads.map((t) => [t.annId, t.version]));
  const wrong = answers.filter((a) => !a.isError && typeof a.json?.threadId === "string" && at.get(a.json.threadId) !== a.json.version);
  assert.deepEqual(wrong.map((a) => `${brief(a)} → stored on ${at.get(a.json.threadId) ?? "no version"}`), [], "C14: every thread an agent was told it opened is stored on the version it was told");
}

/**
 * A feedback answer in a race with a publish. Made on v1 is always possible.
 * Only once the publish made v2 current may a call have read v2 (made on v2)
 * or been refused for the newer version; with v1 still current, such a
 * refusal names a version that does not exist. A web thread is written where
 * its tab says (v1), or refused by the rules.
 */
function feedbackAnswerOk(a, published) {
  if (madeOn(a, "v1")) return true;
  if (a.what === "web thread") return a.isError && DENIED_RE.test(a.text);
  if (!published) return false;
  if (madeOn(a, "v2")) return true;
  return a.isError && (a.what === "add_comment" ? COMMENT_NEWER_RE : NEWER_RE).test(a.text);
}

const commitOk = (a) => !a.isError && typeof a.json?.versionId === "string" && a.json?.deduped !== true;
const commitHeldBack = (a) => a.isError && (OPEN_RE.test(a.text) || PENDING_RE.test(a.text));
/** POST /publish?update= → fireAtOnce's shape: made {versionId, deduped}, or refused with its error. */
const uploadAnswer = (r) => ({ who: "owner", what: "POST /publish?update=", status: r.status, isError: r.status !== 200, text: r.status === 200 ? "published" : String(r.json?.error ?? r.status), json: r.json ?? null });
const landedBy = (state) => Object.fromEntries(state.versions.map((v) => [v, state.threads.filter((t) => t.version === v).map((t) => `${t.kind[0]}${t.channel === "web" ? "w" : ""}${t.open ? "" : "x"}`).join("")]));

/** C14 SYNC-T against commitDraft: the work (its judges read it). */
async function c14SyncWork(ctx) {
  await working(ctx, "C14 SYNC-T", async (obs) => {
    const s = await c14Stage(ctx, "C14 race", { web: true });
    obs.stage = "staged";
    const calls = numbered([
      ...s.feedback.map((a, i) => (i % 2 === 0 ? tool(a, "add_comment", commentArgs(s, i + 1, a.name)) : tool(a, "suggest_edit", suggestArgs(s, i + 1, a.name)))),
      ...s.feedback.map((a, i) => webThreadCall(`${a.name}-tab`, s.web, s.owner.account, { docId: s.docId, versionId: "v1", k: WEB_FROM + i + 1 })),
      tool(s.publisher, "commit_draft", { id: s.docId }),
    ]);
    const fired = await fireAtOnce(ctx, calls, "feedback and commit");
    obs.stage = "fired";
    const feedback = fired.answers.slice(0, 2 * ctx.n);
    const commit = fired.answers[2 * ctx.n];
    const state = await settleStill(() => feedbackState(s.docId), { what: "C14 threads and versions", step: stepOf(ctx) });
    ctx.ev.json("state", state);
    const published = commitOk(commit);
    obs.state = { state, answers: feedback, commit, published };
    obs.stage = "measured";
    ctx.step(`commit: ${brief(commit)}; ${stateLine(state)}`);
    record(ctx, { ref: "C14 SYNC-T", race: fired.race, commit: published ? commit.json.versionId : "refused", landed: landedBy(state) });
    const odd = feedback.filter((a) => !feedbackAnswerOk(a, published));
    assert.deepEqual(
      odd.map(brief),
      [],
      published
        ? "C14: every comment, suggestion and web thread was made (on v1 or v2) or refused for the newer version"
        : "C14: the commit published nothing, so every comment, suggestion and web thread was made on v1 (a refusal for a newer version that does not exist is false)",
    );
    assertWhereTold(state, feedback);
    assert.ok(published || commitHeldBack(commit), `C14: the commit published or was held back by open feedback (${brief(commit)})`);
    if (published) assert.equal(state.current, commit.json.versionId, "C14: the published version is current");
    else {
      assert.equal(state.current, "v1", "C14: a refused commit leaves v1 current");
      assert.ok(state.threads.some((t) => t.version === "v1" && t.open), "C14: a commit refused for open feedback had open feedback on v1 to see");
    }
    assertNoneLeftBehind(state, { pick: SUGGESTION, what: "suggestions, SPEC §22: never left behind on a version nobody reads" });
  });
}

/** A C14 SYNC-T judge: INCONCLUSIVE unless the commit made v2 current (nothing could be left behind otherwise). */
function c14SyncJudge(ctx, pick, what) {
  const { state, published, commit } = observation(ctx, "C14 SYNC-T", "state");
  ctx.step(`commit: ${brief(commit)}; ${stateLine(state)}`);
  if (!published) ctx.inconclusive(`the commit was refused (${String(commit.text).slice(0, 120)}): feedback reached v1 first, so no version replaced v1 in this race and nothing could be left behind on it`);
  assertNoneLeftBehind(state, { pick, what });
}

scenario("C14 SYNC-T: N agents' comments and suggestions (in turn), N threads opened in the browser and the owner's agent's commit_draft fired at one instant; every answer is a thread made on v1, or, once the commit published, on v2 or a refusal for the newer version; each is where it was told, the commit is refused exactly when feedback reached v1 first, and no suggestion is left behind", {
  tiers: BOTH,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, c14SyncWork);

scenario("C14 judge (SYNC-T, agent comments): when the commit published, no thread an add_comment opened in the race is left unresolved on the version it replaced", {
  tiers: BOTH,
  n: N,
  defect: "S12",
  timeoutMs: JUDGE_MS,
}, async (ctx) => c14SyncJudge(ctx, AGENT_COMMENT, "add_comment threads (S12)"));

scenario("C14 judge (SYNC-T, web threads): when the commit published, no thread opened in the browser in the race is left unresolved on the version it replaced", {
  tiers: BOTH,
  n: N,
  defect: "X-c13-feedback-1",
  timeoutMs: JUDGE_MS,
}, async (ctx) => c14SyncJudge(ctx, WEB_THREAD, "web threads (X-c13-feedback-1)"));

/** C14 comment held: the work (S12's judge reads it). */
async function c14CommentHeldWork(ctx) {
  await working(ctx, "C14 comment held", async (obs) => {
    const s = await c14Stage(ctx, "C14 comment held");
    obs.stage = "staged";
    const calls = s.feedback.map((a, i) => tool(a, "add_comment", commentArgs(s, i + 1, a.name)));
    let commit = null;
    const fired = await holdAndRun(ctx, {
      gate: COMMENT_GATE,
      docId: s.docId,
      calls,
      whileHeld: async () => {
        ctx.step(`while every add_comment is held past its read of v1, the publisher's commit_draft runs`);
        const out = await s.publisher.mcp.call("commit_draft", { id: s.docId });
        commit = { who: "publisher", what: "commit_draft", status: 200, isError: out.isError, text: out.text, json: out.json ?? null };
        ctx.step(`commit: ${brief(commit)}`);
        return commit;
      },
    });
    obs.stage = "fired";
    ctx.ev.json("answers", fired.answers.map(brief));
    ctx.step(`add_comment answers: ${fired.answers.map(brief).join("; ")}`);
    const state = await settleStill(() => feedbackState(s.docId), { what: "C14 threads and versions", step: stepOf(ctx) });
    ctx.ev.json("state", state);
    obs.state = { state, answers: fired.answers };
    obs.stage = "measured";
    record(ctx, { ref: "C14 comment held", race: fired.race, commit: commitOk(commit) ? commit.json.versionId : "refused", current: state.current, onV1: state.threads.filter((t) => t.version === "v1" && t.open).length });
    assert.ok(commitOk(commit), `C14 comment held: with nothing open on v1, the commit publishes (${brief(commit)})`);
    const odd = fired.answers.filter((a) => !(madeOn(a, "v1") || madeOn(a, "v2") || (a.isError && COMMENT_NEWER_RE.test(a.text))));
    assert.deepEqual(odd.map(brief), [], "C14 comment held: every add_comment answered a thread, or a refusal for the newer version");
    assertWhereTold(state, fired.answers);
  });
}

scenario("C14 comment held: N add_comment calls held after reading v1 and finding their passage, while the owner's agent's commit_draft publishes v2, then released; the commit publishes and every call answers", {
  tiers: LOCAL,
  needs: AMPLIFY,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, c14CommentHeldWork);

scenario("C14 judge (comment held): no thread an add_comment opened is left unresolved on the version the commit replaced", {
  tiers: LOCAL,
  needs: AMPLIFY,
  n: N,
  defect: "S12",
  timeoutMs: JUDGE_MS,
}, async (ctx) => {
  const { state, answers } = observation(ctx, "C14 comment held", "state");
  ctx.step(`current ${state.current}; add_comment told: ${answers.map((a) => (a.isError ? "refused" : a.json?.version)).join(", ")}`);
  assertNoneLeftBehind(state);
});

scenario("C14 suggestion held: N suggest_edit calls held after their pending count, while the owner's agent's commit_draft publishes v2, then released; each is refused for the newer version and none is left pending on v1", {
  tiers: LOCAL,
  needs: AMPLIFY,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c14Stage(ctx, "C14 suggestion held");
  const calls = s.feedback.map((a, i) => tool(a, "suggest_edit", suggestArgs(s, i + 1, a.name)));
  let commit = null;
  const fired = await holdAndRun(ctx, {
    gate: SUGGEST_GATE,
    docId: s.docId,
    calls,
    whileHeld: async () => {
      const out = await s.publisher.mcp.call("commit_draft", { id: s.docId });
      commit = { who: "publisher", what: "commit_draft", status: 200, isError: out.isError, text: out.text, json: out.json ?? null };
      ctx.step(`while every suggest_edit is held, commit: ${brief(commit)}`);
      return commit;
    },
  });
  ctx.step(`suggest_edit answers: ${fired.answers.map(brief).join("; ")}`);
  const state = await settleStill(() => feedbackState(s.docId), { what: "C14 threads and versions", step: stepOf(ctx) });
  ctx.ev.json("state", state);
  record(ctx, { ref: "C14 suggestion held", race: fired.race, commit: commitOk(commit) ? commit.json.versionId : "refused", current: state.current, onV1: state.threads.filter((t) => t.version === "v1" && t.open).length });
  assertNoneLeftBehind(state);
  assert.ok(commitOk(commit), `C14 suggestion held: with nothing pending on v1, the commit publishes (${brief(commit)})`);
  const notRefused = fired.answers.filter((a) => !(a.isError && NEWER_RE.test(a.text)));
  assert.deepEqual(notRefused.map(brief), [], "C14 suggestion held: every suggestion counted on v1 and written after v2 was current is refused for the newer version (SPEC §22)");
});

/** C14's commit held at commit-before-tx while `land()` opens threads on v1; released, the transaction must refuse it. */
async function c14CommitHeld(ctx, { label, web, land }) {
  const s = await c14Stage(ctx, label, { web });
  let landed = null;
  const fired = await holdAndRun(ctx, {
    gate: COMMIT_GATE,
    docId: s.docId,
    calls: [tool(s.publisher, "commit_draft", { id: s.docId })],
    whileHeld: async () => {
      landed = await land(s);
      ctx.step(`while the commit is held past its check and upload: ${landed.map(brief).join("; ")}`);
      return landed;
    },
  });
  const commit = fired.answers[0];
  ctx.step(`commit, released: ${brief(commit)}`);
  const state = await settleStill(() => feedbackState(s.docId), { what: "C14 threads and versions", step: stepOf(ctx) });
  ctx.ev.json("state", state);
  record(ctx, { ref: label, race: fired.race, commit: commitOk(commit) ? commit.json.versionId : "refused", current: state.current, onV1: state.threads.filter((t) => t.version === "v1" && t.open).length });
  assertNoneLeftBehind(state);
  const notMade = landed.filter((a) => !madeOn(a, "v1"));
  assert.deepEqual(notMade.map(brief), [], `${label}: every thread opened while the commit was held is a thread on v1`);
  assert.ok(commit.isError && OPEN_RE.test(commit.text), `${label}: the commit's transaction sees the threads opened during its upload and refuses: "Resolve all comments before publishing a new version." (${brief(commit)})`);
  assert.equal(state.current, "v1", `${label}: v1 is still current`);
  assert.ok(state.hasDraft, `${label}: the refused commit leaves the draft`);
  assertWhereTold(state, landed);
}

scenario("C14 commit held: the owner's agent's commit_draft held after its open-thread check and upload while N agents' comments land on v1, then released; its transaction refuses it for the open comments and nothing is left behind", {
  tiers: LOCAL,
  needs: AMPLIFY,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, (ctx) =>
  c14CommitHeld(ctx, {
    label: "C14 commit held",
    web: false,
    land: async (s) => {
      ctx.step(`${ctx.n} agent(s) comment on v1`);
      const outs = await Promise.all(s.feedback.map((a, i) => a.mcp.call("add_comment", commentArgs(s, i + 1, a.name))));
      return outs.map((out, i) => ({ who: s.feedback[i].name, what: "add_comment", status: 200, isError: out.isError, text: out.text, json: out.json ?? null }));
    },
  }));

scenario("C14 commit held, web threads: the owner's agent's commit_draft held after its open-thread check and upload while N threads are opened on v1 in the browser (through the rules), then released; its transaction refuses it for the open threads and nothing is left behind", {
  tiers: LOCAL,
  needs: AMPLIFY,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, (ctx) =>
  c14CommitHeld(ctx, {
    label: "C14 commit held, web threads",
    web: true,
    land: async (s) => {
      ctx.step(`${ctx.n} tab(s) of the owner open a thread on v1, as the app's createAnnotation and addComment write them`);
      return webThreads(ctx, s, "v1", "while the commit is held");
    },
  }));

/** C14 stale tab: the work (X-c13-feedback-1's judge reads it). */
async function c14StaleTabWork(ctx) {
  await working(ctx, "C14 stale tab", async (obs) => {
    const s = await c14Stage(ctx, "C14 stale tab", { web: true });
    obs.stage = "staged";
    const commit = answerOf({ who: "publisher", name: "commit_draft" }, await s.publisher.mcp.call("commit_draft", { id: s.docId }));
    ctx.step(`commit: ${brief(commit)}`);
    precondition(commitOk(commit) && commit.json.versionId === "v2", `with nothing open on v1, the owner's agent's commit_draft publishes v2 (${brief(commit)})`);
    ctx.step(`v2 is current; ${ctx.n} tab(s) of the owner that still show v1 each open a thread on it, as the app's createAnnotation and addComment write them (through the rules)`);
    const threads = await webThreads(ctx, s, "v1", "a tab still showing v1");
    obs.stage = "fired";
    ctx.step(`web threads: ${threads.map(brief).join("; ")}`);
    const state = await settleStill(() => feedbackState(s.docId), { what: "C14 threads and versions", step: stepOf(ctx) });
    ctx.ev.json("state", state);
    obs.state = { state, answers: threads };
    obs.stage = "measured";
    record(ctx, { ref: "C14 stale tab", current: state.current, landed: landedBy(state), refused: threads.filter((a) => a.isError).length });
    const odd = threads.filter((a) => !(madeOn(a, "v1") || (a.isError && DENIED_RE.test(a.text))));
    assert.deepEqual(odd.map(brief), [], "C14 stale tab: every web thread was written on the version its tab showed (v1), or refused by the rules");
    assert.equal(state.current, "v2", "C14 stale tab: v2 is current");
    assertWhereTold(state, threads);
  });
}

scenario("C14 stale tab: v2 is published, then N browser tabs that still show v1 each open a thread on v1 through the rules; every write is made on v1 or refused, and v2 stays current", {
  tiers: BOTH,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, c14StaleTabWork);

scenario("C14 judge (stale tab): no thread a tab opened is left unresolved on the version the commit replaced", {
  tiers: BOTH,
  n: N,
  defect: "X-c13-feedback-1",
  timeoutMs: JUDGE_MS,
}, async (ctx) => {
  const { state, answers } = observation(ctx, "C14 stale tab", "state");
  ctx.step(`${stateLine(state)}; the tabs were told: ${answers.map((a) => (a.isError ? "refused" : a.json?.version)).join(", ")}`);
  assertNoneLeftBehind(state, { pick: WEB_THREAD, what: "web threads opened on a replaced version (X-c13-feedback-1)" });
});

// --- C14 against the update mint path (reviseDocument) ------------------------------------------

scenario("C14 update SYNC-T: N agents' suggestions and the owner's agent's update_document fired at one instant; every suggestion is made on v1, or, once the update published, on v2 or refused for the newer version; the update publishes or is held back by the pending ones, and none is left behind", {
  tiers: BOTH,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c14Stage(ctx, "C14 update race", { draft: false });
  const calls = numbered([...s.feedback.map((a, i) => tool(a, "suggest_edit", suggestArgs(s, i + 1, a.name))), tool(s.publisher, "update_document", updateArgs(s))]);
  const fired = await fireAtOnce(ctx, calls, "suggestions and update");
  const feedback = fired.answers.slice(0, ctx.n);
  const update = fired.answers[ctx.n];
  const state = await settleStill(() => feedbackState(s.docId), { what: "C14 threads and versions", step: stepOf(ctx) });
  ctx.ev.json("state", state);
  const published = commitOk(update);
  ctx.step(`update: ${brief(update)}; ${stateLine(state)}`);
  record(ctx, { ref: "C14 update SYNC-T", race: fired.race, update: published ? update.json.versionId : "refused", landed: landedBy(state) });
  const odd = feedback.filter((a) => !feedbackAnswerOk(a, published));
  assert.deepEqual(odd.map(brief), [], published ? "C14 update: every suggestion was made (on v1 or v2) or refused for the newer version" : "C14 update: the update published nothing, so every suggestion was made on v1 (a refusal for a newer version that does not exist is false)");
  assertWhereTold(state, feedback);
  assert.ok(published || (update.isError && PENDING_RE.test(update.text)), `C14 update: update_document published or was held back by the pending suggestions (${brief(update)})`);
  if (published) assert.equal(state.current, update.json.versionId, "C14 update: the published version is current");
  else {
    assert.equal(state.current, "v1", "C14 update: a refused update leaves v1 current");
    assert.ok(state.threads.some((t) => t.version === "v1" && t.open && t.kind === "suggestion"), "C14 update: an update refused for pending suggestions had one pending on v1 to see");
  }
  assertNoneLeftBehind(state, { what: "SPEC §6a: no version is minted while a suggestion on the current one is pending, update_document alike" });
});

scenario("C14 suggestion held, update_document: N suggest_edit calls held after their pending count while the owner's agent's update_document mints v2, then released; each is refused for the newer version and none is left pending on v1", {
  tiers: LOCAL,
  needs: AMPLIFY,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c14Stage(ctx, "C14 suggestion held update", { draft: false });
  const calls = s.feedback.map((a, i) => tool(a, "suggest_edit", suggestArgs(s, i + 1, a.name)));
  let update = null;
  const fired = await holdAndRun(ctx, {
    gate: SUGGEST_GATE,
    docId: s.docId,
    calls,
    whileHeld: async () => {
      update = answerOf({ who: "publisher", name: "update_document" }, await s.publisher.mcp.call("update_document", updateArgs(s)));
      ctx.step(`while every suggest_edit is held, update_document: ${brief(update)}`);
      return update;
    },
  });
  ctx.step(`suggest_edit answers: ${fired.answers.map(brief).join("; ")}`);
  const state = await settleStill(() => feedbackState(s.docId), { what: "C14 threads and versions", step: stepOf(ctx) });
  ctx.ev.json("state", state);
  record(ctx, { ref: "C14 suggestion held, update_document", race: fired.race, update: commitOk(update) ? update.json.versionId : "refused", current: state.current, onV1: state.threads.filter((t) => t.version === "v1" && t.open).length });
  assertNoneLeftBehind(state);
  assert.ok(commitOk(update) && update.json.versionId === "v2", `C14 suggestion held, update_document: with nothing pending on v1, update_document mints v2 (${brief(update)})`);
  assert.equal(state.current, "v2", "C14 suggestion held, update_document: v2 is current");
  const notRefused = fired.answers.filter((a) => !(a.isError && NEWER_RE.test(a.text)));
  assert.deepEqual(notRefused.map(brief), [], "C14 suggestion held, update_document: every suggestion counted on v1 and written after v2 was current is refused for the newer version (SPEC §22)");
});

scenario("C14 update held: the owner's upload of a new version (POST /publish?update=) held between its upload and its transaction while N agents' suggestions land on v1, then released; its transaction refuses it for the pending suggestions, v1 stays current and nothing is left behind", {
  tiers: LOCAL,
  needs: AMPLIFY_UPDATE,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c14Stage(ctx, "C14 update held", { draft: false });
  let suggestions = null;
  const fired = await holdAndRun(ctx, {
    gate: UPDATE_GATE,
    docId: s.docId,
    send: () => [updateUpload(s.owner.http, s.docId, { body: withP40(`upload ${s.tag}`), baseVersion: "v1", timeoutMs: FN_MS }).then(uploadAnswer)],
    whileHeld: async () => {
      ctx.step(`while the upload is held past its checks and the upload of v2/, ${ctx.n} agent(s) suggest edits on v1`);
      const outs = await Promise.all(s.feedback.map((a, i) => a.mcp.call("suggest_edit", suggestArgs(s, i + 1, a.name))));
      suggestions = outs.map((out, i) => answerOf({ who: s.feedback[i].name, name: "suggest_edit" }, out));
      ctx.step(`suggestions: ${suggestions.map(brief).join("; ")}`);
      return suggestions;
    },
  });
  const upload = fired.answers[0];
  ctx.step(`upload, released: ${brief(upload)}`);
  const state = await settleStill(() => feedbackState(s.docId), { what: "C14 threads and versions", step: stepOf(ctx) });
  ctx.ev.json("state", state);
  record(ctx, { ref: "C14 update held", race: fired.race, upload: upload.status, current: state.current, versions: state.versions, onV1: state.threads.filter((t) => t.version === "v1" && t.open).length });
  assertNoneLeftBehind(state, { what: "SPEC §22: the hold is asked again inside the transaction that makes a version current" });
  const notMade = suggestions.filter((a) => !madeOn(a, "v1"));
  assert.deepEqual(notMade.map(brief), [], "C14 update held: every suggestion made while the upload was held is pending on v1");
  assert.ok(upload.status === 409 && PENDING_RE.test(upload.text) && upload.json?.pendingSuggestions === ctx.n, `C14 update held: the upload's transaction sees the ${ctx.n} suggestion(s) made during its upload and refuses with 409 { error, pendingSuggestions: ${ctx.n} } (${brief(upload)})`);
  assert.equal(state.current, "v1", "C14 update held: v1 is still current");
  assert.deepEqual(state.versions, ["v1"], "C14 update held: no version record was minted");
  assertWhereTold(state, suggestions);
});

scenario("C14-serial: the same comments and commit one after another — N agents' comments and N web threads on v1, then the commit (refused); each resolved, then the commit (v2); then N comments and N web threads on the version the document names (v2) — leave nothing behind", {
  tiers: BOTH,
  n: N,
  timeoutMs: CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const s = await c14Stage(ctx, "C14 serial", { web: true });
  const call = async (a, name, args) => {
    const out = await a.mcp.call(name, args);
    const r = { who: a.name, what: name, status: 200, isError: out.isError, text: out.text, json: out.json ?? null };
    ctx.step(brief(r));
    return r;
  };
  /** One tab at a time, on the version the document names now (what the app's live listener shows). */
  const webSerial = async (label) => {
    const out = [];
    for (const [i, a] of s.feedback.entries()) {
      const shown = (await readDoc(target, `docs/${s.docId}`))?.currentVersion;
      const who = `${a.name}-tab`;
      const r = await webThread(s.web.fs, s.owner.account, { docId: s.docId, versionId: shown, anchor: anchorOf(WEB_FROM + i + 1), body: `C14 ${s.tag}: ${label}, ${who}` });
      const ans = { who, what: "web thread", status: 200, isError: false, text: "committed", json: { threadId: r.annId, version: shown } };
      ctx.step(brief(ans));
      out.push(ans);
    }
    return out;
  };
  const first = [];
  for (const [i, a] of s.feedback.entries()) first.push(await call(a, "add_comment", commentArgs(s, i + 1, a.name)));
  const firstWeb = await webSerial("before the commit");
  const refused = await call(s.publisher, "commit_draft", { id: s.docId });
  for (const [i, a] of s.feedback.entries()) if (madeOn(first[i], "v1")) await call(a, "resolve_thread", { id: s.docId, threadId: first[i].json.threadId });
  for (const w of firstWeb) {
    await webResolve(s.web.fs, s.owner.account, { docId: s.docId, versionId: "v1", annId: w.json.threadId });
    ctx.step(`${w.who} resolves its thread as the app's setResolved does`);
  }
  const published = await call(s.publisher, "commit_draft", { id: s.docId });
  const later = [];
  for (const [i, a] of s.feedback.entries()) later.push(await call(a, "add_comment", commentArgs(s, i + 1, a.name)));
  const laterWeb = await webSerial("after the commit");
  const state = await settleStill(() => feedbackState(s.docId), { what: "C14-serial threads and versions", step: stepOf(ctx) });
  ctx.ev.json("state", state);
  record(ctx, { ref: "C14-serial", current: state.current, landed: landedBy(state), onV1: state.threads.filter((t) => t.version === "v1" && t.open).length });
  assertNoneLeftBehind(state);
  assert.deepEqual([...first, ...firstWeb].filter((a) => !madeOn(a, "v1")).map(brief), [], "C14-serial: the comments and web threads before the commit are threads on v1");
  assert.ok(refused.isError && OPEN_RE.test(refused.text), `C14-serial: a commit with threads open on v1 is refused (${brief(refused)})`);
  assert.ok(commitOk(published) && published.json.versionId === "v2", `C14-serial: once they are resolved the commit publishes v2 (${brief(published)})`);
  assert.deepEqual([...later, ...laterWeb].filter((a) => !madeOn(a, "v2")).map(brief), [], "C14-serial: the comments and web threads after the commit are threads on v2");
  assert.equal(state.current, "v2", "C14-serial: v2 is current");
  assertWhereTold(state, [...first, ...firstWeb, ...later, ...laterWeb]);
});

// =====================================================================================================
// C15 — a feedback storm with a get_changes poller
// =====================================================================================================

/**
 * A raw Firestore REST commit of one reply, as the app's addComment writes it
 * (setDoc, createdAt the server's time), for syncHttp: through the rules,
 * as `acct`, with its ID token, traced as `<who>-firestore`. ABORTED is sent
 * again with the same id, as the SDK does, so it lands once.
 */
function webReplyCall(who, fs, acct, token, { docId, annId, body }) {
  const commentId = autoId();
  const path = commentPath(docId, "v1", annId, commentId);
  const data = commentData(acct, { commentId, body });
  const write = { update: { name: `${fs.root}/${path}`, fields: toFields(data) }, updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }] };
  return {
    who,
    what: "web reply",
    commentId,
    request: { url: `${fs.base}:commit`, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ writes: [write] }), warm: `${firestoreOrigin(target)}/`, actor: `${who}-firestore` },
    parse: (row) => firestoreAnswer(row, { commentId }),
    retry: async () => {
      await webReply(fs, acct, { docId, versionId: "v1", annId, body, commentId });
      return { isError: false, text: "committed on retry (ABORTED once)", json: { commentId }, code: null };
    },
  };
}

/** T0's generated flip notes and its resolved state. */
async function flipNotesOf(docId, annId) {
  const comments = await readCollection(target, `docs/${docId}/versions/v1/annotations/${annId}/comments`);
  const notes = comments.filter((c) => c.data.generated === true && /^(Resolved|Reopened)\.$/.test(String(c.data.body)));
  const human = comments.filter((c) => c.data.generated !== true);
  const ann = await readDoc(target, `docs/${docId}/versions/v1/annotations/${annId}`);
  return { notes: notes.length, human: human.length, resolved: ann?.resolved === true };
}

/** A stored row that is a real flip of `annId` (thread.resolved or thread.reopened). */
const isFlipOn = (annId) => (r) => r.data.threadId === annId && (r.data.type === "thread.resolved" || r.data.type === "thread.reopened");
const flipType = (r) => String(r.data.type).split(".")[1];

/**
 * T0's flip events in the stored log since the poller's first cursor, settled
 * (lib/assert.mjs settleStill): READY once there are as many as T0 has flip
 * notes (written in the flip's own transaction, so already all there), then
 * still for 10 s. Until it is ready every read is a value of its own, so the
 * quiet window never starts. Running out of LOG_MS while they are apart
 * returns `waitedOut` (the round's assertions and I10 judge them), unless the
 * emulator killed a function meanwhile (then INCONCLUSIVE).
 */
async function settleFlips(ctx, docId, cursor0, t0, label) {
  let reads = 0;
  const read = async () => {
    reads += 1;
    const rows = (await logAfter(ctx.target, docId, cursor0)).filter(isFlipOn(t0));
    const t = await flipNotesOf(docId, t0);
    return { rows, notes: t.notes, resolved: t.resolved, ready: rows.length === t.notes, read: reads };
  };
  const key = (v) => (v.ready ? JSON.stringify([v.rows.map((r) => r.id), v.notes, v.resolved]) : `not ready at read ${v.read}: ${v.rows.length} flip event(s) on T0 for ${v.notes} note(s)`);
  try {
    const v = await settleStill(read, { what: `C15: T0's flip events after ${label}`, key, deadlineMs: LOG_MS, step: stepOf(ctx) });
    return { ...v, waitedOut: false };
  } catch (err) {
    const last = err?.code === "E2E_SETTLE_TIMEOUT" ? err.value : null;
    if (!last || last.ready) throw err;
    const kill = functionKill(err, ctx);
    if (kill) ctx.inconclusive(`the stack did not answer, so nothing was measured: ${kill}`);
    ctx.step(`after ${LOG_MS / 1000} s T0 has ${last.rows.length} flip event(s) for ${last.notes} note(s) (${label}); the round and I10 judge them`);
    return { ...last, waitedOut: true };
  }
}

/**
 * The three flip rounds on T0. The tools answer the state they were asked for
 * (threads.ts:44, :58), so each answer is checked against the request and the
 * round against what is STORED: T0's state through the Admin SDK at once, and
 * the round's own flip events, settled before the next round fires so that
 * each round's events are the ones after the last round's.
 */
const FLIP_ROUNDS = Object.freeze([
  { label: "all resolve", resolve: () => true, state: true, says: "exactly one thread.resolved", want: (rows) => rows.length === 1 && rows[0].data.type === "thread.resolved" },
  { label: "all reopen", resolve: () => false, state: false, says: "exactly one thread.reopened", want: (rows) => rows.length === 1 && rows[0].data.type === "thread.reopened" },
  { label: "odd resolve, even reopen", resolve: (i) => i % 2 === 0, state: null, says: "at least one flip", want: (rows) => rows.length >= 1 },
]);

async function flipRounds(ctx, agents, docId, t0, cursor0) {
  const rounds = [];
  let before = { rows: 0, notes: 0 };
  let rows = [];
  for (const [k, r] of FLIP_ROUNDS.entries()) {
    const round = `round ${k + 1} (${r.label})`;
    const calls = numbered(agents.map((a, i) => tool(a, r.resolve(i) ? "resolve_thread" : "reopen_thread", { id: docId, threadId: t0 })));
    const fired = await fireAtOnce(ctx, calls, `flips: ${r.label}`);
    const bad = fired.answers.filter((a, i) => a.isError || a.json?.resolved !== r.resolve(i) || a.json?.threadId !== t0);
    assert.deepEqual(bad.map(brief), [], `C15: every ${r.label} call on T0 answered the state it asked for`);
    const now = await flipNotesOf(docId, t0);
    if (r.state !== null) assert.equal(now.resolved, r.state, `C15: after ${round} T0 is ${r.state ? "resolved" : "open"} in Firestore (stored resolved=${now.resolved}, ${now.notes - before.notes} note(s) written in the round), not only in the answers`);
    const f = await settleFlips(ctx, docId, cursor0, t0, round);
    const mine = f.rows.slice(before.rows);
    const notes = f.notes - before.notes;
    ctx.step(`${round}: ${mine.length} flip event(s) in the log (${mine.map(flipType).join(", ") || "none"}), ${notes} note(s), T0 resolved=${f.resolved}`);
    assert.ok(r.want(mine), `C15: ${round} records ${r.says} on T0 in the change log; it recorded ${mine.length} (${mine.map(flipType).join(", ") || "none"}), with ${notes} note(s)`);
    rounds.push({ round: k + 1, label: r.label, flips: mine.length, types: mine.map(flipType), notes, resolved: f.resolved, waitedOut: f.waitedOut, race: fired.race });
    before = { rows: f.rows.length, notes: f.notes };
    rows = f.rows;
  }
  const order = rows.map(flipType);
  const alternating = order.every((t, i) => t === (i % 2 === 0 ? "resolved" : "reopened"));
  assert.ok(alternating, `C15: T0's real flips alternate from open (resolved, reopened, resolved, …); the log holds ${order.join(", ")}`);
  return rounds;
}

/**
 * Wait for the storm's events in the stored log (lib/changes.mjs logAfter,
 * from the poller's first cursor) with lib/assert.mjs settleStill: READY
 * once each caused kind has at least its count and T0 has as many flip events
 * as flip notes (what I10 says they will be), or once a caused kind is past
 * its count (the log never shrinks: I15 judges it); then all of it still for
 * 10 s. Until it is ready every read is a value of its own, so the quiet
 * window never starts. Running out of LOG_MS is settleStill's wait ("…
 * within <ms> ms"), which the case's options judge, except when every caused
 * kind is in and only T0's flips and notes are apart: then it returns
 * `waitedOut` and I10 judges them, unless the emulator killed a function
 * meanwhile (then INCONCLUSIVE).
 */
async function settleStorm(ctx, docId, cursor0, t0, want) {
  let reads = 0;
  const read = async () => {
    reads += 1;
    const rows = await logAfter(ctx.target, docId, cursor0);
    const counts = logCounts(rows);
    const flips = rows.filter(isFlipOn(t0)).length;
    const { notes } = await flipNotesOf(docId, t0);
    const short = Object.entries(want).filter(([k, n]) => (counts[k] ?? 0) < n).map(([k, n]) => `${k} ${counts[k] ?? 0} of ${n}`);
    const over = Object.entries(want).filter(([k, n]) => (counts[k] ?? 0) > n).map(([k, n]) => `${k} ${counts[k]} of ${n}`);
    return { rows, counts, flips, notes, short, over, ready: over.length > 0 || (short.length === 0 && flips === notes), read: reads };
  };
  const key = (v) =>
    v.ready
      ? JSON.stringify([v.counts, v.flips, v.notes])
      : `not ready at read ${v.read}: ${v.short.length ? `short ${v.short.join(", ")}` : `${v.flips} flip event(s) on T0 for ${v.notes} note(s)`}; ${JSON.stringify(v.counts)}`;
  let v;
  try {
    v = await settleStill(read, { what: "C15: the storm's events in the change log", key, deadlineMs: LOG_MS, step: stepOf(ctx) });
  } catch (err) {
    const last = err?.code === "E2E_SETTLE_TIMEOUT" ? err.value : null;
    if (!last || last.ready || last.short.length || last.over.length) throw err;
    const kill = functionKill(err, ctx);
    if (kill) ctx.inconclusive(`the stack did not answer, so nothing was measured: ${kill}`);
    ctx.step(`after ${LOG_MS / 1000} s every caused event is in the log, and it holds ${last.flips} flip event(s) on T0 for ${last.notes} note(s); I10 judges them`);
    return { rows: last.rows, counts: last.counts, waitedOut: true };
  }
  ctx.step(`the storm's events in the log: ${JSON.stringify(v.counts)}; ${v.flips} flip event(s) on T0, ${v.notes} note(s)${v.over.length ? `; more than was caused (${v.over.join(", ")}): I15 judges it` : ""}`);
  return { rows: v.rows, counts: v.counts, waitedOut: false };
}

/**
 * The storm, both variants. `email`: notifications on, one POST /access
 * (invitations), I11 judged and recorded for the race judge. Without it:
 * every account with notifications off and each grant through the operator
 * script (scripts/set-access.mjs: no email, the production path), no I11.
 */
async function c15Storm(ctx, { ref, email }) {
  await working(ctx, ref, async (obs) => {
    const n = ctx.n;
    const tag = rand4();
    const names = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    ctx.step(`cast an owner and ${n} participant(s), fresh, email notifications ${email ? "on" : "off"}; sign each in`);
    const accts = await cast(target, ["owner", ...names.map((p) => `participant-${p}`)], { http: ctx.http({ actor: "harness" }), ...(email ? {} : { notifications: false }) });
    const sessions = await openSessions(target, accts, { batch: 5, timeoutMs: FN_MS, cutoffError: true });
    const owner = sessions[0];
    const parts = sessions.slice(1);
    const title = `${email ? "C15 storm" : "C15 zero-email storm"} ${tag} N=${n}`;
    const up = await publish(owner.http, { fixture: FIXTURE, title, name: "c15", timeoutMs: FN_MS });
    precondition(up.status === 200 && up.versionId === "v1", `POST /publish answered ${up.status} ${JSON.stringify(up.json)}`);
    const docId = up.docId;
    if (email) {
      const shared = await shareMany(target, { owner, doc: docId, grants: parts.map((p) => ({ account: p.account, role: "suggester" })), timeoutMs: FN_MS });
      precondition(shared.status === 200, `POST /access answered ${shared.status} ${JSON.stringify(shared.json)}`);
      ctx.step(`${docId} "${title}": the participants are suggesters (one invitation each)`);
    } else {
      const g = await grantEditors(ctx.target, { owner, doc: docId, accounts: parts.map((p) => p.account), role: "suggester", via: "operator", timeoutMs: FN_MS });
      const meta = await readDoc(target, `docs/${docId}`);
      const suggesters = (meta?.suggesters ?? []).map(lower);
      const ungranted = parts.filter((p) => !suggesters.includes(lower(p.account.email)));
      precondition(ungranted.length === 0, `scripts/set-access.mjs made every participant a suggester on ${docId} (missing: ${ungranted.map((p) => p.account.email).join(", ")})`);
      ctx.step(`${docId} "${title}": the participants are suggesters through the operator script (${g.requests} run(s), no email; the RTDB mirror ${g.missing.length ? `is missing for ${g.missing.length} (suspect S16, unused here: nobody edits live)` : "is there"})`);
    }
    const agents = [];
    for (const [i, p] of parts.entries()) {
      const { token } = await mintToken(p, { name: `c15 ${names[i]}`, channel: "mcp" });
      const actor = `c15-${names[i]}`;
      agents.push({ name: names[i], actor, token, session: p, mcp: ctx.mcp({ token, actor, timeoutMs: FN_MS, cutoffError: true }) });
    }
    const { token: pollerToken } = await mintToken(owner, { name: "c15 poller", channel: "mcp" });
    const poller = ctx.mcp({ token: pollerToken, actor: "c15-poller", timeoutMs: FN_MS, cutoffError: true });
    const ownerWeb = await webOf(ctx, owner, "owner-firestore");
    const partWeb = [];
    for (const [i, p] of parts.entries()) partWeb.push(await webOf(ctx, p, `${names[i]}-firestore`));
    obs.stage = "staged";

    ctx.step("the owner opens T0 on p#e2e-40 in the browser's way (Firestore, through the rules)");
    const t0 = (await webThread(ownerWeb.fs, owner.account, { docId, versionId: "v1", anchor: anchorOf(40), body: `C15 ${tag}: T0, what do you all think?` })).annId;
    // The setup's own events (the version, the grants, T0) are in the log, and hold still, before the
    // poller's cursor is taken. Until T0's two events and the version's are there, each read is a value
    // of its own, so settleStill's quiet window does not start.
    let setupReads = 0;
    await settleStill(
      async () => {
        setupReads += 1;
        const counts = logCounts(await changeLog(ctx.target, docId));
        return { counts, ready: (counts["thread.opened"] ?? 0) >= 1 && (counts["comment.added"] ?? 0) >= 1 && (counts["version.published"] ?? 0) >= 1, read: setupReads };
      },
      { what: "C15 setup events", key: (v) => (v.ready ? JSON.stringify(v.counts) : `not ready at read ${v.read}: ${JSON.stringify(v.counts)}`), quietMs: SETUP_QUIET_MS, deadlineMs: LOG_MS, step: stepOf(ctx) },
    );
    let cursor0 = null;
    for (let since = "all"; ; ) {
      const head = await poller.ok("get_changes", { id: docId, since });
      cursor0 = head.cursor;
      if (head.more !== true) break;
      since = head.cursor;
    }
    ctx.step(`the poller (an owner's token, lib/changes.mjs startPoller) starts at the log's head and polls every ${POLL_INTERVAL_MS} ms`);
    const poll = startPoller(poller, docId, cursor0);
    let feed = null;
    try {
      // --- the storm: 3N requests at one instant -------------------------------------------------
      const storm = [];
      for (const [i, a] of agents.entries()) {
        storm.push(tool(a, "add_comment", { id: docId, exact: exactOf(i + 1), body: `C15 ${tag}: ${a.name}'s point on paragraph ${i + 1}` }));
        storm.push(webReplyCall(a.name, partWeb[i].fs, parts[i].account, partWeb[i].tok, { docId, annId: t0, body: `C15 ${tag}: ${a.name} replies in T0` }));
        storm.push(tool(a, "suggest_edit", { id: docId, exact: exactOf(20 + i + 1), replacement: `Paragraph ${20 + i + 1} (${tag} ${a.name}).` }));
      }
      const stormFired = await fireAtOnce(ctx, numbered(storm), "storm");
      obs.stage = "stormed";
      const stormOdd = stormFired.answers.filter((a) => (a.what === "web reply" ? a.isError : !madeOn(a, "v1")));
      assert.deepEqual(stormOdd.map(brief), [], "C15: every thread, reply and suggestion of the storm was made on v1");

      // --- three flip rounds on T0, each at one instant, each judged on what is stored ------------
      const rounds = await flipRounds(ctx, agents, docId, t0, cursor0);

      ctx.step("the owner replies in T0 (the browser's way): every participant has written there, so each is eligible for a notice");
      await webReply(ownerWeb.fs, owner.account, { docId, versionId: "v1", annId: t0, body: `C15 ${tag}: thanks, all` });

      // --- settle the log, then drain the poller -------------------------------------------------
      const want = { "thread.opened": n, "suggestion.opened": n, "comment.added": 2 * n + 1 };
      const settled = await settleStorm(ctx, docId, cursor0, t0, want);
      feed = await poll.finish();
      ctx.ev.json("poller", { polls: feed.polls, events: feed.events.length });
      ctx.step(`the poller made ${feed.polls.length} poll(s) (${feed.polls.filter((p) => p.more).length} with more, ${feed.polls.filter((p) => p.afterFinish).length} after finish()) and saw ${feed.events.length} event(s)`);

      // --- N threads, N+1 replies -----------------------------------------------------------------
      const anns = await readCollection(target, `docs/${docId}/versions/v1/annotations`);
      const threads = anns.filter((a) => !a.data.suggestion && a.id !== t0);
      const suggestions = anns.filter((a) => a.data.suggestion?.state === "pending");
      const t = await flipNotesOf(docId, t0);
      const flipRows = settled.rows.filter(isFlipOn(t0));
      const triggerRuns = caseFunctionRuns(ctx);
      ctx.ev.json("function-runs", triggerRuns);
      ctx.step(runsLine(triggerRuns));
      record(ctx, { ref, race: stormFired.race, threads: threads.length, suggestions: suggestions.length, t0Human: t.human, notes: t.notes, flips: flipRows.length, rounds: rounds.map((r) => ({ round: r.round, flips: r.flips, types: r.types, notes: r.notes })), polls: feed.polls.length, feed: feed.events.length, log: settled.counts, waitedOut: settled.waitedOut, triggerRuns });
      assert.equal(threads.length, n, `C15: N=${n} new threads on v1 besides T0`);
      assert.equal(suggestions.length, n, `C15: N=${n} pending suggestions on v1`);
      assert.equal(t.human, n + 2, `C15: T0 holds its opener and N+1=${n + 1} replies, each once`);

      // --- I10: notes equal real flips --------------------------------------------------------------
      ctx.step(`I10: ${flipRows.length} real flip(s) in the log (${flipRows.map(flipType).join(", ")}), ${t.notes} note(s), T0 resolved=${t.resolved}`);
      assert.ok(flipRows.length >= 3, `C15: at least three real flips on T0 (one per round at least), the log holds ${flipRows.length}`);
      assertInvariant(checkI10({ flips: flipRows.length, notes: t.notes, initial: false, final: t.resolved }));

      // --- I15: the poller saw every event once, and the counts are what was caused ---------------
      const logged = await logAfter(ctx.target, docId, cursor0);
      const caused = { ...want, "thread.resolved": flipRows.filter((r) => r.data.type === "thread.resolved").length, "thread.reopened": flipRows.filter((r) => r.data.type === "thread.reopened").length };
      const reported = feedToLogIds(feed.events, logged);
      ctx.ev.json("feed", { events: feed.events.map((e) => ({ type: e.type, at: e.at, threadId: e.threadId ?? null, commentId: e.commentId ?? null })), reported, logged: logged.map((r) => ({ id: r.id, type: r.data.type, at: eventAt(r) })) });
      assertInvariant(checkI15({ events: reported, expected: caused }));
      const seen = new Set(reported.map((r) => r.id));
      const unreported = logged.filter((r) => !seen.has(r.id));
      assert.deepEqual(unreported.map((r) => `${r.data.type} ${r.id} at ${eventAt(r)}`), [], `I15: ${unreported.length} logged event(s) after the poller's first cursor were never reported`);
      assert.deepEqual(logCounts(logged), Object.fromEntries(Object.entries(caused).filter(([, v]) => v > 0).sort(([x], [y]) => (x < y ? -1 : 1))), "I15: the stored log holds each caused event once");
      obs.stage = "judged I10 and I15";
      if (!email) return;

      // --- I11: at most one notice per person, document and kind; exactly one where eligible -------
      const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
      const ownerEmail = lower(owner.account.email);
      const partEmails = parts.map((p) => lower(p.account.email));
      const eligible = [
        { to: ownerEmail, docId, kind: "comment" },
        { to: ownerEmail, docId, kind: "suggestion" },
        ...partEmails.flatMap((to) => [{ to, docId, kind: "comment" }, { to, docId, kind: "invitation" }]),
      ];
      // settleKinds waits for every eligible (to, kind) and 10 s of stillness, and returns AT ONCE on a
      // second notice to one (to, kind) (settled false): checkI11 judges what it saw either way.
      const mail = await box.settleKinds({ people: [ownerEmail, ...partEmails], title, eligible, timeout: MAIL_MS });
      const { messages } = mail;
      ctx.ev.json("mail", mail);
      ctx.step(`notices: ${messages.length} message(s) about “${title}”${mail.settled ? `; every eligible one came and the mailboxes held still (${Math.round(mail.waitedMs / 1000)} s)` : `; a second notice reached ${mail.twice.map((x) => `${x.to} (${x.kind} ×${x.n})`).join(", ")}: I11 judges it`}`);
      // The runs that decided the notices: read after they were all sent.
      const decided = caseFunctionRuns(ctx);
      ctx.ev.json("function-runs-at-mail", decided);
      obs.i11 = { messages, eligible, triggerRuns: decided };
      obs.stage = "measured I11";
      assertInvariant(checkI11({ messages, eligible }));
      const misaddressed = messages.filter((m) => m.kind === "suggestion" && m.to !== ownerEmail);
      assert.deepEqual(misaddressed.map((m) => `${m.to}: ${m.subject}`), [], "C15: a suggestion notice goes to the owner and approvers only (SPEC §14), and the participants are suggesters");
    } finally {
      if (!feed) await poll.abandon().catch(() => undefined);
    }
  });
}

scenario("C15 feedback storm under a get_changes poller: N participants each open a thread, reply in a shared one and suggest an edit at one instant, then resolve and reopen the shared one together; N threads and N+1 replies, the poller sees every event once (I15), one note per real flip (I10), and at most one notice per person and kind (I11)", {
  tiers: LOCAL,
  effects: STORM_EMAIL,
  needs: ["mailpit"],
  n: N,
  timeoutMs: STORM_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnFunctionKill: true,
}, (ctx) => c15Storm(ctx, { ref: "C15", email: true }));

scenario("C15 I11 race judge: the storm's notices were decided by onCommentCreated runs that overlapped, so the cooldown claim was contended, and still at most one notice went to each person per document and kind", {
  tiers: LOCAL,
  effects: STORM_EMAIL,
  needs: ["mailpit", "logs"],
  n: N,
  timeoutMs: JUDGE_MS,
}, async (ctx) => {
  const m = observation(ctx, "C15", "i11");
  const runs = m.triggerRuns;
  if (!runs) ctx.inconclusive("the case's window of emulators.log was not readable, so whether any two onCommentCreated runs overlapped is unknown");
  const peak = runs.peak.onCommentCreated ?? 0;
  ctx.step(runsLine(runs));
  // The peaks are lower bounds, so a 2 is certain; a 1 is "never two at once" only when `exact`.
  if (peak < 2) {
    ctx.inconclusive(
      `the sync precondition did not hold: no two onCommentCreated runs ${runs.exact ? "" : "certainly "}overlapped while C15 ran (${runs.runs.onCommentCreated ?? 0} run(s), peak ${peakOf(runs, peak)} at once; ${peakOf(runs, runs.peakTriggers)} Firestore trigger(s) of any kind at once, while the HTTP functions reached ${peakOf(runs, runs.peakOther)}; ${runs.failed} failure line(s)), so claimCommentCooldown's transaction was never ${runs.exact ? "" : "shown to be "}contended: I11 held in sequence, not in a race`,
    );
  }
  assertInvariant(checkI11({ messages: m.messages, eligible: m.eligible }));
});

scenario("C15 zero-email storm under a get_changes poller: as C15, with every grant through the operator script and every account's notifications off; N threads and N+1 replies, the poller sees every event once (I15), and one note per real flip (I10)", {
  tiers: BOTH,
  n: N,
  timeoutMs: STORM_MS,
  inconclusiveOnStackTimeout: true,
  inconclusiveOnFunctionKill: true,
}, (ctx) => c15Storm(ctx, { ref: "C15 zero-email", email: false }));
