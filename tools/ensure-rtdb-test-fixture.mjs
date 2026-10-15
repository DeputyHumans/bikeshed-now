// SPDX-License-Identifier: Apache-2.0
// Provision the public pinned RTDB archive for byte-verifying tools tests without a Firebase installation or account (SPEC §12).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RTDB_STOCK_PIN } from "../e2e/lib/rtdb-runtime.mjs";

export const RTDB_TEST_FIXTURE_PATH = join(homedir(), ".cache/bikeshed-e2e/fixtures/rtdb", `${RTDB_STOCK_PIN.sha256}.jar`);
export const RTDB_TEST_FIXTURE_URL = "https://storage.googleapis.com/firebase-preview-drop/emulator/firebase-database-emulator-v4.11.2.jar";
const FIREBASE_CACHE = join(homedir(), ".cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function verified(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("RTDB test fixture is not a regular file");
  const bytes = readFileSync(path);
  if (hash(bytes) !== RTDB_STOCK_PIN.sha256) throw new Error("RTDB test fixture SHA-256 differs from the pinned public archive");
  return bytes;
}
/** Dependency injection is for local fetch/cache tests; the CLI always uses the exact public URL and source-owned digest. */
export async function ensureRtdbTestFixture({ target = RTDB_TEST_FIXTURE_PATH, firebaseCache = FIREBASE_CACHE, fetchImpl = fetch } = {}) {
  if (existsSync(target)) { verified(target); return { path: target, sha256: RTDB_STOCK_PIN.sha256, source: "verified-cache" }; }
  let bytes, source;
  if (firebaseCache && existsSync(firebaseCache)) {
    try { bytes = verified(firebaseCache); source = "verified-firebase-cache"; }
    catch { /* A different installed cache is not overwritten or treated as this pinned fixture. */ }
  }
  if (!bytes) {
    const response = await fetchImpl(RTDB_TEST_FIXTURE_URL, { signal: AbortSignal.timeout(120_000), redirect: "error" });
    if (!response.ok) throw new Error(`RTDB test fixture download failed: HTTP ${response.status}`);
    const length = Number(response.headers?.get("content-length"));
    if (length > 64 * 1024 * 1024) throw new Error("RTDB test fixture download exceeds the bounded archive size");
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 64 * 1024 * 1024 || hash(bytes) !== RTDB_STOCK_PIN.sha256) throw new Error("RTDB test fixture download SHA-256 differs from the pinned public archive");
    source = "verified-download";
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.partial-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    verified(temporary);
    try { linkSync(temporary, target); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    verified(target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return { path: target, sha256: RTDB_STOCK_PIN.sha256, source };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await ensureRtdbTestFixture();
  console.log(`RTDB tools-test archive ${result.sha256} (${result.source})`);
}
