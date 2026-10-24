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
completion still requires real overlapping trigger delivery. This exception
does not apply to any other inconclusive case. C14's natural publication-first
window has no emulator-impossibility exemption; its separate reviewed safety
contract below preserves that unobserved result.

After the full matrix has finished on frozen source, capture its bound diagnostic
and import a qualifying run into a proposal:

```sh
node tools/e2e-campaign-evidence.mjs capture-local-limit \
  --campaign e2e/.out/frozen-campaign.json --out e2e/.out/trigger-limit.json
node tools/e2e-campaign-evidence.mjs import-run \
  --campaign e2e/.out/frozen-campaign.json --cell concurrency-natural-n20 \
  --artifact e2e/.out/RUN/invocations/INVOCATION/results.json \
  --local-limit e2e/.out/trigger-limit.json --out e2e/.out/proposed-campaign.json
node tools/check-e2e-campaign.mjs --local-only --json e2e/.out/proposed-campaign.json
```

The importer requires all plan trials at the selected N, a passing ordinary C15
work case for each trial, three retained serial-delivery attempts, and the exact
overlap judge's original INCONCLUSIVE outcome. It binds the probe, measurements
and completed invocation metadata by digest, requires the same frozen revision,
version and source fingerprint, and rejects interrupted or partially merged runs.
The run proof says `LOCAL-LIMIT`; it is neither a passing case proof nor a negative
control's green side. No finding is closed by importing it.

The checker reports `localComplete` separately from `complete`. Any accepted local
limitation keeps `complete: false` and lists the unresolved deployment witnesses.
Only the explicit `--local-only` command may exit successfully on local completion;
the default full-completion command continues to fail. Other incomplete cases,
continue to block both. C14 can qualify only through its separate, fully bound
composite safety contract; its original natural observation remains incomplete.


## C14 publication and feedback serialization

A natural burst can prove safe refusal when feedback reaches the current version
first. It cannot prove the opposite transaction order happened. The natural C14
work and browser-fidelity cases retain their ordinary assertions; the agent
publication-first judge remains **INCONCLUSIVE** when no publication occurred.
Neither warming a successful commit nor observing many refusals proves that a
natural publication-first order is impossible.

The reviewed **COMPOSITE-SAFETY** contract keeps every original case identifier,
peer count and planned trial: N=2,5,10,20 with 10,5,3,3 trials respectively. Every
natural attempt must have the original simultaneous mixed request burst, at most
15 ms fire spread, measured wire overlap, correct feedback targets, and either
an actual publication or the exact documented open-review refusal. A refusal
must preserve the complete saved-draft metadata, editing epoch, version records,
and the paths and SHA-256 digests of directly read draft and version object bytes.
A missed publication window retains all three fresh attempts and the raw
conditional judge's INCONCLUSIVE result.

The complementary forced cases must pass at every original peer count and trial.
Comments and suggestions are held after observing v1, publication must actually
make v2 current before release, and stale current-only feedback must not remain
open on v1. The two reverse-order cases hold publication after its early check
and upload, allow either agent comments or browser threads to land, and require
the transaction to refuse while preserving the saved publication state. Browser
comments intentionally retain their selected historical version and passage.
Existing update races, historical-browser checks and serial baselines remain
required. Deterministic N=2 directional controls separately prove the precise
refusal, metadata, byte-preservation, suggestion-head and browser-recheck oracles;
they do not replace any positive peer-count or trial cell.

A composite evidence artifact must bind the frozen source, completed natural and
forced invocations, exact result records, every attempt measurement, byte
inventories, gate receipts and the actual matching negative-control pairs. Only
the exact unachieved natural agent judge may qualify for this reviewed local
acceptance path. Its raw result is never relabeled PASS, generic errors or
cutoffs never qualify, and the C15 trigger limitation is a separate obligation.
Full original completion remains false while natural publication-first is
unobserved; local acceptance reports the composite safety evidence and that
remaining observation separately. Adding assertions or a proposed artifact does
not itself supply acceptance evidence or close the campaign finding.


### Capture and import the separate C14 assessment

After the frozen campaign's runs and control pairs finish, prepare a JSON
manifest under `e2e/.out/` with three arrays of repository-relative paths:

| Field | Required artifacts |
|---|---|
| `natural` | Four final `results.json` files: the unfiltered natural concurrency cells at N=2,5,10,20 |
| `forced` | Four final `results.json` files: the C13 cells at N=2,5,10,20, with the original ordered `amplify-c08-mint-races` and `amplify-c13-feedback` patches |
| `controlLedgers` | Finished actual runner `ledger.json` files establishing each of the ten C14 directional pairs exactly once |

Import those control ledgers into the prepared campaign candidate first. The
original `W2-C14-SYNC-T-judges` item must remain `in-progress`, with its claim,
baseline and every original required case intact. The capture command reads
completed artifacts only; it does not run tests, change outcomes or close items:

```bash
node tools/e2e-campaign-evidence.mjs capture-composite \
  --campaign e2e/.out/prepared-campaign.json \
  --manifest e2e/.out/c14-manifest.json \
  --out e2e/.out/c14-composite.json

node tools/e2e-campaign-evidence.mjs import-run \
  --campaign e2e/.out/prepared-campaign.json \
  --artifact e2e/.out/<run>/invocations/<invocation>/results.json \
  --cell concurrency-natural-n2 \
  --composite e2e/.out/c14-composite.json \
  --out e2e/.out/proposed-campaign.json
```

Repeat import for every corresponding natural and C13 cell, using the previous
candidate as the next input. If the same run also has the precisely qualified
C15 trigger-overlap outcome, supply `--local-limit e2e/.out/local-limit.json`
as well. Neither assessment can exempt the other's raw observations. Every
other failed, TODO or inconclusive case still blocks import and local acceptance.

Capture binds final reporter records, completed invocation metadata, measurements,
stack fingerprints, control definitions and actual control ledgers by digest.
It verifies every cumulative attempt diagnostic and requires capture after all
referenced runs and control ledgers ended. All evidence must use the same frozen
revision, version and source fingerprint; a source change during capture refuses
the proposal. Control tree selectors may be `HEAD`, a revision or `worktree`;
the immutable commit and both actual stack fingerprints establish their source.
The default checker still exits unsuccessfully while the original observation
remains incomplete. Only `--local-only` can report the separate local acceptance.
