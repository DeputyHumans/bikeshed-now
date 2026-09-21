# Threat model

What this system protects, from whom, and where it deliberately stops.

## Assets

| Asset | Where it lives | Who may see it |
|---|---|---|
| Document bytes | private bucket, served only by `contentProxy` and `downloadBundle`; `docShell` reads the entry's first 256 KiB of a non-private document to derive a title, excerpt, keywords and image URL for its page, and nothing of a private one | owner + `members`, or anyone when the owner made it non-private |
| Member lists, owner email, usage stats | `docs/{docId}` | members only — never anonymous, never a non-member on a public document |
| Reviewer identities (annotations, comments) | `docs/{docId}/versions/**` | anyone with an account who can read the document |
| Per-person reading history | `docs/{docId}/viewers`, `/views` | owner + real editors only |
| Personal access token secrets | nowhere — only a SHA-256 hash is stored | nobody, including the owner, after the one-time reveal |
| The deployment's own binding (project id, bucket, keys) | gitignored files and Firebase secret manager | the operator |

## Principals

- **Anonymous.** No account. Can read a non-private document's bytes through the
  proxy and the `public/{docId}` projection. **Can never write anything**, and
  can never read a member list, a reviewer identity, or a reading statistic.
- **Any verified account.** Passes the §1 gate. Sees only what its email is in
  `members` for, plus non-private documents.
- **Member / editor / owner.** The ACL ladder.
- **An agent holding a personal access token.** Exactly its owner's identity and
  exactly its owner's ACL. No service accounts, no impersonation.
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

Browser uploads and duplicates are created `trusted: false`. CLI and MCP
publishes — where the publisher is an authenticated account acting deliberately
— are `trusted: true`.

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

**Mitigation, two parts.**

1. `/content/**` and `/download/**` collapse "you may not read this" and "this
   does not exist" into the same **404**. Mutation endpoints keep 403, where the
   caller is acting inside their own workspace and already knows the id.
2. Presence is gated by a **server-maintained mirror**
   (`presenceAccess/{docId}/{emailKey}`) rather than by the identity gate. RTDB
   rules cannot query Firestore, so the authorization data has to live in RTDB.
   It fails closed: a missing entry means presence goes dark, never that a
   stranger can read it.

Part 2 matters more than it looks. The presence payload now carries a live
selection stream, which reveals what a person is reading sentence by sentence —
considerably more than a name.

### A public document leaks its private fields

Firestore rules cannot project fields, so a naive "allow anonymous `get` when
public" would hand the world `members`, `viewers`, `ownerEmail` and `stats`.

**Mitigation.** A separate world-readable `public/{docId}` projection carrying
only render fields, written by the same server paths that recompute `members`
and deleted the instant visibility returns to private. The `docs/{docId}` rule
is untouched. Everything else under `docs/**` still requires an account, even on
a public document — publishing a document must not publish the people who
reviewed it.

### A client forges provenance

An automation could otherwise claim to be a human, or a human could claim to be
an audited agent.

**Mitigation.** `uid`, `email`, `channel` and `tokenId` are derived server-side
from the credential actually presented. `/mcp` stamps `mcp` unconditionally. On
the direct-Firestore write path, `firestore.rules authoredBySelf()` pins
`actor.channel == 'web'`, because a rules-evaluated client write *is* the web
channel by definition — automation goes through the Admin SDK, which bypasses
rules entirely.

`client` and `agent` are self-reported, stored verbatim, and **rendered as
self-reported**. A badge implying verification it does not have would be worse
than no badge.

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
need server-side rendering.

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
