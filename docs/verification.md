# Verification

`npm run verify` proves the code is self-consistent. It does not prove the
product works, because the most valuable properties here are *integration*
properties: a highlight surviving a reload, a script not running until somebody
vouches for it, generated DOM not being baked into the next version.

This is the walkthrough that proves those, against the emulators, with no cloud
account. It found four real defects the unit suites could not, each recorded in
the commit that fixed it.

---

## Running it

```bash
npm run install:all && npm run build:policy
npm run emulators                                  # terminal 1
npm --prefix app run dev                           # terminal 2

export FIRESTORE_EMULATOR_HOST=127.0.0.1:8088
export FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
export FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000
export GCLOUD_PROJECT=demo-bikeshed BIKESHED_BUCKET=demo-bikeshed-content

node scripts/publish.mjs --doc bikeshed-tour            --account you@example.com
node scripts/publish.mjs --doc design-review-shortener  --account you@example.com
node scripts/publish.mjs --doc markdown-reference       --account you@example.com
```

The three samples are not decoration: **A is scripted HTML, B is script-free
HTML, C is Markdown**, and that is exactly what makes the trust observations
below possible. `npm run check:content` keeps them that way.

---

## What to observe, and what it proves

### 1 · Publishing the same bytes twice is a no-op

Re-run any publish. It prints `already published as v1 (contentHash match) —
NO-OP` and mints no version. This is what makes publishing safe in a loop, in
CI, and in front of an agent that cannot remember what it already did.

### 2 · A Markdown document stores both files

`docs/markdown-reference/versions/v1` records `format: "markdown"`,
`entry: "index.html"`, `sourceEntry: "index.md"` and the pinned
`rendererVersion`, and both files exist under the version prefix. Every ACL and
export path sees an ordinary HTML bundle ([ADR 0003](adr/0003-server-side-markdown.md)).

The operator script's actor is recorded as `uid: null, channel: "cli"` — the one
case in the system where an actor has no account, because Admin credentials are
not one (SPEC §17).

### 3 · A stranger cannot tell a forbidden document from an absent one

| caller | a document they can read | one they cannot | one that does not exist |
|---|---|---|---|
| owner / member | 200 | — | 404 |
| signed-in stranger | — | **404** | 404 |
| anonymous | — | **404** | 404 |

403 would say "this exists and is not yours", which is an enumeration oracle on
a slug space that often contains the confidential part.

### 4 · Visibility changes what the proxy will serve, never what the bucket holds

| | anonymous | cache-control | X-Robots-Tag |
|---|---|---|---|
| `private` | 404 | `private, no-store` | — |
| `unlisted`, no token | 404 | | |
| `unlisted`, wrong token | 404 | | |
| `unlisted`, correct token | 200 | `public, max-age=300` | `noindex` |
| `public` | 200 | `public, max-age=300` | — |

Then check `public/{docId}`: it carries `docId, title, slug, currentVersion,
entry, format, visibility, publicEdit, trusted, publishedAt` and **no**
`members`, `viewers`, `ownerEmail` or `stats`. Set the document private again
and the projection is gone — that is the revocation path, with the five minutes
of CDN latency documented in `operations.md`.

### 5 · Both halves of the trust condition

Duplicate each HTML sample, which resets `trusted` to false, and open all three:

| | sandbox | script ran | prompt |
|---|---|---|---|
| scripted, untrusted | `allow-same-origin` | no | **yes** |
| script-free, untrusted | `allow-same-origin` | — | **no** |
| scripted, trusted (CLI) | none | yes | no |

The prompt appears only when the document is sandboxed **and** actually contains
a `<script>`. That AND is why the two HTML samples differ the way they do, and
it is what keeps the prompt meaningful when it appears.

### 6 · A highlight opens every collapsed ancestor it needs — and only those

The most important observation here. Select text inside the **nested**
`<details>` in `#s5-sections`, comment, and reload.

- The anchor records `elementId: "s5-sections"` — the nearest `id`-bearing
  ancestor, not `<body>`. That scope is what makes it survive edits elsewhere.
- On reload the highlight is redrawn, the nested `<details>` is open, **and so
  is its ancestor**.
- The other eight `<details>` are still closed. It opened what it needed and
  nothing else.

### 7 · Committing an edit publishes the document, not the app

Resolve the open threads (a commit is refused while any remain — the button is
disabled and says why), edit a heading, and commit. Compare v1 and v2:

```
v1: bshd-artifacts=0  data-bshd=0  contenteditable=0  <script>=1  <style>=1  dot-nav-children=0
v2: bshd-artifacts=0  data-bshd=0  contenteditable=0  <script>=1  <style>=1  dot-nav-children=0
```

Both have 15 sections, 10 `<details>`, 6 SVG, 29 ids and **no duplicate id**.
`#dot-nav` is still empty in the saved bytes although the script filled it with
fifteen children at read time — the generated DOM was not baked in, which is
what would otherwise accumulate one copy per save. v1 stays readable at
`/d/bikeshed-tour/v1`.

### 8 · Markdown editing is restricted, visibly

Open the editor on each format and compare the toolbar:

| | HTML document | Markdown document |
|---|---|---|
| Underline, Font, Text colour, Align | enabled | **disabled**, with a tooltip |

The tooltip says *"Markdown cannot express this, so it would be lost the next
time you save."* Disabled beats hidden: a control that appears to work and then
loses your formatting is worse than one that is visibly unavailable.

The download menu is format-aware too — the Markdown document offers the
rendered HTML, **the Markdown source**, and a zip; the single-file HTML document
offers the HTML.

### 9 · Editing a Markdown document does not degrade it

Commit an edit, then commit a **no-op** edit. The second prints `deduped: true`
and returns the same `versionId` — it mints nothing at all, which is idempotence
observed end to end rather than only in a unit test. Diff v2's `index.md`
against v3's: the only differences are your edit plus the first-pass
normalization, and comments — including the SPDX header — are still there.

### 10 · The agent loop closes, and stays traceable

Mint a token in account settings, then:

```
tools/list      → list_documents, get_document, publish_document,
                  update_document, get_comments, reply_to_comment
get_comments    → each thread with the exact passage it is anchored to
reply_to_comment → posts, and is stamped via: "mcp"
```

A human's comment reads `via: "web"` beside the agent's `via: "mcp"` in the same
thread. `get_document` returns Markdown **source**, never rendered HTML.

Then check the document's stats: the agent's read landed in `stats.apiReads`
with `ms: 0`, and `stats.views` and `totalMs` are untouched. Reading *time* is a
human concept; a machine fetch has none.

---

## What this walkthrough found

Four defects, none of which the 344 unit and rules tests could have caught,
because each needed a real runtime:

| | Found because |
|---|---|
| `admin.firestore.FieldValue` is `undefined` inside the Functions emulator, so every write that stamps a timestamp threw | the unit tests call these modules in a plain Node process, where the emulator's proxy does not exist |
| the peer-presence overlay survived into edit mode | the invariant harness mirrored a hook declaration order it did not contain |
| `list_documents` reported `format: "html"` for every document | `format` lives on the version; nothing read it from a real one |
| editing a Markdown document deleted every HTML comment in it | turndown never visits comment nodes, and no fixture had a comment |

The peer-overlay one is worth dwelling on: it was caught by the project's own
dev-only assertion, which crashed the viewer with an exact diagnosis rather than
letting the overlay reach the serializer. That assertion earned its place.
