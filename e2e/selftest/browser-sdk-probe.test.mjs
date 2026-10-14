// SPDX-License-Identifier: Apache-2.0
// Self-test: the Firestore SDK's own network test is blocked but is no isolation breach, exactly that request and nothing near it, and scenario() notes it as an environment signal (SPEC §12).

/**
 * The SDK's WebChannel sends `GET https://www.google.com/images/cleardot.gif?zx=<random>`
 * by itself after its Listen channel errors (seen on a loaded shared stack:
 * A11.11 and A11.12 failed as "isolation breach" though every oracle held).
 * The first test is the classifier alone; the second has a page send it, as
 * the SDK does (`new Image()`), with near misses beside it; the last runs a
 * generated fixture spec through `node --test` with the real reporter, as
 * run.mjs does, and reads its results, findings and evidence. Every request
 * to a Google host is aborted by the tripwire before it is sent: nothing here
 * leaves the machine. A local server stands in for the app. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserPool, SDK_PROBE, classifyUrl, isSdkProbe } from "../lib/browser.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";

/** As the SDK builds it (zx: two base-36 numbers run together); these two were seen on a stack. */
const PROBE = "https://www.google.com/images/cleardot.gif?zx=ggcywhd9fkik";
const PROBE2 = "https://www.google.com/images/cleardot.gif?zx=9krd2xcji07d";

const runId = `selftest-sdkprobe-${process.pid}`;
let server;
let target;
let runDir;
let tmp;

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-sdkprobe-"));
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><body>app</body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = Object.freeze({ kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: new Set(["local"]), stack: { ports: { hosting: port } } });
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(runDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test("isSdkProbe and classifyUrl: exactly the SDK's network test is `sdk-probe` on a local target; every near miss is still a breach", () => {
  const t = { kind: "local", runId: "r", stack: { ports: { hosting: 36650 } } };
  assert.deepEqual(SDK_PROBE, { protocol: "https:", host: "www.google.com", path: "/images/cleardot.gif", param: "zx" });
  for (const url of [PROBE, PROBE2, "https://WWW.Google.com/images/cleardot.gif?zx=ab", "https://www.google.com:443/images/cleardot.gif?zx=0a1b2c3d4e5f"]) {
    assert.equal(isSdkProbe(url), true, url);
    assert.equal(classifyUrl(url, t).verdict, "sdk-probe", url);
    assert.equal(classifyUrl(url, t, { method: "GET" }).verdict, "sdk-probe", url);
  }
  const breaches = [
    ["http://www.google.com/images/cleardot.gif?zx=ab12", "plain http"],
    ["https://www.google.com:8443/images/cleardot.gif?zx=ab12", "another port"],
    ["https://google.com/images/cleardot.gif?zx=ab12", "the bare domain"],
    ["https://www.google.com./images/cleardot.gif?zx=ab12", "a trailing dot"],
    ["https://u:p@www.google.com/images/cleardot.gif?zx=ab12", "credentials"],
    ["https://www.google.com/images/cleardot.gif", "no query"],
    ["https://www.google.com/images/cleardot.gif?zx=", "an empty zx"],
    ["https://www.google.com/images/cleardot.gif?zx=a", "a zx too short"],
    ["https://www.google.com/images/cleardot.gif?zx=abcdefghijklm", "a zx too long"],
    ["https://www.google.com/images/cleardot.gif?zx=AB12", "upper case"],
    ["https://www.google.com/images/cleardot.gif?zx=ab%2012", "an encoded space"],
    ["https://www.google.com/images/cleardot.gif?zx=ab12&zx=cd34", "zx twice"],
    ["https://www.google.com/images/cleardot.gif?zx=ab12&x=1", "another parameter"],
    ["https://www.google.com/images/cleardot.gif?x=1&zx=ab12", "another parameter first"],
    ["https://www.google.com/images/cleardot.gif?zx=ab12&", "a trailing separator"],
    ["https://www.google.com/images/cleardot.gif?zx=ab12#f", "a fragment"],
    ["https://www.google.com/images/cleardot.png?zx=ab12", "another file"],
    ["https://www.google.com/images/cleardot.gif/x?zx=ab12", "a longer path"],
    ["https://www.google.com/x/images/cleardot.gif?zx=ab12", "a deeper path"],
    ["https://www.google.com/search?zx=ab12", "another page"],
    ["wss://www.google.com/images/cleardot.gif?zx=ab12", "a websocket"],
  ];
  for (const [url, why] of breaches) {
    assert.equal(isSdkProbe(url), false, `NEGATIVE (${why}): ${url}`);
    assert.equal(classifyUrl(url, t).verdict, "breach", `NEGATIVE (${why}): ${url}`);
  }
  for (const method of ["POST", "HEAD", "PUT", "OPTIONS"]) {
    assert.equal(isSdkProbe(PROBE, { method }), false, `NEGATIVE: ${method}`);
    assert.equal(classifyUrl(PROBE, t, { method }).verdict, "breach", `NEGATIVE: ${method}`);
  }
  assert.equal(classifyUrl("https://www.googleapis.com/images/cleardot.gif?zx=ab12", t).verdict, "breach", "NEGATIVE: the same path on another Google host");
  assert.equal(classifyUrl("https://example.com/images/cleardot.gif?zx=ab12", t).verdict, "external", "the same path elsewhere is what any other host is");
  assert.equal(classifyUrl("http://127.0.0.1:36650/images/cleardot.gif?zx=ab12", t).verdict, "allow", "and on a stack port it is the stack's");
  assert.equal(isSdkProbe("not a url"), false);
});

/** Have the page fetch `url` as the SDK does (an image), and say how it ended. */
async function sendImage(u, url) {
  return u.page.evaluate((src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve("loaded");
    img.onerror = () => resolve("blocked");
    img.src = src;
  }), url);
}

test("in a browser: the probe is aborted and kept in log.sdkProbes, never in breaches; a near miss, or the same URL by POST, is a breach", async () => {
  const pool = new BrowserPool({ target });
  try {
    const [a, b] = await pool.many(2);
    await a.goto("/");
    assert.equal(await sendImage(a, PROBE), "blocked", "aborted like any other request off the stack");
    assert.deepEqual(a.log.sdkProbes.map((p) => [p.user, p.method, p.url, p.resourceType]), [[a.name, "GET", PROBE, "image"]]);
    assert.match(a.log.sdkProbes[0].reason, /network test/);
    assert.deepEqual([a.log.breaches, a.log.external, pool.breaches()], [[], [], []]);
    assert.deepEqual(pool.sdkProbes().map((p) => p.url), [PROBE]);
    pool.assertIsolation(); // does not throw

    await b.goto("/");
    assert.equal(await sendImage(b, `${PROBE}&x=1`), "blocked");
    const posted = await b.page.evaluate((u) => fetch(u, { method: "POST", mode: "no-cors" }).then(() => "reached", () => "blocked"), PROBE);
    assert.equal(posted, "blocked");
    assert.deepEqual(b.log.breaches.map((x) => [x.method, x.url]), [["GET", `${PROBE}&x=1`], ["POST", PROBE]], "NEGATIVE: near misses are breaches");
    assert.deepEqual(b.log.sdkProbes, []);
    assert.throws(() => pool.assertIsolation(), (e) => e.code === "E2E_ISOLATION_BREACH" && /2 request\(s\)/.test(e.message));
  } finally {
    await pool.close();
  }
});

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;

const FIXTURE = `import assert from "node:assert/strict";
import { scenario } from ${JSON.stringify(lib("test.mjs"))};
const PROBE = ${JSON.stringify(PROBE)};
const send = (u, src) => u.page.evaluate((s) => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("loaded"); i.onerror = () => resolve("blocked"); i.src = s; }), src);
scenario("a probe only", {}, async (ctx) => {
  const u = await ctx.users.user({ name: "prober" });
  await u.goto("/");
  assert.equal(await send(u, PROBE), "blocked");
  assert.equal(u.log.sdkProbes.length, 1);
});
scenario("a near miss", {}, async (ctx) => {
  const u = await ctx.users.user({ name: "nearmiss" });
  await u.goto("/");
  await send(u, PROBE + "&x=1");
});
scenario("a probe, then the body fails", {}, async (ctx) => {
  const u = await ctx.users.user({ name: "prober2" });
  await u.goto("/");
  await send(u, PROBE);
  await send(u, PROBE);
  throw new Error("boom");
});
scenario("no browser at all", {}, async () => {});
`;

function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runAsync(cmd, args, { env, cwd, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("scenario(): a probe passes the case and is noted (a step, sdk-probes.json, the console log, one findings row); a near miss still FAILS it as a breach", async () => {
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify({ ...target, capabilities: ["local"] }));
  const spec = join(tmp, "probe.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const resultsFile = join(inv.dir, "results-functional.jsonl");
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile, reporter: join(E2E_DIR, "lib", "reporter.mjs"), concurrency: 1 }), {
    cwd: REPO_ROOT,
    timeout: 120_000,
    env: { ...childEnv(), E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir },
  });
  assert.equal(proc.status, 1, `the fixture run fails (two cases fail on purpose) and does not hang: ${proc.stdout.slice(-800)}${proc.stderr.slice(-400)}`);
  const results = Object.fromEntries(readFileSync(resultsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.name, r]));
  assert.equal(results["a probe only"]?.status, "pass", "the SDK's network test is no breach");
  assert.equal(results["a near miss"]?.status, "fail", "NEGATIVE: a near miss fails the case");
  assert.equal(results["a near miss"].error.code, "E2E_ISOLATION_BREACH");
  assert.equal(results["a probe, then the body fails"]?.status, "fail");
  assert.equal(results["a probe, then the body fails"].error.message, "boom", "the body's own error, not a breach");
  assert.equal(results["no browser at all"]?.status, "pass");

  const findings = existsSync(join(runDir, "findings.jsonl")) ? readFileSync(join(runDir, "findings.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const probes = findings.filter((f) => f.kind === "sdk-probe");
  assert.deepEqual(probes.map((f) => [f.case, f.class, f.count, f.users]).sort(), [["a probe only", "E", 1, ["prober"]], ["a probe, then the body fails", "E", 2, ["prober2"]]], "one environment finding per case that saw the probe, none for the near miss");
  assert.ok(probes.every((f) => f.runId === runId && !Number.isNaN(Date.parse(f.first))));

  const evDir = join(inv.dir, "evidence");
  const dirs = readdirSync(evDir);
  const failed = dirs.find((d) => d.startsWith("a-probe-then-the-body-fails"));
  assert.ok(failed, `evidence for the failing probe case among ${dirs.join(", ")}`);
  const saved = JSON.parse(readFileSync(join(evDir, failed, "sdk-probes.json"), "utf8"));
  assert.deepEqual(saved.map((p) => [p.user, p.method, p.url]), [["prober2", "GET", PROBE], ["prober2", "GET", PROBE]]);
  assert.match(readFileSync(join(evDir, failed, "steps.md"), "utf8"), /environment: 2 Firestore SDK network test\(s\) from prober2, sent after its Listen channel errored \(a slow stack\): blocked, not an isolation breach/);
  const consoleRows = readFileSync(join(evDir, failed, "console-prober2.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(consoleRows.filter((r) => r.kind === "sdk-probe").length, 2, "the user's console log carries them, kind sdk-probe");
  assert.equal(consoleRows.filter((r) => r.kind === "isolation-breach").length, 0);
  const miss = dirs.find((d) => d.startsWith("a-near-miss"));
  assert.ok(miss && existsSync(join(evDir, miss, "isolation-breaches.json")), "the near miss keeps its breach evidence");
  assert.ok(!existsSync(join(evDir, miss, "sdk-probes.json")));
  assert.ok(!dirs.some((d) => d.startsWith("a-probe-only")), "a passing case writes no evidence (unless E2E_EVIDENCE=always)");
});
