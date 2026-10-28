// SPDX-License-Identifier: Apache-2.0
// Negative-path coverage for cloud credentials, ownership, runtime audits and health (SPEC §12).
import test from "node:test";
import assert from "node:assert/strict";
import { cloudClient, READ_RETRY_DELAYS_MS } from "../scripts/lib/ops-cloud.mjs";
import { alertDefinitions, dashboardDefinition, owned, provisionMonitoring, reconcileResource, uptimeDefinitions, HEARTBEAT, OWNER } from "../scripts/lib/ops-monitoring.mjs";
import { matchesShape } from "../scripts/lib/ops-cloud.mjs";
import { ENDPOINTS } from "../scripts/lib/endpoints.mjs";
import { fleetFindings, snapshot, probe, ensureMarker, ensureRuntimePolicy, healthConfig } from "../scripts/lib/ops-runtime.mjs";

test("refresh an expired credential once and refuse non-Google forwarding", async () => {
  const tokens = [], calls = [];
  const client = cloudClient({ mint: () => `token-${tokens.push(1)}`, fetcher: async (url, opts) => {
    calls.push(opts.headers.Authorization); return new Response(calls.length === 1 ? "expired" : '{"ok":true}', { status: calls.length === 1 ? 401 : 200 });
  } });
  assert.deepEqual(await client.request("https://logging.googleapis.com/v2/test"), { ok: true });
  assert.deepEqual(calls, ["Bearer token-1", "Bearer token-2"]);
  await assert.rejects(client.request("https://googleapis.com.evil.invalid/"), /Refusing/);
  assert.equal(calls.length, 2);
});

/** A client whose responses are scripted per call, recording methods and pauses. */
function scripted(statuses) {
  const methods = [], waits = [];
  const client = cloudClient({ mint: () => "token", wait: async (ms) => { waits.push(ms); }, fetcher: async (url, opts) => {
    methods.push(opts.method); const status = statuses[Math.min(methods.length, statuses.length) - 1];
    return new Response(status === 200 ? '{"ok":true}' : "unavailable", { status });
  } });
  return { client, methods, waits };
}

test("read through Google's transient errors, backing off, and stop after the last retry", async () => {
  // The 2026-10-28 deploys: one 503 among the snapshot's reads, and nothing deployed.
  const once = scripted([503, 429, 200]);
  assert.deepEqual(await once.client.request("https://us-central1-run.googleapis.com/apis/x"), { ok: true });
  assert.deepEqual(once.waits, READ_RETRY_DELAYS_MS.slice(0, 2));

  const always = scripted([503]);
  await assert.rejects(always.client.request("https://us-central1-run.googleapis.com/apis/x"), (error) => error.status === 503);
  assert.equal(always.methods.length, READ_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(always.waits, READ_RETRY_DELAYS_MS);

  const listed = scripted([502, 200]);
  assert.deepEqual(await listed.client.list("https://cloudfunctions.googleapis.com/v2/f", "functions"), []);
  assert.equal(listed.methods.length, 2);
});

test("never repeat a write, and never retry a read the API refused", async () => {
  // A write that answered 503 may still have landed; sending it again could apply it twice.
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const write = scripted([503, 200]);
    await assert.rejects(write.client.request("https://logging.googleapis.com/v2/entries:write", { method, body: {} }), (error) => error.status === 503);
    assert.deepEqual([write.methods.length, write.waits], [1, []], method);
  }
  for (const status of [400, 403, 404]) {
    const refused = scripted([status, 200]);
    await assert.rejects(refused.client.request("https://us-central1-run.googleapis.com/apis/x"), (error) => error.status === status);
    assert.deepEqual([refused.methods.length, refused.waits], [1, []], String(status));
  }
});

test("reconcile only owned resources, detect drift, and make a second application a no-op", async () => {
  const rows = [{ name: "resources/other", displayName: "same name" }], writes = [];
  const desired = { displayName: "same name", enabled: true, userLabels: { managed_by: OWNER, ops_key: "test" } };
  const client = { list: async () => rows, request: async (url, options) => {
    writes.push(options); const row = { ...options.body, name: "resources/managed" };
    const prior = rows.findIndex((x) => x.name === row.name); if (prior < 0) rows.push(row); else rows[prior] = row; return row;
  } };
  const run = (apply) => reconcileResource({ client, collection: "resources", field: "items", desired, key: "test", apply, changes: [] });
  await run(false); assert.equal(writes.length, 0);
  await run(true); await run(true); assert.equal(writes.length, 1); assert.equal(rows[0].name, "resources/other");
  rows[1].enabled = false; await run(true); assert.equal(writes.length, 2);
  rows.push({ ...rows[1] }); await assert.rejects(run(true), /Duplicate/);
});

test("fleet audit rejects policy, readiness, missing-function and traffic drift; snapshots exclude secrets", () => {
  const raw = { fn: { name: "projects/demo-bikeshed/locations/region/functions/health", state: "ACTIVE", buildConfig: { onDeployUpdatePolicy: {}, environmentVariables: { KEY: "private-value" } }, serviceConfig: { environmentVariables: { SECRET: "private-value" } } },
    run: { status: { conditions: [{ type: "Ready", status: "True" }], latestCreatedRevisionName: "r1", latestReadyRevisionName: "r1", traffic: [{ revisionName: "r1", percent: 100 }] } }, build: {} };
  const good = snapshot([raw]); assert.deepEqual(fleetFindings(good, ["health"]), []);
  assert.ok(!JSON.stringify(good).includes("private-value"));
  for (const mutation of [{ onDeploy: false }, { ready: false }, { latestCreated: "r2" }, { traffic: [{ revisionName: "r0", percent: 100 }] }]) {
    assert.ok(fleetFindings([{ ...good[0], ...mutation }], ["health"]).length);
  }
  assert.deepEqual(fleetFindings([], ["health"]), ["health: missing function"]);
});

test("a cached response, wrong body, error status or network failure cannot satisfy health", async () => {
  const origin = "https://example.invalid";
  const good = () => new Response('{"status":"ok"}', { headers: { "cache-control": "private, no-store" } });
  assert.equal(await probe(origin, async (url) => {
    assert.equal(url.pathname, ENDPOINTS.find((x) => x.fn === "health").path);
    return good();
  }), true);
  for (const response of [new Response('{"status":"ok"}'), new Response('{}', { headers: { "cache-control": "private, no-store" } }), new Response('{"status":"ok"}', { status: 503, headers: { "cache-control": "private, no-store" } })]) {
    assert.equal(await probe(origin, async () => response), false);
  }
  assert.equal(await probe(origin, async () => { throw Error("network"); }), false);
});

test("marker provisioning is create-only, verifies existing bytes and refuses mismatches", async () => {
  let bytes = healthConfig.marker; const calls = [];
  const client = { request: async (url, options) => { calls.push({ url, options }); if (options.method === "POST") throw Object.assign(Error("exists"), { status: 412 }); return bytes; } };
  await ensureMarker(client, "private-test-bucket");
  assert.match(calls[0].url, /ifGenerationMatch=0/); assert.equal(calls[0].options.raw, healthConfig.marker);
  bytes = "different"; await assert.rejects(ensureMarker(client, "private-test-bucket"), /refusing to overwrite/);
});

test("availability requires two failing regions for two minutes and includes repeat notifications", () => {
  const checks = uptimeDefinitions({ origin: "https://example.invalid", directOrigin: "https://direct.invalid" }).map((x, i) => ({ ...x, name: `projects/demo-bikeshed/uptimeCheckConfigs/${i}` }));
  assert.equal(checks.length, 3);
  for (const check of checks.slice(1)) assert.equal(check.httpCheck.path, ENDPOINTS.find((x) => x.fn === "health").path);
  for (const check of checks) { assert.equal(check.disabled, false); assert.equal(check.period, "60s"); assert.equal(check.selectedRegions.length, 3); assert.equal(check.timeout, "10s"); }
  const policies = alertDefinitions({ project: "demo-bikeshed", channel: "channels/test", checks });
  assert.equal(policies.length, 8);
  for (const policy of policies.slice(0, 3)) {
    assert.equal(policy.conditions[0].conditionThreshold.thresholdValue, 1);
    assert.equal(policy.conditions[0].conditionThreshold.duration, "120s");
    assert.equal(policy.alertStrategy.notificationChannelStrategy[0].renotifyInterval, "1800s");
    assert.deepEqual(policy.alertStrategy.notificationPrompts, ["OPENED", "CLOSED"]);
  }
});

test("runtime maintenance patches only the policy and skips functions already using it", async () => {
  const calls = [];
  const client = { list: async () => [
    { name: "projects/demo-bikeshed/locations/region/functions/health", buildConfig: { automaticUpdatePolicy: {} }, serviceConfig: { environmentVariables: { SECRET: "untouched" } } },
    { name: "projects/demo-bikeshed/locations/region/functions/session", buildConfig: { onDeployUpdatePolicy: {} } },
  ], request: async (url, options) => { calls.push({ url, ...options }); return { done: true }; } };
  assert.deepEqual(await ensureRuntimePolicy(client, { project: "demo-bikeshed", region: "region" }), ["health"]);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("updateMask"), "buildConfig.automaticUpdatePolicy,buildConfig.onDeployUpdatePolicy");
  assert.deepEqual(calls[0].body, { name: "projects/demo-bikeshed/locations/region/functions/health", buildConfig: { onDeployUpdatePolicy: {} } });
});

test("a delayed audit schedule is not an alert", () => {
  // GitHub delivered the hourly audit about six times a day, up to 6.9 hours apart, so any absence threshold was noise.
  const keys = alertDefinitions({ project: "demo-bikeshed", channel: "channels/test", checks: [] }).map((x) => x.userLabels.ops_key);
  assert.equal(keys.includes("audit_missing"), false);
  assert.equal(keys.some((key) => /audit/.test(key)), false);
});

test("provisioning deletes only owned policies it no longer defines, then the owned heartbeat metric", async () => {
  const fields = ["notificationChannels", "uptimeCheckConfigs", "alertPolicies", "dashboards", "metrics"];
  const store = Object.fromEntries(fields.map((field) => [field, []])), requests = [];
  store.alertPolicies.push({ name: "projects/demo-bikeshed/alertPolicies/retired", userLabels: { managed_by: OWNER, ops_key: "audit_missing" } },
    { name: "projects/demo-bikeshed/alertPolicies/theirs", userLabels: { ops_key: "audit_missing" } });
  store.metrics.push({ name: HEARTBEAT, description: `Managed by ${OWNER}. Hourly audit completed (success or failure).` });
  const client = { list: async (_url, field) => [...store[field]], request: async (url, { method, body }) => {
    requests.push({ url, method });
    const field = fields.find((x) => url.includes(`/${x}`)), rows = store[field];
    const index = rows.findIndex((x) => url.endsWith(`/${x.name.split("/").at(-1)}`));
    if (method === "DELETE") { rows.splice(index, 1); return {}; }
    const row = { ...body, name: body.name ?? `projects/demo-bikeshed/${field}/${requests.length}` };
    if (method === "PATCH") rows[index] = row; else rows.push(row);
    return row;
  } };
  const run = (apply) => provisionMonitoring(client, { project: "demo-bikeshed", email: "ops@example.invalid",
    origin: "https://example.invalid", directOrigin: "https://direct.invalid", apply });
  const dry = await run(false);
  assert.deepEqual(dry.changes.filter((x) => x.startsWith("delete:")), ["delete: audit_missing", "delete: audit heartbeat metric"]);
  assert.equal(requests.length, 0);
  await run(true);
  assert.deepEqual(requests.filter((x) => x.method === "DELETE").map((x) => x.url), [
    "https://monitoring.googleapis.com/v3/projects/demo-bikeshed/alertPolicies/retired",
    `https://logging.googleapis.com/v2/projects/demo-bikeshed/metrics/${HEARTBEAT}`,
  ]);
  assert.deepEqual(store.alertPolicies.filter((x) => !owned(x)).map((x) => x.name), ["projects/demo-bikeshed/alertPolicies/theirs"]);
  assert.deepEqual((await run(true)).changes, []);
  store.metrics.push({ name: HEARTBEAT, description: "Someone else's audit counter." });
  assert.deepEqual((await run(true)).changes, []);
  assert.equal(requests.filter((x) => x.method === "DELETE").length, 2);
});

test("provider notifications exclude resolutions, unrelated incidents and routine description updates", () => {
  const policy = alertDefinitions({ project: "demo-bikeshed", channel: "channels/test", checks: [] }).find((x) => x.userLabels.ops_key === "provider_incident");
  // Pin the API filter, rather than a local reimplementation of Cloud Logging matching.
  assert.equal(policy.conditions[0].conditionMatchedLog.filter,
    'log_id("servicehealth.googleapis.com/activity") AND jsonPayload.category="INCIDENT"' +
    ' AND jsonPayload.state="ACTIVE" AND jsonPayload.detailedState="CONFIRMED"' +
    ' AND jsonPayload.relevance=("IMPACTED" OR "RELATED")' +
    ' AND (labels."servicehealth.googleapis.com/new_event"="true" OR labels."servicehealth.googleapis.com/updated_fields":("state" OR "relevance"))');
  assert.equal(policy.severity, "WARNING");
});

test("dashboard reconciliation tolerates the API omitting default empty scalar fields", () => {
  const desired = dashboardDefinition("demo-bikeshed");
  const api = JSON.parse(JSON.stringify(desired, (_key, value) => value === "" ? undefined : value));
  assert.ok(matchesShape(api, desired));
  api.gridLayout.widgets[1].xyChart.dataSets[0].timeSeriesQuery.timeSeriesFilter.filter = "wrong metric";
  assert.equal(matchesShape(api, desired), false);
});
