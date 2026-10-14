// SPDX-License-Identifier: Apache-2.0
// Self-test: paths are absolute and whole, env is built not inherited, and the Target never holds secrets (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, REPO_ROOT, assertPath, newRunId, runDir, RUN_ID_RE } from "../lib/paths.mjs";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { buildEnv, scrubEnv } from "../lib/proc.mjs";
import { PROD_NOT_IMPLEMENTED, assertTargetPort, emulatorEnv, localTarget, resetLocal, serializeTarget, specEnv, prodTarget } from "../lib/target.mjs";

const PORTS = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 35000 + i));
const fakeStack = (over = {}) => ({
  runId: "2610101200-test",
  runDir: join(OUT_DIR, "2610101200-test"),
  ports: PORTS,
  projectId: "demo-bikeshed",
  webApiKey: "demo-api-key",
  bucket: "demo-bikeshed-content",
  treeDir: "/nonexistent/bikeshed-e2e/stacks/x/tree",
  stackDir: "/nonexistent/bikeshed-e2e/stacks/x",
  tmpDir: "/nonexistent/tmp",
  logs: { emulators: "/nonexistent/emulators.log" },
  expectVersion: "0.0.0",
  fingerprint: { mode: "rev" },
  createdAt: "now",
  ...over,
});

test("REPO_ROOT is this checkout, found from the module, and run dirs live in e2e/.out", () => {
  assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name, "bikeshed-now-source");
  assert.ok(existsSync(join(REPO_ROOT, "e2e", "run.mjs")));
  const id = newRunId();
  assert.match(id, RUN_ID_RE);
  assert.equal(runDir(id), join(REPO_ROOT, "e2e", ".out", id));
});

test("NEGATIVE: a relative, unresolved or missing-value path is refused", () => {
  for (const bad of ["e2e/.out", "/a/../b", "/a/./b", "/a/b/", "/a/undefined/b", `/a/stack-${undefined}`, "", null]) {
    assert.throws(() => assertPath(bad), undefined, String(bad));
  }
  assert.equal(assertPath("/a/b"), "/a/b");
  assert.throws(() => runDir("../escape"), /not a valid run id/);
});

test("NEGATIVE: an inherited credential or binding never reaches a built or scrubbed env", () => {
  const ambient = {
    PATH: "/usr/bin", HOME: "/h", GOOGLE_APPLICATION_CREDENTIALS: "/x.json", GCLOUD_PROJECT: "real", FIREBASE_TOKEN: "t",
    BIKESHED_PUBLIC_ORIGIN: "https://real", RESEND_API_KEY: "re_real", VITE_FIREBASE_API_KEY: "k", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8088", KEEP: "1",
  };
  const scrubbed = scrubEnv(ambient);
  assert.deepEqual(Object.keys(scrubbed).sort(), ["HOME", "KEEP", "PATH"]);
  const built = buildEnv({ path: ["/usr/bin"], tmpdir: "/tmp/x" });
  assert.deepEqual(Object.keys(built).filter((k) => !["PATH", "HOME", "USER", "LANG", "JAVA_HOME", "TMPDIR"].includes(k)), []);
  assert.throws(() => buildEnv({ path: ["relative/bin"] }), /not absolute/);
  assert.throws(() => buildEnv({ path: ["/usr/bin"], set: { X: undefined } }), /has no value/);
});

test("the local Target serializes without secrets and the spec env carries the stack's emulator hosts", () => {
  const t = localTarget(fakeStack());
  assert.equal(t.origin, `http://127.0.0.1:${PORTS.hosting}`);
  assert.equal(t.mail.mailpitUrl, `http://127.0.0.1:${PORTS.mailpit}`);
  assert.equal(t.databaseURL, `http://127.0.0.1:${PORTS.database}?ns=demo-bikeshed`);
  assert.ok(t.capabilities.has("email"));
  const json = JSON.parse(serializeTarget(t));
  assert.ok(Array.isArray(json.capabilities));
  const env = specEnv(t, "/nonexistent/target.json", { PATH: "/usr/bin", GOOGLE_APPLICATION_CREDENTIALS: "/x.json", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8088" });
  assert.equal(env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${PORTS.firestore}`, "the stack's port, not the ambient default");
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.GCLOUD_PROJECT, "demo-bikeshed");
  assert.deepEqual(Object.keys(emulatorEnv(t)).sort(), [
    "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_DATABASE_EMULATOR_HOST", "FIREBASE_EMULATOR_HUB", "FIREBASE_STORAGE_EMULATOR_HOST",
    "FIRESTORE_EMULATOR_HOST", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "STORAGE_EMULATOR_HOST",
  ]);
});

test("NEGATIVE: a Target with a secret-shaped field, or the mail key, refuses to serialize", () => {
  const t = localTarget(fakeStack());
  assert.throws(() => serializeTarget({ ...t, operatorPassword: "x" }), /never carries secrets/);
  assert.throws(() => serializeTarget({ ...t, notes: "key re_e2e_0123abcd" }), /mail key/);
});

test("NEGATIVE: reset helpers refuse a default port and a port that is not this stack's", async () => {
  assert.throws(() => localTarget(fakeStack({ ports: { ...PORTS, firestore: 8088 } })), /outside the e2e range/, "a target is never even built on a default port");
  // A hand-edited target.json: the reset helper must still refuse.
  const onDefault = localTarget(fakeStack());
  onDefault.stack.ports = { ...PORTS, firestore: 8088 };
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("no request may be sent");
  };
  try {
    await assert.rejects(resetLocal(onDefault, { auth: false, database: false }), /outside the e2e range|deny list/);
    assert.equal(fetched, false, "refused before any request");
  } finally {
    globalThis.fetch = realFetch;
  }
  const t = localTarget(fakeStack());
  assert.throws(() => assertTargetPort(t, 36500), /not one of run/);
  assert.throws(() => assertTargetPort(t, 9000), /outside the e2e range|deny list/);
  assert.equal(assertTargetPort(t, PORTS.firestore), PORTS.firestore);
});

test("the production target is a clear refusal in this build", () => {
  assert.throws(() => prodTarget(), new RegExp(PROD_NOT_IMPLEMENTED));
});
