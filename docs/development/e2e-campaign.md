# Local E2E repair campaign

The campaign is **open**. [`e2e/campaign.json`](../../e2e/campaign.json) is the
canonical record of coverage debt, suspected product defects, decisions still
needed, and execution evidence. A zero exit from the E2E runner is insufficient:
it also permits defect TODOs and races that were not reproduced.

The imported baseline is version 0.16.1 at `261d5dc`, with 69 recorded
invocations. Its three critics supplied 239 observations: 205 deep, 13 round one
and 21 round two. Five round-two observations repeat or aggregate earlier
obligations, giving 234 canonical coverage items. All original observations
remain present, and the five overlap mappings retain their complete scope.
The counts reconcile with the original README: 61 historical closures and
173 open coverage items (59 weak oracles, 52 missing controls, 31 missing cases,
14 other, six flaky, five wrong tier, five unclassified and one bad skip).

The 61 closures are bookkeeping from the earlier audit: 14 corrected defect
citations, 25 other deep findings, nine round-one findings and 13 round-two
findings. Their source reports are included. They establish neither a current
product fix nor a current green run. Separately, the ledger retains 61 suspects
in 22 groups and all 38 previously reported questions, intended behavior,
environment limits and harness findings. These remain open until adjudicated
with evidence. The later version-upload dialog and file-drop flows have their
own coverage obligations.

Source identifiers and SHA-256 digests identify the private audit inputs.
Imported prose preserves repository-relative evidence paths; local machine
paths and deployment-shaped values are removed. The raw archive stays outside
the repository. Generated run artifacts remain in gitignored `e2e/.out/`.

## Running the campaign

Use Node 24 and select one installed Firebase CLI explicitly when more than one
is available. The self-test preflight and stack builder now share that selection
and record both versions. The prerequisites and isolation rules are in
[`e2e/README.md`](../../e2e/README.md).

```sh
export E2E_FIREBASE_BIN="$(command -v firebase)"
node --version
"$E2E_FIREBASE_BIN" --version
npm run test:e2e -- --self-test
npm run test:e2e -- run --suite smoke
npm run verify
npm run test:rules:emulated
```

The ledger's `acceptance.requirements` contains 55 explicit command cells: the 51 original cells, the
thumbnail authority variant at N=2, postcommit projection failure, native
transaction acknowledgement loss for endpoints, and the same loss for operator
commands. The original cells comprise
three repository/harness checks, the complete control-set run, plain and capability-enabled smoke, plain
functional, eight functional build variants, and nine concurrency variants at
each of N=2,5,10,20. Print the executable matrix without starting anything:

```sh
node --input-type=module -e 'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync("e2e/campaign.json")); for(const r of c.acceptance.requirements) console.log(r.id+"\n"+r.command+"\n")'
```

The checked-in commands default to immutable HEAD snapshots. For final local
acceptance, commit the integrated source first, prepare the release version
changes, then freeze that worktree. The evidence helper rewrites only tree
selection to `--tree worktree`, preserving all 55 cell IDs and axes, and records
the base SHA, version, source digest and complete control inventory. Evidence
imports are proposals under `e2e/.out/`; they never resolve findings. Keep the
source frozen until the acceptance evidence is complete, then make the release
commit with the reviewed ledger. Recreate a stack after source changes; attaching to a kept
stack never refreshes its code. An efficient area loop is:

```sh
node e2e/run.mjs stack up
node e2e/run.mjs run --attach <runId> --suite functional --spec a07-suggestions.spec.mjs
node e2e/run.mjs stack down <runId>
```

Build capability variants separately. A19 needs measurement, live-consent and
default-marking variants; A20 needs separate parent-directory, uppercase and
underscore skill-name variants, plus the no-server-retry-delay interval probe;
A23 needs email off. Concurrency requires both natural and applicable amplified runs, with the
Storage precondition shim and RTDB proxy. `amplify-c13-feedback` and
`amplify-mint-join` cannot share a stack. The ledger lists the compatible sets.
For authoring use N=2 and `--trials 2`; final measurement omits `--trials` to use
the plan defaults (10,5,3,3 for N=2,5,10,20). Run measurement cells sequentially
under the exclusive tier lock. Keep the load and memory admission gates and
JVM caps intact; an interrupted or refused cell remains incomplete.

## Updating evidence and closing items

`state` is `open`, `in-progress`, `historical-closed` (imported coverage only),
or `resolved`. Keep the original observation and defect IDs. New findings go
in `discoveries`; do not overwrite the baseline. To resolve an item, add a
`resolution` with `kind`, `reason`, a `spec` citation, positive `proofs` IDs and
applicable `controls` IDs. Kinds are `fixed`, `coverage-repair`, `intentional`,
`refuted`, and `local-limit`. A decision requires a stated rationale; a TODO or
failure reclassified as intended behavior is not itself positive evidence.

Prepare the final snapshot without executing any tests:

```sh
node tools/e2e-campaign-evidence.mjs plan --out e2e/.out/final/plan.json
```

This writes the commands and `plan-campaign.json`. The plan also inventories
required case names; a possible rename is reported for review, never silently
aliased. The controls command can run through the bounded parallel wrapper,
which executes ordinary harness workers without changing their stack limits or
admission gates. Finish all control workers before exclusive concurrency cells.
Capture repository checks and import completed evidence explicitly:

```sh
node tools/e2e-campaign-evidence.mjs capture --campaign e2e/.out/final/plan-campaign.json --cell verify --out e2e/.out/final/verify
node tools/e2e-campaign-evidence.mjs import-command --campaign e2e/.out/final/plan-campaign.json --cell verify --artifact e2e/.out/final/verify/command.json --out e2e/.out/final/with-verify.json
node tools/e2e-controls-parallel.mjs --campaign e2e/.out/final/with-verify.json --workers 3 --out e2e/.out/final/controls
node tools/e2e-campaign-evidence.mjs import-command --campaign e2e/.out/final/with-verify.json --cell controls --artifact e2e/.out/final/controls/command.json --out e2e/.out/final/with-controls.json
```

`capture` executes the named command; `plan` and every `import-*` command do
not. Use `import-run --artifact <invocation/results.json> --cell <cell-id>`
for a complete E2E matrix run and `import-controls --artifact <ledger.json>`
for individual control pairs. Continue from the latest proposal each time.
A refused pair stays refused; review the emitted reasons before using the
proposal. Failed, TODO, inconclusive and not-reproduced runs cannot complete a
matrix cell. Imports preserve every finding's state and original observation.

Pin `acceptance.revision`, `acceptance.version` and `acceptance.fingerprint`
to the tested frozen source.
An E2E proof names its `kind` (`e2e-case` or `e2e-run`), `revision`, `version`,
repository-relative `artifact` (the invocation's `results.json`), `runId`,
`invocation` and `outcome`. Case proofs also name the exact `caseId`, `n` (or
null), and `trial` (default one). Dirty stacks additionally need their exact
`fingerprint`; a frozen campaign requires it for every proof, including clean
stacks and commands. Stack fingerprints describe the copied source before
capability or control patches, whose names are checked separately. The checker
reads the result and stack records; labels alone do
not prove a pass. A product fix requires case proofs for every baseline case
and N listed in that item's `requiredCases`. Smoke alone cannot close a defect
that also has functional or concurrency witnesses.

A control names its `mutation`, `red` proof ID, restored `green` proof ID and
the expected `assertion` text. Red must be an actual failure at that assertion;
a timeout, TODO or skipped case is insufficient. E2E pairs must select the same
case ID, N and trial; the assertion must occur in that selected failure's error,
and the red stack must name the mutation. A case title or another failure cannot
authenticate it. Command controls instead name actual assertion diagnostic lines
with `assertionEvidence: {startLine, endLine}` in the red command report; they do
not invent a patched stack. New fixes and coverage
repairs require controls. A positive case on a product-fix or control patch
cannot close the unpatched product. Amplifier and named capability patches are
allowed because they expose the required interleaving or build variant.

Repository commands use `kind: "command"`: `command`, `revision`, `version`,
`artifact`, `outcome` and `logSha256`. The artifact is a JSON record with the
same metadata plus `exitCode`, `tests`, `fail`, `skip`, `todo`, `inconclusive`
and a repository-relative `log`. Save the actual combined output in that log;
the checker verifies its digest and derives counters from the final Node/Vitest
summary. Control aggregates additionally name `controlLedgers` and `controlSets`;
the checker reads the finished runner ledgers, matches each red/green pair and
requires every frozen set exactly once. A subset, duplicate, wrong revision or
unfinished worker cannot satisfy the controls matrix cell.

Assign complete run proofs to each matrix cell's `proofs`. A capability skip
is covered only when the same case, N and trial actually passes on another
variant. A local limitation needs an explicitly resolved `local-limit` item
and a named `acceptance.exclusions` entry (`caseId`, `item`, `reason`); this
records an addressed boundary, not a passed test. No exclusion accepts TODO,
inconclusive, not-reproduced or a failing result. Deployment behavior remains
outside this local campaign; use structural assertions for the documented
emulator blind spots, and retain any remaining boundary explicitly.

```sh
node tools/check-e2e-campaign.mjs --validate  # schema only; never means complete
node tools/check-e2e-campaign.mjs            # strict completion gate
node tools/check-e2e-campaign.mjs --json     # all unresolved obligations/errors
node --test tools/check-e2e-campaign.test.mjs
```

The gate exits 0 only on completion, 1 for open obligations, and 2 for invalid
or unverifiable evidence. `--validate` may exit 0 with open work and always
prints that it is structural validation only.

## Historical live-editing failures

The original stack `2610102145-0a2t` contains four unclassified failures behind
its A11.9/A11.11 flaky labels. Reading the individual invocation records gives
these classifications; later green runs do not erase them:

| Invocation | Case | Classification and evidence |
|---|---|---|
| `20261011T065316Z-p42261-yg5z` | A11.11 | H: the isolation tripwire treated Firestore's connectivity image as an external escape. The harness now blocks and records that exact SDK probe separately. |
| `20261011T132245Z-p33044-5rao` | A11.9 | H: the old 20-second autosave settle bound expired with two of three stable samples already observed; this bound is now 45 seconds. |
| `20261011T135145Z-p11249-uqog` | A11.9 | E: the owner logged Firestore offline at 14:07:06.716Z and 14:07:36.544Z during the 45-second frame wait; the revocation oracle was not reached. |
| `20261011T135145Z-p11249-uqog` | A11.11 | U: setup reached Shared only at +166.52 s, then the 180-second case ended without a completed malformed-rule probe. Earlier Firestore offline notices do not explain the RTDB delay. |

Two earlier red records are deliberate scratch controls, identified by their
invocation metadata: `20261011T055854Z-p65146-nloe` used
`m5-not-revoked.spec.mjs`, and `20261011T060004Z-p69407-suyh` used
`m7-wellformed-cell.spec.mjs`. They are not ordinary product-run failures.
The attempt annotations and their evidence are recorded in [the historical review](e2e-historical-triage.md).
Fresh final-revision A11 runs and applicable controls remain required; the old
three-run stability claim is not carried forward.

The A11 production mirror concern remains outside this local campaign.
Operator initialization now accepts an explicit database URL and uses the
selected demo namespace for emulator runs. Local sharing checks still require
an observed correct mirror, and revoked-editor checks still require its removal.
No production setup failure is excused by a local pass, and no remote mirror
has been repaired or claimed verified by this campaign.

## Catalogue tier correction

A19.4 remains local in this campaign. Its original catalogue describes only
member addition as local, while the same plan's zero-email guard refuses the
whole team endpoint on production. Team creation, rename and deletion do not
send email themselves; the broader guard is a harness policy, not a product
restriction. This campaign adopts that guard consistently for the combined
team lifecycle case, including the second-member admin transitions. It does
not claim production coverage or relax the guard to make a test runnable.
A future production suite may split the non-mailing lifecycle operations after
its guard explicitly permits ledgered team writes (SPEC §17).

The A2 member setup now verifies the stored grant rather than requiring a
member list in the share helper's response. A local browser/API experiment
omits that list, matching the operator response shape: the earlier response
check fails and the stored-grant check passes. This proves the setup contract,
not execution against a deployment.
