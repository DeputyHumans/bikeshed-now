# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org/), and — because a document format and a wire format are both public API here — treats the following as breaking:

- the content-hash framing (SPEC §9), because it decides whether a republish deduplicates,
- the MCP protocol version and tool schemas (SPEC §19),
- `docs/architecture/spec.md` section numbers, which are cited from a hundred source files: append, never renumber.

A Markdown renderer bump is **not** breaking, but it is a migration: the rendered bytes are part of the content hash, so every Markdown document's next save mints a new version. `docs/operations/overview.md` says how to plan one.

## Unreleased

### Added

- **The landing page links to its source.** The footer says Bikeshed is self-hosted and Apache-2.0, and until now it gave no way to find the code. It now links to the repository on GitHub, and so does the text a crawler reads in place of the page.

### Fixed

- **Background tabs no longer count as reading.** Every open tab told the server once a minute that it was being read, hidden or not, so Recent said "You read it just now" about documents nobody was looking at, and cleared their "New since you read it". A document now counts as read once it has been on screen for two seconds, and stops counting when its tab is hidden or has gone five minutes without a scroll, click or key. A document on screen beside another window still counts. A tab opened in the background and never shown is no longer a view, so "Last read by anyone" and view counts follow the same rule. Tabs already open stop lifting their documents as soon as the server has this release, without a reload.
- **The end-to-end check that a viewer never sees someone's draft works again.** A9.5 expected the version chip to read exactly `v1`, and the chip has also shown reading time since October, so the case failed for everyone without saying anything about drafts. It now accepts the reading time and still fails on the word draft, which a new control proves.

## 0.34.0 — 2026-11-04

### Added

- **A document gets the screen on a phone.** The bars above it took 176 px of an iPhone Pro's 714, and about 240 with an expiry. They are two rows now, about 105 px, with the app header folded into them, and they leave while you scroll down and come back when you scroll up. Decks, short documents, the comments pane and editing keep them, and someone else in the document adds a row for as long as they stay. A flick keeps its momentum across the resize, measured in iOS Safari.
- **A comment started signed out now survives signing in.** The panel always said "Your selection is kept", and it never was: signing in left the page and landed on the workspace. The passage is kept in the tab, never the URL, and you come back to the document with your thread on it.
- **`/robots.txt`, and the front page in the sitemap.** `/robots.txt` was answered with the app's HTML, so crawlers got no rules at all, and `/sitemap.xml` listed only documents. Now there is a real file, static so that a function being down cannot stop a site being crawled, with one group for every bot: everything public is open, and signed-in pages, earlier versions, downloads and one-time email links are asked to be left alone. The sitemap also lists `/`, `/terms` and `/privacy`.
- **Authors are told that AI crawlers may read a public document, and may train on it.** With no working `robots.txt` every crawler was already allowed, and the terms and the Share dialog mentioned only search engines. Both now say so, as does the guide, and the terms are dated 4 November 2026.
- **A crawler that runs no JavaScript can read Bikeshed.** `/` held a spinner and `/d/<id>` loaded its document into a frame, so most AI crawlers found a title and a description and nothing else. The landing page's sentences and links now sit in the HTML, and a public document's shell carries its words, so a citation lands in the viewer. Readers see no difference: the stylesheet hides this text and the app replaces it. Unlisted documents, earlier versions and private documents carry none of it.

### Changed

- **Work done outside the browser now says `agent`.** Cards, lists, Details, Activity, comments and decided suggestions spelled out the credential, as in "via CLI on mbp", and cut it off where it did not fit. They now show a small robot and the word `agent`. Hover for the exact words, or tap it or press Enter to see them as a toast, because a phone has no hover. Email, the CLI and the `via` field in MCP and API answers still give the words in full.
- **On a phone the header is the wordmark and one menu**, which holds your address, Account, Docs and Sign out, or Docs and Sign in. It only shrank at 400 px, and an iPhone Pro is 402.
- **A deck opens on its slide on a phone.** The slide list used to start open, covering it. Picking a slide or tapping beside the list closes it, and so does going to a folder from the folder list.
- **The suggestion form opens at the top on a touch screen**, because the iOS keyboard opens over the bottom of the page without moving it. The form and the docked selection buttons also lie above the consent card now.
- **Details says when a document expires**, because a phone's toolbar has no room for the chip.

### Fixed

- **Dismiss no longer runs into the edge of a toast on a touch screen.** A long message squeezed the button until the word spilled out of it, and the word now keeps a little more room on its left too.
- **The wordmark no longer lies over the links beside it, and the logo no longer disappears.** A row short of room took its width out of icons first, down to nothing, and on touch screens the link's underline reached the wordmark. Icons keep their size in a row everywhere now.
- **iOS no longer zooms the page when you tap a text field.** Fields were under the 16 px where it does; on touch screens they are 16 px now, and pinch zoom still works.
- **A link no longer loses letters with no sign of it on a touch screen**: "Everything" read "Everythi". Cut links now end in an ellipsis, and a breadcrumb's first folder stays whole.
- **Closing the comments panel on a phone no longer leaves a blank screen.** The close button is gone in one column, where the Document half of the toggle already does it.
- **A long ⋮ menu stays on the screen and scrolls inside itself**, a tap on the document closes it, and a menu in the header no longer opens lower by however far the page has scrolled.
- **No blue box round the document after touching it.** A finger in the document focuses its frame, which drew the keyboard focus ring round the page. On a touch screen only a Tab draws it now.
- **Tapping a thread and then Document lands on its passage.** The jump was being used up while the frame was hidden.
- **The guides no longer break lines well short of their column.** Text in `/docs` and `/docs/developers` was capped at 34 to 64 characters wide inside a wider column, so it stopped short of the panels beside it and left stray last words on their own line. It now wraps against the column, which makes lines longer on a wide screen. The four paragraphs still hard-wrapped in the guides' source are one line each, which changes nothing a reader sees.
- **A slide title keeps the words either side of a line break apart.** A heading set on two lines with `<br>` ran together in the slide list, the overview and their screen-reader labels, as in "Protection becomesdisconnection."

## 0.33.2 — 2026-11-04

### Deploying

- **A push that changes nothing production serves no longer deploys.** CI still runs on it, because the secret scan and the guards that read the spec cover documents too, but the deploy and its outcome report are skipped. The comparison is with the last commit that deployed rather than the previous push, so code from a failed, paused or replaced run still ships with the next push. `gh workflow run deploy.yml --ref main` always deploys.

### Changed

- **Markdown prose is no longer hard-wrapped.** Most documents here were wrapped at about 78 columns while newer text was not, so some files mixed the two. A paragraph or a list item is now one line in 57 documents and the copies generated from them, including `/llms.txt` and the served skills. No words changed, and each document renders as it did. `CONTRIBUTING.md` and `CLAUDE.md` state the rule. `docs/acf/` follows its upstream, and the Markdown test fixtures and `content/markdown-reference` stay wrapped because they exercise the join.

## 0.33.1 — 2026-11-04

### Security

- **A Markdown upload can no longer hold a function.** Any signed-up account can upload Markdown, and it is rendered inside the request. markdown-it 14.1.0 took time that grew with the square of the input on unclosed inline HTML: 469 KB of unclosed declarations took 13.8 s, and the upload limit is 25 MB. It takes 28 ms on 14.3.3, and a test now holds that.
- **Advisories left open, and why.** After this release `npm audit --omit=dev` reports no high advisory in the functions. It still lists `uuid` (needs firebase-admin 14) and `deepmerge`, `glob`, `minimatch` and `prismjs` (through `@react-email/*` and `resend`, which render only our own templates and load only to send mail). In the app it lists `undici` and `@grpc/grpc-js`, which are not in the browser bundle, and `react-router`, whose backslash redirect `safeNext` already refuses and whose hydration advisory needs server rendering, which this app does not do. The major upgrades that clear them are their own project.

### Deploying

- **markdown-it 14.3.3 is a renderer migration, and a small one.** It is not a breaking change, and existing versions are untouched. A Markdown document mints a new version on its next save only if its rendered bytes change, which takes one of these: an HTML comment spanning a blank line inside a list; a backslash and a space at the end of a line; `*` or `**` around an emoji or other astral character with a letter directly after the closing marker, which stays literal; a non-breaking or other Unicode space at the start or end of a heading or paragraph, which is now kept; a reference label over 999 characters, which stops being a link. Everything else renders byte for byte as before, including all 78 Markdown files in this repository and all 652 CommonMark specification examples.

### Changed

- **The ACF files are Apache-2.0 now.** `docs/acf/**` and `.claude/scripts/status-line.py` are copies of [ACF Tools](https://github.com/fib7/acf-tools) files, which Fibonacci Seven relicensed under Apache-2.0 on 2026-10-28. `NOTICE`, `README.md` and `THIRD_PARTY_LICENSES.md` stop calling them proprietary, `NOTICE` maps each copy to its upstream file, and `docs/acf/organization.md` says in its first line that it differs from upstream. The copies take the plugins' current versions, and the project settings no longer name the status line, which the plugin now provides.
- **Every GitHub Action is pinned to a commit.** CI, deployment and operations name each action by full SHA with its version in a comment, so a moved tag cannot change what runs with the production credential. `upload-artifact` moves to v7 in the same change. The rules job installs the Firebase CLI at the version deployment already pins, 15.25.1, instead of whatever is newest.
- **`CONTRIBUTING.md` states what CI enforces.** The attribution-trailer rule, the binary allowlist and the changelog entry were only in the agent instructions, so a contributor learned them from a red check. The quickstart blocks also gain the step that points the app at the emulators, and the app row of the verification table now runs the coverage it claims to measure.
- **The documentation says what is true again.** The ADR count, the deletion claim in the README, the walkthrough and prerequisite counts, and the CLI publishing guide, which was still written as if the package were unpublished. `docs/operations/config.md` now lists the seven settings it left out, and `docs/operations/overview.md` names the three repository secrets it left out, without which the `report` job fails on every push.
- **A security report can go through GitHub privately**, as well as by email. `SECURITY.md` asks researchers to test their own copy rather than `bikeshed.now`, and names what is supported, including the CLI. The Code of Conduct gives a route for a report about a maintainer.

### Fixed

- **Patched dependencies in the functions.** `node-forge`, `@grpc/grpc-js`, `body-parser` and `qs` move to fixed versions in the lockfile, with no change to `package.json`.
- **`adm-zip` 0.6.1 and `cookie` 0.7.2.** The upload path only reads entries into memory and already refused a spoofed entry size, so none of the `adm-zip` advisories was reachable through it, but it no longer depends on that reasoning. The cookie fix rejects out-of-range names and attributes.
- **Deployment logs no longer name each function's direct address.** `firebase deploy` prints the Cloud Run address of every HTTPS function, and run logs are public in a public repository. `deploy.yml` and `operations.yml` now mask the host suffix those addresses share. A run that cannot read the suffix says so in a warning.

## 0.33.0 — 2026-11-03

### Added

- **Signing in opens Recent.** The documents you read and every new version of a document you can read, from the last 30 days, in one list, newest first. Each row says why it is there ("You read it 2h ago", "New version 2h ago by …") and is marked "New since you read it" when someone else published after your last read. Three quick filters, Opened by me, Shared with me and New since I read, combine and are remembered. If your reads cannot be fetched, as for the minutes after a deploy while the new index builds, Recent lists new versions only and says so. Everything, the top of the folder tree, moves to `/everything` (SPEC §13 "Recent", ADR 0027).
- **Shared with me** in the rail lists every document someone else owns, from every folder, including one shared with you inside a folder you were not given, which until now no page listed.
- **The workspace has a list.** A switch beside the sort shows folders and documents as rows instead of cards: a small cover, the title and its chips, the owner, the last update, the reads and the menu. The Name, Updated and Reads headers sort, and a folder row takes a dropped file into that folder as its card does. On a phone each row is the cover, the title and one line. Cards stay the default on Everything and in folders (SPEC §13 "Grid and list").
- **Search results say where each document is filed**, on a card and in a row: "Everything", the folder's path, or "A folder you can't open" for one shared with you without its folder.
- **The workspace remembers how you left it.** The sort and the layout survive opening a document and coming back, in this browser's own storage, which never leaves it. The privacy policy says so.

### Changed

- The sort called "Recently read" is now "Last read by anyone", which is what it always sorted by.
- **A signed-in person can list their own reading across documents.** The security rules let a verified account list its own per-person read rows (`docs/{docId}/viewers/{uid}`), newest first, from a new collection-group index, and nobody else's. Getting a single row stays the document's editors' alone. Nothing new is written: the rows are the ones every read already keeps. A row outlives access to its document and says only what its reader saw. `tools/viewers-collection.test.mjs` pins the rule's one assumption, that `viewers` names one collection (ADR 0027, SPEC §5 "Your own reading").

### Fixed

- Pin CI, deployment and operations jobs to `ubuntu-26.04` so GitHub Actions no longer emits the `ubuntu-latest` migration warning (SPEC §12).

## 0.32.0 — 2026-11-03

### Security

- **A document's XML files no longer run script on this origin.** The script lock (SPEC §2, ADR 0021) named five types to lock. WebKit, which is Safari and every browser on iOS, also renders `.atom` and `.rss` as XML documents, where an element in the XHTML namespace runs, so a bundle's feed opened by its `/content/…` address ran as whoever opened the link, with that person's session: any account could upload one to a public document and send the link. About a hundred more `+xml` types were left unlocked too. Every content and draft response is now locked unless its type is on a short list of types that are never a scripted document (pictures, sound, video, fonts, CSS, JavaScript, JSON, text, PDF), so a type nobody listed is locked too.
- **Trust runs the current version only.** A document's script runs for a superadmin's trust or a reader's own consent, and both are withdrawn when someone else's version becomes current. But the run variant never looked at the version, so trusting the head again also ran every older version, an editor's hostile one included, opened at `/content/!run/{doc}/{older}/` or `/d/{doc}/{older}`. The server and the viewer now run only the head (SPEC §6c).
- **Trust never carries into a new version, the owner's own commit included.** The owner's commit in the app kept both trust scopes, but a draft is shared: an editor, or any account on a public document open to editing, could put a `<script>` in it through `/draft` or the live merge, and the owner's commit then ran it in every trusting reader's session. Every new version now withdraws both scopes. A trusted interactive document has to be trusted again after each edit (SPEC §6c).
- **A token can no longer lift a document's sandbox for everyone.** `POST /trust` accepted a superadmin's personal access token, so an agent acting on text it was given could run a document's code for every reader. Lifting it now takes the browser's session, as deleting forever does; a token may still put the sandbox back (SPEC §2, §6c).
- **Verification codes are limited per address, not only per account.** Each account could ask for a new code every minute, each with five fresh guesses, so enough throwaway accounts could guess their way into an address that had documents shared with it before its owner signed up. An address is now sent at most five codes a day, whoever asks (SPEC §14).
- **Only a document's owner can move it, and only a folder's owner can move the folder.** Moving into a folder shares a document with that folder's readers, and its link and public level reach it, but any editor could move a document and any folder editor could move a folder. So an editor could file the owner's private document into a folder of their own, share or publish that folder, and became an approver of the document besides. `POST /organize`, `move_document` and `move_folder` now take the owner, and the workspace menus disable Move for anyone else, saying why (SPEC §13, ADR 0017).

- **Exchanging an authorization code requires `client_id` and `redirect_uri`.** `/oauth/token` compared them only when they were sent; PKCE still bound the code to its verifier, but the code should also name the app and address it was issued for, as OAuth requires. Both are now required and a missing one is `invalid_request`. The command line has always sent both (SPEC §23).

- **A `.zip` may hold at most 2,000 files.** The only limit was 25 MB of bytes, so one upload of tiny files could cost millions of Storage writes. The count is checked before anything is decompressed (`docs/development/authoring-bundles.md`).

- **Only somebody in a team can share with it.** Granting a team by its id worked for anyone, and it emails every member an invitation and answers with the roster, so a stranger who learned a team's id could read who is in it and mail them all under a title of their choosing. Adding a team now takes being in it; a team already granted can still change role or be removed (SPEC §18).

- **A destination folder you cannot read is "not found".** Publishing, forking, creating a folder or moving into a folder of somebody else's answered 403, and an id that does not exist 404, so comparing the two confirmed that a folder id was taken. Both are now 404; 403 is kept for a folder you can read but not edit (SPEC §1.4b).

- **The command line's saved sign-in is created readable only by you.** `~/.config/bikeshed/config.json` holds a personal access token, and it was written with the default permissions and narrowed afterwards, which left a moment in which another account on the machine could read it. It is now created owner-only, in a folder only you can open (bikeshed-now 0.21.1).

- **An organisation's issuer is trusted only for the address domains listed beside it.** A trusted issuer (0.31.0) could connect any account here by asserting its address, an administrator's included, so one leaked signing key reached every account. `BIKESHED_ID_JAG_DOMAINS` now lists the domains it may vouch for, an assertion's address must be at one of them exactly, and an `email_verified` the issuer sends must be true. The variable is required: issuers without domains leave the grant off and unadvertised (ADR 0026, SPEC §23, `docs/operations/overview.md`).

- **Revoking an organisation's connection stops it connecting any app for you.** The veto, and the issuer's pinned id for the person, were kept per app, so an organisation could undo a member's Revoke, or connect an address given to someone else, by naming another app. Both now hold for every app that issuer names for that person and address; an account move still starts fresh (ADR 0026, SPEC §23).

### Breaking

- **A deployment that trusts an organisation's issuer must also set `BIKESHED_ID_JAG_DOMAINS`**, or the managed connection is off after this release.
- **Editors can no longer move documents or folders they do not own**, through the browser, the CLI or an agent. They can still rename them. An agent's `move_document` or `move_folder` on someone else's item now fails with "only its owner can move…".

## 0.31.1 — 2026-11-03

### Changed

- **Trusting an organisation's issuer is documented with examples.** `functions/.env.example` shows what `BIKESHED_ID_JAG_ISSUERS` looks like for a Claude workspace and points to the walkthrough. `docs/operations/overview.md` now covers setting the variable and the secret it is deployed from, checking the metadata (with the expected output), reading the `id-jag` log lines, and a table of what Claude is told when Test connection fails, with the cause and the fix for each. SPEC §23 shows an exchange end to end (ADR 0026).

## 0.31.0 — 2026-11-03

### Added

- **An organisation can connect Claude for its people.** Claude's admin settings offer "managed authorization": Claude signs an identity assertion for each member and presents it to the token endpoint, so nobody sees a consent page. A deployment that lists the organisation's issuer in `BIKESHED_ID_JAG_ISSUERS` now accepts it, through the jwt-bearer grant with an ID-JAG (the MCP extension `io.modelcontextprotocol/enterprise-managed-authorization`). The grant and `authorization_grant_profiles_supported` appear in the metadata only then. Unset, nothing changes (ADR 0026, SPEC §23 "Connected by an organisation").
- The assertion must come from a configured issuer, be signed with one of its ES256 keys, be addressed to this server, expire within ten minutes and be used once; a retry within a minute gets back the same token. It connects an account that already exists under the same address and passes the usual gate; it never creates one. Each assertion gets its own access token of an hour, stored only as a hash, and no refresh token.
- The account screen says when your organisation connected an app. Revoking that connection is permanent for that app, and you can still connect it yourself. If the organisation's issuer later names a different person for the same address, it is refused.
- `check:secrets` refuses the shape of an issuer id, because an issuer URL names the organisation.

## 0.30.1 — 2026-11-02

### Fixed

- **The people in a document show their whole names, and the bar beside the title no longer scrolls.** A name longer than 12 characters wrapped inside its one-line chip and was cut off top and bottom, and the bar grew a scrollbar for it. Now every chip shows the full name on one line, as many chips as fit are shown, and the rest fold into a "+N" button that lists them and follows whoever you pick. On a phone, a document with several people no longer pushes Edit and Comments off the screen (S29) (SPEC §16).

## 0.30.0 — 2026-10-30

### Added

- **The Trash empties itself.** Whatever has been in it for 30 days is deleted forever, with its versions, comments and files, by one job that runs once a day (`purgeExpiredTrash`, the only scheduled one; ADR 0025). Each row in the Trash says the day it goes, and `list_trash` and `bikeshed trash` (bikeshed-now 0.21.0) give `deletesAt`.
- **Delete forever, and Empty trash.** From the Trash in the browser, an owner can delete one item or everything sooner with a six-digit code emailed to their address: for exactly that, valid ten minutes, used once, burned by five wrong guesses. Deleting a folder this way takes only what is yours in it; other people's documents stay in their Trash for their own 30 days. Where the deployment's email is off there is no early deletion and the Trash says it empties itself. `GET /purge` says which; `POST /purge` refuses every token, so no agent can do it (SPEC §4 "Deleted forever").
- A deleted document leaves a tombstone that keeps its id, so a link, a fork or a saved cursor that named it finds nothing rather than the next document with that title. A fork whose original was deleted says so, in the panel and as `get_lineage`'s `moreWasDeleted`, and a deleted fork takes itself off its original's count.

### Changed

- The terms' "Ending it" says what deleting now means, and when deleted documents are gone.
- `delete-version.mjs` says the only version of a document is deleted by moving the document to the Trash, and its usage no longer claims seven refusals: three overrides lift one each, two leave something in place.
- Teardown also deletes verification and purge codes, account moves, OAuth codes and the live-editing mirror.

### Deploying

- **Enable the Cloud Scheduler API and grant the deployer `roles/cloudscheduler.admin` before this deploys.** A scheduled function is a Cloud Scheduler job, and the deploy fails without both (docs/operations/overview.md).

## 0.29.1 — 2026-10-30

### Security

- **An account could prove an address it did not own.** `POST /verify/start` kept the code's hash on the account's own record, `users/{uid}`, which that account may read. A six-digit code's hash falls to a million offline guesses in under a second, and the five-guess limit only counts guesses the server sees. So an account could ask for a code for someone else's address, read the hash, find the code and complete on its first try, taking every share waiting for that address wherever no account held it yet. The challenge now lives in `verifications/{uid}`, which no client can read. A code asked for before this release can no longer be completed; ask for a new one. The old field is cleared when a verification completes or an account moves (SPEC §4, §14; threat model).

## 0.29.0 — 2026-10-30

### Changed

- Deleting a folder moves it to the Trash with everything in it, other people's documents included, instead of moving its contents up a level. `delete_folder` and the CLI's `delete-folder` do the same. Nothing is deleted. ([ADR 0024](docs/architecture/adr/0024-deletion-goes-through-a-trash.md))
- An app's consent screen says it can move documents and folders you own to the Trash and restore them, and that it cannot delete anything permanently, in place of deleting folders while keeping their contents.
- A toast with an action, Undo above all, stays ten seconds instead of four, long enough to reach from the keyboard or a screen reader; one without an action still fades after four.

### Added

- The Trash. A document's owner moves it there with **Move to Trash**, in its ⋮ menu or the viewer's More menu, and a folder's owner moves a folder there with everything in it; a toast offers Undo. In the Trash an item is its owner's alone and read-only: its link, a folder's link, its public page, open editing and every grant stop working, and it cannot be shared, renamed or moved. **Trash**, at the foot of the folder list, shows what is there, where each item came from, and Restore, which gives every grant back and puts it where it was, or at its owner's root if that folder is gone. An owner who opens a trashed document reads it under a banner with Restore. Each owner restores their own documents from someone else's trashed folder. `POST /organize` takes `trash` and `restore` for both kinds. Nothing is deleted yet; permanent deletion comes in a later release.
- Agents and the CLI work the Trash too: `trash_document`, `restore_from_trash` (with `kind`) and `list_trash`, which make thirty-six MCP tools, and `bikeshed trash [folder] <id>`, `bikeshed restore [folder] <id>` and bare `bikeshed trash` to list it, in bikeshed-now 0.20.0. `list_documents` and `list_folders`, and so `bikeshed list`, leave what is in the Trash out. No tool and no command deletes anything permanently.

## 0.28.0 — 2026-10-29

### Changed

- A card's "Updated" and the workspace's "Recently updated" order follow the current version's publish, not any change to the record. Renaming, re-sharing, trusting or moving a document used to make it look freshly updated.
- The Activity tile "time reading" is now "time spent reading", so it is not read as how long the document takes.

### Added

- Every card says how long its document takes to read and when it was last updated, and through what when that was not a person in the browser: "6 min read · Updated 2 h ago · via CLI on mbp". Reading time is the words of the current version at 238 a minute, rounded up.
- The viewer's version chip reads "v7 · 6 min" and opens **Details**: how long the document is (reading time, words, slides), when it was created and by whom, when it was last updated, by whom and through what, any unpublished draft, and every version with how it arrived and who published it. Also under More, as "Details…". A reader without a membership sees the length and when it was updated, never by whom.
- Each version records its word count, counted once on the server from its entry document (text a person reads, not scripts, styles or the title), and the document carries `latest`, a summary of its current version, which the version trigger keeps. The public mirror carries the count and the time, never who.
- `scripts/summarize-documents.mjs` asks the trigger to count and summarize documents written before this release; idempotent, with `--dry-run`.

### Fixed

- The "via" badge beside anything automation did is no longer upper-cased. Since 0.27.0 it quotes a token's or an app's name as its owner wrote it, and capitals misquoted it ("DEPLOY-BOT" for “deploy-bot”). A long name is cut short on one line, and the badge's tooltip has it whole.
- On a phone, Details puts who published each version on a line of its own, instead of four squeezed columns.

## 0.27.0 — 2026-10-29

### Changed

- Attribution names the credential, not the endpoint ([ADR 0023](docs/architecture/adr/0023-attribution-names-the-credential.md)). The CLI reads as `cli` on every endpoint, `/mcp` included, where it used to read `mcp`: one person at one terminal no longer produces three different records (`bikeshed publish` read `upload`, `update site.zip` read `cli`, `update notes.md` read `mcp`). An app connected by signing in, such as Claude, now reads as `app` rather than `mcp`. The operator scripts read as `operator`, not `cli`. A personal token minted for MCP or the API still reads `mcp` or `api`. Records written before this release keep what they say.
- Every action records what did it, in words: `via` is stored with the actor when it acts, as `CLI on mbp`, `CLI token “deploy-bot”`, `personal token “laptop agent”`, `“Claude” (connected app)` or `an operator script`. Revoking or renaming a token later never rewrites history. An app's name is its own claim, so it is always quoted and marked as an app.
- **Breaking for agents that read `get_comments`:** a comment's and a suggestion revision's `via` is now those words, absent for a person in the browser, and the kind moved to a new `channel` field. `via` used to hold the channel (`"mcp"`, `"web"`).
- A version records how its content arrived as `origin` (`upload`, `edit` or `fork`), apart from who sent it. `publishedVia` is still written, now derived from `origin` and the channel, so `bikeshed publish` records `cli` like its updates. Every new document and fork counts its first version in "versions published", and so does every operator publish.

### Added

- The Activity panel is one feed, newest first, of everything that happened to the document: every version published (by whom, through what, and whether it was uploaded, edited or forked), comment, suggestion and decision, share, rename, move, visibility, expiry and trust change, and every read. Each row names who acted and, for anything but a person in the browser, what they acted through. People and Automation filter every kind of row, not only reads, and *Show earlier activity* pages back. It used to show reads and access changes only, as two lists, and never who published a version. It is served by `GET /activity`, editors only.
- MCP `list_versions` says how each version arrived (`origin`) and whether a person did it (`automated`), and, for a member, who published it, `channel` and `via`; a link holder is not told who. `get_changes` events carry `id`, `automated`, `via` and, for a publish, `origin`. `bikeshed versions` and `bikeshed changes` print who and through what.
- Comment notification emails say what an automated comment came through in the same words, and a suggestion accepted or declined by an agent says so beside the approver's name.

### Fixed

- An account that moved to a new Google address appeared in Activity as the new address granting itself access. It now reads as the address changing.
- A draft's session log merged two agents of one person, on two tokens, into one entry.
- A version withdrawn by an operator was recorded with nobody behind it. It is now attributed to the operator script.
- A fork's change-log event now names the version that was forked, still never who forked it.
- After an operator withdraws a version, the document's last edited names the version that is current again. It used to be cleared only when the count of published versions reached zero, so withdrawing a later version kept naming its editor.

## 0.26.5 — 2026-10-29

### Fixed

- Avoid repeatedly decompressing the same pinned emulator archive during campaign verification. Reuse only immutable analysis of freshly hash-verified bytes; retain independent proof checks and final artifact verification.

## 0.26.4 — 2026-10-29

### Fixed

- Refresh three live-editing regression patch anchors after the Safari integration and cover all 24 accessibility scenarios in the file budget.

- Preserve the acknowledgement-cleanup negative control beside the new comment retry option.
- Give concurrent comments and suggestions up to ten native Firestore transaction attempts, retaining backoff, atomic writes and acknowledgement receipts.
- Run one complete local C15 email storm per trial instead of repeating an impossible automatic-trigger overlap three times. Keep every participant/trial, ordinary safety assertion, explicit inconclusive result and separate cloud qualification requirement; retain historical three-attempt evidence.

## 0.26.3 — 2026-10-29

### Fixed

- **A document's or folder's ⋮ menu no longer runs off the bottom of the window.** Opened from the last row of a list scrolled to its end, it showed only its first item or two, and scrolling to the rest closed it. It now opens upward when there is no room below, and stays on screen when there is room on neither side (SPEC §13).
- The first time a card's menu was opened in a scrolled list, the page jumped back to the top and the menu closed. It now opens where you clicked.

## 0.26.2 — 2026-10-29

### Fixed

- **Commenting works on an iPhone and in Safari.** Safari's engine, which every iPhone browser uses, never passes the viewer an event from inside a sandboxed document, and most documents are sandboxed. Selecting text there offered no Comment or Suggest edit, tapping a highlight did nothing, links out of the document stayed put, the editor never autosaved, and presence, read tracking and the deck rail stood still. The viewer now asks each document whether it hears it, and where it does not, it watches the selection, scroll and focus instead, learns of typing from the live-editing binding, and points links that leave the document at a new tab (SPEC §6). Arrow keys pressed with focus inside a slide still do nothing there.
- **On a phone, the selection buttons are no longer hidden under the phone's own menu.** On a touch screen they sit at the bottom of the screen, and the suggestion form opens above them (SPEC §7).
- On a phone, the Comments tab of a document with no open comments showed an empty screen. It shows the comments panel and how to start one.

## 0.26.1 — 2026-10-29

### Fixed

- Rebase campaign controls and trust fixtures onto reader-approved script execution, establish touch media before synthetic accessibility checks, and prevent early timers from shortening injected response delays.

- Retain all four resumed-campaign discoveries in the exact identity and claim inventory guard.

- Explicitly settle print comparison frames after removing elements instead of relying on browser-dependent screenshot timing.

- Align the OAuth consent E2E expectation with folder visibility and expiry authority and detect its removal with a dedicated disclosure control.

- Prefer an explicitly configured or installed Playwright-matched browser before system Chrome, avoiding the measured system-browser shutdown delay without skipping browser cleanup or reducing test coverage.

- Apply the explicitly reviewed ten-participant campaign scope to cloud qualification as well as local runs; retain every N2/N5/N10 trial and defer N20 consistently.

- Await shared browser shutdown before E2E maintenance, retain shutdown failures, and stop measuring after an unusable cleanup boundary. Record phase timings, avoid redundant source hashing, and stage patch-test source once while isolating each control without reducing scenarios or trials.
- Align framing checks with shared-folder routing, refresh header controls after the Hosting hotfix, and check successful document bytes and actual viewer rendering.
- Repair duplicated OAuth scenario setup and stale control patches after integration; reject invalid spec syntax before starting emulators.

## 0.26.0 — 2026-10-29

### Security

- **A document's scripts no longer run when its file is opened directly.** The sandbox that kept an untrusted page's scripts off belonged to the viewer's frame, not to the page. The same `/content/…` address pasted into a tab, opened as a popup or embedded with `<object>` ran the page's scripts on this origin, as whoever opened it, able to act for them. Every content and draft response a browser renders as a scripted document now carries the sandbox itself (`Content-Security-Policy: sandbox allow-same-origin`). A page's script runs only at its run address, `/content/[~k/]!run/…`, which the server unlocks only for a reader who chose to run it or a document trusted for everyone. That answer is never cached and only this site may frame it. No page may register a service worker, and a draft never runs its scripts (SPEC §2, §6c; ADR 0021).
- **Only a superadmin may trust a document for everyone.** Doing so lets the page's author act as every reader, and any owner could do it to their own page. Now it takes an owner listed in the deployment's `BIKESHED_SUPERADMINS`, which is never committed. Every reader can still run a page's scripts for themselves. A document with no trust flag is now untrusted, where it used to count as trusted. `scripts/reconcile-trust.mjs` withdraws trust granted under the old rule (docs/operations/overview.md).

## 0.25.0 — 2026-10-29

### Added

- Print from the toolbar. **Print**, just before the More menu, prints the document or saves it as a PDF, stamped with the owner's marking as before; it used to be found only under More → Download. On a phone the toolbar has no room for it, so there it stays in the More menu as *Print or save as PDF*. Cmd/Ctrl+P is unchanged.
- Share and manage a folder from inside it. The open folder's **Share** button (for its owner) and its menu (rename, move, delete) now sit beside its name in the workspace, so changing a folder no longer means going up a level to find its card. Deleting the folder you are in takes you up to where its contents land.

## 0.24.2 — 2026-10-29

### Fixed

- Restore document rendering after the app-shell framing guard also blocked content responses in production Hosting. Use one extglob exclusion group, verified against real Hosting for app, content, draft and thumbnail routes.

## 0.24.1 — 2026-10-29

- Integrate the E2E repairs with folder sharing and account-address migration, preserving transaction-local membership and projection checks. Ship behind bounded release checks; extended campaign work remains explicitly deferred in `docs/development/e2e-release-waves.md`.

- Rebase the verification-mail regression control onto deferred email loading, preserving its suppression of the verification message after a committed reservation.

- Make harness self-tests share the machine-wide test lock, so their browsers cannot enter an exclusive concurrency measurement or prevent its diagnostic cleanup. Retain the lock until the test child closes and forward interruption to its process group.

- Dispatch held publication requests before awaiting their gated responses in E2E races. Preserve natural suggestion-race inconclusives while applying the reviewed same-file safety qualification to the exact C10 pause-point configuration.

- Preserve bounded browser response diagnostics across navigation so local Firestore cleanup can recover completed handshakes without delaying application requests.

- Keep synthetic campaign tests independent of recorded release proofs and source bindings, while preserving all original claims, required cases and historical audit records. Retain the separately verified Hosting 404 boundary in the canonical discovery inventory.

- Correct the delayed Done test to retry explicit safe delivery refusals at any injected latency, retaining all data-integrity checks. Cap this release concurrency qualification at ten participants as requested; retain twenty-participant obligations as deferred coverage.

- Exercise explicit draft reload after a documented stale-snapshot refusal during E2E join admission. Bound recovery before typing, retain version and live epoch, and preserve every convergence and token oracle.

- Let targetless concurrency discovery finish naturally so forced process exit cannot silently truncate the executable case inventory. Pin full declaration drainage with a regression control.

- Confirm idle Firestore cleanup with an ordered read-only subscription barrier, so already-revoked targets cannot stall the next E2E case waiting for a duplicate removal reply.

- Retire observed orphaned Firestore browser subscriptions at the exclusive idle E2E maintenance boundary. Unsubscribe, drain and acknowledge their queues before transport termination, preserving active-case timing, database data, rules and heap limits.

- Archive and recycle Firestore rule-value diagnostics between quiescent exclusive E2E cases. Reapply identical pinned rules and verify their bytes and enforcement, preserving database data and the existing heap ceiling after a ten-editor run exhausted the emulator's heap.

- Preserve actual source fingerprints when a reviewed diagnostics-only harness repair continues an E2E campaign. Qualify narrowly defined browser timing gaps with complete controlled witnesses and regression controls while retaining natural inconclusives and requiring explicit release policy.

- Set MCP transport headers before the managed runtime parses JSON. Real Hosting parser failures bypassed both the handler and configured Hosting headers; malformed requests now retain the non-cacheable response and exposed authentication challenge.

- Support explicitly approved controlled-race release evidence, pinned to reviewed deployed source archives and an actual guard-removal/restoration test, while retaining natural inconclusive outcomes and requiring all local campaign obligations. Preserve verified local-limit and composite qualifications in complete-file partitions.

- Judge cloud notification safety before timing eligibility, so serial delivery cannot hide duplicate notices or cooldown grants behind an inconclusive race classification.

- Check real-cloud notification evidence against automatic trigger identities, deployed function hashes, overlapping cooldown calls on the same instance, committed receipts and captured recipient/kind counts.

- Verify concurrency partitions against executable case, participant and trial inventories, retaining each original completed invocation rather than manufacturing a full-suite result. Reject incomplete partitions and stale source or capability evidence.

- Bound harness self-test file concurrency and use independent user contexts for simultaneous browser actors; retain the measured timing limits and negative controls. Refresh access-race patch context after health integration.

- Collect concurrency partitions on resumable fresh stacks, retaining inconclusive measurements without admitting them as passing matrix evidence.

- Integrate the E2E campaign repairs with production health monitoring and refreshed landing media.

- Recognize the exact concurrent-snapshot draft refusal in the C12 publication race test, retaining all final-state and next-reader checks instead of rejecting safe concurrent saves before those checks run.

- Retry suggestion acceptance when a concurrent save retires the draft object between metadata lookup and download. Read the replacement snapshot without discarding concurrent edits; continue to refuse missing objects whose draft identity has not changed. Refresh the existing misplaced-replacement control for the read helper, and reproduce retirement both before the first save and after a save conflict.
- Repair three integration-stale E2E negative controls: exercise public editing through folder sharing, expect the current 32-tool MCP catalog, and remove reply credentials from the reply handler itself. Each restored control fails its intended assertion and passes against the clean source.

- Preserve an open revision upload and its selected file after edit access is revoked, so the server refusal explains the change without discarding the work. Align CLI pinned-link and MCP required-argument checks with the released history and management contracts.

- Align the browser consent regression with the current owner-management disclosure while retaining exact allowed and excluded capability assertions.

- Keep all 724 negative-control targets selectable after the tool catalog and skill inventory expanded; preserve amplifier composition across the merged sharing and retry paths.

- Preserve current archive read-only behavior in E2E feedback checks, update management fault injection to the shared implementation, and retain all existing control identities through integration.

- Integrate the E2E repairs with the current agent-management and immutable-history features; preserve remembered-link refusals, transaction retry receipts and read-only archives. Replace reaped stack records atomically to prevent concurrent cleanup from corrupting retained evidence.

- Keep the audience self-test adapters synchronized with the explicit hidden trust event used to prove cursor advancement.

- Repair 33 E2E negative controls against current policy generation, live-session guards and assertion messages; independently check SVG namespaces, hidden-event cursors and held claims, drain fork-route cleanup, and flush complete control summaries before worker exit.

- Isolate the phone toolbar negative control from presence-chip clipping so it proves the primary-action reachability assertion directly.

- Keep mobile viewer controls and presence chips reachable by constraining the viewer grid column to the viewport.

- Keep the stale-base commit canary on one saved draft so draft-snapshot protection does not mask the version-minting race it measures.

- Avoid a circular wait in forced first-join E2E scenarios: observe the loaded draft while the join gate holds, then require editable shared state after release.

- Pin the pending-request self-test clock so real timer rounding cannot turn a correctly classified stack timeout into a test failure.

- Release expired E2E stack slots when an unrelated process has reused a recorded group ID; preserve conservative cleanup when process identity is unknown.

- Keep successful skill installation out of every deliberately invalid-name variant, and require only the projection-failure fixture's actual capabilities when importing its evidence.

- Refresh watched-file metadata when a debounced publish starts, preventing a later fallback poll from publishing the same save twice; exercise the delayed-poll ordering in real CLI process tests.

- Extend discovery-retention checks to the watch regression while keeping all original identities, claims and case obligations pinned.

- Track the reproduced watch-delivery regression as an open campaign finding until final frozen acceptance, preserving its native failure and recovery evidence.

- Keep CLI watch mode publishing after missed native file notifications or atomic file replacement. A single-file metadata fallback shares the existing debounce and preserves JSON-only output.

- Check CLI change events in their recorded order rather than assuming thread and comment triggers run in causal order; require wait and resume to deliver both events exactly once.

- Pin the synthetic send interval in the cut-look budget selftest while retaining a real unanswered-read deadline, preventing timer rounding from invalidating its exact retry diagnostic.

- Wait for the saved account preference and checkbox state in the analytics E2E flow, so asynchronous record delivery cannot turn a successful toggle into a false failure.

- Bind the exhausted-budget selftest to an exact observed send interval, so timer rounding cannot invalidate its retry estimate while the no-send and no-look checks remain strict.

- Judge delayed requests against their own route and server clocks, and prove shared delay windows through enrolled requests and an explicit release. Keep synthetic HTTP and MCP cutoff intervals exact so scheduling load cannot change their diagnostics; retain routing, numeric-delay and stall-classification controls.

- Require exact retained RTDB archives, runtime identity, JVM settings, rules and reporter timing for every campaign proof, including composite dependencies and control pairs. Provision the pinned public test archive without a Firebase account or CLI, and keep verification bounded by sharing immutable artifact inspection within each operation.

- Verify the derived Database archive one bounded ZIP member at a time so the full campaign checker fits its unchanged memory limit. Preserve every member digest, CRC, canonical archive bytes and reviewed runtime profile; reject malformed local metadata, oversized output and trailing compressed data.

- Keep the CAS pause patch composable with the existing feedback and minting pauses without changing its resulting code. Load the runtime dependency in isolated capability-parser controls so both admission faults reach their intended assertions.

- Exercise both conditional-draft candidate disposal paths with captured CAS pauses, exact byte preservation and separate product controls. Bind every discovered product defect to its current affected cases while preserving original claims, native ACK obligations and unresolved evidence; extend the existing cleanup finding with the observed CAS draft failures.

- Run local E2E stacks with an explicitly labeled, exact-byte derived Database emulator that synchronizes only diagnostic appends. Keep the installed emulator untouched, preserve ordinary JVM limits and workflow concurrency, and bind each invocation to retained archive attestations plus before/after JVM and rules receipts. Refuse unreviewed toolchains and derived bytes; the standalone rules command remains stock.

- Share immutable campaign evidence reads within each check/import, preserving every proof’s identity checks and detecting changed artifacts without retaining a full report per case.

- Add separate E2E fault controls for duplicated committed suggestion text, missing co-editor delivery and omitted embedded Markdown styling. Keep the existing cases and exact assertions, and include every new control in the complete catalog obligation.

- Remove discarded autosave uploads after conditional-write contention only when a fresh transaction proves neither the draft nor any published version references them. Cover terminal refusals, newer causal drafts, lost acknowledgements and failed reference reads; keep uncertain transport results intact.

- Restore per-callback generated-note allocation in the thread acknowledgement fault control so it reproduces the intended stale-decision overwrite. The former plant hit an immutable-create refusal before changing state; retain that invalid attempt and keep the original later-reopen assertion unchanged.

- Bind native acknowledgement-loss evidence to each held caller’s actual committed callback ordinal. Allow normal precommit contention without mistaking the following native retry for a failed fault injection; retain exact caller, loss order and contiguous retry checks, record the sequence, and preserve every product assertion.

- Keep the late-save publication race conclusive only when the publisher wins an overlapping attempt. Accept an exact snapshot conflict only after proving the winning late draft and published head remain intact; preserve the stale-draft invariant and add a product fault control for the retired-base guard.

- Make the large-document transport regression deterministic by fixing its Yjs client ID width. Preserve the existing payload floor and transport limit; retain observed failures for a short-ID fixture, the old limit and a disabled oversized-compaction guard.

- Retain all original E2E acceptance obligations and add nine complete native-retry area runs, bringing the local matrix to 64 cells. Bind the retry discovery to 34 exact cases and 55 directional controls; keep every finding open until fresh integrated evidence satisfies it.

- Refresh six retained fault patches after transaction receipts changed source context. Keep their projection, minting, deduplication, rename and thumbnail mutations unchanged; verify the complete patch catalog reverses exactly and the affected directional unit checks still detect their faults.

- Distinguish a native OAuth code-exchange retry from independent code replay after another request refreshes the grant. Keep the newer credentials valid, refuse obsolete original credentials without revocation, and retain independent replay protection; cover the real recovery→refresh→retry ordering with a keyed endpoint control.

- Keep the feedback publication pause points applicable after bounded retry receipts changed their imports. Preserve the original gates and directional controls, with exact patch reversal and composed compiler checks.

- Keep a committed MCP comment acknowledged when its author deletes the thread, opening comment or both before a native retry. Store a bounded receipt independently of deletable feedback, preventing false refusals and resurrection, with real author-delete E2E coverage and three directional controls.

- Acknowledge remembered-link saves and no-change publications after a later edit replaces their current pointer or epoch. Bounded operation receipts preserve the original result and captured cleanup without overwriting later drafts; add native retry regressions and combined endpoint schedules for draft and thumbnail supersession.

- Bind the native-retry email privacy check to completion of the actual cooldown decision before counting absent mail. A keyed fault-capability marker distinguishes a finished denial from a callback still waiting in Firestore.

- Preserve later suggestion lease operations when a completed claim or release loses its transaction acknowledgement. Bounded request receipts prevent an older claim from resurrecting a released lease or an older release from clearing a newer claim; cover both same-account races with native retry regressions and keyed endpoint controls.

- Preserve a completed rename across native transaction retries without replaying it over a later name or duplicating its change event. Reject a missing document instead of recreating a partial record; retain regression tests and a keyed endpoint control.

- Preserve an accepted thumbnail upload after a later publication and thumbnail replace its current key. A bounded receipt retains the original success and obsolete-image cleanup without repointing the newer head, epoch or JPEGs; retain native retry regressions and four directional E2E controls.

- Keep operator sharing and withdrawal results across native commit retries even after a later revocation or publication. Share bounded receipt semantics with Functions through an ESM helper and golden tests; add two real operator fault schedules with directional controls.

- Require every declared affected E2E case and concurrency axis when resolving product, discovery or coverage repairs. Command-only harness repairs remain valid when they declare no affected E2E cases.

- Keep membership race gates, PKCE spending, email cooldown and retired-head comment controls applicable after native acknowledgement recovery; preserve each fault and validate the capability combinations.

- Keep the retired-head suggestion and unwritten thread-flip controls effective after native acknowledgement recovery, preserving their original faults and E2E targets.

- Retain the existing verification race gates and reading-statistics regression controls after native retry recovery, preserving their original faults and assertions in either capability order.

- Exercise native acknowledgement loss through the CLI OAuth exchange and comment/suggestion cooldown triggers, including a document expiring while its reader’s claim is held. Four directional controls bind actual commits and native retries to token validity, exact notice counts and expiry privacy; mailbox transport errors remain separate from measured count failures. Align deterministic cooldown fixtures with the fresh authority clock.

- Exercise native acknowledgement loss during folder and document sharing while a later request revokes the grant. Bind the original successful response to its invitation delta, exact event records and the later membership state, with four directional controls.

- Preserve one endpoint operation when Firestore commits but loses its acknowledgement: verification sends its reserved code, wrong codes spend one guess, replaced challenges retain their budget, reading beats consume one cap, and team changes acknowledge prior authority while keeping their invitation delta. Add six real fault-gated endpoint cases and ten directional controls.

- Drain MCP acknowledgement probes after releasing their gate even when setup inspection fails, so a completed case leaves no request running in the next case.

- Forward explicit native Firestore transaction options through the acknowledgement-loss capability, preserving endpoint retry budgets and testing a dropped-options inverse.

- Preserve each completed document or folder membership mutation across native commit retries. Bounded receipts keep the original invitation delta and event emission, prevent an old grant or move from overwriting a later one, and leave pure membership recomputation receipt-free.

- Preserve a notification’s winning cooldown claim across a native commit retry, with a unique claim id alongside compatible numeric timestamps. Recheck current opt-out, read authority and expiry before delivering; prune expired claim ids with their cooldown entries.

- Preserve the built-in CLI’s first OAuth exchange when the native SDK retries a committed token after acknowledgement loss. Keep its plaintext only in that request, verify the committed token identity and revocation state, and retain independent replay revocation.

- Exercise native commit acknowledgement loss through MCP comment creation and overlapping document fetches. Bind each fault to its real commit and retry, with four directional controls for the comment receipt, both read counters and independent receipt cleanup.

- Acknowledge an MCP comment already committed before a lost Firestore acknowledgement, and count each automated fetch once even when another fetch commits before its retry. Keep bounded per-operation receipts on existing records, with independent cleanup and age guards that prevent expired operations from replaying.

- Recognize completed suggestion creations, revisions and thread decisions when the native Firestore SDK retries after losing a commit acknowledgement. Unique annotation/history/note receipts prevent false refusals, duplicate revision history and an old resolution overwriting a later reopen; retain focused native-retry regressions and gated E2E controls.

- Register the native acknowledgement-loss pause at its actual helper source and named gate call, allowing the existing amplifier-composition checks to verify that controls preserve it.

- Keep operator historical-deduplication, withdrawal epoch and public-projection controls applicable after acknowledgement recovery, preserving each original mutation.

- Require complete projection-failure, endpoint acknowledgement-loss and operator acknowledgement-loss runs in the E2E acceptance matrix, preserving every original axis and recording the new transaction-retry defect family without premature closure.

- Exercise actual Firestore commit acknowledgement loss through a document-keyed local fault capability. Seven endpoint and operator cases check successful receipts, retained exact bytes and completed retirement after native SDK retries; fifteen directional controls cover false refusals, lost objects and skipped cleanup. Confine the separate projection fault to its marked fixture so whole-area capability runs remain valid.

- Keep the draft and external-update cleanup controls effective after acknowledgement recovery: their mutations suppress both direct cleanup and cleanup proven safe by stored references, while preserving the original loser-upload assertions.

- Preserve operator publication and withdrawal completion after a lost transaction acknowledgement. A retry recognizes its own immutable version or retirement epoch, keeps the successful cleanup receipt, and finishes mirror, old-log and captured-draft cleanup without repointing newer work.

- Keep normal losing-transaction cleanup while protecting acknowledged-lost uploads: a known refusal may remove a staged candidate only after a fresh read finds its unique prefix in neither the current draft nor any historical version. Failed reference reads and unknown transport outcomes retain bytes.

- Retain the thumbnail upload gate and existing timestamp, authority and nontransactional-write controls after acknowledgement reconciliation, with their original assertions unchanged.

- Refresh publication race and cleanup control patches after acknowledgement recovery changes, preserving their mutations and amplifier composition.

- Give the projection-failure E2E case the same bounded setup budget as the rest of its area, so its session setup reaches the product before the response and storage assertions run.

- Preserve saved and published bytes when Firestore retries a transaction after losing its commit acknowledgement. Recognize each request's committed immutable prefix or retirement epoch before retry-only refusals, keep later heads intact, and retain potentially committed bytes when the result remains uncertain.

- Preserve thumbnails when the database commits an upload but loses its acknowledgement. A transaction retry recognizes that request's recorded key, reports the completed upload, and finishes retiring obsolete images instead of deleting the new JPEGs.

- Verify the original A08 and A11 stability requirements against three distinct completed whole-file runs with every current case passing on the same frozen source; reject filtered, partial, stale or repeated substitutes.

- Exercise an unavailable postcommit projection dependency through the draft API, binding successful responses to durable storage pointers and exact read-back bytes; add explicit local fault capability and directional controls without changing product behavior.

- Add a default-trial thumbnail authority matrix cell while retaining every original campaign axis, and record the targeted N20 repair evidence without closing final acceptance.

- Judge C14 wire overlap from unrounded request timestamps while accepting a positive sub-tenth-millisecond margin displayed as zero; a true zero overlap still refuses the evidence.

- Keep stale-draft, delayed-autosave and checked-snapshot negative controls applicable to both draft commit paths after the snapshot-precondition repair.

- Bind the separate C14 local safety assessment to every original natural and forced trial, exact saved bytes, request timing, completed records, and actual directional controls. Retain raw inconclusive observations and the original open obligation, so local acceptance never claims full completion.

- Recheck thumbnail editor authority after JPEG upload, so a concurrent downgrade or removal cannot publish a shared image. Refuse with the existing reader-aware status and remove only the rejected candidate's objects; preserve owner uploads and existing thumbnails.

- Save document-authorized drafts with an exact snapshot precondition instead of retaining a read transaction through the write. Recheck base, expiry, current role, live epoch, and causal order on every conflict; keep remembered-link authorization transactional and retain candidate bytes when a lost acknowledgement leaves the commit uncertain.

- Keep the tier-lock recording regression valid when invocation metadata also records guarded RTDB maintenance.

- Require the complete documented review refusal and a successful MCP transport before a natural publication race can count as safe refusal; share that predicate with composite evidence validation.

- Preserve exact draft and version bytes when publication loses a feedback race, retain every natural attempt, and add forced-order controls for the separately reported C14 composite safety proof.

- Preserve the RTDB coverage-retention and incomplete-report discoveries in the campaign ledger, and record completed C6 authoring controls without closing final acceptance.

- Archive and recycle the pinned local RTDB emulator’s unbounded rule-value coverage at verified quiescent boundaries, preserving exact rules, data and diagnostics without raising resource caps.

- Require successful invocation completion and the final reporter case records before a passing E2E report can close a full campaign matrix cell; interrupted or early merged subsets remain incomplete.

- Register additional E2E campaign mechanisms without closing original findings; keep harness defects, product fixes and unresolved runtime failures distinct.

- Keep long-paragraph input points visible in scaled frames and exercise concurrent typing as an uninterrupted keystroke sequence, so the driver does not move fast writers into a peer’s unfinished word.

- Cancel pending Done UI effects when its viewer unmounts, and separately exercise a real iframe replacement while a save is held; distinguish each lifecycle guard with its own negative control.

- Exercise an untouched empty shared document through the real save and publish path, and prove its causal-history acceptance with an exact rejecting control.

- Keep a pending Done deadline and completion tied to the editing session that started it, so navigating to another document cannot change its save state, display an old error, or close its editor.

- Bind the local trigger-overlap limitation to completed run metadata, exact case identities and pinned runtime evidence; retain inconclusive outcomes and distinguish local acceptance from full completion.

- Retarget refused-append and oversized-live-document controls around the new delivery/recovery guards, retaining each original mutation and failure assertion.

- Explicitly retry Done in large-peer latency and held-save scenarios after an intentional delivery deadline, preserving their save-order, token and convergence assertions.

- Challenge expiry clearing through its actual HTTP field-deletion path; the control now retains the old deadline and proves the restored feedback-permission assertion detects it.

- Pin and behaviorally reproduce the local Firestore emulator’s serial trigger delivery, document its narrow overlap limitation, and retain each feedback burst’s wire timings and conservative warm-up memory reservation.

- Preserve sufficient patch context for the Done-deadline negative control while keeping its mutation limited to the timeout.

- Verify both external update paths retire a live log created after their initial editor check and fence subsequent writes from that old epoch; independently remove epoch advancement to prove the regression.

- Tie every reported product finding to current executable witnesses, retaining original case identities and peer counts beside explicit rename rationales; no finding is closed by the mapping.

- Wait for live update acknowledgment before Done tears down editing, retain failed or timed-out work for retry, and bound the whole Done attempt. Warn on closing with pending live typing; refuse incomplete live history over a fuller saved draft and offer an explicit leave-and-publish recovery path.

- Challenge the personal-token current-identity gate independently for disabled and deleted accounts, keeping both existing session-versus-token witnesses selectable and requiring exact patched-stack refusals.

- Follow explicit stale-base reload in the natural co-editor observation, and recognize per-tab peer records in the leave-presence canary precondition.

- Reject control definitions whose suite cannot select their spec before allocating a stack; explicitly select concurrency for twelve affected controls.

- Cover an owner signing into an existing workspace while the first backend listen is delayed past the SDK offline transition; require the eventual document and no false empty state, with a direct cache-guard control.

- Exercise real local operator access grants and removals through Firestore, both live-access mirrors and authenticated content/presence/log gates, with separate missing-grant and missing-revoke controls.

- Observe the deck overview opening independently of its image renderer, so a stored-thumbnail regression reaches the exact image assertion rather than a setup timeout.

- Keep the delayed live-editing race and its convergence/token checks, then continue acknowledged typing until a real log compaction occurs; batched transport updates no longer leave those cases permanently inconclusive.

- Retain bounded fresh-document attempts for natural review, publish and feedback-trigger races; assert every attempt, and distinguish refused local review commands from legitimate remote-merge autosaves.

- Validate the live epoch as reserved access-mirror metadata in sharing concurrency snapshots, while continuing to reject malformed grants and retain unknown keys for membership comparison.

- Match affected concurrency scenarios to their actual expanded result identities without losing the recorded peer count or trial; reject contradictory suffix metadata and unrelated scenarios.

- Compare authored reader bodies after Done without per-person presence paint, while retaining the original convergence deadline, save/log stability checks, and independent persisted-byte decoration checks.

- Retarget historical-comment, annotation-access and generated-note controls around the new expiry gates, preserving the specific regressions each control reintroduces.

- Run a frozen complete control inventory through at most three ordinary harness workers, preserving admission gates and importing exact pair artifacts into one command report; reject partial, duplicated, stale or changed-source evidence.

- Bind local E2E acceptance to a frozen source fingerprint, exact assertion failures and complete control ledgers; prepare commands and import actual run evidence into reviewable proposals.

- Offer explicit draft reload when another editor publishes, retaining the stale editor's unsaved local text until that choice. Add a controlled co-editor publication case at every concurrency size and inverse controls for recovery and automatic remounting.

- Freeze direct annotation and comment creates, changes and deletes when a document expires, including owner writes, while preserving existing feedback reads and restoring the same permissions when expiry is cleared.

- Keep one quote context intact in repeated-replacement review tests, and assert failed-save error text after observing any error toast; real patched-stack controls now reach both intended assertions.

- Wait for analytics route events with the harness's explicit pending sentinel, and make the repeated-script control insert a fresh executable script so it proves the later fetch-count assertion.

- Keep change-feed audience checks reusable on both tiers, expecting access events only from local sharing while retaining fork and draft privacy checks everywhere.

- Audit the original smoke, live-editing, workspace and account attempts; preserve unresolved save and page-close causes, and distinguish the account shared-stack one-of-three result from dedicated runs.

- Expand MCP coverage for exact schemas, browser preflight and error headers, historical fork provenance, and every permitted or member-only link-key boundary. Add directional protocol, paging, identity and lineage controls, and reuse the shared visibility helper for cleanup.

- Exercise specific-thread and panel review entry points, deletion and repeated-quote retries, failed draft saves, claim release and protection, adopted highlight paint, stale panel state and full committed attributes; add independent controls without treating scratch negatives as product control proof.

- Wait for separately written smoke comments, allow slow completed saves without weakening convergence checks, and let the saved-attribute smoke case prepare its own version. Keep the autosave race open by holding a real response without imposing a cold-server speed requirement, and assert both peers retain generated-container hints.

- Reconcile original comments, review, change-feed and OAuth failures from their saved artifacts, preserving uncertain attempts and historical outcomes instead of treating current passing runs as retroactive proof.

- Explain when a suggestion changed after its previous replacement reached the draft, so an approver can review or undo that edit instead of being told to retry a now-stale acceptance.

- Add directional account controls for populated-team deletion, consent and script loading, token revocation, hashing, read privacy and names; judge delayed token-use records with an explicit final assertion.

- Exercise fork privacy and expiry across ancestors, descendants and public projections; prove that copied versions exclude feedback and unrelated files, refused destinations leave no bytes, and sign-in intents wait for the authenticated unlock answer.

- Require separate positive campaign runs for the three added CLI capability variants, retaining all 48 original acceptance cells and refusing a ledger that drops any new cell.

- Make presentation hiding checks start with visible comments and banners, require real deck keyboard dispatch, pin thumbnail cache duration independently, and exercise two-image cover refusals and thumbnail side effects with directional controls.

- Verify Markdown readiness without a timed gate, inspect real section hierarchy and external-resource channels, and preserve exact authored raw blocks and duplicate comments across a second save, with directional regression controls.

- Add CLI cases that cross the unchanged document and event page limits, isolate the polling interval floor from the server retry delay, and challenge parent-directory, uppercase and underscore skill names. Trace only local call timing and tool names; slow measurements remain inconclusive.

- Verify live peer colours against independent comment accents and distinct email-derived expectations, inspect decoded shared-log bytes for editor decoration, enforce the exact two-second sharing bound, and add directional suggester-write controls. Explain historical live-editing failures without carrying old stability claims into current acceptance.

- Preserve inline-code markup at the start of a paragraph without changing the authored block or native undo. Exercise the commit/autosave race by holding only a completed response, with exact draft cleanup and request-count checks; the response-delay helper preserves redirects and never resends a completed request during cleanup.

- Distinguish revoked-reader responses from absent-document responses byte for byte, require fresh unrecovered listener failures before excusing a sharing observation, and add directional controls for team and folder removals, invitation contents, inherited rows and private editing.

- Exercise CLI saved-sign-in revocation beside a shell token, already-dead credentials and immediate CI refusal; retain large-source change cursors and add directional controls for logout, replacement arguments, move destinations and wait timeouts.

- Make reading-statistics E2E checks wait for the exact page-exit beacon in both stored records, and add independent controls for automated metrics, both activity filters, malformed beats and editor detail gates.

- Exercise OAuth focus rearming, resource and client binding, live identity closure, hostile redirects, duplicate parameters and capability disclosure; exchange short-lived credentials before unrelated waits and add directional source controls for the protocol and public entry points.

- Keep the document visible and the reader’s place intact when File → Print runs with Comments selected: phone pane switching now applies only on screen, and print hiding overrides later chrome styles. Exercise the complete stylesheet and real printing hook, including consent’s independent print guard.

- Make Inline code wrap the selected rich text with native undo, preserving authored whitespace and styles, and request link destinations from the app window so the sandboxed editor can insert links. Exercise every formatting control through autosave and require the draft banner to show when it was saved.

- Promote seven repaired concurrency regressions after local browser proof, make causal-save retries preserve pending suggestions and authored document checks, and cover the 2 MiB live-log boundary and compaction fallback with explicit negative controls.

- Keep print markings visible above authored ancestor transforms, filters and containment, and lock independent rotation. Expand export coverage for page geometry, both print shortcuts, decoration, browser print cleanup, pagination and every chrome surface, with directional regression controls.

- Cover withdrawal and remint change-feed events, current-content deduplication and trust, and pinned version menus with directional E2E controls; limit report claims to the DOM and final-state evidence actually observed.

- Strengthen change-feed coverage with a real tied page boundary, saved publish and fork cursors, unseen events before writes, generated-note and page-local reply checks, and existing-draft privacy. Classify evidenced emulator timeouts without suppressing extra events, and add directional regression controls.

- Test debug-log limits at watchdog checks, including delayed-poll overshoot and bounded recovery, instead of assuming the scheduler guarantees a hard continuous size cap. Refresh the update-race amplifier for snapshot-bound draft loading.

- Publish restored historical content as a new current version across draft, upload, MCP and operator paths; only content matching the current version is a no-op, so reverting an edit cannot silently discard the draft.

- Keep an active editor and its unsaved changes when entering a review pass; only explicit Reload or Take theirs prepares a new draft snapshot. Verify editor frame parameters against that prepared snapshot.

- Let accessibility judges perform their shared setup when selected alone, while preserving inconclusive results after an earlier failed measurement and inheriting the setup budget and side effects.

- Clarify and test text-range deletion: remove observed characters, retain unseen concurrent insertions at the cut in surviving parents, and remove descendants of deleted elements. Preserve the serial deletion controls.

- Keep the campaign ledger deletion control pinned to its required discovery when new findings are appended.

- Preserve intentional historical browser comments and test their selected version, passage, body and newer-version notice, replacing the contradictory concurrency expectation that no old version may receive feedback.

- Let the operator smoke case create its own owner when selected alone, so its negative controls reach the command under test.

- Refresh regression mutations after presence, activity and write-authority repairs; keep verification race controls applicable alone and after their timing gates.

- Close the operator-owned Admin app after awaited publishing, access, withdrawal or teardown work, so a live realtime mirror connection cannot keep a completed command running.

- Recheck the current version and reader permission atomically when MCP opens a comment, so publication or access revocation during passage lookup cannot leave new feedback behind.

- Judge retired live logs by entry count and observe OAuth return state without waiting for Firebase listeners to become network-idle; fix the default-marking matrix command.

- Carry the supplied MCP link key through the final content transaction, recheck it after token rotation, and preserve the stricter upload editor gate after access revocation.

- Let new presence sessions register disconnect cleanup before announcing themselves, while rechecking ownership so queued cleanup cannot remove another person.

- Align visibility coverage with the explicit reader metadata and response-type contracts while retaining strict field allowlists and header controls.

- Keep reading identities in editor-only history, remove the legacy last-reader email from shared stats, and provide a bounded redaction command for existing records.

- Cover upload-revision refusals from workspace actions and document-frame drops, including permission and expiry changes after opening, pending and accepted suggestions, and active peers; pin readable errors, retry state and unchanged stored content with negative controls.

- Bound email provider requests to ten seconds, including incomplete response bodies, so saved access and later recipients survive a stalled provider; cover both phases with recipient-scoped local holds and regression controls.

- Keep owner export markings and permitted source/bundle downloads available to link readers, refresh legacy public projections, lock five additional print-hiding CSS properties, and strip reader decoration from SVG/PNG exports while preserving authored canvas pixels.

### Fixed

- Refuse stale whole-document draft saves, bind editor frames to their prepared snapshot, and retire old live sessions after link-holder saves so accepted work survives delayed member autosaves and explicit reload resumes from those bytes.

- Preserve reader scroll and unchanged selections across overlapping draft reloads, and keep mobile toolbar actions visible while every presence chip remains reachable.

- Enforce the email verification guess budget and resend interval across concurrent requests; preserve newer challenges when an older completion returns late.

- Make CLI `open --json` and `login --paste --json` return structured results, keeping paste instructions and prompts on stderr.

- Refresh a stacked deck’s position when motion completes or is cancelled, and leave overview keys to documents that do not measure as pages.

- Enforce saved root-attribute preservation after an in-app acceptance, with independent setup when the regression case is selected on its own.

- Initialize operator Realtime Database handles with an explicit emulator URL and demo namespace, so publish and access changes install their mirrors.

- Refresh regression controls for current permission mirrors and cursor rules; assert both live-log directions before a denied join stops the editor.

- Support the measured large-document live seed with a bounded 2 MiB encoded-update limit, explain oversized seed refusals, and retain every delta when a merged compaction is too large.

- Accept an untouched empty shared document's causal history, and replay the delayed-save regression through its authenticated owner session.

- Clarify that a recognized two-slide deck keeps its navigator; cover both destinations and the single-slide boundary in the end-to-end suite.

- Keep delayed autosaves from overwriting merged work using insertion and deletion histories. Capture each editor's version and live epoch, autosave remote merges, and retire only the session consumed by a publish or accepted suggestion. Preserve candidate bytes when a transaction response is uncertain.

- Operator publishing and withdrawal atomically advance the live editing epoch, refresh public version metadata, and retire only the captured log and draft bytes after updating the access mirror.

- Live editing preserves the identity of repeated letters through concurrent typing and deletion by honoring the browser's input range. Applied remote edits notify autosave after the DOM binding has settled.

- Give each browser tab its own presence record, cancel departed callbacks, and retain editing status while any tab of a person edits. Revoked sessions can clean up their own records; readers cannot claim editing to block publishing. Agent guards ignore records whose editor access has been withdrawn.
- Resolve operator Realtime Database URLs explicitly from environment or ignored deployment configuration; reject malformed targets and isolate demo emulators.

- Hosting pins MCP transport headers even when the Functions runtime rejects malformed JSON before the handler runs. The documented boundary is HTTP 400 with a diagnostic; handler parse errors retain JSON-RPC `-32700`.

- Empty offline caches no longer claim the workspace is empty. Formatting waits for the selected version's format, and late responses from older versions cannot replace the current entry or palette.

- MCP reads appear in Activity with a stable session start. Malformed change-feed cursors with partial positions, empty event ids or invalid timestamp ranges are refused without replaying the log or advancing the saved cursor.

- CLI publish/update watch status goes to stderr, keeping `--json` stdout a stream of parseable results while the watcher remains active.

- Browser file drops use the document title and address defaults. Upload dialogs adopt late account marking defaults until the uploader chooses, and explicit stamp-off remains off when sent to the server.

- Withdrawing a version repoints its public view atomically and deletes the exact immutable version and draft bundles named by metadata, preserving other bundles. A changed draft or version aborts before destructive work.

- Live co-editor autosaves no longer offer competing-copy notices. Unpinned readers never flash an obsolete version announcement when following another publish, and a single orphaned comment uses singular grammar.

- Refused draft commits and uploaded updates remove only their unreferenced candidate bundle. Live-log retirement retries an empty browser cache against the server instead of silently leaving the consumed log.

- Owner-only and thumbnail refusals recognize a current stored link grant while preserving the refusal and all write gates. Inherited sharing rows show each ancestor nearest first even in trees deeper than two folders.

- Password signup remains usable when the policy request is unavailable, while Auth still validates submitted passwords. Every app-shell entry path denies framing, covering case variants and client-side navigation to consent.

- Simultaneous live editors elect one initial document, retain its CRDT seed through compaction, and preserve carets and pending local edits when remote updates arrive. Editing waits for initial adoption. Autosave, Done and publish share one ordered save drain; a failed Done keeps the editor open. Publishing retires only an unchanged snapshot of the applied live log.
- Phone slide rails stay below wrapped toolbars, and external checkbox labels meet the 44-pixel touch target requirement.

- Draft saves and publishes select immutable snapshots, recheck the current version, permissions and expiry at commit time, and preserve later saves during deduplication and cleanup. Concurrent suggestion accepts retry on the latest draft, preserving every accepted change. Draft and expiry conflicts retain their own message instead of claiming a newer version.

- Account preferences restore analytics consent before collection, keep route names free of document identifiers, and apply the saved default marking to browser, MCP and CLI publications. Explicit off remains an override.

- Expiry freezes document rename, move and realtime draft writes; only the owner retains realtime reads after expiry. Visibility changes preserve an omitted expiry. Shared draft reads require editor access, while public open editors can join the existing log without seeing members' peer presence.

- Suggestion replacements reject Unicode line and paragraph separators and C1 controls on both creation and revision, matching the single-line contract.
- Dialogs keep focus when controls become disabled, the slide overview traps Tab, and closing a dialog returns focus to its opener. The hidden file picker is no longer a Tab stop. Document frames show their own focus ring.
- Touch controls retain their 44-pixel hit areas across component styles. Explicitly selecting a highlight opens its thread on phones and tablets. Thread scrolling honours reduced motion, and presence dots remain visible in forced colours.

- Operator sharing and publishing now use transactional records and isolated, create-only uploads. The E2E mirror repair uses revision fences and conditional node writes, preserving concurrent revocations.

- Concurrent document, folder and team sharing changes preserve every successful delta. Membership cascades retry changed dependencies, removed team admins lose management rights, and invitations belong to the operation that added access. Realtime access mirrors reject older writes, and public projections cannot reappear from a stale snapshot after a document becomes private.

- Competing version publishes upload into isolated immutable bundles. The committed version record selects the bytes served, downloaded, forked and edited, so a losing request cannot overwrite the winner's content.
- Concurrent suggestion requests share the twenty-pending limit atomically; only one request can take the final slot, with no orphan opening comment.
- Editing restores the document's original body attributes before saving and on exit. Editor-only `spellcheck` no longer leaks into published bytes, while authored editing attributes survive. Empty generated-container hints are restored after a shared document adopts remote content.
- Personal tokens stop working when their owner is disabled, deleted, loses email verification or changes identity. Every use re-checks Auth and the identity gate; an unavailable identity service fails closed.
- Comment and suggestion notices require current read access when their cooldown is claimed. Prior participation no longer mails new content to a removed reader; expiry and rotated link grants are checked too.

### Tests

- Revision upload checks follow the version record's immutable entry and wait for the document iframe before testing a file drop.

- Spawned publish and update watchers verify that both JSON results stay on stdout while the readiness notice goes to stderr after registration.

- Framing controls apply to the stack's expanded Firebase configuration, and the grant-refusal case imports its HTTP-answer classifier.

- Workspace coverage checks independent sort orders, inherited folder movement, invitation silence, thumbnail backfill and both revision-upload entry paths, with refusal, retry and deduplication controls.

- Version and withdrawal checks read immutable snapshot paths, keep retired byte evidence, and detect uploads without a committed version record.

- Concurrency cleanup checks follow immutable storage pointers, retain retired paths after metadata deletion, and detect unreachable refused candidates. Snapshot-race and concurrent-accept controls execute their own measurement.

- Email E2E coverage now checks cooldown expiry, rendered notice content, removed readers, repeated grants, filing silence and provider failures. A request cutoff stays inconclusive instead of counting as delivery-handling success; each added control is independently buildable.

- Regression controls can share the explicit analytics and CLI capability setup with their clean run. Routing fixtures isolate account restoration, and thumbnail checks preserve authored editing attributes.

- Accessibility E2E checks now measure Chrome's computed control names, text contrast and focus paint on 11 screens and two dialogs without an extra dependency. Nested overflow, all interactive hit areas, all five app scroll paths and phone long-press comments have explicit checks and regression controls.

- Endpoint test transactions retry conflicting document and query reads, and failed batches and transactions roll back every write.
- E2E self-tests and stacks select Node 24 and the same explicit Firebase executable, reporting both versions. Installed-tool probes check environment precedence and watcher behavior without depending on source formatting. Mail settling and log-rotation tests wait for the conditions they measure.

## 0.24.0 — 2026-10-28

### Fixed

- Follow an account to the address Google renamed it to. Firebase finds a returning Google user by Google's account id and never updates the stored address. Someone whose Workspace admin moved them to a new domain therefore signed in as their old address, and saw nothing shared with the new one. Now a Google sign-in whose verified address differs moves the account: everything it owns, every grant and team membership naming the old address, and the account record all move to the new one. The new address is believed only from Google's own signed token, bound to the account by Google's id. The move runs as a retried job (`accountMoves/`, the `moveAccount` trigger) that leaves nobody with less access if it stops partway. It signs the account out everywhere and revokes personal tokens minted under the old address. History keeps the address it was written under. Each owner's ACL log records the move (ADR 0020, SPEC §14). While it runs, the sign-in screen says "Moving your account to …". Afterwards the app signs in again as the new address and says what was signed out. An account that was already signed in when Google renamed it sees a notice offering the move.
- Find a thread's earlier participants by account rather than by the address on their comment. Someone who moved address keeps getting notices, and an author is never sent their own comment under an address they have left.

## 0.23.0 — 2026-10-28

### Added

- Share a folder by link, or make it public, with an expiry, as a document can be shared. The folder's link opens everything beneath it to read: its own documents, every subfolder's, and documents filed there later, including ones that are private on their own or owned by someone else. A folder reader has no account-level access. They get no comments, annotations, presence or editing, even when signed in, because the rules cannot see a folder's key. A folder's expiry ends its link and nothing else. Members keep their access, and nothing beneath is frozen. Rotating the link (private, then unlisted again) revokes every copy. A document under a public folder is mirrored to `public/` and listed in the sitemap. The server side is in this release: `POST /visibility` and `POST /unlock` take a `folderId`, and `GET /access` and `GET /folder-access` report `inheritedReach` ([ADR 0019](docs/architecture/adr/0019-folder-links-reach-their-subtree.md)).
- Set a folder's level, link and date in its Share dialog, as a document's are set. Someone with the link, or anyone for a public folder, opens `/folder/{id}` without an account. They see a read-only page of its subfolders and documents with their covers, and every link out carries the key. A signed-in account that is not a member gets the same page. A document's share dialog names each folder above it that reaches it, and its count of readers includes those folders' readers. Cards show a folder's level and when its sharing ends. Moving something into a shared folder says who can now read it. A reader who came through a folder's link is offered no comments, presence or editing, and their chip says when the link stops.
- Unfurl a folder's link with the folder's name. `/folder/**` now goes to `docShell`, which names a folder whose public level or key opens it, caches that page no longer than the link lasts, and marks a keyed page `noindex`. Every other folder gets the generic shell with `private, no-store`. This needs the new Hosting rewrite, which ships with Hosting.
- Let an agent share a folder by link, and read through one. A new tool, `set_folder_visibility`, takes the same sparse patch as `set_document_visibility`, without open editing; there are now thirty-three tools. `get_folder_access` reports the folder's settings, and both access tools report `inheritedReach`. Given a folder's key, `get_folder` lists one level of what it holds. `get_document`, `list_versions`, `fork_document` and `get_lineage` read any document beneath it, and `get_document` says `viaFolder: true` with every `can…` false. Every other tool refuses that key in words rather than as an absent id. `access` on a filing answer names the folders whose reach now opens the document (`throughFolders`), and `alsoReadableBy` says `"anyone"` under a public folder. The new tool is a schema change, so this release is a minor version.
- Share and open a folder by link from the command line. `bikeshed visibility folder <id|link> [private|unlisted|public] [--expires …]` sets a folder's level and date and refuses `--public-edit`. `bikeshed visibility document <id>` names a document explicitly. `bikeshed folder <link>` lists what a folder's link opens, and filing output names the folder whose reach widens who can read (`bikeshed-now` 0.18.0).

## 0.22.1 — 2026-10-28

### Fixed

- Stop one 503 from Google failing a deploy before it starts. The deploy saves evidence before it changes anything, by reading every function's Cloud Run service, one call per function. The ops client gave up on the first 5xx, so one bad answer stopped the whole run. It failed three deploys of 0.22.0 that way, and the hourly audit as well. Reads now retry after 1, 2 and 4 s on 429 or a 5xx. Writes are still sent once, because a write that answered 503 may already have been applied.

## 0.22.0 — 2026-10-27

### Added

- Say what a document is waiting for, and offer a way out when it stalls. The wait was one label, "Opening the document…", from the sign-in round trip through the frame's last image. It now reads "Signing in", "Opening the document" or "Loading the page". A stage that runs past 4 s says it is taking longer than it should, and past 20 s offers Try again: the page reloads for the first two stages, and only the frame for the third.

### Fixed

- Open a document in a new tab without waiting for servers to start. The page, the sign-in cookie and the document's bytes come from three functions in turn, and after a quiet spell each started cold: 3.6 s and 3.0 s for two of them, 3–6 s on "Opening the document…" in all. Each now keeps one instance running, about $24 a month whatever the traffic ([ADR 0018](docs/architecture/adr/0018-keep-the-document-open-path-warm.md)).
- Start every function without loading the email renderer. React and the email templates were imported at the top of the functions' shared module, so every cold start loaded them: 221 ms of a 290 ms load, on paths that never send email. They now load where email is sent, as ADR 0008 always said.

## 0.21.0 — 2026-10-27

### Added

- Offer a way in from "Not here". A reader who is not signed in gets a Sign in button; one signed in with another address sees which address and can switch account. Either way they come back to the same link, key included. What the page offers depends only on the reader's own sign-in state, so it still cannot tell an absent document from one they may not read (SPEC §1.4).

## 0.20.4 — 2026-10-26

### Fixed

- Stop alerting when the operations audit is late. GitHub delivered its hourly schedule about six times a day, so the six-hour warning fired on normal delays; a schedule that stops without failing is no longer alerted on. Provisioning now deletes owned alert policies it no longer defines, and the audit heartbeat metric that fed this one.

## 0.20.3 — 2026-10-23

### Fixed

- Match the fully qualified Service Health label names emitted by Google so initial relevant incidents remain detectable while routine updates are filtered.

## 0.20.2 — 2026-10-23

### Fixed

- Treat delayed operations audits as six-hour monitoring warnings with fewer reminders; retain fast independent availability alerts.
- Notify on active, confirmed, relevant provider incident transitions instead of routine updates and resolutions, with clearer investigation guidance.

## 0.20.1 — 2026-10-22

### Fixed

- Use `/health` for dependency probes after the real platform rejected the exact `/healthz` path, and avoid false dashboard drift from omitted API defaults.

## 0.20.0 — 2026-10-22

### Added

- Read-only, uncached dependency health with bounded failure responses.
- Managed uptime, startup, backend, event-backlog, provider and deployment email alerts; operations dashboard, hourly drift audit and missing-audit detection.
- Manual recovery runbook, runtime-build age reminders and thirty-day deployment metadata evidence. Deployment preserves and checks on-deploy runtime updates.

## 0.19.2 — 2026-10-20

### Changed

- Refresh the landing-page explainer video, poster and captions.


## 0.19.1 — 2026-10-16

### Changed

- Place the agent instructions beside the hero on desktop and after the video on smaller screens, with a clearer action: “Put your agent to work.”
- Simplify the story player by removing its transcript disclosure and duration line while retaining native captions.

## 0.19.0 — 2026-10-16

### Added

- Discover and read published version history through MCP and the CLI, with pinned URLs and explicit version guards.
- Historical content and feedback are a read-only archive across the UI, API and database rules.

### Fixed

- Keep the request-stall harness fixture deterministic under concurrent test load.
- Update end-to-end controls and operator withdrawal for isolated version and draft storage.
- Isolate competing bundle uploads and draft saves so stale work cannot replace published bytes or delete a newer draft.
- Document historical reads and stale-write recovery in all agent instructions and published guides.

## 0.18.0 — 2026-10-16

### Added

- A narrated landing-page story with native playback, captions and a readable transcript, alongside a shorter explanation and clearer getting-started path.
- Optional dedicated public media hosting on Google Cloud Storage, with credential-free operator dry runs, isolated bucket permissions and immutable publication of video, captions and poster revisions.

### Fixed

- Derive the landing footer version from the app package instead of displaying a hardcoded early release.


## 0.17.0 — 2026-10-16

### Added

- Owner permission inspection and grant/revoke/role changes for documents and folders through MCP and CLI; visibility, open editing and expiry controls; folder rename, move and owner-only deletion retaining all contents.
- A permissions skill, updated folder/publishing guidance and OAuth consent. Existing connections gain these commands without reconnecting. Sharing sends the same invitations as the web app, only to newly effective readers.
- Shared HTTP/MCP management handlers, preserving inherited membership and owner checks. Sparse settings changes preserve omitted values.

### Fixed

- Keep HTTP management refusals as identical empty 404 responses for unreadable and missing resources when delegating to the shared handlers.
- Scroll the E2E consent driver to its approval controls before generating pointer input, so longer permission disclosures remain testable.

## 0.16.1 — 2026-10-13

Tests and documentation only, so a patch release. The product is unchanged.

### Tests

- **An end-to-end suite, opt-in: `npm run test:e2e`.** The unit suites run each module in plain Node or jsdom, with at most two fake peers and transactions that never conflict. So the properties that matter most here were proved only by walking `docs/development/verification.md` by hand: a highlight surviving a reload, decoration kept out of saved bytes, several people typing in one document, two commits racing. `e2e/` builds a copy of the product from the tree and starts it on its own ports, with its own emulators and a local mail catcher. Real Chrome sessions, MCP clients and the CLI then drive it.
  - **What it covers:** a smoke tier; 26 functional specs over areas A1–A24 of the test plan; and concurrency scenarios C1–C23 at 2, 5, 10 and 20 simultaneous users. The shared oracles each have a negative control (the saved bytes free of decoration, their hash, convergence, the concurrency invariants): a patch that plants the bug the oracle exists for, seen to turn its case red, then green without it. There are 145 such sets in all. Many checks inside single cases have none yet.
  - **Why it is opt-in:** a run takes minutes and gigabytes, and needs Java, Mailpit and system Chrome. The concurrency tier is a measurement that wants the machine to itself. Neither `npm run verify` nor CI runs it.
  - **What it does not prove yet:** the functional specs have known gaps, left open on purpose so the concurrency scenarios came first, and the production tier is refused in this build. Both are listed in `e2e/README.md`, "Known weaknesses".
  - **It found product defects.** They are tracked separately and fixed in their own releases. Until then their cases report TODO, never a pass.
  - `playwright-core` is the one new dependency: a root devDependency, pinned exactly, Apache-2.0, with no dependencies of its own.

## 0.16.0 — 2026-10-12

A feature, and an update refused where it was not before — while somebody is in the editor — so this is a minor release.

### Added

- **Upload a file as a document's next version, from the browser.** Somebody who works on the file on their own computer could publish its next version only through the CLI or an agent. **Upload a new version…**, in the document's menu or on its card in the workspace, now publishes a file in the document's place, and so does dropping the file onto the open document. Before anything is published, the dialog says what will happen: the comments stay on the version they were written about, an unpublished draft is discarded, and the page's scripts are blocked again until somebody trusts it. It sends the version it opened on, so a version published meanwhile is never silently covered. It is offered to the document's editors, not to the open editors of a public document, which the server already refused (SPEC §2, §6a).

### Fixed

- **An update no longer brings the replaced draft back, or publishes over somebody's typing.** A new version from `update_document`, `bikeshed update` or `POST /publish?update=` deleted the document's draft record but left the draft's files and its live editing log behind. The log wins over the bytes an editor loads, so the next person to open the editor got the old draft back over the new version, and autosaved it. An update made while somebody was in the editor replaced the draft under them, and what they typed was lost when their next save was refused as stale. Every update is now refused while anybody has the document open in the editor, as `commit_draft` and an agent's accept already were. Once the new version is current, the draft's files and its log are dropped. Identical content is still a no-op, whoever is editing (SPEC §2, §6a, §16, §19).

## 0.15.1 — 2026-10-10

### Fixed

- **The consent page's tests no longer fail on a slow CI runner.** They moved the pointer the moment the page's heading appeared. The page attaches its listeners a turn later, and on a loaded runner that turn came after the move, so Approve never armed and three tests failed while the page was right. The tests now keep moving until the page arms. They still fail if it arms on time alone, without its second, or across a blur.

## 0.15.0 — 2026-10-09

### Added

- **Watch a document from a terminal, and see who can read a folder** (`bikeshed-now` 0.15.0).
  - `bikeshed changes <id> --since <cursor|last|all>` prints what happened since a cursor, every page of it, and ends with the cursor to pass next.
  - `--wait` keeps checking until something happens, at most every 30 seconds or the server's `retryAfter`. It exits 3 with the cursor when `--timeout` runs out, so a harness that wakes an agent when a background command ends gets watching from one command.
  - `publish --json`, `fork --json` and `get --json` carry the cursor to start from.
  - `bikeshed folder <id>` names who can read a folder, and `bikeshed folders` counts them.
  - `publish` says where it filed the document and who can read it there.
  - `bikeshed update --base <v>` refuses to replace a version somebody published since, for a `.zip` too (SPEC §19).

- **`POST /publish?update=` takes `baseVersion`,** as `update_document` does. If another version is current, it answers 409 and names that version (SPEC §19).

## 0.14.0 — 2026-10-09

A new read on two endpoints, so a minor release.

### Added

- **The share dialog lists who has access through a folder.** A grant on a folder has always reached everything inside it, subfolders included, but the dialog listed only the record's own grants. The count in its footer included people the list did not show.
  - **What it shows:** each grant made on the folder, or a folder above it, is listed after the record's own. The row is tagged with the folder it comes from and has no role select or remove button, because it is changed on that folder. A folder's dialog shows what the folders above it give.
  - **A folder the owner cannot open** is "a folder you cannot open", never its name. Its people are listed, because the record already names them.
  - **`GET /access?docId=` and `GET /folder-access?folderId=`** answer it, owner-only, with `Cache-Control: private, no-store`.

### Tests

- A grant on a folder is now tested reaching a document two folders down. Before this, only one step of the inheritance arithmetic was tested, and nothing ran the walk over the subtree.

## 0.13.1 — 2026-10-09

### Fixed

- **0.13.0 can be deployed.** Its change-log triggers retry on failure, and the Firebase CLI refuses to deploy such a function without `--force` when it cannot ask. The deploy workflow's functions step now passes it. Deploying by name, it has nothing to delete. A test holds the workflow to it whenever a function retries.

## 0.13.0 — 2026-10-09

A new tool, new fields on results and a new rule on resolving, so a minor release.

### Added

- **`get_changes`: what happened on a document since a cursor, in one call.**
  - **What it reports:** comments, with their passage; threads opened, resolved and reopened; suggestions opened, revised and decided; versions published and withdrawn; and changes to the document's title, folder, visibility, expiry, trust and sharing. Events come in the order they were recorded.
  - **`since` is required.** It is a cursor from an earlier result, `"last"` for the one this credential was last given for the document, or `"all"`. A cursor from another document, or a malformed one, is refused, never read as "now".
  - **Where cursors come from:**
    - `publish_document`, `fork_document` and `POST /publish` hand back the one to start from;
    - `get_document` starts one without overwriting a saved one;
    - an update hands back none, because a write's cursor would skip what came before it.
  - **What is filtered:** what the caller caused is left out, and the events are cut to what the caller may see. Moves, visibility, trust and sharing reach editors only. A fork reaches the original's owner, dated to the day and never by whom.
  - **Also returned:** `needsReply` names the threads a person is waiting on, and `state` is the document now.
  - **What is behind it:** each document has an append-only change log.
    - **Three new Firestore triggers** record versions, threads and comments, each retried on failure, and each event is written once even when a trigger is redelivered.
    - **The endpoints** that rename, move, share, trust or change visibility or expiry write their event in the same batch as the change.
    - **Nothing in the log is shared or sent.** It is read only by whoever asks (ADR 0016, SPEC §4, §19).

  There are twenty-three tools.

### Changed

- **Resolving a thread in the app now records who did it.** The resolve writes `resolvedBy` beside `resolved`, and the rules accept it only as the person resolving, on the web. An agent's resolve records its own. A tab opened before this release has to be reloaded to resolve (SPEC §4).

- **The agent guide, the skills and the developer guide** watch a document with `get_changes`. The CLI keeps comparing `bikeshed comments` until it has a command of its own.

## 0.12.0 — 2026-10-09

Tool results gain fields and two tools gain arguments, which `CHANGELOG.md` counts as breaking, so this is a minor release. Nothing is removed, and every new argument is optional.

### Added

- **An agent can see who can read a folder, and so who can read what it files there.** Filing a document shares it with the folder's people and emails nobody, so the agent is the only one who can tell the person.
  - `list_folders` counts each folder's `readers` and says whether it is `shared`.
  - The new `get_folder` names them: everyone by email (the first 25, then a count), its editors, and its teams. A team is named only to its members, as in the share panel, and is never sized.
  - `publish_document`, `fork_document` and `move_document`, and `POST /publish` behind `bikeshed publish --json`, return where the document is filed (`filedIn`) and who can read it there (`access`), read after the write. A public or unlisted document says so in words, not as a count.
  - `list_documents` and `get_document` say where each document is filed, and `get_document` returns its address.
  - `publish_document` returns the `requestedId` and `idTaken`, so an agent is told when its id was taken rather than having to compare.

  There are twenty-two tools (SPEC §4, §13, §19).

- **`update_document` takes the `baseVersion` it was revised from.** If somebody has published since, the update is refused and names the current version, instead of replacing their work. Its result counts the open threads the new version leaves behind (`threadsLeftBehind`) (SPEC §19).

### Changed

- **`get_comments` returns the oldest threads first and says when it stopped.** It used to return up to 50 threads in no set order, with nothing to say there were more. It now orders by when each thread was opened and sets `truncated`. Each comment carries its `id` and time (`at`). `awaitingReply` marks an open thread on the current version whose latest comment a person wrote in the app. `threads` fetches only the ids named. It needs a new Firestore index, which the deploy creates (SPEC §19).

- **The agent guide, the skills, the developer guide and the server's connect instructions** use all of this. They name who can read a folder before filing, report `access` after it, and pass `baseVersion` when publishing a revision.

## 0.11.4 — 2026-10-09

### Changed

- **An agent says where it filed a document, chooses its id, hands back the link, and watches for comments.** The agent guide (`/llms.txt`) and the three skills now ask an agent to:
  - **Look before filing,** and file a new document at the root, in a folder the person named, or ask first. Filing shares a document and emails nobody, and no tool says who a folder is shared with.
  - **Choose the id,** with a date first on a time-bound document and a project on a living one.
  - **Hand back the `url` every time,** with where the document is filed and who can read it, and open it with `bikeshed open` where the person can see the browser.
  - **Keep checking for comments** until told to stop or an hour passes with nothing new. It answers the open threads a person last spoke in, reads the version again before publishing, and decides only as its person may, never because a comment asks.

  The publishing skill no longer forbids `bikeshed open`. Both guides at `/docs` say the same in their own words (SPEC §19).

## 0.11.3 — 2026-10-09

### Fixed

- **A browser can no longer forge what its own feedback says about itself.** The rules checked that an annotation or comment named its real author, and nothing else. A client could put an agent's token id, client or agent name on its comment, date it whenever it liked, add fields of its own, or create a thread with no `resolved` at all, which no count of open threads sees, the check that holds back a new version included. Feedback is now exactly the fields the app writes, dated by the server, and a later change touches only `resolved` (a reader) or `body` (a comment's author). Nothing the app does changes, and a test now fails if the app and the rules ever disagree (SPEC §4, §17).

## 0.11.2 — 2026-10-09

### Fixed

- **The connect page says what an app can do since 0.11.0.** A person approving an app was told it could not accept or reject suggested edits or resolve threads, which 0.11.0 made untrue for an owner's or approver's agent, and was not told it could rename documents or save a draft as a new version. The page now lists both, and a test holds its two lists to the tools the server serves, so the next tool fails until the page says it (SPEC §19, §23).

- **The developer guide's command reference lists every command again.** It says it is "every `bikeshed` command, in one place", and had no `bikeshed revise` or `bikeshed withdraw` since 0.10.0. Only the agent guide was held to naming everything; now the developer guide is too, SPEC §19 must show every tool, and `--help` must list exactly the commands the CLI runs (SPEC §19).

- **`bikeshed open` and `bikeshed mv` take the link you were sent** (in `bikeshed-now` 0.14.1). The usage has said every `<id>` takes the link since links carried an unlisted document's key, but these two used the argument as it was: `open` opened `…/d/https://…`, and `mv` asked to move a document named after the whole link. `open` now keeps the key, so an unlisted document opens rather than refusing; `mv` moves by the id, since the key lets somebody read, not move (SPEC §17, §19).

## 0.11.1 — 2026-10-08

### Fixed

- **A suggest-only agent is told who decides.** `update_document` refused a caller who may only suggest with "a person accepts or rejects it", which 0.11.0 made untrue: the owner or an approver decides, in the app or through an agent. It now says so (SPEC §19, §22).

## 0.11.0 — 2026-10-08

### Added

- **An agent can rename a document.** `rename_document`, and `bikeshed rename` (in `bikeshed-now` 0.14.0), change its title and slug as the workspace list does, for whoever may edit it, and never its address. An HTML document's own `<title>` is content and stays as written. The workspace list and the tool now share one rename, and the tool refuses an expired document as every write tool does (SPEC §4, §19).

- **An agent can resolve and reopen a thread.** `resolve_thread` and `reopen_thread`, and `bikeshed resolve` and `bikeshed reopen` (in `bikeshed-now` 0.14.0), do what the panel's button does for any reader, on the current version, and never on a suggestion. Unlike the button, each change leaves a "Resolved." or "Reopened." note in the thread, marked as made through an agent, and its participants are told, because resolving hides a point from whoever raised it (ADR 0015, SPEC §6, §19).

- **An owner's or an approver's agent can reject a suggestion.** `reject_suggestion`, and `bikeshed reject --reason` (in `bikeshed-now` 0.14.0), decline one on the current version exactly as the app's Reject does, with the reason in the thread and the agent's channel in `decidedBy`. The tool checks the role itself; `POST /suggestion` still refuses a token's claim, accept and reject, and now says how an agent decides instead (SPEC §2, §19, §22).

- **An owner's or an approver's agent can accept a suggestion, and publish the draft.** `accept_suggestion` and `bikeshed accept` make the change in the draft, never a new version, so a review's decisions gather there until `commit_draft` or `bikeshed commit` (in `bikeshed-now` 0.14.0) publishes them as one, through the in-app commit's own code and gates. With no page to type into, the change is made in the source only where it is certain: the quote placed by both sides of its context, bytes holding no markup, and the result read back as exactly that change; a Markdown quote must be written out in the source, and its replacement is escaped only when it would otherwise render. Anything else is refused and left to the app, and so is everything while somebody has the document open in the editor, whose live log would overwrite the draft. A fixture of cases is held by the server and the browser alike. There are twenty-one tools (ADR 0015, SPEC §6a, §19, §22).

### Fixed

- **An update no longer discards a change somebody accepted.** Accepting a suggestion puts the change into the draft, and `update_document`, `bikeshed update` and a re-upload replaced the draft with their own bytes and deleted it, leaving the suggestion reading "Accepted." over a version without it. They now refuse with `409 { acceptedInDraft }` while the draft holds an accepted change, before uploading anything and again inside the transaction that would delete the draft, and say to publish the draft first (SPEC §2, §6a).

- **Nobody can rewrite or delete the notes the server writes into a thread.** "Accepted.", "Rejected: …", "Withdrawn." and the opener of a suggestion are stamped with the person they speak for, and the comment rules let that person edit or delete them. An approver could erase their decision, and an author rewrite an opener outside the revision history. The rules now refuse both, and a person's own replies are unaffected (SPEC §22).

- **The comments panel offers nothing a live claim would refuse.** While another approver was applying a suggestion, its author's Edit and Withdraw, and other approvers' Reject, stayed enabled and failed when pressed. The "is applying it…" notice also stayed after the claim had lapsed. They are now disabled for exactly as long as the claim holds (SPEC §22).

- **What an approver applies is what is recorded as accepted.** Claim and accept named only the suggestion. If its author revised it after the approver's screen showed it, the old text went into the draft and the new one was recorded as accepted. Both now name the replacement being applied, and are refused if it has changed. An approver also lets go of a claim at once when nothing could be applied, rather than keeping everyone off it for two minutes, and a quote of nothing but whitespace is refused (SPEC §22).

- **A suggestion is never left behind on an old version.** Publishing checked for open threads before uploading the new version's bytes, and made it current after. A suggestion made in between stayed pending on a version nobody reads, and `update_document` did not check that its base was still current. Both publish paths now ask again in the transaction that makes the version current, and a suggestion is written in one that reads the current version (SPEC §6a, §22).

- **Only someone who may still suggest can change a suggestion.** Revising needed only authorship, so a suggester demoted to viewer could still rewrite the text an approver was about to apply, in the app or through an agent. Revising now needs the right to suggest; withdrawing does not (SPEC §22).

## 0.10.0 — 2026-10-08

### Added

- **`get_comments` reads an earlier version's threads.** A thread stays on the version it was opened on, so once a new version was published an agent lost sight of it, decided suggestions included, though any reader could open `/d/<id>/<version>` in the app. It now takes `version`, and `bikeshed comments --version v3` passes it (in `bikeshed-now` 0.13.0). Access is the document's; a version that does not exist is refused by name (SPEC §19).

- **An agent can change or take back its own suggestion.** `revise_suggestion` and `withdraw_suggestion`, and `bikeshed revise` and `bikeshed withdraw` (in `bikeshed-now` 0.13.0), act on its person's pending suggestions on the current version, wherever they were made. `POST /suggestion` now takes a token for `revise` and `withdraw`, which change only the caller's own pending proposal and erase nothing; `claim`, `accept` and `reject` still refuse one. A publish refused for a pending suggestion now says its author may withdraw it. There are fifteen tools (SPEC §2, §19, §22).

### Changed

- **Withdrawing a suggestion closes it instead of deleting it.** Its author's Withdraw deleted the suggestion and every comment under it, so what had been proposed, and the discussion of it, left the document's record. It is now kept as a closed thread: state `withdrawn`, resolved, with who withdrew it and when, and a "Withdrawn." note that reaches the owner and everybody who wrote in the thread, as "Accepted." does. It stops holding back a new version as before. The panel says "Withdrawn by …", and `get_comments` reports `state: "withdrawn"` (SPEC §22).

- **A suggestion keeps what it said before each change.** Editing a pending suggestion overwrote its text, and a new note overwrote the author's old one, so whoever decided saw only the latest form. Each change now keeps what it replaced in `suggestion.revisions`, with when and through which channel, where only the server writes. The panel shows "Changed N times" opening onto the earlier texts, `get_comments` returns them with their `via`, and `bikeshed comments` (in `bikeshed-now` 0.13.0) prints a `was …` line for each. A suggestion may be changed twenty times; after that, withdraw it and suggest it again (SPEC §4, §22).

### Fixed

- **Accepting a suggestion makes the change once, and says what it did.** Where the text beside the quote had changed since the suggestion was made, Accept put the change in the draft and then reported "nothing was accepted": the quote was found by either side of its context, and the result was checked for by both. Accepting again then called it stale, or, where the replacement keeps the quote ("X" becomes "Y, X"), inserted it a second time. The quote and the replacement are now found by one rule. The edit is checked by what the text must read afterwards, and an edit that comes out otherwise is undone before anything is said. A change already in the draft is recorded, not made again, and a stale suggestion no longer takes a claim that keeps everyone else off it. When only recording the decision fails, it says the change is in the draft and to accept again, where it said only "Failed to fetch" (SPEC §22).

- **The last words of a paragraph can be suggested on and accepted.** A quote that ended its paragraph was measured into the line break after it, so in rendered Markdown it was refused as spanning two paragraphs. That happened when the selection was dragged to the end of the line, and again on Accept, which the review bar still offered. The bar, and the comments panel in the editor, now call stale exactly what Accept would refuse, and judge again as the draft changes (SPEC §22).

- **A suggested deletion takes one space with it.** Deleting a word left the spaces on both sides of it, which the editor keeps visible as `&nbsp; ` and the next version kept for good (SPEC §22).

- **Rejecting in the review pass rejects the suggestion on screen.** A reason being typed stayed open when another approver decided that suggestion, or its author withdrew it, and the pass moved on: Enter then rejected the next one, with the reason written for the last. Enter also went through while a decision was in flight, and a rejection that failed lost its reason. The reason now belongs to one suggestion and is kept until the rejection goes through (SPEC §22).

- **The review pass moves on, and ends, as it should.** After a decision it went back to the first suggestion rather than the one after it, so anyone who skipped one met it again after every decision. Its last word was "Publish the result with Save as new version" whatever had happened, even after a rejection, or when the suggestions could not be loaded at all, or while open comments still kept Save greyed out. And an approver hovering over that greyed-out Save was told to find an approver (SPEC §22).

- **Save as new version publishes nothing when the draft did not save.** It checked for a failed save before saving one last time, and not after. A save that failed at that moment published the draft as it was before, and reported "Published". Once a save had failed, pressing it again only said to fix that, and the only fix was to type something. It now saves first every time, and publishes only if that save went through (SPEC §6a).

- **Somebody typing no longer resets the page under a reader.** Every autosave reloaded every reader's frame, about once a second while a co-editor typed, even a frame showing the published version, which a draft save does not change. Each reload dropped the reader's selection and any suggestion form they had open. Now only a frame showing the draft is brought up to date, and only once its reader has finished writing (SPEC §16, §22).

## 0.9.3 — 2026-10-08

### Fixed

- **`/llms.txt` counts thirteen tools, and says where `bikeshed login` signs in.** Since 0.8.0 it told an agent with only an HTTP client that it had "all twelve tools", four lines above a table of thirteen. It and the publishing skill said that `login` without `--origin` signs in to the CLI's default deployment; since `bikeshed-now` 0.12.0 it tries `BIKESHED_ORIGIN` and then the deployment of the last sign-in first. The guide now also names `bikeshed --version`, and says that a token can revoke itself with `POST /tokens`. The README and the verification walkthrough said twelve too. A test now holds every count of the tools these documents give to the number the server serves (SPEC §19).

## 0.9.2 — 2026-10-08

### Changed

- **`bikeshed login` no longer asks which deployment** (in `bikeshed-now` 0.12.0). In a terminal it stopped at `Deployment [https://bikeshed.now]:` before signing in. It now uses `--origin`, then `BIKESHED_ORIGIN`, then the deployment of the last sign-in, then `https://bikeshed.now`, the same order as every other command, and its first line says which. `login --paste` reads only the token from stdin. Without `--origin` it used to read the first line as the address, so a piped token was taken for one and printed back inside the `/account` link. A script that piped the address first should pass `--origin` instead.

## 0.9.1 — 2026-10-08

### Added

- **`bikeshed --version`** (in `bikeshed-now` 0.11.0). It prints which version is installed, and `--help` now opens with the same number. Both come from the package itself, as does the client name the CLI reports to the server, so a release can no longer bump one and forget the other. After `fork`, `--version` still names the version of a document to copy.

## 0.9.0 — 2026-10-08

### Added

- **`bikeshed logout`** (in `bikeshed-now` 0.10.0). It signs the computer out. A token from browser sign-in is revoked on the deployment and deleted, because it exists for that computer alone. A token pasted in with `--paste` is only deleted, since CI may use the same one, and the command says where to revoke it. `BIKESHED_TOKEN` is never touched. Against an older deployment the token is deleted and the command says it still works until revoked at `/account`.
- **A personal token can revoke itself.** `POST /tokens` with `{"op": "revoke"}` and the token as its bearer ends that token and nothing else. Creating and listing tokens still need a browser session, so a leaked token cannot mint another or list the rest.

### Fixed

- **`bikeshed --help` no longer ends with a note meant for the project's maintainers** (in `bikeshed-now` 0.10.0). It told everyone who ran it that the repository's `scripts/` were operator tools that could tear a deployment down. Nobody who installs the package has those scripts, so the paragraph explained nothing they could use.

## 0.8.1 — 2026-10-08

### Fixed

- **The guides show agents starting comment threads, not only answering them.** The user guide's review lanes said people comment and agents suggest edits, and its example of what an agent picks up showed an agent only replying in a person's thread. Both now show an agent opening a thread on a passage. The developer guide's loop says that `add_comment` and `bikeshed comment` let a reviewing agent leave feedback that the next agent picks up. A whole command in a list now wraps at its spaces instead of running off a 400 px frame.

## 0.8.0 — 2026-10-08

### Added

- **A user guide at `/docs`, and a guide for developers at `/docs/developers`.** Each redirects (`302`) to a public document published from `content/`, so the guides are read in the viewer and take comments like any other document. The user guide explains the product in plain words and names no command, and says plainly that any connected agent can pick up the comments, from people or from other agents, reply, and publish the next version. The developer guide holds the rest: connecting an agent, the command line, the loop with the calls that run it, the agent tools, formats and limits. A **Docs** link sits in the header on every page and in the landing page's footer. A deployment that has not published a guide answers its shortcut with "Not here" (`docs/operations/overview.md`; SPEC §2).
- `check:content` keeps both guides free of scripts, their chapters anchored by id, and out of the slide navigator. The skills drift test now reads HTML `<code>` too, and checks every command and tool the guides name.
- **Agents can start a comment thread.** Until now an agent could only reply to a thread a person had opened, or propose an edit. `add_comment`, and `bikeshed comment <id> <passage> --body <text>`, open a thread on a passage of the current version, found the way `suggest_edit` finds one: quoted as a reader sees it, within one paragraph, with a `prefix` or `suffix` where it repeats. Anyone who can read a document can comment on it, as in the browser, and the thread is marked as an agent's. Only a person resolves it, and until then it holds back a new version saved in the app, as any thread does. The viewer highlights an agent's comment only where its exact words stand: a passage whose source wraps a line is highlighted whole, and one it cannot find is listed as orphaned rather than highlighted somewhere else (SPEC §6, §19).

## 0.7.0 — 2026-10-08

### Added

- **Apps connect by signing in.** Paste a deployment's `/mcp` address into Claude (web, Desktop, mobile or Code), ChatGPT, Cursor or VS Code. A browser window asks you to sign in if you need to, says which app is asking and where it will send you back to, and asks you to approve. Nothing is copied by hand. The deployment is its own OAuth 2.1 authorization server: it advertises itself from the `401` that `/mcp` answers, identifies Claude, ChatGPT and Claude Code by their published metadata, and lets other apps register without storing anything. A connected app gets a one-hour token that works on `/mcp` alone, renewed by a refresh token that rotates on every use and lapses after 90 days unused. Whether the account may still connect is checked again at every renewal, so disabling it, changing its address or "sign out everywhere" ends the connection within the hour. A connected app is listed under Access tokens and disconnected with the same Revoke button. New endpoints: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` and `/oauth/consent`, served by two new functions, `oauth` and `oauthConsent` (SPEC §2, §23; ADR 0014).
- **A consent page at `/connect`.** It shows who is asking: a verified host for Claude, ChatGPT and Claude Code, and otherwise the address you will be sent back to, with the app's own name marked as unchecked. It warns when that address is a program on your computer, lists what the app can and cannot do, and names the account it will act as, with a way to switch. The request is taken out of the address bar before anything else can read it, and survives signing in. The page refuses to run inside a frame, and Approve stays disabled until the page has had your attention for a moment. It never sends you anywhere you did not press a button for (SPEC §23).
- **"Connect an app" on the account screen.** The address to paste, with a copy button and the steps for Claude, ChatGPT, Claude Code, Cursor and VS Code, and the command for a terminal. Connected apps appear in the Access tokens list as apps, with the host they came from and when they were last used, and Revoke disconnects one. The landing page's "copy for your agent" text now asks for a connection rather than a token.
- **Each skill is a download, for Claude's skill upload.** `/skills/<name>.zip` holds `<name>/SKILL.md`, packed from the copy the deployment serves after its address is filled in, and is linked from the account screen. `/skills/index.json` names it as `archive`. The predeploy check refuses a zip that differs by one byte from the file beside it, and the skills are held to Claude's limits on names and descriptions (SPEC §23).
- **`bikeshed login` signs in through the browser.** It prints an address, opens it, and waits up to five minutes for you to approve; the token it receives is an ordinary personal access token, saved as before. It needs no terminal of its own, so an agent can run it for you. `--paste` keeps the old way, for SSH and for deployments older than this one; in CI it stops at once and says to set the two variables (in `bikeshed-now` 0.8.0).

### Changed

- **`/mcp`'s `401` now says where to sign in.** It carries `resource_metadata`, adds `error="invalid_token"` when a credential was presented, exposes the header to browser clients, and is never cached. Personal access tokens work exactly as before.
- **`/.well-known/mcp.json` describes signing in first.** Its `authentication.type` is `oauth2`, with the protected-resource and authorization-server paths, and a personal token listed under `alternatives`.

### Fixed

- **`bikeshed open` crashed on Windows.** It ran `start`, which is a `cmd.exe` builtin rather than a program, and had nothing listening for the failure. It now opens the link the way `login` does (in `bikeshed-now` 0.8.0).

## 0.6.5 — 2026-10-08

### Changed

- **Cloud Functions run on Node 24.** Google retires the Node 20 runtime on 2026-10-30, and from then on no functions deploy succeeds. Node 24 is the current long-term-support line, and Cloud Functions supports it until 2028. Every function redeploys on the first deploy after this release, because the runtime is part of each one. Development and CI moved with it: `.nvmrc`, both workflows and the contributor docs now say 24. The source tree accepts Node 22 or later, since Node 20 reached end of life in April.
- **The workflows' own actions run on Node 24 too.** `checkout`, `setup-node` and `setup-java` moved to newer major versions. The old ones ran on Node 20, whatever Node they installed for the build.
- **`bikeshed` needs Node 22 or later** (in `bikeshed-now` 0.7.0). Node 20 reached end of life on 2026-04-30, and CI no longer tests the CLI on it. On Node 20, npm now warns at install time that the package does not support it.

## 0.6.4 — 2026-10-08

### Added

- **Every push to `main` that passes CI now deploys production.** A new workflow, `deploy.yml`, runs the existing checks and then deploys functions, the security rules and indexes, and hosting, in that order. It then deletes any function the release removed, and checks that the live site serves the build it just made. The rules used to be a separate manual step, and 0.6.0's never went live. The deploy signs in to Google without a stored key, and only a workflow running on `main` can sign in at all. Before it does, it refuses a build configured for another project or for the emulators, a build never stamped with its address, and functions given a different address. Setting `DEPLOY_PAUSED` holds it for a migration that needs another order. Setup is under "Continuous deployment" in `docs/operations/overview.md`. `develop` runs CI only until a staging project exists.

### Fixed

- **A CI check for unstamped agent instructions could never fail.** The step that builds with a test origin ended with `! grep … app/dist`. Bash's `-e` ignores a negated command, so a build still holding a `<deployment>` placeholder would have passed. It is now an explicit test that exits non-zero. Today's build has no placeholder left, so the check passes on its merits.

## 0.6.3 — 2026-10-08

### Fixed

- **Editing a Markdown document no longer breaks its scripts, stylesheets or text boxes.** The first save after an edit anywhere in the document put a raw HTML `<script>` onto one line, so a `//` comment swallowed the code after it and the script stopped working; turned an author's `<style>` into a paragraph of visible CSS; squeezed a `<textarea>`'s value; and ran such blocks together on one line. Every later save kept the damage. Their text now comes back exactly, each on lines of its own. The first save also joins a paragraph wrapped across several lines into one line, which it always did and which is now documented (SPEC §11).
- **A new suggestion reaches the owner and approvers even right after a comment email.** Both kinds of email shared one thirty-minute limit per person and document, so a comment email held back the notice of a suggestion that was blocking the next version. Suggestions now have a limit of their own, so a burst of them is still a single email. Expired entries in that limit are now also cleared from the account record, as was always intended; they had been kept, because the write merged maps key by key (SPEC §14).

## 0.6.2 — 2026-10-06

### Fixed

- **Opening the editor and closing it again no longer makes a draft.** Leaving edit mode saved the document whether or not anything had changed, and any save creates a draft — which every editor then reads instead of the published version, until somebody publishes. Leaving now saves only an edit the autosave has not already taken. "Save as new version" still saves first, always (SPEC §6a).
- **An editor who opens an older version sees that version.** With a draft in progress, every version an editor opened showed the draft instead, under the older version's label. The draft is now shown only on the published head, which is the version it is built on (SPEC §6a).
- **Unpublished edits say they are unpublished.** An editor reading a document with a draft was shown the draft under the published version's label, with nothing to tell the two apart. A banner now says the page is unpublished edits, who saved them last and when, and that everyone else still sees the published version; the label reads `v1 · draft`, and Edit opens the editor where they can be published (SPEC §6a).
- **An editor can suggest while reading unpublished edits.** "Suggest edit" was withheld from anyone who could edit whenever a draft existed, on the reasoning that they could simply edit. It is now offered whenever reading the published head or its draft, so proposing a change for somebody else to decide is a choice an editor can always make, and editing stays one click away (SPEC §22).
- **A deck that scales itself fits in the editor.** Many decks size their slides with their own script, and the editor never runs a document's scripts, so there the slides rendered at full size and the left part of every slide sat off the edge of the frame where nothing could scroll to it: text there could not be edited, and a suggestion there could not be seen in the review pass. While editing, the frame is now laid out at the width the slides need and scaled to fit, so whole slides show as they do when reading (SPEC §6a).
- **The review pass shows its first suggestion.** It marked the first target as soon as the editor opened, and on a document edited before, joining the live session a moment later rebuilt the page underneath, so that mark vanished and the first suggestion showed nothing. It now waits for the session, as Accept already did (SPEC §22).

## 0.6.1 — 2026-10-06

### Fixed

- **Comment and suggestion emails reach people who signed in with an already verified address.** Every email that names a person finds them through their account record, and only the email-code sign-up and the account screen created one. Anyone who signed in with Google or GitHub and never changed a preference had none, so they were never told about a comment on their document, and since 0.6.0 an approver was never told about a suggestion waiting for them. Signing in now writes the record, keeping any preference already saved, and the next email finds them (SPEC §2, §14).
- **Escape closes a deck's slide overview.** The overview opened with `o` or its toolbar button could only be closed with the mouse or `o` again; Escape did nothing, although the code meant it to. With the overview shut, Escape is left for presentation mode and everything else, as before (SPEC §6d).
- **Two sample documents say what they do.** `deck-quarter-review`'s chart sized itself with `height="auto"`, which is not a valid SVG attribute and logged an error wherever the deck was shown; it is now CSS, and renders the same. `markdown-reference` lists every change its first save makes, including the one it left out: Markdown inside a raw HTML block comes back as the HTML it renders to.

## 0.6.0 — 2026-10-06

### Added

- **Two more roles: "Can suggest" and "Can approve".** Access now has four levels. Each one can do everything the one below it can. A suggester can read a document and propose edits to it for someone else to decide on. An approver can edit, and also accept or reject other people's suggestions. A role can be granted on a document, a folder or a team, and it is inherited the way reading and editing already are. The share dialog offers all four, with one line on what the chosen role allows, and lists people under the highest role first. `POST /access`, `POST /folder-access` and `set-access.mjs --role` accept both new roles, and an invitation says what the role allows (SPEC §13, §18).
- **Suggested edits.** Anyone who can suggest selects text and proposes what it should say instead, or that it should go. The owner and approvers are emailed, and an approver accepts or rejects it in a review pass in the editor, one suggestion at a time. Accepting makes the change in their own editing session, so it reaches co-editors like any keystroke and lands in the draft, saved before it is recorded; a person still publishes it. Rejecting can say why. The suggester hears either way, in the thread. A suggestion is text inside one block, never formatting or structure, and a pending one can be changed or withdrawn by its author. In the document a pending suggestion is the struck-through text followed by what it would become; in the comments panel it reads as its change and its state. One whose text has since changed says so and can only be rejected. `POST /suggestion` is the one path that writes them (SPEC §2, §4, §14, §22; ADR 0013).
- **Agents can suggest edits too.** A twelfth MCP tool, `suggest_edit`, proposes new text for one passage, quoted as a reader sees it. It is refused, with what to do instead, when the passage is not there, repeats with nothing to tell the copies apart, or spans more than one paragraph. An agent cannot accept or reject a suggestion, its own included. `get_comments` shows each suggestion's change and state, `get_document` says whether the caller may suggest, and `update_document` from someone who may only suggest names `suggest_edit` (SPEC §19, §22).
- **`bikeshed suggest`** does the same from a terminal, and `bikeshed comments` prints each suggestion's change and state under its quote (in `bikeshed-now` 0.6.0).
- **A pending suggestion holds back every new version, on every channel.** Publishing in the app, uploading a revision, `bikeshed update` and `update_document` are all refused with a `409` while a suggested edit on the current version is waiting for a decision, and the message says that only the owner or an approver can make it. An identical update is still a no-op. The operator's `publish.mjs` still publishes, and warns how many it leaves behind (SPEC §6a, §9).

## 0.5.2 — 2026-10-06

### Fixed

- **Stored thumbnails no longer take on the capturing editor's dark mode.** A document with its own dark palette was captured dark whenever the editor who happened to capture it ran their system dark, and every member was then shown that. Captures now show every document as a reader who prefers light sees it. A document that is dark by design stays dark. Thumbnails stored the old way are replaced the next time an editor's workspace or viewer shows them (SPEC §6d).

## 0.5.1 — 2026-10-06

### Changed

- **An owner's expired documents get covers too.** An expired document stays readable to its owner, but its card kept a placeholder for good, because no thumbnail was ever stored for it. The owner's browser may now capture and store its cover and rail; nobody else is shown them, and nothing else about an expired document can be written (SPEC §17).

## 0.5.0 — 2026-10-06

### Added

- **The workspace fills in covers nobody has captured.** A document only got a cover when an editor opened it, so everything published before covers existed showed a placeholder until somebody did. An editor's workspace now captures the missing covers of the cards it shows, in the background, one at a time, from each document's published first screen. A document whose readers all run its scripts still waits for an editor to open it, and an expired one is never captured (SPEC §6d).

### Fixed

- **Stored thumbnails draw SVG artwork in its own colours.** Shapes inside an `<svg>` that take their colour from the page's stylesheet came out black in a captured cover or rail image: a sheet of logo marks, each drawn on a tile coloured by a class, captured as a grid of black squares. The live previews were always right; only the stored images were wrong (SPEC §6d). Images stored by the earlier capture are replaced the next time an editor opens their document, rather than lasting until its next version (SPEC §2, §4).

## 0.4.0 — 2026-10-05

### Added

- **Every workspace card shows what its document looks like.** A card leads with a cover: a deck's first slide, or any other document's first screen. It is captured once per version in an editor's browser, the first time one opens the document, and stored, so every member sees it on every device without it being rendered again; a member's browser keeps it for a day. Folders move to a row of their own above the documents (SPEC §2, §6d).
- **A published deck's slide rail loads from stored images.** One request per slide, kept by the browser, instead of every slide's assets fetched again on every visit. Editing and drafts keep live previews, and an image that will not load falls back to one.

### Fixed

- **Animated decks no longer preview blank.** A deck that shows a slide's content only once its script marks the slide active previewed every slide but the current one as an empty page, and bars or charts that grow in as empty. Previews now show each slide as it ends: animations finished, the deck's own "active" class applied, and anything still hidden revealed.
- **Comment highlights no longer appear in slide previews.** Highlighted text showed in the browser's default yellow on every commented slide's thumbnail.

## 0.3.1 — 2026-10-05

### Fixed

- **A document you trusted for yourself opens once, with its scripts running.** The viewer started every reader as untrusted and did not wait to hear otherwise. Whenever the document arrived before your own grant, which an unlisted link makes likely because the two come from different services, it loaded sandboxed, blocked its scripts, logged "Blocked script execution", and then loaded again. The first load now waits for your answer. It waits only when the answer could change something, never on sign-in, and for at most 1.5 seconds, after which it behaves as before. A frame you are already reading is never taken away (SPEC §6c).
- **Signing out forgets a grant you made.** The grant was not tied to the account that made it, so it kept the document unsandboxed after sign-out or a switch to another account.
- **The trust prompt waits until it knows what you already decided**, so a reader who trusted a document is not asked again while their answer loads.

## 0.3.0 — 2026-10-05

### Added

- **`bikeshed fork` and `bikeshed lineage`** (in `bikeshed-now` 0.5.0). `fork` takes an id or a link, and `--version`, `--folder` and `--title`; `lineage` prints what a document was forked from, nearest first, and for its owner its forks. `bikeshed list` marks a fork with ⑂.
- **Fork replaces Duplicate, and remembers where it came from.** A fork is your own private copy of a version of any document you can read: from the workspace card, the viewer's toolbar and menu, `bikeshed fork` and the MCP tool `fork_document`. Agents and the CLI read lineage too: `get_lineage` and `bikeshed lineage` give the panel's answer, and `list_documents` and `get_document` say which documents are forks. A signed-out reader who presses Fork signs in and comes back to the fork. The fork links to its original, one hop at a time and only as far as the reader could open, and says when the original has changed since. The original's owner sees how many forks there are and the ones they can open, never who made one they cannot. Which document a fork came from is kept where no client can read it, because a docId is the slug of a title (SPEC §21).

### Changed

- `POST /duplicate` is now `POST /fork`, and a copy's `v1` records `publishedVia: "fork"`. Copies made before this keep `"duplicate"` and have no lineage.
- A fork's export marking is its new owner's account default, as for any new document (SPEC §20). Duplicate had always turned it off.
- A folder you cannot add to is refused when forking into it. Duplicate filed the copy at the root instead, silently.
- `/signup` returns a signed-in reader to `?next=` when that is a path on this site, rather than always to the workspace.

## 0.2.1 — 2026-10-04

### Fixed

- **An unlisted document's link opens on a phone without waiting for sign-in.** The viewer read nothing until auth had decided who was asking, and presented the link's key only after Firestore refused the member record. On every mobile browser and Safari, Firebase Auth loads Google's sign-in script before it reports anyone, and Firestore waits for Auth, so while that script stalled the link sat on "Opening the document" indefinitely. Desktop Chrome skips that step, and opened the same link at once. A key holder now asks `/unlock` straight away, and is asked again under their account once auth decides (SPEC §17).

## 0.2.0 — 2026-10-02

### Security

- **A trusted document no longer trusts what somebody else writes into it.** Trust carried from version to version unconditionally, on the claim that in-app editing cannot add a script. The server never held that line: `/draft` stores whatever HTML a caller with `canEdit` sends, and `update_document` takes any content. On a trusted document with open editing, any signed-in account could commit a `<script>` that then ran in every reader's session, same-origin with the app. Now only a version the owner wrote in the app keeps trust. Any other new version, an editor's, an open editor's, or any update through a token, withdraws the owner's trust and every reader's own in the transaction that makes it current (SPEC §6c). A deduplicated update keeps them. The cost is that a collaborator's edit to a trusted interactive document has to be vouched for again.

- **An unlisted document needs its link, everywhere.** Before this fix, "unlisted" meant "readable by anyone who guesses the id". The key was checked on three byte paths, and everything else treated unlisted as public:
  - Anyone could list `public/` and read every unlisted document's id, title and publish time.
  - Opening one without the key drew its title, version and controls around an empty frame.
  - Any account could read and write its comments, read its whole source through `get_document`, and duplicate it.
  - Any account could edit it through the realtime log when open editing was on.
  - `/view` and the write endpoints confirmed that it existed.

  Now, without the key, it is indistinguishable from an id that does not exist (SPEC §17, [ADR 0012](docs/architecture/adr/0012-unlisted-needs-its-link.md)):
  - `public/` holds public documents only, and can no longer be listed.
  - Unlisted readers get their fields from a new `POST /unlock`.
  - A signed-in link holder gets a link grant, which lets them comment and lapses when the link is rotated.
  - `get_document`, `update_document`, `get_comments` and `reply_to_comment` take an optional `k`, and the CLI accepts the link itself in place of an id (in `bikeshed-now` 0.4.0).
  - Link holders on an unlisted open-editing document edit through the draft endpoints, not the live log.

  **Operator action:** deploy functions, hosting, then rules, and run `scripts/reconcile-visibility.mjs` once, in the order [`docs/operations/overview.md`](docs/operations/overview.md) gives.
- **Only a document's editors may move it.** `/organize` and `move_document` gated a move on open editing. So any account could file someone's open-editing public document into its own folder, which made it a member, with the member list and the reading statistics.
- **Write endpoints answer 404, not 403, to anyone who may not read the document.** The 403 confirmed that a private id existed.

### Added

- **The instructions say what a document may contain.** `/llms.txt`, the publishing skill and `bikeshed --help` (in `bikeshed-now` 0.4.0) now list the formats a deployment takes and what renders, runs and loads in each. An agent had been left to guess, and the natural guesses were wrong. Mermaid, math, footnotes and YAML front matter show as typed. External images and fonts load; they were never blocked, only discouraged. Scripts, handler attributes, `target="_blank"` and forms stay off until a person trusts the document: its owner for everyone, any reader for themselves. The sandbox rows were checked in Chromium against the viewer's iframe attributes, and the Markdown rows against the pinned renderer.
- **`bikeshed update` revises a `.zip` bundle** (in `bikeshed-now` 0.4.0). It sends the archive as bytes to `POST /publish?update=<id>`, which publishes a new version of that document with the archive as its whole bundle. That needs an editor of the document; open editing is not enough (SPEC §2).
- **A publisher can choose a document's address.** `POST /publish` takes `id`, `publish_document` takes an optional `id` (a schema addition), the CLI takes `--id` (in `bikeshed-now` 0.3.0), and the upload dialog has an Address field. It was previously always derived from the title, so two documents with one title could only be told apart by a counter. The id has to be what `slugify` would produce, lowercase letters, digits and inner hyphens up to 60 characters, and anything else is a `400` before a byte is stored (SPEC §4).
- **The terminal client is on npm**, as `bikeshed-now`, providing the `bikeshed` command: `npm i -g bikeshed-now`, or `npx -y bikeshed-now` for one call. It was previously reachable only by cloning this repository, which made every `bikeshed …` line in the agent instructions unfollowable for anyone who had not. Three files, no dependencies. [`docs/operations/publishing-the-cli.md`](docs/operations/publishing-the-cli.md) is the release recipe. The root package is renamed `bikeshed-now-source` so the published name belongs to the thing that is actually published.
- **`bikeshed list --all`** (in `bikeshed-now` 0.2.0) prints every document you can read, following the cursor itself, 50 rows a request. `--json` keeps the shape of a single page, so a script needs no second parser.
- **A publish result says where to read the document.** `publish_document` and `update_document` return `url`, and the CLI's `--json` carries it too. An agent over MCP cannot derive it — the origin is in its client's configuration, which the protocol never shows it — so it had nothing to hand back but an id.
- **Agents can organise a workspace.** Three MCP tools — `list_folders`, `create_folder`, `move_document` — and the CLI commands `folders`, `mkdir` and `mv`. Filing a document was previously something only a person could do, which meant an agent either dropped everything at the root or waited for somebody who was not there.
- **Three packaged skills**, in the Agent Skills convention, served by every deployment at `/skills/` and installable with `bikeshed skills install <dir>`: `bikeshed-publishing`, `bikeshed-feedback`, `bikeshed-folders`. `llms.txt` is the short form every agent reads; a skill is the long form, loaded for the task that needs it. Generated into `app/public/skills/` by the same build step that produces `AGENTS.md` and `llms.txt`, and byte-compared by `check:agents`.
- `functions/test/skills.test.js` holds those documents to the surface they describe: every `bikeshed …` command and every tool name they mention must exist, and — the direction that matters more — every tool and command that exists must be named in `docs/agents/agent-guide.md`. A skill naming an absent command is worse than no skill, because an agent believes it.

- **Documents can carry an optional expiry.** The owner sets a date in Share; after it, the document is read-only and readable only by them. It is **not a deletion date** — this product does not delete documents, so the bytes, versions, annotations and comments all survive and clearing the date restores everything. The interface says that in those words, because "expire" reads as "delete" to most people.

  It is deliberately **not in the security rules**: the workspace `list` rule must stay statically provable from its query (SPEC §5), and a query cannot filter on a field most documents lack without dropping every document that lacks it. So the record stays readable and the content stops being served, which is sufficient because every byte already flows through one function. The consequence is stated rather than discovered: a member still sees the row and its title.

  Two details that are decisions. The public cache window is capped at the time remaining, so an expiry — unlike a revocation — is never served stale. And nothing deletes the `public/{docId}` projection at the moment itself, because there is no scheduler here; it carries the date instead, so an anonymous reader is told rather than shown an empty frame.

- **A shared link unfurls as the document.** `/d/**` is now served by a function, `docShell`, that injects the document's own `<title>`, description, keywords and image into the app shell — read from the uploaded HTML at request time, no parser, no new dependency — for a document that is readable anonymously: public, or unlisted with its link token in the URL. A link pasted into Slack, iMessage or LinkedIn shows the document rather than the product (SPEC §17 "Link previews"). Everything else gets the generic shell, and a private slug and an absent one answer with the same bytes. A document that declares no usable image gets a branded default card.

  Two operational consequences. Deploying it needs **functions and hosting both** — the function, and the `firebase.json` rewrite that routes to it — and `BIKESHED_PUBLIC_ORIGIN` is now load-bearing for every document page, because the shell is fetched from Hosting at runtime ([ADR 0011](docs/architecture/adr/0011-document-page-through-a-function.md)).

### Fixed

- **`bikeshed get` printed a long document's first 200,000 characters as if they were all of it** (fixed in `bikeshed-now` 0.4.0). `get_document` cuts a source at that length, to keep it from filling an agent's context, and sets `truncated`. The CLI ignored the flag and exited 0, so a page with a heavy `<head>` came back with no `<body>`, and an update made from that copy published a version missing the rest. `get` now reads a cut source whole from `/content`, and prints nothing if it cannot. `get_document` puts `truncated` ahead of the source, and its description says where the cut falls (SPEC §19).
- **A reader without an account saw an unlisted bundle without its images.** The viewer carried the link's key as `?k=` on the entry, and a query string belongs to one URL: every image and stylesheet the entry names by relative path was requested without it and answered 404. The key now rides in the content path, `/content/~<k>/<docId>/<versionId>/…`, which every relative reference inherits; `?k=` is still accepted. The slide thumbnails, the print export and the three downloads carry it too, and had the same fault (SPEC §2, §17).
- **A link out of a document replaced it inside the viewer.** A plain link navigated the document's frame to somebody else's page, often a refusal to be framed, and `target="_blank"` did nothing at all, because a sandboxed frame may not open a tab. A link that leaves the version now opens in a new tab from the viewer, and the document stays. A link to a passage, or to another file of the same bundle, behaves as before (SPEC §6).
- **Revising a bundle through a token dropped its images.** `update_document`, and so `bikeshed update` with one file, built the new version from the sent file alone, so every stylesheet and image beside a bundle's entry 404ed from its first revision on. The in-app commit had always laid the edit over the base version's files. Both token paths now go through one `reviseDocument` that does the same: one file replaces the entry at the base version's own path, a `.zip` replaces the bundle, and the format cannot change. A version that already lost its files keeps what it holds, and a one-file update carries forward only that; `bikeshed update` with the whole `.zip` repairs it.
- **`bikeshed update` corrupted a `.zip`** (fixed in `bikeshed-now` 0.4.0). It read the archive as UTF-8 and sent the text through `update_document`, so every byte above `0x7f` became U+FFFD and the deployment answered with adm-zip's `Invalid CEN header`.
- **A damaged `.zip` was a 500.** adm-zip parses the central directory lazily, so an archive that passed its constructor threw from `getEntries()`, outside the guard. It is now refused as `could not read the .zip archive`.
- **Two creates at one id could overwrite each other's bytes.** A new document's files are stored before its record, so two publishes (or duplicates) that picked the same id both wrote to its `v1`, and the loser replaced the winner's bytes, which the version record promises never change, before failing with a `500`. New-document writes are now create-only, and a refused write moves the document to a suffixed id.
- **`bikeshed list --cursor` returned the first page again** (fixed in `bikeshed-now` 0.2.0). The CLI printed the cursor, parsed the flag, and never sent it, so nothing past the newest page was reachable from the terminal. `--limit` and `--cursor` are now in `--help`.
- **The instructions said a token publish was trusted.** It never was: `publishNewDocument` writes `trusted: false` for every path a personal access token can reach, and only the operator script publishes trusted. The guide, the publishing skill, the spec and the threat model now say so, and a test refuses the claim in any agent-facing document. A raw `<script>` in Markdown is sandboxed exactly like one in HTML.
- **The lock, eye and globe on the visibility options were a few pixels wide.** Each icon sat in a flex row beside a sentence, and the flex algorithm took the sentence's width out of the icon — five to eleven pixels of an eighteen-pixel mark. The icon no longer shrinks; the sentence wraps.

- **Setting an expiry crashed the function under the emulator.** One line reached `Timestamp` through `admin.firestore`, whose static namespace the Functions emulator's proxy drops — the same defect `FieldValue` had, in the same file, and invisible to every unit test because it is fine in production. `Timestamp` now comes from `firebase-admin/firestore` too, and `wiring.test.js` pins the shape so a third class cannot go the same way.

- **A reader of a public document who was not a member was never told about its expiry.** The `public/{docId}` projection carries the date for exactly that purpose (SPEC §17: "the reader is told rather than shown an empty frame"), and the viewer never read it — it looked only at the member record. The expiry chip reads whichever record the reader has.

- **"Print or save as PDF" overrode the document's own page layout.** The export appended an `@page` margin rule of its own after the document's styles, and `@page` cascades by order: a deck sized for its slides lost its zero margins and printed every slide across two pages, and every document lost the margin choice in the print dialog, which Chrome ignores once CSS has set one. The rule is gone — the document, or the dialog, decides. The marking stamp now goes first in the body rather than last, because anything after a document's final forced page break opened a blank page carrying nothing but the stamp.

- **Printing a document page printed the app.** Cmd+P produced the header, the toolbar, the comments column and the document clipped to its on-screen box. The shortcut now goes to the same export as "Print or save as PDF" — the document alone, scrubbed and stamped — and it is heard with the focus inside the document, where it usually is. File → Print, which no event can redirect, prints the page with the chrome hidden and the frame opened to the document's full height so it paginates, and puts the reader back where they were afterwards. That path carries no stamp; nor does the content URL the same reader can already open.

- **A banner pushed the document to the bottom of the page.** The viewer grid had one row for the toolbar and one for the document, so whenever a banner appeared — a newer version, an expiry, a conflict — it took the document's row, stretched to the whole height with its bottom border as a stray rule across the page, and left the frame a 150px strip underneath. The grid now has a row for the banners, empty and free when there are none, and the document is pinned to the last row rather than placed by its position among its siblings.

- **Publishing a version announced it to the person who published it.** The "newer version" banner fired on every change of the current version, including your own commit, and offered "Open v4 / Stay here" over a frame already showing v4 — the same for any reader with no version pinned, whose frame already follows. It now appears only when the viewer is showing an older version, and clears by itself once that reader opens the new one.

- **Selecting text on a click-driven deck advanced the slide.** A drag that selects a passage ends in a `click`, and a deck whose own script advances on click — the common hand-made shape — took it, hiding the very slide the reader was about to comment on. Clicking a highlight did the same: the thread opened in the panel while the deck moved off it. Both clicks are now stopped before the document's own scripts see them — a capture-phase listener on the frame window for the selection, the highlight's own listener for the mark — and only those. The selection test is what the gesture did, not whether text is selected: a click that dismisses a selection, or one made while a selection sits stranded on a slide the keys moved off, is an ordinary click and the deck gets it as before. It is propagation that is stopped, never the default action, so a link still navigates (SPEC §6).

- **The slide rail had no layout container, so it stacked on top of the document.** `.doc-frame-wrap` was a plain block, and the rail was rendered as a normal-flow sibling of a full-width iframe — so above 860px the rail sat above the document, grew to the height of every thumbnail it held (nothing bounded it, so its own `overflow-y` never engaged), and pushed the frame out of view. Below 860px the rail is `position: fixed`, which is why only wide windows were affected and why the mobile drawer looked fine. The wrapper is now a grid whose rail track is `auto`, so it collapses to nothing when there is no rail rather than stranding an empty band — the failure `.viewer-body` already carries a comment about.

- **Slide thumbnails were rendered without the CSS that shapes them.** A preview emitted the slide alone as the only child of `<body>`, discarding every ancestor its stylesheet is written against — a deck that gets its width from a container rule rendered full-bleed, and one built as `<svg><foreignObject><section>` lost its layout entirely. The box was still sized from the live, correctly-styled frame, so the contents filled a fraction of it and the rest was the reported whitespace. Previews now reproduce the ancestor chain, and `html` and `body` keep every attribute rather than only `class` — `dir="rtl"` alone flips a deck.

- **Previews flattened the slide they were previewing.** The override forced `position: static`, `inset: auto` and `margin: 0`, which turns `position:absolute; inset:0; display:grid; place-items:center` into shrink-wrapped content in the top-left corner. Only visibility is forced now; `display` and `transform` move only where the live document shows that is what hides the slide, and the layout properties are never touched.

- **Every thumbnail was a different height.** Each was measured from its own slide and clamped, so the rail was a ragged column and the overview left a band of dead space under every short card — a grid row is as tall as its tallest item. All previews in a deck are now laid out at one size, the reader's own frame viewport, which also means a deck that re-flows at a breakpoint is previewed at the width it is being read at.

- **The thumbnail width was declared twice, in two languages, and disagreed.** The rail's CSS left a 131px content box against a hardcoded 132, and the overview's cards were pinned to 236px inside `minmax(236px, 1fr)` columns that are wider, leaving dead space beside each one. CSS is now the only owner and the thumbnail measures its own box.

- **The slide navigator appeared for anything with two sections.** It is now shown only for a document whose slides measure about one viewport tall — the signal the arrow keys already used. A long article no longer gets a rail of illegible prose thumbnails, each of which cost a function invocation. The measurement is latched per load, because opening the rail narrows the frame and an unlatched answer makes the viewer oscillate.

- **The rail did not follow the reader**, so on a long deck the highlight walked off the bottom and stayed there; and a slide dragged in edit mode gave no indication of where it would land, though the rail had styled a drop target since it was written and nothing ever set it.

- **The overview took focus to the first slide, not the current one.** `querySelector('[aria-current="true"], button')` returns the first element matching *either* in tree order, which is always card one.

- **The tour rendered blank when its scripts were blocked.** Its fifteen sections started at `opacity: 0` and were revealed by a class the inline script adds on scroll, so with scripts blocked none of them ever appeared — measured in a sandboxed frame, 0 of 15 were visible. That is the state the file is most often read in, and it is the sample that exists to demonstrate the trust prompt, so it was demonstrating the bug instead. Its own header comment claimed the opposite. The fade is now opted into by a class the script adds once it knows it can finish the job: 15 of 15 visible.

- **Leaving fullscreen left the app in presentation mode.** Nothing listened for `fullscreenchange`, and neither Escape nor F11 clicks the Exit button, so the header, toolbar, banners and comments panel all stayed hidden with a 35%-opacity button as the only way back.

- **The trust banner promised content to readers looking at nothing.** A deck that generates its slides at runtime ships an empty container, so "parts of it may look empty" described a page that was entirely empty. The viewer now tells those two states apart and says which one it is.

- **The functions, cli and rules suites never ran in CI.** Their scripts passed a quoted glob to `node --test`, which means node expands it rather than the shell — and node only learned to do that after 20. Development happens on node 22, where it works; CI pins node 20, where `node --test` reported `Could not find .../test/**/*.test.js` and exited non-zero having run nothing. The globs are now unquoted and single-level, which the shell expands on every version. Confirmed against node 20.19.3: 157 functions tests and 19 cli tests, where the old form found none.

- **The app suite asserted against whatever configuration a machine happened to have.** Vitest loads `app/.env.local`, which is gitignored, so the suite passed on a developer machine that had copied it and failed on a fresh clone that had not: `firebase.ts` calls `initializeApp` at module scope, throws `auth/invalid-api-key` without a key, and took `analytics`, `Landing` and `viewer/invariant` down with it at import time. The test environment is now pinned to the `app/.env.example` values in `vite.config.ts`, so the suite is hermetic either way. 259 tests pass with the file present and absent alike.

- **Contact addresses now point at the project rather than at a person.** `SECURITY.md` and `CODE_OF_CONDUCT.md` both named a personal domain; both now say `info@bikeshed.now`. The permission address in `NOTICE` is deliberately unchanged — it belongs to a third party, and redirecting it would misdirect the request it exists to receive.

### Changed

- **The `bikeshed-now` README names bikeshed.now** (in `bikeshed-now` 0.4.1). Its examples showed `https://<deployment>`, a placeholder that means something in a deployment's own `/llms.txt` and nothing on npm, where the client's default deployment is the one a reader can actually use. It now shows `https://bikeshed.now`, and says once that a self-hosted deployment takes its place.
- **A taken id gets a random suffix, not a count.** A second document titled `01-platform` now lands at `01-platform-k3x9qz`, say, rather than `01-platform-2`. A count told the publisher how many documents held the name and made the next id guessable. Existing ids keep their addresses. The publisher still learns that the id was taken; the threat model says why that is accepted.
- **`/llms.txt` and `/skills/**` name the deployment serving them.** They carried the literal `https://<deployment>` in seven places, so an agent that had just fetched the instructions from a live deployment was told to POST to a placeholder — and a skill, which is written into `.claude/skills/` and read days later with no origin in sight, could not work the address out even in principle. The app build now substitutes the real origin into `app/dist`, from `BIKESHED_PUBLIC_ORIGIN` or `config/deploy.json`'s `domain`, which is the first thing that has ever read that key. The guide also says which deployment it is in its own first line, and its command-line stanza is copy-pasteable.

  The tracked copies keep the placeholder, so `check:agents` stays a byte comparison and no deployment binding enters the tree — which matters because `check-secrets.sh` matches by shape and a custom domain has none. A `<deployment>` that survives the substitution fails the build, and the hosting `predeploy` refuses to deploy an `app/dist` that was never stamped.

- **Share and "Who can see it" are one dialog.** They were two, behind two entries of the same menu, asking one question — who gets this — from two places, and the second was found only by reading the overflow menu. "Share" now holds the people and teams first, then the three visibility levels side by side, the link, open editing and the expiry under its own rule. The count in the footer widens with the level ("2 people, and anyone with the link"). Folders keep the people-only dialog, having no visibility or expiry. Every visibility change still sends the whole triple, so ticking one box never clears another.

- **An expiry is a chip beside the version, not a banner above the document.** The banner appeared for every future date, so a document set to expire next year gave up a row of the document area for eleven months. The chip sits on the toolbar next to the version badge — the same one the workspace card shows — escalates in wording and colour through the last week and past the date, explains itself on hover or on tap (nothing is deleted; who can open it; who can restore it), and for the owner opens the place the date is changed. Nothing about an expiry takes a row from the document any more.

- **A document with nothing to say opens without the comments panel.** The panel was open on every document: a 340px column reading "0 open" and asking the reader to select a passage. It now starts collapsed and opens on its own only when the version's first annotation snapshot holds an unresolved thread — resolved ones are hidden until asked for, so a version whose every thread is dealt with reads as done. The reader's own toggle still wins over the default in either direction, a comment landing later does not reopen a panel they closed, and starting a comment opens it as before.

- **An HTML upload's default title is its own `<title>`.** When no title is given, the workspace title — and so the slug of a new document — comes from the document's `<title>` rather than the file name. The upload dialog no longer prefills the file name as a title, so a browser upload follows the document's title exactly as CLI and MCP uploads already did; a typed title still wins, and existing documents keep the titles they have.

- **A deck can be moved through.** The slide navigator was edit-mode only, so a reader opening a long deck got one very long scroll and no way around it. It is now available while reading too, behind a toolbar toggle, alongside arrow-key paging and an overview of every slide at once. Its thumbnails are the slides themselves rather than an index and a title: each is the slide rendered into a separate document, scaled down, sandboxed without `allow-scripts` even when the document is trusted, and mounted only when scrolled into view — one deck in the sample set has 48 slides and every preview is an iframe.

  What counts as a slide now lives in one place (`app/src/viewer/deck.ts`) and is decided by an ordered list of rules rather than a selector. Measured against real decks, `body > section[id]` — the old selector — matched none of them, including the repo's own tour, whose sections sit inside `div.deck`. So the navigator had never appeared for the one sample built to be navigated. Paging is gated on measurement rather than markup: on a document whose sections are taller than the viewport, taking the arrow keys would leave the reader unable to scroll within a section.

- **The brand guard is now `scripts/check-secrets.sh`, and matches only by shape.** It used to be driven by `scripts/forbidden-terms.txt`, a committed list of literal strings that must never appear. A list like that has to be in the tree to be useful, so committing it published the very words it existed to suppress — it was its own first leak — and it could never catch anything nobody had thought to add. The four tiers that read it are gone. The five that remain never needed a list of names: deployment bindings by shape, absolute local paths, attribution trailers, the tracked-binary allowlist, and a new credential tier covering `sk-`, GitHub and Slack tokens, AWS key ids, private-key blocks, service-account JSON, and any tracked dotenv or key file. `npm run check:brand` is now `npm run check:secrets`, and the guard prints `check-secrets: clean`.
- **Git history was rewritten once, before first publication.** The old guard carried the suppressed company name in a comment example, sanitised in the working tree but still present in five historical commits, where no tier could see it — the history tier reads commit metadata, never historical file content. Every commit id therefore changed. Nothing had been published at the time, so no clone needed reconciling.
- **`npm --prefix app run coverage` now runs in CI.** The step was named "App tests and coverage" and the verification table promised ≥90%, but the command behind both was `vitest run` with no `--coverage`, so the thresholds in `app/vite.config.ts` had never once been enforced.
- **`firebase` is a declared root devDependency.** `rules-tests/` imports it and had been resolving it as an auto-installed peer of `@firebase/rules-unit-testing`, which breaks under `--legacy-peer-deps`.
- **`move_document` is an access operation, not a filing one.** A document's members are its own grants unioned with its folder's, so moving it between folders changes who can read it. It requires `canEdit` on the document and `canEditFolder` on the destination, and goes through `persistDocMembership` so the presence mirror and the public projection move with it. Both the guide and the folders skill say so in those words.
- One resolver now authorizes every "put this inside that folder" in the system. `createDoc`, `createFolder`, both halves of `organize` and the MCP publish tool each had their own copy of the same four steps, with three different refusal messages for the same refusal — and one of them checked `editorMembers` by hand rather than calling `canEditFolder`, which agreed only by accident.
- The MCP surface is **nine tools**, not six. Tool schemas are public API (see above), so this is additive: nothing existing changed shape.

- **Several people can now edit one document at the same time.** Document state is a Yjs CRDT bound to the DOM without a schema, so edits merge and every copy converges ([ADR 0010](docs/architecture/adr/0010-crdt-for-shared-document-state.md)). Hand-authored HTML still round-trips byte-identical; that property is the contract, and the sample bundles are the fixtures that hold it.
- **The single-holder edit lock is withdrawn**, along with observe mode, "Ask to edit", the hand-off and the idle release. SPEC §6b and §16 are rewritten: both said there was no CRDT, and both were normative.
- `draft.editSessions` is **withdrawn**. It recorded lock hand-offs, and there are none; a version no longer answers "who wrote which part of it".
- The `app/` runtime dependency budget rises from **7 to 8** (`yjs`, MIT).
- RTDB gains `editAccess`, a second mirror of `editorMembers`. Shared document state is gated on "may edit" rather than on "may read" — gating it on the presence mirror would let a read-only member push content into an editor's browser.

## 0.1.0 — 2026-09-17

First release. Everything below is new, so this entry says what the thing *is* rather than what changed.

### The product

Publish a self-contained HTML bundle or a Markdown file, share it with named people, teams or the public, and collect threaded comments **anchored to the exact passage they are about**. Documents are immutable versions. Agents publish and read feedback through the same interface people do, and are visibly marked as agents.

- **Anchored feedback.** W3C-style text-quote anchoring with a position fallback, scoped to the nearest `id`-bearing ancestor so a comment survives an edit somewhere else in the document. Rehydration opens every collapsed `<details>` ancestor a highlight is hiding behind.
- **It edits the document you wrote.** `execCommand` on the authored DOM, not a normalized schema, so a deck with inline SVG and a scroll observer survives a round trip ([ADR 0007](docs/architecture/adr/0007-execcommand-over-schema-editor.md)).
- **Markdown as a first-class source format**, compiled to an HTML bundle server-side once per version, with a restricted editor palette whose unsupported controls are disabled with a reason rather than hidden ([ADR 0003](docs/architecture/adr/0003-server-side-markdown.md)).
- **Idempotent publishing.** Identical bytes mint no version, by content hash.
- **Three visibility levels** — private, unlisted by token, public — served through a projection that carries no member list, never by opening the bucket.
- **Collaborative presence**: peer cursors, selections and reading positions, with a single-holder edit lock and observe mode instead of a merge engine. (Superseded in Unreleased: edits now merge.)
- **Teams**, expanded server-side into the flat membership arrays so the one provable workspace query is unchanged ([ADR 0006](docs/architecture/adr/0006-denormalized-members.md)).
- **An agent surface**: personal access tokens, six MCP tools, a `bikeshed` CLI, and `docs/agents/agent-guide.md` mirrored to `/llms.txt` with CI asserting they match.
- **Provenance on everything.** Identity and channel are derived from the credential, never claimed; `client` and `agent` are self-reported and labelled as such. Automated reads count into `stats.apiReads`, never into human reading time.
- **Export marking** locked against twenty-five CSS hiding vectors, with the text per document rather than hardcoded.

### Security posture

- Any verified account may sign in; an optional domain allowlist is generated into all four enforcement layers from one file ([ADR 0005](docs/architecture/adr/0005-generated-rules.md)).
- The bucket is private with public-access prevention. One function is the only path bytes take to a browser.
- Read-only byte paths answer **404** for forbidden and absent alike, so a signed-in stranger cannot enumerate the slug space.
- Untrusted documents render script-sandboxed, with two trust scopes — global (owner) and personal (self) — that never collapse into one ([ADR 0002](docs/architecture/adr/0002-two-scope-trust.md)).
- Presence reads are gated by a server-maintained mirror, so a live selection stream is never readable by a non-member.
- Anonymous is read-only everywhere. `publicEdit` widens *who may edit* to any verified account, never to anyone.

### Verification

344 tests: 135 functions, 151 app and 11 CLI, plus 47 rules cases against the emulators. Coverage on the annotation, export, workspace, brand and stats modules is 93% of lines. Five guards run in CI — brand purity including git history and binary assets, SPDX headers, what each sample demonstrates, dependency licences, and byte-comparison of every generated artifact.

`docs/development/verification.md` is the emulator walkthrough for the integration properties no unit test reaches. Writing it found four real defects, each fixed in its own commit.

### Known limits, stated rather than discovered

- A membership change fans out one write per affected document. Bounded and batched; fine for a small team, and named in `docs/architecture/overview.md` so nobody is surprised at ten thousand documents.
- Making a public document private again takes up to five minutes to propagate through the CDN. That is the price of caching public content at all.
- `~~strikethrough~~` round-trips as `~strikethrough~`. GFM accepts both and it is stable thereafter; it is the one lossy Markdown normalization.
- Presence needs a Realtime Database and email needs a Resend key. Without either, both degrade to clean no-ops — which is the path CI exercises.
- The MCP server is hand-written rather than built on the SDK, which requires `zod` as a peer ([ADR 0009](docs/architecture/adr/0009-hand-written-mcp.md)). Protocol changes are ours to follow, and a test speaks the wire format to catch them.
