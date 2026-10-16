// SPDX-License-Identifier: Apache-2.0
// The CI deploy preflight: each refusal fires on its own cause and on nothing else (SPEC §12).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { parseEnv, refusals } from "./deploy-preflight.mjs";
import { TOKEN, servedDocuments, skillArchives, stampDist } from "./stamp-deployment.mjs";

const ORIGIN = "https://h.example";

/**
 * A throwaway build and an EMPTY repository root. Never the real root: on a
 * deployer's machine it holds a real config/deploy.json, and the origin would
 * then come from whatever deployment happens to be configured there.
 */
function fixture({ stamped = true, deployConfig } = {}) {
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
  if (deployConfig !== undefined) {
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "deploy.json"),
      typeof deployConfig === "string" ? deployConfig : JSON.stringify(deployConfig));
  }
  return { base, dist, root };
}

const GOOD_FUNCTIONS_ENV = `BIKESHED_BUCKET=b\nBIKESHED_PUBLIC_ORIGIN=${ORIGIN}/`;

const GOOD_ENV = [
  "# production",
  "VITE_FIREBASE_PROJECT_ID=acme-prod",
  "VITE_FIREBASE_API_KEY=k",
  "VITE_USE_EMULATORS=",
].join("\n");

function check(overrides = {}, { stamped = true, env = { BIKESHED_PUBLIC_ORIGIN: ORIGIN }, deployConfig } = {}) {
  const f = fixture({ stamped, deployConfig });
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

const MEDIA_BASE = "https://storage.googleapis.com/demo-bikeshed-media/landing/v1";
const MEDIA_ENV = `${GOOD_ENV}\nVITE_LANDING_MEDIA_BASE_URL=${MEDIA_BASE}`;
const MEDIA_CONFIG = { bucket: "demo-bikeshed-content", mediaBucket: "demo-bikeshed-media" };

test("landing media clears only a matching, separately configured public bucket", () => {
  assert.deepEqual(check({ appEnv: MEDIA_ENV }, { deployConfig: MEDIA_CONFIG }), []);
});

test("unset landing media needs no media configuration", () => {
  for (const value of ["", "   "]) {
    assert.deepEqual(check({ appEnv: `${GOOD_ENV}\nVITE_LANDING_MEDIA_BASE_URL=${value}` }), []);
  }
  assert.deepEqual(check({}, { deployConfig: "not json" }), []);
});

test("landing media rejects non-direct or decorated URLs without leaking values", () => {
  for (const value of [
    MEDIA_BASE.replace("https:", "http:"),
    MEDIA_BASE.replace("storage.googleapis.com", "media.example"),
    MEDIA_BASE.replace("https://", "https://private-user:private-password@"),
    `${MEDIA_BASE}?credential=private-token`,
    `${MEDIA_BASE}#private-fragment`,
    "https://storage.googleapis.com/demo-bikeshed-media",
    "https://storage.googleapis.com/demo-bikeshed-media/landing/../v1",
  ]) {
    const out = check({ appEnv: `${GOOD_ENV}\nVITE_LANDING_MEDIA_BASE_URL=${value}` }, { deployConfig: MEDIA_CONFIG });
    assert.equal(out.length, 1);
    assert.match(out[0], /must name a direct HTTPS media revision/);
    assert.doesNotMatch(out[0], /demo-bikeshed|private-user|private-password|private-token|private-fragment|media\.example/);
  }
});

test("enabled landing media requires readable, complete bucket configuration", () => {
  for (const deployConfig of [undefined, "not json"]) {
    const out = check({ appEnv: MEDIA_ENV }, { deployConfig });
    assert.equal(out.length, 1);
    assert.match(out[0], /requires a readable config\/deploy.json/);
  }
  for (const deployConfig of [null, {}, { bucket: "demo-bikeshed-content" },
    { mediaBucket: "demo-bikeshed-media" }, { ...MEDIA_CONFIG, mediaBucket: " " },
    { ...MEDIA_CONFIG, bucket: 42 }]) {
    const out = check({ appEnv: MEDIA_ENV }, { deployConfig });
    assert.equal(out.length, 1);
    assert.match(out[0], /requires both bucket and mediaBucket/);
  }
});

test("landing media cannot point at the private content bucket", () => {
  const out = check({ appEnv: MEDIA_ENV }, { deployConfig: { ...MEDIA_CONFIG, bucket: MEDIA_CONFIG.mediaBucket } });
  assert.equal(out.length, 1);
  assert.match(out[0], /separate bucket from private document content/);
  assert.doesNotMatch(out[0], /demo-bikeshed/);
});

test("landing media must match the deployment's media bucket", () => {
  const out = check({ appEnv: MEDIA_ENV }, { deployConfig: { ...MEDIA_CONFIG, mediaBucket: "demo-other-media" } });
  assert.equal(out.length, 1);
  assert.match(out[0], /different bucket/);
  assert.doesNotMatch(out[0], /demo-bikeshed|demo-other-media/);
});

test("landing media follows Vite's shell-over-dotenv precedence", () => {
  const options = { deployConfig: MEDIA_CONFIG, env: { BIKESHED_PUBLIC_ORIGIN: ORIGIN, VITE_LANDING_MEDIA_BASE_URL: MEDIA_BASE } };
  assert.deepEqual(check({}, options), []);
  const badEnv = `${GOOD_ENV}\nVITE_LANDING_MEDIA_BASE_URL=https://media.example/bad`;
  assert.deepEqual(check({ appEnv: badEnv }, options), []);
  const out = check({ appEnv: MEDIA_ENV }, { ...options, env: { ...options.env, VITE_LANDING_MEDIA_BASE_URL: "https://media.example/bad" } });
  assert.equal(out.length, 1);
  assert.match(out[0], /must name a direct HTTPS media revision/);
  assert.deepEqual(check({ appEnv: MEDIA_ENV }, { env: { BIKESHED_PUBLIC_ORIGIN: ORIGIN, VITE_LANDING_MEDIA_BASE_URL: "" } }), []);
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

test("a skill zip that differs from the SKILL.md beside it is refused on its own line", () => {
  // Stamped, so the "still name <deployment>" refusal cannot be what fires: the
  // zip is the only thing wrong, and the refusal has to say so (SPEC §23).
  const f = fixture();
  try {
    const [first] = skillArchives();
    writeFileSync(join(f.dist, first.path), "stale");
    const out = refusals({
      project: "acme-prod",
      appEnv: GOOD_ENV,
      functionsEnv: GOOD_FUNCTIONS_ENV,
      dist: f.dist,
      env: { BIKESHED_PUBLIC_ORIGIN: ORIGIN },
      root: f.root,
    });
    assert.equal(out.length, 1);
    assert.ok(out[0].includes(first.path), out[0]);
    assert.doesNotMatch(out[0], /still name/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
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
