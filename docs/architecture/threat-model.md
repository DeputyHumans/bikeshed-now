# Threat model

What this system protects, from whom, and where it deliberately stops.

## Assets

| Asset | Where it lives | Who may see it |
|---|---|---|
| Document bytes, and the thumbnails captured from them | private bucket, served only by `contentProxy` and `downloadBundle`; thumbnails only by `contentProxy`, uploaded by an editor's browser through `saveThumbs` as size-checked JPEG; `docShell` reads the entry's first 256 KiB of a non-private document to derive a title, excerpt, keywords and image URL for its page, and nothing of a private one | owner + `members`; anyone when public; when unlisted, anyone holding its link (the key, or an account's grant from presenting it); and, to read only, anyone a folder above it opens to by its link or public level (SPEC §17 "A folder's reach") |
| Member lists, owner email, usage stats | `docs/{docId}` | members only — never anonymous, never a non-member on a public document |
| Reviewer identities (annotations, comments) | `docs/{docId}/versions/**` | anyone with an account who can read the document: a member, anyone on a public one, a link grant on an unlisted one |
| That an unlisted document exists, and its title | `docs/{docId}` only — never `public/` | its members and the holders of its link, or of a link to a folder above it |
| A folder's key | `folders/{folderId}.linkToken`, its owner's share dialog; each folder beneath stores only a sha256 of it | the folder's members, who can read its record — never a subfolder's members, who see the hash |
| Per-person reading history | `docs/{docId}/viewers`, `/views` | owner + real editors only |
| Personal access token secrets | nowhere — only a SHA-256 hash is stored | nobody, including the owner, after the one-time reveal |
| The deployment's own binding (project id, bucket, keys) | gitignored files and Firebase secret manager | the operator |

## Principals

- **Anonymous.** No account. Can read a public document's bytes through the
  proxy and its `public/{docId}` projection, and an unlisted document's only
  with its key, through the proxy and `POST /unlock`. **Can never write
  anything**, and can never read a member list, a reviewer identity, or a
  reading statistic.
- **Any verified account.** Passes the §1 gate. Sees only what its email is in
  `members` for, plus public documents, plus unlisted documents it holds the key
  to or a current link grant for.
- **Viewer / suggester / editor / approver / owner.** The ACL ladder (SPEC §13).
- **An agent holding a personal access token, or an app connected by signing
  in** (SPEC §23). Exactly its owner's identity and exactly its owner's ACL. No
  service accounts, no impersonation, no scopes.
- **A document author.** Supplies arbitrary HTML, CSS and JavaScript, which will
  be rendered in a frame on this origin. Treated as hostile by default.
- **The deployment operator.** Owns the data. Not in the threat model.

## The attacks this design is actually shaped by

### An uploaded bundle steals the reader's session

The frame is same-origin, so a bundle's JS could read the app origin's Firebase
auth token from storage.

**Mitigation.** A document is rendered `sandbox="allow-same-origin"` with no
`allow-scripts` unless it is effectively trusted. Trust has two scopes, split by
who bears the risk: **global** trust un-sandboxes for every reader and is
therefore owner-only; **personal** trust un-sandboxes only in the granting
user's own browser, where the only session exposed is theirs, and is therefore
available to any reader. Personal trust never writes the global flag.

Browser uploads, forks, and every publish through a personal access token
— the end-user CLI and MCP alike — are created `trusted: false`. A token is an
authenticated account, but the hand on it may be an agent acting on text it was
given, and global trust is a decision taken on behalf of every reader. Only the
operator script, which runs with Admin credentials against Firestore directly,
creates a document `trusted: true`.

**The sandbox travels with the bytes, not only with the frame** ([ADR 0021](adr/0021-a-documents-script-runs-only-with-consent.md)). Until 0.25.0 the frame's attribute was the whole defence, and the same `/content/…` address opened any other way, pasted into a tab, in a popup or an `<object>`, ran the document's scripts on this origin as whoever opened it. Every content and draft response now carries `Content-Security-Policy: sandbox allow-same-origin` itself, unless its type is one a browser never renders as a scripted document. Until 0.32.0 the rule named five scriptable types instead, and any other XML type a bundle carried (`.atom`, `.rss`, `.rdf`, `.xslt`, about a hundred more) rendered as XML and ran its XHTML-namespaced script on this origin, as whoever opened its link: any account could upload one and send it to anyone. The lock now names what is harmless, so a type nobody thought of is locked. A document's script runs only at its run variant (`/content/[~k/]!run/…`), which the server unlocks only for global trust or the caller's own personal grant, never caches, and lets only this origin frame. The session cookie is `SameSite=Strict`, so a page elsewhere that frames it presents no caller. No content path serves a service worker's script, and a draft's script never runs. Nor does an older version's: trust is for the current version, the one somebody vouched for, and until 0.32.0 the run variant ignored the version, so trusting the head again ran an editor's older version whose commit had withdrawn trust.

**Global trust is a superadmin's, not an owner's.** It lets a document's author act as every reader, and until 0.25.0 any owner could grant it on their own document: an account could publish a page, trust it and share it. Now only an owner listed in `BIKESHED_SUPERADMINS`, deployment configuration that is never committed, may lift the sandbox for everyone, and an absent flag is untrusted. Until 0.32.0 their personal access token could too: a prompt-injected agent holding a superadmin's token could lift the sandbox on any document that superadmin owned. Lifting it now takes the browser's session; a token may only restore it. `scripts/reconcile-trust.mjs` withdraws trust granted under the old rule.

**Trust never carries, and covers the current version only.** Every new version withdraws both scopes, the owner's own commit in the app included. Until 0.32.0 the owner's commit kept them, on the reasoning that the owner vouches for what they write. But a draft is shared: an editor, or any account on a public document open to editing, could put a `<script>` in it through `/draft` or a raw write to the live merge, which records nobody, and the owner who committed it saw nothing in the sandboxed editor. The script then ran in every trusting reader's session. An editor's own commit always withdrew trust; the owner's now does too.

**Residual, accepted.** Whoever trusts a document trusts the scripts of its current version, whoever wrote them; a superadmin who trusts a document others edit should read it first. A reader's personal grant runs the document's script at its run variant wherever they open it, the frame or a tab: the only session it reaches is the one that granted it. When a document's own trust changes, a cached copy of its plain address can carry the old header for up to five minutes; the run variant is never cached, so this cannot unlock anything.

### An unverified address claims someone else's pending shares

The ACL is keyed by **email**, and anything shared with an address lights up the
moment someone signs in with it. GitHub does not generally assert
`email_verified`.

**Mitigation.** The gate stays exactly `email_verified === true` in every layer.
Sign-up **blocks** on verification, and verification writes Firebase's canonical
`emailVerified` field through the Admin SDK rather than inventing a parallel
claim. One gate, one source of truth, zero rules changes.

**The code must be unreadable, not merely hashed.** A six-digit code has a million values, so its hash falls to an offline search in under a second, and the five-guess limit only counts guesses the server sees. Until 0.29.1 the challenge sat on `users/{uid}`, which its own account may read: an account could ask for a code for an address it did not hold, read the hash, find the code offline and complete on its first try, taking every share waiting for that address (one account per address means it worked wherever no account held the address yet). The challenge is now kept in `verifications/{uid}`, which the rules refuse to every client, and a rules test asserts that its own account cannot read it.

**Nor guessable across accounts.** The five guesses and the minute between codes are per account, and each code brings five fresh guesses, so until 0.32.0 a hundred throwaway accounts (the endpoint takes any signed-in account, verified or not) could make 720,000 guesses a day at one address, about even odds of a pending share's address in a day. Now an address is sent at most five codes a day, whoever asks, which is 25 guesses. **Residual, accepted:** anybody can keep an address from verifying by email for a day, and mail its holder five codes, by asking for them.

**This is the single most tempting shortcut in the codebase.** Relaxing the gate
"just for GitHub" would hand an attacker every document anyone ever shared with
that address.

### A forged rename takes someone's shares

An account follows the address Google renames it to (ADR 0020). That move
rewrites grants on documents other people own. A forged move would be the
unverified-address attack above, with a redirect added: everything shared with
one address handed to another.

**Mitigation.** The new address is believed only from Google's own ID token:
- its RS256 signature is checked locally against Google's keys;
- `iss` must be Google, the token unexpired, and `email_verified` the string
  `"true"`, since `"false"` is truthy;
- its `sub` must be one of the Google ids in the caller's *verified* Firebase
  token.

So a token for any other Google account is refused, and the most any token can
do is set the caller's own account to what Google vouches for now. Nothing the
browser says about an address counts.

The job that does the move is created only by the server, and the rules let no
client write one. Before it runs, one account per address is enforced again: a
verified holder of the new address blocks the move.

Once the address changes, every session, cookie and personal token carrying the
old address is revoked. An old address that is later reassigned therefore
inherits nothing from a credential still acting as it. Under the Auth emulator
the unsigned token is accepted only while `FIREBASE_AUTH_EMULATOR_HOST` is set.
That is firebase-admin's own switch, and a test pins that without it the same
token is refused.

### Enumerating the slug space

With no domain gate, any signed-in account could otherwise probe for documents.

**Mitigation, three parts.**

1. `/content/**`, `/download/**`, `/unlock` and `/view` collapse "you may not
   read this" and "this does not exist" into the same **404**. Mutation
   endpoints answer 403 only to a caller who may read the document, who already
   knows the id, and 404 to everyone else. So does a destination folder: one
   the caller cannot read is "not found", like an absent one, and only a folder
   they can read but not edit is 403 (until 0.32.0 any existing folder was 403).
2. Presence is gated by a **server-maintained mirror**
   (`presenceAccess/{docId}/{emailKey}`) rather than by the identity gate. RTDB
   rules cannot query Firestore, so the authorization data has to live in RTDB.
   It fails closed: a missing entry means presence goes dark, never that a
   stranger can read it.

3. **An unlisted document without its key behaves as a private one**, on every
   one of those surfaces and in the security rules. `public/{docId}` holds
   public documents only, allows `get` of a public row and no `list`, and the
   realtime `*` key that opens editing to any account is written for public
   documents only (SPEC §16, §17).

Part 2 matters more than it looks. The presence payload now carries a live
selection stream, which reveals what a person is reading sentence by sentence —
considerably more than a name.

**What still leaks: whether an id is taken.** Publishing at a taken id lands the
document at a suffixed one, so the publisher learns the id exists, even when it
belongs to a private document they cannot read. This is accepted, not missed.
Refusing instead would make the check free and silent. As it is, every check
creates a document in the checker's own workspace, attributed to them; it can go to their Trash and be deleted forever, but a deleted document leaves a tombstone that keeps its id (SPEC §4 "Deleted forever"), so a check cannot be made and quietly taken back. The suffix is random, so it does not say how many documents
share the name (SPEC §4). `publish_document`'s `idTaken` says the same thing in
so many words; it tells the caller nothing that comparing ids did not.

**Who can read a folder is told to its members.** `get_folder` and the `access`
returned by a filing write list a folder's readers by email. That is what the
rules already let any member read off the folder record. A team is named only
to its members, and a team the caller is not in is never sized (SPEC §13).
Nor granted: until 0.32.0 an owner could grant a team they were not in by its
id, which emailed every member an invitation and answered with the roster.
Now only somebody in a team may add it (SPEC §18).

### A public document leaks its private fields

Firestore rules cannot project fields, so a naive "allow anonymous `get` when
public" would hand the world `members`, `viewers`, `ownerEmail` and `stats`.

**Mitigation.** A separate world-readable `public/{docId}` projection carrying
only render fields, of public documents only, written by the same server paths
that recompute `members` and deleted the instant a document stops being public or goes to the Trash (SPEC §4). The `docs/{docId}` rule
is untouched. Everything else under `docs/**` still requires an account, even on
a public document — publishing a document must not publish the people who
reviewed it.

### An unlisted document is found or read without its link

"Unlisted" once meant "readable by anyone who guesses the id". The key was
checked by hand on three byte paths while the shared `canRead`, the security
rules and the projection all treated unlisted as public. So anyone could list
`public/` and read every unlisted document's id and title; any account could
read its comments and, through the agent tools, its whole source; and the view
counter and the write endpoints confirmed that it existed. Chosen ids made the
id guessable as well.

**Mitigation.** One predicate, `readBasis`, decides every read, and
`tokenMatches` is the only comparison of a key, held there by a test. The rules
cannot see a URL, so a signed-in link holder is given a **link grant** that
names the token they presented; it lapses the moment the link is rotated. An
unlisted document is not in `public/`, and the rule refuses a stale row and an
absent one alike.

**Residual, accepted.** A grant cannot be withdrawn from one account without
rotating the link for everyone; that is ADR 0012's reversal condition. A link
holder on an open-editing unlisted document edits without being merged live.
A document once readable at a URL with its key stays in a shared cache for up
to five minutes after the link is rotated, as any content does after it is made
private (SPEC §17).

### A folder's link is used to write, or reaches further than it should

A folder's link or public level opens everything beneath it (ADR 0019). Three
ways that could go wrong: the key authorizes a comment or an edit; a subfolder's
member learns the key to a folder above that they cannot open; or a document
stays reachable after the folder is rotated, made private, or past its date.

**Mitigation.** A folder's reach is read only by `readAccess`, and only read
paths call it. Every write keeps `canRead` and `canEdit`, which never look at a
folder, and a test puts a write path through `readAccess` to watch the refusal
fail. No grant is minted for a folder reader, so the rules give them no thread,
annotation or presence. A folder's `reach` stores sha256 of each key, compared
only by `keyMatchesHash`. Reach is recomputed by the same cascade as
membership, so rotating revokes at once for the folder's own documents and,
within seconds, for its subfolders'.

**Residual, accepted.** Widening a folder widens documents its owner does not
own, without asking their owners. That is "filing is sharing" (SPEC §13)
reaching strangers, and each such document's share dialog names the folder. A
subfolder's documents answer to a rotated key until the cascade reaches them.
A title under a public folder stays in `public/` after the folder's date passes,
as a document's own does after its own date.

### An editor shares a document by filing it

Sharing is the owner's: `setAccess` and the share dialog refuse anyone else. But filing is sharing (SPEC §13): a document filed in a folder is readable by that folder's members, and its link and public level reach it. Until 0.32.0 any editor could move a document, and any folder editor could move a folder, so an editor could file the owner's private document into a folder of their own, share that folder with anyone or make it public, and became an approver of the document besides, since a folder's owner is an approver of what is in it.

**Mitigation.** Moving a document is its owner's, and moving a folder is the folder's owner's, in `POST /organize`, `move_document` and `move_folder` alike, and the menus say so. Editors keep renaming, and filing their own documents into folders they may edit.

**Residual, accepted.** A document filed by its owner into somebody else's folder is shared on that folder's terms, which its owner can change later: that is "filing is sharing" as the owner chose it (see "A folder's link is used to write" below).

### A client forges provenance

An automation could otherwise claim to be a human, or a human could claim to be
an audited agent.

**Mitigation.** `uid`, `email`, `channel` and `tokenId` are derived server-side
from the credential actually presented. `/mcp` stamps `mcp` unconditionally. On
the direct-Firestore write path, `firestore.rules authoredBySelf()` pins
`actor.channel == 'web'`, because a rules-evaluated client write *is* the web
channel by definition — automation goes through the Admin SDK, which bypasses
rules entirely.

Until 0.11.3 that was all the rules pinned. A browser could put an agent's
`tokenId` on its own comment, which points "everything this token touched" at a
token that never touched it. It could backdate `createdAt`, or create a thread
with no `resolved` field, which no `resolved == false` count sees, the in-app
commit gate's included. Now an annotation or comment is created with exactly the
fields the app writes and an actor of `uid`, `email` and `channel` only, dated
by the server (`request.time`). A reader's update changes `resolved` and nothing
else, and a comment's author can change only its `body` (SPEC §4).

`client` and `agent` are self-reported, stored verbatim, and **rendered as
self-reported**. A badge implying verification it does not have would be worse
than no badge.

`via`, the credential in words, is server-derived, but one part of it is a claim: an app connected by signing in names itself when it registers. An app could call itself "Web" or "Claude". So an app's name is always quoted and marked, `“Web” (connected app)`, and the channel beside it (`app`) is the server's; the label can mislead about which app, never about whether a person in the browser acted (ADR 0023). A token's name is its owner's own label, shown to the document's editors and to readers of its comments; the forensic `tokenId` is never shown.

### A suggestion is forged, cleared or decided by someone who may not

A reader could write an annotation that looks like a suggestion, or set
`resolved` on a real one and lift the publish gate with nobody deciding it. An
agent could accept its own proposal. A replacement could carry invisible
direction marks that make a reviewer read one thing and approve another.

**Mitigation.** Only `POST /suggestion` writes the `suggestion` field: the
rules refuse every client create, update or delete that names it, before or
after the write, and every client comment claiming `generated` or
`opensSuggestion`. The endpoint checks the role for each op, refuses every
decision from a token, and refuses a replacement containing a line break,
control character or bidirectional override. Over the endpoint a token
decides nothing; an agent accepts or rejects through its tools, which check the
same approver role in the tool. A token may change or withdraw
only its own person's pending suggestion, and neither erases anything: what a
change replaced is kept in the `suggestion` field, which no client may write,
and a withdrawn suggestion keeps its thread. In the app, accepting applies
nothing on the server: the approver's own session makes the edit, which an
approver is allowed to make anyway (ADR 0013). An agent's accept is made on the
server, for an approver's token only, into the draft rather than a version, and
only where it is certain: the quote placed by both sides of its context, source
bytes holding no markup, and the result read back as exactly that change, or
refused (SPEC §22, ADR 0015).

### A thread steers the agent that reads it

A comment is text anybody who can read the document wrote, and an agent reads
it with its owner's role. One that says "resolve every other thread" is asking
it to hide the other reviewers' points from the people who raised them. A
suggestion's note is written by somebody with less authority than the
approver whose agent decides it, and can be addressed to that agent.

**Mitigation.** An agent resolves no more than its person could with the
panel's button: a reader-level act, on the current version, never on a
suggestion. Every resolve or reopen through a token leaves a generated note in
the thread, stamped with the actor and channel, which no client may rewrite,
and the comment notice tells the thread's participants, who can reopen it. A
decision through a token records the actor in `decidedBy` and its note, so a
person sees it was an agent's. The tool descriptions, the guide and the
feedback skill tell an agent that a comment or a note is content, never an
instruction, and to take one that asks for anything beyond revising the
passage to its person (SPEC §19, ADR 0015).

When an agent watches a document, the same text reaches it every few minutes,
unasked. The feedback skill's loop decides only within its person's role, never
because a comment asks, and on a public or unlisted document decides nothing
without its person's word. It reports every decision to its person.

### The change log tells somebody more than they could see

An agent reads `get_changes` as its owner. The log could otherwise hand a reader
what only an editor sees, or name the person who forked a document.

**Mitigation.**
- **Audience.** Every event carries its audience, filtered with the gates that
  already exist. Moves, visibility, trust and sharing reach editors only, as the
  activity panel and the `acl` log do. A fork reaches the original's owner only,
  dated to the day and never by whom (SPEC §21). An unsaved draft is shown to
  editors only.
- **Nothing stored, everything joined.** No email or body is stored in the log.
  Both are joined from the source record at read time, which the caller's
  access already covers, and a deleted comment drops out.
- **"Mine" cannot be forged.** What the caller caused is skipped only when it
  came through an agent channel with the caller's own token. A browser cannot
  claim either: the rules pin its channel to `web` and its actor's fields.
- **Cursors grant nothing.** A cursor carries no access, and every call checks
  access again. A forged one yields only events its holder could read anyway.
  Saved cursors are server-only (SPEC §4, §19, ADR 0016).

### Zip-slip and zip bombs

A `.zip` upload is the only place attacker-controlled relative paths enter
Storage.

**Mitigation.** Every entry is validated before any write: no `..`, no absolute
paths, no backslashes, no NUL, no empty segments. The total is capped, and so is the number of files (2,000, since 0.32.0), because each is a Storage write. The bomb
guard rejects on the **declared** uncompressed size from the central directory
*before* decompressing, and rejects a size-0 declaration that still carries
meaningful compressed bytes — because a spoofed zero declaration would otherwise
inflate unbounded.

### Hostile CSS suppresses the export marking

**Mitigation.** Stamp styles are set inline with `!important`, which outranks any
selector-based author `!important` rule, and all 25 hiding vectors are locked —
box and text. The print frame is sandboxed without `allow-scripts`, so the
bundle has no JS to add inline styles of its own.

**Residual, accepted.** A bundle can blank its own entire document, producing an
empty PDF. Self-defeating; no content leaked. A cryptographic guarantee would
need server-side rendering. And the browser's File → Print, which cannot be
redirected to the export, prints the page unstamped — no new capability: the
same reader can open the content URL or download the HTML (SPEC §20).

### Editor decoration contaminates saved bytes

The app injects highlights, placeholder marking and a peer-presence overlay into
a document that is also being serialized and published.

**Mitigation, four independent legs**, any three of which still hold:

1. **Mutual exclusion by construction.** The annotation layer and the inline
   editor derive `enabled` from the *same* tagged union, so they cannot both be
   active.
2. **Cleanup/setup ordering.** Effect cleanups run in declaration order before
   any setup, and the annotation layer is declared first.
3. **Unconditional strip on editor entry**, plus a **dev-only assertion** that
   throws if any `bshd-` artifact survived into edit mode. The iframe does not
   always remount on entering edit mode, so this leg is what covers the
   no-remount path.
4. **Serializer defence in depth.** `serializeCleanHtml` strips own-marked nodes
   (by attribute *value*, so a bundle using the same attribute survives),
   unwraps highlight marks preserving children, drops `[contenteditable]`, and
   drops any asset tag absent from the load-time inventory — which also removes
   nodes a **browser extension** injected into the frame.

### Analytics leaks document slugs

`getAnalytics()` sends `page_location`, the full URL, and these URLs are
`/d/{docId}/{versionId}`. **The slug is frequently the confidential thing.**

**Mitigation.** `send_page_view: false` at initialization, manual logging of
route *patterns* only, and a test asserting no id, title, slug, folder name or
email appears in any event payload. This is default behaviour that has to be
actively switched off, which makes it a real trap rather than a theoretical one.

### A leaked personal access token

**Mitigation.** Hashed at rest, shown once, named, individually revocable,
`lastUsedAt` surfaced so an unused token is visible. Scope equals the owner's
ACL, so there is no escalation path to widen. `tokenId` is stamped on everything
the token touches, so "what did this token do" is one query and revocation does
not disturb the owner's other clients. A token can move its owner's things to
the Trash, where they wait 30 days, but never delete anything forever:
`POST /purge` refuses every token. Nor can it lift a document's sandbox for
everyone: `POST /trust` refuses a token that asks, a superadmin's included.

### An app is connected that the person did not mean to connect

Consent phishing. The registration endpoint is open, so anyone can register a
client called "Claude" that sends codes to their own server. A link to the
consent page is then all it takes to ask (SPEC §23).

**Mitigation.**
- **The page leads with what is verified.** A metadata-document client is shown
  as "from {host}", which is the host we fetched. A self-registered client is
  shown by its redirect host, with its name labelled as chosen by the app.
- **The destination is always visible**, as a hostname in punycode. A loopback
  destination gets its own warning.
- **Names are cleaned** of control and format characters, so a right-to-left
  override cannot disguise one.
- **It never redirects without a person's click**, on success or on error.
- **The ID token on the request** binds the grant to the account the page
  shows.

**Residual, accepted.** A person who approves a well-labelled request from an
attacker has connected the attacker. Revoke, on the account screen, is the
remedy, and the row there names the host.

### The consent click is borrowed

Clickjacking, including the double-click variant, where a window opens beneath
the second click.

**Mitigation.**
- **The frame headers.** `/connect` sends `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`, and so does `/signup`, whose `?next=` reaches the
  consent page by client-side navigation.
- **The page itself** refuses to render in a frame.
- **Approve is never focused by default**, and stays disabled until the page
  has had focus for a second and seen a pointer or key event.

A trusted document runs unsandboxed on this origin and could post to
`/oauth/consent` as it can post to `/tokens`. It would need the account's ID
token, which lives in the app's storage, so this is the session-theft case at
the top of this file, not a new one.

### The authorization server is made to fetch something internal

A client metadata document's URL is chosen by whoever asks, and the server
fetches it. That is SSRF by design.

**Mitigation.**
- **The URL:** https on 443, a hostname rather than an IP literal, and no
  internal-looking suffixes.
- **The connection:** the address the socket connects to must be public, which
  is checked inside its own `lookup`. That closes DNS rebinding. Mapped,
  NAT64 and 6to4 addresses are judged by what they carry.
- **The response:** no redirects are followed, the timeout is 5 s and the body
  is capped at 16 KB.
- **Where it runs:** from `/oauth/consent`, behind a signed-in account, and
  from the token endpoint for an identity assertion. There the issuer's
  documents are fetched only for an issuer in the deployment's own
  configuration, and the client's only after that issuer's signature has
  verified, so an anonymous caller chooses nothing that is fetched. An unknown
  `kid` refetches the keys at most once a minute per instance.

### An organisation's assertion is stolen, forged or replayed

Where the deployment trusts an issuer (ADR 0026), a signed assertion connects an app for the person it names, with no consent page and no client secret: Claude authenticates as nobody.

**Mitigation.**
- **Only configured issuers**, compared byte for byte, and only ES256 keys from their own published set. `alg` is fixed, so `none` and an HMAC keyed with the public key are refused.
- **Only listed domains.** An issuer vouches only for addresses at `BIKESHED_ID_JAG_DOMAINS`, exactly, and without that list the grant is off. Until 0.32.0 a trusted issuer could connect any account here by asserting its address, so one leaked signing key reached every account, an administrator's included. An `email_verified` the issuer sends must be true.
- **Short and single.** An assertion expiring more than ten minutes ahead is refused, and each `jti` is spent once; within 60 s a retry gets back the token it already earned, and nothing new.
- **The store is not the key.** A token is `HMAC(row nonce, assertion)` and only its hash is kept, so a copy of `tokens/` yields no live token.
- **Addressed to us.** `aud` must be this server, `client_id` must match the request, and a named `resource` must be ours.
- **It connects an account; it never makes one**, and the account passes the same gate as any refresh.
- **A reassigned address is refused.** The issuer's `sub` is pinned at the first exchange.
- **The person can decline for good.** Revoke on the account screen is sticky for that issuer, whichever app a later assertion names, and the issuer's `sub` is pinned across apps. Until 0.32.0 both held for one app only, so naming another `client_id` undid them.

**Residual, accepted.**
- A leaked assertion is a bearer credential for up to ten minutes, once. Draft -06 of the ID-JAG specification would require a bound key or client authentication; Claude offers neither yet.
- The organisation decides, not the person. A member of a trusting organisation is connected until they revoke it.
- A trusted issuer can connect any account at its listed domains, the operator's own included if it is at one. That is an app's reach, not the account's: no agent connection can trust scripts or delete forever.
- Anyone can make the server fetch a trusted issuer's keys by naming an unknown `kid`. Shared fetches, at most one a minute per instance, and a ten-second back-off after a failure bound it.
- Someone removed from the organisation keeps up to an hour of access, until the access token already issued expires.

### A refresh token or code is stolen and replayed

**Mitigation.**
- **Access tokens last an hour**, and refresh tokens rotate on every use.
- **Replaying a spent refresh token or code revokes the grant.** The exception
  is a retry inside 60 s, which receives the identical pair, so a client's
  timeout cannot fork the chain into a false alarm.
- **Revocation requires possession** of the spent secret. The `tokenId` is
  visible to readers, so a guessed secret must never be able to disconnect
  anyone.
- **A failure of ours is never `invalid_grant`.**

**Residual, accepted.**
- Theft is detected only one rotation deep.
- A disabled account keeps up to an hour of access, until the next refresh
  fails the gate.

### Something is deleted forever that should not have been

Deleting forever cannot be undone, so the attacks that matter are a stranger's browser left signed in, an agent following a misread instruction, and a stale reference that ends up pointing somewhere else.

**Mitigation.** Nothing is deleted at once: deleting moves to the Trash, and only the daily job, 30 days later, or the item's owner sooner, deletes for good (ADR 0024, ADR 0025). Sooner needs a code emailed to the account's own address, for exactly that item or for the whole Trash, valid ten minutes, used once and burned by five wrong guesses; it is kept in `purgeCodes/{uid}`, which no client can read, because a six-digit code's hash is the code to whoever reads it. The endpoint takes the browser's session and refuses every token, so no agent can do it, and where email is off nobody can. An early purge takes only its owner's things: a folder's owner cannot destroy the documents other people had in it before their 30 days. A deleted document leaves a tombstone that keeps its id, so a link, a fork's lineage or an agent's saved cursor that names it finds nothing, never the next document of that name.

**What cannot be recalled, stated.** A page a CDN cached is served for up to five minutes after it is deleted, a thumbnail a browser cached for up to a day, and email already sent stays sent. Anything a reader downloaded, printed or copied is theirs. A purge stopped between its tombstone and its last deletion leaves bytes in Storage until the next daily run, readable by nobody, since every path to them goes through the record.

## Out of scope, stated so it is a decision

- **A malicious deployment operator.** They own the bucket.
- **Denial of service by volume.** No rate limiter; CDN caching is the cost
  defence and App Check is the documented hook.
- **Traffic analysis.** Document sizes and request timing are observable to a
  network attacker.
- **Anonymous abuse attribution.** Deliberately impossible: no IP, no
  fingerprint, no unique-visitor estimation. Counting sessions instead of people
  is a privacy floor, and it means an anonymous abuser cannot be identified.
- **Content scanning.** Nothing inspects uploaded documents for malware,
  phishing or unlawful material.
- **Availability of the underlying platform.**
