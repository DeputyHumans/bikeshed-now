// SPDX-License-Identifier: Apache-2.0
// A4 Expiry: read-time enforcement per role, frozen writes, refused dates, S25 and the expiry chip (SPEC §17).

/**
 * "An expired document is read-only, and visible only to its owner" (SPEC §17
 * "Expiry"), measured on every surface the SPEC names, each case with its own
 * accounts and documents:
 *
 *   A4.1  a public document set to expire a measured lead ahead (at least
 *         20 s). Before the date nothing changes (and a shared cache may not
 *         keep a read past it); every request sent once the date has passed
 *         sees it expired: every non-owner read is the absent id's 404, the
 *         owner still reads, every write is refused for everybody with the one
 *         exception of the owner's POST /thumb, the shell is generic and the
 *         sitemap drops it; clearing the date restores every cell
 *   A4.2  a date in the past, and one more than a hundred years out, are
 *         refused with a 400 and NOT applied (the record is untouched)
 *   A4.3  S25: POST /visibility with the body SPEC §2 documents, which has no
 *         `expiresAt`, must not lift an expiry the owner set
 *   A4.4  the expiry chip escalates in wording and state over the last week
 *         and past the date; the owner's tap opens Share, anyone else's says
 *         what the state means
 *
 * The waits on the expiry instant itself (A4.1, A4.4) are the only waits on
 * time: the product's expiry IS a time (isExpired is `expiresAt <= now`, read
 * at each request), and nothing signals that it passed. How far ahead that
 * instant is set is measured, not fixed: on a shared stack under load one
 * write can take tens of seconds, and a date that passes while the "before"
 * reads are still running measures nothing (INCONCLUSIVE).
 *
 * The loaded stack. On a shared stack a function can take most of a minute,
 * Hosting answers 504 itself at its minute, and the Admin SDK can run past its
 * deadline. None of that is the product answering, so:
 *   - every client waits FN_MS (past Hosting's minute) and is made with
 *     `cutoffError`, so Hosting's cut-off throws E2E_STACK_CUTOFF instead of
 *     landing in a cell as a 504 the product never gave;
 *   - every case body is onAnsweringStack (lib/test.mjs): a non-answer ends it
 *     INCONCLUSIVE, with the reason; an assertion never does;
 *   - setup calls (a session, a publish, a grant, a setting) go through lib's
 *     untilLanded (or the `patient` option), which looks for the call's effect
 *     in the record before sending it again, and sends again only while one
 *     more send and its look fit in the case's budget (`stopAt: "budget"`);
 *   - every body runs against a budget (lib's caseBudget) short of its
 *     timeoutMs, so a case is never cut by node:test's own timeout, which no
 *     judge reads: what is left closes the case's public window (A4.1). A
 *     budget that ran out while a page lost the emulator (lib's pageStall) or
 *     while the stack took SLOW_ANSWER_MS or more to answer this case's own
 *     requests (lib's httpStall) is INCONCLUSIVE; with neither, it FAILS.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { caseBudget, currentTarget, httpStall, onAnsweringStack, pageStall, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { browserSession, mintToken, openSession } from "../../lib/session.mjs";
import { absentDocId, fork, publish, updateUpload } from "../../lib/seed.mjs";
import { setVisibility, share } from "../../lib/grant.mjs";
import { postThumb, thumbPath } from "../../lib/thumbs.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { sameBytes, sameHeadersExceptDate } from "../../lib/assert.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/** The refusal every write on an expired document answers (functions/src/index.ts EXPIRED_WRITE, mcp/tools.ts refuseIfExpired). */
const EXPIRED_RE = /^this document has expired\b/;
/** SPEC §17: "A date in the past is refused"; "Dates beyond a hundred years are refused" (functions/src/lib/access.ts parseExpiry). */
const PAST_ERROR = "an expiry must be in the future";
const FAR_ERROR = "an expiry must be within a hundred years";

/**
 * A4.1 sets its expiry LEAD ahead: twice what one write and one pass of the
 * before-the-date reads took, at least 20 s, and at most 240 s, so the cache
 * cell (max-age at most the seconds left, where the defect is a 300 s
 * window) still discriminates.
 */
const LEAD_MIN_MS = 20 * SECOND;
const LEAD_MAX_MS = 240 * SECOND;
/**
 * How long after the date the first expired-phase request is sent. Expiry is
 * read at each request (functions/src/lib/acl.ts isExpired: `at <= now`), so
 * any request the stack handles after the date sees it; this is only room for
 * a server clock other than this process's (production), never a grace the
 * product is given.
 */
const CLOCK_SKEW_MS = 2 * SECOND;
/** How long a browser has to show a state the server already holds (a live listener, a render). */
const UI_MS = 45 * SECOND;
/** How long a sign-in or a document open may take on a loaded stack: a wait on a condition, never a sleep. */
const OPEN_MS = 90 * SECOND;

/**
 * Every request's own deadline: past Hosting's minute, so its cut-off 504 is
 * what is seen (and, with `cutoffError`, thrown as the stack not answering),
 * never a client timeout first.
 */
const FN_MS = 150_000;
/**
 * An answer this slow is the stack, not the product: a quiet stack answers
 * every request these cases send (no upload over a few kB) in well under
 * 2 s. Half Hosting's cut-off: lib httpStall's own default, named here
 * because the judge is declared here.
 */
const SLOW_ANSWER_MS = 30_000;
/**
 * How long a POST /visibility taken as landed (Hosting cut it off, the record
 * shows its write) has to show the rest of its effect, the public projection:
 * the function is past its own 60 s timeout by then, so it is done or dead.
 */
const PROJECTION_MS = 30_000;

// Each case's timeoutMs, and the part of it its body may spend (lib caseBudget
// keeps a further 20 s to judge and record). What is left between the two is
// the teardown's: closing a public window on a stack that does not answer can
// take two tries of a minute's request and a minute's look at the record.
const A41_TIMEOUT_MS = 1_500_000;
const A41_BODY_MS = 1_180_000;
const A42_TIMEOUT_MS = 720_000;
const A42_BODY_MS = 460_000;
const A43_TIMEOUT_MS = 600_000;
const A43_BODY_MS = 600_000;
// A4.4 makes seven settings in turn, each a write a loaded stack can hold for
// its full minute (run 2610102144-wr3h, invocation dou9: every one of them was
// cut off), then waits for a date set up to LEAD_MAX_MS ahead: about 1,000 s
// there. Still short of A4.1's, so the file takes no longer.
const A44_TIMEOUT_MS = 1_260_000;
const A44_BODY_MS = 1_260_000;

// --- the loaded stack -----------------------------------------------------------

/**
 * The patience of a setup call (untilLanded's, and lib's `patient` option): a
 * call the stack did not answer is sent again only while one more send and
 * its look at the record still end inside the case's budget (lib's `stopAt:
 * "budget"`, read from ctx.budgetEndsAt, which caseBudget sets); otherwise its
 * non-answer ends the case INCONCLUSIVE at once.
 */
const patience = () => ({ stopAt: "budget" });
const patient = (ctx) => ({ ctx, ...patience() });

/** The case's client for `actor`: FN_MS, and Hosting's cut-off thrown (cutoffError). */
function client(ctx, actor) {
  return ctx.http({ actor, timeoutMs: FN_MS, cutoffError: true });
}

/** The case's MCP client for `actor` with a bearer token: FN_MS, and Hosting's cut-off thrown (lib mcpClient's cutoffError). */
function mcpFor(ctx, actor, token) {
  return ctx.mcp({ actor, token, timeoutMs: FN_MS, cutoffError: true });
}

/**
 * A case body: its budget (lib caseBudget, `bodyMs` of the case's timeoutMs)
 * inside the judges (README "When the case's own timeout runs out"), the
 * stack's non-answers INCONCLUSIVE. Built by hand, not with the scenario
 * options, because a case's body may need to end well before its timeoutMs
 * (A4.1, A4.2: what is left closes a public window), where the options'
 * budget is the timeoutMs less 20 s. Its judges are the options' own, in
 * their order: pageStall, then httpStall.
 */
function judged(bodyMs, body) {
  return onAnsweringStack(caseBudget(body, bodyMs), {
    also: (err, ctx) => pageStall(err, ctx) ?? httpStall(err, ctx, { slowMs: SLOW_ANSWER_MS }),
  });
}

/** Accounts for `roles`, made through the case's own client. */
function castFor(ctx, roles) {
  return cast(target, roles, { http: client(ctx, "harness") });
}

/** A session (POST /session, safe to send again) on the case's client. */
async function sessionFor(ctx, acct) {
  const { out } = await untilLanded(ctx, `POST /session (${acct.role})`, () => openSession(target, acct, { http: client(ctx, acct.role) }), null, patience());
  return out;
}

/** The owner's session and the rest of the cast's sessions, by role. */
async function sessions(ctx, roles) {
  const accounts = await castFor(ctx, roles);
  const out = {};
  for (const a of accounts) out[a.role] = await sessionFor(ctx, a);
  return out;
}

/** POST /publish, patient: it names its own id, so a request the stack did not answer is looked for before it is sent again. */
function publishDoc(ctx, http, o) {
  return publish(http, { ...o, patient: patient(ctx) });
}

/** POST /access through lib/grant.mjs share, sent again only after the record shows no grant. */
async function grant(ctx, owner, docId, account, role) {
  const email = String(account.email).toLowerCase();
  const has = (list) => Array.isArray(list) && list.map((e) => String(e).toLowerCase()).includes(email);
  await untilLanded(ctx, `POST /access ${role}`, () => share(target, { owner, doc: docId, account, role, timeoutMs: FN_MS }), async () => {
    const d = await readDoc(target, `docs/${docId}`);
    return has(d?.members) && (role !== "editor" || has(d?.editorMembers)) ? true : null;
  }, patience());
}

/**
 * A setting the case needs (a setup step, not an oracle): POST /visibility as
 * the owner through lib/grant.mjs, patient, which sends `expiresAt` and
 * `publicEdit` only when given and closes any window it opens when the case
 * ends. An answer must be a 200; a request the stack did not answer but whose
 * effect the record shows is taken (`landed`, no answer to read) — once the
 * whole of its effect shows (projectionSettled, below).
 */
async function settle(ctx, owner, docId, fields) {
  for (let send = 1; ; send += 1) {
    const r = await setVisibility(target, { owner, doc: docId, timeoutMs: FN_MS, patient: patient(ctx), ...fields });
    if (!r.landed) {
      assert.equal(r.status, 200, `POST /visibility ${JSON.stringify(fields)}`);
      return r;
    }
    const why = await projectionSettled(docId, fields);
    if (why === null) return r;
    if (send >= 2) ctx.inconclusive(`the stack did not answer, so nothing was measured: POST /visibility ${JSON.stringify(fields)} got Hosting's cut-off twice, and neither time did the request finish: ${why}`);
    ctx.step(`environment: POST /visibility ${JSON.stringify(fields)} was cut off and did not finish (${why}); sending it again, which writes the projection anew`);
  }
}

/**
 * LIB-REQUEST: landed-projection. POST /visibility writes the record, THEN
 * brings `public/{id}` into line with it (functions/src/index.ts, batch.commit
 * then syncPublicProjection), and the sitemap decides expiry from that
 * projection's `expiresAt`. lib's patient setVisibility takes a request the
 * stack did not answer as landed once the record shows it and a projection
 * EXISTS, which on a document already public it did before the request: a
 * request the emulator killed at its 60 s timeout between the two writes
 * (run 2610102144-wr3h, invocation dou9: "Your function timed out after
 * ~60s" for setVisibility, then the sitemap still listing the expired
 * document) is taken half done. Null once a public document's projection
 * carries the date the request sent (or none was sent, or the document is
 * not public); else what the projection still says after PROJECTION_MS.
 */
async function projectionSettled(docId, fields) {
  if (fields.visibility !== "public" || fields.expiresAt === undefined) return null;
  const want = fields.expiresAt;
  const t0 = Date.now();
  let got;
  for (;;) {
    const p = await readDoc(target, `public/${docId}`);
    got = p == null ? "no projection" : p.expiresAt ?? null;
    if (got === want) return null;
    if (Date.now() - t0 >= PROJECTION_MS) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return `the record carries the request's expiresAt ${JSON.stringify(want)}, but public/${docId}, which the same request writes after it, still says ${JSON.stringify(got)} ${PROJECTION_MS} ms after the request was taken as landed`;
}

/**
 * A cell's request, sent again when the stack did not answer it (untilLanded,
 * with no effect to look for): only for a request whose answer a second send
 * cannot change — a read, a refusal, a write that repeats to the same answer
 * (a view, a draft of the same bytes, a cover already stored). A write whose
 * second send would answer otherwise (a fork that makes a document, a commit,
 * a new version, the first cover) is sent once, and its non-answer ends the
 * case INCONCLUSIVE. Sent again only while one more send still ends inside
 * the case's budget.
 */
function resender(ctx) {
  return async (what, send) => (await untilLanded(ctx, what, send, null, { attempts: 3, backoffMs: 2_000, ...patience() })).out;
}

/**
 * POST /visibility once, for an oracle that is the answer itself (A4.2's
 * refusals): another status than `expect` is returned, not thrown. Hosting's
 * cut-off still throws (cutoffError): no answer is no refusal.
 */
async function visibilityOnce(owner, docId, fields) {
  try {
    return await setVisibility(target, { owner, doc: docId, timeoutMs: FN_MS, ...fields });
  } catch (err) {
    if (err?.code !== "E2E_STATUS" || !err.response) throw err;
    const j = err.response.json && typeof err.response.json === "object" ? err.response.json : null;
    return { status: err.response.status, json: j, expiresAt: j?.expiresAt ?? null, response: err.response };
  }
}

// --- helpers --------------------------------------------------------------------

/** A small public-ready document whose own <title> the shell splices in. */
function docHtml(title, marker) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title><meta name="description" content="An A4 expiry fixture."></head>
<body>
<h1>${title}</h1>
<p id="a4-1">Expiry is not deletion: ${marker}.</p>
<p id="a4-2">A second paragraph, so a suggestion has somewhere to point.</p>
</body>
</html>
`;
}

/** docs/{id}.expiresAt as epoch ms, or null when the field is absent. */
async function storedExpiry(docId) {
  const d = await readDoc(target, `docs/${docId}`);
  precondition(d, `docs/${docId} exists`);
  const v = d.expiresAt;
  return v == null ? null : typeof v.toMillis === "function" ? v.toMillis() : v;
}

/** GET /thumb of the stored cover of v1, or a stand-in when the record names none (so the cell, not thumbPath, says so). */
async function getCover(http, docId) {
  const key = (await readDoc(target, `docs/${docId}`))?.thumb?.cover ?? null;
  if (typeof key !== "string") return { status: `no cover stored (thumb.cover ${JSON.stringify(key)})`, headers: new Headers() };
  return http.get(thumbPath(docId, "v1", key));
}

function viewBody(docId) {
  return { docId, versionId: "v1", sessionId: `a4${randomBytes(8).toString("hex")}`, ms: 1000 };
}

/** A table of cells: what each surface answered against what the SPEC says it must. */
function cells(phase) {
  const rows = [];
  return {
    cell(label, got, want) {
      rows.push({ label, got, want, ok: isDeepStrictEqual(got, want) });
    },
    rows,
    /** Every wrong cell at once, so one run names all of them. */
    assertAll(ctx) {
      ctx.ev.json(`cells-${phase}`, rows);
      const bad = rows.filter((r) => !r.ok);
      assert.deepEqual(
        bad.map((r) => r.label),
        [],
        `${phase}: ${bad.length} of ${rows.length} cells wrong:\n${bad.map((r) => `  ${r.label}: got ${JSON.stringify(r.got)}, want ${JSON.stringify(r.want)}`).join("\n")}`,
      );
    },
  };
}

const st = (r) => r.status;
const expiredWrite = (r) => ({ status: r.status, expired: EXPIRED_RE.test(String(r.json?.error ?? "")) });
const mcpExpired = (out) => ({ isError: out.isError, expired: EXPIRED_RE.test(out.text) });
function maxAgeOf(r) {
  const m = /max-age=(\d+)/.exec(r.headers.get("cache-control") ?? "");
  return m ? Number(m[1]) : null;
}

/** Wait until `at` (a Date.now() time). Only for the product's own time: an expiry date. */
function untilTime(at) {
  return new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
}

// --- A4.1 ----------------------------------------------------------------------

scenario("A4.1 an expired document is the absent id's 404 to everyone but its owner, frozen for all (the owner's cover excepted), gone from the shell and sitemap, and clearing the date restores every cell", {
  tiers: ["local", "prod"],
  timeoutMs: A41_TIMEOUT_MS,
}, judged(A41_BODY_MS, async (ctx) => {
  ctx.step("cast an owner and an editor; the owner publishes a document, shares it for editing and makes it public");
  const { owner: O, editor: E } = await sessions(ctx, ["owner", "editor"]);
  const G = resender(ctx);
  const tag = `${runTag(target.runId)}-${rand4()}`;
  const title = `A4 expiry ${tag}`;
  const marker = `a4-marker-${tag}`;
  const up = await publishDoc(ctx, O.http, { body: docHtml(title, marker), filename: "index.html", title, name: "a4-expiry" });
  const docId = up.docId;
  precondition(up.versionId === "v1", `the document's first version is v1: ${JSON.stringify(up.versionId)}`);
  await grant(ctx, O, docId, E.account, "editor");
  const pubAt = Date.now();
  const pub = await settle(ctx, O, docId, { visibility: "public", publicEdit: false, expiresAt: null });
  const writeMs = Date.now() - pubAt;
  assert.deepEqual({ visibility: pub.visibility, expiresAt: pub.expiresAt }, { visibility: "public", expiresAt: null });

  const AN = client(ctx, "anon");
  const mcpO = mcpFor(ctx, "owner-mcp", (await mintToken(O, { name: "e2e a4 owner", channel: "mcp" })).token);
  const mcpE = mcpFor(ctx, "editor-mcp", (await mintToken(E, { name: "e2e a4 editor", channel: "mcp" })).token);
  await Promise.all([mcpO.initialize(), mcpE.initialize()]);

  const content = (id) => `/content/${encodeURIComponent(id)}/v1/index.html`;
  const sitemapHas = async () => {
    const r = await AN.get("/sitemap.xml", { query: { e2e: rand4() } }); // a key of its own: a CDN keys on the query
    assert.equal(r.status, 200, "GET /sitemap.xml");
    return r.text.includes(`/d/${docId}</loc>`);
  };

  ctx.step("what an absent id gets, for comparison: GET /content and /d/ anonymously and as the editor, get_document as the editor");
  const absentId = absentDocId(target, "a4-absent");
  const absentContentE = await G("E GET /content (absent)", () => E.http.get(content(absentId)));
  const absentShell = await G("AN GET /d/ (absent)", () => AN.get(`/d/${absentId}`));
  const absentMcp = await G("E get_document (absent)", () => mcpE.call("get_document", { id: absentId }));
  precondition(absentContentE.status === 404 && absentShell.status === 200 && absentMcp.isError, "an absent id is a 404, a generic shell and a tool error");

  /** The before-the-date reads, in one pass: the editor's and the public's content, the shell, the sitemap. */
  const beforeReads = async () => {
    const t0 = Date.now();
    const rE = await G("E GET /content", () => E.http.get(content(docId)));
    const rA = await G("AN GET /content", () => AN.get(content(docId)));
    const rS = await G("AN GET /d/", () => AN.get(`/d/${docId}`));
    const listed = await G("GET /sitemap.xml", sitemapHas);
    return { t0, rE, rA, rS, listed, ms: Date.now() - t0 };
  };
  ctx.step("one unasserted pass of the before-the-date reads, to size the lead to this stack's speed");
  const rehearsal = await beforeReads();
  let leadMs = Math.min(LEAD_MAX_MS, Math.max(LEAD_MIN_MS, 2 * (writeMs + rehearsal.ms)));
  // What the before-the-date reads need between the date being in place and the date itself.
  const readsRoomMs = Math.max(15 * SECOND, 3 * rehearsal.ms);

  ctx.step(`the owner sets the expiry ${Math.round(leadMs / 1000)} s ahead (a write took ${writeMs} ms, the reads ${rehearsal.ms} ms); the record carries it`);
  let at;
  for (let sets = 1; ; sets += 1) {
    at = Date.now() + leadMs;
    const t = Date.now();
    const set = await settle(ctx, O, docId, { visibility: "public", publicEdit: false, expiresAt: at });
    const setMs = Date.now() - t;
    if (!set.landed) assert.equal(set.expiresAt, at, "POST /visibility answers the date it set");
    assert.equal(await storedExpiry(docId), at, "docs/{id}.expiresAt");
    const leftMs = at - Date.now();
    if (leftMs >= readsRoomMs) break;
    // A loaded stack can hold the setting itself for most of the lead (a
    // cut-off, its look, a resend). The date is then set again, further out:
    // the owner may change a date at any time, an expired one included.
    if (sets >= 3 || leadMs >= LEAD_MAX_MS) ctx.inconclusive(`the stack did not answer, so nothing was measured: setting the date ${Math.round(leadMs / 1000)} s ahead took ${setMs} ms, leaving ${leftMs} ms before it, less than the ${readsRoomMs} ms the before-the-date reads need (set ${sets} time(s))`);
    leadMs = Math.min(LEAD_MAX_MS, Math.max(2 * leadMs, 2 * (setMs + readsRoomMs)));
    ctx.step(`environment: setting the date took ${setMs} ms, leaving ${leftMs} ms before it, less than the ${readsRoomMs} ms the before-the-date reads need: set again, ${Math.round(leadMs / 1000)} s ahead`);
  }

  ctx.step("BEFORE the date: nothing has changed yet, and no public read may be cached past the date");
  const before = cells("before the date");
  {
    const { t0, rE, rA, rS, listed } = await beforeReads();
    const leftS = Math.floor((at - t0) / 1000);
    before.cell("E GET /content", { status: rE.status, marker: rE.text.includes(marker), cache: rE.headers.get("cache-control") }, { status: 200, marker: true, cache: "private, no-store" });
    // "max-age never outlives the date" (SPEC §17). 2 s of slack for a clock
    // other than this one; the defect it exists to catch is a 300 s window.
    before.cell("AN GET /content: 200, public, max-age <= seconds left", { status: rA.status, public: /^public,/.test(rA.headers.get("cache-control") ?? ""), capped: maxAgeOf(rA) !== null && maxAgeOf(rA) <= leftS + 2 }, { status: 200, public: true, capped: true });
    before.cell("AN GET /d/: the document's own head, max-age <= seconds left", { status: rS.status, title: rS.text.includes(`<title>${title}</title>`), capped: maxAgeOf(rS) !== null && maxAgeOf(rS) <= leftS + 2 }, { status: 200, title: true, capped: true });
    before.cell("sitemap lists it", listed, true);
    if (Date.now() >= at - 1000) ctx.inconclusive(`the before-the-date reads took until ${Date.now() - at} ms from the expiry, so they did not measure "before"`);
  }
  before.assertAll(ctx);

  ctx.step(`wait for the date (the product's own time: expiry is read at each request, and nothing signals that it passed), and ${CLOCK_SKEW_MS} ms more for another clock`);
  await untilTime(at + CLOCK_SKEW_MS);
  ctx.step(`EXPIRED: every cell, each request sent after the date (the first ${Date.now() - at} ms after it)`);
  const during = cells("expired");
  {
    // Reads: the absent id's answer for everyone but the owner (SPEC §17 "the SAME 404").
    const rE = await G("E GET /content", () => E.http.get(content(docId)));
    during.cell("E GET /content = the absent id's 404", { status: rE.status, sameBytes: sameBytes(rE.buffer, absentContentE.buffer).equal, sameHeaders: sameHeadersExceptDate(rE, absentContentE).equal }, { status: 404, sameBytes: true, sameHeaders: true });
    during.cell("AN GET /content", st(await G("AN GET /content", () => AN.get(content(docId)))), 404);
    const rO = await G("O GET /content", () => O.http.get(content(docId)));
    during.cell("O GET /content", { status: rO.status, marker: rO.text.includes(marker), cache: rO.headers.get("cache-control") }, { status: 200, marker: true, cache: "private, no-store" });
    during.cell("E GET /download", st(await G("E GET /download", () => E.http.get(`/download/${docId}/v1`))), 404);
    during.cell("O GET /download", st(await G("O GET /download", () => O.http.get(`/download/${docId}/v1`))), 200);
    const fE = await G("E POST /fork (refused)", () => fork(E.http, { docId, ownerEmail: E.account.email }));
    during.cell("E POST /fork", { status: fE.status, empty: fE.response.buffer.length === 0 }, { status: 404, empty: true });
    during.cell("O POST /fork (the owner still reads it)", st(await fork(O.http, { docId, ownerEmail: O.account.email })), 200);
    during.cell("E POST /view", st(await G("E POST /view", () => E.http.postJson("/view", viewBody(docId)))), 404);
    during.cell("AN POST /view", st(await G("AN POST /view", () => AN.postJson("/view", viewBody(docId)))), 404);
    during.cell("O POST /view", st(await G("O POST /view", () => O.http.postJson("/view", viewBody(docId)))), 200);
    const rS = await G("AN GET /d/", () => AN.get(`/d/${docId}`));
    during.cell("AN GET /d/ = the absent id's generic shell", { status: rS.status, sameBytes: sameBytes(rS.buffer, absentShell.buffer).equal, sameHeaders: sameHeadersExceptDate(rS, absentShell).equal, cache: rS.headers.get("cache-control") }, { status: 200, sameBytes: true, sameHeaders: true, cache: "private, no-store" });
    during.cell("sitemap lists it", await G("GET /sitemap.xml", sitemapHas), false);
    const gE = await G("E get_document", () => mcpE.call("get_document", { id: docId }));
    during.cell("E get_document = the absent id's tool error", { isError: gE.isError, text: gE.text }, { isError: true, text: absentMcp.text.replace(absentId, docId) });
    const gO = await G("O get_document", () => mcpO.call("get_document", { id: docId }));
    during.cell("O get_document", { isError: gO.isError, expiresAt: gO.json?.expiresAt, canEdit: gO.json?.canEdit }, { isError: false, expiresAt: at, canEdit: false });
    // "a member still sees the row, its title and its comments; what they cannot get is the document" (SPEC §17).
    const lE = await G("E list_documents", () => mcpE.call("list_documents", {}));
    const row = (lE.json?.documents ?? []).find((d) => d.id === docId);
    during.cell("E list_documents still lists the row, with its date", { isError: lE.isError, listed: Boolean(row), expiresAt: row?.expiresAt }, { isError: false, listed: true, expiresAt: at });

    // Writes: frozen for everyone, the owner included (SPEC §17 "Writing is refused for everyone").
    const html = docHtml(title, `${marker}-draft`);
    during.cell("O POST /draft", expiredWrite(await G("O POST /draft", () => O.http.postJson("/draft", { docId, baseVersion: "v1", html }))), { status: 409, expired: true });
    during.cell("E POST /draft", expiredWrite(await G("E POST /draft", () => E.http.postJson("/draft", { docId, baseVersion: "v1", html }))), { status: 409, expired: true });
    during.cell("O GET /draft", expiredWrite(await G("O GET /draft", () => O.http.get(`/draft/${docId}`))), { status: 409, expired: true });
    during.cell("E GET /draft", expiredWrite(await G("E GET /draft", () => E.http.get(`/draft/${docId}`))), { status: 409, expired: true });
    during.cell("O POST /commit", expiredWrite(await G("O POST /commit", () => O.http.postJson("/commit", { docId, baseVersion: "v1" }))), { status: 409, expired: true });
    during.cell("E POST /commit", expiredWrite(await G("E POST /commit", () => E.http.postJson("/commit", { docId, baseVersion: "v1" }))), { status: 409, expired: true });
    during.cell("O POST /publish?update=", expiredWrite((await G("O POST /publish?update=", () => updateUpload(O.http, docId, { body: docHtml(title, `${marker}-upload`), baseVersion: "v1" }))).response), { status: 409, expired: true });
    during.cell("O update_document", mcpExpired(await G("O update_document", () => mcpO.call("update_document", { id: docId, content: docHtml(title, `${marker}-mcp`), baseVersion: "v1" }))), { isError: true, expired: true });
    // The anchor is deliberately not one: the expiry is checked first, and no comment can come of this.
    during.cell("E POST /suggestion", expiredWrite(await G("E POST /suggestion", () => E.http.postJson("/suggestion", { op: "create", docId, versionId: "v1", anchor: { exact: "" }, replacement: "x" }))), { status: 409, expired: true });
    during.cell("E POST /thumb", expiredWrite(await G("E POST /thumb", () => postThumb(E.http, { docId, versionId: "v1" }))), { status: 409, expired: true });
    const tO = await postThumb(O.http, { docId, versionId: "v1" });
    during.cell("O POST /thumb (the one exception)", { status: tO.status, stored: tO.json?.stored }, { status: 200, stored: true });
    const gtO = await G("O GET /thumb", () => getCover(O.http, docId));
    // min(86400, seconds to expiry), which past the date is 0 (SPEC §2).
    during.cell("O GET /thumb", { status: gtO.status, cache: gtO.headers.get("cache-control") }, { status: 200, cache: "private, max-age=0, immutable" });
    during.cell("E GET /thumb", st(await G("E GET /thumb", () => getCover(E.http, docId))), 404);
  }
  during.assertAll(ctx);

  ctx.step("the owner clears the expiry with an explicit null; the record no longer carries it");
  const cleared = await settle(ctx, O, docId, { visibility: "public", publicEdit: false, expiresAt: null });
  if (!cleared.landed) assert.equal(cleared.expiresAt, null, "POST /visibility answers no date");
  assert.equal(await storedExpiry(docId), null, "docs/{id}.expiresAt after clearing");

  ctx.step("CLEARED: every cell is restored");
  const restored = cells("cleared");
  {
    const rE = await G("E GET /content", () => E.http.get(content(docId)));
    restored.cell("E GET /content", { status: rE.status, marker: rE.text.includes(marker) }, { status: 200, marker: true });
    const rA = await G("AN GET /content", () => AN.get(content(docId)));
    restored.cell("AN GET /content", { status: rA.status, cache: rA.headers.get("cache-control") }, { status: 200, cache: "public, max-age=300" });
    restored.cell("E GET /download", st(await G("E GET /download", () => E.http.get(`/download/${docId}/v1`))), 200);
    restored.cell("E POST /view", st(await G("E POST /view", () => E.http.postJson("/view", viewBody(docId)))), 200);
    const rS = await G("AN GET /d/", () => AN.get(`/d/${docId}`));
    restored.cell("AN GET /d/: the document's own head again", { status: rS.status, title: rS.text.includes(`<title>${title}</title>`), cache: rS.headers.get("cache-control") }, { status: 200, title: true, cache: "public, max-age=300" });
    restored.cell("sitemap lists it", await G("GET /sitemap.xml", sitemapHas), true);
    const gE = await G("E get_document", () => mcpE.call("get_document", { id: docId }));
    restored.cell("E get_document", { isError: gE.isError, expiresAt: gE.json?.expiresAt, canEdit: gE.json?.canEdit }, { isError: false, expiresAt: null, canEdit: true });
    restored.cell("E GET /thumb", st(await G("E GET /thumb", () => getCover(E.http, docId))), 200);
    const tE = await G("E POST /thumb", () => postThumb(E.http, { docId, versionId: "v1" }));
    restored.cell("E POST /thumb (allowed; this version's cover is already stored)", { status: tE.status, stored: tE.json?.stored }, { status: 200, stored: false });
    const sE = await G("E POST /suggestion", () => E.http.postJson("/suggestion", { op: "create", docId, versionId: "v1", anchor: { exact: "" }, replacement: "x" }));
    restored.cell("E POST /suggestion is judged on its anchor again, not refused as expired", { status: sE.status, expired: EXPIRED_RE.test(String(sE.json?.error ?? "")) }, { status: 400, expired: false });
    restored.cell("E POST /fork", st(await fork(E.http, { docId, ownerEmail: E.account.email })), 200);
    const html = docHtml(title, `${marker}-draft`);
    restored.cell("E POST /draft", st(await G("E POST /draft", () => E.http.postJson("/draft", { docId, baseVersion: "v1", html }))), 200);
    restored.cell("E GET /draft", st(await G("E GET /draft", () => E.http.get(`/draft/${docId}`))), 200);
    const c = await O.http.postJson("/commit", { docId, baseVersion: "v1" });
    restored.cell("O POST /commit", { status: c.status, versionId: c.json?.versionId }, { status: 200, versionId: "v2" });
    const u = await mcpO.call("update_document", { id: docId, content: docHtml(title, `${marker}-mcp`), baseVersion: "v2" });
    restored.cell("O update_document", { isError: u.isError, versionId: u.json?.versionId }, { isError: false, versionId: "v3" });
    const p = await updateUpload(O.http, docId, { body: docHtml(title, `${marker}-upload`), baseVersion: "v3" });
    restored.cell("O POST /publish?update=", { status: p.status, versionId: p.json?.versionId }, { status: 200, versionId: "v4" });
  }
  restored.assertAll(ctx);
}));

// --- A4.2 ----------------------------------------------------------------------

scenario("A4.2 a past date and one beyond a hundred years are each refused with a 400, and neither touches the record", {
  tiers: ["local", "prod"],
  timeoutMs: A42_TIMEOUT_MS,
}, judged(A42_BODY_MS, async (ctx) => {
  const { owner: O } = await sessions(ctx, ["owner"]);
  const G = resender(ctx);
  const up = await publishDoc(ctx, O.http, { body: docHtml(`A4.2 ${runTag(target.runId)}`, rand4()), filename: "index.html", name: "a4-dates" });
  const docId = up.docId;

  ctx.step("the owner sets a valid expiry a week out, on a private document");
  const valid = Date.now() + 7 * DAY;
  const set = await settle(ctx, O, docId, { visibility: "private", publicEdit: false, expiresAt: valid });
  if (!set.landed) assert.equal(set.expiresAt, valid, "POST /visibility answers the date it set");
  const recordBefore = await readDoc(target, `docs/${docId}`);
  const snapshot = (d) => ({ visibility: d?.visibility ?? "private", linkToken: d?.linkToken ?? null, publicEdit: d?.publicEdit === true, expiresAt: d?.expiresAt?.toMillis?.() ?? null });
  assert.deepEqual(snapshot(recordBefore), { visibility: "private", linkToken: null, publicEdit: false, expiresAt: valid });

  // Each asks to make the document unlisted too: a refusal that applied the rest
  // of the body would show as a link token and a changed visibility.
  const now = Date.now();
  const refusals = [
    { what: "a minute ago", expiresAt: now - 60 * SECOND, error: PAST_ERROR },
    { what: "an hour from now in SECONDS (1970 as milliseconds)", expiresAt: Math.floor((now + HOUR) / 1000), error: PAST_ERROR },
    { what: "101 years out", expiresAt: now + 101 * YEAR, error: FAR_ERROR },
    { what: "an hour from now in MICROseconds (the year 55000 SPEC §17 names)", expiresAt: (now + HOUR) * 1000, error: FAR_ERROR },
  ];
  const got = [];
  for (const r of refusals) {
    ctx.step(`POST /visibility {visibility: "unlisted", expiresAt: ${r.what}} → 400 "${r.error}"`);
    // A refusal changes nothing, so one the stack did not answer may be sent again.
    const res = await G(`POST /visibility (${r.what})`, () => visibilityOnce(O, docId, { visibility: "unlisted", publicEdit: false, expiresAt: r.expiresAt, expect: 400 }));
    got.push({ what: r.what, status: res.status, error: res.json?.error ?? null, record: snapshot(await readDoc(target, `docs/${docId}`)) });
  }
  ctx.ev.json("refusals", got);
  assert.deepEqual(
    got,
    refusals.map((r) => ({ what: r.what, status: 400, error: r.error, record: snapshot(recordBefore) })),
    "each refused with its reason, and the record exactly as before",
  );

  ctx.step("the limit is a hundred years, not less: 99 years out is accepted");
  const far = Date.now() + 99 * YEAR;
  const ok = await G("POST /visibility (99 years out)", () => visibilityOnce(O, docId, { visibility: "private", publicEdit: false, expiresAt: far }));
  assert.deepEqual({ status: ok.status, expiresAt: ok.expiresAt }, { status: 200, expiresAt: far });
}));

// --- A4.3 (S25) ----------------------------------------------------------------

scenario("A4.3 POST /visibility with the body SPEC §2 documents (no expiresAt) keeps the expiry the owner set", {
  tiers: ["local", "prod"],
  timeoutMs: A43_TIMEOUT_MS,
}, judged(A43_BODY_MS, async (ctx) => {
  // Setup, not the oracle: a failure before the oracle is a precondition (it
  // FAILS the case). The document stays private throughout,
  // so the case opens no window and has nothing to close.
  const accounts = await castFor(ctx, ["owner"]);
  const O = await sessionFor(ctx, accounts[0]);
  const up = await publishDoc(ctx, O.http, { body: docHtml(`A4.3 ${runTag(target.runId)}`, rand4()), filename: "index.html", name: "a4-s25" });
  const docId = up.docId;
  precondition(typeof docId === "string" && docId, `the document was published: ${JSON.stringify(up.json)}`);

  ctx.step("the owner sets the private document to expire in a week");
  const at = Date.now() + 7 * DAY;
  const set = await setVisibility(target, { owner: O, doc: docId, visibility: "private", publicEdit: false, expiresAt: at, timeoutMs: FN_MS, patient: patient(ctx) });
  const setGot = { answered: set.landed ? at : set.expiresAt, stored: await storedExpiry(docId) };
  precondition(isDeepStrictEqual(setGot, { answered: at, stored: at }), `the expiry is set: ${JSON.stringify(setGot)}`);

  ctx.step("the owner sends SPEC §2's body for the same setting, { docId, visibility }, which has no expiresAt");
  const again = await setVisibility(target, { owner: O, doc: docId, visibility: "private", timeoutMs: FN_MS, patient: patient(ctx) });
  precondition(again.landed || (again.status === 200 && again.visibility === "private"), `the request was taken, the document still private: ${JSON.stringify(again.json)}`);
  const events = (await readCollection(target, `docs/${docId}/events`)).filter((e) => e.data?.type === "doc.expiry").map((e) => e.data.data);
  ctx.ev.json("doc.expiry events", events);
  ctx.step(`doc.expiry events: ${JSON.stringify(events)}`);
  const stored = await storedExpiry(docId);

  ctx.step(`S25's oracle: the date the owner set is still there — in the record${again.landed ? " (the stack never answered the request, which the record shows taken)" : " and in the answer"}`);
  const got = again.landed ? { stored } : { answered: again.expiresAt, stored };
  const want = again.landed ? { stored: at } : { answered: at, stored: at };
  assert.deepEqual(
    got,
    want,
    "an expiry is lifted only by the owner clearing it (SPEC §17: \"lifting the date is the single action that unfreezes it\"), not by a request that never mentioned it",
  );
}));

// --- A4.4 ----------------------------------------------------------------------

/** The toolbar chip as a person sees it: its name, its words, and the two states colour is drawn from. */
async function chipState(page) {
  return page.evaluate(() => {
    const c = document.querySelector(".viewer-toolbar .expiry-chip");
    if (!c) return null;
    return { label: c.getAttribute("aria-label"), text: c.querySelector(".chip-label")?.textContent ?? null, soon: c.hasAttribute("data-soon"), expired: c.hasAttribute("data-expired") };
  });
}

/** How the page's own locale writes a day, the way the chip does (app/src/expiry.ts formatDay). */
function dayIn(page, at) {
  return page.evaluate((ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }), at);
}

/** The `<input type="date">` value for `at` in the page's time zone. */
function dateInputIn(page, at) {
  return page.evaluate((ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }, at);
}

/**
 * Sign `acct` in at /signup. The app's own POST /session can get Hosting's
 * cut-off on a loaded stack (signInUi throws it with the answer, which lib
 * reads as the stack not answering); signing in is safe to repeat.
 */
async function signedIn(ctx, acct, name) {
  const u = await ctx.users.user({ name });
  const { out: s } = await untilLanded(ctx, `${name}'s sign-in`, () => u.signInUi(acct.email, acct.password, { timeout: OPEN_MS }), null, patience());
  precondition(s.status === "ok", `${name} signed in through /signup`);
  return u;
}

/**
 * Open the document and wait for its toolbar. The viewer shows "Opening the
 * document…" until the record arrives over the page's Listen channel, which a
 * loaded stack can stall; User.waitShown loads the page again only when this
 * page saw that happen, and otherwise the wait's failure is the case's.
 */
async function openDoc(u, docId) {
  const path = `/d/${encodeURIComponent(docId)}`;
  await u.goto(path, { timeout: OPEN_MS });
  await u.waitShown(".viewer-toolbar", { what: `the viewer toolbar of ${docId}`, path, timeout: OPEN_MS });
}

scenario("A4.4 the expiry chip escalates in words and state through the last week and past the date; the owner's tap opens Share, a reader's says what it means", {
  tiers: ["local", "prod"],
  timeoutMs: A44_TIMEOUT_MS,
}, judged(A44_BODY_MS, async (ctx) => {
  const [OA, VA] = await castFor(ctx, ["owner", "viewer"]);
  ctx.step("owner and viewer sign in through the UI; the owner's browser session publishes, shares with the viewer, and both open the document");
  const [o, v] = await Promise.all([signedIn(ctx, OA, "owner"), signedIn(ctx, VA, "viewer")]);
  // The browser's own session from Node: no second POST /session.
  const O = await browserSession(o, { account: OA, http: client(ctx, "owner") });
  const title = `A4.4 chip ${runTag(target.runId)}-${rand4()}`;
  const up = await publishDoc(ctx, O.http, { body: docHtml(title, rand4()), filename: "index.html", title, name: "a4-chip" });
  const docId = up.docId;
  await grant(ctx, O, docId, VA, "viewer");
  await Promise.all([openDoc(o, docId), openDoc(v, docId)]);
  assert.equal(await chipState(o.page), null, "no expiry, no chip");

  // The slowest write and the slowest chip update seen, which size the lead of the past-the-date step.
  let slowestWriteMs = 0;
  let slowestChipMs = 0;
  const expire = async (at) => {
    const t = Date.now();
    const r = await settle(ctx, O, docId, { visibility: "private", publicEdit: false, expiresAt: at });
    slowestWriteMs = Math.max(slowestWriteMs, Date.now() - t);
    if (!r.landed) assert.equal(r.expiresAt, at, "POST /visibility answers the date it set");
  };
  /**
   * The chip shows `want` within UI_MS (lib User.waitValue). The chip is read
   * from docs/{docId} over the page's Listen channel, which a loaded stack
   * can stall: a page that saw the stack stall in its current load (a cut-off
   * 504, or its Firestore client losing the emulator) is loaded once more and
   * the chip read again; a page that saw none is not, and its wait's failure
   * (E2E_NOT_SHOWN, with the last chip read) FAILS the case. A stall within
   * the last load's wait makes it INCONCLUSIVE (pageStall).
   */
  const expectChip = async (user, want, what) => {
    const t = Date.now();
    const { loads, stall } = await user.waitValue(chipState, want, { what: `the expiry chip (${what})`, path: `/d/${encodeURIComponent(docId)}`, timeout: UI_MS, reloads: 1 });
    if (loads > 1) ctx.step(`environment: ${user.name}'s expiry chip (${what}) shown in load ${loads}, made again after the page saw the stack stall (${stall.slice(0, 2).join("; ")})`);
    slowestChipMs = Math.max(slowestChipMs, Date.now() - t);
  };

  // Whole days plus an hour, so the seconds a render takes cannot round a count down.
  const ladder = [
    { left: 30 * DAY + HOUR, words: null, soon: false, what: "a month out: the date, no warning" },
    { left: 10 * DAY + HOUR, words: "Expires in 10 days", soon: false, what: "ten days out: a count, still no warning" },
    { left: 7 * DAY + HOUR, words: "Expires in 7 days", soon: false, what: "just over a week: not yet the last week" },
    { left: 6 * DAY + HOUR, words: "Expires in 6 days", soon: true, what: "inside the last week: it insists" },
    { left: 1 * DAY + HOUR, words: "Expires tomorrow", soon: true, what: "a day out" },
    { left: 2 * HOUR, words: "Expires today", soon: true, what: "the last day" },
  ];
  for (const step of ladder) {
    const at = Date.now() + step.left;
    await expire(at);
    const words = step.words ?? `Expires ${await dayIn(o.page, at)}`;
    ctx.step(`${step.what}: "${words}"${step.soon ? ", data-soon" : ""}`);
    await expectChip(o, { label: words, text: words, soon: step.soon, expired: false }, step.what);

    if (step.left === 6 * DAY + HOUR) {
      ctx.step("the owner taps the chip: the Share dialog opens, holding this date");
      await o.page.locator(".viewer-toolbar .expiry-chip").click();
      const dialog = o.page.getByRole("dialog", { name: `Share “${title}”` });
      await dialog.waitFor({ state: "visible", timeout: UI_MS });
      assert.equal(await dialog.locator("#expires-on").inputValue(), await dateInputIn(o.page, at), "the dialog's expiry field holds the chip's date");
      await dialog.getByRole("button", { name: "Close" }).click();
      await dialog.waitFor({ state: "detached", timeout: UI_MS });

      ctx.step("the viewer taps the same chip: no dialog, a toast that says nothing is deleted and who can open it after");
      await expectChip(v, { label: words, text: words, soon: true, expired: false }, `${step.what} (viewer)`);
      const since = v.toastMark();
      await v.page.locator(".viewer-toolbar .expiry-chip").click();
      const toast = await v.waitForToast(() => true, { since, timeout: UI_MS });
      assert.equal(toast.text, `Readable until ${await dayIn(v.page, at)}. Nothing is deleted then — only its owner can open it after that.`);
      assert.equal(await v.page.getByRole("dialog").count(), 0, "a reader is handed no dialog");
    }
  }

  // At least 15 s; on a loaded stack, twice the slowest write plus chip update seen, so the chip is read before the date
  // (the write the date is set by is one of them, and runs inside the lead).
  const leadMs = Math.min(LEAD_MAX_MS, Math.max(15 * SECOND, 2 * (slowestWriteMs + slowestChipMs)));
  ctx.step(`past the date: set it ${Math.round(leadMs / 1000)} s ahead (slowest write ${slowestWriteMs} ms, slowest chip ${slowestChipMs} ms), wait for the date (the product's own time), and reopen as the owner`);
  const at = Date.now() + leadMs;
  await expire(at);
  try {
    await expectChip(o, { label: "Expires today", text: "Expires today", soon: true, expired: false }, "before the date");
  } catch (err) {
    // The chip has no timer, but any render after the date may say "Expired": then this read measured nothing.
    if (Date.now() >= at) ctx.inconclusive(`the date passed ${Date.now() - at} ms before the chip was read before it`);
    throw err;
  }
  await untilTime(at + CLOCK_SKEW_MS);
  await openDoc(o, docId);
  await expectChip(o, { label: "Expired", text: "Expired", soon: false, expired: true }, "past the date");
  ctx.step("the owner's tap still opens Share, the one place the date is changed");
  await o.page.locator(".viewer-toolbar .expiry-chip").click();
  await o.page.getByRole("dialog", { name: `Share “${title}”` }).waitFor({ state: "visible", timeout: UI_MS });
}));
