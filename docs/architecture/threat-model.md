# Threat model

What this system protects, from whom, and where it deliberately stops.

## Assets

| Asset | Where it lives | Who may see it |
|---|---|---|
| Document bytes, and the thumbnails captured from them | private bucket, served only by `contentProxy` and `downloadBundle`; thumbnails only by `contentProxy`, uploaded by an editor's browser through `saveThumbs` as size-checked JPEG; `docShell` reads the entry's first 256 KiB of a non-private document to derive a title, excerpt, keywords and image URL for its page, and nothing of a private one | owner + `members`; anyone when public; when unlisted, anyone holding its link (the key, or an account's grant from presenting it) |
| Member lists, owner email, usage stats | `docs/{docId}` | members only — never anonymous, never a non-member on a public document |
| Reviewer identities (annotations, comments) | `docs/{docId}/versions/**` | anyone with an account who can read the document: a member, anyone on a public one, a link grant on an unlisted one |
| That an unlisted document exists, and its title | `docs/{docId}` only — never `public/` | its members and the holders of its link |
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

**Residual, accepted.** An editor the owner deliberately added could inject a
`<script>` into a trusted document via devtools and commit it. This is an
owner-gated relaxation, not a silent divergence: granting edit rights on a
trusted document is granting the ability to run script for every reader, and the
share panel says so.

### An unverified address claims someone else's pending shares

The ACL is keyed by **email**, and anything shared with an address lights up the
moment someone signs in with it. GitHub does not generally assert
`email_verified`.

**Mitigation.** The gate stays exactly `email_verified === true` in every layer.
Sign-up **blocks** on verification, and verification writes Firebase's canonical
`emailVerified` field through the Admin SDK rather than inventing a parallel
claim. One gate, one source of truth, zero rules changes.

**This is the single most tempting shortcut in the codebase.** Relaxing the gate
"just for GitHub" would hand an attacker every document anyone ever shared with
that address.

### Enumerating the slug space

With no domain gate, any signed-in account could otherwise probe for documents.

**Mitigation, three parts.**

1. `/content/**`, `/download/**`, `/unlock` and `/view` collapse "you may not
   read this" and "this does not exist" into the same **404**. Mutation
   endpoints answer 403 only to a caller who may read the document, who already
   knows the id, and 404 to everyone else.
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
creates a document in the checker's own workspace, attributed to them, which
cannot be deleted. The suffix is random, so it does not say how many documents
share the name (SPEC §4). `publish_document`'s `idTaken` says the same thing in
so many words; it tells the caller nothing that comparing ids did not.

**Who can read a folder is told to its members.** `get_folder` and the `access`
returned by a filing write list a folder's readers by email. That is what the
rules already let any member read off the folder record. A team is named only
to its members, and a team the caller is not in is never sized (SPEC §13).

### A public document leaks its private fields

Firestore rules cannot project fields, so a naive "allow anonymous `get` when
public" would hand the world `members`, `viewers`, `ownerEmail` and `stats`.

**Mitigation.** A separate world-readable `public/{docId}` projection carrying
only render fields, of public documents only, written by the same server paths
that recompute `members` and deleted the instant a document stops being public. The `docs/{docId}` rule
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
paths, no backslashes, no NUL, no empty segments. The total is capped. The bomb
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
not disturb the owner's other clients.

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
- **Where it runs:** only from `/oauth/consent`, behind a signed-in account.

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
