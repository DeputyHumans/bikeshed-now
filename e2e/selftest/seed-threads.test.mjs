// SPDX-License-Identifier: Apache-2.0
// Self-test: seedThreads opens n threads as add_comment opens one, by n tool calls or by one call and Admin copies of what it wrote (SPEC §4, §12, §19).

/**
 * The real mcpClient over http.mjs, a fake fetch standing in for POST /mcp.
 * Its add_comment does what the product's does (functions/src/mcp/tools.ts):
 * one batch of the thread and its first comment into an in-memory Firestore
 * stand-in, createdAt the server's time, the body trimmed. seedThreads' Admin
 * path is given that stand-in as `db`, so what it copies is what the "product"
 * wrote, and every copy can be compared field by field. No stack.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { createHttp } from "../lib/http.mjs";
import { mcpClient } from "../lib/mcp.mjs";
import { SEED_THREADS_MAX, SEED_THREADS_VIA, seedThreads } from "../lib/seed.mjs";
import { stackDidNotAnswer } from "../lib/test.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const DOC = "e2e-thr0ad-a20-comments-ab12";
const AUTHOR = { uid: "uidAuthor0001", email: "owner-0thr-abcd@example.com" };
const local = () => Object.freeze({ kind: "local", runId: "2610120500-thr0", runDir: tempDir("e2e-thr-"), origin: "http://127.0.0.1:39051", stack: { ports: { hosting: 39051 } } });
const prod = () => Object.freeze({ kind: "prod", runId: "2610120500-thr0", origin: "https://thr-selftest.invalid", runDir: tempDir("e2e-thr-prod-") });

/** An in-memory stand-in for the Admin SDK's Firestore: doc/collection refs, get, auto ids, batches of create. */
function memoryDb() {
  const store = new Map();
  const commits = [];
  let auto = 0;
  const childrenOf = (path) => [...store.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/")).sort();
  const docRef = (path) => ({
    id: path.split("/").at(-1),
    path,
    get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
    collection: (name) => colRef(`${path}/${name}`),
  });
  const colRef = (path) => ({
    path,
    doc: (id) => docRef(`${path}/${id ?? `zAuto${String((auto += 1)).padStart(5, "0")}`}`),
    get: async () => {
      const docs = childrenOf(path).map((k) => ({ id: k.split("/").at(-1), data: () => store.get(k) }));
      return { docs, size: docs.length };
    },
  });
  return {
    store,
    commits,
    reads: 0,
    doc: docRef,
    collection: colRef,
    batch() {
      const ops = [];
      return {
        create: (ref, data) => ops.push([ref.path, data]),
        async commit() {
          for (const [p] of ops) if (store.has(p)) throw new Error(`6 ALREADY_EXISTS: ${p}`);
          for (const [p, d] of ops) store.set(p, d);
          commits.push(ops.length);
        },
      };
    },
  };
}

/**
 * A db that must never be touched: the tool path reads and writes nothing
 * through the Admin SDK. Every call on a production-shaped target passes it,
 * so no planted bug can reach a real Admin app from a self-test.
 */
const untouchable = new Proxy({}, { get: (_, k) => { throw new Error(`the Admin db was used (${String(k)})`); } });

/**
 * POST /mcp whose add_comment writes as the product does: the thread
 * {annId, anchor, authorUid, authorEmail, actor, createdAt, color, resolved}
 * and its comment {commentId, body, authorUid, authorEmail, actor, createdAt}.
 * `refuse(args, n)` → a tool error's text, or null.
 */
function server(db, { refuse = () => null, version = "v1" } = {}) {
  const calls = [];
  let made = 0;
  const fetch = async (url, init) => {
    const msg = JSON.parse(init.body);
    const args = msg.params?.arguments ?? {};
    calls.push({ path: new URL(url).pathname, name: msg.params?.name, args });
    const no = refuse(args, calls.length);
    let result;
    if (no) result = { content: [{ type: "text", text: no }], isError: true };
    else {
      made += 1;
      const annId = `ann${String(made).padStart(3, "0")}`;
      const commentId = `com${String(made).padStart(3, "0")}`;
      const author = { authorUid: AUTHOR.uid, authorEmail: AUTHOR.email, actor: { uid: AUTHOR.uid, email: AUTHOR.email, channel: "mcp", tokenId: "f".repeat(32) }, createdAt: Timestamp.fromMillis(Date.now() - 5) };
      if (db) {
        const base = `docs/${args.id}/versions/${version}/annotations/${annId}`;
        db.store.set(base, { annId, anchor: { elementId: "p3", exact: args.exact, prefix: "", suffix: " closes the document.", start: 0, end: args.exact.length, strict: true }, ...author, color: "#b5257b", resolved: false });
        db.store.set(`${base}/comments/${commentId}`, { commentId, body: String(args.body).trim().slice(0, 5000), ...author });
      }
      result = { content: [{ type: "text", text: JSON.stringify({ threadId: annId, version, quote: args.exact, url: `https://thr.invalid/d/${args.id}` }) }] };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

const client = (t, s, o = {}) => mcpClient(t, { http: createHttp(t, { actor: "owner-mcp", evidence: false, fetch: s.fetch, guard: { check: () => ({ allow: true }) }, ...o }) });
const annPath = (id) => `docs/${DOC}/versions/v1/annotations/${id}`;
const commentsOf = (db, id) => [...db.store.keys()].filter((k) => k.startsWith(`${annPath(id)}/comments/`));

test("local default (via admin): ONE add_comment, then n − 1 copies of what it wrote, a millisecond apart, in batches; it returns once the clock has passed them", async () => {
  const db = memoryDb();
  const s = server(db);
  const out = await seedThreads(client(local(), s), { docId: DOC, n: 451, exact: "Third paragraph", db });
  const returnedAt = Date.now();
  assert.deepEqual([out.via, out.version, out.threadIds.length, new Set(out.threadIds).size], ["admin", "v1", 451, 451]);
  assert.deepEqual(s.calls, [{ path: "/mcp", name: "add_comment", args: { id: DOC, exact: "Third paragraph", body: "Thread 1." } }], "one tool call, only the arguments given");
  assert.equal(out.threadIds[0], "ann001", "the first is the tool's own thread");
  assert.deepEqual(db.commits, [400, 400, 100], "450 copies, two writes each, 200 threads a batch");

  const first = db.store.get(annPath("ann001"));
  const firstNote = db.store.get(commentsOf(db, "ann001")[0]);
  const t0 = first.createdAt.toMillis();
  out.threadIds.slice(1).forEach((id, j) => {
    const i = j + 2;
    const ann = db.store.get(annPath(id));
    const { annId, createdAt, ...rest } = ann;
    const { annId: _a, createdAt: _c, ...firstRest } = first;
    assert.deepEqual(rest, firstRest, `thread ${i}: every field the product wrote, but its id and time`);
    assert.equal(annId, id, `thread ${i}: annId is its own document id`);
    assert.equal(createdAt.toMillis(), t0 + (i - 1), `thread ${i}: createdAt the first's plus ${i - 1} ms`);
    const notes = commentsOf(db, id);
    assert.equal(notes.length, 1, `thread ${i}: one comment, as add_comment writes`);
    const note = db.store.get(notes[0]);
    const { commentId, body, createdAt: noteAt, ...noteRest } = note;
    const { commentId: _i, body: _b, createdAt: _t, ...firstNoteRest } = firstNote;
    assert.deepEqual(noteRest, firstNoteRest, `thread ${i}: the comment's author and actor are the product's`);
    assert.deepEqual([commentId, body, noteAt.toMillis()], [notes[0].split("/").at(-1), `Thread ${i}.`, createdAt.toMillis()], `thread ${i}: its own comment id, body and the thread's time`);
  });
  assert.ok(returnedAt > t0 + 450, `returned at ${returnedAt}, after the last copy's createdAt ${t0 + 450}`);
});

test("bodies: one string for all, or a function of the 1-based place; each stored trimmed and kept to 5,000 characters, as add_comment stores it; prefix, suffix and k are sent only when given", async () => {
  const db = memoryDb();
  const s = server(db);
  const mcp = client(local(), s);
  const long = `  ${"y".repeat(5100)}  `;
  const out = await seedThreads(mcp, { docId: DOC, n: 3, exact: "alpha", prefix: "says ", suffix: " once", k: "abcdefgh12345678", body: (i) => (i === 3 ? long : `  Note ${i}  `), db });
  assert.deepEqual(s.calls[0].args, { id: DOC, exact: "alpha", body: "  Note 1  ", prefix: "says ", suffix: " once", k: "abcdefgh12345678" }, "the body as given; the tool trims it");
  const bodies = out.threadIds.map((id) => db.store.get(commentsOf(db, id)[0]).body);
  assert.deepEqual(bodies, ["Note 1", "Note 2", "y".repeat(5000)]);

  const db2 = memoryDb();
  const s2 = server(db2);
  const same = await seedThreads(client(local(), s2), { docId: DOC, n: 2, exact: "x", body: "Same.", db: db2 });
  assert.deepEqual(same.threadIds.map((id) => db2.store.get(commentsOf(db2, id)[0]).body), ["Same.", "Same."]);
  assert.deepEqual(s2.calls[0].args, { id: DOC, exact: "x", body: "Same." });

  const db3 = memoryDb();
  const one = await seedThreads(client(local(), server(db3)), { docId: DOC, n: 1, exact: "x", db: db3 });
  assert.deepEqual([one.threadIds, db3.commits], [["ann001"], []], "n = 1 is the tool's thread alone");
});

test("via tool (the default off a local stack): n add_comment calls in order, nothing through the Admin SDK", async () => {
  const s = server(null);
  const out = await seedThreads(client(prod(), s), { docId: DOC, n: 4, exact: "Third paragraph", db: untouchable });
  assert.deepEqual(out, { threadIds: ["ann001", "ann002", "ann003", "ann004"], version: "v1", via: "tool" });
  assert.deepEqual(s.calls.map((c) => [c.name, c.args.body]), [1, 2, 3, 4].map((i) => ["add_comment", `Thread ${i}.`]));

  const forced = server(null);
  const viaTool = await seedThreads(client(local(), forced), { docId: DOC, n: 2, exact: "x", via: "tool", db: untouchable });
  assert.deepEqual([viaTool.via, forced.calls.length], ["tool", 2], "via tool on a local stack, as production does it");
});

test("NEGATIVE: via admin off a local stack throws E2E_LOCAL_ONLY, and a bad argument throws, before anything is sent", async () => {
  const s = server(null);
  const p = client(prod(), s);
  await assert.rejects(seedThreads(p, { docId: DOC, n: 3, exact: "x", via: "admin", db: untouchable }), (e) => e.code === "E2E_LOCAL_ONLY" && /via "admin" writes through the Admin SDK/.test(e.message));
  const mcp = client(local(), s);
  const bad = [
    [{ docId: DOC, n: 2, exact: "x", docID: "y" }, /unknown field "docID"/],
    [{ n: 2, exact: "x" }, /docId is the document's id/],
    [{ docId: DOC, n: 0, exact: "x" }, /n is a whole number from 1 to 500, got 0/],
    [{ docId: DOC, n: 1.5, exact: "x" }, /n is a whole number/],
    [{ docId: DOC, n: SEED_THREADS_MAX + 1, exact: "x" }, /got 501/],
    [{ docId: DOC, n: "3", exact: "x" }, /n is a whole number/],
    [{ docId: DOC, n: 2, exact: "  " }, /exact is the passage/],
    [{ docId: DOC, n: 2, exact: "x", prefix: 3 }, /prefix is a string/],
    [{ docId: DOC, n: 2, exact: "x", via: "rest" }, /via is "admin" or "tool", got "rest"/],
    [{ docId: DOC, n: 2, exact: "x", body: 7 }, /body is a string or \(i\) => string/],
    [{ docId: DOC, n: 3, exact: "x", body: (i) => (i === 3 ? "   " : "ok") }, /body 3 is empty once trimmed/],
    [{ docId: DOC, n: 2, exact: "x", body: () => null }, /body 1 is a string, got null/],
  ];
  for (const [o, re] of bad) await assert.rejects(seedThreads(mcp, { db: untouchable, ...o }), re, JSON.stringify(o));
  await assert.rejects(seedThreads({ call() {} }, { docId: DOC, n: 1, exact: "x" }), /mcp is an mcpClient/);
  assert.deepEqual(s.calls, [], "nothing was sent");
  assert.deepEqual(SEED_THREADS_VIA, ["admin", "tool"]);
});

test("NEGATIVE: a refused add_comment is E2E_PRECONDITION with the tool's words and what was opened; a request with no answer throws as it was, for inconclusiveOnStackTimeout", async () => {
  const s = server(null, { refuse: (args, n) => (n === 3 ? "that passage occurs 2 times; add a prefix or suffix of the words around the one you mean" : null) });
  const err = await seedThreads(client(prod(), s), { docId: DOC, n: 5, exact: "alpha", db: untouchable }).then(() => assert.fail("expected a refusal"), (e) => e);
  assert.equal(err.code, "E2E_PRECONDITION");
  assert.equal(err.message, `precondition: seedThreads: add_comment 3 of 5 on ${DOC} was refused: that passage occurs 2 times; add a prefix or suffix of the words around the one you mean`);
  assert.deepEqual([err.threadIds, err.outcome.isError, s.calls.length], [["ann001", "ann002"], true, 3], "it stops at the refusal");

  const db = memoryDb();
  const first = server(db, { refuse: () => "you cannot comment on that document" });
  const e2 = await seedThreads(client(local(), first), { docId: DOC, n: 50, exact: "x", db }).then(() => assert.fail("expected a refusal"), (e) => e);
  assert.deepEqual([e2.code, e2.threadIds, db.commits], ["E2E_PRECONDITION", [], []], "via admin: no copies of a thread that was never opened");

  const empty = memoryDb();
  const lost = server(null); // answers a threadId but writes nothing
  const e3 = await seedThreads(client(local(), lost), { docId: DOC, n: 3, exact: "x", db: empty }).then(() => assert.fail("expected a precondition"), (e) => e);
  assert.match(e3.message, /add_comment answered thread ann001, but docs\/.+\/annotations\/ann001 holds nothing/);
  assert.deepEqual(empty.commits, []);

  const moved = server(null);
  let v = 0;
  const twoVersions = { calls: moved.calls, fetch: async (url, init) => {
    const res = await moved.fetch(url, init);
    const body = await res.json();
    v += 1;
    const inner = JSON.parse(body.result.content[0].text);
    body.result.content[0].text = JSON.stringify({ ...inner, version: v >= 2 ? "v2" : "v1" });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  } };
  await assert.rejects(seedThreads(client(prod(), twoVersions), { docId: DOC, n: 3, exact: "x", db: untouchable }), /add_comment 2 of 3 opened its thread on v2, not v1: .+ was published again while seeding/);

  const hang = { fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) };
  const deadline = await seedThreads(client(prod(), hang, { timeoutMs: 200 }), { docId: DOC, n: 2, exact: "x", db: untouchable }).then(() => assert.fail("expected no answer"), (e) => e);
  assert.equal(deadline.message, "timeout after 200 ms", "the client's own error, not wrapped");
  assert.equal(stackDidNotAnswer(deadline), "a request to the stack got no answer: timeout after 200 ms");
});
