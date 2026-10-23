// SPDX-License-Identifier: Apache-2.0
// Negative-path coverage for cloud credentials, ownership, runtime audits and health (SPEC §12).
import test from "node:test";
import assert from "node:assert/strict";
import { cloudClient } from "../scripts/lib/ops-cloud.mjs";
import { alertDefinitions, dashboardDefinition, reconcileResource, uptimeDefinitions, OWNER } from "../scripts/lib/ops-monitoring.mjs";
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
  assert.equal(policies.length, 9);
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

test("dashboard reconciliation tolerates the API omitting default empty scalar fields", () => {
  const desired = dashboardDefinition("demo-bikeshed");
  const api = JSON.parse(JSON.stringify(desired, (_key, value) => value === "" ? undefined : value));
  assert.ok(matchesShape(api, desired));
  api.gridLayout.widgets[1].xyChart.dataSets[0].timeSeriesQuery.timeSeriesFilter.filter = "wrong metric";
  assert.equal(matchesShape(api, desired), false);
});
