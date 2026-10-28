# 0018 — Keep the document-open path warm

**Status** Accepted · **Spec** §2

## Context

A document opened in a new tab waits on three Cloud Run services in turn:
`docShell` serves the page, `session` sets the cookie the frame is read with,
and `contentProxy` serves the bytes. Each is its own service and scales to
zero, so after a quiet spell each one starts cold. Measured against production
on 2026-10-27, a cold `docShell` answered in 3.6 s and a cold `contentProxy` in
3.0 s, both 0.2–0.3 s warm — twice what [0011](0011-document-page-through-a-function.md)
measured. Readers saw 3–6 s of "Opening the document…" on a first open, which
is the sum. 0011 named the knob and the condition for turning it: open latency
becoming a complaint.

## Decision

`docShell`, `session` and `contentProxy` run with `minInstances: 1`, through
one `WARM` option set in `functions/src/index.ts`. Nothing else is warm, and
`functions/test/wiring.test.js` fails if the set is anything but these three.

## Consequences

- **A standing charge.** At the live settings (1 vCPU, 256 MiB, request-based
  billing) an idle minimum instance is billed at $0.0000025 per vCPU-second and
  per GiB-second: about $8 a month each, $24 for the three, whether anyone reads
  anything or not. Priced 2026-10-27; the Cloud Run pricing page is the
  authority.
- **Warm is one instance.** A burst past its concurrency of 80, every deploy,
  and an instance Cloud Run replaces still start cold, so what each start loads
  still matters.
- **`unlockDoc` stays cold.** An unlisted document opened by someone who is not
  a member still waits on one cold start ([0012](0012-unlisted-needs-its-link.md)).
- **The console can still disagree.** `preserveExternalChanges` keeps scaling
  set outside the code on every other function, where neither this file nor
  the test can see it.

## What would change this

The floor costing more than first opens are worth: a deployment with almost no
readers can set the three back to zero. Or a first open still taking over a
second with all three warm, which would put the wait in the browser's own
chain — `/session` answering before the document is asked for — rather than in
the services.
