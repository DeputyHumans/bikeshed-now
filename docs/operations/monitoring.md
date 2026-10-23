# Monitoring and manual recovery

The hourly audit and Cloud Monitoring report problems; neither pauses, rolls
back nor redeploys production. The normal all-functions deployment remains.
`/healthz` reads Firestore and a fixed private Storage marker on every request.
It returns only a status, within five seconds, with `private, no-store` on
success, failure, HEAD and unsupported methods (SPEC §2). A missing Firestore
operational document is acceptable; a missing or different Storage marker is
not. This proves dependency access, not a signed-in user's document workflow.

## Bootstrap

Use an explicit operator account and deployment values from gitignored config.
The operator needs Monitoring administration, log-metric management and Storage
object creation/read. Enable the Monitoring, Logging and Personalized Service
Health APIs. Deploy the health function before creating the uptime checks.

```sh
node scripts/ops.mjs marker --project demo-bikeshed --account "$OPERATOR" --bucket "$BUCKET" --apply
node scripts/ops.mjs provision --project demo-bikeshed --account "$OPERATOR" --origin "$ORIGIN" --email "$INCIDENT_EMAIL"
node scripts/ops.mjs provision --project demo-bikeshed --account "$OPERATOR" --origin "$ORIGIN" --email "$INCIDENT_EMAIL" --apply
```

Provisioning first shows the diff, then reconciles only resources labeled
`managed_by=bikeshed-ops-v1`. It refuses duplicates and a heartbeat metric owned
by someone else. Run it a second time: `changes` must be empty. Marker creation
uses a create-only precondition and never overwrites a different object.

Use a dedicated operations service account with Cloud Functions Viewer, Cloud
Run Viewer, Cloud Build Builds Viewer, Monitoring Viewer, Logging Viewer,
Service Usage Viewer and Logs Writer. Its sole write permission is log output;
it has no deployment, IAM or document-data permissions. Reuse the deployment's
Workload Identity provider with a separate service-account binding restricted
to this repository's main branch. Add `PRODUCTION_OPS_SERVICE_ACCOUNT`,
`PRODUCTION_PUBLIC_ORIGIN` and `PRODUCTION_INCIDENT_EMAIL` as repository secrets. Existing project and provider
secrets are reused. No JSON service-account keys are needed.

The deployer also needs Cloud Build Builds Viewer for evidence and Logs Writer
for the post-deploy audit. Create the marker once with the operator identity;
the deployer needs no new private-bucket write access.

Enable GitHub notification settings → Actions → Email → failed workflows only
for the operator as a separate path when Google authentication or Logging fails.
GitHub schedules can be delayed; the independent two-hour missing-heartbeat
alert detects a stopped audit after its first successful heartbeat.

## Signals

| Signal | Trigger |
|---|---|
| Landing, hosted health, direct health | Every minute from Oregon, Virginia and Europe; two locations failing for two minutes |
| Backend errors | At least five server errors in five minutes |
| Startup/readiness | Ready condition changes to false in Cloud Run system-event logs |
| Event delivery | Eventarc subscription oldest unacknowledged message over five minutes for two minutes |
| Deployment/audit | Failed production workflow or failed/drifting audit |
| Provider | Project-relevant Personalized Service Health incident |
| Audit missing | No audit log heartbeat for two hours |
| Runtime maintenance | Monday 16 UTC: actual function build older than fourteen days |

All notifications go to the configured email. Availability incidents send
recovery notifications and repeat after thirty minutes while unresolved.
Log-based alerts throttle to thirty minutes; their automatic closure is **not**
evidence of recovery. The dashboard shows uptime, backend errors, p95 latency
and event backlog. The audit checks the desired monitoring definitions, enabled
channel, Service Health API, ready revisions, traffic and runtime policy.

Runtime security updates apply on deployment. `preserveExternalChanges` keeps
the operator-set policy; the deployment explicitly sets it on new or drifting
functions. A metadata-only policy patch can rebuild a function, so only the
deployment/operator identity runs it. The audit never does. A Firebase
"Skipped (No changes detected)" is not a runtime refresh. When reminded, plan
and execute an actual rebuild, verify its Cloud Build completion time, and
observe production. No scheduled production refresh is enabled.

## Incident response

1. Check the three probes and dashboard. A healthy landing with failing health
   probes points to backend/dependencies. Hosted-only failure suggests routing;
   direct failure removes Hosting from the path. Inspect affected revisions and
   provider health before deciding the cause.
2. Preserve the previous successful workflow's evidence and the failing run's
   `deployment-evidence` artifact. These allowlisted metadata snapshots contain
   revision, build, runtime, source-reference/config hashes and traffic, plus
   the checked-out commit and file hashes. Compare the previous successful
   deployment's manifest with the new one; a source-reference hash alone does
   not establish equal archive contents. Artifacts contain no environment
   values, credentials, user content or raw request logs. Artifacts expire in
   thirty days; retain selected incident evidence privately before expiry.
3. If deployment is worsening the incident, an operator may set
   `DEPLOY_PAUSED=true`. Record its prior value and restore that value afterward.
   No alert changes this switch. A traffic rollback helps only when its target
   revision can actually start; test it before routing users to it.
4. Compare application source and actual build/runtime evidence. Shared startup
   failure across unchanged old and new revisions can be a platform/runtime
   failure. Do not call that hypothesis a confirmed provider root cause without
   provider evidence. Preserve logs and operation IDs for escalation.
5. Apply a reviewed fix, runtime rebuild or known-good release manually. Verify
   every function active, latest revision ready, traffic at 100%, and on-deploy
   runtime policy. Verify fresh public and direct health and one authenticated
   private document in a normal browser. Observe at least fifteen clean minutes
   (startup errors, backend errors, health and event backlog) before closure.

## Delivery drill

Create a temporary copy of an uptime check with a deliberately impossible body
matcher and a dedicated alert pointing to the real email channel. Do not break
an application dependency. Wait for the incident and confirm the email actually
arrives. Restore the correct matcher; wait for recovery and its email. Delete
only the temporary check and policy. A successful API response alone does not
prove email delivery. Repeat after changing recipients and periodically.
