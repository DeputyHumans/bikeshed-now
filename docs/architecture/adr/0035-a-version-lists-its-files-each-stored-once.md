# 0035 — A version lists its files, and each file is stored once per document

**Status** Accepted · **Spec** §2, §4, §8, §9, §9.1, §19, §21 · **Amends** [0033](0033-a-reading-is-kept-once-made.md) (what a kept reading is named by)

## Context

Every version owned a prefix holding a full copy of every file. Changing one picture in a deck meant reading every file back into memory, uploading every one of them again, and keeping a second copy of each, so two versions of a 20 MB deck cost 40 MB. Every minting path worked this way: an update through a token, the in-app commit, an agent's commit and a fork. That was tolerable under a 25 MB cap. It stops being tolerable when a document carries its own video (ADR 0037), when stylesheets, scripts and pictures move out of the page into files beside it (ADR 0036), and when an agent revises a document dozens of times a day.

The content hash had the same shape. SPEC §9.1 hashed every byte of every file, so even a version that copied nothing would have read all of its files to be minted.

## Decision

1. **Each file's bytes are stored once per document,** at `docs/{docId}/blobs/{sha256}`, written create-only. A `412` means the bytes are already there, and that is success. Files are scoped to their document, not shared across the deployment, so purge still deletes `docs/{docId}/`, a fork copies what it uses, and no account can probe whether another document holds some bytes.
2. **A version's record lists its files** in `files`, `hashes` and `sizes`, in the §9.1 order, with `layout: "blobs"`. A new version writes only the files it brings and names the files it carries over. Minting reads no file it carries.
3. **One resolver.** Every reader asks `lib/storage.ts` (`versionObjectKey`, `versionFiles`) where a version's file is. `wiring.test.js` fails if any other module turns a version into a prefix, so no reader can read a stored version as if it had a prefix.
4. **The content hash covers the file list.** §9.1 v2 hashes each file's path, size and SHA-256 behind a domain tag and is recorded as `hashVersion: 2`. Older versions keep v1. "Identical bytes mint no version" compares a new version with the head in the head's own framing. Both runtimes are pinned to golden vectors computed outside this repository, and one vector pins the sort order, which is UTF-16 code units, not the "byte order" §9.1 used to claim.
5. **Old versions are never rewritten.** They keep their prefixes, and nothing is backfilled. The first version minted over such a head reads its files once (25 MB at most, since that was their cap) and stores them.
6. **Nothing stored is deleted on a refusal,** because another version or a concurrent publish of the same bytes may name it. A retried transaction recognizes its own commit by the record's `attempt`, not by a prefix. A new document claims its id with one empty create-only object, `docs/{docId}/claim`, because identical files can no longer tell two creates of one id apart.
7. **Withdrawal deletes only what no other version names.** Its repoint transaction reads every version and marks the rest `withdrawing: { hashes, until }`. A mint that would reuse a marked file is refused until the script clears the mark, and the mark lapses after an hour if the run dies first.

## Consequences

- Revising one file of a large document writes one object and reads none. The update, draft commit and fork tests run against a bucket whose reads of stored files throw.
- Storage holds one copy of each distinct file per document, however many versions name it.
- Every mint answers `{ changed, unchanged, removed }` against the version it replaces, when that version lists its files. That is how the browser and the CLI can say "1 file changed, 23 unchanged".
- Two layouts are read for good. The resolver and its wiring test are what keep that from leaking into every reader.
- A hash a client stored before this release does not match the v2 hash of the same bytes. The value is opaque wherever it is returned, and dedup compares with the head in its own framing, so nothing breaks.
- Withdrawing a version no longer removes a file that another version also holds. To take a file out of every version, every version that names it must be withdrawn. The dry run lists which versions keep it.
- Files from refused or abandoned attempts stay until the document is deleted forever, as orphan prefixes did before, and a retry reuses them.

## What would change this

- Withdrawal needing to remove one file from every version at once, for example a secret published in a picture across many versions. Then a per-file purge belongs in the operator tools, decided by its own ADR.
- Storage cost from distinct files that no version names, from attempts that failed and were never retried, growing large enough to show on the bill. Then a sweep of unnamed files belongs in the daily purge job.
- A need to share bytes across documents, for example forks of a large original. That would mean a deployment-wide store, and it would reopen the probing question this ADR closes by scoping files to their document.
