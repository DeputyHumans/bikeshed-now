# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org/),
and — because a document format and a wire format are both public API here —
treats the following as breaking:

- the content-hash framing (SPEC §9), because it decides whether a republish
  deduplicates,
- the MCP protocol version and tool schemas (SPEC §19),
- `docs/SPEC.md` section numbers, which are cited from a hundred source files:
  append, never renumber.

A Markdown renderer bump is **not** breaking, but it is a migration: the
rendered bytes are part of the content hash, so every Markdown document's next
save mints a new version. `docs/operations.md` says how to plan one.

## Unreleased

### Added

- **Agents can organise a workspace.** Three MCP tools — `list_folders`,
  `create_folder`, `move_document` — and the CLI commands `folders`, `mkdir` and
  `mv`. Filing a document was previously something only a person could do, which
  meant an agent either dropped everything at the root or waited for somebody
  who was not there.
- **Three packaged skills**, in the Agent Skills convention, served by every
  deployment at `/skills/` and installable with `bikeshed skills install <dir>`:
  `bikeshed-publishing`, `bikeshed-feedback`, `bikeshed-folders`. `llms.txt` is
  the short form every agent reads; a skill is the long form, loaded for the task
  that needs it. Generated into `app/public/skills/` by the same build step that
  produces `AGENTS.md` and `llms.txt`, and byte-compared by `check:agents`.
- `functions/test/skills.test.js` holds those documents to the surface they
  describe: every `bikeshed …` command and every tool name they mention must
  exist, and — the direction that matters more — every tool and command that
  exists must be named in `docs/agent-guide.md`. A skill naming an absent
  command is worse than no skill, because an agent believes it.

- **Documents can carry an optional expiry.** The owner sets a date in "Who can
  see this"; after it, the document is read-only and readable only by them.
  It is **not a deletion date** — this product does not delete documents, so the
  bytes, versions, annotations and comments all survive and clearing the date
  restores everything. The interface says that in those words, because "expire"
  reads as "delete" to most people.

  It is deliberately **not in the security rules**: the workspace `list` rule
  must stay statically provable from its query (SPEC §5), and a query cannot
  filter on a field most documents lack without dropping every document that
  lacks it. So the record stays readable and the content stops being served,
  which is sufficient because every byte already flows through one function.
  The consequence is stated rather than discovered: a member still sees the row
  and its title.

  Two details that are decisions. The public cache window is capped at the time
  remaining, so an expiry — unlike a revocation — is never served stale. And
  nothing deletes the `public/{docId}` projection at the moment itself, because
  there is no scheduler here; it carries the date instead, so an anonymous
  reader is told rather than shown an empty frame.

### Changed

- **`move_document` is an access operation, not a filing one.** A document's
  members are its own grants unioned with its folder's, so moving it between
  folders changes who can read it. It requires `canEdit` on the document and
  `canEditFolder` on the destination, and goes through `persistDocMembership` so
  the presence mirror and the public projection move with it. Both the guide and
  the folders skill say so in those words.
- One resolver now authorizes every "put this inside that folder" in the system.
  `createDoc`, `createFolder`, both halves of `organize` and the MCP publish tool
  each had their own copy of the same four steps, with three different refusal
  messages for the same refusal — and one of them checked `editorMembers` by
  hand rather than calling `canEditFolder`, which agreed only by accident.
- The MCP surface is **nine tools**, not six. Tool schemas are public API
  (see above), so this is additive: nothing existing changed shape.

- **Several people can now edit one document at the same time.** Document state
  is a Yjs CRDT bound to the DOM without a schema, so edits merge and every copy
  converges ([ADR 0010](docs/adr/0010-crdt-for-shared-document-state.md)).
  Hand-authored HTML still round-trips byte-identical; that property is the
  contract, and the sample bundles are the fixtures that hold it.
- **The single-holder edit lock is withdrawn**, along with observe mode, "Ask to
  edit", the hand-off and the idle release. SPEC §6b and §16 are rewritten: both
  said there was no CRDT, and both were normative.
- `draft.editSessions` is **withdrawn**. It recorded lock hand-offs, and there
  are none; a version no longer answers "who wrote which part of it".
- The `app/` runtime dependency budget rises from **7 to 8** (`yjs`, MIT).
- RTDB gains `editAccess`, a second mirror of `editorMembers`. Shared document
  state is gated on "may edit" rather than on "may read" — gating it on the
  presence mirror would let a read-only member push content into an editor's
  browser.

## 0.1.0 — 2026-09-17

First release. Everything below is new, so this entry says what the thing *is*
rather than what changed.

### The product

Publish a self-contained HTML bundle or a Markdown file, share it with named
people, teams or the public, and collect threaded comments **anchored to the
exact passage they are about**. Documents are immutable versions. Agents publish
and read feedback through the same interface people do, and are visibly marked
as agents.

- **Anchored feedback.** W3C-style text-quote anchoring with a position
  fallback, scoped to the nearest `id`-bearing ancestor so a comment survives an
  edit somewhere else in the document. Rehydration opens every collapsed
  `<details>` ancestor a highlight is hiding behind.
- **It edits the document you wrote.** `execCommand` on the authored DOM, not a
  normalized schema, so a deck with inline SVG and a scroll observer survives a
  round trip ([ADR 0007](docs/adr/0007-execcommand-over-schema-editor.md)).
- **Markdown as a first-class source format**, compiled to an HTML bundle
  server-side once per version, with a restricted editor palette whose
  unsupported controls are disabled with a reason rather than hidden
  ([ADR 0003](docs/adr/0003-server-side-markdown.md)).
- **Idempotent publishing.** Identical bytes mint no version, by content hash.
- **Three visibility levels** — private, unlisted by token, public — served
  through a projection that carries no member list, never by opening the bucket.
- **Collaborative presence**: peer cursors, selections and reading positions,
  with a single-holder edit lock and observe mode instead of a merge engine.
  (Superseded in Unreleased: edits now merge.)
- **Teams**, expanded server-side into the flat membership arrays so the one
  provable workspace query is unchanged
  ([ADR 0006](docs/adr/0006-denormalized-members.md)).
- **An agent surface**: personal access tokens, six MCP tools, a `bikeshed` CLI,
  and `docs/agent-guide.md` mirrored to `/llms.txt` with CI asserting they match.
- **Provenance on everything.** Identity and channel are derived from the
  credential, never claimed; `client` and `agent` are self-reported and labelled
  as such. Automated reads count into `stats.apiReads`, never into human
  reading time.
- **Export marking** locked against twenty-five CSS hiding vectors, with the
  text per document rather than hardcoded.

### Security posture

- Any verified account may sign in; an optional domain allowlist is generated
  into all four enforcement layers from one file
  ([ADR 0005](docs/adr/0005-generated-rules.md)).
- The bucket is private with public-access prevention. One function is the only
  path bytes take to a browser.
- Read-only byte paths answer **404** for forbidden and absent alike, so a
  signed-in stranger cannot enumerate the slug space.
- Untrusted documents render script-sandboxed, with two trust scopes — global
  (owner) and personal (self) — that never collapse into one
  ([ADR 0002](docs/adr/0002-two-scope-trust.md)).
- Presence reads are gated by a server-maintained mirror, so a live selection
  stream is never readable by a non-member.
- Anonymous is read-only everywhere. `publicEdit` widens *who may edit* to any
  verified account, never to anyone.

### Verification

344 tests: 135 functions, 151 app and 11 CLI, plus 47 rules cases against the
emulators. Coverage on the annotation, export, workspace, brand and stats
modules is 93% of lines. Five guards run in CI — brand purity including git
history and binary assets, SPDX headers, what each sample demonstrates,
dependency licences, and byte-comparison of every generated artifact.

`docs/verification.md` is the emulator walkthrough for the integration
properties no unit test reaches. Writing it found four real defects, each fixed
in its own commit.

### Known limits, stated rather than discovered

- A membership change fans out one write per affected document. Bounded and
  batched; fine for a small team, and named in `docs/architecture.md` so nobody
  is surprised at ten thousand documents.
- Making a public document private again takes up to five minutes to propagate
  through the CDN. That is the price of caching public content at all.
- `~~strikethrough~~` round-trips as `~strikethrough~`. GFM accepts both and it
  is stable thereafter; it is the one lossy Markdown normalization.
- Presence needs a Realtime Database and email needs a Resend key. Without
  either, both degrade to clean no-ops — which is the path CI exercises.
- The MCP server is hand-written rather than built on the SDK, which requires
  `zod` as a peer ([ADR 0009](docs/adr/0009-hand-written-mcp.md)). Protocol
  changes are ours to follow, and a test speaks the wire format to catch them.
