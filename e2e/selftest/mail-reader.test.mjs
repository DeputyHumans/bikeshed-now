// SPDX-License-Identifier: Apache-2.0
// Self-test: the Mailpit reader matches recipients exactly, pages, and only calls a count exact once it held still (SPEC §14).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttp } from "../lib/http.mjs";
import { MAIL_SETTLE_MS, mailbox, matches, recipients } from "../lib/mail/reader.mjs";
import { tempDir } from "./helpers/tmp.mjs";

// A fake Mailpit: search ignores the query (so it over-matches, as Mailpit's
// substring search does) and pages by start/limit; message/{id} returns it whole.
const store = [];
const queries = [];
let seq = 0;
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/v1/search") {
    queries.push(u.searchParams.get("query"));
    const start = Number(u.searchParams.get("start") ?? 0);
    const limit = Number(u.searchParams.get("limit") ?? 50);
    const newestFirst = [...store].reverse();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ total: store.length, messages_count: store.length, start, messages: newestFirst.slice(start, start + limit) }));
    return;
  }
  const m = /^\/api\/v1\/message\/([^/]+)$/.exec(u.pathname);
  if (m) {
    const msg = store.find((x) => x.ID === decodeURIComponent(m[1]));
    res.writeHead(msg ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(msg ? { ...msg, Text: `text of ${msg.ID}` } : { error: "not found" }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const port = server.address().port;

const target = Object.freeze({
  kind: "local",
  runId: "2610101900-mail",
  origin: `http://127.0.0.1:${port}`,
  runDir: tempDir("e2e-mail-"),
  capabilities: new Set(["mailpit"]),
  mail: { mailpitUrl: `http://127.0.0.1:${port}` },
  stack: { ports: { mailpit: port } },
});
const allow = { check: async () => ({ allow: true }) };
const box = () => mailbox(target, { http: createHttp(target, { actor: "mailpit", guard: allow, evidence: false }) });

function put({ to = [], cc = [], subject = "s" }) {
  seq += 1;
  const msg = { ID: `m${seq}`, Subject: subject, To: to.map((a) => ({ Name: "", Address: a })), Cc: cc.map((a) => ({ Name: "", Address: a })), Bcc: [] };
  store.push(msg);
  return msg;
}
const reset = () => {
  store.length = 0;
  queries.length = 0;
};

test("recipients/matches: To, Cc and Bcc without case; subject equal or a RegExp", () => {
  const msg = { To: [{ Address: "A@X.com" }], Cc: [{ Address: "b@x.com" }], Bcc: [{ Address: "c@x.com" }], Subject: "o@x.com shared “T” with you" };
  assert.deepEqual(recipients(msg), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.equal(matches(msg, { to: "a@x.com" }), true);
  assert.equal(matches(msg, { to: "x.com" }), false, "a substring is not a recipient");
  assert.equal(matches(msg, { to: "c@x.com", subject: "o@x.com shared “T” with you" }), true);
  assert.equal(matches(msg, { to: "c@x.com", subject: "o@x.com shared “T” with you!" }), false);
  assert.equal(matches(msg, { subject: /^o@x\.com shared “T” with you$/ }), true);
});

test("NEGATIVE: find() keeps only the exact address, though Mailpit's search over-matches", async () => {
  reset();
  const direct = put({ to: ["a@x.com"] });
  put({ to: ["aa@x.com"] }); // Mailpit's to:"a@x.com" finds this too
  const copied = put({ to: ["someone@else.com"], cc: ["A@X.COM"] });
  put({ to: ["a@x.com.evil"] });
  const found = await box().find({ to: "a@x.com" });
  assert.deepEqual(found.map((m) => m.ID).sort(), [direct.ID, copied.ID].sort());
  assert.ok(queries.every((q) => q === 'to:"a@x.com"'), `the search narrows by recipient: ${queries.join(" | ")}`);
});

test("find() reads every page, not only the first", async () => {
  reset();
  for (let i = 0; i < 450; i++) put({ to: ["bulk@x.com"] });
  put({ to: ["other@x.com"] });
  assert.equal((await box().find({ to: "bulk@x.com" })).length, 450);
});

test("expectMail: one message that stays one resolves after the whole settle", async (t) => {
  // HTTP matching/paging has real-server tests above. Drive this clock and
  // reader together: a busy machine must not turn a 600 ms window into only
  // two polls and make its scheduling speed part of the oracle.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const reads = [];
  const message = { ID: "one", To: [{ Address: "one@x.com" }], Subject: "hello" };
  const reader = mailbox(target, { http: { async get() {
    reads.push(Date.now());
    return { json: { messages: [message], messages_count: 1 } };
  } } });
  let finished = false;
  const pending = reader.expectMail({ to: "one@x.com", count: 1, settleMs: 600, interval: 50, allowShort: true }).then((r) => { finished = true; return r; });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  for (let elapsed = 50; elapsed < 600; elapsed += 50) {
    t.mock.timers.tick(50);
    await flush();
    assert.equal(finished, false, `the settle cannot finish at ${elapsed} ms`);
  }
  t.mock.timers.tick(50);
  await flush();
  assert.equal(finished, true, "the settle finishes at 600 ms");
  const r = await pending;
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].Subject, "hello");
  assert.deepEqual(reads, Array.from({ length: 13 }, (_, i) => i * 50), "every interval, including the final boundary, was read");
  assert.equal(r.reads, reads.length, "the result counts the reads actually made");
});

test("NEGATIVE: a duplicate that lands during the settle fails 'exactly one'", async () => {
  reset();
  put({ to: ["dup@x.com"], subject: "invite" });
  const later = setTimeout(() => put({ to: ["dup@x.com"], subject: "invite" }), 250);
  try {
    await assert.rejects(
      box().expectMail({ to: "dup@x.com", count: 1, settleMs: 800, interval: 50, allowShort: true }),
      (err) => err.code === "E2E_MAIL" && /saw 2/.test(err.message) && err.seen.length === 2,
    );
  } finally {
    clearTimeout(later);
  }
});

test("NEGATIVE: nothing arriving within the timeout fails, and says what it saw", async () => {
  reset();
  put({ to: ["someone@x.com"] });
  await assert.rejects(
    box().expectMail({ to: "nobody@x.com", count: 1, timeout: 300, settleMs: 100, interval: 50, allowShort: true }),
    (err) => err.code === "E2E_MAIL" && /saw 0 within 300 ms/.test(err.message),
  );
});

test("expectMail waits for a late message, then settles", async () => {
  reset();
  setTimeout(() => put({ to: ["late@x.com"] }), 200);
  const r = await box().expectMail({ to: "late@x.com", count: 1, timeout: 3000, settleMs: 300, interval: 50, allowShort: true });
  assert.equal(r.messages.length, 1);
  assert.ok(r.waitedMs >= 150, `it waited for the message (${r.waitedMs} ms)`);
});

test("NEGATIVE: count 0 fails when a message is there, and passes after a quiet settle", async () => {
  reset();
  put({ to: ["quiet@x.com"] });
  await assert.rejects(box().expectMail({ to: "quiet@x.com", count: 0, settleMs: 200, interval: 50, allowShort: true }), /saw 1/);
  const r = await box().expectMail({ to: "silent@x.com", count: 0, settleMs: 200, interval: 50, allowShort: true });
  assert.deepEqual(r.messages, []);
});

test("NEGATIVE: a settle shorter than the plan's 10 s is refused unless a self-test says so", async () => {
  reset();
  assert.equal(MAIL_SETTLE_MS, 10_000);
  await assert.rejects(box().expectMail({ to: "a@x.com", count: 0, settleMs: 9_999 }), /cannot show that a count stopped moving/);
});

test("message() returns the whole message; a non-loopback Mailpit URL is refused", async () => {
  reset();
  const m = put({ to: ["full@x.com"] });
  assert.equal((await box().message(m.ID)).Text, `text of ${m.ID}`);
  assert.throws(() => mailbox({ ...target, mail: { mailpitUrl: "http://mail.example.com:8025" } }), /not a loopback origin/);
  assert.throws(() => mailbox({ ...target, capabilities: new Set() }), (e) => e.code === "E2E_CAPABILITY");
});
