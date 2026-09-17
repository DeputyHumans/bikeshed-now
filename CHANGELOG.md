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
