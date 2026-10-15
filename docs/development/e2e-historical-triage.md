# Historical E2E failure review

Reviewed on 2026-10-15 (SPEC §12). This records what the original artifacts establish, independently of current passing runs. It addresses the historical obligations in `r1:10`, `r1:11`, `r1:13`, `deep:a08-review:13`, `deep:a21-changes:01` (including `r2:06`), `deep:a22-oauth:16`, smoke `r2:07`/`r2:08`, and `deep:a11-live:09`, `deep:a14-workspace:02`, `deep:a19-account:09`.

The review covers **146 original non-pass attempts: 69 environment measurements (E), 50 harness faults (H), and 27 attempts not reproduced to the evidentiary bar (U)**. Of these, 144 were FAIL and two were already INCONCLUSIVE. The initial A06/A08/A21/A22 subset remains 81 FAIL attempts (65 E, 11 H, five U). No original status, elapsed time or FLAKY history was changed. The report API added attempt classifications and refreshed the merged annotations. FLAKY still correctly describes differing historical outcomes; it does not by itself identify a product defect.

The detailed local reviews are `e2e/.out/history-a21-a22/review.json` (A21/A22), `review-more.json` (A06/A08), and `review-extra.json` (smoke/A11/A14/A19). Each entry records the full case name, invocation, classification rationale and original evidence paths. The latter also preserves earlier attempt annotations. Original per-case artifacts live under `e2e/.out/<run>/invocations/<invocation>/evidence/`; classified results remain in each invocation and in the two merged reports.

## What the evidence establishes

| Area | Finding and limit |
|---|---|
| A06 comments | Request deadlines, Admin deadlines and same-page Firestore offline notices support environment classifications. The old 20–30 second reply helpers and short case budgets also produced premature observations. Three attempts have no conclusive same-page evidence explaining the missing selected thread; they remain U. A failed reading-statistics request does not establish why comment selection failed. |
| A08 review | The old 20-second autosave/capture bounds expired before draft requests completed. Emulator lines 146054–146057 and 146131–146140 show a 43,999 ms save, a 35,621 ms save and a function cutoff. The later RTDB permission error is real: findings lines 81–82 record both missing access mirrors after cutoff. Setup had accepted the durable record without its mirror. EMAIL_EXISTS is a fixture collision; dependent BODYATTR without a committed version is a harness setup fault. |
| A21 changes | Two early exact-count expectations incorrectly included or excluded the setup access event. A21.5b depended on A21.5 staging its document. The later 82/103 event shortage coincided with 32 function timeout notices inside its case window, 22 adjacent to recordThreadEvent executions (emulator lines 140118–141114). The interleaved log cannot attribute each missing event to a specific kill. Two earlier shortages have successful HTTP transport and no corresponding kill notice; they remain U. |
| A22 OAuth | Admin/HTTP deadlines and a consent504 explain unavailable measurements. The first consent flow also raced two navigations; the receiver now waits for the callback document to load. A 120-second case budget and a 20-second revoke-toast wait ended while requests remained pending. The two previously unclassified A22.5 attempts both directly report Admin DEADLINE_EXCEEDED. |

Emulator line references above are in `2610102144-wr3h/logs/emulators.log`. The OAuth abandoned token request is in `2610102145-0a2t/logs/emulators.log:169268–169280`; its callback/consent evidence is in the original browser request files. Timing notices establish an unavailable measurement, not a CPU-load diagnosis or a production conclusion.

## Smoke, live-editing and workspace follow-up

The 58 original smoke failures split into **37 H, one E and 20 U**:

- Thirteen empty-comment failures used a single read after the annotation existed, before the separate comment write. The observed single-read mutant fails and restored polling succeeds in `e2e/.out/smoke-oracle-controls/proof.json`.
- Nineteen BODYATTR failures lacked the preceding saved version. No attribute comparison occurred.
- Eighteen live-save failures remain U. Both frames converged, but a peer remained `saving`; its completed-request log contains no draft POST. A completion log cannot show whether an unanswered request began. In `fwbz`, the editor POST answered 200 after 19,239 ms, but the owner only has a draft GET recorded. The editor's latency does not establish the owner's cause.
- Five 60-second MCP/CLI case failures are H: three MCP responses eventually returned 200 after the case ended; in `uajy`, the MCP and CLI steps did not begin until +69.77 s and +77.85 s. The short case deadline expired during otherwise answered setup. This is not proof that every later product assertion passed.
- The `uajy` frame wait is E because both pages logged Firestore backend unavailability during the wait. The two 90-second invitation case deadlines remain U: their case captures contain no attributable access answer, and interleaved emulator requests cannot establish why they ended.

For A11, the original SDK-probe isolation failure and two-of-three settled-sample timeout remain H. The `uqog` A11.9 frame failure is E with same-owner Firestore offline notices at 14:07:06.716Z and 14:07:36.544Z. A11.11's 180-second timeout is **U**, correcting the earlier E label: setup reached Shared at +166.52 s and no malformed-probe response was captured before the deadline. An earlier Firestore notice does not explain a later RTDB probe delay. The two intentional scratch mutants remain separate from these four failures.

A14.5 `ak67` remains U. Its page closed at 325.07 s during the folder-card wait, below its declared 480-second budget. Same-page Firestore offline and the SDK probe establish lost connectivity, not the page-close cause. Retained pre-adoption guard copies were inspected: `atCutoff` only compares status/time; `stackGuard` races the body against a 465-second timer, classifies a caught failure, and clears that timer. Neither closes the pool or a page. These helpers cannot directly explain the 325-second close. The exact running source was not captured, so the old closure is not claimed fixed by removing them.

A19.4's reviewed shared-stack sequence is **one pass in three attempts**: `20261012T125651Z-p18898-9lrn` was INCONCLUSIVE after `/team-members`504 in 60,062 ms; `20261012T130519Z-p45430-jadw` was INCONCLUSIVE after `/team`504 in 60,016 ms; `20261012T131349Z-p68609-11mk` passed. The first two are E, as their original records already said. The retained `w1a-a19-account-adopt/r12.log`, `r13.log`, and `r14.log` match those invocation IDs. Dedicated-stack evidence does not turn this shared sequence into three stable passes; future repeated acceptance should use a lightly loaded stack.

The report API annotated these 65 additional non-pass attempts. SHA-256 checks confirmed all 35 underlying result JSONL files stayed byte-identical. The detailed local review preserves prior annotations, exact evidence paths and the pre-adoption guard references. Current smoke repairs and their current source proof are maintained separately by the campaign; these classifications do not close its current acceptance obligations.

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

### Additional original attempts

| Run | Case | Invocation | Class |
|---|---|---|---|
| wr3h | smoke comments | `20261011T054618Z-p8416-s3n8` | H |
| wr3h | smoke comments | `20261011T054825Z-p16915-9kzd` | H |
| wr3h | smoke comments | `20261011T054835Z-p17330-fw4a` | H |
| wr3h | smoke comments | `20261011T054844Z-p17716-0web` | H |
| wr3h | smoke comments | `20261011T060131Z-p78293-0zxk` | H |
| wr3h | smoke comments | `20261011T065527Z-p53804-z42v` | H |
| wr3h | smoke comments | `20261011T070123Z-p70694-wfqk` | H |
| wr3h | smoke comments | `20261011T073232Z-p87577-rckw` | H |
| wr3h | smoke comments | `20261011T074601Z-p21994-tztl` | H |
| wr3h | smoke comments | `20261011T081023Z-p4801-60i9` | H |
| wr3h | smoke MCP | `20261011T083425Z-p85967-agxb` | H |
| wr3h | smoke live-save | `20261011T083425Z-p85967-agxb` | U |
| wr3h | smoke comments | `20261011T083425Z-p85967-agxb` | H |
| wr3h | smoke BODYATTR | `20261011T083425Z-p85967-agxb` | H |
| wr3h | smoke live-save | `20261011T084539Z-p20275-0ch6` | U |
| wr3h | smoke BODYATTR | `20261011T084539Z-p20275-0ch6` | H |
| wr3h | smoke MCP | `20261011T111334Z-p59534-uajy` | H |
| wr3h | smoke live-save | `20261011T111334Z-p59534-uajy` | E |
| wr3h | smoke comments | `20261011T111334Z-p59534-uajy` | H |
| wr3h | smoke invitation | `20261011T111334Z-p59534-uajy` | U |
| wr3h | smoke CLI | `20261011T111334Z-p59534-uajy` | H |
| wr3h | smoke BODYATTR | `20261011T111334Z-p59534-uajy` | H |
| wr3h | smoke live-save | `20261011T115124Z-p89183-948i` | U |
| wr3h | smoke BODYATTR | `20261011T115124Z-p89183-948i` | H |
| wr3h | smoke live-save | `20261011T115627Z-p8075-eo06` | U |
| wr3h | smoke BODYATTR | `20261011T115627Z-p8075-eo06` | H |
| wr3h | smoke MCP | `20261011T123220Z-p5234-70cz` | H |
| wr3h | smoke live-save | `20261011T123220Z-p5234-70cz` | U |
| wr3h | smoke comments | `20261011T123220Z-p5234-70cz` | H |
| wr3h | smoke BODYATTR | `20261011T123220Z-p5234-70cz` | H |
| wr3h | smoke MCP | `20261011T125641Z-p68567-01zd` | H |
| wr3h | smoke live-save | `20261011T125641Z-p68567-01zd` | U |
| wr3h | smoke BODYATTR | `20261011T125641Z-p68567-01zd` | H |
| wr3h | smoke live-save | `20261011T133902Z-p79330-3xku` | U |
| wr3h | smoke BODYATTR | `20261011T133902Z-p79330-3xku` | H |
| wr3h | smoke live-save | `20261011T134441Z-p91626-irv4` | U |
| wr3h | smoke BODYATTR | `20261011T134441Z-p91626-irv4` | H |
| wr3h | smoke live-save | `20261011T141158Z-p69640-ypqa` | U |
| wr3h | smoke BODYATTR | `20261011T141158Z-p69640-ypqa` | H |
| wr3h | smoke live-save | `20261011T144931Z-p79884-z4ik` | U |
| wr3h | smoke BODYATTR | `20261011T144931Z-p79884-z4ik` | H |
| wr3h | smoke live-save | `20261011T152013Z-p72718-ujq5` | U |
| wr3h | smoke BODYATTR | `20261011T152013Z-p72718-ujq5` | H |
| wr3h | smoke live-save | `20261011T155621Z-p83663-k3u0` | U |
| wr3h | smoke BODYATTR | `20261011T155621Z-p83663-k3u0` | H |
| wr3h | smoke live-save | `20261012T093200Z-p21540-8xp9` | U |
| wr3h | smoke invitation | `20261012T093200Z-p21540-8xp9` | U |
| wr3h | smoke BODYATTR | `20261012T093200Z-p21540-8xp9` | H |
| wr3h | smoke live-save | `20261012T102340Z-p54957-qz11` | U |
| wr3h | smoke BODYATTR | `20261012T102340Z-p54957-qz11` | H |
| wr3h | smoke live-save | `20261012T110321Z-p61163-4y7x` | U |
| wr3h | smoke BODYATTR | `20261012T110321Z-p61163-4y7x` | H |
| wr3h | smoke live-save | `20261012T110812Z-p69430-bnje` | U |
| wr3h | smoke BODYATTR | `20261012T110812Z-p69430-bnje` | H |
| wr3h | smoke live-save | `20261012T121125Z-p22307-0bmp` | U |
| wr3h | smoke BODYATTR | `20261012T121125Z-p22307-0bmp` | H |
| wr3h | smoke live-save | `20261012T163042Z-p28576-fwbz` | U |
| wr3h | smoke BODYATTR | `20261012T163042Z-p28576-fwbz` | H |
| 0a2t | A11.11 | `20261011T065316Z-p42261-yg5z` | H |
| 0a2t | A11.9 | `20261011T132245Z-p33044-5rao` | H |
| 0a2t | A11.9 | `20261011T135145Z-p11249-uqog` | E |
| 0a2t | A11.11 | `20261011T135145Z-p11249-uqog` | U |
| wr3h | A14.5 | `20261012T144525Z-p9557-ak67` | U |
| 0a2t | A19.4 | `20261012T125651Z-p18898-9lrn` | E |
| 0a2t | A19.4 | `20261012T130519Z-p45430-jadw` | E |
