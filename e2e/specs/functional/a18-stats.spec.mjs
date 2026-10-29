// SPDX-License-Identifier: Apache-2.0
// A18 Stats: views, totalMs and viewers, anonymous sessions, automated reads, the Activity gate, keyless unlisted views and heartbeat clamps (SPEC §4, §17).

/**
 * Reading statistics as SPEC §4 ("stats", "recordView deliberately does NOT
 * touch updatedAt", "stats.apiReads counts automated reads") and §17
 * ("Automated reads must not corrupt human metrics", "Version, edit and view
 * provenance", "The activity panel", "An unlisted document needs its link")
 * state them, measured through POST /view (functions/src/index.ts recordView),
 * the reading clock (app/src/stats.ts) and the Activity panel
 * (app/src/components/StatsPanel.tsx). Each case has its own accounts and
 * documents:
 *
 *   A18.1 a member opens a document in the browser: the clock registers one
 *         session (stats.views 1), leaving sends the final beat, and its
 *         active time is stats.totalMs and viewers/{uid}.totalMs; a second
 *         visit by the same person is a second view of one identified
 *         viewer; updatedAt is exactly what the publish wrote
 *   A18.2 anonymous readers, in a browser on an unlisted link and over HTTP
 *         on a public page: uid and email null, views and totalMs counted,
 *         no viewers/{uid}, stats.viewers 0
 *   A18.3 automated reads (MCP get_document, a cli token's POST /view) move
 *         only stats.apiReads and record ms 0; the owner's own browser-channel
 *         beat on the same document then does move the human numbers
 *   A18.4 the per-person detail (viewers, views, acl) is for the owner,
 *         editors and approvers: the rules refuse it to a viewer, a suggester,
 *         an open editor and anonymous, and the panel shows readers to
 *         editors and only the aggregate, with a hint, to a viewer; an open
 *         editor has no Activity entry at all
 *   A18.4 (who read it last): shared stats never reveal a reader's identity;
 *         the protected per-person history still records it for editors
 *   A18.4 (automation filter): human and automated sessions are separated,
 *         the API read tile is exact, and MCP reads have their startedAt
 *   A18.5 POST /view on an unlisted document without its key (anonymous or
 *         signed in, no key or a wrong one) is byte for byte the absent id's
 *         404 and counts nothing; a beat adds at most 5 min, and a lower,
 *         negative or non-numeric claim changes nothing
 *   A18.5 (session ceiling, LOCAL) a session's time stops at 8 h. Reaching
 *         it takes 96 real beats, seconds each on a shared emulator, so the
 *         Admin SDK sets a product-made session's stored time to 8 h − 2 min
 *         and the next beat must add only the 2 min left
 *
 * The only waits on time are the product's: a session registers
 * OPEN_DELAY_MS (2 s) after the document opens (app/src/stats.ts), which is
 * waited on as the condition it produces (stats.views moving), never slept.
 *
 * When the stack itself did not answer (the Hosting emulator's own 504 at its
 * 60 s cut-off, a client's deadline, the Admin SDK's), nothing was measured
 * and the case ends INCONCLUSIVE: lib/test.mjs's inconclusiveOnStackTimeout,
 * and for the cases with browser pages inconclusiveOnPageStall, which also
 * takes a wait that ran out while one of the case's pages saw the stack
 * stall. An assertion is never converted.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { randomBytes } from "node:crypto";
import { answered, currentTarget, precondition, scenario, stackDidNotAnswer } from "../../lib/test.mjs";
import { treeConstant } from "../../lib/target.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSessions } from "../../lib/session.mjs";
import { absentDocId, publish } from "../../lib/seed.mjs";
import { setVisibility, share, withVisibility } from "../../lib/grant.mjs";
import { adminFor, closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { eventually, sameBytes, sameHeadersExceptDate } from "../../lib/assert.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { finalBeatSettled, observeFinalBeacon } from "../../lib/reading-observation.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const HOUR = 60 * 60 * 1000;

/**
 * Every request's timeout, set once on each client (lib/http.mjs: "on a
 * contended shared stack one POST /publish has taken over 60 s"). Under the
 * shared stack's load a POST /access and an MCP get_document have each run
 * past the 60 s default; no case here asserts latency.
 */
const REQ_MS = 150_000;

/** How long a condition the product produces (a beat landing, a panel loading) may take to appear. */
const SETTLE_MS = 120_000;

/**
 * A page's own waits for the server (signing in, opening a document): past the
 * Hosting emulator's 60 s cut-off, so a slow answer ends in an answer or that
 * 504, never in the page helper's 45 s default (a POST /session on the shared
 * stack ran past it).
 */
const PAGE_MS = 120_000;

/**
 * POST /view through `http`. Hosting's 504 at its cut-off is the stack's,
 * never an answer to judge, so answered() throws it as E2E_STACK_CUTOFF; any
 * other answer, a quicker 504 included, is returned and judged.
 */
async function view(http, body) {
  return answered(await http.postJson("/view", body), "POST /view");
}

// LIB-REQUEST: window-close-cutoff — withVisibility's own close (grant.mjs
// closeWindow) sends POST /visibility private twice and then throws
// E2E_WINDOW_OPEN with no answer attached, so a case whose every oracle held
// FAILED when Hosting cut both off at 60 s (wr3h invocation
// 20261012T131901Z, A18.4), though the case's teardown closed the window a
// minute later. The block closes its own window here instead.
/**
 * withVisibility, with the window made private again as the block's last
 * step: POST /visibility private is idempotent, so it is sent again, up to
 * `closeAttempts` in all, while the stack does not answer it (Hosting's
 * cut-off 504, the client's deadline). Any other answer stands. When every
 * attempt is cut off, that is the block's failure (the case ends INCONCLUSIVE)
 * and withVisibility still closes the window, or the case's teardown does.
 */
function openWindow(ctx, opts, fn, { closeAttempts = 3 } = {}) {
  return withVisibility(target, { ...opts, timeoutMs: REQ_MS }, async (answer) => {
    const out = await fn(answer);
    for (let i = 1; ; i += 1) {
      try {
        await setVisibility(target, { owner: opts.owner, doc: opts.doc, visibility: "private", timeoutMs: REQ_MS });
        return out;
      } catch (err) {
        const why = stackDidNotAnswer(err);
        if (!why || i >= closeAttempts) throw err;
        ctx.step(`making ${opts.doc} private again: ${why}; sending it again (${i + 1} of ${closeAttempts})`);
      }
    }
  });
}

/**
 * The two server clamps recordView applies (functions/src/index.ts), read from
 * the tree the stack runs: functions/src/config.ts writes them as integer
 * products (`5 * 60 * 1000`, `8 * 60 * 60 * 1000`).
 *   MAX_BEAT_MS     the most one heartbeat may add
 *   MAX_SESSION_MS  the ceiling on one session's time
 */
const clamp = (name) => (target ? Number(treeConstant(target, "functions/src/config.ts", name, { product: true })) : NaN);
const MAX_BEAT_MS = clamp("MAX_BEAT_MS");
const MAX_SESSION_MS = clamp("MAX_SESSION_MS");

/** A clamp as the messages name it: "5 min", "8 h". */
const span = (ms) => (ms % HOUR === 0 ? `${ms / HOUR} h` : `${ms / 60_000} min`);

/** app/src/stats.ts OPEN_DELAY_MS: how long after the open a session registers. */
const OPEN_DELAY_MS = target ? Number(treeConstant(target, "app/src/stats.ts", "OPEN_DELAY_MS")) : 2_000;

/** The hint StatsPanel shows anyone who is not the owner or an editor. */
const DETAIL_HINT = "Only the owner and its editors can see who read this document.";

/** A sessionId the server accepts (/^[A-Za-z0-9_-]{8,64}$/, functions/src/index.ts SESSION_ID_RE). */
const sid = () => `a18-${randomBytes(10).toString("hex")}`;

const beatBody = (docId, sessionId, ms, extra = {}) => ({ docId, versionId: "v1", sessionId, ms, ...extra });

/** Accounts with open sessions (each has http, idToken, uid, account). */
async function castSessions(roles) {
  return openSessions(target, await cast(target, roles), { timeoutMs: REQ_MS });
}

function htmlDoc(title, body) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** Publish one innocuous HTML page as `owner`. */
async function publishPage(owner, name) {
  const title = `A18 ${name} ${runTag(target.runId)}-${rand4()}`;
  const html = htmlDoc(title, `<h1>${title}</h1>\n<p id="a18-p">A short page about bicycle sheds, published to count who reads it.</p>\n<p>${"Reading takes a while. ".repeat(40)}</p>`);
  const up = await publish(owner.http, { body: html, filename: "index.html", title, name: `a18-${name}` });
  precondition(up.versionId === "v1", `publish ${name}: ${up.status} ${JSON.stringify(up.json)}`);
  return { docId: up.docId, title };
}

/** A Firestore Timestamp as an exact, comparable string, or null when it is not one. */
function stamp(t) {
  return t && typeof t.toMillis === "function" ? `${t.seconds}.${String(t.nanoseconds).padStart(9, "0")}` : null;
}

async function statsOf(docId) {
  return (await readDoc(target, `docs/${docId}`))?.stats ?? {};
}

/** The human side of `stats`: what an automated read must never move (SPEC §17). */
function human(stats) {
  return {
    views: stats.views ?? 0,
    totalMs: stats.totalMs ?? 0,
    viewers: stats.viewers ?? 0,
    lastViewedAt: stamp(stats.lastViewedAt),
    lastViewedByEmail: stats.lastViewedByEmail ?? null,
  };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj?.[k]]));
}

/** Wait for `stats` to satisfy `pred`; returns them. */
function statsWhen(docId, pred, what) {
  return eventually(async () => {
    const s = await statsOf(docId);
    return pred(s) ? s : false;
  }, { timeout: SETTLE_MS, interval: 250, message: what }); // a beat has taken 20 s on a loaded shared emulator; no latency is asserted
}

/**
 * Open a document in `u`'s browser, wait for its reading session to register,
 * then leave with a full navigation, whose pagehide sends the final beat.
 * Returns the one session the visit made and the stats after the final beat.
 */
async function readInBrowser(ctx, u, docId, { k = null } = {}) {
  const openedAt = Date.now();
  await u.open(docId, { ...(k ? { k } : {}), timeout: PAGE_MS });
  ctx.step(`${u.name}: the clock registers the session ${OPEN_DELAY_MS} ms after the open (app/src/stats.ts); wait for stats.views to move`);
  const registered = await statsWhen(docId, (s) => (s.views ?? 0) > 0, `${u.name}'s reading session registered (stats.views moved)`);
  const sessions = await readCollection(target, `docs/${docId}/views`);
  const previousBeatMs = sessions[0]?.data?.lastBeatAt?.toMillis?.();
  precondition(sessions.length === 1 && Number.isFinite(previousBeatMs), "the single browser session is registered before leaving");
  const key = `e2e-final-beacon-${sessions[0].id}`;
  await u.page.evaluate(observeFinalBeacon, { docId, sessionId: sessions[0].id, key });
  ctx.step(`${u.name} leaves with a full navigation to /: observe its native final beacon, then wait for both stored records to agree`);
  await u.goto("/", { timeout: PAGE_MS });
  const leftAt = Date.now();
  const beacons = await u.page.evaluate((storageKey) => {
    const rows = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
    sessionStorage.removeItem(storageKey);
    return rows;
  }, key);
  ctx.ev.json(`${u.name}-final-beacons`, beacons);
  assert.ok(beacons.length > 0, "page exit sends a final reading beacon");
  assert.ok(beacons.every((b) => b.queued === true), "the native browser accepts each final reading beacon");
  const expectedMs = beacons.at(-1).payload.ms;
  precondition(expectedMs > 0 && expectedMs <= MAX_BEAT_MS, "this short visit's final beat is positive and inside the per-beat clamp");
  const observed = await eventually(async () => {
    const [final, session] = await Promise.all([
      statsOf(docId), readDoc(target, `docs/${docId}/views/${sessions[0].id}`),
    ]);
    return finalBeatSettled(final, session, { expectedMs, previousBeatMs })
      ? { final, session } : false;
  }, { timeout: SETTLE_MS, interval: 250, stableSamples: 3, message: `${u.name}'s captured final beat agrees with the session and aggregate` });
  return { registered, sessions, ...observed, sessionId: sessions[0].id, openFor: leftAt - openedAt };
}

// --- A18.1 --------------------------------------------------------------------

scenario("A18.1 a member's reading session counts one view, its active time is totalMs, viewers/{uid} rolls it up, a second visit is a second view of one identified viewer, and updatedAt is untouched", { tiers: ["local", "prod"], timeoutMs: 420_000, inconclusiveOnPageStall: true }, async (ctx) => {
  ctx.step("cast an owner and a viewer; the owner publishes a page and shares it with the viewer");
  const [owner, viewer] = await castSessions(["owner", "viewer"]);
  const email = viewer.account.email.toLowerCase();
  const D = await publishPage(owner, "member");
  await share(target, { owner, doc: D.docId, account: viewer.account, role: "viewer" });
  const before = await readDoc(target, `docs/${D.docId}`);
  precondition(stamp(before?.updatedAt), `docs/${D.docId}.updatedAt is a timestamp before any read`);
  const h0 = human(before.stats ?? {});
  precondition(h0.views === 0 && h0.totalMs === 0 && h0.viewers === 0, `a fresh document has no reading stats: ${JSON.stringify(h0)}`);

  ctx.step("the viewer signs in through the UI and reads the document in the browser");
  const v = await ctx.users.user({ name: "viewer" });
  await v.signInUi(viewer.account.email, viewer.account.password, { timeout: PAGE_MS });
  const visit = await readInBrowser(ctx, v, D.docId);
  assert.equal(visit.registered.views, 1, "the open counted one view");
  assert.equal(visit.sessions.length, 1, `one open is one session: ${visit.sessions.map((s) => s.id).join(", ")}`);
  const S = visit.session;
  assert.deepEqual(
    pick(S, ["uid", "email", "versionId", "via", "automated"]),
    { uid: viewer.uid, email, versionId: "v1", via: "app", automated: false },
    "the session is the viewer's, a person's, read as a member",
  );
  assert.ok(S.ms >= OPEN_DELAY_MS && S.ms <= visit.openFor, `the session's active time lies between the open delay and how long the page was open: ms=${S.ms}, open ${visit.openFor} ms`);

  ctx.step("stats and viewers/{uid} after the final beat");
  assert.deepEqual(
    { ...pick(visit.final, ["views", "totalMs", "viewers"]), lastViewedByEmail: visit.final.lastViewedByEmail ?? null },
    { views: 1, totalMs: S.ms, viewers: 1, lastViewedByEmail: null },
    "stats: one view, the session's active time, one identified viewer",
  );
  const row = await readDoc(target, `docs/${D.docId}/viewers/${viewer.uid}`);
  assert.deepEqual(pick(row, ["uid", "email", "views", "totalMs"]), { uid: viewer.uid, email, views: 1, totalMs: S.ms }, "viewers/{uid} rolls the session up");
  assert.ok(stamp(row.firstViewedAt) && stamp(row.lastViewedAt), "viewers/{uid} stamps its first and last view");

  ctx.step("a second visit by the same person: POST /view with a new session, 0 then 1500 ms, as the clock sends it");
  const sid2 = sid();
  const b1 = await view(viewer.http, beatBody(D.docId, sid2, 0));
  assert.deepEqual([b1.status, b1.json], [200, { ms: 0 }], "the registering beat");
  const b2 = await view(viewer.http, beatBody(D.docId, sid2, 1500));
  assert.deepEqual([b2.status, b2.json], [200, { ms: 1500 }], "the next beat reports the session's absolute time");
  const s2 = await statsOf(D.docId);
  assert.deepEqual(pick(s2, ["views", "totalMs", "viewers"]), { views: 2, totalMs: S.ms + 1500, viewers: 1 }, "a second view, the second session's time added, still one identified viewer");
  const row2 = await readDoc(target, `docs/${D.docId}/viewers/${viewer.uid}`);
  assert.deepEqual(pick(row2, ["views", "totalMs"]), { views: 2, totalMs: S.ms + 1500 }, "viewers/{uid} counts both visits and both times");
  assert.equal(stamp(row2.firstViewedAt), stamp(row.firstViewedAt), "firstViewedAt is kept");

  ctx.step("updatedAt and currentVersion are exactly what the publish wrote (SPEC §4: a read must not masquerade as a publish)");
  const afterDoc = await readDoc(target, `docs/${D.docId}`);
  assert.deepEqual(
    { updatedAt: stamp(afterDoc.updatedAt), currentVersion: afterDoc.currentVersion },
    { updatedAt: stamp(before.updatedAt), currentVersion: before.currentVersion },
    "recordView left updatedAt and currentVersion alone",
  );
});

// --- A18.2 --------------------------------------------------------------------

scenario("A18.2 anonymous readers are counted, never identified: uid and email null, views and totalMs counted on an unlisted link (browser) and a public page (HTTP), no viewers/{uid}", { tiers: ["local", "prod"], timeoutMs: 420_000, inconclusiveOnPageStall: true }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const U = await publishPage(owner, "anon-link");
  const P = await publishPage(owner, "anon-public");

  ctx.step("the owner makes one page unlisted; an anonymous browser opens /d/<doc>?k=<key>");
  await openWindow(ctx, { owner, doc: U.docId, visibility: "unlisted" }, async ({ linkToken: k }) => {
    precondition(typeof k === "string" && k.length >= 22, `link token: ${k}`);
    const before = await readDoc(target, `docs/${U.docId}`);
    precondition(stamp(before?.updatedAt), "updatedAt is a timestamp before any read");
    const h0 = human(before.stats ?? {});
    precondition(h0.views === 0 && h0.totalMs === 0, `a fresh document has no reading stats: ${JSON.stringify(h0)}`);

    const a = await ctx.users.user({ name: "anonymous" });
    const visit = await readInBrowser(ctx, a, U.docId, { k });
    assert.equal(visit.registered.views, 1, "the anonymous open counted one view");
    assert.equal(visit.sessions.length, 1, `one open is one session: ${visit.sessions.map((s) => s.id).join(", ")}`);
    const S = visit.session;
    assert.deepEqual(
      { ...pick(S, ["uid", "email", "versionId", "via", "automated"]), hasActor: "actor" in S },
      { uid: null, email: null, versionId: "v1", via: "unlisted", automated: false, hasActor: false },
      "the session names nobody, and was read through the link",
    );
    assert.ok(S.ms >= OPEN_DELAY_MS && S.ms <= visit.openFor, `the anonymous session's active time: ms=${S.ms}, open ${visit.openFor} ms`);
    assert.deepEqual(
      { ...pick(visit.final, ["views", "totalMs", "viewers"]), lastViewedByEmail: visit.final.lastViewedByEmail ?? null },
      { views: 1, totalMs: S.ms, viewers: 0, lastViewedByEmail: null },
      "an anonymous visit counts a view and its time, and identifies no viewer",
    );
    const rows = await readCollection(target, `docs/${U.docId}/viewers`);
    assert.deepEqual(rows.map((r) => r.id), [], "no viewers/{uid} for an anonymous reader");
    assert.equal(stamp((await readDoc(target, `docs/${U.docId}`)).updatedAt), stamp(before.updatedAt), "updatedAt untouched");
  });

  ctx.step("a public page: an anonymous POST /view with no key, 0 then 2500 ms");
  await openWindow(ctx, { owner, doc: P.docId, visibility: "public" }, async () => {
    const anon = ctx.http({ actor: "anonymous", timeoutMs: REQ_MS });
    const sidP = sid();
    const r1 = await view(anon, beatBody(P.docId, sidP, 0));
    assert.deepEqual([r1.status, r1.json], [200, { ms: 0 }], "the anonymous registering beat on a public page");
    const r2 = await view(anon, beatBody(P.docId, sidP, 2500));
    assert.deepEqual([r2.status, r2.json], [200, { ms: 2500 }], "the anonymous beat's absolute time");
    const s = await statsOf(P.docId);
    assert.deepEqual(
      { ...pick(s, ["views", "totalMs", "viewers"]), lastViewedByEmail: s.lastViewedByEmail ?? null },
      { views: 1, totalMs: 2500, viewers: 0, lastViewedByEmail: null },
      "counted, never identified",
    );
    const S = await readDoc(target, `docs/${P.docId}/views/${sidP}`);
    assert.deepEqual(pick(S, ["uid", "email", "via", "automated", "ms"]), { uid: null, email: null, via: "public", automated: false, ms: 2500 }, "the public session names nobody");
    assert.deepEqual((await readCollection(target, `docs/${P.docId}/viewers`)).map((r) => r.id), [], "no viewers/{uid}");
  });
});

// --- A18.3 --------------------------------------------------------------------

scenario("A18.3 automated reads count only into stats.apiReads with ms 0: MCP get_document and a cli token's POST /view leave views, totalMs and viewers alone, while a person's beat on the same document counts", { tiers: ["local", "prod"], timeoutMs: 360_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const D = await publishPage(owner, "api-reads");
  const before = await readDoc(target, `docs/${D.docId}`);
  precondition(stamp(before?.updatedAt), "updatedAt is a timestamp before any read");
  const h0 = human(before.stats ?? {});
  precondition(h0.views === 0 && h0.totalMs === 0 && h0.viewers === 0 && !(before.stats?.apiReads), `a fresh document has no reading stats: ${JSON.stringify(before.stats ?? {})}`);

  ctx.step("an mcp token's get_document, twice");
  const mcpTok = await mintToken(owner, { name: "e2e a18 mcp", channel: "mcp" });
  const mcp = ctx.mcp({ token: mcpTok.token, actor: "owner-mcp", timeoutMs: REQ_MS });
  await mcp.initialize();
  const apiSid = `api-${mcpTok.tokenId}-v1`; // functions/src/mcp/tools.ts recordApiRead
  for (const n of [1, 2]) {
    const got = await mcp.ok("get_document", { id: D.docId });
    precondition(got.id === D.docId && got.version === "v1", `get_document ${n}: ${JSON.stringify({ id: got.id, version: got.version })}`);
    const s = await statsOf(D.docId);
    assert.equal(s.apiReads, n, `get_document #${n}: stats.apiReads`);
    assert.deepEqual(human(s), h0, `get_document #${n} moved no human number`);
    const sessions = await readCollection(target, `docs/${D.docId}/views`);
    assert.deepEqual(sessions.map((x) => x.id), [apiSid], `get_document #${n}: the token's one session for v1`);
    const A = sessions[0].data;
    assert.deepEqual(
      { uid: A.uid, versionId: A.versionId, ms: A.ms, automated: A.automated, channel: A.actor?.channel, tokenId: A.actor?.tokenId, reads: A.reads },
      { uid: owner.uid, versionId: "v1", ms: 0, automated: true, channel: "mcp", tokenId: mcpTok.tokenId, reads: n },
      `get_document #${n}: an automated session with ms 0`,
    );
  }

  ctx.step("a cli token's POST /view, claiming 50 s and then 90 s of reading");
  const cliTok = await mintToken(owner, { name: "e2e a18 cli", channel: "cli" });
  const bot = ctx.http({ actor: "owner-cli", headers: { authorization: `Bearer ${cliTok.token}` }, timeoutMs: REQ_MS });
  const sidC = sid();
  const c1 = await view(bot, beatBody(D.docId, sidC, 50_000));
  assert.deepEqual([c1.status, c1.json], [200, { ms: 0 }], "an automated beat is recorded with ms 0, whatever it claims");
  const c2 = await view(bot, beatBody(D.docId, sidC, 90_000));
  assert.deepEqual([c2.status, c2.json], [200, { ms: 0 }], "and so is its next beat");
  const sc = await statsOf(D.docId);
  assert.equal(sc.apiReads, 3, "the token's session is one more automated read; its second beat adds none");
  assert.deepEqual(human(sc), h0, "an automated POST /view moved no human number");
  const C = await readDoc(target, `docs/${D.docId}/views/${sidC}`);
  assert.deepEqual(
    { uid: C.uid, ms: C.ms, automated: C.automated, channel: C.actor?.channel, tokenId: C.actor?.tokenId, via: C.via },
    { uid: owner.uid, ms: 0, automated: true, channel: "cli", tokenId: cliTok.tokenId, via: "app" },
    "the token's session: automated, ms 0",
  );
  assert.deepEqual((await readCollection(target, `docs/${D.docId}/viewers`)).map((r) => r.id), [], "no automated read made a viewers/{uid} row");

  ctx.step("positive control: the owner's own session (the web channel) on the same document, 0 then 1200 ms, does count");
  const sidH = sid();
  assert.deepEqual([(await view(owner.http, beatBody(D.docId, sidH, 0))).status], [200]);
  const h2 = await view(owner.http, beatBody(D.docId, sidH, 1200));
  assert.deepEqual([h2.status, h2.json], [200, { ms: 1200 }], "a person's beat keeps its time");
  const sh = await statsOf(D.docId);
  assert.deepEqual(pick(sh, ["views", "totalMs", "viewers", "apiReads"]), { views: 1, totalMs: 1200, viewers: 1, apiReads: 3 }, "the human numbers move for a person, apiReads does not");
  assert.deepEqual((await readCollection(target, `docs/${D.docId}/viewers`)).map((r) => r.id), [owner.uid], "the person is the one identified viewer");
  assert.equal(stamp((await readDoc(target, `docs/${D.docId}`)).updatedAt), stamp(before.updatedAt), "updatedAt untouched by every read");
});

// --- A18.4 --------------------------------------------------------------------

/** More actions → its labels; with Activity among them, open it and read the panel once it settles. */
async function openActivity(u, { labelsOnly = false } = {}) {
  await u.page.locator('.viewer-toolbar [aria-label="More actions"]').first().click();
  const menu = u.page.getByRole("menu", { name: "More actions" });
  await menu.waitFor({ state: "visible", timeout: 15_000 });
  const labels = (await menu.getByRole("menuitem").allTextContents()).map((s) => s.trim());
  if (labelsOnly || !labels.includes("Activity")) {
    await u.page.keyboard.press("Escape");
    return { labels, panel: null, dialog: null };
  }
  await menu.getByRole("menuitem", { name: "Activity", exact: true }).click();
  const dialog = u.page.getByRole("dialog", { name: /^Activity on / });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  // The readers arrive through three Firestore queries on the SDK's Listen
  // channel; a shared emulator under load has held that channel's POST for
  // ~19 s. Nothing here is about latency, so the wait is generous.
  await u.poll(
    async () => (await dialog.getByText(DETAIL_HINT, { exact: true }).count()) > 0 || (await dialog.getByRole("heading", { name: "Readers", exact: true }).count()) > 0,
    { timeout: SETTLE_MS, interval: 250, what: "the Activity panel settled (the hint, or the readers loaded)" },
  );
  const panel = await dialog.evaluate((el) => {
    const h3 = [...el.querySelectorAll("h3")];
    const readersHeading = h3.find((h) => h.textContent.trim() === "Readers");
    const list = readersHeading?.nextElementSibling ?? null;
    return {
      headings: h3.map((h) => h.textContent.trim()),
      readers: readersHeading ? [...(list?.querySelectorAll("li.activity-row") ?? [])].map((li) => li.querySelector("span")?.textContent.trim() ?? "") : null,
      tiles: [...el.querySelectorAll(".stat-tile")].map((t) => ({ value: t.querySelector(".stat-value")?.textContent.trim(), label: t.querySelector(".stat-label")?.textContent.trim() })),
      text: el.innerText,
    };
  });
  return { labels, panel, dialog };
}

const SURFACES = ["list viewers", "list views", "list acl", "get viewers/{viewer}"];

/** Each surface's rules verdict for one identity (an ID token, or null for anonymous). */
async function detailVerdicts(ctx, who, idTokenValue, docId, viewerUid) {
  const fs = clientFirestore(target, { idToken: idTokenValue, http: ctx.http({ actor: `${who}-fs`, timeoutMs: REQ_MS }) });
  const r = {
    "list viewers": await fs.list(`docs/${docId}/viewers`, { pageSize: 20 }),
    "list views": await fs.list(`docs/${docId}/views`, { pageSize: 20 }),
    "list acl": await fs.list(`docs/${docId}/acl`, { pageSize: 20 }),
    "get viewers/{viewer}": await fs.get(`docs/${docId}/viewers/${viewerUid}`),
  };
  return {
    verdicts: Object.fromEntries(SURFACES.map((s) => [s, r[s].verdict ?? `${r[s].status} ${r[s].code}`])),
    viewerIds: (r["list viewers"].docs ?? []).map((d) => d.id),
  };
}

scenario("A18.4 the Activity panel's per-person detail is for the owner and editors only: rules refuse viewers, views and acl to a viewer, a suggester, an open editor and anonymous; the panel lists readers for the owner and an editor, only the aggregate for a viewer, and nothing for an open editor", { tiers: ["local", "prod"], timeoutMs: 720_000, inconclusiveOnPageStall: true }, async (ctx) => {
  ctx.step("cast an owner, editor, approver, viewer, suggester and a stranger; publish; share four roles");
  const [owner, editor, approver, viewer, suggester, stranger] = await castSessions(["owner", "editor", "approver", "viewer", "suggester", "stranger"]);
  const D = await publishPage(owner, "activity");
  for (const [s, role] of [[editor, "editor"], [approver, "approver"], [viewer, "viewer"], [suggester, "suggester"]]) {
    await share(target, { owner, doc: D.docId, account: s.account, role });
  }

  ctx.step("the viewer and the editor each read it once (POST /view, 0 then 1200 ms), so there are rows to see");
  for (const s of [viewer, editor]) {
    const id = sid();
    precondition((await view(s.http, beatBody(D.docId, id, 0))).status === 200, `${s.account.role}'s first beat`);
    precondition((await view(s.http, beatBody(D.docId, id, 1200))).status === 200, `${s.account.role}'s second beat`);
  }
  precondition((await readCollection(target, `docs/${D.docId}/viewers`)).length === 2, "two viewers/{uid} rows to protect");

  ctx.step("rules: list viewers, views and acl, and get the viewer's own row, through the Firestore REST API as each identity");
  const ALLOW = Object.fromEntries(SURFACES.map((s) => [s, "ALLOW"]));
  const DENY = Object.fromEntries(SURFACES.map((s) => [s, "DENY"]));
  const got = {};
  const ids = {};
  for (const [who, s] of [["owner", owner], ["editor", editor], ["approver", approver], ["viewer", viewer], ["suggester", suggester]]) {
    const r = await detailVerdicts(ctx, who, s.idToken, D.docId, viewer.uid);
    got[who] = r.verdicts;
    ids[who] = r.viewerIds.sort();
  }
  got.anonymous = (await detailVerdicts(ctx, "anonymous", null, D.docId, viewer.uid)).verdicts;
  assert.deepEqual(
    got,
    { owner: ALLOW, editor: ALLOW, approver: ALLOW, viewer: DENY, suggester: DENY, anonymous: DENY },
    "the per-person detail: owner, editor and approver read it; viewer, suggester and anonymous are refused",
  );
  const both = [viewer.uid, editor.uid].sort();
  for (const who of ["owner", "editor", "approver"]) assert.deepEqual(ids[who], both, `${who}'s list holds the two readers' rows`);

  ctx.step("UI: the owner, the editor and the viewer each sign in, open the document and choose More actions → Activity");
  const [uo, ue, uv] = await Promise.all(["owner", "editor", "viewer"].map((name) => ctx.users.user({ name })));
  await Promise.all([[uo, owner], [ue, editor], [uv, viewer]].map(([u, s]) => u.signInUi(s.account.email, s.account.password, { timeout: PAGE_MS })));
  await Promise.all([uo, ue, uv].map((u) => u.open(D.docId, { timeout: PAGE_MS })));
  const members = new Set([owner, editor, viewer].map((s) => s.account.email.toLowerCase()));
  for (const [u, s] of [[uo, owner], [ue, editor]]) {
    const { labels, panel } = await openActivity(u);
    assert.ok(labels.includes("Activity"), `${u.name}: More actions offers Activity (${labels.join(" | ")})`);
    assert.ok(panel.readers, `${u.name}: the panel lists readers (headings ${JSON.stringify(panel.headings)}; text ${JSON.stringify(panel.text.slice(0, 200))})`);
    const shown = new Set(panel.readers);
    assert.ok(shown.has(viewer.account.email.toLowerCase()) && shown.has(editor.account.email.toLowerCase()), `${u.name}: the readers include the viewer and the editor: ${panel.readers.join(", ")}`);
    assert.ok(panel.readers.every((e) => members.has(e)), `${u.name}: every reader listed is somebody who read it: ${panel.readers.join(", ")}`);
    assert.equal(panel.tiles[0]?.label, `visits · ${panel.readers.length} identified`, `${u.name}: the visits tile says how many are identified`);
    assert.ok(!panel.text.includes(DETAIL_HINT), `${u.name}: no "only editors" hint for ${s.account.role}`);
    await u.page.keyboard.press("Escape");
  }
  const vp = await openActivity(uv);
  assert.ok(vp.labels.includes("Activity"), `viewer: More actions offers Activity, for the aggregate (${vp.labels.join(" | ")})`);
  assert.deepEqual(
    { readers: vp.panel.readers, headings: vp.panel.headings, visitsLabel: vp.panel.tiles[0]?.label, hint: vp.panel.text.includes(DETAIL_HINT) },
    { readers: null, headings: [], visitsLabel: "visits", hint: true },
    "viewer: the aggregate and the hint, no readers, no activity",
  );
  for (const s of [owner, editor]) assert.ok(!vp.panel.text.toLowerCase().includes(s.account.email.toLowerCase()), `viewer's panel names nobody (found ${s.account.role}'s address)`);
  await eventually(async () => {
    const value = (await vp.dialog.locator(".stat-tile .stat-value").first().textContent())?.trim();
    const views = (await statsOf(D.docId)).views ?? 0;
    return value === String(views) ? value : false;
  }, { timeout: SETTLE_MS, interval: 250, stableSamples: 2, message: "the viewer's visits tile shows the document's stats.views" });

  ctx.step("open editing: the owner makes it public with publicEdit; the stranger may edit it but is not its editor");
  await openWindow(ctx, { owner, doc: D.docId, visibility: "public", publicEdit: true }, async () => {
    const rec = await readDoc(target, `docs/${D.docId}`);
    precondition(rec.visibility === "public" && rec.publicEdit === true, `public with open editing: ${JSON.stringify(pick(rec, ["visibility", "publicEdit"]))}`);
    const pe = (await detailVerdicts(ctx, "stranger", stranger.idToken, D.docId, viewer.uid)).verdicts;
    const an = (await detailVerdicts(ctx, "anonymous", null, D.docId, viewer.uid)).verdicts;
    assert.deepEqual({ stranger: pe, anonymous: an }, { stranger: DENY, anonymous: DENY }, "open editing on a public document hands a stranger nobody's reading history (SPEC §17)");

    ctx.step("UI: the stranger signs in and opens it: More actions has no Activity entry");
    const ux = await ctx.users.user({ name: "stranger" });
    await ux.signInUi(stranger.account.email, stranger.account.password, { timeout: PAGE_MS });
    await ux.open(D.docId, { timeout: PAGE_MS });
    const xp = await openActivity(ux, { labelsOnly: true });
    assert.ok(xp.labels.length > 0 && !xp.labels.includes("Activity"), `an open editor's More actions: ${xp.labels.join(" | ")}`);
  });
});

// --- A18.4, who read it last --------------------------------------------------------

/** Reading identities are editor-only; the member-readable rollup is aggregate (SPEC §4, §17). */
scenario("A18.4 (who read it last) the document record a viewer may read names none of its readers: stats.lastViewedByEmail is the per-person detail the Activity panel withholds from a viewer", { tiers: ["local", "prod"], timeoutMs: 300_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const [owner, editor, viewer] = await castSessions(["owner", "editor", "viewer"]);
  const D = await publishPage(owner, "last-reader");
  await share(target, { owner, doc: D.docId, account: editor.account, role: "editor" });
  await share(target, { owner, doc: D.docId, account: viewer.account, role: "viewer" });
  const fs = clientFirestore(target, { idToken: viewer.idToken, http: ctx.http({ actor: "viewer-fs", timeoutMs: REQ_MS }) });
  const recordAsViewer = async () => {
    const r = await fs.get(`docs/${D.docId}`);
    precondition(r.verdict === "ALLOW", `a member reads the document record (as the app's watchDoc does): ${r.status} ${r.code}`);
    return r.doc.data.stats ?? {};
  };

  ctx.step("before anyone reads it, the viewer's read of the record names no reader (the oracle can pass)");
  const unread = await recordAsViewer();
  precondition((unread.lastViewedByEmail ?? null) === null, `an unread document names no reader: stats.lastViewedByEmail ${JSON.stringify(unread.lastViewedByEmail)}`);

  ctx.step("the editor reads it once (POST /view); the viewer is still refused the per-person detail");
  precondition((await view(editor.http, beatBody(D.docId, sid(), 0))).status === 200, "the editor's beat");
  precondition((await fs.list(`docs/${D.docId}/viewers`)).verdict === "DENY", "the viewer may not list viewers/{uid} (A18.4)");

  ctx.step("the viewer reads the document record again: the aggregate without a reading identity");
  const stats = await recordAsViewer();
  precondition(stats.views === 1, `the viewer sees the aggregate: views ${stats.views}`);
  ctx.step(`stats keys the viewer receives: ${Object.keys(stats).sort().join(", ")}`);
  assert.equal(Object.hasOwn(stats, "lastViewedByEmail"), false, "member-readable stats never reveal the last reader's email");
  const history = await readDoc(target, `docs/${D.docId}/viewers/${editor.uid}`);
  assert.equal(history.email, editor.account.email.toLowerCase(), "editor-gated history retains the reader's identity");
});

// --- A18.4, the automation filter ---------------------------------------------------

/** The panel's Recent activity rows under one filter (Everything, People, Automation). */
async function activityRows(dialog, filter) {
  await dialog.getByRole("button", { name: filter, exact: true }).click();
  await dialog.getByRole("button", { name: filter, exact: true, pressed: true }).waitFor({ state: "visible", timeout: 10_000 });
  return dialog.evaluate((el) => {
    const lists = el.querySelectorAll("ul.activity-feed");
    const feed = lists[lists.length - 1];
    return [...(feed?.querySelectorAll("li.activity-row") ?? [])].map((li) => ({
      who: li.querySelector("span")?.textContent.trim() ?? null,
      badge: li.querySelector(".badge-automated")?.textContent.trim() ?? null,
      caption: li.querySelector(".caption")?.textContent.trim() ?? null,
    }));
  });
}

/**
 * X-a18-stats-3. SPEC §17: "The stats panel shows both and filters to
 * human-only or automation-only." The panel lists sessions ordered by
 * `startedAt` (app/src/firestore.ts:317), and a Firestore orderBy leaves out
 * every document without the field; recordApiRead, which records every MCP
 * get_document, never writes it (functions/src/mcp/tools.ts:403-417), while
 * recordView does (functions/src/index.ts:2225). So the owner's Automation
 * filter shows a token's POST /view and never an agent's MCP read.
 */
scenario("A18.4 (automation filter) the owner's Activity panel lists an MCP get_document under Automation, beside a token's POST /view", { tiers: ["local", "prod"], timeoutMs: 360_000, inconclusiveOnPageStall: true }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const email = owner.account.email.toLowerCase();
  const D = await publishPage(owner, "automation-feed");

  ctx.step("an mcp token reads the document (get_document); a cli token posts a view");
  const mcpTok = await mintToken(owner, { name: "e2e a18 feed mcp", channel: "mcp" });
  const mcp = ctx.mcp({ token: mcpTok.token, actor: "owner-mcp", timeoutMs: REQ_MS });
  await mcp.initialize();
  precondition((await mcp.ok("get_document", { id: D.docId })).id === D.docId, "get_document read the document");
  const cliTok = await mintToken(owner, { name: "e2e a18 feed cli", channel: "cli" });
  const bot = ctx.http({ actor: "owner-cli", headers: { authorization: `Bearer ${cliTok.token}` }, timeoutMs: REQ_MS });
  precondition((await view(bot, beatBody(D.docId, sid(), 0))).status === 200, "the cli token's POST /view");
  const stored = await readCollection(target, `docs/${D.docId}/views`);
  const channels = stored.map((x) => x.data.actor?.channel).sort();
  precondition(JSON.stringify(channels) === JSON.stringify(["cli", "mcp"]), `both automated sessions are stored: ${JSON.stringify(channels)}`);
  const mcpSession = stored.find((x) => x.data.actor?.channel === "mcp");
  ctx.step(`the MCP session's fields: ${Object.keys(mcpSession.data).sort().join(", ")}`);

  ctx.step("a human reading session is also present, so both filters must exclude the other kind");
  const humanSession = sid();
  precondition((await view(owner.http, beatBody(D.docId, humanSession, 0))).status === 200, "the person's POST /view");

  ctx.step("the owner signs in, opens the document, chooses More actions → Activity, then Automation");
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(owner.account.email, owner.account.password, { timeout: PAGE_MS });
  await u.open(D.docId, { timeout: PAGE_MS });
  const { panel, dialog } = await openActivity(u);
  precondition(panel?.readers, "the owner sees the per-person detail");
  const rows = await activityRows(dialog, "Automation");
  ctx.step(`Automation rows: ${JSON.stringify(rows)}`);
  // Each badge names the token, in the words the server stored when it acted (ADR 0023).
  const CLI_BADGE = "via CLI token “e2e a18 feed cli”";
  const MCP_BADGE = "via personal token “e2e a18 feed mcp”";
  precondition(rows.some((r) => r.badge === CLI_BADGE && r.who === email), `positive control: the token's POST /view is listed under Automation: ${JSON.stringify(rows)}`);
  assert.ok(rows.some((r) => r.badge === MCP_BADGE && r.who === email), `the Automation filter lists no MCP read, though one is stored (a session without startedAt): ${JSON.stringify(rows)}`);
  assert.ok(rows.every((r) => r.badge === MCP_BADGE || r.badge === CLI_BADGE), "Automation excludes human activity");
  const apiReads = (await statsOf(D.docId)).apiReads;
  precondition(apiReads === 2, "the two automated reads are recorded before inspecting their tile");
  const automationTile = dialog.locator(".stat-tile").filter({ hasText: "automated reads" });
  assert.equal((await automationTile.locator(".stat-value").textContent())?.trim(), String(apiReads), "the automated reads tile equals stats.apiReads");
  const people = await activityRows(dialog, "People");
  assert.ok(people.length > 0 && people.every((r) => !r.badge), "People excludes automated activity and includes the human session");
});

// --- A18.5 --------------------------------------------------------------------

/** A key of the same shape that is not the document's. */
function wrongKey(k) {
  const last = k.slice(-1) === "A" ? "B" : "A";
  return `${k.slice(0, -1)}${last}`;
}

scenario("A18.5 POST /view on an unlisted document without its key is the absent id's 404 and counts nothing; a beat adds at most 5 min, and a lower, negative or non-numeric claim changes nothing", { tiers: ["local", "prod"], timeoutMs: 540_000, inconclusiveOnStackTimeout: true }, async (ctx) => {
  const [owner, stranger] = await castSessions(["owner", "stranger"]);
  const U = await publishPage(owner, "keyless");
  const absent = absentDocId(target, "a18-absent");
  const anon = ctx.http({ actor: "anonymous", timeoutMs: REQ_MS });

  await openWindow(ctx, { owner, doc: U.docId, visibility: "unlisted" }, async ({ linkToken: k }) => {
    precondition(typeof k === "string" && k.length >= 22, `link token: ${k}`);
    const before = await readDoc(target, `docs/${U.docId}`);
    const h0 = human(before.stats ?? {});

    ctx.step("the absent id's answer, to compare with");
    const ref = await view(anon, beatBody(absent, sid(), 1000));
    precondition(ref.status === 404, `POST /view on an absent id: ${ref.status}`);

    ctx.step("no key, or a wrong one, anonymous and signed in");
    const probeIds = {};
    const probe = async (label, http, extra) => {
      probeIds[label] = sid();
      return view(http, beatBody(U.docId, probeIds[label], 1000, extra));
    };
    const answers = {
      "anonymous, no k": await probe("anonymous, no k", anon),
      "anonymous, wrong k": await probe("anonymous, wrong k", anon, { k: wrongKey(k) }),
      "signed-in stranger, no k": await probe("signed-in stranger, no k", stranger.http),
      "signed-in stranger, wrong k": await probe("signed-in stranger, wrong k", stranger.http, { k: wrongKey(k) }),
    };
    for (const [label, r] of Object.entries(answers)) {
      assert.equal(r.status, 404, `${label}: ${r.status} ${r.text.slice(0, 120)}`);
      assert.ok(sameBytes(r.buffer, ref.buffer).equal, `${label}: the body is the absent id's, byte for byte`);
      const h = sameHeadersExceptDate(r, ref);
      assert.ok(h.equal, `${label}: the headers are the absent id's: ${JSON.stringify(h.diff)}`);
    }

    ctx.step("nothing was counted: no session, no viewer, no stats, no grant");
    for (const [label, id] of Object.entries(probeIds)) assert.equal(await readDoc(target, `docs/${U.docId}/views/${id}`), null, `${label}: no session recorded`);
    assert.deepEqual((await readCollection(target, `docs/${U.docId}/views`)).map((r) => r.id), [], "no view sessions at all");
    assert.deepEqual((await readCollection(target, `docs/${U.docId}/viewers`)).map((r) => r.id), [], "no viewers/{uid}");
    assert.deepEqual(human(await statsOf(U.docId)), h0, "stats unchanged");
    assert.equal(await readDoc(target, `docs/${U.docId}/linkGrants/${stranger.uid}`), null, "a refused view grants nothing");

    ctx.step("positive control: the same anonymous beat WITH the key is counted");
    const sidK = sid();
    const ok = await view(anon, beatBody(U.docId, sidK, 0, { k }));
    assert.deepEqual([ok.status, ok.json], [200, { ms: 0 }], "anonymous with the key");
    assert.equal((await statsOf(U.docId)).views, h0.views + 1, "the keyed view counted");
  });

  ctx.step("clamps, on the owner's own session (the document is private again)");
  precondition((await readDoc(target, `docs/${U.docId}`))?.visibility === "private", "withVisibility made the document private again");
  precondition(MAX_BEAT_MS < 10 * HOUR, `a 10-hour claim is past one beat's clamp: MAX_BEAT_MS ${MAX_BEAT_MS}`);
  const h1 = human(await statsOf(U.docId));
  const sidX = sid();
  const beatX = async (ms, label) => {
    const r = await view(owner.http, beatBody(U.docId, sidX, ms));
    precondition(r.status === 200, `${label}: ${r.status} ${r.text.slice(0, 120)}`);
    return r.json?.ms;
  };
  assert.equal(await beatX(0, "registering beat"), 0, "the registering beat");
  assert.equal(await beatX(10 * HOUR, "a 10-hour claim"), MAX_BEAT_MS, `a beat claiming 10 h adds MAX_BEAT_MS (${span(MAX_BEAT_MS)}), no more`);
  let s = await statsOf(U.docId);
  assert.deepEqual(pick(s, ["views", "totalMs"]), { views: h1.views + 1, totalMs: h1.totalMs + MAX_BEAT_MS }, "stats took the clamped delta");
  for (const [claim, label] of [[1000, "a lower (reordered) claim"], [-60_000, "a negative claim"], ["36000000", "a non-numeric claim"], [MAX_BEAT_MS, "a duplicate of the last beat"]]) {
    assert.equal(await beatX(claim, label), MAX_BEAT_MS, `${label} leaves the session at ${MAX_BEAT_MS}`);
  }
  s = await statsOf(U.docId);
  assert.deepEqual(pick(s, ["views", "totalMs"]), { views: h1.views + 1, totalMs: h1.totalMs + MAX_BEAT_MS }, "none of them moved stats");

  const row = await readDoc(target, `docs/${U.docId}/viewers/${owner.uid}`);
  assert.deepEqual(pick(row, ["views", "totalMs"]), { views: 1, totalMs: MAX_BEAT_MS }, "viewers/{uid} took the same clamped time");
});

// --- A18.5, the session ceiling -------------------------------------------------

scenario("A18.5 (session ceiling) a session's time stops at MAX_SESSION_MS (8 h): a beat near it adds only what is left, and the next adds nothing", {
  tiers: ["local"],
  needs: ["admin-emulator"],
  timeoutMs: 240_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const D = await publishPage(owner, "ceiling");
  const sidX = sid();
  const beatX = async (ms, label) => {
    const r = await view(owner.http, beatBody(D.docId, sidX, ms));
    precondition(r.status === 200, `${label}: ${r.status} ${r.text.slice(0, 120)}`);
    return r.json?.ms;
  };
  ctx.step("the owner's registering beat creates the session, as the product does");
  precondition((await beatX(0, "registering beat")) === 0, "the registering beat answers ms 0");
  const LEFT = 2 * 60 * 1000;
  precondition(LEFT < MAX_BEAT_MS && MAX_SESSION_MS < 10 * HOUR, `the probe needs what is left below one beat's clamp and a 10-hour claim past the ceiling: MAX_BEAT_MS ${MAX_BEAT_MS}, MAX_SESSION_MS ${MAX_SESSION_MS}`);
  ctx.step(`stand in for ${(MAX_SESSION_MS - LEFT) / MAX_BEAT_MS | 0} beats of ${span(MAX_BEAT_MS)}: the Admin SDK sets the session's stored ms to ${span(MAX_SESSION_MS)} − 2 min (on a shared emulator each real beat takes seconds, and that many do not fit a case)`);
  await adminFor(target).db.doc(`docs/${D.docId}/views/${sidX}`).update({ ms: MAX_SESSION_MS - LEFT });
  const s0 = await statsOf(D.docId);
  const r0 = await readDoc(target, `docs/${D.docId}/viewers/${owner.uid}`);

  ctx.step(`a beat claiming 10 h: the session reaches ${span(MAX_SESSION_MS)}, adding only the 2 min that were left`);
  assert.equal(await beatX(10 * HOUR, "a 10-hour beat near the ceiling"), MAX_SESSION_MS, `the session stops at MAX_SESSION_MS (${span(MAX_SESSION_MS)})`);
  let s = await statsOf(D.docId);
  assert.deepEqual(pick(s, ["views", "totalMs"]), { views: s0.views, totalMs: s0.totalMs + LEFT }, "stats took only what was left below the ceiling");
  const r1 = await readDoc(target, `docs/${D.docId}/viewers/${owner.uid}`);
  assert.deepEqual(pick(r1, ["views", "totalMs"]), { views: r0.views, totalMs: r0.totalMs + LEFT }, "viewers/{uid} took the same");

  ctx.step("another 10-hour beat adds nothing");
  assert.equal(await beatX(10 * HOUR, "a 10-hour beat at the ceiling"), MAX_SESSION_MS, `the session stays at ${span(MAX_SESSION_MS)}`);
  s = await statsOf(D.docId);
  assert.deepEqual(pick(s, ["views", "totalMs"]), { views: s0.views, totalMs: s0.totalMs + LEFT }, "stats did not move past the ceiling");
  assert.equal((await readDoc(target, `docs/${D.docId}/views/${sidX}`)).ms, MAX_SESSION_MS, `the session record holds ${span(MAX_SESSION_MS)}`);
});
