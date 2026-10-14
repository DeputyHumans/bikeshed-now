// SPDX-License-Identifier: Apache-2.0
// Self-test: `needs` may refuse a capability ("!<capability>"), and a target knows its stack's patch sets, as `patches` and as `patch:<set>` capabilities, also for a target.json written before that field (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCK_SIZE, namePorts } from "../lib/ports.mjs";
import { capabilitiesFor, patchCapability, patchSetsOf, PATCH_CAPABILITY_PREFIX } from "../lib/options.mjs";
import { loadTarget, localTarget, recordedPatchSets, serializeTarget } from "../lib/target.mjs";
import { expand, skipReason, splitNeeds } from "../lib/test.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PORTS = namePorts(Array.from({ length: BLOCK_SIZE }, (_, i) => 36100 + i));
const target = (caps, kind = "local") => ({ kind, runId: "r", capabilities: new Set(caps) });

test("needs: \"!<capability>\" skips where the target HAS it, with the reason; a plain need is as before", () => {
  const plain = target(["local", "email"]);
  const withId = target(["local", "email", "measurement-id", "patch:a19-analytics-live"]);
  const why = (t, needs) => skipReason(t, { needs, selected: null });
  assert.equal(why(plain, ["!measurement-id"]), null, "runs where the capability is absent");
  assert.equal(why(withId, ["!measurement-id"]), "needs no measurement-id (the local target has it)");
  assert.equal(why(withId, ["measurement-id", "!patch:a19-analytics-live"]), "needs no patch:a19-analytics-live (the local target has it)");
  assert.equal(why(withId, ["measurement-id", "patch:a19-analytics-live"]), null);
  assert.equal(why(plain, ["measurement-id", "!patch:a19-analytics-live"]), "needs measurement-id (the local target lacks it)", "a missing need is reported first");
  assert.equal(why(withId, ["!email", "!measurement-id", "!oob-codes"]), "needs no email, measurement-id (the local target has it)");
  assert.equal(why(withId, ["! measurement-id"]), "needs no measurement-id (the local target has it)", "the name is trimmed");
  assert.equal(why(plain, ["no-measurement-id (this stack was built with one)"]), "needs no-measurement-id (this stack was built with one) (the local target lacks it)", "a made-up need still skips as before");
  assert.equal(why(target(["x"], "prod"), ["!x"]), "needs no x (the prod target has it)");
  assert.equal(skipReason(target(["x"], "prod"), { tiers: ["prod"], needs: ["!x"], selected: null }), "needs no x (the prod target has it)");
  assert.equal(skipReason(null, { needs: ["!x"] }), "no target (E2E_TARGET is not set)");
  assert.deepEqual(splitNeeds(["a", "!b", "c", "!  d "]), { want: ["a", "c"], refuse: ["b", "d"] });
  assert.deepEqual(splitNeeds(), { want: [], refuse: [] });
  const [c] = expand("a case", { needs: ["!measurement-id"] }, withId);
  assert.equal(c.skip, "needs no measurement-id (the local target has it)", "expand() carries it to the declared case");
});

test("NEGATIVE: a `!` that names no capability, a doubled `!!`, a non-string or a non-list throws at declaration", () => {
  const t = target(["local"]);
  for (const bad of ["!", "! ", "!!x"]) {
    assert.throws(() => skipReason(t, { needs: [bad], selected: null }), (e) => e instanceof TypeError && /names no capability/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => skipReason(t, { needs: [7], selected: null }), /each entry is a capability name/);
  assert.throws(() => skipReason(t, { needs: "!x", selected: null }), /a list of capabilities/);
  assert.throws(() => expand("x", { needs: ["!"] }, t), /names no capability/, "so a typo fails the spec file as it loads");
});

const record = (over = {}) => ({
  runId: "2610111200-ptch",
  runDir: tempDir("e2e-ptch-"),
  ports: PORTS,
  projectId: "demo-bikeshed",
  webApiKey: "demo-api-key",
  bucket: "demo-bikeshed-content",
  treeDir: "/nonexistent/bikeshed-e2e/stacks/p/tree",
  stackDir: "/nonexistent/bikeshed-e2e/stacks/p",
  tmpDir: "/nonexistent/tmp",
  logs: { emulators: "/nonexistent/emulators.log" },
  options: { emailOff: false, appEnv: {} },
  expectVersion: "0.0.0",
  fingerprint: { mode: "rev" },
  createdAt: "now",
  ...over,
});
const applied = (...sets) => sets.map((set) => ({ set, applied: [{ file: `/x/${set}/01.patch`, sha256: "0".repeat(64) }] }));

test("a stack built with patch sets: target.patches lists them in order, and each is a patch:<set> capability", () => {
  assert.equal(PATCH_CAPABILITY_PREFIX, "patch:");
  assert.equal(patchCapability("a19-analytics-live"), "patch:a19-analytics-live");
  for (const bad of ["", "A19", "../x", "a b", null, undefined]) assert.throws(() => patchCapability(bad), /not a patch set name/, String(bad));
  const rec = record({ patches: applied("a19-export-mark-default", "controls-a19-notify-optout") });
  assert.deepEqual(patchSetsOf(rec), ["a19-export-mark-default", "controls-a19-notify-optout"]);
  assert.deepEqual(patchSetsOf({}), []);
  assert.deepEqual(patchSetsOf({ patches: [{ set: "ok" }, { set: "../bad" }, {}, null] }), ["ok"], "only names a set can have");
  const caps = capabilitiesFor(rec);
  assert.ok(caps.has("patch:a19-export-mark-default") && caps.has("patch:controls-a19-notify-optout") && caps.has("patches"));
  assert.deepEqual([...capabilitiesFor(record({ patches: [] }))].filter((c) => c.startsWith("patch:")), [], "no set, no patch: capability");
  const t = localTarget(rec);
  assert.deepEqual(t.patches, ["a19-export-mark-default", "controls-a19-notify-optout"]);
  const json = JSON.parse(serializeTarget(t));
  assert.deepEqual(json.patches, t.patches, "target.json carries them");
  assert.ok(json.capabilities.includes("patch:a19-export-mark-default"));
  assert.deepEqual(localTarget(record()).patches, [], "a stack built without any");
});

/** Write a run dir holding target.json (and stack.json when given); return the target.json path. */
function runFiles({ targetJson, stackJson }) {
  const dir = tempDir("e2e-ptch-run-");
  mkdirSync(dir, { recursive: true });
  const t = { ...targetJson, runDir: dir };
  writeFileSync(join(dir, "target.json"), JSON.stringify(t));
  if (stackJson !== undefined) writeFileSync(join(dir, "stack.json"), typeof stackJson === "string" ? stackJson : JSON.stringify(stackJson));
  return { file: join(dir, "target.json"), dir };
}

test("loadTarget: target.json's own patches win; one written before the field gets them from the run's stack.json, with their capabilities; null when neither says", () => {
  const base = JSON.parse(serializeTarget(localTarget(record({ patches: applied("a19-analytics-live") }))));
  // Its own list, and a stack.json that disagrees: target.json wins.
  const own = runFiles({ targetJson: base, stackJson: { patches: applied("something-else") } });
  const a = loadTarget(own.file);
  assert.deepEqual([...a.patches], ["a19-analytics-live"]);
  assert.ok(a.capabilities.has("patch:a19-analytics-live") && !a.capabilities.has("patch:something-else"));
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.patches));

  // An older target.json: no `patches`, no patch: capability.
  const { patches: _p, ...older } = base;
  older.capabilities = older.capabilities.filter((c) => !c.startsWith("patch:"));
  const old = runFiles({ targetJson: older, stackJson: { state: "ready", patches: applied("a19-export-mark-default", "a20-cli-bad-skill-name") } });
  const b = loadTarget(old.file);
  assert.deepEqual([...b.patches], ["a19-export-mark-default", "a20-cli-bad-skill-name"], "from stack.json");
  assert.ok(b.capabilities.has("patch:a19-export-mark-default") && b.capabilities.has("patch:a20-cli-bad-skill-name"));
  assert.equal(skipReason(b, { needs: ["!patch:a19-export-mark-default"], selected: null }), "needs no patch:a19-export-mark-default (the local target has it)");
  assert.deepEqual(recordedPatchSets(old.dir), ["a19-export-mark-default", "a20-cli-bad-skill-name"]);

  const none = loadTarget(runFiles({ targetJson: older, stackJson: { state: "ready", patches: [] } }).file);
  assert.deepEqual([...none.patches], [], "a stack built without any says so");
  for (const [what, stackJson] of [["no stack.json", undefined], ["an unreadable one", "{torn"], ["one with no patches field", { state: "ready" }]]) {
    const c = loadTarget(runFiles({ targetJson: older, stackJson }).file);
    assert.equal(c.patches, null, what);
    assert.deepEqual([...c.capabilities].filter((x) => x.startsWith("patch:")), [], what);
  }
});
