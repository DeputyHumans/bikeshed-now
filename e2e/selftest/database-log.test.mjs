// SPDX-License-Identifier: Apache-2.0
// Self-test: the Database emulator's own records reach the run's logs/database-debug.log through partial writes, cuts, interrupted drains, a held lock, the watchdog's caps and a stop whose clean exit unlinks firebase-debug.log (SPEC §12).

/**
 * firebase-debug.log is written by a real writer process
 * (helpers/fb-log-writer.mjs): firebase-tools' own logger when it is
 * installed (so the format the drain reads is pinned to its producer, and the
 * writer's copy of that format is pinned to it too), and, as firebase-tools'
 * CLI does, the file is unlinked at a clean exit. The fake stacks live in
 * temporary directories, never under ~/.cache/bikeshed-e2e/stacks, so no
 * other session's admission counts them; their run dirs are under e2e/.out,
 * removed after.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT_DIR, ensureDir } from "../lib/paths.mjs";
import { STACK_MARK_KEY, SYSTEM_PATH, buildEnv, newStackMark, spawnDetached } from "../lib/proc.mjs";
import { isPidAlive } from "../lib/ports.mjs";
import { DATABASE_LOG, DATABASE_LOG_STATE, DEBUG_LOG_PIN, capDebugLogs, databaseLogPaths, drainDatabaseLog, drainEmulatorLog, emulatorLogText, emulatorTrailer } from "../lib/debuglogs.mjs";
import { HOUR_MS, initialLease, ownerIdentity, writeLease } from "../lib/lifetime.mjs";
import { saveRecord, stopStack } from "../lib/stack.mjs";
import { spawnWatchdog } from "../lib/watchdog.mjs";
import { tempDir } from "./helpers/tmp.mjs";
import { firebaseTools } from "../lib/prerequisites.mjs";

const WRITER = fileURLToPath(new URL("./helpers/fb-log-writer.mjs", import.meta.url));
const STACK_SRC = fileURLToPath(new URL("../lib/stack.mjs", import.meta.url));
const NODE_BIN = dirname(process.execPath);
const ISO = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] /;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const fakes = [];
let seq = 0;

const FT = firebaseTools({ optional: true });
const WRITER_ENV = FT ? { E2E_FIREBASE_BIN: FT.bin } : { E2E_FB_WRITER: "format" };

after(async () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
  for (const rec of fakes) {
    if (rec.state !== "stopped" && rec.state !== "failed" && rec.state !== "stop-incomplete") await stopStack(rec, { log: () => {}, graceMs: 500 }).catch(() => undefined);
    for (const p of rec.processes ?? []) {
      try {
        process.kill(-p.pgid, "SIGKILL");
      } catch {}
    }
    rmSync(rec.runDir, { recursive: true, force: true });
  }
});

/** A database record's trailer for `message`, as firebase-tools prints it. */
const T = (message) => JSON.stringify({ metadata: { emulator: { name: "database" }, message } });

const SCRIPT = [
  { emulator: "database", type: "DEBUG", text: "Ignoring unsupported arg: projectId" },
  { emulator: "database", type: "DEBUG", text: "WARNING: one\nWARNING: two\n" },
  { emulator: "firestore", type: "DEBUG", text: "Oct 13 io.gapi channelRead\nINFO: Detected non-HTTP/2 connection.\n" },
  { emulator: "database", type: "DEBUG", text: "07:49:28.000 [w] INFO partial " },
  { emulator: "database", type: "DEBUG", text: "rest of the line\n" },
  { emulator: "database", type: "BULLET", text: "Database Emulator logging to database-debug.log" },
  { emulator: "database", type: "INFO", text: "an info line about the database, already in emulators.log" },
  { emulator: null, type: "DEBUG", text: "a plain debug line" },
  { emulator: "database", type: "DEBUG", text: `odd ${T("x")} inside\n` },
  { emulator: "database", type: "DEBUG", text: `foo ${T("y")}\nbar\n` },
  { emulator: "database", type: "DEBUG", text: T("only a trailer") },
  { emulator: "functions", type: "DEBUG", text: `a function logged ${T("smuggled")}` },
  { emulator: "functions", type: "DEBUG", text: `x ${T("smuggled too")}\ny\n` },
  { emulator: "database", type: "DEBUG", text: "\u001b[33mcoloured\u001b[39m line\n" },
  { emulator: "database", type: "DEBUG", text: `first\n[info] a JVM line that looks like a record\n[debug] [2026-01-01T00:00:00.000Z] and another\nlast\n` },
  { emulator: "database", type: "DEBUG", text: "07:49:40.874 [main] INFO done\n" },
];

/** The lines the drain must write for SCRIPT, without their time: each database DEBUG chunk, a line each. */
function expectedLines(script) {
  const out = [];
  for (const s of script) {
    if (s.emulator !== "database" || s.type !== "DEBUG") continue;
    const body = s.text.endsWith("\n") ? s.text.slice(0, -1) : s.text;
    out.push(...body.split("\n"));
  }
  return out;
}

/** Each line of a drained text: [time, rest]. */
function split(text) {
  assert.ok(text === "" || text.endsWith("\n"), "every record ends its last line");
  return text.split("\n").slice(0, -1).map((l) => {
    const m = ISO.exec(l);
    assert.ok(m, `a line without its time: ${JSON.stringify(l.slice(0, 120))}`);
    return [m[1], l.slice(m[0].length)];
  });
}

/** Lines of a child's stdout until `want` is seen. */
function waitLine(child, want, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`no "${want}" from the writer within ${ms} ms (saw ${JSON.stringify(lines)})`)), ms);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (lines[lines.length - 1] === want) {
          clearTimeout(timer);
          resolve(lines);
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the writer exited ${code} before "${want}" (saw ${JSON.stringify(lines)})`));
    });
  });
}

/** Run SCRIPT-like `script` through the writer into `file` (appending); the writer is then killed without its exit handler. */
async function writeScript(file, script, { env = WRITER_ENV } = {}) {
  const sf = join(dirname(file), `script-${process.pid}-${++seq}.json`);
  writeFileSync(sf, JSON.stringify(script));
  const child = spawn(process.execPath, [WRITER, file, "script", sf], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });
  children.push(child);
  const lines = await waitLine(child, "done");
  child.kill("SIGKILL");
  await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", r)));
  return lines[0];
}

/** A drain over a temp dir: source <dir>/firebase-debug.log, out <dir>/logs/database-debug.log, state <dir>/state.json. */
function drainer(dir, o = {}) {
  const paths = { source: join(dir, "firebase-debug.log"), out: join(dir, "logs", DATABASE_LOG), state: join(dir, DATABASE_LOG_STATE) };
  return { ...paths, drain: (x = {}) => drainEmulatorLog({ ...paths, ...o, ...x }) };
}

test("the real writer's records: each database DEBUG chunk, a line each with its record's time, nothing else", async () => {
  const dir = tempDir("e2e-dblog-real-");
  const file = join(dir, "firebase-debug.log");
  const t0 = new Date().toISOString();
  const mode = await writeScript(file, SCRIPT);
  const t1 = new Date().toISOString();
  assert.equal(mode, FT ? "mode real" : "mode format", "firebase-tools' own logger whenever it is installed");
  const r = emulatorLogText(readFileSync(file, "utf8"));
  const lines = split(r.text);
  assert.deepEqual(lines.map((l) => l[1]), expectedLines(SCRIPT));
  assert.equal(r.records, SCRIPT.filter((s) => s.emulator === "database" && s.type === "DEBUG").length);
  for (const [at] of lines) assert.ok(at >= t0 && at <= t1, `${at} is the record's own time, between ${t0} and ${t1}`);
  // The lines of one chunk share its time; the colour codes are kept as the JVM wrote them.
  assert.ok(r.text.includes("\u001b[33mcoloured\u001b[39m line\n"));
  assert.deepEqual(r.cursor.starts, [], "no record left open");
  // The other emulators' trailer is never matched as the database's.
  assert.throws(() => emulatorTrailer("Database"), TypeError);
  assert.equal(emulatorLogText(readFileSync(file, "utf8"), { emulator: "firestore" }).records, 1);
});

test("the writer's copy of the format is firebase-tools' own, byte for byte but the times", async (t) => {
  if (!FT) return t.skip("firebase-tools is not installed here");
  const dir = tempDir("e2e-dblog-format-");
  const script = SCRIPT.filter((s) => s.type !== "BULLET");
  await writeScript(join(dir, "real.log"), script);
  await writeScript(join(dir, "copy.log"), script, { env: { E2E_FB_WRITER: "format" } });
  const norm = (f) => readFileSync(join(dir, f), "utf8").replace(/\[\d{4}-\d\d-\d\dT[\d:.]+Z\]/g, "[T]");
  assert.equal(norm("copy.log"), norm("real.log"));
});

test("firebase-tools as installed: the CLI unlinks firebase-debug.log at a clean exit, and logs each JVM chunk at debug with its emulator", (t) => {
  if (!FT) return t.skip("firebase-tools is not installed here");
  const cli = readFileSync(join(FT.root, "lib", "bin", "cli.js"), "utf8");
  assert.match(cli, /process\.on\("exit", \(code\) => \{[\s\S]{0,200}code < 2 && fsutils\.fileExistsSync\(logFilename\)\) \{\s*fs\.unlinkSync\(logFilename\);/, "why stopStack drains BEFORE the emulators are signalled");
  const dl = readFileSync(join(FT.root, "lib", "emulator", "downloadableEmulators.js"), "utf8");
  const run = dl.slice(dl.indexOf("async function _runBinary"), dl.indexOf("async function _runBinary") + 3000);
  assert.match(run, /EmulatorLogger\.forEmulator\(emulator\.name\)/);
  assert.equal(run.match(/logger\.log\("DEBUG", data\.toString\(\)\);/g)?.length, 2, "stdout and stderr, each chunk at DEBUG");
  const el = readFileSync(join(FT.root, "lib", "emulator", "emulatorLogger.js"), "utf8");
  assert.match(el, /EmulatorLogger\.verbosity = Verbosity\.DEBUG;/, "DEBUG is not suppressed by default, so each chunk carries its trailer");
});

test("drains in pieces give what one read gives: writes cut anywhere, mid-record included, and a backlog over several reads", async () => {
  const src = tempDir("e2e-dblog-src-");
  await writeScript(join(src, "whole.log"), [...SCRIPT, ...SCRIPT, ...SCRIPT, ...SCRIPT]);
  const bytes = readFileSync(join(src, "whole.log"));
  const want = emulatorLogText(bytes.toString("utf8")).text;
  let rnd = 7;
  const next = (n) => (rnd = (rnd * 1103515245 + 12345) % 2147483648) % n;
  for (const [label, cuts] of [
    ["one write", [bytes.length]],
    ["random cuts", Array.from({ length: 40 }, () => 1 + next(bytes.length - 1)).sort((a, b) => a - b).concat(bytes.length)],
    ["every 37 bytes", Array.from({ length: Math.ceil(bytes.length / 37) }, (_, i) => Math.min(bytes.length, (i + 1) * 37))],
  ]) {
    const dir = tempDir("e2e-dblog-pieces-");
    const d = drainer(dir, { chunkBytes: 1024 });
    let at = 0;
    let total = 0;
    for (const cut of cuts) {
      if (cut > at) appendFileSync(d.source, bytes.subarray(at, cut));
      at = Math.max(at, cut);
      const r = d.drain();
      total += r.records;
      assert.equal(r.reset, null, label);
      const state = JSON.parse(readFileSync(d.state, "utf8"));
      assert.ok(state.offset === 0 || bytes[state.offset - 1] === 10, `${label}: the offset is always a line end`);
    }
    assert.equal(readFileSync(d.out, "utf8"), want, label);
    assert.equal(total, 4 * SCRIPT.filter((s) => s.emulator === "database" && s.type === "DEBUG").length, `${label}: every record once`);
    assert.equal(JSON.parse(readFileSync(d.state, "utf8")).records, total, `${label}: the state counts every record once`);
    assert.equal(existsSync(`${d.state}.lock`), false, `${label}: the lock is released`);
  }
});

test("a cut or replaced firebase-debug.log is read from its start again, after a line saying so; nothing twice", async () => {
  const A = SCRIPT.slice(0, 5);
  const B = [{ emulator: "database", type: "DEBUG", text: "after the cut\n" }, ...SCRIPT.slice(12)];
  // (a) cut by capDebugLogs, as the watchdog cuts it
  {
    const dir = tempDir("e2e-dblog-cut-");
    const d = drainer(dir);
    await writeScript(d.source, A);
    const a = emulatorLogText(readFileSync(d.source, "utf8")).text;
    d.drain();
    assert.ok(capDebugLogs(dir, { maxBytes: 64 }).some((x) => x.rotated));
    await writeScript(d.source, B);
    const b = emulatorLogText(readFileSync(d.source, "utf8")).text;
    const r = d.drain({ now: () => Date.parse("2026-10-13T12:00:00.000Z") });
    assert.equal(r.reset, "cut");
    const out = readFileSync(d.out, "utf8");
    const gap = out.slice(a.length, out.length - b.length);
    assert.equal(out.slice(0, a.length), a);
    assert.equal(out.slice(out.length - b.length), b);
    assert.match(gap, /^\[2026-10-13T12:00:00\.000Z\] \[e2e\] firebase-debug\.log was cut after this file had read \d+ bytes of it \(last read [^)]+\); what the database emulator printed between that read and the cut is not here\n$/);
  }
  // (b) cut and grown past the old offset before the next drain: the first bytes differ
  {
    const dir = tempDir("e2e-dblog-regrow-");
    const d = drainer(dir);
    await writeScript(d.source, A);
    const first = d.drain();
    truncateSync(d.source, 0);
    await writeScript(d.source, [...B, ...B, ...B, ...B]);
    assert.ok(statSync(d.source).size > first.offset, "grown past where the last drain stopped");
    const b = emulatorLogText(readFileSync(d.source, "utf8")).text;
    const r = d.drain();
    assert.equal(r.reset, "cut", "told by the file's first bytes");
    assert.ok(readFileSync(d.out, "utf8").endsWith(b), "read whole from 0, not from the old offset");
  }
  // (c) replaced: another inode
  {
    const dir = tempDir("e2e-dblog-replaced-");
    const d = drainer(dir);
    await writeScript(d.source, A);
    d.drain();
    unlinkSync(d.source);
    await writeScript(d.source, B);
    const r = d.drain();
    assert.equal(r.reset, "replaced");
    assert.match(readFileSync(d.out, "utf8"), /\[e2e\] firebase-debug\.log was replaced after/);
  }
});

test("an append whose save never came is cut back, not written twice", async () => {
  const dir = tempDir("e2e-dblog-trim-");
  const d = drainer(dir);
  await writeScript(d.source, SCRIPT.slice(0, 5));
  d.drain();
  const a = readFileSync(d.out, "utf8");
  // A drain killed between its append and its state save.
  appendFileSync(d.out, "[2026-10-13T00:00:00.000Z] half an append\n");
  const r = d.drain();
  assert.equal(r.trimmed, "[2026-10-13T00:00:00.000Z] half an append\n".length);
  assert.equal(readFileSync(d.out, "utf8"), a);
  await writeScript(d.source, SCRIPT.slice(12));
  d.drain();
  assert.equal(readFileSync(d.out, "utf8"), emulatorLogText(readFileSync(d.source, "utf8")).text);
});

test("the output is capped as the debug logs are: past half the cap it moves to .1", async () => {
  const dir = tempDir("e2e-dblog-cap-");
  const d = drainer(dir, { maxBytes: 1200 });
  // Thirty one-line records, fed to the source one at a time with a drain after each.
  await writeScript(join(dir, "all.log"), Array.from({ length: 30 }, (_, i) => ({ emulator: "database", type: "DEBUG", text: `07:00:00.000 [ws] INFO record ${i} ${"r".repeat(60)}` })));
  const lines = readFileSync(join(dir, "all.log"), "utf8").split("\n").slice(0, -1);
  assert.equal(lines.length, 30);
  let rotated = 0;
  for (const line of lines) {
    appendFileSync(d.source, `${line}\n`);
    rotated += d.drain().rotated ? 1 : 0;
    assert.ok(statSync(d.out).size <= 600, `at most half the cap (${statSync(d.out).size})`);
  }
  assert.ok(rotated >= 2, `rotated ${rotated} times`);
  const kept = readFileSync(`${d.out}.1`, "utf8") + readFileSync(d.out, "utf8");
  const all = emulatorLogText(readFileSync(d.source, "utf8")).text;
  assert.ok(all.endsWith(kept), "the newest records, in order");
  assert.match(kept, /record 29 /);
});

test("the lock: a live holder makes a drain busy and nothing is written; a dead holder's lock is taken over", async () => {
  const dir = tempDir("e2e-dblog-lock-");
  const d = drainer(dir);
  await writeScript(d.source, SCRIPT.slice(0, 3));
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(holder);
  writeFileSync(`${d.state}.lock`, `${holder.pid}\n`);
  const busy = d.drain();
  assert.equal(busy.busy, true);
  assert.equal(existsSync(d.out), false, "nothing written while another drain holds the lock");
  assert.equal(existsSync(d.state), false);
  holder.kill("SIGKILL");
  for (let i = 0; i < 50 && isPidAlive(holder.pid); i++) await sleep(50);
  const r = d.drain();
  assert.equal(r.busy, undefined);
  assert.ok(r.records > 0);
  assert.equal(existsSync(`${d.state}.lock`), false);
});

test("a line longer than a whole read is skipped, the records around it kept, across drains too", async () => {
  const dir = tempDir("e2e-dblog-long-");
  const d = drainer(dir, { chunkBytes: 1024 });
  const script = [
    { emulator: "database", type: "DEBUG", text: "before\n" },
    { emulator: "functions", type: "DEBUG", text: `a big one ${"z".repeat(3000)}` },
    { emulator: "database", type: "DEBUG", text: "after\n" },
  ];
  await writeScript(d.source, script);
  const r = d.drain();
  assert.equal(r.skippedLines, 1);
  assert.deepEqual(split(readFileSync(d.out, "utf8")).map((l) => l[1]), ["before", "after"]);
  // A long line still being written when a drain comes: skipped until its end, whenever that arrives.
  appendFileSync(d.source, `[debug] [2026-10-13T00:00:00.000Z] ${"q".repeat(2500)}`);
  const mid = d.drain();
  assert.equal(mid.records, 0);
  appendFileSync(d.source, `${"q".repeat(10)}\n`);
  await writeScript(d.source, [{ emulator: "database", type: "DEBUG", text: "after the long one\n" }]);
  const end = d.drain();
  assert.equal(end.skippedLines, 1);
  assert.deepEqual(split(readFileSync(d.out, "utf8")).map((l) => l[1]), ["before", "after", "after the long one"]);
});

/**
 * A fake stack whose "emulators" process is the writer streaming into
 * <tree>/firebase-debug.log (marked, its own group, as startStack spawns
 * one); optionally the real watchdog. `logs.database` only when `current`
 * (an older record has none).
 */
async function fakeStack({ current = true, watchdog = false, maxBytes = null, tickMs = 25, filler = 0 } = {}) {
  const runId = `selftest-dl${process.pid}-${++seq}`;
  const stackDir = ensureDir(join(realpathSync(tempDir("e2e-dblog-stack-")), "bikeshed-e2e", "stacks", runId), "stackDir");
  const treeDir = ensureDir(join(stackDir, "tree"), "treeDir");
  const runDir = ensureDir(join(OUT_DIR, runId), "runDir");
  const logs = ensureDir(join(runDir, "logs"), "logs");
  const mark = newStackMark(runId);
  const env = buildEnv({ path: [NODE_BIN, ...SYSTEM_PATH], tmpdir: realpathSync(tempDir("e2e-dblog-tmp-")), set: { [STACK_MARK_KEY]: mark, ...WRITER_ENV } });
  const writer = spawnDetached(process.execPath, [WRITER, join(treeDir, "firebase-debug.log"), "stream", String(tickMs), String(filler)], { cwd: treeDir, env, logFile: join(logs, "emulators.log") });
  const now = Date.now();
  const rec = {
    runId,
    mark,
    state: "ready",
    keep: true,
    createdAt: new Date(now).toISOString(),
    createdBy: { pid: process.pid },
    owner: ownerIdentity(),
    stackDir,
    treeDir,
    runDir,
    tmpDir: env.TMPDIR,
    logs: { emulators: join(logs, "emulators.log"), watchdog: join(logs, "watchdog.log"), ...(current ? { database: join(logs, DATABASE_LOG) } : {}) },
    ...(maxBytes ? { debugLogs: { maxBytes } } : {}),
    processes: [{ name: "emulators", ...writer }],
  };
  writeLease(stackDir, initialLease({ createdAtMs: now, keep: true, config: { ttlMs: HOUR_MS, extendMs: 2 * HOUR_MS, maxMs: 8 * HOUR_MS } }));
  saveRecord(rec);
  fakes.push(rec);
  for (let i = 0; i < 200 && !readFileSync(rec.logs.emulators, "utf8").includes("ready\n"); i++) await sleep(50);
  assert.match(readFileSync(rec.logs.emulators, "utf8"), /ready\n/, "the writer is streaming");
  if (watchdog) {
    rec.processes.unshift(spawnWatchdog(rec, { nodeBin: NODE_BIN, pollMs: 300 }));
    saveRecord(rec);
  }
  return rec;
}

/** The seq numbers in a drained text, one per record (a record's two lines count once), in file order; and the [e2e] lines' places. */
function seqs(text) {
  const out = [];
  const gaps = [];
  for (const [, line] of split(text)) {
    if (line.startsWith("[e2e] ")) {
      gaps.push(out.length);
      continue;
    }
    const m = /seq=(\d+)/.exec(line);
    assert.ok(m, `a record without its seq: ${line.slice(0, 80)}`);
    const n = Number(m[1]);
    if (out.length && out[out.length - 1] === n && !line.includes("shutdown")) continue;
    out.push(line.includes("shutdown") ? `shutdown ${n}` : n);
  }
  return { seqs: out, gaps };
}

test("the writer unlinks firebase-debug.log at a clean exit, as firebase-tools does: what a stop must drain first", async () => {
  const dir = tempDir("e2e-dblog-unlink-");
  const file = join(dir, "firebase-debug.log");
  const child = spawn(process.execPath, [WRITER, file, "stream", "25", "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...WRITER_ENV } });
  children.push(child);
  await waitLine(child, "ready");
  assert.ok(existsSync(file));
  child.kill("SIGINT");
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 0);
  assert.equal(existsSync(file), false, "gone with the clean exit");
});

test("stopStack drains before the emulators are signalled, then the pinned link: every record and the shutdown line survive the unlink", async () => {
  const rec = await fakeStack();
  await sleep(600);
  const r = await stopStack(rec, { log: () => {}, graceMs: 3000, keepTree: true });
  Object.assign(rec, { state: r.state });
  assert.equal(r.state, "stopped");
  assert.equal(existsSync(join(rec.treeDir, "firebase-debug.log")), false, "the writer unlinked it at its clean exit");
  const { databaseLog } = r;
  assert.equal(databaseLog.file, rec.logs.database);
  assert.ok(databaseLog.before.records > 10, `drained before the signal: ${JSON.stringify(databaseLog.before)}`);
  assert.equal(databaseLog.pinned, true);
  assert.ok(databaseLog.after.records >= 1, `the pinned link held the shutdown: ${JSON.stringify(databaseLog.after)}`);
  const { seqs: got, gaps } = seqs(readFileSync(rec.logs.database, "utf8"));
  assert.deepEqual(gaps, []);
  const last = got.pop();
  assert.match(String(last), /^shutdown \d+$/, "the shutdown record is the last");
  assert.deepEqual(got, got.map((_, i) => i), "every record from seq=0, once, in order");
  assert.equal(Number(String(last).split(" ")[1]), got.length, "and none after the last one drained");
  assert.equal(existsSync(join(rec.stackDir, DEBUG_LOG_PIN)), false, "the pin is removed");
  const saved = JSON.parse(readFileSync(join(rec.runDir, "stack.json"), "utf8")).stopped.databaseLog;
  assert.equal(saved.after.total, databaseLog.before.records + databaseLog.after.records, "the record says what was kept (records are chunks: a split line is two)");
  assert.equal(existsSync(join(rec.stackDir, DATABASE_LOG_STATE)), true, "a kept tree keeps its drain state");
});

test("an older record (no logs.database) is drained beside its emulators.log, and its tree is removed as before", async () => {
  const rec = await fakeStack({ current: false });
  await sleep(300);
  const want = databaseLogPaths(rec).out;
  assert.equal(want, join(dirname(rec.logs.emulators), DATABASE_LOG));
  const r = await stopStack(rec, { log: () => {}, graceMs: 3000 });
  Object.assign(rec, { state: r.state });
  assert.equal(r.state, "stopped");
  assert.equal(existsSync(rec.stackDir), false, "the tree (and the pin with it) is gone");
  const { seqs: got } = seqs(readFileSync(want, "utf8"));
  assert.match(String(got.pop()), /^shutdown /);
  assert.ok(got.length >= 5 && got.every((n, i) => n === i));
});

test("the watchdog drains before every cut: what the cap throws away from the tree is in logs/database-debug.log", { timeout: 60_000 }, async (t) => {
  // ~110 KB/s of firestore lines against a 200 KB cap: a cut about every second.
  const rec = await fakeStack({ watchdog: true, maxBytes: 200_000, tickMs: 20, filler: 2000 });
  const deadline = Date.now() + 30_000;
  let wd = "";
  let cuts = 0;
  do {
    await sleep(100);
    wd = readFileSync(rec.logs.watchdog, "utf8");
    cuts = (wd.match(/cut .*firebase-debug\.log at/g) ?? []).length;
  } while (cuts < 2 && Date.now() < deadline);
  assert.ok(cuts >= 2, `the watchdog cut firebase-debug.log ${cuts} times:\n${wd}`);
  // What the tree still holds, as a stop without the drain would have it: the middle is gone.
  const inTree = new Set();
  for (const f of ["firebase-debug.head.log", "firebase-debug.log.1", "firebase-debug.log"]) {
    const p = join(rec.treeDir, f);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, "utf8").matchAll(/INFO seq=(\d+)/g)) inTree.add(Number(m[1]));
  }
  const r = await stopStack(rec, { log: () => {}, graceMs: 3000 });
  Object.assign(rec, { state: r.state });
  const text = readFileSync(rec.logs.database, "utf8");
  const { seqs: got, gaps } = seqs(text);
  const last = Number(String(got.pop()).split(" ")[1]);
  assert.ok(gaps.length >= 1, "a cut is said where it happened");
  // Strictly increasing, nothing twice; a seq is missing only next to a cut, and at most two there.
  let missing = 0;
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i] > got[i - 1], `seq ${got[i]} after ${got[i - 1]}: nothing twice, nothing out of order`);
    const jump = got[i] - got[i - 1] - 1;
    if (jump > 0) {
      assert.ok(gaps.includes(i), `${jump} record(s) missing between seq ${got[i - 1]} and ${got[i]} with no cut there`);
      assert.ok(jump <= 2, `${jump} records lost at one cut: the drain did not run just before it`);
      missing += jump;
    }
  }
  assert.equal(got[0], 0);
  const lostFromTree = [];
  for (let n = 0; n < last; n++) if (!inTree.has(n)) lostFromTree.push(n);
  assert.ok(lostFromTree.length > 20, `the cuts took ${lostFromTree.length} records out of the tree's logs`);
  const kept = new Set(got);
  const keptOfLost = lostFromTree.filter((n) => kept.has(n)).length;
  assert.ok(keptOfLost >= lostFromTree.length - missing, `of the ${lostFromTree.length} records the tree lost, ${keptOfLost} are in ${DATABASE_LOG}`);
  assert.ok(got.length >= last - 2 * gaps.length, `${got.length} of ${last} records kept`);
  t.diagnostic(`${cuts} cut(s); the tree kept ${last - lostFromTree.length} of ${last} records, ${DATABASE_LOG} ${got.length} (${missing} lost at ${gaps.length} cut(s))`);
});

test("startStack records logs.database; a stack record and a local target's stack name the same paths", () => {
  const src = readFileSync(STACK_SRC, "utf8");
  assert.match(src, /\n {6}database: join\(ld, DATABASE_LOG\),\n/, "startStack's rec.logs");
  const stack = { treeDir: "/x/bikeshed-e2e/stacks/r/tree", stackDir: "/x/bikeshed-e2e/stacks/r", logs: { emulators: "/o/r/logs/emulators.log", database: "/o/r/logs/database-debug.log" } };
  assert.deepEqual(databaseLogPaths(stack), { source: "/x/bikeshed-e2e/stacks/r/tree/firebase-debug.log", pinned: `/x/bikeshed-e2e/stacks/r/${DEBUG_LOG_PIN}`, out: "/o/r/logs/database-debug.log", state: `/x/bikeshed-e2e/stacks/r/${DATABASE_LOG_STATE}` });
  assert.equal(databaseLogPaths({ treeDir: "/t" }), null, "no stack dir, no logs: nothing to drain");
  assert.equal(drainDatabaseLog({ treeDir: "/t" }), null);
  assert.throws(() => databaseLogPaths(null), TypeError);
});
