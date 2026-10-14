// SPDX-License-Identifier: Apache-2.0
// Self-test: settleKinds counts a document's notices per (person, kind) by subject pattern, settles them for checkI11, and stops at once on a second one (SPEC §14).

/**
 * Against a fake Mailpit, as mail-wait.test.mjs does: search ignores the
 * query (the reader decides) and answers newest first, each summary with a
 * Created time. Subjects are written exactly as functions/src/email/notify.ts
 * writes them, and NOTICE_KINDS is pinned to those templates. What it
 * proves: the kind read from the subject whoever the author is, other
 * documents' and other people's mail left out, every eligible (person, kind)
 * waited for, the settle restarted by any new message, a second notice per
 * (person, kind) ending the wait AT ONCE, and the two ways to run out, each
 * a wait with `missingOnly: true`.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHttp } from "../lib/http.mjs";
import { MAIL_SETTLE_MS, NOTICE_KINDS, kindOfSubject, mailbox } from "../lib/mail/reader.mjs";
import { checkI11 } from "../lib/invariants.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const store = [];
let seq = 0;
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/v1/search") {
    const start = Number(u.searchParams.get("start") ?? 0);
    const limit = Number(u.searchParams.get("limit") ?? 50);
    const newestFirst = [...store].reverse();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ total: store.length, messages_count: store.length, start, messages: newestFirst.slice(start, start + limit) }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const port = server.address().port;

const target = Object.freeze({
  kind: "local",
  runId: "2610130900-mailkinds",
  origin: `http://127.0.0.1:${port}`,
  runDir: tempDir("e2e-mailkinds-"),
  capabilities: new Set(["mailpit"]),
  mail: { mailpitUrl: `http://127.0.0.1:${port}` },
  stack: { ports: { mailpit: port } },
});
const allow = { check: async () => ({ allow: true }) };
const box = () => mailbox(target, { http: createHttp(target, { actor: "mailpit", guard: allow, evidence: false }) });
const SHORT = { settleMs: 400, interval: 25, allowShort: true };

const TITLE = "C15 storm ab12 N=2";
const DOC = "c15-storm-ab12";
const OWNER = "owner@example.test";
const P1 = "p1@example.test";
const P2 = "p2@example.test";
/** The product's subjects (functions/src/email/notify.ts). */
const commented = (author, title = TITLE) => `${author} commented on “${title}”`;
const suggested = (author, title = TITLE) => `${author} suggested an edit to “${title}”`;
const shared = (inviter, title = TITLE) => `${inviter} shared “${title}” with you`;

function put(to, subject) {
  seq += 1;
  store.push({ ID: `m${seq}`, Subject: subject, To: [{ Name: "", Address: to }], Cc: [], Bcc: [], Created: new Date(Date.parse("2026-10-13T09:00:00.000Z") + seq * 1000).toISOString() });
}
const reset = () => {
  store.length = 0;
};
const later = (ms, fn) => setTimeout(fn, ms);

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

test("NOTICE_KINDS is the product's three subjects, pinned to notify.ts, each matching its own kind only", () => {
  const src = readFileSync(join(REPO_ROOT, "functions/src/email/notify.ts"), "utf8");
  assert.ok(src.includes("subject: `${inviterEmail} shared “${subject.title}” with you`,"), "the invitation's template");
  assert.ok(src.includes("? `${props.authorEmail} suggested an edit to “${props.docTitle}”`"), "the suggestion notice's template");
  assert.ok(src.includes(": `${props.authorEmail} commented on “${props.docTitle}”`,"), "the comment notice's template");
  assert.deepEqual(Object.keys(NOTICE_KINDS), ["comment", "suggestion", "invitation"]);
  assert.ok(Object.isFrozen(NOTICE_KINDS));
  const odd = "Q3 “plan”: who shared it?";
  assert.equal(kindOfSubject(commented("a@x.test", odd)), "comment");
  assert.equal(kindOfSubject(suggested("a@x.test", odd)), "suggestion");
  assert.equal(kindOfSubject(shared("a@x.test", odd)), "invitation");
  assert.equal(kindOfSubject("123456 is your Bikeshed verification code"), null);
  assert.equal(kindOfSubject(commented("a@x.test"), { mine: /commented/ }), "mine");
});

test("every eligible (person, kind) arrives, whoever wrote it; other documents and other people are left out; settled for checkI11", async () => {
  reset();
  put(OWNER, commented(P2)); // the cooldown's winner: either author's name
  put(OWNER, suggested(P1));
  put(P1, shared(OWNER));
  put(P2, shared(OWNER));
  put(OWNER, commented(P1, "another document")); // another title
  put("stranger@example.test", commented(P1)); // not one of the people
  put(P1, `${OWNER} replied about “${TITLE}”`); // quotes the title, matches no kind
  later(150, () => put(P1, commented(OWNER)));
  later(200, () => put(P2, commented(P1)));
  const eligible = [
    { to: OWNER, docId: DOC, kind: "comment" },
    { to: OWNER, docId: DOC, kind: "suggestion" },
    ...[P1, P2].flatMap((to) => [{ to, docId: DOC, kind: "comment" }, { to, docId: DOC, kind: "invitation" }]),
  ];
  const t0 = Date.now();
  const r = await box().settleKinds({ people: [OWNER, P1, P2], title: TITLE, eligible, timeout: 3_000, ...SHORT });
  assert.ok(Date.now() - t0 >= 200 + 400 - 30, "it waited for the last eligible notice, then the settle");
  assert.equal(r.settled, true);
  assert.deepEqual([r.twice, r.missing], [[], []]);
  assert.ok(r.settledMs >= 400 && r.reads > 2);
  assert.deepEqual(
    r.messages.map((m) => [m.to, m.kind, m.docId, typeof m.at]),
    [
      [OWNER, "comment", DOC, "number"],
      [OWNER, "suggestion", DOC, "number"],
      [P1, "invitation", DOC, "number"],
      [P1, "other", DOC, "number"],
      [P1, "comment", DOC, "number"],
      [P2, "invitation", DOC, "number"],
      [P2, "comment", DOC, "number"],
    ],
  );
  assert.deepEqual(checkI11({ messages: r.messages, eligible }).failures, []);
});

test("a second notice to one (person, kind) ends the wait AT ONCE, settled false, named in twice; checkI11 fails on it", async () => {
  reset();
  put(OWNER, commented(P1));
  put(P1, shared(OWNER));
  later(100, () => put(OWNER, commented(P2)));
  const t0 = Date.now();
  const r = await box().settleKinds({ people: [OWNER, P1], title: TITLE, docId: DOC, eligible: [{ to: OWNER, kind: "comment" }, { to: P1, kind: "invitation" }], timeout: 3_000, settleMs: 2_000, interval: 25, allowShort: true });
  assert.ok(Date.now() - t0 < 1_000, `it did not wait out the settle: ${Date.now() - t0} ms`);
  assert.equal(r.settled, false);
  assert.deepEqual(r.twice, [{ to: OWNER, kind: "comment", n: 2 }]);
  const i11 = checkI11({ messages: r.messages, eligible: [{ to: OWNER, docId: DOC, kind: "comment" }] });
  assert.equal(i11.ok, false);
  assert.match(i11.failures.join("; "), /owner@example\.test · c15-storm-ab12 · comment: 2 message\(s\), two of them \d+ s apart \(inside 30 min\)/);
});

test("a new message during the settle restarts it, though nothing is missing", async () => {
  reset();
  put(OWNER, commented(P1));
  later(250, () => put(OWNER, suggested(P1))); // not eligible: still a move
  const t0 = Date.now();
  const r = await box().settleKinds({ people: [OWNER], title: TITLE, eligible: [{ to: OWNER, kind: "comment" }], timeout: 3_000, ...SHORT });
  assert.ok(Date.now() - t0 >= 250 + 400 - 30, `the settle counted from the second message: ${Date.now() - t0} ms`);
  assert.deepEqual(r.messages.map((m) => m.kind), ["comment", "suggestion"]);
  assert.equal(r.settled, true);
});

test("running out: an eligible notice that never came, or mailboxes still moving; each E2E_MAIL worded as a wait, missingOnly", async () => {
  reset();
  put(OWNER, commented(P1));
  const err = await rejection(box().settleKinds({ people: [OWNER, P1], title: TITLE, eligible: [{ to: OWNER, kind: "comment" }, { to: P1, kind: "invitation" }], timeout: 200, ...SHORT }));
  assert.equal(err.code, "E2E_MAIL");
  assert.match(err.message, /^settleKinds: within 200 ms, 1 eligible notice\(s\) about “C15 storm ab12 N=2” never came: invitation to p1@example\.test \(saw 1: comment to owner@example\.test\)$/);
  assert.equal(err.missingOnly, true);
  assert.deepEqual(err.missing, [{ to: P1, kind: "invitation" }]);
  assert.equal(err.messages.length, 1);
  reset();
  const people = Array.from({ length: 30 }, (_, i) => `q${i}@example.test`);
  const timers = people.map((to, i) => later(30 * i, () => put(to, shared(OWNER))));
  const moving = await rejection(box().settleKinds({ people, title: TITLE, timeout: 100, settleMs: 300, interval: 20, allowShort: true }));
  for (const t of timers) clearTimeout(t);
  assert.equal(moving.code, "E2E_MAIL");
  assert.match(moving.message, /^settleKinds: within 400 ms, the notices about “C15 storm ab12 N=2” to 30 people did not hold still for 300 ms/);
  assert.equal(moving.missingOnly, true);
});

test("TypeErrors before anything is read; a settle under 10 s without allowShort; docId from eligible, or refused when they disagree", async () => {
  reset();
  const b = box();
  const bad = [
    [{ people: [], title: TITLE }, /people is a non-empty list/],
    [{ people: [OWNER, OWNER.toUpperCase()], title: TITLE }, /is named twice in people/],
    [{ people: [OWNER], title: "" }, /title is the document's title/],
    [{ people: [OWNER], title: TITLE, kinds: {} }, /kinds names at least one kind/],
    [{ people: [OWNER], title: TITLE, kinds: { other: /x/ } }, /a lowercase word other than "other"/],
    [{ people: [OWNER], title: TITLE, kinds: { comment: "commented" } }, /the pattern for comment is a RegExp/],
    [{ people: [OWNER], title: TITLE, kinds: { comment: /commented/g } }, /has the g or y flag/],
    [{ people: [OWNER], title: TITLE, eligible: [{ to: P1, kind: "comment" }] }, /eligible entry's to is one of people/],
    [{ people: [OWNER], title: TITLE, eligible: [{ to: OWNER, kind: "reply" }] }, /eligible entry's kind is one of comment, suggestion, invitation/],
    [{ people: [OWNER, P1], title: TITLE, eligible: [{ to: OWNER, kind: "comment", docId: "d1" }, { to: P1, kind: "comment", docId: "d2" }] }, /eligible names 2 documents/],
    [{ people: [OWNER], title: TITLE, docId: "d1", eligible: [{ to: OWNER, kind: "comment", docId: "d2" }] }, /eligible names d2, but docId is d1/],
    [{ people: [OWNER], title: TITLE, timeout: -1 }, /timeout is a number of ms/],
  ];
  for (const [o, re] of bad) {
    const err = await rejection(b.settleKinds(o));
    assert.ok(err instanceof TypeError, `${String(err)} for ${JSON.stringify(o)}`);
    assert.match(err.message, re);
  }
  const short = await rejection(b.settleKinds({ people: [OWNER], title: TITLE, settleMs: 500 }));
  assert.match(short.message, /a 500 ms settle cannot show that a count stopped moving \(minimum 10000 ms/);
  assert.equal(MAIL_SETTLE_MS, 10_000);
  put(OWNER, commented(P1));
  const r = await b.settleKinds({ people: [OWNER], title: TITLE, eligible: [{ to: OWNER, kind: "comment", docId: DOC }], timeout: 1_000, ...SHORT });
  assert.equal(r.messages[0].docId, DOC, "the docId eligible names");
});
