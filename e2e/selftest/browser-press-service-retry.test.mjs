// SPDX-License-Identifier: Apache-2.0
// Self-test: User.pressRetryingServiceError presses a dialog's button again when a loaded emulator refused its write with a rules "Service call error", dismissing the stacked refusals first, and only then; when every press is refused so, the refusal carries a stackCut (SPEC §6c, §12).

/**
 * Hermetic: a local server stands in for the trust dialog
 * (app/src/components/TrustDialog.tsx closes only when its write succeeds) and
 * the app's toast stack (Toast.tsx's markup: an error toast stays until its
 * Dismiss is pressed). The stack is anchored under the dialog's footer, as
 * the app's is, so three error toasts cover "Run it for me" and two do not.
 * Each press answers 150 ms later: refused the first `service` times with
 * the Firestore emulator's "Service call error. Function: [get], …" (or,
 * with `?refuse=1`, every time with "Missing or insufficient
 * permissions."), else the dialog closes; with `?stuck=1` nothing happens
 * at all. `window.state.presses` counts the presses. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { pageStall, stackDidNotAnswer } from "../lib/test.mjs";

const SERVICE_TOAST = "false for 'update' @ L88, Service call error. Function: [get], Argument: [path_value { segments { simple: \"databases\" } }].";
const LOST_LINE = "@firebase/firestore: Firestore (11.0.0): Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds.";
const DIALOG = "This document wants to run its own code";
const RUN = "Run it for me";

const APP = `<!doctype html><html><head><meta charset="utf-8"><title>stand-in</title><link rel="icon" href="data:,"><style>
body{margin:0;font:14px sans-serif}
#dlg{position:fixed;left:40px;bottom:30px;width:520px;height:200px;border:1px solid #888;background:#fff}
#dlg .footer{position:absolute;left:10px;bottom:30px;height:20px;display:flex;gap:8px}
#dlg button{height:20px;padding:0 6px;font-size:12px}
.toast-stack{position:fixed;left:0;bottom:0;width:640px;display:flex;flex-direction:column-reverse;z-index:10}
.toast{height:25px;box-sizing:border-box;display:flex;align-items:center;gap:8px;background:#eee}
.toast-error{background:#c33;color:#fff}
</style></head><body>
<div id="dlg" role="dialog" aria-label=${JSON.stringify(DIALOG)}>
<p>Run its code in your browser?</p>
<div class="footer"><button type="button" id="keep">Keep it sandboxed</button><button type="button" id="run">${RUN}</button></div>
</div>
<div class="toast-stack"></div>
<script>
  const q = new URLSearchParams(location.search);
  let service = Number(q.get("service") ?? 0);
  window.state = { presses: 0, ran: false };
  // Toast.tsx's markup: the message in a span, then Dismiss, which React removes on its next render.
  window.__toast = (text) => {
    const t = document.createElement("div");
    t.className = "toast toast-error";
    t.setAttribute("role", "alert");
    const span = document.createElement("span");
    span.textContent = text;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = "Dismiss";
    b.onclick = () => setTimeout(() => t.remove(), 80);
    t.append(span, b);
    document.querySelector(".toast-stack").append(t);
  };
  document.getElementById("run").addEventListener("click", () => {
    window.state.presses += 1;
    if (q.get("stuck") === "1") return;
    setTimeout(() => {
      if (q.get("refuse") === "1") return window.__toast("Missing or insufficient permissions.");
      if (service > 0) { service -= 1; return window.__toast(${JSON.stringify(SERVICE_TOAST)}); }
      window.state.ran = true;
      document.getElementById("dlg").remove();
    }, 150);
  });
</script></body></html>`;

let server;
let target;
let pool = null;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-press-service-retry", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

async function reader(search = "") {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name: "reader" });
  await u.goto(`/${search}`);
  await u.page.locator("#run").waitFor({ state: "visible" });
  return u;
}
const runButton = (u) => u.page.getByRole("dialog", { name: DIALOG }).getByRole("button", { name: RUN, exact: true });
const closed = (u) => async () => (await u.page.locator("#dlg").count()) === 0;
const state = (u) => u.page.evaluate(() => window.state);
const showing = (u) => u.page.evaluate(() => document.querySelectorAll(".toast-stack .toast").length);

test("the stand-in is the app's geometry: three stacked error toasts cover the dialog's button, two do not", async () => {
  const u = await reader();
  try {
    const onTop = () => u.page.evaluate(() => {
      const r = document.getElementById("run").getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".toast") ? "toast" : "button";
    });
    await u.page.evaluate(() => { window.__toast("one"); window.__toast("two"); });
    assert.equal(await onTop(), "button");
    await u.page.evaluate(() => window.__toast("three"));
    assert.equal(await onTop(), "toast", "without this, the test below would pass without a dismissal");
  } finally {
    await u.close();
  }
});

test("pressRetryingServiceError: presses refused with a Service call error are made again, each after the refusals are dismissed; it resolves with how many were refused", async () => {
  const u = await reader("?service=3");
  try {
    const mark = u.toastMark();
    const out = await u.pressRetryingServiceError(runButton(u), { retries: 3, backoffMs: 100, done: closed(u), timeout: 5_000, what: RUN });
    assert.deepEqual(out, { serviceErrors: 3 });
    assert.deepEqual(await state(u), { presses: 4, ran: true }, "the fourth press reached the button the three refusals had covered");
    assert.equal(await showing(u), 0, "every refusal was dismissed");
    assert.deepEqual(u.log.toasts.slice(mark).map((t) => t.kind), ["error", "error", "error"], "the refusals were recorded as they came");
  } finally {
    await u.close();
  }
});

test("pressRetryingServiceError: a press that takes effect at once resolves {serviceErrors: 0}; the default back-off is comment's, 3 s", async () => {
  const u = await reader("?service=0");
  try {
    assert.deepEqual(await u.pressRetryingServiceError(runButton(u), { done: closed(u), timeout: 5_000 }), { serviceErrors: 0 });
    assert.deepEqual(await state(u), { presses: 1, ran: true });
  } finally {
    await u.close();
  }
  const v = await reader("?service=1");
  try {
    const t0 = Date.now();
    assert.deepEqual(await v.pressRetryingServiceError("#run", { done: closed(v), timeout: 5_000 }), { serviceErrors: 1 });
    assert.ok(Date.now() - t0 >= 3_000, "the back-off passed before the second press");
  } finally {
    await v.close();
  }
});

test("pressRetryingServiceError: when every press is refused so, the last refusal throws with serviceErrors and a stackCut, which the case's judges read as the stack not answering", async () => {
  const u = await reader("?service=9");
  try {
    const err = await u.pressRetryingServiceError(runButton(u), { retries: 2, backoffMs: 100, done: closed(u), timeout: 5_000, what: RUN }).then(() => null, (e) => e);
    assert.match(err?.message ?? "", /^reader: the press of "Run it for me" was refused: the app said ".*Service call error.*" \(3 press\(es\), each refused with "Service call error"\)$/);
    assert.equal(err.serviceErrors, 3);
    assert.equal(err.stackCut, `reader: the emulator failed a rule's get() ("Service call error") on 3 press(es) of "Run it for me" in a row, so the rules never judged the write`);
    assert.equal(stackDidNotAnswer(err), err.stackCut);
    assert.equal(err.toast?.kind, "error");
    assert.equal((await state(u)).presses, 3);
  } finally {
    await u.close();
  }
});

test("NEGATIVE: any other refusal throws at once, however many retries are allowed, with no stackCut", async () => {
  const u = await reader("?refuse=1");
  try {
    const t0 = Date.now();
    const err = await u.pressRetryingServiceError(runButton(u), { retries: 3, backoffMs: 100, done: closed(u), timeout: 5_000, what: RUN }).then(() => null, (e) => e);
    assert.equal(err?.message, `reader: the press of "Run it for me" was refused: the app said "Missing or insufficient permissions."`);
    assert.deepEqual([err.stackCut, err.serviceErrors, err.toast?.text], [undefined, undefined, "Missing or insufficient permissions."]);
    assert.equal(stackDidNotAnswer(err), null, "the rules' verdict: judged");
    assert.equal(pageStall(err, { usersSoFar: lostPage() }), null, "a refusal is no wait: a page's stall does not excuse it");
    assert.equal((await state(u)).presses, 1);
    assert.ok(Date.now() - t0 < 3_000, "at once");
  } finally {
    await u.close();
  }
});

/** A user, as pageStall reads one, whose Firestore client lost the emulator a second ago. */
const lostPage = () => [{ name: "reader", log: { console: [{ t: Date.now() - 1_000, type: "error", text: LOST_LINE }], sdkProbes: [] }, responses: [] }];

test("pressRetryingServiceError: no effect and no toast within timeout is a wait that ran out, the last throw of done its cause; pageStall reads it", async () => {
  const u = await reader("?stuck=1");
  try {
    const err = await u.pressRetryingServiceError("#run", { done: closed(u), timeout: 800 }).then(() => null, (e) => e);
    assert.equal(err?.message, `reader: the press of "#run" took no effect within 800 ms, and no error toast came`);
    assert.equal(err.stackCut, undefined);
    assert.match(pageStall(err, { usersSoFar: lostPage() }) ?? "", /^a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\)/);
    let checks = 0;
    const thrown = await u.pressRetryingServiceError("#run", { done: async () => { checks += 1; throw new Error("the dialog is still open"); }, timeout: 600, what: RUN }).then(() => null, (e) => e);
    assert.equal(thrown?.message, `reader: the press of "Run it for me" took no effect within 600 ms, and no error toast came (the last check: the dialog is still open)`);
    assert.equal(thrown.cause?.message, "the dialog is still open");
    assert.ok(checks > 1, "a throw of done is \"not yet\": it was read again");
    assert.equal((await state(u)).presses, 2);
  } finally {
    await u.close();
  }
});

test("pressRetryingServiceError: bad arguments throw TypeError before anything is pressed", async () => {
  const u = await reader("?service=0");
  try {
    const done = closed(u);
    const refused = async (p, re) => assert.rejects(p, (e) => e instanceof TypeError && re.test(e.message));
    await refused(u.pressRetryingServiceError("", { done }), /^reader: pressRetryingServiceError: locator is a selector on the page or a Playwright Locator, got ""$/);
    await refused(u.pressRetryingServiceError({}, { done }), /locator is a selector on the page or a Playwright Locator/);
    await refused(u.pressRetryingServiceError("#run", {}), /done is async \(\) => truthy once the press took effect/);
    await refused(u.pressRetryingServiceError("#run", { done, retries: -1 }), /retries is how many more presses a "Service call error" may cost/);
    await refused(u.pressRetryingServiceError("#run", { done, retries: 1.5 }), /retries is how many more presses/);
    await refused(u.pressRetryingServiceError("#run", { done, backoffMs: -1 }), /backoffMs is the ms waited after a refusal/);
    await refused(u.pressRetryingServiceError("#run", { done, timeout: 0 }), /timeout is a positive number of ms/);
    await refused(u.pressRetryingServiceError("#run", { done, what: "" }), /what names the control in messages/);
    assert.equal((await state(u)).presses, 0, "a bad argument presses nothing");
  } finally {
    await u.close();
  }
});
