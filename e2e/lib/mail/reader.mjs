// SPDX-License-Identifier: Apache-2.0
// Reading the stack's Mailpit: messages to one exact address, counted until the count holds still, and a document's notices counted per (person, kind) for I11 (SPEC §14).

/**
 *   const box = mailbox(target);
 *   const { messages } = await box.expectMail({ to: invitee, count: 1 });
 *   const full = await box.message(messages[0].ID);   // Subject, Text, HTML, From, To
 *
 *   const notice = await box.waitFor({ to: owner, subject: `${a} commented on “${t}”` });  // arrived: no settle
 *   await box.expectMailboxes({ [owner]: [s1, s2], [witness]: [] });                       // every mailbox exact, ONE settle
 *
 * "Exactly one" is a claim about a count that has STOPPED moving, not about the
 * first poll that saw one: a duplicate send lands a moment after the first. So
 * expectMail waits until at least `count` messages match, then keeps reading
 * for `settleMs` (10 s, the plan's "counts stable for 10 s") and fails if the
 * count is not exactly `count` at every read of that window. `count: 0` is the
 * same rule — the window must pass with none.
 *
 * waitFor is ARRIVAL, not a count: it resolves the moment a matching message
 * is there, with the newest one in full, and never settles. It is how a case
 * knows something has happened (a trigger has run, so a later write cannot
 * join it); it says nothing about duplicates. Hold the counts at the end with
 * expectMail or expectMailboxes.
 *
 * expectMailboxes holds several WHOLE mailboxes to exact subject lists (a
 * multiset: order is free, a repeat counts) in one shared settle, so a case
 * that ends on six recipients waits 10 s once, not six times. Mail cannot be
 * unsent, so anything EXTRA in any mailbox fails at once; a mailbox that is
 * short is waited for until `timeout`. Its error says which mailbox differs
 * first (in the order given), and `missingOnly` says whether every difference
 * is a message that never came (nothing extra anywhere): the only failure a
 * judge of the stack's load (lib/test.mjs functionKill) may excuse.
 *
 * settleKinds counts a document's NOTICES per (person, kind), the kind read
 * from the subject by pattern (NOTICE_KINDS: the product's comment,
 * suggestion and invitation subjects), for invariants.mjs checkI11. Exact
 * subjects cannot be known where several authors race: a comment notice
 * names whichever author's trigger took the cooldown. It waits until every
 * eligible (person, kind) has a notice and all of it holds still for
 * `settleMs`, and stops AT ONCE when a second notice reaches one (person,
 * kind), returning what it saw for checkI11 to judge.
 *
 * Matching is done HERE, on the parsed recipients, never by trusting Mailpit's
 * search: `to:a@x` is a substring match there (it finds `aa@x` too). Mailpit
 * narrows, this file decides. Recipients are To, Cc and Bcc, compared without
 * case. `subject` is a string (equal) or a RegExp.
 *
 * Every read goes through http.mjs, so it is held to the stack's ports and
 * lands, redacted, in the case's HTTP evidence.
 */

import { createHttp } from "../http.mjs";
import { requireCapability } from "../target.mjs";

/** The plan's settle for server and mail counts. */
export const MAIL_SETTLE_MS = 10_000;
const PAGE = 200;
/** How many messages an error lists before it says "and N more". */
const BRIEF_MAX = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (s) => String(s ?? "").trim().toLowerCase();

/** Every recipient address of a Mailpit message summary (To, Cc, Bcc), lowercased. */
export function recipients(msg) {
  return [...(msg?.To ?? []), ...(msg?.Cc ?? []), ...(msg?.Bcc ?? [])].map((r) => lower(r?.Address)).filter(Boolean);
}

/** Does a message summary match {to, subject}? `to` is exact; `subject` is equal or a RegExp. */
export function matches(msg, { to = null, subject = null } = {}) {
  if (to != null && !recipients(msg).includes(lower(to))) return false;
  if (subject instanceof RegExp) return subject.test(String(msg?.Subject ?? ""));
  if (subject != null) return String(msg?.Subject ?? "") === subject;
  return true;
}

function mailError(message, extra) {
  const err = new Error(message);
  err.code = "E2E_MAIL";
  Object.assign(err, extra);
  return err;
}

const brief = (msgs) => msgs.map((m) => `${m.ID} to=${recipients(m).join(",")} subject=${JSON.stringify(m.Subject)}`).join("; ") || "none";
const briefSome = (msgs) => `${brief(msgs.slice(0, BRIEF_MAX))}${msgs.length > BRIEF_MAX ? `; and ${msgs.length - BRIEF_MAX} more` : ""}`;
const subjectText = (subject) => (subject instanceof RegExp ? String(subject) : JSON.stringify(subject));

/** A summary's Created time as ms, or null. */
const createdOf = (m) => {
  const t = Date.parse(String(m?.Created ?? ""));
  return Number.isFinite(t) ? t : null;
};

/**
 * The newest of `msgs` (Mailpit search order, newest first): by `Created`
 * when every one has it, the first in search order on a tie or otherwise.
 */
function newest(msgs) {
  if (msgs.every((m) => createdOf(m) != null)) return msgs.reduce((a, b) => (createdOf(b) > createdOf(a) ? b : a));
  return msgs[0];
}

/** `want` less `got` and `got` less `want`, as multisets of strings. */
function multisetDiff(want, got) {
  const left = [...want];
  const extra = [];
  for (const g of got) {
    const k = left.indexOf(g);
    if (k < 0) extra.push(g);
    else left.splice(k, 1);
  }
  return { missing: left, extra };
}

/** expectMailboxes' `expected` as [{to, want}], each `want` sorted; a TypeError for anything else. */
function mailboxList(expected) {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    throw new TypeError(`expectMailboxes: expected is {[address]: [exact subjects]}, got ${Array.isArray(expected) ? "an array" : (JSON.stringify(expected) ?? String(expected))}`);
  }
  const entries = Object.entries(expected);
  if (entries.length === 0) throw new TypeError("expectMailboxes: name at least one mailbox");
  const named = new Set();
  return entries.map(([to, subjects]) => {
    const key = lower(to);
    if (!key) throw new TypeError("expectMailboxes: a mailbox is an exact address, got an empty one");
    if (named.has(key)) throw new TypeError(`expectMailboxes: ${to} is named twice (addresses compare without case)`);
    named.add(key);
    if (!Array.isArray(subjects) || subjects.some((s) => typeof s !== "string")) {
      throw new TypeError(`expectMailboxes: the subjects for ${to} are a list of exact subject strings, got ${JSON.stringify(subjects) ?? String(subjects)}`);
    }
    return { to, want: [...subjects].sort() };
  });
}

function msOption(who, name, v) {
  if (!Number.isFinite(v) || v < 0) throw new TypeError(`${who}: ${name} is a number of ms, 0 or more, got ${JSON.stringify(v) ?? String(v)}`);
}

/**
 * The product's document notices, by subject (functions/src/email/notify.ts):
 *   comment     "<author> commented on “<title>”"
 *   suggestion  "<author> suggested an edit to “<title>”"
 *   invitation  "<inviter> shared “<title>” with you"
 * One pattern per kind, tried in this order; a self-test pins them to the
 * source's templates. Frozen.
 */
export const NOTICE_KINDS = Object.freeze({
  comment: / commented on “/,
  suggestion: / suggested an edit to “/,
  invitation: / shared “.*” with you$/,
});
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The first kind in `kinds` ({kind: RegExp}, NOTICE_KINDS by default) whose pattern matches `subject`, or null. */
export function kindOfSubject(subject, kinds = NOTICE_KINDS) {
  for (const [kind, re] of Object.entries(kinds)) if (re.test(String(subject ?? ""))) return kind;
  return null;
}

/** settleKinds' `kinds`, checked: a non-empty {kind: RegExp} without "other" and without g or y flags. */
function kindList(kinds) {
  if (kinds === null || typeof kinds !== "object" || Array.isArray(kinds)) throw new TypeError(`settleKinds: kinds is {kind: RegExp}, got ${JSON.stringify(kinds) ?? String(kinds)}`);
  const entries = Object.entries(kinds);
  if (entries.length === 0) throw new TypeError("settleKinds: kinds names at least one kind");
  for (const [kind, re] of entries) {
    if (!KIND_RE.test(kind) || kind === "other") throw new TypeError(`settleKinds: a kind is a lowercase word other than "other" (what an unmatched subject is), got ${JSON.stringify(kind)}`);
    if (!(re instanceof RegExp)) throw new TypeError(`settleKinds: the pattern for ${kind} is a RegExp, got ${typeof re}`);
    if (re.global || re.sticky) throw new TypeError(`settleKinds: the pattern for ${kind} has the g or y flag, so test() would depend on the previous call`);
  }
  return kinds;
}

/**
 * A reader over target.mail.mailpitUrl.
 * @param {object} target
 * @param {object} [o]  {http} to reuse a client, or {evidence} for a new one
 */
export function mailbox(target, o = {}) {
  requireCapability(target, "mailpit");
  const base = String(target.mail?.mailpitUrl ?? "").replace(/\/+$/, "");
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(base)) throw new Error(`mailbox: target.mail.mailpitUrl is not a loopback origin: ${JSON.stringify(base)}`);
  const http = o.http ?? createHttp(target, { actor: "mailpit", evidence: o.evidence });

  /** Mailpit's search, every page: message summaries, newest first. */
  async function search(query) {
    const out = [];
    for (let start = 0; ; start += PAGE) {
      const r = await http.get(`${base}/api/v1/search`, { query: { query, start, limit: PAGE }, expect: 200 });
      const page = r.json?.messages;
      if (!Array.isArray(page)) throw mailError(`mailbox: Mailpit search answered without a messages list: ${r.text.slice(0, 200)}`);
      out.push(...page);
      const total = Number(r.json.messages_count ?? r.json.total ?? out.length);
      if (page.length < PAGE || out.length >= total) break;
    }
    return out;
  }

  /** Summaries of messages to exactly `to` (and, if given, with that subject). */
  async function find({ to, subject = null } = {}) {
    if (!to) throw new Error("mailbox.find: `to` is required (an exact address)");
    const narrowed = await search(`to:"${lower(to).replace(/"/g, "")}"`);
    return narrowed.filter((m) => matches(m, { to, subject }));
  }

  /** One full message: {ID, Subject, From, To, Text, HTML, …}. */
  async function message(id) {
    const r = await http.get(`${base}/api/v1/message/${encodeURIComponent(id)}`, { expect: 200 });
    return r.json;
  }

  /** A message's headers: {Name: [values]}. */
  async function headers(id) {
    const r = await http.get(`${base}/api/v1/message/${encodeURIComponent(id)}/headers`, { expect: 200 });
    return r.json;
  }

  /**
   * Wait for exactly `count` messages matching {to, subject}, held for
   * `settleMs`. Resolves {messages, waitedMs, settledMs, reads}; otherwise
   * throws E2E_MAIL saying what was seen.
   */
  async function expectMail({ to, subject = null, count = 1, timeout = 30_000, settleMs = MAIL_SETTLE_MS, interval = 250, allowShort = false } = {}) {
    if (!Number.isInteger(count) || count < 0) throw new Error("expectMail: count must be a whole number");
    if (settleMs < MAIL_SETTLE_MS && !allowShort) {
      throw new Error(`expectMail: a ${settleMs} ms settle cannot show that a count stopped moving (minimum ${MAIL_SETTLE_MS} ms; allowShort is for self-tests)`);
    }
    const what = `${count} message(s) to ${to}${subject != null ? ` with subject ${subject instanceof RegExp ? subject : JSON.stringify(subject)}` : ""}`;
    const t0 = Date.now();
    let seen = await find({ to, subject });
    let reads = 1;
    while (seen.length < count) {
      if (Date.now() - t0 >= timeout) throw mailError(`expectMail: wanted ${what}; saw ${seen.length} within ${timeout} ms (${brief(seen)})`, { seen });
      await sleep(interval);
      seen = await find({ to, subject });
      reads += 1;
    }
    const waitedMs = Date.now() - t0;
    const settleEnd = Date.now() + settleMs;
    for (;;) {
      if (seen.length !== count) {
        throw mailError(`expectMail: wanted ${what}; saw ${seen.length} after ${Date.now() - t0} ms (${brief(seen)})`, { seen });
      }
      if (Date.now() >= settleEnd) break;
      await sleep(Math.min(interval, Math.max(0, settleEnd - Date.now())));
      seen = await find({ to, subject });
      reads += 1;
    }
    return { messages: seen, waitedMs, settledMs: settleMs, reads };
  }

  /**
   * The newest message to exactly `to` (with `subject`, when given) as soon
   * as one is there, in full (as message(id) reads it). No settle: arrival
   * only, never a count. After `timeout` ms with none it throws E2E_MAIL
   * "waitFor: no message to <to> [with subject <s>] within <timeout> ms
   * (saw <n> to <to>: …)", with `seen` (every summary to `to`, whatever its
   * subject) and `waitedMs`: a wait that ran out, in a judge's terms.
   */
  async function waitFor({ to, subject = null, timeout = 30_000, interval = 250 } = {}) {
    if (!to) throw new Error("mailbox.waitFor: `to` is required (an exact address)");
    if (subject != null && typeof subject !== "string" && !(subject instanceof RegExp)) {
      throw new TypeError(`mailbox.waitFor: subject is a string (equal) or a RegExp, got ${JSON.stringify(subject) ?? String(subject)}`);
    }
    msOption("mailbox.waitFor", "timeout", timeout);
    msOption("mailbox.waitFor", "interval", interval);
    const what = `message to ${to}${subject != null ? ` with subject ${subjectText(subject)}` : ""}`;
    const t0 = Date.now();
    for (;;) {
      const all = await find({ to });
      const hit = all.filter((m) => matches(m, { subject }));
      if (hit.length > 0) return message(newest(hit).ID);
      if (Date.now() - t0 >= timeout) {
        throw mailError(`waitFor: no ${what} within ${timeout} ms (saw ${all.length} to ${to}: ${briefSome(all)})`, { seen: all, waitedMs: Date.now() - t0 });
      }
      await sleep(interval);
    }
  }

  /**
   * Every named mailbox holds exactly its subjects (`expected`: {[address]:
   * [exact subjects]}, a multiset; [] is a quiet mailbox), and all of them
   * still do for one shared `settleMs`. Resolves {mailboxes: {[address as
   * given]: summaries}, waitedMs, settledMs, reads}.
   *
   * Throws E2E_MAIL with `mailbox` (the first that differs, in the order
   * given), `differs` [{to, want, got, missing, extra}] (every one that
   * differs), `seen` {[address]: summaries} and `missingOnly`:
   *   - at once, when any mailbox holds a subject it should not (one too
   *     many, or one not listed): missingOnly false;
   *   - after `timeout` with some mailbox still short and nothing extra:
   *     "… within <timeout> ms …", missingOnly true;
   *   - during the settle, when any mailbox moves: missingOnly true only if
   *     nothing is extra.
   * A malformed `expected` (not an object, empty, an address named twice
   * without case, a subject that is not a string) throws a TypeError before
   * anything is read; so does a settle under MAIL_SETTLE_MS unless
   * `allowShort` (self-tests).
   */
  async function expectMailboxes(expected, { timeout = 30_000, settleMs = MAIL_SETTLE_MS, interval = 250, allowShort = false } = {}) {
    const boxes = mailboxList(expected);
    msOption("expectMailboxes", "timeout", timeout);
    msOption("expectMailboxes", "interval", interval);
    msOption("expectMailboxes", "settleMs", settleMs);
    if (settleMs < MAIL_SETTLE_MS && !allowShort) {
      throw new Error(`expectMailboxes: a ${settleMs} ms settle cannot show that a count stopped moving (minimum ${MAIL_SETTLE_MS} ms; allowShort is for self-tests)`);
    }
    const t0 = Date.now();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return Promise.all(boxes.map(async (b) => {
        const msgs = await find({ to: b.to });
        const got = msgs.map((m) => String(m?.Subject ?? "")).sort();
        return { ...b, msgs, got, ...multisetDiff(b.want, got) };
      }));
    };
    const fail = (rows, head) => {
      const differs = rows.filter((r) => r.missing.length || r.extra.length).map(({ to, want, got, missing, extra }) => ({ to, want, got, missing, extra }));
      const first = differs[0];
      const missingOnly = differs.every((d) => d.extra.length === 0);
      const detail = (d) => `the mail to ${d.to}${d.extra.length ? ` has extra ${JSON.stringify(d.extra)}` : ""}${d.extra.length && d.missing.length ? " and" : ""}${d.missing.length ? ` lacks ${JSON.stringify(d.missing)}` : ""} (saw ${JSON.stringify(d.got)}, wanted ${JSON.stringify(d.want)})`;
      const more = differs.length > 1 ? `; and ${differs.length - 1} more mailbox(es) differ: ${differs.slice(1).map((d) => d.to).join(", ")}` : "";
      return mailError(`expectMailboxes: ${head}: ${detail(first)}${more}`, {
        mailbox: first.to,
        differs,
        missingOnly,
        seen: Object.fromEntries(rows.map((r) => [r.to, r.msgs])),
      });
    };
    let rows = await read();
    for (;;) {
      if (rows.some((r) => r.extra.length)) throw fail(rows, `more mail than expected after ${Date.now() - t0} ms`);
      if (rows.every((r) => r.missing.length === 0)) break;
      if (Date.now() - t0 >= timeout) throw fail(rows, `within ${timeout} ms, a mailbox is still short`);
      await sleep(interval);
      rows = await read();
    }
    const waitedMs = Date.now() - t0;
    const settleEnd = Date.now() + settleMs;
    for (;;) {
      if (rows.some((r) => r.missing.length || r.extra.length)) throw fail(rows, `a mailbox moved during the ${settleMs} ms settle, after ${Date.now() - t0} ms`);
      if (Date.now() >= settleEnd) break;
      await sleep(Math.min(interval, Math.max(0, settleEnd - Date.now())));
      rows = await read();
    }
    return { mailboxes: Object.fromEntries(rows.map((r) => [r.to, r.msgs])), waitedMs, settledMs: settleMs, reads };
  }

  /**
   * A document's notices to `people`, counted per (person, kind), until
   * every `eligible` {to, kind} has one and all of it holds still for
   * `settleMs`: the input of invariants.mjs checkI11.
   *
   * A message counts when it is to one of `people` (exact recipient) and its
   * subject quotes `“<title>”`, as every notice of the product does; its
   * kind is the first of `kinds` (NOTICE_KINDS by default) whose pattern
   * matches, else "other". Resolves {messages: [{to (lower-cased), docId,
   * kind, at (its Created, ms), subject, id}] (in the order of `people`,
   * then by time), twice: [{to, kind, n}], missing: [{to, kind}], settled,
   * waitedMs, settledMs, reads}:
   *   - settled: true once nothing is missing and nothing moved for
   *     `settleMs` (every new message restarts that window);
   *   - settled: false, AT ONCE, when any (person, kind) has a second
   *     notice: mail cannot be unsent, so waiting cannot help. `twice` names
   *     them; pass `messages` to checkI11, which fails on them.
   * Throws E2E_MAIL, `missingOnly: true` (nothing extra: the one failure
   * functionKill may excuse), with `missing` and `messages`: when an
   * eligible notice has not come within `timeout` ("settleKinds: within
   * <timeout> ms, …"), or when the mailboxes are still moving at `timeout`
   * + `settleMs`.
   *
   * `docId` is what each message carries for checkI11; left out, the one
   * docId `eligible` names (null when none does). TypeError before anything
   * is read for: `people` not a non-empty list of addresses, or one named
   * twice (without case); an empty `title`; bad `kinds`; an eligible entry
   * whose `to` is not among `people` or whose kind is not a kind; eligible
   * entries naming two docIds, or one other than `docId`; a bad timeout or
   * interval. A settle under MAIL_SETTLE_MS throws unless `allowShort`
   * (self-tests).
   */
  async function settleKinds({ people, title, kinds = NOTICE_KINDS, eligible = [], docId = null, timeout = 30_000, settleMs = MAIL_SETTLE_MS, interval = 250, allowShort = false } = {}) {
    if (!Array.isArray(people) || people.length === 0 || people.some((p) => typeof p !== "string" || !lower(p))) {
      throw new TypeError(`settleKinds: people is a non-empty list of exact addresses, got ${JSON.stringify(people) ?? String(people)}`);
    }
    const who = people.map(lower);
    const dup = who.find((p, i) => who.indexOf(p) !== i);
    if (dup) throw new TypeError(`settleKinds: ${dup} is named twice in people (addresses compare without case)`);
    if (typeof title !== "string" || title.length === 0) throw new TypeError(`settleKinds: title is the document's title as its notices quote it, got ${JSON.stringify(title) ?? String(title)}`);
    kindList(kinds);
    if (!Array.isArray(eligible)) throw new TypeError(`settleKinds: eligible is a list of {to, kind}, got ${JSON.stringify(eligible) ?? String(eligible)}`);
    const docs = new Set();
    const wanted = eligible.map((e) => {
      if (!e || typeof e !== "object" || typeof e.to !== "string" || !who.includes(lower(e.to))) throw new TypeError(`settleKinds: an eligible entry's to is one of people, got ${JSON.stringify(e) ?? String(e)}`);
      if (!Object.hasOwn(kinds, e.kind)) throw new TypeError(`settleKinds: an eligible entry's kind is one of ${Object.keys(kinds).join(", ")}, got ${JSON.stringify(e.kind)}`);
      if (e.docId != null) docs.add(e.docId);
      return { to: lower(e.to), kind: e.kind };
    });
    if (docs.size > 1) throw new TypeError(`settleKinds: eligible names ${docs.size} documents (${[...docs].join(", ")}); count one document's notices per call`);
    if (docId !== null && docs.size === 1 && !docs.has(docId)) throw new TypeError(`settleKinds: eligible names ${[...docs][0]}, but docId is ${docId}`);
    const doc = docId ?? (docs.size === 1 ? [...docs][0] : null);
    msOption("settleKinds", "timeout", timeout);
    msOption("settleKinds", "interval", interval);
    msOption("settleKinds", "settleMs", settleMs);
    if (settleMs < MAIL_SETTLE_MS && !allowShort) {
      throw new Error(`settleKinds: a ${settleMs} ms settle cannot show that a count stopped moving (minimum ${MAIL_SETTLE_MS} ms; allowShort is for self-tests)`);
    }
    const quoted = `“${title}”`;
    const tuple = (to, kind) => `${to}\u0000${kind}`;
    const t0 = Date.now();
    let reads = 0;
    let last = null;
    let since = t0;
    for (;;) {
      reads += 1;
      const boxes = await Promise.all(who.map(async (to) => ({ to, msgs: await find({ to }) })));
      const messages = [];
      for (const { to, msgs } of boxes) {
        const mine = msgs
          .filter((m) => String(m?.Subject ?? "").includes(quoted))
          .map((m) => ({ to, docId: doc, kind: kindOfSubject(m.Subject, kinds) ?? "other", at: createdOf(m), subject: String(m.Subject), id: m.ID }));
        mine.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
        messages.push(...mine);
      }
      const counts = new Map();
      for (const m of messages) counts.set(tuple(m.to, m.kind), (counts.get(tuple(m.to, m.kind)) ?? 0) + 1);
      const twice = [...counts].filter(([, n]) => n > 1).map(([k, n]) => {
        const [to, kind] = k.split("\u0000");
        return { to, kind, n };
      });
      const missing = wanted.filter((e) => !counts.get(tuple(e.to, e.kind)));
      const key = JSON.stringify(messages.map((m) => [m.to, m.kind, m.id]));
      const now = Date.now();
      if (key !== last) {
        last = key;
        since = now;
      }
      const result = (settled) => ({ messages, twice, missing, settled, waitedMs: now - t0, settledMs: now - since, reads });
      if (twice.length) return result(false);
      if (missing.length === 0 && now - since >= settleMs) return result(true);
      const brief = () => messages.map((m) => `${m.kind} to ${m.to}`).join(", ") || "none";
      if (missing.length && now - t0 >= timeout) {
        throw mailError(`settleKinds: within ${timeout} ms, ${missing.length} eligible notice(s) about “${title}” never came: ${missing.map((e) => `${e.kind} to ${e.to}`).join(", ")} (saw ${messages.length}: ${brief()})`, { missing, messages, missingOnly: true });
      }
      if (now - t0 >= timeout + settleMs) {
        throw mailError(`settleKinds: within ${timeout + settleMs} ms, the notices about “${title}” to ${who.length} people did not hold still for ${settleMs} ms (the last change ${now - since} ms ago; saw ${messages.length}: ${brief()})`, { missing, messages, missingOnly: true });
      }
      await sleep(interval);
    }
  }

  return { base, http, search, find, message, headers, expectMail, waitFor, expectMailboxes, settleKinds };
}
