// SPDX-License-Identifier: Apache-2.0
// Self-test: User.fulfilAnalytics answers every analytics request here and counts it, the SDK's web config names the measurement id, and nothing near those requests is taken from the tripwire (SPEC §12, §15).

/**
 * A local server stands in for the app; the page sends what the analytics
 * SDK sends (@firebase/analytics 0.10: the web config GET with its
 * x-goog-api-key header, so a CORS preflight; Firebase Installations' create
 * and token POSTs; the gtag script tag; a collection beacon). Every request
 * to a Google host is fulfilled by the route or aborted by the tripwire
 * before it is sent: nothing here leaves the machine. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { ANALYTICS_HOSTS, ANALYTICS_SCRIPT_STUB, BrowserPool, analyticsRequest, classifyUrl } from "../lib/browser.mjs";
import { OUT_DIR } from "../lib/paths.mjs";
import { dummyMeasurementId, isMeasurementIdShape } from "../lib/options.mjs";

const runId = `selftest-analytics-${process.pid}`;
const APP_ID = "1:000000000000:web:e2eselftest00";
const WEB_CONFIG = `https://firebase.googleapis.com/v1alpha/projects/-/apps/${encodeURIComponent(APP_ID)}/webConfig`;
const INSTALLATIONS = "https://firebaseinstallations.googleapis.com/v1/projects/demo-bikeshed/installations";
let server;
let runDir;
let port;

const targetWith = (appEnv = {}) => Object.freeze({
  kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed",
  capabilities: new Set(["local"]), options: { emailOff: false, appEnv }, stack: { ports: { hosting: port } },
});

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><body>app</body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(runDir, { recursive: true, force: true });
});

test("analyticsRequest: exactly the SDK's requests, by kind; a near miss at the two Google API hosts is null, so the tripwire judges it", () => {
  assert.deepEqual(ANALYTICS_HOSTS, ["googletagmanager.com", "google-analytics.com", "analytics.google.com", "doubleclick.net"]);
  const id = dummyMeasurementId();
  const hits = [
    [`https://www.googletagmanager.com/gtag/js?l=dataLayer&id=${id}`, "GET", { kind: "gtag" }],
    ["https://googletagmanager.com/gtm.js", "GET", { kind: "gtag" }],
    [`https://region1.google-analytics.com/g/collect?v=2&tid=${id}`, "POST", { kind: "collect" }],
    ["https://www.google-analytics.com/g/collect", "GET", { kind: "collect" }],
    ["https://analytics.google.com/g/collect", "POST", { kind: "collect" }],
    ["https://stats.g.doubleclick.net/g/collect", "POST", { kind: "collect" }],
    ["http://www.google-analytics.com/collect", "GET", { kind: "collect" }],
    [WEB_CONFIG, "GET", { kind: "web-config", appId: APP_ID }],
    [INSTALLATIONS, "POST", { kind: "installations", projectId: "demo-bikeshed", fid: null, op: "create" }],
    [`${INSTALLATIONS}/fIdAbc_123/authTokens:generate`, "POST", { kind: "installations", projectId: "demo-bikeshed", fid: "fIdAbc_123", op: "token" }],
    [`${INSTALLATIONS}/fIdAbc_123`, "DELETE", { kind: "installations", projectId: "demo-bikeshed", fid: "fIdAbc_123", op: "delete" }],
    [INSTALLATIONS, "GET", { kind: "installations", projectId: "demo-bikeshed", fid: null, op: null }],
  ];
  for (const [url, method, want] of hits) assert.deepEqual(analyticsRequest(url, { method }), want, `${method} ${url}`);
  const misses = [
    [WEB_CONFIG, "POST", "the web config by POST"],
    [`${WEB_CONFIG}/more`, "GET", "a longer web config path"],
    [WEB_CONFIG.replace("/v1alpha/", "/v1/"), "GET", "another API version"],
    [WEB_CONFIG.replace("https://", "http://"), "GET", "the web config over http"],
    [WEB_CONFIG.replace("googleapis.com/", "googleapis.com:8443/"), "GET", "another port"],
    ["https://firebase.googleapis.com/v1alpha/projects/demo-bikeshed/apps/x/webConfig", "GET", "a named project"],
    [INSTALLATIONS.replace("/v1/", "/v2/"), "POST", "installations v2"],
    [`${INSTALLATIONS}/a/b/c`, "POST", "a deeper installations path"],
    ["https://firebaseinstallations.googleapis.com/", "GET", "the installations root"],
    ["https://www.googleapis.com/v1alpha/projects/-/apps/x/webConfig", "GET", "the same path on another Google host"],
    ["https://u:p@www.googletagmanager.com/gtag/js", "GET", "credentials in the URL"],
    ["wss://www.google-analytics.com/g/collect", "GET", "a websocket"],
    ["https://www.google.com/images/cleardot.gif?zx=ab12", "GET", "the Firestore SDK's probe"],
    ["https://evilgoogletagmanager.com/gtag/js", "GET", "a look-alike host"],
    ["not a url", "GET", "not a URL"],
  ];
  for (const [url, method, why] of misses) assert.equal(analyticsRequest(url, { method }), null, `NEGATIVE (${why}): ${method} ${url}`);
  // The tripwire's own verdicts are unchanged: on a local target each of these is still a breach without the route.
  const t = { kind: "local", runId: "r", stack: { ports: { hosting: 36650 } } };
  for (const [url] of hits.filter(([u]) => u.startsWith("https://"))) assert.equal(classifyUrl(url, t).verdict, "breach", url);
});

/** In the page: what the SDK sends, in its order, and how each ended. */
function sdkTraffic({ webConfig, installations, apiKey, beacon }) {
  const out = {};
  const json = (r) => r.json().then((j) => ({ status: r.status, json: j }), () => ({ status: r.status, json: null }));
  const fail = (e) => ({ error: String(e && e.message) });
  return (async () => {
    out.webConfig = await fetch(webConfig, { method: "GET", headers: { Accept: "application/json", "x-goog-api-key": apiKey } }).then(json, fail);
    out.create = await fetch(installations, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ fid: "cAbCdEfGhIjKlMnOpQrStU", authVersion: "FIS_v2", appId: "x", sdkVersion: "w:0.6" }),
    }).then(json, fail);
    out.token = await fetch(`${installations}/cAbCdEfGhIjKlMnOpQrStU/authTokens:generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "FIS_v2 e2e-fulfilled-locally" },
      body: JSON.stringify({ installation: { sdkVersion: "w:0.6", appId: "x" } }),
    }).then(json, fail);
    const id = out.webConfig.json && out.webConfig.json.measurementId;
    out.script = await new Promise((resolve) => {
      const s = document.createElement("script");
      s.async = true;
      s.src = `https://www.googletagmanager.com/gtag/js?l=dataLayer&id=${id}`;
      s.onload = () => resolve("loaded");
      s.onerror = () => resolve("blocked");
      document.head.appendChild(s);
    });
    out.collect = await fetch(beacon, { method: "POST", mode: "no-cors", body: "en=page_view" }).then((r) => ({ type: r.type }), fail);
    return out;
  })();
}

test("in a browser: every analytics request is answered here and counted, in order; the web config names the measurement id; nothing is a breach", async () => {
  const pool = new BrowserPool({ target: targetWith() });
  try {
    const u = await pool.user({ name: "allower" });
    const seen = await u.fulfilAnalytics();
    assert.ok(isMeasurementIdShape(seen.measurementId), "a measurement-id-shaped dummy, since the stack has none");
    assert.deepEqual(Object.keys(seen), [], "the id is not an enumerable row");
    assert.equal(await u.fulfilAnalytics(), seen, "a second call is the same array");
    await assert.rejects(u.fulfilAnalytics({ measurementId: dummyMeasurementId() }), /another measurement id/);
    await u.goto("/");
    const beacon = `https://region1.google-analytics.com/g/collect?v=2&tid=${seen.measurementId}`;
    const out = await u.page.evaluate(sdkTraffic, { webConfig: WEB_CONFIG, installations: INSTALLATIONS, apiKey: "demo-api-key", beacon });
    assert.deepEqual(out.webConfig, { status: 200, json: { appId: APP_ID, measurementId: seen.measurementId } }, "the page reads the web config across origins");
    assert.deepEqual(out.create, {
      status: 200,
      json: { name: "projects/demo-bikeshed/installations/cAbCdEfGhIjKlMnOpQrStU", fid: "cAbCdEfGhIjKlMnOpQrStU", refreshToken: "e2e-fulfilled-locally", authToken: { token: "e2e-fulfilled-locally", expiresIn: "604800s" } },
    });
    assert.deepEqual(out.token, { status: 200, json: { token: "e2e-fulfilled-locally", expiresIn: "604800s" } });
    assert.equal(out.script, "loaded", "the measurement script loads (the stub)");
    assert.deepEqual(out.collect, { type: "opaque" }, "the beacon is answered");
    assert.deepEqual(
      seen.map((r) => [r.user, r.kind, r.method, r.host, r.status, r.id]),
      [
        ["allower", "web-config", "GET", "firebase.googleapis.com", 200, null],
        ["allower", "installations", "POST", "firebaseinstallations.googleapis.com", 200, null],
        ["allower", "installations", "POST", "firebaseinstallations.googleapis.com", 200, null],
        ["allower", "gtag", "GET", "www.googletagmanager.com", 200, seen.measurementId],
        ["allower", "collect", "POST", "region1.google-analytics.com", 204, seen.measurementId],
      ],
      "one row per request, the preflight none (Playwright answers it)",
    );
    assert.equal(seen[3].path, "/gtag/js");
    const script = await u.page.evaluate(async (src) => (await fetch(src)).text(), `https://www.googletagmanager.com/gtag/js?id=${seen.measurementId}`);
    assert.equal(script, ANALYTICS_SCRIPT_STUB, "the script is the stub, which runs nothing");
    assert.deepEqual([u.log.breaches, u.log.external, u.log.sdkProbes], [[], [], []], "nothing reached the tripwire");
    pool.assertIsolation();
  } finally {
    await pool.close();
  }
});

test("NEGATIVE: without fulfilAnalytics the same traffic is aborted as breaches; with it, a near miss at a Google API host still is", async () => {
  const pool = new BrowserPool({ target: targetWith() });
  try {
    const [plain, armed] = await pool.many(2, { names: ["plain", "armed"] });
    await plain.goto("/");
    const beacon = "https://region1.google-analytics.com/g/collect?v=2";
    const out = await plain.page.evaluate(sdkTraffic, { webConfig: WEB_CONFIG, installations: INSTALLATIONS, apiKey: "k", beacon });
    assert.ok(out.webConfig.error && out.create.error && out.token.error && out.collect.error, JSON.stringify(out));
    assert.equal(out.script, "blocked");
    assert.deepEqual(
      plain.log.breaches.map((b) => new URL(b.url).hostname).sort(),
      ["firebase.googleapis.com", "firebaseinstallations.googleapis.com", "firebaseinstallations.googleapis.com", "region1.google-analytics.com", "www.googletagmanager.com"],
      "the tripwire's verdict without the route",
    );

    const seen = await armed.fulfilAnalytics();
    await armed.goto("/");
    const near = await armed.page.evaluate(async (urls) => {
      const r = [];
      for (const [u, method] of urls) r.push(await fetch(u, { method, mode: "no-cors" }).then(() => "reached", () => "blocked"));
      return r;
    }, [[`${WEB_CONFIG}/more`, "GET"], [WEB_CONFIG, "POST"], [INSTALLATIONS.replace("/v1/", "/v2/"), "POST"]]);
    assert.deepEqual(near, ["blocked", "blocked", "blocked"]);
    assert.deepEqual(armed.log.breaches.map((b) => `${b.method} ${b.url}`), [`GET ${WEB_CONFIG}/more`, `POST ${WEB_CONFIG}`, `POST ${INSTALLATIONS.replace("/v1/", "/v2/")}`], "near misses stay the tripwire's");
    assert.deepEqual(seen, [], "and none of them was answered or counted");
    await assert.rejects(plain.fulfilAnalytics({ measurementId: "G-not-an-id" }), /measurement-id-shaped/);
  } finally {
    await pool.close();
  }
});

test("the web config names the stack's own measurement id when it was built with one, or the one given", async () => {
  const own = dummyMeasurementId();
  const pool = new BrowserPool({ target: targetWith({ VITE_FIREBASE_MEASUREMENT_ID: own }) });
  try {
    const [a, b] = await pool.many(2);
    const given = dummyMeasurementId();
    const [sa, sb] = [await a.fulfilAnalytics(), await b.fulfilAnalytics({ measurementId: given })];
    assert.deepEqual([sa.measurementId, sb.measurementId], [own, given]);
    for (const [u, want] of [[a, own], [b, given]]) {
      await u.goto("/");
      const got = await u.page.evaluate((url) => fetch(url, { headers: { "x-goog-api-key": "k" } }).then((r) => r.json()), WEB_CONFIG);
      assert.equal(got.measurementId, want, u.name);
    }
    assert.deepEqual([sa.length, sb.length], [1, 1], "each user counts its own");
  } finally {
    await pool.close();
  }
});
