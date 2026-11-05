# Verification

`npm run verify` proves the code is self-consistent. It does not prove the product works, because the most valuable properties here are *integration* properties: a highlight surviving a reload, a script not running until somebody vouches for it, generated DOM not being baked into the next version.

This is the walkthrough that proves those, against the emulators, with no cloud account. It found four real defects the unit suites could not, each recorded in the commit that fixed it. Most of it now runs as the opt-in end-to-end suite; [Automated](#automated-npm-run-teste2e) maps each step to its specs and says what is still walked by hand.

---

## Running it

```bash
npm run install:all && npm run build:policy
cp app/.env.example app/.env.local
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

The three samples are not decoration: **A is scripted HTML, B is script-free HTML, C is Markdown**, and that is exactly what makes the trust observations below possible. `npm run check:content` keeps them that way. The fourth, `deck-animated`, is a stacked deck whose slides reveal only once shown — trust it, and its slide thumbnails are what show whether a preview reaches a slide's final state.

Four prerequisites for the document page, which the Hosting emulator serves through `docShell` exactly as production does:

- **`functions/.env.local` containing `BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050`.** That file is loaded last and only by the emulator. Without it, one of two things happens. On a deployer's machine, where `functions/.env` carries the production origin, the emulator **silently fetches the production shell**: every document page boots the live site's assets and nothing warns. With no origin configured anywhere, the fallback is `demo-bikeshed`'s default site, which does not exist: opening the first document page prints a warning from the running function (`docShell: BIKESHED_PUBLIC_ORIGIN is unset — /d/** will answer 503 …` — not at emulator start-up, where firebase-tools' brief discovery pass would print the same line spuriously) and every `/d/**` answers 503. Either way the console prints `shell origin: http://127.0.0.1:5050` on the first document page once the override is in place; if it prints anything else, it is missing.
- **`functions/.env.local` also containing `BIKESHED_BUCKET=demo-bikeshed-content`.** `functions/.env` may name the real content bucket on a deployer's machine; without the `.local` override `contentProxy` reads a bucket `publish.mjs` never wrote to, and every document asset 404s.
- **`env $(grep -v '^#' app/.env.example | xargs) npm run build:app`.** The Hosting emulator serves `app/dist`, not the Vite dev server, and `app/.env.local` may hold a real web config: building with plain `VITE_USE_EMULATORS=1 npm run build:app` on a deployer's machine inlines that real project id, so the built app queries the emulator under the wrong project and every document page sits at "Opening the document…" forever. Building from `app/.env.example` instead uses the demo values it pins (`demo-bikeshed`, `demo-api-key`, `demo-bikeshed-content`, `http://127.0.0.1:9000?ns=demo-bikeshed`) regardless of what `app/.env.local` holds.
- **`config/deploy.json` stamps the emulator's `/llms.txt` too.** The same build writes this deployment's real address into `app/dist/llms.txt` and `app/dist/skills/**`, so on a deployer's machine the instructions you read at `http://127.0.0.1:5050/llms.txt` point an agent at **production**. Add `BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050` to the build above — the same origin `functions/.env.local` already gives `docShell` — and the local instructions describe the local deployment:

  ```bash
  env $(grep -v '^#' app/.env.example | xargs) \
    BIKESHED_PUBLIC_ORIGIN=http://127.0.0.1:5050 npm run build:app
  ```

---

## What to observe, and what it proves

### 1 · Publishing the same bytes twice is a no-op

Re-run any publish. It prints `already published as v1 (contentHash match) — NO-OP` and mints no version. This is what makes publishing safe in a loop, in CI, and in front of an agent that cannot remember what it already did.

### 2 · A Markdown document stores both files

`docs/markdown-reference/versions/v1` records `format: "markdown"`, `entry: "index.html"`, `sourceEntry: "index.md"` and the pinned `rendererVersion`, and both files exist under the version prefix. Every ACL and export path sees an ordinary HTML bundle ([ADR 0003](../architecture/adr/0003-server-side-markdown.md)).

The operator script's actor is recorded as `uid: null, channel: "cli"` — the one case in the system where an actor has no account, because Admin credentials are not one (SPEC §17).

### 3 · A stranger cannot tell a forbidden document from an absent one

| caller | a document they can read | one they cannot | one that does not exist |
|---|---|---|---|
| owner / member | 200 | — | 404 |
| signed-in stranger | — | **404** | 404 |
| anonymous | — | **404** | 404 |

403 would say "this exists and is not yours", which is an enumeration oracle on a slug space that often contains the confidential part.

### 4 · Visibility changes what the proxy will serve, never what the bucket holds

| | anonymous | cache-control | X-Robots-Tag |
|---|---|---|---|
| `private` | 404 | `private, no-store` | — |
| `unlisted`, no token | 404 | | |
| `unlisted`, wrong token | 404 | | |
| `unlisted`, correct token | 200 | `public, max-age=300` | `noindex` |
| `public` | 200 | `public, max-age=300` | — |

Then check `public/{docId}` for the PUBLIC row: it carries `docId, title, slug, currentVersion, entry, format, visibility, publicEdit, trusted, expiresAt, forked, publishedAt` and **no** `members`, `viewers`, `ownerEmail` or `stats`. There is no row at all for the private and unlisted documents, and an anonymous `GET` of `public/<unlisted>` and of `public/<absent>` both come back `PERMISSION_DENIED`, as does listing `public`. Make the public document private again and its row is gone — that is the revocation path, with the five minutes of CDN latency documented in `operations.md`.

An unlisted document's readers get those fields from `POST /unlock` instead (`curl -si -X POST http://127.0.0.1:5050/unlock -H 'content-type: application/json' -d '{"docId":"<slug>","k":"<token>"}'`):

| | anonymous | signed-in stranger | cache-control |
|---|---|---|---|
| unlisted, no token | 404 | 404 | `private, no-store` |
| unlisted, wrong token | 404 | 404 | `private, no-store` |
| unlisted, correct token | 200 | 200, and a grant at `docs/<slug>/linkGrants/<uid>` | `private, no-store` |
| private, or absent | 404 | 404 | `private, no-store` |

After that 200, the stranger reads the unlisted document's threads and can comment without the token in the URL, and `/content/**` answers them `private, no-store`, never `public` — their URL carries no key. Make the document private and unlisted again, and the old token and the grant both stop working. `POST /view` without the token is the same 404 as an absent id.

The document page follows the same five rows. `curl -sI http://127.0.0.1:5050/d/<slug>` (with `?k=…` for the unlisted rows), and `curl -s` for the body:

| | status | cache-control | X-Robots-Tag | `<title>` is the document's |
|---|---|---|---|---|
| `private` | 200 | `private, no-store` | — | no |
| `unlisted`, no token | 200 | `private, no-store` | — | no |
| `unlisted`, wrong token | 200 | `private, no-store` | — | no |
| `unlisted`, correct token | 200 | `public, max-age=300` | `noindex` | **yes** |
| `public` | 200 | `public, max-age=300` | — | **yes** |

A slug that does not exist and a private one must return **byte-identical header sets**, `Date` aside — the generic shell is the same response for every refusal, so the page cannot confirm that a slug exists. One difference from production to know about: the Hosting emulator forwards every cookie to the function where production forwards only `__session`; the function reads none, so the rows above do not depend on it, but it is why a cookie-based bug can hide here.

### 5 · Both halves of the trust condition

Fork each HTML sample, which resets `trusted` to false, and open all three:

| | sandbox | script ran | prompt |
|---|---|---|---|
| scripted, untrusted | `allow-same-origin` | no | **yes** |
| script-free, untrusted | `allow-same-origin` | — | **no** |
| scripted, trusted (operator script) | none | yes | no |

The prompt appears only when the document is sandboxed **and** actually contains a `<script>`. That AND is why the two HTML samples differ the way they do, and it is what keeps the prompt meaningful when it appears.

The sandbox is also in the bytes (SPEC §2 "The script lock"). Open the scripted fork's own address, `/content/<id>/v1/index.html`, in a tab: the page renders and `#dot-nav` stays empty, and `curl -sI` shows `content-security-policy: sandbox allow-same-origin`. Its run address, `/content/!run/<id>/v1/index.html`, is unlocked (`frame-ancestors 'self'` alone) only once you have chosen *Run it for me*.

### 6 · A highlight opens every collapsed ancestor it needs — and only those

The most important observation here. Select text inside the **nested** `<details>` in `#s5-sections`, comment, and reload.

- The anchor records `elementId: "s5-sections"` — the nearest `id`-bearing ancestor, not `<body>`. That scope is what makes it survive edits elsewhere.
- On reload the highlight is redrawn, the nested `<details>` is open, **and so is its ancestor**.
- The other eight `<details>` are still closed. It opened what it needed and nothing else.

### 7 · Committing an edit publishes the document, not the app

Resolve the open threads (a commit is refused while any remain — the button is disabled and says why), edit a heading, and commit. Compare v1 and v2:

```
v1: bshd-artifacts=0  data-bshd=0  contenteditable=0  <script>=1  <style>=1  dot-nav-children=0
v2: bshd-artifacts=0  data-bshd=0  contenteditable=0  <script>=1  <style>=1  dot-nav-children=0
```

Both have 15 sections, 10 `<details>`, 6 SVG, 29 ids and **no duplicate id**. `#dot-nav` is still empty in the saved bytes although the script filled it with fifteen children at read time — the generated DOM was not baked in, which is what would otherwise accumulate one copy per save. v1 stays readable at `/d/bikeshed-tour/v1`.

### 8 · Markdown editing is restricted, visibly

Open the editor on each format and compare the toolbar:

| | HTML document | Markdown document |
|---|---|---|
| Underline, Font, Text colour, Align | enabled | **disabled**, with a tooltip |

The tooltip says *"Markdown cannot express this, so it would be lost the next time you save."* Disabled beats hidden: a control that appears to work and then loses your formatting is worse than one that is visibly unavailable.

The download menu is format-aware too — the Markdown document offers the rendered HTML, **the Markdown source**, and a zip; the single-file HTML document offers the HTML.

### 9 · Editing a Markdown document does not degrade it

Commit an edit, then commit a **no-op** edit. The second prints `deduped: true` and returns the same `versionId` — it mints nothing at all, which is idempotence observed end to end rather than only in a unit test. Diff v2's `index.md` against v3's: the only differences are your edit plus the first-pass normalization, and comments — including the SPDX header — are still there.

### 10 · The agent loop closes, and stays traceable

Mint a token in account settings, then:

```
tools/list      → list_documents, get_document, publish_document,
                  update_document, get_comments, add_comment, reply_to_comment, …
get_comments    → each thread with the exact passage it is anchored to
add_comment     → a new thread on a quoted passage, highlighted exactly in the viewer
reply_to_comment → posts, and is stamped via: "mcp"
```

A human's comment reads `via: "web"` beside the agent's `via: "mcp"` in the same thread. `get_document` returns Markdown **source**, never rendered HTML.

Then check the document's stats: the agent's read landed in `stats.apiReads` with `ms: 0`, and `stats.views` and `totalMs` are untouched. Reading *time* is a human concept; a machine fetch has none.

### 11 · A fork remembers its original, and says so only to who could open it

Three accounts: **A** owns a public document, **B** and **C** do not.

1. Signed out, open A's document and press **Fork**. Sign in as B: you land back on the document and the fork opens — same title, `v1`, private, a "Fork" chip beside the version. The chip's panel says "Forked from" A's document, linked.
2. As C, open B's fork after B shares it, and fork it again. The panel shows two hops. Have B make their fork private: C's panel now stops at "a document you can't open", and does not name A's document behind it.
3. As A, publish v2. B's fork shows the dot, and its panel says the original has changed. A's card and toolbar say `2`, and A's panel lists B's fork only while A can open it.
4. In the Firestore emulator UI, `docs/{fork}` holds `forked: true` and nothing naming its parent; the pointer is in `forks/{fork}`, which the rules suite proves no client can read.

### 12 · A thumbnail is captured once, shows the slide's last frame, and is kept

Publish `deck-animated` and sign in as its owner.

1. Open it. Within a few seconds the network panel shows two `POST /thumb` requests, `kind=cover` then `kind=slides`, both `200`. `docs/deck-animated` now holds `thumb` with a cover key and `slides.count: 6`, and its `updatedAt` has not moved. In the Storage emulator the images sit under `docs/deck-animated/thumbs/v1/{key}/`, beside `v1/`, never inside it.
2. The rail's thumbnails are `<img src="/thumb/…">`, not preview frames. Every slide shows its final state: the badge on the first, every bar on the third at its value.
3. Back on Everything, the card leads with the first slide. Reload: the cover comes from the browser's cache, with no request reaching the function.
4. As `reviewer@example.com`, the cover and rail load, and opening the deck sends no `POST /thumb`. A non-member asking for the same image URL gets the same `404` as for one that does not exist.
5. Publish `deck-quarter-review` and `markdown-reference` and open only Everything, as their owner. Within a few seconds each sends one `POST /thumb … kind=cover` from the workspace itself, and both cards show their first screen. `deck-animated`, trusted and scripted, keeps its placeholder until it is opened. A document whose expiry has passed gets a cover in its owner's workspace, and stays a placeholder for its editors.

### 12b · Recent lists what you read and what changed, and says which

1. Sign in as `owner@example.com`: the page is Recent, at `/`, in rows. Every sample published in the last 30 days is listed by its new version; one you have opened says "You read it …" and sits by the time you read it.
2. As `reviewer@example.com`, open a document shared with you, then, as its owner, publish a new version. Back on the reviewer's Recent the row reads "New version … by owner@example.com" with "New since you read it"; opening it and coming back clears the mark.
3. Turn on "Opened by me", then "New since I read": each narrows the list, and a reload keeps them. With both on and nothing left, "Clear filters" brings everything back.
4. In the Firestore emulator's request log, the visit made one query on the `viewers` collection group, filtered to the reader's uid. A read of someone else's rows the same way is refused.
5. Shared with me, in the rail, lists the documents the owner shared with the reviewer, each with its folder; Everything is at `/everything`, and a document's trail leads there.
6. Cmd-click a document you have not read, so it opens in a background tab, wait a few seconds and reload Recent: it is still listed by its version. Switch to that tab for two seconds, come back and reload: it says "You read it just now". Leave the tab behind for two minutes and reload again: the time reads "2m ago" and does not catch up.

What this cannot show: the collection-group index, which the emulator never enforces. After a deploy, confirm it is READY, and until it is, that Recent says it is showing new versions only rather than an error (ADR 0027).

### 13 · A suggestion is decided by an approver, as an edit everyone sees

Publish `markdown-reference`. As its owner, share it with `sug@example.com` ("Can suggest"), `ed@example.com` ("Can edit") and `appr@example.com` ("Can approve"), creating the three accounts first as in step 0.

1. As `sug@example.com`, select a few words of one paragraph. The selection toolbar shows **Suggest edit** beside Comment. Select across two paragraphs and press it: it explains why, and opens nothing. Select within one, press it, type a replacement, press Enter. The words are struck through with the replacement after them, and the thread opens, waiting.
2. In the thread, **Edit** the replacement and save it: the struck text and the inline replacement both follow.
3. As `ed@example.com`, open the editor. The bar under the toolbar says one suggested edit is waiting and that only the owner or an approver can decide it; "Save as new version" is greyed out with the same reason, and `POST /commit` answers `409` with `pendingSuggestions: 1`. Stay in the editor.
4. As `appr@example.com`, choose **Review** on the thread. The editor opens on the suggestion, its text marked (in Chrome by the highlight API: no attribute appears on it in the Elements panel). **Accept**. The network panel shows `claim`, then `POST /draft`, then `accept`, in that order. In `ed@example.com`'s editor, the replacement appears once.
5. Suggest a second edit as `sug@example.com`; as the approver, **Reject…** it with a reason. The suggester's thread shows "Accepted." on the first and "Rejected: …" on the second.
6. As either editor, "Save as new version" now publishes. The new version's bytes contain the accepted replacement and no `data-bshd`.
7. Tab through the suggest form and the review bar with the keyboard alone: every control is reachable and works.

### 14 · An app connects by signing in, and the account screen can disconnect it

Run this step through Hosting at `:5050`, not Vite at `:5173`. The Vite proxy rewrites `Host`, so in development the issuer would name `:5050` while the page and its sign-in belong to `:5173`. In the emulator the issuer is the request's own origin (SPEC §23).

1. `curl -si -X POST http://127.0.0.1:5050/mcp` answers `401`. Its `WWW-Authenticate` names `resource_metadata="http://127.0.0.1:5050/.well-known/oauth-protected-resource/mcp"`, and it sends `Cache-Control: private, no-store`.
2. Fetch both metadata documents with `curl -s`. The protected resource's `authorization_servers[0]` equals the server metadata's `issuer` exactly. `/.well-known/mcp.json` still comes from Hosting.
3. Point the MCP Inspector at `http://127.0.0.1:5050/mcp`, in direct mode. It registers, opens `/connect`, and the consent page shows the redirect host with the app's name marked as not checked. The address bar shows `/connect` with no query. **Approve**. The Inspector lists thirty-six tools.
4. On the account screen the app appears under Access tokens as connected. **Revoke** it. The Inspector's next call answers `401` and offers to sign in again.
5. `bikeshed login --origin http://127.0.0.1:5050` prints the address, opens the browser, and shows the "program on this computer" warning. **Approve**. The terminal says it is signed in, and `bikeshed list` works.
6. Download the plugin from the account screen. `unzip -l` lists `.claude-plugin/plugin.json` and each `skills/<name>/SKILL.md`, and nothing else. Open **On Claude's Free plan?** and download a skill: `unzip -l` lists `<name>/SKILL.md` and nothing else.

---

### 15 · An agent decides a review, and publishes it as one version

Use the document from step 13, with the CLI signed in as `appr@example.com` (`bikeshed login`, or `BIKESHED_TOKEN` from the account screen), and three new suggestions from `sug@example.com`: two to accept, one to reject.

1. `bikeshed comments <id>` lists the three, `[pending]`.
2. `bikeshed accept <id> <t1>`, then `<t2>`. `bikeshed get <id>` still prints the old text, because accepting mints no version; in the app, as an editor, the draft banner shows, and the draft has both changes.
3. `bikeshed reject <id> <t3> --reason "Not this one"`. As `sug@example.com`, the three threads read "Accepted.", "Accepted." and "Rejected: Not this one", each marked as an agent's.
4. Open the editor in a second window as `ed@example.com` and leave it open. `bikeshed accept` on a fourth suggestion answers that somebody has the document open in the editor, and writes nothing; so does `bikeshed commit`. Close it.
5. Open a comment thread as anybody. `bikeshed commit <id>` is refused until `bikeshed resolve <id> <thread>`, which leaves a "Resolved." note in the thread that its author is told of; `bikeshed reopen` leaves "Reopened.".
6. `bikeshed commit <id>` publishes one version with both accepted changes. Open the editor: it seeds from the new version, not from a stale log.
7. `bikeshed rename <id> New title`: the workspace list shows it, and `/d/<id>` still opens.

What this proves: the change is made where the page shows the quote, a review lands as one version, and the live log cannot silently undo an accept. What it cannot prove: that a real deployment's runtime account may read and clear the Realtime Database (operations overview, "When something is wrong").

### 16 · An agent watching a document hears what people say, and only once

1. Over MCP (or `curl` to `/mcp`), `publish_document` a short Markdown document. Keep the `cursor` it returns.
2. In the browser, comment on a passage, then resolve the thread.
3. `get_changes` with that cursor: `thread.opened`, `comment.added` with your words and the passage, and `thread.resolved` with your address. Keep the new cursor.
4. `get_changes` again with the new cursor: no events, and the same cursor back.
5. Share the document with a second account from the share panel, and call `get_changes` with that account's token: `access.changed` is not there. That event reaches editors only.

What this proves: the three triggers fire in the emulator and the feed reads them in order, once each. What it cannot prove: that Eventarc may invoke the triggers on a real deployment, or that a failed one is retried. Both show only there (operations overview).

### 17 · A file uploaded as the next version replaces the draft, and nobody's typing

Use any document you own at `v1`.

1. Open the editor, type a word you will recognise, and close the window without publishing. The document now has a draft and a live log.
2. In another window, **More → Upload a new version…**, choose a different `.html`, and **Publish**. The toast says `Published v2.`; the frame shows the new file. The version doc in the emulator UI says `publishedVia: "upload"`, and scripts the owner had trusted are blocked again.
3. Open the editor. It shows `v2`, not the word from step 1: the update dropped the draft's files and its log. Before 0.16.0 it brought the old draft back, and the first keystroke saved it over the new version.
4. Drag a file from the desktop onto the open document. A dashed target covers the page and the dialog opens with the file in it; nothing is published until **Publish**. The frame is never replaced by the file.
5. Open the dialog, then `bikeshed update <id> other.html` from a terminal. The dialog says `v3 was published while this was open` and will not publish.
6. Open the editor in a second window as another editor and leave it open. The dialog names them and will not publish; `bikeshed update` answers that somebody has the document open in the editor. Close it, and both work.
7. Upload the same file again: `No changes — the file is identical to v…`. The workspace card's **Actions → Upload a new version…** does the same as the viewer's menu.

What this proves: every update path refuses under an open editor and drops what the replaced draft left behind, and the dialog never publishes over a version its user has not seen. What it cannot prove: that a real deployment's runtime account may read and clear the Realtime Database. If it cannot read it, every update is refused as "could not tell whether anybody is editing" (operations overview, "When something is wrong").

### 18 · In Safari's engine, an untrusted document still answers

Chrome delivers every event from the document's frame, so nothing above can fail there for the reason this checks. Open an untrusted document with a thread on it in **Safari** (or on an iPhone, or in any iPhone browser):

1. In the console, on the parent page: dispatch an event into `document.querySelector("iframe.doc-frame").contentDocument` with a listener of your own on it. It is never called: the condition SPEC §6 describes.
2. Select a word. **Comment** appears, within a moment (the selection is sampled, not heard). On a touch screen it is docked at the bottom.
3. Tap or click the highlight. Its thread is selected in the panel.
4. A link to another site opens in a new tab, and the document stays.
5. **Edit**, type a word: the toolbar says `Saved` within a few seconds, and the draft holds the word.
6. Known and accepted: arrow keys pressed after clicking inside a deck's slide do nothing until you click outside it.

The same steps can be driven from a script with the system WebKit: a `WKWebView` signed in through the sign-in form, the gestures replaced by the parent selecting, focusing and clicking inside the frame. That is how 0.26.2 was checked, and it found every step above but one: a link clicked from script opened no tab, because a click from script is not a user's gesture, so step 4 with a real tap is checked by hand on a phone. It has no committed harness yet.

### 19 · On a phone, in Safari

`a28-phone-layout` measures fourteen sizes in Chromium. What only WebKit can tell you is below, on an iOS Simulator with Safari (`xcodebuild -downloadPlatform iOS`) or an iPhone, in portrait and then on its side. The Simulator shares this machine's network, so `http://127.0.0.1:<hosting port>` reaches a kept stack. Realistic flicks need real gestures: an XCUITest driving `XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")` with `swipeUp(velocity: .fast)` produces them, in a throwaway project in a scratch directory.

1. A long untrusted document: about 105 px of bars, the title and the menu button in the first row.
2. Flick down: the bars go and the page keeps moving. Flick up: they come back. Nudge at the very bottom: nothing flickers.
3. Press and hold a word: the buttons dock at the bottom. Drag the handles: nothing moves under them.
4. Comment and reply: the page does not zoom, and the box stays visible above the keyboard.
5. Suggest edit: the form is at the top, and Suggest can be reached with the keyboard up.
6. Tap a highlight, then Document: back on the passage.
7. Signed out: select, Comment, Sign in, sign in. You are back on the document, with your thread on the passage.
8. A deck: the slide list starts closed, Slides opens it, a tap beside it closes it, and the bars never hide.
9. A short document: the bars stay. Then Everything, Folders, pick a folder: the drawer closes.
10. Share, Trash, Account: nothing cut off.
11. A comment posted with a token: tap `agent`. A toast says what it came through, and the thread stays as it was.


## Automated: `npm run test:e2e`

The suite in `e2e/` runs most of this walkthrough by itself. It builds a copy of the product from the tree and starts it on its own ports, with its own emulators, a local Mailpit for mail and its own `functions/.env.local`. It builds the app from `app/.env.example` with the copy's own origin, so none of "Running it" applies to it and nothing in it can reach a deployment. It is **opt-in**, and neither `npm run verify` nor CI runs it. One run takes minutes and gigabytes, and it needs Java, Mailpit and system Chrome on the machine. Its concurrency tier is a measurement that wants the machine to itself. [`e2e/README.md`](../../e2e/README.md) is the full guide.

```bash
npm run test:e2e -- --self-test          # the harness's own tests, no stack
npm run test:e2e -- run --suite smoke    # a stack from HEAD, canaries, a functional smoke, stack down
npm run test:e2e -- stack up --tree worktree                       # keep a stack; prints its runId
npm run test:e2e -- run --attach <runId> --suite functional        # every functional spec against it
```

Specs are under `e2e/specs/`; the `A` cases are `functional/`, the `C` cases `concurrency/`.

| # | Specs | Cases | What runs by itself | Still by hand |
|---|---|---|---|---|
| 1 | a12-versions, a20-mcp, a20-cli | A12.1, A20.2 `update_document`, A20.7e, A20.7s | identical bytes mint nothing on `/publish?update=`, `update_document`, an editor's commit and `publish --watch` | the operator script's `NO-OP` line |
| 2 | a10-markdown | A10.2 | `format`, `entry`, `sourceEntry`, `rendererVersion`; both files stored and zipped | the operator script's actor, `uid: null, channel: "cli"` |
| 3 | a02-matrix-http | A2.X, A2.AN | a stranger's and an anonymous 404 are byte-equal to an absent id's: status, body and headers | — |
| 4 | a03-visibility, a02-matrix-http, a18-stats | A3.1–A3.7, A3.9, A2.LK, A2.LKw, A18.5 | every proxy, `/unlock` and `/d` row; private and absent byte-identical; the `public/{id}` keys; link grants and rotation; `POST /view` without the token | production's own headers (below) |
| 5 | a05-reading-trust, a15-forks | A5.1, A5.8, A15.2 | the three trust rows; a fork resets `trusted`; the plain address locked for everyone, the run address unlocked only for the reader who consented, a worker's fetch refused | — (A5.1 uploads the samples rather than forking them) |
| 6 | a05-reading-trust | A5.7 | `elementId: "s5-sections"`, the highlight redrawn, both ancestors open, the other eight closed | — |
| 7 | a09-editing | A9.7, A9.11 | the commit refused with its reason; every v1 and v2 count; no duplicate id; `#dot-nav` empty in the bytes and filled when read; v2 clean and its hash right | — |
| 8 | a10-markdown | A10.1, A10.5 | the disabled controls and their tooltip; the format-aware download menu | — |
| 9 | a10-markdown | A10.3, A10.4 | the diff is the edit plus normalisation, comments and SPDX kept; a no-op commit is `deduped: true` | — |
| 10 | a20-mcp, a06-comments, a18-stats, a19-account | A20.1, A20.2, A6.1, A6.9, A18.3, A19.5 | 36 tools; each thread's quote; the agent's thread highlighted in the viewer; `via` mcp beside web; Markdown source from `get_document`; `apiReads` with `ms: 0`, the human stats untouched | — |
| 11 | a15-forks | A15.1, A15.1b, A15.2, A15.3, A15.3b | signed-out Fork → sign-in → one fork; the record and the server-only `forks/{id}`; two hops, `changed`, the walk stopping at a hidden parent | the Fork chip, the "Forked from" panel, the dot and the card's count (lineage is checked through its API) |
| 12 | a16-decks, a14-workspace, a02-matrix-http | A16.4, A16.5, A14.6 | cover then slides, once each; the `thumb` record, `updatedAt` untouched; the rail as `<img src="/thumb/…">`; a viewer posts nothing; a non-member's 404; the workspace's own covers | each slide's final state, and the reload served from the browser's cache (only the `immutable` header is checked) |
| 13 | a07-suggestions, a08-review, a24-responsive-a11y | A7.1, A7.2, A7.4, A8.1–A8.3, A8.9, A24.2c, A24.2d | Suggest refused across paragraphs; `409` with `pendingSuggestions`; the highlight API with no mutation; `claim` → `POST /draft` → `accept`; the reject note; the co-editor sees the change once; clean committed bytes; the keyboard walk | the struck text and inline replacement redrawn after an Edit |
| 14 | a20-mcp, a22-oauth, a20-cli, a19-account | A20.4, A22.1, A22.2, A22.6, A22.7, A20.7p, A19.6 | the `401` challenge with `no-store`; the issuer equal to `authorization_servers[0]`; registration, consent, 36 tools; Revoke → `invalid_token`; CLI login; a skill zip holding `<name>/SKILL.md` alone | the MCP Inspector itself (a scripted OAuth client stands in), and the CLI's own browser (stubbed) |
| 15 | a20-cli, a20-mcp, c06-leave-commit, c12-agent-vs-editors | A20.7h, A20.7i, A20.7k, A20.2 `commit_draft`, C11, C12d | accept, reject and commit from the CLI, with only the commit minting; the resolve and reopen notes; an agent's accept and commit refused while an editor is open | the CLI's own wording of that refusal |
| 16 | a21-changes, a20-mcp, a20-cli | A21.1–A21.3, A20.2 `get_changes`, A20.7j | the three events once each, in order; a quiet cursor comes back unchanged; `access.changed` reaches editors only | Eventarc on a real deployment |
| 17 | c12-agent-vs-editors, a12-versions, a20-cli | C12a–C12c, A12.5, A12.6, A20.7e | an update refused `409` naming the editors and leaving draft and log alone; an update dropping both, the next editor seeing the new version; `publishedVia: "upload"`; a stale base; identical bytes | **the whole dialog**: Upload a new version…, its toast, dropping onto an open document, "vN was published while this was open", the editors it names, "No changes", the card's entry |
| 18 | a25-folder-links | A25.1–A25.4 | a folder's key opens a private document two levels down to read: `/unlock` in both forms, keyed bytes `public, max-age=300` and noindex, the folder's `/folder/**` shell named; every refusal one empty 404 or the generic no-store shell; no grant and no write for a signed-in stranger, over HTTP or MCP; rotation, a document moved out, a folder's date ending its link and nothing else; the signed-out walk, with no comments offered | the Share dialog's folder section, and production's own headers on `/folder/**` and keyed `/content/**` |
| 19 | a01-identity | A1.10 | an account Google renamed, over the Auth emulator's Google sign-in: the old address still in Firebase's token, `moving` with no cookie, the `moveAccount` job `done`, the next Google sign-in the new address, which reads what was shared with it and shares its own document; its ACL log says `address-moved`; the old address's `__session` and personal token refused | the browser's "Moving your account to …" screen and the drift notice (unit-tested in `app/src/auth.test.tsx`), a real Google token's signature (unit-tested in `functions/test/accountmove.test.js`), and a real account's move in production |
| 20 | a26-trash, a14-workspace | A26.1–A26.5, A14.5, A14.5b | a trashed document refused as an absent id to a viewer, its key, a link grant, a folder's link, MCP and a direct Firestore read, and every one open again on Restore; every write refused with the Trash's 409, the owner's too; a team change while it is trashed handing it to nobody; the owner's banner with Restore and no Edit; another owner's document in a trashed folder restored at their own root; Move to Trash with Undo, a folder's question, and Trash restoring a whole subtree | how the Trash page reads on a phone, and Undo reached from a screen reader |
| 21 | a27-purge | A27.1–A27.5 | the emailed code deleting a trashed document forever: a tombstone with only `purgedAt`, no version, no log entry written after, no object under `docs/{id}/`, its link the absent id's 404, its id never given again; a CLI and an MCP token refused; five wrong codes burning the code; a folder's early purge leaving another owner's document in their Trash, restored at their root; email off refusing with its reason and sending nothing; the Trash page's day, dialog and code | the daily job, which the Functions emulator loads and never runs (purge.test.js calls it as a library); the deploy's Cloud Scheduler role, which only a real deploy can show |
| 22 | a28-phone-layout | A28.0–A28.19 | fourteen sizes, every surface: no sideways scroll, overlap, clipped control, squeezed icon, cut word or target under 44 px, and no text field under 16 px on touch; two rows of bars, gone on the way down and back on the way up; a comment started signed out on its passage after signing in; a deck and the folder drawer out of the way | what WebKit alone decides: momentum, the keyboard, selection handles |

**What stays by hand, and why.**

- **The upload dialog (17).** It arrived in 0.16.0, after the specs were written. The specs send its request raw, so the server's answers are covered, but no spec opens the dialog.
- **Third-party and system UI (14).** The MCP Inspector, and the browser `bikeshed login` opens, are other people's programs. The specs drive the same protocol with a scripted client and a stubbed opener.
- **The operator scripts' own output (1, 2).** The specs publish over HTTP, MCP and the CLI. The operator script runs once, in the smoke tier, so its console line and its account-less actor are read only here.
- **What only a deployment shows.** Eventarc invoking the triggers and retrying them (16), the runtime account's access to the Realtime Database (15, 17), and real Hosting's caching are production properties. The emulator cannot show them (CLAUDE.md), and the suite's production tier is refused in this build.
- **Pixels and a few UI words (11, 12, 13).** Where a step is judged by eye, the specs check the record or the API behind it instead.

A case tagged `defect:` reports TODO, not a pass. It is a known product defect, or a SPEC question under triage, and some rows above contain one. A green `run` therefore does not say every row holds. **Known weaknesses** in `e2e/README.md` says how to read those cases. It also lists the cases that need a specially built stack, and the gaps in the functional specs that were deliberately left open.

## What this walkthrough found

Four defects, none of which the 344 unit and rules tests could have caught, because each needed a real runtime:

| | Found because |
|---|---|
| `admin.firestore.FieldValue` is `undefined` inside the Functions emulator, so every write that stamps a timestamp threw | the unit tests call these modules in a plain Node process, where the emulator's proxy does not exist |
| the peer-presence overlay survived into edit mode | the invariant harness mirrored a hook declaration order it did not contain |
| `list_documents` reported `format: "html"` for every document | `format` lives on the version; nothing read it from a real one |
| editing a Markdown document deleted every HTML comment in it | turndown never visits comment nodes, and no fixture had a comment |

The peer-overlay one is worth dwelling on: it was caught by the project's own dev-only assertion, which crashed the viewer with an exact diagnosis rather than letting the overlay reach the serializer. That assertion earned its place.
