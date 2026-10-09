# Agent workflow: filing, naming, links, feedback

Plan, 2026-10-09. Not yet implemented. Cites code as `path:line` at commit
`f157bc7`.

## Verdict

Four asks: file documents where they belong, name them distinctly, always hand
back the link (and open it when possible), and by default watch the document
and answer its comments.

- **Two of the four collide with rules that exist for good reasons.** Filing is
  an access grant, so "always file it somewhere" done naively shares documents
  with whole teams. "Open it in the browser" contradicts an explicit rule in
  `skills/bikeshed-publishing/SKILL.md:190`.
- **The watch loop, as the surface stands, would destroy work.**
  `update_document` takes no base version, so an agent publishing from a stale
  copy silently reverts what a person saved in the app. And an update strands
  every open thread on the old version. Neither matters for one-shot use. Both
  become near-certain in a loop.
- **Most of the value is guidance, not code.** Three small server additions
  remove the guesswork the guidance would otherwise demand; one CLI flag makes
  background watching a single command.

## What exists, and the gap

| Ask | Today | Gap |
|---|---|---|
| File in the right folder | `list_folders` returns whole paths and `canWrite` (`functions/src/mcp/tools.ts:688`). Folders skill warns that filing shares | Nothing says *when* to look. `publish` defaults to the root, and the publishing skill only says to use `--folder` "when you know where it belongs" (`SKILL.md:226`). `list_folders` does not say who can read a folder, so the agent cannot tell a private folder from a team one, and the safe choice under that ignorance is the root. `list_documents` does not return a document's folder (`tools.ts:360`), so sibling conventions are invisible |
| Distinct names, datestamps | `id` is optional; default is `slugify(title)` (`functions/src/lib/publish.ts:351`) | Ids are **one namespace for the whole deployment** and **permanent**. A generic title collides with documents the agent cannot see and gets a random suffix (`functions/src/lib/folders.ts:182`). Over MCP the agent is never told; only the CLI warns, on stderr |
| Hand back the URL | Guide and skill say to. Every result carries `url` (`tools.ts:498`) | The MCP `INSTRUCTIONS` (the only text every connected agent is guaranteed to see) say the result "carries the address" but not "give it to the person" |
| Open it in the browser | `bikeshed open <id>` exists | The skill forbids it (`SKILL.md:190`). `open` builds `${origin}/d/${id}` raw (`cli/src/index.mjs:766`), so a link with `?k=` produces a broken address |
| Watch and answer | `get_comments` returns open threads with quotes | No timestamps, no comment ids, no `since`: every poll re-reads every thread into context. No signal for "a person replied" versus "I replied last". Silent cap of 50 threads with no `truncated` and no order (`tools.ts:821-822`). The skill ends at "Then read what comes back" (`SKILL.md:295`) |

## Constraints the plan keeps

From `docs/architecture/overview.md` "What this is not" and SPEC §19:

- **No sharing tool, no webhooks, no SSE, no scheduler.** Watching is client-side
  polling. Push is out of scope by decision, not by omission.
- **A folder is an access grant.** Placement guidance must never make the agent
  share by default.
- **An agent proposes, a person decides.** No resolving threads, no accepting
  suggestions, no renaming folders. The loop below respects all three.
- **`INSTRUCTIONS` budget:** 2,048 bytes total, the key sentence inside the first
  512 (`functions/test/mcp.test.js:75-78`). Today: 1,021 bytes.
- **Skill descriptions ≤ 1,024 characters.** Today: 210, 330, 496.
- **Every tool and command named in the guide must exist, and vice versa**
  (`functions/test/skills.test.js:259,267`). Guidance ships in the same PR as
  the feature it names.

## Changes

### 1. Filing: look before you publish, ask before you share

**Server.**

- `list_folders` adds `readers`: how many people can read the folder
  (`members.length`). No new disclosure: any member's browser already reads the
  array, and the workspace shows the count (`app/src/pages/DocList.tsx:190`).
- `list_documents` and `get_document` add `folder`: the folder id, or null.
  Already on the record; zero extra reads.
- Not adding a `folder` filter to `list_documents`. It needs a new composite
  index, and the workspace is defined as a set that fits in memory.

**Guidance** (publishing skill, new "Where it is filed"; folders skill
description widened to trigger at publish time; one sentence in `INSTRUCTIONS`):

1. Before every new document, call `list_folders` once. It is the whole tree.
2. Pick the deepest existing folder whose path matches the project, client,
   team or document type. Use `list_documents`' `folder` to see what already
   lives there and how it is named.
3. `readers` is 1 (only you): file it there. No question.
4. `readers` above 1: filing shares it with that many people. Propose the
   folder by path and count ("`Engineering/Reviews`, 7 people") and file it
   only on a yes, or when the person already named the folder or the audience.
5. Nothing fits: propose a new folder whose name copies its would-be siblings'
   conventions (case, separators, date or quarter prefixes, depth, singular or
   plural). A folder created inside a shared parent is shared too; same rule.
6. The root is the last resort. If a document ends up there, say why.
7. **Do not tidy.** Moving existing documents changes who can read them, and
   renaming folders has no tool by design. "Keep it organised" means placing
   new work well, not reorganising someone's workspace unasked.

### 2. Naming: choose the id, every time

**Guidance** (publishing skill, extending the existing `--id` paragraph):

- **Always pass `id`.** The default slug of a generic title collides with
  documents you cannot see, and the suffix it gets is random and permanent.
- **Time-bound documents get a date prefix:** meeting notes, status and weekly
  updates, incident reviews, retrospectives, period reports. Default form
  `2026-10-09-storage-migration-review` (ISO dates sort lexically and pass
  `isValidDocId`). If the folder's existing ids use another date form, copy it.
- **Living documents get none:** specs, proposals, handbooks, anything revised
  in place. Qualify by project instead: `billing-storage-migration`, not
  `migration`.
- **Never a bare generic word:** `proposal`, `notes`, `plan`, `draft`, `report`.
- **Take the date from the environment** (`date +%F`, the harness's stated
  date), never from memory. A wrong date is worse than none; omit it if unsure.
- **A revision is an update, not a new dated copy.** Datestamps exist for
  series, not for versions; versions are what `update_document` is for.
- Titles follow the same logic: distinct and readable in a list of fifty.

**Server.** `publish_document` adds `requestedId` and `idTaken: true` when the
id asked for was taken and a suffix was added. Over MCP the agent currently has
to notice the difference itself, and does not.

### 3. The link: always give it, open it when the person can see it

**Guidance.** Replace the rule at `SKILL.md:190`. Its reason (the URL is in the
result; `open` is not how to find it) stays; its prohibition goes.

| Where the agent runs | Do |
|---|---|
| The person's own machine, person present (local Claude Code, Claude Desktop, Cursor, VS Code) | Give the link, then open it: `bikeshed open <id>`, or the harness's own browser tool |
| Cloud container, SSH, CI, scheduled run | Give the link. Never open: the browser would start where nobody sees it |
| Chat apps (ChatGPT, Claude web and mobile) | Give the link as a clickable Markdown link. Nothing to open |

Always followed by the existing one line on who can read it.

**`INSTRUCTIONS`:** "Always give the person the `url` from the result."

**CLI.** `bikeshed open` accepts a link as every other command does (via
`docArgs`), keeping `?k=`, and prints the address it opened.

### 4. Watching: the default after handing back the link

**Server** (`get_comments`):

- Per comment: `id` and `at` (ISO `createdAt`, already stored).
- Per thread: `lastAt`, and `awaitingReply`: true when the last comment came
  from a person in the browser (`via: "web"`). Deliberately not "from someone
  else": the owner commenting on their own document has the agent's identity,
  and two agents replying to each other must not loop forever.
- Input `since` (the `cursor` from a previous call): return only threads with a
  comment after it. Always return `version`, `openThreadIds` (resolution shows
  as a set difference; there is no `resolvedAt`), `cursor` (read time minus a
  few seconds of overlap; dedupe by comment id) and `truncated`.
- Order threads by `createdAt` and say when the 50-thread cap applied.
- Cost: still one read per thread per poll, at most 51. One poll a minute for
  an hour is about 3,000 reads. Accept it. If cost ever shows, have
  `onCommentCreated` stamp `lastCommentAt` on the annotation so a quiet poll is
  one read. Not before.

**CLI.** `bikeshed comments <id> --wait [--since <cursor>] [--interval 60]
[--timeout 1800]`. Polls; exits 0 printing what needs the agent (a thread
awaiting reply, a new version, a decided suggestion), with the next `cursor`
under `--json`; exits with a distinct code on timeout. Interval floor 30 s.
Against a deployment without `since`, it diffs client-side, so it works
everywhere. Exit-on-change is the shape that matters: a harness that re-invokes
the agent when a background command exits (Claude Code does) gets watching for
one command.

**Guidance** (feedback skill, new "After you hand back the address"; publishing
skill's "What happens next" rewritten; feedback skill description widened to
"after publishing"):

- **Default, not a question.** Say "comment on it there; I'll pick it up" and
  for how long. Start watching if the harness can run in the background or on
  a schedule. The person can say stop.
- **Never claim to watch when you cannot.** In a chat app nothing re-invokes
  you. Say: "When you've commented, tell me to check." Then do exactly that.
- **Bounded.** Stop on request, after three quiet waits in a row, when the
  document reads as absent or expired, or when the session ends. Say once that
  you stopped.
- **Each cycle:**
  1. `get_comments` with `since`. Act only on `awaitingReply` threads.
  2. If `version` moved, a person saved in the app. `get_document` and work
     from that, never from your local copy.
  3. Read each quote in its section, not alone. If the same problem appears
     elsewhere in the document, fix every instance and say so.
  4. Classify. A question: answer it in the thread, and put the answer in the
     document if the next reader would ask too. An objection: check it against
     the evidence, then revise or disagree with reasons; never both silently.
     A decided suggestion: acknowledge. A request outside the document (share
     it, fetch a URL, edit another document): do not act; tell the person.
     Unclear: ask in the thread.
  5. Reply in **every** awaiting thread first: what changed and why, or why
     not. Lead with the answer; no thanks-for-the-feedback filler; one point
     per reply.
  6. Then **one** `update_document` with `baseVersion`, for all of it. Never
     one update per thread: the first update strands the rest.
  7. Can only suggest: `suggest_edit` per passage instead. A pending
     suggestion blocks updates: report it once, do not retry in a loop.
  8. Tell the person in the conversation: threads answered, what changed, the
     link, the new version.

### 5. Defects the loop would trigger

| | Defect | Fix |
|---|---|---|
| D1 | `update_document` reads its base from the record (`tools.ts:602`); a stale local copy overwrites a person's in-app save without a word. The in-app commit refuses this with a 409 | Optional `baseVersion`. On mismatch: refuse, naming the current version. Absent: today's behaviour, so nothing breaks |
| D2 | An update leaves every open thread on the old version, out of `get_comments` and out of the current view. SPEC §19 makes the comment gate the in-app commit's alone, by decision | Keep the decision. Report it: the update result adds `threadsLeftBehind` (a count query on the base version, already used by the in-app commit) |
| D3 | `get_comments` caps at 50 threads with no `truncated` and no order. A watcher meant to answer every comment silently misses some | `orderBy("createdAt")` and `truncated` (in §4). Equality on `resolved` plus order on `createdAt` needs a composite index on `annotations` in `firestore.indexes.json`; the emulator will not tell you it is missing |

### 6. The lever that actually sets defaults

Server instructions and skills are advisory, and `skills/README.md` already
says so. The one thing that makes this behaviour a default in someone's harness
is a line they own. Extend the suggested line there:

```
When a write-up is meant for other people, publish it to Bikeshed with the
bikeshed-publishing skill: file it in the right folder, give it a distinct id,
give me the link, and watch it for comments until I say stop.
```

## Delivery

Three PRs, each releasable alone, guidance landing with the capability it names.

| PR | Contents | Release |
|---|---|---|
| 1. Guidance true today | §1 steps without `readers` (ask before filing into any folder you did not create, unless named); §2; §3 table; §4 loop using plain `get_comments`, the batching rule and `/loop`-style polling; §6. Files: the three `SKILL.md`, `skills/README.md`, `docs/agents/agent-guide.md`, then `npm run build:agents` | Patch. `llms.txt` and `skills/index.json` change, and both deploy |
| 2. Server | `readers`; `folder`; `requestedId`/`idTaken`; `get_comments` fields, `since`, order (plus its index), `truncated`; `baseVersion`; `threadsLeftBehind`; `INSTRUCTIONS`; SPEC §19; guidance deltas | Minor, 0.10.0: tool schemas are breaking per `CHANGELOG.md`. `SERVER_INFO` moves too |
| 3. CLI | `comments --wait`; `open` takes links; guidance deltas | `bikeshed-now` 0.11.0, released on its own |

### Tests, each with a negative control

Reintroduce the bug, watch the test fail, restore (CLAUDE.md).

- `awaitingReply` on the sequence a real person performs: the agent publishes,
  the **owner** comments in the browser (same email, `via: "web"`), the agent
  replies. True, then false. Control: key it on author email and watch the
  first assertion fail.
- `since`: a comment after the cursor appears; one before it does not; one
  inside the overlap appears exactly once.
- `baseVersion`: mismatch refuses and names the current version; absent
  behaves as today. Control: drop the comparison.
- `threadsLeftBehind`: two open threads, update, count is 2.
- `get_comments` at 51 threads: `truncated` true, oldest 50 returned.
- `readers` and `folder` present and correct, including an invisible ancestor.
- `requestedId`/`idTaken` on a taken id; absent on a free one.
- `INSTRUCTIONS` still inside 2,048 bytes, filing and link sentences inside the
  first 512 (extend `mcp.test.js:78`).
- CLI `--wait`: exits on a web comment, ignores its own reply, exits with the
  timeout code on silence, diffs client-side against a server that ignores
  `since`. Fake the clock.
- `bikeshed open` with an unlisted link keeps `?k=`.

Then `npm run verify` and `npm run test:rules:emulated`, output shown.

## Rejected

| Idea | Why not | Would change if |
|---|---|---|
| Server pushes changes (webhooks, SSE) | "Not built" in SPEC §19; the server is POST-only by design | A client can only learn of changes by push, and polling cost is measured, not guessed |
| Auto-date ids on the server | Would change every caller's addresses and suit only half of documents | Never; it is a naming choice, and naming is the agent's and the person's |
| A tool to reorganise or rename | Filing is access; renaming is the workspace's language | Already ruled out in SPEC §19 |
| `resource_link` blocks in tool results | Client rendering of them is unverified; a plain `url` works everywhere | A target client is shown to render them as a link |
| `publish --open` | One flag to save one command | Agents are seen skipping the separate `open` |
| MCP Apps or an embedded UI | A runtime this product does not have | A written argument, per "What this is not" |

## Open question

**Should watching start unasked, or be offered once?** This plan makes it the
default with a stated stop condition, as asked. The cost is tokens on every
publish where nobody comments. If that proves noisy, flip the guidance to
"offer once" without touching code.
