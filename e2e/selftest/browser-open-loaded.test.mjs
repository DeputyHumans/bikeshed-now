// SPDX-License-Identifier: Apache-2.0
// Self-test: User.open with `reloads` loads a document again only after the page saw the stack stall, and with `sessionCheck` judges the load's own POST /session, Hosting's cut-off there being the stack not answering (SPEC §3, §12).

/**
 * Hermetic: a local server serves /d/<docId> as an app page that follows a
 * plan, load by load: whether it posts its ID token to /session (as every
 * load of a signed-in page does, app/src/auth.tsx) and how /session answers
 * it ("ok" 200, "cut" Hosting's cut-off, "quick504", "refused" 403, after
 * `delayMs`), whether its Firestore client logs that it lost the emulator,
 * and whether the viewer and its document frame show. A self-test cannot
 * wait out Hosting's minute: a 504 the server marks with `x-e2e-cutoff` has
 * its entry stamped as taking 60,010 ms (the Hosting emulator's own,
 * measured) as the user records it. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { pageStall, stackDidNotAnswer } from "../lib/test.mjs";

const CUTOFF_ANSWER_MS = 60_010;
const CUT = "Hosting's cut-off for a function that has not answered";
const LOST_LINE = "@firebase/firestore: Firestore (11.0.0): Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds.";
const T = 2_000;

/** docId → the plan, one entry per load (the last repeats): {session: "ok"|"cut"|"quick504"|"refused"|"none", delayMs, lost, show}. */
const plans = new Map();
const loads = new Map();
const sessions = [];
let server;
let target;

const step = (o = {}) => ({ session: "ok", delayMs: 0, lost: false, show: true, ...o });
const planFor = (docId, n) => {
  const p = plans.get(docId) ?? [step()];
  return p[Math.min(n, p.length) - 1];
};

function page(docId, n, s) {
  return `<!doctype html><html><head><title>load ${n}</title></head><body><div id="root">Opening the document…</div><script>
  ${s.lost ? `console.error(${JSON.stringify(LOST_LINE)});` : ""}
  ${s.session !== "none" ? `fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "x", docId: ${JSON.stringify(docId)}, load: ${n} }), credentials: "same-origin" }).catch(() => {});` : ""}
  ${s.show ? `setTimeout(() => { document.getElementById("root").innerHTML = '<div class="viewer"><div class="viewer-body"><iframe class="doc-frame" sandbox="allow-same-origin" src="/content/${docId}/v1/index.html"></iframe></div></div>'; }, 100);` : ""}
</script></body></html>`;
}

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const d = /^\/d\/([A-Za-z0-9-]+)(?:\/v\d+)?$/.exec(u.pathname);
    if (req.method === "GET" && d) {
      const n = (loads.get(d[1]) ?? 0) + 1;
      loads.set(d[1], n);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(page(d[1], n, planFor(d[1], n)));
    }
    if (req.method === "POST" && u.pathname === "/session") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { docId, load } = JSON.parse(raw);
        sessions.push([docId, load]);
        const s = planFor(docId, load);
        setTimeout(() => {
          if (s.session === "cut" || s.session === "quick504") {
            res.statusCode = 504;
            if (s.session === "cut") res.setHeader("x-e2e-cutoff", "1");
            res.setHeader("content-type", "text/plain");
            return res.end("Timed out waiting for function to respond.");
          }
          res.statusCode = s.session === "refused" ? 403 : 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ status: s.session === "refused" ? "not_allowed" : "ok" }));
        }, s.delayMs);
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    if (u.pathname.startsWith("/content/")) return res.end("<!doctype html><html><body><p>The document.</p></body></html>");
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-open-loaded", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

let pool = null;
after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** A fresh reader whose 504s the server marks are recorded as Hosting's cut-off. */
async function reader() {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name: "reader" });
  const push = u.responses.push.bind(u.responses);
  u.responses.push = (...entries) => push(...entries.map((e) => (e.status === 504 && e.headers?.["x-e2e-cutoff"] === "1" ? Object.assign(e, { ms: CUTOFF_ANSWER_MS }) : e)));
  return u;
}

async function withReader(fn) {
  const u = await reader();
  try {
    return await fn(u);
  } finally {
    await u.close();
  }
}

const rejection = (p) => p.then(() => assert.fail("expected a rejection"), (e) => e);
const sessionsOf = (docId) => sessions.filter(([d]) => d === docId).map(([, n]) => n);

test("without reloads or sessionCheck, open is as it was: one load, waitForFrame's result, a cut-off POST /session not looked at", async () => {
  plans.set("plain", [step({ session: "cut" })]);
  await withReader(async (u) => {
    const r = await u.open("plain", { timeout: T });
    assert.deepEqual(Object.keys(r).sort(), ["editable", "sandbox", "src"]);
    assert.equal(r.src, "/content/plain/v1/index.html");
    assert.equal(loads.get("plain"), 1);
  });
});

test("sessionCheck: the load's POST /session cut off by Hosting loads the page again, and the next load's own answer is taken, though it came after its frame showed", async () => {
  plans.set("cut-once", [step({ session: "cut" }), step({ session: "ok", delayMs: 800 })]);
  await withReader(async (u) => {
    const r = await u.open("cut-once", { timeout: T, reloads: 1, sessionCheck: true });
    assert.equal(r.src, "/content/cut-once/v1/index.html");
    assert.equal(r.loads, 2);
    assert.deepEqual(r.stall, [`reader: POST /session 504 after ${CUTOFF_ANSWER_MS} ms`]);
    assert.deepEqual([r.session.method, r.session.path, r.session.status], ["POST", "/session", 200]);
    assert.ok(r.session.ms >= 700, `the second load's own answer, ${Math.round(r.session.ms)} ms after it was sent`);
    assert.equal(u.findResponses({ method: "POST", path: "/session" }).find((e) => e.seq === r.session.seq)?.postJson?.load, 2, "matched by its request: load 2's");
    assert.deepEqual(sessionsOf("cut-once"), [1, 2]);
    assert.equal(loads.get("cut-once"), 2);
  });
});

test("sessionCheck: cut off on every load allowed, it throws Hosting's cut-off as the stack not answering, naming the load and never the link key", async () => {
  plans.set("cut-always", [step({ session: "cut" })]);
  await withReader(async (u) => {
    const err = await rejection(u.open("cut-always", { k: "SECRET-LINK-KEY", timeout: T, reloads: 1, sessionCheck: true }));
    assert.equal(err.code, "E2E_STACK_CUTOFF");
    assert.equal(err.message, `reader's POST /session on load 2 of /d/cut-always answered 504 after ${CUTOFF_ANSWER_MS} ms, ${CUT}`);
    assert.equal(stackDidNotAnswer(err), err.message);
    assert.deepEqual([err.loads, err.response?.status, err.response?.postJson?.load], [2, 504, 2]);
    assert.ok(new URL(u.page.url()).search.includes("SECRET-LINK-KEY"), "the page was opened with its key");
    assert.ok(!JSON.stringify({ m: err.message, s: err.stackCut }).includes("SECRET"), "no message names it");
    assert.equal(loads.get("cut-always"), 2);
  });
  plans.set("cut-no-reload", [step({ session: "cut" })]);
  await withReader(async (u) => {
    const err = await rejection(u.open("cut-no-reload", { timeout: T, sessionCheck: true }));
    assert.equal(err.message, `reader's POST /session on load 1 of /d/cut-no-reload answered 504 after ${CUTOFF_ANSWER_MS} ms, ${CUT}`);
    assert.equal(loads.get("cut-no-reload"), 1, "reloads 0: not loaded again");
  });
});

test("NEGATIVE: sessionCheck: a quick 504 or a refusal is an answer; it stands, and nothing is loaded again", async () => {
  for (const [docId, session, status] of [["quick", "quick504", 504], ["refused", "refused", 403]]) {
    plans.set(docId, [step({ session })]);
    await withReader(async (u) => {
      const r = await u.open(docId, { timeout: T, reloads: 1, sessionCheck: true });
      assert.deepEqual([r.loads, r.stall, r.session.status], [1, null, status], docId);
      assert.ok(r.session.ms < 59_000);
      assert.equal(loads.get(docId), 1, docId);
    });
  }
});

test("reloads: a load whose Firestore client lost the emulator, and whose viewer never showed, is loaded again; without sessionCheck, session is null", async () => {
  plans.set("lost-once", [step({ session: "none", lost: true, show: false }), step({ session: "none" })]);
  await withReader(async (u) => {
    const r = await u.open("lost-once", { timeout: T, reloads: 1 });
    assert.deepEqual([r.loads, r.stall, r.session], [2, ['reader: "Could not reach Cloud Firestore backend"'], null]);
    assert.equal(loads.get("lost-once"), 2);
  });
});

test("NEGATIVE: reloads: a load that saw no stall is never loaded again, though the next would show: E2E_NOT_SHOWN, which pageStall does not excuse", async () => {
  plans.set("quiet", [step({ session: "none", show: false }), step({ session: "none" })]);
  await withReader(async (u) => {
    const err = await rejection(u.open("quiet", { timeout: T, reloads: 1 }));
    assert.equal(err.code, "E2E_NOT_SHOWN");
    assert.equal(err.message, `reader: open: the viewer and its document frame not shown within ${T} ms of load 1 of /d/quiet: the page saw no stall of the stack in that load`);
    assert.deepEqual([err.loads, err.stall], [1, []]);
    assert.match(err.cause?.message ?? "", /a loaded document frame not reached within 2000 ms/);
    assert.equal(loads.get("quiet"), 1);
    assert.equal(pageStall(err, { usersSoFar: [u] }), null, "FAILS: nothing excuses it");
  });
});

test("reloads: stalled on every load allowed: E2E_NOT_SHOWN naming the last load's evidence, which pageStall judges the stack's", async () => {
  plans.set("lost-always", [step({ session: "none", lost: true, show: false })]);
  await withReader(async (u) => {
    const err = await rejection(u.open("lost-always", { timeout: T, reloads: 1 }));
    assert.equal(err.code, "E2E_NOT_SHOWN");
    assert.equal(err.message, `reader: open: the viewer and its document frame not shown within ${T} ms of load 2 of /d/lost-always: the page saw the stack stall in that load (reader: "Could not reach Cloud Firestore backend"); loaded again after the stack stalled (reader: "Could not reach Cloud Firestore backend")`);
    assert.equal(loads.get("lost-always"), 2);
    assert.match(pageStall(err, { usersSoFar: [u] }) ?? "", /^a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\)/);
  });
});

test("NEGATIVE: sessionCheck on a page that posts no /session (a signed-out reader) throws, within its timeout, saying so", async () => {
  plans.set("anon", [step({ session: "none" })]);
  await withReader(async (u) => {
    const t0 = Date.now();
    const err = await rejection(u.open("anon", { timeout: T, sessionCheck: true }));
    assert.equal(err.message, `reader: open: load 1 of /d/anon sent no POST /session within ${T} ms of its frame showing; sessionCheck is for a signed-in user, whose every load posts its ID token (app/src/auth.tsx)`);
    assert.ok(Date.now() - t0 < 3 * T + 3_000, `${Date.now() - t0} ms`);
  });
});

test("bad options throw before anything is loaded", async () => {
  await withReader(async (u) => {
    const before = loads.get("never") ?? 0;
    await assert.rejects(u.open("never", { reloads: -1 }), /reader: open reloads is a whole number 0 or more, got -1/);
    await assert.rejects(u.open("never", { reloads: 1.5 }), /open reloads is a whole number/);
    await assert.rejects(u.open("never", { reloads: "1" }), /open reloads is a whole number/);
    await assert.rejects(u.open("never", { sessionCheck: "yes" }), /reader: open sessionCheck is true or false, got "yes"/);
    await assert.rejects(u.open("never", { sessionCheck: true, timeout: 0 }), /reader: open timeout is a number of ms above 0, got 0/);
    assert.equal(loads.get("never") ?? 0, before);
  });
});
