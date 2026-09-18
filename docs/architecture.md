# Architecture

`docs/SPEC.md` says what the system does and is normative. This file says why it
is shaped this way, and — more usefully — what it deliberately is not.

The individual decisions, with their costs and their reversal conditions, are in
[`adr/`](adr/) — nine records of about thirty lines each.

## The one-paragraph version

A document is an immutable bundle of bytes in a private bucket. The only path
those bytes take to a browser is one Cloud Function that authenticates the
caller, checks an ACL, and streams. The browser renders them in a **same-origin**
iframe, which is what makes highlight-anchored commenting possible at all: the
parent app can drive annotation directly on `contentDocument` without injecting
anything into the document. Everything else — versions, folders, teams,
presence, provenance — exists to make that one arrangement safe and useful.

## Five load-bearing decisions

### 1. Same-origin iframe, nothing injected

The alternative is a sandboxed cross-origin frame with an injected
`annotator.js` and a `postMessage` protocol. That buys isolation and costs a
message protocol for every DOM operation, plus a script inside the user's
document that must never be serialized back.

We keep same-origin and pay for it with an explicit **trust model** (SPEC §6c):
a document that did not come from a trusted publisher renders with
`sandbox="allow-same-origin"` and no `allow-scripts`, so its JS cannot read the
app origin's auth token. Annotation and editing keep working because they are
parent-driven — `contentEditable` and `execCommand`, not iframe scripts.

See `adr/0001-same-origin-iframe.md`.

### 2. `execCommand`, not a schema editor

ProseMirror, Slate and Lexical all normalize a document into their own schema.
For hand-authored HTML — a deck with inline SVG, a `<details>` tree, a scroll
observer — normalizing is destruction. The editor here edits the **actual
authored DOM**, which is why `serializeCleanHtml` can guarantee a round trip.

`execCommand` is deprecated and awkward. It is also the only API that edits a
document in place without first deciding what a document is allowed to contain.

See `adr/0007-execcommand-over-schema-editor.md`.

### 3. Denormalized `members`, one query, one provable rule

`members` is a flat array of lowercased emails: the owner, direct grants,
grants inherited from the parent folder chain, and team grants expanded to the
people in them. It is simultaneously the read gate and the workspace query key.

This is the single most constraining fact in the system. Firestore `list` rules
must be **statically provable from the query constraints** — they are not
filters — so the rule can only be `request.auth.token.email in resource.data.members`.
That forbids a transformed expression like `email.lower()`, which is why emails
are stored lowercased as an invariant, and it is why teams expand server-side
into emails rather than appearing in `members` as ids.

The cost is write fan-out: sharing a folder, or removing someone from a team,
recomputes every affected document. A single batched BFS handles it, parent
before child. **A 50-person team granted on 200 documents is 200 writes.** For a
small-team tool that is the right trade. At 10,000 documents it would not be,
and the fix would be a job queue — stated here so nobody discovers it in
production.

See `adr/0006-denormalized-members.md` and `adr/0004-email-keyed-acl.md`.

### 4. Content-hash idempotency, with two implementations held together by a fixture

Re-publishing identical bytes is a no-op. That makes `publish` safe to run in a
loop, safe in CI, and safe for an agent that cannot remember what it already did.

The hash has two implementations — ESM for the scripts, CommonJS for the
functions — because those runtimes cannot share a module. They are pinned to a
**shared golden-vector fixture**, not to each other: a port-vs-port comparison
drifts together, a fixture does not. The byte layout is frozen in SPEC §9.1.

### 5. Generated security rules

`.rules` files cannot import and the Firebase toolchain has no preprocessor, so
the identity gate would otherwise be hand-copied into four places that drift
silently. It is written once in `config/access-policy.json` and rendered by pure
functions into four **committed** artifacts, byte-compared in CI.

Committed rather than gitignored because a security boundary that is not in git
is not reviewable and has no diff history.

See `adr/0005-generated-rules.md`.

## Shape

```
config/          the identity gate, and the templates it renders
tools/           the renderer
firestore.rules  database.rules.json     GENERATED, committed
functions/       Cloud Functions v2 (CommonJS) — every server-side decision
scripts/         operator CLIs (ESM) — provision, publish, withdraw, tear down
cli/             the end-user `bikeshed` CLI — PAT auth, HTTPS only
app/             React 18 + Vite 5 + TypeScript strict
content/         sample document bundles
rules-tests/     the rules suite, against the emulator
```

**The ESM/CommonJS split is deliberate.** Functions are CommonJS because that is
what the Cloud Functions Node runtime wants; scripts are ESM because
`node:util parseArgs` and top-level await make small CLIs pleasant. Three pairs
of modules are duplicated across the boundary on purpose — `hash`, `membership`,
`policy` — and each pair is held in agreement by a parity test that
dynamic-imports the ESM side from the CommonJS one.

## What this is not

Each line below is a decision, not a gap. If you want to change one, the bar is
a written argument in a pull request, not a dependency.

- **No operational transform.** Document state IS merged: several people may
  type into one document at once, by a Yjs CRDT bound to the DOM without a
  schema ([ADR 0010](adr/0010-crdt-for-shared-document-state.md)). OT is the
  alternative that was not taken — it needs a central server to order
  operations, which this architecture does not have and does not want. The
  single-holder edit lock this replaces is withdrawn; ADR 0010 records both why
  it was chosen and why it was reversed.
- **No plugin system.** Nothing has asked for an extension point twice.
- **No theming engine.** One palette, swapped by editing twelve tokens.
- **No i18n.** No second locale is in sight, and retrofitting is mechanical.
- **No multi-tenancy.** One deployment is one workspace; folders already group.
- **No SSO or SCIM.** This is a self-hosted tool for small teams. If you need
  directory sync, you need a different product, and the README says so.
- **No search index.** The workspace filter is client-side over a set that fits
  in memory.
- **No mobile app.** The web app is responsive to 400px and touch-parity-tested.
- **No admin console.** The CLIs are the admin surface, and they are auditable.
- **No rate limiter.** CDN caching is the cost defence for public documents;
  App Check is the named hook if abuse appears.
- **No document deletion.** Versions can be withdrawn through a guarded CLI with
  seven refusals. A document itself is not deletable through any path, which is
  a product decision about a review tool, stated explicitly rather than left as
  a missing button.
- **No OAuth 2.1 for the agent surface.** Personal access tokens, ~120 lines,
  revocable by someone who has never heard of OAuth.
- **No service accounts.** A token is exactly its owner, with exactly their ACL.
- **No unique-visitor estimation.** Anonymous sessions are counted; people are
  not.

## Dependency budget

| Surface | Budget | Why |
|---|---|---|
| `app/` runtime | **8** | Markdown renders server-side; email renders server-side. The eighth is `yjs`, argued for in [ADR 0010](adr/0010-crdt-for-shared-document-state.md) — no CRDT can be hand-written at a defensible size |
| `functions/` eager | **9**, budget 10 | `adm-zip`, `cookie`, `firebase-admin`, `firebase-functions`, `markdown-it`, `mime-types`, `resend`, `turndown`, `turndown-plugin-gfm` |
| `functions/` lazy | 4 | `react`, `react-dom`, `@react-email/components`, `@react-email/render` — imported only inside the email path ([0008](adr/0008-runtime-email-rendering.md)) |
| `cli/` | its own package | nothing it pulls in reaches the app or the functions |
| root | dev only | |

The app ships with **no UI kit, no CSS framework, no icon library, no state
manager, no PDF library and no zip library.** That discipline is the most
valuable structural property this codebase has, and the budget exists to keep it
from being traded away one convenient package at a time.

The functions side came in **one under** its budget rather than at it. The MCP
endpoint was planned around `@modelcontextprotocol/sdk`, which requires `zod` as
a peer; the server half of streamable HTTP turned out to be ~200 lines of
JSON-RPC, so it is hand-written and the two packages were never added. That is a
deliberate deviation from the plan and is recorded in
[ADR 0009](adr/0009-hand-written-mcp.md).

Three markdown-related packages are load-bearing and **pinned to exact
versions**, not ranges: the rendered bytes are part of the content hash, so a
patch release would mint new versions of every Markdown document
([0003](adr/0003-server-side-markdown.md)).

## Cost model

Every byte of every document is proxied through a Cloud Function. That is the
price of the private bucket and the ACL, and it is the thing most likely to
surprise you on a bill.

Two consequences:

- **Prefer single-file bundles.** A 50-asset deck is 50 function invocations per
  reader; the same deck inlined is one. `docs/authoring-bundles.md` says so at
  the top.
- **Public documents are cacheable** (`public, max-age=300` on the immutable
  version path) precisely because they are where traffic spikes. The trade is
  five minutes of revocation latency, documented in `docs/operations.md` rather
  than discovered.

`docs/operations.md` makes setting a GCP budget alert a numbered setup step.
