# 0027 — A reader lists their own reading, across documents

**Status** Accepted · **Spec** §4, §5, §13

## Context

The workspace is getting a Recent page, the landing page once signed in: what you read lately and what got a new version, newest first. "What you read" already exists. `recordView` keeps a per-person rollup for every signed-in human reader, the owner included, at `docs/{docId}/viewers/{uid}`, with `lastViewedAt` moved on every reading beat. But the rules let only a document's editors read those rows, and a rules test pinned that a viewer could not read even their own.

Three ways in were weighed. A server route on the stats function would have filtered rows by current access and left the rules alone, at the cost of a functions change, an uncached response to prove on a real deployment, and up to two hundred reads per landing. Letting each reader get their own row on each document they can open needed no index, but cost one read per document in the workspace on every landing. Or the rules could let a person list their own rows directly, across documents, with one bounded collection-group query.

## Decision

1. **A verified person may `list` their own `viewers` rows across documents.** The rule is a recursive match, `/{path=**}/viewers/{viewerId}`, because that is the only block a collection-group query consults. It allows `list` when the identity gate passes and the row's stored `uid` is the caller's, so the query must filter on that field (rules are not filters). Recent asks for at most the 100 newest by `lastViewedAt`, from a collection-group index.
2. **`get` stays the editors'.** The per-document read of anyone's row, the caller's own included, is unchanged. The grant is the smallest one Recent needs.
3. **The app decides what is shown, not the rows.** Recent joins the rows against the workspace query, which returns only documents its reader may read now, outside the Trash.
4. **Nothing new is written.** The rows are the ones `recordView` already writes.

## Consequences

- A row outlives access to its document. After an unshare or a Trash, its reader can still list it until the document is deleted forever. It holds the docId, which is a slug of the title, and the reader's own counts and times: nothing they did not see when they read it.
- A recursive match cannot name its parent. The rule holds only while `viewers` names exactly one collection, which `tools/viewers-collection.test.mjs` pins by listing every place the source names one. A second collection called `viewers`, anywhere, would be listable by its `uid` field.
- The same match answers a list of one document's readers filtered to the caller, on a document they cannot open too. It returns only their own row.
- The index builds after a deploy. Until it is ready the query fails, so Recent falls back to updates alone and says why. The emulator never enforces indexes, so this shows only on a real deployment.
- Rows are written for reads that last past the two-second open delay, and never for an agent's. Recent's "you read it" means what the statistics already mean.

## What would change this

A second collection that has to be called `viewers`: then the rows carry a field only they have, and the rule and query filter on it. Evidence that a row for a document someone has lost access to tells them something they did not know: then the reads go through a server route that checks access first. A workspace large enough that 100 rows no longer cover a month of reading: raise the bound, which is one constant, before anything else.
