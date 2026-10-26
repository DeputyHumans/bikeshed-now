// SPDX-License-Identifier: Apache-2.0
// Archive and recycle Firestore rule-value diagnostics at an exclusive quiescent boundary without changing rules or data (SPEC §12).

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
import { within } from "./paths.mjs";
import { assertCoverageBoundary } from "./rtdb-coverage.mjs";
import { retireFirestoreChannels } from "./firestore-channels.mjs";

export const FIRESTORE_COVERAGE_PIN = Object.freeze({ firebase: "15.25.1", firestore: "1.22.0", sha256: "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c" });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (ok, why) => { if (!ok) throw Object.assign(new Error(`Firestore coverage maintenance refused: ${why}`), { code: "E2E_FIRESTORE_MAINTENANCE" }); };
const pinned = new Map();

/** The stock JAR replaces its authorizer and coverage tracker on every successful identical-rule PUT. */
export async function pinnedFirestore(target, { env = process.env } = {}) {
  const jobs = jvmEvents(target.stack.stackDir).started.filter(j => j.role === "firestore" && j.alive);
  need(jobs.length === 1, "exactly one live Firestore JVM is required");
  const key = `${target.runId}:${jobs[0].pid}`;
  if (pinned.has(key)) return pinned.get(key);
  const firebase = firebaseTools({ env });
  const require = createRequire(join(firebase.root, "package.json"));
  const info = require(join(firebase.root, "lib/emulator/downloadableEmulators.js")).getDownloadDetails("firestore");
  const command = commandLine(jobs[0].pid);
  need(command?.includes(` -jar ${info.downloadPath} `) && command.includes(" -Xmx2048m "), "live Firestore JAR or ordinary heap cap differs");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(info.downloadPath)) digest.update(chunk);
  const actual = { firebase: firebase.version, firestore: info.version, sha256: digest.digest("hex") };
  need(JSON.stringify(actual) === JSON.stringify(FIRESTORE_COVERAGE_PIN), "CLI, Firestore version or JAR bytes differ from the audited reset behavior");
  pinned.set(key, actual);
  return actual;
}

async function archive(response, path) {
  need(response.status === 200 && /json/.test(response.headers.get("content-type") ?? ""), "coverage is not inspectable JSON");
  let sourceBytes = 0, storedBytes = 0;
  const digest = createHash("sha256");
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(b, _, done) { sourceBytes += b.length; done(null, b); } }), createGzip(), new Transform({ transform(b, _, done) { storedBytes += b.length; digest.update(b); done(null, b); } }), createWriteStream(path, { flags: "wx" }));
  return { sourceBytes, storedBytes, sha256: digest.digest("hex") };
}

/** Does not mark the shared boundary recycled: the RTDB maintenance immediately following owns that transition. */
export async function recycleFirestoreCoverage(target, { boundary, caseName, invocationDir = evidenceRoot(target), fetchImpl = fetch, inspect = null, pin = pinnedFirestore } = {}) {
  const state = () => inspect ? inspect() : { invocation: readInvocationMeta(invocationDir), locks: tierLockStatus(), browsers: markedBrowsers() };
  assertCoverageBoundary({ target, boundary, ...await state() });
  const toolchain = await pin(target);
  const tree = target.stack.treeDir, config = JSON.parse(readFileSync(within(tree, "firebase.json"), "utf8"));
  need(typeof config.firestore?.rules === "string", "one staged Firestore rules file is required");
  const rulesPath = within(tree, config.firestore.rules), wanted = readFileSync(rulesPath), rulesSha256 = hash(wanted);
  need(target.projectId === "demo-bikeshed", "only the isolated demo project qualifies");
  const base = `/emulator/v1/projects/${encodeURIComponent(target.projectId)}`;
  const request = (path, options = {}) => {
    const url = `${new URL(target.firestoreUrl).origin}${path}`;
    assertReachable(target, url);
    return fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json" }, ...options });
  };
  const before = await request(`${base}:securityRules`);
  need(before.status === 200, "live rules unavailable");
  const source = (await before.json()).rules;
  need(source?.files?.length === 1 && source.files[0].content === wanted.toString(), "live rules differ from staged bytes");
  const deniedPath = `/v1/projects/${target.projectId}/databases/(default)/documents/e2e_maintenance_probe/missing`;
  const deniedBefore = await request(deniedPath);
  need([403, 404].includes(deniedBefore.status), `anonymous probe has an unexpected HTTP ${deniedBefore.status}`);
  await deniedBefore.arrayBuffer();
  const dir = join(invocationDir, "firestore-coverage"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json.gz`);
  const coverage = { artifact: relative(invocationDir, path), ...await archive(await request(`${base}:ruleCoverage`), path) };
  assertCoverageBoundary({ target, boundary, ...await state() });
  need(readFileSync(rulesPath).equals(wanted), "staged rules changed during the archive");
  const log = row => appendFileSync(join(invocationDir, "maintenance.jsonl"), JSON.stringify(row) + "\n");
  log({ at: new Date().toISOString(), event: "firestore-coverage-recycle-start", beforeCase: caseName, rulesSha256, toolchain, coverage });
  const channels = await retireFirestoreChannels(target, { fetchImpl, assertIdle: async () => assertCoverageBoundary({ target, boundary, ...await state() }) });
  const put = await request(`${base}:securityRules`, { method: "PUT", body: JSON.stringify({ rules: source, ignore_errors: false }) });
  const reapplied = put.status === 200 ? await put.json() : null;
  need(put.status === 200 && (reapplied.issues ?? []).every(issue => issue.severity === "WARNING"), `identical-rule reapply failed: HTTP ${put.status}`);
  const after = await request(`${base}:securityRules`);
  need(after.status === 200 && JSON.stringify((await after.json()).rules) === JSON.stringify(source), "live rules changed after maintenance");
  const fresh = await request(`${base}:ruleCoverage`);
  need(fresh.status === 200, "fresh coverage unavailable");
  const chunks = []; let size = 0;
  for await (const chunk of Readable.fromWeb(fresh.body)) {
    size += chunk.length;
    need(size <= Math.max(1024 * 1024, wanted.length * 50), "replacement coverage is unexpectedly large");
    chunks.push(chunk);
  }
  const report = JSON.parse(Buffer.concat(chunks).toString());
  need(JSON.stringify(report.rules) === JSON.stringify(source) && Array.isArray(report.report) && report.report.length > 0, "fresh coverage is not bound to exact rules");
  let expressions = 0;
  const empty = node => {
    if (!node || typeof node !== "object") return;
    if (Object.hasOwn(node, "values")) { expressions++; need(Array.isArray(node.values) && node.values.length === 0, "replacement tracker retains evaluated values"); }
    for (const [key, value] of Object.entries(node)) if (key !== "values") empty(value);
  };
  empty(report.report);
  // Protobuf JSON omits empty repeated fields, so source positions also prove the report has expressions.
  need(expressions > 0 || report.report.every(row => row.sourcePosition && !row.values), "fresh coverage has no inspectable expressions");
  const deniedAfter = await request(deniedPath);
  need(deniedAfter.status === deniedBefore.status, "anonymous rule enforcement changed");
  await deniedAfter.arrayBuffer();
  const row = { at: new Date().toISOString(), event: "firestore-coverage-recycled", beforeCase: caseName, rulesSha256, toolchain, coverage, mutation: "identical-rule-reapply", channels, warnings: reapplied.issues ?? [], freshCoverage: { bytes: size, expressions: report.report.length, retainedValues: 0 }, anonymousProbeStatus: deniedAfter.status };
  log(row);
  return row;
}
