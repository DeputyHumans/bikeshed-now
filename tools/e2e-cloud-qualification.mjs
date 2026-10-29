// SPDX-License-Identifier: Apache-2.0
// Qualify retained cloud cooldown trials and a deployed red/green control against reviewed source archives (SPEC §14).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute } from "node:path";
import { EvidenceArtifacts } from "./e2e-artifact-cache.mjs";
import { judgeCloudCooldownTrial, judgeCloudCooldownMutation } from "./e2e-cloud-cooldown.mjs";

const AdmZip = createRequire(new URL("../functions/package.json", import.meta.url))("adm-zip");
const sha = b => createHash("sha256").update(b).digest("hex");
const need = (ok, why) => { if (!ok) throw new Error(`cloud qualification: ${why}`); };
const guard = "    const last = Number(cooldowns[own] ?? 0);\n    if (now - last < COMMENT_EMAIL_COOLDOWN_MS) return false;\n";
const overlays = new Set(["src/index.ts", "src/oauth/consent.ts", "src/oauth/token.ts", "src/mcp/server.ts", "src/lib/actor.ts", "src/lib/presence.ts", "src/config.ts", "src/email/notify.ts"]);
const timing = new Set(["cloud cooldown: automatic triggers did not overlap", ...["comment", "suggestion"].map(k => `cloud cooldown: ${k} cooldown calls did not overlap on one instance`)]);

/** Reviewed overlays are pinned by the release policy, not trusted merely because the artifact names them. */
export function verifyCloudQualification(ref, { root, version, reviewedOverlays }) {
  const cache = new EvidenceArtifacts();
  const path = p => {
    need(typeof p === "string" && p.startsWith("e2e/.out/") && !isAbsolute(p) && !p.includes("\\") && !relative(root, resolve(root, p)).startsWith(".."), "artifact must remain in ignored evidence directory");
    return resolve(root, p);
  };
  const bound = ref => { const p = path(ref?.artifact); need(/^[a-f0-9]{64}$/.test(ref.sha256) && cache.digest(p) === ref.sha256, "artifact digest differs"); return p; };
  const json = ref => cache.json(bound(ref));
  const m = json(ref);
  need(m.schemaVersion === 1 && m.kind === "cloud-cooldown-qualification" && m.version === version, "manifest kind or version differs");
  const base = [];
  const walk = dir => { for (const e of readdirSync(resolve(root, "functions", dir), { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (e.isFile()) base.push(p); } };
  walk("src"); base.push("package.json", "package-lock.json", "tsconfig.json"); base.sort();
  const archives = {}, deployments = {};
  for (const label of ["natural", "controlled", "red", "restored"]) {
    const d = m.deployments?.[label]; need(d, `missing ${label} deployment`);
    const metadata = json(d.metadata), archive = new AdmZip(readFileSync(bound(d.archive)));
    const entries = archive.getEntries().filter(e => !e.isDirectory);
    const names = entries.map(e => e.entryName);
    need(names.length === new Set(names).size && names.every(n => !isAbsolute(n) && !n.split("/").includes("..")), "archive has ambiguous paths");
    archives[label] = new Map(entries.map(e => [e.entryName, e.getData()]));
    deployments[label] = metadata;
    need(JSON.parse(archives[label].get("package.json")).version === version, "deployed package version differs");
    assert.deepEqual(names.filter(n => !n.startsWith("lib/")).sort(), base, "cloud qualification: deployed source inventory differs");
    if (["natural", "controlled"].includes(label)) {
      const receipt = json(d.comparison);
      assert.deepEqual(receipt.storageSource, metadata.buildConfig?.source?.storageSource, "cloud qualification: archive origin differs from deployment");
      need(receipt.archiveSha256 === d.archive.sha256 && d.archive.sha256 === reviewedOverlays?.[label]?.archive && d.comparison.sha256 === reviewedOverlays[label].comparison && receipt.overlayPatchSha256 === reviewedOverlays[label].patch && cache.digest(bound(d.patch)) === reviewedOverlays[label].patch, "source overlay is not the reviewed patch");
      assert.deepEqual(receipt.files.map(x => x.file).sort(), names.sort(), "cloud qualification: packaged file census differs");
      for (const f of receipt.files) need(sha(archives[label].get(f.file)) === f.sha256, "packaged bytes differ from receipt");
      assert.deepEqual(receipt.baseFiles.map(x => x.file).sort(), base, "cloud qualification: base source census differs");
      for (const f of receipt.baseFiles) {
        need(cache.digest(resolve(root, "functions", f.file)) === f.sha256, "candidate function source changed since cloud verification");
        if (!overlays.has(f.file)) need(sha(archives[label].get(f.file)) === f.sha256, "unapproved source overlay");
      }
    }
  }
  const baseline = archives.controlled;
  for (const label of ["red", "restored"]) {
    assert.deepEqual([...archives[label].keys()].sort(), [...baseline.keys()].sort(), "cloud qualification: control archive census differs");
    const changed = [...baseline].filter(([p, b]) => !b.equals(archives[label].get(p))).map(([p]) => p).sort();
    assert.deepEqual(changed, label === "red" ? ["lib/email/notify.js", "lib/email/notify.js.map", "src/email/notify.ts"] : [], "cloud qualification: control changed unexpected packaged bytes");
  }
  const original = baseline.get("src/email/notify.ts").toString();
  need(original.split(guard).length === 2 && archives.red.get("src/email/notify.ts").toString() === original.replace(guard, ""), "red control is not exactly the cooldown guard removal");
  const seen = new Set();
  const trial = (ref, label, n) => {
    const t = json(ref), d = deployments[label];
    need(t.n === n && !seen.has(t.docId), "wrong trial size or reused fixture"); seen.add(t.docId);
    need(t.deployment?.revision === d.serviceConfig?.revision && t.deployment.functionHash === d.labels?.["firebase-functions-hash"] && d.serviceConfig.service === `projects/${t.deployment.projectId}/locations/${d.name.split("/")[3]}/services/${t.deployment.service}`, "measurement belongs to another deployed build");
    need(!!t.controlled === (label !== "natural"), "natural/controlled classification differs");
    return t;
  };
  const expected = [2, 5, 10, 20].flatMap(n => Array.from({ length: n === 2 ? 10 : n === 5 ? 5 : 3 }, (_, i) => `${n}:${i + 1}`));
  assert.deepEqual(m.trials.map(t => `${t.n}:${t.trial}`).sort(), expected.sort(), "cloud qualification: trial matrix differs");
  let natural = 0, controlled = 0;
  for (const row of m.trials) {
    need(Array.isArray(row.natural) && row.natural.length >= 1 && row.natural.length <= 3, "natural attempt census differs");
    let passed = false;
    for (const attempt of row.natural) {
      const t = trial(attempt, "natural", row.n);
      try { judgeCloudCooldownTrial(t); passed = true; } catch (error) { need(timing.has(error.message), `natural safety failure: ${error.message}`); }
    }
    if (passed) { need(!row.controlled, "controlled evidence hides a naturally satisfied axis"); natural++; }
    else { judgeCloudCooldownTrial(trial(row.controlled, "controlled", row.n)); controlled++; }
  }
  const red = trial(m.red, "red", 2);
  judgeCloudCooldownMutation(red); judgeCloudCooldownTrial(trial(m.restored, "restored", 2));
  cache.assertUnchanged();
  return { natural, controlled, trials: expected.length, redGreen: true };
}
