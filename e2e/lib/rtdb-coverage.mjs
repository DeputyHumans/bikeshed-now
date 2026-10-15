// SPDX-License-Identifier: Apache-2.0
// Reclaim the local RTDB emulator's unbounded rule-value coverage only between quiescent exclusive cases, preserving rules and coverage evidence (SPEC §12).

import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { firebaseTools } from "./prerequisites.mjs";
import { commandLine } from "./proc.mjs";
import { jvmEvents } from "./jvm.mjs";
import { markedBrowsers } from "./browsers.mjs";
import { tierLockStatus } from "./locks.mjs";
import { readInvocationMeta, evidenceRoot } from "./invocation.mjs";
import { assertReachable } from "./http.mjs";
import { rtdbNamespace } from "./rtdb.mjs";
import { rtdbRulesFile } from "./patch.mjs";
import { within } from "./paths.mjs";

import { RTDB_RUNTIME_CAPABILITY, RTDB_STOCK_PIN, inspectRtdbLaunch } from "./rtdb-runtime.mjs";
export const RTDB_COVERAGE_PIN = RTDB_STOCK_PIN;
const hash = b => createHash("sha256").update(b).digest("hex");
const need = (ok, reason) => { if (!ok) throw Object.assign(new Error(`RTDB coverage maintenance refused: ${reason}`), { code: "E2E_RTDB_MAINTENANCE" }); };

/** A timed-out/abandoned body poisons later maintenance, even after its browser begins closing. */
export class CoverageBoundary {
  active = 0;
  unsafe = false;
  needed = true;
  enter() { this.active++; }
  leave({ settled, closed, usedBrowsers, pending = 0 }) {
    if (!settled || !closed || pending) this.unsafe = true;
    if (usedBrowsers) this.needed = true;
    this.active--;
  }
  ready() { return this.needed && !this.unsafe && this.active === 1; }
  recycled() { this.needed = false; }
}

export function assertCoverageBoundary({ target, invocation, locks, browsers, boundary }) {
  need(target?.kind === "local" && target.capabilities?.has("rtdb-rules"), "only a rules-verified local stack qualifies");
  need(boundary?.ready() === true, "a prior body, request or browser cleanup is still active or incomplete");
  need(invocation?.runId === target.runId && invocation.maintenance?.rtdbCoverage === true && invocation.parallelism?.concurrency === 1 && invocation.locks?.concurrency?.mode === "exclusive" && !invocation.endedAt, "invocation is not a serial exclusive concurrency measurement");
  need(locks?.exclusive?.pid === invocation.pid && locks.exclusive.runId === target.runId && locks.exclusive.tier === "concurrency" && locks.exclusive.mode === "exclusive" && locks.shared?.length === 0, "the invocation does not hold the exclusive tier lock");
  need(browsers.length === 0, "a harness browser is still alive");
}

/** Ordinary shared authoring and parallel files never mutate emulator diagnostics. */
export function coverageMaintenanceEligible(target, tier, mode, concurrency) {
  return target?.kind === "local" && tier === "concurrency" && mode === "exclusive" && concurrency === 1;
}

const pinned = new Map();
/** Bind the audited behavior to the JAR the stack's live Database JVM is actually running. */
export async function pinnedDatabase(target, { env = process.env } = {}) {
  const database = jvmEvents(target.stack.stackDir).started.filter(j => j.role === "database" && j.alive);
  need(database.length === 1, "exactly one live Database JVM is required");
  const key = `${target.stack.stackDir}:${database[0].pid}:${target.rtdbEngine?.profileSha256 ?? "stock"}:${target.rtdbEngine?.attestation?.sha256 ?? ""}`;
  if (target.capabilities?.has(RTDB_RUNTIME_CAPABILITY)) need(target.rtdbEngine, "claimed derived capability has no runtime identity");
  if (pinned.has(key)) return pinned.get(key);
  const firebase = firebaseTools({ env });
  if (target.rtdbEngine) {
    const rec = JSON.parse(readFileSync(join(target.stack.stackDir, "stack.json"), "utf8"));
    need(rec.runId === target.runId && JSON.stringify(rec.rtdbEngine) === JSON.stringify(target.rtdbEngine), "target and stack derived identities differ");
    need(firebase.version === rec.rtdbEngine.firebaseVersion, "selected Firebase CLI changed");
    const live = inspectRtdbLaunch(rec);
    const actual = { firebase: rec.rtdbEngine.firebaseVersion, database: rec.rtdbEngine.databaseVersion, sha256: live.actualSha256, kind: rec.rtdbEngine.kind, originalSha256: rec.rtdbEngine.originalSha256, profileSha256: live.profileSha256, attestation: rec.rtdbEngine.attestation };
    pinned.set(key, actual);
    return actual;
  }
  const require = createRequire(join(firebase.root, "package.json"));
  const info = require(join(firebase.root, "lib/emulator/downloadableEmulators.js")).getDownloadDetails("database");
  need(commandLine(database[0].pid)?.includes(` -jar ${info.downloadPath} `), "the live JVM is not running the selected Database JAR");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(info.downloadPath)) digest.update(chunk);
  const actual = { firebase: firebase.version, database: info.version, sha256: digest.digest("hex") };
  need(JSON.stringify(actual) === JSON.stringify(RTDB_COVERAGE_PIN), "the CLI, Database version or JAR bytes differ from the audited retention/reset behavior");
  pinned.set(key, actual);
  return actual;
}

/** Stream the full diagnostic report to disk; payload strings never accumulate in the harness heap. */
async function archiveCoverage(response, path) {
  need(response.status === 200 && /json/.test(response.headers.get("content-type") ?? ""), "coverage was not an inspectable JSON response");
  let sourceBytes = 0, storedBytes = 0;
  const digest = createHash("sha256");
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) { sourceBytes += chunk.length; done(null, chunk); } }), createGzip(), new Transform({ transform(chunk, _, done) { storedBytes += chunk.length; digest.update(chunk); done(null, chunk); } }), createWriteStream(path, { flags: "wx" }));
  return { sourceBytes, storedBytes, sha256: digest.digest("hex") };
}

/** A whitespace-only rule round trip releases coverage; the exact staged bytes are always restored. */
export async function recycleRtdbCoverage(target, { boundary, caseName, invocationDir = evidenceRoot(target), fetchImpl = fetch, inspect = null, pin = pinnedDatabase } = {}) {
  const state = inspect ? await inspect() : { invocation: readInvocationMeta(invocationDir), locks: tierLockStatus(), browsers: markedBrowsers() };
  assertCoverageBoundary({ target, boundary, ...state });
  const toolchain = await pin(target);
  const namespace = rtdbNamespace(target), tree = target.stack.treeDir;
  const rel = rtdbRulesFile(JSON.parse(readFileSync(within(tree, "firebase.json"), "utf8")), namespace);
  need(rel, "no staged rules file is bound to this namespace");
  const rulesPath = within(tree, rel), wanted = readFileSync(rulesPath), rulesSha256 = hash(wanted);
  const origin = new URL(target.databaseURL).origin;
  const request = async (path, options = {}) => {
    const url = `${origin}${path}?ns=${encodeURIComponent(namespace)}`;
    assertReachable(target, url);
    return fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { authorization: "Bearer owner", "content-type": "application/json" }, ...options });
  };
  const rulesUrl = "/.settings/rules.json";
  const before = await request(rulesUrl);
  need(before.status === 200 && Buffer.from(await before.arrayBuffer()).equals(wanted), "live rules differ from the staged rules before maintenance");
  const dir = join(invocationDir, "rtdb-coverage"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json.gz`);
  const coverage = { artifact: relative(invocationDir, path), ...await archiveCoverage(await request("/.inspect/coverage.json"), path) };
  // Recheck the real boundary and source after the archive's potentially long read.
  const now = inspect ? await inspect() : { invocation: readInvocationMeta(invocationDir), locks: tierLockStatus(), browsers: markedBrowsers() };
  assertCoverageBoundary({ target, boundary, ...now });
  need(readFileSync(rulesPath).equals(wanted), "staged rules changed during maintenance");
  appendFileSync(join(invocationDir, "maintenance.jsonl"), JSON.stringify({ at: new Date().toISOString(), event: "rtdb-coverage-recycle-start", beforeCase: caseName, namespace, rulesSha256, toolchain, coverage }) + "\n");
  // The metadata observer compares raw strings and ignores an identical PUT.
  // A trailing newline changes no rule but forces a fresh tracker; restore even
  // when that first request or its verification fails.
  const temporary = Buffer.concat([wanted, Buffer.from("\n")]);
  try {
    const put = await request(rulesUrl, { method: "PUT", body: temporary });
    need(put.status === 200, `whitespace-only reinstall answered ${put.status}`);
    await put.arrayBuffer();
    const changed = await request(rulesUrl);
    need(changed.status === 200 && Buffer.from(await changed.arrayBuffer()).equals(temporary), "temporary rules differ from the whitespace-only variant");
  } finally {
    const restore = await request(rulesUrl, { method: "PUT", body: wanted });
    need(restore.status === 200, `exact-rule restoration answered ${restore.status}`);
    await restore.arrayBuffer();
    const after = await request(rulesUrl);
    need(after.status === 200 && Buffer.from(await after.arrayBuffer()).equals(wanted), "live rules differ after maintenance");
  }
  // Bound this read: a failed reset must not copy the retained payloads into the
  // harness heap. A clean report contains only the rule syntax and empty values.
  const fresh = await request("/.inspect/coverage.json");
  need(fresh.status === 200, "fresh coverage is unavailable");
  const chunks = []; let size = 0;
  for await (const chunk of Readable.fromWeb(fresh.body)) {
    size += chunk.length;
    need(size <= Math.max(1024 * 1024, wanted.length * 50), "replacement coverage is unexpectedly large");
    chunks.push(chunk);
  }
  let report = JSON.parse(Buffer.concat(chunks).toString());
  if (typeof report === "string") report = JSON.parse(report);
  need(report.rules === wanted.toString() && report.report && typeof report.report === "object", "fresh coverage is not bound to the exact restored rules");
  let expressions = 0;
  const empty = node => {
    if (!node || typeof node !== "object") return;
    if (Object.hasOwn(node, "values")) { expressions++; need(Array.isArray(node.values) && node.values.length === 0, "replacement tracker still retains evaluated values"); }
    for (const [key, value] of Object.entries(node)) if (key !== "values") empty(value);
  };
  empty(report.report);
  need(expressions > 0, "fresh coverage contains no inspectable expressions");
  const deniedUrl = `${origin}/.json?ns=${encodeURIComponent(namespace)}&shallow=true`;
  assertReachable(target, deniedUrl);
  const denied = await fetchImpl(deniedUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  need(denied.status === 401 && (await denied.json()).error === "Permission denied", "anonymous root read no longer receives the real rules denial");
  const row = { at: new Date().toISOString(), event: "rtdb-coverage-recycled", beforeCase: caseName, namespace, rulesSha256, toolchain, coverage, mutation: "whitespace-roundtrip-exact-restore", freshCoverage: { bytes: size, expressions, retainedValues: 0 } };
  appendFileSync(join(invocationDir, "maintenance.jsonl"), JSON.stringify(row) + "\n");
  boundary.recycled();
  return row;
}
