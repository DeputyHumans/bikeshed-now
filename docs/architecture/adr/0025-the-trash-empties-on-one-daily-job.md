# 0025 — The Trash empties on one daily job, or sooner with an emailed code

**Status** Accepted · **Spec** §2, §4, §14, §19, §21 · **Amends** [0024](0024-deletion-goes-through-a-trash.md) · **Supersedes** overview.md's "No scheduler, no cron"

## Context

ADR 0024 made deleting a move to the Trash and left permanent deletion for a later release: the Trash would empty itself after 30 days, or sooner from the browser with a code emailed to the account, and no agent could do either. Two facts stood in the way.

Nothing here ran on a clock. Expiry is decided when a document is read, which is why it never needed a job. A Trash cannot work that way: nothing reads a Trash nobody opens, so "deleted 30 days after it arrived" is a promise only something running on a schedule can keep.

And a deleted document's id would be free again. Document ids are slugs of titles, so `uniqueDocId` hands out `plan` to the next document called Plan. A stale link, a fork's lineage or an agent's saved cursor that named the old one would then open a stranger's document.

## Decision

1. **One scheduled function, `purgeExpiredTrash`, runs once a day.** It finishes any purge an earlier run left part way, then deletes forever whatever has been in the Trash for 30 days, anyone's, in pages, until a deadline short of its timeout; what it does not reach it reaches the next day. It is the only job here. Expiry, notices and everything else are still decided when something is read or written.
2. **A deleted document leaves a tombstone, `{ purgedAt }`, in place of its record.** It names no owner and no member, so every gate refuses it as a document nobody may read, and it stays for good, so its id is never reused. The tombstone is written first, in a transaction that confirms the document is still in the Trash and still in scope; only then are its subcollections, its public mirror, its Storage objects under `docs/{id}/` and its live-editing state deleted, and `purgePending` marks a purge not yet finished. Its fork record goes and its original's fork count drops in the same transaction. A folder's record is deleted outright: its id is random and nothing else is keyed by it.
3. **Its owner can delete sooner, from the browser only, with an emailed code.** `POST /purge` refuses every token and accepts only the web session. A code is sent to the account's own address for exactly one thing, one item or the whole Trash; it is valid ten minutes, used once, burned by five wrong guesses, and another may be asked for a minute after the last. It is kept in `purgeCodes/{uid}`, which no client can read. Where the deployment's email is off there is no early deletion, and the Trash says it empties itself.
4. **An early purge takes only its owner's things.** A folder deleted early takes what of its owner's went to the Trash with it. Other people's documents that went with it stay in their Trash, with their own 30 days, and come back at their owners' roots if restored. Anything still live inside, which only a race with the Trash itself can leave, goes to its owner's root rather than under a folder that no longer exists. The daily job takes everything in a folder's batch: 30 days is 30 days for everyone in it.
5. **No agent deletes anything forever.** There is no tool for it, and the endpoint refuses tokens, a personal one, the CLI's or a connected app's.

## Consequences

- Deploying needs the Cloud Scheduler API and a deployer that may create scheduler jobs (docs/operations/overview.md). Neither shows locally: the Functions emulator loads a scheduled function and never runs it, so the job is tested as a library call.
- What has left this system cannot be recalled: a page a CDN cached for up to five minutes, thumbnails in a browser's cache for up to a day, email already sent, and anything a reader saved. The threat model says so.
- A fork whose original was deleted says so (`deletedAncestor`, `moreWasDeleted`) instead of calling it a document the reader cannot open. A tombstone tells nobody anything but that something was deleted, which whoever forked it knew existed.
- Tombstones accumulate, one small record per deleted document, forever. That is the price of ids that mean one document.
- A purge interrupted between its tombstone and its last deletion leaves bytes in Storage until the next daily run. Nobody can read them meanwhile: every path to them goes through the record, and the record is a tombstone.
- A browser left signed in on a shared computer can move things to the Trash, as before, but cannot delete them without the inbox.

## What would change this

Evidence that people need to delete things where email is off: then a second factor that needs no email, not deletion without one. Evidence that 30 days is wrong for most people: the number is one constant, `TRASH_RETENTION_MS`. A second thing that must happen on a clock: that is when this one job becomes a scheduler, and that change deserves its own decision.
