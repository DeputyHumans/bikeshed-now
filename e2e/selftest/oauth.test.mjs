// SPDX-License-Identifier: Apache-2.0
// Self-test: PKCE, the loopback receiver, the authorize URL, and the consent driver against a late-arming page (SPEC §23).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ARM_DELAY_MS, authorizeParams, authorizeUrl, consent, pkce, startReceiver } from "../lib/oauth.mjs";

test("pkce: the RFC 7636 appendix B vector, and fresh pairs are well formed", () => {
  const rfc = pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(rfc.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const p = pkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(p.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.method, "S256");
  assert.throws(() => pkce("short"));
});

test("authorizeUrl carries exactly the parameters a client sends", () => {
  const params = authorizeParams({ clientId: "bsdcr_x", redirectUri: "http://127.0.0.1:39727/callback", challenge: "c".repeat(43), state: "s1", resource: "http://127.0.0.1:39719/mcp" });
  const u = new URL(authorizeUrl({ origin: "http://127.0.0.1:39719" }, params));
  assert.equal(u.pathname, "/connect");
  assert.deepEqual(Object.fromEntries(u.searchParams), { response_type: "code", client_id: "bsdcr_x", redirect_uri: "http://127.0.0.1:39727/callback", code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s1", resource: "http://127.0.0.1:39719/mcp" });
});

test("startReceiver: resolves with the redirect's query; other paths are 404; a local target claims from its spare pool (spare.test.mjs)", async () => {
  const r = await startReceiver({ port: 0 });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${r.port}/favicon.ico`)).status, 404);
    const res = await fetch(`${r.redirectUri}?code=abc&state=s1&iss=http%3A%2F%2F127.0.0.1%3A1`);
    assert.equal(res.status, 200);
    const got = await r.wait(2000);
    assert.deepEqual([got.code, got.state, got.iss, got.error], ["abc", "s1", "http://127.0.0.1:1", null]);
  } finally {
    await r.close();
  }
  const idle = await startReceiver({ port: 0 });
  await assert.rejects(idle.wait(50), (e) => e.code === "E2E_OAUTH_TIMEOUT");
  await idle.close();
  // A local target's receiver is claimed from the pool, which lives in the
  // run directory: without one it is refused rather than guessed.
  await assert.rejects(startReceiver({ target: { kind: "local", stack: { ports: { spare: 0 } } } }), /runDir/);
});

/**
 * A page that arms like Connect.tsx: listeners attach `attachDelayMs` after
 * the button is visible (the effect runs a turn after the render); from then,
 * Approve enables once the page has been focused for ARM_DELAY_MS AND a pointer
 * move has been seen. A move before the listeners exist is lost.
 */
function armingPage({ attachDelayMs = 300 } = {}) {
  const t0 = Date.now();
  let touched = false;
  let clicked = null;
  const listening = () => Date.now() - t0 >= attachDelayMs;
  const enabled = () => touched && Date.now() - t0 >= attachDelayMs + ARM_DELAY_MS;
  const button = (name) => ({
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    isEnabled: async () => (name === "Approve" ? enabled() : true),
    boundingBox: async () => ({ x: 400, y: 300, width: 90, height: 36 }),
    click: async () => {
      if (name === "Approve" && !enabled()) throw new Error("clicked Approve while it was disabled");
      clicked = name;
    },
  });
  return {
    getByRole: (role, { name }) => button(name),
    bringToFront: async () => {},
    mouse: {
      move: async (x, y) => {
        if (x >= 400 && x <= 490 && y >= 300 && y <= 336) throw new Error("the pointer must never cross Approve");
        if (listening()) touched = true;
      },
    },
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    get clicked() {
      return clicked;
    },
  };
}

/** What the CI-failing tests did: look, move once, then wait. */
async function naiveConsent(page, { timeoutMs = 2500 } = {}) {
  const approve = page.getByRole("button", { name: "Approve" });
  await approve.waitFor();
  await page.mouse.move(10, 10);
  const started = Date.now();
  while (!(await approve.isEnabled())) {
    if (Date.now() - started > timeoutMs) throw new Error("never armed");
    await page.waitForTimeout(100);
  }
  await approve.click();
}

test("the fake page models the race: a single early move never arms it (control for the driver below)", async () => {
  const page = armingPage({ attachDelayMs: 300 });
  await assert.rejects(naiveConsent(page), /never armed/);
  assert.equal(page.clicked, null);
});

test("consent(): keeps moving until Approve arms, then clicks it, never before the second", async () => {
  const page = armingPage({ attachDelayMs: 300 });
  const out = await consent(page, { approve: true, timeoutMs: 5000, stepMs: 50 });
  assert.equal(page.clicked, "Approve");
  assert.equal(out.clicked, "approve");
  assert.ok(out.armedAfterMs >= 300 + ARM_DELAY_MS - 20, `armed after ${out.armedAfterMs} ms`);
  assert.ok(out.moves >= 2, `${out.moves} moves`);
});

test("consent(): approve:false clicks Cancel at once; a page that never arms fails with E2E_CONSENT", async () => {
  const page = armingPage();
  assert.equal((await consent(page, { approve: false })).clicked, "cancel");
  assert.equal(page.clicked, "Cancel");
  const never = armingPage({ attachDelayMs: 60_000 });
  await assert.rejects(consent(never, { timeoutMs: 400, stepMs: 50 }), (e) => e.code === "E2E_CONSENT");
  assert.equal(never.clicked, null);
});
