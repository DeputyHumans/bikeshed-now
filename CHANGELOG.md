# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org/),
and — because a document format and a wire format are both public API here —
treats the following as breaking:

- the content-hash framing (SPEC §9), because it decides whether a republish
  deduplicates,
- the MCP protocol version and tool schemas (SPEC §19),
- `docs/architecture/spec.md` section numbers, which are cited from a hundred source files:
  append, never renumber.

A Markdown renderer bump is **not** breaking, but it is a migration: the
rendered bytes are part of the content hash, so every Markdown document's next
save mints a new version. `docs/operations/overview.md` says how to plan one.

## Unreleased

### Security

- **An unlisted document needs its link, everywhere.** Before this fix,
  "unlisted" meant "readable by anyone who guesses the id". The key was checked
  on three byte paths, and everything else treated unlisted as public:
  - Anyone could list `public/` and read every unlisted document's id, title and
    publish time.
  - Opening one without the key drew its title, version and controls around an
    empty frame.
  - Any account could read and write its comments, read its whole source through
    `get_document`, and duplicate it.
  - Any account could edit it through the realtime log when open editing was on.
  - `/view` and the write endpoints confirmed that it existed.

  Now, without the key, it is indistinguishable from an id that does not exist
  (SPEC §17, [ADR 0012](docs/architecture/adr/0012-unlisted-needs-its-link.md)):
  - `public/` holds public documents only, and can no longer be listed.
  - Unlisted readers get their fields from a new `POST /unlock`.
  - A signed-in link holder gets a link grant, which lets them comment and lapses
    when the link is rotated.
  - `get_document`, `update_document`, `get_comments` and `reply_to_comment` take
    an optional `k`, and the CLI accepts the link itself in place of an id (in
    `bikeshed-now` 0.4.0).
  - Link holders on an unlisted open-editing document edit through the draft
    endpoints, not the live log.

  **Operator action:** deploy functions, hosting, then rules, and run
  `scripts/reconcile-visibility.mjs` once, in the order
  [`docs/operations/overview.md`](docs/operations/overview.md) gives.
- **Only a document's editors may move it.** `/organize` and `move_document`
  gated a move on open editing. So any account could file someone's open-editing
  public document into its own folder, which made it a member, with the member
  list and the reading statistics.
- **Write endpoints answer 404, not 403, to anyone who may not read the
  document.** The 403 confirmed that a private id existed.

### Added

- **The instructions say what a document may contain.** `/llms.txt`, the
  publishing skill and `bikeshed --help` now list the formats a deployment
  takes and what renders, runs and loads in each. An agent had been left to
  guess, and the natural guesses were wrong. Mermaid, math, footnotes and YAML
  front matter show as typed. External images and fonts load; they were never
  blocked, only discouraged. Scripts, handler attributes, `target="_blank"` and
  forms stay off until a person trusts the document: its owner for everyone,
  any reader for themselves. The sandbox rows were checked in Chromium against
  the viewer's iframe attributes, and the Markdown rows against the pinned
  renderer.
- **`bikeshed update` revises a `.zip` bundle.** It sends the archive as bytes
  to `POST /publish?update=<id>`, which publishes a new version of that
  document with the archive as its whole bundle. That needs an editor of the
  document; open editing is not enough (SPEC §2).
- **A publisher can choose a document's address.** `POST /publish` takes `id`,
  `publish_document` takes an optional `id` (a schema addition), the CLI takes
  `--id` (in `bikeshed-now` 0.3.0), and the upload dialog has an
  Address field. It was previously always derived from the title, so two
  documents with one title could only be told apart by a counter. The id has to
  be what `slugify` would produce, lowercase letters, digits and inner hyphens
  up to 60 characters, and anything else is a `400` before a byte is stored
  (SPEC §4).
- **The terminal client is on npm**, as `bikeshed-now`, providing the `bikeshed`
  command: `npm i -g bikeshed-now`, or `npx -y bikeshed-now` for one call. It was
  previously reachable only by cloning this repository, which made every
  `bikeshed …` line in the agent instructions unfollowable for anyone who had
  not. Three files, no dependencies.
  [`docs/operations/publishing-the-cli.md`](docs/operations/publishing-the-cli.md)
  is the release recipe. The root package is renamed `bikeshed-now-source` so the
  published name belongs to the thing that is actually published.
- **`bikeshed list --all`** (in `bikeshed-now` 0.2.0) prints every document you
  can read, following the cursor itself, 50 rows a request. `--json` keeps the
  shape of a single page, so a script needs no second parser.
- **A publish result says where to read the document.** `publish_document` and
  `update_document` return `url`, and the CLI's `--json` carries it too. An agent
  over MCP cannot derive it — the origin is in its client's configuration, which
  the protocol never shows it — so it had nothing to hand back but an id.
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
  exists must be named in `docs/agents/agent-guide.md`. A skill naming an absent
  command is worse than no skill, because an agent believes it.

- **Documents can carry an optional expiry.** The owner sets a date in Share;
  after it, the document is read-only and readable only by them.
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

- **A shared link unfurls as the document.** `/d/**` is now served by a
  function, `docShell`, that injects the document's own `<title>`, description,
  keywords and image into the app shell — read from the uploaded HTML at
  request time, no parser, no new dependency — for a document that is readable
  anonymously: public, or unlisted with its link token in the URL. A link
  pasted into Slack, iMessage or LinkedIn shows the document rather than the
  product (SPEC §17 "Link previews"). Everything else gets the generic shell,
  and a private slug and an absent one answer with the same bytes. A document
  that declares no usable image gets a branded default card.

  Two operational consequences. Deploying it needs **functions and hosting
  both** — the function, and the `firebase.json` rewrite that routes to it —
  and `BIKESHED_PUBLIC_ORIGIN` is now load-bearing for every document page,
  because the shell is fetched from Hosting at runtime
  ([ADR 0011](docs/architecture/adr/0011-document-page-through-a-function.md)).

### Fixed

- **A reader without an account saw an unlisted bundle without its images.**
  The viewer carried the link's key as `?k=` on the entry, and a query string
  belongs to one URL: every image and stylesheet the entry names by relative
  path was requested without it and answered 404. The key now rides in the
  content path, `/content/~<k>/<docId>/<versionId>/…`, which every relative
  reference inherits; `?k=` is still accepted. The slide thumbnails, the print
  export and the three downloads carry it too, and had the same fault (SPEC §2,
  §17).
- **A link out of a document replaced it inside the viewer.** A plain link
  navigated the document's frame to somebody else's page, often a refusal to be
  framed, and `target="_blank"` did nothing at all, because a sandboxed frame
  may not open a tab. A link that leaves the version now opens in a new tab
  from the viewer, and the document stays. A link to a passage, or to another
  file of the same bundle, behaves as before (SPEC §6).
- **Revising a bundle through a token dropped its images.** `update_document`,
  and so `bikeshed update` with one file, built the new version from the sent
  file alone, so every stylesheet and image beside a bundle's entry 404ed from
  its first revision on. The in-app commit had always laid the edit over the
  base version's files. Both token paths now go through one `reviseDocument`
  that does the same: one file replaces the entry at the base version's own
  path, a `.zip` replaces the bundle, and the format cannot change. A version
  that already lost its files keeps what it holds, and a one-file update
  carries forward only that; `bikeshed update` with the whole `.zip` repairs it.
- **`bikeshed update` corrupted a `.zip`.** It read the archive as UTF-8 and
  sent the text through `update_document`, so every byte above `0x7f` became
  U+FFFD and the deployment answered with adm-zip's `Invalid CEN header`.
- **A damaged `.zip` was a 500.** adm-zip parses the central directory lazily,
  so an archive that passed its constructor threw from `getEntries()`, outside
  the guard. It is now refused as `could not read the .zip archive`.
- **Two creates at one id could overwrite each other's bytes.** A new document's
  files are stored before its record, so two publishes (or duplicates) that
  picked the same id both wrote to its `v1`, and the loser replaced the winner's
  bytes, which the version record promises never change, before failing with a
  `500`. New-document writes are now create-only, and a refused write moves the
  document to a suffixed id.
- **`bikeshed list --cursor` returned the first page again** (fixed in
  `bikeshed-now` 0.2.0). The CLI printed the cursor, parsed the flag, and never
  sent it, so nothing past the newest page was reachable from the terminal.
  `--limit` and `--cursor` are now in `--help`.
- **The instructions said a token publish was trusted.** It never was:
  `publishNewDocument` writes `trusted: false` for every path a personal access
  token can reach, and only the operator script publishes trusted. The guide, the
  publishing skill, the spec and the threat model now say so, and a test refuses
  the claim in any agent-facing document. A raw `<script>` in Markdown is
  sandboxed exactly like one in HTML.

### Changed

- **A taken id gets a random suffix, not a count.** A second document titled
  `01-platform` now lands at `01-platform-k3x9qz`, say, rather than
  `01-platform-2`. A count told the publisher how many documents held the name
  and made the next id guessable. Existing ids keep their addresses. The
  publisher still learns that the id was taken; the threat model says why that
  is accepted.
- **`/llms.txt` and `/skills/**` name the deployment serving them.** They
  carried the literal `https://<deployment>` in seven places, so an agent that
  had just fetched the instructions from a live deployment was told to POST to
  a placeholder — and a skill, which is written into `.claude/skills/` and read
  days later with no origin in sight, could not work the address out even in
  principle. The app build now substitutes the real origin into `app/dist`,
  from `BIKESHED_PUBLIC_ORIGIN` or `config/deploy.json`'s `domain`, which is
  the first thing that has ever read that key. The guide also says which
  deployment it is in its own first line, and its command-line stanza is
  copy-pasteable.

  The tracked copies keep the placeholder, so `check:agents` stays a byte
  comparison and no deployment binding enters the tree — which matters because
  `check-secrets.sh` matches by shape and a custom domain has none. A
  `<deployment>` that survives the substitution fails the build, and the
  hosting `predeploy` refuses to deploy an `app/dist` that was never stamped.

- **Share and "Who can see it" are one dialog.** They were two, behind two
  entries of the same menu, asking one question — who gets this — from two
  places, and the second was found only by reading the overflow menu. "Share"
  now holds the people and teams first, then the three visibility levels side
  by side, the link, open editing and the expiry under its own rule. The
  count in the footer widens with the level ("2 people, and anyone with the
  link"). Folders keep the people-only dialog, having no visibility or expiry.
  Every visibility change still sends the whole triple, so ticking one box
  never clears another.

- **An expiry is a chip beside the version, not a banner above the document.**
  The banner appeared for every future date, so a document set to expire next
  year gave up a row of the document area for eleven months. The chip sits on
  the toolbar next to the version badge — the same one the workspace card
  shows — escalates in wording and colour through the last week and past the
  date, explains itself on hover or on tap (nothing is deleted; who can open
  it; who can restore it), and for the owner opens the place the date is
  changed. Nothing about an expiry takes a row from the document any more.

- **A document with nothing to say opens without the comments panel.** The
  panel was open on every document: a 340px column reading "0 open" and
  asking the reader to select a passage. It now starts collapsed and opens on
  its own only when the version's first annotation snapshot holds an
  unresolved thread — resolved ones are hidden until asked for, so a version
  whose every thread is dealt with reads as done. The reader's own toggle
  still wins over the default in either direction, a comment landing later
  does not reopen a panel they closed, and starting a comment opens it as
  before.

- **An HTML upload's default title is its own `<title>`.** When no title is
  given, the workspace title — and so the slug of a new document — comes from
  the document's `<title>` rather than the file name. The upload dialog no
  longer prefills the file name as a title, so a browser upload follows the
  document's title exactly as CLI and MCP uploads already did; a typed title
  still wins, and existing documents keep the titles they have.

- **A deck can be moved through.** The slide navigator was edit-mode only, so a
  reader opening a long deck got one very long scroll and no way around it. It
  is now available while reading too, behind a toolbar toggle, alongside
  arrow-key paging and an overview of every slide at once. Its thumbnails are
  the slides themselves rather than an index and a title: each is the slide
  rendered into a separate document, scaled down, sandboxed without
  `allow-scripts` even when the document is trusted, and mounted only when
  scrolled into view — one deck in the sample set has 48 slides and every
  preview is an iframe.

  What counts as a slide now lives in one place (`app/src/viewer/deck.ts`) and
  is decided by an ordered list of rules rather than a selector. Measured
  against real decks, `body > section[id]` — the old selector — matched none of
  them, including the repo's own tour, whose sections sit inside `div.deck`. So
  the navigator had never appeared for the one sample built to be navigated.
  Paging is gated on measurement rather than markup: on a document whose
  sections are taller than the viewport, taking the arrow keys would leave the
  reader unable to scroll within a section.

- **The brand guard is now `scripts/check-secrets.sh`, and matches only by
  shape.** It used to be driven by `scripts/forbidden-terms.txt`, a committed
  list of literal strings that must never appear. A list like that has to be in
  the tree to be useful, so committing it published the very words it existed to
  suppress — it was its own first leak — and it could never catch anything
  nobody had thought to add. The four tiers that read it are gone. The five that
  remain never needed a list of names: deployment bindings by shape, absolute
  local paths, attribution trailers, the tracked-binary allowlist, and a new
  credential tier covering `sk-`, GitHub and Slack tokens, AWS key ids,
  private-key blocks, service-account JSON, and any tracked dotenv or key file.
  `npm run check:brand` is now `npm run check:secrets`, and the guard prints
  `check-secrets: clean`.
- **Git history was rewritten once, before first publication.** The old guard
  carried the suppressed company name in a comment example, sanitised in the
  working tree but still present in five historical commits, where no tier could
  see it — the history tier reads commit metadata, never historical file
  content. Every commit id therefore changed. Nothing had been published at the
  time, so no clone needed reconciling.
- **`npm --prefix app run coverage` now runs in CI.** The step was named "App
  tests and coverage" and the verification table promised ≥90%, but the command
  behind both was `vitest run` with no `--coverage`, so the thresholds in
  `app/vite.config.ts` had never once been enforced.
- **`firebase` is a declared root devDependency.** `rules-tests/` imports it and
  had been resolving it as an auto-installed peer of
  `@firebase/rules-unit-testing`, which breaks under `--legacy-peer-deps`.
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
  converges ([ADR 0010](docs/architecture/adr/0010-crdt-for-shared-document-state.md)).
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

### Fixed

- **The lock, eye and globe on the visibility options were a few pixels
  wide.** Each icon sat in a flex row beside a sentence, and the flex
  algorithm took the sentence's width out of the icon — five to eleven pixels
  of an eighteen-pixel mark. The icon no longer shrinks; the sentence wraps.

- **Setting an expiry crashed the function under the emulator.** One line
  reached `Timestamp` through `admin.firestore`, whose static namespace the
  Functions emulator's proxy drops — the same defect `FieldValue` had, in the
  same file, and invisible to every unit test because it is fine in
  production. `Timestamp` now comes from `firebase-admin/firestore` too, and
  `wiring.test.js` pins the shape so a third class cannot go the same way.

- **A reader of a public document who was not a member was never told about
  its expiry.** The `public/{docId}` projection carries the date for exactly
  that purpose (SPEC §17: "the reader is told rather than shown an empty
  frame"), and the viewer never read it — it looked only at the member
  record. The expiry chip reads whichever record the reader has.

- **"Print or save as PDF" overrode the document's own page layout.** The
  export appended an `@page` margin rule of its own after the document's
  styles, and `@page` cascades by order: a deck sized for its slides lost its
  zero margins and printed every slide across two pages, and every document
  lost the margin choice in the print dialog, which Chrome ignores once CSS
  has set one. The rule is gone — the document, or the dialog, decides. The
  marking stamp now goes first in the body rather than last, because
  anything after a document's final forced page break opened a blank page
  carrying nothing but the stamp.

- **Printing a document page printed the app.** Cmd+P produced the header,
  the toolbar, the comments column and the document clipped to its on-screen
  box. The shortcut now goes to the same export as "Print or save as PDF" —
  the document alone, scrubbed and stamped — and it is heard with the focus
  inside the document, where it usually is. File → Print, which no event can
  redirect, prints the page with the chrome hidden and the frame opened to
  the document's full height so it paginates, and puts the reader back where
  they were afterwards. That path carries no stamp; nor does the content URL
  the same reader can already open.

- **A banner pushed the document to the bottom of the page.** The viewer
  grid had one row for the toolbar and one for the document, so whenever a
  banner appeared — a newer version, an expiry, a conflict — it took the
  document's row, stretched to the whole height with its bottom border as a
  stray rule across the page, and left the frame a 150px strip underneath.
  The grid now has a row for the banners, empty and free when there are
  none, and the document is pinned to the last row rather than placed by
  its position among its siblings.

- **Publishing a version announced it to the person who published it.** The
  "newer version" banner fired on every change of the current version,
  including your own commit, and offered "Open v4 / Stay here" over a frame
  already showing v4 — the same for any reader with no version pinned, whose
  frame already follows. It now appears only when the viewer is showing an
  older version, and clears by itself once that reader opens the new one.

- **Selecting text on a click-driven deck advanced the slide.** A drag that
  selects a passage ends in a `click`, and a deck whose own script advances on
  click — the common hand-made shape — took it, hiding the very slide the
  reader was about to comment on. Clicking a highlight did the same: the thread
  opened in the panel while the deck moved off it. Both clicks are now stopped
  before the document's own scripts see them — a capture-phase listener on the
  frame window for the selection, the highlight's own listener for the mark —
  and only those. The selection test is what the gesture did, not whether
  text is selected: a click that dismisses a selection, or one made while a
  selection sits stranded on a slide the keys moved off, is an ordinary click
  and the deck gets it as before. It is propagation that is stopped, never
  the default action, so a link still navigates (SPEC §6).

- **The slide rail had no layout container, so it stacked on top of the
  document.** `.doc-frame-wrap` was a plain block, and the rail was rendered as
  a normal-flow sibling of a full-width iframe — so above 860px the rail sat
  above the document, grew to the height of every thumbnail it held (nothing
  bounded it, so its own `overflow-y` never engaged), and pushed the frame out
  of view. Below 860px the rail is `position: fixed`, which is why only wide
  windows were affected and why the mobile drawer looked fine. The wrapper is
  now a grid whose rail track is `auto`, so it collapses to nothing when there
  is no rail rather than stranding an empty band — the failure `.viewer-body`
  already carries a comment about.

- **Slide thumbnails were rendered without the CSS that shapes them.** A
  preview emitted the slide alone as the only child of `<body>`, discarding
  every ancestor its stylesheet is written against — a deck that gets its width
  from a container rule rendered full-bleed, and one built as
  `<svg><foreignObject><section>` lost its layout entirely. The box was still
  sized from the live, correctly-styled frame, so the contents filled a
  fraction of it and the rest was the reported whitespace. Previews now
  reproduce the ancestor chain, and `html` and `body` keep every attribute
  rather than only `class` — `dir="rtl"` alone flips a deck.

- **Previews flattened the slide they were previewing.** The override forced
  `position: static`, `inset: auto` and `margin: 0`, which turns
  `position:absolute; inset:0; display:grid; place-items:center` into
  shrink-wrapped content in the top-left corner. Only visibility is forced now;
  `display` and `transform` move only where the live document shows that is
  what hides the slide, and the layout properties are never touched.

- **Every thumbnail was a different height.** Each was measured from its own
  slide and clamped, so the rail was a ragged column and the overview left a
  band of dead space under every short card — a grid row is as tall as its
  tallest item. All previews in a deck are now laid out at one size, the
  reader's own frame viewport, which also means a deck that re-flows at a
  breakpoint is previewed at the width it is being read at.

- **The thumbnail width was declared twice, in two languages, and disagreed.**
  The rail's CSS left a 131px content box against a hardcoded 132, and the
  overview's cards were pinned to 236px inside `minmax(236px, 1fr)` columns
  that are wider, leaving dead space beside each one. CSS is now the only owner
  and the thumbnail measures its own box.

- **The slide navigator appeared for anything with two sections.** It is now
  shown only for a document whose slides measure about one viewport tall — the
  signal the arrow keys already used. A long article no longer gets a rail of
  illegible prose thumbnails, each of which cost a function invocation. The
  measurement is latched per load, because opening the rail narrows the frame
  and an unlatched answer makes the viewer oscillate.

- **The rail did not follow the reader**, so on a long deck the highlight
  walked off the bottom and stayed there; and a slide dragged in edit mode gave
  no indication of where it would land, though the rail had styled a drop
  target since it was written and nothing ever set it.

- **The overview took focus to the first slide, not the current one.**
  `querySelector('[aria-current="true"], button')` returns the first element
  matching *either* in tree order, which is always card one.

- **The tour rendered blank when its scripts were blocked.** Its fifteen
  sections started at `opacity: 0` and were revealed by a class the inline
  script adds on scroll, so with scripts blocked none of them ever appeared —
  measured in a sandboxed frame, 0 of 15 were visible. That is the state the
  file is most often read in, and it is the sample that exists to demonstrate
  the trust prompt, so it was demonstrating the bug instead. Its own header
  comment claimed the opposite. The fade is now opted into by a class the
  script adds once it knows it can finish the job: 15 of 15 visible.

- **Leaving fullscreen left the app in presentation mode.** Nothing listened
  for `fullscreenchange`, and neither Escape nor F11 clicks the Exit button, so
  the header, toolbar, banners and comments panel all stayed hidden with a
  35%-opacity button as the only way back.

- **The trust banner promised content to readers looking at nothing.** A deck
  that generates its slides at runtime ships an empty container, so "parts of
  it may look empty" described a page that was entirely empty. The viewer now
  tells those two states apart and says which one it is.

- **The functions, cli and rules suites never ran in CI.** Their scripts passed
  a quoted glob to `node --test`, which means node expands it rather than the
  shell — and node only learned to do that after 20. Development happens on
  node 22, where it works; CI pins node 20, where `node --test` reported
  `Could not find .../test/**/*.test.js` and exited non-zero having run nothing.
  The globs are now unquoted and single-level, which the shell expands on every
  version. Confirmed against node 20.19.3: 157 functions tests and 19 cli tests,
  where the old form found none.

- **The app suite asserted against whatever configuration a machine happened to
  have.** Vitest loads `app/.env.local`, which is gitignored, so the suite
  passed on a developer machine that had copied it and failed on a fresh clone
  that had not: `firebase.ts` calls `initializeApp` at module scope, throws
  `auth/invalid-api-key` without a key, and took `analytics`, `Landing` and
  `viewer/invariant` down with it at import time. The test environment is now
  pinned to the `app/.env.example` values in `vite.config.ts`, so the suite is
  hermetic either way. 259 tests pass with the file present and absent alike.

- **Contact addresses now point at the project rather than at a person.**
  `SECURITY.md` and `CODE_OF_CONDUCT.md` both named a personal domain; both now
  say `info@bikeshed.now`. The permission address in `NOTICE` is deliberately
  unchanged — it belongs to a third party, and redirecting it would misdirect
  the request it exists to receive.

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
  round trip ([ADR 0007](docs/architecture/adr/0007-execcommand-over-schema-editor.md)).
- **Markdown as a first-class source format**, compiled to an HTML bundle
  server-side once per version, with a restricted editor palette whose
  unsupported controls are disabled with a reason rather than hidden
  ([ADR 0003](docs/architecture/adr/0003-server-side-markdown.md)).
- **Idempotent publishing.** Identical bytes mint no version, by content hash.
- **Three visibility levels** — private, unlisted by token, public — served
  through a projection that carries no member list, never by opening the bucket.
- **Collaborative presence**: peer cursors, selections and reading positions,
  with a single-holder edit lock and observe mode instead of a merge engine.
  (Superseded in Unreleased: edits now merge.)
- **Teams**, expanded server-side into the flat membership arrays so the one
  provable workspace query is unchanged
  ([ADR 0006](docs/architecture/adr/0006-denormalized-members.md)).
- **An agent surface**: personal access tokens, six MCP tools, a `bikeshed` CLI,
  and `docs/agents/agent-guide.md` mirrored to `/llms.txt` with CI asserting they match.
- **Provenance on everything.** Identity and channel are derived from the
  credential, never claimed; `client` and `agent` are self-reported and labelled
  as such. Automated reads count into `stats.apiReads`, never into human
  reading time.
- **Export marking** locked against twenty-five CSS hiding vectors, with the
  text per document rather than hardcoded.

### Security posture

- Any verified account may sign in; an optional domain allowlist is generated
  into all four enforcement layers from one file
  ([ADR 0005](docs/architecture/adr/0005-generated-rules.md)).
- The bucket is private with public-access prevention. One function is the only
  path bytes take to a browser.
- Read-only byte paths answer **404** for forbidden and absent alike, so a
  signed-in stranger cannot enumerate the slug space.
- Untrusted documents render script-sandboxed, with two trust scopes — global
  (owner) and personal (self) — that never collapse into one
  ([ADR 0002](docs/architecture/adr/0002-two-scope-trust.md)).
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

`docs/development/verification.md` is the emulator walkthrough for the integration
properties no unit test reaches. Writing it found four real defects, each fixed
in its own commit.

### Known limits, stated rather than discovered

- A membership change fans out one write per affected document. Bounded and
  batched; fine for a small team, and named in `docs/architecture/overview.md` so nobody
  is surprised at ten thousand documents.
- Making a public document private again takes up to five minutes to propagate
  through the CDN. That is the price of caching public content at all.
- `~~strikethrough~~` round-trips as `~strikethrough~`. GFM accepts both and it
  is stable thereafter; it is the one lossy Markdown normalization.
- Presence needs a Realtime Database and email needs a Resend key. Without
  either, both degrade to clean no-ops — which is the path CI exercises.
- The MCP server is hand-written rather than built on the SDK, which requires
  `zod` as a peer ([ADR 0009](docs/architecture/adr/0009-hand-written-mcp.md)). Protocol
  changes are ours to follow, and a test speaks the wire format to catch them.
