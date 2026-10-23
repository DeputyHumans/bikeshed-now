// SPDX-License-Identifier: Apache-2.0
// Owned monitoring definitions and repeatable provisioning without application credentials (SPEC §12).
import { matchesShape } from "./ops-cloud.mjs";

export const OWNER = "bikeshed-ops-v1";
export const HEARTBEAT = "bikeshed_ops_audit_heartbeat";
const labels = (key) => ({ managed_by: OWNER, ops_key: key });
export const owned = (row, key) => row.userLabels?.managed_by === OWNER && (!key || row.userLabels.ops_key === key);
const title = (key) => `Bikeshed: ${key.replaceAll("_", " ")}`;
const metric = (name, resource, extra = "") => `metric.type="${name}" AND resource.type="${resource}"${extra ? ` AND ${extra}` : ""}`;
const sum = (seconds = 300) => [{ alignmentPeriod: `${seconds}s`, perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }];
const threshold = (filter, value, duration = "0s", aggregations = sum()) => ({ filter, comparison: "COMPARISON_GT", thresholdValue: value, duration, aggregations, trigger: { count: 1 } });

export function uptimeDefinitions({ origin, directOrigin }) {
  return [
    ["landing", origin, "/", 'id="root"'],
    ["health_hosted", origin, "/health", '"status":"ok"'],
    ["health_direct", directOrigin, "/health", '"status":"ok"'],
  ].map(([key, base, path, content]) => ({
    displayName: title(key), userLabels: labels(key), disabled: false,
    monitoredResource: { type: "uptime_url", labels: { host: new URL(base).hostname, project_id: "" } },
    httpCheck: { path, port: 443, useSsl: true, validateSsl: true, requestMethod: "GET", acceptedResponseStatusCodes: [{ statusValue: 200 }] },
    contentMatchers: [{ content, matcher: "CONTAINS_STRING" }],
    period: "60s", timeout: "10s", selectedRegions: ["USA_OREGON", "USA_VIRGINIA", "EUROPE"],
  }));
}

export function alertDefinitions({ project, channel, checks }) {
  const docs = `Environment: production. Inspect the operations dashboard and the service logs before changing production.\n\n` +
    `Logs: https://console.cloud.google.com/logs/query?project=${encodeURIComponent(project)}\n\n` +
    `Runbook: https://github.com/DeputyHumans/bikeshed-now/blob/main/docs/operations/monitoring.md\n\n` +
    `Recovery is manual. Closure of a log-only alert does not prove recovery; confirm fresh health probes and ready revisions.`;
  const base = (key, conditions, isLog = false) => ({ displayName: title(key), userLabels: labels(key), enabled: true,
    combiner: "OR", conditions, notificationChannels: [channel], documentation: { content: docs, mimeType: "text/markdown" },
    alertStrategy: isLog ? { notificationRateLimit: { period: "1800s" }, autoClose: "1800s" }
      : { autoClose: "86400s", notificationPrompts: ["OPENED", "CLOSED"], notificationChannelStrategy: [{ notificationChannelNames: [channel], renotifyInterval: "1800s" }] },
  });
  const availability = checks.map((check) => base(`availability_${check.userLabels.ops_key}`, [{
    displayName: "Two regions fail for two minutes",
    conditionThreshold: threshold(metric("monitoring.googleapis.com/uptime_check/check_passed", "uptime_url", `metric.labels.check_id="${check.name.split("/").at(-1)}"`), 1, "120s",
      [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_NEXT_OLDER", crossSeriesReducer: "REDUCE_COUNT_FALSE", groupByFields: ["resource.label.host"] }]),
  }]));
  return [...availability,
    base("backend_errors", [{ displayName: "Five server errors in five minutes", conditionThreshold: threshold(metric("run.googleapis.com/request_count", "cloud_run_revision", 'metric.labels.response_code_class="5xx"'), 4) }]),
    base("startup_failed", [{ displayName: "A revision or service became unready", conditionMatchedLog: {
      filter: 'resource.type="cloud_run_revision" AND protoPayload.serviceName="run.googleapis.com" AND severity>=ERROR AND protoPayload.status.message:"Ready condition status changed to False"',
    } }], true),
    base("event_backlog", [{ displayName: "Event processing has stalled", conditionThreshold: threshold(metric("pubsub.googleapis.com/subscription/oldest_unacked_message_age", "pubsub_subscription", 'resource.labels.subscription_id=monitoring.regex.full_match("eventarc-.*")'), 300, "120s",
      [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_MAX", crossSeriesReducer: "REDUCE_MAX" }]) }]),
    base("operations_attention", [{ displayName: "Deployment, audit or runtime maintenance needs attention", conditionMatchedLog: {
      filter: 'log_id("bikeshed-ops") AND (jsonPayload.event="deployment_failed" OR (jsonPayload.event="ops_audit" AND jsonPayload.result="failed") OR jsonPayload.event="runtime_patch_due")',
    } }], true),
    { ...base("provider_incident", [{ displayName: "Active confirmed provider incident affecting this project", conditionMatchedLog: {
      // Service Health emits description updates and resolutions as INCIDENT logs too.
      filter: 'log_id("servicehealth.googleapis.com/activity") AND jsonPayload.category="INCIDENT"' +
        ' AND jsonPayload.state="ACTIVE" AND jsonPayload.detailedState="CONFIRMED"' +
        ' AND jsonPayload.relevance=("IMPACTED" OR "RELATED")' +
        ' AND (labels."servicehealth.googleapis.com/new_event"="true" OR labels."servicehealth.googleapis.com/updated_fields":("state" OR "relevance"))',
    } }], true), severity: "WARNING",
      documentation: { mimeType: "text/markdown", content: `Google reports a new or materially changed, active confirmed incident affecting this project or a product and location it uses. Check Service Health for the affected product, location, and mitigation. A provider warning alone does not establish a Bikeshed outage.\n\n` +
        `Description-only updates, resolved incidents, and unrelated locations do not send new alerts. Follow the existing provider incident for progress; use fresh availability checks to establish application impact.\n\n${docs}` },
    },
    { ...base("audit_missing", [{ displayName: "Operations audit has not completed for six hours", conditionAbsent: {
      filter: metric(`logging.googleapis.com/user/${HEARTBEAT}`, "global"), duration: "21600s", trigger: { count: 1 }, aggregations: sum(60),
    } }]), severity: "WARNING",
      documentation: { mimeType: "text/markdown", content: `The scheduled metadata audit has not completed for six hours. This is a monitoring gap, not evidence of an application outage.\n\n` +
        `Check the latest operations workflow, its schedule, and authentication. Dispatch it manually if needed. GitHub schedules can be delayed; successful runs have arrived more than five hours apart. The independent minute-by-minute availability checks remain active.\n\n${docs}` },
      alertStrategy: { autoClose: "86400s", notificationPrompts: ["OPENED", "CLOSED"], notificationChannelStrategy: [{ notificationChannelNames: [channel], renotifyInterval: "21600s" }] },
    },
  ];
}

export function dashboardDefinition(project) {
  const chart = (heading, filter, aligner, reducer, groupByFields = []) => ({ title: heading, xyChart: { dataSets: [{ timeSeriesQuery: {
    timeSeriesFilter: { filter, aggregation: { alignmentPeriod: "60s", perSeriesAligner: aligner, crossSeriesReducer: reducer, groupByFields } },
  }, plotType: "LINE" }] } });
  const widgets = [
    { title: "Manual recovery", text: { format: "MARKDOWN", content: `Project: ${project}. Alerts do not trigger deployments or rollbacks. [Runbook](https://github.com/DeputyHumans/bikeshed-now/blob/main/docs/operations/monitoring.md)` } },
    chart("Uptime check success", metric("monitoring.googleapis.com/uptime_check/check_passed", "uptime_url"), "ALIGN_FRACTION_TRUE", "REDUCE_MEAN", ["metric.label.check_id"]),
    chart("5xx by service", metric("run.googleapis.com/request_count", "cloud_run_revision", 'metric.labels.response_code_class="5xx"'), "ALIGN_RATE", "REDUCE_SUM", ["resource.label.service_name"]),
    chart("Request latency p95", metric("run.googleapis.com/request_latencies", "cloud_run_revision"), "ALIGN_PERCENTILE_95", "REDUCE_MAX", ["resource.label.service_name"]),
    chart("Oldest unacknowledged event", metric("pubsub.googleapis.com/subscription/oldest_unacked_message_age", "pubsub_subscription"), "ALIGN_MAX", "REDUCE_MAX", ["resource.label.subscription_id"]),
  ];
  return { displayName: "Bikeshed operations", labels: { managed_by: OWNER }, gridLayout: { columns: "2", widgets } };
}

export async function reconcileResource({ client, collection, field, desired, key, apply, changes }) {
  const rows = await client.list(collection, field);
  const found = rows.filter((row) => owned(row, key));
  if (found.length > 1) throw new Error(`Duplicate managed resource: ${key}`);
  const existing = found[0];
  if (existing && matchesShape(existing, desired)) return existing;
  changes.push(`${existing ? "update" : "create"}: ${key}`);
  if (!apply) return existing ?? { ...desired, name: `planned/${key}` };
  if (existing && desired.conditions) desired = { ...desired, conditions: desired.conditions.map((condition) => {
    const prior = existing.conditions?.find((x) => x.displayName === condition.displayName);
    return prior?.name ? { ...condition, name: prior.name } : condition;
  }) };
  return client.request(existing ? `${collection}/${existing.name.split("/").at(-1)}` : collection,
    { method: existing ? "PATCH" : "POST", body: { ...desired, ...(existing ? { name: existing.name } : {}) } });
}

export async function provisionMonitoring(client, options) {
  const { project, email, origin, directOrigin, apply = false } = options;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A notification email is required");
  for (const base of [origin, directOrigin]) if (new URL(base).protocol !== "https:") throw new Error("HTTPS origins are required");
  const prefix = `https://monitoring.googleapis.com/v3/projects/${project}`;
  const changes = [];
  const channel = await reconcileResource({ client, collection: `${prefix}/notificationChannels`, field: "notificationChannels", key: "email", apply, changes,
    desired: { displayName: "Bikeshed incident email", type: "email", labels: { email_address: email }, userLabels: labels("email"), enabled: true } });
  const checks = [];
  for (const check of uptimeDefinitions({ origin, directOrigin })) {
    check.monitoredResource.labels.project_id = project;
    checks.push(await reconcileResource({ client, collection: `${prefix}/uptimeCheckConfigs`, field: "uptimeCheckConfigs", desired: check, key: check.userLabels.ops_key, apply, changes }));
  }
  const metricsUrl = `https://logging.googleapis.com/v2/projects/${project}/metrics`;
  const heartbeat = { name: HEARTBEAT, disabled: false, description: `Managed by ${OWNER}. Hourly audit completed (success or failure).`,
    filter: 'log_id("bikeshed-ops") AND jsonPayload.event="ops_audit"', metricDescriptor: { metricKind: "DELTA", valueType: "INT64", unit: "1" } };
  const existingMetric = (await client.list(metricsUrl, "metrics")).find((x) => x.name === HEARTBEAT);
  if (existingMetric && !existingMetric.description?.startsWith(`Managed by ${OWNER}.`)) throw new Error("Heartbeat metric belongs to another operator");
  if (!existingMetric || !matchesShape(existingMetric, heartbeat)) {
    changes.push("ensure: audit heartbeat metric");
    if (apply) await client.request(existingMetric ? `${metricsUrl}/${HEARTBEAT}` : metricsUrl, { method: existingMetric ? "PUT" : "POST", body: heartbeat });
  }
  for (const desired of alertDefinitions({ project, channel: channel.name, checks })) {
    await reconcileResource({ client, collection: `${prefix}/alertPolicies`, field: "alertPolicies", desired, key: desired.userLabels.ops_key, apply, changes });
  }
  const dashUrl = `https://monitoring.googleapis.com/v1/projects/${project}/dashboards`;
  const dashboards = (await client.list(dashUrl, "dashboards")).filter((x) => x.labels?.managed_by === OWNER);
  if (dashboards.length > 1) throw new Error("Duplicate managed dashboard");
  const desired = dashboardDefinition(project), current = dashboards[0];
  if (!current || !matchesShape(current, desired)) {
    changes.push("ensure: operations dashboard");
    if (apply) await client.request(current ? `https://monitoring.googleapis.com/v1/${current.name}` : dashUrl,
      { method: current ? "PATCH" : "POST", body: { ...desired, ...(current ? { name: current.name, etag: current.etag } : {}) } });
  }
  return { changes, checkNames: checks.map((x) => x.name), channel: channel.name };
}
