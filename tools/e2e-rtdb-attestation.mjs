// SPDX-License-Identifier: Apache-2.0
// Independently bind retained RTDB runtime bytes and live JVM observations to exact campaign evidence (SPEC §12).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { RTDB_COVERAGE_PIN } from "../e2e/lib/rtdb-coverage.mjs";
import { inspectRtdbDerivation, assertRtdbLaunchReceipt } from "../e2e/lib/rtdb-runtime.mjs";
import { tierLockMode } from "../e2e/lib/locks.mjs";

export const APPROVED_RTDB_DERIVATION = Object.freeze({
  kind: "request-context-sync-v1",
  label: "derived/unofficial diagnostic-append lock",
  profileSha256: "ea69a817b0ba05d6193621617ad696700ff354575f87f474ea6ef0926f878b35",
  actualSha256: "919e70261efbd666cd605621deb41f2dbf8c1d042a08b55e937bc06d8d09a18f",
});
const SHA = /^[a-f0-9]{64}$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(`RTDB attestation: ${message}`); };
const equal = (a,b,message) => assert.deepEqual(a,b,`RTDB attestation: ${message}`);
const identity = engine => Object.fromEntries(["kind","label","firebaseVersion","databaseVersion","originalSha256","actualSha256","profileSha256"].map(k=>[k,engine?.[k]??null]));
const DEFAULT_HEAPS = Object.freeze({ firestore: 2048, database: 1024, other: 512 });
const JAVA_TUNING = Object.freeze({ JAVA_TOOL_OPTIONS: null, JDK_JAVA_OPTIONS: null, _JAVA_OPTIONS: null });
// Tokens are private to one caller-created check/import operation. No disk or process-wide verdict cache.
const caches = new WeakMap();
export function createRtdbAttestationCache() {
  const token = Object.freeze({});
  caches.set(token, { root: null, closed: false, files: new Map(), inspections: new Map(), attestations: new Set(), directories: new Map(), spans: new Map() });
  return token;
}
function operationCache(token, root) {
  if (!token) return null;
  const cache = caches.get(token);
  need(cache && !cache.closed, "cache must be an open operation-scoped token");
  if (cache.root === null) cache.root = root;
  need(cache.root === root, "cache cannot cross evidence roots");
  return cache;
}
/** Rehash each retained artifact once at operation end; a proof cannot survive later file replacement. */
export function assertRtdbAttestationCacheUnchanged(token) {
  const cache=caches.get(token);
  need(cache && !cache.closed,"cache must be an open operation-scoped token");
  for(const [path,names] of cache.directories)equal(readdirSync(path).filter(name=>/^results-.+\.jsonl$/.test(name)).sort(),names,"reporter source inventory changed before final acceptance");
  for(const [path,entry] of cache.files) {
    const before=lstatSync(path,{bigint:true});
    need(before.isFile() && realpathSync(path)===path,"artifact changed before final acceptance");
    equal(facts(before),entry.facts,"evidence changed before final acceptance");
    const digest=hash(readFileSync(path));
    const after=lstatSync(path,{bigint:true});
    need(after.isFile() && realpathSync(path)===path,"artifact changed during final verification");
    equal(facts(after),entry.facts,"evidence changed during final verification");
    need(digest===entry.sha256,"evidence digest changed before final acceptance");
  }
  cache.closed=true;
  cache.files.clear(); cache.inspections.clear(); cache.attestations.clear(); cache.directories.clear(); cache.spans.clear();
}
const facts = stat => Object.fromEntries(["dev","ino","mode","size","mtimeNs","ctimeNs"].map(k=>[k,String(stat[k])]));

/** Cache immutable file facts, never a proof verdict. Each access revalidates path and stat identity. */
function file(root, artifact, cache) {
  need(typeof artifact === "string" && artifact.startsWith("e2e/.out/") && !isAbsolute(artifact) && !artifact.includes("\\"), "artifact is not repository-relative evidence");
  const path = resolve(root,artifact), rel=relative(root,path);
  need(rel === artifact && !rel.startsWith(".."), "artifact path is not canonical");
  const before=lstatSync(path,{bigint:true});
  need(before.isFile() && realpathSync(path) === path, "artifact is not a contained regular file");
  const identity=facts(before), prior=cache?.files.get(path);
  if(prior) {
    equal(identity,prior.facts,"evidence changed within one check/import operation");
    return prior;
  }
  const value=readFileSync(path), after=lstatSync(path,{bigint:true});
  need(after.isFile() && realpathSync(path)===path,"artifact changed during read");
  equal(facts(after),identity,"artifact changed during read");
  const entry={facts:identity,value,sha256:hash(value),json:undefined};
  cache?.files.set(path,entry);
  return entry;
}
function deepFreeze(value) {
  if(value && typeof value==="object" && !Object.isFrozen(value)) {
    for(const child of Object.values(value))deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function jsonFile(root,artifact,cache) {
  const entry=file(root,artifact,cache);
  if(entry.json===undefined)entry.json=deepFreeze(JSON.parse(entry.value.toString("utf8")));
  return entry.json;
}
function boundJson(root, reference, what, cache) {
  need(reference && SHA.test(reference.sha256), `${what} reference or digest missing`);
  const entry=file(root,reference.artifact,cache);
  need(entry.sha256===reference.sha256, `${what} digest differs`);
  return jsonFile(root,reference.artifact,cache);
}
function archive(root,sha256,cache) {
  need(SHA.test(sha256), "archive digest is unknown");
  const artifact=`e2e/.out/runtime-artifacts/rtdb/${sha256}.jar`, entry=file(root,artifact,cache);
  need(entry.sha256===sha256,"retained JAR digest differs");
  return {artifact,sha256,value:entry.value};
}
function inspectionOf(original,actual,cache) {
  const key=JSON.stringify([original.artifact,original.sha256,actual.artifact,actual.sha256]);
  if(cache?.inspections.has(key))return cache.inspections.get(key);
  const inspection=deepFreeze(inspectRtdbDerivation(original.value,actual.value));
  cache?.inspections.set(key,inspection);
  return inspection;
}
/** The complete final reporter span, not just a selected or merged subset. */
function reporterSpan(root,rel,cache) {
  const dir=resolve(root,dirname(rel));
  need(realpathSync(dir)===dir,"reporter directory is not canonical");
  const names=readdirSync(dir).filter(name=>/^results-.+\.jsonl$/.test(name)).sort();
  need(names.length>0,"final reporter files are missing");
  if(cache?.directories.has(dir))equal(names,cache.directories.get(dir),"reporter source inventory changed within operation");
  else cache?.directories.set(dir,names);
  const entries=names.map(name=>file(root,`${dirname(rel)}/${name}`,cache));
  const key=JSON.stringify([dir,...entries.map(e=>e.sha256)]);
  if(cache?.spans.has(key))return cache.spans.get(key);
  const ids=new Set(); let earliest=Infinity,latest=-Infinity;
  for(const entry of entries) {
    for(const line of entry.value.toString("utf8").split("\n").filter(line=>line.trim())) {
      const row=JSON.parse(line);
      need(typeof row?.id==="string" && !ids.has(row.id),"final reporter identity missing or duplicated");
      ids.add(row.id);
      const time=typeof row.at==="string" ? Date.parse(row.at) : NaN;
      need(Number.isFinite(time),"final reporter case timestamp is missing or invalid");
      earliest=Math.min(earliest,time); latest=Math.max(latest,time);
    }
  }
  need(ids.size>0,"final reporter has no case timestamps");
  const span=Object.freeze({earliest,latest,count:ids.size});
  cache?.spans.set(key,span);
  return span;
}
function validateEngine(engine) {
  need(engine && ["stock",APPROVED_RTDB_DERIVATION.kind].includes(engine.kind),"engine kind absent or unknown");
  equal({firebase:engine.firebaseVersion,database:engine.databaseVersion,sha256:engine.originalSha256},RTDB_COVERAGE_PIN,"unknown original toolchain/JAR");
  if(engine.kind==="stock") {
    need(engine.label==="stock/upstream Firebase emulator","stock label differs");
    need(engine.actualSha256===RTDB_COVERAGE_PIN.sha256 && engine.profileSha256===null,"stock metadata does not describe stock bytes");
    need(!engine.attestation,"stock engine cannot inherit a derived attestation");
  } else {
    need(SHA.test(APPROVED_RTDB_DERIVATION.profileSha256??"") && SHA.test(APPROVED_RTDB_DERIVATION.actualSha256??""),"derived runtime has not been independently approved");
    for(const field of ["kind","label","profileSha256","actualSha256"])need(engine[field]===APPROVED_RTDB_DERIVATION[field],`derived ${field} is unknown or mislabeled`);
    need(engine.actualSha256!==RTDB_COVERAGE_PIN.sha256,"stock JAR mislabeled derived");
  }
}
function validateReceipt(receipt,{engine,stack,invocation,phase}) {
  need(receipt && Number.isInteger(receipt.pid) && receipt.pid>0 && Number.isInteger(receipt.startSec) && receipt.startSec>0,`${phase} JVM identity missing`);
  need(receipt.liveDatabaseJvmCount===1,`${phase} must observe exactly one Database JVM`);
  need(receipt.mark===stack.mark,`${phase} JVM belongs to another stack`);
  need(receipt.jarPath===engine.actualPath && receipt.actualSha256===engine.actualSha256,`${phase} actual JVM JAR differs`);
  need(receipt.heapMb===DEFAULT_HEAPS.database,`${phase} observed Database heap differs`);
  equal(receipt.environmentTuning,JAVA_TUNING,`${phase} external Java tuning differs`);
  need(Array.isArray(receipt.argv) && receipt.argv.every(x=>typeof x==="string"),`${phase} actual argv missing`);
  const jarPositions=receipt.argv.flatMap((arg,i)=>arg==="-jar"?[i]:[]);
  need(jarPositions.length===1 && receipt.argv[jarPositions[0]+1]===engine.actualPath,`${phase} actual -jar launch differs`);
  equal(receipt.argv.filter(arg=>/^-Xmx/.test(arg)),["-Xmx1024m"],`${phase} heap flags differ`);
  need(receipt.argv.includes("-XX:+ExitOnOutOfMemoryError"),`${phase} OOM exit disabled`);
  need(!receipt.argv.some(arg=>/ActiveProcessorCount|scala\.concurrent\.context|akka\..*(?:parallelism|dispatcher|thread)|^-javaagent|^-agentlib|^-agentpath/.test(arg)),`${phase} concurrency or instrumentation flags changed`);
  assertRtdbLaunchReceipt(receipt,{engine,stack});
  const expectedRules=stack.rtdbRules;
  need(SHA.test(expectedRules?.sha256??"") && expectedRules.equal===true, "stack lacks exact verified rules");
  equal(receipt.rules,{stagedSha256:expectedRules.sha256,liveSha256:expectedRules.sha256,namespace:expectedRules.namespace},`${phase} exact live/staged rules differ`);
  const time=Date.parse(receipt.observedAt),start=Date.parse(invocation.startedAt),end=Date.parse(invocation.endedAt);
  need(Number.isFinite(time) && time>=start && time<=end,`${phase} receipt lies outside completed invocation`);
}

/** Call only with an explicit final acceptance engine policy; this function never changes outcomes. */
export function verifyRtdbRunAttestation(campaign,{report,stack,rel},{root,cache:token}) {
  root=realpathSync(root);
  const cache=operationCache(token,root);
  const expected=campaign.acceptance?.rtdbEngine;
  need(expected,"acceptance must explicitly choose stock or approved unofficial runtime");
  validateEngine(expected); validateEngine(stack.rtdbEngine);
  equal(identity(stack.rtdbEngine),identity(expected),"stack engine differs from frozen acceptance policy");
  const engine=stack.rtdbEngine;
  need(report.runId===stack.runId && report.invocation?.runId===stack.runId,"report/stack run identity differs");
  need(stack.fingerprint?.baseSha===campaign.acceptance.revision && stack.expectVersion===campaign.acceptance.version && stack.fingerprint?.sha256===campaign.acceptance.fingerprint,"source revision/version/fingerprint differs");
  equal(stack.jvm?.heapMb,DEFAULT_HEAPS,"ordinary stack heap map differs");
  let invocation;
  try { invocation=jsonFile(root,`${dirname(rel)}/invocation.json`,cache); }
  catch(error) { throw new Error(`RTDB attestation: completed invocation cannot be verified: ${error.message}`, { cause:error }); }
  need(invocation.id===report.invocation.id && invocation.runId===stack.runId,"completed invocation identity differs");
  const start=Date.parse(invocation.startedAt),end=Date.parse(invocation.endedAt);
  need(Number.isFinite(start) && Number.isFinite(end) && end>=start && [0,1,3].includes(invocation.exit) && !invocation.interrupted && !invocation.stackDown,"invocation did not finish on its original stack");
  for(const field of ["suite","spec","grep","n","trials","capabilities","plan","parallelism","locks"])equal(report.invocation[field],invocation[field],`report ${field} differs from completed invocation`);
  equal(report.invocation.rtdbEngine,invocation.rtdbEngine,"report engine differs from completed invocation");
  equal(identity(invocation.rtdbEngine),identity(engine),"invocation engine differs from stack");
  for(const field of ["sourcePath","actualPath"])equal(invocation.rtdbEngine[field],engine[field],`invocation ${field} differs from stack`);
  equal(report.invocation.rtdbRuntime,invocation.rtdbRuntime,"report runtime reference differs from completed invocation");
  const runtime=boundJson(root,invocation.rtdbRuntime,"runtime envelope",cache);
  need(runtime.schemaVersion===1 && runtime.runId===stack.runId && runtime.invocationId===invocation.id && runtime.fingerprint===stack.fingerprint.sha256 && runtime.revision===stack.fingerprint.baseSha && runtime.version===stack.expectVersion,"runtime envelope identity differs");
  equal(identity(runtime.engine),identity(engine),"runtime envelope engine differs");
  for(const field of ["sourcePath","actualPath"])equal(runtime.engine[field],engine[field],`runtime ${field} differs from stack`);
  equal(runtime.parallelism,invocation.parallelism,"runtime parallelism differs");
  equal(runtime.locks,invocation.locks,"runtime tier locks differ");
  if(invocation.suite==="concurrency") {
    need(invocation.parallelism?.concurrency===1,"concurrency file parallelism changed");
    const expectedLock=tierLockMode("concurrency",{n:invocation.n,trials:invocation.trials});
    need(invocation.locks?.concurrency?.mode===expectedLock.mode && invocation.locks.concurrency.authoring===expectedLock.authoring,"original authoring/measurement lock selection changed");
  }
  const actual=archive(root,engine.actualSha256,cache);
  if(engine.kind!=="stock") {
    const original=archive(root,engine.originalSha256,cache),attestation=boundJson(root,engine.attestation,"derivation attestation",cache);
    need(attestation.schemaVersion===1 && attestation.kind==="rtdb-derivation-attestation","attestation schema/kind differs");
    const inspection=inspectionOf(original,actual,cache);
    const attestationKey=JSON.stringify([original.artifact,original.sha256,actual.artifact,actual.sha256,engine.attestation.artifact,engine.attestation.sha256]);
    if(!cache?.attestations.has(attestationKey)) {
      equal(attestation.inspection,inspection,"independent byte/member/method/Code inspection differs from attestation");
      equal(attestation.archives,{original:{artifact:original.artifact,sha256:original.sha256},derived:{artifact:actual.artifact,sha256:actual.sha256}},"attestation archive references differ");
      cache?.attestations.add(attestationKey);
    }
    need(inspection.originalSha256===engine.originalSha256 && inspection.actualSha256===engine.actualSha256 && inspection.profileSha256===engine.profileSha256,"inspected profile/digests differ from approved engine");
    equal(invocation.rtdbEngine.attestation,engine.attestation,"invocation attestation differs from stack");
    equal(runtime.engine.attestation,engine.attestation,"runtime attestation differs from stack");
  }
  validateReceipt(runtime.before,{engine,stack,invocation,phase:"before"});
  validateReceipt(runtime.after,{engine,stack,invocation,phase:"after"});
  need(Date.parse(runtime.before.observedAt)<=Date.parse(runtime.after.observedAt),"runtime boundaries are reversed");
  const span=reporterSpan(root,rel,cache);
  need(span.earliest>=start && span.latest<=end,"reporter timestamps lie outside completed invocation");
  need(Date.parse(runtime.before.observedAt)<=span.earliest,"before receipt follows a reported case");
  need(Date.parse(runtime.after.observedAt)>=span.latest,"after receipt predates a reported case");
  for(const field of ["pid","startSec","mark","jarPath","actualSha256"])need(runtime.before[field]===runtime.after[field],`runtime ${field} changed during invocation`);
  return {engine:identity(engine),unofficial:engine.kind!=="stock",artifact:invocation.rtdbRuntime.artifact,sha256:invocation.rtdbRuntime.sha256};
}

/** Counterfactual stock-vs-derived probes are diagnostic evidence, never a substituted product-control pair. */
export function assertSameRtdbControlEngine(red,green) {
  equal(identity(red.engine),identity(green.engine),"red/green product controls used different runtime engines");
}
