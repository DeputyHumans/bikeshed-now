# 0019 — A folder's link reaches everything beneath it, to read

**Status** Accepted · **Spec** §2, §4, §13, §17, §19

## Context

A document could be private, unlisted or public, and could expire. A folder
could only be shared with people. Sharing a whole folder with someone who has
no account meant making every document in it unlisted, sending one link per
document, and repeating that for every document filed later. SPEC §17 said
folders had "no visibility and no expiry".

There were three ways a folder's link could work:
- open every document beneath it, including documents that are private on
  their own;
- open only the folder's own documents;
- list only documents that were already shared on their own.

The rules shaped the choice. Firestore rules cannot walk a folder chain, and
expiry is not in the rules at all (§17). Comments, annotations and presence are
read straight from the client, under the rules. So a read decided by a folder's
key can only be made by the functions, which is where every document byte
already goes.

## Decision

1. **A folder has the three levels, a link and an expiry.** It has no open
   editing. The token is minted, kept and deleted on the document's rule, so
   making the folder private and then unlisted again revokes every link.
2. **What it opens is the whole subtree**, including documents that are private
   on their own and documents filed later. This is §13's "filing is sharing",
   extended to strangers.
3. **Reach is denormalized, as membership is** (ADR 0006). A folder stores
   `reach`: its own entry plus its parent's `reach`, recomputed by the same
   cascade, parent before child. A document stores nothing new. A read through
   a folder loads the document's own folder, and only after the document's
   own basis has said no.
4. **A reach entry stores sha256 of the key, never the key.** A folder's members
   can read its record. A member of a subfolder must not learn the key to an
   ancestor folder they cannot open.
5. **It opens documents to read, and nothing else.** `readAccess` adds a
   folder's reach on top of `readBasis`, and only read paths call it: the
   bytes, thumbnails, downloads, a fork's copy, views, `/unlock` and the page
   shell. Every write keeps `canRead` and `canEdit`, which never look at a
   folder. A folder reader gets no link grant, so the rules give them no
   comments, annotations or presence. They see the document and not its
   threads.
6. **Expiry ends the reach only.** Members keep their access, and nothing
   beneath the folder is frozen. A document's own expiry still wins over any
   folder.
7. **A document under a public folder is mirrored to `public/{docId}`**, marked
   `viaFolder`. That mirror is what lists it in the sitemap. Presence and the
   live log stay keyed on the document's own level, so a public folder writes
   no realtime `*` key.

Two alternatives were rejected:
- **Copying the folder's key onto every document.** Any member of one document
  could then read a key that opens the whole folder.
- **Walking the ancestors on every read.** That is a read per level, on the
  busiest path. With the reach denormalized it is one read, and none when the
  document's own basis already decides.

## Consequences

- **Making a folder public exposes documents its owner does not own.** A
  document someone else filed into the folder becomes readable by anyone. Its
  owner's share dialog says through which folder, and filing responses name
  the wider audience. Nobody is asked first, as nobody is asked today when a
  folder gains members.
- **Revocation is not instant everywhere.** Documents directly in the folder
  stop answering to an old key at once. A subfolder's documents follow when the
  cascade reaches that subfolder, typically within seconds. The five-minute CDN
  window of §17 applies on top.
- **A folder reader cannot comment, even signed in.** Commenting needs a grant
  the rules can see, and the rules cannot see a folder's key.
- **One more read per refused byte request** for a document that is filed in a
  folder, on the path that is about to answer 404.
- **A title outlives an ended public reach in `public/`,** as it outlives a
  document's own expiry. The mirror carries the date, and nothing deletes it
  at the moment it passes.

## What would change this

- **Commenting through a folder link is asked for:** mint a per-folder grant and
  denormalize grant holders onto documents, as `members` is.
- **The cascade's revocation window is measured as a problem:** have read paths
  also check the reaching folder's own record, which costs one more read per
  request.
- **Owners object to their documents going public through someone else's
  folder:** let a document refuse inherited reach, at the cost of a second
  setting in every share dialog.
