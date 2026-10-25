// SPDX-License-Identifier: Apache-2.0
// Build synthetic source archives and complete cloud trial matrices for release-gate controls (SPEC §14).

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fixture, controlledFixture, mutationFixture } from "./e2e-cloud-test-fixture.mjs";

const Zip = createRequire(new URL("../functions/package.json", import.meta.url))("adm-zip");
const sha = b => createHash("sha256").update(b).digest("hex");
export function cloudQualificationFixture(root, version = "0.1.0") {
  const ref = artifact => ({ artifact, sha256: sha(readFileSync(join(root, artifact))) });
  const write = (name, value) => { const p = join(root, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return ref(name); };
  const put = (name, value) => write(`e2e/.out/cloud/${name}`, value);
  const guard = "    const last = Number(cooldowns[own] ?? 0);\n    if (now - last < COMMENT_EMAIL_COOLDOWN_MS) return false;\n";
  const base = { "src/email/notify.ts": guard, "package.json": JSON.stringify({ version }), "package-lock.json": "{}", "tsconfig.json": "{}" };
  for (const [p, b] of Object.entries(base)) write(`functions/${p}`, b);
  const deployments = {}, reviewedOverlays = {};
  for (const label of ["natural", "controlled", "red", "restored"]) {
    const source = { ...base, "lib/email/notify.js": "compiled", "lib/email/notify.js.map": "map" };
    if (label === "red") { source["src/email/notify.ts"] = ""; source["lib/email/notify.js"] = "mutant"; source["lib/email/notify.js.map"] = "mutant map"; }
    const zip = new Zip(); for (const [p, b] of Object.entries(source)) zip.addFile(p, Buffer.from(b));
    const archive = put(`${label}.zip`, zip.toBuffer());
    const storageSource = { bucket: "synthetic", object: `${label}.zip`, generation: "1" };
    const metadata = put(`${label}-deployment.json`, { name: "projects/demo-bikeshed/locations/region/functions/e2ecomment", buildConfig: { source: { storageSource } }, labels: { "firebase-functions-hash": "a".repeat(40) }, serviceConfig: { revision: "e2ecomment-00001", service: "projects/demo-bikeshed/locations/region/services/e2ecomment" } });
    const d = { archive, metadata };
    if (["natural", "controlled"].includes(label)) {
      d.patch = put(`${label}.patch`, "reviewed synthetic patch");
      d.comparison = put(`${label}-comparison.json`, { archiveSha256: archive.sha256, storageSource, overlayPatchSha256: d.patch.sha256, files: Object.entries(source).map(([file, b]) => ({ file, sha256: sha(b) })), baseFiles: Object.entries(base).map(([file, b]) => ({ file, sha256: sha(b) })) });
      reviewedOverlays[label] = Object.fromEntries(["archive", "comparison", "patch"].map(k => [k, d[k].sha256]));
    }
    deployments[label] = d;
  }
  let seq = 0;
  const measure = t => {
    const original = t.docId, id = `e2e-doc-${++seq}`;
    const renamed = JSON.parse(JSON.stringify(t).replaceAll(original, id));
    return put(`measurement-${seq}.json`, renamed);
  };
  const trials = [2, 5, 10, 20].flatMap(n => Array.from({ length: n === 2 ? 10 : n === 5 ? 5 : 3 }, (_, i) => ({ n, trial: i + 1, natural: [measure(fixture(n))] })));
  const first = fixture(); for (const r of first.logs) r.labels.instanceId = r.labels.execution_id;
  trials[0].natural = [measure(first)]; trials[0].controlled = measure(controlledFixture());
  const manifest = { schemaVersion: 1, kind: "cloud-cooldown-qualification", version, deployments, trials, red: measure(mutationFixture()), restored: measure(controlledFixture()) };
  const save = () => put("qualification.json", manifest);
  return { root, version, reviewedOverlays, manifest, ref: save(), save, put, read: r => JSON.parse(readFileSync(join(root, r.artifact))), write };
}
