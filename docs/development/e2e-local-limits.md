# Local E2E proof boundaries

## Firestore trigger overlap

Firebase CLI 15.25.1 uses Firestore emulator 1.22.0. The audited JAR has SHA-256
`9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`.
Its `CloudFirestore.init` passes a `ThreadPoolExecutor` with zero core threads,
four maximum threads, and an unbounded `LinkedBlockingQueue` to
`FunctionsEmulatorEventPublisher`. Once its first worker exists, later deliveries
queue behind it: an unbounded queue never requires expansion toward that maximum.
The publisher waits synchronously for each handler's HTTP response. The Node
Functions worker pool receives these deliveries one at a time; raising its
parallel-work limit or warming its workers cannot create missing deliveries.

Run the pinned structural and behavioral probe without starting a stack:

```sh
node tools/probe-e2e-trigger-queue.mjs > trigger-boundary.json
```

It uses the same `E2E_FIREBASE_BIN` and `E2E_JAVA_BIN` overrides as the harness,
checks the installed CLI and emulator versions and JAR digest, inspects the actual
bytecode, and runs the observed executor configuration in the selected JVM.
While the first task is held by a latch, three further tasks remain queued.
An independent four-core counterfactual starts all four tasks and leaves no queue.
The probe starts no emulator, downloads nothing, and refuses unknown versions or
changed bytecode. A skipped installed-JAR self-test is not this proof.

This boundary applies only to **C15's automatic trigger-overlap witness**. C15's
ordinary checks still require all caused events exactly once (I15), one generated
note per real state transition (I10), and correctly addressed, bounded notices
(I11). Those checks can pass locally. A measured trigger peak of one remains
**INCONCLUSIVE** for cooldown contention, even when every ordinary check passes.
It must never be relabeled PASS or counted as a concurrent-handler proof.

A local acceptance report may document this exact unsupported witness only with
fresh case evidence at every required peer count and trial, the pinned probe's
actual output, and explicit unresolved deployment-bound verification. Broader
completion still requires real overlapping trigger delivery. This document does
not grant an exception to any other inconclusive case or alter the completion
checker. In particular, C14's natural publisher-wins window has no exemption.
