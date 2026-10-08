// SPDX-License-Identifier: Apache-2.0
// The CI deploy preflight: each refusal fires on its own cause and on nothing else (SPEC §12).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { parseEnv, refusals } from "./deploy-preflight.mjs";
import { TOKEN, servedDocuments, stampDist } from "./stamp-deployment.mjs";

const ORIGIN = "https://h.example";

/**
 * A throwaway build and an EMPTY repository root. Never the real root: on a
 * deployer's machine it holds a real config/deploy.json, and the origin would
 * then come from whatever deployment happens to be configured there.
 */
function fixture({ stamped = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "bikeshed-preflight-"));
  const dist = join(base, "dist");
  for (const rel of servedDocuments()) {
    const path = join(dist, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `see ${TOKEN}/d/x`);
  }
  if (stamped) stampDist(dist, ORIGIN);
  const root = join(base, "root");
  mkdirSync(root);
  return { base, dist, root };
}

const GOOD_FUNCTIONS_ENV = `BIKESHED_BUCKET=b\nBIKESHED_PUBLIC_ORIGIN=${ORIGIN}/`;

const GOOD_ENV = [
  "# production",
  "VITE_FIREBASE_PROJECT_ID=acme-prod",
  "VITE_FIREBASE_API_KEY=k",
  "VITE_USE_EMULATORS=",
].join("\n");

function check(overrides = {}, { stamped = true, env = { BIKESHED_PUBLIC_ORIGIN: ORIGIN } } = {}) {
  const f = fixture({ stamped });
  try {
    return refusals({
      project: "acme-prod",
      appEnv: GOOD_ENV,
      functionsEnv: GOOD_FUNCTIONS_ENV,
      dist: f.dist,
      env,
      root: f.root,
      ...overrides,
    });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
}

test("a matching, stamped production build is cleared", () => {
  // The control every refusal below is measured against: if this ever refused,
  // the other tests would pass for the wrong reason.
  assert.deepEqual(check(), []);
});

test("no target project is refused", () => {
  // An unset repository secret reaches the job as an empty string.
  const out = check({ project: "" });
  assert.equal(out.length, 1);
  assert.match(out[0], /no target project/);
});

test("an emulator-only project id is refused", () => {
  const out = check({
    project: "demo-bikeshed",
    appEnv: "VITE_FIREBASE_PROJECT_ID=demo-bikeshed",
  });
  assert.equal(out.length, 1);
  assert.match(out[0], /demo-/);
});

test("an emulator bundle is refused, however the flag is spelled", () => {
  for (const value of ["1", "true", "YES", " 1 "]) {
    const out = check({ appEnv: `${GOOD_ENV}\nVITE_USE_EMULATORS=${value}` });
    assert.equal(out.length, 1, `VITE_USE_EMULATORS=${JSON.stringify(value)}`);
    assert.match(out[0], /VITE_USE_EMULATORS/);
  }
});

test("an emulator flag the app reads as off is not refused", () => {
  // The same reading app/src/config.ts gives it: only 1, true and yes are on.
  assert.deepEqual(check({ appEnv: `${GOOD_ENV}\nVITE_USE_EMULATORS=0` }), []);
});

test("a bundle configured for another project is refused", () => {
  const out = check({ appEnv: "VITE_FIREBASE_PROJECT_ID=acme-staging" });
  assert.equal(out.length, 1);
  assert.match(out[0], /different Firebase project/);
});

test("a bundle with no project id at all is refused", () => {
  const out = check({ appEnv: "VITE_FIREBASE_API_KEY=k" });
  assert.equal(out.length, 1);
  assert.match(out[0], /different Firebase project/);
});

test("a missing app config is refused", () => {
  const out = check({ appEnv: "" });
  assert.equal(out.length, 1);
  assert.match(out[0], /missing or empty/);
});

test("no public origin is refused", () => {
  // checkDist alone clears this case, on purpose, for a hand deploy with no
  // custom domain. The pipeline cannot clear it: the smoke test needs an origin.
  const out = check({}, { env: {} });
  assert.equal(out.length, 1);
  assert.match(out[0], /no public origin/);
});

test("an unstamped build is refused", () => {
  const out = check({}, { stamped: false });
  assert.equal(out.length, 1);
  assert.match(out[0], /still name <deployment>/);
});

test("functions told no origin are refused", () => {
  for (const functionsEnv of ["", "BIKESHED_BUCKET=b", "BIKESHED_PUBLIC_ORIGIN="]) {
    const out = check({ functionsEnv });
    assert.equal(out.length, 1, JSON.stringify(functionsEnv));
    assert.match(out[0], /BIKESHED_PUBLIC_ORIGIN/);
  }
});

test("functions told a different or unusable origin are refused", () => {
  for (const value of ["https://other.example", "https://<deployment>", "https://h.example/app"]) {
    const out = check({ functionsEnv: `BIKESHED_PUBLIC_ORIGIN=${value}` });
    assert.equal(out.length, 1, value);
    assert.match(out[0], /BIKESHED_PUBLIC_ORIGIN/);
  }
});

test("the functions origin is compared after normalizing, as the stamp's is", () => {
  // The control's GOOD_FUNCTIONS_ENV already carries a trailing slash; a bare
  // host must clear too, since config/deploy.json holds exactly that form.
  assert.deepEqual(check({ functionsEnv: "BIKESHED_PUBLIC_ORIGIN=h.example" }), []);
});

test("no refusal quotes the values it compared", () => {
  // The binding stays out of the build log too.
  const out = [
    ...check({ appEnv: "VITE_FIREBASE_PROJECT_ID=acme-staging" }),
    ...check({ project: "demo-x", appEnv: "VITE_FIREBASE_PROJECT_ID=demo-x" }),
    ...check({ functionsEnv: "BIKESHED_PUBLIC_ORIGIN=https://other.example" }),
  ];
  for (const line of out) {
    assert.doesNotMatch(line, /acme-prod|acme-staging|demo-x|h\.example|other\.example/);
  }
});

test("dotenv lines parse the way the checks need", () => {
  assert.deepEqual(
    parseEnv(
      [
        "# comment",
        "",
        "export A=1",
        'B="two words"',
        "C='x'",
        "D=",
        "  E = spaced  ",
        "not a pair",
      ].join("\n"),
    ),
    { A: "1", B: "two words", C: "x", D: "", E: "spaced" },
  );
});
