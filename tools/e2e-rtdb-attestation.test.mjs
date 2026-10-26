// SPDX-License-Identifier: Apache-2.0
// Real archived-byte provenance fixtures reject forged, cross-run and incomplete RTDB acceptance evidence (SPEC §12).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRtdbFixture } from "./e2e-rtdb-test-fixture.mjs";
import { createRtdbAttestationCache, assertRtdbAttestationCacheUnchanged, verifyRtdbRunAttestation, assertSameRtdbControlEngine } from "./e2e-rtdb-attestation.mjs";
const root=realpathSync(mkdtempSync(join(tmpdir(),"rtdb-attestation-fixtures-"))), cache=createRtdbAttestationCache();
const check=f=>verifyRtdbRunAttestation(f.campaign,{report:f.report,stack:f.stack,rel:f.rel},{root:f.root,cache});
after(()=>{assertRtdbAttestationCacheUnchanged(cache);rmSync(root,{recursive:true,force:true});});
test("real pinned derived bytes and complete fixture evidence qualify without relabeling the runtime",()=>{
  const f=createRtdbFixture(root,{suffix:"valid"});const got=check(f);assert.equal(got.unofficial,true);assert.equal(got.engine.kind,"request-context-sync-v1");
});
test("explicit stock fixture policy preserves original hash validity and cannot imply derived evidence",()=>{
  const f=createRtdbFixture(root,{suffix:"stock",stock:true});const got=check(f);assert.equal(got.unofficial,false);assert.equal(got.engine.originalSha256,got.engine.actualSha256);
});
const variants=[
 ["missing-policy",f=>delete f.campaign.acceptance.rtdbEngine,/acceptance must explicitly choose/],
 ["unknown-original",f=>f.stack.rtdbEngine.originalSha256="f".repeat(64),/unknown original/],
 ["unknown-derived",f=>f.stack.rtdbEngine.actualSha256="f".repeat(64),/actualSha256 is unknown/],
 ["unknown-profile",f=>f.stack.rtdbEngine.profileSha256="f".repeat(64),/profileSha256 is unknown/],
 ["stock-mislabeled-derived",f=>f.stack.rtdbEngine.actualSha256=f.stack.rtdbEngine.originalSha256,/actualSha256 is unknown|mislabeled/],
 ["unofficial-label-hidden",f=>f.stack.rtdbEngine.label="official",/label is unknown/],
 ["source-revision",f=>f.stack.fingerprint.baseSha="f".repeat(40),/source derivation: revision differs/],
 ["source-version",f=>f.stack.expectVersion="0.0.0",/source derivation: version differs/],
 ["source-fingerprint",f=>f.stack.fingerprint.sha256="f".repeat(64),/source fingerprint differs/],
 ["stack-run-identity",f=>f.stack.runId="other",/report\/stack run/],
 ["heap-map",f=>f.stack.jvm.heapMb.database=2048,/ordinary stack heap/],
 ["unfinished",f=>delete f.done.endedAt,/invocation did not finish/],
 ["interrupted",f=>f.done.interrupted="SIGINT",/invocation did not finish/],
 ["stack-down",f=>f.done.stackDown=true,/invocation did not finish/],
 ["unknown-exit",f=>f.done.exit=9,/invocation did not finish/],
 ["completed-id",f=>f.done.id="other",/completed invocation identity/],
 ["selection",f=>f.done.n=[5],/report n differs/],
 ["runtime-run",f=>f.runtime.runId="other",/runtime envelope identity/],
 ["runtime-invocation",f=>f.runtime.invocationId="other",/runtime envelope identity/],
 ["runtime-revision",f=>f.runtime.revision="f".repeat(40),/runtime envelope identity/],
 ["runtime-version",f=>f.runtime.version="0.0.0",/runtime envelope identity/],
 ["runtime-fingerprint",f=>f.runtime.fingerprint="f".repeat(64),/runtime envelope identity/],
 ["runtime-path",f=>f.runtime.engine.actualPath="other",/runtime actualPath differs/],
 ["invocation-path",f=>{f.done.rtdbEngine.actualPath="other";f.report.invocation.rtdbEngine.actualPath="other";},/invocation actualPath differs/],
 ["file-parallelism",f=>{for(const x of [f.runtime,f.done,f.report.invocation])x.parallelism.concurrency=2;},/concurrency file parallelism/],
 ["tier-lock",f=>{for(const x of [f.runtime,f.done,f.report.invocation])x.locks.concurrency.mode="exclusive";},/lock selection changed/],
 ["forged-attestation",f=>f.attestation.inspection.mutation.flagsAfter=1,/independent byte\/member\/method\/Code inspection/],
 ["attestation-archive",f=>f.attestation.archives.derived.artifact="e2e\/.out\/other.jar",/attestation archive references/],
 ["missing-after",f=>f.runtime.after=null,/after JVM identity missing/],
 ["wrong-jvm-count",f=>f.runtime.after.liveDatabaseJvmCount=2,/exactly one Database JVM/],
 ["wrong-pid",f=>f.runtime.after.pid=4321,/runtime pid changed/],
 ["wrong-start",f=>f.runtime.after.startSec+=1,/runtime startSec changed/],
 ["wrong-mark",f=>f.runtime.after.mark="other",/JVM belongs to another stack/],
 ["wrong-actual-jar",f=>f.runtime.after.jarPath="other.jar",/actual JVM JAR differs/],
 ["wrong-observed-hash",f=>f.runtime.after.actualSha256="f".repeat(64),/actual JVM JAR differs/],
 ["observed-heap",f=>f.runtime.after.heapMb=2048,/observed Database heap/],
 ["java-env",f=>f.runtime.after.environmentTuning.JAVA_TOOL_OPTIONS="-Xmx2g",/external Java tuning/],
 ["java-agent",f=>{f.runtime.after.argv.splice(5,0,"-javaagent:other.jar");f.runtime.after.commandLine=f.runtime.after.argv.join(" ");},/concurrency or instrumentation flags/],
 ["java-unknown-option",f=>{f.runtime.after.argv.splice(5,0,"-Dunknown=true");f.runtime.after.commandLine=f.runtime.after.argv.join(" ");},/unexpected JVM tuning/],
 ["rule-drift",f=>f.runtime.after.rules.liveSha256="f".repeat(64),/exact live\/staged rules differ/],
 ["outside-invocation",f=>f.runtime.after.observedAt="2026-10-15T10:00:06.000Z",/outside completed invocation/],
 ["old-tier-after",f=>f.runtime.after.observedAt="2026-10-15T10:00:01.500Z",/after receipt predates a reported case/],
 ["late-before",f=>f.runtime.before.observedAt="2026-10-15T10:00:02.500Z",/before receipt follows a reported case/],
 ["case-at-missing",f=>delete f.records[0].at,/timestamp is missing or invalid/],
 ["case-at-invalid",f=>f.records[0].at="not-a-time",/timestamp is missing or invalid/],
 ["later-raw-only-case",f=>f.records.push({...f.records[0],id:"later",at:"2026-10-15T10:00:04.500Z"}),/after receipt predates a reported case/],
 ["duplicate-raw-case",f=>f.records.push({...f.records[0]}),/identity missing or duplicated/],
];
for(const [name,mutate,diagnostic]of variants)test(`RTDB provenance rejects ${name}`,()=>{
  const f=createRtdbFixture(root,{suffix:name});mutate(f);f.flush();assert.throws(()=>check(f),diagnostic);
});
test("product controls cannot pair stock and derived engines",()=>{
  const green=check(createRtdbFixture(root,{suffix:"green-pair"})),red=check(createRtdbFixture(root,{suffix:"red-pair",stock:true}));
  assert.throws(()=>assertSameRtdbControlEngine(red,green),/different runtime engines/);
});
test("cached archives cannot grandfather a different proof identity",()=>{
  const f=createRtdbFixture(root,{suffix:"cached-identity"});check(f);f.report.runId="other";assert.throws(()=>check(f),/report\/stack run/);
});
test("late artifact changes are rejected at operation finalization",()=>{
  const local=createRtdbAttestationCache(),f=createRtdbFixture(root,{suffix:"late-mutation"});
  verifyRtdbRunAttestation(f.campaign,{report:f.report,stack:f.stack,rel:f.rel},{root,cache:local});
  const path=join(root,dirname(f.rel),"rtdb-runtime.json");writeFileSync(path,readFileSync(path,"utf8")+" ");
  assert.throws(()=>assertRtdbAttestationCacheUnchanged(local),/changed before final acceptance/);
});
test("closed operation tokens cannot be reused",()=>{
  const local=createRtdbAttestationCache();assertRtdbAttestationCacheUnchanged(local);
  const f=createRtdbFixture(root,{suffix:"closed"});assert.throws(()=>verifyRtdbRunAttestation(f.campaign,{report:f.report,stack:f.stack,rel:f.rel},{root,cache:local}),/open operation-scoped token/);
});
