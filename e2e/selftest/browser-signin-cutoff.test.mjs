// SPDX-License-Identifier: Apache-2.0
// Self-test: signInUi's default waits outlast Hosting's 60 s cut-off, so a POST /session the stack never answered ends in a refusal the judges read (SPEC §12).

/**
 * signInUi runs here on a User with no browser: its page is a sign-in form
 * that shows the session's error once POST /session is answered, and its
 * waitForResponse answers that POST after a set time, as the Hosting emulator
 * does with its own 504 at 60,010 ms, or runs out first when its timeout is
 * shorter. Every wait signInUi makes is recorded with its timeout. A
 * self-test cannot wait a minute; the waits' lengths are what is measured.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { User } from "../lib/browser.mjs";
import { stackDidNotAnswer } from "../lib/test.mjs";

const CUT = "Hosting's cut-off for a function that has not answered";
/** The Hosting emulator's own 504 for POST /session, measured on a loaded shared stack. */
const CUTOFF_ANSWER_MS = 60_010;

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

/**
 * A User without a browser, whose POST /session is answered `status` after
 * `answerMs`: then a 200 leaves the sign-in page with a session cookie, and
 * anything else shows the form with its error. `waits` records [what,
 * timeout] for every wait signInUi makes.
 */
function standIn({ answerMs = CUTOFF_ANSWER_MS, status = 504 } = {}) {
  const waits = [];
  let answered = false;
  const u = Object.create(User.prototype);
  Object.assign(u, {
    name: "owner",
    target: { origin: "http://127.0.0.1:1" },
    responses: [],
    responseMark: () => 0,
    goto: async () => {},
    async poll(fn, { timeout, what } = {}) {
      waits.push([what, timeout]);
      const v = await fn();
      if (v) return v;
      throw new Error(`owner: ${what} not reached within ${timeout} ms`);
    },
    async waitForResponse(pred, { timeout } = {}) {
      waits.push(["POST /session", timeout]);
      if (timeout < answerMs) throw new Error(`owner: no matching response within ${timeout} ms (last seen: none)`);
      answered = true;
      return { seq: 1, method: "POST", path: "/session", status, ms: answerMs, response: null };
    },
    sessionCookie: async () => (answered && status === 200 ? { name: "__session" } : null),
    page: {
      evaluate: async () => {
        if (answered && status === 200) return { state: "left", path: "/" };
        return { state: "form", error: answered ? "Could not establish a secure session. Try signing in again." : null };
      },
      fill: async () => {},
      getByRole: () => ({ click: async () => {} }),
      url: () => "http://127.0.0.1:1/signup",
    },
  });
  return { u, waits };
}

test("by default every wait outlasts Hosting's cut-off: a POST /session it cut off is the refusal carrying that 504, which stackDidNotAnswer reads", async () => {
  const { u, waits } = standIn();
  const err = await rejection(u.signInUi("owner@example.test", "a-password"));
  assert.deepEqual(err.response, { method: "POST", path: "/session", status: 504, ms: CUTOFF_ANSWER_MS }, err.message);
  assert.match(err.message, /POST \/session answered 504 \(body unread\), the page shows "session_failed" \(wanted ok\)/);
  assert.equal(stackDidNotAnswer(err), `POST /session answered 504 after ${CUTOFF_ANSWER_MS} ms, ${CUT}`);
  assert.equal(waits.length, 3, `the form, the answer, the outcome: ${JSON.stringify(waits)}`);
  const lengths = new Set(waits.map(([, ms]) => ms));
  assert.equal(lengths.size, 1, `one default for every wait: ${JSON.stringify(waits)}`);
  const [ms] = lengths;
  assert.ok(ms >= CUTOFF_ANSWER_MS + 10_000, `the default (${ms} ms) leaves the page 10 s to show what Hosting answered at ${CUTOFF_ANSWER_MS} ms`);
});

test("NEGATIVE: the old 45 s wait runs out with POST /session still open, a failure stackDidNotAnswer cannot read", async () => {
  const { u, waits } = standIn();
  const err = await rejection(u.signInUi("owner@example.test", "a-password", { timeout: 45_000 }));
  assert.match(err.message, /no matching response within 45000 ms/);
  assert.equal(err.response, undefined);
  assert.equal(stackDidNotAnswer(err), null);
  assert.deepEqual(waits.map(([, ms]) => ms), [45_000, 45_000], "a timeout the case gives is every wait's");
});

test("a quicker answer is judged as before: a quick 504 is refused and not the cut-off; an ok outcome resolves", async () => {
  const quick = standIn({ answerMs: 1_200 });
  const err = await rejection(quick.u.signInUi("owner@example.test", "a-password"));
  assert.equal(err.response.status, 504);
  assert.equal(stackDidNotAnswer(err), null, "a quick 504 is the product's answer");

  const ok = standIn({ answerMs: 900, status: 200 });
  const s = await ok.u.signInUi("owner@example.test", "a-password");
  assert.equal(s.status, "ok");
  assert.equal(s.httpStatus, 200);
});
