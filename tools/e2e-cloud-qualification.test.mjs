// SPDX-License-Identifier: Apache-2.0
// Cloud release qualification refuses missing axes, stale source, unreviewed overlays and ineffective deployed controls (SPEC §14).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCloudQualification } from "./e2e-cloud-qualification.mjs";
import { cloudQualificationFixture } from "./e2e-cloud-qualification-fixture.mjs";

function fixture(t) { const root = mkdtempSync(join(tmpdir(), "cloud-qualification-")); t.after(() => rmSync(root, { recursive: true, force: true })); return cloudQualificationFixture(root); }
test("complete natural and controlled trials retain their separate counts and a deployed red/green control", t => {
  const x = fixture(t); assert.deepEqual(verifyCloudQualification(x.ref, x), { natural: 20, controlled: 1, trials: 21, redGreen: true });
});
for (const [name, change, pattern] of [
  ["missing axis", x => x.manifest.trials.pop(), /matrix differs/],
  ["duplicate axis", x => x.manifest.trials[1] = x.manifest.trials[0], /matrix differs/],
  ["missing controlled fallback", x => delete x.manifest.trials[0].controlled, /artifact/],
  ["reused trial", x => x.manifest.trials[2].natural = x.manifest.trials[1].natural, /reused fixture/],
  ["stale candidate source", x => x.write("functions/src/email/notify.ts", "changed"), /candidate function source changed/],
  ["unreviewed overlay", x => x.reviewedOverlays.controlled.patch = "b".repeat(64), /reviewed patch/],
  ["different release", x => x.version = "0.2.0", /version differs/],
  ["red evidence replaced by green", x => { const t = x.read(x.manifest.red); t.messages = t.messages.filter(m => !m.id.endsWith("-duplicate")); for (const r of t.logs.filter(r => r.jsonPayload.phase === "result")) r.jsonPayload.granted = r.labels.execution_id.endsWith("-0"); x.manifest.red = x.put("green-as-red.json", t); }, /mutation did not expose/],
  ["unrestored deployed source", x => x.manifest.deployments.restored.archive = x.manifest.deployments.red.archive, /unexpected packaged bytes/],
  ["changed artifact bytes", x => x.write(x.manifest.trials[0].natural[0].artifact, {}), /digest differs/],
  ["another runtime revision", x => { const r = x.manifest.trials[0].controlled, t = x.read(r); t.deployment.revision += "-other"; x.manifest.trials[0].controlled = x.put("wrong-revision.json", t); }, /another deployed build/],
  ["natural safety failure hidden by timing", x => { const r = x.manifest.trials[0].natural[0], t = x.read(r); t.messages.push({ ...t.messages[0], id: "extra" }); x.manifest.trials[0].natural[0] = x.put("unsafe.json", t); }, /natural safety failure/],
]) test(`refuses ${name}`, t => { const x = fixture(t); change(x); assert.throws(() => verifyCloudQualification(x.save(), x), pattern); });
