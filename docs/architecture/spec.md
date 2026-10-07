# Bikeshed — implementation spec (normative)

Every module MUST conform to this file. It supersedes prose elsewhere, including
`README.md` and `docs/architecture/overview.md`. Field names, endpoint shapes, and the
auth flow are FIXED here. If something is underspecified, prefer the simplest
choice consistent with the rest of this document.

**Section numbers are a public API.** Roughly a hundred source files cite
`(SPEC §N)` in their header. Append, never renumber. A withdrawn section becomes
`§N. (withdrawn — see §M)` and keeps its number forever.

---

## 0. What this is

Versioned document publishing with highlight-anchored feedback.

People publish self-contained HTML bundles or Markdown sources, share them with
named reviewers, teams, or the public, and collect threaded comments anchored to
highlighted passages. Documents are immutable versions; content lives in a
private bucket and is served only through an authorizing proxy. Publishing and
infrastructure are driven by idempotent scripts, a terminal CLI and an MCP
endpoint, so agents are first-class publishers alongside people.

---

## 1. Identity gate

A request is valid only if it is signed in with a **verified** email address:

```
request.auth != null && email_verified == true && email is string
```

`email is string` is a real conjunct, not decoration: a custom token can carry
`email_verified: true` with no `email` claim, and without this the principal
reaches the member checks and denies only by accident.

There is **no built-in domain restriction**. The per-document owner+member ACL
is the access control. A deployment MAY add a domain allowlist; it is empty by
default, which means open.

**All emails are stored and compared LOWERCASED.** This is what makes the
`array-contains` list rule in §5 exact rather than merely close.

### 1.1 Single source of truth

`config/access-policy.json` is the only place the policy is written. It is
rendered by `tools/build-policy.mjs` into four **committed** artifacts, each
carrying a `GENERATED — DO NOT EDIT` banner and the source sha256:

| Artifact | Why it exists separately |
|---|---|
| `firestore.rules` | `.rules` files cannot import |
| `database.rules.json` | same |
| `functions/src/generated/policy.ts` | Cloud Functions uploads only `functions/`, and tsconfig pins `rootDir: "src"` |
| `app/src/generated/policy.ts` | Vite bundles only what it can import from `app/src` |

`npm run check:policy` re-renders in memory and byte-compares. It runs as
`pretest` and as the first step of `npm run build`. The artifacts are committed,
not gitignored: a security boundary that is not in git is not reviewable and has
no diff history.

The renderers in `config/policy.mjs` are **pure functions**, so the rules tests
render allowlist mode in memory and feed the string straight to
`initializeTestEnvironment` — no temp file, no second fixture that can drift.

### 1.2 The client never receives the allowlist

Vite inlines everything it imports into the public bundle, so `app/src/generated/
policy.ts` carries the email SHAPE rules and one boolean (`POLICY_IS_OPEN`) and
never the domain list. The client learns policy outcomes from `POST /session`,
which returns exactly four typed outcomes: `ok`, `unverified`, `not_allowed`,
`session_failed`.

### 1.3 Email validity

Two separate questions, never conflated:

- `isEmailShapeValid(email)` — structural. Always applies. Rejects whitespace,
  control characters, `..`, leading/trailing dots, and **`$ # [ ] /`**. The last
  five are illegal RTDB key characters, and the presence mirror (§16) keys on
  email — so this validator is what guarantees every stored address is
  representable as a key.
- `isAllowedEmail(email, policy)` — policy. Applies only when an allowlist is
  configured. Matching is **anchored**: `example.com` does not match
  `a@evil.example.com`. A leading dot (`.example.com`) is the explicit
  subdomain opt-in.

Two distinct 400s so the UI can explain: `invalid email address` versus
`email not permitted by policy`.

### 1.4 Two consequences of an open gate

**(a) Presence is gated by a server-maintained mirror, not by the identity gate.**
See §16. Without it, any signed-in account could enumerate the slug space and
learn who reads what.

**(b) Read-only endpoints collapse 403 into 404.** `/content/**`,
`/download/**`, `/unlock` and `/view` return `404` for "you may not read this"
and for "this does not exist" alike. Mutation endpoints answer `403` only to a
caller who may READ the document, who already knows the id; everyone else gets
the same `404` as an absent id, or every write endpoint would be the existence
check the read paths closed. This drops no feature and closes the existence
oracle that an open gate would otherwise open. "May read" includes an unlisted
document's key or link grant (§17), and nothing less: without them an unlisted
document answers exactly as a private one.

---

## 2. HTTP endpoints

Hosting rewrites → Cloud Functions v2, region **`us-central1`** (FIXED; Hosting
rewrites require it). Export names are FIXED and are asserted to match
`firebase.json` and `scripts/lib/endpoints.mjs` by `functions/test/wiring.test.js`.

| Rewrite | Function |
|---|---|
| `/session` | `session` |
| `/config` | `appConfig` |
| `/access` | `setAccess` |
| `/publish` | `createDoc` |
| `/folder` | `createFolder` |
| `/folder-access` | `setFolderAccess` |
| `/organize` | `organize` |
| `/fork` | `forkDoc` |
| `/trust` | `trustDoc` |
| `/marking` | `setMarking` |
| `/visibility` | `setVisibility` |
| `/team` | `manageTeam` |
| `/team-members` | `manageTeamMembers` |
| `/tokens` | `manageTokens` |
| `/view` | `recordView` |
| `/unlock` | `unlockDoc` |
| `/draft` | `saveDraft` |
| `/commit` | `commitVersion` |
| `/thumb` | `saveThumbs` |
| `/mcp` | `mcp` |
| `/sitemap.xml` | `sitemap` |
| `/verify/**` | `verifyEmail` |
| `/download/**` | `downloadBundle` |
| `/draft/**` | `getDraft` |
| `/content/**` | `contentProxy` |
| `/thumb/**` | `contentProxy` |
| `/d/**` | `docShell` |
| — (Firestore trigger) | `onCommentCreated` |

Rewrite order matters: exact paths precede wildcards, which precede the SPA
catch-all. `/folder` is an exact rewrite, so `/folder/{id}` correctly falls
through to the SPA. `/d/**` is the one rewrite that serves a **client route**:
`docShell` answers with the app shell itself, not an API (§17 "Link previews").

**`Cache-Control` for `/content/**` and `/thumb/**` is set by the function, not by Hosting.**
A Hosting `headers` entry would override the function and force one policy on
both gated and public content; §17 needs them to differ.

Every endpoint is **auth-first**: authentication is checked before anything that
could reveal whether a document exists. The one exception is `GET /d/**`, which
never authenticates at all: it decides from the document record and `k` alone,
and answers a private slug and an absent one with the same bytes (§17 "Link
previews").

### `POST /session`
Body `{ idToken }`. Verifies with `verifyIdToken(idToken, true)` and applies §1.
Mints a session cookie (`createSessionCookie`, 5 days) and sets `__session` —
the only cookie Firebase Hosting forwards to functions — as
`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=<expiresIn s>`. It also
merges `{ uid, email }` into `users/{uid}`, the record every email finds a
person by (§14), so an account whose address arrived verified has one from its
first sign-in; a preference already saved there is kept, and a failed write is
logged rather than refusing the sign-in.

Response `200 { status: "ok" }`, or `200 { status: "unverified" }`,
`403 { status: "not_allowed", message }`, `401 { status: "session_failed" }`.
The status is a typed outcome, not an error string, so the UI can explain
rejection as a *state* rather than a failure.

### `DELETE /session`
Clears `__session` (Max-Age=0). `204`.

### `GET /config`
Public. Returns `{ signInHint?: string }` — a deployment-authored sentence for
the rejection screen. **Never the allowlist.**

### `GET /content/[~<k>/]:docId/:versionId/*`
Path after `versionId` is the relative file path; default `index.html`.

An unlisted document's key may come as a first path segment `~<k>`, ahead of
the document, as well as `?k=`. The viewer puts it in the path: a query string
belongs to one URL, so the entry got it and every file the entry names by
relative path was requested without it, and a signed-out reader of the link got
the text and none of its images or stylesheets. A path segment is inherited by
every relative reference. A document id never starts with `~`, so the segment
is unambiguous (`contentPath` in `lib/http.ts`).

1. Resolve the caller: `__session` cookie, else anonymous.
2. Load `docs/{docId}`. If absent → `404`.
3. Decide the caller's `readBasis` (§17): member, public, link (the path's or
   the query's `k` matches the document's token) or grant (a signed-in caller's
   current link grant). None → **`404`** (§1.4b).
4. Version must exist → else `404`.
5. Stream `gs://<bucket>/docs/{docId}/{versionId}/<relPath>` with the Admin SDK.

Headers: `Content-Type` from the extension; `X-Content-Type-Options: nosniff`;
`Cache-Control: private, no-store` for a member's or a grant's read,
`public, max-age=300` for a read the URL alone decides — public, or unlisted
with `k` — because a grant's URL carries no key and a shared cache keys on the
URL; `X-Robots-Tag: noindex` when visibility is `unlisted`.
Never send a restrictive `X-Frame-Options`/`frame-ancestors` — the content must
embed same-origin in the app's iframe.

Streamed with `file.createReadStream()`; large files are never buffered whole.

### `POST /thumb`, `GET /thumb/[~<k>/]:docId/:versionId/:key/:slot.jpg`

A version's **thumbnails**: a cover for its workspace card and, for a deck, one
image per slide for the rail. Nothing here renders a document, so they are
captured in an editor's browser from the previews §6d builds, and stored so
every member sees them without anybody rendering them again.

- **`POST /thumb?doc=&v=&kind=cover|slides&sizes=<n>,…&r=<revision>`** — the
  body is the JPEGs back to back, in slot order. `r` is the capture revision,
  raised whenever capture changes what an image of the same bytes looks like;
  any but the deployment's own is a `409`, so a page left open from an older
  release cannot store what a newer capture exists to replace. Editors only: `isDocEditor`, not open
  editing's wider `canEdit`, because a stored image is shown to every member.
  `409` once expired to the caller — to everyone but its owner, who alone
  still reads an expired document and so may store its cover — or when `v` is
  not `currentVersion`. Each image must be a
  JPEG by its own markers, at most 160 KiB and 1280 px a side; a cover is one
  image, slides at most 100. The objects go in under a key minted per upload,
  and a transaction makes that key the record's only if this kind is not yet
  stored for `v` by this revision; a loser deletes what it wrote. A newer
  revision replaces an older one's images for the same version and deletes
  their keys, so a capture that got an image wrong is not stuck with it until
  the next version. Moving the record to a new version deletes the old
  version's thumbnails. Never touches `updatedAt`.
- **`GET /thumb/…`** — `contentProxy`, through the same gate as `/content`: an
  expired document's thumbnails are a `404` to everyone but its owner. Serves
  only what `docs/{docId}.thumb` names. `Cache-Control: private,
  max-age=min(86400, seconds to expiry), immutable` for a member's or a grant's
  read — the key in the URL means the bytes there never change, and the window
  bounds what a removed member's browser keeps — and the `/content` policy for
  a read the URL alone decides.

### `GET /d/:docId[/:versionId]`
Serves the app shell — the same bytes Hosting would serve for any client
route — and, when the document is readable **anonymously** (§17), with the
document's own `<head>` spliced in for crawlers. The rules are `contentProxy`'s
for an anonymous caller: private, expired, and unlisted without the exact `k`
all get the generic shell, the owner included.

**It never authenticates.** The response may be cached at a public URL, so
whatever it carries is what a stranger may see; a member's tab title comes
from the client. Headers: `Content-Type: text/html`, `nosniff`;
`Cache-Control: private, no-store` for the generic shell,
`public, max-age=min(300, seconds to expiry)` for a document, plus
`X-Robots-Tag: noindex` when it is unlisted. **200 in every case** — a private
slug and an absent one are byte-identical (§1.4b). The function's only other
answers are `405` for a method other than `GET`/`HEAD` and `503` when no shell
has ever been adopted from Hosting (§17); a `403` with an HTML body is the
platform refusing the invocation, not the function answering
(`docs/operations/overview.md`). Accepts `?k=` exactly as `/content/**` does.

### `POST /unlock`
Body `{ docId, k? }`. What a reader who is not a member may know about a
document, and the one place an unlisted document's key is exchanged for access.

`200` with the reader projection — `public/{docId}`'s fields (§17) without
`publishedAt` — when the caller's `readBasis` is `public`, `link` or `grant`, or
`member` of a non-private document. A signed-in caller whose basis is `link`
gets a link grant first (§4, §17). Everything else is **one identical `404`**
with an empty body: absent, private (to its members too, who read
`docs/{docId}` directly), unlisted without the key or with a wrong one, and a
grant from before the link was rotated. `400` only for a missing or malformed
`docId`, which says nothing about any document. Expiry is not checked, as in
the projection: the reader is told a document expired rather than shown nothing.

The key travels in the body, never the query, so it stays out of request logs.
`Cache-Control: private, no-store` on every answer. The grant is read in the
same round trip as the document whether or not either exists.

### `POST /access`
Body `{ docId, add?: [{ email, role }], remove?: string[] }`, where `role` is
`"viewer"`, `"suggester"`, `"editor"` or `"approver"` (§13). `add` entries
accept a plain email or a `team:{teamId}` grant (§18).

Owner-only. Applies deltas with set semantics (one role per principal; the owner
is never removed and never stored in a role), expands team grants, folds in the
parent folder chain, and writes the four grant lists `{ viewers, suggesters,
editors, approvers }`, the four effective sets `{ members, suggesterMembers,
editorMembers, approverMembers }` and `updatedAt` via the Admin SDK. Records an
entry in `docs/{docId}/acl` with the acting `Actor` (§17). Syncs the presence
mirror (§16) and the public projection (§17).

`200 { viewers, suggesters, editors, approvers, members }`.

### `POST /draft`, `GET /draft/**`, `POST /commit`
Editor-gated (`canEdit`, which on an unlisted open-editing document accepts the
caller's link grant), Admin-SDK only, versions immutable — a commit always
mints a NEW `vN+1`. A refused caller gets `404` unless they may read (§1.4b).

- **`POST /draft`** — `{ docId, baseVersion, entry?, html }`. `409 { currentVersion }`
  when `baseVersion !== currentVersion`. Writes `docs/{docId}/draft/{entry}` and
  `docs/{docId}.draft`. For a Markdown-sourced document the edited HTML is
  converted to Markdown server-side and `index.md` is what is stored (§11).
- **`GET /draft/:docId/*`** — serves the draft prefix, **falling back** to
  `docs/{docId}/{baseVersion}/<relPath>` for anything the draft does not carry,
  so first-edit and non-entry assets render. `private, no-store`.
- **`POST /commit`** — `{ docId, baseVersion }`. `409` if stale, if there is no
  draft, or if any annotation on the current version is unresolved
  (`{ unresolvedCount, pendingSuggestions }`; the message says which kind holds
  it, since only an approver can clear a pending suggestion, §6a). Assembles base assets + edited entry, re-renders
  Markdown if applicable, hashes with the §9 framing, **dedups on `contentHash`**
  (identical bytes → no-op, clear the draft, `deduped: true`), else uploads and,
  in one transaction, creates `versions/{vN+1}`, bumps `currentVersion` and
  clears `draft`.

### `POST /suggestion`
Every change to a suggested edit (§22), `{ op, docId, versionId, k?, … }`, and
the only writer of an annotation's `suggestion` field. `private, no-store`.
Anonymous `401`; a caller who may not read `404` (§1.4b); an expired document
`409`.

| `op` | Body | Who | Refused with |
|---|---|---|---|
| `create` | `anchor, replacement, note?` | `canSuggest`, any channel | `403` a reader who may not suggest; `409 { currentVersion }` not the current version; `409` twenty pending by this author; `400` a bad anchor, a replacement with a line break or control character, or one equal to its quote |
| `revise` | `annId, replacement, note?` | its author, in the app | `403` anyone else; `409` decided or claimed |
| `withdraw` | `annId` | its author, in the app | the same; deletes the thread |
| `claim` | `annId` | an approver, in the app | `409 { claimedBy }` another approver's live claim |
| `accept` | `annId` | an approver, in the app | `409` no draft of this version; idempotent once accepted |
| `reject` | `annId, reason?` | an approver, in the app | idempotent once rejected |

Every op but `create` refuses a token with `403`: deciding is a person's act.
`create` answers `{ annId, versionId }`; the others `{ state }`.

### Workspace endpoints
- **`POST /publish` (`createDoc`)** — raw body is the uploaded file; metadata in
  the query string (`?filename=&title=&id=&folderId=&marking=`). Accepts a single
  `.html`, a `.md`/`.markdown`, or a `.zip`. Mints `v1`, `trusted: false`.
  `title` is optional: for HTML the document's own `<title>` (read by the §17
  head scanner, else `og:title`) is the default, then the file name without its
  extension; for Markdown, the first level-one heading. `id` is optional too:
  the docId to publish at, refused with a `400` before anything is stored if it
  breaks the rules in §4. A taken `id` is not refused; see §4.

  **`?update=<docId>[&k=]`** publishes a new version of that document instead,
  through the same `reviseDocument` as `update_document` (§19). It is the one
  way to revise with a `.zip`, because the tools take text. It takes
  `isDocEditor`, not `canEdit`: uploading a bundle into a document is a
  re-upload in all but name, which open editing does not extend to. `id`,
  `folderId` and `title` with it are a `400`; a refused caller gets the usual
  `404`/`403` (§1.4b); an expired document a `409`; a pending suggestion on the
  current version a `409 { error, pendingSuggestions }` (§6a). A new version
  withdraws trust, as every update through a token does (§6c). Answers
  `{ docId, versionId, contentHash, fileCount, bytes, deduped }`.
- **`POST /folder` (`createFolder`)** — `{ name, parentId? }`.
- **`POST /folder-access` (`setFolderAccess`)** — same delta shape as `/access`;
  owner-only; cascade-recomputes the whole subtree.
- **`POST /organize`** — `{ kind, id, op, targetFolderId?, name? }`. Document
  deletion is deliberately unsupported (`400`). Renaming a document takes
  `canEdit`; **moving it takes `isDocEditor`**, because filing a document into a
  folder makes that folder's members its members, and open editing would
  otherwise let any account file someone's document into its own folder and
  become a member.
- **`POST /fork` (`forkDoc`)** — `{ op: "create" | "lineage", docId, k?, ... }`
  (§21). `create` is `canRead`-gated on the source (a link grant or `k` counts;
  `404` otherwise) and takes `versionId?`, `folderId?`, `title?`; the fork is
  owner-only, private and `trusted: false`. `lineage` answers where a document
  came from, as far as the caller may see, and its forks for its owner. Both
  answer per caller, so the handler sets `noStore` first.
- **`POST /trust`** — owner-only global trust (§6c).
- **`POST /marking`** — owner-only export marking (§20).
- **`POST /visibility`** — owner-only `{ docId, visibility, publicEdit? }` (§17).
- **`POST /view` (`recordView`)** — reading heartbeat; see §4. Carries `k` in the
  body for an unlisted document; without a read basis it is the `404` an absent
  id gets, and nothing is counted.
- **`GET /download/:docId/:versionId`** — `canRead`-gated zip of the version;
  accepts `?k=` as `/content/**` does.

### Account, team and token endpoints
- **`POST /verify/start`**, **`POST /verify/complete`** — §14.
- **`POST /team`**, **`POST /team-members`** — §18.
- **`POST /tokens`** — `{ op: "create"|"revoke"|"list", ... }` — §19.
- **`POST /mcp`** — streamable HTTP MCP endpoint, PAT-authenticated — §19.
- **`GET /sitemap.xml`** — public documents only.

---

## 3. Auth flow (web app)

1. Sign in with Google or GitHub (`signInWithPopup`). The Google provider sets
   `prompt: "select_account"` — without it, a rejected account is silently
   reused on the next attempt and the screen appears dead.
2. GitHub requests the `user:email` scope explicitly. Without it Firebase
   receives no email for users who keep theirs private, and an email-keyed ACL
   cannot grant anything to a user with no email.
3. `auth/account-exists-with-different-credential` triggers the linking flow
   (§14). One account per email is the intended invariant, not a limitation.
4. Get the ID token and `POST /session` to set `__session` — required so the
   same-origin iframe can load gated `/content/**`.
5. Re-`POST /session` on every `onIdTokenChanged`.
6. Sign out: `DELETE /session`, then `auth.signOut()`.

The app talks to Firestore directly for doc lists, annotations and comments
(gated by `firestore.rules`). It loads document CONTENT only through the
`/content/**` proxy.

---

## 4. Firestore data model

`app/src/types.ts` is the typed source of truth; this section is normative about
meaning.

```
docs/{docId}                                   DocMeta
docs/{docId}/versions/{versionId}              DocVersion       (immutable)
.../annotations/{annId}                        Annotation
.../annotations/{annId}/comments/{commentId}   Comment
docs/{docId}/trust/{uid}                       PersonalTrust
docs/{docId}/viewers/{uid}                     ViewerStat
docs/{docId}/views/{sessionId}                 ViewSession
docs/{docId}/acl/{entryId}                     AclChange        (append-only)
docs/{docId}/linkGrants/{uid}                  LinkGrant        (server-written)
forks/{forkDocId}                              ForkRecord       (server-only, §21)
folders/{folderId}                             FolderMeta
teams/{teamId}                                 TeamMeta
users/{uid}                                    UserRecord
users/{uid}/tokens/{tokenId}                   TokenRecord
public/{docId}                                 PublicDoc        (projection, public only)
```

**An `Annotation` with a `suggestion` field is a suggested edit** (§22):
`suggestion: { replacement, state: "pending" | "accepted" | "rejected",
claim?, decidedBy?, decidedAt? }`. Its `resolved` is `false` while pending and
`true` once decided, so it counts as an open thread everywhere one is counted.
Only `POST /suggestion` writes the field. A **`Comment`** may carry
`opensSuggestion` (the thread's first comment) and `generated` (text the server
wrote rather than the author), and no client may write either.

**`linkGrants/{uid}`** is `{ uid, token, grantedAt }`: this account presented an
unlisted document's key, and `token` is the one it presented. It counts only
while that is still `linkToken`, so rotating the link revokes every grant
without touching one. Written only by `POST /unlock`; no client reads or writes
it (§17).

**`members`** is the EFFECTIVE read set: the union of `ownerEmail`, every
direct grant list, the parent folder chain's grants, and the expansion of any
`team:{id}` grant — all lowercased. It is the array the doc list queries. The
owner is always in it. `viewers`, `suggesters`, `editors` and `approvers` remain
the DIRECT grants and are the record of intent; `members` is the record of
reality.

**`suggesterMembers`**, **`editorMembers`** and **`approverMembers`** are the
EFFECTIVE sets of the three upper roles, each containing the one above it
(§13). `editorMembers` missing on legacy records ⇒ fall back to `editors`; the
other two missing ⇒ empty, which is correct, since nobody held those roles
before the sets existed.

**`trusted`** is GLOBAL trust: it controls whether the viewer sandboxes the
content iframe FOR EVERY READER. Every publish through `publishNewDocument` —
browser upload, fork, the end-user CLI and MCP alike — creates it `false`;
only the operator script `scripts/publish.mjs`, which runs with Admin
credentials, creates it `true`; afterwards the owner flips it via `/trust`.
`commitVersion` leaves it untouched, so trust PERSISTS across in-app edits.
Missing ⇒ treated as trusted.

**`stats`** is the denormalized usage rollup, so the workspace list renders
counts with no extra reads and any member can see the AGGREGATE. Written only by
the Admin SDK, always as a nested map under `set(..., { merge: true })` so the
view writer and the edit writer never clobber each other.
`recordView` deliberately does NOT touch `updatedAt` — that field means "bumped
on every publish", and a read must not masquerade as a publish.

**`thumb`** is `{ versionId, rev?, cover?, slides?: { key, count } }`: which
version's thumbnails are stored, by which capture revision (absent is the
first), and under which keys (§2 `POST /thumb`). Storage holds
them at `docs/{docId}/thumbs/{versionId}/{key}/{cover|s<n>}.jpg` — beside the
version's prefix, never under it, because everything that reads a version (the
next commit's content hash, a fork, the download) takes every object under
`docs/{docId}/{versionId}/`. Written only by the Admin SDK, never with
`updatedAt`: a captured image is not a publish. It may name an older version
than `currentVersion` until an editor next opens the document, and the workspace
shows that cover meanwhile.

`stats.apiReads` counts automated reads. They never enter `stats.views` or
`stats.totalMs`: reading *time* is a human concept and an agent fetching a
document forty times would otherwise turn both into noise (§17).

**Versions** are immutable and mint as `v{max(N)+1}` over EXISTING version
documents, so a withdrawn id is re-used by the next commit. `views/{sessionId}
.versionId` may therefore carry a `"{versionId}-deleted"` tombstone, written by
`delete-version.mjs`, so old and new sessions are never conflated under one id.
Withdrawing a version also deletes its thumbnails and clears a `thumb` naming
it, since a re-minted id would otherwise inherit them.

`createdAt` is set once. `updatedAt` is bumped on every publish.

**A docId** is the document's address, `/d/{docId}`, and never changes. The
publisher may ask for one (`id` on `/publish`, on `publish_document`, and
`--id` in the CLI); otherwise it is `slugify(title)`. An asked-for id must be
lowercase letters and digits with single hyphens between them, at most 60
characters: exactly what `slugify` produces, because the id is also a Realtime
Database key, an unencoded link and a quoted download filename. If the id is
taken the document is still created, at `{id}-{six random [a-z0-9]}`. An id is
taken if a record holds it or if bytes are already stored under it: a new
document's bytes are written only where no object exists yet, and a refused
write moves the document to a suffixed id.
The publisher learns that the id was taken and nothing more; the suffix is
random, so it no longer says how many share the name. The returned `docId` is
the answer; callers must not assume they got what they asked for. Ids minted
before this rule, `-2`, `-3` and so on, keep their addresses. Rename changes
`title` and `slug`, never the docId.

---

## 5. Doc list query

```js
query(collection(db, "docs"),
      where("members", "array-contains", emailLower),
      orderBy("createdAt", "desc"))
```

One query suffices because the owner, inherited folder grants and expanded team
grants are all already in `members`. The composite index is declared in
`firestore.indexes.json`.

The matching `list` rule must be **statically provable from the query
constraints** — rules are not filters. That forbids a transformed expression
like `email.lower()` in the rule, which is why members are stored lowercased as
an invariant. **Any change that makes `members` something other than a flat
array of lowercased emails breaks this rule and therefore the entire workspace.**

---

## 6. Annotation mechanics

The document renders in `<iframe src="/content/{docId}/{versionId}/{entry}">`.
Because it is same-origin, the parent app drives annotation directly on
`iframe.contentDocument`. **The proxy injects nothing.**

- On `load`: inject one `<style>` into the iframe head for `.bshd-hl`.
- Selection → anchor: `dom-anchor-text-quote` (`fromRange`/`toRange`) plus
  `dom-anchor-text-position` as the fallback, both scoped to the **nearest
  ancestor element carrying an `id`**, stored as `anchor.elementId`. Selectors
  are computed relative to that element so they survive content above it
  changing.
- Rehydrate: find the element by `elementId`, `toRange` the quote selector
  within it; **if the range is inside a collapsed `<details>`, open it first**,
  then wrap in `<mark class="bshd-hl" data-bshd-ann="...">` — or in a `<tspan>`
  carrying the same class and attribute when the text node lives inside SVG
  text, because SVG renders no foreign child of `<text>` and a `<mark>` there
  paints nothing.
- Wrapping is per-text-node, so existing element nodes are never destroyed or
  re-parented. Highlights are presentational and are NEVER persisted.
- Selecting a thread brings its passage into view, centred, **unless it is
  already in view** — the usual reason it is being that the selection came
  from clicking the highlight, which is under the pointer. Once per selection:
  a redraw for a peer's comment landing must not pull back a reader who has
  scrolled on. The thread card does the same in the panel, in the other
  direction.
- **A resolved annotation is not drawn.** Resolving is how a reader says a
  passage is dealt with, so its mark comes off the prose; the thread stays in
  the panel and can be reopened there. A resolved annotation is skipped before
  its anchor is resolved, so it is never reported as orphaned either.
- **The panel starts collapsed unless there is a thread to read.** Its default
  is decided once per document, by the version's first annotation snapshot:
  open when a thread is unresolved, collapsed otherwise — resolved threads are
  hidden until asked for, so they do not count. Until that snapshot lands it
  is closed. Whichever comes first, the snapshot or the reader's toggle, wins,
  and nothing after it changes the answer: a comment landing later does not
  reopen a panel the reader closed, and a new version of the same document
  does not collapse one they had open. Starting a comment opens it regardless.
- **A click that carries a comment intent never reaches the document's own
  scripts.** A drag that selects text ends in a `click`, and a click on a
  highlight is the thread's. Both are stopped in the capture phase before any
  listener the document registered — the selection's at the frame *window*,
  which sits above the document in the propagation path and so runs first
  whatever the document attached, and whenever; the highlight's by the
  listener that already claims it. Propagation is stopped, the default action
  is not: a link still navigates (see the next point) and a `<summary>` still
  toggles. This is what keeps a deck that advances on click (§6d) on the slide
  being annotated.
- **A link out of the document opens beside it.** A link that leaves the
  version — another site, the app's own pages, another version — opens in a new
  tab from the parent, with `noopener,noreferrer`, and its default action in the
  frame is prevented. Left to the frame, a plain link replaced the document
  inside the viewer with somebody else's page (often a framing refusal), and a
  sandboxed frame may not open a tab at all, so `target="_blank"` did nothing.
  A fragment link scrolls, and a link to another file of the same version — a
  bundle's own pages — still navigates the frame. `attachOutboundLinks`, on the
  frame window in the capture phase, reading mode only: in the editor a click
  on a link places the caret.
  Reading mode only, with the rest of the layer: the edit frame runs no script
  and the caret must never lose a click.

  The test is what *this gesture* did, not whether text is selected: the
  selection is noted at pointer-down and compared at click, and only a click
  that changed it is stopped. Measured in Chrome, that is the line that
  matters. A click that dismisses a selection collapses it on mouse-up, before
  `click`, and is an ordinary click. A selection stranded on a slide the arrow
  keys moved off is never collapsed — hidden text cannot be hit-tested — and
  is the same selection at both moments, so it passes; stopping on "text is
  selected" swallowed every click from then on. A click with no pointer-down
  before it — keyboard activation, a script's own synthetic click — is nobody
  selecting text and passes as well.

### 6a. Inline editing

The one path that writes content, and it is explicit and server-mediated.

- Edit mode points the iframe at `/draft/{docId}/{entry}`, sets
  `body.contentEditable`, and shows a WYSIWYG toolbar driven by `execCommand`.
- **The edit frame is unconditionally script-free**, whatever `trusted` says.
  `editing` is part of the iframe `key`, so toggling edit mode REMOUNTS the
  frame — sandboxing is decided at parse time. Without this, the bundle's own JS
  runs in the frame being serialized: its generated DOM is persisted as static
  markup while the generator stays in place, so every later render appends
  another copy, and any node the script rewrites on load silently discards the
  editor's typed change.
- A deck that sizes its slides with its own script renders at full size in the
  script-free edit frame, and centred in a narrower frame its slides start at a
  negative offset nothing can scroll to. While editing, the frame is laid out at
  the width the slides' content reaches — measured once per load and latched,
  as `paged` is — and the iframe ELEMENT is scaled to the stage
  (`useFrameFit`). The document is not touched.
- Containers the author left empty for their script to fill are outlined in edit
  mode. Marking is an **attribute** (`data-bshd-empty`) plus one injected
  stylesheet, **never an inserted node**, so no placeholder content can reach the
  saved bytes.
- Before serializing, `serializeCleanHtml` strips every app injection from a
  CLONE: highlight marks, the injected stylesheets, the peer-presence overlay,
  placeholder marking, and `contenteditable` attributes. App injections carry
  `data-bshd` with a value from `OWN_MARKERS` and are stripped as a class — the
  value check is what makes the namespace safe against a bundle that happens to
  use the same attribute.
- Serialization also drops any `script/style/link/meta/base` absent from the
  load-time asset inventory (`captureAssetTags`, taken in `onLoad` before any
  injection). That removes nodes a BROWSER EXTENSION added to the same-origin
  frame. It is sound only because the edit frame is script-free.
- A commit is refused when the pre-commit draft save failed. Publishing anyway
  would promote the PREVIOUS draft bytes while reporting success.
- Leaving edit mode saves only an edit the autosave has not yet taken. Any
  save creates a draft, so a save on the way out of an unchanged session
  would leave a draft that differs from nothing.
- While a draft exists, an editor reading the **published head** reads the
  draft, under a banner that says so — who saved it last, and when — and a
  version label that reads `vN · draft`. The banner is the only signal: the
  frame cannot carry one. An editor who opens an older version reads that
  version; the draft is built on the head (`readsDraft`).
- Autosave is debounced to `POST /draft`. "Save as new version" calls
  `POST /commit`, allowed only when every comment on the current version is
  resolved. Annotations are version-scoped, so the new version starts
  comment-free and the old version keeps its comments.
- **No version is minted while a suggestion on the current one is pending**,
  through ANY account channel: the in-app commit, `/publish?update=`, the CLI
  and `update_document` alike. Publishing past it would leave it undecided on a
  version nobody reads — a rejection nobody chose to make — and only an approver
  may decide it. The gate is asked after the content-hash dedup, so an
  identical update stays a no-op, and before anything is uploaded
  (`lib/review.ts`). The comment gate stays on the in-app commit alone, because
  the agent loop revises a document in answer to its open comments and a
  person resolves them afterwards (§19).

### 6b. Presence and live collaboration

Shared **awareness** and shared **document state** are both in scope. Several
people may type into one document at the same time; their edits merge and every
copy converges ([ADR 0010](adr/0010-crdt-for-shared-document-state.md)).

Document state is a **Yjs** CRDT, bound to the DOM by `app/src/crdt/binding.ts`.
The binding imposes no schema, which is what keeps §6a's guarantee intact: a
`Y.XmlElement` is a name, a string map and a child list, so a hand-authored
document with inline SVG and a `<details>` tree is mirrored exactly rather than
normalized into an editor's model. The **normative** property is that a document
survives a round trip through the wire format byte-identical; the sample bundles
are the fixtures that hold it.

Deletion beats concurrent typing: if one person removes a passage while another
edits it, the passage goes. That is the CRDT's semantics, not a policy choice,
and it is tested rather than assumed.

### 6c. Trust and the untrusted-content sandbox

Browser upload makes untrusted publishers possible, so the same-origin iframe is
not unconditionally safe: a bundle's JS could read the viewer's Firebase auth
token from the app origin's storage. The viewer therefore renders with
`sandbox="allow-same-origin"` (NO `allow-scripts`) whenever the document is not
effectively trusted. Same-origin is retained so the parent can still drive
annotation and editing; scripts are disabled so an untrusted bundle cannot
exfiltrate the token.

**Two trust scopes, split by who bears the risk.** Effective trust for a reader
is `meta.trusted !== false || personalTrust(uid)`.

- **GLOBAL** (`docs.trusted`, `POST /trust`) — un-sandboxes for EVERY reader. A
  decision made on other people's behalf, so it stays **owner-only**.
- **PERSONAL** (`docs/{docId}/trust/{uid}`) — un-sandboxes only in the granting
  user's own browser. The sole session exposed to that bundle's JS is their own,
  so **any reader may grant it to themselves**. Client-written under an own-uid
  rule. It NEVER writes `meta.trusted`.

The viewer surfaces trust ONLY when it would change something: the document is
still sandboxed for this reader AND the loaded DOM actually contains `<script>`
tags. Static uploads therefore never prompt. Nor does a reader whose own answer
is not in yet, who may already have decided.

**The first load waits for the reader's own answer.** The sandbox is read at
parse time, so a frame that loads before this reader's personal grant is known
loads sandboxed, and loads again when the grant lands. A reading frame's first
load therefore waits for that answer, within three limits:

- **Only when it could matter.** The document is not globally trusted and an
  account is known. A globally trusted document and an anonymous reader never wait.
- **Never on auth.** A link opens before sign-in has decided (§17). A key
  holder whose grant turns up after auth decides still loads twice.
- **Bounded.** At most `PERSONAL_TRUST_WAIT_MS`. Past it, the frame loads
  sandboxed and remounts when the answer lands, as it did before it waited.

A frame that has loaded is never taken away to wait. A reader who signs in to
comment keeps the document and their selection.

**Trust carries into a new version only when the owner wrote it in the app**
(`keepsTrust`). Any other new version withdraws both scopes, the global flag and
every personal grant, in the same transaction that makes it current: an edit by
an editor or an open editor, and every update through a token, which is an
upload in all but name (`update_document`, `POST /publish?update=`). A reader
trusted the scripts they had seen, not whatever somebody publishes next. A
deduplicated update mints nothing and changes nothing. Re-upload and fork
still make FRESH `trusted: false` documents.

This replaces "trust propagates across in-app edits, because platform editing
is parent-driven and cannot introduce a new bundle". The server never held that
line: `/draft` stores whatever HTML a `canEdit` caller sends, so on a trusted
document with open editing any signed-in account could commit a `<script>` that
then ran, same-origin with the app, in every reader's session.

A sandboxed document may therefore be one whose scripts were the only thing
that would have BUILT it. The viewer distinguishes "this document has no
slides" from "this document has no slides yet" and says which, because the
first is a fact about the document and the second is a decision the reader can
undo.

### 6d. Decks and presentation

There is no slide model and no deck format. A **slide** is a region the author
already treated as one, found by reading the loaded DOM (`app/src/viewer/deck.ts`).
Detection is an ordered list of rules, not one selector, because real decks
disagree: roughly half carry no `id` on a slide and roughly half never use the
class `slide`, and those two sets do not overlap. Three properties are
normative:

- **Reading order is DOM order.** Ids and index attributes are display labels.
  Decks exist whose sections are numbered out of order, and whose ids are bare
  numerals whose `#id` form is not a valid selector, so no selector is ever
  built from an id.
- **Detection never runs the document.** It reads markup, which is what makes
  it work in the sandboxed case that needs it most.
- **A document that is not a deck is unaffected.** Candidates must be siblings
  of one parent, and the navigator appears only above two slides.

Navigation **scrolls** the document and never styles it, so §7's rule stands
unchanged — with one measured exception. A deck that runs its own JavaScript
usually **stacks** its slides, every one at `position:absolute; inset:0` with
one shown at a time, and on that shape scrolling to a slide changes nothing.
When every slide's rect shares a top, navigation instead presses the arrow keys
the deck already answers to, dispatched into the frame, and reads position from
which slide is *shown* (`display`, `visibility`, `opacity`, a translating
`transform` — the same four the preview undoes) with the deck's own attribute
changes as the signal, since nothing scrolls. That is the deck's own contract;
the hash is not one (`#5`, `#/4`, `#/step-id` and `#slide=5` are all in the
wild), and toggling the deck's class would style a document this app does not
own. The one input a deck's script is denied is the click that carries a
reader's comment intent — a drag that selected text, or a click on a
highlight — which §6 stops before the deck sees it, so a deck that advances
on click stays on the slide being annotated. A stacked deck that takes no arrow keys cannot be driven from the rail and
falls back to the scroll, which leaves it exactly where it was. The navigator —
rail, overview and arrow keys alike — appears only when slides measure about
one viewport tall. On a document whose sections are
taller, taking the arrow keys would leave the reader unable to scroll within a
section, and a thumbnail of a section three screens deep is a smudge nobody can
read. That measurement is **latched per document load**: the rail's own width
narrows the frame, so a navigator that re-decided on every resize could unmount
itself, widen the frame, reappear, and oscillate. Keys are bound on both the
parent and the frame document, because an iframe's key events never reach the
parent, and yield to `defaultPrevented` so a trusted deck's own navigation wins.
`o` opens and closes the overview, and Escape closes it; with the overview shut,
Escape is left untouched for whatever else is listening — presentation mode's
fullscreen exit, a menu, a dialog.

**Previews are a separate document.** The rail and the overview render each
slide into a parent-built `srcDoc` iframe, scaled down, carrying the document's
own stylesheets minus every `data-bshd` node, and a `<base>` pointing at the
content proxy. A preview renders the slide **in the CSS context it was written
in**: every ancestor up to `<body>` is reproduced, shallowly, with its
attributes, and `html` and `body` keep theirs. A deck whose slides take their
width from a container rule, or whose slides live inside `<svg><foreignObject>`,
has no layout at all without them. For the same reason a preview forces only
visibility — never position, inset, margin or size — and forces `display` or
`transform` only where the live document shows that is what hides the slide.
Every preview in one deck is laid out at **one** size, the reader's own frame
viewport, so the same media queries resolve and the rail cannot go ragged.

A preview shows a slide in its **final state**, not its first frame. Decks
animate a slide's content in when the slide is shown, and a preview is never
shown anything: it loads once and runs no script. So every animation in a
preview is zero-length — already over, its fill mode deciding what stays — and
transitions are off. Content a deck keeps hidden until its script marks the
slide active never animates at all there, so once the preview has loaded,
whatever inside the slide still computes to `opacity:0` or `visibility:hidden`
is marked and forced visible, skipping `position:fixed` chrome with its subtree.
Like the slide rule, only those two layout-neutral properties are forced.
Decoration is stripped from the copy by the same function the serializer uses:
highlights are unwrapped to their text and our own nodes removed by value, so
one reader's annotations never appear in a preview.

The same previews are what a **stored thumbnail** (§2 `POST /thumb`) is
captured from: in an editor's browser, once per version, rendered in a frame of
the app's own and rasterised to JPEG. A deck's cover is its first slide and its
rail is every slide; any other document's cover is its first screen. Every
stored image is laid out at one fixed stage, 1280×720, whoever captured it, so
an editor on a phone does not decide every member's cards are portrait — and
shows the document as a reader who prefers light sees it, whatever the
capturing browser prefers, so an editor running their system dark does not
decide every member's cards are dark. A document that declares itself dark is
dark by design and stays so; only `prefers-color-scheme` is answered. A
capture happens only on the published head, read rather than edited, with no
draft, by an editor, on a document that has not expired or is the editor's
own — and only when the
editor's frame runs scripts exactly when everyone's does. A reader who trusted
a document for themselves runs its scripts with their own access, and those
scripts could paint something of theirs into the page that a stored image would
then show to every member.

A document nobody has opened since then would otherwise keep a placeholder
for good, so the **workspace fills in missing covers** for the cards it shows,
in an editor's browser, one at a time: it fetches the published entry once,
parses it without running anything, and captures the first screen of the same
page preview — for a deck, its first slide, since a deck without its script
shows its slides in order. It takes only what the viewer would: an editor's,
unexpired unless it is their own, with no cover stored for the current version
by this capture. A
document every reader runs the scripts of, and that has scripts, is left for
an editor to open, since a capture that runs none could show everybody a page
none of them sees; an untrusted document is sandboxed for every reader, so its
first screen without scripts is exactly theirs.

Reading the published head, the rail and the overview show those **stored
images** instead of building previews, when the record holds a rail for exactly
this version with exactly as many slides as the deck on screen: one request per
slide, kept by the browser for a day, rather than every slide's assets fetched
again on every visit. Editing, a draft, another version or another slide count
all use live previews, since the stored rail no longer describes what is on
screen, and an image that will not load falls back to its live preview.

Previews are sandboxed `allow-same-origin` with NO `allow-scripts`, even for a
trusted document. Because a preview is a copy the app constructs and nothing
serializes, the layout it forces on that copy is not a restyle of embedded
content and cannot reach published bytes — and for the same reason the marker
it uses to find the slide is set on the copy, never on the document being read.

Presentation mode hides app chrome with a class on `<body>` and requests
fullscreen as an enhancement; the CSS state is what hides the chrome, and the
app's state follows `fullscreenchange` rather than assuming it.

---

## 7. Web app structure

```
app/src/
  main.tsx App.tsx
  brand/{tokens.ts,dom.ts,fonts.ts,Wordmark.tsx,Mark.tsx}
  styles/*.css                      (14 files, @layer tokens,base,primitives,layout,feature)
  generated/policy.ts               (GENERATED)
  config.ts firebase.ts auth.tsx analytics.ts
  firestore.ts access.ts folders.ts teams.ts upload.ts edit.ts trust.ts
  presence.ts stats.ts tokens.ts visibility.ts marking.ts
  annotation/{anchor.ts,highlighter.ts,Sidebar.tsx}
  wysiwyg/{EditToolbar.tsx,placeholders.ts}
  export/{labels.ts,html.ts,pdf.ts,image.ts}
  viewer/{useDocFrame.ts,useAnnotationLayer.ts,useInlineEditor.ts,...}
  workspace/tree.ts
  pages/{DocList.tsx,DocViewer.tsx,SignUp.tsx,Account.tsx,Legal.tsx,Landing.tsx}
  components/*.tsx
  hooks/{breakpoints.ts,useMediaQuery.ts}
```

**Accessibility is a hard requirement:** visible `:focus-visible`, targets ≥44px,
colour is never the sole signal, `prefers-reduced-motion` honoured, WCAG AA
contrast. Brand chrome only — **never restyle embedded document content.**

---

## 8. Functions ownership

```
functions/src/
  index.ts                 all exports (§2)
  config.ts                bucket, region, limits, secrets
  generated/policy.ts      GENERATED
  lib/{auth,acl,access,folders,hash,bundle,presence,actor,publicdoc,linkgrant,teams,tokens,head,html,shell}.ts
  lib/markdown/{render,serialize,slug,theme.ts}
  email/{send,cooldown,templates/*}
  mcp/{server,tools}.ts
```

- `lib/auth.ts` — the §1 gate over a decoded token, an ID token, a session
  cookie, or a personal access token.
- `lib/acl.ts` — `readBasis`, `canRead`, `isDocEditor`, `canEdit`,
  `canManageSharing`, and the folder equivalents. **`acl.ts canRead()` MUST
  mirror `firestore.rules` `canRead()`** for a caller with an account; they are
  tested on both sides. `tokenMatches` is the only place a link token is
  compared, and a wiring test holds it there.
- `lib/linkgrant.ts` — reading and recording link grants (§17).
- `lib/hash.ts` — the §9 framing, byte-identical to `scripts/lib/hash.mjs`.
- `lib/head.ts` — what a document's own `<head>` and first words say about it
  (§17 "Link previews"): an `indexOf`-driven scanner over the entry's first
  256 KiB, linear on adversarial input, with no HTML parser.
- `lib/html.ts` — escaping for markup the functions emit into the app shell;
  separate from the Markdown renderer's escaper, whose bytes are part of the
  content hash.
- `lib/shell.ts` — the `docShell` decision, the page composed from it, the
  splice into the shell template, and the runtime fetch of the shell from
  Hosting; the handler in `index.ts` is glue.
- Bucket name: `BIKESHED_BUCKET` → `config/deploy.json` → `${projectId}-content`.
  **The Firebase default bucket is never assumed** (§14 of the risk register:
  `${projectId}.appspot.com` is wrong for post-2024 projects and
  `.firebasestorage.app` is wrong for pre-2024 ones).
- Never leak whether a document exists to a caller who may not read it: 401/404
  before 403 on read-only byte paths (§1.4b).

---

## 9. Scripts ownership and the content-hash framing

`scripts/` is Node ESM using `node:util parseArgs` and `firebase-admin`.
Admin is initialized **lazily**, so every `--dry-run` path runs without
credentials. Project id from `--project`, `GCLOUD_PROJECT`, or `.firebaserc`.

Scripts: `setup.mjs`, `teardown.mjs`, `publish.mjs`, `set-access.mjs`,
`delete-version.mjs`, `reconcile-visibility.mjs` (removes `public/{docId}` rows
and `editAccess/{docId}/*` keys a document's visibility no longer earns; §17). Shared helpers in `scripts/lib/`: `args`, `email`,
`firebase`, `hash`, `membership`, `endpoints`.

These are **operator** tools — distinct from the end-user `bikeshed` CLI (§19).
They authenticate with the Admin SDK and require `--account` explicitly on every
real run; the CLI authenticates with a personal access token over HTTPS.

`publish.mjs` is exempt from the pending-suggestion gate (§6a): Admin
credentials bypass every endpoint and rule, so a refusal there would be advice,
not a boundary. It prints how many pending suggestions it leaves behind on the
version it replaces instead of saying nothing.

### 9.1 The content hash (normative byte layout)

`contentHash` is a sha256 over the bundle. Two independent implementations exist
— `scripts/lib/hash.mjs` (ESM) and `functions/src/lib/hash.ts` (CommonJS) —
because the two runtimes cannot share a module. They MUST agree byte for byte,
or CLI-published and in-app-committed versions stop deduplicating and
idempotency silently dies.

```
files sorted ascending by POSIX relative path (byte order)
for each file:
    frame := UInt32BE(byteLength(relpath, "utf8")) || UInt32BE(byteLength(data))
    update(frame); update(utf8(relpath)); update(data)
digest hex
```

The length-prefixed, domain-separated framing is what guarantees no two distinct
`(relpath, bytes)` sequences can collide — including the trailing-space filename
case that naive concatenation gets wrong.

Both implementations are asserted against a **shared golden-vector fixture**
(`functions/test/fixtures/hash-vectors.json`), not against each other. A
port-vs-port comparison drifts together; a fixture does not.

---

## 10. Brand tokens

Twelve semantic tokens on `:root`, defined once in `app/src/styles/tokens.css`
and mirrored in `app/src/brand/tokens.ts`:

```
--color-bg --color-surface --color-line
--color-ink --color-ink-muted
--color-accent --color-on-accent
--color-focus --color-success --color-warn --color-danger
--color-annotation
```

**No brand-named tokens.** A token called `--teal` cannot be re-themed without a
rename, and every consumer then encodes a colour rather than a role.

`--color-focus` appears **nowhere** but `:focus-visible`, so the ring is the only
colour of its kind on the page. Shadows are tinted with the ink RGB, never
neutral black.

Typography is **one self-hosted variable font**. No font CDN: this product holds
documents people mark confidential, and a CDN tells a third party the viewer's
IP, user agent and referer on every page load. `app/src/brand/fonts.ts` exports
one `FONT_FACE_CSS` used by both the stylesheet and the iframe injector.

### 10.1 DOM namespace

All app-injected DOM uses the `bshd-` prefix, defined **once** in
`app/src/brand/dom.ts`, which also exports `OWN_MARKERS` and `isOwnMarker(el)`.

This is a correctness constraint, not a cosmetic one: `serializeCleanHtml`
*deletes* every `[data-bshd]` node it finds, so a namespace collision with an
uploaded bundle would be silent data loss. The serializer removes a `[data-bshd]`
node only when its VALUE is one we write.

---

## 11. Markdown documents

`.md` is a first-class source format: uploadable, WYSIWYG-editable, versioned,
annotated, exported and counted exactly like an HTML bundle.

**Markdown compiles to an HTML bundle at write time, server-side, exactly once
per version. The client never renders Markdown.** Every other invariant survives
untouched, and there is no dual-implementation drift risk because there is only
one implementation running in one place.

### At rest

```
docs/{docId}/{vN}/index.md      authored source, canonical
docs/{docId}/{vN}/index.html    compiled entry, what the iframe loads
```

`DocVersion` gains `format: "html" | "markdown"`, `sourceEntry?`, and
`rendererVersion`. `entry` still points at the HTML, so `contentProxy`,
`downloadBundle`, export and every ACL path are unchanged code.

Both files sit inside the hashed bundle, so §9 idempotency is preserved exactly.
The corollary: **a renderer upgrade changes the rendered bytes and therefore
mints a new version.** That is correct — the rendering is part of the artifact —
and `rendererVersion` makes it auditable. The renderer is pinned to an exact
version; a bump is a documented migration in this section.

### Rendering

CommonMark + GFM via `markdown-it`, no nondeterministic plugins. Output is a
self-contained HTML document with an embedded stylesheet and **zero external
URLs**.

- **Section wrapping.** Each heading and its subordinate content is wrapped in
  `<section id="<slug>">` using GitHub-style slugs (lowercased, non-alphanumerics
  → `-`, deduped `-1`/`-2`). Anchors scope to the nearest `id`-bearing ancestor,
  so a flat heading stream would scope every highlight to `<body>`. This is not
  cosmetic: it is what makes annotations survive edits.
- **Raw HTML flows through the existing trust model.** Rendered output keeps raw
  HTML including `<script>`, and the document obeys §6c unchanged. One concept,
  not two.

The document stylesheet is **separate from the app's design tokens and must stay
that way.** Chrome tokens never restyle document content.

### Editing

The editor still edits the rendered DOM via `execCommand`. Two changes:

- **The palette is constrained to what Markdown can express.** Font family,
  font size, text colour, highlight colour and both alignment controls are
  **disabled with a tooltip explaining why**, never silently dropped. A control
  that appears to work and then loses your formatting is worse than one that is
  visibly unavailable.
- **Save converts DOM → Markdown server-side** (`turndown` + `turndown-plugin-gfm`).
  Converting in the function keeps it to one implementation and keeps the app's
  dependency budget at seven.

**Normalization is visible at version boundaries.** The first save normalizes
(`*` bullets → `-`, setext → ATX). After that first pass it MUST be idempotent:
`md → html → md'`, then `md' → html' → md''` with `md' === md''`. That property
is the contract, and it is what keeps editing a Markdown document from slowly
destroying it.

---

## 12. Local verification expectations

| Command | Expectation |
|---|---|
| `npm run check:policy` + `git diff --exit-code` | codegen reproducible and committed |
| `npm --prefix app run typecheck && npm --prefix app run build` | exit 0, `app/dist/index.html` exists |
| `npm --prefix functions run build && npm --prefix functions test` | 0 failing |
| `npm --prefix app test` | green; coverage ≥90% on `annotation/ export/ workspace/ stats.ts brand/` |
| `npm run test:rules:emulated` | 0 failing |
| 5 script `--dry-run` commands | exit 0, **none requires credentials** |
| `npm run check:secrets` | `check-secrets: clean` |
| `npm run check:headers` | exit 0 |

**The app MUST connect to the emulators** behind `VITE_USE_EMULATORS=1`
(`connectAuthEmulator`, `connectFirestoreEmulator`, `connectDatabaseEmulator`).
This is a requirement, not a convenience: it is the single thing that makes the
quickstart cost nothing.

The Vite dev proxy MUST cover **every** endpoint but one, the `devProxy: false`
row described at the end of this paragraph. Use anchored regex keys
(`^/folder(\?.*)?$`) for exact endpoints and prefix rules only for `/content`,
`/download`, `/draft`. A naive `/folder` prefix rule would proxy the client
route `/folder/{id}` to the emulator and silently break folder deep-linking.
A row with `devProxy: false` in `scripts/lib/endpoints.mjs` is a Hosting
rewrite for a **client route** and is never proxied in dev: `/d` is rewritten
to `docShell` in production, but in dev the shell is Vite's own, and the
wiring test asserts the key is absent.

---

## 13. Workspace: nested folders and inherited sharing

Documents organize into nested folders with their own sharing. Inheritance is
**denormalized, not resolved at read time**:

```
approverMembers  = union(self owner,       self approvers,  parent.approverMembers)
editorMembers    = union(approverMembers,  self editors,    parent.editorMembers)
suggesterMembers = union(editorMembers,    self suggesters, parent.suggesterMembers)
members          = union(suggesterMembers, self viewers,    parent.members)
```

Four roles, one per principal, each able to do everything below it:

| Role | Grant list | Adds |
|---|---|---|
| viewer | `viewers` | read, comment |
| suggester | `suggesters` | propose a text change for someone else to decide on |
| editor | `editors` | edit live, publish a version |
| approver | `approvers` | accept or reject suggestions |

Each set is built on the one above it, so `approverMembers ⊆ editorMembers ⊆
suggesterMembers ⊆ members` holds by construction, even under a parent whose
record predates a set. An approver is an editor because accepting a suggestion
is replayed as an edit in their own session; the reverse would make a role
that could accept text it could not type.

Because each node only needs its DIRECT parent's already-computed arrays, the
cascade is a single BFS (`recomputeSubtree`), parent before child. Any
folder-share change or move re-fans the affected subtree server-side. The
doc-list query, its composite index and the `canRead`/`list` rules are
UNCHANGED.

`folders/{folderId}` mirrors `DocMeta`'s ACL shape and adds `parentId`,
`ancestors` (root-first) and `depth`. Folder writes are Admin-SDK only.

Folder delete is **owner-only** and reparents children to the folder's parent —
never orphans. Document delete is unsupported, deliberately and explicitly.

---

## 14. Accounts, sign-up, and email

GitHub auth, sign-up and transactional email are **one feature**, because GitHub
is precisely the provider that does not hand us a verified email, and an
email-keyed ACL cannot safely admit an unverified address.

### Providers

Both through Firebase Auth. GitHub MUST request `user:email`.

**`email_verified` is not guaranteed.** The gate in every layer stays exactly
`email_verified === true`; we do NOT introduce a second notion of verification.
The app runs its own flow and, on success, the Admin SDK calls
`updateUser({ emailVerified: true })` — writing Firebase's canonical field,
which flows into the ID token on next refresh. **One gate, one source of truth,
zero rules changes.**

**Account collision.** `auth/account-exists-with-different-credential` →
`fetchSignInMethodsForEmail` → name the provider that owns the address → sign in
with it → `linkWithCredential(pending)`. `users/{uid}.providers[]` records what
is linked. One account per email is a correctness requirement: two accounts
sharing an address would be an ACL bug.

### Sign-up

1. Choose a provider.
2. If no email came back, collect one.
3. If the email is unverified, send a code and **block until verified**.
4. Create `users/{uid}` — done by `POST /session` on every sign-in, merged, so
   it exists whichever provider verified the address (§2).
5. Land in the workspace — **anything shared with you before you signed in is
   already listed**, because the ACL is keyed by email.

Step 3 is security-load-bearing: without it, signing in with an unverified
address that matches a pending share would hand an attacker someone else's
documents. This is the most tempting shortcut in the whole feature and is
recorded as such in `docs/architecture/threat-model.md`.

### Email

Exactly three messages: **invitation** (a new grant, never a re-grant),
**verification**, **new comment**. Deliberately not built: digests, weekly
summaries, a notification centre, unread badges, mention parsing, reminders,
marketing.

The comment email is bounded **by construction rather than by infrastructure**:
one `onDocumentCreated` trigger; recipients = owner + prior thread participants −
the author; a per-(recipient, doc) cooldown on the user record. No queue, no
scheduler, no cron. Per-user opt-out in `users/{uid}.emailNotifications`.

A suggested edit is a branch of the comment email, not a fourth message. Its
opening comment is addressed to the owner and every approver − the author,
because only they can decide it; the notice shows the quote and the proposed
replacement, and the author's note if there was one. A decision is a short
comment in the thread ("Accepted." / "Rejected: …"), which reaches the
suggester the ordinary way.

Templates are react-email components rendered with `@react-email/render`, pulled
in via a **dynamic `import()` inside the send helper** so React never loads in
`session`, `contentProxy` or any other hot path.

**Resend is optional, and that is a requirement.** The API key is a Firebase
secret via `defineSecret`, never an env file. If unset, every send is a logged
no-op and the app behaves exactly as it does with it — the quickstart must not
require a Resend account. Sends are try/catch and never fail the request that
triggered them.

Comment bodies are rendered as **plain text with a link back**, never as HTML.

---

## 15. Analytics

Firebase Analytics, initialized **only when `VITE_FIREBASE_MEASUREMENT_ID` is
present**. Clone the repo without one and there is no analytics, no
`googletagmanager.com` request and no cookies.

Three things that are easy to get wrong:

1. **`getAnalytics()` throws in unsupported environments.** Guard with
   `isSupported()` (a Promise) and fall back to a no-op. Skip this and a browser
   with third-party storage blocked can fail module init and take sign-in down.
2. **Never under emulators.** `VITE_USE_EMULATORS=1` disables it outright.
3. **Suppress the automatic page view.** `getAnalytics()` sends `page_location`,
   the full URL, and this app's URLs are `/d/{docId}/{versionId}` — **the slug is
   frequently the confidential thing**. Initialize with
   `initializeAnalytics(app, { config: { send_page_view: false, page_title: "Bikeshed" } })`
   and log route changes manually using the **route pattern**
   (`/d/:docId/:versionId`). The `page_title` is pinned in the config because
   the tab title is the document's (§17 "Link previews") and gtag attaches
   `page_title` from `document.title` to every event, its own `session_start`,
   `first_visit` and `user_engagement` included; the event builder pins it
   again on every event the app logs.

**No document id, title, slug, folder name or email is ever sent to Analytics.**
An assertion in the event-builder test enforces it.

Eleven events, enum and count parameters only: `page_view`, `login`, `sign_up`,
`doc_publish`, `doc_open`, `annotation_create`, `comment_create`,
`version_commit`, `export`, `share_grant`, `trust_grant`.

This is **not** the product's first-party reading stats (§4). Those answer "who
read this document and for how long" and live in the owner's own Firestore;
Analytics answers "how is the product used" in aggregate. Neither grows to cover
the other's job.

### Consent

An earlier revision of this section stated that no banner was needed, "because
there is no anonymous browsing to consent for except public documents, where
analytics is not initialized for signed-out visitors."

**Both halves of that were false once §17 landed.** Public and unlisted sharing
created anonymous browsing, and `initAnalytics()` runs from a single effect at
App mount for every visitor — signed in or not. A signed-out reader of a public
document was getting `_ga` cookies having never been asked, and having no
account for a preference to live on. Confirmed on a real deployment.

So consent is now a **per-visitor** decision, held per-visitor in
`localStorage` (`app/src/consent.ts`), and it gates initialization itself:

- Unanswered or declined ⇒ `resolve()` returns null and the measurement script
  is **never fetched**. Not fetched-then-disabled: a request nobody sends cannot
  be logged by anybody.
- A corrupted or unreadable store reads as unanswered. Silence is never a yes.
- The banner appears only when a measurement id is configured. A deployment
  without analytics never asks, because there would be nothing to consent to.
- The **session cookie is out of scope and needs no consent** — it is strictly
  necessary to serve a document to the person who asked for one, and asking
  permission for the thing that makes the page work teaches people to click
  Accept without reading.

Account-level opt-out (`users/{uid}.analyticsOptOut` →
`setAnalyticsCollectionEnabled(false)`) remains, and answers a different
question: it is per-account and travels across devices, where consent is
per-device. Both must be satisfied, and an account opt-out cannot re-enable what
consent denied, because there is no instance to enable.

---

## 16. Collaborative presence and concurrent editing

### One colour per person

`PresenceBar`'s deterministic per-email palette is the single source of peer
identity, reused by the presence chip, the live caret and selection, the
scroll-rail marker, the comment-thread accent, and the author edge on each
persisted highlight. It is derived from the email, so it is stable between
sessions. **Colour is never the only signal**: carets carry name labels, rail
markers label on hover, presence chips encode mode by dot shape.

### Ephemeral presence is an overlay, never inline DOM

The most important constraint in this section. Persisted annotations wrap text
nodes inline because they must flow with the text. **Ephemeral peer presence
never touches the document DOM.** It renders into one absolutely-positioned,
`pointer-events: none` container appended to the iframe body, holding per-peer
caret bars and selection rectangles computed from `Range.getClientRects()` and
repositioned by a single rAF loop.

Three reasons this is not merely tidier:

1. **Serialization safety.** One marked container is one `querySelector` to
   strip, already covered by the `[data-bshd]` rule and the dev-only assertion.
   Inline wrappers would be a third contamination class.
2. **It cannot fight the editor.** Wrapping text nodes inside a `contentEditable`
   lands in the browser's undo stack and can move the local caret. An overlay is
   invisible to `execCommand`.
3. **It survives rapid updates.** Repositioning rectangles is cheap;
   re-wrapping text nodes five times a second is not.

### Transport

Realtime Database, under `status/{docId}`:

```
status/{docId}/peers/{uid}    { email, name, mode, focus?, viewport?, composing?, lastChanged }
status/{docId}/lock           { uid, email, since }
status/{docId}/requests/{uid} { email, at }
presenceAccess/{docId}/{emailKey}   server-maintained mirror, client-unreadable
```

| Field | Updated on | Throttle |
|---|---|---|
| `focus` — selection or caret, as an ephemeral `Anchor` | `selectionchange` | 200 ms, on change only |
| `viewport` — fractional scroll position | scroll | 500 ms |
| `composing` — `{ threadId \| "new" }` | comment input focus/blur | edge-triggered |
| `mode` — view / edit | transition | edge-triggered |

**The anchor machinery is reused verbatim.** A remote selection is an `Anchor`
with a short lifetime: `describeAnchorFromSelection` on the sender,
`rangeFromAnchor` on the receiver, then `getClientRects()`. No second resolution
path, and it degrades gracefully when two peers are on slightly different draft
revisions — exactly what quote-plus-position anchoring was built for.

### The presence mirror

`presenceAccess/{docId}/{emailKey}` is written by
`functions/src/lib/presence.ts syncPresenceAccess(docId, members)` as a
whole-node `set()` — an atomic replace, so revocations propagate. It is called
from exactly the places that already recompute `members`: `createDoc`,
`forkDocument`, `setAccess`, `organize`, `folders.ts recomputeSubtree`,
`manageTeamMembers`, and the admin scripts. It no-ops when RTDB is unconfigured,
is wrapped in try/catch, and never fails the request.

It is keyed by **email, not uid**, because the server does not learn a grantee's
uid until their first sign-in, and a share must work the moment it is granted.

### Concurrent editing

Anyone who may edit a document may edit it at any time. There is no lock, no
holder and no hand-off: edits merge, and every copy converges on the same
document whatever order the updates arrive in.

**The lock this replaces is withdrawn.** It was a single-holder soft claim in
`status/{docId}/lock` with observe mode for everyone else, and it is gone along
with `requests/{uid}`, the idle release and the "Ask to edit" hand-off. The
reasoning that chose it, and the reasoning that reversed it, are both in
[ADR 0010](adr/0010-crdt-for-shared-document-state.md).

The stale-base `409` **stays**, and now means only what it always meant:
somebody PUBLISHED a new version while you were editing. It never described
concurrent drafts, and no longer has to.

Writes to the shared log are gated by `editAccess/{docId}`, a second mirror, of
`editorMembers` — approvers included, since that set contains them (§13). A
suggester is not in it, and never joins the shared log. A **public** open-editing document also carries the key `*`:
any verified account. An **unlisted** one never does. The realtime rules cannot
see a link's key, so `*` there would let any account write into a document it
cannot name; its link holders edit through `/draft` instead, which can check
their grant, and are not merged live with the members (§17).

### The caret is still faster than the text

Peer carets and selections update at 200 ms; the document merges as fast as
updates arrive. The two are separate channels on purpose — the pointer is what
the eye tracks, so it has to feel live, and it is ephemeral, so it must never
touch the document DOM (see the overlay rule above).

### Deliberately not built

Per-character attribution or blame · cursor chat · voice and video · a live chat
channel · presence for non-members · live co-editing through an unlisted link ·
workspace-wide "who is online".

Per-character attribution is the one worth naming twice: with the edit lock gone
there are no hand-offs to record, so `draft.editSessions` no longer answers "who
wrote v3" and nothing else does either. That is a known loss, recorded in ADR
0010 rather than discovered.

---

## 17. Visibility, public sharing, and provenance

### Three levels

`DocMeta.visibility: "private" | "unlisted" | "public"`, default `private`.

| | Who can read the bytes | Discoverable | URL |
|---|---|---|---|
| `private` | owner + members | no | `/d/{slug}` |
| `unlisted` | anyone with the link | no: without `k`, indistinguishable from an absent id | `/d/{slug}?k={token}` |
| `public` | anyone | indexed, in `sitemap.xml` | `/d/{slug}` |

**The private-bucket invariant is not weakened.** The bucket keeps uniform access
and public-access-prevention; `contentProxy` stays the only path bytes take.
"Public" means *the proxy will serve you without a cookie*.

### Expiry

`DocMeta.expiresAt: Timestamp | null`, default absent, set by the owner through
`POST /visibility` alongside visibility and open editing — from the Share
dialog, which holds the people, the three levels, the link, open editing and
the expiry together. There is no separate "who can see it" dialog: it was one
question asked from two menu entries, and the second was found only by reading
the overflow menu. Folders share the same dialog without that section, having
no visibility and no expiry. One rule:

> **An expired document is read-only, and visible only to its owner.**

It is **not a deletion date.** This product does not delete documents (see
`docs/architecture/overview.md`), so expiry cannot mean removal: the bytes, the versions,
the annotations and the comments all survive, and clearing the date restores
everything. The interface says so in those words, because "expire" reads as
"delete" to most people and teaching the wrong model here is expensive.

The owner keeps reading it because they set the date and are the only one who
can move it; locking them out would make the setting unrecoverable rather than
reversible. Everybody else gets the **same 404** a document they may not read
gives them, so an expiry cannot be used to confirm that a slug exists. Writing
is refused for everyone, the owner included — an expired document is frozen, and
lifting the date is the single action that unfreezes it. One exception, and
only one: the owner's browser may still store the document's thumbnails (§2
`POST /thumb`). A cover is not the document, nothing about the document changes,
and the owner is the one reader an expired document has left — so the owner's
workspace keeps recognisable cards, and nobody else is ever shown them.

**Expiry is not in the security rules, and cannot be.** The workspace `list`
rule has to be statically provable from the query's constraints (§5), and a
query cannot filter on a field most documents do not have without dropping every
document that does not have it. So the record stays readable and the CONTENT
stops being served — which is sufficient precisely because every byte in this
system already flows through one function. The consequence, stated rather than
discovered: a member still sees the row, its title and its comments; what they
cannot get is the document.

Enforced in ten places from one predicate (`isExpired` in `lib/acl.ts`):
`contentProxy` (content and thumbnails alike), `downloadBundle`, `getDraft`,
`saveDraft`, `commitVersion`, `saveThumbs`, `forkDoc`, `recordView`, `sitemap`
and `docShell`, plus the MCP tools. A fork
is a read of every byte, so an expired source cannot be forked out from behind
its date, and an expired document stops a lineage walk (§21).

Two details that are decisions rather than implementation:

- **The public cache window is capped at the time remaining.** Revocation
  latency is an accepted trade — a document made private again can be served
  from cache for up to five minutes — but an expiry's moment is known in
  advance, so serving past it would be a choice. `max-age` never outlives the
  date.
- **Nothing deletes the `public/{docId}` projection when the moment arrives.**
  There is no scheduler here, by decision, so the projection *carries* the date
  (`expiresAt`, epoch milliseconds) and the reader is told rather than shown an
  empty frame. A title outliving its content is the honest cost of having no
  cron.

How the viewer says it: a chip beside the version badge — the same one the
workspace card shows — for every future date, escalating in wording and colour
through the last week and past the date, read from `docs/{docId}` for a member
and from the projection, or `/unlock`, for anyone else. Its tooltip, and a tap for anyone who
cannot change the date, carry the not-deleted sentence and who can open it; the
owner's tap opens the Share dialog. It never takes a row from the document: it
was a banner above the frame for every future date, and a document set to
expire next year gave up that row for eleven months.

A date in the past is **refused**, not applied: accepting one would make "take
this down now" a side effect of a typo in a year, and the intended way to take a
document down immediately is to make it private, which is reversible in a way an
accidental expiry is not. Dates beyond a hundred years are refused for the same
class of reason — milliseconds pasted where seconds were meant land in the year
55000, which looks like an expiry and is not one.

### An unlisted document needs its link

> **Without the key, anyone who is not a member learns no more about an
> unlisted document than about a private one.**

No title, no "unlisted", no viewer chrome, and one identical `404` on every
surface: bytes, the reader projection, the view counter, the write endpoints,
the agent tools and the security rules. The residual is the one private
documents already carry — publishing at a taken id reveals that it is taken
(§4) — and nothing more.

Who may read, decided once in `lib/acl.ts readBasis` and mirrored by the rules:

| Basis | Who | Cached at a shared URL |
|---|---|---|
| `member` | owner or effective member, at any visibility | no |
| `public` | anyone, on a public document | yes |
| `link` | anyone whose request carries `k` equal to `linkToken`, in the query or, on `/content/`, as the `~<k>` path segment (§2) | yes: the URL carries the key |
| `grant` | a signed-in account holding a current link grant | no: the URL carries no key |

The key is compared in constant time, and an absent token never matches an
absent key. The rules cannot see a URL, so a signed-in visitor who opens an
unlisted document with its key is given a **link grant** by `POST /unlock` —
`docs/{docId}/linkGrants/{uid}`, naming the token they presented — and the
rules, the endpoints and the agent tools accept it in place of the key. It is
what lets a link holder comment, and what lets them open the document again
from a reply notification, which links without the key.

**Rotating the link revokes everything it granted.** Making the document private
deletes its token and making it unlisted again mints a new one, so every old
link and every grant stops working at once, without a cleanup pass. A grant is
per account and cannot be revoked alone; that is the reversal condition in
[ADR 0012](adr/0012-unlisted-needs-its-link.md).

Open editing on an unlisted document reaches its link holders and nobody else,
and not through the live log (§16).

### Anonymous reads use a projection, not a rules exception

Firestore rules cannot project fields, so letting an anonymous client `get` a
public `docs/{docId}` would hand the world `members`, `viewers`, `ownerEmail`
and `stats`. A **public** document is mirrored to **`public/{docId}`** carrying
only `docId`, `title`, `slug`, `currentVersion`, `entry`, `format`,
`visibility`, `publicEdit`, `trusted`, `expiresAt`, `forked`, `publishedAt` — written by the same paths that
recompute `members`, and **deleted the instant it stops being public**. The rule
allows `get` of a public row only, and no `list`: an absent id and any other row
are the same refusal.

An **unlisted** document is not mirrored. Anything in `public/` is readable by
whoever knows an id, and once was listable by anyone at all; an unlisted
document's title belongs to the holders of its link. They get the same fields
from `POST /unlock`, which checks the key.

Everything else under `docs/**` still requires an account, even on a public
document. Those records carry member lists and reviewer identities; publishing a
document must not publish the people who reviewed it.

### Anonymous is read-only. Always.

Any write — comment, annotation, resolve, edit — requires a signed-in account,
even on a public document whose owner enabled open editing. **`publicEdit`
widens *who may edit* to "any verified account", never to "anyone".** It never
relaxes `isVerifiedUser()`.

An anonymous reader who selects text and tries to comment gets the sign-in sheet
**with their selection preserved**, and the comment posts after sign-in. A
"sign in to comment" that loses the selection is where this feature dies.

### Caching

Gated content: `private, no-store`. Non-private content on the immutable
`/content/{docId}/{versionId}/…` path: `public, max-age=300`. Versions are
immutable so the bytes can never be stale; the real exposure is **revocation
latency — making a document private again takes up to five minutes to
propagate**, documented in `operations.md` beside the purge steps.

Stored thumbnails (§2 `GET /thumb`) are the one gated response a browser may
keep: `private, max-age` of at most a day, capped at expiry, and `immutable`
because their URL names a key that is never reused. A member's workspace then
costs no function call per card on every visit. `private` keeps them out of
every shared cache; what the window concedes is that someone removed from a
document keeps, for up to a day, the images their own browser already held.

This is also the cost defence: every byte is proxied through a function, and
public documents are where traffic spikes. A rate limiter is **deliberately not
built**; Firebase App Check is the named hook if abuse materializes.

### Link previews

Hosting's static shell says "Bikeshed" in its `<head>` and nothing about the
document, and a crawler runs no JavaScript, so a pasted link unfurled as the
product. `/d/**` is therefore rewritten to `docShell` (§2), which serves the
same shell to everyone and, only when the document is readable without an
account, with the document's own head spliced in. The decision is
`contentProxy`'s for an **anonymous** caller — no cookie, member or owner
check — because the response may be cached at a public URL and whatever it
carries is what a stranger may see. The owner of a private document gets the
generic shell too; their tab title comes from the client
([ADR 0011](adr/0011-document-page-through-a-function.md)).

| | Shell | `Cache-Control` | Robots |
|---|---|---|---|
| `private` | generic | `private, no-store` | — |
| `unlisted`, no or wrong `k` | generic | `private, no-store` | — |
| `unlisted`, correct `k` | document | `public, max-age=min(300, seconds to expiry)` | `X-Robots-Tag: noindex` and `<meta name="robots" content="noindex">` |
| `public` | document | `public, max-age=min(300, seconds to expiry)` | — |
| expired, at any level | generic | `private, no-store` | — |

An absent document, a version that does not exist, and any failure between
the decision and the finished page are generic as well.

**The head comes from the entry's first 256 KiB** (`HEAD_SCAN_BYTES`), asked
for as a byte range and capped again in the function, so a large document is
never read to the end for the sake of its head. What lies past the cap is not
described. From that prefix, with comments, `<script>`, `<style>`, `<svg>`,
`<template>` and `<nav>` dropped first — an inline SVG's accessible `<title>`
must not become the document's, nor a table of contents its description:

- **Title**: `<title>`, else `og:title`, else the stored workspace title.
- **Description**: `<meta name="description">`, else `og:description`, else
  the first ~200 characters of body text after the first `</h1>` (after
  `<body>` when there is no `<h1>`), cut back to a word with an ellipsis.
- **Keywords**: `<meta name="keywords">`, when declared.
- **Image**: the declared `og:image`, else `twitter:image`, else the first
  raster `<img>` in the body (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`),
  resolved against the entry's URL under `/content/{docId}/{versionId}/` as a
  browser would. A same-origin result must stay inside that version's prefix
  and name a file the version holds, and carries `k` for an unlisted
  document; a cross-origin `http(s)` URL is the author's; anything else —
  none, `data:`, `javascript:`, an escape from the prefix, a file the version
  lacks — is `/brand/og-default.png`, 1200×630, served by Hosting.
- **`og:url`**: the URL as shared — `/d/{docId}`, `/{versionId}` when the
  request pinned one, and `?k=` for an unlisted document, never for a public
  one whatever `k` the request happened to carry.

**Every refusal is one identical response** (§1.4b). `decideShell` returns
the same frozen `GENERIC` object for every reason, so a generic answer carries
no document-specific byte by construction; a generic response sets no header
a document response does not; and the cache header is set only once the page
is built, so a throw before then falls back to a generic shell that is still
uncacheable — never a broken page pinned at a public URL for the window. Every
injected value passes through `lib/html.ts` and is spliced by index, never by
`String.replace` with a string, whose `$'` would paste the template into
itself.

**The shell is cached like content.** A document's shell is subject to the
same five-minute window as `/content/**`, and withdrawing a version does not
purge a cached shell: its title and excerpt can be served for up to five
minutes after the bytes are gone, exactly as the content can.

### Actor provenance

One shape, stamped on every read and write, so "was this a person or an agent"
is never a guess:

```ts
type Actor = {
  uid: string | null;  // an account, or null for the operator scripts (below)
  email: string;
  channel: "web" | "cli" | "mcp" | "api";   // SERVER-DERIVED, never client-claimed
  tokenId?: string; // which PAT, when channel !== "web"
  client?: string;  // self-reported, e.g. "bikeshed-cli/0.3.1"
  agent?: string;   // self-reported agent or model id
};
```

**What is trustworthy and what is not, stated rather than blurred.** `uid`,
`email`, `channel` and `tokenId` are derived server-side from the credential
actually presented — a Bearer token cannot claim to be `web`, and `/mcp` stamps
`mcp` regardless of what the caller says. On the direct-Firestore write path,
`firestore.rules authoredBySelf()` pins `actor.channel == 'web'` for the same
reason. `client` and `agent` come from `X-Bikeshed-Client` / `X-Bikeshed-Agent`,
are stored verbatim, and are **rendered as self-reported** in the UI. A badge
that implies verification it does not have is worse than no badge.

Stamped on: version records (`publishedBy`), annotations and comments (`actor`,
immutable after create), view sessions, and ACL changes. Not on drafts — see
`editSessions` in §17.

`uid` is null in exactly one case: the operator scripts in `scripts/`, which
authenticate with Admin credentials rather than as an account. They remain
identifiable — `channel: "cli"`, an `email` from the required `--account` flag,
and no `tokenId` — and that combination is precisely what distinguishes an
operator action from a user's own CLI token.

**`tokenId` is the forensic primitive.** If a token leaks, "everything this token
ever touched" is one query, and revocation is one click without disturbing the
owner's other clients.

### Automated reads must not corrupt human metrics

Automated reads record a view session with `ms: 0` and count into
`stats.apiReads` — never `stats.views` or `stats.totalMs`. The stats panel shows
both and filters to human-only or automation-only. Comments and highlights
created through an automation channel carry a visible "via MCP" marker.

### Version, edit and view provenance

- Each version carries `publishedByEmail`, `publishedVia: "cli" | "upload" |
  "editor" | "mcp" | "fork"` (`"duplicate"` on copies made before §21, which
  record no lineage), `parentVersion`, and the full `publishedBy`
  Actor, alongside `contentHash`, `fileCount`, `bytes`, `publishedAt`, `format`
  and `rendererVersion`.
- `draft.editSessions` is **withdrawn**. It was appended when the edit lock
  changed hands, and with the lock gone (§16) there are no hand-offs to record.
  A version therefore answers "who published this" but not "who wrote which
  part of it": per-character attribution is still deliberately not built, so
  `lastEditedByEmail` is now the whole of the answer. Recorded as a loss in
  [ADR 0010](adr/0010-crdt-for-shared-document-state.md) rather than left to be
  discovered.
- Views record `via: "app" | "unlisted" | "public"`. Anonymous sessions record
  `uid: null`, count toward `stats.views` and `stats.totalMs`, and are **never**
  rolled into `viewers/{uid}` — there is no identity to roll into. The owner sees
  "142 views · 38 identified".

**No IP, no fingerprint, no unique-visitor estimation for anonymous traffic.**
Sessions are counted; people are not. A deliberate privacy floor.

### The activity panel

One reverse-chronological feed per document, assembled entirely from collections
that already exist, with **no new writes**. Gated to `isDocEditor`.

---

## 18. Teams

Share a document or folder with a whole team, or with particular people — both,
side by side.

### Grants record intent; effective sets record reality

Every grant list — `viewers[]`, `suggesters[]`, `editors[]`, `approvers[]` —
takes entries of the form `team:{teamId}` alongside plain emails, and the server
**expands them at write time** into the flat effective sets it already computes
(§13):

```
viewers: ["ana@example.com", "team:design"]     ← the durable grant
members: ["ana@…", "bo@…", "cy@…", "owner@…"]   ← the flat effective set
```

Rules, the composite index and the single doc-list query are **completely
unchanged**. That is the point: `members` is simultaneously the read gate and
the query key, and the `list` rule is only valid because it is statically
provable from an `array-contains` filter (§5).

*The alternative considered and rejected:* putting team ids directly in
`members` and matching a custom claim. It works for `get`, but it breaks the
provable `list` rule and trades a bounded write fan-out for a permanent
complexity tax on the most security-critical rule in the file.

### Model

```
teams/{teamId}: { teamId, name, slug, ownerEmail, admins[], members[], createdAt, updatedAt }
```

Emails lowercased. Readable by its own members; **write server-only**, matching
how `docs` and `folders` already behave.

`POST /team` (create / rename / delete), `POST /team-members` (add / remove,
admin-gated). `/access` and `/folder-access` accept `team:{id}` entries with no
signature change.

### Fan-out is bounded and reuses the existing cascade

Removing someone from a team must revoke access everywhere the team was granted:
an `array-contains` query over `team:{teamId}` grants feeding the **same batched
BFS recompute** that folder-access changes already use. A 50-person team granted
on 200 documents is 200 writes — a batch, not a job queue. For a small-team tool
that is the right trade, and it is stated in `docs/architecture/overview.md` so nobody is
surprised at 10,000 documents.

Three things fall out free because expansion is server-side: the presence mirror
(§16) is keyed by email and needs no change; a PAT's ACL (§19) picks up team
access with no change; and the public projection (§17) carries no team names.

### Not built

Nested teams · per-team roles beyond member/admin · team-owned documents (a
document always has a person as owner; a team is an access grant, not a
principal) · directory sync / SCIM.

---

## 19. Agent surface — tokens, MCP, CLI

One credential, two clients, one set of server logic. The MCP server and the CLI
are **thin shells over the same endpoints the web app already calls.**

### Personal access tokens

Minted in account settings, `bsk_`-prefixed, **stored only as a SHA-256 hash**,
shown once, named, revocable, with `lastUsedAt`. Sent as `Authorization: Bearer`.

A token carries the **same identity, and therefore the same ACL, as the person
who minted it.** No service accounts, no impersonation, no second permission
model.

*Why not OAuth 2.1, which the MCP spec prefers:* it needs an authorization
server, a consent screen and token/refresh endpoints — a real subsystem, for a
self-hosted tool whose users are largely the people who own the deployment. A
PAT is roughly 120 lines, serves the CLI and MCP identically, and can be revoked
by someone who has never heard of OAuth. Noted as the upgrade path if one-click
client onboarding is ever wanted.

### MCP — twelve tools

`POST /mcp`, streamable HTTP, one Cloud Function, one rewrite.

| Tool | Purpose |
|---|---|
| `list_documents` | the caller's documents, with visibility and current version |
| `get_document` | metadata + current **source** (Markdown where available) |
| `publish_document` | create a document from content, optionally at a chosen `id` (§4) |
| `fork_document` | copy a version of a document the caller can read into one they own (§21) |
| `get_lineage` | what a document was forked from and, for its owner, its forks (§21) |
| `update_document` | commit a new version of an existing document |
| `suggest_edit` | propose replacing a passage with new text, for a person to accept or reject (§22) |
| `list_folders` | every folder the caller can see, each with its full path |
| `create_folder` | create one, optionally inside another |
| `move_document` | file a document into a folder, or back to the workspace root |
| `get_comments` | **unresolved feedback, each with its anchored quote** |
| `reply_to_comment` | respond in a thread |

`get_document`, `update_document`, `suggest_edit`, `get_comments` and
`reply_to_comment` take an optional `k`: an unlisted document's key, for a caller who is not a member and
whose account holds no link grant. Without it such a document answers exactly as
an id that does not exist (§17). The CLI accepts the link itself wherever it
takes an id, because the link is the only place a person holds the key.

`get_comments` is what earns the whole surface. Because every annotation stores
`exact`/`prefix`/`suffix`, a comment comes back **with the passage it is about**,
so an agent knows what to change without fetching and diffing the document. That
closes the loop this product exists for.

Efficiency rules, because agent context is the scarce resource: `get_comments`
returns quote, comment, author and thread id and nothing else; `list_documents`
is metadata-only; `get_document` returns **source, never rendered HTML with its
embedded stylesheet**; responses are capped and cursor-paginated. The source cap
is 200,000 characters, and `truncated` says when it applied. The CLI does not
inherit it: its output lands in a file, not a context, so `bikeshed get` reads a
cut source whole through `/content`, behind the same read checks.

There is no anonymous MCP access. Publishing always attributes to a real account
and stamps `publishedVia: "mcp"`.

`list_documents` and `get_document` **report** `expiresAt`; nothing on this
surface sets it. Expiry decides who may read a document and until when, which is
the same class of decision as sharing, and this surface does not make those. An
expired document reads as absent to every caller but its owner, and every write
tool refuses it. *What would change this:* narrowing a document's reach is
safe to automate in a way widening it is not, so an agent setting — never
clearing or extending — an expiry is the reversal worth arguing for first.

**The folder tools are an access surface, not a filing surface.** A document's
effective members are its own grants unioned with its folder's (§13), so moving
a document between folders changes who can read it. `move_document` therefore
requires the real editor set (`isDocEditor`) on the document — not open
editing, which would let any account file someone's document into its own
folder and become a member — and `canEditFolder` on the destination, and
goes through `persistDocMembership` so the presence mirror and the public
projection move with it.

`list_folders` returns whole paths rather than a tree to walk. An ancestor the
caller is not a member of renders as `…`: membership cascades downward only, so
a grant on a child leaves its parent invisible, and neither its id nor its
omission would be a true answer.

Three things are deliberately **absent** from the surface, and each is a stated
refusal rather than a gap: deleting a folder (it reparents everything beneath
it), renaming one, and sharing anything. `functions/test/mcp.test.js` asserts no
tool name matches `delete|remove|share|grant|access`.

**An agent proposes and never decides.** `suggest_edit` takes the passage as a
reader sees it — no markup — and finds it in the current version's RENDERED
entry without a DOM (`lib/quote.ts`): exactly, inside one block, with a prefix
or suffix to choose between repeats. It refuses a passage that is not there,
that repeats with nothing to tell the copies apart, or that spans a block or a
line break, each with what to do instead. The anchor it stores is the one the
browser's strict resolver will find; a fixture of golden cases is asserted by
both (§22). Accepting and rejecting have no tool, and every decision op of
`/suggestion` refuses a token; `functions/test/suggest-edit.test.js` asserts no
tool name matches `accept|reject|approve|resolve|decide`. `get_comments` reports
a suggestion's `replacement` and `state`; `get_document` reports `canSuggest`;
and `update_document` from a caller who may only suggest names `suggest_edit`.

One resolver authorizes every "put this inside that folder" in the system —
`resolveFolderTarget` in `functions/src/lib/folders.ts` — used by `createDoc`,
`createFolder`, both halves of `organize`, and the three MCP tools. It
authorizes with `canEditFolder`, which is the question all six are asking.

### CLI — `bikeshed`

Deliberately distinct from `scripts/*.mjs`:

| | `scripts/*.mjs` | `bikeshed` CLI |
|---|---|---|
| Who | whoever owns the deployment | any signed-up user |
| Credential | Admin SDK / gcloud, `--account` required | personal access token |
| Talks to | Firestore and Storage directly | the deployment over HTTPS |
| Purpose | provision, withdraw, tear down | publish and revise documents |

Commands: `login`, `publish <file>`, `update <slug> <file>`, `fork <slug>`,
`lineage <slug>`, `list`,
`get <slug>`, `comments <slug>`, `reply`, `suggest <slug> <text> (--with <text>
| --delete)`, `open <slug>`, `folders`, `mkdir <name>`,
`mv <slug> <folder|root>`, `skills [install <dir>]`, plus `publish --watch`.
Every command takes `--json`. `comments` prints a suggestion's replacement and
state under its quote. `suggest` demands exactly one of `--with` and `--delete`:
an empty `--with` is too easy to send by accident to be the way to ask for a
deletion.

`update` sends one `.md` or `.html` through `update_document`, and a `.zip` —
by name, or by the same magic-byte sniff the deployment uses — as raw bytes to
`POST /publish?update=`. Read as text, an archive is corrupted on the way.

`publish --id <id>` asks for the docId. When the deployment answers with a
different one, because the id was taken or because a deployment too old to know
the parameter ignored it, the CLI says so on stderr, which keeps `--json` output
parseable.

`mv` requires its destination and spells the root as the literal word `root`.
The MCP tool encodes the root as an OMITTED `folder` — JSON-RPC has no empty
string to send, since `missingArguments` rejects one — but a positional argument
left off by accident would silently unfile a document and revoke the access its
folder granted, so the CLI does not accept the omission.

### Universal agent instructions

`docs/agents/agent-guide.md` is the source of truth. A build step copies it to
`app/public/llms.txt` byte for byte and **CI asserts the two match**, so hosted
instructions can never drift from the repo's.

A second, build-only step stamps the copy in `app/dist`: the token
`https://<deployment>` becomes the deployment's own origin, resolved
`BIKESHED_PUBLIC_ORIGIN` → the `domain` in `config/deploy.json` → nothing, in
which case the placeholder is served as written and the build says so on one
line. **Only `app/dist` is ever stamped.** That is what keeps `check:agents` a
byte comparison and keeps a deployment binding out of the tree, where
`check-secrets.sh` — which matches by shape — could not see a custom domain. A
`<deployment>` that survives a stamp fails the build, so a placeholder written
any other way cannot ship unresolved. `/.well-known/mcp.json` advertises the
endpoint; every URL in it is relative and nothing stamps it.

### Skills

`skills/<name>/SKILL.md`, in the Agent Skills convention: YAML frontmatter
carrying `name` and `description`, then Markdown. Three of them —
`bikeshed-publishing`, `bikeshed-feedback`, `bikeshed-folders` — one per job the
surface exists for. `llms.txt` is the short form every agent reads; a skill is
the long form, loaded for the task that needs it.

The same build step copies them to `app/public/skills/`, with a generated
`index.json` built from the frontmatter, and the same stamp reaches the
`app/dist` copies, so a deployment serves the skills that describe **what that
deployment can do**, at the address it is actually reachable at. The list of
files to stamp is derived from the `skills/` directory rather than enumerated,
so a skill cannot be added or renamed and left unstamped. `bikeshed skills install <dir>` writes
them wherever a harness reads skills from; it needs no token, because they are
public files, and it validates each name against `^[a-z0-9][a-z0-9-]*$` before
it uses it as a directory.

Kept true by `functions/test/skills.test.js` rather than by intention. Every
`bikeshed …` command and every MCP tool name a skill or the guide mentions must
exist, **and** every tool and command that exists must be named in the guide —
the second direction being the one that catches a capability nobody is told
about. A skill naming an absent command is worse than no skill: an agent
believes it.

### Not built

OAuth 2.1 flows · service accounts · webhooks · a REST API distinct from these
endpoints · SDKs in other languages · rate limiting beyond CDN caching · folder
deletion, folder renaming or sharing through the agent surface · resolving a
comment thread from an agent · accepting or rejecting a suggested edit from an agent.

---

## 20. Export marking

Exports carry an optional marking, resolved at **publish/upload time**, not at
export time — otherwise a reader exporting would apply *their* default, when the
marking is the owner's policy.

```ts
type Marking = { enabled: boolean; label: string; footer: string };
// footer supports {year} {date} {title} {version} {user}
```

| Layer | Where | Who writes it |
|---|---|---|
| Per-document (authoritative at export) | `docs/{docId}.marking` | server, via `POST /marking` (owner-only) |
| Account default (seeds new documents) | `users/{uid}.defaultMarking` | client, own-uid |
| Deployment default (seeds accounts) | `VITE_EXPORT_MARK*` | operator |
| Off | — | the default |

### The mechanism

Stamp styles are set **inline with `!important`**. An important inline
declaration outranks any selector-based author `!important` rule, so hostile
bundle CSS cannot suppress the marking. All 25 hiding vectors are locked — box
(`display`, `visibility`, `opacity`, `transform`, `filter`, `clip`, `clip-path`,
`content-visibility`, `max-height/width`, `overflow`, `zoom`) and text
(`-webkit-text-fill-color`, `-webkit-text-stroke`, `text-indent`, `text-shadow`,
`letter-spacing`, `word-spacing`, `white-space`, `text-transform`).

Rendering happens in a print iframe sandboxed `allow-same-origin allow-modals`
with deliberately **no** `allow-scripts`. `position: fixed` repeats the stamp on
every page. `{year}` is computed at export time.

**The export imposes no page geometry.** The document's own `@page` — or,
absent one, the print dialog — decides size and margins; `@page` cascades by
order, so a rule of ours would beat the document's and a fixed-size deck would
spill every slide across two pages. The stamp nodes go **first** in `<body>`:
anything after a document's final forced page break opens a page of its own,
and a fixed box is positioned the same wherever it sits.

**The browser's print reaches this export.** Cmd+P / Ctrl+P on a document page
is routed to it — heard on the frame's window as well as the app's, because
the reader's focus is usually inside the document. File → Print fires no
event that could be redirected, so the page prints acceptably by itself: the
chrome presentation mode hides is hidden on paper, and the frame is opened to
its content's full height on `beforeprint` so the document paginates rather
than printing as one clipped box, then closed again with the reader's scroll
position restored. That path carries **no stamp** and prints what is on
screen, highlights included. It grants nothing the reader lacked: the content
proxy serves `/content/{docId}/{versionId}/{entry}` inline to anyone who may
read it, and "Download the HTML" hands them the file. The marking is a property
of the export path, not an access control.

Residual risk, accepted: a bundle could blank its own entire document, yielding
an empty PDF — self-defeating, no content leaked. A cryptographically guaranteed
stamp would require server-side rendering; client-side print is the chosen
trade-off.

Safety: values are written with `textContent`, never `innerHTML`; the footer is
capped at 300 characters and the label at 40, and control characters are
stripped. When marking is disabled the stamp nodes are simply absent; every
other property (sandbox, `<script>` scrub, `on*` scrub, `javascript:` scrub)
stays unconditional.

---

## 21. Forks

A fork is a copy of one version of a document the caller can read, made into a
new document they own, that remembers which document it came from. It replaces
"duplicate", which made the copy and forgot the origin.

### What a fork is

| | |
|---|---|
| Who may fork | anyone who may READ the source: `canRead`, with `k` or a link grant counting, and not expired for them (§17). A refusal is the `404` an absent id gets |
| What is copied | the bytes of ONE version — the one asked for, current by default. Not annotations, comments, trust grants, views or other versions |
| What it is | a new document at `v1`, owned by the caller, `private`, `trusted: false` (ADR 0002), in a folder the caller can edit or at the root. A folder they cannot edit is REFUSED, not dropped |
| Its title | the source's, unless one is given. The id comes from it and takes the random suffix when taken (§4) |
| Its marking | the caller's account default (§20). The source's marking is its owner's policy and does not follow the content |
| `publishedVia` | `"fork"` on its `v1` |

Everything is written in ONE batch: the fork's record, its `v1`, its
`forks/{forkDocId}` record, and `stats.forks` incremented on the source. The
count therefore never disagrees with the forks that exist, and because no
document is ever deleted (§13) it stays exact.

### Where the pointer lives, and why not on the fork

`forks/{forkDocId}` is `{ parentId, parentVersion, parentContentHash, forkedAt }`
and NO client may read or write it. `docs/{forkDocId}` carries only
`forked: true`, and the public projection and the `/unlock` answer carry the same
boolean (§17).

Every member of a fork reads `docs/{forkDocId}` directly, and a docId is the slug
of the title its document was first published under. A pointer on the record
would hand the original's address — and so, near enough, its first title — to
everybody the fork is later shared with, including people who hold no link to an
unlisted original. That is precisely what an unlisted link exists to prevent.
**Reversal condition:** a reader who should see the parent and cannot be told
any other way — and then the answer is a per-caller endpoint, as here, never a
field.

`parentContentHash` is recorded beside `parentVersion` because a withdrawn
version's id is re-minted by the next commit (§4): the id alone can come to name
different bytes.

### Lineage, one hop at a time

`POST /fork { op: "lineage", docId, k? }` is gated like a read of `docId`, and
answers:

```ts
{ forked: boolean;
  ancestors: { docId; title; versionId; ownerEmail?; changed? }[];  // nearest first
  hiddenAncestor: boolean;
  forks?: { total; hidden; visible: { docId; title; visibility; forkedAt; ownerEmail? }[] } }
```

- **The walk stops at the first parent the caller cannot open**, and says so in
  `hiddenAncestor`. It does not skip past it: that would tell the reader where a
  document they were never shown came from. Capped at twenty hops.
- **A key opens only the document it was presented for.** Parents are readable
  by membership, public visibility, or a link grant the caller already holds.
- **`ownerEmail`** appears only where the caller is a member of that document,
  and could read it off the record anyway. A public reader is not told who owns
  a public original.
- **`changed`**, on the nearest parent only: its current version's content hash
  differs from `parentContentHash`. Absent when either hash is unknown, because
  "unknown" is neither answer.
- **`forks`** is the OWNER's only. Every fork is counted; the ones the owner can
  open — `canRead` again, so an unlisted fork only with its grant, an expired
  one not at all — are listed. The original's owner is never told who made a
  fork they cannot open. Cost: one query and N reads on demand, no write.
  Past a few hundred forks a paginated panel is the fix.

### Where Fork is offered

| Surface | |
|---|---|
| Workspace card | "Fork", one click, into the folder being viewed, then opens it |
| Viewer toolbar | "Fork", for a reader who is not the owner, in the slot Share takes for an owner — so no toolbar is wider than an owner's. Its tooltip says the author will see that it was forked |
| Viewer menu | "Fork", or "Fork this version" on an old one, for every reader; "Forks…" for the owner |
| Signed out | sign in, then the fork completes: the intent travels as `?fork=1` through `/signup?next=`, runs once the document has resolved as the account, and is removed before the request so a reload cannot fork twice. `next` is honoured only as a path on this origin |
| MCP / CLI | `fork_document`; `bikeshed fork <id|link> [--version] [--folder] [--title]`. Lineage is `get_lineage` and `bikeshed lineage <id|link>`, the same answer as the panel; `list_documents` and `get_document` carry `forked`, and `list_documents` the fork count, off the record |

The viewer shows a fork chip beside the version — "Fork", the owner's count, a
dot when the original has changed — whose accessible name says all three in
words. It asks for lineage on its own only for a fork; a document that is not
one costs no request.

### What this does not do

- **No sync, no merge, no "propose back".** Merging hand-authored HTML is a
  subsystem of its own (ADR 0007), not a feature of forking.
- **Not a guarantee of attribution.** Download and re-upload makes a copy with
  no lineage. The trace covers the fork path, and says no more than that.
- **No lineage for copies made before this section.** They keep
  `publishedVia: "duplicate"` and are neither linked nor counted.

---

## 22. Suggestions

Somebody who may not edit a document — or may, and would rather ask — proposes
a change for somebody else to decide on. People and agents alike. The decision
behind the shape, and what would reverse it, is ADR 0013.

### Who may do what

| | read, comment | suggest | edit, publish | accept, reject |
|---|---|---|---|---|
| viewer | ✓ | | | |
| suggester | ✓ | ✓ | | |
| editor | ✓ | ✓ | ✓ | |
| approver | ✓ | ✓ | ✓ | ✓ |
| owner | ✓ | ✓ | ✓ | ✓ |
| open editor (§17) | ✓ | ✓ | ✓ | |
| an agent | its person's | its person's | its person's | never |

Roles are granted and inherited as in §13. The author of a pending suggestion
may change or withdraw it.

### What a suggestion is

One **text** replacement inside one block: the quoted text, anchored as a
comment is (§6), and what it should become. An empty replacement deletes the
quote. A replacement is one line of text — no line break, control character or
bidirectional override — because anything else would insert structure when it
is typed in. Formatting, images and structure cannot be suggested.

It is stored as an annotation with a `suggestion` field (§4), so it has a
thread, a highlight, orphan detection and the comment email for free.

### Lifecycle

```
pending ──accept──▶ accepted
   │    └─reject──▶ rejected
   └──withdraw────▶ (deleted)
```

A **claim** is held by the approver applying it, for two minutes, and keeps
every other decision and the author's withdrawal off it meanwhile, so two
approvers cannot insert the same change twice. A lapsed claim is ignored.

**Accepting is an edit.** The approver's browser finds the quote in the DRAFT —
exactly, never by fuzzy match — replays the replacement with `execCommand` in
the approver's own editing session, waits for the draft to save, and only then
records the decision. So it reaches every co-editor through the shared state
(§16) like a keystroke, and lands in the draft; publishing it is still "Save as
new version". A quote that no longer matches exactly is **stale**: shown as
such, and only rejectable.

**A pending suggestion holds back every new version** (§6a). Only an approver
clears one, so somebody who can publish but not decide is told who can.

Each author may have twenty pending suggestions on one version.

### Writing one

Select text while reading; the selection toolbar offers **Suggest edit** beside
Comment to anyone who may suggest, on the published head only, and not once the
document has expired. An editor reading the draft is offered it too: whoever
can edit chooses, each time, between proposing a change and making it, and the
review pass judges a suggestion against that same draft (`offersSuggest`). A
suggestion quoting text that exists only in the draft reads as stale to
somebody reading the published version until it is accepted and published. A selection it cannot take — across two paragraphs,
holding a line break, list, table or image, or inside a figure — is refused on
press with the reason, not greyed out. The selection is trimmed of edge
whitespace and anchored as a comment is.

The form floats over the frame, in the parent's DOM: the quote, a field
prefilled with it (caret at the end), and an optional note. Enter submits;
Escape cancels; a pasted line break becomes a space; empty suggests deleting
the text. The thread opens on success. Its author may Edit it, in the panel,
until it is decided.

### The review pass

An approver decides suggestions in the editor, because accepting is an edit
there. **Review** on a thread, or **Review all**, opens the editor on it; a bar
under the editing toolbar shows the change, who suggested it, and Accept,
Reject (with an optional reason), Previous, Next and Done. Each suggestion is
judged against the DRAFT on screen, the text an Accept would change, so one an
editor has already rewritten shows as stale there. The target is brought into
view once and marked with the CSS Custom Highlight API through an adopted
stylesheet — no node and no attribute, so nothing reaches the serializer or the
CRDT's observer — falling back to selecting it where the API is missing.

Accept waits for the editing session to have joined the shared document (an
edit applied before the bind is lost to it), then runs claim → apply → save
the draft → record. A failure at any step says which and records nothing, and
accepting again after an interruption finds the change already made and only
records it. In the editor, the same bar tells anyone who cannot decide that
suggestions are waiting and who can clear them, which is also why "Save as new
version" is greyed out.

`useSuggestionReview` is declared AFTER `useInlineEditor`, the one viewer hook
that is: it edits rather than decorates.

### Display

A pending suggestion is drawn in the reading frame by the annotation layer, as
a highlight whose text is struck through, followed by its replacement. The
replacement is an ATTRIBUTE on the last wrapper (`data-bshd-ins`), shown by the
injected stylesheet as generated content — never a text node, which would
change the `textContent` every anchor is measured against, and would survive
the strip that unwraps highlights into the bytes. Both attributes ride on
`HL_SELECTOR` wrappers, so the four legs of §6a remove them with no new leg
(`brand/dom.ts`).

It is drawn only where its quote resolves EXACTLY (`annotation/exact.ts`):
whitespace normalised, context choosing between repeats, never fuzzy and
never by position. One that does not is stale — listed, not drawn. A decided
suggestion is resolved, and like a resolved comment is not drawn.

In the panel a suggestion reads as its change — struck, then inserted, and in
words for a screen reader — with its state. It has no Resolve button. An
approver may Reject it, with a reason; its author may Withdraw it.

### Not built

A suggesting mode inside the editor · structural or formatting suggestions ·
accepting on the server · merging a stale suggestion into changed text ·
carrying a pending suggestion to the next version · bulk accept · a
per-document "require review" switch · deciding from an agent.
