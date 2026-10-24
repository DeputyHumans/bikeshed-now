// SPDX-License-Identifier: Apache-2.0
// Self-test: --rtdb-proxy and --gates reach every file a stack is built from (ports, functions env, app env, the bundle check, capabilities), and the aux process serves the gates and a latency proxy whose delay shows in a round trip (SPEC §12, §16).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { sparePorts } from "../lib/spare.mjs";
import { E2E_TMP, ensureDir } from "../lib/paths.mjs";
import { materializeTree } from "../lib/tree.mjs";
import { installEgressGuard } from "../lib/egress.mjs";
import { applyPatchSet, patchAppConfig, patchFirebaseJson, writeFunctionsEnv } from "../lib/patch.mjs";
import { AUX_ROLES, verifyBuild, withAuxPorts } from "../lib/stack.mjs";
import { CONTROL_CAPABILITY_PATCHES, capabilitiesFor, parseStackOptionArgs, stackGates, stackOptionArgs, viteEnvFor } from "../lib/options.mjs";
import { listControlSets, readControl } from "../lib/controls.mjs";
import { gateClient, isAmplifySet, readAmplify } from "../lib/gates.mjs";
import { rtdbLatency } from "../lib/proxy.mjs";
import { startAux } from "../lib/stackaux.mjs";
import { rtdbDelayEffect } from "../lib/live.mjs";
import { classifyUrl } from "../lib/browser.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PORTS = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 36000 + i));
const work = tempDir("e2e-aux-");
after(() => rmSync(work, { recursive: true, force: true }));

test("withAuxPorts takes spare8 (gate) and, with the proxy, spare9 (rtdbProxy) out of the spare pool", () => {
  assert.equal(withAuxPorts(PORTS, {}), PORTS, "no option: the block as it was");
  const gated = withAuxPorts(PORTS, { gates: true });
  assert.equal(gated.gate, PORTS.spare8);
  assert.equal(gated.spare8, undefined);
  assert.equal(gated.spare9, PORTS.spare9);
  assert.equal(gated.rtdbProxy, undefined);
  const both = withAuxPorts(PORTS, { gates: true, rtdbProxy: true });
  assert.deepEqual([both.gate, both.rtdbProxy], [PORTS.spare8, PORTS.spare9]);
  assert.deepEqual(withAuxPorts(PORTS, { rtdbProxy: true }), both, "the proxy needs the control port too");
  const pool = sparePorts({ stack: { ports: both } });
  assert.equal(pool.length, 7);
  assert.ok(!pool.includes(both.gate) && !pool.includes(both.rtdbProxy), "no spec can claim an aux port");
  assert.deepEqual(AUX_ROLES, { gate: "spare8", rtdbProxy: "spare9" });
});

test("stack options: --rtdb-proxy, --gates and an amplify set parse, round-trip and imply gates; product mutants are refused", () => {
  assert.deepEqual(parseStackOptionArgs(["--rtdb-proxy", "--gates", "--patches", "amplify-mint-join"]), { emailOff: false, appEnv: {}, rtdbProxy: true, gates: true, patches: ["amplify-mint-join"] });
  assert.deepEqual(parseStackOptionArgs(["--email-off"]), { emailOff: true, appEnv: {} }, "a list without them parses as it always did");
  const parsed = parseStackOptionArgs(["--rtdb-proxy", "--patches", "amplify-mint-join"]);
  assert.deepEqual(parseStackOptionArgs(stackOptionArgs(parsed)), parsed);
  assert.throws(() => parseStackOptionArgs(["--patches", "controls-decor"]), /not a stack option: --patches controls-decor/);
  assert.equal(stackGates({ patchSets: ["amplify-mint-join"] }), true);
  assert.equal(stackGates({ patchSets: ["controls-decor", "amplify"] }), false);
  assert.equal(stackGates({ gates: true }), true);
  const c = readControl("controls-i6-stale-removed");
  assert.deepEqual(c.stack, ["--patches", "amplify-mint-join"], "a control may be built on an amplify set");
});

test("functions env and app env carry the gate URL only on a gated stack; the app dials the proxy port given", () => {
  const tree = join(work, "tree");
  mkdirSync(join(tree, "functions"), { recursive: true });
  writeFileSync(join(tree, "functions", "package.json"), "{}");
  const plain = writeFunctionsEnv(tree, PORTS);
  assert.equal(plain.gateUrl, null);
  assert.doesNotMatch(readFileSync(join(tree, "functions", ".env.local"), "utf8"), /E2E_GATE_URL/);
  const ports = withAuxPorts(PORTS, { gates: true, rtdbProxy: true });
  const gated = writeFunctionsEnv(tree, ports, { gateUrl: `http://127.0.0.1:${ports.gate}` });
  assert.match(readFileSync(join(tree, "functions", ".env.local"), "utf8"), new RegExp(`^E2E_GATE_URL="http://127\\.0\\.0\\.1:${ports.gate}"$`, "m"));
  assert.equal(gated.gateUrl, `http://127.0.0.1:${ports.gate}`);
  assert.throws(() => writeFunctionsEnv(tree, ports, { gateUrl: "http://example.com:80" }), /127\.0\.0\.1/);
  assert.throws(() => writeFunctionsEnv(tree, ports, { gateUrl: "http://127.0.0.1:9000" }), /outside the e2e range|deny list/, "never a default port");
  const example = { VITE_FIREBASE_PROJECT_ID: "demo-bikeshed", VITE_FIREBASE_API_KEY: "demo-api-key" };
  const env = viteEnvFor(example, { databasePort: ports.rtdbProxy, projectId: "demo-bikeshed", origin: "http://127.0.0.1:1", gateUrl: `http://127.0.0.1:${ports.gate}` });
  assert.equal(env.VITE_FIREBASE_DATABASE_URL, `http://127.0.0.1:${ports.rtdbProxy}?ns=demo-bikeshed`);
  assert.equal(env.VITE_E2E_GATE_URL, `http://127.0.0.1:${ports.gate}`);
  assert.equal(viteEnvFor(example, { databasePort: 1, projectId: "demo-bikeshed", origin: "o" }).VITE_E2E_GATE_URL, undefined);
});

test("verifyBuild checks the database port the bundle dials, and a client gate's URL", () => {
  const ports = withAuxPorts(PORTS, { gates: true, rtdbProxy: true });
  const tree = join(work, "build");
  mkdirSync(join(tree, "app", "dist", "assets"), { recursive: true });
  const origin = `http://127.0.0.1:${ports.hosting}`;
  writeFileSync(join(tree, "app", "dist", "llms.txt"), `served at ${origin}\n`);
  writeFileSync(join(tree, "app", "dist", "index.html"), "<!doctype html>");
  const gateUrl = `http://127.0.0.1:${ports.gate}`;
  const bundle = (db, extra = "") => `const p="demo-bikeshed";const d="127.0.0.1:${db}?ns=demo-bikeshed";const e={auth:${ports.auth},firestore:${ports.firestore},database:${db}};${extra}`;
  writeFileSync(join(tree, "app", "dist", "assets", "index.js"), bundle(ports.rtdbProxy, `const g="${gateUrl}";`));
  const ok = verifyBuild(tree, origin, ports, { databasePort: ports.rtdbProxy, gateUrl, gateRequired: true });
  assert.deepEqual([ok.databasePort, ok.gateInBundle], [ports.rtdbProxy, true]);
  assert.throws(() => verifyBuild(tree, origin, ports), /the app bundle (does not contain the stack database URL|dials auth)/, "NEGATIVE: a stack without the proxy refuses a bundle that dials one");
  writeFileSync(join(tree, "app", "dist", "assets", "index.js"), bundle(ports.database, `const g="${gateUrl}";`));
  assert.throws(() => verifyBuild(tree, origin, ports, { databasePort: ports.rtdbProxy }), /does not contain the stack database URL/, "NEGATIVE: a proxied stack refuses a bundle that dials the emulator itself");
  writeFileSync(join(tree, "app", "dist", "assets", "index.js"), `${bundle(ports.database).replace(`"127.0.0.1:${ports.database}?ns`, `"127.0.0.1:${ports.rtdbProxy}?ns`)}`);
  assert.throws(() => verifyBuild(tree, origin, ports, { databasePort: ports.rtdbProxy }), /dials auth \d+, firestore \d+, database \d+; .*\(the RTDB proxy; the emulator is on/, "NEGATIVE: an EMULATOR_PORTS literal still on the emulator");
  writeFileSync(join(tree, "app", "dist", "assets", "index.js"), bundle(ports.rtdbProxy));
  assert.throws(() => verifyBuild(tree, origin, ports, { databasePort: ports.rtdbProxy, gateUrl, gateRequired: true }), /does not contain the gate URL/, "NEGATIVE: a client gate's build without its URL");
  assert.equal(verifyBuild(tree, origin, ports, { databasePort: ports.rtdbProxy, gateUrl }).gateInBundle, false, "recorded when no client gate needs it");
});

test("capabilities: gates and rtdb-proxy only with a live aux record and a bundle that dials the proxy", () => {
  const ports = withAuxPorts(PORTS, { gates: true, rtdbProxy: true });
  const base = { ports, options: { emailOff: false, appEnv: {}, rtdbProxy: true, gates: true }, processes: [{ name: "aux" }], aux: { gates: true, proxy: ports.rtdbProxy }, build: { databasePort: ports.rtdbProxy } };
  const caps = (rec) => [...capabilitiesFor(rec)].filter((c) => c === "gates" || c === "rtdb-proxy").sort();
  assert.deepEqual(caps(base), ["gates", "rtdb-proxy"]);
  assert.deepEqual(caps({ ...base, build: { databasePort: ports.database } }), ["gates"], "NEGATIVE: a bundle that dials the emulator is no proxy");
  assert.deepEqual(caps({ ...base, processes: [] }), [], "NEGATIVE: no aux process, neither");
  assert.deepEqual(caps({ ...base, aux: { gates: false, proxy: null } }), []);
  assert.deepEqual(caps({ ports: PORTS, options: { emailOff: false, appEnv: {} } }), [], "an older record");
});

/** A stand-in for the Database emulator's REST root. */
async function fakeDatabase() {
  const s = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.headers.authorization === "Bearer owner" ? '{"status":true}' : '{"error":"Permission denied"}');
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { port: s.address().port, close: () => new Promise((r) => s.close(r)) };
}

const fakeTarget = (aux, db) => ({
  kind: "local",
  runId: "selftest-aux",
  projectId: "demo-bikeshed",
  databaseURL: `http://127.0.0.1:${db.port}?ns=demo-bikeshed`,
  capabilities: new Set(["rtdb-proxy", "gates"]),
  stack: { ports: { gate: aux.controlPort, rtdbProxy: aux.proxy.port, database: db.port } },
});

test("the aux process's proxy: a delay set at runtime shows in the round trip by about its size, and goes when reset", async () => {
  const db = await fakeDatabase();
  const aux = await startAux({ controlPort: 0, proxy: { listenPort: 0, upstreamPort: db.port }, log: () => {} });
  try {
    const lat = rtdbLatency(fakeTarget(aux, db));
    assert.deepEqual(await lat.get(), { up: 0, down: 0 });
    const up = await rtdbDelayEffect(lat, { up: 300, down: 0 });
    assert.equal(up.ok, true, up.failures.join("; "));
    const down = await rtdbDelayEffect(lat, { up: 0, down: 200 });
    assert.equal(down.ok, true, down.failures.join("; "));
    assert.deepEqual(await lat.get(), { up: 0, down: 0 }, "rtdbDelayEffect sets it back");
    const fast = await lat.roundTrip();
    assert.ok(fast.ms < 150, `after the reset the round trip is ${fast.ms} ms`);
    const direct = await lat.roundTrip({ via: "direct" });
    assert.ok(direct.ms < 150);
    const st = await lat.stats();
    assert.ok(st.stats.connections >= 12, `the proxy carried ${st.stats.connections} connections`);
    // The gate service shares the control port.
    const g = gateClient(`http://127.0.0.1:${aux.controlPort}`);
    await g.hold("x");
    assert.equal((await g.counts()).x.armed, true);
    await g.releaseAll();
    const bad = await fetch(`http://127.0.0.1:${aux.controlPort}/latency`, { method: "POST", body: JSON.stringify({ up: -1 }) });
    assert.equal(bad.status, 400, "a negative delay is refused");
  } finally {
    await aux.close();
    await db.close();
  }
});

test("NEGATIVE control: a delay that never reaches the proxy is caught by the round-trip check", async () => {
  const db = await fakeDatabase();
  const aux = await startAux({ controlPort: 0, proxy: { listenPort: 0, upstreamPort: db.port }, log: () => {} });
  // A control port that answers POST /latency 200 but has no proxy behind it.
  const liar = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ ok: true, up: 300, down: 0 })));
  });
  await new Promise((r) => liar.listen(0, "127.0.0.1", r));
  try {
    const t = fakeTarget(aux, db);
    const lat = rtdbLatency({ ...t, stack: { ports: { ...t.stack.ports, gate: liar.address().port } } });
    const effect = await rtdbDelayEffect(lat, { up: 300, down: 0 });
    assert.equal(effect.ok, false);
    assert.match(effect.failures[0], /grew by -?\d+ ms, not about the 300 ms delay set/);
  } finally {
    await new Promise((r) => liar.close(r));
    await aux.close();
    await db.close();
  }
});

/** Two ports free right now (a listener bound and closed). */
async function freePorts(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const s = createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    out.push(s.address().port);
    await new Promise((r) => s.close(r));
  }
  return out;
}

test("stackaux.mjs as a process: answers /health with its proxy, and exits on SIGTERM", async () => {
  const db = await fakeDatabase();
  const [control, proxy] = await freePorts(2);
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "lib", "stackaux.mjs"), "--control", String(control), "--rtdb-proxy", String(proxy), "--upstream", String(db.port)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  try {
    let health = null;
    for (let i = 0; i < 100 && !health; i += 1) {
      try {
        health = await (await fetch(`http://127.0.0.1:${control}/health`)).json();
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.ok(health, `no /health from the aux process: ${out}`);
    assert.deepEqual({ ok: health.ok, gates: health.gates, proxy: health.proxy }, { ok: true, gates: true, proxy: { port: proxy, upstream: db.port, delay: { up: 0, down: 0 } } });
    const through = await fetch(`http://127.0.0.1:${proxy}/.json?ns=demo-bikeshed&shallow=true`, { headers: { authorization: "Bearer owner" } });
    assert.equal(through.status, 200, "a read through the proxy reaches the database");
    const code = await new Promise((resolve) => {
      child.once("exit", (c) => resolve(c));
      child.kill("SIGTERM");
    });
    assert.equal(code, 0);
    assert.match(out, /"kind":"stop","signal":"SIGTERM"/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await db.close();
  }
});

test("a control applies after its amplifier or capability setup, preserving every amplifier gate", async () => {
  const stacked = listControlSets().map((set) => readControl(set)).filter((c) => c.stack.includes("--patches"));
  assert.ok(stacked.some((c) => c.set === "controls-i6-stale-removed"), stacked.map((c) => c.set).join(", "));
  for (const c of stacked) {
    const opts = parseStackOptionArgs(c.stack);
    const dir = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-aux-"));
    try {
      const { treeDir } = await materializeTree({ runId: "selftest-aux", tree: "HEAD", dest: join(dir, "tree"), linkModules: false });
      const ports = withAuxPorts(PORTS, { gates: true, rtdbProxy: true });
      const fb = patchFirebaseJson(treeDir, ports);
      patchAppConfig(treeDir, { ...ports, database: ports.rtdbProxy }, fb.defaults);
      writeFunctionsEnv(treeDir, ports, { gateUrl: `http://127.0.0.1:${ports.gate}` });
      installEgressGuard(treeDir);
      for (const set of [...opts.patches, c.set]) applyPatchSet(treeDir, set);
      // Every gate of every amplify set the control stacks on is still called, in the file its amplify.json names, once the control's own patch is on top (a set calls its gates through its own helper: e2eGate, e2eRaceGate, …).
      const sets = opts.patches.filter((set) => isAmplifySet(set));
      assert.ok(opts.patches.every((set) => isAmplifySet(set) || CONTROL_CAPABILITY_PATCHES.includes(set)), `${c.set}: every setup patch is an amplifier or named capability`);
      for (const set of sets) {
        for (const g of readAmplify(set).gates) {
          const file = g.where.split(/[\s:]/)[0];
          assert.match(readFileSync(join(treeDir, file), "utf8"), new RegExp(`\\be2e\\w*Gate\\("${g.name}"`), `${c.set}: the amplify set ${set} is in (its ${g.side} gate ${g.name} in ${file})`);
        }
      }
      assert.match(readFileSync(join(treeDir, "app", "src", "config.ts"), "utf8"), new RegExp(`database: ${ports.rtdbProxy},`), "the web SDK dials the proxy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// --- the RTDB handshake names the proxy, never the emulator ------------------------------

/** One unmasked server text frame (RFC 6455), payload under 64 KiB. */
function wsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

/**
 * A stand-in for the Database emulator's websocket: it answers an upgrade
 * with 101 and then, as the emulator does, a handshake whose "h" names its
 * OWN address, 127.0.0.1:<its port>. `split` writes the frame in two parts
 * cut inside that address, `gapMs` apart.
 */
async function fakeRtdbSocket({ split = false, gapMs = 0 } = {}) {
  const server = net.createServer((sock) => {
    let head = "";
    sock.on("error", () => undefined);
    sock.on("data", (c) => {
      if (head.includes("\r\n\r\n")) return;
      head += c.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const port = server.address().port;
      const frame = wsTextFrame(JSON.stringify({ t: "c", d: { t: "h", d: { ts: 1_760_000_000_000, v: "5", h: `127.0.0.1:${port}`, s: "e2e-session" } } }));
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: e2e\r\n\r\n");
      if (!split) return sock.write(frame);
      const cut = frame.indexOf(Buffer.from(`127.0.0.1:${port}`)) + 6;
      sock.write(frame.subarray(0, cut));
      setTimeout(() => sock.write(frame.subarray(cut)), gapMs);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** Upgrade through `port` and read the first frame's JSON. */
function firstFrame(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`GET /.ws?v=5&ns=demo-bikeshed HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZTJlZTJlZTJlZTJlZTJlZQ==\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`no whole first frame within 3 s: ${JSON.stringify(buf.toString("latin1"))}`));
    }, 3_000);
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      const at = buf.indexOf("\r\n\r\n");
      if (at < 0) return;
      const frame = buf.subarray(at + 4);
      if (frame.length < 2) return;
      const len = frame[1] & 0x7f;
      const [off, size] = len === 126 ? [4, frame.length >= 4 ? frame.readUInt16BE(2) : Infinity] : [2, len];
      if (frame.length < off + size) return;
      clearTimeout(timer);
      s.destroy();
      resolve(JSON.parse(frame.subarray(off, off + size).toString("utf8")));
    });
    s.on("error", reject);
  });
}

test("the RTDB handshake that comes back through the aux proxy names the PROXY's port, so a reconnect dials the proxy again", async () => {
  const db = await fakeRtdbSocket();
  const aux = await startAux({ controlPort: 0, proxy: { listenPort: 0, upstreamPort: db.port }, log: () => {} });
  try {
    const direct = await firstFrame(db.port);
    assert.equal(direct.d.d.h, `127.0.0.1:${db.port}`, "the stand-in names its own port, as the emulator does");
    const via = await firstFrame(aux.proxy.port);
    assert.equal(via.d.d.h, `127.0.0.1:${aux.proxy.port}`, "through the proxy the client is told the proxy's address");
    assert.equal(via.d.d.s, "e2e-session", "nothing else in the frame changed");
    assert.equal(aux.proxy.stats.rewrites, 1);
  } finally {
    await aux.close();
    await db.close();
  }
});

test("the rewrite holds when the server's frame is cut inside the address", async () => {
  const db = await fakeRtdbSocket({ split: true, gapMs: 5 });
  const aux = await startAux({ controlPort: 0, proxy: { listenPort: 0, upstreamPort: db.port }, log: () => {} });
  try {
    const via = await firstFrame(aux.proxy.port);
    assert.equal(via.d.d.h, `127.0.0.1:${aux.proxy.port}`);
  } finally {
    await aux.close();
    await db.close();
  }
});

test("a browser that dials the Database emulator's own port on a --rtdb-proxy stack is a breach; without the proxy it is a stack port", () => {
  const ports = withAuxPorts(PORTS, { gates: true, rtdbProxy: true });
  const proxied = { kind: "local", runId: "selftest-aux", options: { rtdbProxy: true }, capabilities: new Set(["rtdb-proxy"]), stack: { ports } };
  const v = classifyUrl(`ws://127.0.0.1:${ports.database}/.ws?v=5&ns=demo-bikeshed`, proxied);
  assert.equal(v.verdict, "breach", JSON.stringify(v));
  assert.match(v.reason, /bypass/);
  assert.equal(classifyUrl(`http://127.0.0.1:${ports.database}/.lp?start=t`, proxied).verdict, "breach", "long polling too");
  assert.equal(classifyUrl(`ws://127.0.0.1:${ports.rtdbProxy}/.ws?v=5`, proxied).verdict, "allow", "the proxy is the way in");
  const plain = { kind: "local", runId: "selftest-aux", options: { rtdbProxy: false }, capabilities: new Set(), stack: { ports: PORTS } };
  assert.equal(classifyUrl(`ws://127.0.0.1:${PORTS.database}/.ws?v=5`, plain).verdict, "allow");
});
