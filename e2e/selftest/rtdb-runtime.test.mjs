// SPDX-License-Identifier: Apache-2.0
// Challenge the exact-byte unofficial RTDB derivation and its live launch/provenance boundary without starting an emulator (SPEC §12).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { crc32, deflateRawSync } from "node:zlib";
import { OUT_DIR, REPO_ROOT } from "../lib/paths.mjs";
import { firebaseTools } from "../lib/prerequisites.mjs";
import { installJavaWrapper } from "../lib/jvm.mjs";
import { capabilitiesFor } from "../lib/options.mjs";
import { RTDB_APPEND_CHANGE, RTDB_RUNTIME_CAPABILITY, beginRtdbInvocationChild, RTDB_STOCK_PIN, assertRtdbLaunchReceipt, deriveRtdbJar, inspectRtdbDerivation, readRtdbZipMember, parseClassMethods, prepareRtdbRuntime, verifyRtdbEngine, writeRtdbInvocationEvidence } from "../lib/rtdb-runtime.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const hash = b => createHash("sha256").update(b).digest("hex");
const require = createRequire(join(REPO_ROOT, "functions", "package.json")), AdmZip = require("adm-zip");
let stockCache, derivedCache;
function fixture() {
  if (!stockCache) {
    const firebase = firebaseTools(), load = createRequire(join(firebase.root, "package.json"));
    const database = load(join(firebase.root, "lib/emulator/downloadableEmulators.js")).getDownloadDetails("database");
    assert.ok(existsSync(database.downloadPath), "downloaded audited Database JAR is a prerequisite, not a skipped test");
    const stock = readFileSync(database.downloadPath);
    assert.deepEqual({ firebase: firebase.version, database: database.version, sha256: hash(stock) }, RTDB_STOCK_PIN);
    stockCache = { stock, sourcePath: database.downloadPath };
  }
  return stockCache;
}
function derived() { derivedCache ??= deriveRtdbJar(fixture().stock); return derivedCache; }

test("the pinned class parser identifies the actual method flags and unchanged Code bytes", () => {
  const bytes = new AdmZip(fixture().stock).getEntry(RTDB_APPEND_CHANGE.className).getData();
  const method = parseClassMethods(bytes).find(m => m.name === RTDB_APPEND_CHANGE.method && m.descriptor === RTDB_APPEND_CHANGE.descriptor);
  assert.equal(method.flagsOffset, 7665); assert.equal(method.flags, 1);
  assert.equal(method.attributes.find(a => a.name === "Code").sha256, RTDB_APPEND_CHANGE.codeSha256);
  for (const bad of [bytes.subarray(0, 100), Buffer.concat([bytes, Buffer.from([0])]), Buffer.from(bytes)]) {
    if (bad.length === bytes.length) bad[10] = 255;
    assert.throws(() => parseClassMethods(bad), /class|constant|unparsed|truncated/);
  }
});

test("only the single method flag byte changes; all other member payloads and method code stay identical", () => {
  const { stock } = fixture(), sourceBefore = hash(stock), { bytes, facts } = derived();
  assert.deepEqual(inspectRtdbDerivation(stock, bytes), facts);
  assert.deepEqual(facts.changedMembers, [RTDB_APPEND_CHANGE.className]);
  assert.equal(facts.memberCount, 17956);
  const a = new AdmZip(stock), b = new AdmZip(bytes);
  assert.deepEqual(b.getEntries().map(e => e.entryName), a.getEntries().map(e => e.entryName));
  const before = a.getEntry(RTDB_APPEND_CHANGE.className).getData(), after = b.getEntry(RTDB_APPEND_CHANGE.className).getData();
  assert.deepEqual([...before.keys()].filter(i => before[i] !== after[i]), [7666]);
  assert.equal(before[7666], 1); assert.equal(after[7666], 33);
  assert.equal(parseClassMethods(after).find(m => m.name === "addRuleResult").attributes.find(a => a.name === "Code").sha256, RTDB_APPEND_CHANGE.codeSha256);
  assert.equal(hash(stock), sourceBefore, "derivation does not mutate the supplied stock bytes");
  assert.deepEqual(deriveRtdbJar(stock).bytes, bytes, "canonical output is reproducible");
});

test("unknown stock, an unchanged stock posing as derived, and an extra archive mutation all refuse", () => {
  const { stock } = fixture(), { bytes } = derived();
  const unknown = Buffer.from(stock); unknown[0] ^= 1;
  assert.throws(() => deriveRtdbJar(unknown), /unrecognized stock/);
  assert.throws(() => inspectRtdbDerivation(stock, stock), /canonical one-bit/);
  const extra = Buffer.from(bytes); extra[extra.length - 1] ^= 1;
  assert.throws(() => inspectRtdbDerivation(stock, extra), /canonical one-bit/);
  const repacked = new AdmZip(bytes); repacked.addFile("unexpected.txt", Buffer.from("extra"));
  assert.throws(() => inspectRtdbDerivation(stock, repacked.toBuffer()), /canonical one-bit/);
  assert.throws(() => prepareRtdbRuntime({ firebase: "15.25.2", database: "4.11.2" }), /unreviewed CLI/);
});

test("canonical raw-splice verification refuses a valid unrelated ZIP comment change", () => {
  const { stock } = fixture(), { bytes } = derived();
  assert.equal(bytes.readUInt16LE(bytes.length - 2), 0, "canonical source has no archive comment");
  const commented = Buffer.concat([bytes, Buffer.from("unreviewed")]);
  commented.writeUInt16LE(10, bytes.length - 2);
  assert.equal(new AdmZip(commented).getEntries().length, 17956, "the counterexample remains a readable archive");
  assert.throws(() => inspectRtdbDerivation(stock, commented), /canonical one-bit/);
});

test("the durable archive/attestation verifies after launch-copy deletion and refuses attestation substitution", () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const dir = mkdtempSync(join(OUT_DIR, "rtdb-runtime-selftest-")), stackDir = join(dir, "stack"), runDir = join(dir, "run");
  mkdirSync(stackDir); mkdirSync(runDir);
  try {
    const engine = prepareRtdbRuntime({ firebase: RTDB_STOCK_PIN.firebase, database: RTDB_STOCK_PIN.database, sourcePath: fixture().sourcePath, stackDir, runDir });
    assert.deepEqual(verifyRtdbEngine(engine), derived().facts);
    assert.equal(hash(readFileSync(fixture().sourcePath)), RTDB_STOCK_PIN.sha256, "installed JAR remains untouched");
    rmSync(join(stackDir, "rtdb-runtime"), { recursive: true });
    assert.deepEqual(verifyRtdbEngine(engine), derived().facts, "ordinary teardown leaves independently inspectable bytes");
    assert.throws(() => verifyRtdbEngine({ ...engine, actualSha256: "a".repeat(64) }), /actualSha256/);
    const path = join(REPO_ROOT, engine.attestation.artifact), original = readFileSync(path); chmodSync(path, 0o600);
    writeFileSync(path, Buffer.concat([original, Buffer.from(" ")]));
    assert.throws(() => verifyRtdbEngine(engine), /attestation hash/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function launchFixture() {
  const engine = { kind: "request-context-sync-v1", label: "derived/unofficial diagnostic-append lock", actualPath: "/stack/rtdb-runtime/firebase-database-emulator-v4.11.2.jar", actualSha256: "a".repeat(64), profileSha256: "b".repeat(64) };
  const stack = { stackDir: "/stack", mark: "fixture-mark", tools: { java: "/usr/bin/java" }, jvm: { heapMb: { firestore: 2048, database: 1024, other: 512 } }, ports: { database: 30103, functions: 30104 } };
  const argv = ["/usr/bin/java", "-Xmx1024m", "-XX:+ExitOnOutOfMemoryError", "-XX:OnOutOfMemoryError=echo database %p >> '/stack/jvm/oom'", "-XX:ErrorFile=/stack/jvm/hs_err_pid%p.log", "-Duser.language=en", "-jar", engine.actualPath, "--host", "127.0.0.1", "--port", "30103", "--single_project_mode", "Warning", "--functions_emulator_host", "127.0.0.1", "--functions_emulator_port", "30104"];
  const receipt = { observedAt: "2026-10-15T00:00:00Z", liveDatabaseJvmCount: 1, pid: 100, startSec: 1000, mark: stack.mark, jarPath: engine.actualPath, actualSha256: engine.actualSha256, profileSha256: engine.profileSha256, heapMb: 1024, argv, commandLine: argv.join(" "), environmentTuning: { JAVA_TOOL_OPTIONS: null, JDK_JAVA_OPTIONS: null, _JAVA_OPTIONS: null }, rules: { namespace: "demo-bikeshed", stagedSha256: "c".repeat(64), liveSha256: "c".repeat(64) } };
  return { engine, stack, receipt };
}

test("runtime receipts retain ordinary arguments and reject hidden thread/heap/agent/path changes", () => {
  const good = launchFixture(); assert.equal(assertRtdbLaunchReceipt(good.receipt, good), good.receipt);
  for (const mutate of [
    r => { r.argv[1] = "-Xmx2048m"; }, r => { r.argv.splice(6, 0, "-XX:ActiveProcessorCount=1"); },
    r => { r.argv.splice(6, 0, "-Dscala.concurrent.context.numThreads=1"); }, r => { r.argv.splice(6, 0, "-javaagent:/fake.jar"); },
    r => { r.argv[7] = "/different.jar"; }, r => { r.argv.push("--host", "127.0.0.1"); },
    r => { r.argv.splice(-2); }, r => { r.environmentTuning.JAVA_TOOL_OPTIONS = "-Xmx2048m"; },
    r => { r.liveDatabaseJvmCount = 2; }, r => { r.mark = "another-stack"; }, r => { r.actualSha256 = "d".repeat(64); },
  ]) {
    const f = launchFixture(); mutate(f.receipt); f.receipt.commandLine = f.receipt.argv.join(" ");
    assert.throws(() => assertRtdbLaunchReceipt(f.receipt, f), /refused/);
  }
});

test("a runtime capability requires a matching verified live identity, not an intended derivation", () => {
  const f = launchFixture();
  assert.equal(capabilitiesFor({ rtdbEngine: f.engine }).has(RTDB_RUNTIME_CAPABILITY), false);
  assert.equal(capabilitiesFor({ rtdbEngine: { ...f.engine, live: f.receipt } }).has(RTDB_RUNTIME_CAPABILITY), true);
  for (const patch of [{ pid: 0 }, { actualSha256: "wrong" }, { profileSha256: "wrong" }, { jarPath: "/stock.jar" }]) assert.equal(capabilitiesFor({ rtdbEngine: { ...f.engine, live: { ...f.receipt, ...patch } } }).has(RTDB_RUNTIME_CAPABILITY), false);
});

test("the actual shell wrapper replaces only exact -jar argv and preserves spaces, empty values and all other arguments", () => {
  const dir = tempDir("e2e-rtdb-wrapper-"), fake = join(dir, "java-recorder");
  writeFileSync(fake, "#!/bin/sh\nprintf '%s\\000' \"$@\"\n", { mode: 0o755 });
  const sourcePath = join(dir, "stock folder", "firebase-database-emulator-v4.11.2.jar"), actualPath = join(dir, "derived folder", "firebase-database-emulator-v4.11.2-lock.jar");
  const paths = installJavaWrapper({ stackDir: dir, realJava: fake, heap: { firestore: 2048, database: 1024, other: 512 }, rtdbEngine: { sourcePath, actualPath } });
  const args = ["-Duser.language=en", "-jar", sourcePath, "--label", "quoted ' text", "--empty", ""];
  const r = spawnSync(paths.java, args); assert.equal(r.status, 0, r.stderr.toString());
  const got = r.stdout.toString().slice(0, -1).split("\0");
  assert.deepEqual(got.slice(4), args.map((a, i) => i === 2 ? actualPath : a));
  assert.deepEqual(got.slice(0, 2), ["-Xmx1024m", "-XX:+ExitOnOutOfMemoryError"]);
  const record = readdirSync(paths.jvmDir).find(n => n.startsWith("argv-"));
  assert.deepEqual(readFileSync(join(paths.jvmDir, record)).toString().slice(0, -1).split("\0"), [fake, ...got]);
  const wrong = spawnSync(paths.java, ["-jar", sourcePath + ".other"]); assert.equal(wrong.status, 70); assert.equal(wrong.stdout.length, 0);
  const ambiguous = spawnSync(paths.java, ["-jar", sourcePath, "-jar", sourcePath]); assert.equal(ambiguous.status, 70);
  const other = spawnSync(paths.java, ["-jar", "/fake/cloud-firestore-emulator-v0.jar", "--label", "two words"]);
  assert.equal(other.status, 0); assert.deepEqual(other.stdout.toString().slice(0, -1).split("\0").slice(4), ["-jar", "/fake/cloud-firestore-emulator-v0.jar", "--label", "two words"]);
  const before = readFileSync(paths.started, "utf8"), version = spawnSync(paths.java, ["-version"]);
  assert.equal(version.status, 0); assert.equal(readFileSync(paths.started, "utf8"), before, "version probe creates no JVM launch record");
});

test("invocation evidence cannot join receipts from a replaced JVM or changed rule/argument state", () => {
  const f = launchFixture(), dir = tempDir("e2e-rtdb-receipt-");
  const rec = { ...f.stack, runDir: dir, runId: "fixture", rtdbEngine: f.engine, fingerprint: { baseSha: "e".repeat(40), sha256: "f".repeat(64) }, expectVersion: "0.0.0" };
  const invocationDir = join(dir, "invocations", "fixture"); mkdirSync(invocationDir, { recursive: true });
  const args = { rec, invocationId: "fixture", invocationDir, before: f.receipt, parallelism: { concurrency: 1 }, locks: { concurrency: { mode: "exclusive" } } };
  assert.ok(writeRtdbInvocationEvidence({ ...args, after: structuredClone(f.receipt) }).sha256);
  for (const mutate of [r => { r.pid++; }, r => { r.startSec++; }, r => { r.rules.liveSha256 = "0".repeat(64); }]) {
    const after = structuredClone(f.receipt); mutate(after);
    assert.throws(() => writeRtdbInvocationEvidence({ ...args, after }), /changed during invocation/);
  }
});

test("a later child capture failure clears the earlier tier completion and updates its bound reference first", async () => {
  const f = launchFixture(), dir = tempDir("e2e-rtdb-later-receipt-");
  const rec = { ...f.stack, runDir: dir, runId: "fixture", rtdbEngine: f.engine, fingerprint: { baseSha: "e".repeat(40), sha256: "f".repeat(64) }, expectVersion: "0.0.0" };
  const invocationDir = join(dir, "invocations", "fixture"); mkdirSync(invocationDir, { recursive: true });
  const args = { rec, invocationId: "fixture", invocationDir, before: f.receipt, parallelism: { concurrency: 1 }, locks: { concurrency: { mode: "exclusive" } } };
  let reference = writeRtdbInvocationEvidence({ ...args, after: structuredClone(f.receipt) });
  const oldDigest = reference.sha256;
  await assert.rejects(beginRtdbInvocationChild(args, { capture: async () => { throw new Error("later capture failed"); }, record: value => { reference = value; } }), /later capture failed/);
  const bytes = readFileSync(join(invocationDir, "rtdb-runtime.json")), evidence = JSON.parse(bytes);
  assert.equal(evidence.after, null, "a later failed child cannot inherit an earlier completed runtime");
  assert.notEqual(reference.sha256, oldDigest, "the invocation reference is invalidated before capture");
  assert.equal(reference.sha256, hash(bytes), "the incomplete artifact remains exactly bound");
  assert.deepEqual(evidence.before, f.receipt, "the earliest before receipt still brackets the invocation");
  const source = readFileSync(join(REPO_ROOT, "e2e/run.mjs"), "utf8");
  assert.match(source, /if \(target\.rtdbEngine\) \{[\s\S]*?rtdbBefore = await beginRtdbInvocationChild[\s\S]*?const code = await nodeTest/, "every child starts through invalidation before nodeTest");
});

test("all member identities and the pinned profile verify within a 128 MiB JavaScript heap", () => {
  const program = `import { readFileSync } from "node:fs"; import { deriveRtdbJar, inspectRtdbDerivation } from ${JSON.stringify(new URL('../lib/rtdb-runtime.mjs',import.meta.url).href)}; const stock = readFileSync(process.argv[1]); const result = deriveRtdbJar(stock); const again = inspectRtdbDerivation(stock,result.bytes); if(JSON.stringify(again)!==JSON.stringify(result.facts)) throw Error("inspection is unstable"); console.log(JSON.stringify({facts:again,heapUsed:process.memoryUsage().heapUsed}));`;
  const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", program, fixture().sourcePath], { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, "bounded inspection completes before its fixed deadline");
  assert.equal(result.signal, null, `bounded inspection must not exhaust its heap or be killed: ${result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.facts.memberCount, 17956);
  assert.equal(actual.facts.actualSha256, "919e70261efbd666cd605621deb41f2dbf8c1d042a08b55e937bc06d8d09a18f");
  assert.equal(actual.facts.profileSha256, "ea69a817b0ba05d6193621617ad696700ff354575f87f474ea6ef0926f878b35");
  assert.deepEqual(actual.facts.changedMembers, [RTDB_APPEND_CHANGE.className]);
});

function zipMemberFixture({ data = Buffer.from("an independently checked member"), size = data.length, crc = crc32(data), suffix = Buffer.alloc(0), localName = "entry", centralName = "entry" } = {}) {
  const compressed = Buffer.concat([deflateRawSync(data), suffix]), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(Buffer.byteLength(localName), 26);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(Buffer.byteLength(centralName), 28);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + Buffer.byteLength(centralName), 12); end.writeUInt32LE(local.length + Buffer.byteLength(localName) + compressed.length, 16);
  return Buffer.concat([local, Buffer.from(localName), compressed, central, Buffer.from(centralName), end]);
}

test("the bounded ZIP reader validates actual payload CRC, size, compression consumption and local identity", () => {
  const data = Buffer.from("123456789");
  assert.equal(crc32(data), 0xcbf43926, "CRC uses the independent standard golden vector");
  assert.deepEqual(readRtdbZipMember(zipMemberFixture({ data }), "entry"), data);
  assert.equal(readRtdbZipMember(zipMemberFixture({ data: Buffer.alloc(0) }), "entry").length, 0, "empty entries remain valid");
  assert.throws(() => readRtdbZipMember(zipMemberFixture({ crc: 0 }), "entry"), /ZIP member CRC mismatch/, "matching corrupt header CRCs cannot attest changed payload bytes");
  assert.throws(() => readRtdbZipMember(zipMemberFixture({ size: 1024 * 1024 + 1 }), "entry"), /audited size bound/, "member size cannot request an unbounded inflate");
  assert.throws(() => readRtdbZipMember(zipMemberFixture({ size: 32 }), "entry"), /uncompressed member size differs/, "declared output length must equal actual bytes");
  assert.throws(() => readRtdbZipMember(zipMemberFixture({ size: 1 }), "entry"), /invalid or oversized compressed ZIP member/, "inflate stops at the declared output limit");
  assert.throws(() => readRtdbZipMember(zipMemberFixture({ suffix: Buffer.from([0]) }), "entry"), /trailing bytes/, "every declared compressed byte must belong to the deflate stream");
  assert.throws(() => readRtdbZipMember(zipMemberFixture({ localName: "other" }), "entry"), /member name differs/, "local and central filenames identify the same bytes");
  const mismatched = zipMemberFixture(); mismatched.writeUInt32LE(0, 14);
  assert.throws(() => readRtdbZipMember(mismatched, "entry"), /local\/central CRC or size differs/, "local metadata must agree before decompression");
  const encoding = zipMemberFixture(); encoding.writeUInt16LE(1, 6);
  assert.throws(() => readRtdbZipMember(encoding, "entry"), /unexpected ZIP member encoding/, "encrypted or descriptor-driven entries cannot qualify");
});
