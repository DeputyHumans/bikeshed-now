# 0016 — A change log an agent pulls, one per document

**Status** Accepted · Amended by [0023](0023-attribution-names-the-credential.md): the log now also feeds the Activity panel, and an actor's channel is its credential's · **Spec** §4, §14, §17, §19

## Context

An agent that publishes a document is asked to keep watching it and answer what
people say. To do that it needs one question answered cheaply and completely:
*what happened since I last looked?*

The records that exist cannot answer it.
- **It is too expensive.** Re-reading every thread costs a read per thread per
  poll, and puts the whole conversation into the agent's context each time.
- **Some changes leave nothing behind.** A version withdrawn, a visibility
  changed, and a resolve made in the browser record nothing that says what
  changed or who did it.

The activity panel (§17) assembles its feed from existing collections with "no
new writes", which is right for a panel an editor opens now and then. It is the
wrong shape for a poll every minute that must also report what leaves no record.

Three statements stand in the way:
- the code comment in `onCommentCreated`, "the moment this needs any of those [a
  queue, a scheduler, a cron], it has become a notification system, and this
  product does not have one";
- §14's "a notification centre" and §19's "webhooks", both listed as not built;
- the agent guide's "There is no session state".

## Decision

1. **One append-only log per document, `docs/{docId}/events`.** Every event says
   what changed, who may read about it (`readers`, `editors` or `owner`), and
   who caused it: a uid, a channel and a token, never an email. It stores no
   body. Email and bodies are joined from the source record when the log is
   read, so a deleted comment drops out rather than living on here.
2. **Triggers record what many paths change; endpoints record what they alone
   change.**
   - Three Firestore triggers, each with `retry: true`, cover versions, threads
     and comments.
   - The document record cannot carry a trigger, because every view heartbeat
     writes it. So the endpoints that rename, move, share, trust or change the
     visibility or expiry of a document write their event in the same batch as
     the change.
3. **Created, never overwritten.**
   - Events are ordered by `at`, which is when the event was written, by the
     server's clock.
   - A trigger's event takes the CloudEvent's id, so a redelivery finds it and
     writes nothing. An overwrite would move `at` past a cursor, and the event
     would be reported twice.
4. **Pulled, never pushed.** `get_changes` reads the log after a cursor. Nothing
   is queued, scheduled or sent. The one thing kept per credential is the last
   cursor it was given for each document, for clients that forget between
   conversations.
5. **Only a poll moves a cursor.** Publishing or forking seeds one, because the
   document is new. Reading a document starts one, but never overwrites one
   already saved. A write to an existing document hands back none: a cursor
   from the head of the log would skip what came after the caller's last poll.

Why this is not the notification system that the code comment refuses:
- Nobody is told anything. The log is written as a side effect of changes that
  happen anyway, and is read only by whoever asks, as often as they ask.
- There is no queue, no fan-out and no delivery state per recipient.
- The cursor kept per credential is a bookmark, not a session. Every request
  still carries its own credential, and the protocol stays stateless.

Rejected:
- **Deriving the feed at read time.** That is about eight queries plus one per
  open thread on each poll, and it still has no record of withdrawals, visibility
  or browser resolves.
- **One feed for the whole workspace.** Events would need `members` copied onto
  them, and every access cascade would rewrite them.
- **Recording in `onCommentCreated`.** It sends email and does not retry.
  Retrying it would resend mail; not retrying loses events.
- **Webhooks or SSE.** The server is POST-only and keeps no connections.

## Consequences

- **Writes.**
  - One event per change.
  - One trigger invocation per version, thread and comment write.
  - One saved-cursor write when a poll moves a credential's cursor. A quiet poll
    writes nothing.
- **Folder and team cascades record no per-document event.** They change who can
  read a document without a write of its own. `get_changes` reports `readers` in
  its `state`, so a watcher sees the change between polls.
- **The order is the order of recording, not of occurrence.** Two changes
  seconds apart through different triggers may be recorded either way round.
  The log promises no lost and no repeated event, not chronology.
- **Never pruned.** A cursor from a year ago still resumes exactly.

## What would change this

- **A client is seen that can only learn of changes by push:** add delivery, and
  give this ADR's Decision 4 up deliberately, in a new record.
- **Agents are seen watching more documents than they can poll one by one:** a
  workspace feed, with the cost of copying membership onto events.
- **The log's reads are seen to dominate a deployment's bill:** prune it behind
  a horizon and refuse older cursors by name, rather than read them as "start".
