// SPDX-License-Identifier: Apache-2.0
// Attest an unofficial per-stack RTDB diagnostic-append lock without changing rule evaluation or the installed emulator (SPEC §12).

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { OUT_DIR, REPO_ROOT, assertPath } from "./paths.mjs";
import { commandLine, environments, markedPids, processStartSecs } from "./proc.mjs";
import { jvmEvents } from "./jvm.mjs";
import { rtdbRulesFile } from "./patch.mjs";

const require = createRequire(join(REPO_ROOT, "functions", "package.json"));
const AdmZip = require("adm-zip"); // Existing Functions runtime dependency; no additional dependency.
export const RTDB_STOCK_PIN = Object.freeze({ firebase: "15.25.1", database: "4.11.2", sha256: "b70d99344caf17c98b6f910fa8f6edf32a7c016cb1035e8915f70d38901eb97f" });
export const RTDB_DERIVED_PIN = Object.freeze({ actualSha256: "919e70261efbd666cd605621deb41f2dbf8c1d042a08b55e937bc06d8d09a18f", profileSha256: "ea69a817b0ba05d6193621617ad696700ff354575f87f474ea6ef0926f878b35" });
export const RTDB_RUNTIME_KIND = "request-context-sync-v1";
export const RTDB_RUNTIME_CAPABILITY = "rtdb-diagnostic-append-lock";
export const RTDB_APPEND_CHANGE = Object.freeze({ className: "com/firebase/util/data/RequestContext.class", originalClassSha256: "31ddf8db47ec01b28a2640f410bcde236d0c9b9c699398aad56ca881f9b9a0c9", method: "addRuleResult", descriptor: "(Lcom/firebase/util/data/RuleResult;)V", flagsOffset: 7665, flagsBefore: 1, flagsAfter: 33, codeSha256: "eb0ac01eda5c4740426777a0237882b33611c778da07310436d21ecb3952ea0a" });
const hash = data => createHash("sha256").update(data).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const need = (ok, reason) => { if (!ok) throw Object.assign(new Error(`RTDB derived runtime refused: ${reason}`), { code: "E2E_RTDB_RUNTIME" }); };
const regular = path => { need(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "artifact is not a regular file"); return readFileSync(path); };

/** A bounded classfile parser locates method_info; no bytecode is synthesized. */
export function parseClassMethods(bytes) {
  let p = 0;
  const take = n => { need(Number.isSafeInteger(n) && n >= 0 && p + n <= bytes.length, "truncated classfile"); const at = p; p += n; return at; };
  const u1 = () => bytes.readUInt8(take(1));
  const u2 = () => bytes.readUInt16BE(take(2));
  const u4 = () => bytes.readUInt32BE(take(4));
  need(u4() === 0xcafebabe, "not a classfile"); take(4);
  const count = u2(), strings = new Map();
  for (let i = 1; i < count; i++) {
    const tag = u1();
    if (tag === 1) { const size = u2(); strings.set(i, bytes.subarray(take(size), p).toString("utf8")); }
    else if ([3, 4, 9, 10, 11, 12, 17, 18].includes(tag)) take(4);
    else if ([5, 6].includes(tag)) { take(8); i++; }
    else if ([7, 8, 16, 19, 20].includes(tag)) take(2);
    else if (tag === 15) take(3);
    else need(false, `unknown constant-pool tag ${tag}`);
  }
  const string = i => { need(strings.has(i), "invalid attribute/name constant"); return strings.get(i); };
  const attributes = () => {
    const rows = [];
    for (let n = u2(); n > 0; n--) { const name = string(u2()), size = u4(), offset = take(size); rows.push({ name, size, sha256: hash(bytes.subarray(offset, offset + size)) }); }
    return rows;
  };
  take(6); take(u2() * 2);
  for (let n = u2(); n > 0; n--) { take(6); attributes(); }
  const methods = [];
  for (let n = u2(); n > 0; n--) {
    const flagsOffset = p, flags = u2(), name = string(u2()), descriptor = string(u2());
    methods.push({ flagsOffset, flags, name, descriptor, attributes: attributes() });
  }
  attributes(); need(p === bytes.length, "unparsed class bytes");
  return methods;
}

function changedClass(bytes) {
  const pin = RTDB_APPEND_CHANGE;
  need(hash(bytes) === pin.originalClassSha256, "unrecognized RequestContext class");
  const methods = parseClassMethods(bytes), selected = methods.filter(m => m.name === pin.method && m.descriptor === pin.descriptor);
  need(selected.length === 1, "method descriptor is not unique");
  const m = selected[0];
  need(m.flags === pin.flagsBefore && m.flagsOffset === pin.flagsOffset && m.attributes.find(a => a.name === "Code")?.sha256 === pin.codeSha256, "method flags, offset or Code changed");
  const result = Buffer.from(bytes); result.writeUInt16BE(pin.flagsAfter, m.flagsOffset);
  const changed = [...bytes.keys()].filter(i => bytes[i] !== result[i]);
  need(same(changed, [pin.flagsOffset + 1]), "mutation is not the one synchronization bit");
  const expected = methods.map(row => row === m ? { ...row, flags: pin.flagsAfter } : row);
  need(same(parseClassMethods(result), expected), "method attributes changed");
  return result;
}

/** Read only ordinary single-disk ZIP central headers; the stock hash makes this deliberately narrow. */
function zipDirectory(bytes) {
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
  need(end >= 0, "missing ZIP end record");
  need(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, "multi-disk ZIP");
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  need(count !== 65535 && count === bytes.readUInt16LE(end + 8) && offset + size === end, "ZIP64 or unusual central directory");
  const rows = [], names = new Set(); let p = offset;
  for (let i = 0; i < count; i++) {
    need(p + 46 <= end && bytes.readUInt32LE(p) === 0x02014b50, "invalid central header");
    const nameSize = bytes.readUInt16LE(p + 28), extraSize = bytes.readUInt16LE(p + 30), commentSize = bytes.readUInt16LE(p + 32), next = p + 46 + nameSize + extraSize + commentSize;
    need(next <= end, "truncated central header");
    const name = bytes.subarray(p + 46, p + 46 + nameSize).toString("utf8");
    need(!names.has(name), "duplicate ZIP member"); names.add(name);
    need(!/^META-INF\/.*\.(?:SF|RSA|DSA|EC)$/i.test(name), "signed JAR needs separate review");
    rows.push({ name, central: p, local: bytes.readUInt32LE(p + 42), compressed: bytes.readUInt32LE(p + 20), size: bytes.readUInt32LE(p + 24), crc: bytes.readUInt32LE(p + 16), flags: bytes.readUInt16LE(p + 8), method: bytes.readUInt16LE(p + 10) });
    p = next;
  }
  need(p === end, "extra central directory bytes");
  return { end, offset, rows };
}

/** Preserve every other compressed member and header; only target CRC/size and shifted offsets change. */
function canonicalDerived(stock) {
  need(hash(stock) === RTDB_STOCK_PIN.sha256, "unrecognized stock JAR");
  const directory = zipDirectory(stock), row = directory.rows.find(e => e.name === RTDB_APPEND_CHANGE.className);
  need(row && row.flags === 0 && row.method === 8, "unexpected target ZIP encoding");
  const zip = new AdmZip(stock), before = zip.getEntry(row.name).getData(), after = changedClass(before);
  const entry = new AdmZip(stock).getEntry(row.name); entry.setData(after);
  const compressed = deflateRawSync(after), crc = entry.header.crc, delta = compressed.length - row.compressed;
  need(stock.readUInt32LE(row.local) === 0x04034b50 && stock.readUInt16LE(row.local + 6) === 0 && stock.readUInt16LE(row.local + 8) === 8, "unexpected target local header");
  const start = row.local + 30 + stock.readUInt16LE(row.local + 26) + stock.readUInt16LE(row.local + 28), oldEnd = start + row.compressed;
  need(oldEnd <= directory.offset, "target overlaps directory");
  const prefix = Buffer.from(stock.subarray(0, start));
  prefix.writeUInt32LE(crc, row.local + 14); prefix.writeUInt32LE(compressed.length, row.local + 18);
  const central = Buffer.from(stock.subarray(directory.offset, directory.end));
  for (const item of directory.rows) {
    const at = item.central - directory.offset;
    if (item.local > row.local) central.writeUInt32LE(item.local + delta, at + 42);
    if (item === row) { central.writeUInt32LE(crc, at + 16); central.writeUInt32LE(compressed.length, at + 20); }
  }
  const end = Buffer.from(stock.subarray(directory.end)); end.writeUInt32LE(directory.offset + delta, 16);
  return Buffer.concat([prefix, compressed, stock.subarray(oldEnd, directory.offset), central, end]);
}

/** Independently inspect archive payloads and demand the canonical raw splice, not an attestation's claims. */
export function inspectRtdbDerivation(stock, derived) {
  need(hash(stock) === RTDB_STOCK_PIN.sha256, "unrecognized stock JAR");
  need(derived.equals(canonicalDerived(stock)), "derived archive differs from the canonical one-bit transform");
  const originalDirectory = zipDirectory(stock), nextDirectory = zipDirectory(derived);
  need(same(originalDirectory.rows.map(r => r.name), nextDirectory.rows.map(r => r.name)), "ZIP member order changed");
  const a = new AdmZip(stock), b = new AdmZip(derived), members = [], changedMembers = [];
  for (const row of originalDirectory.rows) {
    const before = a.getEntry(row.name).getData(), after = b.getEntry(row.name).getData();
    const changed = !before.equals(after);
    if (changed) changedMembers.push(row.name);
    need(row.name === RTDB_APPEND_CHANGE.className ? after.equals(changedClass(before)) : !changed, `unexpected changed member ${row.name}`);
    members.push([row.name, hash(before), hash(after)]);
  }
  need(same(changedMembers, [RTDB_APPEND_CHANGE.className]), "changed member inventory differs");
  const facts = { kind: RTDB_RUNTIME_KIND, originalSha256: hash(stock), actualSha256: hash(derived), mutation: RTDB_APPEND_CHANGE, afterClassSha256: hash(b.getEntry(RTDB_APPEND_CHANGE.className).getData()), memberCount: members.length, membersSha256: hash(JSON.stringify(members)), changedMembers };
  return { ...facts, profileSha256: hash(JSON.stringify(facts)) };
}

export function deriveRtdbJar(stock) {
  const bytes = canonicalDerived(stock);
  const facts = inspectRtdbDerivation(stock, bytes);
  for (const key of ["actualSha256", "profileSha256"]) need(facts[key] === RTDB_DERIVED_PIN[key], `derived ${key} is not the reviewed runtime`);
  return { bytes, facts };
}

function confined(base, path) {
  assertPath(base); assertPath(path);
  const rel = relative(base, path); need(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "artifact escapes its root");
  return path;
}

/** A content-addressed file is published exclusively; an existing artifact must match exactly. */
function archiveOnce(bytes, archiveRoot) {
  mkdirSync(archiveRoot, { recursive: true }); need(realpathSync(archiveRoot) === resolve(archiveRoot), "archive root contains a symlink");
  const digest = hash(bytes), dest = join(archiveRoot, `${digest}.jar`), temp = join(archiveRoot, `.${digest}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  if (!existsSync(dest)) {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o400 });
    try { linkSync(temp, dest); } catch (err) { if (err.code !== "EEXIST") throw err; }
    finally { unlinkSync(temp); }
  }
  need(hash(regular(dest)) === digest, "archived JAR differs from its content address");
  return dest;
}

/** Called before spawn only, never for the standalone rules command or an already running JVM. */
export function prepareRtdbRuntime({ firebase, database, sourcePath, stackDir, runDir, archiveRoot = join(OUT_DIR, "runtime-artifacts", "rtdb") }) {
  need(firebase === RTDB_STOCK_PIN.firebase && database === RTDB_STOCK_PIN.database, "unreviewed CLI or Database version");
  assertPath(sourcePath); need(realpathSync(sourcePath) === sourcePath, "selected stock path is not canonical");
  const stock = regular(sourcePath), { bytes, facts } = deriveRtdbJar(stock);
  const dir = confined(stackDir, join(stackDir, "rtdb-runtime")); mkdirSync(dir, { recursive: true }); need(realpathSync(dir) === dir, "runtime directory contains a symlink");
  const actualPath = join(dir, "firebase-database-emulator-v4.11.2-request-context-sync-v1.jar");
  writeFileSync(actualPath, bytes, { flag: "wx", mode: 0o400 }); chmodSync(actualPath, 0o400);
  need(same(inspectRtdbDerivation(stock, regular(actualPath)), facts), "launch JAR failed readback");
  const originalArtifact = archiveOnce(stock, archiveRoot), derivedArtifact = archiveOnce(bytes, archiveRoot);
  const attestation = { schemaVersion: 1, kind: "rtdb-derivation-attestation", inspection: facts, archives: { original: { artifact: relative(REPO_ROOT, originalArtifact), sha256: facts.originalSha256 }, derived: { artifact: relative(REPO_ROOT, derivedArtifact), sha256: facts.actualSha256 } } };
  const artifact = confined(runDir, join(runDir, "rtdb-runtime-attestation.json"));
  const encoded = Buffer.from(JSON.stringify(attestation, null, 2) + "\n"); writeFileSync(artifact, encoded, { flag: "wx", mode: 0o400 });
  need(hash(regular(sourcePath)) === RTDB_STOCK_PIN.sha256, "installed JAR changed during derivation");
  return { kind: facts.kind, label: "derived/unofficial diagnostic-append lock", firebaseVersion: firebase, databaseVersion: database, originalSha256: facts.originalSha256, actualSha256: facts.actualSha256, profileSha256: facts.profileSha256, sourcePath, actualPath, attestation: { artifact: relative(REPO_ROOT, artifact), sha256: hash(encoded) }, live: null };
}

/** Offline verification survives ordinary stack teardown: it reads the archived pair, not launch bytes. */
export function verifyRtdbEngine(engine) {
  need(engine?.kind === RTDB_RUNTIME_KIND && engine.label === "derived/unofficial diagnostic-append lock", "runtime is not the reviewed unofficial transform");
  need(engine.firebaseVersion === RTDB_STOCK_PIN.firebase && engine.databaseVersion === RTDB_STOCK_PIN.database, "runtime versions changed");
  const path = confined(REPO_ROOT, resolve(REPO_ROOT, engine.attestation?.artifact ?? "")), bytes = regular(path);
  need(hash(bytes) === engine.attestation.sha256, "attestation hash mismatch");
  const a = JSON.parse(bytes);
  need(a.schemaVersion === 1 && a.kind === "rtdb-derivation-attestation", "unsupported attestation schema");
  const archive = ref => { const p = confined(join(OUT_DIR, "runtime-artifacts", "rtdb"), resolve(REPO_ROOT, ref.artifact)); const bytes = regular(p); need(hash(bytes) === ref.sha256 && p.endsWith(`/${ref.sha256}.jar`), "archive identity mismatch"); return bytes; };
  const facts = inspectRtdbDerivation(archive(a.archives.original), archive(a.archives.derived));
  for (const key of ["kind", "originalSha256", "actualSha256", "profileSha256"]) need(engine[key] === facts[key], `runtime ${key} differs from verified bytes`);
  need(same(a.inspection, facts), "attestation inventory differs from verified archive");
  for (const key of ["actualSha256", "profileSha256"]) need(facts[key] === RTDB_DERIVED_PIN[key], `derived ${key} is not the reviewed runtime`);
  return facts;
}

/** A capability is advertised only after startup verified the live process as well as its bytes. */
export function hasVerifiedRtdbRuntime(engine) {
  return engine?.kind === RTDB_RUNTIME_KIND && engine?.live?.actualSha256 === engine.actualSha256 && engine.live.profileSha256 === engine.profileSha256 && engine.live.jarPath === engine.actualPath && Number.isInteger(engine.live.pid) && engine.live.pid > 1 && Number.isFinite(engine.live.startSec);
}

/** Recheck the source-owned launch allowlist from durable receipts after the JVM/tree are gone. */
export function assertRtdbLaunchReceipt(receipt, { engine, stack }) {
  need(receipt.liveDatabaseJvmCount === 1, "not exactly one live Database JVM");
  need(receipt.mark === stack.mark && Number.isInteger(receipt.pid) && receipt.pid > 1 && Number.isFinite(receipt.startSec), "runtime process identity is invalid");
  need(receipt.jarPath === engine.actualPath && receipt.actualSha256 === engine.actualSha256 && receipt.profileSha256 === engine.profileSha256, "runtime receipt identity differs");
  const argv = receipt.argv, heapMb = stack.jvm?.heapMb?.database;
  need(Array.isArray(argv) && argv.every(a => typeof a === "string" && !a.includes("\0")), "invalid launch argv");
  const indices = argv.flatMap((arg, i) => arg === "-jar" ? [i] : []), jarAt = indices[0];
  need(indices.length === 1 && argv[jarAt + 1] === engine.actualPath && receipt.commandLine === argv.join(" "), "live argv differs from derived launch");
  need(argv[0] === stack.tools.java && receipt.heapMb === heapMb && argv[1] === `-Xmx${heapMb}m` && argv[2] === "-XX:+ExitOnOutOfMemoryError", "ordinary heap/OOM arguments changed");
  need(argv[3] === `-XX:OnOutOfMemoryError=echo database %p >> '${join(stack.stackDir, "jvm", "oom")}'` && argv[4] === `-XX:ErrorFile=${join(stack.stackDir, "jvm", "hs_err_pid%p.log")}`, "ordinary JVM diagnostics changed");
  need(same(argv.slice(5, jarAt), ["-Duser.language=en"]), "unexpected JVM tuning/agent option");
  const appArgs = argv.slice(jarAt + 2), allowed = new Map([["--host", "127.0.0.1"], ["--port", String(stack.ports.database)], ["--functions_emulator_host", "127.0.0.1"], ["--functions_emulator_port", String(stack.ports.functions)], ["--single_project_mode", "Warning"]]);
  need(appArgs.length % 2 === 0, "odd Database option count");
  const seen = new Set();
  for (let i = 0; i < appArgs.length; i += 2) { need(allowed.has(appArgs[i]) && allowed.get(appArgs[i]) === appArgs[i + 1] && !seen.has(appArgs[i]), "unknown or changed Database application option"); seen.add(appArgs[i]); }
  need(seen.size === allowed.size, "ordinary Database arguments are missing");
  need(same(receipt.environmentTuning, { JAVA_TOOL_OPTIONS: null, JDK_JAVA_OPTIONS: null, _JAVA_OPTIONS: null }), "ambient JVM tuning is present");
  return receipt;
}

/** The wrapper captures exact NUL-separated arguments; ps and ownership must independently agree. */
export function inspectRtdbLaunch(rec) {
  const engine = rec.rtdbEngine; verifyRtdbEngine(engine);
  const jobs = jvmEvents(rec.stackDir).started.filter(j => j.role === "database" && j.alive);
  need(jobs.length === 1, "exactly one live Database JVM is required");
  const pid = jobs[0].pid, startSec = processStartSecs([pid]).get(pid), cmd = commandLine(pid);
  need(Number.isFinite(startSec) && markedPids(rec.mark, [pid]).has(pid), "Database PID/start/stack ownership is unverified");
  const raw = regular(join(rec.stackDir, "jvm", `argv-${pid}`)); need(raw.at(-1) === 0, "launch argv is truncated");
  const argv = raw.toString("utf8").slice(0, -1).split("\0"), indices = argv.flatMap((a, i) => a === "-jar" ? [i] : []);
  need(indices.length === 1 && argv[indices[0] + 1] === engine.actualPath && cmd === argv.join(" "), "live JVM arguments differ from recorded derived launch");
  const heapMb = rec.jvm?.heapMb?.database;
  need(argv[1] === `-Xmx${heapMb}m` && argv[2] === "-XX:+ExitOnOutOfMemoryError", "ordinary heap/OOM arguments changed");
  const env = environments([pid]).get(pid), environmentTuning = {};
  need(typeof env === "string" && env.length > 0, "runtime environment is unavailable");
  for (const key of ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]) { need(!new RegExp(`(?:^|\\s)${key}=`).test(env), `ambient ${key} is present`); environmentTuning[key] = null; }
  need(hash(regular(engine.actualPath)) === engine.actualSha256, "live launch JAR changed");
  return assertRtdbLaunchReceipt({ observedAt: new Date().toISOString(), liveDatabaseJvmCount: jobs.length, pid, startSec, mark: rec.mark, jarPath: engine.actualPath, actualSha256: engine.actualSha256, profileSha256: engine.profileSha256, heapMb, argv, commandLine: cmd, environmentTuning }, { engine, stack: rec });
}

/** Read-only runtime/rule snapshot outside the spec child; rules and ordinary data are never changed here. */
export async function captureRtdbRuntime(rec, { fetchImpl = fetch } = {}) {
  const live = inspectRtdbLaunch(rec), namespace = rec.projectId;
  const config = JSON.parse(readFileSync(join(rec.treeDir, "firebase.json"), "utf8")), rel = rtdbRulesFile(config, namespace);
  need(rel, "staged Database rules are missing");
  const rules = regular(confined(rec.treeDir, resolve(rec.treeDir, rel))), stagedSha256 = hash(rules);
  const response = await fetchImpl(`http://127.0.0.1:${rec.ports.database}/.settings/rules.json?ns=${encodeURIComponent(namespace)}`, { headers: { authorization: "Bearer owner" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  need(response.status === 200, "live rules could not be read");
  const liveSha256 = hash(Buffer.from(await response.arrayBuffer())); need(liveSha256 === stagedSha256, "live and staged rules differ");
  need(processStartSecs([live.pid]).get(live.pid) === live.startSec && commandLine(live.pid) === live.commandLine, "Database process changed during snapshot");
  return { ...live, rules: { namespace, stagedSha256, liveSha256 } };
}

/** The archived derived JAR is retained after a disposable stack has been stopped. */
export function verifiedRtdbArchive(engine) {
  verifyRtdbEngine(engine);
  const a = JSON.parse(regular(confined(REPO_ROOT, resolve(REPO_ROOT, engine.attestation.artifact))));
  return resolve(REPO_ROOT, a.archives.derived.artifact);
}

/** Persist a before/after receipt; a missing after remains explicitly incomplete evidence. */
export function writeRtdbInvocationEvidence({ rec, invocationId, invocationDir, before, after = null, parallelism, locks }) {
  need(typeof invocationId === "string" && /^[a-f0-9]{64}$/.test(rec.fingerprint?.sha256 ?? ""), "missing invocation/source identity");
  assertRtdbLaunchReceipt(before, { engine: rec.rtdbEngine, stack: rec });
  if (after) {
    assertRtdbLaunchReceipt(after, { engine: rec.rtdbEngine, stack: rec });
    for (const key of ["pid", "startSec", "mark", "jarPath", "actualSha256", "profileSha256", "heapMb"]) need(before[key] === after[key], `runtime ${key} changed during invocation`);
    need(same(before.argv, after.argv) && same(before.rules, after.rules), "launch arguments or rules changed during invocation");
  }
  const envelope = { schemaVersion: 1, runId: rec.runId, invocationId, fingerprint: rec.fingerprint.sha256, revision: rec.fingerprint.baseSha, version: rec.expectVersion, engine: rec.rtdbEngine, before, after, parallelism, locks };
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + "\n"), file = confined(rec.runDir, join(invocationDir, "rtdb-runtime.json"));
  writeFileSync(file, bytes);
  return { artifact: relative(REPO_ROOT, file), sha256: hash(bytes) };
}

/** Invalidate an earlier tier's completed receipt before a later capture or child can fail. */
export async function beginRtdbInvocationChild(args, { capture = captureRtdbRuntime, record } = {}) {
  need(typeof record === "function", "invocation evidence recorder is missing");
  if (args.before) record(writeRtdbInvocationEvidence({ ...args, after: null }));
  const observed = await capture(args.rec), before = args.before ?? observed;
  record(writeRtdbInvocationEvidence({ ...args, before, after: null }));
  return before;
}
