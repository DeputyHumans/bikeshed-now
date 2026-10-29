// SPDX-License-Identifier: Apache-2.0
// Source-owned complete synthetic runtime records backed by the actual pinned original/derived JAR bytes (SPEC §12).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { deriveRtdbJar, RTDB_STOCK_PIN } from "../e2e/lib/rtdb-runtime.mjs";
import { RTDB_TEST_FIXTURE_PATH } from "./ensure-rtdb-test-fixture.mjs";
import { tierLockMode } from "../e2e/lib/locks.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
let jarPair;
function pair() {
  if(!jarPair) {
    const original=readFileSync(process.env.E2E_RTDB_STOCK_JAR ?? RTDB_TEST_FIXTURE_PATH);
    const {bytes:derived,facts}=deriveRtdbJar(original);
    jarPair={original,derived,facts};
  }
  return jarPair;
}
const clone = value => structuredClone(value);
const write = (root,rel,value) => {mkdirSync(dirname(join(root,rel)),{recursive:true});writeFileSync(join(root,rel),value);};
const json = value => JSON.stringify(value,null,2)+"\n";

/** These records are fixtures, not claims that a test launched a JVM. The ZIP/method evidence is real. */
export function createRtdbFixture(root,{suffix="base",n=[2],trials=1,stock=false}={}) {
  const jars=pair();
  const archives=Object.fromEntries([["original",jars.original],["derived",jars.derived]].map(([name,bytes])=>{
    const sha256=hash(bytes), artifact=`e2e/.out/runtime-artifacts/rtdb/${sha256}.jar`;
    if(!existsSync(join(root,artifact)))write(root,artifact,bytes);
    return [name,{artifact,sha256}];
  }));
  const dir=`e2e/.out/fixture-${suffix}`, invocationDir=`${dir}/invocations/fixture-invocation`, rel=`${invocationDir}/results.json`;
  const revision="a".repeat(40), fingerprint="b".repeat(64), version="0.16.1", runId=`fixture-${suffix}`, id="fixture-invocation";
  const rulesSha=hash('{"rules":{".read":false,".write":false}}');
  const engine={kind:stock?"stock":"request-context-sync-v1",label:stock?"stock/upstream Firebase emulator":"derived/unofficial diagnostic-append lock",firebaseVersion:RTDB_STOCK_PIN.firebase,databaseVersion:RTDB_STOCK_PIN.database,originalSha256:RTDB_STOCK_PIN.sha256,actualSha256:stock?RTDB_STOCK_PIN.sha256:jars.facts.actualSha256,profileSha256:stock?null:jars.facts.profileSha256,sourcePath:join(root,"installed-stock.jar"),actualPath:join(root,dir,"stack","rtdb-runtime.jar"),live:null};
  const attestation={schemaVersion:1,kind:"rtdb-derivation-attestation",inspection:clone(jars.facts),archives};
  const attestationRel=`${dir}/rtdb-runtime-attestation.json`;
  if(!stock)engine.attestation={artifact:attestationRel,sha256:hash(json(attestation))};
  const stack={runId,mark:`mark-${suffix}`,stackDir:join(root,dir,"stack"),fingerprint:{baseSha:revision,sha256:fingerprint},expectVersion:version,tools:{java:"/fixture/java"},ports:{database:9000,functions:5001},jvm:{heapMb:{firestore:2048,database:1024,other:512}},rtdbRules:{namespace:"demo-bikeshed",sha256:rulesSha,equal:true},rtdbEngine:clone(engine)};
  const argv=[stack.tools.java,"-Xmx1024m","-XX:+ExitOnOutOfMemoryError",`-XX:OnOutOfMemoryError=echo database %p >> '${join(stack.stackDir,"jvm","oom")}'`,`-XX:ErrorFile=${join(stack.stackDir,"jvm","hs_err_pid%p.log")}`,"-Duser.language=en","-jar",engine.actualPath,"--host","127.0.0.1","--port","9000","--functions_emulator_host","127.0.0.1","--functions_emulator_port","5001","--single_project_mode","Warning"];
  const receipt={observedAt:"2026-10-15T10:00:01.000Z",liveDatabaseJvmCount:1,pid:1234,startSec:1792058400,mark:stack.mark,jarPath:engine.actualPath,actualSha256:engine.actualSha256,profileSha256:engine.profileSha256,heapMb:1024,argv,commandLine:argv.join(" "),environmentTuning:{JAVA_TOOL_OPTIONS:null,JDK_JAVA_OPTIONS:null,_JAVA_OPTIONS:null},rules:{stagedSha256:rulesSha,liveSha256:rulesSha,namespace:"demo-bikeshed"}};
  const locks={concurrency:tierLockMode("concurrency",{n,trials})},parallelism={concurrency:1};
  const done={id,runId,suite:"concurrency",spec:"fixture.spec.mjs",grep:null,n,trials,capabilities:[],plan:[{tier:"concurrency",files:["e2e/specs/concurrency/fixture.spec.mjs"]}],parallelism,locks,startedAt:"2026-10-15T10:00:00.000Z",endedAt:"2026-10-15T10:00:05.000Z",exit:0,interrupted:null,stackDown:null,rtdbEngine:clone(engine)};
  const runtime={schemaVersion:1,runId,invocationId:id,fingerprint,revision,version,engine:clone(engine),before:clone(receipt),after:{...clone(receipt),observedAt:"2026-10-15T10:00:04.000Z"},parallelism:clone(parallelism),locks:clone(locks)};
  const record={id:"e2e/specs/concurrency/fixture.spec.mjs::fixture [N=2]",file:"e2e/specs/concurrency/fixture.spec.mjs",name:"fixture [N=2]",n:2,trial:1,status:"pass",at:"2026-10-15T10:00:02.000Z"};
  const report={runId,invocation:clone(done),mergedAt:done.endedAt,cases:[clone(record)]};
  const campaign={acceptance:{revision,version,fingerprint,rtdbEngine:clone(engine)}};
  const f={root,dir,rel,report,stack,done,runtime,attestation,records:[record],campaign};
  f.flush=()=>{
    if(!stock) {
      write(root,attestationRel,json(f.attestation));
      const ref={artifact:attestationRel,sha256:hash(json(f.attestation))};
      for(const e of [f.stack.rtdbEngine,f.done.rtdbEngine,f.report.invocation.rtdbEngine,f.runtime.engine])e.attestation=clone(ref);
    }
    const runtimeRel=`${invocationDir}/rtdb-runtime.json`,encoded=json(f.runtime);
    write(root,runtimeRel,encoded);
    const ref={artifact:runtimeRel,sha256:hash(encoded)};
    f.done.rtdbRuntime=clone(ref);f.report.invocation.rtdbRuntime=clone(ref);
    write(root,`${invocationDir}/invocation.json`,json(f.done));
    write(root,rel,json(f.report));
    write(root,`${invocationDir}/results-concurrency.jsonl`,f.records.map(json).join(""));
  };
  // JSONL must contain one record per physical line.
  const flush=f.flush;f.flush=()=>{flush();write(root,`${invocationDir}/results-concurrency.jsonl`,f.records.map(row=>JSON.stringify(row)+"\n").join(""));};
  f.flush();return f;
}

/** Add complete runtime evidence to an existing synthetic scenario, preserving its asserted identities. */
export function attachRtdbFixture(root, { campaign, rel, report, stack, done } = {}) {
  report ??= JSON.parse(readFileSync(join(root, rel), "utf8"));
  const runId = report.runId, stackRel = `e2e/.out/${runId}/stack.json`;
  stack ??= JSON.parse(readFileSync(join(root, stackRel), "utf8"));
  const invocationDir = dirname(rel), completionRel = `${invocationDir}/invocation.json`;
  if (!done && existsSync(join(root, completionRel))) done = JSON.parse(readFileSync(join(root, completionRel), "utf8"));
  const f = createRtdbFixture(root, { suffix: `runtime-${runId}` });
  const originalInvocation = report.invocation;
  const suite = originalInvocation.suite ?? (report.cases.some(row => row.n !== null && row.n !== undefined) ? "concurrency" : "functional");
  const startedAt = originalInvocation.startedAt ?? "2026-10-15T01:00:00.000Z";
  const endedAt = done?.endedAt ?? report.mergedAt ?? "2026-10-15T01:01:01.000Z";
  const start = Date.parse(startedAt), end = Date.parse(endedAt);
  const invocation = {
    id: originalInvocation.id, runId, suite, spec: [], grep: null,
    n: suite === "concurrency" ? [...new Set(report.cases.map(row => row.n).filter(Number.isInteger))] : null,
    trials: null, capabilities: [], plan: [{ tier: suite, files: [...new Set(report.cases.map(row => row.file))] }],
    ...originalInvocation, runId, startedAt,
  };
  invocation.parallelism ??= Object.fromEntries(invocation.plan.map(({ tier }) => [tier, 1]));
  invocation.locks ??= Object.fromEntries(invocation.plan.map(({ tier }) => [tier, tierLockMode(tier, invocation)]));
  Object.assign(stack, { ...f.stack, ...stack, runId, mark: `mark-${runId}`, stackDir: join(root, `e2e/.out/${runId}/stack`) });
  const engine = clone(f.stack.rtdbEngine);
  engine.actualPath = join(stack.stackDir, "rtdb-runtime.jar");
  stack.rtdbEngine = clone(engine);
  Object.assign(report, { invocation, mergedAt: report.mergedAt ?? endedAt });
  report.invocation.rtdbEngine = clone(engine);
  const completed = { ...clone(invocation), endedAt, exit: report.cases.some(row => row.status === "fail") ? 1 : 0, interrupted: null, stackDown: null, ...Object.fromEntries(["endedAt", "exit", "interrupted", "stackDown"].filter(key => done && Object.hasOwn(done, key)).map(key => [key, done[key]])), runId };
  completed.rtdbEngine = clone(engine);
  completed.parallelism = clone(invocation.parallelism); completed.locks = clone(invocation.locks);
  const receipt = clone(f.runtime.before);
  receipt.mark = stack.mark; receipt.jarPath = engine.actualPath;
  receipt.argv = receipt.argv.map(arg => arg.replaceAll(f.stack.stackDir, stack.stackDir).replaceAll(f.stack.rtdbEngine.actualPath, engine.actualPath));
  receipt.commandLine = receipt.argv.join(" ");
  receipt.observedAt = new Date(start + Math.min(1000, (end - start) / 4)).toISOString();
  const after = { ...clone(receipt), observedAt: new Date(end - Math.min(1000, (end - start) / 4)).toISOString() };
  const runtime = { ...clone(f.runtime), runId, invocationId: invocation.id, revision: stack.fingerprint.baseSha, fingerprint: stack.fingerprint.sha256, version: stack.expectVersion, engine: clone(engine), before: receipt, after, parallelism: clone(invocation.parallelism), locks: clone(invocation.locks) };
  for (const row of report.cases) row.at ??= new Date(start + (end - start) / 2).toISOString();
  const runtimeRel = `${invocationDir}/rtdb-runtime.json`, encoded = json(runtime), reference = { artifact: runtimeRel, sha256: hash(encoded) };
  report.invocation.rtdbRuntime = clone(reference); completed.rtdbRuntime = clone(reference);
  write(root, runtimeRel, encoded); write(root, completionRel, json(completed));
  write(root, rel, json(report)); write(root, stackRel, json(stack));
  // Initial fixtures have one complete raw reporter. Later mutations remain explicit in each test.
  const reporter = readdirSync(join(root, invocationDir)).find(name => /^results-.+\.jsonl$/.test(name)) ?? "results-final.jsonl";
  write(root, `${invocationDir}/${reporter}`, report.cases.map(row => JSON.stringify(row) + "\n").join(""));
  if (campaign) campaign.acceptance.rtdbEngine = clone(engine);
  return { report, stack, done: completed, runtime, engine };
}
