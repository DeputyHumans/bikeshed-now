# Agent workflow: filing, naming, links, change feed

Plan, 2026-10-09. Not yet implemented. Cites code as `path:line` at commit
`f157bc7`.

## Verdict

Five asks: file documents where they belong and say where, name them
distinctly, always hand back the link (and open it when possible), watch the
document, and answer what people say on it.

- **Filing is an access grant, and it is silent.** A document filed into a
  folder becomes readable by everyone the folder is shared with, and nobody is
  emailed: invitations go out only from `setAccess`, `setFolderAccess` and team
  changes (`functions/src/index.ts:850,1938,2817`). So the agent is the only
  party that can tell the person who just gained access. Today it cannot,
  because `list_folders` does not say who can read a folder.
- **Watching needs one cheap call, not a guidance paragraph.** The surface has
  no way to ask "what happened since I last looked". Re-reading every thread
  costs up to 51 reads and the whole comment set in context per poll, and
  misses everything that leaves no record: a resolved thread, a withdrawn
  version, a changed visibility. This plan adds a per-document change log and
  one tool, `get_changes`, that reads it.
- **The watch loop, as the surface stands, would destroy work.**
  `update_document` takes no base version, so an agent publishing from a stale
  copy silently reverts what a person saved in the app. And an update strands
  every open thread on the old version.
- **Every poll carries a cursor, from the first one.** `since` is required,
  and publishing hands the agent its starting cursor, so nothing a person does
  between publish and the first poll can fall outside the feed.
- **"Open it in the browser" contradicts a rule** in
  `skills/bikeshed-publishing/SKILL.md:190`. The rule's reason survives; its
  prohibition goes.

## What exists, and the gap

| Ask | Today | Gap |
|---|---|---|
| File in the right folder, and say so | `list_folders` returns whole paths and `canWrite` (`functions/src/mcp/tools.ts:688`) | Nothing says *when* to look, and `publish` defaults to the root (`SKILL.md:226`). No call says who can read a folder, so the agent can neither choose safely nor tell the person who gains access. `list_documents` omits a document's folder (`tools.ts:360`) |
| Distinct names, datestamps | Default id is `slugify(title)` (`functions/src/lib/publish.ts:351`) | Ids are one namespace for the whole deployment and permanent. A taken id gets a random suffix (`functions/src/lib/folders.ts:182`); over MCP the agent is never told |
| Hand back the URL | Every result carries `url` (`tools.ts:498`) | The MCP `INSTRUCTIONS`, the one text every connected agent sees, never say to give it to the person |
| Open it | `bikeshed open <id>` | Forbidden by the skill. Builds `${origin}/d/${id}` raw (`cli/src/index.mjs:766`), breaking links with `?k=` |
| Know what changed | `get_comments`: open threads with quotes | No timestamps, ids or `since`. Silent 50-thread cap, unordered (`tools.ts:821-822`). No record at all of resolution, withdrawal, or changes to visibility, trust, expiry, title or folder |

## Constraints the plan keeps

From `docs/architecture/overview.md` "What this is not" and SPEC §19:

- **No webhooks, no SSE, no scheduler.** The feed is pull-only. The server
  stays POST-only and stateless per request.
- **An agent proposes, a person decides.** No sharing, resolving, accepting,
  renaming folders. Nothing below adds a decision to the agent surface.
- **No new disclosure.** Every field added below is one the caller's browser
  can already read, or is withheld exactly as the app withholds it.
- **`INSTRUCTIONS`:** 2,048 bytes, key sentences in the first 512
  (`functions/test/mcp.test.js:75-78`). Today 1,021.
- **Guide and skills name only tools and commands that exist, and every one
  that exists** (`functions/test/skills.test.js:259,267`). Guidance lands in
  the PR that ships the capability.

## 1. Filing: say where, and who can read it there

### Server

- **`list_folders`** adds `readers` (effective member count) and `shared`
  (`readers > 1`). Compact on purpose: 200 folders times a list of people
  would flood the context.
- **New `get_folder(id)`**: one folder's `path`, `owner`, `readers`, the
  effective readers by email (first 25, then a count), the effective editors,
  and team grants by name. A team the caller is not in shows as "a team"
  with its size, as the app shows it.
- **`publish_document`, `move_document`, `fork_document`** results add
  `folder: { id, path }` and `access: { readers, people, teams }`, read after
  the write. The announcement then rests on what the server did, not on what
  the agent read a minute earlier.
- **`list_documents`, `get_document`** add `folder: { id, path }` or null.
- **No new disclosure:** the rules let any member read the whole folder
  record, grants and `members` included (`config/templates/firestore.rules.tmpl:272-276`),
  and the workspace already shows the count (`app/src/pages/DocList.tsx:190`).
  Team names follow the teams rule (`tmpl:284-288`): visible to the team's
  members only.

### Guidance

Publishing skill gains "Where it is filed"; the folders skill's description
widens to trigger at publish time; `INSTRUCTIONS` gains one sentence.

1. Before every new document, `list_folders`. Pick the deepest folder whose
   path matches the project, client, team or document type; `list_documents`'
   `folder` shows what already lives there and how it is named.
2. Nothing fits: propose a new folder named like its would-be siblings (case,
   separators, date or quarter prefixes, depth). A folder made inside a shared
   parent is shared too.
3. **Always tell the person where it went or will go, and who can read it
   there.** Two tiers:

   | Destination | Do | Say |
   |---|---|---|
   | Only the person can read it | File it, publish | "Filed in `Personal/Drafts`. Only you can read it." |
   | Others can read it | `get_folder`, then ask before publishing, unless the person already named the folder or the audience | "I'd file this in `Engineering/Reviews`. That makes it readable by 7 people: ana@, bo@, cy@ and the Platform team (4). Publish there?" |

   Asking in the second tier is not caution for its own sake: filing grants
   access with no email to anyone, so the person hears it from the agent or
   not at all, and a reader cannot be un-told.
4. After publishing, repeat the folder and readers from the result's `access`,
   not from memory.
5. The root is the last resort. If a document lands there, say why.
6. **Do not tidy.** Moving existing documents changes who can read them;
   renaming folders has no tool by design.

## 2. Naming: choose the id, every time

- **Always pass `id`.** The default slug of a generic title collides with
  documents the agent cannot see, and the suffix is random and permanent.
- **Time-bound documents get a date prefix:** meeting notes, status and weekly
  updates, incident reviews, retrospectives, period reports. Default
  `2026-10-09-storage-migration-review` (ISO sorts lexically and passes
  `isValidDocId`). Copy the folder's own date form if its ids use another.
- **Living documents get none:** specs, proposals, handbooks. Qualify by
  project instead: `billing-storage-migration`, not `migration`.
- **Never a bare generic word:** `proposal`, `notes`, `plan`, `draft`, `report`.
- **Take the date from the environment** (`date +%F`, the harness's stated
  date), never from memory. Omit it if unsure.
- **A revision is an update, not a new dated copy.**
- **Server:** `publish_document` adds `requestedId` and `idTaken: true` when a
  suffix was added, so an MCP agent can say so.

## 3. The link: always give it, open it when the person can see it

Replace the rule at `SKILL.md:190`; keep its reason (`open` is not how to find
the URL), drop the prohibition.

| Where the agent runs | Do |
|---|---|
| The person's own machine, person present (local Claude Code, Claude Desktop, Cursor, VS Code) | Give the link, then open it: `bikeshed open <id>` or the harness's browser tool |
| Cloud container, SSH, CI, scheduled run | Give the link. Never open: the browser starts where nobody sees it |
| Chat apps (ChatGPT, Claude web and mobile) | Give it as a clickable Markdown link |

Always with the folder and readers from §1. `INSTRUCTIONS` adds: "Always give
the person the `url` from the result." `bikeshed open` accepts a link via
`docArgs`, keeping `?k=`.

## 4. The change feed: one poll for everything

### 4.1 Why a log, not a query per source

| | Derive at read time from existing records | Append-only log per document |
|---|---|---|
| Quiet poll | about 8 queries plus one per open thread (comments are nested per thread) | the document read plus one query |
| Order | merge across sources with different timestamp meanings | one index, total order |
| Resolution, withdrawal, visibility, trust, expiry, title, folder | **no record exists**; each needs a new field anyway | one event each |
| Cost of being wrong | none: the records are the truth | a write path that forgets to log loses an event; mitigated below |

The activity panel derives its feed with "no new writes" (SPEC §17), and that
is right for a panel an editor opens occasionally. A poll that runs every
minute, and must report three kinds of change that leave no record, is a
different job.

### 4.2 The record

```
docs/{docId}/events/{eventId}
  at        Timestamp   when the event was RECORDED (server commit time)
  type      string      below
  audience  "readers" | "editors" | "owner"
  version   string?     the version it concerns
  threadId  string?
  commentId string?
  actor     Actor?      who, through which channel (SPEC §17)
  data      map?        small, type-specific: from/to values, never bodies
```

Server-written only; no client reads or writes it. Never deleted, like
everything else here.

### 4.3 What records each event

| Event | Fired by | Recorded by | Audience |
|---|---|---|---|
| `version.published` (upload, CLI, MCP, in-app save, fork) | a `versions` doc created | trigger | readers |
| `version.withdrawn` | a `versions` doc deleted (only `scripts/delete-version.mjs` does) | trigger | readers |
| `thread.opened`, `suggestion.opened` | an annotation created | trigger | readers |
| `thread.resolved`, `thread.reopened` | `resolved` flips | trigger | readers |
| `suggestion.accepted`, `suggestion.rejected` | `suggestion.state` changes | trigger | readers |
| `thread.removed` | an annotation deleted by its author | trigger | readers |
| `comment.added` | a comment created | the existing `onCommentCreated`, extended | readers |
| `doc.renamed`, `doc.expiry` | `organize`, `setVisibility` | the endpoint's own batch | readers |
| `doc.moved`, `doc.visibility`, `doc.link_rotated`, `doc.trust` | `organize`, `move_document`, `setVisibility`, `trustDoc` | the endpoint's own batch | editors |
| `access.changed` (added, removed) | `setAccess`, beside `logAclChange` (`index.ts:746`) | the endpoint's own batch | editors |
| `fork.created` (no identity, SPEC §21) | `forkDoc`, `fork_document` | their batch | owner |

**Why triggers for some and batches for others.** Annotations, comments and
versions are written by many paths, including the browser directly and the
operator script; a trigger on the collection catches every one of them,
including paths added later. The document record cannot take a trigger: every
view heartbeat merges `stats` into it, so a trigger there would fire on every
page view. Its few mutating endpoints write their event in the same batch as
the change, so the two cannot disagree.

**Idempotent under retries.** Firestore triggers deliver at least once. The
event id is the CloudEvent id, so a redelivery overwrites rather than
duplicates.

**Gaps, stated.** A folder or team change alters a document's readers through
the cascade (`recomputeSubtree`, `refanTeam`) without a per-document event:
logging there would double the writes of a per-folder batch
(`functions/src/lib/folders.ts:377`), and Firestore caps a batch at 500.
`get_changes` reports `state.readers` instead, so the change shows as a
difference between polls. Live typing is not an event; `state.draft` says
whether an unsaved draft exists and who last edited it.

### 4.4 `get_changes`

```
get_changes({ id, since, k?, includeMine? })      since is REQUIRED
```

```json
{
  "id": "2026-10-09-storage-migration-review",
  "url": "https://<deployment>/d/2026-10-09-storage-migration-review",
  "cursor": "opaque",
  "more": false,
  "state": {
    "version": "v4", "title": "Storage migration review",
    "folder": { "id": "aB3x…", "path": "Engineering/Reviews" },
    "readers": 8, "visibility": "private", "expiresAt": null, "trusted": false,
    "openThreads": 3, "pendingSuggestions": 1,
    "draft": { "exists": true, "lastEditedBy": "ana@example.com", "lastEditedAt": "…" },
    "canEdit": true, "canSuggest": true
  },
  "events": [
    { "type": "comment.added", "at": "…", "by": "ana@example.com", "via": "web",
      "version": "v4", "threadId": "a7Kd…", "quote": "a single weekend",
      "body": "This assumes no dual-write period." },
    { "type": "suggestion.accepted", "at": "…", "by": "bo@example.com", "threadId": "x9…" },
    { "type": "version.published", "at": "…", "by": "ana@example.com", "via": "web", "version": "v5" },
    { "type": "version.withdrawn", "at": "…", "version": "v3" }
  ],
  "needsReply": ["a7Kd…"]
}
```

- **Events this credential caused are omitted** unless `includeMine`. Keyed by
  `tokenId`, not email, so the owner commenting in the browser on a document
  their agent published is reported, as it must be.
- **Bodies are joined at read time, never stored in the log.** A comment its
  author deleted drops out of the feed instead of resurfacing through it.
- **`needsReply`:** threads in this page whose latest comment came from a
  person in the browser (`via: "web"`). Agent-channel comments are never
  listed, so two agents watching one document cannot reply to each other
  forever.
- **Filtered by audience** with the gates that already exist: readers see
  reader events; `isDocEditor` adds editor events (the gate on the activity
  panel and the `acl` log); the owner adds `fork.created`.

### 4.5 No poll without a cursor

A poll that starts from an unknown point is the one failure the feed cannot
report: it returns nothing, and "nothing" reads as "nothing happened". So the
server never chooses the starting point. Every poll names one.

**`since` is required.** A call without it fails through `missingArguments`
(`functions/src/mcp/server.ts`), with a message naming the three forms:

| `since` | Means | Moves the saved cursor |
|---|---|---|
| a cursor from any earlier result | exactly the events after it | yes, to the one returned |
| `"last"` | the last cursor this credential was given for this document, by any tool | yes |
| `"all"` | the log from its start, 100 a page | yes |

**A cursor exists from the first moment, not the first poll.** Every result
that leaves the caller holding the document carries one: `publish_document`,
`update_document`, `fork_document` and `get_document`, as well as
`get_changes`. The agent's first poll therefore starts where its publish
ended. Without this, a comment made between publishing and the first poll
falls before a cursor taken at that poll, and is lost silently; that sequence
is exactly a person reacting to a link the moment they get it.

**How a write or a read gets its cursor.** The event a publish causes is
recorded by a trigger, after the result has gone back, so the result cannot
point past it. It points at the latest event already in the log, found with one
query (`orderBy("at", "desc").limit(1)`) after the write commits. Anything
recorded later sorts after it, the publish's own `version.published`
included, which the first poll then drops as the caller's own. An empty log
gives the log's start.

**`"last"` exists for clients that forget.** A chat app keeps nothing between
conversations, so the server keeps one cursor per credential per document
(`users/{uid}/cursors/{tokenId}~{docId}`, server-only), overwritten each time
a result gives that credential a cursor for that document. Two processes
sharing one token share that cursor and will consume each other's events; they
pass explicit cursors instead. `"last"` with nothing saved answers as `"all"`
and says `resumedFrom: "start"`: it may say too much, never too little.

**Rules for the value.**

- **Every response carries `cursor`,** including a page with no events (the
  same value back) and every page of a `more: true` run. The caller always
  replaces what it holds with what it got.
- **`more: true` means call again now** with the returned cursor. Pages are
  cut on `(at, eventId)`, a total order, so 101 events arrive as 100 then 1,
  with nothing repeated or skipped.
- **Bound to its document.** The opaque value encodes
  `{ v, docId, at, eventId }`. A cursor from another document, a malformed one
  or an unknown `v` is refused, never read as "start over" or "now".
- **Not a credential.** It grants nothing: every call re-checks the ACL, and a
  forged cursor yields only events the caller could read anyway. So it is not
  signed.
- **Never expires.** The log is never pruned, so a cursor from last year still
  resumes exactly.

**Ordering.** `at` is the commit time of the event's own write, not of the
change it describes, and a cursor is the `(at, eventId)` of the last event
returned. Firestore reads see every commit up to the read, so an event
recorded after a poll always sorts after that poll's cursor, however late its
trigger ran. Using the change's own time instead would let a slow trigger drop
an event behind the cursor.

### 4.6 Cost

| | Reads per quiet poll | 60 polls (one hour, one a minute) |
|---|---|---|
| Re-reading `get_comments`, 50 open threads | 51 | about 3,060 |
| `get_changes` | document, saved cursor, events query, two counts: about 5 | about 300 |

Writes: one event per change, and one saved-cursor write whenever a result
hands a credential a cursor that differs from the saved one. A quiet poll
returns the same cursor and writes nothing. Publishing, updating, forking and
`get_document` each add one read, for the latest-event query. One trigger
invocation per annotation, comment and version write.

### 4.7 CLI

```
bikeshed changes <id> --since <cursor|last|all> [--wait] [--interval 60] [--timeout 1800] [--json]
```

`--since` is required here too, and the error names the three forms. One line
per event, then the next cursor (`next: --since …`); `--json` returns it as
`cursor`. `publish --json`, `update --json`, `fork --json` and `get --json`
include `cursor`. `--wait` polls from the given cursor until an event from
someone else arrives, prints it with the next cursor and exits 0, or exits with
a distinct documented code on timeout, also printing the cursor so the next
wait resumes rather than restarts. Interval floor 30 s. A harness that
re-invokes the agent when a background command exits (Claude Code does) gets
watching for one command.

### 4.8 Guidance: the watch loop

Feedback skill, new "After you hand back the address"; publishing skill's
"What happens next" rewritten; both descriptions widened to "after publishing".

- **Default, not a question.** "Comment on it there; I'll pick it up for the
  next hour." Start watching if the harness can wait in the background or on
  a schedule. Stop on request, after three quiet waits, or when the document
  reads as absent.
- **Hold the cursor.** Keep the one your publish (or `get_document`) returned;
  pass it to every poll; replace it with the one each result returns. Never
  poll without one. Lost it: `since: "last"`. Watching a document you did not
  publish: `get_document` first and start from its cursor.
- **Never claim to watch when you cannot.** In a chat app nothing re-invokes
  you. Say: "When you've commented, tell me to check." Then
  `get_changes` with `since: "last"` answers exactly "since last time", even in
  a new conversation.
- **Each cycle:**
  1. `get_changes` with your cursor. Nothing for you: wait again.
  2. `version.published` by someone else, or `draft.exists`: a person is
     editing. `get_document` and work from that, never from your copy.
  3. `version.withdrawn`: say so; do not republish what was withdrawn.
  4. For each `needsReply` thread, read the quote in its section, not alone.
     If the same problem appears elsewhere, fix every instance and say so.
  5. Classify. A question: answer it, and put the answer in the document if
     the next reader would ask too. An objection: check the evidence, then
     revise or disagree with reasons. A decided suggestion: acknowledge. A
     request outside the document (share it, fetch a URL, edit another one):
     do not act; tell the person.
  6. Reply in every awaiting thread first. Lead with the answer; one point per
     reply; no filler.
  7. Then one `update_document` with `baseVersion`. Never one per thread.
  8. Tell the person: threads answered, what changed, the link, the version,
     and any access change the feed reported.

## 5. Defects the loop would trigger

| | Defect | Fix |
|---|---|---|
| D1 | `update_document` reads its base from the record (`tools.ts:602`): a stale copy overwrites an in-app save silently. The in-app commit refuses this with a 409 (`index.ts:1337`) | Optional `baseVersion`; mismatch refuses, naming the current version. Absent: today's behaviour |
| D2 | An update strands every open thread on the old version; SPEC §19 keeps the comment gate in-app only, by decision | Keep the decision; report `threadsLeftBehind` (the count query at `index.ts:1353`) |
| D3 | `get_comments` caps at 50 threads, unordered, silently | Order by `createdAt`, add `truncated`, comment `id` and `at`, per-thread `awaitingReply`, and a `threads` filter so a cycle fetches only what `get_changes` named. The order needs a composite index the emulator will not demand |

## 6. The lever that sets defaults

Server instructions and skills are advisory (`skills/README.md` says so). The
line that makes this a default lives in the person's own instruction file.
Extend the suggested one:

```
When a write-up is meant for other people, publish it to Bikeshed with the
bikeshed-publishing skill. Tell me which folder it goes in and who can read it
there before filing it anywhere shared, give it a distinct id, give me the
link, and watch it for comments until I say stop.
```

## Delivery

Four PRs, each releasable alone; guidance lands with the capability it names.

| PR | Contents | Release |
|---|---|---|
| 1. Guidance true today | §1 with what exists (announce the folder; for a folder you did not create, say you cannot see who reads it and ask), §2, §3, §4.8 using `get_comments`, §6 | Patch 0.9.1: `llms.txt` and `skills/index.json` deploy |
| 2. Filing and safety | `get_folder`; `readers`, `shared`, `folder`, `access` fields; `requestedId`/`idTaken`; `baseVersion`; `threadsLeftBehind`; D3; `INSTRUCTIONS`; SPEC §19; guidance deltas | 0.10.0: tool schemas are breaking per `CHANGELOG.md` |
| 3. Change feed | ADR 0015; `events`; two triggers plus `onCommentCreated`; event writes in five endpoints and the fork path; `get_changes` with a required `since`; `cursor` on publish, update, fork and `get_document` results; saved per-credential cursors; indexes; rules; SPEC §4 and §19; guidance deltas | 0.11.0 |
| 4. CLI | `changes --since … [--wait]`, `cursor` in `publish`/`update`/`fork`/`get --json`, `folder <id>`, `open` takes links | `bikeshed-now` 0.11.0, on its own |

PR 3 touches deployment: two new Firestore triggers. Eventarc permissions and
trigger auth are invisible locally (CLAUDE.md), so it is verified against a
real deployment before the release is called done.

### Tests, each with a negative control

Reintroduce the bug, watch the test fail, restore.

- **Filing.** `get_folder` lists effective readers including an inherited
  grant; a team the caller is not in shows no name. Control: return the raw
  grant and watch the team-name assertion fail. `publish_document.access`
  matches a fresh read after filing.
- **Feed, the real sequence.** Agent publishes; owner comments in the browser
  (same email, `via: "web"`); agent replies; a second person resolves the
  thread; an operator withdraws a version. `get_changes` returns exactly
  `comment.added`, `thread.resolved`, `version.withdrawn`, in order, without
  the agent's own reply. Control: key "mine" on email and watch the owner's
  comment vanish.
- **Cursor from birth.** Publish; a person comments before the agent's first
  poll; the first poll, from the publish result's cursor, returns the comment.
  Control: take the starting cursor at the first poll and watch the comment
  vanish.
- **Cursor ordering.** An event recorded after a poll but describing an
  earlier change appears on the next poll. Control: order by the change's
  time.
- **Cursor required and bound.** A call without `since` fails naming it; a
  cursor from another document, a malformed one and an unknown `v` are each
  refused. Control: fall back to "now" on a bad cursor and watch the refusal
  test fail.
- **Every response has a cursor,** including an empty page; 101 events arrive
  as 100 then 1 with nothing repeated or skipped.
- **`"last"`.** Two tokens keep separate saved cursors; with nothing saved it
  answers from the start and says so; a quiet poll writes nothing.
- **Idempotence.** Deliver one CloudEvent twice; one event.
- **Audience.** A reader never sees `access.changed`, `doc.visibility` or
  `fork.created`. Control: drop the filter.
- **Deleted comment.** Gone from the feed after its author deletes it.
- **Coverage.** Every mutating endpoint in `scripts/lib/endpoints.mjs` either
  records an event or is listed as exempt with a reason. A new endpoint fails
  until someone decides.
- **Rules.** No client reads or writes `events` or the cursor records
  (`npm run test:rules:emulated`).
- **D1 to D3** as above; `INSTRUCTIONS` inside budget; CLI `--wait` exits on a
  browser comment, ignores its own reply, times out with its code.

Then `npm run verify` and `npm run test:rules:emulated`, output shown.

## Rejected

| Idea | Why not | Would change if |
|---|---|---|
| Push (webhooks, SSE) | "Not built" in SPEC §19; POST-only server | A target client can only learn of changes by push |
| A workspace-wide feed (every document at once) | Events would need `members` copied onto them, and every access cascade would rewrite them | An agent is seen watching more documents than it can poll one by one |
| Server-side diffs of a new version | No diff library in the budget; the agent holds its previous copy or can fetch both versions | Agents are seen missing what a person changed |
| A trigger on the document record | Fires on every view heartbeat | `stats` moves off the record |
| Auto-dated ids on the server | Changes every caller's addresses; suits half of documents | Never |
| Email to readers when an agent files into a folder | Turns filing into sharing by another name, and sharing is a person's act | A person asks for it, in the app, as a sharing feature |
| `resource_link` blocks in results | Client rendering unverified; a plain `url` works everywhere | A target client renders them |
