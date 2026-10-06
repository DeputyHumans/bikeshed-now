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
node scripts/publish.mjs --doc deck-animated            --account you@example.com
```

The three samples are not decoration: **A is scripted HTML, B is script-free
HTML, C is Markdown**, and that is exactly what makes the trust observations
below possible. `npm run check:content` keeps them that way. The fourth,
`deck-animated`, is a stacked deck whose slides reveal only once shown — trust
it, and its slide thumbnails are what show whether a preview reaches a slide's
final state.

Three prerequisites for the document page, which the Hosting emulator serves
through `docShell` exactly as production does:

- **`functions/.env.local` containing `BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050`.**
  That file is loaded last and only by the emulator. Without it, one of two
  things happens. On a deployer's machine, where `functions/.env` carries the
  production origin, the emulator **silently fetches the production shell**:
  every document page boots the live site's assets and nothing warns. With no
  origin configured anywhere, the fallback is `demo-bikeshed`'s default site,
  which does not exist: opening the first document page prints a warning from
  the running function (`docShell: BIKESHED_PUBLIC_ORIGIN is unset — /d/**
  will answer 503 …` — not at emulator start-up, where firebase-tools' brief
  discovery pass would print the same line spuriously) and every `/d/**`
  answers 503. Either way the console prints `shell origin:
  http://127.0.0.1:5050` on the first document page once the override is in
  place; if it prints anything else, it is missing.
- **`functions/.env.local` also containing `BIKESHED_BUCKET=demo-bikeshed-content`.**
  `functions/.env` may name the real content bucket on a deployer's machine;
  without the `.local` override `contentProxy` reads a bucket `publish.mjs`
  never wrote to, and every document asset 404s.
- **`env $(grep -v '^#' app/.env.example | xargs) npm run build:app`.** The
  Hosting emulator serves `app/dist`, not the Vite dev server, and
  `app/.env.local` may hold a real web config: building with plain
  `VITE_USE_EMULATORS=1 npm run build:app` on a deployer's machine inlines
  that real project id, so the built app queries the emulator under the wrong
  project and every document page sits at "Opening the document…" forever.
  Building from `app/.env.example` instead uses the demo values it pins
  (`demo-bikeshed`, `demo-api-key`, `demo-bikeshed-content`,
  `http://127.0.0.1:9000?ns=demo-bikeshed`) regardless of what
  `app/.env.local` holds.
- **`config/deploy.json` stamps the emulator's `/llms.txt` too.** The same
  build writes this deployment's real address into `app/dist/llms.txt` and
  `app/dist/skills/**`, so on a deployer's machine the instructions you read at
  `http://127.0.0.1:5050/llms.txt` point an agent at **production**. Add
  `BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050` to the build above — the same
  origin `functions/.env.local` already gives `docShell` — and the local
  instructions describe the local deployment:

  ```bash
  env $(grep -v '^#' app/.env.example | xargs) \
    BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050 npm run build:app
  ```

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
export path sees an ordinary HTML bundle ([ADR 0003](../architecture/adr/0003-server-side-markdown.md)).

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

Then check `public/{docId}` for the PUBLIC row: it carries `docId, title, slug,
currentVersion, entry, format, visibility, publicEdit, trusted, expiresAt,
publishedAt` and **no** `members`, `viewers`, `ownerEmail` or `stats`. There is
no row at all for the private and unlisted documents, and an anonymous `GET` of
`public/<unlisted>` and of `public/<absent>` both come back `PERMISSION_DENIED`,
as does listing `public`. Make the public document private again and its row is
gone — that is the revocation path, with the five minutes of CDN latency
documented in `operations.md`.

An unlisted document's readers get those fields from `POST /unlock` instead
(`curl -si -X POST http://127.0.0.1:5050/unlock -H 'content-type: application/json' -d '{"docId":"<slug>","k":"<token>"}'`):

| | anonymous | signed-in stranger | cache-control |
|---|---|---|---|
| unlisted, no token | 404 | 404 | `private, no-store` |
| unlisted, wrong token | 404 | 404 | `private, no-store` |
| unlisted, correct token | 200 | 200, and a grant at `docs/<slug>/linkGrants/<uid>` | `private, no-store` |
| private, or absent | 404 | 404 | `private, no-store` |

After that 200, the stranger reads the unlisted document's threads and can
comment without the token in the URL, and `/content/**` answers them
`private, no-store`, never `public` — their URL carries no key. Make the
document private and unlisted again, and the old token and the grant both stop
working. `POST /view` without the token is the same 404 as an absent id.

The document page follows the same five rows. `curl -sI http://127.0.0.1:5050/d/<slug>`
(with `?k=…` for the unlisted rows), and `curl -s` for the body:

| | status | cache-control | X-Robots-Tag | `<title>` is the document's |
|---|---|---|---|---|
| `private` | 200 | `private, no-store` | — | no |
| `unlisted`, no token | 200 | `private, no-store` | — | no |
| `unlisted`, wrong token | 200 | `private, no-store` | — | no |
| `unlisted`, correct token | 200 | `public, max-age=300` | `noindex` | **yes** |
| `public` | 200 | `public, max-age=300` | — | **yes** |

A slug that does not exist and a private one must return **byte-identical
header sets**, `Date` aside — the generic shell is the same response for every
refusal, so the page cannot confirm that a slug exists. One difference from
production to know about: the Hosting emulator forwards every cookie to the
function where production forwards only `__session`; the function reads none,
so the rows above do not depend on it, but it is why a cookie-based bug can
hide here.

### 5 · Both halves of the trust condition

Fork each HTML sample, which resets `trusted` to false, and open all three:

| | sandbox | script ran | prompt |
|---|---|---|---|
| scripted, untrusted | `allow-same-origin` | no | **yes** |
| script-free, untrusted | `allow-same-origin` | — | **no** |
| scripted, trusted (operator script) | none | yes | no |

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

### 11 · A fork remembers its original, and says so only to who could open it

Three accounts: **A** owns a public document, **B** and **C** do not.

1. Signed out, open A's document and press **Fork**. Sign in as B: you land back
   on the document and the fork opens — same title, `v1`, private, a "Fork" chip
   beside the version. The chip's panel says "Forked from" A's document, linked.
2. As C, open B's fork after B shares it, and fork it again. The panel shows two
   hops. Have B make their fork private: C's panel now stops at "a document you
   can't open", and does not name A's document behind it.
3. As A, publish v2. B's fork shows the dot, and its panel says the original has
   changed. A's card and toolbar say `2`, and A's panel lists B's fork only
   while A can open it.
4. In the Firestore emulator UI, `docs/{fork}` holds `forked: true` and nothing
   naming its parent; the pointer is in `forks/{fork}`, which the rules suite
   proves no client can read.

### 12 · A thumbnail is captured once, shows the slide's last frame, and is kept

Publish `deck-animated` and sign in as its owner.

1. Open it. Within a few seconds the network panel shows two `POST /thumb`
   requests, `kind=cover` then `kind=slides`, both `200`. `docs/deck-animated`
   now holds `thumb` with a cover key and `slides.count: 6`, and its
   `updatedAt` has not moved. In the Storage emulator the images sit under
   `docs/deck-animated/thumbs/v1/{key}/`, beside `v1/`, never inside it.
2. The rail's thumbnails are `<img src="/thumb/…">`, not preview frames. Every
   slide shows its final state: the badge on the first, every bar on the
   third at its value.
3. Back on the workspace, the card leads with the first slide. Reload: the
   cover comes from the browser's cache, with no request reaching the function.
4. As `reviewer@example.com`, the cover and rail load, and opening the deck
   sends no `POST /thumb`. A non-member asking for the same image URL gets the
   same `404` as for one that does not exist.
5. Publish `deck-quarter-review` and `markdown-reference` and open only the
   workspace, as their owner. Within a few seconds each sends one
   `POST /thumb … kind=cover` from the workspace itself, and both cards show
   their first screen. `deck-animated`, trusted and scripted, keeps its
   placeholder until it is opened; so does any document whose expiry has
   passed.

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
