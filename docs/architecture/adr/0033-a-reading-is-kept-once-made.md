# 0033 — A version's reading is kept once made, named by its bytes

**Status** Accepted, amended by [0034](0034-a-reading-is-made-within-a-budget.md) (§1: a reading shortened to fit its budget is kept like any other) · **Spec** §2, §8, §19 · **Amends** [0030](0030-agents-read-a-markdown-reading.md) §1

## Context

ADR 0030 made a reading fresh on every request, and named its own reversal condition: conversion showing up in latency would call for "a memo per version … or a reading stored beside the version like a thumbnail". On 2026-11-17 it did.

The page was 2,207,561 bytes and 33,168 elements, a tracker of the kind agents now publish. It read to 720,838 characters. Fetching its `.md` took 3.5 to 5.1 s each time in production. `bikeshed get` failed with a 500 after 14 s, because `get_document` pages a reading 200,000 characters at a time, and every page downloaded the 2.2 MB source and converted the whole page again for its slice. Four pages meant four conversions, and the instance was killed for memory on the fourth. Raising `docMarkdown` and `mcp` to 1 GiB ended the kills, but every request still paid a conversion: 0.40 to 0.68 s of one CPU in a Linux container for this page.

A faster converter was measured before deciding, each run on the same 2.1 MB stripped input, one fresh process per engine:

| Engine | ms / run | Peak RSS | HTML left in the output | Could carry the reading's rules |
|---|---|---|---|---|
| turndown 7.2.0 with the reading's rules | 219–251 | 479 MB | none | yes |
| `mdream` 2.1.0, Rust NAPI | 9–10 | 100 MB | 11,046 tags, inside table cells | no: options only, no per-element hook |
| `@mdream/js` 2.1.0 | 46–65 | 165 MB | 11,046 tags | only rewritten onto streaming hooks, as the last dependency `functions/` has room for, ESM-only |
| `node-html-markdown` 2.0.0 | 12,006–12,896 | 951 MB | none | ruled out |

None of them kept apart the words ADR 0032 separates. A faster engine would still convert on every page; keeping the reading converts once.

## Decision

1. **A version's reading is kept once made**, by `lib/markdown/stored.ts`, at `docs/{docId}/readings/{versionId}/{name}.json`. That is outside the version's prefix, for the reason thumbnails are: the content hash, a fork's copy and the download zip read everything under it. What is kept is the body and its counts. The front matter names the title, which a rename changes, and an address that depends on how the reading was asked for, so it is composed on every request.
2. **It belongs to the version's bytes, not its name.** A withdrawn head's name is minted again by the next publish (`v${maxN + 1}`), with other bytes. So `name` hashes the version record's `contentHash` (SPEC §9) and storage prefix, the entry, the origin, the key that opened it (a keyed reading carries the key in its addresses), and a fingerprint of the rules: the compiled `reading.js`, turndown and its parser. Change any of them and the old object is never read again, with no constant for anyone to remember to bump. A record without a well-formed `contentHash` is converted every time and nothing is kept for it.
3. **"Current" is never kept as an alias.** An unpinned read resolves `currentVersion` from the record that same request read through the gate, so a new publish is read at once. Only committed versions are kept, never a draft.
4. **The gate first, the request never at risk.** The store is read only after `readGate` or `loadDocForRead` has said yes. A miss converts, then writes create-only (`ifGenerationMatch: 0`). The write is awaited, because Cloud Run takes the CPU away once the response is sent. A failed write, or one that loses the race to an identical write, is logged as a code and the request still answers. A kept object that does not parse as a reading is made again.
5. **Withdrawal removes them.** `scripts/delete-version.mjs` deletes and lists `docs/{docId}/readings/{version}/` beside the thumbnails, and a document's purge already removes everything under `docs/{docId}/`.

## Consequences

- A repeat read of a large page, and every page of it after the first, is a Storage read and a slice. The first read of a version still converts, once.
- A rules change, a renamed origin or a rotated link key leaves objects nobody reads. They go with the version's withdrawal or the document's purge.
- A public unpinned `.md` can already be served from a CDN for `PUBLIC_CACHE_SECONDS` after a publish (§17); keeping readings adds no staleness to that, and the front matter's `version` says which version it is.
- `stored-reading.test.js` pins the object's name and the miss, hit and refusal paths, version reuse, keyed and unkeyed reads, malformed objects and failed writes, each with a negative control.

## What would change this

- First reads of real documents still over about a second in production. Then spike the reading's rules on `@mdream/js`, adopting it only if `reading.test.js` passes unchanged.
- Kept readings growing to a cost that matters beside the versions they belong to. Then they expire, like a cache, instead of living as long as the version.
