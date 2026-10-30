# 0024 — Deletion goes through a Trash

**Status** Accepted, amended by [0025](0025-the-trash-empties-on-one-daily-job.md), which ships decision 5 · **Spec** §4, §5, §13, §17, §19 · **Amends** [0017](0017-agent-management-with-owner-permissions.md)

## Context

A document could not be deleted through any path. That was stated as a product decision about a review tool: what was shared for review stays reviewable, and a link someone was sent keeps working. In practice people uploaded the wrong file, made a document by mistake, or finished with one, and the only way to make it go away was to ask whoever runs the deployment. Folders could be deleted, but deleting one only moved its contents up a level, so a folder full of finished work could not be put away either.

A deletion that takes effect at once is the opposite problem: one click, by a tired owner or by an agent acting on a misread instruction, destroys work other people commented on, with nothing to recover.

## Decision

1. **Deleting moves to the Trash.** The owner moves a document there. The owner of a folder moves the folder there with everything in it, other people's documents included, because a folder is put away whole. Nothing is deleted: versions, feedback, grants and links stay where they are.
2. **In the Trash, an item is its owner's alone and frozen.** Its members are its owner (the membership computation, in both twins, so no recompute can hand it back); a link, a link grant, a folder's link, open editing and the public mirror all stop working; every read path that refuses an expired document to a non-owner refuses it, and every write path refuses it to everyone, the owner included. It is expiry's rule, `isFrozen`, extended rather than repeated beside it.
3. **Restore gives back exactly what was taken.** Every grant comes back, and the item returns to its folder while that folder is still there, otherwise to its owner's root. A folder's restore brings back what went with it (one `batch`) and not what its owner already took back or what went to the Trash separately. Each owner restores their own documents from a trashed folder, at their own root.
4. **Agents may trash and restore, and list the Trash.** They act with their person's permissions, as everything else does (ADR 0017). `delete_folder` now trashes.
5. **Permanent deletion is a separate step, and a later release.** It empties the Trash after 30 days, or earlier from the browser only with a code emailed to the account. No agent can do it. Until it ships, nothing leaves the Trash.

## Consequences

- Links stop working for everyone but the owner while an item is in the Trash, and start again on Restore. A reader is told nothing they were not told before: a trashed document is the same 404 as one that does not exist.
- A folder's owner can put away documents they do not own. Those owners lose nothing: each finds their document in their own Trash, marked with the folder it went with, and restores it. The folder's owner cannot see or restore someone else's document.
- Trashing a folder is one membership write per item, as recomputing it is; the cost stated in overview.md applies.
- Live editors of a document that goes to the Trash lose access as anyone whose access is removed does; their unsaved draft stays on the record and is there again on Restore.
- Nothing can be filed into a trashed folder, and a trashed item cannot be renamed, moved, shared or made public until it is restored.
- The CLI before 0.20 sends `delete` for `delete-folder`, which now trashes instead of moving the contents up. Nothing it deleted before is affected.

## What would change this

Evidence that owners need a document gone at once, with no recovery window, more than they need protection from a mistake: that is a stronger second factor for the early purge, not a Trash that can be skipped. Or evidence that folder owners putting away other people's documents surprises those people: then a folder takes only what its owner owns, and leaves the rest at their owners' roots.
