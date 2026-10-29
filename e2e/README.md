# End-to-end suite

Opt-in. Not part of `npm run verify` or CI. It builds an isolated copy of the
product, starts it on its own ports with its own mail catcher, and runs specs
against it through one object, the **Target**. Read **Known weaknesses**
(near the end) before counting a green run as coverage.

```bash
npm run test:e2e -- --self-test                 # the harness's own tests, no stack (needs Chrome)
npm run test:e2e -- run --suite smoke           # stack from HEAD, canaries, functional smoke, stack down
npm run test:e2e -- stack up --tree worktree    # start and keep; prints runId, ports, capabilities
npm run test:e2e -- stack up --email-off --app-env VITE_FIREBASE_MEASUREMENT_ID=dummy
npm run test:e2e -- run --attach <runId> --suite functional --spec e2e/specs/functional/<area>.spec.mjs
npm run test:e2e -- run --attach <runId> --spec-file /abs/scratch/<mutant>.spec.mjs [--grep '<case>']   # a copy outside e2e/specs
npm run test:e2e -- stack up --ttl 1 --jvm-heap firestore=1g   # a shorter lease, a lower Firestore heap
npm run test:e2e -- run --suite concurrency --rtdb-proxy --patches amplify-mint-join --n 2 --trials 1   # the concurrency tier, authoring (N <= 2, trials <= 2: shared lock)
npm run test:e2e -- run --suite concurrency --storage-shim --spec c17-identity.spec.mjs --n 2 --trials 1   # Storage refuses a second create-only write: storage-preconditions
npm run test:e2e -- stack status                # owner, expiry, RSS and heap caps of every stack
npm run test:e2e -- stack down <runId>
npm run test:e2e -- reap                        # orphans of crashed runs, expired stacks, orphaned Chrome (kept stacks stay until expiry)
npm run test:e2e -- report <runId>[/<invId>]    # one invocation's summary
npm run test:e2e -- report <runId> --merge      # every invocation of the run in one table
npm run test:e2e -- compare <a> <b>             # exit 1 on PASS → FAIL or a lost PASS
npm run test:e2e -- classify [--merge] <run> <id> <H|E|P|I|U> <note…>
npm run test:e2e -- controls [<set>…]           # every oracle family red with its patch, green without
```

Browser selection uses `E2E_CHROME` when set, then the installed browser matching
Playwright, then system Chrome. Install the matching build once with
`node node_modules/playwright-core/cli.js install chromium`; tests never download
it implicitly. The selected browser and version remain in pool diagnostics.

Self-tests take the same machine-wide shared tier lock as functional runs.
They wait while a concurrency measurement holds the exclusive lock, and keep
their shared lock until the test child closes. Interrupting self-tests stops
the child process group before releasing that lock.

`run` exits 0 when everything passed (known defects failing as expected,
and NOT REPRODUCED trials, included), 1 when a case failed, the stack failed or was stopped under the
run (an emulator died, its lease ran out), or the stack's teardown left
something running, 3 when a case ended INCONCLUSIVE or a gate never opened
(the concurrency load gate, the memory gate, the machine-wide stack cap), and
130 when interrupted. `stack up` exits 3 when the memory gate or the stack cap
never let the stack start. An interrupt (Ctrl-C, SIGTERM, SIGHUP) stops the
spec processes and the stack the run started before it exits, and `run` and
`stack up` first reap the orphans of crashed runs, expired stacks and
orphaned Chrome processes.

Reader reload controls `controls-c22-reader-place` and
`controls-c22-reader-selection` run their complete C22 work when selected alone.
`controls-c18-toolbar-overflow` targets C18 work at N=5; that work checks both
reachable presence chips and visible phone actions. These cases enforce S28/S29
as ordinary assertions; fresh campaign runs and red controls remain required.
A17.3 seeds and checks canvas runtime pixels through the parent driver before
export because the untrusted upload correctly cannot run its drawing script.

C23 now checks snapshot refusal and explicit recovery instead of accepting
silent whole-document replacement. Its work holds each member's autosave,
saves twice as an unlisted link editor, requires the delayed member requests to
refuse, then reloads members and verifies all accepted edits survive resumed
merging. A separate held-frame case changes the draft after preparing Edit and
checks refusal, non-editability and explicit reload. The six `controls-c23-*`
sets each execute a complete scenario at N=2; the campaign still requires the
main scenario at the approved release counts on fresh integrated stacks.
For the 2026-10-26 release, the explicit scope is N=2,5,10; N=20 is
retained as deferred coverage, not a passing result.

## Outcomes

| | |
|---|---|
| PASS / FAIL | as `node:test` says; a browser request that left the stack FAILS a case whatever its body did (but for the Firestore SDK's own network test, which is blocked and noted: see Users and the browser); a case its spec FILE's failure cancelled (the file's timeout, its process dying) is a FAIL record of its own, `E2E_FILE_CANCELLED` (see Time budgets) |
| INCONCLUSIVE | the case called `ctx.inconclusive(reason)`: a precondition of the measurement did not hold (fire spread over 15 ms HTTP / 40 ms browser, no overlap proof, a peer never "Shared"). Never a pass or a fail; `requireConclusive(ctx, {spread, overlap})` in `lib/sync.mjs` does it for races, and `inconclusiveOnStackTimeout` for a request the stack never answered (see scenario()) |
| TODO | a `defect: "S<n>"` case whose own oracle failed (an assertion in the body, or anything inside `ctx.oracle(…)`), or that passed ("passed unexpectedly": the defect looks fixed). Any other failure — a breach, a sync timeout, a guard refusal, `precondition(…)` — FAILS it |
| NOT REPRODUCED | a `defect:` case whose body called `ctx.notReproduced(reason)`: this trial never reached the defect's window (a natural race that did not race), so it measured neither the defect nor its absence. The plan's class U: listed, never counted as a pass, and no exit 3 (`run` exits as for a TODO). `summary.md` lists each, and counts every scenario's trials per N as `<defect> seen in s of K trials` (Results). A breach still FAILS it |
| SKIP | not for this target or selection, with the reason |

A timed-out case keeps its evidence: it is written, and every user captured,
the moment `node:test` reports the timeout, and the browsers are closed so the
body stops. `--test-force-exit` ends a spec process whose body never settles.

## Results

Each `run` is one **invocation** with a directory of its own,
`e2e/.out/<runId>/invocations/<invId>/`: `invocation.json` (argv, the files
planned per tier, `--spec`, `--grep`, `--n`, tree, patches, stack options,
capabilities, per tier `timeouts`: the file and case timeouts it ran with
and each file's budget, per tier `locks`: the tier lock it took (`mode`,
`authoring`, `reason`, then `acquiredAt` and `waitedMs`; summary.md says
it on a `Tier locks:` line, merged.md in the invocation's row), and `stackDown`: why the stack went away under the
run, when it did — an emulator named as dead, or a lease that ran out; the
cases it cut short have no record), the reporter's `results-<tier>.jsonl`, the merged
`results.json` and `summary.md`, `load.jsonl` (every 5 s the load and the
memory readings: pressure level, swap-outs since the last line, free share,
available bytes, swap used; and a browser pool's memory waits),
`evidence/<case>/`, and any `<name>.jsonl` of measurement rows a spec
appended (`measure`, under For spec authors: kept whatever the outcome).
For verified derived-runtime stacks, `rtdb-runtime.json` binds the invocation
to before/after JVM and rules receipts; `invocation.json` references its digest.
`timings.jsonl` records source materialization and build phases in the stack run
directory, and admission, case body, browser cleanup and maintenance phases in
each invocation. Durations use a monotonic clock; rows include outcome and
process RSS, but no request payloads. Missing timing records are not evidence of
a completed phase. A failed maintenance or unsafe cleanup boundary stops later
case bodies in that spec process with an explicit NOT RUN skip; a fresh stack
is required before retrying them.

The memory gate's waits and refusals for a stack go to
`e2e/.out/<runId>/load.jsonl`.
Parallel `--attach` runs on one stack never delete, overwrite or merge each
other's results. `report`, `compare` and `classify` take `<runId>` when the
run has one invocation, else `<runId>/<invId>` or the directory. A
`--spec-file` run (a scratch copy, see For spec authors) is the same kind of
invocation under `e2e/.out/<runId>/scratch/<invId>/` instead, so no listing,
report or merge of the run's invocations ever includes it; read it with
`report <that directory>`.

**A known defect's rate.** summary.md lists every NOT REPRODUCED case
(`## Not reproduced`: its defect, reason and evidence), and under `##
Known defects per scenario` one line per scenario and N whose trials judged
a known defect, `<file>::<scenario> [N=2]: S4 seen in 3 of 7 trials (4 not
reproduced); not counted: 1 inconclusive`. K counts the trials that judged
the defect: seen (a TODO that failed as expected), not reproduced, and
passed unexpectedly; INCONCLUSIVE, FAIL and plain PASS trials are named
apart, skips left out. A scenario is listed when any trial is NOT
REPRODUCED, or when two or more ran and one judged the defect. The counts
line gains `<k> not reproduced (…)` only when there is one, and `run` logs
the NOT REPRODUCED count and each `rate: <line>`. In `lib/report.mjs`:
`defectRates(records)` → `[{scenario, file, name, n, defect, judged, seen,
notReproduced, passedUnexpectedly, inconclusive, failed, passed, skipped,
trials, ids, text}]` (results.json `summary.rates`; `summary.notReproduced`
is `[{id, defect, reason}]`), and `rateLine(rate)` → `<scenario>: <text>`.
A not-reproduced record (`lib/reporter.mjs`) is `status: "not-reproduced"`,
`outcome: "not-reproduced"`, with `defect` and `notReproduced` (the reason),
keys no other record has; `NOT_REPRODUCED` is that string,
`formatNotReproduced(defect, reason)` → the skip reason scenario() gives it
(`NOT REPRODUCED (known defect "S4"): <reason>`) and
`parseNotReproduced(text)` → `{defect, reason}` or null reads it back
(`NOT_REPRODUCED_PREFIX` = `"NOT REPRODUCED"`).

`report <runId> --merge` reads **every** invocation of a run as one table and
writes `<runDir>/merged.json` and `merged.md`: per case id, the latest outcome
that actually ran (a later SKIP never hides an earlier outcome) and the
invocation that produced it, the outcome history, and **FLAKY** when the
outcomes that ran differ between invocations (pass in one, fail in another; a
known defect failing in one and passing in another; NOT REPRODUCED in one and
the defect seen in another is that race's rate, never FLAKY, and merged.md's
rates count every invocation's trials). "Latest" is by the
record's own finish time, not by when its invocation started: parallel
invocations overlap, and one that started first can run a case last.
`classify --merge <runId> <id> …` resolves the id against that view and keeps
the classification in `<runDir>/classifications.json` together with the
outcome it was made against. It wins over an invocation's own only while that
is still the case's latest outcome. When a newer invocation replaces it, the
classification is **STALE**: it shows as `staleClassification` (and `STALE:`
in `merged.md`), not as `classification`, and a failing case goes back into
`unclassified` until someone classifies it again.

`compare <a> <b>` (two invocations, unchanged by `--merge`) counts a case that
passed in `<a>` as a regression when it fails in `<b>`, and as **lost** when in
`<b>` it is gone, skipped, INCONCLUSIVE, NOT REPRODUCED or a failing known defect — both exit
1. Only a case that `<b>`'s own recorded selection left out is excused, and
listed as filtered.

## Negative controls

`e2e/patches/controls-<family>/` holds one patch set per oracle family and a
`control.json` naming the case it must turn red and the failure message it must
produce. `controls` builds a stack from HEAD without any set and runs every
target case (GREEN: each must pass; one clean stack per distinct suite and
stack options), then one stack per set with that set applied (RED: its target
must fail with that message), and writes both outputs to
`e2e/.out/controls-<stamp>/ledger.json` — a directory each invocation creates
for itself (`controls-<stamp>-<rand4>` when another one started in the same
second holds the stamp's name). A patched stack is built fresh, never
reverted in place: the copy is built once, so a reverted patch would change
nothing that runs.

| set | oracle | the bug it plants |
|---|---|---|
| `controls-decor` | DECOR | a `bshd-` class left on a paragraph by the editor |
| `controls-bodyattr` | BODYATTR | the serializer keeps `contenteditable` on `<body>` |
| `controls-i1-applyremote` | I1/I2 convergence | remote text is never applied |
| `controls-rehash` | REHASH | a commit stores bytes appended after the hash |
| `controls-mcp-tools` | exactly 23 MCP tools | a 32nd tool |
| `controls-cli-list` | CLI `list --json` | the first document dropped |
| `controls-mail-dup` | mail exactly once | every invitation sent twice |
| `controls-annotations` | a comment reaches the other reader | the listener keeps only one's own threads |
| `controls-egress` | the egress guard (smoke canary) | the guard's connect layer lets names through (its DNS layer still refuses, so even the control sends nothing) |
| `controls-email-off` | email off (smoke canary, `--email-off` stack) | `send.ts` no longer trims the whitespace key, so the product tries to send |
| `controls-i2-double-insert` | I2 (concurrency canary) | `applyRemote` writes every remote text insert into the DOM twice |
| `controls-i3-ready-skipped` | I3 (concurrency canary) | the editor binds without awaiting `log.ready()`, so a late joiner seeds a second copy |
| `controls-i6-stale-removed` | I6 (concurrency canary, built on `amplify-mint-join`) | `commitDraft`'s transaction no longer checks that its base is still current |
| `controls-i12-leave-noop` | I12 (concurrency canary) | the presence handle's `leave()` removes nothing |

I11 (at most one email per recipient, document and kind in 30 min) is
controlled by `controls-a23-cooldown`: the window is not checked, so a
second comment's notice is sent, and A23.4 goes red. A control may be built
on an amplify set: its `stack` names `--patches amplify-<name>`, which both
sides get, before the control's own set. The same setup field accepts the
explicit capability-only sets `a19-analytics-live` and
`a20-cli-bad-skill-name`, `a20-cli-uppercase-skill`, `a20-cli-underscore-skill`,
and `a20-cli-no-retry-delay`; arbitrary product-fix or other control sets are
refused there, so the green side cannot silently inherit the mutant. A control may target one case of
a scenario with `n`, as `"<scenario> [N=<k>]"`: both sides then run with
`--n <k> --trials 1` (see Adding a negative control), so no fixed-N copy of
the scenario is needed.

A14 workspace coverage includes independent title, creation, update, view-count
and last-read orders; deeper folder reparenting; silence after moves and folder
deletion; and cover absence windows anchored before navigation and after the
trusted document fetch. A14.7/A14.8 exercise revision uploads through the card
menu and document-frame drops, including format refusal, retry, deduplication,
confirmation and stale-dialog prevention. The `controls-a14-*` sets also target
A17.5c's late account-default and explicit-choice sequence. Their presence is
not execution evidence: the campaign ledger retains pending controls and the
fresh refusal/control proof. A14.7b/A14.8b open each revision dialog before
changing a grant or expiry, and also exercise pending suggestions, accepted
draft changes and a live editor. Refusals retain the selected file, release
progress, and leave version records and stored bytes unchanged; the frame-drop
dialog blocks Publish when it sees the active peer.

A23 also exercises cooldown expiry by aging only its own account's cooldown
keys on a local `admin-emulator` stack, then sending fresh comments and
suggestions through the normal product paths. Its HTML content, recipient,
filing, re-grant and provider-failure controls are listed under
`e2e/patches/controls-a23-*`. Provider failure tests require an actual 200
response. A Hosting or client cutoff remains inconclusive even when the shim
recorded a refusal: timestamps alone do not establish why the product did
not answer. No cutoff counts as a successful failure-handling test.
A23.6c/d hold one recipient's provider response before its headers or midway
through its body. They require the original access request to answer 200 while
that hold remains armed, its connection to be cancelled, and the next recipient
to receive their invitation. These cases require `mail-hold-recipient`; start a
fresh stack to obtain it. Their negative controls disable the deadline or
disconnect its cancellation signal, so a Hosting cutoff cannot substitute for
the product's ten-second provider deadline.

## Prerequisites

| | |
|---|---|
| Node | 24 under `~/.nvm/versions/node/v24.*`, or `E2E_NODE_BIN`; the pinned runtime is verified with 24.21.0 |
| firebase-tools | 15.25.1 on `PATH` (`E2E_FIREBASE_BIN`), with Database 4.11.2 and the other emulator jars already cached in `~/.cache/firebase/emulators` |
| Java | on `PATH` (`E2E_JAVA_BIN`) |
| Mailpit | on `PATH` (`E2E_MAILPIT_BIN`) |
| Chrome | system Chrome for the browser specs; `playwright-core` never downloads one |
| deps | `npm run install:all` in the checkout; stacks symlink its `node_modules` |

`npm run test:tools` provisions the pinned public Database archive through
`pretest:tools`, without a Firebase CLI installation or account. It verifies
an existing tools-test cache or copies a hash-verified Firebase cache; otherwise
it downloads the exact public archive, verifies its SHA-256 and publishes it
atomically under `~/.cache/bikeshed-e2e/fixtures/rtdb/`. Subsequent runs work
offline and verify the cached bytes again. These tests inspect real original
and derived JAR bytes; they do not launch Java or substitute a ZIP inspector.
The first run needs network access unless the pinned archive is already cached.

`--self-test` resolves and checks Node 24 before launching the suite, even
when the calling shell uses another Node version. It also requires an
installed firebase-tools package, prints the selected executables and
versions, and pins `E2E_FIREBASE_BIN` for every child. Stacks use the same
resolver and save these selections in `stack.json`'s `toolchain` field.
An explicit missing or unusable override fails before testing; it never
falls back to a different installation. Individual installed-tool probes
may skip only when no Firebase installation or override exists.

When several Firebase installations exist, set `E2E_FIREBASE_BIN` explicitly
alongside `E2E_NODE_BIN` (the Node 24 bin directory). Merely invoking a
particular `node` does not select a Firebase executable elsewhere on PATH.
The installed-tool probes exercise env precedence and watcher behavior;
they do not require one transpiler's object-spread spelling or a particular
order of watcher ignore rules.

New local stacks use a verified **unofficial copy of Database 4.11.2**. Its
concurrent prefetch diagnostics append to an unsynchronized mutable list;
the stock runtime has lost diagnostic entries and crashed its namespace in
this suite. The copy changes only the synchronization flag on
`RequestContext.addRuleResult`. Rule evaluation and prefetch scheduling stay
outside that lock, while diagnostic append timing changes. The installed JAR
is untouched. Unknown toolchain versions, archive bytes or derived output
are refused; the exact source-owned pins are in `lib/rtdb-runtime.mjs`.

Every stack records the original and derived identities, a byte-level
attestation and its actual JVM launch. Every invocation records the JVM,
arguments and exact rules before and after its cases. The retained archives
under `.out/runtime-artifacts/rtdb/` let campaign checks verify the transform
after stack teardown. The runtime capability is advertised only after live
verification. Missing or mismatched runtime evidence cannot qualify for
final campaign acceptance. `npm run test:rules:emulated` remains a separate
check against the stock runtime; its result does not establish derived-runtime
parity or production behavior.

## Tiers

| Tier | Lock | What |
|---|---|---|
| `smoke` | shared | canaries: `/config`, shim → Mailpit, the spec env, the protocol clients, the egress guard, the stack options, the stack's resource caps (JVM heaps, debug logs, watchdog, lease). A failure here is a harness problem, and later tiers do not run |
| `--suite smoke` | — | the `smoke` tier, then `specs/functional/smoke.spec.mjs` in the `functional` tier: UI sign-in and a comment, a two-peer live edit saved and checked byte by byte, MCP, the CLI, one invitation in Mailpit |
| `functional` | shared | `specs/functional/<area>.spec.mjs`, four files at a time |
| `concurrency` | exclusive (a measurement run); shared for an authoring run, every `--n` at most 2 and `--trials` at most 2. Either way it waits for the 1-minute load to fall below 8 | `specs/concurrency/<scenario>.spec.mjs`, at `--n 2,5,10,20` |
| production | — | `--target prod` is refused in this build |

## What a stack is

- **A tree from git, never a copy of the directory.** `--tree HEAD|<rev>` is
  `git archive`; `--tree worktree` is `git ls-files -co --exclude-standard`,
  and refuses untracked files outside the source roots, `content/`, `docs/`
  and `e2e/`. The copy is then checked for `.firebaserc`, `config/deploy.json`,
  `functions/.env*` and `app/.env*` (only `.env.example` may exist). It lives in
  `~/.cache/bikeshed-e2e/stacks/<runId>/tree`, with `node_modules` symlinked from
  this checkout when its lockfiles can satisfy the tree's (`--install` runs
  `npm ci` in the copy instead).
- **One state root per user, whatever TMPDIR says.** Stack trees, stack records,
  port-block locks and tier locks all live under `~/.cache/bikeshed-e2e/`, so a
  terminal and a sandboxed agent session (each with its own TMPDIR) see the
  same locks and the same stacks.
- **A 24-port block in 30000–39999**, claimed with an `O_EXCL` lock under
  `~/.cache/bikeshed-e2e/locks/`, never overlapping a live block of another
  size, and proven free by binding 127.0.0.1, ::1, 0.0.0.0 and :: and by
  connecting. The default emulator ports, Firebase's built-ins and
  `E2E_DENY_PORTS` are never used. Every emulator is pinned, including the hub,
  logging, eventarc, tasks and the Firestore websocket; nine ports
  (`spare`…`spare9`) are the stack's **spare-port pool**.
- **Patched copies, never patched source.** `firebase.json` is rewritten as
  JSON; `app/src/config.ts`'s `EMULATOR_PORTS` is replaced through an anchored
  regex that must match exactly once and agree with the tree's own
  `firebase.json`; `functions/.env.local` points the Resend SDK at the shim and
  `.secret.local` holds a dummy `re_e2e_…` key (or, with `--email-off`, a single
  space). Named sets in `patches/<set>/*.patch` (`amplify`, `controls-<family>`)
  are applied with `git apply --check` first.
- **Its own processes.** Mailpit, the Resend shim (`lib/mail/shim.mjs`) and
  `firebase emulators:start`, each detached in its own process group, each with
  an env built from nothing: its own `HOME` and `TMPDIR`, Node 24 first on
  `PATH`. No `GOOGLE_APPLICATION_CREDENTIALS`, `GCLOUD_PROJECT`, `FIREBASE_*`,
  `BIKESHED_*`, `RESEND_*` or `VITE_*` is inherited.
- **No egress.** Every Node process the stack starts — the build steps, the
  shim, the emulator CLI and every function worker it spawns — and every
  worker thread in them preloads `lib/egress-guard.mjs` (copied to
  `<tree>/.e2e/`) through `NODE_OPTIONS=--require=<path>`. It is `--require`
  because Node runs `--import` preloads in the main thread only, and vite,
  rollup, pino transports and piscina all use worker threads. A
  connection to anything but loopback is refused before any name is resolved,
  every lookup of a real name and every DNS query is refused, and each refusal
  is one JSON line in `logs/egress.jsonl`. Readiness checks the guard is armed
  in the shim; the egress canary proves it in a function worker; the
  self-test proves it in a worker thread. The guard does **not** cover
  non-Node binaries (the Firestore and Database emulators, which are Java, and
  Mailpit), a child that clears its environment or drops `NODE_OPTIONS`, or a
  worker thread started with an `env` that lacks it.
- **Admitted, never piled on.** A stack starts only when the machine has room
  (`lib/load.mjs`, `lib/admission.mjs`): (a) `sysctl -n
  kern.memorystatus_vm_pressure_level` is 1, normal (2, warn, waits; 4,
  critical, refuses at once); (b) vm_stat's `Swapouts` rose by at most 256
  pages over a 5 s window; (c) `memory_pressure`'s "System-wide memory free
  percentage" is at least 25 % and that share of `hw.memsize` at least 8 GB.
  (c) is the kernel's figure, not free + inactive + speculative pages:
  inactive memory alone (10.6 GB) passed an 8 GB bar while the machine swapped
  itself to death. Swap USE is logged, never judged: macOS adds swap files a
  gigabyte at a time and keeps them long after the pressure (19 of 20 GB used
  was measured with 81 % free and nothing swapping). And fewer than
  `E2E_MAX_STACKS` (3) stacks may be live under `~/.cache/bikeshed-e2e/stacks`,
  whoever started them (`stack up`, `run`, `controls`, another session): live
  while a recorded group or any process carrying its mark runs, or while it
  is starting and its owner is alive. The count and the newcomer's record are
  made under one `O_EXCL` lock (`locks/admission.lock`), so two starts cannot
  take the last slot. A start waits up to `E2E_STACK_WAIT_MS` (20 min), each
  wait and refusal a line in `e2e/.out/<runId>/load.jsonl` with all three
  readings, then fails `E2E_ADMISSION`: `stack up` and `run` exit 3.
- **Every JVM under a heap cap** (`lib/jvm.mjs`). firebase-tools starts the
  Firestore and Database emulators and the Storage rules runtime as `java …
  -jar <jar>`, found on PATH, with no `-Xmx` (a JVM then may grow to a quarter
  of RAM: two shared Firestore emulators reached 17 GB each). The emulator's
  PATH starts with `<stackDir>/bin/java`, a script written per stack that
  picks the role from the jar and execs the real JVM with `-Xmx` (Firestore
  2048m, Database 1024m, any other 512m; `--jvm-heap` lowers one),
  `-XX:+ExitOnOutOfMemoryError` and `-XX:OnOutOfMemoryError` writing
  `<role> <pid>` to `<stackDir>/jvm/oom`. A JVM out of heap exits (code 3)
  instead of thrashing, and is NAMED: readiness fails at once ("the Firestore
  emulator (pid …) ran out of memory: java.lang.OutOfMemoryError at its
  -Xmx16m cap"), `run` stops its specs and exits 1, and the watchdog marks a
  ready stack failed with that reason and stops it (tree kept).
- **Quiescent RTDB rule-coverage recycling** (`lib/rtdb-coverage.mjs`). The
  pinned Database emulator 4.11.2 retains every distinct evaluated rule value,
  including complete CRDT payload strings, after the application deletes or
  compacts that data. Serial concurrency measurements holding the exclusive
  tier lock archive the complete coverage report as streaming gzip before the
  first case and after a preceding browser case has fully closed. No body,
  request or marked harness browser may remain active. A whitespace-only rules
  round trip triggers a fresh tracker (an identical-text PUT is ignored), then
  restores and verifies the exact staged rule bytes in `finally`. The fresh
  report must contain zero evaluated values, and anonymous access must still
  be denied. The archive digest, rule digest, pinned toolchain and before-case
  boundary are recorded in `maintenance.jsonl` and case diagnostics; read-only
  judges do not schedule another reset. A failed archive, changed rule file,
  unknown JAR, abandoned body or incomplete restoration fails the case. Shared
  authoring and parallel-file runs never recycle coverage. This changes no
  database data, case outcome, timeout or heap ceiling. The installed-runtime
  probe is `node tools/probe-e2e-rtdb-coverage.mjs`; the diagnosis and proof
  boundary are in [the heap note](../docs/development/e2e-rtdb-heap.md).
- **Quiescent Firestore rule-coverage recycling** (`lib/firestore-coverage.mjs`).
  The same boundary also archives Firestore's rule-value report before RTDB
  maintenance. The pinned Firestore 1.22.0 JAR rebuilds its evaluator on an
  identical-rule PUT; no temporary rule change is needed. The helper checks
  the live JAR and ordinary 2048m heap, preserves the complete source object,
  verifies exact staged content before and after, requires an empty replacement
  tracker, and checks that the anonymous probe's result is unchanged. It records
  the compressed archive and digests in `maintenance.jsonl`. A standalone
  installed-JAR probe retained 1,011 values after 200 writes; identical-rule
  reapplication cleared them while preserving the document bytes and both
  allowed and denied writes. Omitting that reapplication failed the empty-tracker
  assertion, and restoring it passed. The helper never deletes database data,
  raises heap limits, or runs while a case's requests or browsers remain active.
- **Orphaned Firestore browser subscriptions** (`lib/firestore-channels.mjs`).
  The same pinned, exclusive idle boundary retires Listen sessions observed by
  the browser harness. The stock emulator's close callback does not unsubscribe
  its database listener: termination alone returns success while messages keep
  accumulating. Observation keeps only session IDs, numeric request offsets and
  subscription IDs. Before primary pages and secondary tabs navigate, bounded
  inspector capture retains response bodies across navigation (1 MiB total,
  64 KiB per response); requests are neither routed nor delayed. A browser
  regression reproduces the lost-body error with durable capture disabled.
  After every browser exits, cleanup removes the observed
  subscriptions, appends and removes a fresh read-only barrier target, drains
  its confirmation, acknowledges the last envelope through a backchannel GET,
  and terminates the transport. The pinned handler processes removals in order;
  its already-revoked targets do not emit a second removal reply. The barrier
  targets only a hashed path under `__e2e_channel_cleanup` and changes no data. Unknown
  protocol state, missing confirmations, HTTP errors or lost idle admission fail
  maintenance. No page close or active-case timing changes. A real-browser probe
  reduced 990 retained envelopes to 7; disabling cleanup grew them to 1,950 after
  another 80 writes, with document data and security rules unchanged.
- **Periodic debug-log size limits** (`lib/debuglogs.mjs`). Two shared stacks wrote
  22 GB of `firebase-debug.log` and 10 GB of `firestore-debug.log` each, and
  firebase-tools has no way to lower them (the Firestore emulator's
  `-Dgoogle.cloud_firestore.debug_log_level=FINE` is a literal in its
  launcher, read after `JAVA_TOOL_OPTIONS`; the debug log's file transport has
  no size limit). `firestore-debug.log` and `database-debug.log` are symlinks
  to `/dev/null`: firebase-tools writes them at their own offset (a cut leaves
  a hole the size of everything before it) and copies every line into
  `firebase-debug.log` anyway. The watchdog cuts `firebase-debug.log` (written
  O_APPEND) whenever it is over half of `E2E_DEBUG_LOG_MAX_MB` (200): its
  newest half goes to `firebase-debug.log.1`. Writes between watchdog polls
  can temporarily exceed the limit; the next check truncates the live file.
  The first cut keeps its first
  256 KB (the start-up lines, `database rules config:` among them) as
  `firebase-debug.head.log`. `logs/emulators.log`, which every reader in
  `e2e/` reads by byte offset, is never touched. The Database emulator's own
  output would survive none of this (its file is `/dev/null`, the cuts drop
  the middle of `firebase-debug.log`, and firebase-tools unlinks that file
  when it exits cleanly), so it is copied out as it is written, to
  `logs/database-debug.log` (Reading the stack).
- **An owner, an expiry and a watchdog** (`lib/lifetime.mjs`,
  `lib/watchdog.mjs`). `owner` in `stack.json` is the pid AND start second of
  the process that started the stack (a pid alone is reused).
  `<stackDir>/lease.json` holds `expiresAt` and `hardExpiresAt`: a kept stack
  gets 4 h (`--ttl`, `E2E_STACK_TTL_H`), each `run --attach` makes it at least
  2 h from then (`E2E_STACK_EXTEND_H`; one attach adds at most 2 h, and never
  shortens it), and nothing passes the hard maximum, 8 h after the start
  (`E2E_STACK_MAX_H`, which may be lowered, never raised). A stack `run`
  stops itself expires at the hard maximum. A small Node process per stack,
  started with its record and carrying its mark, polls every
  `E2E_WATCHDOG_POLL_MS` (15 s) with no harness command running: it stops the
  stack at expiry, at the hard maximum, or when a stack that is not kept (or
  is still starting) has lost its owner; it fails a ready stack whose
  emulator died; it caps the debug logs; it exits when the stack is stopped
  (a teardown stops it first). `stopReason` in `stack.json` says who stopped
  a stack and why. `reap` applies the same rule.
- **RTDB rules where the app reads.** firebase-tools binds a plain
  `database: {rules}` to `<projectId>-default-rtdb`, but the app and the
  functions use `ns=<projectId>`, which then ran with no rules at all (every
  read and write allowed). The copy's `firebase.json` binds the tree's
  `database.rules.json` to both (`rtdbRulesConfig` in `lib/patch.mjs`).
  Stacks built before this have no `rtdb-rules` capability.
- **An aux process, with `--gates`, `--rtdb-proxy` or `--storage-shim`**
  (`lib/stackaux.mjs`). Ports leave the spare pool and are renamed: `gate`
  (spare8: the gate service and the aux's control port), with
  `--rtdb-proxy` `rtdbProxy` (spare9: a raw TCP proxy to the Database
  emulator, whose delay per direction a spec sets at runtime), and with
  `--storage-shim` `storageShim` (spare7: an HTTP proxy in front of the
  Storage emulator for the functions, which refuses a second create-only
  write or copy; `lib/storage-shim.mjs`, Capabilities). It is an essential
  process, marked, under the egress guard, its log `logs/aux.log`. A gated
  stack's functions get `E2E_GATE_URL` and its app build
  `VITE_E2E_GATE_URL`; a proxied stack's app dials the proxy, which
  `verifyBuild` checks (the one `EMULATOR_PORTS` literal and the database
  URL) and readiness proves with a read through it; a shimmed stack's
  emulator preloads the shim's preload after the egress guard
  (`<tree>/.e2e/storage-shim-preload.mjs`), which points every function
  worker's Storage emulator host at the shim. See Concurrency specs.
- **Readiness**, within 240 s (or at once, naming the emulator, when one runs
  out of heap or an essential process exits): the hub lists all six emulators on their ports,
  each answers, every bound RTDB namespace reads the tree's rules back
  byte-equal and an anonymous read of `ns=<projectId>` is 401
  (`checkRtdbRules`, recorded as `rtdbRules` in `stack.json`), `GET /config`
  is 200 through Hosting, Mailpit is ready, and a canary goes through the shim
  into Mailpit. With `--storage-shim`, also: the aux's `/health` names the
  Storage shim, a Storage listing answers 200 through it, and (once
  `/config` has started a function worker) the worker's preload line in
  `logs/storage-shim.jsonl` says its Storage hosts now name the shim
  (`shimRedirects`, recorded as `storageShim.redirect` in `stack.json`); a
  worker left on the emulator fails the start at once, naming it. Then,
  recorded and never required, the Storage the functions use (the shim
  with `--storage-shim`, else the emulator) is probed for create-only
  writes and copies (`lib/storage-preconditions.mjs`
  `probeStoragePreconditions`, recorded as `storagePreconditions` in
  `stack.json`, the capability `storage-preconditions`: see Capabilities).
  On the Storage emulator of firebase-tools 15.25.1 the start log says
  `ready: Storage does NOT honour create-only writes (no capability
  storage-preconditions): …`; through the shim it says `ready: Storage
  refuses a second create-only write and copy (412) and keeps the first:
  capability storage-preconditions`.

### Stack options

`run` (when it builds the stack) and `stack up` take them; they are recorded
in `stack.json` (`options`, `jvm`, the lease in `lease.json`) and
`target.json` (`options` and capabilities). `--attach` refuses them: the
attached stack is what it was built as (an attach extends its lease by
itself).

| option | what it does | capability |
|---|---|---|
| `--email-off` | the product's own off switch: `RESEND_API_KEY` is a single space, which `send.ts` trims to nothing and logs `[email] skipped "<subject>" to <addr>: no API key configured`. The shim still runs with its own dummy key and must then receive nothing from the product | `email-off` (and no `email`) |
| `--app-env VITE_FIREBASE_MEASUREMENT_ID=dummy` | builds the app with a measurement-id-shaped value generated at build time (nothing real is ever accepted; no tracked file holds one); `target.options.appEnv` carries it. Under the emulators the app never initializes Analytics, whatever the id (SPEC §15) | `measurement-id` |
| `--app-env VITE_EXPORT_MARK_ENABLED[=1]` | the deployment's default export marking is on (SPEC §20): `1`, `true` or `yes`, the key alone being `1`; off is the default, so there is no value for it | `export-mark-default` |
| `--app-env "VITE_EXPORT_MARK_LABEL=<text>"`, `--app-env "VITE_EXPORT_MARK_FOOTER=<text>"` | that marking's corner label (at most 40 characters) and footer (at most 300), as given: non-empty, no leading or trailing whitespace (the app trims), no control character or `"`. `target.options.appEnv` carries all three, so a case compares against them, not against a file | — |
| `--patches <set>` | applies `e2e/patches/<set>/*.patch` to the tree before the build (repeatable, in order); `target.patches` lists the sets | `patch:<set>` per set |
| `--jvm-heap <role>=<size>` | a lower heap cap for one JVM role (`firestore`, `database`, `other`; `768`, `768m`, `1g`; repeatable), recorded as `jvm.heapMb`. Each defaults to its ceiling, 2048m, 1024m and 512m, and a value above it (or below 16m) is a usage error | — |
| `--ttl <hours>` | a kept stack's first lease (`stack up`, `run --keep`), at most the hard maximum; default 4 | — |
| `--rtdb-proxy` | the app bundle dials the Database emulator through the aux process's TCP proxy (block role `rtdbProxy`); `rtdbLatency(target).set({up, down})` delays it at runtime (lib/proxy.mjs) | `rtdb-proxy` |
| `--gates` | the aux process runs the gate service (block role `gate`); the functions get `E2E_GATE_URL` and the app build `VITE_E2E_GATE_URL`. Implied by any `--patches amplify-<name>` | `gates` |
| `--storage-shim` | the aux process runs the Storage shim (block role `storageShim`) in front of the Storage emulator, and every function worker dials it: a write or copy with `ifGenerationMatch` is judged under one lock per object, so a second create-only one is refused with 412 as Cloud Storage refuses it (`lib/storage-shim.mjs`). The harness's own Admin client and `target.storageUrl` keep the emulator's port | `storage-shim`, and through the readiness probe `storage-preconditions` |
| `--patches amplify-<name>` | an amplify set: pause points and client gates (lib/gates.mjs), with its `amplify.json`; implies `--gates`. Several may be named: the gate helpers they share go in once (see Several amplify sets on one stack) | `patch:amplify-<name>`, `gates` |

Every stack this harness builds also has `resource-caps` (JVM caps, capped
debug logs, an owner, a lease and a watchdog), which the smoke canary
`specs/smoke/resources.spec.mjs` checks on the live stack.

The memory and lifetime limits are environment variables, read by whatever
starts the stack (or, for a pool, the spec process). They are configuration,
never a way to get a run through: lowering a threshold to start on a machine
short of memory is the failure they exist to stop.

| variable | default | what |
|---|---|---|
| `E2E_MIN_FREE_PCT` | 25 | memory_pressure's free share a stack start needs |
| `E2E_MIN_AVAILABLE_GB` | 8 | …and that share of physical memory, in GB |
| `E2E_MAX_SWAPOUTS` | 256 | pages swapped out over the 5 s window, at most |
| `E2E_POOL_BASE_GB`, `E2E_POOL_CONTEXT_MB` | 2, 600 | a browser pool needs base + N × context available for N contexts (same figure as above) |
| `E2E_STACK_PEER_MB` | 700 | a case with N >= 10 on a local stack also needs N × this available for the stack's growth, before its body (`admitLive`) |
| `E2E_POOL_WAIT_MS` | 120000 | how long a pool waits before its case ends INCONCLUSIVE |
| `E2E_MAX_STACKS` | 3 | live stacks on the machine |
| `E2E_STACK_WAIT_MS` | 1200000 | how long a start waits for memory and a slot before exit 3 |
| `E2E_STACK_TTL_H`, `E2E_STACK_EXTEND_H`, `E2E_STACK_MAX_H` | 4, 2, 8 | a kept stack's lease, what an attach makes it, the hard maximum (at most 8) |
| `E2E_DEBUG_LOG_MAX_MB` | 200 | each debug log's cap (at most 200) |
| `E2E_WATCHDOG_POLL_MS` | 15000 | the watchdog's poll |

Only keys in `APP_ENV_ALLOWLIST` (`lib/options.mjs`) are accepted. A key's
value must reach the app bundle, or the build fails (the option would
silently do nothing), except the `VITE_EXPORT_MARK_*` keys: whether the app
uses them is what a case tests, so `verifyBuild` only records it, as
`build.appEnvInBundle` in `stack.json` (`appEnvBundleRule(key)` →
`"required"` or `"recorded"`).

## For spec authors

### Where a spec lives and how to run one

A spec is `e2e/specs/functional/<area>.spec.mjs` (or `specs/concurrency/…`).
It imports only from `e2e/lib/` and reaches the stack only through the Target.
To run one against a stack somebody else keeps:

```bash
node e2e/run.mjs run --attach <runId> --suite functional --spec e2e/specs/functional/<area>.spec.mjs [--grep '<case regex>'] [--n 2,5]
node e2e/run.mjs report <runId>/<invId>        # this invocation;   report <runId> --merge  for everyone's
```

A spec file OUTSIDE `e2e/specs/` (a copy with a bug planted in it, for a
spec-mutation negative control) runs against an attached stack with
`--spec-file` (`lib/specfile.mjs`), exactly as a spec runs: the same
environment, reporter, tier lock and file budget, in the one tier `--suite`
names (`functional`, the default, or `concurrency`):

```bash
node e2e/run.mjs run --attach <runId> --spec-file /abs/scratch/m1.spec.mjs [--spec-file …] [--grep '<case regex>']
```

```js
// a scratch script outside the checkout; <checkout> is this repository's absolute path
const { absoluteLibImports } = await import("<checkout>/e2e/lib/specfile.mjs");
const src = absoluteLibImports(readFileSync("<checkout>/e2e/specs/functional/a18-stats.spec.mjs", "utf8"));
writeFileSync("/abs/scratch/m1.spec.mjs", src.replace(from, to)); // the planted bug
```

- `absoluteLibImports(src)` → string rewrites a spec's `../../lib/<module>`
  imports (static and dynamic, never one in a comment or a string) to this
  harness's lib by absolute file URL, so the copy runs anywhere.
- `checkSpecFile(file)` → `{file, real, imports: [{specifier, line, dynamic,
  resolved}]}` and `specFilePlan({specFiles, spec, attach, suite})` →
  `{tier, files}` (real paths, as node names them) or null are what run.mjs
  calls, before it attaches to or reaps anything. Each refusal is a usage
  error (exit 2, code `E2E_SPEC_FILE`): no `--attach`; `--spec` beside it; a
  suite other than `functional`/`concurrency`; a file named twice; a path
  that is not absolute and resolved; a file in `e2e/specs/` (use `--spec`);
  a file anywhere else in this checkout except under `e2e/.out/` (the copy
  stays out of the tracked tree); one that is missing, not a regular file,
  or not `.mjs`; a relative, absolute or `file:` import that resolves to no
  file (a copy that kept `../../lib/…`), or into an `e2e/lib/` that is not
  this harness's. `specImports(src)` → `[{specifier, index, line, dynamic}]`
  is the import scan both use; `SPEC_FILE_SUITES` lists the two suites.
- The invocation goes to `e2e/.out/<runId>/scratch/<invId>/`
  (`SCRATCH_INVOCATIONS_DIR` in `lib/invocation.mjs`; `createInvocation(runDir,
  meta, {under})` makes it), never `invocations/`: a mutant fails on
  purpose, and its failure must not reach `report <runId> --merge` or anyone's
  merged view. A case's id is `<absolute real path>::<name>`, never the
  original spec's, and its evidence's rerun line is `--spec-file <that
  path>` (`rerunCommand(runId, file, name)` in `lib/test.mjs`).

`run.mjs` sets `E2E_TARGET` (the stack's `target.json`), `E2E_RUN_ID`,
`E2E_SUITE`, `E2E_INVOCATION_DIR`, `E2E_CASE_TIMEOUT_MS` (see Time budgets)
and, with `--n`, `E2E_N`; the spec process
gets the caller's environment minus every deployment binding, plus the stack's
`*_EMULATOR_HOST` variables. `E2E_EVIDENCE=always` keeps evidence of passing
cases too; `E2E_TRACE=1` records a Playwright trace per user (local stacks
only — it is refused on any other target, because a trace holds cookies,
tokens and typed passwords unredacted). Spec authors do not edit `e2e/lib/`,
`e2e/run.mjs` or `e2e/selftest/`.

### scenario()

```js
import assert from "node:assert/strict";
import { scenario, precondition } from "../../lib/test.mjs";

scenario("comments: a viewer's reply reaches the owner", {
  tiers: ["local", "prod"],          // where it may run; elsewhere SKIPPED with the reason
  effects: ["email:POST /access"],   // an email effect is skipped on prod: "sends email: POST /access"
  needs: ["mailpit"],                // target capabilities; a missing one SKIPS, with the reason;
                                     // "!<capability>" one it must NOT have (present → SKIPPED)
  n: [2, 5],                         // one case per N, named "… [N=5]"; run.mjs --n selects
  trials: { 2: 3 },                  // a number, per N, or "plan" (10/5/3/3); omitted in specs/concurrency/ with n: "plan";
                                     // run.mjs --trials k overrides it; with k > 1 the trials are named "… [N=2] #k"
  defect: "S7",                      // a KNOWN defect (see Outcomes)
  timeoutMs: 120_000,                // else E2E_CASE_TIMEOUT_MS, the tier default (see Time budgets)
  inconclusiveOnStackTimeout: true,  // the stack's own non-answer ends it INCONCLUSIVE (below)
  inconclusiveOnPageStall: true,     // …and so does a wait that ran out while a page saw the stack stall (below)
  inconclusiveOnFunctionKill: true,  // …or while the emulator killed functions under load (below)
  inconclusiveOnCaseTimeout: true,   // …and the case's own timeout is such a wait (below)
  inconclusiveOnRequestStall: true,  // …and the case's own requests Hosting cut off are evidence too (below)
  inconclusiveOnHttpStall: true,     // …and a budget that ran out while the stack answered the case's own requests slowly (below)
  usersPerBrowser: 5,
}, async (ctx) => { … });
```

`ctx` holds `target`, `n`, `trial`, `name`, `t` (the `node:test` context),
`users` (a lazily created `BrowserPool`), `usersSoFar` (a copy of the users
made so far, or `[]`: it never makes a pool and never throws, even after the
case timed out), `http(opts)` and `mcp(opts)`
(clients that log into this case's evidence), `ev` (its `Evidence`),
`step(text)` (a line in `steps.md`), `inconclusive(reason)` (throws; the case
is INCONCLUSIVE), `notReproduced(reason)` (throws `E2E_NOT_REPRODUCED`,
`NOT_REPRODUCED_CODE` in `lib/test.mjs`; a `defect:` case is NOT
REPRODUCED, any other case gets a TypeError and FAILS), `oracle(fnOrPromise)` (whatever it throws is the defect's
own oracle failing: a TODO on a `defect:` case; an `E2E_NOT_REPRODUCED`
passes through it as it is), `logSince` (the size in
bytes of the stack's `emulators.log` as the case began, a `logMark`, which
`functionKill` reads from; null on a target without the `logs` capability),
`requests()` (the case's own Node requests so far, as rows, and with
`{pending: true}` those still in flight: below) and
`budgetEndsAt` (the `Date.now()` time the case's budget runs out, which
`caseBudget` sets as the body starts, so with `inconclusiveOnCaseTimeout`;
null in a case without one: below).

Outcome rules, in practice:

- A plain assertion failing is a FAIL — or, in a `defect:` case, a TODO.
- In a `defect:` case, wrap any oracle that is not an `assert` (an `eventually`
  convergence, a `waitForLog`) in `await ctx.oracle(() => …)`, or its timeout
  FAILS the case instead of marking it TODO.
- `precondition(value, message)` throws `E2E_PRECONDITION`: a setup step that is
  not the thing under test. It FAILS even a `defect:` case.
- `ctx.inconclusive(reason)` when the measurement itself did not hold (no
  overlap, spread over the limit, a peer never Shared). Run.mjs exits 3.
- `ctx.notReproduced(reason)` in a `defect:` case whose measurement DID hold
  but whose trial never reached the defect's window: a natural race that
  happened not to race (C9's losing upload ended before the winner's, so
  no loser overwrote it). It is not evidence that the defect is fixed
  (the body returning would say so: a TODO, "passed unexpectedly"), nor that the measurement
  failed (INCONCLUSIVE, exit 3): it is NOT REPRODUCED, the plan's class U,
  listed and counted in each scenario's rate. Its steps, HTTP and reason
  (`error.txt`) are kept; its pages are not captured. Nothing judges it
  again: no stack judge (`inconclusiveOn…`, `pageStall`, `functionKill`,
  `httpStall`, a spec's `also`) reads it, even when its reason reads like
  a wait, and `ctx.oracle()` hands it on untouched. A breach still FAILS
  it. Use it only where a trial can miss the window by chance; a
  deterministic case (SYNC-P, a gate) that misses its window is
  INCONCLUSIVE.
- An INCONCLUSIVE keeps every page, as a FAIL does: each user's console and
  requests (`console-<user>.jsonl`, `requests-<user>.jsonl`), then its DOM
  excerpt and screenshot, in the case's evidence directory beside
  `error.txt`. The consoles and requests are written at once, whatever the
  time; the waits for the DOM and the screenshots (a stalled page may never
  answer them) stop `INCONCLUSIVE_CAPTURE_MS` (20 s) after the INCONCLUSIVE,
  and never later than `CAPTURE_RESERVE_MS` (15 s) before the case's
  timeout, so the capture cannot turn it into node:test's timeout FAIL; a
  step names any user it did not wait for. A spec needs no capture of its
  own for this (c01's `keepConsoles` can go). `captureUsers(ev, users,
  {deadline = Infinity})` → `{captured, late, failed}` (`lib/test.mjs`, user
  names, never rejects) is that capture, for a spec's own use: every user's
  `ev.captureUser` is CALLED (its console and requests are written as it is
  called), and only the waits stop at `deadline`, a `Date.now()` time. A
  bad `ev`, `users` or `deadline` is a TypeError.
- Skips come from `tiers`, `effects`, `needs` and `--n`; never skip from the
  body to hide a failure.
- Any browser isolation breach FAILS the case after the body, whatever it did.
  The Firestore SDK's own network test (`isSdkProbe`, below) is blocked but is
  no breach: the case notes it (a step, `sdk-probes.json`, one `findings.jsonl`
  row of kind `sdk-probe`, class E) and its outcome is its body's.
- Every document the case made unlisted or public through `setVisibility`
  or `withVisibility` (or registered with `trackWindow`, `lib/grant.mjs`) is
  made private again when the case ends, pass, fail or timeout. One that
  will not close FAILS a case whose body passed (`E2E_WINDOW_OPEN`, never a
  known defect's TODO) and is recorded in `findings.jsonl` (kind
  `window-open`). A close the stack did not answer (Hosting's 504, or none
  at all) is judged by the document's record, not by the missing answer
  (Windows, under Seed, fixtures and grants).

**When the stack does not answer.** On a loaded shared stack a write can take
10–60 s, and the Hosting emulator answers 504 itself ("Timed out waiting for
function to respond.") for a function that has not answered within 60 s
(measured: 60,005–60,010 ms). The product never answered that request, so
nothing was measured. Declare `inconclusiveOnStackTimeout: true`, or wrap the
body in `onAnsweringStack(fn)` (the same thing), and a failure of one of these
shapes ends the case INCONCLUSIVE with the reason `the stack did not answer,
so nothing was measured: <why>`. The failure itself is kept, as the
INCONCLUSIVE's cause in `error.txt` and in `stack-did-not-answer.txt`:

- an error carrying a 504 that took `HOSTING_CUTOFF_MS` (59,000 ms) or more,
  as `err.response` (http.mjs's `E2E_STATUS` from `expect`, `openSession`'s
  `E2E_SESSION`, oauth.mjs's receiver timeout `E2E_OAUTH_TIMEOUT` when the
  consent page's own POST /oauth/consent got it, `User.suggest`'s
  `suggestion refused` when the page's POST /suggestion got it, any helper
  that passes `expect` through) or as `err.res.response` (mcp.mjs's
  `E2E_MCP_HTTP`);
- `E2E_STACK_CUTOFF`, or any error whose `stackCut` is a string: what
  `answered()` and `stackCutoff()` throw, and what a client made with
  `cutoffError: true` throws (below);
- http.mjs's own deadline, an error whose message is exactly `timeout after
  <N> ms`;
- the Admin SDK's own deadline on a Firestore call (`readDoc`,
  `readCollection`, a batch): an error whose `code` is the number 4, gRPC's
  DEADLINE_EXCEEDED, and whose message opens with grpc-js's `4
  DEADLINE_EXCEEDED: ` or google-gax's `Total timeout of API … exceeded N
  milliseconds`. The reason reads `a Firestore call through the Admin SDK got
  no answer within its deadline: <its first line>`;
- any of these as the cause of `ctx.oracle()`'s `E2E_DEFECT_ORACLE`: a known
  defect's oracle that got no answer did not fail as expected.

Nothing else qualifies. An assertion never does, whatever its message. Nor
does DEADLINE_EXCEEDED in the product's own words (a tool error, a 500's
body: the product answered), gax's `Exceeded maximum number of retries` (a
count, not a deadline), a `precondition`, a quicker 504 (that is an answer,
and it is judged), another status at the cut-off, a guard refusal, or a
wait that ran out (`eventually`, Playwright, a toast): a page that ignores
what the stack did deliver still FAILS, and so does a breach. (A case that
also declares `inconclusiveOnPageStall` widens this for waits, and only
with a page's evidence: below.)
A response the case reads itself
raises nothing, so pass it through `answered(r, what)`. That returns `r`, or
throws `stackCutoff(what, r)` when `r` is the cut-off. `r` is an http.mjs
response, a `User` response entry (`waitForResponse`, `findResponses`), a
`log.requests` row or a `User.capture` row (whose wait is `respondedAt −
sentAt`):

```js
const mark = u.responseMark();
await dialog.getByRole("button", { name: "Add", exact: true }).click();
const r = answered(await u.waitForResponse({ method: "POST", path: "/access" }, { since: mark, timeout: 75_000 }), "the page's POST /access");
```

Or make the client with `cutoffError: true` (`createHttp`, `ctx.http`,
`openSession`, `bearerHttp`, `mcpClient`, `ctx.mcp`; kept by `with()`), and it throws
`E2E_STACK_CUTOFF` itself for a 504 whose request took `HOSTING_CUTOFF_MS`
or more, timed per redirect hop, before `expect` is checked: the message
and `stackCut` are `stackCutoff`'s (`POST /access answered 504 after 60005
ms, Hosting's cut-off …`), `response` the response. A quicker 504, or any
other status however slow, is returned as before
(`selftest/http-cutoff.test.mjs`):

```js
const owner = await openSession(ctx.target, acct, { timeoutMs: 180_000, cutoffError: true });
const r = await owner.http.postJson("/organize", body);   // Hosting's cut-off throws; a 400 is returned and judged
assert.equal(r.status, 400);
```

For the 504 to arrive at all, wait past the cut-off. http.mjs's default
deadline is the same 60 s; when it fires first the case is still
INCONCLUSIVE, but the reason cannot name the request (`http.jsonl` does).
`signInUi`'s waits default to 75 s, past it.

**A CLI run the stack cut off.** The CLI reports Hosting's 504 like any other
status, on its `error:` line ("error: The server returned 504.", "error:
Upload failed (504)."), and exits 1. `runCli` names such a run in its
result's `cut`: a string when the run printed a 504 `error:` line and took
`HOSTING_CUTOFF_MS` or more, else null. The CLI does not time its requests,
so this is the whole run's time (the product itself never answers 504). A
`spawnCli` handle's `cut` times each 504 line from the latest `mark()`
before it (below). Pass either through `answered(r, what)`: it throws
`E2E_STACK_CUTOFF` with that reason as `stackCut`, prefixed `<what>: ` when
`what` is given, `response` null and `cli` `{code, signal, ms}` (never the
CLI's stdout), and returns a run whose `cut` is null as it is. A quicker 504,
another status, or a 504 line that is not the CLI's `error:` line (a title it
echoes) is an answer, and is judged:

```js
scenario("A20.7b publish --json …", { inconclusiveOnStackTimeout: true }, async (ctx) => {
  const r = answered(await runCli(ctx.target, ["publish", "page.html", "--json"], { token, home }));
  assert.equal(r.code, 0, r.stderr);
});
```

**A wait that ran out while a page saw the stack stall.** A browser case
mostly waits for what a page shows, and on a loaded shared stack that wait
runs out because a function never answered the page (Hosting cut it off
after its minute) or the page's Firestore client lost the emulator (its
listener then delivers nothing). The failure is a Playwright timeout or an
`eventually`, which the shapes above never take. Declare
`inconclusiveOnPageStall: true` (it implies `inconclusiveOnStackTimeout`,
and beside `inconclusiveOnStackTimeout: false` throws when declared), or
wrap the body in `onAnsweringStack(fn, {also: pageStall})`, the same thing,
and such a failure also ends INCONCLUSIVE, but only with a page's evidence
inside that wait's window. `pageStall(err, ctx)` judges:

- **the failure** is a wait that ran out, in its own words or one level down
  as its `cause` (a helper that rewords a Playwright timeout): `… within <N>
  ms` (`eventually`'s `E2E_EVENTUALLY_TIMEOUT`, `User`'s waits and toasts, a
  mailbox, `signInUi`'s, the case's budget's `E2E_CASE_BUDGET`, below),
  Playwright's `Timeout <N>ms exceeded` (or any
  `TimeoutError`), `lib/logs.mjs`'s `E2E_LOG_TIMEOUT`; or a `precondition`
  (`E2E_PRECONDITION`). Never an assertion, an error that carries the answer
  it refused (`response` or `res`: the product answered, and is judged), a
  known defect's oracle, an INCONCLUSIVE, a breach, a guard refusal, or the
  harness's own waits (`E2E_SYNC_TIMEOUT`, `E2E_SPARE_TIMEOUT`, node:test's
  timeout of the case);
- **the evidence** is from this case's pages (`ctx.usersSoFar`), at or after
  the window's start: a response answered Hosting's cut-off 504
  (`isHostingCutoff`, read from `User.responses`, else `log.requests`), or a
  page's Firestore client losing the emulator (the SDK's console line `Could
  not reach Cloud Firestore backend`, or its network test in
  `log.sdkProbes`). A quicker 504, or nothing at all, is no evidence: the
  wait on a stack that kept answering FAILS;
- **the window** is the wait's own length plus `marginMs` (10 s) back from
  the failure, or `STALL_WINDOW_MS` (130 s) when the failure names no length
  (a precondition, a bare `TimeoutError`).

The reason names the evidence, the window and the failure at its call site:

```
the stack did not answer, so nothing was measured: a page's Firestore client lost the emulator
(owner: "Could not reach Cloud Firestore backend"), in the 100 s before a wait ran out — the failure,
at a19-account.spec.mjs:244 (via User.waitForToast, browser.mjs:2129): owner: no matching toast within 90000 ms (seen: none)
```

```js
scenario("A19.5 a team is created from the account screen", { inconclusiveOnPageStall: true }, async (ctx) => {
  const u = await ctx.users.user({ name: "owner", consent: "denied" });
  … // a wait that runs out here, while the page lost the emulator, is INCONCLUSIVE; an assertion still FAILS
});
// a wider window for a precondition, or a spec's own evidence beside the lib's:
scenario("…", {}, onAnsweringStack(fn, { also: (err, ctx) => pageStall(err, ctx, { windowMs: 250_000 }) ?? mine(err, ctx) }));
```

`callSite(err)` → string or null is how the reason names the call site, for
a spec's own reasons too: from the error's stack (else its cause's), the
first frame outside `e2e/lib/` by file name and line, and the outermost lib
call it made, `a19-account.spec.mjs:244 (via User.waitForToast,
browser.mjs:2129)`; the lib call alone when no other frame shows; null when
neither does. It never names a directory. The INCONCLUSIVE's reason and
`stack-did-not-answer.txt` hold the judgement's evidence, and (since
2026-10-13) its pages are captured as a FAIL's are, within the limits under
Outcome rules above. `selftest/stack-stall.test.mjs` pins all of this, through
`node --test` and the reporter, with real pages
(`selftest/inconclusive-capture.test.mjs` the capture).

**A wait that ran out while the emulator killed functions.** A case that
waits on what a TRIGGER does (a notice in Mailpit, a change-log row, a log
line) has no request of its own to be cut off: on a loaded shared stack the
trigger itself dies, and the wait runs out. The Functions emulator says so in
its own log, without naming the function: "Your function was killed because
it raised an unhandled error" after a "10 ABORTED: Transaction lock timeout"
(the Firestore emulator giving up on a transaction's lock under load), or
"Your function timed out after ~60s" (its 60 s limit). Declare
`inconclusiveOnFunctionKill: true` (it implies `inconclusiveOnStackTimeout`,
beside `inconclusiveOnStackTimeout: false` throws when declared, and with
`inconclusiveOnPageStall` asks the pages first), or wrap the body in
`onAnsweringStack(fn, {also: functionKill})`, the same thing.
`functionKill(err, ctx)` judges:

- **the failure** is a wait that ran out, read as `pageStall` reads one
  (`… within <N> ms` — `eventually`, `waitFor`, `expectMailboxes`,
  `expectMail`, `User`'s waits —, Playwright's `Timeout <N>ms exceeded`, a
  `TimeoutError`, `E2E_LOG_TIMEOUT`, or one of these as its `cause`), but
  never a `precondition`, and never one that says something EXTRA arrived
  (`missingOnly === false`, as `expectMailboxes` sets it, on the error or its
  cause): mail cannot be unsent, and one too many is the product's. Nor an
  assertion, an error carrying the answer it refused, a known defect's
  oracle, a breach, a guard refusal or the harness's own waits;
- **the evidence** is in the stack's `emulators.log` from `ctx.logSince` (the
  case's start) on: a kill line within 60 lines after a lock-timeout line not
  yet paired with one (a kill for any other error may be the product's, and
  is no evidence), or a 60 s stop while Hosting answered a request 504 (its
  cut-off, the stack-wide signature of load; either alone is no evidence).
  The counts and Hosting's 504 lines, redacted, go to `function-kills.json`.

The log cannot say which function a kill ended, and a shared stack runs other
specs' functions too, so this says only that the measurement was not
reliable: never PASS. On a quiet stack the same wait FAILS. A case that is
mostly over before what it waits for is caused can pass its own mark,
`functionKill(err, ctx, {since: logMark({target})})`, from `lib/logs.mjs`.

```
the stack did not answer, so nothing was measured: the emulator killed 1 function(s) for a transaction lock
timeout ("ABORTED: Transaction lock timeout") since the case began, so what it waited for may be what a killed
function never did — the failure, at a23-email.spec.mjs:551 (via Object.waitFor, mail/reader.mjs:230): waitFor: no …
```

```js
scenario("A23.2 a comment notice reaches the owner", { inconclusiveOnFunctionKill: true }, async (ctx) => {
  const box = mailbox(ctx.target, { http: ctx.http({ actor: "mailpit" }) });
  … // a reply through the rules
  await box.waitFor({ to: owner, subject, timeout: 180_000 });        // lost to a killed trigger: INCONCLUSIVE
  await box.expectMailboxes({ [owner]: [subject], [witness]: [] });   // one too many: FAILS, whatever the log says
});
```

**When the case's own timeout runs out.** A case that runs out of its
`timeoutMs` is reported by node:test the moment the timeout fires, as a FAIL
that nothing can judge: on a loaded shared stack that is often a case whose
every wait was slow, none of them long enough to fail. Declare
`inconclusiveOnCaseTimeout: true` (it implies `inconclusiveOnPageStall`, and
so `inconclusiveOnStackTimeout`; beside either set to `false` it throws when
declared), and the body runs against a budget, `timeoutMs` less
`CASE_BUDGET_MARGIN_MS` (20 s; a quarter of `timeoutMs` for a case under 80
s), kept back to judge the failure and write its evidence; its browsers then
close without the case waiting for them (one Chrome takes 3 s, more under
load), so a slow close never turns the outcome into node:test's timeout.
Running out of the budget is `E2E_CASE_BUDGET`, `the case's budget
ran out: not done within <budget> ms (its timeoutMs <timeoutMs> less <margin>
ms, kept to judge and record it)`: a wait that ran out, which `pageStall`
(and `functionKill`, when declared) read like any other, its window the whole
case. So it ends INCONCLUSIVE when a page of the case saw the stack stall at
any time in it, and FAILS, with every page captured, when none did. The
reason names the case where it was declared:

```
the stack did not answer, so nothing was measured: a page's Firestore client lost the emulator
(reader: "Could not reach Cloud Firestore backend"), in the 350 s before a wait ran out — the failure,
at a14-workspace.spec.mjs:486 (via scenario, test.mjs:855): the case's budget ran out: not done within 340000 ms (…)
```

```js
scenario("A14.1 the workspace lists Recently updated first …", { timeoutMs: 360_000, inconclusiveOnCaseTimeout: true }, async (ctx) => { … });
// with a spec's own judges: the budget goes inside them, so that running out of it is judged
scenario("…", { timeoutMs: 300_000 }, onAnsweringStack(caseBudget(fn, 300_000), { also: (err, ctx) => pageStall(err, ctx) ?? mine(err, ctx) }));
```

The body is abandoned, not stopped: what it awaits runs on until the case
closes its pool, and `ctx.users` then throws `this case's body was abandoned
(its budget of <budget> ms ran out); no new users`. Without the option a case
keeps its whole `timeoutMs`, and running out of it FAILS as before.
As the body starts, the budget sets `ctx.budgetEndsAt`, the `Date.now()`
time it runs out (the earlier of two, when a spec wraps a budgeted body in
its own), which `untilLanded`'s `stopAt: "budget"` reads (below); it stays
null in a case without a budget.
`selftest/case-budget.test.mjs` pins this, through `node --test` and the
reporter, with real pages.

**A wait that ran out while the case's own requests were cut off.**
`pageStall` reads what the case's PAGES saw. A case whose own Node requests
(`ctx.http`, `ctx.mcp`, a session's, a seed's: any http.mjs client inside
the case) got Hosting's cut-off 504 has the same evidence that the stack
stalled, and a case whose budget ran out before any page existed has no
other: A6.1 sent POST /publish four times, each cut off at 60 s, and FAILED
on its budget. Declare `inconclusiveOnRequestStall: true` (it implies
`inconclusiveOnPageStall`, and so `inconclusiveOnStackTimeout`; beside
either set to `false` it throws when declared), or call `pageStall(err, ctx,
{requests: true})` in your own `also`, and a request the case made that
answered Hosting's cut-off 504 inside the wait's window counts as a page's
does. It is off by default: without it nothing changes. A quicker 504,
another status, or a request nothing answered (the client's own deadline) is
no evidence. The reason names them after any page's evidence:

```
the stack did not answer, so nothing was measured: a request this case made got Hosting's cut-off 504
(owner: POST /publish 504 after 60005 ms; owner: POST /publish 504 after 60008 ms), in the 350 s before a wait ran out — the failure,
at a06-comments.spec.mjs:420 (via scenario, test.mjs:1083): the case's budget ran out: not done within 340000 ms (…)
```

```js
scenario("A6.1 …", { timeoutMs: 360_000, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true }, async (ctx) => { … });
// by hand, beside a spec's own judge: the budget inside the judges, so that running out of it is judged
scenario("…", { timeoutMs: T }, onAnsweringStack(caseBudget(fn, T), { also: (err, ctx) => pageStall(err, ctx, { requests: true }) ?? mine(err, ctx) }));
```

`ctx.requests()` → `[{t, at, actor, method, url, path, status, ms, error}]`
is what it reads: the case's own Node requests so far, one row per request
and per redirect hop, as http.mjs logged them into the case's evidence
(`http.jsonl`, redacted; the latest 2,000). `t` is the hop's start and `at`
(`t + ms`) its answer, both `Date.now()` times; `url` is redacted as
`http.jsonl` has it, `path` has no origin, query or fragment; `status` is
null when nothing answered, and `error` is then the fetch's own failure
(`timeout after N ms` among them) or `guard refused: <rule>`. A client made
with `evidence: false` logs nowhere, so its requests are not there. Each call
gives fresh rows and never throws, even after the case timed out. Read it for
a judgement of your own instead of `ctx.ev.http`, which is Evidence's
internal buffer of JSON lines. `selftest/request-stall.test.mjs` pins this,
through `node --test` and the reporter.

`ctx.requests({pending: true})` adds, after those rows, one row per hop
still in flight (sent, and neither answered nor failed yet): `{t, at: null,
actor, method, url, path, status: null, ms: null, error: null, pending:
true}`, `t` when it was sent. Only `pending: true` adds them; `requests()`,
`requests(null)` or any other value gives the rows as before. It reads
http.mjs's `pendingRequests(sink)` → `[{t, actor, method, url}]` (copies,
the url redacted; `[]` for anything that is not a sink with a hop in
flight), which lists each hop under the sink its record will be written to,
so a case sees exactly its own: a client made with `evidence: false` is
listed nowhere.

A request sent OUTSIDE `createHttp` (syncHttp's worker threads) reaches
the same two places through two more http.mjs exports, which a guarded
`syncHttp` already uses: `evidenceSink(target, evidence = undefined)` →
`(line) => void` is the sink a client made with that `evidence` writes to
(a function is itself, a directory its `http.jsonl`, `false` nothing,
undefined the running case's, else the process-wide one, else the run's
file; give it only `traceLine()` strings; any other `evidence` is a
TypeError), and `trackPending(evidence, {t = Date.now(), actor = "anon",
method, url})` → `untrack()` lists one hop as pending under that sink
(decided at the call, in the caller's async context) until `untrack()`
(idempotent) is called; the url is redacted there.

**A budget that ran out while the stack answered the case's own requests
slowly.** Hosting's cut-off is a request the stack never answered. A loaded
shared stack also answers late without cutting anything off: on run wr3h,
A4.1 and A4.2 ran out of their budgets while 5 to 14 of their requests each
took 30–60 s, none cut off, and with no page to give `pageStall` evidence
they FAILED as `E2E_CASE_BUDGET`. Declare `inconclusiveOnHttpStall: true` (it
implies `inconclusiveOnCaseTimeout`, and so `inconclusiveOnPageStall` and
`inconclusiveOnStackTimeout`; beside any of them set to `false` it throws
when declared), or call `httpStall(err, ctx)` in your own `also`, and such a
case ends INCONCLUSIVE. `httpStall(err, ctx, {slowMs = 30_000, now =
Date.now()})` judges:

- **the failure** is the case's budget running out (`E2E_CASE_BUDGET`) and
  nothing else. A slow answer is still an answer: it may explain the case
  running out of time, never a wait for something that did not show, an
  assertion, an answer, a precondition or a known defect's oracle (each
  null);
- **the evidence** is at least one of the case's own requests
  (`ctx.requests({pending: true})`) that took `slowMs` or more to be answered
  or to fail (the client's own deadline included), or that had been in
  flight that long when the judge ran: the request the budget ran out
  during. A quicker failure, or a guard refusal (never sent), is none. A
  budget that ran out on a stack that answered quickly FAILS;
- `slowMs` is 30 s by default, half Hosting's cut-off: a quiet stack answers
  these requests in well under 2 s. A request the product takes that long
  even on a quiet stack (a large upload) is no evidence of anything: give
  that case a larger `slowMs`. Below 10,000 ms (the Firestore SDK's own
  threshold) it throws `TypeError`, as a `now` that is not a `Date.now()`
  time does.

With the option, the case's judges are asked in order: `pageStall` (with
`requests: true` under `inconclusiveOnRequestStall`), then `httpStall`, then
`functionKill` when declared. The reason names the slowest three:

```
the stack did not answer, so nothing was measured: the case's budget ran out while the stack answered its own
requests slowly: 6 of its 31 request(s) took 30 s or more (owner: POST /visibility answered 200 after 58004 ms;
harness: POST /publish still unanswered after 41210 ms; owner: POST /session answered 200 after 37950 ms; and 3 more),
so the time it ran out of went to the stack — the failure, at a04-expiry.spec.mjs:612 (via scenario, test.mjs:1260): the case's budget ran out: …
```

```js
scenario("A4.2 …", { timeoutMs: 720_000, inconclusiveOnHttpStall: true }, async (ctx) => { … });
// by hand, beside a spec's own judges: the budget inside them, so that running out of it is judged
scenario("…", { timeoutMs: T }, onAnsweringStack(caseBudget(fn, T), { also: (err, ctx) => pageStall(err, ctx) ?? httpStall(err, ctx) }));
```

`selftest/http-stall.test.mjs` pins this, through `node --test` and the
reporter.

**Sending again what the stack did not answer.** A setup call that a loaded
stack left unanswered is often not lost, only late: Hosting gave up after its
minute, and the function went on to finish. `untilLanded(ctx, what, send,
effect, {attempts = 3, lookupMs = 60_000, intervalMs = 2_000, backoffMs =
5_000, stopAt = null, onFail = null})` sends such a call again instead of
giving up on the case:

- `send` is the call. `unanswered(x)` decides, of what it threw or returned,
  whether the stack answered: Hosting's cut-off 504 (thrown, or returned on
  the result or on its `response`), the client's own deadline, the Admin
  SDK's, a CLI run's `cut`. Any answer, a refusal included, is the
  product's, and is returned or thrown as it is.
- After a non-answer, `effect` (async () => the effect, or null, undefined
  or false while it is not there; a throw counts as "not yet") is read every
  `intervalMs` for up to `lookupMs` BEFORE anything is sent again, and taken
  when found. `effect: null` is a call that may simply be sent again (POST
  /session), after `backoffMs`. `onFail({attempt, why, error, out})` runs at
  each non-answer, before the look.
- Each failure, look and resend is a step. After `attempts` sends with no
  answer and no effect, or a failure at or past `stopAt` (a Date.now() time:
  nothing is sent after it), the case ends INCONCLUSIVE, whatever its
  options: `the stack did not answer, so nothing was measured: <what> got no
  answer N time(s) (the last: …), and it had not taken effect <lookupMs> ms
  after each`, the last failure its cause and in `stack-did-not-answer.txt`.
- It resolves `{out, landed, attempts}`: the call's own answer, or the effect
  found instead (then `out` is null).
- `stopAt: "budget"` ties it to the case's own budget, `ctx.budgetEndsAt`
  (`inconclusiveOnCaseTimeout`, or a body wrapped in `caseBudget`; a ctx
  without one throws `TypeError` before anything is sent). A number is
  checked only after each look, so a `stopAt` near the budget let the budget
  run out mid-look: A5.5 and A5.6 sent POST /publish three times, each cut
  off at 60 s and looked after for 60 s, and FAILED as `E2E_CASE_BUDGET` at
  340 s with no page to give `pageStall` evidence. With `"budget"`,
  everything ends 2 s before the budget would: a look is cut to end by then
  (each read raced against it, so a read the stack does not answer cannot
  hold it), and the call is sent again only while one more send and what
  follows it still fit, the longest send that went unanswered so far plus
  `lookupMs` (or `backoffMs`, with `effect: null`). Otherwise the case ends
  INCONCLUSIVE at once: `… got no answer 2 time(s) (the last: …), and it had
  not taken effect 60000 ms after each; it was not sent again: one more
  send and its look, about 120004 ms, would not end within the case's
  budget (98000 ms left)` (a cut look reads `… nor 31000 ms after the last,
  all the case's budget left`). The first send is always made, and
  `attempts` still bounds it, in its own words. The budget does not keep
  room for what the case does AFTER the call lands: a case that then runs
  out still ends on the budget, judged as before.

```js
const before = (await readDoc(ctx.target, `docs/${docId}`))?.marking ?? null;
const r = await untilLanded(ctx, "POST /marking", () => owner.http.postJson("/marking", { docId, marking }, { timeoutMs: 150_000 }), async () => {
  const now = (await readDoc(ctx.target, `docs/${docId}`))?.marking ?? null;
  return now && !isDeepStrictEqual(now, before) ? now : null;   // this call's write, not the old value
});
const { out: owner } = await untilLanded(ctx, "POST /session", () => openSession(ctx.target, acct, { timeoutMs: 150_000 }), null);
// in a case with inconclusiveOnCaseTimeout: never sent again past what its budget can hold
const up = await publish(owner.http, { body: html, filename: "index.html", title, timeoutMs: 150_000, patient: { ctx, stopAt: "budget" } });
```

`publish`, `publishMcp` (lib/seed.mjs), `setVisibility` and `share`
(lib/grant.mjs) take it as `patient: {ctx, attempts, lookupMs, intervalMs,
stopAt}`, with the effect read from the record for you (Seed, fixtures and
grants); their `stopAt` takes `"budget"` too. `selftest/until-landed-budget.test.mjs`
pins `"budget"` and `ctx.budgetEndsAt`, through `node --test` and the
reporter: the A5.5 case ends INCONCLUSIVE with it and FAILS on its budget
without it.
`stallEvidence(users, since)` → `{cut, lost}` is the evidence pageStall
reads, for a spec's own judgement: a line per response answered Hosting's
cut-off 504 at or after `since`, and per page whose Firestore client lost
the emulator then. `selftest/until-landed.test.mjs` pins this, through
`node --test` and the reporter.

A spec with wider evidence of its own still passes it as
`onAnsweringStack(fn, {also: (err, ctx) => reason | null})`. `also` is asked
only when none of the shapes matched, and never about an assertion, a known
defect's oracle, an INCONCLUSIVE, an isolation breach or a guard refusal.
When it throws, the failure stands. Its reason is redacted like the others.

`lib/test.mjs`: `HOSTING_CUTOFF_MS` (59,000); `isHostingCutoff(r)` →
boolean; `stackCutoff(what, rOrMs)` → an `E2E_STACK_CUTOFF` error (`stackCut`
its redacted reason, `response` the answer, or `{status: 504, ms}` for a
number); `answered(r, what)` → `r` (`what` defaults to the request as `r`
names it; `r` may also be a CLI run, judged by its `cut`); `stackDidNotAnswer(err)` → the reason or null;
`onAnsweringStack(fn, {also})` → a case body; `STALL_WINDOW_MS` (130,000);
`pageStall(err, ctx, {windowMs = STALL_WINDOW_MS, marginMs = 10_000, now =
Date.now(), requests = false})` → the reason or null (a negative or
non-finite option, or a `requests` that is not a boolean, throws
`TypeError`); `functionKill(err, ctx, {since = ctx.logSince, target =
ctx.target})` → the reason or null (`since` a byte offset, a whole number 0
or more, or null; anything else throws `TypeError`; null without a mark, the
`logs` capability or a log); `callSite(err)` → string or null;
`unanswered(x)` → the reason or null; `untilLanded(ctx, what, send, effect,
{attempts = 3, lookupMs = 60_000, intervalMs = 2_000, backoffMs = 5_000,
stopAt = null, onFail = null})` → `{out, landed, attempts}` (`stopAt` a
`Date.now()` time, `"budget"` or null; a bad argument, an unknown option,
or `"budget"` on a ctx without `budgetEndsAt` throws `TypeError` before
anything is sent);
`stallEvidence(users, since)` → `{cut, lost}` (throws `TypeError` unless
`users` is an array and `since` a number); `CASE_BUDGET_MARGIN_MS` (20,000); `caseBudget(fn, timeoutMs)` → a case body
that sets `ctx.budgetEndsAt` as it starts and rejects `E2E_CASE_BUDGET` (with
`budgetMs` and `timeoutMs`) when its budget runs out (a `fn` that is not a
function, or a `timeoutMs` that is not a positive number, throws
`TypeError`); `httpStall(err, ctx, {slowMs = 30_000, now = Date.now()})` →
the reason or null (`slowMs` under 10,000 or not a number, or a `now` that
is not a `Date.now()` time, throws `TypeError`). An
`inconclusiveOnStackTimeout`, `inconclusiveOnPageStall`,
`inconclusiveOnFunctionKill`, `inconclusiveOnCaseTimeout`,
`inconclusiveOnRequestStall` or `inconclusiveOnHttpStall` that is not a
boolean throws when the scenario is declared.

### Time budgets

`node --test`'s `--test-timeout` bounds each spec FILE as a whole: when it
fires, the cases still to run are cancelled, however healthy (a13-sharing's
ten cases, 1,530 s of their own timeouts, were cut at a fixed 600 s on a
slow shared stack). So, unless `--timeout <ms>` is given (then it is the
file's and every case's, as before), `run.mjs` gives each tier the largest
**file budget** among the files it runs, never less than the tier default
(smoke 120 s, functional 600 s, concurrency 1,800 s):

- a spec's own, a top-level unindented declaration
  `export const E2E_FILE_TIMEOUT_MS = 25 * 60_000;` (an integer, or a product
  of integers and earlier top-level numeric constants). Declare one when your
  cases come from a wrapper or a loop the scan cannot see;
- otherwise the sum over its `scenario()` calls of cases × `timeoutMs` (the
  tier default for a call without one), capped at 6× the tier default. The
  scan reads the source, never runs it: options must be an object literal,
  `timeoutMs` an integer, a top-level numeric const or a product of them, `n`
  an array literal, `trials` an integer or an object of integers. Anything
  else counts once at the tier default.

A case with no `timeoutMs` of its own gets `E2E_CASE_TIMEOUT_MS`, the tier
default, so it keeps the bound it had rather than the file's larger budget.
The run logs `<tier>: file timeout <ms> (<spec>'s budget)`, and
`invocation.json` keeps `timeouts`. A malformed `E2E_FILE_TIMEOUT_MS` is a
usage error (exit 2) before any stack starts.

`lib/budget.mjs`: `tierTimeouts(files, {defaultMs, explicitMs = null,
ceilingMs = defaultMs * CEILING_FACTOR, read})` → `{fileTimeoutMs,
caseTimeoutMs, explicit, driver, files}`; `fileBudget(file, {caseDefaultMs,
ceilingMs, source})` → `{file, declaredMs, cases, sumMs, computedMs,
budgetMs, unresolved: [{line, why}]}` (see what the scan made of a spec:
`node -e 'import("./e2e/lib/budget.mjs").then((b) =>
console.log(b.fileBudget("e2e/specs/functional/<area>.spec.mjs", {caseDefaultMs:
600000})))'`); `scanScenarios(src, {caseDefaultMs})` → `{calls, cases,
sumMs, unresolved}`; `declaredFileTimeout(src)` → ms or null (throws
`E2E_FILE_TIMEOUT` when declared twice or unreadable); `caseTimeoutDefault(env
= process.env)` → ms or null; `blankSource(src)`, `evalInteger(text, consts)`,
`topLevelIntegers(src)`; `FILE_TIMEOUT_NAME`, `CASE_TIMEOUT_ENV`,
`CEILING_FACTOR` (6).

The bound is Node's, and `run.mjs` spawns `node --test` with the Node that
runs it. `nodeTestArgs` puts `--test-timeout=<ms>` on the parent `node --test`,
and both Node versions pass the flag down to each file's process. Node 22
(measured on 22.17) also times the FILE with it: four healthy 1 s cases with
their own 5 s timeouts, at `--test-timeout=3500`, pass 3 and the file is
cancelled. Node 24 (measured on 24.21) does not: there it is only the default
timeout of a test with none of its own, the same file passes 4/4, and no file
is cut. So on Node 24 the file budget cancels nothing healthy either way;
what the per-case default (`E2E_CASE_TIMEOUT_MS`) still prevents, on both, is
a case with no `timeoutMs` inheriting the FILE budget: a hung case would hold
its file, and one of the tier's concurrency slots, for the sum of every
case's timeout (up to 6× the tier default) instead of its own bound.
`selftest/budget-run.test.mjs` pins both: which of the two this Node does,
and, as its negative control, a hung case without the per-case default held
for the whole 18.5 s budget where with it it is cut at 3.5 s and the cases
after it run.

**A file that fails as a whole leaves a record for every case it took
down** (`lib/reporter.mjs`). When the file's timeout fires, or its process
fails outside any case (an import or top-level throw, a top-level
`before()`/`after()` hook, a crash, `process.exit` in a body), node:test
reports only the per-file wrapper, and the case running then and every case
after it used to vanish: the summary said `7 cases … 0 fail` while the run
exited 1. The reporter keeps every top-level case the file declared and
every one that started, and turns each that never reported into a FAIL
record: error code `E2E_FILE_CANCELLED`, message `cancelled: file timeout
(test timed out after <ms>ms) while this case ran` or `… before this case
started` (`cancelled: the spec file failed (…)` for anything but the
timeout), and `cancelled: {reason: "file-timeout"|"file-failed", started,
by}`. Subtests the running case had already reported keep their path under
it. When every declared case did report (a failing `after()` hook, a throw
after the last case), the failure is one record of its own,
`<file>::(file)`, with `fileFailure: {failureType, by, cancelledCases}` and,
in `detail`, the last 30 lines of the file's stderr and stray diagnostics,
redacted as evidence is; its message carries what they say ("the spec file
failed outside any case: test failed — Error: load boom"). A case
`--grep` left out is never declared, so never reported cancelled.
`FILE_RECORD_NAME` (`"(file)"`), `CANCELLED_CODE`, `isFileEvent(data)`,
`fileKey(file)` (the wrapper names the file as it was given, the cases by
the path the process loaded: both go through realpath), `DETAIL_MAX_LINES`
(30) and `DETAIL_MAX_CHARS` (500) are exported.

Every case writes, on failure (or always with `E2E_EVIDENCE=always`),
`evidence/<case>/`: `steps.md` with the rerun command, `error.txt`, the case's
`http.jsonl`, and per browser user `console-<u>.jsonl`, `requests-<u>.jsonl`,
`dom-<u>.html`, `screenshot-<u>.png` (and `trace-<u>.zip`). Everything written
goes through http.mjs's redaction (cookies, bearer and `bs*_` tokens, JWTs,
passwords, `?k=` and `/content/~<k>/` link keys) and then a fail-closed check:
a line in which a credential shape survived is replaced by a marker, never
written. Screenshots cannot be redacted: never put a secret on screen you do
not need there.

**Measurements are not evidence.** A passing case leaves no
`evidence/<case>/` (unless `E2E_EVIDENCE=always`), and the reporter keeps no
`t.diagnostic` line but `evidence=` and `outcome=`, so a number a PASSING
case measured (a serial control's rate, a fixed build's rounds) would be
lost. `measure(ctx, name, row, {env = process.env})` (`lib/evidence.mjs`)
appends one JSON line, `{at, case, n, trial, ...row}` (the ctx's name, N
and trial, null when it has none; a key of `row` wins), to the invocation's
`<name>.jsonl` (`<E2E_INVOCATION_DIR>/<name>.jsonl`, beside `load.jsonl`
and `rss.jsonl`), whatever the outcome. It is deep-redacted as evidence is,
and a line in which a credential shape survives is written as `{at, case,
n, trial, withheld}` instead, so the rows still count. It returns `{file,
line, withheld}` (plus `error` when the append failed: a measurement is
never the case's outcome), or null outside a run. `name` matches
`MEASURE_NAME_RE` (`/^[a-z0-9][a-z0-9-]{0,63}$/`; the file is
`<name>.jsonl`) and is none of the harness's own files,
`RESERVED_MEASURE_NAMES` (`results`, `load`, `rss`, `http`, `invocation`,
`summary`, `merged`) or `results-…`, which report.mjs reads as the
reporter's records. A bad name, a row that is not a plain object or does
not serialise, or no ctx throws TypeError, outside a run too, so a mistake
shows on the first local run. `measureFile(name, env = process.env)` → the
path, or null outside a run; an `E2E_INVOCATION_DIR` outside `e2e/.out`
throws.

```js
import { measure } from "../../lib/evidence.mjs";
measure(ctx, "c04-first-join", { scenario: "C4 press", latency: "rtt150", offsetMs: 100, copies: 2 });
```

`<case>` is `slugify(name)` (`lib/evidence.mjs`): lower case, `[a-z0-9-]`, at
most 80 characters, with `-2`, `-3`, … when the name is taken. `assertPath`
(`lib/paths.mjs`) refuses a path holding `null` or `undefined` as a segment or
beside a dash, because that is how a template literal built from a missing
value looks. In a case name, though, either one is just a word ("uid and
email null", "non-null", "a null cursor"), so slugify writes each with a dash
before its last letter, wherever it stands: `…-email-nul-l-…`,
`undefine-d`. Every other name slugs as it always did. Evidence also checks
each directory before it makes it, so a refused path (now only a slug set
by hand, not one from slugify) throws without leaving an empty directory.
`selftest/evidence-slug.test.mjs` pins this, through `node --test` and the
reporter.

### Tiers, effects and production safety

Production is refused in this build, but specs are written for both tiers
now, so they must already behave:

- Declare `tiers: ["local"]` for anything only a local stack can do (reading
  Mailpit, `resetLocal`, operator scripts, patches, killing a process).
  `tiers` defaults to both.
- Declare every email the case causes in `effects` (`"email:POST /access"`,
  `"email:comment"`, …): on production such a case is skipped, with the
  reason.
- Share with `share(target, {owner, doc, account, role})` from
  `lib/grant.mjs`, never a raw `POST /access`: locally it is the real
  endpoint; on production it is the operator script, which sends no email.
  Several grants in ONE `POST /access` are `shareMany` (below), which has no
  production path and throws `E2E_LOCAL_ONLY` there before sending.
  `joinShared` (`lib/live.mjs`) follows the same rule: one `POST /access`
  on a local stack, `share()` per editor through the operator script
  anywhere else, so it causes no email on production (see "Joining N
  editors"). So does `addMember` for its one person (or grants nothing,
  with `role: null`).
- Before an in-browser comment on production, call
  `createGuard(target).assertQuietDoc(docId)` (or `quietDoc(target, docId)`):
  it refuses unless the owner, every approver and every prior comment author
  are run accounts with notifications off.
- A spec that comments and must stay quiet on BOTH tiers casts with
  `cast(target, roles, {notifications: false})`: on a local stack that writes
  `users/{uid}` `{uid, email, emailNotifications: false}` before any session
  (POST /session merges over it), as production always does, so
  `quietDoc()` holds locally too and no comment notice is sent.
  `{analytics: false}` adds `analyticsOptOut: true`. Without either option a
  local account still has no record until its first session.
- A rules-evaluated Firestore write (`clientFirestore`, `lib/firestore-client.mjs`)
  is guarded like any other write on production: every document it names
  must be under `docs/<id>` or `public/<id>` of a document the run created,
  `folders/<id>` of a folder it created, or `users/<uid>` of a run account
  (rules `ledger`, `ledger-folder`, `ledger-account`); any other collection
  (`firestore-path`), another project (`firestore-project`), a transaction or
  an unknown method (`firestore-unclassified`) is refused, and absent-id
  probes are not taken. A write anywhere under `docs/<id>/versions/<v>/annotations`
  is comment-capable: it goes only after `assertQuietDoc(<id>)`. Reads (GET,
  `:runQuery`, `:batchGet`, …) go. The browser routes the same REST API. The
  classification is `FIRESTORE_REST` in `lib/guard.mjs` (`evaluate` takes the
  run accounts' uids as `ctx.ledgerUids`; `check()` fills it from the ledger).
- A Realtime Database REST request (`rtdbAs`, `lib/rtdb.mjs`) is guarded the
  same way on production: to the target's database (`target.databaseURL`) or
  any `*.firebaseio.com` / `*.firebasedatabase.app` host, a write (any method
  but GET, HEAD and OPTIONS, or an `x-http-method` that says so) goes only
  under `status/<id>` of a document the run created (`ledger`); another
  database (`rtdb-project`) or namespace (`rtdb-namespace`), `.settings` or
  any other path (`rtdb-path`) and anything that is not `…/<path>.json`
  (`rtdb-unclassified`) are refused. Reads of the target's own database go.
  The classification is `RTDB_REST` in `lib/guard.mjs`.
- The one Realtime Database write outside `status/<id>` is the harness's
  own: the presence/edit mirror of a run document that
  `scripts/set-access.mjs` left missing (suspect S16), written only when a
  case asks for it (`mirror: "write-missing"` on `joinShared`, `addMember`
  or `grantEditors`, or `writeMirror` from `lib/grant.mjs`). It is the
  mirror the product's own grant path would have written, read from the
  document's record, and it goes only through its own narrow guard,
  `mirrorWriteVerdict`, on every target: ETag reads and conditional replacements
  of each access node, with the source document's revision fence, for a document
  in the run's ledger, naming run accounts only (plus public editing when the
  document enables it), recorded in `findings.jsonl` beside the S16 finding (see THE
  MIRROR, WRITTEN BY THE HARNESS under Seed, fixtures and grants).
- Every account, document, folder, token, grant, OAuth client and team a spec
  creates through `lib/` is appended to the run's `ledger.jsonl`
  (`lib/ledger.mjs`); the production guard refuses to act on anything that is
  not in it. Create through the helpers, not by hand. A fork is a creation
  too: `fork()` from `lib/seed.mjs`, never a bare `POST /fork`; so is a team:
  `createTeam()`, never a bare `POST /team {op: "create"}`; so is a folder:
  `createFolder()`, never a bare `POST /folder`, and over MCP
  `createFolderMcp()`, never a bare `create_folder`. A creating
  helper (`publish`, `fork`, `createTeam`, `createFolder`) ledgers a 200 even when the call's `expect`
  refused it and threw, so a document the case did not expect is still the
  run's. A document the BROWSER made (the app's Fork button, its upload
  page) or the CLI made never passes through those helpers: ledger it with
  `ledgerDoc(target, {docId, via, ownerEmail, actor, versionId, forkOf})`
  (`lib/seed.mjs`) the moment the case knows its id, before anything else
  names it; a folder made with the workspace's Folder button with
  `ledgerFolder(target, {folderId, via, ownerEmail, actor, parentId, name})`;
  a personal token minted outside `mintToken` (the CLI's browser login, the
  account page, an OAuth exchange that answers a `bsk_` token) with
  `ledgerToken(target, {tokenId, uid, channel, name, via})`.
  A `BrowserPool` also ledgers every document and folder its users' pages
  create by itself (see WHAT A PAGE CREATED under Users and the browser), so
  one the case did not expect is still the run's; the explicit call is
  still what makes it the run's before the case's next request.
- Folder grants have NO production path: `POST /folder-access` emails every
  new member, and `scripts/set-access.mjs` takes documents only. Grant on a
  folder with `shareFolder` / `unshareFolder` (`lib/grant.mjs`), which throw
  `E2E_LOCAL_ONLY` on any other target before sending, and declare
  `effects: ["email:POST /folder-access"]` so the case is skipped there.
  Team membership (`teamMembers`, `POST /team-members`) is refused on
  production by the guard, as `POST /team` is.
- An absent-id probe that is a write (a POST, or an MCP act or comment tool),
  for SPEC §1.4b's "the same 404 as an absent id", names an id from
  `absentDocId(target, name = "absent")` (`lib/seed.mjs`), never a bare
  `docIdFor`. The id is ledgered as `absent` (`ledgerAbsentIds(target)` in
  `lib/ledger.mjs`; `ledgerDocIds` leaves it out, so quarantine skips it). On
  production the guard sends such a write only after `absentDoc(target,
  docId)` (`lib/guard.mjs`, also `createGuard(target).assertAbsent(docId)`)
  proves `docs/<id>` does not exist and holds no subcollection, and refuses
  it (rule `absent-probe`) when it does. An email route stays refused
  whatever it names; an `absent` row outside the run's `e2e-<run6>-`
  namespace is refused (`absent-namespace`); the CLI wrapper and the
  browser's Firestore writes take no probes. A GET may name any id, so a read
  probe needs none of this. Never publish at an absent id.
- Make a document unlisted or public only with `setVisibility(target, {owner,
  doc, visibility, expiresAt, publicEdit})` from `lib/grant.mjs`, never a raw
  `POST /visibility`: the window it opens closes with the case (see
  scenario() above), so on production no document stays readable past the
  case that opened it. When the case's next steps need the document private
  again, open it with `withVisibility(target, {owner, doc, visibility}, fn)`
  instead: it is private as soon as `fn` returns or throws. A window the
  Share dialog opened in a browser is
  registered with `trackWindow(target, {owner, doc, visibility})`. One opened
  outside any case (a `before()` hook) is the process's: `closeWindows()` in
  `after()`.
- Name a deliberately unknown MCP tool with the `e2e_no_such_` prefix
  (`UNKNOWN_TOOL_PREFIX`): the production guard refuses any tool it cannot
  classify.
- A race fired from Node with `syncHttp` (`lib/sync.mjs`) passes `{target:
  ctx.target}`: its worker threads send with Node's own http, outside
  `createHttp`, and only then is each request and its warm-up checked for
  isolation, asked of the guard before any worker exists (one refusal and
  nothing is sent), and traced into the case's `http.jsonl`. Without a
  target, syncHttp refuses any request or warm-up whose host is not
  loopback (`E2E_GUARD`, rule `sync-unguarded`), so an unguarded race
  cannot reach production at all. See Synchronisation (races).

### Users and the browser

```js
const [owner, viewer] = await cast(ctx.target, ["owner", "viewer"]);  // lib/accounts.mjs
const a = await ctx.users.user({ name: "owner" });                    // BrowserPool → User
await a.signInUi(owner.email, owner.password);
await a.open(docId);
```

A pool makes contexts only while the machine has room: before its first,
`E2E_POOL_BASE_GB` (2) + N × `E2E_POOL_CONTEXT_MB` (600) must be available
for the N contexts it is about to make (`many(n)` asks for all n at once),
then 600 MB per further one, on the stack gate's figure (memory_pressure's
free share of physical memory). It waits up to `E2E_POOL_WAIT_MS` (120 s),
logging to the invocation's `load.jsonl`, then throws `E2E_INCONCLUSIVE`: the
case measured nothing. `close()` reaches every browser, whatever closing a
user or a context threw; scenario() calls it in `finally`, on a failure and on
a timeout too, and Playwright closes a process's browsers on its SIGINT,
SIGTERM or SIGHUP (`selftest/browser-orphans.test.mjs`). Every Chrome is
launched with `--e2e-browser-mark=<runPid>.<runStart>.<launcherPid>.<launcherStart>.<8 hex>`
on its command line (`lib/browsers.mjs`; `run.mjs` passes itself to specs as
`E2E_RUN_OWNER`), so `reap` finds and stops one whose run or launcher is gone.

`BrowserPool({target, usersPerBrowser = 5, headless, trace})`: `user({name,
consent = null, device = null})`, `many(n, {batch, names, consent = null,
device = null})` (`consent` and `device` below), `parser()` (a scratch page for DECOR),
`printRenderer({width = 794, height = 1123, media = "print", deviceScaleFactor
= 1})` (a scratch renderer judged by pixels, below), `breaches()`,
`sdkProbes()`, `created()` (every user's `log.created`, each row with its
`user`), `assertIsolation()`, `stats()`, `close()`. One Chrome per five
users, one context and page per user; every context is instrumented before its
first navigation (an isolation tripwire, toast capture, console, request and
websocket frame logs).
`signInMany(users, accounts, {batch})` signs many in, five at a time.

A `User` has `name`, `page`, `context`, `email`, `device` (`{width, height,
touch}`, frozen), `responses`, `log` (`console`, `errors`,
`requests`, `toasts`, `breaches`, `external`, `websockets`, `sdkProbes`,
`created`, `wsFrames`), `inEdit`, `tabs` and `tabOf` (one person's other
tabs, below) and:

| | |
|---|---|
| navigation | `url(path)`, `goto(path)`, `open(docId, {v, k, timeout = 45_000, reloads = 0, sessionCheck = false})` → `{src, sandbox, editable}` (with `reloads` or `sessionCheck`, also `{loads, stall, session}`: below), `waitForFrame({match, editable})`, `frame()` |
| session | `signInUi(email, password, {path = "/signup", next, expectStatus = "ok", timeout = 75_000, here = false})` → `{status, already, httpStatus, body, gate, url, bodyUnread?}` (below), `sessionCookie()` |
| editing | `enterEdit({waitShared})` → `{share, frame}`, `awaitEdit({waitShared = false, timeout = 45_000})` → `{share, frame}` (enterEdit's waits without its press: below), `typeInFrame(selectorOrPoint, text, {delay, at})`, `typeAndAutosave(selectorOrPoint, text, {delay = 15, at, thenBackspace = 0, timeout = 20_000, expectStatus = 200})` → `{status, body, saveState, startedAt, clock, entry, typed, inputs, after}`, `waitForAutosave({after, timeout = 20_000, expectStatus = 200})` → `{status, body, saveState, startedAt, clock, entry}` (below), `done()`, `saveAsNewVersion()` → `{outcome: published\|nochange\|conflict\|save-failed\|error, text, versionId, toast}`, `shareState()`, `saveState()`, `recordSaveStates()` → `{states: [{i, s, t, text}], inputs: [t], armedAt, read(), stop()}` (below) |
| touch | `tap(point, {durationMs = 50})` → `{x, y, durationMs, tappedAt}`, a touch user only (below) |
| reading and comments | `clickInFrame(selectorOrPoint, {where: center\|start\|end, hitTest = true})` → `{clickedAt, inner, scale, hit: {page, frame} \| null}`, `selectText(selector, exact, {occurrence, fab})` → `{via: drag\|range-fallback, text, rects}`, `selectBetween({sel, exact, occurrence}, {sel, exact, occurrence}, {fab, steps = 10, timeout})` → `{via: drag\|range-fallback, text}`, `drag(start, end, {steps})`, `openComments({timeout})` → `{presses}`, `thread(quote, {kind: any\|comment\|suggestion})`, `comment(text, {timeout = 20_000, retryServiceError = 0, reselect = null})` → `{quote}` (into the thread its own press made; with `retryServiceError`, `{quote, serviceErrors}`: below), `reply(quote, text, {timeout = 30_000})`, `resolve(quote, {timeout = 30_000})`, `reopen(quote, {timeout = 30_000})` (`timeout` bounds each of their waits: below) |
| suggestions | `pressSuggest({refused: true\|false\|null, timeout})` → `{refused, reason, clickedAt}`, `suggestState()` → `{open: false}` or `{open: true, quote, value, start, end, focused, hint, note, submitDisabled}`, `suggest(replacement, {note, keyboard = false, timeout})` → `{opened, value, response}` (below) |
| printing | `capturePrint(labelOrFn, {timeout = 15_000, frames = 1, extract = null, arg = null, match = null})` → `{armedAt, frames: [{index, t, sandbox, className, src, printed, hooks, hookError, snaps: [{t, html, title, url, error, extra, extractError}]}], ignored: [{t, sandbox, className, src}]}` (below) |
| More menu | `moreMenu({timeout})` → `{groups: [{heading, items: [{label, disabled, reason}]}], labels}`, `menuGroup(heading, {timeout})` → `labels[]` \| `null`, `chooseMenu(label, {timeout})` → `{label, disabled, reason, heading}`, `download(labelOrFn, {timeout = 30_000})` → `{filename, bytes, url}` (below) |
| tabs | `newTab({name = null})` → a `User`: another page of the same context, so the same account (below); `ownsPage(page)` → boolean |
| waiting | `toastMark()`, `toastsSince(since = 0)` → this user's toasts since the mark, `waitForToast(pred, {since, timeout})`, `poll(fn, {timeout, interval, what})`, `waitShown(locatorOrSelector, {what, path, timeout = 30_000, reloads = 1})` → `{loads, stall}`, `waitValue(read, want, {what, path, timeout = 30_000, reloads = 1, interval = 200})` → `{loads, stall, value}` (below) |
| files, dialogs, toasts | `dropFiles(selectorOrLocator, files, {events = DROP_EVENTS, timeout = 10_000})` → `[{type, claimed}]`, `answerDialog(action, {accept = true, value, timeout = 15_000})` → `{type, message, defaultValue, accepted, value}`, `dismissToasts({timeout = 10_000})` → `{dismissed: [{kind, text}], left: [{kind, text}]}`, `pressRetryingServiceError(selectorOrLocator, {retries = 3, backoffMs = 3_000, done, timeout = 30_000, what = null})` → `{serviceErrors}` (below) |
| creations | `log.created` → live `[{t, kind: doc\|folder, via, id, ledgered, error}]`, `settleCreated({timeout = 30_000})` → `log.created` once every creation answered so far is ledgered (below) |
| frame loads | `watchFrameLoads(docId = null)` → `{loads, summary(), settled(), stop()}` (below) |
| absence | `watchFor(selector, text = null)` → `{selector, text, sightings(), documents(), stop()}`: `sightings()` → `[{seq, doc, t, goneAt, gone: null\|removed\|navigation, path, text, visible}]`, `documents()` → `[{doc, t, path, via: call\|load}]`, `stop()` → the rows (below) |
| CPU | `throttleCpu(rate)` → `restore()` → the rate then in force (below) |
| analytics | `fulfilAnalytics({measurementId})` → `seen` (below) |
| network | `responseMark()`, `findResponses(pred, {since})`, `waitForResponse(pred, {since, timeout})` → `{seq, t, at, ms, method, url, path, query, type, status, headers, requestHeaders, postData, postBuffer, postJson, response, request}`; `capture({paths = null, method = "POST", responseJson = true, max = 5000})` → live rows `{seq, method, url, path, type, op, postJson, t, sentAt, respondedAt, doneAt, status, json, failure, state: sent\|answered\|finished\|failed, settled}` with `mark()`, `waitFor(pred, {since = 0, timeout = 30_000, settled = true})`, `waitInTurn(pred, {since = 0, settled = true, unansweredMs = HOSTING_CUTOFF_MS + 16_000, idleMs = 30_000, what = "waitInTurn"})` → the row, `stop()` (below); `delayRequests(path, {method = "POST", rules, match = null, maxMs = 120_000, at = "hosting"})` → `{rows, seen(), restore()}`, `failRequests(path, {method = "POST", status = 500, count = null, match = null, body, at = "hosting"})` → `{failed, restore()}` (below) |
| websocket frames | `log.wsFrames` → `{sent: string[], received: string[], total: {sent, received}, dropped: {sent, received}}`, live, from the context's creation (below) |
| evidence | `domExcerpt()`, `close()` |

**One person in two tabs.** `u.newTab({name = null})` → a `User` opens
another page in `u`'s own context: the same cookies, storage and signed-in
account, already under the context's tripwire, toast observer and logs. The
tab is a User of its own, with its own `name` (`<u>-tab2`, `-tab3`, … unless
named; a name `u` or one of its tabs already has throws), `page`, `inEdit`
and `closed`, so `enterEdit`, `open`, `typeAndAutosave` and the rest drive
that tab. `log`, `responses`, `email`, `creating` and the response sequence
(`responseMark()`) are the context's: the tab reads and writes `u`'s own,
and signing in on a tab signs the whole context in. What a User waits on is
its own page's: `findResponses`, `waitForResponse` (so `waitForAutosave`),
`capture`, `delayRequests`, `failRequests`, `waitForToast` and
`toastsSince` take only the requests and toasts of pages it owns
(`ownsPage(page)`). A tab owns its own page. `u` owns every page no tab
claims: its own, a popup, a page made with `u.context.newPage()`. A user
with no tab owns every page, as every user did before. So two tabs that
both edit never take each other's autosave, and a delay set on one never
holds the other's requests. `u.responses` and `u.log` still hold every
page's rows (the stall judges read them). Each response entry, capture row
and toast names its page in a non-enumerable `page` (null when the request
had none), never serialised. `tabs` lists the tabs in the order asked for,
closed ones included, and each tab's `tabOf` is `u` (a tab's own `newTab`
opens another tab of `u`). A tab is never in `pool.users`. `newTab` asks
the pool's memory gate for one context first (a tab is a renderer of its
own), and its INCONCLUSIVE leaves no tab. A tab's `close()` closes its page
alone (Playwright's `page.close()`, which by default runs no `beforeunload`
handler; `tab.page.close({runBeforeUnload: true})` runs them). `u.close()`
closes the context and every tab with it.
Compare tabs by identity with `assert.ok(a === b)`, never
`assert.equal(a, b)` (see Known harness facts).

```js
const tabB = await e.newTab();                       // "p2-tab2": p2's account, its own page
await tabB.open(docId);                              // a reader of the document in a second tab
await tabB.close();                                  // the tab's page only; e's page stays in the editor
```

`signInUi` signs in with the password form at the sign-in page and reports
what POST /session answered (SPEC §2, §14). `path` is that page with whatever
query the case needs, sent as given (`/signup?next=${encodeURIComponent(x)}`;
the router's `/SIGNUP` too); any other page throws before anything opens.
`expectStatus` is the outcome the case wants: `"ok"` (the default),
`"unverified"`, `"not_allowed"`, `"session_failed"`, a list of them, or `null`
for whichever comes; any other outcome throws `POST /session answered <http>
<body> (wanted …)`, carrying that answer as `response` (a plain `{method,
path, status, ms}`), so Hosting's cut-off 504 to POST /session is the stack
not answering (`inconclusiveOnStackTimeout`) and a quicker one is judged.
`timeout` bounds each of its waits; the default, 75 s, outlasts that cut-off
(60 s), so a POST /session the stack never answered ends in that 504 rather
than in a wait no judge can read (`selftest/browser-signin-cutoff.test.mjs`). It
resolves once the PAGE shows the outcome, not at the
response: for `"ok"` the app has left the sign-in page (`url` is where it
landed, so a `next=` case reads it there) and the `__session` cookie is
stored; for `"unverified"` the verification step shows (`gate:
"needs_verification"`, or `"needs_email"`) and nothing has navigated; for
`"not_allowed"` its notice (`gate: "not_allowed"`); for `"session_failed"` the
form again with its error (`gate: "signed_out"`). `status` is the body's
outcome, `httpStatus` the response's status, `body` its JSON (null, with
`bodyUnread: true`, when a navigation took it; the page then decides). A
context already signed in to Firebase shows no form: the page's own POST
/session as it loaded is the answer, with `already: true`, and the same
expectation applies (an unverified account signed in earlier stops at the
gate again; `"ok"` means the page redirected).

```js
const acct = await castUnverified(ctx.target, "invitee", { email });   // the address shared with earlier
const s = await u.signInUi(acct.email, acct.password, { path: `/signup?next=${encodeURIComponent(`/d/${docId}`)}`, expectStatus: "unverified" });
assert.equal(s.gate, "needs_verification");                             // "Send me a code" is on screen
```

`here: true` opens nothing: it signs in on the sign-in page the APP
navigated to, such as Fork's `/signup?next=<encoded /d/<id>?k=…&fork=1>` or
the viewer's "Sign in", so the URL the app built (its `next=`, the Fork
intent, a link key) and the page's in-memory state are the ones signed in
on, with no reload, as a person does it. It waits up to `timeout` for the
page to be the sign-in page on the stack's origin showing the form, so call
it straight after the click that leads there. A page already at a gate is
`already: true`, answered by the last POST /session this user saw. A page
that never gets there throws `signInUi({here: true}): the app did not show
the sign-in page … the page is at <pathname>` (the pathname only: the query
may hold a link key). `here` with a `path` throws before anything happens.

```js
await u.page.locator(".viewer-toolbar").getByRole("button", { name: "Fork", exact: true }).click();
const s = await u.signInUi(forker.email, forker.password, { here: true });  // the form the app opened
const forkId = await u.poll(() => …the /d/<id> the app opened…);
ledgerDoc(ctx.target, { docId: forkId, via: "fork-ui", ownerEmail: forker.email, forkOf: sourceId });
```

`next: "/d/<docId>"` signs in where the case is going: it opens
`/signup?next=<encoded next>`, so the app boots ONCE, on the sign-in page, and
goes on to the document by itself (signing in and then `open()` boots it
twice, which on a loaded shared stack is much of a short browser case). With
the outcome `"ok"` it resolves only once the page is at `next`, its pathname
and query as the URL parser normalises them (`url` is then that page); call
`waitForFrame()` next for the document. One that lands anywhere else within
`timeout` throws `signInUi({next}): signed in, but the app did not land on
<pathname> … the page is at <pathname>` (pathnames only). Only a path the app
honours is taken (app/src/next.ts `safeNext`: `"/…"` on this origin, not
`"//…"`, no backslash or control character); anything else throws before a
page opens, so probe the app's refusal of a bad `next` with `path`. `next`
beside `path` or `here` throws. Another outcome (`"unverified"`) does not wait
to land. A `next` the app leaves by itself as it lands (Fork's `&fork=1`) is
gone before it can be seen: use `path`.

```js
const u = await ctx.users.user({ name: "owner" });
await u.signInUi(owner.email, owner.password, { next: `/d/${docId}` });   // one boot, on the document
const frame = await u.waitForFrame();
```

**The browser's session, for Node.** A case that signed a user in through the
UI already holds a session: `browserSession(user, {account})`
(`lib/session.mjs`) copies that user's own `__session` cookie
(`sessionCookie()`) into an http.mjs client's jar, so the case's Node calls
(`publish`, `share`, `mintToken` …) ride it with no second POST /session (5–10
s a case on a loaded shared stack) and no request at all to get it. It
resolves `{account, http, uid, idToken: null, refreshToken: null, via:
"browser"}`. `uid` is the cookie's own subject (its `user_id`, else `sub`;
read, never verified: the stack verifies it), so it is the account the
browser IS signed in as: with `account` (a cast account, the session's then),
a cookie of another uid throws; without it, `account` is `{role: user.name,
email, uid}` from the cookie. The client is new unless `http` is given (its
jar then gets the cookie, and its own options apply); a new one takes
`evidence`, `timeoutMs` and `cutoffError` as `openSession` does, its actor is
the account's role, and inside a case it logs to the case's `http.jsonl`. It
is the SAME session, copied once with its path, expiry and `Secure`: a
revocation reaches both, DELETE /session (`closeSession`) clears only the copy
it went from, and a later sign-in in the browser is not seen. There is no ID
token, so what needs one (`clientFirestore`'s `session`, POST /oauth/consent)
takes `idToken(target, account)`. A user holding no `__session` cookie for the
stack's origin, or one that is not a token naming an account, throws
`E2E_SESSION`; anything but a User of a target throws `TypeError`.
`selftest/browser-session.test.mjs` pins it with a stand-in that sets the
cookie as POST /session does.

```js
const [acct] = await cast(ctx.target, ["owner"], { notifications: false });
const u = await ctx.users.user({ name: "owner" });
await u.signInUi(acct.email, acct.password);
const owner = await browserSession(u, { account: acct });          // no second POST /session
const up = await publish(owner.http, { body, filename: "index.html", title, ownerEmail: acct.email });
```

`log.requests` holds one row per request, `{t, ms, method, url, type,
status, finished}`, written at its RESPONSE and completed in place when it
finishes (`finished: true`, the total `ms`) or fails after its headers
(`failure`); a request that fails before any response is a row with `failure`
only. Playwright never emits `requestfinished` for some responses whose body
the page does not read (measured on a stack: the viewer's `POST /view` beat),
so those are rows with `finished: false`, never missing ones.
`User.responses` keeps every response (the last 5000) as a live entry with
the request's body: `postJson` is the parsed JSON body or null, `postData` the
string, `postBuffer` the bytes, `headers` the response's. A predicate is a
function of the entry (one that throws is a non-match), an exact path, a
RegExp over the path, or `{method, path, status}`. Take `responseMark()`
BEFORE acting, then `waitForResponse(pred, {since: mark})`: unlike
`page.waitForResponse`, a response that already arrived is found, not missed.
Entries hold Playwright objects and are never written to evidence.

```js
const mark = reader.responseMark();
await reader.open(docId);
const beat = await reader.waitForResponse((r) => r.method === "POST" && r.path === "/view" && r.postJson.docId === docId, { since: mark });
assert.equal(beat.status, 200);
```

`capture({paths, method})` is the request log to use when WHAT a page sent,
and in what order, is the assertion: a claim told from an accept on the same
path, a save that must come between them, a request cut off before any
answer. It is opt-in and starts empty: from the call on, every request whose
pathname matches `paths` (an exact path, a RegExp, a list of them, or null for
all) and whose method matches `method` (POST by default, a list, or null for
any) is one row, in the order the requests were SENT, written at the request
(so one that never gets a response is still a row) and completed in place.
`postJson` is the request's body parsed as JSON (null when it is not), `op`
its string `op` field or null. `sentAt`, `respondedAt` (headers) and `doneAt`
(finished or failed) are this process's `performance.now()` as Playwright's
`request`, `response` and `requestfinished`/`requestfailed` events arrive,
which is the order the browser reported them; compare them with your own
`performance.now()`, and `t` (the wall clock at the send) with `Date.now()`.
`status` stays null without a response, `failure` is the browser's error text,
`json` the response body parsed once it has finished (null when it is not JSON,
or with `responseJson: false`). `state` is `sent`, `answered`, `finished` or
`failed`; `settled` is true once the row will not change again (after the body
is read). A response the page never finishes reading stays `answered`, as in
`log.requests`. A request already in flight at the call is never a row.
`waitFor(pred)` resolves the first row since a `mark()` (a seq) that matches
and has settled (`settled: false` takes it at once); `pred` is a function, a
path, a RegExp, or `{method, path, op, status}` with `op` and `status` each a
value or a list, and a timeout names what was captured. `stop()` takes no new
rows and lets the rows in flight complete. It keeps the last `max` rows;
`seq` and `mark()` count every row ever taken, so a mark survives the trim.
Rows stringify as plain data (the Playwright request is a non-enumerable
`request`). They hold bodies unredacted in memory, so write them to evidence
only through `ctx.ev.json`, which redacts, and drop a `/draft` row's `html`
first: it is the whole document. The browser's own `request.timing()` is not
used: Playwright (1.63) takes `startTime` from the response's timing baseline
but measures `responseEnd` from the request's first event, so the two do not
share an origin.

```js
const posts = approver.capture({ paths: ["/suggestion", "/draft"] });
const clickedAt = performance.now();
await bar.getByRole("button", { name: "Accept" }).click();
await posts.waitFor({ path: "/suggestion", op: "accept" });
const seq = posts.filter((p) => p.sentAt >= clickedAt);
assert.match(seq.map((p) => p.op ?? p.path).join(" "), /^claim( \/draft)+ accept/);
for (let i = 1; i < seq.length; i += 1) assert.ok(seq[i - 1].doneAt <= seq[i].sentAt, "each was sent after the previous one had finished");
posts.stop();
```

**A page's chain of requests on a loaded stack.** `waitFor` has one deadline
for the whole wait and never reads the rows it waits through: an accept the
page sends only after a claim and a POST /draft that each took the stack
tens of seconds runs it out while the stack is still working, and the
failure carries nothing `pageStall` can read (seen in A8.2: two POST /draft
sent at 20 s, answered at 35.6 s). `waitInTurn(pred, {since, settled,
unansweredMs, idleMs, what})` waits on the chain itself and returns the
row `waitFor` would: the first since `since` that matches `pred`, once
settled (`settled: false`: once sent). It reads every row from `since`,
and from any row still unsettled as it starts (a save under way holds up
what follows it), and has three ends, none of them a deadline of its own:

- every answer goes through lib/test.mjs `answered()` as it arrives:
  Hosting's cut-off 504 to ANY request of the chain throws E2E_STACK_CUTOFF
  ("v's page's POST /draft (Accept) answered 504 after 60004 ms, …",
  `response` the row), so the case ends INCONCLUSIVE through
  `stackDidNotAnswer`; a quicker 504 is an answer, returned when it is the
  row asked for;
- a request still `sent` (no answer at all) `unansweredMs` after it was sent
  (Hosting's cut-off and 16 s, 75 s, by default) throws E2E_STACK_CUTOFF too,
  counted, for one sent before the wait began, from the wait's start: a
  request the case held itself (`delayRequests`, sync.mjs `holdRequests`)
  reached the stack only when it was let go, and the capture cannot see the
  hold, so wait in turn on a held request once it is let go (or up to its
  send, with `settled: false`), never across a hold longer than that;
  with `stackCut` "v's page's POST /draft (#4, Accept) got no answer in 75012
  ms, past Hosting's own cut-off of 59000 ms: the stack did not answer it",
  `response` null;
- only a page that, with none of its requests `sent`, changes no row for
  `idleMs` (30 s) FAILS: "v: Accept: the page sent nothing more within 30000
  ms, with none of its requests in flight (captured since 3: …)", or "v:
  Accept: #5 matched but had not settled (answered), and nothing changed
  within 30000 ms, …". That is a wait in `pageStall`'s words, judged with
  the case's own evidence.

A response the page never finishes reading stays `answered` and does not
hold the wait open. Capture only the chain's paths: every captured row is
judged, and a long-polled request in the capture (Firestore's GET back
channel, under `method: null`) would be "no answer". Arguments are checked
before anything waits, and an unknown option throws (there is no
`timeout`); the case's own timeout is the outer bound.
`selftest/browser-capture-in-turn.test.mjs` pins each end, the default, and
that the single-deadline `waitFor` runs out on the same chain.

```js
const posts = approver.capture({ paths: ["/suggestion", "/draft"] });
const accepting = posts.mark();
await bar.getByRole("button", { name: "Accept" }).click();
const acc = await posts.waitInTurn((r) => r.path === "/suggestion" && r.op === "accept", { since: accepting, what: "Accept" });
assert.equal(acc.status, 200); // claim, POST /draft and accept each answered, none of them cut off

// A request the case holds: wait up to its send, act, let it go, then wait in turn on its answer.
const hold = holdRequests(approver.page, (url) => url.pathname === "/suggestion", 1, { method: "POST", predicate: (req) => /"op":"accept"/.test(req.postData() ?? "") });
await hold.installed;
const again = posts.mark();
await bar.getByRole("button", { name: "Accept" }).click();
await posts.waitInTurn({ path: "/suggestion", op: "accept" }, { since: again, settled: false, what: "Accept, up to its send" });
// … what the case does while the accept is held
await hold.release();
const released = await posts.waitInTurn({ path: "/suggestion", op: "accept" }, { since: again, what: "the released accept" });
```

`delayRequests(path, {rules})` makes this user's network slow for one path
of the stack's origin, without failing anything: each matching request,
in the order it reaches the route, takes the next rule, `rules[i]` a number
(held so many ms), a function (held until the promise it returns settles,
called as the request arrives; a rejection releases it too, as `ruleError`)
or null (at once); past the list, at once; never longer than `maxMs`
(`DELAY_MAX_MS`, 120 s, by default). Then
it goes on with `route.fallback()`, through the isolation tripwire, to the
stack. `path` is an exact pathname (`"/draft"` is POST /draft, never the
frame's GET /draft/<doc>/<file>) or a RegExp over it, `method` POST by
default (a list, or null for any), `match({method, url, path, postJson,
postData})` narrows by body (a throw is a non-match). Only requests on ONE
of the stack's origins are taken, `at`: `"hosting"` (the default) the app's,
`target.origin`; `"firestore"` the stack's Firestore, where the page's
Firestore SDK sends its requests (`target.firestoreUrl`; below). The same path
anywhere else (another host or port) is not taken, so neither this nor
failRequests can answer, and hide, an isolation breach. Any other `at`, or
`"firestore"` on a target that names no `firestoreUrl`, throws before any
route. `rows` (live) is one per matching request, `{seq, t, method, url,
path, postJson, rule: ms\|until\|none, ms, heldAt, releasedAt, released,
ruleError}`, `heldAt`/`releasedAt` this process's `performance.now()` and
`released` why it went: `"rule"`, `"cap"`, `"restore"`, `"at-once"`, or null
while held. `restore()` takes no more, lets every held one go and removes the
route: call it in `finally`. A delayed request is a `capture` row from the
moment the page sent it; it reaches the stack at `releasedAt`. Routes stack:
the one registered last is consulted first. Not `lib/sync.mjs`
`holdRequests`, which holds N requests and releases them together.

`failRequests(path, {status, count})` answers matching requests HERE, so the
stack never sees them: `status` from 400 to 599 (500 by default) with `body`
(`FAIL_BODY`, `{"error": "e2e: failed on purpose by User.failRequests"}`, by
default; a string as `text/plain`; anything else as JSON), or `"abort"`, the
browser's own network failure (fetch rejects). `count` fails the next so many
and lets the rest through; null fails every one until `restore()`. `path`,
`method`, `match` and `at` as above, on that one origin only. `failed` (live) is
`{seq, t, at, method, url, path, postJson, status}` per failed request. Both
keep bodies in memory unredacted: write rows only through `ctx.ev`.

```js
// A save slower than the debounce, then the autosave delivered only after the commit has answered.
const posts = u.capture({ paths: ["/draft", "/commit"] });
let committed;
const commitDone = new Promise((r) => (committed = r));
const slow = await u.delayRequests("/draft", { rules: [1_500, () => commitDone] });
try {
  // … type, press Save …
  await posts.waitFor({ path: "/commit" });
  committed();
} finally {
  await slow.restore();
}
const failing = await u.failRequests("/draft", { count: 1 });                        // "a save fails"
const cut = await u.failRequests("/suggestion", { status: "abort", match: (r) => r.postJson?.op === "accept" });
```

**A backend slower than the Firestore SDK.** `at: "firestore"` takes the
page's own requests to the stack's Firestore emulator instead of the app's
origin. `FIRESTORE_LISTEN_PATH` (`/google.firestore.v1.Firestore/Listen/channel`)
is the SDK's Listen channel, through which every snapshot listener of the page
is served: its POSTs carry what the page asks for (the first opens the
channel), its GETs are the long-polled back channel, which a POST rule never
takes. Held past 10 s, the SDK gives up on the backend: it logs `Could not
reach Cloud Firestore backend` and serves its offline cache until the held
requests go on (measured on two stacks: offline 9,974 and 10,001 ms after
the first held POST, the snapshot it waited for only after the hold). That
console line is `pageStall`'s
evidence of a stall: in a case that holds the channel on purpose and
declares `inconclusiveOnPageStall` (or `inconclusiveOnCaseTimeout`), a wait
that runs out in that window ends INCONCLUSIVE, not FAIL. Judge what the page
must show after the hold with an assertion, or leave those options off. A
channel's body is form-encoded, so its rows' `postJson` is null, and the raw
body `match` reads carries the account's ID token (its Authorization header,
measured): never write it. To hold every POST of one window, give every rule
the same gate, made as the first arrives
(`selftest/browser-delay-firestore.test.mjs` pins `at`, the window and the
origin checks):

```js
import { FIRESTORE_LISTEN_PATH } from "../../lib/browser.mjs";

let gate = null;
const window15s = () => (gate ??= new Promise((r) => setTimeout(r, 15_000)));    // from the first POST on
const hold = await u.delayRequests(FIRESTORE_LISTEN_PATH, { at: "firestore", rules: Array(50).fill(window15s) });
try {
  await u.signInUi(acct.email, acct.password);          // the workspace's first listen waits 15 s
  … // what the page shows while its SDK is offline
} finally {
  await hold.restore();
}
const firstHeld = hold.rows[0]?.t;                      // Date.now(), as log.console's `t`
const offline = u.log.console.find((c) => c.t >= firstHeld && /Could not reach Cloud Firestore backend/.test(c.text ?? ""));
```

`capture` is also the oracle for "this page sent nothing", such as a viewer
who may not edit posting no thumbnail. Start it before the page loads, give
the same capture to a user who does send, and assert on its rows, never on
`log.requests`: that is written at the response, so a request still waiting
for its answer has no row there, and an absence read from it passes while
the request is in flight. A request whose answer the page never reads gets
no `requestfinished` from Playwright on a stack (measured for the viewer's
`/view` beat, and for `POST /thumb`, from which `uploadThumbs` takes only
`res.ok` and which got no `requestfailed` either), so its row stays
`answered` and never settles: wait for it by status with `settled: false`
(a status never matches a row that has no answer yet). The query is on
`url`. `selftest/browser-capture-upload.test.mjs` pins how capture and
`log.requests` treat such a request, with a server that holds the answer in
place of the stack.

```js
const vPosts = viewer.capture({ paths: "/thumb" });          // before either page loads
const oPosts = owner.capture({ paths: "/thumb" });
await viewer.open(docId);
await owner.open(docId);
const cover = await oPosts.waitFor({ path: "/thumb", status: 200 }, { settled: false, timeout: 60_000 });
assert.equal(new URL(cover.url).searchParams.get("kind"), "cover");
assert.deepEqual(vPosts.map((r) => r.url), [], "the viewer posted nothing, not even a request still in flight");
```

**Every request a page starts**, whatever its path or method, is
`capture({method: null})`: a row per request from the moment it is sent,
in every page and frame of the user's context, with `type` its resource
type ("fetch", "xhr", "document", "image", "script", …) and `t` the wall
clock at the send. It is the log for "the search sent nothing" or "no cover
POST": a request that never got an answer is a row here and nowhere else.
`selftest/browser-capture.test.mjs` pins it for a page's image, a child
frame's own fetch and a second page of the same context.

```js
const watch = u.capture({ method: null });
const t0 = Date.now();
await u.page.locator("#workspace-search").fill("plans");
await new Promise((r) => setTimeout(r, 2_000));            // longer than any debounce
// Firestore's listen backchannel re-opens on its own schedule: the one request to leave out.
const sent = watch.filter((r) => r.t >= t0 && !(r.method === "GET" && r.path.endsWith("/Listen/channel")));
assert.deepEqual(sent.map((r) => `${r.method} ${r.path} (${r.type})`), [], "searching sent nothing");
watch.stop();
```

**WHAT A PAGE CREATED.** Every document and folder a user's pages create on
the target is ledgered by the pool itself, whether the case expected it or
not: a 200 to POST /publish without `update` (`via: "upload-ui"`), to POST
/folder (`"folder-ui"`, with the request's `parentId` and the answered
`name`), or to POST /fork `{op: "create"}` (`"fork-ui"`, `forkOf` the
source), only on the target's origin (`pageCreation(method, url, postJson,
origin)` → `{kind, via, …}` or null, exported, decides). The row is the one
`ledgerDoc` / `ledgerFolder` write, with `actor` the user's name and
`ownerEmail` the email it signed in with (null if it never did). Each
creation is a row in `log.created`, `{t, kind, via, id, ledgered, error}`,
pushed as the answer arrives and completed once its body is read:
`ledgered: false` with an `error` when the answer named no id or the target
has no run directory; nothing there ever throws. `await
u.settleCreated()` resolves once every creation answered so far is ledgered:
call it after the page shows what it made, then assert on what was made
(`pool.created()` across users: "one upload per dropped file"). On
production a spec still ledgers what it acts on next itself, the moment it
knows the id; twice is harmless.

```js
await u.dropFiles(".workspace-main", [{ name: "a.html", data: "<!doctype html><title>A</title><p>A", type: "text/html" }, { name: "b.md", data: "# B\n", type: "" }]);
await u.page.waitForURL(/\/d\//);                                      // what the app does after an upload
const made = (await u.settleCreated()).filter((r) => r.kind === "doc");
assert.equal(made.length, 2, "one upload per dropped file");
assert.ok(made.every((r) => r.ledgered), JSON.stringify(made));
```

`dropFiles(selector, files, {events})` drops files as the browser builds a
drop from the desktop: a `DataTransfer` holding real `File` objects (its
`types` is `["Files"]`), dispatched on the element as each of `events` in
order (`DROP_EVENTS`, `["dragenter", "dragover", "drop"]`, by default; any
of `DROP_EVENT_TYPES`, which adds `"dragleave"`), at the element's centre.
`selector` is a selector on the page (its first match, waited for up to
`timeout`) or a Playwright Locator. `files` is a non-empty list of `{name,
data, type}`: `data` a Buffer, a Uint8Array or a string (sent as UTF-8),
`type` the MIME type, `""` when a browser would not know it (a `.md` file);
Playwright's `{name, buffer, mimeType}` is taken too. It resolves `{type,
claimed}` per event, `claimed` whether the page called `preventDefault`:
a drop zone that does not claim `dragover` lets the browser navigate to the
file, so that is an oracle of its own.

`answerDialog(action, {accept = true, value, timeout = 15_000})` runs
`action` (the click that raises it) and answers the `window.alert`,
`confirm`, `prompt` or `beforeunload` dialog it raises: accepted, with
`value` typed into a prompt, or dismissed with `accept: false`. A prompt
accepted with no `value` returns `""` to the page, not its default. Only
the first dialog is answered; a later one is Playwright's, which dismisses
it. It resolves `{type, message, defaultValue, accepted, value}` once the
dialog is answered and `action` has settled, and throws when `action`
throws or no dialog came within `timeout`; it leaves no listener behind.

```js
const asked = await u.answerDialog(() => menu.getByRole("menuitem", { name: "Rename" }).click(), { value: "Plans 2026" });
assert.deepEqual([asked.type, asked.defaultValue], ["prompt", "Plans"]);
const warned = await u.answerDialog(() => menu.getByRole("menuitem", { name: "Delete folder" }).click());
assert.equal(warned.message, "Delete “Plans 2026”? Everything inside moves up one level — nothing is deleted.");
```

`dismissToasts({timeout = 10_000})` presses Dismiss (`TOAST_DISMISS_LABEL`,
app/src/components/Toast.tsx) on every toast showing that has one, with a
DOM click on each toast's own button (so one lying under another goes
too), and waits until each pressed toast has left the page. Error toasts
never go by themselves and the stack lies over a dialog's footer, so call it
before pressing anything near the bottom of the screen. A busy toast and one
whose button is an action ("Undo") have no Dismiss and stay. It resolves
`{dismissed, left}`, each `[{kind: error|info|busy, text}]`, and throws when
a pressed toast is still showing after `timeout`. The toasts were already
recorded in `log.toasts` as they appeared.

`fulfilAnalytics()` answers every analytics request the user's context makes
from the call on, here, and counts it: nothing reaches Google, on a stack or
(later) on production. Call it straight after creating the user, before the
page loads anything that may start analytics. Its route is registered after
the tripwire's and Playwright consults the last route first, so it answers
these and everything else falls through to the tripwire as before. What it
answers (`analyticsRequest(url, {method = "GET"})` → `{kind, …}` or null,
exported): the measurement script (`kind: "gtag"`, any googletagmanager.com
URL) with `ANALYTICS_SCRIPT_STUB`, a comment that runs nothing, so nothing is
ever collected; a collection request (`"collect"`: google-analytics.com,
analytics.google.com, doubleclick.net, `ANALYTICS_HOSTS` with their
subdomains) with a 204; the SDK's dynamic web config (`"web-config"`, exactly
`GET https://firebase.googleapis.com/v1alpha/projects/-/apps/<appId>/webConfig`)
with `{appId, measurementId}`; Firebase Installations (`"installations"`,
exactly `https://firebaseinstallations.googleapis.com/v1/projects/<p>/installations[/<fid>[/authTokens:generate]]`)
with a made-up installation and token. Another path, method or port at those
two Google API hosts is not matched and stays a breach. The app passes
Firebase no measurement id of its own (`VITE_FIREBASE_MEASUREMENT_ID` only
switches analytics on), so the SDK takes it from the web config, and without
that answer never inserts the measurement script: `measurementId`
(measurement-id-shaped; by default the stack's own, else a fresh dummy, and
`seen.measurementId` either way) is the id gtag is then loaded for. `seen` is
live, one row per request in the order the route saw them, `{t, user, kind,
method, host, path, id, status}` (`id` the URL's `id` or `tid` parameter, else
null; `status` what it was answered). A second call returns the same array.
Cross-origin preflights never reach a route: Playwright answers them while
interception is on and adds the CORS headers to a fulfilled response. On
production a row's path names the deployment's app id: write rows to
evidence only through `ctx.ev`.

```js
const u = await ctx.users.user({ name: "allower" });
const seen = await u.fulfilAnalytics();                       // before the first navigation
await u.goto("/privacy");
// … Allow on the consent banner …
const gtag = await eventually(() => seen.filter((r) => r.kind === "gtag").length > 0 && seen.filter((r) => r.kind === "gtag"));
assert.equal(gtag[0].id, seen.measurementId, "loaded for the id the web config named");
assert.deepEqual(otherVisitorSeen, [], "a visitor who declined: nothing would have been sent");
```

**A visitor who already answered the consent banner.** On a deployment with
analytics (production, or a stack with the `a19-analytics-live` patch) the
app's consent banner sits fixed over the bottom of every page until the
visitor answers it, and takes the clicks meant for the controls beneath.
`ctx.users.user({name, consent: "denied"})` (or `"granted"`) is a visitor
who answered it earlier: `CONSENT_KEY` (`"bshd-consent"`, the app's own key
in `app/src/consent.ts`, exported) holds the answer in the context's
localStorage for the stack's origin before its first page loads, so the
first render reads it and no banner shows. It is Playwright's
`storageState`, written once as the context is made, as a returning
visitor's browser holds it: no request reaches the stack for it, no other
origin's storage gets it, and nothing answers it again, so a case that
removes the key sees the banner, as that visitor would. `null` (the
default) leaves it unanswered, which a case testing the banner needs. Any
other value throws `TypeError` (`user(): consent is "denied", "granted" or
null (unanswered), got …`) before a browser or a context is made;
`many(n, {consent})` gives each user the same.
`selftest/browser-consent.test.mjs` reads the key from `app/src/consent.ts`,
so a lib key that drifts from the app's fails there.

```js
const u = await ctx.users.user({ name: "owner", consent: "denied" });   // no banner over the account screen
```

**A phone or a tablet.** `ctx.users.user({name, device: {width, height,
touch: true}})` is a touch device of that viewport (whole CSS px): the
context is made with Playwright's `hasTouch` and `isMobile`, so the page
matches `(pointer: coarse)`, `(any-pointer: coarse)` and `(hover: none)` (the
queries the app's coarse-pointer styles are written against), has touch
events (`navigator.maxTouchPoints` 1) and honours its meta viewport (a page
without one lays out 980 px wide, as on a phone). `touch: false` (the
default) is only a window of that size, with a mouse; no `device` is the
desktop every user was before, 1280×800 with a mouse. The device is fixed
when the context is made, and the user's `device` says which. A malformed
one, or a key it does not take (a misspelt `touch` must not quietly make a
mouse device), throws `TypeError` before a browser or a context is made;
`many(n, {device})` gives each user the same.
`checkDevice(device, who)` (`lib/browser.mjs`) is that check, exported: it
returns the device, frozen (the desktop's for null), or throws the TypeError
with `who` at the start of its message. A helper that makes other things
before the user calls it first, as `live.mjs` `addMember` does before it
casts and grants anyone.

`tap(point, {durationMs = 50})` is a finger: Chrome's own gesture
(`Input.synthesizeTapGesture`) at `{x, y}` in the page's CSS px (a
`boundingBox()` centre; a point in the document frame goes through
`framePointToPage` first), so the page sees `pointerdown`/`pointerup` of
pointer type `touch`, `touchstart`, `touchend`, then `mousedown`, `mouseup`
and a `click`. Held longer it is a long press: 1,200 ms selects the word
under it and raises `contextmenu`, with no click. It resolves `{x, y,
durationMs, tappedAt}` once the finger has lifted. Only a touch user taps:
Chrome synthesizes the gesture on any page, so on a mouse user it would tap a
page whose coarse-pointer styles never applied, and that throws before
anything is sent; so does a point that is not two finite numbers, or a
`durationMs` that is not a whole number of ms. A point outside the viewport
is Chrome's own refusal, `Position out of bounds`: scroll it into view first.
For an element, Playwright's own `locator.tap()` works on a touch user.
`selftest/browser-touch.test.mjs` pins all of this, measured with Chrome 154.

```js
const PHONE = { width: 400, height: 800, touch: true };
const u = await ctx.users.user({ name: "phone", device: PHONE });
… // sign in, open the document
const geom = await frameGeometry(u.page);                          // lib/frame.mjs
await u.tap(framePointToPage(geom, centreOfTheQuote));             // a tap on a highlight
await u.tap(framePointToPage(geom, centreOfAWord), { durationMs: 1_200 });   // a long press: the word is selected
await u.page.getByRole("button", { name: "Comment" }).tap();       // Playwright's own, on a touch user
```

`log.wsFrames` keeps every websocket frame the user's pages sent and
received, from the context's creation on (before the first navigation, so a
socket a page opens as it loads is covered): `sent` and `received` are the
payloads as strings, each in the order Playwright reported them (a binary
frame decoded as UTF-8). It is the oracle for "this browser never asked the
database for X": on a stack the only websockets are the Realtime Database's
(`ws://127.0.0.1:<database port>/.ws?…`), whose frames are JSON naming the
path of each listen and write (`"a":"q"` with `"p":"/status/<doc>/y"` is a
listen). A frame is one websocket MESSAGE as DevTools reports it: the
browser's own fragmentation is invisible, and an empty message is not
reported. The database client splits a message over 16,384 characters into
several messages, the first holding only their count, so a long write is
several frames and its path is near the start of the second. Each direction
keeps the last `WS_FRAMES_MAX` (5,000) frames within `WS_FRAMES_MAX_CHARS`
(8 MiB) of text, and always the newest; `total` counts every frame and
`dropped` the ones let go. An absence read from a direction that dropped
frames proves nothing: assert its `dropped` is 0 beside it, and give a user
who does touch the path the same check, so a frame that did would be seen. A
database client that has once failed to use a websocket long-polls over HTTP
instead (`/.lp?…` requests), which this log does not see: check the user sent
frames at all. The frames hold the database client's auth frame (the
account's ID token): the lib never writes them to evidence; write any only
through `ctx.ev.json`, which redacts.

```js
const s = await ctx.users.user({ name: "suggester" });     // capturing from here on
await s.signInUi(acct.email, acct.password);
await s.open(docId);
// … the case runs …
const f = s.log.wsFrames;
assert.equal(f.dropped.sent, 0, "every frame the suggester sent is here");
assert.deepEqual(f.sent.filter((x) => x.includes(`/status/${docId}/y`)), [], "never listened to or wrote the live log");
```

The isolation tripwire lets ONE request to a Google host be blocked without
failing the case: the Firestore SDK's own network test, `GET
https://www.google.com/images/cleardot.gif?zx=<random>`, which its WebChannel
sends after a Listen channel error, whatever the app is configured to reach
(on a loaded stack, after a stall of 10 s or more). `isSdkProbe(url, {method
= "GET"})` is exactly that request (`SDK_PROBE`: https on the default port,
that host and path, `zx` alone and 2–12 base-36 characters, GET), and
`classifyUrl(url, target, {method = "GET"})` → `{verdict, reason}` says
`sdk-probe` for it on a local target (otherwise `allow`, `breach` or
`external`, as before). It is aborted, kept in `log.sdkProbes` (`{t, user,
method, url, resourceType, reason}`; `pool.sdkProbes()` for every user),
written as `sdk-probe` lines in the user's `console-<u>.jsonl`, and noted by
scenario(): a step, `sdk-probes.json` and one `findings.jsonl` row `{kind:
"sdk-probe", class: "E", case, count, users, first}`. It is an environment
signal, never a pass condition. Anything near it (another path, query, port,
scheme or method, a websocket) is a breach as before.

`openCrossSitePage(user, {path = CROSS_SITE_PATH, via, timeout = 30_000})`
→ origin (`lib/browser.mjs`) puts the user's page on an origin that is
CROSS-SITE to the target, for a site check tested end to end (SPEC §23's on
POST /oauth/consent): a request the page then sends to the target is
labelled `Sec-Fetch-Site: cross-site` by the browser itself and carries that
`Origin`, which no header a spec writes can stand in for. `via: "stack"`, the
default on a local target, opens `path` (`CROSS_SITE_PATH`, `/llms.txt`, a
static file, so no app boots; any path works) on the stack's own Hosting port
under the other loopback name, `http://localhost:<hosting>` for a stack on
127.0.0.1: another site, but a stack port the tripwire allows and a loopback
page Chrome lets reach the stack. `via: "route"`, the default on any other
target, opens `https://e2e-<8 hex>.example<path>`, which a route on the page
answers (a small page for a navigation, 404 for anything else), so nothing
reaches the network. A page a route answered is not on loopback to Chrome's
local-network rules, which refuse its requests to 127.0.0.1 before they are
sent (measured, Chrome 154), so on a local stack `via: "route"` runs the
production path but cannot test the stack. `via: "stack"` on a non-local
target, a path that is not `/…`, and a page that did not land on the origin
throw.

```js
const site = await openCrossSitePage(u);                       // http://localhost:<hosting> locally
const mark = u.responseMark();
await u.page.evaluate((to) => fetch(`${to}/oauth/consent`, { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: "{}" }), target.origin);
const r = await u.waitForResponse({ method: "POST", path: "/oauth/consent" }, { since: mark });
assert.equal(r.status, 403, `the site check refused a request from ${site}`);
```

`clickInFrame` is the click `typeInFrame` makes, with no caret and no
typing: a real left click at the element's centre, its first line's start or
its last line's end (or at a point in the frame's own viewport), mapped
through the frame's CSS scale. Use it for links, `<summary>`, highlights and
deck clicks. It hit-tests first and throws when the click would land
elsewhere: the page's topmost element at the point must be the document
iframe (not a toolbar, the selection FAB or the loading cover), and the
frame's element there must be the target or inside it. `hitTest: false`
clicks regardless; `hit` then is null.

`selectBetween(from, to)` is selectText across elements: a real drag from the
first character of `from.exact` (its `occurrence`th, inside `from.sel`) to the
last of `to.exact` inside `to.sel`, so the selection spans paragraphs, a
`<br>`, a list or a table. `from` is scrolled into view and `to` measured where
it then is. When either end is outside the frame's painted box it makes no
drag at all (no press reaches the frame); then, or when the drag did not select
from `from` to `to` (`selectionBetween` below), it sets the same Range instead
and says `via: "range-fallback"`. `text` is the selected Range's
text, trimmed: `Range.toString()`, the raw text anchors are measured against,
with the source's whitespace between blocks (`"…riverbank.\nA second"`), not
the Selection's rendered `toString()`. Like selectText it then waits for the
selection toolbar while reading (`fab: false` skips that).

`openComments()` is safe against the panel's first annotation snapshot, which
decides the default (open when a thread is unresolved) unless the reader
toggled first, and is never changed by anything after it. A single read and
press loses to a snapshot that lands between them: the snapshot opens the
panel and the press closes it. So it reads `data-comments`, presses only while
that reads closed (never while it reads open), waits up to 1.5 s for the panel,
and repeats until `timeout`; `{presses}` says how many it took (0: already
open). `thread(quote)` finds a comment thread by its `.thread-quote` and a
suggestion by the quote its change strikes (`.suggestion-change del`) or, while
its Edit form is open, the form's `.suggest-quote`; never by an earlier
replacement in its history or by the floating form outside the panel. `quote`
is a substring, as Playwright's `hasText`; `kind: "comment"` or `"suggestion"`
narrows it.

`pressSuggest()` presses the selection toolbar's "Suggest edit" as a person
does, refused or not. A selection the product will not take leaves the button
`aria-disabled`, with the reason as its title, and the press shows that reason
(SPEC §22). Playwright's `click` waits for "enabled", which an aria-disabled
button never becomes (it hangs), and `force: true` clicks whatever lies on top,
such as an earlier refusal's toast. pressSuggest waits until the button is the
topmost element at its own centre and has stopped moving, then makes one real
mouse click there; when it never is, it throws and presses nothing. `refused`
is an expectation: `true` wants the button aria-disabled, `false` wants it not,
and a mismatch throws before any press (`null`, the default, presses either
way). What the press did (the refusal toast, the form) is yours to wait for.
`suggestState()` reads the floating form in one go, without waiting: the quote,
the field's `value`, its selection `start`/`end` (equal: the caret), whether it
has focus, the hint under it, the note and whether the submit button is
disabled.

`suggest(replacement)` presses (as `pressSuggest({refused: false})`, so a
refused selection throws with its reason instead of hanging), fills the field,
presses Enter and waits for the form to close; an error toast throws
`suggestion refused: <text>` as soon as it shows, with `toast` and
`response`: the page's latest `POST /suggestion` entry since the press (as
`findResponses` gives it), or null when it sent none (a refusal the form
makes itself). So Hosting's cut-off 504 behind the toast is the stack not
answering (`stackDidNotAnswer` names it, `untilLanded` sends it again), and
any other answer, a quick 504 included, is the product's refusal, judged
(`selftest/browser-suggest-answer.test.mjs`). `keyboard: true` types as a
person does, from wherever the form put the caret: Backspace over the end of
the prefilled quote that differs from the replacement, then the rest key by key
(the note too). It needs the field focused, and when the field does not then
hold exactly the replacement (a caret that was not at the end) it throws
BEFORE Enter and sends nothing. It refuses a line break or tab, which cannot be
typed into the one-line field; paste one with `page.keyboard.insertText` in
your own steps. It resolves `{opened, value, response}`: the form as it opened
(in keyboard mode once its field had focus), the field as Enter was pressed,
and the page's `POST /suggestion` entry (as `findResponses` gives it) or null.

```js
await reader.selectBetween({ sel: "#p1", exact: "lazy dog" }, { sel: "#p2", exact: "A second" });
const mark = reader.toastMark();
const press = await reader.pressSuggest({ refused: true });          // throws if the selection was taken
await reader.waitForToast(press.reason, { since: mark });
await reader.selectText("#p2", "harbour lights");
const s = await reader.suggest("harbour beacons", { keyboard: true });
assert.deepEqual([s.opened.value, s.opened.start, s.opened.focused], ["harbour lights", 14, true], "prefilled, caret at the end");
assert.equal(s.response.status, 200);
await reader.openComments();
await reader.thread("harbour lights", { kind: "suggestion" }).first().waitFor();
```

`watchFrameLoads(docId)` records what the reading frame loaded, from the call
until `stop()`: one row per navigation REQUEST of a direct child frame of the
page to the document's files, `/content/[~<key>/]<docId>/<v>/…` or
`/draft/<docId>/…` (`parseDocumentPath(pathname)` → `{kind: content|draft,
docId, versionId, keyed}` or null, exported by `lib/browser.mjs`). A fragment
link loads nothing and is no row, although Playwright fires `framenavigated`
for it; a redirect chain is one row; an iframe inside the document is never
the reading frame and is never recorded. A row is `{seq, frameIndex, kind,
path, search, t, pageMs, sandbox, cls, status, committed, failure, redirects,
unread}` in `summary()` (plain data), and `loads` holds the same rows live,
with `frame` (the Playwright Frame) and `url`. `sandbox` and `cls` are the
iframe's own attributes as its request started (null: no sandbox; undefined
until read, or never when the frame vanished first, with `unread` saying why),
so each load carries the sandbox it really had. `frameIndex` numbers distinct
Frames: a remount (a new iframe element, as a trust answer or edit mode makes)
is a new index, a link or a reload in place keeps it. A load the frame
abandoned before committing (a remount replaced it) stays a row with
`committed: false` and its `failure`. `pageMs` is the time from the page's
own last navigation request to this load's (null when the watcher started
after it); on a stack it agreed with the page's resource timing to the
millisecond. Start the watcher BEFORE the action, and `await stop()` (or
`settled()`) before asserting on `sandbox`.

```js
const loads = reader.watchFrameLoads(docId);
await reader.open(docId);
await eventually(async () => loads.summary().map((l) => [l.frameIndex, l.sandbox]), { stableSamples: 12, interval: 250 });
await loads.stop();
assert.deepEqual(loads.summary().map((l) => l.sandbox), [null], "exactly one load, unsandboxed (SPEC §6c)");
```

`watchFor(selector, text)` is the oracle for something that must never show,
not even for one render, such as the newer-version banner an unpinned reader
must never get. A poll cannot prove that: it reads the DOM between renders and
misses what was there for one. watchFor puts a MutationObserver on the top
document, which looks again after every change, in the same microtask
checkpoint and so before the next render: whatever was present at a render is
a row. It resolves once installed. From then on, each element that starts to
match `selector` (CSS, top document only: the document frame is not watched)
and, when `text` is given, whose `textContent` contains it (a string) or
matches it (a RegExp), is one row, `{seq, doc, t, goneAt, gone, path, text,
visible}`, until it stops matching. `gone` is null while it still matches,
`"removed"` once it was removed or its text, class or attributes changed, and
`"navigation"` when its document went (`goneAt` is then when the next one
started). It is an init script too, so a reload or a navigation is watched from
the new document's first script: `doc` numbers the documents (1 is the one
current at the call), and `documents()` → `[{doc, t, path, via}]` says how each
was covered (`"call"`: from the call on; `"load"`: from before its first
script). Each row reaches Node through a binding as it happens, so a
document that goes takes none with it, and `sightings()` also reads the
current document's own record, rows not yet arrived included. `t` and `goneAt` are the
page's `Date.now()`, `text` the element's text (trimmed, 500 characters),
`visible` whether it had a box as it appeared. `stop()` freezes the rows, in
this document and in later ones (the init script stays on the page but is told
to stop). An element added and removed before the observer looks, within one
task, was never rendered and is no row. watchFor adds no node and no attribute
to any document. An empty result proves something only next to a watch that
does see it: give a reader who must get the banner the same watch.

```js
const sel = ".viewer-banners .banner";
const [pinned, unpinned] = [await o.watchFor(sel, NEWER_BANNER), await v.watchFor(sel, NEWER_BANNER)];
await updateUpload(owner.http, docId, { body, baseVersion: "v1" });
await v.waitForFrame({ match: new RegExp(`/${docId}/v2/`) });
await o.page.locator(sel, { hasText: NEWER_BANNER }).waitFor();
assert.deepEqual(await unpinned.sightings(), [], "the unpinned reader never saw the banner, not for one render");
assert.equal((await pinned.sightings()).length, 1, "the same watch sees it where it shows");
```

`throttleCpu(rate)` slows the user's page `rate` times, as DevTools' CPU
throttling does (`Emulation.setCPUThrottlingRate` on a CDP session of the
page), and resolves to `restore()`. It is for a render-scheduling race that
an idle machine nearly always wins: two React renders committed inside one
scheduler slice paint nothing between them, and on a slower CPU the slice
can run out between them, so the first one paints. `rate` is a finite number of
at least 1 (1 is full speed); anything else throws a TypeError before anything
is sent (Chrome itself takes 0 or a negative rate as full speed). Measured
with Chrome 154 (`selftest/browser-cpu.test.mjs`, against a reference page
in another Chrome), it slows the page's own renderer: the top document and
every frame in its process, which includes a same-origin frame and so the
document frame, read or edited (its sandbox always keeps
`allow-same-origin`, `app/src/viewer/frameMode.ts`), and it holds through
a reload and a navigation, cross-site ones included. It does not slow a frame
in another process (a cross-site frame, a sandbox without
`allow-same-origin`) or another user. It throttles the page that is
`user.page` at the call. Calls stack: the latest throttle still in force sets
the rate (`throttleCpu(1)` is full speed until its own restore), and each
`restore()` takes only its own away, in any order, resolving to the rate then
in force (1 when no other is). A second call of the same restore is the first's
promise, and once the page has closed a restore resolves 1 and sends nothing.
Restore in a `finally`, so a failed step does not leave the rest of the case
slowed. Do not open a CDP session of your own for this (see **Known harness
facts**).

```js
const restore = await reader.throttleCpu(6);           // DevTools' "6x slowdown"
try {
  await updateUpload(owner.http, docId, { body, baseVersion: "v2" });
  await reader.waitForFrame({ match: new RegExp(`/${docId}/v3/`), timeout: 45_000 });
} finally {
  await restore();
}
assert.deepEqual(await watch.sightings(), [], "not for one render, not even on a slower CPU");
```

`typeAndAutosave(target, text)` types as `typeInFrame` does, presses
Backspace `thenBackspace` times (an edit that changes nothing still makes a
save: type `"x"`, then one Backspace), and resolves once the autosave that
follows the LAST key has been answered and the toolbar says so (SPEC §6a).
Never wait on `saveState()` alone: the editor saves one debounce
(`AUTOSAVE_MS`) after the last input event, and a save already in flight when
a key went in still ends on "saved", without that key, before the next save
has begun (app/src/viewer/useInlineEditor.ts). The last key's time is the
document's own last `input` event, read in the page; keys that fire none (no
editor on the frame) throw at once, "fired no input event in the document",
rather than after the timeout. `inputs` is how many the keys fired (null when
the page could not count them, and then `after` is this process's time).
`waitForAutosave({after})` is the wait alone, for an edit made another way (a
toolbar button, a paste): take `const after = Date.now()` once the action
has resolved, then call it. It waits for the first POST /draft the browser
STARTED at or after `after` (the request's own start, `clock: "browser"`;
`"node"`, which is later, only when the response carried no timing), so a save
that began before the edit is never the one, even when its answer comes later.
An `after` that is not such a time (a `responseMark()` passed by mistake)
throws. `expectStatus` is a status, a list, or `null` for any; another throws
`the autosave after the last edit was answered <status> <body> (wanted …)`,
and a refused save settles on `saveState: "error"`. `entry` is the
`User.responses` entry: `entry.postJson.html` is the HTML that was saved.

```js
await u.enterEdit();
const save = await u.typeAndAutosave('[id="edit-target"] > p', token);
assert.ok(save.entry.postJson.html.includes(token), "the draft holds the edit");
await u.typeAndAutosave("#e2e-1", "x", { thenBackspace: 1 });   // a no-op edit, saved
```

`awaitEdit({waitShared = false, timeout = 45_000})` → `{share, frame}` is
enterEdit's waits WITHOUT its press, for an Edit press made elsewhere: in
the page at a shared instant (`syncPages`, SYNC-T), or a press whose
editable `/draft/` frame a route holds (`holdRequests`, SYNC-H). The Edit
button is a toggle (Edit / Stop editing), so a second press would leave
edit mode again, or wait on a button that is no longer there. It marks the
user `inEdit` at once (settleLive reads it), then waits, each wait up to
`timeout`, for the Formatting toolbar, an editable `/draft/` frame, and the
share state: "shared" with `waitShared`, otherwise anything but "joining".
It never clicks. `enterEdit` is its press plus these waits. A wait that
runs out throws as enterEdit's does; whether that is a failed sync
precondition (INCONCLUSIVE) is the caller's to say.

```js
// every page presses Edit at one instant (an in-page press, serialised by syncPages)
const fire = await syncPages(users.map((u) => u.page), () => document.querySelector('.viewer-toolbar [aria-label="Edit"]').click());
requireConclusive(ctx, { spread: fire });
await Promise.all(users.map((u) => u.awaitEdit({ waitShared: true, timeout: 90_000 })));
```

`recordSaveStates()` is the oracle for debounce and Done timing: it records
in the page every change of the toolbar's save state and every `input` event
of the document frame, each on the PAGE's clock (`performance.timeOrigin +
performance.now()`), so the two are compared on one clock (a request time
taken in this process lags under load). `states` (live) is `{i, s, t, text}`
per change of the data-state (`"idle"`, `"dirty"`, `"saving"`, `"saved"`,
`"error"`, or null while none shows) or of its text: the first row is the
state at arming, and a row is kept only when one of them differs from the
last, so `states.map((r) => r.s)` is the sequence of transitions. `inputs`
(live) is each input event's time. The input listener is the frame
document's own, added from the TOP page in the capture phase: it runs in the
scriptless edit frame, and before the editor's bubbling listener, so an
input's time is never later than the start of the debounce it caused. Every
frame document is listened to as its iframe loads, so arm it before Edit if
you like (the toolbar appearing is a row); an untrusted reading frame is out
of reach and has none. Rows reach Node as they happen, and a navigation ends
the recording without losing them. `read()` → `{armed, armedAt, states,
inputs, docs}` (plain copies, from the page; `armed: false` after a
navigation), `stop()` the same, final. Compare its times with each other,
never with this process's clock. The recorders live in
`window[Symbol.for(SAVE_STATES_KEY)]`: no node, no attribute.

```js
const rec = await u.recordSaveStates();
await u.enterEdit({ waitShared: true });
await u.typeInFrame("#p1", token, { delay: 15 });
await u.poll(() => rec.states.some((r) => r.s === "saved"));
const { states, inputs } = await rec.stop();
const saving = states.find((r) => r.s === "saving");
assert.ok(saving.t - inputs.at(-1) >= 1000, "the save began a whole debounce after the last key");
```

`moreMenu()` reads the viewer's More menu (app/src/components/Menu.tsx) in
one go: `groups` in order, each a heading (`.menu-label`, such as
`"Download"`, `"This document"` or `"Versions"`, or null for items under none)
and its items up to the next separator or heading, `{label, disabled,
reason}` (`reason` is a disabled item's title, or null); `labels` is every
item's label in order. The menu's trigger is a toggle, so every method here
presses it only while the menu is closed, and leaves the menu closed (Escape,
or the trigger when focus is in the frame, where Escape does not reach the
menu). `menuGroup(heading)` is that group's labels: null when the menu has no
such heading, `[]` when it has nothing under it. `chooseMenu(label)` chooses
the item labelled exactly `label` and waits for the menu to close; an item
that is not there throws with what the menu offers, and a disabled one throws
with its reason, unpressed (Playwright's click would wait for it to become
enabled). `download(action)` captures one browser download, a blob the app
saves or an attachment the server sends: `action` is a More-menu label or a
function that starts it. It resolves `{filename, bytes, url}` (the suggested
name, a Buffer, the download's URL) and throws when the download failed, when
none started within `timeout`, and at once when the app showed an error toast
instead (`no download from "…": the app said "Could not fetch the document
(500)."`).

```js
await u.open(md.docId);
assert.deepEqual((await u.menuGroup("Download")).filter((l) => l.startsWith("Download ")),
  ["Download the rendered HTML", "Download the Markdown source", "Download everything as a .zip"]);
const src = await u.download("Download the Markdown source");
assert.equal(sha(src.bytes), sha(mdBytes), `the source as uploaded (${src.filename})`);
```

`waitShown(locator, {what, path, timeout = 30_000, reloads = 1})` waits for
what the page shows (a Playwright locator, or a selector whose first match
is waited for) to be visible. On a loaded shared stack that wait can run out
because the page's Listen channel stalled or a function it called was cut
off. When it runs out and THIS page saw the stack stall in that load
(`stallEvidence`: a response answered Hosting's cut-off 504, or its
Firestore client losing the emulator; read from 10 s before the first wait,
and for a load waitShown made itself from when that load began), `path` is
loaded again (with the same `timeout`) and waited on again, up to `reloads`
times. A page that saw no stall is never loaded again: its wait's failure is
the case's. It resolves `{loads, stall}` (the loads it took, and the evidence
behind the last reload, or null), or throws `E2E_NOT_SHOWN`: `<user>: <what>
not shown within <timeout> ms of load <n> of <path>: the page saw the stack
stall in that load (…)`, or `…: the page saw no stall of the stack in that
load`, with `loads`, `stall` (that load's evidence) and Playwright's timeout
as `cause`. Its `within <timeout> ms` is the LAST load's wait, so with
`inconclusiveOnPageStall` the case is INCONCLUSIVE only when that load (or
pageStall's 10 s margin before it) saw the stall: a page loaded again after a
stall that still does not show on a stack that answered it FAILS.
`selftest/browser-wait-shown.test.mjs` pins this.

```js
const card = o.page.locator(".doc-card", { has: o.page.locator(`a.doc-card-title[href="/d/${docId}"]`) });
await o.waitShown(card, { what: `the workspace's card of ${docId}`, path: "/", timeout: 150_000 });
```

`waitValue(read, want, {what, path, timeout = 30_000, reloads = 1, interval
= 200})` is waitShown for a VALUE read from the page rather than a locator:
a chip's state, a count, a label, often fed by a Listen channel the stack
stalled. `read(page)` (async, given this user's page) is polled every
`interval` ms for up to `timeout` until its value is `want`
(`isDeepStrictEqual`), or passes it when `want` is a function `(value) =>
boolean`. A read that throws, or has not answered when the wait's time runs
out (each read gets at least 1 s), counts as "not yet". When the wait runs
out and THIS page saw the stack stall in its CURRENT load, `path` is loaded
again (with the same `timeout`) and the value waited for again, up to
`reloads` times. Unlike waitShown, the evidence is read from when the page's
current document began loading (its `performance.timeOrigin`) or 10 s before
the first wait, whichever is earlier: the SDK says it lost the emulator once,
and a listener lost minutes ago delivers nothing now (for a load waitValue
made itself, from when that load began). A page that saw no stall is never
loaded again. It resolves `{loads, stall, value}` (the value read), or
throws `E2E_NOT_SHOWN`: `<user>: <what> not shown within <timeout> ms of
load <n> of <path> (want <want>, last read <value>): the page saw the stack
stall in that load (…)`, or `…: the page saw no stall of the stack in that
load` (`nothing read (<the read's error>)` when no read gave a value), with
`loads`, `stall`, `value` (the last value read, undefined when none was),
`want`, and the last read's error as `cause`. As with waitShown, its `within
<timeout> ms` is the LAST load's wait, so `pageStall` judges that load
alone. `what` defaults to "the value"; `path` null makes no reload; a closed
page throws at once. `selftest/browser-wait-value.test.mjs` pins this.

```js
const chipText = (page) => page.evaluate(() => document.querySelector(".viewer-toolbar .expiry-chip")?.textContent ?? null);
await o.waitValue(chipText, "Expired", { what: "the expiry chip past the date", path: `/d/${docId}`, timeout: 45_000 });
```

`open(docId, {v, k, timeout = 45_000, reloads = 0, sessionCheck = false})`
does the same for a document. Without `reloads` and `sessionCheck` it is as
it always was: one load, then `waitForFrame`, resolving `{src, sandbox,
editable}`. With either:

- `reloads`: when the wait for the viewer and its frame runs out and THIS
  load saw the stack stall (`stallEvidence` from when the load began), the
  page is loaded again, up to `reloads` times. Otherwise it throws
  `E2E_NOT_SHOWN`, `<user>: open: the viewer and its document frame not
  shown within <timeout> ms of load <n> of /d/<docId>[/<v>]: the page saw
  the stack stall in that load (…)` or `…: the page saw no stall of the
  stack in that load`, with `loads`, `stall` and the frame wait's error as
  `cause`. As with waitShown, pageStall judges the last load's wait alone.
- `sessionCheck`, for a signed-in user: every load of a signed-in page posts
  the persisted user's ID token to /session (app/src/auth.tsx), and Hosting's
  504 there leaves the app signed out over a cookie that is still valid
  ("Sign in to comment" over the frame that cookie served). Once the frame
  shows, open waits for the load's own POST /session (the first the page
  sends after the load began, matched by its request) to be sent, within
  `timeout`, and answered, within `timeout` or 75 s of being sent, whichever
  is longer, so the 60 s cut-off always arrives. Hosting's cut-off loads the
  page again while `reloads` allow, and otherwise throws `E2E_STACK_CUTOFF`
  (`stackCutoff`: `<user>'s POST /session on load <n> of /d/<docId> answered
  504 after <ms> ms, Hosting's cut-off …`, `response` the entry, `loads`),
  which `inconclusiveOnStackTimeout` ends INCONCLUSIVE. Any other answer, a
  quick 504 or a refusal included, stands: what the page shows then is the
  case's to judge. A load that sends no POST /session (a signed-out reader)
  throws `<user>: open: load <n> of /d/<docId> sent no POST /session within
  <timeout> ms of its frame showing; …`, so leave `sessionCheck` off for
  one.

It then resolves `{src, sandbox, editable, loads, stall, session}`: `loads`
the loads it took, `stall` the evidence behind the last reload (a session
cut-off reads `<user>: POST /session 504 after <ms> ms`), or null, and
`session` the last load's POST /session as plain data, `{seq, method, path,
status, ms}`, or null without `sessionCheck`. A bad `reloads`,
`sessionCheck` or (with either) `timeout` throws before anything loads.
Messages never name `?k=`: it is a link key.
`selftest/browser-open-loaded.test.mjs` pins this.

```js
await u.signInUi(acct.email, acct.password);
const { loads, session } = await u.open(docId, { v: "v1", timeout: 90_000, reloads: 1, sessionCheck: true });
```

`comment(text)` comments on the current selection: the selection toolbar's
Comment, then the reply box of the thread THAT press made, then Enter, and it
resolves `{quote}` once the text shows in that thread. Not "the selected
thread": the app selects the new thread only once Firestore has acknowledged
the annotation (DocViewer.tsx `startComment`), and until then the thread
selected before the press still is, so a second comment on one page used to
go into the first thread. comment() remembers every thread element on the
page before the press (a WeakSet in the window: no node, no attribute) and
waits for a selected thread that is not one of them. An error toast instead
(the annotation refused) throws at once, `the Comment press made no thread:
the app said "…"`. `timeout` bounds each of its two waits, as before (the
new thread, then the comment in it): give it the stack's write latency on a
loaded stack.

```js
await u.selectText("#p-box", "passage in the box");
await u.comment(`Box comment ${t}`, { timeout: 45_000 });
await u.selectText("#fig-label", "Label in a figure");        // the first thread is still selected
await u.comment(`Figure comment ${t}`, { timeout: 45_000 });  // lands in the new one
```

A loaded Firestore emulator can fail a rule's `get()`, and the rules then
refuse the write with "Service call error. Function: [get], …" in the app's
error toast (`RULES_SERVICE_ERROR_RE`): the emulator failing, not the rules'
verdict (seen in a05, a17 and a24). `comment(text, {retryServiceError: n,
reselect})` presses again after such a refusal, up to `n` more times,
`reselect()` first (a refused press may leave no selection) and 3 s apart,
and resolves `{quote, serviceErrors}`. Any other toast throws at once, as
before. When every press was refused so, the last refusal throws with
`serviceErrors` and a `stackCut` (`<user>: the emulator failed a rule's get()
("Service call error") on N Comment press(es) in a row, …`), so a case with
`inconclusiveOnStackTimeout` ends INCONCLUSIVE. Without the option nothing
changes. `selftest/browser-comment-retry.test.mjs` pins this.

```js
await u.selectText("#p-1", quote);
await u.comment(`Print probe comment ${t}`, { timeout: 45_000, retryServiceError: 3, reselect: () => u.selectText("#p-1", quote) });
```

Any other press whose rules-guarded client write the emulator can refuse so
(a dialog's "Run it for me", which writes the reader's trust grant) is
`pressRetryingServiceError(selectorOrLocator, {retries = 3, backoffMs =
3_000, done, timeout = 30_000, what = null})`. It presses the control (a
selector, its first match, or a Playwright Locator) and waits up to
`timeout` for `done()` (async () => truthy once the press took effect: the
dialog closed; a throw is "not yet") or an error toast, the write refused.
A "Service call error" refusal is pressed again after `backoffMs`, up to
`retries` more times, and before each press again every toast with a Dismiss
is dismissed (`dismissToasts`): error toasts never go by themselves, and in
the app three of them stacked cover a dialog's footer, so without that the
fourth press timed out as a FAIL (a05's A5.2 met the refusal on a shared
stack; a scratch copy that refused every press showed the fourth time out).
It resolves `{serviceErrors}`. Any other error toast throws at once,
`<user>: the press of "<what>" was refused: the app said "…"`, the toast as
`toast`. When every press was refused so, the last refusal throws with
`serviceErrors` and a `stackCut` (`<user>: the emulator failed a rule's
get() ("Service call error") on N press(es) of "<what>" in a row, so the
rules never judged the write`): a case with `inconclusiveOnStackTimeout` ends
INCONCLUSIVE. No outcome within `timeout` throws `<user>: the press of
"<what>" took no effect within <timeout> ms, and no error toast came` (`(the
last check: …)` and `cause` when `done` threw), a wait `pageStall` reads.
`timeout` also bounds the click. `what` names the control (default: the
selector, or the locator as Playwright prints it). A bad argument throws
`TypeError` before anything is pressed. `selftest/browser-press-service-retry.test.mjs`
pins this.

```js
const dlg = u.page.getByRole("dialog", { name: "This document wants to run its own code" });
await u.pressRetryingServiceError(dlg.getByRole("button", { name: "Run it for me", exact: true }), {
  what: "Run it for me",
  done: async () => (await dlg.count()) === 0,   // TrustDialog closes only when its write succeeded
});
```

`reply(quote, text)`, `resolve(quote)` and `reopen(quote)` act on the thread
`thread(quote)` finds (null: the selected one) through the panel, as a
person does: `openComments`, then the thread's reply box (the text, Enter) or
its Resolve or Reopen (after "Show resolved", when the panel offers it), then
the outcome on the page (the reply in that thread; the thread gone from the
list or marked resolved; marked unresolved). `timeout` (30 s) bounds EACH of
the three waits, each its own: the panel, the control (Playwright's click,
which waits for the thread to be listed: another user's thread reaches this
page only with its snapshot, which a loaded stack has delayed past 30 s), and
the outcome. Before, only the outcome took `timeout`, while the panel kept
10 s and the press Playwright's 30 s; the default is 30 s so that no wait is
shorter than it was. A control that never showed throws `<user>: reply: the
thread quoting "…" showed no Reply box to press within <timeout> ms (<n> such
thread(s) in the panel)` (`Resolve button`, `Reopen button`), Playwright's
error as its cause: 0 threads is a thread this page never received. A reply
that never showed throws `<user>: reply: "<text>" did not show in the thread
quoting "…" within <timeout> ms`. Each is a wait `pageStall` reads. An empty
`text`, or a `timeout` that is not a positive number, throws before anything
is pressed (an empty text used to pass without replying, since it is found in
every comment). `selftest/browser-thread-actions.test.mjs` pins this.

```js
await owner.reply(quote, `Owner reply ${t}`, { timeout: 90_000 });   // the viewer's thread may reach the owner's page late
await viewer.resolve(quote, { timeout: 90_000 });
await owner.reopen(quote, { timeout: 90_000 });
```

`capturePrint(action)` captures what the app hands to print() ("Print or
save as PDF", Cmd/Ctrl+P: app/src/export/pdf.ts `printDoc`). It arms a
MutationObserver in the app's window, runs `action` (a More-menu label,
chosen with `chooseMenu`, or a function that starts the print), and replaces
the print() of every iframe added from then on (except the reading frame,
`iframe.doc-frame`) with a recorder, at once and again at each of the
frame's `load`s. It resolves once at least `frames` iframes were added and
every one has had print() called; nothing is printed and no dialog opens.
One row per iframe added while armed: `sandbox`, `className`, `src` its
attributes as it was added, `printed` the calls, `hooks` how often the
recorder was installed, `hookError` why it could not be (a frame the page
cannot reach: a sandbox without `allow-same-origin`). Each call's snapshot
(the first `PRINT_MAX_SNAPS`, 10) is the frame's document AT the call:
`html` (its doctype and `outerHTML`), `title`, `url`, `t` (the page's
`Date.now()`). `extract(document, arg)` runs in the page at the call and its
result is `extra`: it is sent as SOURCE, so it may use nothing from the
spec's scope but `arg` (JSON); a throw is `extractError`. It throws at once
on an error toast (`no print from "…": the app said "…"`), on a navigation,
and at `timeout` with what was recorded as `err.record`; it disarms either
way. A print() called in the same task as the frame's insertion is before
the observer runs and is missed (printDoc waits 250 ms). The recorder lives
in `window[Symbol.for(PRINT_KEY)]`. `match`, a CSS selector, narrows what a
print frame is: an iframe added that does not match it is never hooked and
is no row, only listed in the record's `ignored` (`[{t, sandbox, className,
src}]`), and nothing waits for it. The owner's viewer captures its own
thumbnail in an iframe sandboxed `allow-same-origin` alone
(app/src/viewer/capture.ts), which a loaded page can add in the middle of a
print; without `match` that frame is a row that never prints, and the
capture times out (`2 frame(s) added (1 wanted)`). Pass `match:
'[sandbox~="allow-modals"]'` for the app's print frame. A selector the page
cannot parse throws before the action runs.
`selftest/browser-print-match.test.mjs` pins this.

```js
const LOCKED = ["display", "visibility", "opacity" /* … */];
// The toolbar's Print; a string is a More-menu label instead, which is where
// a 400 px phone keeps "Print or save as PDF".
const print = () => u.page.locator(".viewer-toolbar").getByRole("button", { name: "Print", exact: true }).click();
const rec = await u.capturePrint(print, {
  extract: (doc, locked) => Array.from(doc.querySelectorAll('[class*="bshd-print"]')).map((el) => ({
    className: el.className, text: el.textContent,
    important: locked.filter((p) => el.style.getPropertyPriority(p) === "important"),
  })),
  arg: LOCKED,
});
assert.equal(rec.frames.length, 1);
const [{ sandbox, printed, snaps: [snap] }] = rec.frames;
assert.deepEqual([sandbox, printed], ["allow-same-origin allow-modals", 1]);
const keyed = await u.capturePrint(() => u.page.keyboard.press("ControlOrMeta+p"));  // the shortcut
```

`pool.printRenderer()` renders HTML the spec holds (a print snapshot, an
exported SVG) in a scratch context of the pool's Chrome: every request
aborted (each render's URLs in `blocked`), `deviceScaleFactor` device pixels
per CSS pixel, `media` emulated (`"print"`, `"screen"` or null), a `width` ×
`height` viewport (A4 in CSS pixels, `PRINT_PAGE`, by default). It returns
`{page, context, width, height, media, render(html, o), close()}`; the pool
closes it too. `render(html, {width, height, computed, probe,
stripAuthorStyles, screenshot, without, regions, settle = true, timeout =
30_000})` sets the viewport, loads the HTML to `load`, then in this order:
`stripAuthorStyles` removes every `<style>` and stylesheet `<link>` (what the
elements compute to with no author CSS; inline style attributes stay); the
page SETTLES (`document.fonts.ready`, then two animation frames), so the
boxes, styles and probe read next are those of the page as painted, not of a
frame before it (`settle: false` skips it; `settled` in the result says
which; a page that does not settle within `timeout` throws; a screenshot
needs no settling of its own: Playwright's waits for the fonts and Chrome
draws a fresh frame for it); `computed: {selector,
properties}` reads each match as `{tag, id, className, text, rect: [x, y, w,
h], computed: {property: value}}` into `elements`; `probe: async (page) =>
value` is your own reading, `probed`; the viewport is shot as `png` (with
`screenshot: true`, `without` or `regions`); `without` (a selector) removes
its matches (`removed` counts them) and shoots again, `basePng`; `regions:
{name: {x, y, w, h, color = null, tol = 70, minDiff = 30}}` gives
`pixels[name]` = lib/png.mjs `colourPixels` over `png` in that box, counting
only what differs from `basePng` when `without` was given. Everything not
asked for is null. A thing is judged VISIBLE by the pixels it paints, never
by its computed style alone: an oracle that the stamp shows needs its own
hidden control (the same render with the stamp `display: none` paints 0),
and an author's block of the same colour in the same corner is not the
stamp's (it is in both renders, so the baseline leaves it out). `blocked`
may hold a link key: write it only through `ctx.ev`.

```js
const r = await ctx.users.printRenderer();
try {
  const out = await r.render(snap.html, {
    computed: { selector: ".bshd-print-mark, .bshd-print-footer", properties: LOCKED },
    probe: (page) => page.evaluate(() => getComputedStyle(document.getElementById("canary")).display),
    without: ".bshd-print-mark, .bshd-print-footer",
    regions: { label: { x: 794 - 420, y: 0, w: 420, h: 80, color: [0xb0, 0x23, 0x18] } },
  });
  const p = out.pixels.label;                     // {count, box, fill, area}
  assert.ok(p.count >= 20 && p.fill <= 0.6, "glyphs, not a box");
  const ref = await r.render(snap.html, { stripAuthorStyles: true, computed: { selector: ".bshd-print-mark", properties: LOCKED } });
} finally {
  await r.close();
}
```

`lib/png.mjs` decodes PNGs in Node, with no dependency: `pngPixels(bytes)` →
`{width, height, bitDepth, colorType, data}` (`data` a Uint8Array of RGBA,
row by row, not premultiplied; every colour type and bit depth, the five row
filters, PLTE and tRNS, every chunk's CRC checked; a 16-bit sample becomes
its high byte; Adam7 interlacing and anything malformed throw `E2E_PNG`),
`pngSize(bytes)` → `{width, height}` from the IHDR alone, `pixelAt(img, x,
y)` → `[r, g, b, a]`, and `colourPixels(img, {color = null, tol = 70, region
= null, baseline = null, minDiff = 30})` → `{count, box, fill, area}`: the
pixels in `region` (`{x, y, w, h}`, clipped to the image; null for all of it)
that are not fully transparent, within `tol` of `color` (Euclidean in RGB;
null for any colour) and, with a `baseline` image of the same size, differ
from it by more than `minDiff` (the sum of the three channel differences);
`box` `[x, y, w, h]` around them (null when none), `fill` their share of it
(glyphs fill little of their box, a solid block all of it), `area` the
clipped region's size. `img` and `baseline` are decoded images or PNG bytes.
A downloaded PNG export is judged the same way: `colourPixels(file.bytes,
{color, region: {x: w / 2, y: 0, w: w / 2, h: Math.floor(h * 0.3)}})` (whole
pixels: round a fraction yourself).

`lib/frame.mjs` works inside the document frame: `docFrame(page)`,
`frameGeometry(page)` (rect and scale), `framePointToPage(geom, p)`,
`insideFrame(geom, p)`, `frameSnapshot`, `frameText(frame, {withoutOwn,
selector})`, `bodyHash(frame)` (`{hash, length}` of `body.innerHTML`),
`bodyAttributes`, `idSelector(id)` (ids that start with a digit),
`rangeRects`, `setSelection`, `setSelectionBetween(frame, from, to)` (the
Range selectBetween falls back to, with no mouse; returns its text),
`selectionBetween(frame, from, to)` → `{ok, text, want, startIn, endIn}` (is the
current selection that Range?), `selectionText`, `placeCaret`,
`elementPoint`, `focusState`. `frameText(frame)` is the body's `textContent`;
`{withoutOwn: true}` leaves out the text of the app's own nodes in the
document, found by their `data-bshd` VALUE in the pinned `KNOWN_OWN_VALUES`
(`lib/bytes.mjs`): the peer overlay, whose labels name the other readers and so
differ from reader to reader, and the injected stylesheets. A node whose
`data-bshd` is any other value is the author's and is kept, as is text inside
highlight wrappers. A list of values instead of `true` names them yourself;
`selector` reads one element instead of the body (and throws when it matches
nothing). Compare readers' texts with `withoutOwn: true`, never raw.

`inFrameDoc(page, fn, arg = null, {frame = DOC_FRAME})` → `fn`'s value runs
your own `fn(doc, arg)` with the frame's CURRENT Document as `doc`, from the
TOP page's realm, as the app's editor reaches it, rather than inside the
frame (`frame.evaluate`): so nothing depends on the frame being allowed to run
script (a listener or observer it adds to the scriptless edit frame is called;
one added from inside that frame is not, and a timer there never fires), and
the language built-ins it uses (`Array`, `JSON`) are the app's, never ones a
trusted document's script replaced (DOM methods are still the frame's own).
`bytes.mjs` `parseAndRun(parser, html, fn, arg = null)` runs the SAME function
on stored bytes parsed by Chrome's DOMParser in the parser page (`parser` is
`pool.parser()`, an `openParser()` result, or the pool itself), so one
structural probe is asked of the editor's DOM and of the version that was
saved. `fn` is sent as source (`probeSource(fn, what)` → the expression;
`probeArg(arg, what)` → the JSON), so it may use nothing from the spec's
scope but `arg` (JSON); it may be async and must return plain data. A parsed
document ran no script and has no window, layout or computed style: a probe
for both reads elements, attributes and text only. Each throws
`inFrameDoc: …` / `parseAndRun: …` when the frame is missing or out of reach
(a sandbox without `allow-same-origin`: wait for the frame first), the probe
throws, or it returns a DOM node.

```js
const formatting = (doc, ids) => ids.map((id) => ({ id, b: doc.querySelectorAll(`#${id} b`).length, font: doc.querySelectorAll(`#${id} font`).length }));
const live = await inFrameDoc(u, formatting, ["p1", "p2"]);                    // the edit frame
const saved = await parseAndRun(ctx.users, draftHtml, formatting, ["p1", "p2"]); // the bytes
assert.deepEqual(saved, live, "the draft holds what the editor shows");
```

`armArrival(page, id, text, {frame = DOC_FRAME})` → `{armedAt, already}`,
`arrival(page, text, {frame})` → `{armed, id, at, armedAt, already,
reloaded}` and `waitForArrival(page, text, {timeout = 15_000, interval = 50,
frame})` → the same, once `at` is set, time the moment a text first appears
in the frame's element `#id`, on the page's own clock. `at` is the page's
`Date.now()` in the microtask after the change that made `#id`'s
`textContent` include `text`, never when a poll looked: a MutationObserver
installed from the top page (one installed by evaluating inside the
script-free edit frame is never called). Arm BEFORE the action; `page` may be
a User. Pages on one machine share the clock, so the receiver's `at` minus
the sender's is a propagation time, and this process's `Date.now()` compares
too. `already: true`: the text was there when armed (`at` is `armedAt`, no
measurement). One probe per text per page (arming the same text again
replaces it); a navigation of the page drops them (`armed: false`), and a
replaced frame document (a remount, a reload) is `reloaded: true`, after
which an `at` still null is never set. `waitForArrival` throws `E2E_ARRIVAL`
with `reason` `"unarmed"`, `"reloaded"` or `"timeout"`, so "did it arrive
within 2 s" is a timeout, never a frame that was swapped meanwhile. The
frame's document must be reachable from the page (same origin, or a sandbox
with `allow-same-origin`, as the edit frame has). The probes live in
`window[Symbol.for(ARRIVAL_KEY)]` of the top page: no node, no attribute.

```js
await Promise.all([armArrival(a, "e2e-3", tok), armArrival(b, "e2e-3", tok)]);
await a.typeInFrame("#e2e-3", tok);
const [typed, got] = await Promise.all([waitForArrival(a, tok), waitForArrival(b, tok)]);
assert.ok(got.at - typed.at < 1000, `propagation ${got.at - typed.at} ms`);

await armArrival(p, "e2e-10", probe);                    // "received within 2 s, or not"
await o.typeInFrame("#e2e-10", probe);
const seen = await waitForArrival(p, probe, { timeout: 2_000 }).catch((e) => (e.reason === "timeout" ? null : Promise.reject(e)));
```

**Anywhere in the body.** `armArrival(page, null, text)` arms the same probe
with no element: it arrives when the frame's BODY's `textContent` first
includes `text`, timed the same way (the observer in the top page, the
page's `Date.now()`). Use it when the text may land in an element
`getElementById` does not return: a doubled body (S1, S27) holds every id
twice, and a keystroke a peer typed into ITS first `#e2e-2` can be in your
second copy, on your screen but never "in #e2e-2" (C4's joiner-to-members
leg read a false "never arrived" that way). The body is read afresh at each
check (a body replaced whole is watched), all of its text as one string, so
an element boundary does not separate (a token whose halves end one
paragraph and start the next has arrived); it costs one read of the body's
text per batch of mutations. `arrival()` gives `id: null` for it (the same
keys as an id's probe; `armed` tells it from no probe), and
`waitForArrival`'s messages say `anywhere in the frame's body` where an id's
say `in #<id>`. An `id` that is neither a non-empty string nor null is
refused, `undefined` included (until 2026-10-13 it armed a probe on an
element with the id "undefined", which never arrived).
`probeArrivals(users, {…, anywhere: true})` arms every peer this way (see
Probes, under Concurrency specs).

```js
await armArrival(peer, null, tok);                              // anywhere in peer's body
await typist.typeInFrame('[id="dup"] ~ [id="dup"]', tok);       // the SECOND copy of #dup
const got = await waitForArrival(peer, tok);                    // got.id === null
```

`lib/tokens.mjs` makes typed,
checksummed tokens for concurrent typing and analyses where each landed
(`makeToken`, `parseToken`, `isToken`, `scanTokens`, `collectSegments`,
`analyseTokens`; see its header). **The I2 split check and the I4 check need
`analyseTokens({segments: await frame.evaluate(collectSegments, {ids}), typed})`
over the whole body.** Every other input is flat or partial, and the result
says so. `{targets}` and `{text}` report `splitDetection: false`, because
`textContent` joins the two halves of a paragraph that Enter split, so a token
cut across them reads `ok`. `{text}` is refused unless you pass `flat: true`.
With `{targets}` or `{text, id}`, a token from a deleted passage that is not
found is `inconclusive`, which fails `ok`, never `gone`: it may have survived in
an element you did not give.

### The oracles

| oracle | what it proves | how |
|---|---|---|
| DECOR | no app decoration (`data-bshd` by value, `data-bshd-*`, `bshd-` ids and classes, `--bshd-` variables, highlight marks, editor attributes on descendants) reached the stored bytes, and nothing of the author's was lost | `fingerprint(page, html)` with `pool.parser()`, then `diffFingerprint(v1, vN, allowedTextChange)` → `{ok, decoration, lost, structure, bodyAttr, text}`; `decorations(fp, baseline)`. Always diff against **v1**: without a baseline only the pinned `KNOWN_OWN_VALUES` count |
| BODYATTR | `<html>` and `<body>` attributes equal v1's (DECOR ignores root attributes; `innerHTML` cannot see them) | `bodyAttrDiff(v1, vN)` → `{equal, body, html}` |
| REHASH | the stored bytes hash to the version's `contentHash` with the tree's own `scripts/lib/hash.mjs` (SPEC §9.1) | `rehashZip(zip, {target})`, or `rehashVersion({target \| http, docId, versionId, k})`; `downloadVersion({http \| target, docId, versionId, k})` goes through http.mjs |
| I1 | live peers converge: identical frame bodies | `bodyHash(frame)` equal across peers on consecutive samples (`eventually(fn, {stableSamples: 3})`) |

Use DECOR and BODYATTR on every saved version a case produces, REHASH on every
version whose bytes matter, I1 for any live-editing case before asserting
anything else about the text.

### Protocol clients

| module | what |
|---|---|
| `lib/http.mjs` | `createHttp(target, {actor, guard, evidence, jar, headers, allowPorts, timeoutMs, cutoffError})` → `request(method, path, {query, headers, body, json, form, redirect, maxRedirects, timeoutMs, expect, noCookies})`, `get`, `head`, `post`, `put`, `delete`, `postJson`, `with({actor, headers, timeoutMs, cutoffError})`, `timeoutMs`, `cutoffError`. With `cutoffError: true` (false by default; anything but a boolean throws `TypeError` when the client is made), Hosting's cut-off 504 throws `E2E_STACK_CUTOFF` instead of being returned (When the stack does not answer). A request waits its own `timeoutMs`, else the client's (kept by `with()`), else `DEFAULT_REQUEST_TIMEOUT_MS` (60 s): give a slow shared stack's longer bound once, on the client (`openSession(target, acct, {timeoutMs: 180_000})`), and every helper that sends through it (`publish`, `share`, `createFolder` …) waits that long; a `timeoutMs` that is not a positive number throws when the client is made. Every response is fully read: `{status, ok, headers, setCookies, buffer, text, json, url, ms, redirects}`. `pendingRequests(sink)` → `[{t, actor, method, url}]` lists the hops a sink is still waiting on (`ctx.requests({pending: true})` reads it: When the stack does not answer). Only the stack's loopback ports are reachable (`E2E_ISOLATION` otherwise); redirects are followed only with `redirect: "follow"`, one hop at a time, each hop checked and traced. Use it for every request — never raw `fetch` |
| `lib/session.mjs` | `openSession(target, account, {timeoutMs, cutoffError, http, evidence, expectStatus})` → `{account, http (jar holds __session), idToken, uid}`, `browserSession(user, {account, http, evidence, timeoutMs, cutoffError})` → `{account, http (jar holds the browser user's own __session), uid, idToken: null, refreshToken: null, via: "browser"}` (no POST /session: Users and the browser), `openSessions(target, accounts, {batch, timeoutMs, cutoffError, …})`, `closeSession`, `idToken`, `signInWithPassword(target, account, {timeoutMs, cutoffError, http, evidence})`, `mintToken(session, {name, channel})` → `{tokenId, token}`, `listTokens`, `revokeToken`, `bearerHttp(target, token, {timeoutMs, cutoffError, …})`. `timeoutMs` and `cutoffError` are the session client's for every later request (the sign-in included: POST /session cut off throws `E2E_STACK_CUTOFF`, not `E2E_SESSION`); with `http` given, that client's own apply |
| `lib/accounts.mjs` | `cast(target, roles, {notifications, analytics, retryTaken = 3})` → `[{role, email, password, uid}]` (`<role>-<run6>-<rand4>@example.com`, verified; `notifications: false` / `analytics: false` write the opt-out record before any session, see production safety; an address the Auth emulator says is already signed up, `EMAIL_EXISTS`, is replaced by another fresh one up to `retryTaken` times (0 to 20; anything else throws before any request), since a long-lived shared stack holds thousands of accounts per role under one run tag and a fresh four-character suffix is now and then taken: a refused signUp makes and ledgers nothing, any other refusal and the last one are thrown as they are; `selftest/cast-taken.test.mjs`), `castOne(target, role, o)`, `castUnverified(target, role, {email, retryTaken = 3})` → `{role, email, password, uid, verified: false}` (local only: an unverified account made with accounts:signUp, as the web SDK signs up, and ledgered `verified: false`; `email` is the address to sign up, sent as given, for a case that shares with it before the account exists, otherwise `localEmail(target, role)`, replaced when taken as cast's is; a malformed one throws before any request, and a chosen one that is taken is never replaced: it throws the emulator's `EMAIL_EXISTS`), `optOutRecord(acct, o)` → the record cast writes, or null, `runTag`, `rand4` (four characters of [a-z0-9], each of the 36 equally likely: a byte of 252 or more is drawn again, so `% 36` favours none; `selftest/rand4-uniform.test.mjs`), `localEmail` |
| `lib/firestore-client.mjs` | `clientFirestore(target, {idToken, session, http, actor, evidence, database})` → `create(path, data, {serverTime = ["createdAt"]})`, `update(path, fields, {serverTime = []})`, `set(path, data, {serverTime = [], merge = false})`, `remove(path)`, `get(path)` (+ `doc`), `list(collection, {pageSize, pageToken})` (+ `docs`, `nextPageToken`), `runQuery(structuredQuery, {parent})` (+ `docs`), `commit(writes)`; each → `{status, code, message, verdict: "ALLOW"\|"DENY"\|null, ok, denied, json, response}`. The Firestore REST API as the app's SDK reaches it, evaluated by the rules: `Bearer <ID token>`, or no Authorization at all for `idToken: null`; `idToken` may be a function. `session` (an `openSession` result) is the caller: its ID token, read at each request, and its `http`; an `idToken` or `http` given beside it wins (`clientFirestore(target, {session: viewer})`). The emulator's admin `"owner"` is refused and no cookie is sent. `create` sets `currentDocument: {exists: false}` and each `serverTime` field to REQUEST_TIME (serverTimestamp()); `update` sends an updateMask of exactly the given top-level fields on an existing document; `set` is setDoc, the app's own write for personal trust, annotations and comments: the whole document with no precondition and no mask, so the rules judge it as a create or an update by what is stored (a re-grant of personal trust is an update, which `create` cannot send). `merge: true` is setDoc's `{merge: true}` (the account record): a mask of every leaf path of `data`, `mergeMask(data)` (a nested map recursed into, an array or an empty map a leaf), with the `serverTime` fields as transforms outside it. Personal trust as the app grants it: `set("docs/<docId>/trust/<uid>", {uid, email: <lower-cased>}, {serverTime: ["trustedAt"]})` with `{session}` that account's. `verdict` is `"DENY"` only for 403 PERMISSION_DENIED and `"ALLOW"` only for 200: NOT_FOUND or a malformed write is `null`. A delete of a missing document is PERMISSION_DENIED (the rules see no resource), so pair every refusal with a positive control. `runQuery` sends a query as the SDK does (`POST …/documents[/<parent>]:runQuery {structuredQuery}`), so a list rule judges its constraints: the app's workspace query is `{from: [{collectionId: "docs"}], where: {fieldFilter: {field: {fieldPath: "members"}, op: "ARRAY_CONTAINS", value: toValue(email)}}, orderBy: [{field: {fieldPath: "createdAt"}, direction: "DESCENDING"}]}`; an error inside a 200 stream is `ok: false` with no verdict. Paths are relative (`docs/<id>/versions/v1/annotations/<a>`); `doc.data` decodes timestamps to `Date`. Also `toValue`, `toFields`, `fromValue`, `fromFields`, `fieldPath`, `mergeMask(data)` → `[fieldPath]`, `firestoreResult(response)`, `firestoreOrigin(target)` (the stack's emulator; on production `FIRESTORE_PUBLIC_ORIGIN` when the Target names no `firestoreUrl`) |
| `lib/web.mjs` | the app's own comment writes without a browser: `webThread(fs, acct, {docId, versionId, anchor, body})`, `webReply`, `webResolve`, exactly as `app/src/firestore.ts` makes them, through a `clientFirestore` (see **Commenting as the app does** below) |
| `lib/rtdb.mjs` | `rtdbAs(target, {idToken, http, actor, evidence})` → `get(path, {query})`, `put(path, value, {query})`, `patch(path, value, {query})`, `post(path, value, {query})`, `delete(path, {query})`, `request(method, path, {value, query})`, `url(path, query)`; each → `{status, ok, denied, verdict: "ALLOW"\|"DENY"\|null, error, json, response}`. The Realtime Database REST API (`<db>/<path>.json?ns=<projectId>`) as a signed-in client, evaluated by `database.rules.json`: the ID token goes ONLY in `?auth=`, and the request carries no Authorization header (one the http client has by default is stripped) and no cookie; `idToken: null` is anonymous (no `auth` at all), and may be a function; `"owner"` and a `query.auth` are refused. A token the emulator would read as nobody is refused too, before anything is sent (`E2E_RTDB_TOKEN`; see `rtdbTokenProblem` below and **Known harness facts**). `verdict` is `"ALLOW"` only for 200 and `"DENY"` only for 401 `{"error": "Permission denied"}` (what `.read`, `.write` and `.validate` all answer); a 400, a 404, or a 401 with any other error (production's answer to a token it cannot use) is `null`. `json` is the value (null when absent). `rtdbAdmin(target, {http, actor, evidence})` → `get(path, {query})` (same result), `rules({namespace})` → `{status, ok, text, buffer, response}`: `Bearer owner` and nothing else, past the rules; local only (needs `admin-emulator`, else `E2E_CAPABILITY`; on production read with `rtdbGet`). `rtdbRulesStatus(target, {namespace, http, evidence})` → `{ok, checked, namespace, file, bytes, sha256, equal, rulesStatus, anonymousStatus, reason}`: live, on any local stack, whether the namespace's loaded rules equal the file the stack's `firebase.json` binds and an anonymous root read is a rules DENY; gate an RTDB DENY on it (`precondition(s.ok, s.reason)`) or declare `needs: ["rtdb-rules"]`. `rtdbTokenProblem(token)` → `string|null`: why the RTDB emulator would evaluate `token` as no token at all (not three dot-separated segments; a header or payload that is not a base64url JSON object; no `sub`; no numeric `iat`), or `null` when it reads it as the user it names; every Firebase ID token is `null`, a legacy database secret is not, and the reason never contains the token. Also `rtdbUrl(target, path, query)` (segments percent-encoded, `.`/`..` refused, `""` is the root, query values sent as given: quote `orderBy` yourself), `rtdbNamespace(target)`, `rtdbResult(response)`, `RTDB_ADMIN_BEARER`, `RTDB_DENIED`. Paths are relative (`status/<docId>/y/<entry>`) |
| `lib/mcp.mjs` | `mcpClient(target, {token, http, actor, timeoutMs, cutoffError})` (`timeoutMs` and `cutoffError` those of the client it makes, as `createHttp` takes them: with `cutoffError: true` Hosting's cut-off on POST /mcp throws `E2E_STACK_CUTOFF` from every call, `raw()` and `notify()` included, instead of a 504 returned or `E2E_MCP_HTTP`; with `http`, that client's own apply; `selftest/mcp-cutoff.test.mjs`) → `initialize()`, `listTools()`, `call(name, args)` → `{isError, text, json, result}`, `ok(name, args)`, `rpc`, `notify`, `batch`, `raw`, `state`, `serverVersion` |
| `lib/oauth.mjs` | `discover(http)`, `register(http, {redirectUris})`, `pkce()`, `authorizeParams`, `authorizeUrl`, `approveViaApi(http, idToken, params, {action})`, `exchangeCode`, `refresh`, `startReceiver({target, page, via})` → `{via, redirectUri, port, claim, wait(ms), received(ms), heard(), requests, close()}` (where the redirect lands: a loopback server on a claimed spare port, or a route inside the browser; its timeout `E2E_OAUTH_TIMEOUT` carries `consent`, what the consent page's own POST /oauth/consent answered, and that answer as `response` when it was 4xx or 5xx; below), `consent(page, {approve})` → `{clicked, armedAfterMs, moves, arming}` (drives the consent page's arming delay), `armingProbe(page, {path, label})`, `readArming(page)` (measures it; below), `ARM_DELAY_MS`, `ARMING_KEY`, `ROUTE_RECEIVER_PORTS` |
| `lib/cli.mjs` | `runCli(target, args, {token, home, cwd, input, env, timeoutMs, guard})` → `{code, signal, stdout, stderr, json, opened, entry, source, home, ms, cut}`: the tree's CLI with an environment built from nothing, `BIKESHED_ORIGIN` forced and, on a local target, the egress guard: a command that builds its URL without `BIKESHED_ORIGIN` is refused and logged in `logs/egress.jsonl`, not sent to production. `cut` is `cliCut(r, "bikeshed <command>")`: why the stack, not the product, failed the run, or null (When the stack does not answer). `cliCut(r, what = "bikeshed")` → `string\|null` for anything with `ms` and `stderr`. `spawnCli(target, args, o)` for a command that runs until stopped (below). `cliHome`, `cliEnv`, `cliGuardEnv`, `cliEntry` |
| `lib/operator.mjs` | `runOperator(target, "delete-version.mjs", args, {timeoutMs, input, env})` → `{code, stdout, stderr, script, env}`: any `scripts/*.mjs` of the TREE, cwd the tree, with the emulator hosts, the stack's own HOME (never yours), `BIKESHED_BUCKET`, a dummy `authorized_user` file as `GOOGLE_APPLICATION_CREDENTIALS` (`delete-version.mjs` refuses a real run without one; against emulators no token is fetched) and the egress guard. `operatorEnv(target)`, `dummyAdc(target)`, `stackHome(target)`. Local only |

**A CLI command that runs until stopped** (`lib/cli.mjs`): `publish --watch`,
`update --watch`, `changes --wait`, a browser `login`. `runCli` resolves only
when the CLI exits, so `spawnCli(target, args, {token, home, cwd, env, guard,
maxMs = 300_000})` returns at once, after the same `--origin` refusal, guard
verdict, environment and entry as `runCli`, with stdin closed. The handle:

- `pid`, `entry`, `source`, `home`, `startedAt`. Every `t` is this
  process's `performance.now()`, as `User.capture` rows are.
- `stdout` and `stderr`, read live. `stderrAt` holds `[{t, text}]`, one per
  chunk as it came. `stderrLines` holds `[{t, text}]`, one per whole line,
  timed by the chunk that ended it.
- `opened`: the URLs the stub opener recorded, read live.
- `marks` and `mark(what)` → `{t, what}`. The spawn is the first mark, "the
  start". Mark each thing the case does that sets the CLI working (a save it
  will republish, a change it waits for).
- `cut` → a string or null: the first 504 `error:` line that came
  `HOSTING_CUTOFF_MS` or more after the latest mark before it, e.g. "bikeshed
  publish saw a 504 60364 ms after the burst writing revision 3, …". A 504
  soon after a later mark is that mark's answer. Pass the handle through
  `answered()` to end the case INCONCLUSIVE on it.
- `exited`: null while it runs, then `{code, signal, stdout, stderr, ms,
  stopped: "stop"|"max"|null}`. `done` is the promise of it.
- `stop({signal = "SIGTERM", graceMs = 5_000})` signals the CLI's process group,
  then SIGKILLs the group if it is still there after `graceMs`. It resolves to
  `exited`. Calling it again returns the same promise.

The CLI leads its own process group, so `stop()` reaches whatever it started
and nothing else. The group is SIGKILLed after `maxMs`
(`stopped: "max"`) and when this process exits. A spec process killed by a
signal (a file timeout, run.mjs's teardown) runs no exit hook, so the CLI
also carries a lifeline (`lib/cli-lifeline.mjs`, preloaded after the egress
guard, with `E2E_CLI_PARENT_PID` and `E2E_CLI_DEADLINE` in its environment).
The lifeline ends the group within a second of its parent being gone, or 5 s
past `maxMs`.

```js
const w = await spawnCli(ctx.target, ["publish", "page.html", "--watch", "--id", id, "--json"], { token, home });
try {
  await eventually(() => /watching/.test(w.stdout + w.stderr), { timeout: 180_000 });
  w.mark("the save of revision 2");
  writeFileSync(join(home.home, "page.html"), revision2);
  await eventually(() => w.stdout.includes('"versionId"') || w.exited, { timeout: 180_000 });
} finally {
  await w.stop();
}
answered(w, "publish --watch");
```

**Commenting as the app does** (`lib/web.mjs`, SPEC §4, §6). A person
comments in the browser through three rules-evaluated writes of
`app/src/firestore.ts`, and these send the same three through a
`clientFirestore` (`fs`) for the account `acct` (an account from `cast`, or
an `openSession` result):

- `webThread(fs, acct, {docId, versionId, anchor, body, annId, commentId,
  abortRetries})` → `{annId, commentId, anchor, path}` opens a thread:
  `createAnnotation`, then `addComment`. Each is a setDoc (`fs.set`: the whole
  document, no precondition, `createdAt` the server's time); the address is
  lower-cased, the actor `{uid, email, channel: "web"}`, the colour
  `ANNOTATION_COLOR` (`TOKENS.annotation`). `path` is the annotation's.
- `webReply(fs, acct, {docId, versionId, annId, body, commentId,
  abortRetries})` → `{commentId, path}` is `addComment` on an existing thread.
- `webResolve(fs, acct, {docId, versionId, annId, resolved = true,
  abortRetries})` → `{resolved, resolvedBy, path}` is `setResolved`: updateDoc
  of exactly `resolved` and `resolvedBy` (the caller); `resolved: false`
  reopens.
- `anchorIn(text, elementId, exact, {at})` → `{elementId, exact, prefix,
  suffix, start, end}` is the Anchor the app makes when a reader selects
  `exact` inside the element whose textContent is `text`: the quote with
  `ANCHOR_CONTEXT` (32) characters either side, as the app's
  dom-anchor-text-quote keeps them, and its position. `exact` must occur once,
  or `at` (its start) says which; `elementId` `""` is the document root.
- `webAnnotationWrite(fs, acct, {docId, versionId, anchor, annId})` →
  `{annId, path, data, write}` sends nothing: createAnnotation's write, to
  open many threads in one `fs.commit([...writes])`.

Ids are auto-ids as the web SDK makes them (`autoId()`: 20 of
`[A-Za-z0-9]`) unless you pass `annId` / `commentId` (a trigger's order
follows ids). ABORTED (a loaded emulator's "Transaction lock timeout") is
retried as the SDK retries it, up to `WEB_ABORT_RETRIES` (5) times,
`WEB_ABORT_BACKOFF_MS` × k apart, a creation read back first so one that
landed anyway is not sent again. Any other refusal throws `E2E_WEB_WRITE`
at once (`err.result` the clientFirestore result, `err.path`), and an
argument that is wrong throws a TypeError before anything is sent: an
unknown option (`version` for `versionId`), a version that is not `v<n>`,
an anchor that is not exactly the app's six keys (`strict` is an agent's
server-anchored comment) or whose `end - start` is not the quote's length.
For a write the rules should REFUSE, start from `annotationData(acct,
{annId, anchor})`, `commentData(acct, {commentId, body})` or
`resolveData(acct, resolved)`, change it, and send it with `fs` yourself, so
the refusal is yours to assert. Also `webActor(acct)`,
`annotationPath(docId, versionId, annId)`, `commentPath(docId, versionId,
annId, commentId)`, `ANNOTATION_KEYS`, `COMMENT_KEYS`, `RESOLVE_KEYS`,
`ANCHOR_KEYS`. `selftest/web.test.mjs` reads `app/src/firestore.ts`, the
colour token, `describeAnchorFromRange` and the rules' key lists, and fails
when the app's write shape moves away from these. On production every one
of these writes is under a document's annotations, so the guard sends it
only after `assertQuietDoc(docId)`.

```js
const fs = clientFirestore(ctx.target, { session: viewer });          // the viewer's own ID token
const anchor = anchorIn(paragraphText, "e2e-3", "Paragraph 3.");
const t = await webThread(fs, viewer, { docId, versionId: "v1", anchor, body: "first words" });
await webReply(fs, viewer, { docId, versionId: "v1", annId: t.annId, body: "and more" });
await webResolve(clientFirestore(ctx.target, { session: owner }), owner, { docId, versionId: "v1", annId: t.annId });
```

**Where a browser's redirect lands.** `startReceiver({target, host =
"127.0.0.1", port, path = "/callback", claimTimeoutMs, page, via})`: give it
the `page` (a Page or a User) that will follow the redirect whenever a browser
does. The consent page leaves with `location.assign` only once its POST has
answered, so a socket receiver's `wait()` resolves when the request ARRIVES,
before the browser has committed the navigation, and a `goto` straight after
it is "interrupted by another navigation". `received(timeoutMs = 30_000)` is
`wait()` and then, with a `page`, until that page has loaded the receiver's
address, all within `timeoutMs`; it throws `E2E_OAUTH_TIMEOUT` naming where
the page is (origin and path, never the query, which holds the code).
Without a page it is `wait()`. `heard()` says, without waiting, whether the
redirect has arrived; `requests` (live) is `{t, method, path}` per request
the receiver answered, any path, never the query. `via: "socket"` (the
default on a local target, and wherever there is no `page`) is the loopback
server it always was: on a claimed spare port of a local stack, else on
`port` (0: ephemeral). `via: "route"` (the default when a `page` is given on
any other target) binds nothing: a route on the page's context answers
`http://127.0.0.1:<port>`, `path` with the receiver's page and anything else
404, so the redirect never leaves the browser, as production requires (a
browser there may not navigate to loopback). Its `port` is only the number in
the URI, by default an unused one of `ROUTE_RECEIVER_PORTS` (40000–48999,
never a stack's port), so a request the route misses, or one after `close()`,
is a breach the tripwire aborts, on any target. `claim` is then null. Pass
`via: "route"` on a local stack to run the production path where it can be
watched. A socket receiver with a `page` on a non-local target is refused.
The `url` a delivery carries is the full address the browser asked for, port
included.

```js
const u = await ctx.users.user({ name: "owner" });
const r = await startReceiver({ target: ctx.target, page: u });   // a route on production, a spare port locally
try {
  const params = authorizeParams({ clientId, redirectUri: r.redirectUri, challenge: p.challenge });
  await u.goto(`/connect?${new URLSearchParams(params)}`);
  await consent(u.page, { approve: true });
  const back = await r.received();                                // the page is on the receiver now
  assert.equal(back.state, params.state);
  await u.goto("/account");                                       // never "interrupted by another navigation"
} finally {
  await r.close();
}
```

**When no redirect comes.** The consent page leaves only once its own POST
/oauth/consent has answered 2xx; on a 4xx or 5xx it shows its failure view
and has nowhere to go (app/src/pages/Connect.tsx `decide`). So a receiver
given a `page` watches, from `startReceiver` on, every POST /oauth/consent
that page's context sends for its own redirect (the body's
`params.redirect_uri`: another receiver's on the same page is left out, a
body that names none is kept), and when `wait()` or `received()` runs out,
its `E2E_OAUTH_TIMEOUT` says what they answered. The first clause is the one
it always was (`no redirect reached the receiver within <N> ms`, the length
the judges read), and then one of:

- `; the page's POST /oauth/consent for this redirect: describe 200 after
  412 ms, approve 504 after 60008 ms; the last answered 504, so the consent
  page had nowhere to go`;
- `…, approve unanswered after 30002 ms` (no answer yet), or `…, approve
  failed (net::ERR_EMPTY_RESPONSE) after 12 ms` (none will come);
- `; the page sent no POST /oauth/consent for this redirect after the
  receiver started` (the press never reached it).

The latest six are named and the rest counted (`2 earlier, then …`). The
error carries `consent`, every such POST oldest first, `{method: "POST",
path: "/oauth/consent", action, state: "sent"|"answered"|"failed", status,
ms, failure, t, at}` (`action` null when the body does not say; `ms` the
wait for the answer, or so far; `t` and `at` on Date.now()), or null for a
receiver with no page. When the LAST row answered 4xx or 5xx, that row is
also `response`: Hosting's 504 at its cut-off is then the stack not
answering (`stackDidNotAnswer`; with `inconclusiveOnStackTimeout` the case
ends INCONCLUSIVE, `POST /oauth/consent answered 504 after 60008 ms,
Hosting's cut-off …`), and a quicker error is the product's answer, judged,
which `pageStall` and `functionKill` never excuse. With no such answer
(none sent, unanswered, failed, 2xx) there is no `response`, and the error
is the wait it always was. For the cut-off to arrive at all, give
`received()` more than 60 s on a local stack. Nothing about the POST beyond
its path is kept: no origin, body or query. Receivers on one context share
one set of listeners, gone with the last `close()`
(`selftest/oauth-receiver-consent.test.mjs`).

```js
scenario("A22.x connect …", { inconclusiveOnStackTimeout: true }, async (ctx) => {
  // … startReceiver({ target: ctx.target, page: u }), goto /connect …
  await consent(u.page, { approve: true });
  const back = await r.received(90_000);   // a cut-off approve ends INCONCLUSIVE; a quick 500 FAILS, named
});
```

**Measuring the consent page's arming.** `consent()` drives the arming;
`armingProbe(page, {path = "/connect", label = "Approve"})` → `{path, label}`
measures it, in the page and on the page's own clock
(`performance.timeOrigin + performance.now()`, so wall time, comparable
across that page's documents), never from this process's, which lags a CDP
round trip or more under load. It is an init script: install it BEFORE the
goto, and every top-level document at `path` from then on records, from
before its first script, `appeared` (the DOM change at which the button
labelled `label` first existed: a MutationObserver, not a poll), `enabled`
(when it first existed without `disabled`; null: never), `focusAtAppear`
(`document.hasFocus()`) and `visibleAtAppear` (`visibilityState`) at that
moment, `moves` and `keys` (the time of every pointermove and keydown that
reached the window, from capture-phase listeners, so before the page's own),
`states` (`{t, present, disabled}` per change of the button, the first row the
state at install) and `focusChanges` (`{t, type: focus|blur|visibilitychange,
hasFocus, visibility}`: app/src/pages/Connect.tsx `useArmed` restarts its
second on each). `readArming(page)` → that record of the CURRENT document
plus `now` (the page's clock at the read), or null: another path, a document
loaded before the probe, or a frame (never probed). One probe per page (the
same options again: a no-op; others throw). It adds no node and no
attribute: the record is `window[Symbol.for(ARMING_KEY)]`. `consent()` on a
probed page also returns `arming`, the record read just before its click
(null on a page without a probe). Compare the record's times with each other.

```js
const u = await ctx.users.user({ name: "owner" });
await armingProbe(u);                                    // before the goto
await u.goto(`/connect?${new URLSearchParams(params)}`);
await u.page.getByRole("button", { name: "Approve", exact: true }).waitFor();
const a0 = await readArming(u);
if (!a0.focusAtAppear || a0.visibleAtAppear !== "visible") ctx.inconclusive("the consent page had no focus when Approve appeared");
await sleep(Math.max(0, a0.appeared + 2_500 - a0.now));  // 2.5 s of the page's own time, no input
const a1 = await readArming(u);
assert.equal(a1.enabled, null, "no input: still disabled");
await u.page.keyboard.press("Shift");
const a2 = await eventually(async () => { const r = await readArming(u); return r.enabled !== null && r; });
const key = a2.keys.find((k) => k >= a2.appeared);
assert.ok(a2.enabled - key < 1_000, `armed ${Math.round(a2.enabled - key)} ms after the key`);
```

### Seed, fixtures and grants

`lib/seed.mjs`: `publish(http, {fixture | body | file, filename, title, id, folderId, expect, timeoutMs, patient, admin})`
→ `{status, json, docId, versionId}` (POST /publish, as the app's upload and
the CLI do), `publishZip(http, entries)`, `updateUpload(http, docId, {fixture |
body, baseVersion, k, expect, timeoutMs})` (a new version; `timeoutMs` is the
request's, as `publish`'s is, else the client's: raise it past Hosting's 60 s
cut-off on a loaded stack, so the stack's own 504 is what the case sees), `publishMcp(mcp, {title, content,
format, id, folder, patient, admin})`, `publishOperator(target, {sample, owner})` (the tree's
`scripts/publish.mjs`, local only), `readSample(target, sample)`, `docIdFor(target,
name)` (`e2e-<run6>-<slug>-<r4>`), `absentDocId(target, name = "absent")` (a
`docIdFor` id that is never created, ledgered as `absent`, for absent-id
probes; see production safety above). Fixtures in `e2e/fixtures/`
(`crdt-paragraphs.html` with `p#e2e-1…40`, `large-doc.html`,
`foreign-marker.html`, `digit-sections.html`) are generated by
`node e2e/lib/seed.mjs --write-fixtures`; read them with `readFixture(name)`.

**Patient.** `publish` and `publishMcp` with `patient: {ctx, attempts = 3,
lookupMs = 60_000, intervalMs = 2_000, stopAt = null}` (`stopAt` a time, or
`"budget"` for the case's own: untilLanded) send a request the
stack did not answer again, through `untilLanded` (scenario(), above). They
need the id they name (`id: false` throws), which is what makes a resend
safe: at the first non-answer the id is ledgered (the request may have made
the document), and then the document is looked for before anything is sent
again. The effect is the record with a current version AND its RTDB presence
mirror, `presenceAccess/<id>`, the function's last write
(functions/src/lib/publish.ts writes the bytes, then the record and its
version in one batch, then the mirror). Found, it is ledgered with its
version and returned as `{status: null, json: {docId, versionId, title,
fileCount, format}, docId, versionId, response: null, landed: true}`
(publishMcp: `{isError: false, text: null, json, result: null, docId, landed:
true}`); an answer is returned as before, with `landed: false`. A resend after
the first request made the document after all is answered under a suffixed
id (the product's rule for a taken id): use the `docId` returned. The case
ends INCONCLUSIVE when no attempt is answered or lands. `admin` is a
stand-in `{readDoc, rtdbGet}` for lib/admin.mjs (self-tests); a `patient`
that is not `{ctx, …}`, or has an unknown field, throws before anything is
sent.

```js
const up = await publish(owner.http, { body: html, filename: "index.html", title, timeoutMs: 150_000, patient: { ctx } });
const viaMcp = await publishMcp(mcp, { title, content, id: docIdFor(ctx.target, "mcp"), patient: { ctx } });
```

`fork(http, {docId, k, versionId, folderId, title, ownerEmail, expect, timeoutMs})`
→ `{status, json, docId, versionId, response}` is `POST /fork {op: "create"}`
(SPEC §21) as the client's actor, sending only the fields given; `docId` is
the source, and the returned `docId` and `versionId` are the fork's. A 200
appends `{kind: "doc", docId, ownerEmail, actor, via: "fork", versionId,
forkOf}` to the ledger (never the link key). The fork's id is the product's,
a slug of its title made unique, not a `docIdFor` id: pass `title` to choose
it. No status is expected unless `expect` says so.

`ledgerDoc(target, {docId, via, ownerEmail = null, actor = null, versionId =
null, forkOf})` → the row appended, `{kind: "doc", docId, ownerEmail, actor,
via, versionId[, forkOf]}` (`fork()`'s fields, in its order), sends nothing.
It is for a document made OUTSIDE these helpers: a fork the app's Fork
button made (`via: "fork-ui"`, `forkOf` the source), an upload from its
upload page (`"upload-ui"`), the CLI's (`"cli"`). Ledger it as soon as the
case knows the id (the page the app opened, the response's `docId`), before
anything else names it: on production the guard refuses every act on a
document the ledger lacks, and quarantine walks only ledgered ones.
`docId` (and `forkOf`) must be an id the product can have made (lowercase
letters, digits and single hyphens between them, at most 60 characters), so
a path, a URL or an undefined throws; so do a missing `via`, an unknown
field (`owner` for `ownerEmail`) and a credential-shaped value. Twice is
harmless.

`ledgerFolder(target, {folderId, via, ownerEmail = null, actor = null,
parentId = null, name = null})` → the row appended, `{kind: "folder",
folderId, ownerEmail, actor, parentId, name, via}` (`createFolder()`'s
fields, in its order, then `via`), sends nothing. It is `ledgerDoc` for a
folder made outside `createFolder`/`createFolderMcp`: the workspace's
Folder button (`via: "folder-ui"`), the CLI. Without it, on production the
guard refuses every write that names the folder (rule `ledger-folder`): a
folder made inside it, an upload into it, a rename. `folderId` (and a
`parentId` that is not null) must be an id the product can have made,
Firestore's 20-character auto id, so a path, a URL, a `createFolder`
result or an undefined throws; so do a missing `via` and an unknown field.
Twice is harmless. A `BrowserPool` calls it (and `ledgerDoc`) by itself for
whatever its pages create (Users and the browser, WHAT A PAGE CREATED).

`ledgerToken(target, {tokenId, uid, channel, name = null, via})` → the row
appended, `{kind: "token", tokenId, uid, channel, name[, via]}`. It is
`mintToken`'s row, field for field and in its order, plus `via` (how the
token was made: `"cli-login"`, `"account-ui"`, …) when given. It sends
nothing. Use it for a token minted OUTSIDE `mintToken`, which ledgers its
own: the CLI's browser login (the id is `config.json`'s token between `bsk_`
and the dot), the account page's Access tokens, an OAuth exchange. Ledger it
the moment the case knows the id.

- `tokenId` must be an id the product can have made, 32 lowercase hex digits.
  The whole token, secret included, is refused, and its value is not repeated
  in the error.
- `channel` is one of `TOKEN_CHANNELS` (`"cli"`, `"mcp"`, `"api"`).
- `uid` is the account's uid.
- `name` is a string (`""` included) or null.

An unknown field throws, and so does any credential-shaped value. Twice is
harmless.

`createTeam(http, {name, ownerEmail, expect = 200, timeoutMs})` → `{status,
json, teamId, name, response}` is `POST /team {op: "create", name}` (SPEC §18)
as the client's actor: a team it owns, administers and alone belongs to. A
200 appends `{kind: "team", teamId, ownerEmail, actor, name}` to the ledger
(`LEDGER_KINDS` in `lib/ledger.mjs` has `"team"`), also when `expect` refused
it. `name` is sent as given (the product trims it and refuses an empty one or
one over 120 characters); without it, `e2e <run6> team <r4>`. `expect: null`
takes any status. Production refuses `POST /team` (guard rule `team`), so in
practice it is a local-stack helper.

`createFolder(http, {name, parentId, ownerEmail, expect = 200, timeoutMs})`
→ `{status, json, folderId, name, parentId, response}` is `POST /folder
{name[, parentId]}` (SPEC §13) as the client's actor: a folder it owns, at its
root or inside `parentId` (a folder id or a `createFolder` result; sent only
when given, `null` is the root). A 200 appends `{kind: "folder", folderId,
ownerEmail, actor, parentId, name}` to the ledger, also when `expect` refused
it, so on production the guard lets later writes name it (rule
`ledger-folder`). `name` is sent as given; without it, `e2e <run6> folder
<r4>`. `expect: null` takes any status.

`createFolderMcp(mcp, {name, parent, ownerEmail})` → `{isError, text, json,
result, folderId, name, parentId}` is the MCP `create_folder` tool (SPEC §13,
§19) through an initialized `mcpClient`: a folder the token's account owns,
at its root or inside `parent` (a folder id or a `createFolder` /
`createFolderMcp` result; sent only when given, `null` is the root). A
success is ledgered exactly as `createFolder` ledgers one, `{kind: "folder",
folderId, ownerEmail, actor, parentId, name}` (`actor` the client's,
`ownerEmail` the one you pass, else null), so on production the guard lets
later tools and writes name it, and a `create_folder` inside it. Like
`publishMcp` it never throws on a tool error: check `isError` (`folderId` is
then undefined, and nothing is created or ledgered); a JSON-RPC or HTTP
failure throws, as `mcp.call` does. An unknown field (`parentId` for
`parent`) throws before anything is sent. `name` is sent as given (the
product trims it, and `name` in the result is the one it answered); without
it, `e2e <run6> folder <r4>`.

```js
const F = await createFolderMcp(agent.mcp, { name: `A21.3 ${tag}`, ownerEmail: owner.account.email });
precondition(!F.isError && F.folderId, `create_folder: ${F.text}`);
await agent.mcp.ok("move_document", { id: docId, folder: F.folderId });   // the guard knows the folder
```

`forkMcp(mcp, {id, version, title, folder, k, ownerEmail})` → `{isError,
text, json, result, docId, versionId}` is the MCP `fork_document` tool (SPEC
§19, §21) through an initialized `mcpClient`: a copy of a version the token's
account can read, as a new private document it owns. Only the arguments
given are sent, as given (`folder` may also be a `createFolder` /
`createFolderMcp` result). A success is ledgered as `fork()` ledgers one,
`{kind: "doc", docId, ownerEmail, actor, via: "mcp-fork", versionId,
forkOf}`: `forkOf` is the source's id as the product reads it (trimmed),
never the link key, and `actor` is the client's. So on production quarantine
walks the fork and the guard lets later tools name it. Like `publishMcp` it
never throws on a tool error: check `isError` (`docId` and `versionId` are
then undefined, and nothing is ledgered); a JSON-RPC or HTTP failure throws,
as `mcp.call` does. `id` must be a non-empty string, and an unknown field
throws before anything is sent (the message says `docId` is `id`,
`versionId` is `version`, `folderId` is `folder`).

`seedThreads(mcp, {docId, n, exact, prefix, suffix, k, body, via})` →
`{threadIds, version, via}` opens `n` open comment threads on the document's
current version, oldest first in `threadIds`. Each is what `add_comment`
opens: the thread on `exact` and its first comment, by the token's account,
on the mcp channel (SPEC §4, §19). It is setup for what a long list shows
(get_comments' cap of 50, the order past it), not a test of `add_comment`.

- `via: "tool"`, the default on every target but a local one: `n`
  `add_comment` calls, one after another, so creation order is call order.
  Each goes through http.mjs, so on production the guard sends it only once
  the document is proved quiet.
- `via: "admin"`, the default on a local stack and refused elsewhere
  (`E2E_LOCAL_ONLY`, before anything is sent): ONE `add_comment`, then the
  other `n − 1` are copies of what it wrote, read back through
  `lib/admin.mjs` and written in Admin batches (200 threads, 400 writes, a
  batch). Each copy has fresh ids, its own body and `createdAt` the first's
  plus 1, 2, … ms. The anchor, the actor and every other field are the
  product's own. Measured on a loaded shared stack: 50 threads in 196 ms.
  It returns only once the clock has passed the last copy's `createdAt`, so
  a thread opened afterwards sorts after all of them.

`n` is a whole number from 1 to `SEED_THREADS_MAX` (500). `exact`,
`prefix`, `suffix` and `k` are `add_comment`'s own (the last three are sent
only when given). `body` is one string for every thread or `(i) => string`
for thread `i` (1-based), and defaults to `Thread <i>.`. Each body is sent
as given and stored as the product stores it, trimmed and kept to 5,000
characters. An empty body, an unknown field or a bad value throws before
anything is sent. A refused `add_comment` throws `E2E_PRECONDITION` with
the tool's words, its `outcome` and the `threadIds` opened before it, and so
does a new version published while it seeds. A request the stack did not
answer throws as http.mjs, mcp.mjs or the Admin SDK threw it, so
`inconclusiveOnStackTimeout` judges it. Every thread fires what a real one
fires (the change log's triggers, `onCommentCreated`), so cast the accounts
with comment email off. `SEED_THREADS_VIA` lists the two ways; `db`
replaces `adminFor(target).db` on the Admin path (a self-test's stand-in).

```js
const first = await o.mcp.ok("add_comment", { id: d.id, exact: "quick brown fox", body: "First thread." });
const { threadIds } = await seedThreads(o.mcp, { docId: d.id, n: 50, exact: "Third paragraph" });
const ids = [first.threadId, ...threadIds];   // 51 open threads, oldest first
const r = await o.mcp.ok("get_comments", { id: d.id });
assert.deepEqual(r.threads.map((t) => t.threadId), ids.slice(0, 50));
```

`lib/thumbs.mjs` stores thumbnails without a browser (SPEC §2):
`postThumb(http, {docId, versionId, kind = "cover", images, sizes, r, query,
expect, timeoutMs})` → the http.mjs response (`json` is `{stored: true}`, or
`{stored: false}` when that kind is already stored for the version). `images`
defaults to one fresh `jpegSkeleton()`, `sizes` to their byte lengths, `r`
to `thumbRevision(http.target)`; `r: null` sends none. `thumbRevision(target)`
→ number, `THUMB_REVISION` from the stack's tree (via `treeConstant`): any
other `r` is a 409 "captured by an older version of the app".
`jpegSkeleton({width = 16, height = 16, pad = 0})` → Buffer, the smallest JPEG
the server's marker check accepts (SOI, `pad` bytes of comment segments,
SOF0 width×height, EOI); a 0 side or one over 1280, or a pad past 160 KiB,
makes one it must refuse. It has no scan data, so a browser cannot decode
it (measured: Chrome's createImageBitmap refuses it): a thumbnail stored
with it is served, but an `<img>` showing it fails to load; build an image a
page must show with `tinyPng`. `THUMB_JPEG` is `jpegSkeleton()`, 17 bytes, 16×16,
shared by the process: never write into it. `storeThumb(http, {docId,
versionId, kind = "cover", images, sizes, r, query, timeoutMs})` →
`{stored, key, path, paths, record, response}` is `postThumb` that must
answer 200, then the record it left in `docs/<id>.thumb` (read through
`lib/admin.mjs`) and the GET path of each image the record names (`path` is
the first; slides are `s0…`); `stored: false` means the kind was already
stored for that version, and the paths are those images'. `thumbPath(docId,
versionId, key, slot = "cover", {k})` → `/thumb/[~<k>/]<docId>/<versionId>/<key>/<cover|s<n>>.jpg`
(`slot` may be a number). `tinyPng({width = 2, height = 2, rgb = [200, 30,
30]})` → Buffer, a real one-colour RGB PNG with valid CRCs, for a bundle's
image or an og:image (built at run time, so no binary is committed). `THUMB_SOURCE` is
`functions/src/lib/thumbs.ts`. Editors only, the owner only once expired,
and `versionId` must be the current version.

`lib/grant.mjs`: `share(target, {owner, doc, account, role, verify, expect,
timeoutMs, patient, admin})` → `{status, json, members, mirror, response}`
(and `unshare(target, {owner, doc, account, expect, timeoutMs})`)
gives a role and reads the RTDB presence/edit mirror back; a missing mirror
is recorded in `findings.jsonl` (suspect S16), never thrown. `timeoutMs` is
the request's (POST /access locally, else the http client's 60 s; the
operator script on production, else 120 s): raise it on a slow shared stack.
`response` is the http.mjs answer to POST /access (null from the operator
script), so a cut-off that `expect` let through is readable.
`readMirror(target, docId, email, role, {admin})`, `operatorSetAccess(target, {docId, email, role, remove,
operator, timeoutMs = 120_000})`, `ROLES`, and `GRANT_LIST`, the record field
each role's grants are kept in (`{viewer: "viewers", suggester:
"suggesters", editor: "editors", approver: "approvers"}`, frozen, pinned to
functions/src/lib/access.ts's by `selftest/share-patient.test.mjs`).

`share` with `patient: {ctx, attempts, lookupMs, intervalMs, stopAt}` sends
a grant the stack did not answer again (`untilLanded`), after looking for its
effect in the record. POST /access writes the grant lists and `updatedAt`
into `docs/<id>` in one batch, then the RTDB mirrors, then answers; so the
effect is the record's `updatedAt` moved since just before the first request
AND the principal (an address lower-cased, `team:<id>` with its case) in
`docs/<id>[GRANT_LIST[role]]` and in no other role's list. Found, the grant
is ledgered as an answered one is, its mirror is read again until it is
there or `lookupMs` pass (the function writes it next, so no false S16 is
recorded), and share returns `{status: null, json: null, members (the
record's), mirror, response: null, landed: true}`; an answer is returned as
before, with `landed: false`. A grant already held before the call does not
count, since its `updatedAt` never moved: it is sent again. The case ends
INCONCLUSIVE when no attempt is answered or lands. The record is read
through Admin, so only on a target with `admin-emulator` (every local stack),
on production, or with `admin`, a stand-in `{readDoc, rtdbGet[, emailKey]}`
for self-tests; anything else, or a `patient` that is not `{ctx, …}` or has
an unknown field, throws before anything is sent.

```js
const g = await share(ctx.target, { owner, doc: docId, account: acct, role: "suggester", timeoutMs: 180_000, patient: { ctx } });
precondition(g.landed || g.status === 200, `share suggester: ${g.status}`);
```

SEVERAL GRANTS IN ONE REQUEST, LOCAL ONLY: `shareMany(target, {owner, doc,
grants, verify = true, expect = 200, timeoutMs, admin})` → `{status, json,
members, principals, mirrors, response}` is ONE `POST /access {docId, add:
[...]}` as the owner, each grant `{account | team, role = "viewer"}` sent as
`share()` sends it (`{email, role}` lower-cased for a person, `{principal:
"team:<id>", role}` for a team), in the order given; a principal named twice
is sent twice. It is the shape the product handles as one request (each new
member is invited inside it, so "the next recipient in the same request" can
be tested), and one request instead of several racing grants (S18). A 200
(also one `expect` refused, which then throws) appends one `{kind: "grant",
docId, email: <principal>, role, via: "access"}` row per grant; any other
status, a cut-off or no answer appends none. `expect: null` takes any status.
`verify` reads each grant's mirror after a 200 (`readMirror`, or
`readTeamMirror` for a team) into `mirrors`, one per grant, else null; a
missing one is recorded in `findings.jsonl` (S16), never thrown. `admin`
replaces `lib/admin.mjs`'s reads (a self-test's stand-in). On any target but
a local one it throws `E2E_LOCAL_ONLY` before sending anything. An empty or
malformed list throws a plain Error, also before sending, naming the grant by
its place, 1-based (neither or both of `account` and `team`, a role not in
`ROLES`, a team id the product refuses), and so does a missing owner or
document. Declare `effects: ["email:POST /access"]`.

```js
const r = await shareMany(ctx.target, { owner: O, doc: docId, grants: [
  { account: E.account, role: "editor" }, { account: V.account }, { team, role: "suggester" },
], timeoutMs: 120_000 });
assert.ok(r.members.includes(E.account.email));
```

A TEAM is granted the same way: `share(target, {owner, doc, team, role,
verify, expect, timeoutMs})` and `unshare(target, {owner, doc, team, expect,
timeoutMs})`, `team` a team id, `team:<id>` or a `createTeam` result (an
`account` that is one of the last two works too; give one or the other).
The principal is `team:<id>` with the id's case kept, sent as POST /access
`{docId, add: [{principal, role}]}` (`remove: [principal]`) locally and as
`set-access.mjs --add team:<id>` on production, and ledgered as `{kind:
"grant", docId, email: "team:<id>", role, via}`. A person is sent as before,
`{email, role}`. `verify` then reads every member's mirror:
`readTeamMirror(target, docId, team, role = "viewer", {admin})` → `{teamId,
found, members: [{email, presence, edit, expectEdit, ok}], ok}`, members
from `teams/<id>` through Admin; each must be in `presenceAccess/<doc>`, and
in `editAccess/<doc>` for an editing role. For a viewer or suggester grant
a member's edit mirror is not judged (`expectEdit: null`): another grant may
give them more, and the document's owner, a member of their own team, edits
whatever the team holds. `ok` is false when the record is missing or names
nobody. Teams are LOCAL in practice (`createTeam` and `teamMembers` are
refused on production).

```js
const team = await createTeam(O.http, { name: `A19.4 team ${t}`, ownerEmail: O.account.email });
await teamMembers(O.http, team, { add: [M.account] });
const g = await share(ctx.target, { owner: O, doc: docId, team, role: "viewer" });
assert.ok(g.mirror.ok, JSON.stringify(g.mirror.members));          // the member can now be present
await unshare(ctx.target, { owner: O, doc: docId, team });
```

THE MIRROR, WRITTEN BY THE HARNESS (suspect S16). `scripts/set-access.mjs`,
production's only grant path, writes no RTDB mirror today (see "Suspect
S16" under Concurrency specs), so its grantee's presence and live writes
are refused. The plan says: record it, then write the mirror the way the
product would have, for run documents only. `writeMirror(target, {doc,
actor = "operator-mirror", evidence, timeoutMs = 60_000, admin = null,
fetchImpl = null})` → `{docId, members, editorMembers, update, status}`
does it:

- It reads `docs/<id>` and its `updateTime` through Admin. Each node carries
  `__revision` in the product's timestamp format, `__expiresAt` as an epoch
  deadline (zero means no expiry), and `__owner` as a normalized email. It reads `editAccess/<id>`
  with an ETag, then conditionally replaces it; `presenceAccess/<id>` follows.
  A newer revision is retained. An ETag conflict retries up to five times.
- `mirrorUpdate(docId, {members, editorMembers})` builds the boolean email
  maps (lower case, dots replaced by commas). `writeMirror` adds the revision,
  owner, deadline, and the open-edit `*` key only for a public document with public editing enabled.
- Requests use `createHttp`, the database admin credential, isolation checks
  and a redacted trace row per request. No database-root read or write occurs.
- `mirrorWriteVerdict(req, {target, docs, accounts, docId = null})` →
  `{allow, rule[, reason]}` guards run-owned document nodes and run-account
  grants. Its internal `publicEdit` option permits the wildcard only when the
  source document enables it. GET and conditional PUT are the only methods;
  PUT requires a quoted ETag, valid revision and deadline, and a normalized
  owner who belongs to this run. Any refusal is `E2E_GUARD`.
  All intended grants are checked before credentials are obtained.
- `E2E_MIRROR` covers missing records/revisions, malformed membership, missing
  ETags, unexpected responses or no answer, and exhausted conflict retries.
- A successful synchronization appends `{kind: "mirror-written", suspect:
  "S16", docId, members, editors, by: "harness"}` to `findings.jsonl`.
- `admin` is a self-test's `{readDocRevision, authorization?}`; its reader
  returns `{data, revision}`. `fetchImpl` is the stand-in fetch.

`MIRROR_MODES` = `["stop", "write-missing"]`: what `grantEditors`,
`joinShared` and `addMember` (`lib/live.mjs`) do, with their `mirror`
option, when a mirror reads back missing on the operator path: report it
and write nothing (the default), or have the harness write it as above.

```js
const { docId, users, mirrored } = await joinShared(ctx, { n: ctx.n, mirror: "write-missing" });   // on production: past S16's grant half
```

Folders and teams, also `lib/grant.mjs` (SPEC §13, §18), LOCAL ONLY in
practice (see production safety):

- `shareFolder(target, {owner, folder, account, role = "viewer", expect =
  200, timeoutMs})` → `{status, json, folderId, principal, response}` is
  `POST /folder-access {folderId, add: [{principal, role}]}` as the owner;
  the grant reaches everything filed beneath the folder. `folder` is an id or
  a `createFolder` result; `json` is the folder's four grant lists. A 200
  (also one `expect` refused) appends `{kind: "grant", folderId, email:
  <principal>, role, via: "folder-access"}`. On any target but a local one
  it throws `E2E_LOCAL_ONLY` and sends nothing.
- `unshareFolder(target, {owner, folder, account, expect = 200, timeoutMs})`
  → the same shape, `POST /folder-access {folderId, remove: [principal]}`.
- `teamMembers(http, team, {add = [], remove = [], admin, expect = 200,
  timeoutMs})` → `{status, json, members, admins, affected, response}` is
  `POST /team-members {teamId[, add][, remove][, admin]}` as the client's
  actor; `team` is a team id or a `createTeam` result, `add`/`remove` emails
  or accounts (sent lower-cased, only when non-empty), `admin` `{email,
  isAdmin}`. `affected` counts the documents and folders the product
  re-fanned. Refused on production (guard rule `team-members`).
- `principalOf(account)` → the principal as the product stores it: an email
  lower-cased, or `team:<teamId>` with the id's case kept. `account` is an
  email, a `team:<id>` string, an account (`{email}`) or a team (`{teamId}`).

```js
const team = await createTeam(O.http, { name: `A13.5 team ${t}`, ownerEmail: O.account.email });
await teamMembers(O.http, team, { add: [T1.account, T2.account] });
const F = await createFolder(O.http, { name: `A13.5 folder ${t}`, ownerEmail: O.account.email });
await shareFolder(ctx.target, { owner: O, folder: F, account: team, role: "editor" });
```

Windows, also `lib/grant.mjs` (SPEC §17): `setVisibility(target, {owner, doc,
visibility, expiresAt, publicEdit, expect = 200, timeoutMs, patient, admin})` →
`{status, json, visibility, publicEdit, linkToken, expiresAt, response}` is
`POST /visibility` as the owner, sending `expiresAt` and `publicEdit` only
when given (an absent `expiresAt` CLEARS an expiry, suspect S25). Unlisted or
public opens a window on the document, private closes it; a refused request
leaves the registry as it was, and one with no answer, or answered 504 (the
product never answers 504: it is Hosting's cut-off, and the function may go on
to open the document), leaves the document open, to be closed.
`trackWindow(target, {owner, doc, visibility = "public", scope, admin})`
registers a window opened another way, `openWindows({scope})` → `[{docId,
visibility, since}]` (the running case's, or the process's outside any case),
`closeWindows({scope, attempts = 2, lookupMs = 60_000, intervalMs = 2_000,
admin})` → `{closed: [{docId, status, via}], failed: [{docId, visibility,
status, error, record}]}` makes each private as its owner (a 404 counts as
closed: the owner's 404 means it is gone; a 5xx or no answer is tried again;
never throws), and `withWindowScope(map, fn)` is how scenario() gives each
case its own registry. `VISIBILITIES` lists the three levels.

A close answered 504, or not at all, may still be closing the document, so
before anything is sent again the record is read (every `intervalMs`, for up
to `lookupMs`), and the window is closed, `via: "record"`, once all three
things POST /visibility writes say so: `docs/<id>` private (or gone),
`public/<id>` (the projection anonymous readers read) gone, and the RTDB
gate `editAccess/<id>/*` (live editing open to any account) not set. Any
other close is `via: "answer"`. A window still open is recorded with
`record`, what the record last said (`{visibility, projection, openEdit}`,
never its link token). The record is read through the Admin SDK, so only on
a target with the `admin-emulator` capability, on production, or with
`admin`, a stand-in `{readDoc, rtdbGet}` for self-tests (setVisibility and
trackWindow keep it on the window, for the case's teardown).
`selftest/window-landed.test.mjs` pins this.

`setVisibility` with `patient: {ctx, attempts, lookupMs, intervalMs, stopAt}`
sends a request the stack did not answer again (`untilLanded`), taking its
effect from the record when every part of it says so: the record's
`updatedAt` moved since just before the first request (this call's write,
not an earlier one), its visibility (and `publicEdit`, when given) is the
one asked, an unlisted one has a link token, the projection exists exactly
when public, and the open-edit gate is set exactly when public with
publicEdit. Found, it returns `{status: null, json: null, visibility,
publicEdit, linkToken, expiresAt, response: null, landed: true}` read from
the record (an answer has `landed: false`), and settles the window registry
as an answer would. The case ends INCONCLUSIVE when no attempt is answered
or lands; the window stays registered, to be closed.

```js
const { linkToken: k } = await setVisibility(ctx.target, { owner, doc: docId, visibility: "unlisted", timeoutMs: 150_000, patient: { ctx } });
```

`withVisibility(target, {owner, doc, visibility, expiresAt, publicEdit,
timeoutMs}, fn)` → what `fn` returns is a window for the length of `fn`:
setVisibility opens it (`unlisted` or `public`; anything but a 200 throws and
`fn` never runs), `fn(answer)` gets setVisibility's answer, and the document
is made private again (as closeWindows does it: a 404 is gone, a 5xx is tried
again) the moment `fn` returns or throws, so the case's next line runs on a
private document. `fn`'s own error is what the block throws. A close that
fails after `fn` returned throws `E2E_WINDOW_OPEN` (`err.failed` as
closeWindows' `failed`) and leaves the window registered, so the case's end
tries again. If `fn` makes the document private itself, nothing more is sent.
One document per block; nest blocks for two.

```js
const { linkToken: k } = await setVisibility(ctx.target, { owner, doc: docId, visibility: "unlisted" });
// … read with ?k=; the case's end makes docId private again, pass or fail

await withVisibility(ctx.target, { owner, doc: docId, visibility: "public" }, async () => {
  // … read it as a stranger
});
// docId is private here: the case goes on with it private
```

### Reading the stack: admin, logs, mail

- **The tree** (`lib/target.mjs`): `treeConstant(target, rel, name)` → string,
  a top-level `[export] const NAME = <literal>;` from the source the stack was
  built from (`target.stack.treeDir`; this checkout only for a target with no
  tree). `treeConstant(target, "functions/src/lib/thumbs.ts",
  "THUMB_REVISION")` is the `r` POST /thumb wants (`thumbRevision(target)` in
  `lib/thumbs.mjs` returns it as a number). Numbers come back in
  decimal, strings unquoted, booleans as `"true"`/`"false"`. A tree that lacks
  the file throws (never this checkout's value instead), as do an expression,
  an escape, a declaration that is indented, and a name declared twice. The
  value may stand alone on the line after the `=`, as a formatter wraps a
  long literal (`export const SUGGESTED_FOOTER =` and on the next line
  `  "…";`, app/src/export/labels.ts):
  nothing after the `=`, then ONE indented line holding the whole value AND
  its `;`, read as that value would be on the declaration's own line. A value
  that runs past that line, a next line without its `;` (the line after
  could continue it), a blank or unindented next line throw. `treeConstant(target, rel, name, {product: true})` → string
  reads an INTEGER PRODUCT instead: decimal integer literals (`_` separators
  allowed, no leading zero) joined by `*`, one factor alone included, as the
  server's clamps are written: `treeConstant(target, "functions/src/config.ts",
  "MAX_BEAT_MS", {product: true})` is `"300000"` for `5 * 60 * 1000`. A name,
  a parenthesis, another operator, a sign, a fraction, an exponent, a hex
  literal, a string, a boolean, and a product past `Number.MAX_SAFE_INTEGER`
  throw. Without the option a product throws as before, and the error says to
  pass `{product: true}`.
- **Firestore, Storage, RTDB, Auth** (`lib/admin.mjs`): `readDoc(target, path)`
  → data or null, `readCollection(target, path)` → `[{id, data}]`,
  `queryCollection(target, path, filters = [])` → `[{id, data}]`, only the
  documents matching every `[field, op, value]` triple (one Admin SDK
  `where()` each, ANDed; `op` one of `WHERE_OPS`, `<` `<=` `==` `!=` `>=` `>`
  `array-contains` `in` `not-in` `array-contains-any`): read a collection
  every spec on the stack shares by the case's own key, as in
  `queryCollection(target, "forks", [["parentId", "==", sourceId]])`. A
  malformed path (not a collection), triple, operator, an undefined value
  or an empty list for `in` throws before anything is read; production
  refuses a combination that needs a composite index it lacks. `readObject(target, key)` → Buffer or
  null, `listObjects(target, prefix)` → the names, sorted (with `{meta:
  true}`, each object's generation: below), `rtdbGet(target, path)` (REST, so no
  websocket keeps the process alive), `writeUser` (an account record before
  its first session), `emailKey`, `adminFor(target)` for anything else (call
  `closeAdmin(target)` in `after()` if you used its `rtdb` handle, or
  `watchRtdb`, below).
  `rtdbAdmin(target).get(path)` (`lib/rtdb.mjs`) is the same admin read
  through http.mjs, so it lands in the case's trace and gives a verdict.
- **Objects rewritten in place** (`lib/admin.mjs`): a name list cannot see a
  save of the same bytes, or a delete followed by a save, of an object that
  was there before.
  `listObjects(target, prefix, {meta = false, bucket = null} = {})`
  with `meta: true`, as `listObjects(target, prefix, {meta: true})`, lists
  each object as Storage does, `{name, generation, metageneration, md5, size}`,
  in the name list's order (UTF-16 code units): `generation` a decimal string
  every save renews, `metageneration` one a metadata-only update moves, `md5`
  the base64 MD5 of the bytes (null when Storage lists none, as for a composed
  object), `size` a number. "Left alone" is then `assert.deepEqual(after,
  before)` over two listings. Without `meta` it is the old call: the names.
  Every page is read. An object listed with no generation throws
  `E2E_STORAGE_META` (`object` names it): a comparison by generation would
  hold for nothing. A `meta` that is not a boolean, or a `bucket` with no
  `getFiles`, is a TypeError before anything is listed; `bucket` replaces
  `adminFor(target).bucket` (a self-test's stand-in).
  - The Storage EMULATOR stamps a save's generation with its clock in
    milliseconds (firebase-tools 15.25.1 `storage/metadata.js`,
    `opts.generation || Date.now()`, pinned by
    `selftest/admin-objects-meta.test.mjs`): two saves of one name within
    the same millisecond carry the same generation there, and only there
    (Cloud Storage renews it on every save). Measured on a fresh stack
    (2026-10-13): 25 back-to-back save-and-list rounds of one name never
    repeated a generation (1 ms apart at the closest), and a delete then a
    save took 2–3 ms and moved it by 9 (two runs).

  ```js
  const before = await listObjects(ctx.target, `docs/${docId}/draft/`, { meta: true });
  … the refused update …
  assert.deepEqual(await listObjects(ctx.target, `docs/${docId}/draft/`, { meta: true }), before, "the draft's objects were left alone");
  ```
- **Every value an RTDB node takes** (`lib/admin.mjs`):
  `watchRtdb(target, path, {firstMs = 15_000, pick = null, rtdb = null, now = Date.now} = {})`
  → `Promise<{path, first, stop()}>` binds the Admin SDK's own listener
  (`adminFor(target).rtdb`: the emulator directly, never through a
  `--rtdb-proxy`) and keeps one row per value event, `{t, n, exists}`: `t`
  this process's `Date.now()` as the SDK raised it, `n` the node's child
  count, `exists` false while the node is absent; plus `v: pick(value,
  snapshot)` when `pick` is given (keep it small: one row per change). It
  resolves once the first value has arrived (`first`, also `rows[0]`: the
  node as it stood when the listener was bound). `stop()` detaches the
  listener and returns `{path, rows, error}`, the same object on every
  call. Judge a window only on `error === null`.
  - Why not a poll. A removal of a whole node that writers refill within
    milliseconds is gone before a REST read 200 ms later. Measured on a fresh
    stack (2026-10-13, two runs), a node removed and refilled at once six
    times (three over REST, each removal lasting 2–5 ms before the next
    value; three as a `remove()` and three child `set()`s sent together from
    a second Admin app, 0–1 ms): the watch had all six empty rows each time,
    while a 200 ms REST poll over the same window (23 reads) and a listener
    sampled every 100 ms (44–46 samples) had none. Rows are never merged: two values with the same count
    are two rows. A write that leaves the node as it was raises no event (an
    identical REST PUT gave no row), so each row is a change.
  - Failing. No first value within `firstMs` throws `E2E_RTDB_WATCH` with
    `stackCut` ("the Database emulator gave no value of <path> within <ms>
    ms"), so a case with `inconclusiveOnStackTimeout` ends INCONCLUSIVE (the
    stack did not answer). A listener cancelled before its first value throws
    `E2E_RTDB_WATCH` without one. Both carry `path`, `firstMs` and `error`,
    and leave no listener behind. A cancel after the first value ends the
    rows and is stop()'s `error`; so is the first throw of `pick` (that row's
    `v` is undefined, and the watch goes on).
  - The socket is the target's Admin app's and stays open after `stop()`:
    call `closeAdmin(target)` in an `after()` hook, or the spec process
    outlives its tests.
  - A path that is not a string, is the root, or has a `.` or `..` segment, a
    `firstMs` that is not above 0, a `pick` or `rtdb` of the wrong kind, or a
    `now` that is not a function is a TypeError before anything is bound.
    `RTDB_WATCH_FIRST_MS` is 15,000. `rtdb` replaces `adminFor(target).rtdb`
    (a self-test's stand-in; `selftest/rtdb-watch.test.mjs` also drives
    firebase-admin's own handle, offline).

  ```js
  after(() => (target ? closeAdmin(target) : undefined));
  …
  const w = await watchRtdb(ctx.target, `status/${docId}/y`);
  … the window …
  const { rows, error } = w.stop();
  assert.equal(error, null, "the watch held");
  assert.deepEqual(rows.filter((r) => r.n === 0), [], "the live log was never emptied");
  ```
- **A document's change log** (`lib/changes.mjs`, SPEC §4, §19): the triggers
  record `thread.opened`, `comment.added`, `version.published` and the rest
  AFTER the write that caused them (10–44 s per trigger run measured on a
  loaded shared stack). Wait for them with `settleLog`, never by polling
  `get_changes`, which saves the very cursors a case is testing.
  `settleLog(target, docId, want, {timeout = LOG_SETTLE_MS, interval =
  LOG_INTERVAL_MS, message, db})` → the rows, once `docs/<docId>/events`
  holds EXACTLY `want` (`{"<event type>": count}`; a type not listed, or
  listed with 0, must be absent). It reads the stored log every 400 ms,
  through Admin, and throws: `E2E_LOG_OVERSHOOT` AT ONCE when any type is past
  its count (the log only grows, so waiting cannot help: an event recorded
  twice, one you did not expect, or a short `want`); `E2E_LOG_TIMEOUT` after
  `timeout` (default 240 s), naming what is missing (a failed read is tried
  again until then, the last failure its `cause`); and a TypeError before
  reading for a type that is not in the stack tree's `EventType` union
  (`functions/src/lib/events.ts`), a count that is not a whole number, or a
  `docId` the product cannot make. Each error carries `want`, `got` and
  `rows`, and begins with `message`. They are plain errors: in a `defect:`
  case whose oracle is the log, wrap the call in `ctx.oracle()`.
  `changeLog(target, docId, {db})` → `[{id, data}]` reads it once: every
  event, in recorded order (`at`, then id by its UTF-8 bytes, as `get_changes`
  orders them); a row with no server `at` throws `E2E_LOG_UNDATED`, never
  dropped. `eventAt(row)` → the ISO time `get_changes` reports for it
  (`Timestamp#toDate()`, which ROUNDS to the millisecond; `fork.created` shows
  only the first ten characters, the day). Also `logCounts(rows)` → `{type:
  n}` (keys sorted), `compareRecorded(a, b)` (a sort comparator over rows),
  `eventTypes(target)` → the tree's event types, `parseEventTypes(src)`,
  `eventsPath(docId)`, `EVENTS_SOURCE`, `LOG_SETTLE_MS` (240,000),
  `LOG_INTERVAL_MS` (400).

  ```js
  const rows = await settleLog(ctx.target, docId, { "version.published": 1, "thread.opened": 1, "comment.added": 1 }, { message: "the thread is recorded" });
  const feed = await agent.mcp.ok("get_changes", { id: docId, since: "all", includeMine: true });
  assert.deepEqual(feed.events.map((e) => [e.type, e.at]), rows.map((r) => [r.data.type, eventAt(r)]));
  ```

  **What a poller was told, against what is stored (I15).** "get_changes
  reports each event once, and the counts match" is read with four more
  exports, which a case uses instead of a poller of its own:

  ```js
  const poll = startPoller(agent.mcp, docId, cursor0);         // from the log's head (page "all" until !more)
  … the storm …; settle the stored log (settleStill over logCounts(await logAfter(…)), or settleLog) …
  const { events } = await poll.finish();
  const logged = await logAfter(ctx.target, docId, cursor0);   // stored events after the poller's first cursor
  const reported = feedToLogIds(events, logged);
  assertInvariant(checkI15({ events: reported, expected }));
  const seen = new Set(reported.map((r) => r.id));
  assert.deepEqual(logged.filter((r) => !seen.has(r.id)).map((r) => r.id), [], "every logged event reported");
  ```

  - `startPoller(mcp, docId, cursor, {intervalMs = 400, includeMine =
    false, finishMs = 60_000})` → `{finish(), abandon()}` polls get_changes
    at once and then every `intervalMs` (a page that says `more` is
    followed at once), each poll from the cursor the last gave back, and
    keeps EVERY page's events, in order: an event reported twice is there
    twice. `cursor` is a cursor, `"all"` or `"last"`. `finish()` stops it
    on the first QUIET poll that STARTED after finish() was called: the
    cursor given back unchanged and no more (SPEC §19). Never on a poll with
    no events: under a cursor that does not move past what it reports, every
    poll repeats the last event, and a poller waiting for an empty one never
    ends; this one ends and keeps the repeats, for checkI15 to see. Never on
    a poll already in flight when finish() was called: its read may predate
    the last event. It resolves `{events, polls: [{at, ms, events, more,
    moved, afterFinish}], cursor}` (the same promise on every call) and
    rejects with `E2E_POLL_TIMEOUT` (no quiet poll within `finishMs` of
    finish(), checked between polls, worded "… within <ms> ms …"),
    `E2E_POLLER` (a get_changes refused, or answered without events and a
    cursor: it stopped there), both carrying `{events, polls, cursor}`, or
    the error a poll threw, unchanged (a cut-off keeps its shape).
    `abandon()` stops after the poll in flight and resolves the same three;
    it never rejects (for a `finally` when the case failed first). `mcp` is
    an mcp.mjs client; a bad docId, cursor (another document's included) or
    option is a TypeError before anything is sent.
  - `logAfter(target, docId, cursor, {db})` → `[{id, data}]`: the stored
    events strictly after `cursor`'s position, in recorded order (`"all"`,
    or a cursor given before any event: every one). A poller may be told
    less than this: the feed leaves out events its audience hides, events
    the polling TOKEN caused (unless includeMine; another token of the same
    person is not "mine"), and comments deleted since.
  - `feedToLogIds(feed, rows)` → `[{id, kind}]` in feed order: each feed
    event as the stored row it reports, matched on type, version, threadId,
    commentId (a comment.added's) and `at` as the feed shows it. Feed events
    with the same fields take those rows in recorded order; one past them
    reuses the last (checkI15 then counts it twice); one with no row at all
    is `unlogged:<fields>` (an extra of its kind).
  - `cursorPosition(cursor, {docId = null})` → `{docId, at: {seconds,
    nanoseconds}, id}` | null (the log's start, `"all"`), decoded as
    `functions/src/lib/events.ts` encodes it (`CURSOR_VERSION` 1, pinned by
    the self-test); `"last"`, a malformed cursor, another version, or
    another document's cursor is a TypeError, as the product refuses them.
    `feedAt(row)` → the `at` the feed reports for a stored row (eventAt;
    the day alone for a `fork.created`). `POLL_INTERVAL_MS` (400),
    `POLL_FINISH_MS` (60,000).
  - `selftest/changes-poller.test.mjs` pins all of this against a stand-in
    get_changes that follows the product's cursor rules, including one whose
    cursor includes its own last event (the poller ends, checkI15 fails).
- **Resources** (`lib/stack.mjs`): `stackResources(runId)` → `{caps, jvms:
  [{role, pid, alive, xmxMb, exitOnOom}], debugLogs: {maxBytes, files},
  watchdog, owner, keep, createdAt, lease, rss: {totalBytes, processes, by}}`,
  read live (the smoke canary uses it); `stackFailures(rec)` → what has died,
  each naming the emulator; `stackRss(rec)`.
- **Logs** (`lib/logs.mjs`): take a mark before acting, then wait after it:
  `const m = logMark({target}); … await waitForLog(/re/, {target, since: m})`.
  `expectNoLog(re, {target, since})` refuses a settle under 45 s
  (`MIN_LOG_WAIT_MS`), `grepLog`, `readLog`, `tailLog`. Names under
  `logs/`: `emulators.log` (function console lines), `mailpit.log`,
  `shim.log`, `shim.jsonl`, `build.log`, `egress.jsonl`,
  `database-debug.log` (below).
- **The Functions emulator's runs** (`lib/logs.mjs`): how many runs of each
  function the emulator began in a window of `emulators.log`, and how many
  ran at once. Its own process prints `i  functions: Beginning execution of
  "us-central1-<name>"` as it hands a request to a worker, `i  functions:
  Finished "us-central1-<name>" in <ms>ms` as the answer ends, and `i
  Request to function failed: <error>`, naming no function, when the
  worker never answered (a kill, or the 60 s limit's destroy)
  (firebase-tools `functionsRuntimeWorker.js` `RuntimeWorker.request`). A
  Firestore trigger arrives the same way and answers once its code has
  returned. The lines carry no time and no document, and ONE process prints
  them, so their order is the order of those events: two runs overlapped
  when the second began before the first's end line. Measured over every
  `emulators.log` under `e2e/.out` (1221 stacks, 2026-10-13): begun =
  finished + failed in every one.
  - `functionRuns(text, {triggers = FIRESTORE_TRIGGERS, openAtStart = null} = {})`
    → `{runs, peak, peakTriggers, peakOther, peakAny, open, stray, failed,
    openAtStart, exact}`. `text` is whole lines of the log. `runs` (begun),
    `peak` (most at once), `open` (not seen to end) and `stray` (end lines
    of runs begun before the text) are per function name, the region taken
    off (`onCommentCreated`; a grouped export keeps its dashes), keys sorted,
    a 0 left out. `peakTriggers` is over `triggers`, `peakOther` over every
    other function, `peakAny` over all; `failed` counts failure lines.
  - Every count is a LOWER bound, never more than certainly ran at once. An
    end line of f ends one open run of f, or is `stray` when none is open;
    a run begun before the text may end while one of the text's is open,
    and its end is then taken for that run's, which counts as ended early.
    A failure line names no function, so it ends one open run of EVERY
    function. `exact` is true when neither could happen (`openAtStart` 0,
    no failure, nothing stray): then every peak is what ran at once.
    Against c13's in-spec parser over the same 1221 logs: equal on all 1213
    without a failure line, lower on 6 of the 8 with one, never higher.
  - Only the emulator's own whole lines count (VT codes stripped, DEBUG's
    ` {"metadata":…}` trailer allowed): a line that merely contains one,
    such as a function's console line quoting it (`>  i  functions: …`),
    does not.
  - `caseFunctionRuns(ctx, {since = ctx.logSince, until = null, triggers = FIRESTORE_TRIGGERS, target = ctx.target} = {})`
    → functionRuns over the case's window plus `{since, until, from, to}`
    (`from`/`to`: the bytes read), or null when there is nothing to read
    (no mark, a target that is not a local stack or lacks `logs`, no log, a
    mark past its end). It reads from the start of the line holding `since`
    to the last whole line before `until` (or the log's end now), and counts
    `openAtStart` from the log's first line (begun, less finished and
    failed: each run ends with exactly one of the two), so a window that
    began with nothing in flight can be `exact`. That read is 70 ms on a
    30 MB log. Call it once the runs it counts are over (after the server
    settle): a run still going is in `open`. `until` (a later `logMark`)
    closes the window early, e.g. at the end of a race.
  - `FIRESTORE_TRIGGERS` (frozen): `onCommentCreated`,
    `recordCommentEvent`, `recordThreadEvent`, `recordVersionEvent`, every
    export of `functions/src/index.ts` built with `onDocumentCreated` or
    `onDocumentWritten`; every other export there is HTTP (`onRequest`).
    `selftest/function-runs.test.mjs` pins it to the source.
  - What an overlap is, and is not. The window is the emulator's, from
    handing the request to a worker to the end of its answer, so two
    overlapping windows are necessary for the two functions' code to
    overlap, not proof that one statement in each did. The log names no
    document: on a stack other spec files use at the same time (an attached
    functional stack), their runs are in the window too. A concurrency run
    without `--attach` builds its own stack and, by default (`--concurrency
    1`), runs its files one at a time, so there the window holds the case's
    runs and what earlier cases left running (`openAtStart`).
  - TypeErrors before anything is read: `text` not a string, `triggers` not
    a list of names, `openAtStart` neither a whole number nor null, `since`
    or `until` not a byte offset (or `until` before `since`), a `ctx` that
    is not an object.

  ```js
  import { caseFunctionRuns } from "../../lib/logs.mjs";
  … the storm, then the server settle …
  const runs = caseFunctionRuns(ctx);
  ctx.ev.json("function-runs", runs);
  if (!runs) ctx.inconclusive("the case's window of emulators.log was not readable");
  const peak = runs.peak.onCommentCreated ?? 0;
  if (peak < 2) ctx.inconclusive(`the sync precondition did not hold: no two onCommentCreated runs certainly overlapped (${runs.runs.onCommentCreated ?? 0} run(s); ${runs.failed} failure line(s))`);
  ```
- **The Database emulator's own log** (`lib/debuglogs.mjs`,
  `e2e/.out/<runId>/logs/database-debug.log`, `rec.logs.database`, so
  `target.stack.logs.database`): what the RTDB emulator (a JVM) printed,
  every line led by its record's ISO time, `[2026-10-13T15:20:15.256Z]
  08:20:15.256 [main] INFO com.firebase.server.forge.App$ - Listening at
  127.0.0.1:31373` (the JVM's own clock is local and has no date), plus
  firebase-tools' own debug lines about the database (its command line, the
  arguments it ignores). It survives the stack: read it after the run, when
  the tree is gone.
  - What it holds, and what it does not. At its default level the emulator
    prints its start-up (`Listening at 127.0.0.1:<port>`, each namespace
    activated), warnings and errors, and its shutdown (`Attempting graceful
    shutdown` … `Graceful shutdown complete`). It prints NOTHING per
    connection: measured live (a fresh stack, 2026-10-13), two editors joining,
    settling, and one closing its page until its presence was gone wrote
    no line at all. So this log tells whether the emulator restarted,
    failed or warned during a window, not whether a client's socket
    dropped; a connection-level question needs the stack's RTDB proxy
    (`--rtdb-proxy`, `rtdbLatency(target).stats()`) or presence read over
    the window (`status/{d}/peers`).
  - How it gets there. firebase-tools logs each chunk of the JVM's stdout
    and stderr into `firebase-debug.log` as `[debug] [<ISO>] <chunk>
    {"metadata":{"emulator":{"name":"database"},"message":"<chunk>"}}`. The
    drain takes the chunk from that JSON trailer, and only when the printed
    text is the same chunk (its last line before the trailer, and its first
    line as many lines up as the chunk has line breaks), so a chunk that
    merely contains such JSON, or a line inside one that looks like a
    record's start, is never taken for a record. Info and warn lines are
    firebase-tools' own and are in `emulators.log` already.
  - When. The watchdog drains the new bytes on every tick (15 s), BEFORE it
    cuts `firebase-debug.log`; `stopStack` drains once more after the
    watchdog is stopped and before the emulators are signalled (a clean exit
    unlinks the file), hard-links the file into the stack dir
    (`firebase-debug.pinned.log`), drains that link once the processes are
    gone (the shutdown lines), then removes it. A cut that lands between a
    drain and the truncation loses at most what was written in those
    milliseconds, and the file says where: `[<ISO>] [e2e] firebase-debug.log
    was cut after this file had read <n> bytes of it (last read <ISO>); what
    the database emulator printed between that read and the cut is not
    here`. The progress (offset, the file's inode and first 128 bytes, the
    output's committed size) is `<stackDir>/database-log.json` under an
    O_EXCL lock holding the drainer's pid, so the watchdog, `stopStack` and a
    spec never write a record twice.
  - Capped as the debug logs are: past half of `E2E_DEBUG_LOG_MAX_MB` the
    file moves to `database-debug.log.1`.
  - In a case: `waitForLog(re, {target, name: "database-debug.log", since})`
    sees a line up to one watchdog poll late; `drainDatabaseLog(ctx.target.stack)`
    first makes it current (`{busy: true}` while the watchdog is mid-drain:
    try again).
  - `stopStack` returns, and `rec.stopped.databaseLog` keeps, `{file, before,
    after, pinned}`, each drain `{records, total, bytes, read, reset[,
    busy][, missing]}` or `{error}`; a drain never stops a teardown.
    `watchdogTick` returns its drain as `database` (also in `watchdog.json`).
  - Stacks started before this have no `logs.database` and no watchdog
    drain; `stopStack` still drains what their `firebase-debug.log` holds
    into `logs/database-debug.log` beside their `emulators.log`.
  - Exports: `DATABASE_LOG = "database-debug.log"`, `DATABASE_LOG_STATE =
    "database-log.json"`, `DEBUG_LOG_PIN = "firebase-debug.pinned.log"`,
    `DRAIN_CHUNK_BYTES` (1 MiB: a longer line cannot be a record and is
    skipped); `drainDatabaseLog(stack, {maxBytes = null, chunkBytes, now} =
    {})` → the drain's result, or null for a stack that names no tree,
    stack dir or logs (`stack` is a stack record or `target.stack`);
    `databaseLogPaths(stack)` → `{source, pinned, out, state}` | null;
    `drainEmulatorLog({source, out, state, emulator = "database", maxBytes,
    chunkBytes, now})` → `{file, source, records, total, bytes, read,
    written, offset, size, reset: null|"cut"|"replaced", rotated, trimmed,
    skippedLines[, busy][, missing]}` (synchronous); `emulatorLogText(text,
    {emulator = "database", cursor = null})` → `{text, records, cursor}`
    (whole lines; the cursor carries an open record to the next call);
    `emulatorTrailer(emulator = "database")` → the trailer's opening text;
    `pinDebugLog(stack)` → `{pinned: path|null, reason?}`,
    `unpinDebugLog(stack)` → boolean.
- **Egress refusals** (`lib/egress.mjs`): `egressMark(target)`,
  `readEgress(target, {since})` → `[{kind: connect|dns|udp, host, port, pid,
  thread, script, frames}]` (`thread` is the worker's `threadId`, 0 for the
  main thread), `waitForEgress(target, pred, {since, timeout})`. A spec
  that makes the product reach outward can assert the refusal; a spec that
  must not can assert there is none.
- **Mail** (`lib/mail/reader.mjs`): `mailbox(target)` → `find({to, subject})`,
  `expectMail({to, subject, count, timeout, settleMs})` (counts must hold
  still for 10 s, `MAIL_SETTLE_MS`; `count: 0` is a quiet settle), `message(id)`,
  `headers(id)`, `search(query)`. Match on YOUR recipients only.
  - `waitFor({to, subject = null, timeout = 30_000, interval = 250})` → the
    newest matching message, whole (as `message(id)` reads it: `Subject`,
    `Text`, `HTML`, …), the moment one is there: ARRIVAL, no settle, no
    count. It is how a case knows a trigger has run. `subject` is a string
    (equal) or a RegExp; newest is by `Created`, else Mailpit's own
    newest-first order. With none by `timeout` it throws `E2E_MAIL`
    `waitFor: no message to <to> [with subject <s>] within <N> ms (saw <n>
    to <to>: …)`, with `seen` (every summary to `to`, any subject) and
    `waitedMs`. A missing `to` throws; a bad subject, timeout or interval
    throws `TypeError`, before anything is read.
  - `expectMailboxes({[address]: [subjects]}, {timeout = 30_000, settleMs =
    MAIL_SETTLE_MS, interval = 250})` → `{mailboxes: {[address as given]:
    summaries}, waitedMs, settledMs, reads}` holds several WHOLE mailboxes to
    exact subject lists (a multiset: order free, a repeat counted; `[]` a
    quiet mailbox) through ONE shared settle, so ending on six recipients
    costs 10 s, not 60. Anything extra in any mailbox fails at once (mail
    cannot be unsent); a short one is waited for until `timeout`, then fails
    `expectMailboxes: within <N> ms, a mailbox is still short: …`; any move
    during the settle fails too. Each throws `E2E_MAIL` naming the first
    mailbox that differs in the order given, with `mailbox`, `differs`
    (`[{to, want, got, missing, extra}]`, every one that differs), `seen` and
    `missingOnly` (true only when nothing is extra anywhere: a notice that
    never came, the one failure `functionKill` may excuse). An address named
    twice without case, a subject that is not a string, an empty or
    non-object expectation, or a settle under 10 s (unless `allowShort`, for
    self-tests) throws before anything is read.

  ```js
  const box = mailbox(ctx.target, { http: ctx.http({ actor: "mailpit" }) });
  const notice = await box.waitFor({ to: owner, subject: commented(K, title), timeout: 180_000 });
  assert.ok(notice.Text.includes(`/d/${docId}/v2`));
  await box.expectMailboxes({ [owner]: [commented(K, title)], [K]: [], [W]: [commented(K, title)] }, { timeout: 180_000 });
  ```
  - **Notices per (person, kind), for I11.** Where several authors race, a
    notice's exact subject cannot be known (a comment notice names whichever
    author's trigger took the cooldown), so expectMailboxes cannot hold it.
    `settleKinds({people, title, kinds = NOTICE_KINDS, eligible = [], docId
    = null, timeout = 30_000, settleMs = MAIL_SETTLE_MS, interval = 250,
    allowShort = false})` → `{messages: [{to, docId, kind, at, subject, id}],
    twice: [{to, kind, n}], missing: [{to, kind}], settled, waitedMs,
    settledMs, reads}` reads the mailboxes of `people` (exact recipients), keeps
    the messages whose subject quotes `“<title>”` (as every notice does), and
    gives each the first kind whose pattern matches (else `"other"`). It
    waits until every `eligible` `{to, kind}` has one and nothing moved for
    `settleMs` (any new message restarts that window): `settled: true`. A
    SECOND notice to one (person, kind) ends it AT ONCE, `settled: false`,
    `twice` naming it (mail cannot be unsent): pass `messages` to checkI11,
    which fails on it. Running out is `E2E_MAIL` with `missingOnly: true`,
    `missing` and `messages`: an eligible notice not there within `timeout`
    ("settleKinds: within <timeout> ms, …"), or mailboxes still moving at
    `timeout` + `settleMs`. `docId` is what each message carries (left out:
    the one `eligible` names). `to` comes back lower-cased; `at` is the
    message's `Created`. People named twice, an eligible `to` outside
    `people` or kind outside `kinds`, eligible entries naming two documents
    (or not `docId`), `kinds` that are not `{word: RegExp}` (no `"other"`, no
    g or y flag) are TypeErrors before anything is read; a settle under 10 s
    throws unless `allowShort`.
  - `NOTICE_KINDS` (frozen) is the product's three notice subjects
    (`functions/src/email/notify.ts`, pinned by `selftest/mail-kinds.test.mjs`):
    `comment` `/ commented on “/`, `suggestion` `/ suggested an edit to “/`,
    `invitation` `/ shared “.*” with you$/`. `kindOfSubject(subject, kinds =
    NOTICE_KINDS)` → the first matching kind, or null.

  ```js
  const eligible = [{ to: owner, docId, kind: "comment" }, { to: owner, docId, kind: "suggestion" }, ...parts.flatMap((to) => [{ to, docId, kind: "comment" }, { to, docId, kind: "invitation" }])];
  const { messages } = await box.settleKinds({ people: [owner, ...parts], title, eligible, timeout: 240_000 });
  assertInvariant(checkI11({ messages, eligible }));
  ```
- **The Resend shim** (`lib/mail/shimctl.mjs`, capability
  `mail-fail-recipient`): `shimControl(target)` → `failRecipient(to, {status,
  count, body})` (the next `count` sends naming exactly `to` fail; nobody
  else's), `pending(to)`, `clear(to)` (do it in `finally`), `requests({to})`
  (what the shim received for `to`, refused and injected ones included),
  `health()`. `shimKey(target)` is the dummy key, for a canary that talks to
  the shim directly. The shim's global `/__e2e/fail-next` and `/__e2e/reset`
  affect every spec on the stack: never use them on a shared one.
  With `mail-hold-recipient`, `holdRecipient(to, {stage: "headers" | "body"})`
  stalls only that exact recipient, `held(to)` reports received, pending and
  closed connections, and `release(to)` ends any remaining held response
  without delivery (call it in `finally`). A client abort leaves the hold armed
  and increments `closed`, proving cancellation happened without a release.
- **Password-reset mail** goes through Firebase's own mailer: read the Auth
  emulator's `/emulator/v1/projects/<projectId>/oobCodes` at
  `target.authEmulatorUrl` with `createHttp` (capability `oob-codes`).

### Synchronisation (races)

`lib/sync.mjs`: `syncHttp(requests, {target})` fires N requests from N
worker threads at one instant (`{results, spreadMs, verdict, overlap}`);
`syncActors(tasks)` the same for your own worker functions; `syncPages(pagesOrFrames, actionFn,
{arg})` fires an action in N pages at one instant; `holdRequests(contexts,
urlPattern, n)` holds N browser requests and `release()`s them together
(`{records, overlap}`); `overlapProof(records)` (`max(send) < min(firstByte)`),
`spreadVerdict(times, kind)` and `requireConclusive(ctx, {spread, overlap})`,
which ends the case INCONCLUSIVE when the fire spread is over
`SPREAD_LIMIT_MS` (15 ms HTTP, 40 ms browser) or the overlap is unproven.
Interleavings inside the product (SYNC-P pause points, SYNC-G client
gates) and RTDB latency are under Concurrency specs: `lib/gates.mjs`,
`lib/proxy.mjs` `rtdbLatency`.

**Guarded SYNC-T.** syncHttp's workers send with Node's own http, outside
`createHttp`, so pass the target and syncHttp does what createHttp does for
each of them, before any worker exists:

```js
import { staticWarmUrl } from "../../lib/workers.mjs";
const requests = agents.map((a, i) => ({
  url: `${ctx.target.origin}/mcp`, method: "POST", body: callJson(i), warm: staticWarmUrl(ctx.target),
  headers: { authorization: `Bearer ${a.token}`, accept: ACCEPT, "content-type": "application/json" },
}));
const run = await syncHttp(requests, { target: ctx.target, timeoutMs: 150_000 });   // no guardSync() of your own
requireConclusive(ctx, { spread: run, overlap: run.overlap });
```

**Warm a racer's socket on a static file.** A warm-up only opens each
racer's keep-alive socket before the barrier. `GET /config` is the
appConfig FUNCTION, so N racers warmed there start up to N more
Functions-emulator workers, about 216 MB each and never reaped (measured:
a 3-racer race warmed on `/config` took appConfig from 0 workers to 3;
warmed on the static file, 0 to 0). `lib/workers.mjs`
`staticWarmUrl(target)` → `<origin>/site.webmanifest` (`STATIC_WARM_PATH`,
`app/public/site.webmanifest`, which Hosting serves from the built app with
no function) opens the socket and starts nothing; on a local stack it
throws when the file is not in the stack's `app/dist`. Warm the FUNCTION's
workers, where a race needs them warm, with requests the function answers
without changing anything, after `admitWorkers` (Concurrency specs, Memory
per N).

`syncHttp(requests, {target = null, guard = true, evidence = undefined,
actor = "sync", allowPorts = [], leadMs = 25, timeoutMs = 60_000, kind =
"http"})`, a request `{url, method = "GET", headers, body, warm?, actor?}`:

- every request AND its warm-up goes through http.mjs
  `assertReachable(target, url, allowPorts)` first (`E2E_ISOLATION`), then
  the guard: `guard: true` is `createGuard(target)`, or pass a `{check(req)}`
  of your own; it is asked `{method, url, headers, body, actor}` exactly as
  sent. One refusal writes its row (`guard: {refused, rule, reason}`) and
  throws `E2E_GUARD` (`rule`, `verdict`) with NOTHING sent, not even the
  allowed requests' warm-ups. The guard cannot be turned off for a target
  (`guard: false` is a TypeError); locally it allows everything anyway;
- each hop goes with `User-Agent` and `X-Bikeshed-Agent:
  bikeshed-e2e/<runId>` unless the request names its own;
- each hop sent, warm-up included, is one redacted row (http.mjs
  `traceLine`: `{t, seq, pid, actor, method, url, reqHeaders, reqBody,
  status, ms, resHeaders, resBody | error, sync: {i, warm, firedAt?,
  sentAt?, firstByteAt?, endAt?}}`) in the sink a client with that
  `evidence` writes to: by default the running case's, so `ctx.requests()`
  has them. A warm-up is pending until the barrier opens, a request until
  it is answered (`ctx.requests({pending: true})`). A warm-up that failed on
  the wire is a row with its `error` (its actor never fires, as before). A
  row that would still hold a credential is withheld and syncHttp throws
  `E2E_REDACTION` after writing the others. A syncHttp row is the one with a
  `sync` key (a createHttp row has none). In the case's own store
  (`ctx.ev.http`, its http.jsonl) evidence.mjs `redact` then replaces a
  `cookie`, `set-cookie` or `authorization` value WHOLE, so
  `__session=‹redacted›` reads `<redacted:20>` there: an oracle on a row
  asserts that the secret is absent, never the shape of its redaction. A
  request authenticated by a session cookie (`headers: {cookie:
  s.http.jar.header(url)}`) goes and is traced like a Bearer one;
- `actor` labels the rows (a request's own `actor` wins); the result gains
  `guarded: true`.

Without `target` syncHttp is the old one, unchecked, unguarded and
untraced, with one difference: a request or warm-up whose host is not
loopback is refused (`E2E_GUARD`, rule `sync-unguarded`) before anything is
sent. `guard`, `evidence`, `actor` or `allowPorts` without `target` is a
TypeError. A body is a string, a Buffer or Uint8Array (sent as its bytes:
until 2026-10-13 a Buffer reached the worker as a plain Uint8Array and went
out as the JSON of its indices), or a value sent as its JSON. A binary body
needs nothing more: POST /thumb's JPEGs as `application/octet-stream` go
byte for byte, guarded or not, a Uint8Array window as exactly its window,
and the row records it as `<N bytes sha256:…>`
(`selftest/sync-binary.test.mjs`, on C17c's own bodies; proved live: two
covers raced into POST /thumb, one stored, served byte-equal). No base64
detour through `syncActors` is needed. `syncActors`
takes `onRelease(releasedAt)`, called just before the barrier opens, and a
prepare's own `state.e2eReport` comes back as `report` beside its result.

The listen gate, also `lib/sync.mjs`, makes a race between the frame and a
Firestore read (the version record, the document's meta) deterministic from
the client, with the product untouched: `holdListen(host, match = () =>
true, ms = null)` → `Promise<{heldAt, records, release(), stop()}>` holds
each of the browser's Firestore listen POSTs that `match` for `ms` from the
moment it is held (`ms: null`: until `release()`), and lets everything else
through at once. `host` is a Page, a BrowserContext or a User (its page).
`match(decodedBody, {messages, url, method})` sees the body DECODED: the web
SDK sends each listen request form-encoded on one WebChannel
(`count=…&ofs=…&req0___data__=<JSON>`), where `/docs/<id>/versions` is
percent-encoded and no raw match finds it; `messages` holds each
`req<N>___data__` parsed (`decodeListenBody(raw)` → `{decoded, messages}`
does the same for you). A predicate that throws holds nothing; a GET (the back
channel) always goes through. The channel sends one POST at a time, so a held
POST also holds the requests queued behind it. Everything goes on with
`route.fallback()`, so the isolation tripwire still judges it. `heldAt` (live)
is the `Date.now()` of each hold, `records` (live) `[{i, at, releasedAt, url,
body, messages}]`, `release()` lets everything held so far go (later matches
are still held), and `stop()` releases, removes the route and resolves
`records`: call it in `finally`. `LISTEN_CHANNEL` is the path,
`/google.firestore.v1.Firestore/Listen/channel`.

```js
const gate = await holdListen(u.page, (b) => b.includes(`/docs/${docId}`) && b.includes('"collectionId":"versions"'), 8_000);
try {
  await u.open(docId);
  await eventually(() => gate.heldAt.length > 0, { timeout: 10_000, message: "the version read reaches the gate" });
  // … what the page shows while the version record is late
} finally {
  await gate.stop();
}
```

**The plan's server settle** ("server and mail: counts stable for 10 s"),
which five concurrency specs each wrote by hand, is `lib/assert.mjs`
`settleStill(read, {quietMs = 10_000, deadlineMs = 120_000, intervalMs =
1_000, what = "the records", key = JSON.stringify, step = null})` → the
value: `read()` every `intervalMs` until `key(value)` has not changed for
`quietMs`, and the last value read. Every change restarts the window, a
value that comes back to an earlier one included. Pass a projection as
`key` to compare part of a value while getting all of it, and `step:
ctx.step` for a line when it settles. Running out of `deadlineMs` is
`E2E_SETTLE_TIMEOUT`, worded as a wait (`<what>: did not hold still for
<quietMs> ms within <deadlineMs> ms (…): <last key>`), so `pageStall` and
`functionKill` may excuse it under load and it FAILS on a stack that kept
answering (an `assert.ok` there is never excusable); it carries `value`,
`reads`, `changes`, `waitedMs`, `stillMs`, `quietMs`, `deadlineMs`, `what`.
A read that throws is thrown at once, unchanged, never retried; the
deadline is checked between reads. `SETTLE_QUIET_MS` (10,000),
`SETTLE_DEADLINE_MS` (120,000), `SETTLE_INTERVAL_MS` (1,000).
`selftest/settle-still.test.mjs` pins it, the wait included, through the
real functionKill.

```js
const state = await settleStill(() => feedbackState(docId), { what: "C14 threads and versions", step: ctx.step });
const out = await settleStill(() => readOutcome(stage), { key: (o) => JSON.stringify([o.anns.map((a) => a.state), o.draft.hash]), deadlineMs: 90_000 });
```

`lib/assert.mjs`: `eventually(fn, {timeout, interval, stableSamples})`,
`expectStatus`, `checkHeaders`, `cacheControl`, `assertHeaderMatrix`,
`sameHeadersExceptDate`, `sameBytes`, and `lineHunks(expected, actual)` →
`[{line, expected: [...], got: [...]}]`, a line diff for a byte oracle:
`assert.deepEqual(lineHunks(want, got), [], "…")` fails with only the
differences, where comparing two whole documents prints both. `[]` exactly
when the texts are equal; `line` is the 1-based line of `expected` where the
hunk begins (for a pure insertion, the line it goes before). The differing
middle is diffed by longest common subsequence, so a moved line is one
removal and one addition; one larger than `LINE_HUNKS_MAX_CELLS` (4,000,000
lines × lines) is a single hunk. Lines split on `"\n"` only (a CRLF
difference shows as the `"\r"`); strings or Buffers (UTF-8).

### Concurrency specs (C1–C23)

A concurrency spec is `e2e/specs/concurrency/<scenario>.spec.mjs` and runs
only in its own tier:

```bash
node e2e/run.mjs run --suite concurrency --spec c01-typing.spec.mjs --n 2 --trials 2     # build a stack, run, stop it (authoring: shared lock)
node e2e/run.mjs run --suite concurrency --rtdb-proxy --patches amplify-mint-join --n 2,5   # with the proxy and the gates (measurement: exclusive)
node e2e/run.mjs run --attach <runId> --suite concurrency --spec c01-typing.spec.mjs --n 5 --trials 1   # N=5: exclusive
```

- **The tier lock and the load gate.** A concurrency run is one of two
  kinds (`lib/locks.mjs` `tierLockMode`):
  - an **authoring** run, every N `--n` selects at most 2
    (`AUTHORING_MAX_N`) and `--trials` at most 2 (`AUTHORING_MAX_TRIALS`),
    e.g. `--n 2 --trials 2` or `--n 1,2 --trials 1`, takes the SHARED tier
    lock, like a functional run: authors validate in parallel, beside the
    functional runs, and wait while a measurement run holds the lock;
  - every other run is a **measurement** run and takes the EXCLUSIVE lock:
    no `--n` (every N the specs declare, up to 20), an N of 3 or more, no
    `--trials` (the plan-default trials, 10 at N=2), or more than 2 trials.
    It waits until no shared run (functional, smoke, or an authoring
    concurrency run) holds the lock anywhere on the machine, and while it
    holds it no new shared run starts.

  The mode changes the lock and nothing else. Every concurrency run then
  waits for the 1-minute load to fall below `--max-load` (8), and the memory
  gate and the stack cap apply to its stack as to any. Keep the defaults;
  never raise one to get a run through. A gate that never opens ends the run
  with exit 3, and every wait is a line in the run's output. The run logs
  the lock it takes and why (`concurrency: the SHARED tier lock — authoring
  run: --n 2 --trials 2 …`) and records it in its results: `locks` in
  invocation.json and results.json (`{concurrency: {mode, authoring,
  reason, acquiredAt, waitedMs}}`), a `Tier locks: concurrency EXCLUSIVE
  (measurement run: …)` line in summary.md, and the mode in the
  invocation's row of merged.md, so a measurement run is visibly
  exclusive. A scenario without `n` is not selected by `--n`: in an
  authoring run its body must join at most 2 editors too, or declare `n`.
  Never run a concurrency spec against the stack the functional authors
  share.

  `tierLockMode(tier, {n = null, trials = null} = {})` → `{tier, mode:
  "shared" | "exclusive", authoring, reason}`: `n` is the `--n` list as
  numbers (null: no `--n`), `trials` the `--trials` number (null: none);
  smoke and functional are always shared; an unknown tier throws.
  `report.mjs` `tierLocksLine(locks, {brief = false} = {})` → the
  `Tier locks: …` line (null when nothing was recorded), with the
  concurrency reason unless `brief`, a wait of a second or more, and
  "never taken" for a lock the run planned but never got.
- **N and K.** Declare `n: [2, 5, 10, 20]` and leave `trials` out: a
  scenario with `n` in `specs/concurrency/`, or in a scratch file run with
  `--spec-file … --suite concurrency`, runs the plan's K per N,
  `PLAN_TRIALS` = 10/5/3/3 (`trials: "plan"` says it anywhere; a number or
  `{N: k}` still wins). `--n` picks the N; `--trials <k>` (`E2E_TRIALS`)
  makes every scenario k trials per N while you author (validate at N=2
  with `--trials 2`, which shares the tier lock, and at N=5 with `--trials
  1`, which takes it alone). With more than one trial
  the cases are named `… [N=5] #k`. The file budget counts the same cases:
  `lib/budget.mjs` `isConcurrencySpec(file, env)` is the one predicate, and
  run.mjs gives the budget the tier it runs the files as.
- **Memory at N >= 10.** Before the body of a case with N >= 10 on a local
  stack, scenario() waits (up to `E2E_POOL_WAIT_MS`) until the pool's need
  for N contexts and the stack's growth, N × `E2E_STACK_PEER_MB` (700), are
  available (`lib/load.mjs` `admitLive`); no room is INCONCLUSIVE. See
  "Memory per N" below.
- **A failed sync precondition is INCONCLUSIVE, never FAIL**: a peer that
  never shows "Shared", a gate that never held its callers (`requireHeld`),
  a fire spread or overlap that did not hold (`requireConclusive`), a
  presence that never showed. Call `ctx.inconclusive(reason)`; never
  `precondition` for these (that FAILS).
- **Did two trigger runs overlap?** A race inside a Firestore trigger (I11's
  cooldown claim in `onCommentCreated`, I15's log writers) is a race only
  if two runs of it ran at once, and the Functions emulator rarely does
  that: of 1222 stack logs under `e2e/.out` (2026-10-13), 1131 ran a
  Firestore trigger and only 7 ever ran two at once (2 of them two
  `onCommentCreated` runs), while 854 ran two HTTP functions at once. Read
  `caseFunctionRuns(ctx)` (`lib/logs.mjs`, Reading the stack) after the
  server settle and call `ctx.inconclusive` unless `peak.<trigger>` is 2
  or more; its counts are lower bounds, so a 2 is certain.
- **A natural race that held but never reached the defect's window is NOT
  REPRODUCED**: `ctx.notReproduced(reason)` in the `defect:` case (C9's
  natural update race, where S4 needs a losing upload to end after the
  winner's). Never "passed unexpectedly" (the defect looks fixed) and
  never INCONCLUSIVE (exit 3 in half the trials). summary.md then reads
  `<scenario> [N=2]: S4 seen in s of K trials` (Results), over the K
  trials of the run; keep `measure()` rows for what each trial saw.
- **After a run, the Database emulator's own log** is in
  `e2e/.out/<runId>/logs/database-debug.log` (Reading the stack): whether
  the emulator warned, failed or restarted inside a case's window, by ISO
  time. It holds no per-connection lines; a dropped socket shows in
  presence read over the window or through `--rtdb-proxy`.

**Joining N editors** (`lib/live.mjs`):

```js
import { joinShared, settleLive, probeArrivals, typeProbe } from "../../lib/live.mjs";
const { docId, users, owner, accounts } = await joinShared(ctx, { n: ctx.n });   // all "Shared", or INCONCLUSIVE
```

`joinShared(ctx, {n, fixture = "crdt-paragraphs.html", body = null,
filename = null, title, batch = 5, enter = true, waitShared = true,
seedFirst = true, sharedMs = 90_000, openMs = 90_000, grantVia = null,
role = "editor", extra = [], notifications = undefined, beforeJoin = null,
impl = null, mirror = "stop"})` → `{docId, owner, accounts, users, names,
joinMs, grantVia, role, extra, staged[, mirrored]}`: an owner and n−1 editors cast, the fixture published and shared for editing, `ceil(n/5)`
Chromes × 5 contexts, sign-in through the UI five at a time, the document
opened five at a time, and edit entered: the owner alone until its seed is
in `status/{d}/y` (read through a 503, `rtdbGetPatient`), then the rest
five at a time. Two FIRST joins at once both seed and the document doubles
(S1, C4's subject), which `seedFirst: false` allows. `users[0]` is the
owner; the users are named `p1`…`pN` (a token's peer). `enter: false` stops
in reading mode, before any entering and before the seed precondition, for
a case that enters each editor itself (staggered joins; a seed the rules
refuse, S10, never reaches the log).

A generated document joins the same way: `body` (a non-empty string or
Buffer: a cut of a fixture, a size) is published in place of the fixture,
as `filename` (`"index.html"` unless named), and wins over `fixture`.
Without a body, the fixture goes exactly as before, under its own name.
`joinPublishOptions({fixture, body, filename})` → `{options, label}` is that
decision (what reaches `seed.mjs` `publish`, which would read a fixture IN
PLACE of a body passed beside it, and the step's wording).

```js
const { docId, users } = await joinShared(ctx, { n: ctx.n, body: largeCut(10), title: "C7 size control", enter: false });
```

**Joiners in another role, accounts with no browser, a document staged
before anyone opens it** (C10b, C10c: approvers deciding suggestions that
are already pending when the editor opens):

```js
const { docId, users, extra: [sug], staged } = await joinShared(ctx, {
  n: ctx.n, role: "approver", extra: [{ role: "suggester" }], notifications: false,
  beforeJoin: async ({ docId, extra: [s] }) => makeSuggestions(await openSession(ctx.target, s.account), docId),
});
```

- `role` is what every joiner but the owner is granted: `"editor"` (the
  default: the old labels, `editor-pK`, and the old grant call exactly), or
  `"approver"`. A role that cannot edit live (`"viewer"`, `"suggester"`) is
  a TypeError unless `enter: false`, since such a joiner would never show
  "Shared". The cast labels follow it (`approver-p2`).
- `extra: [{role, grant = true, name = role}]` casts accounts that get no
  browser, after the joiners, in the same `cast()`. Each is granted its own
  `role` (one of grant.mjs `ROLES`) in the SAME grant request as the joiners:
  one `POST /access` with mixed roles locally, `share()` per account through
  the operator script elsewhere. `grant: false` makes an account with no
  grant at all (a link holder; `role` is then only its label). They come
  back as `extra: [{name, role, grant, account}]`; `accounts` and `users`
  stay the joiners'. On the operator path only a JOINER's missing mirror
  (S16) stops the join; an extra never writes the live log, and grant.mjs
  has recorded its missing mirror in findings.jsonl anyway.
- `notifications: false` casts every account (joiners and extras) opted out
  of email (`cast()`'s option); left out, cast gets `{http}` alone, as
  before.
- `beforeJoin({docId, owner, accounts, extra, publish})` runs once the
  document is published and every grant made, and before any browser is
  made: what it stages (pending suggestions, comments, a second version) is
  there when the editors open the document. `publish` is seed.mjs publish's
  answer (`{status, docId, versionId, …}`). Its value comes back as
  `staged`; a throw propagates, with no browser made.
- Everything is checked before anything is cast (a TypeError, or
  `E2E_LOCAL_ONLY` for `grantVia: "access"` off a local stack).
  `joinAccountsPlan({n, role, extra, enter, notifications})` → `{labels,
  roles, extra, cast}` is that decision: the cast labels in order, one role
  per grantee for grantEditors (null when no extra is granted, so the
  joiners' grant is the old call), the extras, and cast's extra options.
- `impl` (a self-test's): `{cast, openSession, publish, signInMany, share,
  shareMany}` in place of the modules, all six or none
  (`selftest/live-join-roles.test.mjs` drives joinShared with them).

`grantEditors`' `roles` serves a case that stages without browsers too (an
agents-only case: approvers' MCP tokens and a suggester), on any target:

```js
await grantEditors(ctx.target, { owner, doc: docId, accounts: [...approvers, suggester], roles: [...approvers.map(() => "approver"), "suggester"] });
```

**How the editors are granted, on each target.** On a local stack,
`joinShared` grants every editor in ONE `POST /access` (`shareMany`: the
product's one-request path, which invites each into Mailpit). Anywhere else
that endpoint would email them, so it calls `share()` once per editor
through the operator script (`scripts/set-access.mjs`, no email), one after
another. `grantVia: "operator"` takes that production path on a local stack
too (the stack tree's script against its emulators), which is how it is
proved without production; `grantVia: "access"` off a local stack throws
`E2E_LOCAL_ONLY` before anything is made. The result's `grantVia` says which
ran. A C-scenario whose only email is joinShared's no longer needs
`effects: ["email:POST /access"]` to stay off production.

**Suspect S16 stops the operator path today, locally too.** set-access.mjs
writes no RTDB mirror: `scripts/lib/firebase.mjs` starts its Admin app with
no `databaseURL`, firebase-admin then cannot make a Database handle ("Can't
determine Firebase Database URL", with the emulator host set or not), and
`getRtdb()` answers null. An editor without its `editAccess` mirror still
shows "Shared", while every write it makes to the live log is
`PERMISSION_DENIED` and its keystrokes never reach anyone (measured on
2026-10-13). So on the operator path, when a granted editor's mirror reads
back missing (grant.mjs has already recorded it in `findings.jsonl`, suspect
S16), `joinShared` ends the case INCONCLUSIVE before any browser is made: "the
sync precondition did not hold: after scripts/set-access.mjs granted <d>,
the RTDB mirror (presenceAccess/editAccess) of <emails> is missing (suspect
S16 …)". That is the default (`mirror: "stop"`), and with it C-scenarios on
production end that way until S16 is fixed. The local `POST /access` path
is unchanged, and the product writes the mirror on it.

**`mirror: "write-missing"` gets past it, as the plan prescribes.** Once
every grant is made, the harness writes the document's mirror from its
record, as the product's grant path would have (`lib/grant.mjs`
`writeMirror`: per-node ETag compare-and-set through its own narrow guard,
for run documents and run accounts only; see THE MIRROR, WRITTEN BY THE
HARNESS under Seed, fixtures and grants), reads every missing grantee's
mirror back, records `mirror-written` beside the S16 finding, steps
`suspect S16: scripts/set-access.mjs left the RTDB mirror of <emails>
missing …; the harness wrote presenceAccess/<d> and editAccess/<d> from
docs/<d> …`, and the join goes on. A joiner's mirror STILL missing after
the write ("… and after the harness wrote it from docs/<d> the mirror of
<emails> still reads …"), or a write the database did not take
(`E2E_MIRROR`: "… and the harness could not write it: …"), is the same
INCONCLUSIVE, before any browser; a guard refusal (`E2E_GUARD`) is thrown,
never INCONCLUSIVE. The result gains `mirrored` (grantEditors' below; null
when nothing was written). Only the operator path writes: on `POST /access`
the product writes the mirror itself, and that is what a local case
measures. So a C-scenario that passes `mirror: "write-missing"` measures
S16's runtime half on production (an agent's write refused or let through
while an editor is open: `liveEditing` outside the emulator) instead of
stopping at its grant half. Locally, `grantVia: "operator"` with it proves
the path (lib-changes.md).

The two halves are exported. `joinGrantVia(target, via = null)` → `"access"
| "operator"` is the decision: null picks by target, `"access"` off a local
stack is `E2E_LOCAL_ONLY`, and any other value is a TypeError.
`grantEditors(target, {owner, doc, accounts, role = "editor", roles = null,
via = null, timeoutMs = 120_000, impl = null, mirror = "stop"})` → `{via, requests, results,
missing[, mirrored]}` grants as `joinShared` does. `roles` (one per account, in order)
gives each account its own role in place of `role`: still ONE `shareMany`
locally, `share()` per account with its own role on the operator path; a
list that is not one non-empty string per account is a TypeError before
anything is sent. `requests` counts POSTs or script runs.
`results` holds grant.mjs's answers, in order. `missing` is `[{email,
mirror}]`, one per account whose mirror was read back and is not what its
role needs. An empty list sends nothing. `impl` is a self-test's
`{share, shareMany}`.

`mirror` (`MIRROR_MODES`): `"stop"`, the default, is all of the above, and
the result has exactly those four keys. `"write-missing"` adds `mirrored`:
on the operator path, when any account's mirror read back missing, ONCE
after every grant (the write replaces both nodes with what the record says,
so between grants it would be stale), `writeMirror(target, {doc})` and then
`readMirror` again for each missing account, with its own role:
`mirrored` = `{written: true, docId, write (writeMirror's answer), accounts:
[{email, role, before, after}], ok}` (`ok`: every `after` ok). Nothing
missing, or the access path, is `mirrored: null`, with nothing written.
`missing` still lists what the grants left (the S16 evidence).
writeMirror's errors propagate (`E2E_GUARD`, `E2E_MIRROR`). With a stand-in
`impl`, `"write-missing"` needs its `writeMirror` and `readMirror` too (a
TypeError before anything is sent, so a self-test never reaches a real
database). A mode that is neither is a TypeError.

**One more person** (C18's phone, C22's reader who stays reading, C23's
link holder, a serial control's late arrival, C4b's joiner). `joinShared`
makes every user a desktop context and every joiner a granted editor who
enters edit with the rest; one person who is none of those joins after it:

```js
const PHONE = { width: 400, height: 800, touch: true };
const { docId, owner, users } = await joinShared(ctx, { n: ctx.n - 1, enter: false });
const { user: phone } = await addMember(ctx, { owner, docId, name: `p${ctx.n}`, device: PHONE });          // an editor, on a phone, reading
const { user: holder } = await addMember(ctx, { owner, docId, name: "link", role: null, k: linkToken });  // no grant: the link and its key
```

`addMember(ctx, {owner, docId, name, role = "editor", label = null, device =
null, k = null, via = null, open = true, openMs = 90_000, notifications =
undefined, timeoutMs = 120_000, impl = null, mirror = "stop"})` → `{account, user, role,
grantVia, granted, signIn, opened}` (`lib/live.mjs`):

- **Who.** One account, cast as `label` (default `<role>-<name>`, the label
  `joinShared` gives its pK; `link-<name>` without a role: a short
  lower-case word, since it starts the email), granted `role` on `docId`
  exactly as `joinShared` grants (`grantEditors`: one `POST /access`
  locally, `share()` through the operator script anywhere else; `via`
  forces one, `joinGrantVia`'s rules). Any of grant.mjs's four roles, since
  it never enters edit; `role: null` grants nothing at all (a link holder,
  and `via` is then a TypeError). `granted` is grantEditors' answer (null
  without a role), `grantVia` its path.
- **The S16 stop.** On the operator path, a mirror that reads back not what
  `role` needs ends the case INCONCLUSIVE before any browser is made,
  whatever the role: this person's page writes its presence (an editing
  role its live writes too). The local path does not stop on it, as
  `joinShared`'s does not. With `mirror: "write-missing"` the harness
  writes the mirror first, as `joinShared` does (`granted.mirrored` says
  what), and only a mirror still not what `role` needs after the write, or
  a write the database did not take, stops it; `impl` then also has
  `writeMirror` and `readMirror`.
- **Its browser.** Then, and only then, `ctx.users.user({name, device,
  consent: "denied"})` (through the pool's memory gate; `device` as
  `checkDevice` takes it, null the desktop), signed in through the UI
  (`signIn`, User.signInUi's answer: anything but "ok" throws), and the
  document opened with `k` as `?k=` when given (`opened`, open()'s answer;
  the key is never in a step). It is left READING: the case presses Edit
  itself when its scenario says so (`u.enterEdit`, or `u.awaitEdit` after
  a press made elsewhere). `open: false` stops once signed in (C4b's
  joiner, granted later), and `k` beside it is a TypeError.
- **Checked first.** Every argument is checked before anything is cast:
  `docId`, `name` (not already a user of this case: evidence files are
  named after it), `role`, the label, `k`, `open`, `openMs`, `timeoutMs`,
  `notifications`, `impl`, `owner` (required with a role), the device
  (`checkDevice`), and `via` (`E2E_LOCAL_ONLY` for "access" off a local
  stack). `impl` is a self-test's `{cast, share, shareMany}`
  (`selftest/live-add-member.test.mjs`).

**Settling** — `settleLive(users, {docId, n = users.length, deadlineMs,
minLength = 1, requireShared = true, readBodies})` → `{ms, hash, samples, saveStates,
shareStates, lastDraftAt, yEntries}` waits for the plan's settle conditions
at once: I1 on 3 consecutive samples, on bodies of at least `minLength`
characters (equal EMPTY bodies are not convergence; give a baseline's length
when the scenario only adds text); nothing `dirty` or `saving` and no save
`error` (a failed `POST /draft`, which nothing retries without new input);
every peer that entered edit (the User's `inEdit`, or a save state seen
while waiting) still shows a save state and "Shared"; no `POST /draft` for
3 s from any peer; and `status/{d}/y` stable for 2 s. A peer that never
entered edit is judged on its body only. The deadline is `SETTLE_DEADLINES_MS`: 15,
20, 30 and 60 s for N = 2, 5, 10 and 20 (`settleDeadlineMs(n)`: the next
larger listed N). A missed deadline is an I1 FAILURE, an AssertionError
`I1: the live session of N peer(s) on <d> did not settle within … : <what
was still unsettled>` — never INCONCLUSIVE. `SETTLE` holds the constants.
With no `readY`, y is read through a 503 (`rtdbGetPatient`, below). The
result's `yRetries` counts the 503s it read through, and a failure message
names them. When 503s last past 5 s, settleLive throws
`E2E_RTDB_UNAVAILABLE`, not an I1 failure. A `readY` of your own is used as
given.

For idle readers after Done, `readBodies(users)` may sample authored DOM with
`readerBodyHash(frame)`: each reader's known presence decoration is different
by design. The sampler removes only the independently pinned `data-bshd` values;
unknown values and all authored content remain. C6 uses this sampler while
retaining every deadline and save/log condition above. Live editors still use
raw `bodyHash`, and persisted draft/version bytes still face DECOR unchanged.
`selftest/reader-body.test.mjs` demonstrates both raw-overlay false divergence
and an overbroad marker strip concealing real authored differences.

**One editor settles too** (C9b: one editor beside N−1 agents). `settleLive([u],
{docId})` judges every condition above except I1's convergence, which needs
two peers: in its place, its own body has the same hash on 3 consecutive
samples (and is at least `minLength` long). Nothing dirty, saving or in
error, still in edit and "Shared", no `POST /draft` for 3 s and `status/{d}/y`
stable for 2 s all hold as for N. The result gains `alone: true` and
`peers: 1` (`alone: false`, `peers: N` for two or more, which are judged on I1
exactly as before), and `hash` is that body's. A missed deadline is the same
I1 AssertionError, `… (N=1; one peer: its body's stability in place of
convergence): …`. No user at all is a TypeError. The deadline for one is
N=2's (15 s) unless you pass `n`.

**Reading the live log through a 503.** The Database emulator has answered
a harness read of `status/{d}/y` with 503 "Firebase database instance is
inactive" under load (run 2610130353-9akl), and a case that threw on it
FAILED on the oracle's own read. `rtdbGetPatient(target, path, {retryMs =
5_000, intervalMs = 500, read = null, onRetry = null, now = Date.now})` →
the value is `admin.mjs` `rtdbGet` made again while the Database answers
503, until `retryMs` have passed since the first. Any other error is thrown
at once, unchanged. 503s past `retryMs` throw `E2E_RTDB_UNAVAILABLE`, which
carries a `stackCut` (plus `cause`, `attempts`, `path` and `ms`). A case
with `inconclusiveOnStackTimeout` therefore ends INCONCLUSIVE ("the stack
did not answer"), and any other case fails naming it. `retryMs: 0` gives up
on the first 503. `read(target, path)` replaces rtdbGet, and `onRetry(err,
attempt)` hears each retry. `isRtdbUnavailable(err)` → boolean is the test:
an Error whose message has rtdbGet's `: 503`, never an assertion.
`RTDB_RETRY = {retryMs: 5_000, intervalMs: 500}`. settleLive and
joinShared's seed wait read y this way. Use it for your own reads of the
live log (`status/{d}/y`, `status/{d}/peers`) in place of a hand-rolled
retry:

```js
const y = await rtdbGetPatient(ctx.target, `status/${docId}/y`);
```

**Every value of the live log, not samples.** `rtdbGetPatient` reads the
log once. A removal of the whole `status/{d}/y` that typing editors refill
within milliseconds falls between two reads, however often you poll. To
judge "the log was never emptied" over a window, watch it instead:
``watchRtdb(ctx.target, `status/${docId}/y`)`` (`lib/admin.mjs`, under
Reading the stack) keeps every value the Admin SDK's listener raises,
`{t, n, exists}` per row, and needs `closeAdmin(target)` in `after()`.

**Probes** — `typeProbe(user, selector, text, {delay})` → `{after, inputs}`
types like a person and gives the page-clock time of the last `input`
event; `probeArrivals(users, {from, id, text, timeoutMs})` → `{after,
arrivals: [{name, shared, ms}]}` arms every other peer first and measures
each arrival (null: not within `timeoutMs`). Latency is recorded, never
asserted locally: local N=20 measures the emulator.
`probeArrivals(users, {from, id, text, timeoutMs = 15_000, delay = 0,
anywhere = false})`: `anywhere: true` arms each peer anywhere in its body
(`armArrival(u, null, text)`) rather than in `#id`, for a body that may be
doubled (S1, S27, C4): a token typed into the typist's first `#id` can be in
another peer's second copy, where a probe by id never sees it and reports a
false "never arrived". `from` still types at the end of its own first
`#id`; a non-boolean `anywhere` is a TypeError.

**Rates** — a case that counts rounds (how many duplicated, at which press
offset, how long each settle took) appends a row per round with
`measure(ctx, "<spec name>", row)` (`lib/evidence.mjs`, under the evidence
paragraph above) to `<invocation>/<spec name>.jsonl`: a PASS keeps no
evidence and the reporter no diagnostic line, so this is where a serial
control's rate, or a fixed build's, survives. A known defect's rate over
the trials needs no rows: summary.md counts it from the outcomes (`S4
seen in s of K trials`, NOT REPRODUCED and TODO, under Results).

**Entering edit at once** — a press made in the page (`syncPages`) or one
whose `/draft/` frame is held (`holdRequests`) is followed by
`u.awaitEdit({waitShared})`, never `enterEdit`, which would press again (see
Users and the browser).

**One editor in two tabs** (S21, C11b) — `e.newTab()` is a second page of
`e`'s own context, so the same account, and so the same presence node
(`status/{d}/peers/{uid}`, app/src/presence.ts), driven as a User of its
own (see One person in two tabs, under Users and the browser). Each tab's `inEdit`, autosave waits, captures and delays are its
own. The tab is not one of `joinShared`'s `users`: pass it to `settleLive`
or `inputClocks` yourself when it edits.

**Input clocks** — the race proof of a typing race under the RTDB proxy's
window (C2, C3, C5): every client→database byte is held for `windowMs`, so
edits that all fall inside it were all made before any of them could reach
another peer. `inputClocks(users)` → `{names, read()}` arms a recorder on
each user's document frame (capture phase, nothing written to the document;
a user without a same-origin frame throws, and the recorders already armed
come off). From then on it counts each `input` event and its page-clock
time: a peer's own keystrokes, Backspace and paste, never a remote merge
(which changes the DOM without one), never input before arming.
`read()` stops every recorder and resolves `{inputs: [{name, n, first,
last, replaced, lost}], first, last, spanMs, silent, problems}` (the same
object on every later call). `replaced`: the frame's document is not the
one armed (a reload, a remount, edit mode left), so later input went
unrecorded; `lost`: the page navigated or closed, so nothing is known.
`problems` says in words why the records cannot prove a race: a silent
peer, a replaced frame, a lost page. `inputSpan(inputs)` → `{first, last,
spanMs, silent, problems}` is the same judgement over saved records:
`spanMs` runs from the earliest input of ANY peer to the latest of any
(null when nobody typed).

```js
const clocks = await inputClocks(users);
await lat.set({ up: windowMs, down: 0 });
… every peer's edits, at once …
const r = await clocks.read();
ctx.ev.json("race", r);
if (r.problems.length || !(r.spanMs < windowMs - 300)) ctx.inconclusive(`the race did not hold: ${[...r.problems, `span ${r.spanMs} ms`].join("; ")}`);
await lat.reset();
ctx.ev.json("drain", await lat.drained());   // what the window queued is delivered (RTDB latency, below); then settleLive
```

**Invariants** (`lib/invariants.mjs`): one pure judge per invariant, each
returning `{invariant, ok, failures}`, and `assertInvariant(result)`, which
throws an AssertionError `I<k>: <failures>` (a `defect:` case's own oracle,
so a TODO there, a FAIL anywhere else). `INVARIANTS` holds the plan's
sentences.

| | judge | readers |
|---|---|---|
| I1 | `checkI1(samples)`, `checkI1Stable(series, {samples: 3})` | `readI1(users)` → `[{name, hash, length}]` |
| I2 | `checkI2({peers: {name: segments}, draft, typed})` (tokens.mjs `analyseTokens`) | `readSegments(user, ids)`, `segmentsOfHtml(page, html, ids)` |
| I3 | `checkI3({peers: {name: {sentinels, children}}, baseline})` | `readI3(frameOrPage, {sentinelId})`, `readI3All(users)` |
| I4 | `checkI4({peers, draft, typed, deletedTexts})` (absent tokens from `tokenLog().expectAbsent`) | as I2 |
| I5 | `checkI5({draftHash, peerHashes, decoration, bodyAttr})` | bytes.mjs `diffFingerprint`, `bodyAttrDiff` |
| I6 | `checkI6(versions, {base})` | `readVersions(target, docId)` |
| I7 | `checkI7({rehash, recordHash, storedSha, winnerSha})` | bytes.mjs `rehashVersion` |
| I8 | `checkI8({draftText, draftHtml = null, accepted: [{annId, replacement, elementId?, text?, exact?}]})` → `+{entries}` (in place: below) | `elementText(html, id)` → string \| null |
| I9 | `checkI9({suggestions: [{annId, insertions, notes}], losers: [{status, json}]})` | |
| I10 | `checkI10({flips, notes, initial, final})` | |
| I11 | `checkI11({messages: [{to, docId, kind, at}], eligible, windowMs})` | `mailbox(target).settleKinds({people, title, eligible})` (its `messages`); logs.mjs `caseFunctionRuns(ctx)` (did two `onCommentCreated` runs overlap) |
| I12 | `checkI12(peers, {docId, waitedMs})` | `waitI12(target, docId, {since, timeoutMs = 5000})` |
| I13 | `checkI13({arrivals, limitMs = 2000})` | `probeArrivals` |
| I14 | `checkI14({members, editorMembers, presenceAccess, editAccess, revokedWrites})` | admin.mjs `rtdbGet`, rtdb.mjs `rtdbAs` |
| I15 | `checkI15({events: [{id, kind}], expected})` | changes.mjs `startPoller`, `logAfter`, `feedToLogIds`; logs.mjs `caseFunctionRuns(ctx)` (did the log writers' runs overlap) |
| I16 | `checkI16({stored, computed, access})` | `expectedMembership(owner, grants, parent, teams)` (scripts/lib/membership.mjs) |

**I8 in place.** Counting a replacement in the draft's text passes one put
beside a quote it kept, or into another paragraph (`controls-c10-i8-in-place`
plants the first). SPEC §22 says more: an accept replaces exactly that span,
so the quote's element must read its old text with that one span replaced.
Give `checkI8` the draft's source and, for each accepted change, the element
its quote stands in:

```js
assertInvariant(checkI8({
  draftText,                       // what each replacement is counted in, as before
  draftHtml: draft.html,           // the draft's source
  accepted: suggestions.map((s) => ({
    annId: s.annId, replacement: s.replacement,
    elementId: s.anchor.elementId, // the element the quote stands in
    text: v1Text[s.anchor.elementId], // that element's text before the accept: elementText(v1Html, id)
    exact: s.anchor.exact,         // the quote; it must stand once in `text`
  })),
}));
```

- Every entry is counted as before (`<annId>: its replacement is in the
  draft <n> time(s), not once`). An entry counted once whose element does
  not read `text` with `exact` replaced by it then fails as `<annId>: its
  replacement is in the draft once, but not in place: #<elementId> reads
  "<what it reads>", not its text with "<exact>" replaced by
  "<replacement>"` (`(no such element, or more than one)` when the id is
  missing or doubled). Count failures come first.
- An entry without `elementId`, `text` and `exact` is judged by its count
  alone, exactly as before; give all three or none. Leave them out for an
  element something else also edits (typing in the same paragraph): in
  place is strict, the whole element's text.
- The result's `entries` `[{annId, count, elementId, reads, expected,
  shape}]` say what each change looks like: `shape` `"in place"` (counted
  once, the element reads `expected`), `"absent"` (counted 0 and its element
  reads its old text, untouched: the lost update S5 and S17 predict) or
  `"other"`; the last four are null for an entry judged by its count alone.
  A judge tagged with a suspect that predicts an absence can refuse any
  `"other"` as not the predicted shape.
- A TypeError, never a verdict: some but not all of the three fields; a
  quote that does not stand exactly once in `text` (which span it replaced
  is then unknown); an entry naming an element without `draftHtml`; two
  entries naming one element; a `draftHtml` that is not a string; an empty
  replacement (judge a deletion by its quote).
- `elementText(html, id)` reads the one element with that id from a
  document's source as its `textContent` would read once a browser parsed
  it (comments skipped, raw text and RCDATA, void and foreign self-closed
  elements, character references, the parser's implied ends for p, li,
  dt, dd and headings, a table in quirks mode, template contents left out),
  or null when no element, or more than one, has that id. Pure and
  synchronous, no browser. Its self-test checks it against Chrome's own
  parse of every element of every e2e fixture and of each edge case;
  table foster parenting and the adoption agency are not modelled.

**Gates (SYNC-P, SYNC-G)** make an interleaving deterministic from inside
the product. An amplify set, `e2e/patches/amplify-<name>/`, holds `*.patch`
files and an `amplify.json` naming each gate (`{what, gates: [{name, side:
"server" | "client", where, key}]}`), and is applied to a stack COPY only,
like any set (`--patches amplify-<name>`, `git apply --check` first). Its
patches add `await e2eGate("<name>", docId)` at the chosen points. A stack
built with one (or with `--gates`) runs the gate service in its aux process
on the block role `gate`, and gives the functions `E2E_GATE_URL` and the app
build `VITE_E2E_GATE_URL` (a stack port, which the browser tripwire
allows). Both helpers FAIL CLOSED: without their URL, or when the service
answers anything but 200, they throw, so a patched stack never goes on as
if it had paused. Capability `gates`, plus `patch:amplify-<name>`.

```js
import { gates, requireHeld } from "../../lib/gates.mjs";
const g = gates(ctx.target);
await g.hold("mint-after-upload", { key: docId });          // its callers for this document now wait
const calls = sessions.map((s) => s.http.postJson("/commit", { docId, baseVersion: "v1" }));
await requireHeld(ctx, g, "mint-after-upload", calls.length, { key: docId });   // or INCONCLUSIVE
await g.release("mint-after-upload");                       // all of them, in one tick
// g.release(name, {count: 1}) lets the first to arrive go alone (FIFO) and keeps the gate armed
```

**A gated race in one call** — `holdCalls(ctx, g, {gate, key, send,
whileHeld = null, timeoutMs = 90_000, graceMs = 300, ttlMs})` → `{answers,
during, held, release}` (`lib/gates.mjs`) is the whole of it at a SERVER
gate, with the INCONCLUSIVE rules in one place:

```js
const g = gates(ctx.target);
const out = await holdCalls(ctx, g, {
  gate: "comment-before-write", key: docId,
  send: () => agents.map((a, i) => a.mcp.call("add_comment", commentArgs(i))),   // the calls, already sent
  whileHeld: () => publisher.mcp.call("commit_draft", { id: docId }),            // what they race
});
// out.answers: each call's value, in order; out.during: whileHeld's value
```

It arms `gate` for `key` alone (never every key: a TypeError without one),
sends, and waits until all the calls are held (`timeoutMs`; never held:
INCONCLUSIVE, naming any call that had already answered, which never reached
the gate). After `graceMs` it is INCONCLUSIVE if any call answered (it was
not held); then `whileHeld({held})` runs, and it is INCONCLUSIVE if any
answered meanwhile (a hold that expired); then ONE release for `key`, which
must let exactly the calls go (more: another caller of that key was held too,
INCONCLUSIVE). A call that rejected is thrown after all have settled,
unchanged (a cut-off keeps its shape). The gate is released for `key` in a
`finally`, whatever happened. `ctx.step` hears "all N call(s) are held …"
and "one release … let all N go together". A CLIENT gate is a TypeError (a
page calls its gate once per run of its effect, so releases do not count
joiners: `requireJoinersHeld`). `HOLD_CALLS_WAIT_MS` (90,000),
`HOLD_CALLS_GRACE_MS` (300). `selftest/hold-calls.test.mjs` pins every rule
against the real gate service.

`gates(target)` → `{url, hold(name, {key, ttlMs, armMs}), waitHeld(name, n,
{timeoutMs = 30_000, key, distinct}) → {held, callers, distinctCallers},
release(name, {count, disarm, key}) → {released, at, held, armed},
releaseCaller(name, {key, caller = null, disarm}) → {caller, released,
latest, at, held, armed}, counts({key}) → {name: {armed, key, held,
arrived, passed, released, expired, aborted, lastRelease}}, releaseAll()}`. A held caller goes on by
itself after `ttlMs` (90 s, at most `GATE_HOLD_MAX_MS` 120 s: outcome
`expired`), an armed gate disarms after `armMs` (10 min, at most 15), and a
caller that hangs up is dropped: a spec that dies holding a gate cannot
wedge the stack. Release what you hold in a `finally`. `waitHeld` that runs
out throws `E2E_GATE_TIMEOUT`.

- **Arming is per (name, key).** Two cases holding the same gate for two
  documents never touch each other: a release with no key releases only
  the keys that client armed (`counts({key})` reads one key's counts). An
  arming for every key (no key) while a key is armed, or the reverse, is
  refused 409 (`E2E_GATE`, `status` 409).
- **Callers are told apart.** Each call names its caller: the client
  helper one id per page and a `run` per call, the server helper one id per
  request. `callers` is `[{seq, key, side, caller, run, at, latest}]`.
  `waitHeld(name, n, {distinct: "caller"})` waits for n CALLERS, each with
  its latest run held: every run of a hook's effect calls the gate (a frame
  reload re-runs it while the first call is held), so one joiner can be
  held twice. `requireHeld` does this by itself at a client gate
  (`gateSide(name)` from amplify.json), so "both joiners held" means two
  joiners. A stack whose aux process predates caller identity answers
  without it, and a distinct wait throws `E2E_GATE` (restart the stack).
- **A forced simultaneous join** (S1, C4) needs more than that: a joiner's
  first held run is not the one that binds. The join effect runs when edit
  mode starts and again when the draft frame loads, and only the
  second binds; live, the second call came 13 ms and 616 ms after the
  first. `requireJoinersHeld(ctx, g, users, {key})` (`lib/live.mjs`) waits
  for the distinct callers, then every joiner's loaded `/draft/` frame,
  then the distinct callers again, so each is held by its binding run;
  then `g.release("join-before-bind")`. Input stays disabled until binding,
  so this precondition must not wait for `contenteditable=true`. Start the
  joiners with
  `u.enterEdit({waitShared: true})` without awaiting it first, as the
  canary's gate case does.
- **One joiner at a time** (a serial control at a client gate):
  `g.releaseCaller(name, {key, caller = null, disarm})` lets ONE caller go,
  every held run of `caller` (its latest and the superseded runs before
  it) in one tick, and nobody else's; with no `caller`, the caller whose
  latest run has been held longest. A release by `count` counts FIFO
  positions across callers: a superseded run of one joiner ahead of
  another's binding run, or a call that expires or hangs up between reading
  the queue and releasing, moves it onto the wrong joiner. The gate stays
  armed unless `disarm: true`; `key` defaults to the one key this client
  armed (it armed several: name one). It resolves `{caller (null when no
  caller's latest run was held: nothing was released), released (FIFO,
  each with `latest`), latest (whether the caller's latest run went), at,
  held, armed}`. An aux process older than this answers 405, which throws
  `E2E_GATE` (restart the stack); it never falls back to a release by
  position.

  ```js
  await requireJoinersHeld(ctx, g, users, { key: docId });
  for (let k = 0; k < users.length; k += 1) {
    const r = await g.releaseCaller("join-before-bind", { key: docId });
    if (!r.caller || !r.latest) ctx.inconclusive(`no binding run held for release ${k + 1}`);
    // … wait for that joiner's "Shared" and its seed on the others' sockets before the next
  }
  ```

The committed set is `amplify-mint-join`:

| gate | side | where |
|---|---|---|
| `mint-before-id` | server | `commitDraft`, after the dedup query, before the version id is chosen |
| `mint-after-upload` | server | `commitDraft`, between the upload of v(N+1)/ and the transaction |
| `join-before-bind` | client | `useSharedDocument`, after `log.ready()`, before `bindSync` |

A new set: `amplify-<name>/NN-<what>.patch` and its `amplify.json`.
`readAmplify(set)` checks the metadata, and `selftest/gates.test.mjs`
checks every gate named is called.

**Several amplify sets on one stack** (`--patches amplify-mint-join
--patches amplify-c10-accept`). The two gate helpers,
`functions/src/lib/e2eGate.ts` and `app/src/e2eGate.ts` (`lib/patch.mjs`
`SHARED_GATE_HELPERS`), are added by more than one set: amplify-mint-join
adds both, amplify-c10-accept and amplify-c13-feedback the server one. Each
set carries its own copy, so each applies alone. Named together, a helper
goes into the tree ONCE: when a set's patch adds one that an earlier set
already put there, and the two copies are the same file but for the
header's second line (which names the set: `helperBody(text)` is the text
without it), `applyPatchSet` applies that patch with the path excluded
(`git apply --exclude=<path>`, in the check and in the apply). The tree
keeps the first set's copy, and the later set's result lists it:
`{set, applied, shared: [{file, path, from}]}` (`shared` only when
something was excluded; one set alone gives the old `{set, applied}`). A
copy whose BODY differs is a harness error, `E2E_PATCH` (`… adds <path>,
which the set <from> already put in the stack tree with a different body
…`), before anything of that set is applied: make them the same, or give
the set a helper of its own, as amplify-c08-mint-races (`e2eRaceGate.ts`),
amplify-c12-update, amplify-c16-access and amplify-c17-identity do. Any
other file a set adds that the tree already holds is refused by `git apply`
as before. `patchNewFiles(text)` → `[{path, content}]` reads what a patch
creates, as git writes it (`selftest/patch-shared-helpers.test.mjs` pins it
against git for every committed set).

Every pair of committed amplify sets applies together, in either order,
with every gate of both called, except **amplify-c13-feedback with
amplify-mint-join**: both add their pause point and their `import { e2eGate
} from "./e2eGate"` at the same place in `functions/src/lib/draft.ts`, so
the second does not apply (and would import twice if it did). That is the
sets' own conflict, not the helper's; the self-test lets that pair fail
only on draft.ts. All the other six sets apply together on one stack (the
server helper shared once), and the functions typecheck that way (checked
for mint-join + c10, c10 + mint-join, c10 + c13 and the six together on
2026-10-13).

**RTDB latency** — `--rtdb-proxy` builds the app to dial the Database
emulator through a raw TCP proxy (`lib/proxy.mjs`) in the stack's aux
process, on the block role `rtdbProxy`; `verifyBuild` refuses a bundle
that dials anything else. Delay is 0 until a spec sets it, per direction,
from the next byte on (a FIFO: nothing is reordered):

```js
import { rtdbLatency } from "../../lib/proxy.mjs";
const lat = rtdbLatency(ctx.target);                 // capability rtdb-proxy
await lat.set({ up: 300, down: 0 });                 // client→database bytes 300 ms late, for every browser
try { … } finally { await lat.reset(); }
```

`rtdbLatency(target)` → `{port, controlUrl, set({up, down}), get(),
reset(), drop() → number, stats() → {delay, stats}, drained({timeoutMs =
65_000, intervalMs = 50}) → {ms, polls, atStart, delay, stats},
roundTrip({via = "proxy" | "direct", samples = 3}) → {ms, samples}}`.

**What a window leaves queued.** Setting the delay back to 0 sends nothing
early: each direction is a FIFO, a chunk is due at max(arrival + delay, the
previous chunk's due), and a chunk that arrives after the reset waits
behind those queued before it. So bytes a page sent while a window was set
(its compaction's append and removal, set off by acks that came back
before the reset) reach the database up to a window AFTER the reset, and
nothing outside the proxy sees them waiting: a settle at N=5 once
finished 0.8 s before they arrived (run 2610131218-fgf7). After `reset()`,
`await lat.drained()` before settling. It reads `GET /proxy/stats` every
`intervalMs` until nothing is queued either way on any connection and no
byte is held by the address rewriter (every byte has been WRITTEN to its
far socket; the database applies it after, which settleLive's
`status/{d}/y` stability then covers: live, 18 new live-log keys within 1
s of it), and resolves `{ms, polls, atStart, delay, stats}`: `atStart` is the first reading (`drainState`'s `{empty,
queued: {up, down}, queuedBytes: {up, down}, held}`, what was still in the
proxy), `stats` the last. Running out of `timeoutMs` (`DRAIN_WAIT_MS`, 65
s: the longest delay a direction may have, and 5 s) throws
`E2E_PROXY_DRAIN`, the harness's own failure and never a wait the stack
ran out of, with `state`, `atStart`, `delay`, `polls` and `ms`; its message
says when a delay is still set (steady traffic under a delay never leaves
the queues empty: reset first). A bad `timeoutMs` (1–600000) or
`intervalMs` (1–5000) is a TypeError. The counters are in `stats` too:
`queued` `{up, down}` (chunks queued now, every connection's),
`queuedBytes` `{up, down}` and `held` (bytes); `drainState(stats)` →
that reading, or null for stats without them, which is what an aux process
started before 2026-10-13's change answers: `drained()` then throws
`E2E_PROXY` (stop the stack and start it again). `startProxy()`'s own
proxy has the same `drained()` (its stats read in-process), and
`hostRewriter()`'s object a `held` getter. `DRAIN_POLL_MS` is 50.

```js
await lat.set({ up: windowMs, down: 0 });
try { … the race … } finally { await lat.reset(); }
const drain = await lat.drained();          // {ms, atStart: {queued: {up, down}, …}, …}
ctx.ev.json("proxy-drain", drain);
await settleLive(users, { docId });
```

The Database server
names its own address in two control messages: the handshake that opens
every connection, and a RESET, which tells a client the host to dial next.
The web SDK the app bundles ignores the handshake's host under
`connectDatabaseEmulator` (as the app connects) but obeys a reset's: every
later connection of that page dials it. The emulator resets every live
client to its own address when a namespace fails (Known harness facts), so
the proxy rewrites the address to its own in EVERY control message of
every connection, and a page's reconnects come back through the proxy and
its delay. Until 2026-10-13 it rewrote only the first occurrence in each
connection, which the handshake took, and a later reset went through: run
2610131148-8csa failed a C4 case with 48 breaches that way. Data is left
exactly as the server sent it: an address inside data is counted, never
rewritten. `stats` gains `upgrades` (connections answered `101`),
`rewriteKinds: {handshake, reset, control, stream}` (what `rewrites`
counted: `stream` is an answer that is not a `101`, long polling, rewritten
as bytes), `hostsInData` and `compressedFrames` (frames it could not read;
the emulator negotiates no deflate, so 0). When a page's RTDB connection
matters to a case, put `(await lat.stats()).stats` in its evidence
(`ctx.ev.json`): handshakes and resets against connections and upgrades say
whether every page stayed on the proxy. An aux process started before this
change answers without `upgrades`: stop that stack and start it again.
`lib/proxy.mjs` `hostRewriter(pairs, emit, {holdMs = REWRITE_HOLD_MS,
headMax = REWRITE_WINDOW_BYTES, frameMax = CONTROL_FRAME_MAX_BYTES, count})`
→ `{push(chunk), flush(), stop()}` (`count(what, n)` hears each occurrence
rewritten, by kind, and `"data"`, `"compressed"`, `"upgrade"`) is that
down-stream filter, exported for
`selftest/proxy-rewrite-all.test.mjs`: it reads the down stream as HTTP, a
`101` answer frame by frame (a whole, unfragmented, uncompressed text frame
of up to `CONTROL_FRAME_MAX_BYTES`, 4096, is held until whole and parsed;
any other frame passes as it comes), and any other answer as bytes, whose
tail that may begin the address waits up to `REWRITE_HOLD_MS` (25).
`REWRITE_WINDOW_BYTES` (4096) is now the most of an HTTP head it holds.
On such a stack the browser tripwire calls
the emulator's own port a breach, so a bypass fails the case. `drop()`
destroys every connection through the proxy, as a network failure would
(each page reconnects; `stats.connections` counts it). A half-close travels
through the queue: bytes a peer sent before it closed still arrive, after
their delay. `rtdbDelayEffect(lat, {up, down})`
(`lib/live.mjs`) measures the REST round trip through the proxy before and
with the delay and resets it; `checkDelayEffect({baselineMs, delayedMs,
expectedMs, slackMs})` judges "grew by about the delay". The Admin SDK,
`rtdbGet`, `rtdbAs` and the functions still reach the emulator directly.
The proxy is stack-wide: set the delay back in a `finally`.

**Memory per N.** One user is a Chrome context; `joinShared` makes
`ceil(N/5)` Chromes. The pool's memory gate asks for 2 GB plus 600 MB per
context before it makes them (`E2E_POOL_BASE_GB`, `E2E_POOL_CONTEXT_MB`),
and a pool that never gets room ends its case INCONCLUSIVE after
`E2E_POOL_WAIT_MS`. `startRssSampler(target, {everyMs, file})` → `stop()` →
`{samples, peak: {stackBytes, browserBytes, totalBytes, at}, peakBy}`
samples the stack's marked processes and this process's Chromes; the
canary writes it to `<invocation>/rss.jsonl` (`rssFile()`). Measured by
`specs/concurrency/canary.spec.mjs` on a fresh stack:

| N | Chromes × contexts | stack RSS at the peak | browsers' RSS at the peak | peak total |
|---|---|---|---|---|
| 2 | 1 × 2 (+ a parser context) | 3.9 GB (Functions workers 2.8 GB) | 1.8 GB | 5.7 GB |
| 5 | 1 × 5 (+ a parser context) | 5.0 GB (`other`, mostly Functions workers, 3.8 GB) | 3.7 GB | 8.8 GB |
| 10 | 2 × 5 (+ a parser context) | 5.3 GB (`other`, mostly Functions workers, 4.1 GB) | 6.5 GB | 11.8 GB |
| 20 | 4 × 5 (+ a parser context, a fifth Chrome) | 14.5–15.3 GB (Functions workers 13.5–13.7 GB, 62 or more of them) | 9.8–12.3 GB | 24.3–27.6 GB |

(N=2 and N=20: two runs on 2026-10-13, 2610130058-1tjm and 2610130126-207g:
the N=20 case joined in 14–27 s, the probe reached every peer in under 10
ms, and the session settled in 5–9 s. N=5 and N=10: one run each on
2026-10-13, 2610130250-zujw, a `--rtdb-proxy --patches amplify-mint-join`
stack that had already run the canary at N=2, so its stack figure includes
that; 4 samples each at 3 s, so a short peak may be missed.) The browsers used 0.5–0.6 GB per context and
the stack grew by about 0.6 GB per peer, so the reservations follow the
measurement (tightened on 2026-10-13; they were 2 GB + 300 MB × N, 8 GB at
N=20, about half the footprint):

| N | pool: 2 GB + N × 600 MB | stack growth: N × 700 MB (N >= 10 only) | reserved before the body | measured peak total |
|---|---|---|---|---|
| 2 | 3.2 GB | — | (the pool's own gate) | 5.7 GB, with the stack's 3.9 GB already running |
| 5 | 4.9 GB | — | (the pool's own gate) | 8.8 GB (browsers 3.7 GB) |
| 10 | 7.9 GB | 6.8 GB | 14.7 GB | 11.8 GB (browsers 6.5 GB) |
| 20 | 13.7 GB | 13.7 GB | 27.4 GB | 24.3–27.6 GB |

The stack admission's 8 GB is for a stack's start; the growth reserve is
what a live case at N >= 10 waits for on top (`admitLive`), and a wait
that never opens is INCONCLUSIVE.

The Functions workers are most of a stack (about 216 MB each, and the
emulator starts more under load). Never raise a memory limit to make room:
wait, or stop your other stack.

**Function workers in an HTTP-only case** (`lib/workers.mjs`). A burst of
k concurrent requests to one function leaves k Functions-emulator workers
(`node …/functionsEmulatorRuntime`, `FUNCTION_TARGET=<entry point>`, about
216 MB each), which the emulator never reaps; a burst to another function
adds k more. An HTTP-only file (C17, C19, C20) at N=5 peaked at a stack RSS
of 11.46 GB (58 processes) with no browser at all. The live reservation
above is per PEER and only from N=10, so a burst reserves for itself, and
the idle workers can be handed back between bursts:

```js
import { admitWorkers, functionWorkers, retireIdleWorkers } from "../../lib/workers.mjs";
await admitWorkers(ctx, { requests: 2 * burst, what: "C19a's warm-up and burst" });   // or INCONCLUSIVE
… the warm-up (requests the function answers without changing anything), the race, the server settle …
ctx.ev.json("workers", functionWorkers(ctx.target));                                  // what the stack holds now
ctx.step((await retireIdleWorkers(ctx.target)).summary);                             // between bursts, never mid-race
```

- `admitWorkers(ctx, {requests, what = null, timeoutMs = null, pollMs =
  5000, sample = null, logFile, env})` → `{ok, needBytes, waitedMs, sample,
  skipped?}`. On a local stack it waits (up to `E2E_POOL_WAIT_MS`, as a
  browser pool does; gate `function-workers` in the invocation's
  load.jsonl) until `workerNeedBytes(requests)` is available: the pool's
  headroom `E2E_POOL_BASE_GB` (2 GB) plus `requests` × 250 MB. No room ends
  the case INCONCLUSIVE (`the machine never had room for <what>: it needs
  … (2 GB + k × 250 MB, one Functions-emulator worker per concurrent
  request), and has …`); a wait is a step. Count every request that may
  start a worker: a warm-up's and a race's to a function not yet warm. Any
  other target resolves at once (`skipped`: its workers are Cloud Run
  instances, not this machine's). `FUNCTION_WORKER_MB` is 250 (measured:
  216), and `E2E_FUNCTION_WORKER_MB` may only RAISE it: a lower value
  throws. `functionWorkerBytes(env)` and `workerNeedBytes(requests,
  {thresholds, workerBytes})` are the figures; `WORKERS_GATE` the gate name.
- `functionWorkers(target, {mark, scan})` → `{mark, count, rssBytes,
  workers: [{pid, entryPoint, rssBytes}], byEntryPoint: {<entry point>:
  {count, rssBytes}}}` (null off a local stack): every process carrying the
  stack's mark whose command runs the worker runtime (`WORKER_RUNTIME`).
- `retireIdleWorkers(target, {timeoutMs = 60000, settleMs = 5000, pollMs =
  250, env, scan, fetchImpl, now})` → `{reloaded, status, line, before:
  {count, rssBytes}, after, retired: [{pid, entryPoint, rssBytes}],
  remaining, started, ms, summary[, reason]}`. It asks the stack's own
  Emulator Hub to reload the Functions emulator's triggers (`PUT
  /functions/enableBackgroundTriggers`, `RELOAD_PATH`: the hub's public
  route, which awaits `reloadTriggers()` and then answers 200), then waits
  up to `settleMs` for the workers it found to exit. The reload kills every
  IDLE worker and lets a BUSY one finish its request first (`remaining`);
  the harness signals nothing. Background (Firestore) triggers stay
  registered: proved live, `recordVersionEvent` logged a new version 773 ms
  after a reload. The reload takes about 11 s (it rediscovers every
  trigger), and the next request to each function cold-starts. It is
  stack-wide, so it is refused (`E2E_SHARED_STACK`) outside the
  concurrency tier and belongs between bursts, after the case's server
  settle, never while another case on the stack is racing. `line` is the
  emulator's `Loaded functions definitions from source` line
  (`RELOAD_LINE_RE`) when its log already holds it; `reloaded: false` with
  `reason` when the hub refuses or does not answer within `timeoutMs`;
  `{reloaded: false, skipped}` off a local stack. Measured live on a fresh
  stack: 9 of 9 idle workers retired (1.9 GB) in 10.7 s, 0 left, and the
  functions answered at once afterwards on new workers.
- The emulator also reloads when a file under `functions/` changes, but
  its watcher ignores every path with a segment starting with a dot,
  tested on the WHOLE path, and every stack tree lives under
  `~/.cache/bikeshed-e2e/stacks/`: no change in a stack's tree ever reloads
  anything (measured: none in 60 s). Use the hub.
- Warm a racer's SOCKET on `staticWarmUrl(target)` (Synchronisation),
  never on `GET /config`, which is a function.

**The canary** (`specs/concurrency/canary.spec.mjs`): N editors converge
on a probe (N = 2…20), the proxy's delay shows (`rtdb-proxy`), the gates
hold and release (`patch:amplify-mint-join`), and one canary per invariant
whose negative control is committed (I2, I3, I6, I12). The tier runs its
files in name order, so the canary does not run first by itself: run it
first (`--spec canary.spec.mjs`, on a stack built with `--rtdb-proxy
--patches amplify-mint-join` so nothing in it is skipped). If it fails, the
C-scenarios say nothing. Its join-gate case shows S1 every time (two joiners
released together after an empty `log.ready()` both seed: sentinel ×2, 82
top-level elements for 41): recorded there, judged by C4. Until 2026-10-13
its "both joiners held" counted held CALLS, which one joiner whose effect
re-ran could meet alone (4 held calls for 2 joiners were seen); it now
waits for two distinct callers, each with its latest run held
(`requireHeld` at a client gate), and C4 must do the same.

### Spare ports

A listener of your own (an OAuth receiver, a latency proxy) must be on one of
the stack's ports — the browser's isolation tripwire allows nothing else — and
must not collide with another spec file doing the same. Claim one from the
pool (`lib/spare.mjs`, capability `spare-pool`):

```js
await withSparePort(ctx.target, async (port) => { /* listen on 127.0.0.1:port */ });
// or: const c = await claimSparePort(ctx.target, {purpose: "my-listener"}); try { … } finally { c.release(); }
```

Claims are exclusive across every process attached to the stack (one lock
file per port in the run directory), a dead claimer's claim is taken over, and
when all nine are taken a claim waits (up to `SPARE_TIMEOUT_MS`, 120 s) rather
than collide. `startReceiver({target})` and `startProxy({target, upstreamPort})`
claim and release by themselves (a `via: "route"` receiver binds nothing and
claims nothing). `spareClaims(target)` lists the holders.

### Capabilities

Declare what a case needs with `needs`: `local`, `email` or `email-off`,
`mailpit`, `admin-emulator`, `oob-codes`, `reset`, `logs`, `patches`, and on
stacks this harness version builds `egress-guard`, `spare-pool`, `gates`
and `rtdb-proxy` (with those options: the aux process),
`mail-fail-recipient`, `mail-hold-recipient`, `operator-scripts`, `resource-caps` (JVM heap caps,
capped debug logs, an owner, a lease and a watchdog), `rtdb-rules` (readiness proved
`ns=<projectId>` enforces the tree's RTDB rules; an older stack lacks it even
if someone has since loaded them, which `rtdbRulesStatus` checks live),
`storage-preconditions` (readiness proved the functions' Storage refuses a
second create-only write and copy; below), `storage-shim` (with
`--storage-shim`: the aux runs the Storage shim and readiness proved the
function workers dial it; below), plus
`measurement-id` and `export-mark-default` with those options, and
`patch:<set>` for every patch set the tree was built with (`--patches <set>`;
`patchCapability(set)` in `lib/options.mjs` writes it). `requireCapability(target, …)` throws
`E2E_CAPABILITY` from a body.

`"!<capability>"` in `needs` is one the target must NOT have: the case is
skipped where it is present, `needs no <capability> (the local target has
it)`. So a case that exists only on a plain stack and one that exists only
on a patched one each skip on the other's, declaratively:

```js
scenario("A19.2 … no measurement id …", { tiers: ["local"], needs: ["!measurement-id"] }, …);
scenario("A19.2 … id built in, under emulators …", { tiers: ["local"], needs: ["measurement-id", "!patch:a19-analytics-live"] }, …);
scenario("A19.2 … analytics live …", { needs: ["measurement-id", "patch:a19-analytics-live"] }, …);
```

A `!` that names nothing (`"!"`, `"!!x"`) throws as the spec loads
(`splitNeeds(needs)` → `{want, refuse}` in `lib/test.mjs`). `target.patches`
lists the sets in the order they were applied; for a `target.json` written
before that field, `loadTarget` reads them (and adds their `patch:<set>`)
from the run's `stack.json` (`recordedPatchSets(runDir)`), and it is `null`
only when neither says. A spec never reads `stack.json` itself. To gate a
case on a patch set, write `needs: [patchCapability(set)]` or `needs:
["!" + patchCapability(set)]`; to read the list, use `target.patches`.

**`storage-preconditions`.** The product writes a new document's bytes
`CREATE_ONLY` (`functions/src/lib/publish.ts`: `ifGenerationMatch: 0`), so
two creates racing at one id rely on Storage refusing the second with 412,
which moves it to a suffixed id (SPEC §4); a fork's copy goes the same way
(`fork.ts`, SPEC §21). Cloud Storage implements generation preconditions.
The Storage emulator of firebase-tools 15.25.1 has none at all (no
`ifGenerationMatch` anywhere in its sources): it accepts both, and the last
bytes win. So NO plain local stack has this capability, and a case whose
property rests on the refusal (C17a same id, the one-click forks, a fix
proof for a lost create) declares `needs: ["storage-preconditions"]` and is
SKIPPED there (`needs storage-preconditions (the local target lacks
it)`), declaratively, rather than probing and ending INCONCLUSIVE. A stack
built with `--storage-shim` puts the Storage shim in front of the emulator
for the functions; its readiness probe goes through the shim, finds both
refused, and the stack HAS the capability, so such cases run there:

```bash
node e2e/run.mjs run --suite concurrency --storage-shim --spec c17-identity.spec.mjs --n 2 --trials 1
```

A production target (a later phase) advertises it without probing: its
bucket is never probed. Readiness records `storagePreconditions` in
`stack.json`; only `honoured === true` gives the capability, and a stack
started before the probe has none.

- `probeStoragePreconditions({storageUrl, bucket, label = null, fetchImpl =
  fetch, timeoutMs = 5000})` → `{honoured: true | false | null, write:
  {first, second, after, refused, kept, honoured, reason}, copy: {source,
  destination, rewrite, after, refused, kept, honoured, reason}, prefix,
  cleaned, left, reason, ms}`: a write made twice with `ifGenerationMatch=0`
  and read back, and a rewrite with `ifGenerationMatch=0` onto an existing
  object, read back (the path the Node SDK takes under
  `STORAGE_EMULATOR_HOST`), as the emulator's admin, under
  `e2e-probe/storage-preconditions/<label>-<hex>/` (`STORAGE_PROBE_PREFIX`),
  every object deleted after. `honoured` is true only when both answered
  412 and kept the first bytes; false when either was accepted; null when
  it could not tell (a refused set-up write, any other status, no answer),
  which never gives the capability. Loopback emulators only: any other
  `storageUrl` is a TypeError before a request. It never throws otherwise.
- `storagePreconditionsStatus(target, {fetchImpl, timeoutMs})` → `{checked:
  true, via: "shim" | "emulator", storageUrl, ...probe}` live on the Storage
  a local stack's functions use (its shim with `--storage-shim`, else its
  emulator; the port must be one of the stack's own); `{checked: false,
  honoured: null, reason}` on any other target. For a case that wants to
  say so itself: `if (!s.honoured) ctx.inconclusive(s.reason)`.
- `storagePreconditionsLine(r)`: the start log's line.
  `STORAGE_PRECONDITIONS` (the capability's name), `STORAGE_ADMIN_BEARER`.

Measured on a fresh stack: the readiness probe took 15 ms (both accepted,
cleaned), and the product's own client (firebase-admin's
`file.save(…, CREATE_ONLY)` twice, `file.copy(…, CREATE_ONLY)` onto an
existing object) was accepted the same way.

**`storage-shim`** (`--storage-shim`, `lib/storage-shim.mjs`). The aux
process runs an HTTP proxy on the block role `storageShim` in front of the
Storage emulator, and the stack's function workers dial it instead of the
emulator. What it does with each request (`storageRequestKind`):

- Every write of a named object — an upload (`POST
  /upload/storage/v1/b/<b>/o?name=<n>`, media or multipart: the Node SDK's
  simple upload, which every product write uses), a rewrite or copy's
  destination (`POST /b/<sb>/o/<s>/rewriteTo/b/<b>/o/<n>`, the SDK's
  `copy()`; `copyTo` and the `/storage/v1` form too), a delete, a patch, a
  resumable upload's `PUT` under `?name=` — takes that object's LOCK (one
  FIFO mutex per bucket and name) and holds it until the emulator's answer
  has ended. Writes of one object never interleave; other objects never
  wait.
- A write with `ifGenerationMatch=<g>` (upload, rewrite, copy) is JUDGED
  under the lock: the shim reads the object's metadata as the emulator's
  admin, and the precondition holds when g is 0 and the object does not
  exist, or when the object is at generation g. Held: forwarded as sent.
  Not held: 412 with Cloud Storage's body (`conditionNotMet`, header
  `x-e2e-storage-shim: refused`), and the emulator never sees it. The Node
  SDK raises that as `code: 412`, which is what `isPreconditionFailure`
  reads, so `placeNewDocument` moves the loser to a suffixed id.
- Everything else passes through unchanged and unlocked: reads, listings,
  a resumable session, bytes both ways, the status, the Host header (so
  the emulator's resumable Location names the shim).
- It refuses what it cannot judge, never passing it silently: any other
  precondition (`ifGenerationNotMatch`, `ifMetageneration*`,
  `ifSourceGeneration*`, `ifSourceMetageneration*`), any precondition on a
  read, delete, patch or resumable upload, or an `ifGenerationMatch` upload
  with no `?name=` answers 501 (`unjudged`); an `ifGenerationMatch` that
  is not a decimal generation answers 400; a metadata read that fails
  answers 503; a locked request the emulator has not answered within 120 s
  is cut off with 504.

How the functions reach it: firebase-tools sets a worker's
`STORAGE_EMULATOR_HOST` and `FIREBASE_STORAGE_EMULATOR_HOST` from its
registry AFTER the functions' `.env.local`, so no dotenv line can move
them. The emulator therefore preloads `lib/storage-shim-preload.mjs`
(copied to `<tree>/.e2e/storage-shim-preload.mjs`; a controls set may
patch the copy) after the egress guard, with `E2E_STORAGE_SHIM_HOST`,
`E2E_STORAGE_SHIM_UPSTREAM` and `E2E_STORAGE_SHIM_LOG`. Where
`FUNCTIONS_EMULATOR` is `"true"` and the Storage hosts name this stack's
emulator, it points both at the shim before the runtime loads, and writes
one line to `logs/storage-shim.jsonl` (`{t, pid, ppid, thread, target,
from, to, shim, upstream, redirected, already, why}`); anywhere else it
changes nothing. Readiness requires a worker's line naming the shim.

NOT through it: the harness's Admin client (`adminFor`, `listObjects`,
`seed`), the operator scripts and a spec's `STORAGE_EMULATOR_HOST` keep
the emulator's own port (`target.storageUrl`), and the browser never talks
to Storage. Their writes are neither locked nor judged; reads see the
same bytes (the shim stores nothing).

```js
import { storageShim } from "../../lib/storage-shim.mjs";
const shim = storageShim(ctx.target);              // needs: ["storage-shim"]
const { stats: before } = await shim.stats();
// … the race …
const { stats, decisions } = await shim.stats({ since: before.seq });
ctx.ev.json("storage-shim", { refused: stats.refused - before.refused, decisions });
```

- `storageShim(target, {fetchImpl})` → `{port, url, controlUrl, upstreamUrl, stats({since})}`:
  the client. `stats({since = 0})` → `Promise<{port, upstream, stats,
  decisions}>`. `stats` is `{seq, requests, open, passed, locked, waited,
  maxWaitMs, held, judged, forwarded, refused, unjudged, invalid, errors,
  timeouts}`. `decisions` are the kept decisions with `seq` above `since`
  (the last `SHIM_DECISIONS_KEPT`, 1000): `{seq, t, kind, bucket, name,
  ifGenerationMatch, current, decision: "forward" | "refuse" | "unjudged"
  | "invalid" | "error", status, waitedMs, ms, reason}`. Every decision
  but a forward is also a line of `logs/aux.log`. E2E_CAPABILITY without
  the capability; E2E_STORAGE_SHIM when the control route answers
  otherwise than 200; TypeError for a `since` that is not a whole number.
- `startStorageShim({listenPort = 0, host = "127.0.0.1", upstreamPort, upstreamHost = "127.0.0.1", metaTimeoutMs = 10000, holdMaxMs = 120000, log})`
  → `Promise<{port, host, url, upstream, stats, decisions({since}), close()}>`:
  the shim itself (the aux runs it; a self-test may start one in front of
  a stand-in). Loopback only.
- `storageRequestKind(method, url, headers)` → `{method, path, kind,
  bucket, name, source, lock, ifGenerationMatch, preconditions, judge,
  unjudged, invalid}`: the table above.
- `shimRedirects(lines, {shimPort, upstreamPort})` → `{ok, workers,
  redirected, refused, reason}` and `readStorageShimLog(file, {since})` →
  lines: what readiness reads. `installStorageShimPreload(treeDir)`,
  `describeStorageShimPreload(file)` → `{file, sha256}`,
  `storageShimEnv({preload, shimPort, upstreamPort, log, nodeOptions})`
  → the emulator's env additions (the preload after `nodeOptions`).
- Constants: `STORAGE_SHIM` (the capability), `STORAGE_SHIM_ROLE`
  (`storageShim`), `STORAGE_SHIM_SPARE` (`spare7`), `STORAGE_SHIM_ENV`,
  `STORAGE_SHIM_UPSTREAM_ENV`, `STORAGE_SHIM_LOG_ENV`,
  `STORAGE_SHIM_PRELOAD_SOURCE`, `STORAGE_SHIM_PRELOAD_IN_TREE`,
  `PRECONDITION_PARAMS`, `SHIM_DECISIONS_KEPT`, `SHIM_LOCK_HOLD_MAX_MS`,
  `SHIM_META_TIMEOUT_MS`; in `lib/stack.mjs`, `STORAGE_SHIM_ROLES` and
  `withAuxPorts(ports, {gates, rtdbProxy, storageShim})`.

Measured on fresh stacks: through the shim the readiness probe took 17 ms
(both refused, the first bytes kept, cleaned) and the target had
`storage-shim` and `storage-preconditions`; a publish's v1 `index.html`
reached Storage as a create-only upload judged and forwarded by the shim,
from a `createDoc` worker the preload had moved. c17's own C17a race and
one-click forks (N=2, two trials each) RAN and passed, and in all four the
loser's create-only write or copy was refused 412 by the shim (it waited
0–2 ms for the winner's lock) and moved to a suffixed id. The same C17a race
with its `needs` removed, on a plain stack, failed both trials: the loser
answered 500 `could not create the document`, and no suffixed document was
made.

### Adding a negative control

Every new oracle family needs a control: a patch that plants the bug the
oracle exists to catch, and the proof that the oracle then fails.

1. Make `e2e/patches/controls-<family>/` with one or more `NN-<what>.patch`
   files (unified diffs with `a/` and `b/` prefixes, relative to the tree root;
   they may patch product source or the harness's staged
   `.e2e/egress-guard.mjs`) and a `control.json`:

   ```json
   {
     "oracle": "the oracle family",
     "what": "the bug the patch plants",
     "target": { "spec": "e2e/specs/functional/<area>.spec.mjs", "case": "<the scenario's exact name>", "suite": "functional" },
     "stack": [],
     "expect": { "message": "<a RegExp the target's failure message must match>" }
   }
   ```

   `suite` (default `functional`) and `stack` (stack options such as
   `"--email-off"`, `"--rtdb-proxy"`, `"--gates"`, or `"--patches",
   "amplify-<name>"` to build both sides on an amplify set) are optional.
   An invariant's canary lives in `specs/concurrency/canary.spec.mjs` with
   `"suite": "concurrency"`.

   `case` may name one case of a scenario declared with `n`:
   `"<scenario> [N=2]"` (a trailing `" #1"` is accepted and means the
   same). When the spec does not declare that name verbatim but declares
   `"<scenario>"`, both sides run with `--n 2 --trials 1` (one trial, so
   the case is named `"<scenario> [N=2]"`, which the `--grep` selects and
   the verdict reads), and the clean side gets a stack of its own for that
   selection. A name the spec declares verbatim is always literal; `#2` or
   later is refused (one trial carries no such name). A name in double or
   single quotes counts as declared. In `lib/controls.mjs`:
   `targetSelection(control, src)` → `{case, scenario, n, trial, expanded,
   args}` decides it (`args`: `[]`, or `["--n", "<k>", "--trials", "1"]`),
   `assertTargetDeclared(control)` now returns it, and run.mjs keeps it on
   the control as `selection` (recorded in ledger.json). `greenGroups`
   groups by (suite, stack, selection args) and each group gains `args`;
   `greenRunArgs(group, {tree})` and `redRunArgs(control, {tree})` are the
   `run` arguments of the two sides; `targetCaseName(control)` is the name
   the runs give the case, which `findTarget` looks for.
   `parseExpandedCase(name)` → `{scenario, n, trial}` or null
   (`EXPANDED_CASE_RE`) and `declaresName(src, name)` are the pieces. An
   N of 3 or more makes both runs measurement runs (the exclusive tier
   lock); N=2 is an authoring run.
2. `node e2e/run.mjs controls controls-<family>` builds a clean stack (GREEN:
   the case must pass) and a patched one (RED: it must FAIL with the message),
   and writes `e2e/.out/controls-<stamp>[-<rand4>]/ledger.json` (its own
   directory, from `makeControlsDir(root, now)` in `lib/controls.mjs`, named
   by `controlsStamp(now)`, even when another `controls` started in the same
   second). Both must hold before
   the oracle counts. One family per set, so a red case names its patch.

A spec's own assertion is controlled by mutating a COPY of the spec, never
the tracked file: write it with `absoluteLibImports` to a scratch directory
(or under `e2e/.out/`), plant the bug, and run it with `run --attach <runId>
--spec-file <copy> --grep '<case>'` (see Where a spec lives). The case must
fail with the message its oracle gives; the results stay in the run's
`scratch/` directory, out of everyone's merged view.

### Shared-stack etiquette

The functional areas share long-running stacks. On one:

- A kept stack lives 4 h, and every `run --attach` makes it at least 2 h
  from then, never past 8 h after it started; `stack status` shows its
  owner, expiry, hard maximum and RSS. Its watchdog stops it at expiry,
  whoever is using it, so a run that needs longer starts its own stack, and a
  stack its watchdog stopped ends every run on it (exit 1, "stack … is
  stopped (watchdog: expired …)"). Stop a stack you started as soon as you are
  done (`stack down`): it holds one of three machine-wide slots.
- At most `E2E_MAX_STACKS` (3) stacks run on the machine, and a stack starts
  only with memory to spare; a start that finds neither waits, then exits 3.
  Attach to a stack that is up rather than start another, and never lower a
  memory threshold, raise the cap or lengthen a lease to get a run through.

- Never reset, delete or stop anything you did not create: no `resetLocal`, no
  shim `/__e2e/reset` or `/__e2e/fail-next`, no Mailpit deletes of messages
  that are not yours, no `stack down`.
- Make every id unique: accounts from `cast` (they carry the run tag and a
  random suffix), documents from `docIdFor`/`publish`, your own invitee
  addresses as `<role>-<runTag(runId)>-<rand4()>@example.com`.
- Filter everything you read by YOUR recipients, document ids and accounts:
  other specs' mail, documents and log lines are in the same places.
- Take a log mark before acting and read only after it.
- Release what you claim (spare ports, shim failures) in `finally`.

### Known harness facts

- The Database emulator (v4.11.2) can fail a whole namespace under
  concurrent rule-checked writes: a `NullPointerException` in
  `RequestContext.addRuleResult` (rules evaluation), then `Namespace failure
  for demo-bikeshed; clearing connections` and `status Active to Shutdown`
  in `logs/database-debug.log`. For 30 s the namespace is inactive: the
  pages' pending writes fail `internal_error`, the harness's REST reads
  answer 503 "Firebase database instance is inactive" (what
  `rtdbGetPatient` reads through), and every live client is RESET to the
  emulator's own address. Seen once at N=5 (run 2610131148-8csa, 18:53:06Z,
  C4 held frames): all five pages dialled the emulator's own port within
  0.6 s. A case that crosses such a window measured the emulator, not the
  product; the log names the window by ISO time.
- The web SDK (@firebase/database 1.0.8) takes a RESET's host for every
  later connection of a page (`onReset_` sets `repoInfo_.host`, so
  `internalHost`), but ignores the handshake's under
  `connectDatabaseEmulator`. The RTDB proxy therefore rewrites every control
  message, not the first (`selftest/proxy-rewrite-all.test.mjs` pins both).
- firebase-tools deletes `firebase-debug.log` when `emulators:start` exits
  with a code under 2, which a teardown's SIGINT is: no stopped stack's
  tree has one, a kept failed tree included. The Database emulator's
  records are kept in `logs/database-debug.log`; nothing else of that file
  outlives the stack.
- Never let an assertion print a `User`, a Playwright `Page` or a context:
  `assert.equal(tab.tabOf, u)` or `assert.deepEqual(u.tabs, [b])` that FAILS
  makes node inspect both sides, and a User's inspection walks the whole
  Playwright graph. A self-test that failed that way grew for 140 s until
  the OS killed it (exit 137): no output at all, and its Chrome orphaned.
  Compare identity with `assert.ok(a === b, "…")` and print names.
- The Hosting emulator cuts a function off at 60 s and answers 504 itself
  (60,005–60,010 ms measured), and http.mjs's default deadline is the same
  60 s, so a function that overruns reads as either. Neither is the
  product's answer. `inconclusiveOnStackTimeout` (scenario()) ends such a
  case INCONCLUSIVE; a wait longer than a minute shows which of the two it
  was.
- Playwright's own drag (`page.mouse` with the button down) hangs over the
  app's scriptless reading frame; `User.drag` and `User.selectText` send raw
  CDP mouse events instead.
- A page has ONE CPU throttling rate: the last that any CDP session set.
  Detaching a session that set one puts the page back to full speed, even
  while another session's throttle is meant to be in force (measured with
  Chrome 154). So a helper that opens a session, throttles, and detaches it
  at its restore ends every other throttle on that page too. `User.throttleCpu`
  keeps one session per page, never detaches it, and stacks the calls.
- The stack is `http://127.0.0.1`, and `/session` sets a `Secure` cookie.
  Chrome stores and sends it (loopback is a secure context) and so does
  http.mjs's jar, but Playwright's `context.cookies(url)` leaves it out for an
  http URL: use `User.sessionCookie()`, which reads the unfiltered jar.
- The emulator's log flushes late — an `[email] skipped` line has appeared
  more than 30 s after its request. Wait at least 45 s for a line, and never
  assert one is absent on a shorter settle (`expectNoLog` refuses).
- `node --test --test-timeout` was a per-FILE limit on Node 22 (three 1.5 s
  cases with 10 s timeouts each, cancelled after the first at
  `--test-timeout=3000`); on Node 24.21 it is only each test's default
  timeout, and no file is cut. On both, a case without a timeout of its own
  inherits it. `run.mjs` therefore sizes it from the files' budgets and passes
  the case default separately (Time budgets).
- An account cast through the Auth REST API (without `{notifications: false}`
  or `{analytics: false}`) has no `users/{uid}` until its
  first `POST /session` (`openSession` or `signInUi`); some email paths skip
  people without one.
- The comments panel starts closed when every thread is resolved:
  `User.openComments()` first. Never press the Comments toggle yourself after
  one read of `data-comments`: the first annotation snapshot can open the panel
  in between, and your press then closes it (seen in A7.4). openComments
  re-reads and retries.
- "Suggest edit" for a refused selection is `aria-disabled`, not disabled:
  Playwright's `click` hangs on it and `force` can land on a toast lying over
  it. `User.pressSuggest()`.
- The editor's "Saved" can come from a save that began BEFORE your last key:
  an answer to a save in flight sets it while the next save is still a
  debounce away. Wait with `typeAndAutosave` or `waitForAutosave({after})`,
  never on `saveState()` alone.
- A poll cannot prove that something never showed: it reads the DOM between
  renders, and a banner that was there for one render is gone by the next
  read. `User.watchFor(selector, text)` observes every change instead, from
  each document's first script.
- The More menu's trigger is a toggle: pressing it on an open menu closes it.
  `moreMenu`, `menuGroup`, `chooseMenu` and `download` press it only while the
  menu is closed.
- **Any `Authorization: Bearer …` header is the admin in the RTDB emulator**,
  whatever follows it: `Bearer not-a-token` reads everything (200) and skips
  the rules. An RTDB request sent with a user's ID token as a Bearer header
  therefore proves nothing about the rules. Use `rtdbAs` (`lib/rtdb.mjs`),
  which sends the token only as `?auth=` and strips the header; read the
  stored truth with `rtdbAdmin` or `rtdbGet`. (Firestore is the other way
  round: there the ID token IS a Bearer header, and only `owner` is the
  admin; `clientFirestore`.)
- **The RTDB emulator never says a token is bad: it reads one as nobody.**
  Measured: an `?auth=` value that is not `header.payload.signature` with
  JSON-object header and payload, or whose payload has no `sub` or no `iat`,
  is evaluated as an anonymous caller. Under the tree's rules that is the
  same 401 `Permission denied` a real refusal gives (an owner's own claims
  with `iat` removed were denied their own document), and on a namespace
  with no rules it is a 200. `?auth=not-a-token` is refused only because the
  rules refuse anonymous callers. The emulator does not check the signature,
  `alg`, `exp`, `aud` or `iss`, so an expired ID token is still its user
  locally. `rtdbAs` refuses a token the emulator would read as nobody
  (`E2E_RTDB_TOKEN`, before anything is sent; `rtdbTokenProblem(token)` says
  why), so a DENY from it is the account's. Want the anonymous caller? Pass
  `idToken: null`.
- Before this harness version, a stack's `ns=<projectId>` ran with no RTDB
  rules (firebase-tools bound them to `<projectId>-default-rtdb`), so an RTDB
  DENY on such a stack is blind. Gate on `needs: ["rtdb-rules"]` or on
  `rtdbRulesStatus(target).ok`. (The harness side: `rtdbRulesConfig(database,
  projectId)` and `rtdbRulesFile(firebaseJson, ns)` in `lib/patch.mjs` write
  and read the binding; `checkRtdbRules(rec, {fetchImpl})` in `lib/stack.mjs`
  is the readiness step.)
- **The Storage emulator ignores `ifGenerationMatch`** (firebase-tools
  15.25.1): a second create-only write or copy onto an existing object is
  accepted and replaces it. A plain local stack therefore lacks
  `storage-preconditions`, and a race the product resolves with a 412 (two
  creates at one id, a fork's copy) cannot hold there; build the stack with
  `--storage-shim` for one (Capabilities).
- **A function worker's Storage host cannot be set from `.env.local`.**
  firebase-tools spreads the functions' dotenv first and its emulator
  registry after it (`getRuntimeEnvs`), so `STORAGE_EMULATOR_HOST` is
  always the emulator's. The Storage shim moves it with a preload instead
  (`lib/storage-shim-preload.mjs`).
- **The Functions emulator never reaps an idle worker, and never reloads
  on a change in a stack's tree.** Each concurrent request to a function is
  a worker of about 216 MB that lives until the stack stops or the
  emulator reloads; its source watcher ignores every path under a dot
  directory, and every tree is under `~/.cache`. `retireIdleWorkers`
  reloads through the Emulator Hub instead (Memory per N).
- On a stack Playwright emits no `requestfinished` for a fetch whose answer
  the page never reads: the viewer's `/view` beat, and `POST /thumb`
  (`uploadThumbs` takes `res.ok`), which got no `requestfailed` either.
  Such a request is a `log.requests` row from its response, `finished:
  false`, and a `capture` row that stays `answered` and never settles. For
  "X sent nothing", use `capture`, started before the page loads:
  `log.requests` has no row for a request still waiting for its answer.
- The Firestore SDK pings `https://www.google.com/images/cleardot.gif?zx=…`
  by itself once its Listen channel errors, which on a loaded stack follows a
  stall of 10 s or more ("Could not reach Cloud Firestore backend", then
  "WebChannelConnection RPC 'Listen' stream … transport errored"). The
  tripwire aborts it like anything else off the stack but does not count it a
  breach (`isSdkProbe`, `log.sdkProbes`); the case notes it as an environment
  signal. Any other request to a Google host, a near miss of that one
  included, is still a breach. Parking a page on `about:blank` to dodge it is
  no longer needed.
- Code evaluated inside the edit frame (Playwright's `frame.evaluate`) runs,
  but an observer it installs there is never called: the frame runs no
  script. Observe the frame's document from the top page (`armArrival`).
- A websocket "frame" in Playwright is a whole message: the browser's own
  fragmentation is invisible, and an empty message is not reported at all.
  The Realtime Database client does its own splitting at 16,384 characters
  (`log.wsFrames`).
- An OAuth receiver's `wait()` resolves when the redirect ARRIVES, before the
  browser has committed the navigation (the consent page leaves only once its
  POST has answered, so Playwright's click has long returned): a `goto`
  straight after it is "interrupted by another navigation". Give
  `startReceiver` the `page` and use `received()`, which also waits for that
  page to load the receiver's address.
- A page a Playwright route ANSWERED (`route.fulfill`) is not on loopback to
  Chrome's local-network rules: Chrome refuses its requests to a 127.0.0.1
  port other than its own before sending them ("Permission was denied for
  this request to access the `loopback` address space", Chrome 154). So a
  cross-site page meant to reach a local stack must be a page the stack
  served (`openCrossSitePage` `via: "stack"`), and a route receiver's page
  reaches nothing.

## Known weaknesses

The [local repair campaign](../docs/development/e2e-campaign.md) now preserves
these findings in [`campaign.json`](campaign.json), including the source
observations, overlap mappings, historical closure reports, product suspects
and the full execution matrix. `node tools/check-e2e-campaign.mjs` is the
strict completion gate; `--validate` checks structure only. The counts below
are the imported baseline, not a claim about current fixes.

The suite landed **concurrency first**. Completeness critics read every
functional spec against the plan's catalogue and the control ledger, and
the maintainer chose to spend the time on C1–C23 instead of filling what
they found. So most of it is still open, and a green functional run is
weaker evidence than its case count suggests.

The three critic ledgers hold 234 findings, counting a round-two finding
that repeats a deep-critic one once. **173 are open:**

| kind | open | what it means |
|---|---|---|
| weak | 59 | the oracle can pass with the bug present (a status checked but not what was written, a sort that the fixture cannot tell from no sort) |
| never red | 52 | no planted bug, control set or spec mutation, has been seen to turn the oracle red. By CLAUDE.md's rule that is not yet a test |
| missing | 31 | a catalogue or SPEC sentence no case drives |
| other | 14 | stale evidence, a spec that contradicts itself, a lib helper used outside its contract |
| flaky | 6 | outcomes that differ between runs |
| tier | 5 | runs on the wrong tier, or skips where it could run |
| unclassified | 5 | FAILs on a loaded shared stack nobody classified, usually because the spec has no stall judges (scenario()), so Hosting's 60 s cut-off ends as FAIL, not INCONCLUSIVE |
| bad skip | 1 | a skip whose reason does not hold |

61 were closed before landing:

- all 14 wrong defect citations, each re-read against the SPEC and re-classed
  as a confirmed defect (P), a report-and-ask item (I) or a SPEC question (Q);
- 25 deep-critic and 13 round-two findings, by finishing and re-proving the 8
  specs an earlier pass had left mid-edit (a01, a09, a12, a14, a15, a16, a17,
  a19). Most of these are "never red" families now seen red by spec mutations
  in scratch. Those mutations are not committed control sets;
- 9 round-one findings for a01–a07, which later controls
  (`controls-a01-*`, `controls-a2-refused-write`) or stall judges cover.

Nothing is open for a01, a02-matrix-data, a03, a04, a05 or a07. The rest, by
unit, with the most significant examples:

| unit | open | kinds | most significant |
|---|---|---|---|
| a02-matrix-http | 1 | 1 tier | `member()` cannot pass on production, though its cases are tagged for both tiers (moot until the production tier exists) |
| a06-comments | 2 | 1 unclassified, 1 flaky | no stall judges, so A6.7–A6.9 FAIL on a loaded stack; A6.2 flips |
| a08-review | 14 | 5 weak, 5 missing, 2 never red, 1 unclassified, 1 other | "Review all" is never pressed; no case accepts a deletion, or a replacement that contains its quote; only the record step is ever failed, never the save; a claim is tested against the author's revise but not a withdrawal; A8.7b never reads the failure toast's text |
| a09-editing | 4 | 3 weak, 1 other | A9.3 presses 7 of the 15 formatting controls; A9.8 asserts the toasts but not the draft the race leaves behind; A9.5 accepts a banner with no "when" |
| a10-markdown | 5 | 2 weak, 2 never red, 1 other | md → html → md idempotence is checked on one sample only; section wrapping is judged by the list of ids alone; the tooltip and "no external URL" checks have never been red |
| a11-live | 8 | 3 weak, 2 never red, 1 flaky, 1 tier, 1 other | the wire comparison strips `data-bshd-empty` from both sides, so that decoration reaching the wire would pass; the colour checks cannot see whether a colour derives from the address; the suggester's refused `y` write has never been red; A11.9 and A11.11 flip |
| a12-versions | 8 | 3 never red, 2 weak, 2 other, 1 missing | a withdrawal never checks its `version.withdrawn` event; the version menu, the pinned threads and A12.1's dedup family have never been red; `delete-version`'s order is judged by its end state only |
| a13-sharing | 8 | 5 never red, 2 weak, 1 tier | no removal half (team, folder, open editing) has been red; A13.2 compares the 404's status, not its bytes; A13.3's INCONCLUSIVE escape is too wide |
| a14-workspace | 8 | 5 weak, 1 never red, 1 unclassified, 1 other | Name and both read-count sorts pass for a sort that does nothing on the fixture; a folder delete is checked on direct children only; "filing emails nobody" is not asserted; the per-card cover counts have never been red |
| a15-forks | 8 | 3 missing, 3 weak, 1 never red, 1 other | "an expired document stops a lineage walk" and an unlisted fork's visibility are never driven; "a fork copies no comments or versions" runs on a source that has none; a refusal's "writes nothing" reads Firestore, not Storage |
| a16-decks | 8 | 4 weak, 3 never red, 1 missing | "presenting hides the banners" passes when they do not exist; the deck-keys check passes for a viewer that toggles `.active` itself; a two-image cover is never sent; the thumbnail cache header comes from the tree's constant, not SPEC's 86400 |
| a17-export | 8 | 4 weak, 2 missing, 2 never red | the stamp repeating on every printed page is not asserted; Cmd/Ctrl+P is pressed only inside the frame; `rotate` is missing from the stamp's hiding vectors, and hostile rules on `html` and `body` are never tried |
| a18-stats | 6 | 3 never red, 2 weak, 1 other | A18.1 requires the `lastViewedByEmail` that A18.4's SPEC question is about; the Automation filter is never shown to filter; the MCP half of A18.3 has never been red; the final-beat wait can be met by the 60 s interval beat |
| a19-account | 11 | 4 weak, 3 missing, 2 never red, 1 tier, 1 flaky | the account's analytics opt-out is untested, and so is a corrupt stored consent; the default marking is checked through the Upload dialog only, not MCP or the CLI; the team is deleted after its members are gone; token revoke → 401 has never been red |
| a20-cli | 13 | 6 weak, 5 never red, 2 missing | `BIKESHED_TOKEN` beside a saved sign-in is never tried; `list --all` and `changes` never read a second page; the `--interval` floor is never exercised; `CI` without a flag, and logout's other outcomes, are not driven |
| a20-mcp | 9 | 5 never red, 2 other, 1 missing, 1 weak | no CORS preflight on `/mcp`; its challenge and cache headers have never been red; nor has the missing-argument family; a fork's lineage is unchecked |
| a21-changes | 11 | 4 never red, 3 weak, 1 missing, 1 tier, 1 flaky, 1 unclassified | no stall judges; A21.7 depends on the emulator not dropping trigger runs; the `(at, id)` page cut never exercises its id half; the owner-only and editor-only audience filters have never been red |
| a22-oauth | 16 | 5 missing, 5 never red, 3 weak, 2 other, 1 flaky | consent arming's focus half is untested; a private-use redirect scheme, the token endpoint's parser rules and resource binding are not driven; 3 of the 5 refresh gate conditions are untested; the credential-kind rule on `/oauth/consent` has never been red |
| a23-email | 8 | 3 missing, 3 never red, 1 weak, 1 other | no case shows a cooldown ending; `/verify/start` never meets a refused send; filing into a shared folder never reaches an existing reader; the HTML part's content is not asserted |
| a24-responsive-a11y | 15 | 6 weak, 4 missing, 4 never red, 1 bad skip | axe is skipped (A24.5c), so WCAG AA contrast goes unchecked; Tab into the document frame is never judged for a ring; a fixed dialog never adds to the page's scroll width, so sideways scrolling inside one goes unseen; the 44 px floor is measured on base.css's own selectors only |
| smoke | 2 | 1 unclassified, 1 flaky | on one loaded shared stack the live-edit pair never settled and the viewer's comment flipped; both pass on a fresh stack |

**Newer than the critics.** 0.16.0's **Upload a new version…** dialog, and
dropping a file onto an open document, came after the critics read the
specs, and no spec drives either. C12 and A12 cover the server side with
raw requests: an update refused while somebody edits, dropping the draft and
the live log, a stale base, identical bytes. The dialog's own refusals and
messages are walked by hand (`docs/development/verification.md`, item 17).

**Cases that run only on a specially built stack.** A plain `stack up` skips
them, with the capability named in the reason:

| case | needs | build it with |
|---|---|---|
| A19.2, a measurement id under emulators | `measurement-id` | `stack up --app-env VITE_FIREBASE_MEASUREMENT_ID=dummy` |
| A19.2, analytics live (the consent sequence) | `measurement-id`, `patch:a19-analytics-live` | the same, plus `--patches a19-analytics-live` |
| A19.3, the deployment's default marking | `export-mark-default` | `stack up --app-env VITE_EXPORT_MARK_ENABLED` (and the label and footer, as the case's comment shows) |
| A20.7m, a skill name the CLI must refuse | `patch:a20-cli-bad-skill-name` | `stack up --patches a20-cli-bad-skill-name` |
| A20.7m2, an uppercase first skill name | `patch:a20-cli-uppercase-skill` | `stack up --patches a20-cli-uppercase-skill` |
| A20.7m3, an underscore first skill name | `patch:a20-cli-underscore-skill` | `stack up --patches a20-cli-underscore-skill` |
| A20.7y, the CLI polling floor independently of the server retry delay | `patch:a20-cli-no-retry-delay` | `stack up --patches a20-cli-no-retry-delay` |
| A23.7, email off | `email-off` | `stack up --email-off` |

The `storage-preconditions` cases (Capabilities) likewise need
`--storage-shim`, and the production tier (A25, `--target prod`) is
refused in this build.

**A `defect:` case is not a pass.** Each one is a known product defect, or a
SPEC question or report-and-ask item under triage. The list and its unresolved decisions are tracked in
[`campaign.json`](campaign.json). Its TODO ("failed as expected") means the defect is
still there, and "passed unexpectedly" means it may have been fixed and wants
a look. `run` exits 0 over both, so read `summary.md`, not the exit code,
before saying a feature works.

## Safety rules

- Never bind or signal anything on the default ports (9099 8088 9000 5001 5050
  9199 4040 4400 4500 9150 9299 9499) or on another session's 1xxxx/2xxxx ports.
  The reset helpers refuse any port that is not the stack's own.
- Teardown and `reap` signal only processes that carry the stack's
  **provenance mark**: every process a stack starts gets
  `E2E_STACK_MARK=<runId>.<16 hex>` in its environment, and its children
  inherit it. A group is signalled only when its leader carries the mark; any
  other marked process is signalled by its own pid. A process that merely
  names the tree in its argv or has its cwd inside it — another session's
  `grep`, a `tail`, an editor helper, a peer's operator script — is left alone
  and listed. The mark is read from the environment part of `ps -E`, so no
  command line can forge it. Once a stack's processes are gone, its short
  TMPDIR (`/tmp/bshd-<runId>`) is removed, whether or not its tree is kept.
- Every stack's processes are bounded: every JVM by its heap cap (Firestore
  2048m, Database 1024m, any other 512m, never raised), each debug log by
  200 MB, its life by its lease (8 h at most), the machine by three live
  stacks, and nothing starts under memory pressure, while swapping, or with
  less than 25 % / 8 GB free. A stack's watchdog carries its mark, so a
  teardown stops it; it signals nothing but its own stack, through
  `stopStack`.
- A Chrome is the harness's only when its command line starts with a Chrome
  executable and holds `--e2e-browser-mark=<…>` as a whole word (macOS does
  not show Chrome's environment, so it cannot carry `E2E_STACK_MARK`);
  `reap` signals the group of such a leader, and only when its run or the
  process that launched it is gone, re-reading the leader's command line
  before each signal. Another session's `grep` or `pgrep` naming the switch is
  not a Chrome and is never signalled.
- Nothing a spec runs reaches beyond loopback: http.mjs and the browser
  tripwire for requests, and the egress guard for the `bikeshed` CLI
  (`runCli`, `spawnCli`) and the operator scripts (`runOperator`).
- Every Node process a stack starts, and every worker thread in one, runs
  under the egress guard and can reach loopback only. The guard does **not**
  cover non-Node binaries (the Firestore and Database emulators, which are
  Java, and Mailpit), a child that clears its environment or drops
  `NODE_OPTIONS`, or a worker thread given an `env` without it. The harness
  does nothing to stop those reaching out. Mailpit runs with
  `--disable-version-check`, and the Java emulators get no credentials, but
  neither is a guard.
- Evidence goes only to `e2e/.out/` (gitignored), redacted and leak-checked.
  Nothing in `target.json` is a secret.
- Production values go only in gitignored `e2e/.env.prod`; `.env.example`
  lists the names.

### Draft admission during concurrent autosaves

C7 may race an existing peer's autosave between preparing an editing session
and loading its pinned iframe. SPEC §6b requires the stale frame to remain
non-editable and offer **Reload draft**. Before the joining actor types,
`lib/draft-admission.mjs` permits at most three explicit reload clicks for that
exact JSON refusal. A reload must retain the origin, document path, base version
and live epoch. Unknown refusals and editable DOM are never retried. Participant
counts, trials, stagger timing, typed tokens and every post-join oracle remain
unchanged. A controlled browser check holds the iframe request, commits a peer
autosave, observes the real 409, and checks recovery; disabling recovery fails.

### Browser requests held at server gates

`holdRequests.release()` dispatches a browser request and then waits for its HTTP
response. In the C8 late-loser publication race, that response is deliberately
held at `commit-before-read`. Start the release promise, verify the first caller
has arrived, dispatch the remaining callers, and verify their arrivals before
opening the server gate. Drain the response promises after releasing both server
gates, including on a refused precondition. Awaiting a response before releasing
its server gate deadlocks the test until the request times out. The full-file
N2, N5 and N10 reruns retain every winner, stale-base and fresh-draft assertion.

The C10 full file also contains natural timing judges when run with its reviewed
`amplify-c10-accept` pause points. The timing qualifier accepts that exact patch
set and either the canonical file path or its exact CLI basename. It still
requires every slow-link and held-save trial, real failing/restored controls,
and the original natural inconclusive records. Unrelated patches, mixed mutant
sets, filtered runs and unrelated file selections remain rejected.
