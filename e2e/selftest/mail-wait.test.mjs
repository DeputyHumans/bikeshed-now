// SPDX-License-Identifier: Apache-2.0
// Self-test: waitFor sees arrival without a settle, and expectMailboxes holds several whole mailboxes to exact subjects in one settle (SPEC §14).

/**
 * Against a fake Mailpit, as mail-reader.test.mjs does: search ignores the
 * query (Mailpit's own search over-matches, so the reader must decide) and
 * answers newest first, each summary with a Created time; message/{id}
 * returns it whole.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHttp } from "../lib/http.mjs";
import { MAIL_SETTLE_MS, mailbox } from "../lib/mail/reader.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const store = [];
const queries = [];
let seq = 0;
let clock = Date.parse("2026-10-12T10:00:00.000Z");
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
    res.end(JSON.stringify(msg ? { ...msg, Text: `text of ${msg.ID}`, HTML: `<p>html of ${msg.ID}</p>` } : { error: "not found" }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const port = server.address().port;

const target = Object.freeze({
  kind: "local",
  runId: "2610121300-mailwait",
  origin: `http://127.0.0.1:${port}`,
  runDir: tempDir("e2e-mailwait-"),
  capabilities: new Set(["mailpit"]),
  mail: { mailpitUrl: `http://127.0.0.1:${port}` },
  stack: { ports: { mailpit: port } },
});
const allow = { check: async () => ({ allow: true }) };
const box = () => mailbox(target, { http: createHttp(target, { actor: "mailpit", guard: allow, evidence: false }) });
const SHORT = { settleMs: 600, interval: 50, allowShort: true };

/** A message to `to`; `created` (ms) overrides the clock, `null` leaves Created out. */
function put({ to = [], cc = [], subject = "s", created } = {}) {
  seq += 1;
  clock += 1000;
  const msg = { ID: `m${seq}`, Subject: subject, To: to.map((a) => ({ Name: "", Address: a })), Cc: cc.map((a) => ({ Name: "", Address: a })), Bcc: [] };
  if (created !== null) msg.Created = new Date(created ?? clock).toISOString();
  store.push(msg);
  return msg;
}
const reset = () => {
  store.length = 0;
  queries.length = 0;
};
const later = (ms, fn) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

// --- waitFor ---------------------------------------------------------------------

test("waitFor: resolves as the message arrives, with no settle, and returns it whole", async () => {
  reset();
  put({ to: ["owner@x.com"], subject: "other" });
  const stop = later(300, () => put({ to: ["owner@x.com"], subject: "notice" }));
  try {
    const t0 = Date.now();
    const m = await box().waitFor({ to: "owner@x.com", subject: "notice", timeout: 5_000, interval: 50 });
    const took = Date.now() - t0;
    assert.equal(m.Subject, "notice");
    assert.equal(m.Text, `text of ${m.ID}`, "the whole message, as message(id) reads it");
    assert.match(m.HTML, /^<p>html of m\d+<\/p>$/);
    assert.ok(took >= 250, `it waited for the arrival (${took} ms)`);
    assert.ok(took < 2_000, `and resolved on arrival, with no settle (${took} ms; a settle is ${MAIL_SETTLE_MS} ms)`);
  } finally {
    stop();
  }
});

test("waitFor: several match: the newest by Created, else the first in Mailpit's newest-first order; a RegExp subject", async () => {
  reset();
  const base = Date.parse("2026-10-12T11:00:00.000Z");
  put({ to: ["n@x.com"], subject: "notice", created: base + 5_000 });
  const newest = put({ to: ["n@x.com"], subject: "notice", created: base + 9_000 });
  put({ to: ["n@x.com"], subject: "notice", created: base + 1_000 }); // stored last, created first
  assert.equal((await box().waitFor({ to: "n@x.com", subject: "notice", timeout: 0 })).ID, newest.ID, "by Created, not by arrival in the store");

  reset();
  put({ to: ["o@x.com"], subject: "a 1", created: null });
  const last = put({ to: ["o@x.com"], subject: "a 2", created: null });
  assert.equal((await box().waitFor({ to: "o@x.com", subject: /^a \d$/, timeout: 0 })).ID, last.ID, "no Created: Mailpit's order, newest first");
  assert.equal((await box().waitFor({ to: "O@X.com", timeout: 0 })).ID, last.ID, "no subject: any message to the address; the address without case");
});

test("NEGATIVE: waitFor is not satisfied by another subject, a longer address, or a substring; it times out as a wait, naming what it saw", async () => {
  reset();
  put({ to: ["w@x.com"], subject: "notice!" });
  put({ to: ["ww@x.com"], subject: "notice" }); // Mailpit's to:"w@x.com" finds this too
  put({ to: ["w@x.com.evil"], subject: "notice" });
  const t0 = Date.now();
  const err = await rejection(box().waitFor({ to: "w@x.com", subject: "notice", timeout: 300, interval: 50 }));
  assert.equal(err.code, "E2E_MAIL");
  assert.ok(Date.now() - t0 >= 300, "it waited the whole timeout");
  assert.match(err.message, /^waitFor: no message to w@x\.com with subject "notice" within 300 ms \(saw 1 to w@x\.com: m\d+ to=w@x\.com subject="notice!"\)$/);
  assert.deepEqual(err.seen.map((m) => m.Subject), ["notice!"], "seen: everything to that address, whatever its subject");
  assert.ok(err.waitedMs >= 300);
  assert.ok(queries.every((q) => q === 'to:"w@x.com"'), "Mailpit narrows by recipient; the reader decides");
});

test("NEGATIVE: waitFor refuses a missing address, a bad subject or timeout before reading anything", async () => {
  reset();
  await assert.rejects(box().waitFor({ subject: "x" }), /`to` is required/);
  await assert.rejects(box().waitFor({ to: "a@x.com", subject: 3 }), TypeError);
  await assert.rejects(box().waitFor({ to: "a@x.com", timeout: -1 }), /timeout is a number of ms, 0 or more, got -1/);
  await assert.rejects(box().waitFor({ to: "a@x.com", interval: Number.NaN }), TypeError);
  assert.deepEqual(queries, []);
});

// --- expectMailboxes ----------------------------------------------------------------

test("expectMailboxes: five whole mailboxes held to exact subjects in ONE settle, order free, a repeat counted", async () => {
  reset();
  put({ to: ["a@x.com"], subject: "s2" });
  put({ to: ["a@x.com"], subject: "s1" });
  put({ to: ["b@x.com"], subject: "s1" });
  put({ to: ["b@x.com"], subject: "s1" });
  put({ to: ["c@x.com"], cc: ["D@x.com"], subject: "s3" });
  const t0 = Date.now();
  const r = await box().expectMailboxes({ "a@x.com": ["s1", "s2"], "b@x.com": ["s1", "s1"], "c@x.com": ["s3"], "d@x.com": ["s3"], "quiet@x.com": [] }, SHORT);
  const took = Date.now() - t0;
  assert.ok(took >= 600, `held for the settle (${took} ms)`);
  assert.ok(took < 2 * 600, `ONE settle for five mailboxes, not one each (${took} ms)`);
  assert.deepEqual(Object.keys(r.mailboxes), ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "quiet@x.com"], "keyed by the addresses as given");
  assert.deepEqual(r.mailboxes["a@x.com"].map((m) => m.Subject).sort(), ["s1", "s2"]);
  assert.deepEqual(r.mailboxes["quiet@x.com"], []);
  assert.equal(r.settledMs, 600);
  assert.ok(r.reads >= 5, `it kept reading through the settle (reads ${r.reads})`);
});

test("expectMailboxes waits for late arrivals in several mailboxes, then settles", async () => {
  reset();
  const stops = [later(150, () => put({ to: ["l1@x.com"], subject: "x" })), later(350, () => put({ to: ["l2@x.com"], subject: "y" }))];
  try {
    const r = await box().expectMailboxes({ "l1@x.com": ["x"], "l2@x.com": ["y"] }, { ...SHORT, timeout: 5_000 });
    assert.ok(r.waitedMs >= 300, `it waited for the later one (${r.waitedMs} ms)`);
  } finally {
    stops.forEach((s) => s());
  }
});

test("NEGATIVE: anything extra in any mailbox fails at once, though another is still short: missingOnly false", async () => {
  reset();
  put({ to: ["e1@x.com"], subject: "ok" });
  put({ to: ["e2@x.com"], subject: "dup" });
  put({ to: ["e2@x.com"], subject: "dup" });
  const t0 = Date.now();
  const err = await rejection(box().expectMailboxes({ "short@x.com": ["never"], "e1@x.com": ["ok"], "e2@x.com": ["dup"] }, { ...SHORT, timeout: 5_000 }));
  assert.ok(Date.now() - t0 < 1_000, "at once: mail cannot be unsent, so waiting cannot help");
  assert.equal(err.code, "E2E_MAIL");
  assert.equal(err.missingOnly, false);
  assert.equal(err.mailbox, "short@x.com", "the first mailbox that differs, in the order given");
  assert.deepEqual(err.differs, [
    { to: "short@x.com", want: ["never"], got: [], missing: ["never"], extra: [] },
    { to: "e2@x.com", want: ["dup"], got: ["dup", "dup"], missing: [], extra: ["dup"] },
  ]);
  assert.match(err.message, /^expectMailboxes: more mail than expected after \d+ ms: the mail to short@x\.com lacks \["never"\] \(saw \[\], wanted \["never"\]\); and 1 more mailbox\(es\) differ: e2@x\.com$/);
  assert.doesNotMatch(err.message.split("\n")[0], /within \d+ ?ms/, "not a wait that ran out");
  assert.deepEqual(Object.keys(err.seen), ["short@x.com", "e1@x.com", "e2@x.com"]);

  reset();
  put({ to: ["q@x.com"], subject: "unexpected" });
  const quiet = await rejection(box().expectMailboxes({ "q@x.com": [] }, SHORT));
  assert.equal(quiet.missingOnly, false, "a quiet mailbox that is not");
  assert.match(quiet.message, /the mail to q@x\.com has extra \["unexpected"\]/);
});

test("NEGATIVE: a mailbox still short at the timeout fails as a wait, naming the first short one: missingOnly true", async () => {
  reset();
  put({ to: ["s1@x.com"], subject: "a" });
  put({ to: ["s2@x.com"], subject: "b" });
  const t0 = Date.now();
  const err = await rejection(box().expectMailboxes({ "s1@x.com": ["a"], "s2@x.com": ["b", "c"], "s3@x.com": ["d"] }, { ...SHORT, timeout: 300 }));
  assert.ok(Date.now() - t0 >= 300, "it waited the whole timeout");
  assert.equal(err.code, "E2E_MAIL");
  assert.equal(err.missingOnly, true);
  assert.equal(err.mailbox, "s2@x.com");
  assert.deepEqual(err.differs.map((d) => [d.to, d.missing, d.extra]), [["s2@x.com", ["c"], []], ["s3@x.com", ["d"], []]]);
  assert.equal(err.message, 'expectMailboxes: within 300 ms, a mailbox is still short: the mail to s2@x.com lacks ["c"] (saw ["b"], wanted ["b","c"]); and 1 more mailbox(es) differ: s3@x.com');
});

test("NEGATIVE: a duplicate landing in one mailbox during the shared settle fails it: missingOnly false", async () => {
  reset();
  put({ to: ["d1@x.com"], subject: "one" });
  put({ to: ["d2@x.com"], subject: "two" });
  const stop = later(250, () => put({ to: ["d2@x.com"], subject: "two" }));
  try {
    const err = await rejection(box().expectMailboxes({ "d1@x.com": ["one"], "d2@x.com": ["two"] }, { ...SHORT, settleMs: 900 }));
    assert.equal(err.missingOnly, false);
    assert.equal(err.mailbox, "d2@x.com");
    assert.match(err.message, /^expectMailboxes: a mailbox moved during the 900 ms settle, after \d+ ms: the mail to d2@x\.com has extra \["two"\]/);
  } finally {
    stop();
  }
});

test("NEGATIVE: a malformed expectation or a short settle is refused before anything is read", async () => {
  reset();
  for (const bad of [null, [], "a@x.com", {}, { "a@x.com": "s" }, { "a@x.com": [/s/] }, { "a@x.com": [1] }, { "": [] }, { "A@x.com": [], "a@X.COM": [] }]) {
    await assert.rejects(box().expectMailboxes(bad, SHORT), TypeError, JSON.stringify(bad));
  }
  await assert.rejects(box().expectMailboxes({ "a@x.com": [] }, { ...SHORT, timeout: -5 }), /timeout is a number of ms, 0 or more/);
  await assert.rejects(box().expectMailboxes({ "a@x.com": [] }, { settleMs: 9_999 }), /a 9999 ms settle cannot show that a count stopped moving/);
  assert.deepEqual(queries, [], "nothing was read");
});
