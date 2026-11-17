# 0029 — Expiry makes it private, on an hourly job

**Status** Accepted · **Spec** §2, §4, §17, §19 · **Amends** [0019](0019-folder-links-reach-their-subtree.md), [0025](0025-the-trash-empties-on-one-daily-job.md)

## Context

A document's date froze it. Once the date passed it was read-only and readable by its owner alone, for everyone, the owner included, until somebody changed or cleared the date (SPEC §17 as it stood). That protected against a typo taking a document down, but in use it meant a document past its date could not be edited, commented on, or even shared differently, and the people it had been shared with by name lost it along with the strangers holding its link. Sharing it with six reviewers until the review ended took it from the six as well.

The Share dialog made it worse: it sent the stored date back with every change, and the server refuses a date in the past, so every change failed until the date was cleared. That was a bug, fixed separately. The freeze was the design.

A date that only ends the link and public access needs nothing new from the reader's side. A folder's date already worked that way, ending its reach while its members kept everything. What it needs is a moment at which the record actually changes, so the change shows in its history and the owner's choices afterwards start from a private document, not from a frozen one. Nothing here acted on a clock except the Trash's daily job, and ADR 0025 said a second thing that must happen on one deserved its own decision.

## Decision

1. **When its date passes, a document becomes private and its date is cleared.** Its level goes to private, open editing goes off, and its link token is deleted, so every copy of the link stops working for good; making it unlisted again mints a new one. Its grants are untouched: the people it was shared with by name, and a folder's members, keep reading and editing it. Nothing is deleted. A folder's date does the same for the folder, and its reach beneath it ends with its level.
2. **An hourly scheduled function, `applyExpiries`, makes the change.** It finds every document, then every folder, whose date is at or before now, walking each by a cursor so that skipped items cannot hide the rest, until a deadline short of its timeout, and says `more` when it stops early.
3. **Until the job runs, a passed date freezes as it always did.** Every read path, write path and rule that checks the date is unchanged: the document is its owner's alone and takes no writes. That is stricter than private, so the hour can delay people getting it back but can never let anybody in who would not be let in after.
4. **The date is cleared last.** One transaction makes it private and records the change under an id derived from the date; the public mirror and a folder's subtree follow; a second transaction deletes the date only if it is still the one the run saw. A run that stops between the two leaves the item private, still frozen and still matched, and the next run finishes it without recording it twice. A new date the owner sets meanwhile is kept.
5. **Each switch is recorded once, as the date's doing.** A document's change log gets one `doc.expired` event for editors, with the level it had and whether open editing ended, under a new `system` actor with no account. A folder's access history gets an entry with `reason: "expired"`.
6. **The Trash is left alone.** Restore gives back exactly what it took, so a trashed item keeps its level and date; restored after its date, it is frozen until the next run makes it private.

## Consequences

- Named people can be locked out for up to an hour after a date. An hourly job was chosen over a more frequent one as the cheaper of two acceptable waits.
- An unlisted or public folder above a document reaches it again once its own date is cleared, as it reaches any private document filed there (ADR 0019). A document's own date used to win over every folder for good; now it wins only until the job runs. The Share dialog says when a folder above still reaches the document.
- A document past its date no longer keeps a title in its public mirror for good: the mirror goes when it becomes private.
- Every document and folder already past its date is converted by the first run, and their named people get them back.
- There are two scheduled jobs. Each is a Cloud Scheduler job to deploy and, where the platform needs it, an invoker grant to give, and neither runs in the emulator: both are tested as library calls, and A4.5 calls `expireDocument` itself.
- An actor with no uid no longer always means an operator script.

## What would change this

People needing the old freeze, a document kept from its named people too after a date: that is a different setting, revoking grants, not this one made stricter. An hour proving too long for the people locked out: the cadence is one line. A third thing that must happen on a clock: then these jobs become a scheduler, which deserves its own decision.
