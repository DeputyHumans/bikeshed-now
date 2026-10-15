# Historical E2E failure review

Reviewed on 2026-10-15 (SPEC §12). This records what the original artifacts establish, independently of current passing runs. It addresses the historical obligations in `r1:10`, `r1:11`, `r1:13`, `deep:a08-review:13`, `deep:a21-changes:01` (including `r2:06`) and `deep:a22-oauth:16`.

The 81 original FAIL attempts comprise **65 environment measurements (E), 11 harness faults (H), and five attempts not reproduced to the evidentiary bar (U)**. No original status, elapsed time or FLAKY history was changed. The report API added attempt classifications and refreshed the merged annotations. FLAKY still correctly describes differing historical outcomes; it does not by itself identify a product defect.

The detailed local reviews are `e2e/.out/history-a21-a22/review.json` (A21/A22) and `review-more.json` (A06/A08). Each entry records the full case name, invocation, classification rationale and original evidence paths. The latter also preserves earlier attempt annotations. Original per-case artifacts live under `e2e/.out/<run>/invocations/<invocation>/evidence/`; classified results remain in each invocation and in the two merged reports.

## What the evidence establishes

| Area | Finding and limit |
|---|---|
| A06 comments | Request deadlines, Admin deadlines and same-page Firestore offline notices support environment classifications. The old 20–30 second reply helpers and short case budgets also produced premature observations. Three attempts have no conclusive same-page evidence explaining the missing selected thread; they remain U. A failed reading-statistics request does not establish why comment selection failed. |
| A08 review | The old 20-second autosave/capture bounds expired before draft requests completed. Emulator lines 146054–146057 and 146131–146140 show a 43,999 ms save, a 35,621 ms save and a function cutoff. The later RTDB permission error is real: findings lines 81–82 record both missing access mirrors after cutoff. Setup had accepted the durable record without its mirror. EMAIL_EXISTS is a fixture collision; dependent BODYATTR without a committed version is a harness setup fault. |
| A21 changes | Two early exact-count expectations incorrectly included or excluded the setup access event. A21.5b depended on A21.5 staging its document. The later 82/103 event shortage coincided with 32 function timeout notices inside its case window, 22 adjacent to recordThreadEvent executions (emulator lines 140118–141114). The interleaved log cannot attribute each missing event to a specific kill. Two earlier shortages have successful HTTP transport and no corresponding kill notice; they remain U. |
| A22 OAuth | Admin/HTTP deadlines and a consent504 explain unavailable measurements. The first consent flow also raced two navigations; the receiver now waits for the callback document to load. A 120-second case budget and a 20-second revoke-toast wait ended while requests remained pending. The two previously unclassified A22.5 attempts both directly report Admin DEADLINE_EXCEEDED. |

Emulator line references above are in `2610102144-wr3h/logs/emulators.log`. The OAuth abandoned token request is in `2610102145-0a2t/logs/emulators.log:169268–169280`; its callback/consent evidence is in the original browser request files. Timing notices establish an unavailable measurement, not a CPU-load diagnosis or a production conclusion.

## Current source and proof boundary

- A06 now uses 150-second HTTP, 120-second page and 90-second UI budgets, explicit comment/reply waits, and case/request stall judges. A6.3 and A6.7 have 420/480-second case budgets. A remaining `listen-deliveries` LIB-REQUEST concerns snapshot observation, not the old request-budget classification.
- A08 now uses patient setup, retries a taken fixture email, observes the save after the last typed input, waits for the claim/draft/accept responses in turn, and checks a landed grant’s RTDB mirror. Its one remaining `share-patient-mirror` LIB-REQUEST documents the local retry wrapper. The earlier three-marker inventory and “no markers remain” claim are not current evidence.
- A21 commit `63f838b` enables function-kill judging and cutoff-aware clients and makes the malformed-cursor case independent. A22 commit `65404d0` retains explicit cutoff/case judging and measures real focus rearming.
- Fifty-seven focused current setup, stall, budget, cast, mirror and OAuth receiver selftests passed in `/tmp/soapbox-history-judges.log`. These are classifier/setup evidence, not historical product reruns.
- A21’s nine B9 cases and A22’s ten B10 cases passed in their separately recorded runs. A08 is still receiving coverage and product changes; no three full current runs or complete current m1–m8 control proof is claimed here. Final repeated runs and patched-stack controls remain campaign acceptance work.

## Original attempts

`wr3h` below means run `2610102144-wr3h`; `0a2t` means `2610102145-0a2t`. Each invocation identifier is exact. U rows retain uncertainty rather than borrowing the cause of a different attempt.

| Run | Case | Invocation | Class |
|---|---|---|---|
| wr3h | A21.1 | `20261011T073738Z-p414-89jr` | H |
| wr3h | A21.1 | `20261012T062903Z-p72280-45d7` | E |
| wr3h | A21.2 | `20261012T062903Z-p72280-45d7` | E |
| wr3h | A21.3 | `20261012T060155Z-p81318-q48r` | E |
| wr3h | A21.3 | `20261012T064427Z-p52195-bixh` | E |
| wr3h | A21.4 | `20261012T060155Z-p81318-q48r` | E |
| wr3h | A21.5 | `20261012T060155Z-p81318-q48r` | E |
| wr3h | A21.5 | `20261012T064427Z-p52195-bixh` | E |
| wr3h | A21.5b | `20261012T060155Z-p81318-q48r` | H |
| wr3h | A21.5b | `20261012T064427Z-p52195-bixh` | H |
| wr3h | A21.6 | `20261012T060155Z-p81318-q48r` | E |
| wr3h | A21.6 | `20261012T064427Z-p52195-bixh` | E |
| wr3h | A21.7 | `20261011T075403Z-p42477-l0fn` | H |
| wr3h | A21.7 | `20261011T080628Z-p81226-66en` | U |
| wr3h | A21.7 | `20261011T081733Z-p29679-46p2` | U |
| wr3h | A21.7 | `20261012T064427Z-p52195-bixh` | E |
| wr3h | A6.1 | `20261012T184930Z-p62963-vfb7` | E |
| wr3h | A6.2 | `20261011T084111Z-p7131-acfl` | U |
| wr3h | A6.2 | `20261011T085247Z-p57982-6orb` | H |
| wr3h | A6.2 | `20261012T093913Z-p36468-3wh8` | U |
| wr3h | A6.3 | `20261011T084111Z-p7131-acfl` | E |
| wr3h | A6.5 | `20261012T091037Z-p66020-yh3c` | E |
| wr3h | A6.6 | `20261012T091037Z-p66020-yh3c` | E |
| wr3h | A6.7 | `20261012T091037Z-p66020-yh3c` | U |
| wr3h | A6.7 | `20261012T093913Z-p36468-3wh8` | E |
| wr3h | A6.8 | `20261012T091037Z-p66020-yh3c` | E |
| wr3h | A6.8 | `20261012T093913Z-p36468-3wh8` | E |
| wr3h | A6.9 | `20261012T091037Z-p66020-yh3c` | E |
| wr3h | A6.9 | `20261012T093913Z-p36468-3wh8` | E |
| wr3h | A8.1 | `20261011T111650Z-p71580-q5tb` | E |
| wr3h | A8.1 | `20261012T100546Z-p1739-4rhj` | E |
| wr3h | A8.1 | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.1 | `20261012T190047Z-p13980-rwuj` | H |
| wr3h | A8.2 | `20261011T111650Z-p71580-q5tb` | E |
| wr3h | A8.2 | `20261012T100546Z-p1739-4rhj` | E |
| wr3h | A8.2 | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.3 | `20261011T111650Z-p71580-q5tb` | E |
| wr3h | A8.3 | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.3 | `20261013T002045Z-p46681-te3o` | H |
| wr3h | A8.4 | `20261011T111650Z-p71580-q5tb` | E |
| wr3h | A8.4 | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.5 | `20261011T111650Z-p71580-q5tb` | E |
| wr3h | A8.5 | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.6 | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.6 | `20261012T191103Z-p97250-qyl5` | E |
| wr3h | A8.7 | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.7b | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.8 | `20261012T184056Z-p34985-it6s` | E |
| wr3h | A8.9 BODYATTR | `20261012T184056Z-p34985-it6s` | H |
| wr3h | A8.9 | `20261012T184056Z-p34985-it6s` | E |
| 0a2t | A22.2 | `20261011T080333Z-p69600-2sbb` | H |
| 0a2t | A22.2 | `20261012T061907Z-p43933-wwe0` | E |
| 0a2t | A22.2 | `20261012T071754Z-p54811-hlra` | E |
| 0a2t | A22.2 | `20261012T081735Z-p22855-7z7q` | E |
| 0a2t | A22.2 | `20261012T082911Z-p57978-0l5v` | E |
| 0a2t | A22.2 | `20261012T084652Z-p3722-g5fm` | E |
| 0a2t | A22.3 | `20261012T061907Z-p43933-wwe0` | E |
| 0a2t | A22.3 | `20261012T071754Z-p54811-hlra` | E |
| 0a2t | A22.3 | `20261012T081735Z-p22855-7z7q` | E |
| 0a2t | A22.3 | `20261012T082911Z-p57978-0l5v` | E |
| 0a2t | A22.3 | `20261012T084652Z-p3722-g5fm` | E |
| 0a2t | A22.3b | `20261011T081319Z-p15353-ujlk` | H |
| 0a2t | A22.3b | `20261012T061907Z-p43933-wwe0` | E |
| 0a2t | A22.3b | `20261012T071754Z-p54811-hlra` | E |
| 0a2t | A22.3b | `20261012T081735Z-p22855-7z7q` | E |
| 0a2t | A22.3b | `20261012T082911Z-p57978-0l5v` | E |
| 0a2t | A22.3b | `20261012T084652Z-p3722-g5fm` | E |
| 0a2t | A22.4 | `20261012T061907Z-p43933-wwe0` | E |
| 0a2t | A22.4 | `20261012T071754Z-p54811-hlra` | E |
| 0a2t | A22.4 | `20261012T081735Z-p22855-7z7q` | E |
| 0a2t | A22.4 | `20261012T082911Z-p57978-0l5v` | E |
| 0a2t | A22.4 | `20261012T084652Z-p3722-g5fm` | E |
| 0a2t | A22.5 | `20261012T081735Z-p22855-7z7q` | E |
| 0a2t | A22.5 | `20261012T082911Z-p57978-0l5v` | E |
| 0a2t | A22.6 | `20261011T153748Z-p29181-w1j1` | H |
| 0a2t | A22.6 | `20261012T064521Z-p54373-pnvj` | E |
| 0a2t | A22.6 | `20261012T065716Z-p84756-ew4h` | E |
| 0a2t | A22.6 | `20261012T071754Z-p54811-hlra` | E |
| 0a2t | A22.6 | `20261012T081735Z-p22855-7z7q` | E |
| 0a2t | A22.6 | `20261012T082911Z-p57978-0l5v` | E |
| 0a2t | A22.6 | `20261012T084652Z-p3722-g5fm` | E |
