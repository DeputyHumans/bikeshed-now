// SPDX-License-Identifier: Apache-2.0
// Comments end to end: the thread record, replies, resolve and reopen, refused client writes, the panel default, scroll rules, orphans, SVG text and the automation badge (SPEC §6).

/**
 * Catalogue A6.1–A6.9, one scenario each, each with its own accounts and its
 * own documents (the stack is shared with other specs):
 *
 *   A6.1 a web comment's annotation has exactly the eight keys SPEC §4 lists,
 *        a web actor and a scoped anchor; its comment exactly the six
 *   A6.2 a reply makes exactly two comments, in order, and reaches the other
 *        reader live
 *   A6.3 Resolve takes the highlight off and the thread out of the list for
 *        every reader; "Show resolved" brings the THREAD back (the highlight
 *        stays off: SPEC §6 "A resolved annotation is not drawn"); Reopen
 *        draws it again; `resolvedBy` is exactly {uid, email, channel:"web"}
 *   A6.4 the client writes SPEC §4 forbids are refused with PERMISSION_DENIED,
 *        each next to a positive control that proves the write path itself
 *        works (a refusal for the wrong reason would otherwise pass)
 *   A6.5 the panel default is decided once, by the first annotation snapshot:
 *        a later comment does not reopen a panel the reader closed, a reopened
 *        thread does not open a panel that started collapsed, and starting a
 *        comment opens it regardless
 *   A6.6 selecting a thread scrolls its passage into view, centred, only when
 *        it is offscreen; a peer's comment never scrolls the reader, idle or
 *        with a thread selected
 *   A6.7 a draft that edits a commented passage away shows the orphan banner
 *        and "(no longer in the text)" to the editor reading the draft, and
 *        nothing of the kind to a viewer reading the version
 *   A6.8 a comment on SVG text is wrapped in tspan.bshd-hl, never a <mark>,
 *        and the label keeps its painted width
 *   A6.9 an agent's comment carries a badge naming the token it came through
 *        ("via personal token “…”", ADR 0023); a person's reply beside it
 *        carries none
 *
 * EMAIL. A comment notifies the owner and the thread's earlier participants
 * (onCommentCreated) unless they opted out. Every account here is cast with
 * {notifications: false}, so it has opted out before its first session (on a
 * local stack cast writes users/{uid} {emailNotifications: false}; production
 * always does), and every case asserts quietDoc() before its first comment.
 * So no case sends a comment notice on either tier, and none declares an
 * email effect. Sharing goes through share(), which on production is the
 * operator script. A6.4's direct writes go through clientFirestore, which the
 * production guard sends under annotations only after the same quietDoc.
 *
 * Fixed waits: only where an ABSENCE is the oracle (no scroll, the panel stays
 * closed, no banner), which can only be observed over a window. Each such
 * window starts after a positive signal that the triggering change has
 * already reached the reader's page (its highlight is drawn). In A6.5 a
 * snapshot of resolved threads only shows nothing on the page, so its signal
 * is read where the snapshot arrives: the page's Firestore Listen back
 * channel, through a passive CDP session (watchListen), which records each
 * arrival of the thread's document and its `resolved` field. The reopen is
 * sent only once the resolved thread has arrived, and SNAPSHOT_SETTLE_MS
 * (2 s) after it, the time the page's SDK is given to raise that snapshot (a
 * pause measured from the arrival, never a guess at the stack's latency; on
 * the loaded shared stack the first snapshot of a new listener has come over
 * 17 s after the page loaded). When the panel does open, the case compares
 * how long after the first snapshot the reopen arrived with how long the page
 * then took to draw it, and ends INCONCLUSIVE when the page acted on its
 * snapshots too slowly for the two to be told apart (they may have been
 * raised as one), else it FAILS.
 *
 * A LOADED SHARED STACK. On the shared stack a single write has taken 20–60 s
 * (POST /session 26 s, POST /publish 21 s, a comment's Firestore write past
 * the 20 s User.comment allows by default), so every bound here is set for
 * it, not for a quiet stack: a request's client deadline (REQUEST_MS) is past
 * Hosting's 60 s cut-off, so a slow function ends in its answer or in the
 * cut-off's 504; a page load or sign-in waits PAGE_MS; what a Firestore
 * write or snapshot shows waits UI_MS, each of User.reply, resolve and
 * reopen's waits included. Setup that the stack left unanswered (a session, a
 * publish, a share, an MCP call) is sent again through untilLanded once its
 * effect is not found. Every case declares STALL, lib/test.mjs's
 * inconclusiveOnCaseTimeout and inconclusiveOnRequestStall: a request the
 * stack never answered, or a wait that ran out (the case's budget included)
 * while a page of the case, or a request the case made, saw the stack stall
 * (Hosting's cut-off 504, a page's Firestore client losing the emulator),
 * ends the case INCONCLUSIVE; any assertion, and any wait that ran out on a
 * stack that kept answering, still FAILS. In A6.4 a rules verdict the emulator could not
 * reach because a rule's get() failed under load ("Service call error") is
 * not a verdict: the write is made again (nothing was stored), and after four
 * such answers the case is INCONCLUSIVE, so a refusal never passes for the
 * wrong reason.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario, untilLanded } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { idToken, mintToken, openSession } from "../../lib/session.mjs";
import { publish, readFixture } from "../../lib/seed.mjs";
import { readMirror, share } from "../../lib/grant.mjs";
import { closeAdmin, readCollection, readDoc } from "../../lib/admin.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { quietDoc } from "../../lib/guard.mjs";
import { eventually } from "../../lib/assert.mjs";
import { FIRESTORE_LISTEN_PATH, RULES_SERVICE_ERROR_RE } from "../../lib/browser.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOTH = ["local", "prod"];
/** A request's client deadline: past Hosting's 60 s cut-off, so a slow function ends in its answer or the cut-off's 504, never in this client giving up first. */
const REQUEST_MS = 150_000;
/** A page load, a frame, a sign-in: POST /session alone took 26 s on the loaded shared stack. */
const PAGE_MS = 120_000;
/** What a Firestore write or snapshot shows: on a page (a new thread, a highlight, a reply) or in the stored records. */
const UI_MS = 90_000;
/** A wait on the page alone (a selection's toolbar, a click's own scroll), with the CPU shared by every unit. */
const LOCAL_MS = 30_000;
/** Each case's timeout (lib/budget.mjs reads these): on a quiet stack every case takes 2–12 s; on the loaded shared stack setup alone has taken 108 s. */
const RULES_CASE_MS = 300_000;
const CASE_MS = 360_000;
const LONG_CASE_MS = 420_000;
const LONGEST_CASE_MS = 480_000;
/** How many more times a write the emulator answered with "Service call error" is made, and the back-off before each (for the emulator, not a wait on the product). */
const SERVICE_RETRIES = 3;
const SERVICE_BACKOFF_MS = 3_000;

/** SPEC §4: what a browser writes, exactly. */
const ANNOTATION_KEYS = ["actor", "anchor", "annId", "authorEmail", "authorUid", "color", "createdAt", "resolved"];
const COMMENT_KEYS = ["actor", "authorEmail", "authorUid", "body", "commentId", "createdAt"];
/** SPEC §6: a quote and a position, scoped to the nearest id-bearing ancestor. */
const ANCHOR_KEYS = ["elementId", "end", "exact", "prefix", "start", "suffix"];

const FIXTURE = "crdt-paragraphs.html";
const FIXTURE_HTML = readFixture(FIXTURE);
/** How long an absence is watched for (see the header). */
const QUIET_WINDOW_MS = 2_500;
/** What the reader's page is given to raise a snapshot whose bytes it has received (A6.5; see the header). */
const SNAPSHOT_SETTLE_MS = 2_000;

const tag = () => `${runTag(target.runId)}-${rand4()}`;

/** The text of one fixture paragraph, as its element's textContent. */
function paragraph(id) {
  const m = new RegExp(`<p id="${id}">([^<]*)</p>`).exec(FIXTURE_HTML);
  precondition(m, `the fixture has no <p id="${id}">`);
  return m[1];
}

/** A quote that occurs exactly once in the fixture, inside paragraph `id`. */
function quoteIn(id, exact) {
  precondition(paragraph(id).includes(exact), `"${exact}" is not in #${id}`);
  precondition(FIXTURE_HTML.split(exact).length === 2, `"${exact}" is not unique in the fixture`);
  return exact;
}

// --- when the stack does not answer ---------------------------------------------

/**
 * How every case is judged when it fails (see A LOADED SHARED STACK in the
 * header): its body runs against a budget that ends before its timeout
 * (inconclusiveOnCaseTimeout), and a request the stack never answered, or a
 * wait that ran out (the budget's included) while a page of the case or a
 * request the case made itself saw the stack stall (pageStall, its
 * `requests: true` through inconclusiveOnRequestStall), ends it INCONCLUSIVE.
 * The case's own requests matter where no page exists yet: A6.1 once sent
 * POST /publish four times, each cut off at 60 s, and ran out of its budget.
 */
const STALL = Object.freeze({ inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true });

// --- cast and documents -------------------------------------------------------

/** A session for `account`, its client patient past Hosting's cut-off; POST /session the stack left unanswered is sent again. */
async function sessionFor(ctx, account) {
  const { out } = await untilLanded(ctx, `POST /session (${account.role})`, () => openSession(target, account, { http: ctx.http({ actor: account.role, timeoutMs: REQUEST_MS, cutoffError: true }) }), null);
  return out;
}

/** Give `account` `role` on `docId`; a POST /access the stack left unanswered is looked for in the RTDB mirror before it is sent again. */
async function shareWith(ctx, owner, docId, account, role) {
  await untilLanded(ctx, `POST /access ${docId} ${account.role}`, () => share(target, { owner, doc: docId, account, role, timeoutMs: REQUEST_MS }), async () => ((await readMirror(target, docId, account.email, role)).ok ? true : null));
}

/** quietDoc (lib/guard.mjs), its Admin reads sent again when the emulator gave them no answer. */
async function quiet(ctx, docId) {
  await untilLanded(ctx, `quietDoc ${docId}`, () => quietDoc(target, docId), null);
}

/**
 * One document `owner` publishes, shared as `shares` ([[account, role]]), its
 * id. Ends with quietDoc: from here on, a comment on it emails nobody.
 */
async function sharedDoc(ctx, owner, shares, { name, title, body = null, filename = FIXTURE }) {
  const up = await publish(owner.http, { ...(body ? { body, filename } : { fixture: FIXTURE }), title, name, timeoutMs: REQUEST_MS, patient: { ctx } });
  precondition(up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)}`);
  for (const [account, role] of shares) await shareWith(ctx, owner, up.docId, account, role);
  await quiet(ctx, up.docId);
  return up.docId;
}

/**
 * An owner with a session, one published document, and the rest of the cast
 * shared at their roles (sharedDoc). `readers` is [{label, role}].
 */
async function stage(ctx, { name, title, readers = [{ label: "viewer", role: "viewer" }], body = null, filename = FIXTURE }) {
  // No comment email for anyone in the cast, on either tier (see the header).
  const accounts = await cast(target, ["owner", ...readers.map((r) => r.label)], { notifications: false });
  const owner = await sessionFor(ctx, accounts[0]);
  const docId = await sharedDoc(ctx, owner, readers.map((r, i) => [accounts[i + 1], r.role]), { name, title, body, filename });
  return { owner, accounts, docId };
}

/** The owner's agent: an mcp-channel token minted with the owner's session, initialized; its client patient past Hosting's cut-off. */
async function agentFor(ctx, session) {
  const { token, tokenId } = await mintToken(session, { name: `e2e a06 ${tag()}`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: `${session.account.role}-mcp`, timeoutMs: REQUEST_MS });
  await untilLanded(ctx, "MCP initialize", () => mcp.initialize(), null);
  return { mcp, tokenId };
}

/** A signed-in browser user with the document open. */
async function reader(ctx, name, account, docId) {
  const u = await ctx.users.user({ name });
  await u.signInUi(account.email, account.password, { timeout: PAGE_MS });
  await u.open(docId, { timeout: PAGE_MS });
  return u;
}

// --- the comment UI, every wait bounded for a loaded stack ----------------------

/**
 * Select `quote` in `selector` and comment `text` on it (User.comment), each
 * of its two waits UI_MS. A press the loaded emulator refused with "Service
 * call error" (a rule's get() failing, not the rules' verdict) is made again
 * after selecting the passage again (retryServiceError); when every press was
 * refused so the case is INCONCLUSIVE. Resolves selectText's result.
 */
async function commentOn(u, selector, quote, text) {
  const sel = await u.selectText(selector, quote, { timeout: LOCAL_MS });
  await u.comment(text, { timeout: UI_MS, retryServiceError: SERVICE_RETRIES, reselect: () => u.selectText(selector, quote, { timeout: LOCAL_MS }) });
  return sel;
}

// --- reading the stack and the page -------------------------------------------

const annPath = (docId, v = "v1") => `docs/${docId}/versions/${v}/annotations`;

/** The version's annotations, waiting until there are exactly `n`. */
async function annotationsOf(docId, n, { v = "v1", timeout = UI_MS } = {}) {
  return eventually(async () => {
    const rows = await readCollection(target, annPath(docId, v));
    return rows.length === n ? rows : false;
  }, { timeout, message: `exactly ${n} annotation(s) on ${docId}/${v}` });
}

/** A thread's comments in createdAt order, waiting until there are exactly `n`. */
async function commentsOf(docId, annId, n, { v = "v1", timeout = UI_MS } = {}) {
  return eventually(async () => {
    const rows = await readCollection(target, `${annPath(docId, v)}/${annId}/comments`);
    if (rows.length !== n) return false;
    return rows.sort((a, b) => a.data.createdAt.toMillis() - b.data.createdAt.toMillis());
  }, { timeout, message: `exactly ${n} comment(s) on ${annId}` });
}

const hlSel = (annId) => `mark.bshd-hl[data-bshd-ann="${annId}"], tspan.bshd-hl[data-bshd-ann="${annId}"]`;

async function hlCount(u, annId) {
  return (await u.frame()).locator(hlSel(annId)).count();
}

/** Wait for a thread's highlight to be drawn (present) or gone (absent) in u's frame. */
async function waitHl(u, annId, present, { timeout = UI_MS } = {}) {
  await eventually(async () => ((await hlCount(u, annId)) > 0) === present, {
    timeout,
    message: `${u.name}: the highlight of ${annId} ${present ? "is drawn" : "is gone"}`,
  });
}

const panelState = (u) => u.page.locator(".viewer-body").getAttribute("data-comments");

/** The frame's scroll position, viewport height, and where a thread's highlight sits in it. */
async function frameView(u, annId = null) {
  return (await u.frame()).evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : null;
    const r = el?.getBoundingClientRect();
    return {
      scrollY: Math.round(scrollY),
      maxScroll: Math.round(document.scrollingElement.scrollHeight - innerHeight),
      innerHeight,
      mark: r ? { top: r.top, bottom: r.bottom, height: r.height, inView: r.top >= 0 && r.bottom <= innerHeight } : null,
    };
  }, annId ? hlSel(annId) : null);
}

/** Sample `fn` every `interval` ms for `ms` ms (an absence can only be watched for). */
async function sampleFor(fn, ms = QUIET_WINDOW_MS, interval = 100) {
  const out = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    out.push(await fn());
    await sleep(interval);
  }
  out.push(await fn());
  return out;
}

// LIB-REQUEST: listen-deliveries — A6.5 must know that the reader's page has
// RECEIVED its first annotation snapshot of a document whose only thread is
// resolved, and the page shows nothing for that snapshot. Its Firestore
// Listen back channel (FIRESTORE_LISTEN_PATH, its GETs) carries it: the
// thread's document arrives there with its `resolved` field. Read here
// through a CDP session (Network.streamResourceContent), passively: nothing
// is held, changed or answered. Proposed: User.watchListen(docPath) →
// {rows, channels(), stop()} in lib/browser.mjs, beside delayRequests.

/**
 * Watch u's page's Firestore Listen back channel for the document at
 * `docPath` (a path under /documents/): a row {t (Date.now() as its bytes
 * reached this process), resolved (its `resolved` field: true, false, or null
 * when not read)} each time that document arrives. Attach it BEFORE the
 * navigation that opens the channel: only requests sent after it are read.
 * Resolves {rows (live), channels() (back-channel requests seen), errors
 * (live: why a request could not be read), stop()}.
 */
async function watchListen(u, docPath) {
  const cdp = await u.page.context().newCDPSession(u.page);
  const marker = `/documents/${docPath}"`;
  const rows = [];
  const errors = [];
  const streams = new Map(); // requestId → {buf, pos, pending: base64 chunks that came before the buffered data, or null}
  let channels = 0;
  const scan = (s) => {
    for (;;) {
      const i = s.buf.indexOf(marker, s.pos);
      if (i < 0) {
        s.pos = Math.max(s.pos, s.buf.length - marker.length);
        break;
      }
      // The document's fields come before its updateTime: wait until it is all here.
      const j = s.buf.indexOf('"updateTime"', i);
      if (j < 0) {
        s.pos = i;
        break;
      }
      const m = /"resolved"\s*:\s*\{\s*"booleanValue"\s*:\s*(true|false)/.exec(s.buf.slice(i, j));
      rows.push({ t: Date.now(), resolved: m ? m[1] === "true" : null });
      s.pos = j;
    }
    if (s.pos > 1_000_000) {
      s.buf = s.buf.slice(s.pos);
      s.pos = 0;
    }
  };
  const feed = (s, b64) => {
    if (!b64) return;
    s.buf += Buffer.from(b64, "base64").toString("latin1");
    scan(s);
  };
  cdp.on("Network.requestWillBeSent", (e) => {
    try {
      if (e.request.method !== "GET" || new URL(e.request.url).pathname !== FIRESTORE_LISTEN_PATH) return;
    } catch {
      return;
    }
    channels += 1;
    streams.set(e.requestId, { buf: "", pos: 0, pending: [] });
  });
  cdp.on("Network.responseReceived", (e) => {
    const s = streams.get(e.requestId);
    if (!s) return;
    cdp.send("Network.streamResourceContent", { requestId: e.requestId }).then(
      (r) => {
        feed(s, r.bufferedData);
        for (const d of s.pending ?? []) feed(s, d);
        s.pending = null;
      },
      (err) => {
        s.pending = null;
        s.streamFailed = true;
        errors.push(`streamResourceContent: ${String(err?.message ?? err).split("\n")[0]}`);
      },
    );
  });
  cdp.on("Network.dataReceived", (e) => {
    const s = streams.get(e.requestId);
    if (!s || !e.data) return;
    if (s.pending) s.pending.push(e.data);
    else feed(s, e.data);
  });
  cdp.on("Network.loadingFinished", (e) => {
    const s = streams.get(e.requestId);
    if (!s) return;
    streams.delete(e.requestId);
    // A long poll that finished before streaming took: its whole body.
    if (!s.streamFailed) return;
    cdp.send("Network.getResponseBody", { requestId: e.requestId }).then(
      (r) => feed(s, r.base64Encoded ? r.body : Buffer.from(r.body, "utf8").toString("base64")),
      (err) => errors.push(`getResponseBody: ${String(err?.message ?? err).split("\n")[0]}`),
    );
  });
  cdp.on("Network.loadingFailed", (e) => streams.delete(e.requestId));
  await cdp.send("Network.enable", {});
  return { rows, errors, channels: () => channels, stop: () => cdp.detach().catch(() => undefined) };
}

/** The thread on `docId`'s v1 quoting `exact` whose comments hold `body`, or null: what an add_comment the stack did not answer may still have made. */
async function threadWith(docId, exact, body) {
  for (const a of await readCollection(target, annPath(docId))) {
    if (a.data.anchor?.exact !== exact) continue;
    const comments = await readCollection(target, `${annPath(docId)}/${a.id}/comments`);
    if (comments.some((c) => c.data.body === body)) return a.id;
  }
  return null;
}

/**
 * The id of the thread the agent's MCP add_comment made. A call the stack did
 * not answer (Hosting's cut-off) is looked for on the stored record before it
 * is sent again, so a late one is taken, never doubled.
 */
async function agentComment(ctx, agent, docId, exact, body) {
  const { out, landed } = await untilLanded(ctx, `MCP add_comment on ${docId}`, () => agent.mcp.ok("add_comment", { id: docId, exact, body }), () => threadWith(docId, exact, body));
  if (landed) return landed;
  precondition(out?.threadId, `add_comment returned no threadId: ${JSON.stringify(out)}`);
  return out.threadId;
}

/** The agent's MCP resolve_thread (resolved true) or reopen_thread (false); one the stack did not answer is looked for on the record first. */
async function agentResolve(ctx, agent, docId, threadId, resolved) {
  const tool = resolved ? "resolve_thread" : "reopen_thread";
  await untilLanded(ctx, `MCP ${tool} ${threadId}`, () => agent.mcp.ok(tool, { id: docId, threadId }), async () => ((await readDoc(target, `${annPath(docId)}/${threadId}`))?.resolved === resolved ? true : null));
}

// --- A direct Firestore write as a signed-in account ----------------------------

/** The rules' client: what the app's own SDK sends, under this account's ID token. */
async function firestoreAs(ctx, account) {
  return clientFirestore(target, { idToken: await idToken(target, account), http: ctx.http({ actor: `${account.role}-firestore`, timeoutMs: REQUEST_MS }) });
}

/**
 * Make a client write and return its answer once the rules judged it. The
 * Firestore emulator under load fails a rule's get() and answers 403 with
 * "Service call error" (RULES_SERVICE_ERROR_RE, lib/browser.mjs): the rules
 * never reached a verdict, and nothing was stored, so the write is made again,
 * SERVICE_BACKOFF_MS apart, up to SERVICE_RETRIES more times. Then it throws
 * with a `stackCut`, so the case is INCONCLUSIVE: such an answer must never
 * pass as a refusal, nor fail a positive control.
 */
async function judged(write, what) {
  for (let tries = 1; ; tries += 1) {
    const r = await write();
    if (!(r.status === 403 && RULES_SERVICE_ERROR_RE.test(r.message ?? ""))) return r;
    if (tries > SERVICE_RETRIES) {
      throw Object.assign(new Error(`${what}: the emulator answered "Service call error" ${tries} time(s): ${r.message}`), {
        stackCut: `the emulator failed a rule's get() ("Service call error") on ${tries} tries of ${what}, so the rules never judged it`,
      });
    }
    await sleep(SERVICE_BACKOFF_MS);
  }
}

/** A rules DENY: 403 PERMISSION_DENIED, never a NOT_FOUND or a malformed write. */
function refused(r, what) {
  assert.deepEqual({ status: r.status, code: r.code, verdict: r.verdict }, { status: 403, code: "PERMISSION_DENIED", verdict: "DENY" }, `refused: ${what} (got ${r.status} ${r.code} ${r.message})`);
}

/** A rules ALLOW: the positive control that shows the write path itself works. */
function allowed(r, what) {
  precondition(r.verdict === "ALLOW", `positive control: ${what} must be allowed (got ${r.status} ${r.code} ${r.message})`);
}

// --- A6.1 ---------------------------------------------------------------------

scenario("A6.1 a web comment stores an annotation with exactly the eight SPEC keys, a web actor and an anchor scoped to its paragraph, and a comment with exactly six", { tiers: BOTH, timeoutMs: CASE_MS, ...STALL }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a61-keys", title: "A6.1 annotation keys" });
  const viewerAcct = accounts[1];
  const QUOTE = quoteIn("e2e-3", "lantern linen harbor pepper");

  ctx.step("the viewer signs in, drags over a passage in #e2e-3, presses Comment and sends from the reply box");
  const v = await reader(ctx, "viewer", viewerAcct, docId);
  const body = `A6.1 ${tag()}`;
  const t0 = Date.now();
  const sel = await commentOn(v, "#e2e-3", QUOTE, body);
  const t1 = Date.now();
  assert.equal(sel.text, QUOTE, "the drag selected the passage");

  ctx.step("the stored annotation: exactly the eight keys, the viewer as author and web actor, unresolved, server-stamped");
  const [ann] = await annotationsOf(docId, 1);
  const a = ann.data;
  ctx.ev.json("annotation", { id: ann.id, ...a, createdAt: a.createdAt?.toMillis?.() });
  assert.deepEqual(Object.keys(a).sort(), ANNOTATION_KEYS, "annotation keys");
  assert.equal(a.annId, ann.id, "annId is the document's own id");
  assert.deepEqual(a.actor, { uid: viewerAcct.uid, email: viewerAcct.email, channel: "web" }, "actor is exactly {uid, email, channel: web}");
  assert.deepEqual({ authorUid: a.authorUid, authorEmail: a.authorEmail, resolved: a.resolved }, { authorUid: viewerAcct.uid, authorEmail: viewerAcct.email, resolved: false });
  assert.ok(typeof a.color === "string" && a.color.length > 0, "a colour");
  assert.equal(typeof a.createdAt?.toMillis, "function", "createdAt is a Firestore timestamp");
  // The emulator shares this machine's clock: the stamp falls between the press and the comment showing, with a minute's slack.
  assert.ok(a.createdAt.toMillis() >= t0 - 60_000 && a.createdAt.toMillis() <= t1 + 60_000, `createdAt ${a.createdAt.toMillis()} is the server's clock at the write (pressed ${t0}, shown ${t1})`);

  ctx.step("the anchor: quote and position, scoped to #e2e-3, offsets measured in that element's text");
  assert.deepEqual(Object.keys(a.anchor).sort(), ANCHOR_KEYS, "anchor keys");
  const start = paragraph("e2e-3").indexOf(QUOTE);
  assert.deepEqual(
    { elementId: a.anchor.elementId, exact: a.anchor.exact, start: a.anchor.start, end: a.anchor.end },
    { elementId: "e2e-3", exact: QUOTE, start, end: start + QUOTE.length },
  );

  ctx.step("its one comment: exactly the six keys, the body as typed, the viewer's web actor");
  const [c] = await commentsOf(docId, ann.id, 1);
  assert.deepEqual(Object.keys(c.data).sort(), COMMENT_KEYS, "comment keys");
  assert.deepEqual(
    { commentId: c.data.commentId, body: c.data.body, authorUid: c.data.authorUid, authorEmail: c.data.authorEmail, actor: c.data.actor },
    { commentId: c.id, body, authorUid: viewerAcct.uid, authorEmail: viewerAcct.email, actor: { uid: viewerAcct.uid, email: viewerAcct.email, channel: "web" } },
  );
  assert.equal(typeof c.data.createdAt?.toMillis, "function", "the comment's createdAt is a Firestore timestamp");
  await waitHl(v, ann.id, true);
});

// --- A6.2 ---------------------------------------------------------------------

scenario("A6.2 the owner's reply to a viewer's thread makes exactly two comments in order, and the viewer sees it without reloading", { tiers: BOTH, timeoutMs: CASE_MS, ...STALL }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a62-reply", title: "A6.2 reply" });
  const [ownerAcct, viewerAcct] = accounts;
  const QUOTE = quoteIn("e2e-4", "quill lantern walnut jasper");

  ctx.step("the viewer comments on a passage in #e2e-4");
  const v = await reader(ctx, "viewer", viewerAcct, docId);
  const first = `A6.2 first ${tag()}`;
  await commentOn(v, "#e2e-4", QUOTE, first);
  const [ann] = await annotationsOf(docId, 1);

  ctx.step("the owner opens the document and replies in that thread's reply box");
  const o = await reader(ctx, "owner", ownerAcct, docId);
  const second = `A6.2 reply ${tag()}`;
  await o.reply(QUOTE, second, { timeout: UI_MS });

  ctx.step("stored: exactly two comments on the one thread, the viewer's then the owner's, each the six keys with its author's web actor");
  const comments = await commentsOf(docId, ann.id, 2);
  for (const c of comments) assert.deepEqual(Object.keys(c.data).sort(), COMMENT_KEYS, `keys of ${c.id}`);
  assert.deepEqual(
    comments.map((c) => ({ body: c.data.body, authorUid: c.data.authorUid, actor: c.data.actor })),
    [
      { body: first, authorUid: viewerAcct.uid, actor: { uid: viewerAcct.uid, email: viewerAcct.email, channel: "web" } },
      { body: second, authorUid: ownerAcct.uid, actor: { uid: ownerAcct.uid, email: ownerAcct.email, channel: "web" } },
    ],
  );
  assert.equal((await readCollection(target, annPath(docId))).length, 1, "a reply opens no second thread");

  ctx.step("the viewer, who never reloaded, sees both comments in that order");
  await eventually(async () => {
    const bodies = (await v.thread(QUOTE).first().locator(".comment-body").allTextContents()).map((s) => s.trim());
    return bodies.length === 2 && bodies[0] === first && bodies[1] === second ? bodies : false;
  }, { timeout: UI_MS, message: "the viewer's thread lists both comments in order" });
});

// --- A6.3 ---------------------------------------------------------------------

scenario("A6.3 Resolve hides the highlight and the thread for every reader, Show resolved brings the thread back, Reopen redraws it, and resolvedBy is exactly the web actor", { tiers: BOTH, timeoutMs: LONG_CASE_MS, ...STALL }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a63-resolve", title: "A6.3 resolve" });
  const [ownerAcct, viewerAcct] = accounts;
  const QUOTE = quoteIn("e2e-5", "russet yarrow thistle indigo");

  ctx.step("the viewer comments; the owner has the document open too; both frames draw the highlight");
  const v = await reader(ctx, "viewer", viewerAcct, docId);
  await commentOn(v, "#e2e-5", QUOTE, `A6.3 ${tag()}`);
  const [ann] = await annotationsOf(docId, 1);
  const o = await reader(ctx, "owner", ownerAcct, docId);
  await Promise.all([waitHl(v, ann.id, true), waitHl(o, ann.id, true)]);

  ctx.step("the viewer presses Resolve");
  await v.resolve(QUOTE, { timeout: UI_MS });

  ctx.step("stored: resolved, and resolvedBy is exactly the viewer's web actor; nothing else changed");
  const resolved = await eventually(async () => {
    const d = await readDoc(target, `${annPath(docId)}/${ann.id}`);
    return d?.resolved === true ? d : false;
  }, { timeout: UI_MS, message: "the annotation is resolved" });
  assert.deepEqual(resolved.resolvedBy, { uid: viewerAcct.uid, email: viewerAcct.email, channel: "web" }, "resolvedBy");
  assert.deepEqual(Object.keys(resolved).sort(), [...ANNOTATION_KEYS, "resolvedBy"].sort(), "resolve adds resolvedBy and nothing else");

  ctx.step("both frames lose the highlight; the viewer's list no longer shows the thread and counts it resolved");
  await Promise.all([waitHl(v, ann.id, false), waitHl(o, ann.id, false)]);
  await eventually(async () => (await v.thread(QUOTE).count()) === 0, { timeout: UI_MS, message: "the resolved thread is hidden" });
  assert.equal((await v.page.locator(".comments-count").textContent()).trim(), "0 open · 1 resolved");

  ctx.step("Show resolved brings the thread back, marked resolved with a Reopen button; the passage stays undrawn (SPEC §6)");
  await v.page.locator(".comments-head button", { hasText: "Show resolved" }).click({ timeout: LOCAL_MS });
  const t = v.thread(QUOTE).first();
  await t.waitFor({ state: "visible", timeout: LOCAL_MS });
  assert.equal(await t.getAttribute("data-resolved"), "true");
  assert.equal(await t.getByRole("button", { name: "Reopen" }).count(), 1, "a Reopen button");
  assert.equal(await hlCount(v, ann.id), 0, "Show resolved does not draw a resolved annotation");

  ctx.step("the owner reopens it: stored unresolved, resolvedBy the owner's web actor, and both frames draw it again");
  await o.reopen(QUOTE, { timeout: UI_MS });
  const reopened = await eventually(async () => {
    const d = await readDoc(target, `${annPath(docId)}/${ann.id}`);
    return d?.resolved === false ? d : false;
  }, { timeout: UI_MS, message: "the annotation is reopened" });
  assert.deepEqual(reopened.resolvedBy, { uid: ownerAcct.uid, email: ownerAcct.email, channel: "web" }, "resolvedBy after reopen");
  await Promise.all([waitHl(v, ann.id, true), waitHl(o, ann.id, true)]);
});

// --- A6.4 ---------------------------------------------------------------------

scenario("A6.4 client writes outside the rules are refused with PERMISSION_DENIED: extra field, mcp channel, resolved at creation, someone else's comment, a generated note", { tiers: BOTH, timeoutMs: RULES_CASE_MS, ...STALL }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a64-rules", title: "A6.4 refused writes" });
  const [ownerAcct, viewerAcct] = accounts;
  // Every write's answer is the rules' verdict, never the loaded emulator's "Service call error" (judged, above).
  const judgedAs = (c, who) => ({
    create: (path, data, o) => judged(() => c.create(path, data, o), `${who}'s create of ${path}`),
    update: (path, fields, o) => judged(() => c.update(path, fields, o), `${who}'s update of ${path}`),
    remove: (path) => judged(() => c.remove(path), `${who}'s delete of ${path}`),
  });
  const asViewer = judgedAs(await firestoreAs(ctx, viewerAcct), "the viewer");
  const asOwner = judgedAs(await firestoreAs(ctx, ownerAcct), "the owner");
  const web = (a) => ({ uid: a.uid, email: a.email, channel: "web" });
  const QUOTE = quoteIn("e2e-2", "Xenon delta timber linen");
  const start = paragraph("e2e-2").indexOf(QUOTE);
  const annotation = (id, a = viewerAcct) => ({
    annId: id,
    anchor: { elementId: "e2e-2", exact: QUOTE, prefix: "", suffix: "", start, end: start + QUOTE.length },
    authorUid: a.uid,
    authorEmail: a.email,
    actor: web(a),
    color: "#b5257b",
    resolved: false,
  });
  const comment = (id, body, a = viewerAcct) => ({ commentId: id, body, authorUid: a.uid, authorEmail: a.email, actor: web(a) });
  const newId = () => `a64${rand4()}${rand4()}`;
  const annAt = (id) => `${annPath(docId)}/${id}`;

  ctx.step("positive control: the viewer creates exactly what the app writes, and it is stored");
  const A = newId();
  allowed(await asViewer.create(annAt(A), annotation(A)), "a well-formed annotation");
  assert.deepEqual(Object.keys((await readDoc(target, annAt(A))) ?? {}).sort(), ANNOTATION_KEYS);

  ctx.step("annotation creates SPEC §4 forbids: each refused, and nothing stored");
  const badCreates = [
    ["an extra field", (id) => ({ ...annotation(id), note: "extra" })],
    ['actor.channel "mcp"', (id) => ({ ...annotation(id), actor: { ...web(viewerAcct), channel: "mcp" } })],
    ["resolved: true at creation", (id) => ({ ...annotation(id), resolved: true })],
    ["a tokenId on the actor", (id) => ({ ...annotation(id), actor: { ...web(viewerAcct), tokenId: "t" } })],
    ["another account as author", (id) => annotation(id, ownerAcct)],
  ];
  for (const [what, make] of badCreates) {
    const id = newId();
    refused(await asViewer.create(annAt(id), make(id)), `annotation with ${what}`);
    assert.equal(await readDoc(target, annAt(id)), null, `nothing stored for ${what}`);
  }
  {
    const id = newId();
    refused(await asViewer.create(annAt(id), { ...annotation(id), createdAt: new Date() }, { serverTime: [] }), "annotation dated by the client's clock");
    assert.equal(await readDoc(target, annAt(id)), null);
  }

  ctx.step("positive control: the viewer comments on that thread; comments carrying server-only markers are refused");
  const C1 = newId();
  const cAt = (id) => `${annAt(A)}/comments/${id}`;
  allowed(await asViewer.create(cAt(C1), comment(C1, "first words")), "a well-formed comment");
  assert.deepEqual(Object.keys((await readDoc(target, cAt(C1))) ?? {}).sort(), COMMENT_KEYS);
  for (const [what, extra] of [["generated: true", { generated: true }], ["opensSuggestion: true", { opensSuggestion: true }]]) {
    const id = newId();
    refused(await asViewer.create(cAt(id), { ...comment(id, "forged"), ...extra }), `comment with ${what}`);
    assert.equal(await readDoc(target, cAt(id)), null, `nothing stored for ${what}`);
  }

  ctx.step("editing: the owner may not reword the viewer's comment; its author may reword it, and change nothing else");
  refused(await asOwner.update(cAt(C1), { body: "rewritten by the owner" }), "editing someone else's comment");
  assert.equal((await readDoc(target, cAt(C1)))?.body, "first words", "the viewer's words stand");
  allowed(await asViewer.update(cAt(C1), { body: "first words, reworded" }), "the author rewording their own comment");
  assert.equal((await readDoc(target, cAt(C1)))?.body, "first words, reworded");
  refused(await asViewer.update(cAt(C1), { body: "again", actor: { ...web(viewerAcct), channel: "cli" } }), "the author changing a comment's actor");

  ctx.step("resolving: resolvedBy must be the reader; the viewer's own resolve and reopen go through");
  refused(await asViewer.update(annAt(A), { resolved: true, resolvedBy: web(ownerAcct) }), "a resolve that names someone else in resolvedBy");
  allowed(await asViewer.update(annAt(A), { resolved: true, resolvedBy: web(viewerAcct) }), "the viewer resolving as themselves");
  allowed(await asViewer.update(annAt(A), { resolved: false, resolvedBy: web(viewerAcct) }), "the viewer reopening as themselves");

  ctx.step("a generated note: the owner's agent resolves the thread, which leaves a note stamped with the owner; even its author may not edit or delete it");
  const agent = await agentFor(ctx, owner);
  await agentResolve(ctx, agent, docId, A, true);
  const notes = await eventually(async () => {
    const rows = (await readCollection(target, `${annAt(A)}/comments`)).filter((c) => c.data.generated === true);
    return rows.length === 1 ? rows : false;
  }, { timeout: UI_MS, message: "exactly one generated note" });
  const note = notes[0];
  precondition(note.data.authorUid === ownerAcct.uid, `the note is the owner's (authorUid ${note.data.authorUid})`);
  refused(await asOwner.update(cAt(note.id), { body: "I never said that" }), "the author editing a generated note");
  refused(await asOwner.remove(cAt(note.id)), "the author deleting a generated note");
  assert.equal((await readDoc(target, cAt(note.id)))?.body, note.data.body, "the note stands, word for word");

  ctx.step("positive control: the owner's own ordinary comment can be deleted by its author");
  const C2 = newId();
  allowed(await asOwner.create(cAt(C2), comment(C2, "the owner's words", ownerAcct)), "the owner's own comment");
  allowed(await asOwner.remove(cAt(C2)), "its author deleting an ordinary comment");
  assert.equal(await readDoc(target, cAt(C2)), null);
});

// --- A6.5 ---------------------------------------------------------------------

scenario("A6.5 the panel default is decided once: a later comment does not reopen a panel the reader closed, a reopened thread does not open one that started collapsed, and starting a comment opens it", { tiers: BOTH, timeoutMs: LONGEST_CASE_MS, ...STALL }, async (ctx) => {
  const accounts = await cast(target, ["owner", "viewer"], { notifications: false });
  const owner = await sessionFor(ctx, accounts[0]);
  const viewerAcct = accounts[1];
  const agent = await agentFor(ctx, owner);

  ctx.step("two documents shared with the reader, made side by side: one with an unresolved thread, and one whose only thread is resolved");
  // Side by side, not one after the other: on the loaded shared stack a single publish or share has cost two Hosting cut-offs.
  const [{ docId, T1 }, { secondId, T3 }] = await Promise.all([
    (async () => {
      const id = await sharedDoc(ctx, owner, [[viewerAcct, "viewer"]], { name: "a65-panel", title: "A6.5 panel default" });
      return { docId: id, T1: await agentComment(ctx, agent, id, quoteIn("e2e-2", "Nectar orchard kestrel glacier"), `A6.5 first ${tag()}`) };
    })(),
    (async () => {
      const id = await sharedDoc(ctx, owner, [[viewerAcct, "viewer"]], { name: "a65-resolved", title: "A6.5 resolved only" });
      const t = await agentComment(ctx, agent, id, quoteIn("e2e-6", "Russet orchard harbor glacier"), `A6.5 resolved ${tag()}`);
      await agentResolve(ctx, agent, id, t, true);
      return { secondId: id, T3: t };
    })(),
  ]);

  ctx.step("the reader opens the first document and the panel opens by itself");
  const r = await reader(ctx, "reader", viewerAcct, docId);
  await waitHl(r, T1, true);
  await eventually(async () => (await panelState(r)) === "open", { timeout: UI_MS, message: "the panel opens for an unresolved thread" });

  ctx.step("the reader closes the panel");
  await r.page.locator('.comments-panel button[aria-label="Close comments"]').click({ timeout: LOCAL_MS });
  await eventually(async () => (await panelState(r)) === "closed", { timeout: LOCAL_MS, message: "the panel closed" });

  ctx.step("a peer's new thread lands (its highlight is drawn in the reader's frame); the panel stays closed");
  const T2 = await agentComment(ctx, agent, docId, quoteIn("e2e-4", "Thistle hollow thistle ochre"), `A6.5 later ${tag()}`);
  await waitHl(r, T2, true);
  const after1 = await sampleFor(() => panelState(r));
  assert.deepEqual([...new Set(after1)], ["closed"], `a later comment reopened the panel the reader closed: ${after1.join(",")}`);

  ctx.step("the reader opens the second document, whose only thread is resolved: the panel starts collapsed");
  // The page shows nothing for a snapshot of resolved threads only, so the
  // reader's first snapshot is read where it arrives: the page's Listen
  // channel (see the header).
  const listen = await watchListen(r, `${annPath(secondId)}/${T3}`);
  try {
    await r.open(secondId, { timeout: PAGE_MS });
    const first = await eventually(() => listen.rows.find((x) => x.resolved === true) ?? false, {
      timeout: UI_MS,
      message: `the reader's page receives its first annotation snapshot of the second document, the thread resolved (${listen.channels()} Listen back-channel request(s) read; arrivals ${JSON.stringify(listen.rows)}; ${listen.errors.join("; ") || "no read errors"})`,
    });
    ctx.step(`the reader's page received the resolved thread on its Listen channel; ${SNAPSHOT_SETTLE_MS} ms pass for its SDK to raise that snapshot, then the reopen`);
    // Product time, not a wait on a condition: the bytes are on the page; the snapshot they make shows nothing.
    await sleep(SNAPSHOT_SETTLE_MS);
    assert.equal(await panelState(r), "closed", "a document with only resolved threads starts collapsed");

    ctx.step("the peer reopens that thread (its highlight is drawn); the panel stays collapsed");
    await agentResolve(ctx, agent, secondId, T3, false);
    await waitHl(r, T3, true);
    const drawnAt = Date.now();
    const reopened = listen.rows.find((x) => x.resolved === false) ?? null;
    ctx.ev.json("listen-arrivals", { first, reopened, drawnAt, rows: listen.rows, channels: listen.channels(), errors: listen.errors });
    ctx.step(`the reopened thread reached the page ${reopened ? reopened.t - first.t : "?"} ms after its first snapshot did, and was drawn ${reopened ? drawnAt - reopened.t : "?"} ms after it arrived`);
    const after2 = await sampleFor(() => panelState(r));
    if (after2.some((s) => s !== "closed")) {
      // Opened. That is the product deciding again on a later snapshot,
      // unless its SDK had not yet raised the first snapshot when the reopen
      // arrived, and raised the two as one: possible only when the page took
      // longer to act on its snapshots than the reopen came after the first.
      const leadMs = reopened ? reopened.t - first.t : null;
      const pageLagMs = reopened ? drawnAt - reopened.t : null;
      ctx.step(`the panel opened: the reopened thread reached the page ${leadMs ?? "?"} ms after its first snapshot did, and was drawn ${pageLagMs ?? "?"} ms after it arrived`);
      if (!reopened || leadMs < 3 * pageLagMs + 1_000) {
        ctx.inconclusive(`the reader's page drew the reopened thread ${pageLagMs ?? "?"} ms after it arrived, against ${leadMs ?? "?"} ms between its first snapshot and the reopen reaching it: it may have raised the two as one snapshot, so whether the panel was decided before the reopen was not measured (panel states: ${after2.join(",")})`);
      }
    }
    assert.deepEqual([...new Set(after2)], ["closed"], `a thread reopened after the first snapshot opened a collapsed panel: ${after2.join(",")}`);
  } finally {
    await listen.stop();
  }

  ctx.step("starting a comment opens it regardless");
  await r.selectText("#e2e-8", quoteIn("e2e-8", "Marble kestrel ember harbor"), { timeout: LOCAL_MS });
  const toasts = r.toastMark();
  await r.page.locator(".selection-fab", { hasText: /^\s*Comment\s*$/ }).first().click({ timeout: LOCAL_MS });
  // The page opens the panel once the new thread's write is acknowledged (DocViewer startComment).
  // The loaded emulator failing a rule's get() refuses the write without the rules' verdict ("Service call error" in the app's toast): nothing was measured.
  const serviceError = () => r.log.toasts.slice(toasts).find((t) => t.kind === "error" && RULES_SERVICE_ERROR_RE.test(String(t.text ?? "")));
  const opened = await eventually(async () => ((await panelState(r)) === "open" ? "open" : serviceError() ? "refused" : false), { timeout: UI_MS, message: "Comment opened the panel" });
  if (opened === "refused") ctx.inconclusive(`the emulator failed a rule's get() on the Comment press ("Service call error": ${JSON.stringify(String(serviceError().text).slice(0, 160))}), so the thread was never written`);
});

// --- A6.6 ---------------------------------------------------------------------

scenario("A6.6 selecting a thread scrolls its passage into view only when it is offscreen, and a peer's comment never scrolls the reader", { tiers: BOTH, timeoutMs: LONG_CASE_MS, ...STALL }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a66-scroll", title: "A6.6 scroll" });
  const viewerAcct = accounts[1];
  const agent = await agentFor(ctx, owner);
  const Q1 = quoteIn("e2e-1", "Estuary amber zephyr walnut");
  const Q20 = quoteIn("e2e-20", "Russet saffron upland yarrow");
  const Q30 = quoteIn("e2e-30", "Timber glacier saffron zephyr");
  const T1 = await agentComment(ctx, agent, docId, Q1, `A6.6 top ${tag()}`);
  const T20 = await agentComment(ctx, agent, docId, Q20, `A6.6 middle ${tag()}`);

  ctx.step("the reader opens the document at the top; the panel lists the two threads");
  const r = await reader(ctx, "reader", viewerAcct, docId);
  for (const t of [T1, T20]) await waitHl(r, t, true);
  await eventually(async () => (await panelState(r)) === "open", { timeout: UI_MS, message: "the panel is open" });

  ctx.step("with nothing selected, a peer's comment on #e2e-30 lands: the reader is not scrolled");
  const T30 = await agentComment(ctx, agent, docId, Q30, `A6.6 peer ${tag()}`);
  await waitHl(r, T30, true);
  const s0 = await sampleFor(async () => (await frameView(r)).scrollY);
  assert.deepEqual([...new Set(s0)], [0], `a peer's comment scrolled an idle reader: ${s0.join(",")}`);
  const top = await frameView(r, T30);
  // Where centring #e2e-30 would put the frame: possible only if the frame can scroll that far.
  const centredAt = Math.round((top.mark?.top + top.mark?.bottom) / 2 - top.innerHeight / 2);
  precondition(top.scrollY === 0 && top.mark && !top.mark.inView && centredAt > 0 && centredAt <= top.maxScroll, `the reader is at the top, #e2e-30 is offscreen and can be centred: ${JSON.stringify({ ...top, centredAt })}`);

  ctx.step("the reader selects the #e2e-30 thread in the panel: its offscreen passage is brought into view, centred");
  await r.thread(Q30).first().locator(".thread-quote").click({ timeout: LOCAL_MS });
  await eventually(async () => (await r.thread(Q30).first().getAttribute("aria-selected")) === "true", { timeout: LOCAL_MS, message: "the thread is selected" });
  const brought = await eventually(async () => {
    const f = await frameView(r, T30);
    return f.scrollY > 0 && f.mark?.inView ? f : false;
  }, { timeout: LOCAL_MS, message: "the #e2e-30 passage scrolled into view" });
  ctx.step(`scrolled to ${brought.scrollY} (centred would be ${centredAt}); the passage sits at ${Math.round(brought.mark.top)}–${Math.round(brought.mark.bottom)} of ${brought.innerHeight}`);
  // SPEC §6: "Selecting a thread brings its passage into view, centred".
  assert.ok(Math.abs(brought.scrollY - centredAt) <= 2, `the passage is centred: scrolled to ${brought.scrollY}, centred is ${centredAt}`);

  ctx.step("the reader scrolls back to the top; a peer's comment lands; the reader is not pulled back to the selected passage");
  await (await r.frame()).evaluate(() => scrollTo(0, 0));
  await eventually(async () => (await frameView(r)).scrollY === 0, { timeout: LOCAL_MS, message: "the reader is back at the top" });
  const T35 = await agentComment(ctx, agent, docId, quoteIn("e2e-35", "Quill garnet marble ember"), `A6.6 peer again ${tag()}`);
  await waitHl(r, T35, true);
  const s1 = await sampleFor(async () => (await frameView(r)).scrollY);
  assert.deepEqual([...new Set(s1)], [0], `a peer's comment scrolled the reader back to the selected passage: ${s1.join(",")}`);
  assert.equal(await r.thread(Q30).first().getAttribute("aria-selected"), "true", "the selection survived the redraw");

  ctx.step("the reader scrolls so the #e2e-20 passage is in view near the top, then selects its thread: nothing moves");
  const placed = await (await r.frame()).evaluate((sel) => {
    const el = document.querySelector(sel);
    scrollTo(0, el.getBoundingClientRect().top + scrollY - 40);
    const rr = el.getBoundingClientRect();
    return { scrollY: Math.round(scrollY), top: rr.top, bottom: rr.bottom, innerHeight };
  }, hlSel(T20));
  precondition(placed.top >= 0 && placed.bottom <= placed.innerHeight && placed.top < placed.innerHeight / 4, `the #e2e-20 passage is in view, near the top: ${JSON.stringify(placed)}`);
  await r.thread(Q20).first().locator(".thread-quote").click({ timeout: LOCAL_MS });
  await eventually(async () => (await r.thread(Q20).first().getAttribute("aria-selected")) === "true", { timeout: LOCAL_MS, message: "the #e2e-20 thread is selected" });
  const s2 = await sampleFor(async () => (await frameView(r)).scrollY);
  assert.deepEqual([...new Set(s2)], [placed.scrollY], `selecting a thread whose passage was already in view scrolled the frame: ${s2.join(",")}`);
});

// --- A6.7 ---------------------------------------------------------------------

scenario("A6.7 a draft that edits commented passages away shows the editor the orphan banner and (no longer in the text), and a viewer of the version neither", { tiers: BOTH, timeoutMs: LONGEST_CASE_MS, ...STALL }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a67-orphan", title: "A6.7 orphans" });
  const [ownerAcct, viewerAcct] = accounts;
  const Q7 = quoteIn("e2e-7", "fennel fable yarrow zephyr");
  const Q8 = quoteIn("e2e-8", "Basil walnut quarry jasper");

  ctx.step("the viewer comments on #e2e-7 in the browser; the owner's agent comments on #e2e-8");
  const v = await reader(ctx, "viewer", viewerAcct, docId);
  await commentOn(v, "#e2e-7", Q7, `A6.7 web ${tag()}`);
  const agent = await agentFor(ctx, owner);
  const T8 = await agentComment(ctx, agent, docId, Q8, `A6.7 agent ${tag()}`);
  const anns = await annotationsOf(docId, 2);
  const T7 = anns.find((a) => a.data.anchor.exact === Q7)?.id;
  precondition(T7, "the viewer's annotation is stored");

  ctx.step("the owner saves a draft without paragraphs #e2e-7 and #e2e-8 (POST /draft, what the editor's autosave sends)");
  const html = FIXTURE_HTML.replace(/<p id="e2e-7">[^<]*<\/p>\n/, "").replace(/<p id="e2e-8">[^<]*<\/p>\n/, "");
  precondition(html.length < FIXTURE_HTML.length && !html.includes('id="e2e-7"') && !html.includes('id="e2e-8"'), "both paragraphs were cut from the draft");
  // The same bytes on the same base: sending it again after a non-answer stores the same draft.
  const { out: saved } = await untilLanded(ctx, `POST /draft ${docId}`, () => owner.http.postJson("/draft", { docId, baseVersion: "v1", html }), null);
  precondition(saved.status === 200, `POST /draft answered ${saved.status} ${saved.text.slice(0, 200)}`);

  ctx.step("the owner, who may edit, opens the document: the frame shows the draft, with both threads orphaned");
  const o = await ctx.users.user({ name: "owner" });
  await o.signInUi(ownerAcct.email, ownerAcct.password, { timeout: PAGE_MS });
  await o.goto(`/d/${encodeURIComponent(docId)}`, { timeout: PAGE_MS });
  await o.waitForFrame({ match: /\/draft\//, timeout: PAGE_MS });
  const banner = o.page.locator(".viewer-banners .banner", { hasText: "no longer match" });
  await banner.waitFor({ state: "visible", timeout: UI_MS });
  const text = (await banner.textContent()).replace(/\s+/g, " ").trim();
  assert.match(text, /^2 comments no longer match the text they were written about\. They are still in the panel\.$/, `the orphan banner: ${JSON.stringify(text)}`);
  await o.openComments({ timeout: UI_MS });
  for (const q of [Q7, Q8]) {
    const t = o.thread(q).first();
    await t.waitFor({ state: "visible", timeout: UI_MS });
    assert.equal((await t.locator(".thread-quote em").textContent()).trim(), "(no longer in the text)", `the "${q}" thread says it is orphaned`);
  }
  assert.deepEqual([await hlCount(o, T7), await hlCount(o, T8)], [0, 0], "an orphan draws nothing in the draft");

  ctx.step("the viewer, who may not edit, reloads: v1 is on screen, both passages are drawn, and there is no orphan banner");
  await v.open(docId, { timeout: PAGE_MS });
  const src = (await v.waitForFrame({ timeout: PAGE_MS })).src;
  assert.match(src, /^\/content\//, `the viewer reads the version, not the draft: ${src}`);
  await Promise.all([waitHl(v, T7, true), waitHl(v, T8, true)]);
  await eventually(async () => (await v.page.locator(".viewer-banners .banner", { hasText: "no longer match" }).count()) === 0, {
    timeout: 15_000,
    stableSamples: 10,
    interval: 150,
    message: "no orphan banner for the viewer",
  });
  await v.openComments({ timeout: UI_MS });
  assert.equal(await v.page.locator(".comments-panel .thread-quote em").count(), 0, "no thread is marked orphaned for the viewer");

  ctx.step("restore the first passage in the draft; the remaining orphan uses singular grammar");
  const oneOrphan = FIXTURE_HTML.replace(/<p id="e2e-8">[^<]*<\/p>\n/, "");
  const restored = await owner.http.postJson("/draft", { docId, baseVersion: "v1", html: oneOrphan });
  precondition(restored.status === 200, "the single-orphan draft saved");
  await o.open(docId, { timeout: PAGE_MS });
  await o.waitForFrame({ match: /\/draft\//, timeout: PAGE_MS });
  const singular = o.page.locator(".viewer-banners .banner", { hasText: "no longer match" });
  await singular.waitFor({ state: "visible", timeout: UI_MS });
  assert.equal((await singular.textContent()).replace(/\s+/g, " ").trim(), "1 comment no longer matches the text it was written about. It is still in the panel.", "one orphan uses singular grammar");
});

// --- A6.8 ---------------------------------------------------------------------

const SVG_DOC = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>E2E SVG labels</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}</style>
</head>
<body>
<h1 id="a68-head">Figure with labels</h1>
<p id="a68-intro">The figure below names two stages of the system.</p>
<figure id="a68-fig">
<svg xmlns="http://www.w3.org/2000/svg" width="520" height="160" viewBox="0 0 520 160">
<rect x="8" y="8" width="504" height="144" fill="none" stroke="#888"/>
<text id="a68-label-1" x="24" y="60" font-size="24">Ingest pipeline stage</text>
<text id="a68-label-2" x="24" y="120" font-size="24">Archive cold storage</text>
</svg>
</figure>
</body>
</html>
`;

scenario("A6.8 a comment on SVG text is wrapped in tspan.bshd-hl, never a mark, and the label keeps its painted width for the commenter and for another reader", { tiers: BOTH, timeoutMs: CASE_MS, ...STALL }, async (ctx) => {
  const { accounts, docId } = await stage(ctx, { name: "a68-svg", title: "A6.8 SVG labels", body: SVG_DOC, filename: "index.html" });
  const [ownerAcct, viewerAcct] = accounts;
  const LABEL = "#a68-label-1";
  const QUOTE = "pipeline";
  const labelState = async (u) =>
    (await u.frame()).evaluate((sel) => {
      const t = document.querySelector(sel);
      return {
        text: t.textContent,
        width: Math.round(t.getBBox().width * 10) / 10,
        tspans: Array.from(t.querySelectorAll("tspan.bshd-hl")).map((s) => s.textContent),
        marksInSvg: document.querySelectorAll("svg mark").length,
      };
    }, LABEL);

  ctx.step("the viewer opens the figure and measures the label before any highlight");
  const v = await reader(ctx, "viewer", viewerAcct, docId);
  const before = await labelState(v);
  precondition(before.text === "Ingest pipeline stage" && before.width > 0 && before.tspans.length === 0, `the label renders: ${JSON.stringify(before)}`);

  ctx.step(`the viewer selects "${QUOTE}" inside the SVG label and comments`);
  const sel = await commentOn(v, LABEL, QUOTE, `A6.8 ${tag()}`);
  ctx.step(`selected via ${sel.via}`);
  assert.equal(sel.text, QUOTE);
  const [ann] = await annotationsOf(docId, 1);
  assert.deepEqual({ elementId: ann.data.anchor.elementId, exact: ann.data.anchor.exact }, { elementId: "a68-label-1", exact: QUOTE }, "anchored to the label");

  for (const [who, u] of [["the commenter", v], ["another reader", await reader(ctx, "owner", ownerAcct, docId)]]) {
    ctx.step(`${who}: the label holds one tspan.bshd-hl with the passage, no <mark> is inside the SVG, and the label's width is unchanged`);
    await waitHl(u, ann.id, true);
    const hl = await (await u.frame()).evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((e) => ({ tag: e.tagName.toLowerCase(), ns: e.namespaceURI, text: e.textContent })), hlSel(ann.id));
    assert.deepEqual(hl, [{ tag: "tspan", ns: "http://www.w3.org/2000/svg", text: QUOTE }], `${who}: the highlight wrapper`);
    const now = await labelState(u);
    assert.deepEqual({ text: now.text, tspans: now.tspans, marksInSvg: now.marksInSvg }, { text: before.text, tspans: [QUOTE], marksInSvg: 0 }, `${who}: the label's content`);
    assert.ok(Math.abs(now.width - before.width) <= 1, `${who}: the label is still painted at its width (${before.width} → ${now.width})`);
  }
});

// --- A6.9 ---------------------------------------------------------------------

scenario("A6.9 an agent's comment is labelled with the token it came through, server-stamped, and a person's reply beside it carries no badge", { tiers: BOTH, timeoutMs: CASE_MS, ...STALL }, async (ctx) => {
  const { owner, accounts, docId } = await stage(ctx, { name: "a69-via", title: "A6.9 via MCP" });
  const [ownerAcct, viewerAcct] = accounts;
  const QUOTE = quoteIn("e2e-6", "Glacier yarrow anchor delta");

  ctx.step("the owner's agent opens a thread with add_comment");
  const agent = await agentFor(ctx, owner);
  const body = `A6.9 agent ${tag()}`;
  const T = await agentComment(ctx, agent, docId, QUOTE, body);
  const [stored] = await commentsOf(docId, T, 1);
  assert.deepEqual(
    { channel: stored.data.actor?.channel, tokenId: stored.data.actor?.tokenId, uid: stored.data.actor?.uid, authorEmail: stored.data.authorEmail },
    { channel: "mcp", tokenId: agent.tokenId, uid: ownerAcct.uid, authorEmail: ownerAcct.email },
    "the comment's actor is the server-derived mcp channel and the token that wrote it",
  );

  ctx.step("the viewer opens the document: the passage is drawn exactly, and the agent's comment carries a badge naming its token");
  const v = await reader(ctx, "viewer", viewerAcct, docId);
  await waitHl(v, T, true);
  assert.equal(((await (await v.frame()).locator(hlSel(T)).allTextContents()).join("")), QUOTE, "the strict anchor highlights exactly the quote");
  await v.openComments({ timeout: UI_MS });
  const thread = v.thread(QUOTE).first();
  const agentComment0 = thread.locator(".comment").first();
  await agentComment0.locator(".comment-body", { hasText: body }).waitFor({ state: "visible", timeout: UI_MS });
  const badge = agentComment0.locator(".comment-head .badge-automated");
  assert.equal(await badge.count(), 1, "one automation badge on the agent's comment");
  const words = (await badge.textContent()).trim();
  assert.match(words, /^via personal token “e2e a06 .+”$/, "the credential in words, as the server stored it");
  assert.equal(await badge.getAttribute("title"), `Posted on ${ownerAcct.email.toLowerCase()}'s behalf by ${words.slice("via ".length)}`);

  ctx.step("the viewer replies in the browser: that comment carries no badge");
  const reply = `A6.9 person ${tag()}`;
  await v.reply(QUOTE, reply, { timeout: UI_MS });
  const mine = thread.locator(".comment", { has: v.page.locator(".comment-body", { hasText: reply }) });
  await mine.waitFor({ state: "visible", timeout: UI_MS });
  assert.equal(await mine.locator(".badge-automated").count(), 0, "a web comment gets no badge");
  assert.equal(await thread.locator(".comment").count(), 2);
});
