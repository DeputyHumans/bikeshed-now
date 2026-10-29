# E2E fixes: release now, extended qualification next

On 2026-10-29 the operator directed that the long-running concurrency campaign
stop blocking production delivery. The first release integrates the implemented
E2E fixes with current main. It does not claim that the exhaustive campaign is
complete, and it does not turn failures, skips or inconclusive trials into passes.

## First release

Release the implemented fixes after repository verification, emulated security
rules, focused integration checks, CI and deployment verification. Preserve
current main's folder sharing and account-address migration. Publish the updated
CLI separately and remove legacy reader identities from document statistics
using the bounded cleanup script after the fixed service is live.

The pre-integration candidate `8340a1b` passed 2,739 repository tests, 107 rules
tests, all 1,468 harness self-tests, smoke, and the complete identity, visibility,
reading and email files. Earlier evidence includes 449 functional passes,
724 actual failing/restored product controls, and real-preview transport,
Hosting and notification checks. Those results retain their original source
identities; they are not evidence that every later main change was tested in
that earlier campaign. New integration checks are reported in the release PR.

The exhaustive self-test and stress-campaign reruns are explicitly deferred for
this release under the operator's instruction. Known product failures found in
the bounded release checks still require repair; an unfinished stress test does
not block unrelated verified fixes.

## Follow-up wave

- Finish the remaining controlled feedback, access, identity and thumbnail
  concurrency files at 2, 5 and 10 participants. Twenty remains deferred.
- Investigate the C13 N5 harness-maintenance failures: an alive browser caused
  coverage maintenance to refuse its boundary. The run recorded 90 passes,
  10 failures and 5 inconclusives; none of those failures is accepted as a pass.
- Retain the C13 N2 timing inconclusives and review their controlled evidence.
- Investigate the earlier RTDB rule-tracker crash and cross-checkout browser
  interference. Distinguish harness defects from product safety failures.
- Profile the harness before another broad campaign: per-case browser startup
  and teardown, repeated source archives, emulator recycling, wall time, peak
  memory and swap. Reuse immutable setup where isolation permits, and make the
  ordinary release smoke gate short and bounded.
- Rebase the remaining regression patches onto current main and run their
  application/control checks as separate harness work. Preserve original
  mutation intent and failing/restored evidence.
- Finish campaign-ledger adjudication without rewriting historical reports or
  claiming exhaustive completion for this release.

Raw reports, source fingerprints, failed attempts and earlier control ledgers
remain in the ignored campaign evidence directories. The canonical campaign
ledger remains an incomplete research/qualification record, not the completion
claim for this explicitly scoped release.
