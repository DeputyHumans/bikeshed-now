// SPDX-License-Identifier: Apache-2.0
// get_changes end to end: event kinds, the quiet poll, audience, "last" and "all", refused cursors, needsReply, includeMine and paging (SPEC §19).

/**
 * Catalogue A21.1–A21.7, one scenario each, each with its own accounts and
 * documents (the stack is shared with other specs). Expected behaviour is
 * SPEC §4 ("events/{eventId}"), SPEC §19 ("Watching a document: get_changes")
 * and ADR 0016; the source it was checked against is functions/src/lib/events.ts
 * and the get_changes tool in functions/src/mcp/tools.ts.
 *
 *   A21.1  a person's browser thread, comment and resolve reach the owner's
 *          agent as thread.opened, comment.added (body and quote, read from
 *          the source when the log is read) and thread.resolved (by the
 *          resolver), each once, in recorded order; the stored log holds no
 *          body, and no address beyond access.changed's own data (who was
 *          added or removed); an edited body reads as edited and a deleted
 *          comment drops out
 *   A21.2  a quiet poll returns the cursor it was given and writes nothing; a
 *          page of only the caller's own events still moves the cursor; the
 *          next event is reported once from it
 *   A21.3  audience (LOCAL: access.changed is written only by POST /access,
 *          which sends invitations and which the production guard refuses;
 *          the operator script it uses there records no event): a viewer gets
 *          reader events only, never access.changed or another editors' event,
 *          yet its cursor moves past them; an editor gets those; only the
 *          owner gets fork.created, dated to the day and by nobody; the draft
 *          is in `state` for editors only
 *   A21.4  "last" with nothing saved answers from the log's start and says
 *          resumedFrom:"start"; after that it resumes exactly where this
 *          credential left off; a write hands back and moves no cursor;
 *          get_document starts one only when none is saved; "all" returns the
 *          whole log
 *   A21.5  a cursor from another document, malformed ones, one of an unknown
 *          version, "now", "start" and a missing `since` are each a tool error
 *          (never a JSON-RPC error, never read as start or now) and move no
 *          saved cursor
 *   A21.5b a cursor of the server's own shape whose event id is empty: SPEC
 *          §19 says a malformed cursor is refused, never read as "start over".
 *          It probes A21.5's document (whose log is its publish) rather than
 *          staging its own, so run alone it fails its precondition
 *   A21.6  needsReply: open threads on the current version whose latest
 *          comment a person wrote in the browser; never an agent's thread or
 *          an agent's reply, a resolved thread, or an older version's
 *   A21.7  includeMine leaves out only this token's agent events (another token
 *          of the same account, and the same person in the browser, are
 *          reported); pages hold 100, cut on (at, id), `more` exactly when
 *          there is a next page; every response carries `more` and
 *          `retryAfter`
 *
 * WAITING. Events from the three triggers (versions, threads, comments) land
 * after the write that caused them, so every case first waits for the log to
 * hold exactly the events it expects (settleLog, lib/changes.mjs, which reads
 * the stored log through Admin and fails at once on a count past the one
 * wanted) — never by polling get_changes, which would move the very cursors
 * under test. Events the endpoints write (access, trust, visibility, move,
 * fork) commit with the change. No fixed sleeps.
 *
 * THE BROWSER. A person's thread, reply and resolve are the app's own
 * rules-evaluated Firestore writes (app/src/firestore.ts), sent through
 * lib/web.mjs with the Anchor the app makes for the quoted passage (anchorIn).
 *
 * COST. Every write through a function is slow on a loaded emulator, and a
 * transaction slowest (a rename measured 9–42 s on a shared stack), so events
 * come from the cheapest real writer that records them: the browser's own
 * Firestore writes (one commit can open a hundred threads for A21.7's pages)
 * and add_comment / reply_to_comment, which are plain batched writes. The
 * whole file takes about 15 s on a stack of its own and 12–30 minutes on a
 * shared one under load. run.mjs gives the file the sum of its cases'
 * timeoutMs as its budget (lib/budget.mjs), capped at six times the tier
 * default: an hour.
 *
 * EMAIL. Every account is cast with notifications off, so no comment, reply or
 * resolve sends a notice on either tier, and production's quietDoc() holds.
 * Sharing goes through share() (on production the operator script). Only
 * A21.3 needs POST /access itself; it is LOCAL and declares that effect.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { idToken, mintToken, openSession } from "../../lib/session.mjs";
import { createFolderMcp, docIdFor, fork, publishMcp, readFixture } from "../../lib/seed.mjs";
import { setVisibility, share } from "../../lib/grant.mjs";
import { closeAdmin, readDoc } from "../../lib/admin.mjs";
import { clientFirestore } from "../../lib/firestore-client.mjs";
import { changeLog, eventAt, settleLog } from "../../lib/changes.mjs";
import { anchorIn, commentPath, webAnnotationWrite, webReply, webResolve, webThread } from "../../lib/web.mjs";
import { treeConstant } from "../../lib/target.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE_HTML = readFixture("crdt-paragraphs.html");
/** The fixture's paragraphs, by id: plain text, so each is its own textContent. */
const PARA = Object.fromEntries([...FIXTURE_HTML.matchAll(/<p id="(e2e-\d+)">([^<]*)<\/p>/g)].map((m) => [m[1], m[2]]));
/** A passage unique in the document: "Paragraph N." and the next two words. */
const quote = (id) => PARA[id].split(" ").slice(0, 4).join(" ");
/** The Anchor the app makes when a reader selects quote(id) in paragraph #id. */
const anchorOf = (id) => anchorIn(PARA[id], id, quote(id));

/**
 * Every client's request timeout. lib/http.mjs bounds one request at 60 s
 * unless the client says otherwise, and on a loaded shared stack a POST
 * /session and a publish_document have each taken longer (both cut at 60 s in
 * one run), so every client this file makes waits up to three minutes for any
 * one request. The cases' own timeouts still bound the whole.
 */
const REQUEST_MS = 180_000;

/** SPEC §19: a page is 100 events. */
const PAGE = 100;
/**
 * How long the triggers get for A21.7's hundred threads, recorded by a hundred
 * trigger runs (62 of them took over 60 s on a loaded shared stack). Every
 * other settle takes settleLog's own bound, LOG_SETTLE_MS.
 */
const PAGE_SETTLE_MS = 480_000;
/** SPEC §4: the fields an event record may have. */
const EVENT_FIELDS = ["actor", "at", "audience", "commentId", "data", "threadId", "type", "version"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * share() is POST /access on a local stack, which records one access.changed;
 * on production it is the operator's scripts/set-access.mjs, which records none.
 */
const SHARE_EVENTS = target?.kind === "local" ? 1 : 0;

const tag = () => `${runTag(target.runId)}-${rand4()}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

function counts(types) {
  const m = {};
  for (const t of types) m[t] = (m[t] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)));
}
const typesOf = (r) => counts(r.events.map((e) => e.type));

/** An event as get_changes gives it, with `at` checked for its form and taken out. */
function stripAt(e) {
  const { at, ...rest } = e;
  assert.match(String(at), ISO, `event ${e.type}: at is an ISO time (${at})`);
  return rest;
}

// --- the log as stored --------------------------------------------------------

/** Wait until docs/<docId>/events holds exactly `want` ({type: count}); the rows, in recorded order. */
const settle = (docId, want, message, o = {}) => settleLog(target, docId, want, { message, ...o });

// --- agents and people ----------------------------------------------------------

/** A signed-in session of `acct`; its client (and so share, fork, mintToken on it) waits REQUEST_MS. */
const sessionOf = (acct) => openSession(target, acct, { timeoutMs: REQUEST_MS });

/** A personal token of `session`'s account on the mcp channel, initialized. */
async function agentOf(ctx, session, label) {
  const { token, tokenId } = await mintToken(session, { name: `e2e a21 ${label}`, channel: "mcp" });
  const mcp = ctx.mcp({ token, actor: `${session.account.role}-${label}`, timeoutMs: REQUEST_MS });
  await mcp.initialize();
  return { mcp, token, tokenId, uid: session.uid, email: session.account.email, label };
}

/** users/{uid}/cursors/{tokenId}~{docId}: what this credential has saved as "last", or null. */
async function savedCursor(agent, docId) {
  return readDoc(target, `users/${agent.uid}/cursors/${agent.tokenId}~${docId}`);
}

/** get_changes that must succeed; its result. */
async function changes(agent, docId, since, extra = {}) {
  const out = await agent.mcp.call("get_changes", { id: docId, ...(since === undefined ? {} : { since }), ...extra });
  assert.equal(out.isError, false, `get_changes as ${agent.label} (since ${String(since).slice(0, 24)}): ${out.text.slice(0, 300)}`);
  return out.json;
}

/**
 * An owner (and the rest of the cast), all with notifications off; the owner's
 * session and MCP agent "a", which publishes the paragraphs fixture.
 */
async function stage(ctx, roles, name, title) {
  const accounts = await cast(target, ["owner", ...roles], { notifications: false, http: ctx.http({ actor: "harness", timeoutMs: REQUEST_MS }) });
  const owner = await sessionOf(accounts[0]);
  const agent = await agentOf(ctx, owner, "a");
  const pub = await publishMcp(agent.mcp, { title, content: FIXTURE_HTML, format: "html", id: docIdFor(target, name) });
  precondition(!pub.isError && pub.docId, `publish_document: ${pub.text?.slice(0, 300)}`);
  precondition(typeof pub.json.cursor === "string", "publish_document hands back a cursor");
  ctx.step(`the owner's agent published ${pub.docId}`);
  return { accounts, owner, agent, docId: pub.docId, cursor: pub.json.cursor, title };
}

/** A browser of `acct`: a clientFirestore with its own ID token, for the app's writes (lib/web.mjs). */
async function browserOf(ctx, acct) {
  const fs = clientFirestore(target, { idToken: await idToken(target, acct, { timeoutMs: REQUEST_MS }), http: ctx.http({ actor: `${acct.role}-web`, timeoutMs: REQUEST_MS }) });
  return { acct, fs };
}

/** A new thread on quote(elementId), as the app opens one: createAnnotation, then addComment. */
const thread = (w, docId, versionId, elementId, body) => webThread(w.fs, w.acct, { docId, versionId, anchor: anchorOf(elementId), body });
/** A comment on thread `annId`, as the app's addComment writes it; its id. */
const answer = async (w, docId, versionId, annId, body) => (await webReply(w.fs, w.acct, { docId, versionId, annId, body })).commentId;
/** The app's setResolved on thread `annId`. */
const resolveIn = (w, docId, versionId, annId, resolved = true) => webResolve(w.fs, w.acct, { docId, versionId, annId, resolved });

// --- A21.1 ----------------------------------------------------------------------

scenario("A21.1 a browser thread, comment and resolve reach the owner's agent as thread.opened, comment.added (body and quote read from the source) and thread.resolved (by the resolver), once each, in recorded order; the log stores no body or address; an edited body reads edited, a deleted comment drops out", { timeoutMs: 600_000 }, async (ctx) => {
  const { owner, accounts, agent, docId, cursor: c0 } = await stage(ctx, ["viewer"], "a211-kinds", "A21.1 event kinds");
  const [ownerAcct, viewerAcct] = accounts;
  await share(target, { owner, doc: docId, account: viewerAcct, role: "viewer" });
  const [vw, ow] = [await browserOf(ctx, viewerAcct), await browserOf(ctx, ownerAcct)];

  const BODY = `A21.1 first words ${tag()}`;
  ctx.step(`the viewer, in the browser, opens a thread on "${quote("e2e-3")}" saying "${BODY}"; the owner resolves it in the browser`);
  const t = await thread(vw, docId, "v1", "e2e-3", BODY);
  await resolveIn(ow, docId, "v1", t.annId, true);
  const rows = await settle(docId, { "version.published": 1, "access.changed": SHARE_EVENTS, "thread.opened": 1, "comment.added": 1, "thread.resolved": 1 }, "the publish, the share, the thread, its comment and the resolve are recorded");

  ctx.step("SPEC §4: each stored event has only the log's fields and an actor of uid, channel and token; no body is stored, and no address outside access.changed's own data (who was added or removed)");
  for (const r of rows) {
    assert.deepEqual(Object.keys(r.data).filter((k) => !EVENT_FIELDS.includes(k)), [], `${r.data.type}: fields outside SPEC §4's list`);
    if (r.data.actor) assert.deepEqual(Object.keys(r.data.actor).filter((k) => !["uid", "channel", "tokenId"].includes(k)), [], `${r.data.type}: the actor carries more than uid, channel and token`);
    const { data, ...rest } = r.data;
    const raw = JSON.stringify(rest) + (r.data.type === "access.changed" ? "" : JSON.stringify(data ?? null));
    for (const secret of [viewerAcct.email, ownerAcct.email]) assert.ok(!raw.includes(secret), `${r.data.type}: the stored event holds the address ${secret}`);
    assert.ok(!JSON.stringify(r.data).includes(BODY), `${r.data.type}: the stored event holds the comment's body`);
  }

  ctx.step("the owner's agent polls from the cursor publish_document gave it");
  const r1 = await changes(agent, docId, c0);
  const visible = rows.filter((r) => r.data.type !== "version.published"); // the agent's own publish: left out without includeMine
  assert.deepEqual(r1.events.map((e) => [e.type, e.at]), visible.map((r) => [r.data.type, eventAt(r)]), "every event but the agent's own publish, each once, in recorded order");
  const byType = Object.fromEntries(r1.events.map((e) => [e.type, stripAt(e)]));
  const common = { channel: "web", version: "v1", threadId: t.annId, quote: t.anchor.exact };
  assert.deepEqual(byType["thread.opened"], { type: "thread.opened", ...common, by: viewerAcct.email }, "thread.opened: by its author, with the passage");
  assert.deepEqual(byType["comment.added"], { type: "comment.added", ...common, commentId: t.commentId, by: viewerAcct.email, body: BODY }, "comment.added: body and quote");
  assert.deepEqual(byType["thread.resolved"], { type: "thread.resolved", ...common, by: ownerAcct.email }, "thread.resolved: by whoever resolved it, not by its author");

  ctx.step("the viewer rewords the comment in the browser: the feed reads the body from the source");
  const REWORDED = `${BODY} (reworded)`;
  const edit = await vw.fs.update(commentPath(docId, "v1", t.annId, t.commentId), { body: REWORDED });
  precondition(edit.ok, `the author's rewording: ${edit.status} ${edit.code}`);
  const r2 = await changes(agent, docId, c0);
  assert.deepEqual(r2.events.filter((e) => e.type === "comment.added").map((e) => e.body), [REWORDED], "the body as it is now, not as it was");

  ctx.step("the viewer adds a second comment; once its event is recorded, deletes it: it drops out of the feed, the log keeps the event");
  const SECOND = `A21.1 second words ${tag()}`;
  const c2 = await answer(vw, docId, "v1", t.annId, SECOND);
  const withSecond = await settle(docId, { "version.published": 1, "access.changed": SHARE_EVENTS, "thread.opened": 1, "comment.added": 2, "thread.resolved": 1 }, "the second comment is recorded");
  precondition(withSecond.some((r) => r.data.commentId === c2), "the second comment's event is in the log");
  const gone = await vw.fs.remove(commentPath(docId, "v1", t.annId, c2));
  precondition(gone.ok, `the author's delete: ${gone.status} ${gone.code}`);
  const r3 = await changes(agent, docId, c0);
  assert.deepEqual(
    r3.events.filter((e) => e.type === "comment.added").map((e) => [e.commentId, e.body]),
    [[t.commentId, REWORDED]],
    "the deleted comment is gone from the feed, and nothing of it is reported",
  );
  assert.equal((await changeLog(target, docId)).filter((r) => r.data.type === "comment.added").length, 2, "the log itself is never pruned: both comment.added events are stored");
});

// --- A21.2 ----------------------------------------------------------------------

scenario("A21.2 a quiet poll returns the same cursor and writes nothing; a page of only the caller's own events still moves the cursor; the next event is reported once from it", { timeoutMs: 480_000 }, async (ctx) => {
  const { owner, accounts, agent, docId } = await stage(ctx, [], "a212-quiet", "A21.2 quiet poll");
  const START = b64({ v: 1, d: docId });
  await settle(docId, { "version.published": 1 }, "the publish is recorded");

  ctx.step('"all" as the publishing agent: its own publish is left out, yet the cursor moves past it');
  const r1 = await changes(agent, docId, "all");
  assert.deepEqual(r1.events, [], "the only event is the caller's own, left out without includeMine");
  assert.notEqual(r1.cursor, START, "a page of only the caller's own events still moves the cursor past them");
  const c1 = r1.cursor;
  const saved1 = await savedCursor(agent, docId);
  assert.equal(saved1?.cursor, c1, "the poll saved its cursor as this credential's last");

  ctx.step("three quiet polls: from that cursor, with includeMine, and as \"last\"");
  for (const [label, since, extra] of [["the cursor", c1, {}], ["the cursor, includeMine", c1, { includeMine: true }], ['"last"', "last", {}]]) {
    const q = await changes(agent, docId, since, extra);
    assert.deepEqual({ cursor: q.cursor, events: q.events, more: q.more, resumed: "resumedFrom" in q }, { cursor: c1, events: [], more: false, resumed: false }, `a quiet poll (since ${label}) returns the same cursor`);
  }
  const saved2 = await savedCursor(agent, docId);
  assert.ok(saved2?.cursor === c1 && saved2.updatedAt.isEqual(saved1.updatedAt), `a quiet poll writes nothing (ADR 0016): updatedAt ${saved1.updatedAt.toDate().toISOString()} → ${saved2?.updatedAt?.toDate?.().toISOString()}`);

  ctx.step("another token of the same account comments; once recorded, the poll from the quiet cursor reports exactly that thread, once");
  const other = await agentOf(ctx, owner, "b");
  const T = await other.mcp.ok("add_comment", { id: docId, exact: quote("e2e-2"), body: `A21.2 ${tag()}` });
  await settle(docId, { "version.published": 1, "thread.opened": 1, "comment.added": 1 }, "the comment is recorded");
  const r2 = await changes(agent, docId, c1);
  assert.deepEqual(r2.events.map((e) => [e.type, e.threadId, e.channel, e.by]).sort(), [["comment.added", T.threadId, "mcp", accounts[0].email], ["thread.opened", T.threadId, "mcp", accounts[0].email]], "the new thread's two events, once each");
  assert.notEqual(r2.cursor, c1, "the cursor moves past them");
  const r3 = await changes(agent, docId, r2.cursor);
  assert.deepEqual({ cursor: r3.cursor, events: r3.events }, { cursor: r2.cursor, events: [] }, "and from there the poll is quiet again, with the same cursor");
});

// --- A21.3 ----------------------------------------------------------------------

scenario("A21.3 audience: a viewer never receives access.changed or another editors' event (trust, visibility, move) yet its cursor moves past them; an editor receives them; only the owner receives fork.created, dated to the day; the draft is in state for editors only", {
  tiers: ["local"],
  effects: ["email:POST /access"],
  timeoutMs: 600_000,
}, async (ctx) => {
  const { owner, accounts, agent, docId } = await stage(ctx, ["viewer", "editor"], "a213-audience", "A21.3 audience");
  const [ownerAcct, viewerAcct, editorAcct] = accounts;

  ctx.step("the owner shares with a viewer and an editor (POST /access, two access.changed), trusts the document (doc.trust), opens and closes an unlisted link (two doc.visibility) and files it in a new folder (doc.moved)");
  await share(target, { owner, doc: docId, account: viewerAcct, role: "viewer" });
  await share(target, { owner, doc: docId, account: editorAcct, role: "editor" });
  await owner.http.postJson("/trust", { docId, trusted: true }, { expect: 200 });
  await setVisibility(target, { owner, doc: docId, visibility: "unlisted" });
  await setVisibility(target, { owner, doc: docId, visibility: "private" });
  const folder = await createFolderMcp(agent.mcp, { name: `A21.3 ${tag()}`, ownerEmail: ownerAcct.email });
  precondition(!folder.isError && folder.folderId, `create_folder: ${folder.text?.slice(0, 200)}`);
  await agent.mcp.ok("move_document", { id: docId, folder: folder.folderId });

  ctx.step("the viewer comments in the browser (thread.opened and comment.added, reader events) and forks the document (fork.created)");
  await thread(await browserOf(ctx, viewerAcct), docId, "v1", "e2e-6", `A21.3 ${tag()}`);
  const [viewer, editor] = [await sessionOf(viewerAcct), await sessionOf(editorAcct)];
  await fork(viewer.http, { docId, title: `A21.3 fork ${tag()}`, ownerEmail: viewerAcct.email, expect: 200 });
  const ALL = { "version.published": 1, "access.changed": 2, "doc.trust": 1, "doc.visibility": 2, "doc.moved": 1, "thread.opened": 1, "comment.added": 1, "fork.created": 1 };
  await settle(docId, ALL, "every change is recorded");

  ctx.step('each reads "all" with includeMine: the viewer, the editor, the owner');
  const [va, ea] = [await agentOf(ctx, viewer, "v"), await agentOf(ctx, editor, "e")];
  const rv = await changes(va, docId, "all", { includeMine: true });
  const re = await changes(ea, docId, "all", { includeMine: true });
  const ro = await changes(agent, docId, "all", { includeMine: true });
  const { "fork.created": _owner, ...EDITOR } = ALL;
  assert.deepEqual(typesOf(rv), counts(["version.published", "thread.opened", "comment.added"]), "a viewer receives reader events only: no access.changed, doc.trust, doc.visibility, doc.moved or fork.created");
  assert.deepEqual(typesOf(re), counts(Object.entries(EDITOR).flatMap(([t, n]) => Array(n).fill(t))), "an editor receives the editors' events (sharing, trust, visibility, the move) and not fork.created");
  assert.deepEqual(typesOf(ro), counts(Object.entries(ALL).flatMap(([t, n]) => Array(n).fill(t))), "the owner receives every event, fork.created included");
  assert.deepEqual([rv.cursor, re.cursor], [ro.cursor, ro.cursor], "every reader's cursor is the position after the last event read, whoever may see it");

  ctx.step("what an editor learns from access.changed, and what the owner learns of the fork");
  assert.deepEqual(
    re.events.filter((e) => e.type === "access.changed").map(stripAt),
    [
      { type: "access.changed", channel: "web", added: [viewerAcct.email], removed: [], by: ownerAcct.email },
      { type: "access.changed", channel: "web", added: [editorAcct.email], removed: [], by: ownerAcct.email },
    ],
    "access.changed: who was added and removed, and by whom",
  );
  const forked = ro.events.filter((e) => e.type === "fork.created");
  assert.equal(forked.length, 1);
  assert.match(forked[0].at, DAY, "a fork is dated to the day (SPEC §21)");
  assert.deepEqual(Object.keys(forked[0]).sort(), ["at", "type"], "and never by whom: no by, no channel");

  ctx.step("state: whether a draft exists is the editors' business");
  assert.equal("draft" in rv.state, false, "the viewer's state says nothing about a draft");
  assert.deepEqual([re.state.draft, ro.state.draft], [{ exists: false }, { exists: false }], "the editor's and the owner's do");
});

// --- A21.4 ----------------------------------------------------------------------

scenario("A21.4 \"last\" with nothing saved answers from the start with resumedFrom:\"start\", then resumes exactly where the credential left off; a write moves no cursor; get_document starts one only when none is saved; \"all\" returns the whole log", { timeoutMs: 900_000 }, async (ctx) => {
  const { owner, agent, docId } = await stage(ctx, [], "a214-last", "A21.4 last and all");
  const T = await agent.mcp.ok("add_comment", { id: docId, exact: quote("e2e-4"), body: `A21.4 opening ${tag()}` });
  const log = await settle(docId, { "version.published": 1, "thread.opened": 1, "comment.added": 1 }, "the publish and agent a's thread are recorded");
  let comments = 1;
  /** A reply by `who` on T; resolves once its comment.added is in the log. */
  const reply = async (who, words) => {
    const r = await who.mcp.ok("reply_to_comment", { id: docId, threadId: T.threadId, body: `${words} ${tag()}` });
    comments += 1;
    await settle(docId, { "version.published": 1, "thread.opened": 1, "comment.added": comments }, `${who.label}'s reply is recorded`);
    return r;
  };
  const added = (r) => r.events.map((e) => [e.type, e.commentId]);

  ctx.step('a token minted now, with nothing saved for this document, asks for "last"');
  const fresh = await agentOf(ctx, owner, "b");
  precondition((await savedCursor(fresh, docId)) === null, "the new token has no saved cursor for the document");
  const first = await changes(fresh, docId, "last");
  assert.equal(first.resumedFrom, "start", "nothing saved: answered from the start, and said so");
  assert.deepEqual(first.events.map((e) => [e.type, e.at]), log.map((r) => [r.data.type, eventAt(r)]), "every event in the log, in recorded order");
  assert.equal(first.more, false);

  ctx.step('"last" again resumes where it left off; "all" returns the whole log again');
  const again = await changes(fresh, docId, "last");
  assert.deepEqual({ resumed: "resumedFrom" in again, events: again.events, cursor: again.cursor }, { resumed: false, events: [], cursor: first.cursor }, '"last" with a saved cursor: nothing new, no resumedFrom');
  const all = await changes(fresh, docId, "all");
  assert.equal("resumedFrom" in all, false, '"all" says nothing of resuming');
  assert.deepEqual(all.events, first.events, '"all" returns the whole log');
  assert.equal(all.cursor, first.cursor);

  ctx.step('agent a replies: "last" reports exactly that');
  const ra = await reply(agent, "A21.4 agent a again");
  const next = await changes(fresh, docId, "last");
  assert.deepEqual(added(next), [["comment.added", ra.commentId]], "the one event after the saved cursor");

  ctx.step('the token\'s own write hands back no cursor and moves none: its "last" with includeMine then reports that write');
  const before = (await savedCursor(fresh, docId))?.cursor;
  assert.equal(before, next.cursor, "the poll saved its cursor");
  const own = await reply(fresh, "A21.4 the fresh token writes");
  assert.equal("cursor" in own, false, "a write hands back no cursor (SPEC §19)");
  assert.equal((await savedCursor(fresh, docId))?.cursor, before, "and moves none");
  const mine = await changes(fresh, docId, "last", { includeMine: true });
  assert.deepEqual(added(mine), [["comment.added", own.commentId]], "the write is still ahead of this credential's cursor");

  ctx.step("get_document starts a cursor for a credential with none, and never overwrites one");
  const reader = await agentOf(ctx, owner, "c");
  const g1 = await reader.mcp.ok("get_document", { id: docId });
  assert.equal((await savedCursor(reader, docId))?.cursor, g1.cursor, "get_document saved its cursor: none was saved");
  const quiet = await changes(reader, docId, "last");
  assert.deepEqual({ resumed: "resumedFrom" in quiet, events: quiet.events, cursor: quiet.cursor }, { resumed: false, events: [], cursor: g1.cursor }, "watching starts at the head get_document gave");
  const rb = await reply(agent, "A21.4 agent a once more");
  const g2 = await reader.mcp.ok("get_document", { id: docId });
  assert.notEqual(g2.cursor, g1.cursor, "get_document hands back the head of the log");
  assert.equal((await savedCursor(reader, docId))?.cursor, g1.cursor, "but does not overwrite the saved cursor");
  const later = await changes(reader, docId, "last");
  assert.deepEqual(added(later), [["comment.added", rb.commentId]], "so the reply after it is still reported");
});

// --- A21.5 and A21.5b --------------------------------------------------------------

scenario("A21.5 a cursor from another document, a malformed one, one of an unknown version, \"now\", \"start\" and a missing since are each a tool error, never read as start or now, and move no saved cursor", { timeoutMs: 420_000 }, async (ctx) => {
  const { agent, docId: A, cursor: cA } = await stage(ctx, [], "a215-a", "A21.5 cursor A");
  const pubB = await publishMcp(agent.mcp, { title: "A21.5 cursor B", content: FIXTURE_HTML, format: "html", id: docIdFor(target, "a215-b") });
  precondition(!pubB.isError && pubB.docId, `publish_document B: ${pubB.text?.slice(0, 200)}`);
  const B = pubB.docId;
  await settle(A, { "version.published": 1 }, "A's publish is recorded");
  await settle(B, { "version.published": 1 }, "B's publish is recorded");

  ctx.step("positive controls: each document's own cursors are accepted");
  await changes(agent, A, cA, { includeMine: true });
  const okB = await changes(agent, B, pubB.json.cursor, { includeMine: true });
  await changes(agent, A, b64({ v: 1, d: A }));
  const savedA = await savedCursor(agent, A);
  precondition(savedA?.cursor, "the polls on A saved a cursor");
  ctx.step(`A's saved cursor after the controls: ${savedA.cursor.slice(0, 16)}…`);

  const FOREIGN = /^since: that cursor belongs to another document, not "[^"]+"\. Pass a cursor/;
  const MALFORMED = /^since: that is not a cursor this server gave out\. Pass a cursor/;
  const refusals = [
    ["a cursor from another document is refused", okB.cursor, FOREIGN],
    ["another document's start cursor is refused", b64({ v: 1, d: B }), FOREIGN],
    ["a malformed cursor is refused", "not-a-cursor", MALFORMED],
    ['"now" is refused, never read as now', "now", MALFORMED],
    ['"start" is refused, never read as the start', "start", MALFORMED],
    ["a cursor of an unknown version is refused", b64({ v: 2, d: A }), MALFORMED],
    ["a cursor whose position is not numbers is refused", b64({ v: 1, d: A, s: "1", n: 0, e: "x" }), MALFORMED],
    ["a partial position is refused", b64({ v: 1, d: A, n: 0, e: "x" }), MALFORMED],
    ["negative nanoseconds are refused", b64({ v: 1, d: A, s: 1, n: -1, e: "x" }), MALFORMED],
    ["overflowing nanoseconds are refused", b64({ v: 1, d: A, s: 1, n: 1e9, e: "x" }), MALFORMED],
    ["overflowing seconds are refused", b64({ v: 1, d: A, s: 253402300800, n: 0, e: "x" }), MALFORMED],
    ["an event path is refused", b64({ v: 1, d: A, s: 1, n: 0, e: "a/b" }), MALFORMED],
  ];
  for (const [what, since, re] of refusals) {
    ctx.step(what);
    const out = await agent.mcp.call("get_changes", { id: A, since });
    assert.equal(out.isError, true, `${what}: it answered ${out.json ? `${out.json.events?.length} event(s), cursor ${String(out.json.cursor).slice(0, 16)}` : out.text.slice(0, 200)}`);
    assert.match(out.text, re, `${what}: the reason`);
    if (re === FOREIGN) assert.ok(out.text.includes(`not "${A}"`), `${what}: it names the document asked about`);
  }
  ctx.step("since left out: the schema's required argument");
  const missing = await agent.mcp.call("get_changes", { id: A });
  assert.equal(missing.isError, true, "a get_changes without since is refused");
  assert.match(missing.text, /missing required argument "since"/);

  const after = await savedCursor(agent, A);
  assert.ok(after?.cursor === savedA.cursor && after.updatedAt.isEqual(savedA.updatedAt), "no refusal moved or rewrote the saved cursor");
});

scenario("A21.5b a cursor of the server's own shape whose event id is empty is refused, never read as the log's start", { timeoutMs: 180_000 }, async (ctx) => {
  const { agent, docId } = await stage(ctx, [], "a215b-empty", "A21.5b malformed cursor");
  const mcp = agent.mcp;
  await settle(docId, { "version.published": 1 }, "the publish is recorded");
  const head = await changes(agent, docId, "all", { includeMine: true });
  precondition(head.events.length === 1 && head.events[0].type === "version.published" && head.more === false, "the whole log is this document's publish");
  const real = unb64(head.cursor);
  precondition(typeof real.s === "number" && typeof real.n === "number" && typeof real.e === "string" && real.e.length > 0, `a server cursor is {v, d, s, n, e}: ${JSON.stringify(Object.keys(real))}`);

  ctx.step("positive control: the server's own cursor at the head is a quiet poll");
  const quiet = await changes(agent, docId, head.cursor, { includeMine: true });
  assert.deepEqual(quiet.events, [], "the head is the head");

  ctx.step("the same position with an empty event id: SPEC §19, a malformed cursor is refused, never read as start over");
  const forged = b64({ ...real, e: "" });
  const out = await mcp.call("get_changes", { id: docId, since: forged, includeMine: true });
  ctx.ev.json("empty-id-answer", { isError: out.isError, text: out.isError ? out.text : undefined, events: out.json?.events?.map((e) => e.type), cursor: out.json?.cursor ? unb64(out.json.cursor) : null });
  assert.equal(out.isError, true, `a cursor with an empty event id was not refused: it was read from the start of the log (${out.json?.events?.length} event(s): ${out.json?.events?.map((e) => e.type).join(", ")}; cursor back ${JSON.stringify(out.json?.cursor ? unb64(out.json.cursor) : null)})`);
});

// --- A21.6 ----------------------------------------------------------------------

scenario("A21.6 needsReply names only open threads on the current version whose latest comment a person wrote in the browser: never an agent's thread or reply, a resolved thread, or an older version's", { timeoutMs: 1_200_000 }, async (ctx) => {
  const { owner, accounts, agent, docId } = await stage(ctx, ["viewer"], "a216-needs-reply", "A21.6 needsReply");
  const viewerAcct = accounts[1];
  await share(target, { owner, doc: docId, account: viewerAcct, role: "viewer" });
  const vw = await browserOf(ctx, viewerAcct);
  const otherAgent = await agentOf(ctx, owner, "b");
  const needs = async (extra = {}) => [...(await changes(agent, docId, "all", extra)).needsReply].sort();
  const sorted = (...ids) => [...ids].sort();

  ctx.step("the viewer opens T1, T3 and T4 in the browser; another agent (the owner's second token) opens T2");
  const T1 = await thread(vw, docId, "v1", "e2e-1", `A21.6 T1 ${tag()}`);
  const T2 = await otherAgent.mcp.ok("add_comment", { id: docId, exact: quote("e2e-2"), body: `A21.6 T2 from an agent ${tag()}` });
  const T3 = await thread(vw, docId, "v1", "e2e-3", `A21.6 T3 ${tag()}`);
  const T4 = await thread(vw, docId, "v1", "e2e-4", `A21.6 T4 ${tag()}`);
  await settle(docId, { "version.published": 1, "access.changed": SHARE_EVENTS, "thread.opened": 4, "comment.added": 4 }, "four threads and their first comments are recorded");
  const r0 = await changes(agent, docId, "all");
  assert.ok(r0.events.some((e) => e.type === "comment.added" && e.threadId === T2.threadId && e.channel === "mcp"), "the agent's thread is in the page: its exclusion below is needsReply's doing");
  assert.deepEqual([...r0.needsReply].sort(), sorted(T1.annId, T3.annId, T4.annId), "needsReply names the people's threads, never the agent-opened T2");

  ctx.step("the owner's agent replies on T3; the viewer resolves T4 in the browser");
  await agent.mcp.ok("reply_to_comment", { id: docId, threadId: T3.annId, body: `A21.6 the agent answers ${tag()}` });
  await resolveIn(vw, docId, "v1", T4.annId, true);
  await settle(docId, { "version.published": 1, "access.changed": SHARE_EVENTS, "thread.opened": 4, "comment.added": 5, "thread.resolved": 1 }, "the agent's reply and the resolve are recorded");
  assert.deepEqual(await needs(), [T1.annId], "needsReply: T3's latest comment is an agent's, T4 is resolved");
  assert.deepEqual(await needs({ includeMine: true }), [T1.annId], "the same with includeMine: an agent's reply never asks for one");

  ctx.step("the viewer answers the agent on T3 in the browser: a person is waiting again");
  await answer(vw, docId, "v1", T3.annId, `A21.6 the viewer answers back ${tag()}`);
  await settle(docId, { "version.published": 1, "access.changed": SHARE_EVENTS, "thread.opened": 4, "comment.added": 6, "thread.resolved": 1 }, "the viewer's answer is recorded");
  assert.deepEqual(await needs(), sorted(T1.annId, T3.annId), "T3 is back: its latest comment is the person's");

  ctx.step("the owner's agent publishes v2: v1's threads are no longer the current version's");
  const v2 = await agent.mcp.ok("update_document", { id: docId, baseVersion: "v1", content: FIXTURE_HTML.replace("</body>", `<p id="e2e-a21-v2">A21.6 second version.</p>\n</body>`) });
  precondition(v2.versionId === "v2", `update_document made v2: ${JSON.stringify(v2).slice(0, 200)}`);
  await settle(docId, { "version.published": 2, "access.changed": SHARE_EVENTS, "thread.opened": 4, "comment.added": 6, "thread.resolved": 1 }, "v2 is recorded");
  assert.deepEqual(await needs(), [], "nothing on v1 needs a reply once v2 is current");

  ctx.step("the viewer opens T5 on v2 in the browser");
  const T5 = await thread(vw, docId, "v2", "e2e-5", `A21.6 T5 on v2 ${tag()}`);
  await settle(docId, { "version.published": 2, "access.changed": SHARE_EVENTS, "thread.opened": 5, "comment.added": 7, "thread.resolved": 1 }, "T5 is recorded");
  assert.deepEqual(await needs(), [T5.annId], "needsReply: the open person's thread on the current version");
});

// --- A21.7 ----------------------------------------------------------------------

scenario("A21.7 includeMine leaves out only this token's agent events (another token of the account and the browser are reported); pages hold 100, cut on (at, id), more exactly when a page follows; every response carries more and retryAfter", { timeoutMs: 900_000 }, async (ctx) => {
  const { owner, accounts, agent: ta, docId } = await stage(ctx, [], "a217-mine", "A21.7 includeMine");
  const ownerAcct = accounts[0];
  const RETRY_AFTER = Number(treeConstant(target, "functions/src/mcp/tools.ts", "RETRY_AFTER_SECONDS"));
  const shape = (r, what) => {
    assert.equal(typeof r.more, "boolean", `${what}: more is a boolean`);
    assert.equal(r.retryAfter, RETRY_AFTER, `${what}: retryAfter is ${RETRY_AFTER} s`);
    assert.equal(typeof r.cursor, "string", `${what}: a cursor`);
    assert.ok(Array.isArray(r.events) && Array.isArray(r.needsReply) && r.state && typeof r.state === "object", `${what}: events, needsReply and state`);
  };

  ctx.step("agent a (token A) comments on #e2e-1; agent b (token B, same account) on #e2e-2; the owner in the browser on #e2e-3");
  const tb = await agentOf(ctx, owner, "b");
  const T1 = await ta.mcp.ok("add_comment", { id: docId, exact: quote("e2e-1"), body: `A21.7 by token A ${tag()}` });
  const T2 = await tb.mcp.ok("add_comment", { id: docId, exact: quote("e2e-2"), body: `A21.7 by token B ${tag()}` });
  const T3 = await thread(await browserOf(ctx, ownerAcct), docId, "v1", "e2e-3", `A21.7 in the browser ${tag()}`);
  await settle(docId, { "version.published": 1, "thread.opened": 3, "comment.added": 3 }, "the publish and three threads are recorded");

  const seen = (r) => r.events.map((e) => `${e.type}${e.threadId ? `:${e.threadId}` : ""}`).sort();
  const opened = (id) => [`comment.added:${id}`, `thread.opened:${id}`];
  // "all", not publish_document's cursor: that one is the head when the publish
  // returned, which the publish's own event may or may not have reached yet.
  const rA = await changes(ta, docId, "all");
  shape(rA, "token A");
  assert.deepEqual(seen(rA), [...opened(T2.threadId), ...opened(T3.annId)].sort(), "token A: its own thread and publish are left out; token B's and the browser's are reported");
  assert.ok(rA.events.filter((e) => e.threadId === T3.annId).every((e) => e.channel === "web" && e.by === ownerAcct.email), "the same person in the browser is reported, as web");
  const rAll = await changes(ta, docId, "all", { includeMine: true });
  assert.deepEqual(seen(rAll), ["version.published", ...opened(T1.threadId), ...opened(T2.threadId), ...opened(T3.annId)].sort(), "token A with includeMine: everything");
  const rB = await changes(tb, docId, "all");
  assert.deepEqual(seen(rB), ["version.published", ...opened(T1.threadId), ...opened(T3.annId)].sort(), "token B: token A's publish and thread are reported, its own thread is not");

  ctx.step("paging: the owner opens 100 more threads in the browser, in one commit");
  const D = docId;
  const ob = await browserOf(ctx, ownerAcct);
  const ids = Object.keys(PARA);
  const writes = Array.from({ length: PAGE }, (_, i) => webAnnotationWrite(ob.fs, ownerAcct, { docId: D, versionId: "v1", anchor: anchorOf(ids[i % ids.length]) }).write);
  const committed = await ob.fs.commit(writes);
  precondition(committed.ok, `the browser's commit of ${PAGE} annotations: ${committed.status} ${committed.code} ${committed.message}`);
  const log = await settle(D, { "version.published": 1, "thread.opened": 3 + PAGE, "comment.added": 3 }, "the 100 threads are recorded", { timeout: PAGE_SETTLE_MS });
  const want = log.map((r) => [r.data.type, eventAt(r)]);
  const before = 7; // the publish and the three threads above, each opened with a comment

  ctx.step("exactly a page after the first seven events: 100 events and more is false");
  const exact = await changes(ta, D, rAll.cursor);
  shape(exact, "an exactly full page");
  assert.deepEqual({ n: exact.events.length, more: exact.more }, { n: PAGE, more: false }, "exactly 100 events left: one page, and no more");
  assert.deepEqual(exact.events.map((e) => [e.type, e.at]), want.slice(before), "the threads, in recorded order");

  ctx.step('"all": 107 events are a page of 100 with more, then a page of 7 without');
  const page1 = await changes(ta, D, "all", { includeMine: true });
  shape(page1, "page 1");
  assert.deepEqual({ n: page1.events.length, more: page1.more }, { n: PAGE, more: true }, "page 1 holds 100 and says more");
  const page2 = await changes(ta, D, page1.cursor, { includeMine: true });
  shape(page2, "page 2");
  assert.deepEqual({ n: page2.events.length, more: page2.more }, { n: before, more: false }, "page 2 holds the rest");
  const both = [...page1.events, ...page2.events];
  assert.deepEqual(both.map((e) => [e.type, e.at]), want, "the two pages are the whole log, in recorded order");
  assert.equal(new Set(both.map((e) => `${e.type}:${e.threadId ?? ""}`)).size, PAGE + before, "each event once (I15)");
  const quiet = await changes(ta, D, page2.cursor, { includeMine: true });
  shape(quiet, "a quiet poll");
  assert.deepEqual({ n: quiet.events.length, more: quiet.more, cursor: quiet.cursor }, { n: 0, more: false, cursor: page2.cursor }, "after the last page: quiet");

  ctx.step('"all" without includeMine: the page is cut on the log, not on what the caller sees');
  const hidden = await changes(ta, D, "all");
  shape(hidden, "a page with the caller's own events left out");
  const ownInPage1 = page1.events.filter((e) => e.type === "version.published" || e.threadId === T1.threadId).length;
  precondition(ownInPage1 === 3, `token A's publish and thread are in page 1 (${ownInPage1})`);
  assert.deepEqual({ n: hidden.events.length, more: hidden.more, cursor: hidden.cursor }, { n: PAGE - ownInPage1, more: true, cursor: page1.cursor }, "97 shown of the 100 read, more, and the cursor after the 100th");
});
