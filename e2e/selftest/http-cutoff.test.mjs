// SPDX-License-Identifier: Apache-2.0
// Self-test: a client made with cutoffError throws E2E_STACK_CUTOFF for Hosting's cut-off 504, and the session helpers pass the option on (SPEC §12).

/**
 * createHttp's `cutoffError` is checked against a stand-in fetch on a clock
 * this file moves (a self-test cannot wait a minute for Hosting's cut-off):
 * the boundary against lib/test.mjs HOSTING_CUTOFF_MS, the wording against
 * stackCutoff, the order against `expect`, the timing per redirect hop, and
 * `with()`. Then openSession, against a local server whose POST /session
 * answers 504 while the clock jumps past the cut-off, with and without the
 * option. No browser, no stack.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttp } from "../lib/http.mjs";
import { bearerHttp, openSession } from "../lib/session.mjs";
import { HOSTING_CUTOFF_MS, isHostingCutoff, onAnsweringStack, stackCutoff, stackDidNotAnswer } from "../lib/test.mjs";

const CUT = "Hosting's cut-off for a function that has not answered";
const LEAD = "the stack did not answer, so nothing was measured: ";
const BODY_504 = "Timed out waiting for function to respond.";

let server;
let target;
let skew = 0; // ms the stand-in server adds to Date.now() as it answers POST /session
const realNow = Date.now;

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

/** The auth emulator's signInWithPassword, and a POST /session that answers 504 as the clock passes Hosting's cut-off. */
function stand() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.startsWith("/auth/accounts:signInWithPassword")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ idToken: "id-token-for-the-stand-in", refreshToken: "refresh-for-the-stand-in", localId: "u1", expiresIn: "3600" }));
      }
      if (req.method === "POST" && req.url === "/session") {
        skew += 60_005; // what the Hosting emulator's own 504 takes
        res.writeHead(504, { "content-type": "text/plain" });
        return res.end(BODY_504);
      }
      res.writeHead(404).end();
    });
  });
}

before(async () => {
  server = stand();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  target = { kind: "local", runId: `selftest-cut-${process.pid}`, runDir: "/nonexistent-run-dir", origin, authRestBase: `${origin}/auth`, webApiKey: "stand-in-key", projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: { hosting: port } } };
});

after(async () => {
  Date.now = realNow;
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

let clock = 1_800_000_000_000;
/** Run `fn` with Date.now() reading `clock`, which only the stand-in fetch moves. */
async function onTheClock(fn) {
  Date.now = () => clock;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** A fetch that answers each call with the next of `script` ({status, ms, location, body}), moving the clock by its `ms`. */
function scripted(script) {
  const calls = [];
  let i = 0;
  const fetch = async (url, init) => {
    const step = script[i++];
    if (!step) throw new Error(`the stand-in fetch was called ${i} times, scripted for ${script.length}`);
    calls.push({ url, method: init.method });
    clock += step.ms;
    const headers = { "content-type": "text/plain", ...(step.location ? { location: step.location } : {}) };
    return new Response(step.body ?? (step.status === 504 ? BODY_504 : "answer"), { status: step.status, headers });
  };
  return { fetch, calls };
}

const client = (o = {}) => createHttp(target, { actor: "selftest", evidence: false, guard: { check: () => ({ allow: true }) }, ...o });
const once = (status, ms, o = {}) => client({ cutoffError: true, ...o, fetch: scripted([{ status, ms }]).fetch });

test("cutoffError: Hosting's 504 at its cut-off throws E2E_STACK_CUTOFF, worded as stackCutoff; the boundary is lib/test.mjs HOSTING_CUTOFF_MS", async () => {
  const short = await onTheClock(() => once(504, HOSTING_CUTOFF_MS - 1).post("/access"));
  assert.equal(short.status, 504, "one ms short of the cut-off is an answer, returned");
  assert.equal(short.ms, HOSTING_CUTOFF_MS - 1);

  const err = await onTheClock(() => rejection(once(504, HOSTING_CUTOFF_MS).post("/access", { json: { docId: "d1" } })));
  assert.equal(err.code, "E2E_STACK_CUTOFF");
  assert.equal(err.message, `POST /access answered 504 after ${HOSTING_CUTOFF_MS} ms, ${CUT}`);
  assert.equal(err.message, stackCutoff("POST /access", HOSTING_CUTOFF_MS).message, "the same words as lib/test.mjs stackCutoff");
  assert.equal(err.stackCut, err.message);
  assert.equal(err.response.status, 504, "the response rides along");
  assert.equal(err.response.text, BODY_504);
  assert.equal(err.response.ms, HOSTING_CUTOFF_MS);
  assert.ok(isHostingCutoff(err.response), "and lib/test.mjs reads it as the cut-off too");
  assert.equal(stackDidNotAnswer(err), err.message);

  const ctx = { ev: { text() {}, step() {} } };
  const inc = await onTheClock(() => rejection(onAnsweringStack(async () => once(504, 60_005).get("/folder-access"))(ctx)));
  assert.equal(inc.code, "E2E_INCONCLUSIVE");
  assert.equal(inc.reason, `${LEAD}GET /folder-access answered 504 after 60005 ms, ${CUT}`);

  const keyed = await onTheClock(() => rejection(once(504, 60_000).get("/content/~abcdefgh12345678/d1/v1/index.html?k=abcdefgh12345678")));
  assert.equal(keyed.message, `GET /content/~‹redacted›/d1/v1/index.html answered 504 after 60000 ms, ${CUT}`);
  assert.doesNotMatch(keyed.message, /abcdefgh12345678/, "a link key never reaches the reason");
});

test("the product's answers are returned as they were: a quicker 504, another status however slow, and any 504 without the option", async () => {
  for (const [status, ms] of [[504, 1_200], [500, 60_005], [200, 61_000], [502, 60_005]]) {
    const r = await onTheClock(() => once(status, ms).post("/publish"));
    assert.equal(r.status, status, `${status} after ${ms} ms`);
  }
  const plain = client({ fetch: scripted([{ status: 504, ms: 60_005 }]).fetch });
  assert.equal(plain.cutoffError, false, "off unless asked");
  assert.equal((await onTheClock(() => plain.post("/publish"))).status, 504, "without the option, the cut-off is returned as before");
  assert.equal(client({ cutoffError: null }).cutoffError, false);
  assert.equal(client({ cutoffError: undefined }).cutoffError, false);
});

test("expect: the cut-off throws before expect is checked; a quicker 504 is still E2E_STATUS", async () => {
  const cut = await onTheClock(() => rejection(once(504, 60_005).post("/organize", { json: {}, expect: 200 })));
  assert.equal(cut.code, "E2E_STACK_CUTOFF");
  const listed = await onTheClock(() => rejection(once(504, 60_005).post("/organize", { json: {}, expect: [200, 504] })));
  assert.equal(listed.code, "E2E_STACK_CUTOFF", "Hosting's 504 is never the product's, even where a 504 is expected");
  const quick = await onTheClock(() => rejection(once(504, 900).post("/organize", { json: {}, expect: 200 })));
  assert.equal(quick.code, "E2E_STATUS");
  assert.equal(stackDidNotAnswer(quick), null, "a quick 504 is judged");
  const fine = await onTheClock(() => once(504, 900).post("/organize", { json: {}, expect: 504 }));
  assert.equal(fine.status, 504);
});

test("timed per hop: a redirect's slow first hop does not make a quick 504 the cut-off; a slow last hop does, named by its own method and path", async () => {
  const slowFirst = scripted([{ status: 302, ms: 58_000, location: "/b" }, { status: 504, ms: 2_000 }]);
  const r = await onTheClock(() => client({ cutoffError: true, fetch: slowFirst.fetch }).post("/a", { redirect: "follow" }));
  assert.equal(r.status, 504, "the last hop answered in 2 s: returned");
  assert.equal(r.ms, 60_000, "the whole request took 60 s");
  assert.deepEqual(slowFirst.calls.map((c) => [c.method, new URL(c.url).pathname]), [["POST", "/a"], ["GET", "/b"]]);

  const slowLast = scripted([{ status: 302, ms: 100, location: "/b" }, { status: 504, ms: 60_005 }]);
  const err = await onTheClock(() => rejection(client({ cutoffError: true, fetch: slowLast.fetch }).post("/a", { redirect: "follow" })));
  assert.equal(err.code, "E2E_STACK_CUTOFF");
  assert.equal(err.message, `GET /b answered 504 after 60005 ms, ${CUT}`, "the hop that was cut off, as it was sent");
  assert.equal(err.response.ms, 60_105);
});

test("with() keeps cutoffError, and may change it; a cutoffError that is not a boolean throws when the client is made", async () => {
  const c = client({ cutoffError: true, fetch: scripted([{ status: 504, ms: 60_005 }, { status: 504, ms: 60_005 }]).fetch });
  const same = c.with({ headers: { "x-extra": "1" } });
  assert.equal(same.cutoffError, true);
  assert.equal((await onTheClock(() => rejection(same.get("/view")))).code, "E2E_STACK_CUTOFF", "with() keeps it");
  const off = c.with({ cutoffError: false });
  assert.equal(off.cutoffError, false);
  assert.equal((await onTheClock(() => off.get("/view"))).status, 504, "with({cutoffError: false}) returns it");
  assert.equal(client().with({ cutoffError: true }).cutoffError, true);
  for (const bad of ["yes", 1, 0, {}]) {
    assert.throws(() => client({ cutoffError: bad }), (e) => e instanceof TypeError && /createHttp: cutoffError is true or false/.test(e.message), JSON.stringify(bad));
  }
});

test("openSession and bearerHttp pass cutoffError to the client they make: POST /session cut off is E2E_STACK_CUTOFF; without it, E2E_SESSION carrying the response, as before", async () => {
  const account = { role: "owner", email: "owner@example.test", password: "a-password-for-the-stand-in" };
  Date.now = () => realNow() + skew;
  try {
    const cut = await rejection(openSession(target, account, { cutoffError: true, evidence: false }));
    assert.equal(cut.code, "E2E_STACK_CUTOFF", cut.message);
    const waited = Number(/^POST \/session answered 504 after (\d+) ms, /.exec(cut.message)?.[1]);
    assert.equal(cut.message, `POST /session answered 504 after ${waited} ms, ${CUT}`);
    assert.ok(waited >= 60_005, `the clock jumped past the cut-off as the stand-in answered (${waited} ms)`);
    assert.equal(stackDidNotAnswer(cut), cut.message);

    const plain = await rejection(openSession(target, account, { evidence: false }));
    assert.equal(plain.code, "E2E_SESSION", "without the option, openSession's own refusal");
    assert.equal(plain.response.status, 504);
    assert.match(stackDidNotAnswer(plain), new RegExp(`^POST /session answered 504 after 6\\d{4,} ms, ${CUT}$`), "which lib/test.mjs reads as the cut-off too");
  } finally {
    Date.now = realNow;
  }
  assert.equal(bearerHttp(target, "a-token", { cutoffError: true, evidence: false }).cutoffError, true);
  assert.equal(bearerHttp(target, "a-token", { evidence: false }).cutoffError, false);
  await assert.rejects(openSession(target, account, { cutoffError: "yes", evidence: false }), TypeError, "a bad option is refused before anything is sent");
});
