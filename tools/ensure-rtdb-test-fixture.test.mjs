// SPDX-License-Identifier: Apache-2.0
// The public fixture provisioner refuses corrupt caches/downloads and publishes complete pinned bytes atomically (SPEC §12).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRtdbTestFixture, RTDB_TEST_FIXTURE_PATH } from "./ensure-rtdb-test-fixture.mjs";
const root = mkdtempSync(join(tmpdir(), "rtdb-public-fixture-"));
const original = readFileSync(process.env.E2E_RTDB_STOCK_JAR ?? RTDB_TEST_FIXTURE_PATH);
after(() => rmSync(root, { recursive: true, force: true }));
const path = name => join(root, `${name}.jar`);
const noFetch = async () => { throw new Error("unexpected network fetch"); };
const response = bytes => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => bytes });
test("verified public fixture cache is reusable without network or Firebase", async () => {
  const target=path("cached");writeFileSync(target,original);
  const result=await ensureRtdbTestFixture({target,firebaseCache:null,fetchImpl:noFetch});
  assert.equal(result.source,"verified-cache");assert.deepEqual(readFileSync(target),original);
});
test("a corrupted existing fixture is refused without overwriting it", async () => {
  const target=path("corrupt-cache");writeFileSync(target,"bad cached bytes");
  await assert.rejects(ensureRtdbTestFixture({target,firebaseCache:null,fetchImpl:noFetch}),/SHA-256 differs/);
  assert.equal(readFileSync(target,"utf8"),"bad cached bytes");
});
test("a symlink cannot masquerade as the published fixture", async () => {
  const cached=path("symlink-source"),target=path("symlink");writeFileSync(cached,original);symlinkSync(cached,target);
  await assert.rejects(ensureRtdbTestFixture({target,firebaseCache:null,fetchImpl:noFetch}),/regular file/);
});
test("a correct installed Firebase cache is copied without invoking its CLI", async () => {
  const firebaseCache=path("firebase"),target=path("copy");writeFileSync(firebaseCache,original);
  const result=await ensureRtdbTestFixture({target,firebaseCache,fetchImpl:noFetch});
  assert.equal(result.source,"verified-firebase-cache");assert.deepEqual(readFileSync(target),original);assert.deepEqual(readFileSync(firebaseCache),original);
});
test("a fresh fixture fetch pins the public URL and checks complete bytes before publication", async () => {
  const target=path("download");let calls=0;
  const result=await ensureRtdbTestFixture({target,firebaseCache:null,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,"https://storage.googleapis.com/firebase-preview-drop/emulator/firebase-database-emulator-v4.11.2.jar");
    assert.equal(options.redirect,"error");assert.ok(options.signal instanceof AbortSignal);assert.equal(existsSync(target),false);
    return response(original);
  }});
  assert.equal(calls,1);assert.equal(result.source,"verified-download");assert.deepEqual(readFileSync(target),original);
  assert.equal(readdirSync(root).some(name=>name.startsWith("download.jar.partial-")),false);
});
test("wrong downloaded bytes never produce an accepted cache", async () => {
  const target=path("bad-download");
  await assert.rejects(ensureRtdbTestFixture({target,firebaseCache:null,fetchImpl:async()=>response(Buffer.from("untrusted"))}),/download SHA-256 differs/);
  assert.equal(existsSync(target),false);assert.equal(readdirSync(root).some(name=>name.startsWith("bad-download.jar.partial-")),false);
});
test("a wrong installed cache falls back to exact public bytes without modifying the installed file", async () => {
  const firebaseCache=path("other-installed"),target=path("fallback");writeFileSync(firebaseCache,"different version");
  const result=await ensureRtdbTestFixture({target,firebaseCache,fetchImpl:async()=>response(original)});
  assert.equal(result.source,"verified-download");assert.equal(readFileSync(firebaseCache,"utf8"),"different version");assert.deepEqual(readFileSync(target),original);
});
test("HTTP failures and interrupted bodies cannot publish a fixture", async () => {
  const http=path("http"),body=path("body");
  await assert.rejects(ensureRtdbTestFixture({target:http,firebaseCache:null,fetchImpl:async()=>({ok:false,status:503})}),/HTTP 503/);
  await assert.rejects(ensureRtdbTestFixture({target:body,firebaseCache:null,fetchImpl:async()=>({...response(original),arrayBuffer:async()=>{throw new Error("body interrupted");}})}),/body interrupted/);
  assert.equal(existsSync(http),false);assert.equal(existsSync(body),false);
});
test("a concurrent corrupted publication is refused and never overwritten", async () => {
  const target=path("concurrent-corrupt");
  await assert.rejects(ensureRtdbTestFixture({target,firebaseCache:null,fetchImpl:async()=>{
    writeFileSync(target,"other writer corrupt");return response(original);
  }}),/SHA-256 differs/);
  assert.equal(readFileSync(target,"utf8"),"other writer corrupt");assert.equal(readdirSync(root).some(name=>name.startsWith("concurrent-corrupt.jar.partial-")),false);
});
test("two simultaneous successful downloads publish one complete verified cache", async () => {
  const target=path("parallel");let fetched=0,release;const gate=new Promise(r=>release=r);
  const fetchImpl=async()=>{fetched++;if(fetched===2)release();await gate;return response(original);};
  const results=await Promise.all([ensureRtdbTestFixture({target,firebaseCache:null,fetchImpl}),ensureRtdbTestFixture({target,firebaseCache:null,fetchImpl})]);
  assert.equal(results.length,2);assert.deepEqual(readFileSync(target),original);assert.equal(readdirSync(root).some(name=>name.startsWith("parallel.jar.partial-")),false);
});
