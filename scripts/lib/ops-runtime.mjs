// SPDX-License-Identifier: Apache-2.0
// Read-only fleet audits, explicit runtime maintenance and redacted deployment evidence (SPEC §12).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { functionNames } from "./endpoints.mjs";
import { mapLimit } from "./ops-cloud.mjs";
import { provisionMonitoring, OWNER, owned } from "./ops-monitoring.mjs";

export const healthConfig = JSON.parse(readFileSync(new URL("../../functions/src/health.json", import.meta.url), "utf8"));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const functionsUrl = (project, region) => `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/${region}/functions`;

export function sourceEvidence() {
  const paths = execFileSync("git", ["ls-files", "-z", "--", "functions"], { encoding: "utf8" }).split("\0").filter(Boolean);
  return { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    files: Object.fromEntries(paths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])) };
}

export async function fleet(client, { project, region }) {
  const rows = await client.list(functionsUrl(project, region), "functions");
  return mapLimit(rows, 4, async (fn) => {
    const service = fn.serviceConfig?.service?.split("/").at(-1);
    const run = service ? await client.request(`https://${region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${project}/services/${service}`) : {};
    let build = {};
    if (fn.buildConfig?.build) build = await client.request(`https://cloudbuild.googleapis.com/v1/${fn.buildConfig.build}`);
    return { fn, run, build };
  });
}

/** Only allowlisted metadata and hashes leave the process. Never serialize raw configs or logs. */
export function snapshot(rows) {
  return rows.map(({ fn, run, build }) => ({
    function: fn.name.split("/").at(-1), state: fn.state, updated: fn.updateTime,
    runtime: fn.buildConfig?.runtime, onDeploy: fn.buildConfig?.onDeployUpdatePolicy != null && fn.buildConfig?.automaticUpdatePolicy == null,
    build: fn.buildConfig?.build?.split("/").at(-1), built: build.finishTime, buildStatus: build.status,
    sourceReferenceHash: digest(fn.buildConfig?.source ?? {}), settingsHash: digest({ service: fn.serviceConfig, trigger: fn.eventTrigger }),
    ready: run.status?.conditions?.find((c) => c.type === "Ready")?.status === "True",
    latestCreated: run.status?.latestCreatedRevisionName, latestReady: run.status?.latestReadyRevisionName,
    traffic: (run.status?.traffic ?? []).map(({ revisionName, percent }) => ({ revisionName, percent })),
    runtimeImage: run.spec?.template?.metadata?.annotations?.["run.googleapis.com/base-images"] ?? null,
  })).sort((a, b) => a.function.localeCompare(b.function));
}

export function fleetFindings(rows, expected = functionNames()) {
  const findings = [];
  for (const name of expected) {
    const row = rows.find((x) => x.function === name);
    if (!row) { findings.push(`${name}: missing function`); continue; }
    if (row.state !== "ACTIVE" || !row.ready || row.latestCreated !== row.latestReady) findings.push(`${name}: revision not ready`);
    if (!row.onDeploy) findings.push(`${name}: runtime policy drift`);
    if (row.traffic.reduce((n, t) => n + (t.revisionName === row.latestReady ? (t.percent ?? 0) : 0), 0) !== 100) findings.push(`${name}: traffic not on latest ready revision`);
  }
  return findings;
}

export async function ensureRuntimePolicy(client, options) {
  const rows = await client.list(functionsUrl(options.project, options.region), "functions");
  const expected = new Set(functionNames());
  const changed = [];
  await mapLimit(rows.filter((x) => expected.has(x.name.split("/").at(-1))), 3, async (fn) => {
    if (fn.buildConfig?.onDeployUpdatePolicy != null && fn.buildConfig?.automaticUpdatePolicy == null) return;
    const name = fn.name.split("/").at(-1);
    changed.push(name);
    const operation = await client.request(`https://cloudfunctions.googleapis.com/v2/${fn.name}?updateMask=buildConfig.automaticUpdatePolicy,buildConfig.onDeployUpdatePolicy`,
      { method: "PATCH", body: { name: fn.name, buildConfig: { onDeployUpdatePolicy: {} } } });
    const deadline = Date.now() + 900_000;
    let status = operation;
    while (!status.done && Date.now() < deadline) {
      await delay(10_000);
      status = await client.request(`https://cloudfunctions.googleapis.com/v2/${operation.name}`);
    }
    if (!status.done || status.error) throw new Error(`${name}: runtime policy update did not succeed`);
  });
  return changed.sort();
}

export async function ensureMarker(client, bucket) {
  if (!bucket) throw new Error("Pass the private bucket explicitly");
  const object = encodeURIComponent(healthConfig.storagePath);
  try {
    await client.request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${object}&ifGenerationMatch=0`,
      { method: "POST", raw: healthConfig.marker });
  } catch (error) { if (![409, 412].includes(error.status)) throw error; }
  const bytes = await client.request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${object}?alt=media`, { headers: { Accept: "text/plain" } });
  if (bytes !== healthConfig.marker) throw new Error("Existing health marker differs; refusing to overwrite it");
}

export async function probe(origin, fetcher = fetch) {
  if (new URL(origin).protocol !== "https:") throw new Error("Health probes require HTTPS");
  try {
    const response = await fetcher(new URL("/healthz", origin), { signal: AbortSignal.timeout(10_000), redirect: "error" });
    return response.status === 200 && response.headers.get("cache-control") === "private, no-store" && (await response.text()).trim() === '{"status":"ok"}';
  } catch { return false; }
}

export async function writeEvent(client, project, payload) {
  await client.request("https://logging.googleapis.com/v2/entries:write", { method: "POST", body: {
    logName: `projects/${project}/logs/bikeshed-ops`, resource: { type: "global", labels: { project_id: project } },
    entries: [{ severity: payload.result === "failed" || payload.event === "deployment_failed" ? "ERROR" : "INFO", jsonPayload: payload }],
  } });
}

export async function audit(client, options) {
  const findings = [], rows = await fleet(client, options), evidence = snapshot(rows);
  findings.push(...fleetFindings(evidence));
  const directOrigin = rows.find(({ fn }) => fn.name.endsWith("/health"))?.fn.serviceConfig?.uri;
  for (const [label, base] of [["hosted", options.origin], ["direct", directOrigin]]) {
    if (!base || !await probe(base)) findings.push(`${label}: health probe failed`);
  }
  if (options.monitoring) {
    const prefix = `https://monitoring.googleapis.com/v3/projects/${options.project}`;
    const channels = await client.list(`${prefix}/notificationChannels`, "notificationChannels");
    const channel = channels.find((x) => owned(x, "email"));
    if (!channel?.enabled || !channel.labels?.email_address) findings.push("monitoring: email channel missing or disabled");
    else if (directOrigin) {
      const diff = await provisionMonitoring(client, { ...options, directOrigin, apply: false });
      findings.push(...diff.changes.map((x) => `monitoring drift: ${x}`));
    }
    const services = await client.request(`https://serviceusage.googleapis.com/v1/projects/${options.project}/services/servicehealth.googleapis.com`);
    if (services.state !== "ENABLED") findings.push("monitoring: personalized service health disabled");
  }
  // Actual build age, not function updateTime (which also changes for metadata edits).
  const now = options.now ?? new Date();
  if (now.getUTCDay() === 1 && now.getUTCHours() === 16) {
    const stale = evidence.filter((x) => !x.built || now - new Date(x.built) > 14 * 86400_000).map((x) => x.function);
    if (stale.length) await writeEvent(client, options.project, { event: "runtime_patch_due", functions: stale, owner: OWNER });
  }
  return { at: now.toISOString(), result: findings.length ? "failed" : "ok", findings, functions: evidence };
}
