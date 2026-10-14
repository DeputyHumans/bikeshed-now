// SPDX-License-Identifier: Apache-2.0
// Self-test: User.newTab is one person's second tab, a User of its own in the same context, and each tab waits only on its own page's requests and toasts (SPEC §12).

/**
 * Hermetic: a local server stands in for the app. GET / is a page with a
 * toast stack and two helpers, `post(path, body)` (a fetch POST that
 * resolves the status) and `toast(kind, text)` (a toast as
 * app/src/components/Toast.tsx renders one, which the pool's toast observer
 * records). POST /draft answers `{who}` from its body after 20 ms. Needs
 * Chrome.
 *
 * Identity is checked with `same`/`sameList`, never assert.equal on a User,
 * a Page or a context: a failing assert.equal inspects both sides, and a
 * User's inspection walks the whole Playwright graph. A negative control
 * that failed that way grew for 140 s until the OS killed it (exit 137),
 * printing nothing and leaving its Chrome behind.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

const APP = `<!doctype html><html><head><meta charset="utf-8"><title>app</title></head><body>
<p>app</p><div class="toast-stack"></div>
<script>
  window.post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
  window.toast = (kind, text) => {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " toast-error" : "");
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    const span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    document.querySelector(".toast-stack").appendChild(el);
    return true;
  };
</script></body></html>`;

let server;
let target;
const pools = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = new URL(req.url, "http://x").pathname;
      if (req.method === "POST" && path === "/draft") {
        let who = null;
        try {
          who = JSON.parse(body).who;
        } catch {}
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ who }));
        }, 20);
        return;
      }
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(APP);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-tabs", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await Promise.allSettled(pools.map((p) => p.close()));
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

function newPool() {
  const p = new BrowserPool({ target });
  pools.push(p);
  return p;
}

/** A page of the app: the user's own, a tab's, or any page of a context. */
const onApp = async (page) => {
  await page.goto(`${target.origin}/`, { waitUntil: "load" });
  return page;
};
const post = (page, who) => page.evaluate((who) => window.post("/draft", { who }), who);
const toast = (page, kind, text) => page.evaluate(([k, t]) => window.toast(k, t), [kind, text]);
const whoOf = async (entry) => JSON.parse(await entry.response.text()).who;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a User, a Page or a context is called in a message: never the object itself (see the header). */
const label = (x) => (x == null ? String(x) : typeof x.name === "string" ? `User ${x.name}` : typeof x.url === "function" ? `a page (${(() => { try { return x.url(); } catch { return "?"; } })()})` : typeof x);
/** `a` is `b`, the same object, without printing either. */
const same = (a, b, msg) => assert.ok(a === b, `${msg}: got ${label(a)}, want ${label(b)}`);
/** `list` holds exactly `want`, the same objects in order, without printing them. */
const sameList = (list, want, msg) => assert.ok(Array.isArray(list) && list.length === want.length && list.every((x, i) => x === want[i]), `${msg}: got [${(list ?? []).map(label).join(", ")}], want [${want.map(label).join(", ")}]`);

/** Wait until `log.toasts` holds a toast with this text (the binding is asynchronous). */
async function toastLogged(u, text, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = u.log.toasts.find((x) => x.text === text);
    if (t) return t;
    await sleep(25);
  }
  throw new Error(`toast ${JSON.stringify(text)} never reached log.toasts`);
}

test("newTab: another page of the same context, a User of its own (name, page, inEdit), the context's records written through, flat, never in pool.users", async () => {
  const pool = newPool();
  const u = await pool.user({ name: "e" });
  await u.goto("/");
  await u.page.evaluate(() => (document.cookie = "who=e; path=/"));
  u.email = "e@example.test";
  u.inEdit = true;
  const b = await u.newTab();
  assert.equal(b.name, "e-tab2", "the default name: the user's, then -tab<k> from 2");
  same(b.tabOf, u, "the tab names its user");
  sameList(u.tabs, [b], "the user lists the tab");
  same(u.tabOf, null, "the user is no tab");
  same(b.context, u.context, "the same context");
  assert.ok(b.page !== u.page, "its own page");
  assert.ok(u.context.pages().includes(b.page));
  same(b.pool, u.pool, "the same pool");
  same(b.target, u.target, "the same target");
  same(b.device, u.device, "the same device");
  assert.equal(b.inEdit, false, "its own inEdit");
  assert.equal(u.inEdit, true);
  b.inEdit = true;
  u.inEdit = false;
  assert.deepEqual([u.inEdit, b.inEdit], [false, true]);
  for (const key of ["log", "responses", "creating"]) same(b[key], u[key], `${key} is the context's: the user's own object`);
  assert.equal(b.email, "e@example.test", "the account the context signed in as");
  b.email = "f@example.test";
  assert.equal(u.email, "f@example.test", "written through to the user (signInUi on a tab signs the whole context in)");
  assert.equal(b.responseMark(), u.responseMark(), "one response sequence for the context");
  await onApp(b.page);
  assert.match(await b.page.evaluate(() => document.cookie), /who=e/, "the same cookies");
  sameList(pool.users, [u], "a tab is never one of the pool's users (its rows are already the user's)");
  assert.equal(pool.stats().users, 1);

  const c = await b.newTab({ name: "third" });
  same(c.tabOf, u, "a tab's tab is a tab of the user: tabs are flat");
  sameList(u.tabs, [b, c], "both tabs are the user's");
  sameList(b.tabs, [], "a tab lists no tabs of its own");
  const d = await u.newTab({ name: "e-tab3" });
  const e4 = await u.newTab();
  assert.equal(e4.name, "e-tab4", "a default name skips one already given");
  await assert.rejects(u.newTab({ name: "e" }), /already names this user or one of its tabs/);
  await assert.rejects(u.newTab({ name: "third" }), /already names this user or one of its tabs/);
  await assert.rejects(u.newTab({ name: "" }), TypeError);
  await assert.rejects(u.newTab({ name: 5 }), TypeError);
  const [p, q] = await Promise.all([u.newTab(), u.newTab()]);
  assert.notEqual(p.name, q.name, "tabs asked for at once get distinct names");
  assert.deepEqual(u.tabs.map((t) => t.name), ["e-tab2", "third", "e-tab3", "e-tab4", p.name, q.name]);
  for (const t of [c, d, e4, p, q]) await t.close();
  assert.equal(b.page.isClosed(), false);
});

test("responses: each User finds and waits on its own page's only (a tab, its page; the user, every page no tab claims), on one sequence; every page's is in the context's array", async () => {
  const pool = newPool();
  const u = await pool.user({ name: "e" });
  await onApp(u.page);
  const b = await u.newTab();
  await onApp(b.page);
  const loose = await onApp(await u.context.newPage()); // a page no tab claims (a popup, say): the user's
  const mark = u.responseMark();
  assert.equal(b.responseMark(), mark);
  assert.equal(await post(u.page, "u"), 200);
  assert.equal(await post(b.page, "b"), 200);
  assert.equal(await post(loose, "loose"), 200);
  const ofU = u.findResponses({ path: "/draft" }, { since: mark });
  const ofB = b.findResponses({ path: "/draft" }, { since: mark });
  assert.deepEqual(await Promise.all(ofU.map(whoOf)), ["u", "loose"], "the user: its own page and the unclaimed one, never the tab's");
  assert.deepEqual(await Promise.all(ofB.map(whoOf)), ["b"], "the tab: its own page's only");
  assert.equal(u.responses.filter((r) => r.seq >= mark && r.path === "/draft").length, 3, "the context's array holds every page's (stall evidence reads it)");
  const first = await b.waitForResponse({ path: "/draft" }, { since: mark, timeout: 5_000 });
  assert.equal(await whoOf(first), "b", "the tab's wait never takes the user's earlier response");
  same(first.page, b.page, "an entry names its page");
  assert.ok(!Object.keys(first).includes("page"), "non-enumerably");
  assert.equal(b.responseMark(), u.responseMark());
  await assert.rejects(b.waitForResponse((r) => r.path === "/draft" && r.seq !== first.seq, { since: mark, timeout: 300 }), /no matching response within 300 ms/);

  await b.close();
  assert.deepEqual([b.closed, b.page.isClosed(), u.closed, u.page.isClosed()], [true, true, false, false], "a tab's close() closes its page alone");
  sameList(u.tabs, [b], "a closed tab stays a tab");
  assert.equal(u.ownsPage(b.page), false, "and its page stays its own, never the user's");
  assert.equal(u.ownsPage(null), true, "a request with no page is the user's");
  assert.equal(b.ownsPage(null), false);
  const m2 = u.responseMark();
  assert.equal(await post(u.page, "u2"), 200);
  assert.deepEqual(await Promise.all(u.findResponses({ path: "/draft" }, { since: m2 }).map(whoOf)), ["u2"]);
});

test("capture: each User's rows are its own page's (with a non-enumerable page); a user with no tab still captures every page of its context", async () => {
  const pool = newPool();
  const u = await pool.user({ name: "e" });
  await onApp(u.page);
  const b = await u.newTab();
  await onApp(b.page);
  const loose = await onApp(await u.context.newPage());
  const uRows = u.capture({ paths: ["/draft"] });
  const bRows = b.capture({ paths: ["/draft"] });
  await post(b.page, "b");
  await post(u.page, "u");
  await post(loose, "loose");
  await uRows.waitFor({ path: "/draft" }, { timeout: 5_000 });
  await sleep(200);
  assert.deepEqual(uRows.map((r) => r.postJson.who), ["u", "loose"]);
  assert.deepEqual(bRows.map((r) => r.postJson.who), ["b"]);
  assert.deepEqual([bRows[0].page === b.page, uRows[0].page === u.page, uRows[1].page === loose], [true, true, true]);
  assert.ok(!Object.keys(bRows[0]).includes("page"));
  JSON.stringify(bRows);
  uRows.stop();
  bRows.stop();

  const solo = await pool.user({ name: "solo" });
  await onApp(solo.page);
  const second = await onApp(await solo.context.newPage());
  const rows = solo.capture({ paths: ["/draft"] });
  await post(second, "second");
  await rows.waitFor({ path: "/draft" }, { timeout: 5_000 });
  assert.deepEqual(rows.map((r) => r.postJson.who), ["second"], "no tab: a second page of the context is the user's, as before");
  assert.equal(solo.ownsPage(second), true);
  rows.stop();
});

test("toasts: each User's waits see its own page's toasts only, while log.toasts holds all, each naming its page non-enumerably", async () => {
  const pool = newPool();
  const u = await pool.user({ name: "e" });
  await onApp(u.page);
  const b = await u.newTab();
  await onApp(b.page);
  const mark = u.toastMark();
  assert.equal(b.toastMark(), mark);
  await toast(u.page, "error", "from u");
  await toastLogged(u, "from u");
  await toast(b.page, "error", "from b");
  const fromB = await toastLogged(u, "from b");
  assert.deepEqual(u.log.toasts.slice(mark).map((t) => t.text), ["from u", "from b"], "the context's log has both");
  assert.deepEqual(u.toastsSince(mark).map((t) => t.text), ["from u"]);
  assert.deepEqual(b.toastsSince(mark).map((t) => t.text), ["from b"]);
  const hit = await b.waitForToast((t) => t.kind === "error", { since: mark, timeout: 5_000 });
  assert.equal(hit.text, "from b", "the tab's wait never takes the user's earlier toast");
  await assert.rejects(u.waitForToast("from b", { since: mark, timeout: 300 }), /no matching toast within 300 ms \(seen: error: from u\)/);
  same(fromB.page, b.page, "a toast names its page");
  assert.ok(!Object.keys(fromB).includes("page"));
  assert.doesNotMatch(JSON.stringify({ kind: "toast", ...fromB }), /page/, "evidence serialises a toast without its page");
});

test("delayRequests and failRequests: the route is the context's, yet it takes only its own User's requests", async () => {
  const pool = newPool();
  const u = await pool.user({ name: "e" });
  await onApp(u.page);
  const b = await u.newTab();
  await onApp(b.page);
  const held = await b.delayRequests("/draft", { rules: [1_500] });
  try {
    let t0 = Date.now();
    assert.equal(await post(u.page, "u"), 200);
    assert.ok(Date.now() - t0 < 1_000, `the user's POST went at once (${Date.now() - t0} ms)`);
    assert.equal(held.seen(), 0, "the tab's delay took nothing of the user's");
    t0 = Date.now();
    assert.equal(await post(b.page, "b"), 200);
    assert.ok(Date.now() - t0 >= 1_400, `the tab's POST was held (${Date.now() - t0} ms)`);
    assert.equal(held.seen(), 1);
  } finally {
    await held.restore();
  }
  const fail = await u.failRequests("/draft", { status: 503 });
  try {
    assert.equal(await post(b.page, "b"), 200, "the user's failure took nothing of the tab's");
    assert.equal(await post(u.page, "u"), 503);
    assert.equal(fail.failed.length, 1);
  } finally {
    await fail.restore();
  }
});

test("memory and closing: newTab asks the pool's gate for one context, its refusal leaves no tab; the user's close() closes every tab, and a closed user opens none", async () => {
  const pool = newPool();
  const u = await pool.user({ name: "e" });
  await onApp(u.page);
  const real = pool.admitContexts.bind(pool);
  const asked = [];
  pool.admitContexts = async (n) => {
    asked.push(n);
    return real(n);
  };
  const b = await u.newTab();
  assert.deepEqual(asked, [1], "one context's room, as user() asks");
  const pagesBefore = u.context.pages().length;
  pool.admitContexts = async () => {
    const err = new Error("INCONCLUSIVE: no room");
    err.code = "E2E_INCONCLUSIVE";
    throw err;
  };
  await assert.rejects(u.newTab({ name: "starved" }), (err) => err.code === "E2E_INCONCLUSIVE");
  sameList(u.tabs, [b], "no tab left behind");
  assert.equal(u.context.pages().length, pagesBefore, "and no page made");
  pool.admitContexts = real;
  const again = await u.newTab({ name: "starved" });
  assert.equal(again.name, "starved", "the refused name is free again");
  await u.close();
  assert.deepEqual([u.closed, b.closed, again.closed, b.page.isClosed(), again.page.isClosed()], [true, true, true, true, true]);
  await assert.rejects(u.newTab(), /this user is closed/);
  await assert.rejects(b.newTab(), /this user is closed/);
});
