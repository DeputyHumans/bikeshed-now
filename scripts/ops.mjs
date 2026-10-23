// SPDX-License-Identifier: Apache-2.0
// Explicit operator provisioning and read-only CI audits; no automatic recovery (SPEC §12).
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cloudClient } from "./lib/ops-cloud.mjs";
import { provisionMonitoring } from "./lib/ops-monitoring.mjs";
import { audit, ensureMarker, ensureRuntimePolicy, fleet, snapshot, sourceEvidence, writeEvent } from "./lib/ops-runtime.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  project: { type: "string" }, region: { type: "string", default: "us-central1" }, account: { type: "string" },
  origin: { type: "string" }, email: { type: "string" }, bucket: { type: "string" }, output: { type: "string" },
  apply: { type: "boolean", default: false }, monitoring: { type: "boolean", default: false }, result: { type: "string" },
} });
const [command] = positionals;
if (!values.project || !/^[a-z][a-z0-9-]+$/.test(values.project)) throw new Error("An explicit --project is required");
const client = cloudClient({ account: values.account });
function emit(result) {
  if (values.output) { mkdirSync(dirname(values.output), { recursive: true }); writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); }
  console.log(JSON.stringify(result, null, 2));
}
try {
  switch (command) {
    case "snapshot": emit({ at: new Date().toISOString(), repository: sourceEvidence(), functions: snapshot(await fleet(client, values)) }); break;
    case "runtime-policy":
      if (!values.apply) throw new Error("Runtime maintenance requires --apply");
      emit({ changed: await ensureRuntimePolicy(client, values) }); break;
    case "marker":
      if (!values.apply) throw new Error("Marker creation requires --apply");
      await ensureMarker(client, values.bucket); emit({ marker: "verified" }); break;
    case "provision": {
      const rows = await fleet(client, values);
      const directOrigin = rows.find(({ fn }) => fn.name.endsWith("/health"))?.fn.serviceConfig?.uri;
      if (!directOrigin) throw new Error("Deploy the health function before provisioning uptime checks");
      emit(await provisionMonitoring(client, { ...values, directOrigin })); break;
    }
    case "audit": {
      let report;
      try { report = await audit(client, values); }
      catch (error) { report = { at: new Date().toISOString(), result: "failed", findings: [`Audit could not complete (${error.status ?? "request or configuration failure"})`] }; }
      emit(report);
      await writeEvent(client, values.project, { event: "ops_audit", result: report.result, findings: report.findings });
      if (report.result !== "ok") process.exitCode = 1;
      break;
    }
    case "report":
      if (!["success", "failure", "cancelled", "skipped"].includes(values.result)) throw new Error("Pass a workflow job --result");
      await writeEvent(client, values.project, { event: values.result === "success" ? "deployment_succeeded" : "deployment_failed", result: values.result, run: process.env.GITHUB_RUN_ID ?? "manual" });
      emit({ reported: values.result }); break;
    default: throw new Error("Use snapshot, runtime-policy, marker, provision, audit or report");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
