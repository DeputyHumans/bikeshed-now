# 0034 — A reading is made in a worker, within a time and memory budget

**Status** Accepted · **Spec** §2, §8, §19 · **Amends** [0030](0030-agents-read-a-markdown-reading.md) (its bound), [0033](0033-a-reading-is-kept-once-made.md) §1 (what is kept)

## Context

ADR 0030 bounded a reading at 2,000,000 characters parsed after the strip. On 2026-11-18 the tracker that prompted ADR 0033 stripped to 2,296,524 characters and had grown by about 200,000 the day before, so its reading stopped before the end of the page. With 1 GiB (ADR 0033), raising the number looked like the whole fix.

It was not. Measured in a Linux container with one vCPU and 1 GiB, the functions bundle loaded first:

| Page | Parsed | Time | Peak RSS |
|---|---|---|---|
| The tracker's markup, repeated | 2M | 0.50 s | 208 MiB |
| The tracker's markup, repeated | 8M | 1.68 s | 469 MiB |
| The tracker's markup, repeated | 16M | out of heap | |
| `<p>x</p>`, repeated | 2M | 23 s | 545 MiB |
| `<div>`, nested 100,000 deep | 500K | 48 s to parse, then a stack overflow | |

The length never bounded the cost. Turndown's `join` copies its whole output for every sibling it adds, so one long run of siblings is quadratic, and domino's parser is quadratic in nesting depth. The 0.37.1 rules cost the same on the same pages, so this was already live. Production's one vCPU is slower still: the tracker's 2M took 3.3 s there.

Converting on the request's own thread, such a page stalled every other request on the instance (`mcp` takes up to 80 at once), ran past the 60 s Hosting gives a function, and failed before anything was kept, so every read paid it again. Raising the number alone would have made the worst case about four times worse.

## Decision

1. **A reading is made in a worker thread** (`lib/markdown/worker.ts`), started by `lib/markdown/budget.ts`. The request's thread only waits, so the instance keeps serving: the main event loop stalled at most 58 ms during any conversion measured.
2. **Each attempt has a deadline and a heap ceiling.** The ladder is 8M characters (`READ_PARSE_CHARS`) within 20 s, then 2M within 12 s, then 250K within 8 s, each worker capped at 512 MiB of old-generation heap. That is 40 s at worst, inside the 60 s limit. An attempt fails when it runs out of time (the worker is terminated), runs out of memory, throws (a stack overflow from deep nesting), or its worker exits. An attempt that would parse the whole page again is skipped, because it would fail the same way.
3. **Every outcome is a reading.** A shorter attempt's reading carries `TOO_COMPLEX` ("too complex to read whole here … stops before its end") and `cut`. When no attempt fits, the body is empty, `cut` is set, and the only warning is `UNREADABLE`; the strip's counts still fill `left-out`. Each failed attempt logs `reading: over budget <time|memory|error>`, a code only.
4. **One conversion at a time per instance.** A worker at its ceiling plus the bundle comes to about 660 MiB, so two would reach 1 GiB. `oneAtATime` queues them, and `stored.ts` holds it around everything a miss does. After its wait, a miss looks for the kept reading again, so readers who queued behind the reading of the same version are served what it kept.
5. **A shortened reading is kept like any other** (amends ADR 0033 §1), so a page costs its budget once. The budget and the worker are part of the rules fingerprint, so changing the ladder retires every kept reading.

## Consequences

- The tracker reads whole: 813,912 characters in 0.63 s in the container, up to about 8M characters of markup like it.
- A page that costs more than its budget reads shorter or not at all, and says so. It no longer costs any other request anything.
- A deadline depends on the machine. A page near one could be kept shortened because its instance was busy, until its next version or a change to the rules. The tracker's margin is 20 s against an estimated 3 s.
- Starting a worker costs about 50 ms, paid once per version's reading, since what is made is kept.
- `reading-budget.test.js` pins the ladder, each failure and its fallback, an unstartable worker, and that the main thread keeps running. `stored-reading.test.js` pins one conversion at a time, the second look, and a kept shortened reading. Each has a negative control.

## What would change this

- Production memory on `docmarkdown` or `mcp` approaching 1 GiB during a conversion. Then lower the heap ceiling, or give the two services more memory.
- Real documents kept shortened or unreadable. Then the converter's quadratic paths are the problem, and the spike ADR 0033 names (`@mdream/js`, streaming and linear) is the next step.
