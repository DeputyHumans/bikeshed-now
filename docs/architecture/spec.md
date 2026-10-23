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

The optional landing-page explainer is operator-reviewed public marketing media,
not a published document. It MAY be served directly from a separate public
bucket, never the private document-content bucket. A media revision is immutable;
its MP4, captions and poster MUST agree before the landing page references it.

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
`firebase.json` and `scripts/lib/endpoints.mjs` by `functions/test/wiring.test.js`,
which also holds this table to them.

| Rewrite | Function |
|---|---|
| `/session` | `session` |
| `/config` | `appConfig` |
| `/healthz` | `health` |
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
| `/suggestion` | `manageSuggestion` |
| `/thumb` | `saveThumbs` |
| `/mcp` | `mcp` |
| `/.well-known/oauth-protected-resource` | `oauth` |
| `/.well-known/oauth-protected-resource/mcp` | `oauth` |
| `/.well-known/oauth-authorization-server` | `oauth` |
| `/.well-known/openid-configuration` | `oauth` |
| `/oauth/register` | `oauth` |
| `/oauth/token` | `oauth` |
| `/oauth/consent` | `oauthConsent` |
| `/sitemap.xml` | `sitemap` |
| `/verify/**` | `verifyEmail` |
| `/download/**` | `downloadBundle` |
| `/draft/**` | `getDraft` |
| `/content/**` | `contentProxy` |
| `/thumb/**` | `contentProxy` |
| `/d/**` | `docShell` |
| — (Firestore trigger) | `onCommentCreated` |
| — (Firestore trigger) | `recordVersionEvent` |
| — (Firestore trigger) | `recordThreadEvent` |
| — (Firestore trigger) | `recordCommentEvent` |

Rewrite order matters: exact paths precede wildcards, which precede the SPA
catch-all. `/folder` is an exact rewrite, so `/folder/{id}` correctly falls
through to the SPA. `/d/**` is the one rewrite that serves a **client route**:
`docShell` answers with the app shell itself, not an API (§17 "Link previews").

**`/docs` and `/docs/developers` are redirects, not rewrites.** Hosting answers
`/docs` and `/docs/` with `302` to `/d/docs`, and `/docs/developers` with `302`
to `/d/docs-developers`; redirects are applied before static files and
rewrites. Each guide is an ordinary published document whose source is
`content/<id>/bundle/index.html`, so it is read in the viewer and takes
comments like any other. The user guide names no command; the developer guide
holds the command line, the agent tools and the loop an agent runs. Temporary
rather than `301`, because a browser keeps a `301` for good. A deployment that
has not published a guide answers its shortcut with the document page's "Not
here", and under Vite dev there is no redirect at all.

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

### `GET /healthz`, `HEAD /healthz`

Public operational status, never user data: read an operational Firestore path
(absence is acceptable) and validate the private Storage health marker. Perform
no writes and bound the dependency checks to five seconds. Return `200` with
`{"status":"ok"}` or `503` with `{"status":"degraded"}`; HEAD has no body.
All responses, including method refusals, MUST be `private, no-store`. Dependency
identities and errors MUST NOT appear in the response. An operator provisions
the marker before deploying the endpoint. This is dependency availability, not
proof of private sign-in or document writes.

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
5. Stream `<storagePrefix>/<relPath>` from the committed version record with the Admin SDK; legacy records use `docs/{docId}/{versionId}`.

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

`GET /access?docId=` answers the owner's share panel: which grants the
document inherits, and from which folder (§13). Owner-only, refused as a read
is. `200 { inherited: [{ folderId, path, principal, role }] }`: every grant on
the document's folder and on each folder above it, nearest folder first and
highest role first within each. `path` names only the levels the caller can
open and writes `…` for the rest, as `filedIn` does. `Cache-Control: private,
no-store` on every answer, the refusals included.

### `POST /draft`, `GET /draft/**`, `POST /commit`
Editor-gated (`canEdit`, which on an unlisted open-editing document accepts the
caller's link grant), Admin-SDK only, versions immutable — a commit always
mints a NEW `vN+1`. A refused caller gets `404` unless they may read (§1.4b).

- **`POST /draft`** — `{ docId, baseVersion, entry?, html }`. `409 { currentVersion }`
  when `baseVersion !== currentVersion`, checked again in the adopting transaction.
  Writes create-only objects to a unique `docs/{docId}/drafts/{attempt}/` prefix
  and records that prefix in `docs/{docId}.draft.storagePrefix`. For a Markdown-sourced document the edited HTML is
  converted to Markdown server-side and `index.md` is what is stored (§11).
- **`GET /draft/:docId/*`** — serves the draft prefix, **falling back** to
  the base version's committed storage prefix for anything the draft does not carry,
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
| `revise` | `annId, replacement, note?` | its author, any channel | `403` anyone else; `409` decided or claimed, or changed twenty times |
| `withdraw` | `annId` | its author, any channel | the same; idempotent once withdrawn, and the thread stays |
| `claim` | `annId` | an approver, in the app | `409 { claimedBy }` another approver's live claim |
| `accept` | `annId` | an approver, in the app | `409` no draft of this version; idempotent once accepted |
| `reject` | `annId, reason?` | an approver, in the app | idempotent once rejected |

`claim`, `accept` and `reject` refuse a token with `403`: here an accept
records what the approver's browser has already applied, which a token cannot
have done. An agent decides through its tools instead, which check the same
role (§19). `revise` and `withdraw` take one: each changes only the caller's
own pending proposal, and neither destroys anything.
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
  through the same `reviseDocument` as `update_document` (§19). It is how the
  app's "Upload a new version…" publishes a file from disk — from the viewer's
  menu, a dropped file, or the workspace card — and the one way to revise with a
  `.zip`, because the tools take text. It takes
  `isDocEditor`, not `canEdit`: uploading a bundle into a document is a
  re-upload in all but name, which open editing does not extend to. `id`,
  `folderId` and `title` with it are a `400`; a refused caller gets the usual
  `404`/`403` (§1.4b); an expired document a `409`. Given `baseVersion`, the
  version the file was revised from, another version being current is a
  `409 { error, currentVersion }`. A pending suggestion on the current version
  is a `409 { error, pendingSuggestions }`, a draft holding an accepted
  suggestion a `409 { error, acceptedInDraft }`, and anybody having the document
  open in the editor a `409 { error, editors }` (§6a). A new version withdraws
  trust, as every update through a token does (§6c), and drops the draft it
  replaced (§16). Answers `{ docId, versionId, contentHash, fileCount, bytes,
  deduped }`.
- **`POST /folder` (`createFolder`)** — `{ name, parentId? }`.
- **`POST /folder-access` (`setFolderAccess`)** — same delta shape as `/access`;
  owner-only; cascade-recomputes the whole subtree. `GET
  /folder-access?folderId=` answers as `GET /access` does, from the folder's
  parent up: a folder's own grants are already its direct ones.
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
- **`POST /tokens`** — `{ op: "create"|"revoke"|"list", ... }` — §19. A browser
  session for all three; a personal token as its own bearer may `revoke` itself
  and nothing else (§23).
- **`POST /mcp`** — streamable HTTP MCP endpoint; a personal access token or a
  connected app's access token — §19, §23.
- **`GET /.well-known/oauth-protected-resource[/mcp]`**,
  **`GET /.well-known/oauth-authorization-server`**, **`POST /oauth/register`**,
  **`POST /oauth/token`** — the `oauth` function — §23.
- **`POST /oauth/consent`** — the `oauthConsent` function, signed-in account's
  ID token only — §23.
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
docs/{docId}/events/{eventId}                  ChangeEvent      (append-only, server-only, ADR 0016)
docs/{docId}/linkGrants/{uid}                  LinkGrant        (server-written)
forks/{forkDocId}                              ForkRecord       (server-only, §21)
folders/{folderId}                             FolderMeta
teams/{teamId}                                 TeamMeta
users/{uid}                                    UserRecord
users/{uid}/tokens/{tokenId}                   TokenRecord
users/{uid}/cursors/{tokenId}~{docId}          SavedCursor      (server-only, §19)
public/{docId}                                 PublicDoc        (projection, public only)
```

**An `Annotation` with a `suggestion` field is a suggested edit** (§22):
`suggestion: { replacement, state: "pending" | "accepted" | "rejected" |
"withdrawn", claim?, decidedBy?, decidedAt?, revisions? }`, where `decidedBy`
and `decidedAt` say who closed it — an approver deciding, or its author
withdrawing — and when, and `revisions` holds, oldest first, what each change
its author made replaced: `{ replacement, note?, at, actor }`, the note only
when a new one replaced the author's own. Its `resolved` is `false` while pending and `true` once closed, so
it counts as an open thread everywhere one is counted.
Only `POST /suggestion` writes the field. A **`Comment`** may carry
`opensSuggestion` (the thread's first comment) and `generated` (text the server
wrote rather than the author), and no client may write either.

A browser writes feedback with **exactly** the fields the app sends, and the
rules list them: an `Annotation` is `{ annId, anchor, authorUid, authorEmail,
actor, color, resolved, createdAt }`, created with `resolved: false`, and a
`Comment` is `{ commentId, body, authorUid, authorEmail, actor, createdAt }`.
`createdAt` is the server's clock (`request.time`), never the client's. After
that a reader may change an annotation's `resolved`, together with
`resolvedBy: { uid, email, channel: "web" }`, which must be the reader. The
change log reports it as who resolved or reopened the thread, and an agent's
resolve writes the same field with its own actor. A comment's author may change
its `body` and nothing else. Everything else on these records is written by the
server, through the Admin SDK.

**`events/{eventId}`** is the change log an agent reads through `get_changes`
(§19, ADR 0016). Its fields:
- `at`: when the event was written, by the server's clock;
- `type`: what changed, for example `comment.added`, `thread.resolved`,
  `suggestion.accepted`, `version.withdrawn`, `doc.renamed` or `access.changed`;
- `audience`: `readers`, `editors` or `owner`;
- optionally `version`, `threadId` and `commentId`;
- `actor`: `{ uid, channel, tokenId? }`, with no email;
- `data`: small values, never a body.

How events are written:
- **Triggers** (`recordVersionEvent`, `recordThreadEvent`, `recordCommentEvent`)
  create them under the CloudEvent's id, so a redelivery writes nothing.
- **Endpoints** that change the document record create them in the same batch
  as the change.
- **Never:** no client reads or writes the log, and nothing deletes from it.

A saved cursor, `users/{uid}/cursors/{tokenId}~{docId}`, is `{ cursor, docId,
tokenId, updatedAt }`: the last cursor `get_changes` gave that credential for
that document. It is server-only.

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
`docs/{docId}/bundles/{attempt}/`, selected by `DocVersion.storagePrefix`;
legacy records use `docs/{docId}/{versionId}/`. Written only by the Admin SDK, never with
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
the answer; callers must not assume they got what they asked for.
`publish_document` also returns the `requestedId` (the one asked for, or the
title's slug) and `idTaken`, which says outright what comparing the two would
tell the caller anyway. Ids minted
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
- **A `strict` anchor is never resolved by position.** An agent's comment
  (§19) is anchored on the server, by its quote, without a DOM: `elementId` is
  empty, `exact` is whitespace-collapsed, and its offsets are local to one
  block rather than positions in the body. So it is rehydrated with the
  strict resolver suggestions use (§22) — the exact text, whitespace
  normalised, or nothing — and one that does not resolve is orphaned. The
  fuzzy resolver would truncate a quote whose source wraps a line, and its
  position fallback would highlight the wrong words.
- **A resolved annotation is not drawn.** Resolving is how a reader says a
  passage is dealt with, so its mark comes off the prose; the thread stays in
  the panel and can be reopened there. An agent resolves through a tool, which
  leaves a note in the thread saying so (§19). A resolved annotation is skipped before
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
  `POST /commit` (or, from an agent, `commit_draft`; both are `commitDraft` in
  `lib/draft.ts`), allowed only when every comment on the current version is
  resolved. Annotations are version-scoped, so the new version starts
  comment-free and the old version keeps its comments.
- **No version is minted while a suggestion on the current one is pending**,
  through ANY account channel: the in-app commit, `/publish?update=`, the CLI
  and `update_document` alike. Publishing past it would leave it undecided on a
  version nobody reads — a rejection nobody chose to make — and only an approver
  may decide it. The gate is asked after the content-hash dedup, so an
  identical update stays a no-op, and before anything is uploaded
  (`lib/review.ts`).
- **No update replaces a draft that holds an accepted change.** Accepting puts
  the change in the draft (§22), and `/publish?update=`, the CLI and
  `update_document` mint a version from their own bytes and delete the draft.
  So while the current version's draft exists and a suggestion on that version
  is accepted, they refuse with `409 { error, acceptedInDraft }` and say to
  publish the draft first, asked before anything is uploaded and again inside
  the transaction that would delete it. The in-app commit publishes the draft
  itself and is not held.
- **No update is made under somebody's editor.** `/publish?update=`, the CLI
  and `update_document` are refused with `409 { error, editors }` while anybody
  has the document open in the editor, whose typing the new version would
  throw away. A read of presence that fails refuses too, rather than guess
  nobody is there. The question is asked after the dedup, so an identical
  update stays a no-op, and before anything is uploaded (`lib/presence.ts`).
  Once the version is current, the draft's files and its live log are dropped
  (§16); a refused or deduplicated update leaves both alone. A race remains,
  as for an agent's accept (§22): somebody who opens the editor between the
  question and the new version loses what they type in that window.
- The comment gate stays on the in-app commit alone, because
  the agent loop revises a document in answer to its open comments, and
  closing them is not what publishing the answer waits for (§19).

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
  health.json                          operational marker contract
  index.ts                 all exports (§2)
  config.ts                bucket, region, limits, secrets
  generated/policy.ts      GENERATED
  lib/{auth,acl,access,management,audience,events,folders,hash,bundle,presence,actor,publicdoc,linkgrant,teams,tokens}.ts
  lib/{head,html,htmltext,http,health,marking,thumbs,shell}.ts
  lib/{storage,versions,publish,draft,review,fork,rename,suggestions,accept,apply,quote,threads}.ts
  lib/markdown/{render,serialize,slug,theme}.ts
  email/{send,notify}.ts
  email/templates/*.tsx
  mcp/{server,tools,management}.ts
  oauth/{routes,metadata,clients,redirect,fetch,consent,grants,token}.ts
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
(`*` bullets → `-`, setext → ATX, and a hard-wrapped paragraph becomes one
line). After that first pass it MUST be idempotent:
`md → html → md'`, then `md' → html' → md''` with `md' === md''`. That property
is the contract, and it is what keeps editing a Markdown document from slowly
destroying it.

Normalization MUST NOT be lossy, and raw text is where it most easily is: the
text inside an author's `<script>`, `<style>` and `<textarea>` comes back
byte for byte, each on lines of its own where it stood as a block. Whitespace
there is meaning — a line break ends a script's `//` comment — and the HTML to
Markdown converter collapses whitespace in every other text node.

---

## 12. Local verification expectations

| Command | Expectation |
|---|---|
| `npm run check:policy` + `git diff --exit-code` | codegen reproducible and committed |
| `npm --prefix app run typecheck && npm --prefix app run build` | exit 0, `app/dist/index.html` exists |
| `npm --prefix functions run build && npm --prefix functions test` | 0 failing |
| `npm --prefix app test` | green; coverage ≥90% on `annotation/ export/ workspace/ stats.ts brand/` |
| `npm run test:rules:emulated` | 0 failing |
| `npm --prefix cli test` | 0 failing |
| `node scripts/<each>.mjs --dry-run …` | exit 0; credential-free for all but `delete-version`, whose preview must read to be useful |
| `npm run check:secrets` | `check-secrets: clean` |
| `npm run check:headers` | exit 0 |
| `npm run check:content` | every sample still demonstrates what it is there for |
| `npm run check:licenses` | exit 0, every dependency permissive |
| `npm run check:agents` | `AGENTS.md` matches `CLAUDE.md`, `llms.txt` the agent guide, and the served skills their sources |
| `npm run test:tools` | 0 failing |
| `npm run test:e2e -- --self-test`, then `npm run test:e2e -- run --suite smoke` (opt-in) | 0 failing, then exit 0 |

`npm run verify` runs every row except three: `test:rules:emulated`, which needs
the emulators and starts them, the script dry-runs, which are run by hand, and
the end-to-end suite, which is opt-in (`CONTRIBUTING.md` has the same table).
The suite builds its own copy of the product from the tree on spare ports,
needs Java, Mailpit and Chrome, and takes minutes and gigabytes, so neither
`verify` nor CI runs it. It is run for a change the verification walkthrough
covers (`docs/development/verification.md`, "Automated"; `e2e/README.md`).

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

**Filing is sharing, and it is silent.** A document filed into a folder is
readable by everyone in the folder's `members`, and nobody is emailed:
invitations go out only when sharing itself changes. So an agent that files a
document is the only party that can tell the person who just gained access,
and the agent surface says who that is:
- `list_folders` counts each folder's readers;
- `get_folder` names them;
- every write that files a document returns `filedIn` and `access`, read after
  the write.

This discloses nothing new. The rules let a folder's members read its whole
record, `members` included, and a team is named only to its own members, as the
share panel names it (`lib/audience.ts`).

**The share panel says where access comes from.** A record holds only the
flattened sets, so the panel asks `GET /access` or `GET /folder-access` (§2) and
lists each inherited grant after the record's own, tagged with the folder it is
made on. Those rows have no role select and no remove button: inherited access
is changed on the folder, never under it. A person granted directly and through
a folder gets both rows, because removing the direct grant leaves the other. The
owner may be unable to open a folder above: its people are already in the
record's own sets, so they are listed, but the folder is "a folder you cannot
open", never its name.

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
marketing. The change log an agent reads (§19, ADR 0016) is none of these. Nobody
is told anything by it. It is written as a side effect of changes that happen
anyway, and read only by whoever asks.

The comment email is bounded **by construction rather than by infrastructure**:
one `onDocumentCreated` trigger; recipients = owner + prior thread participants −
the author; a per-(recipient, doc) cooldown on the user record. No queue, no
scheduler, no cron. Per-user opt-out in `users/{uid}.emailNotifications`.

A suggested edit is a branch of the comment email, not a fourth message. Its
opening comment is addressed to the owner and every approver − the author,
because only they can decide it; the notice shows the quote and the proposed
replacement, and the author's note if there was one. A decision is a short
comment in the thread ("Accepted." / "Rejected: …"), which reaches the
suggester the ordinary way; so is a withdrawal ("Withdrawn."), which reaches the
owner and everybody who has written in the thread.

New suggestions have a cooldown of their own, apart from comments: a waiting
suggestion holds back the next version until somebody decides it, so a comment
email a minute earlier must not delay the notice of one, while a burst of
suggestions — an agent may leave twenty — is still one email per window.

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

**The log belongs to the draft.** When an editor opens a document, a log that
holds anything wins over the bytes it loaded, because it may hold edits they do
not. So a write made outside the editor is refused while anybody is in it, and
drops a log nobody is using: an agent's accept and `commit_draft` (§22), and
every update, through `/publish?update=`, the CLI or `update_document` (§6a).
An update deletes the draft's files with it; left in place, `/draft` would
serve them. Without both, the next person to open the editor would bring the
replaced draft back over the new version and autosave it.

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
reason, and allows the actor no other field: a browser cannot put a `tokenId`,
`client` or `agent` on its own feedback. `client` and `agent` come from `X-Bikeshed-Client` / `X-Bikeshed-Agent`,
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
that already exist, with **no new writes**. Gated to `isDocEditor`. The change log
`get_changes` reads (§19, ADR 0016) is separate and does not feed this panel. The
panel is opened now and then by an editor; the log is polled every minute or two
by an agent, and must report what leaves no record of its own.

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

*That upgrade has been taken* (ADR 0014): apps now connect by signing in, as
§23 specifies. Personal tokens are unchanged and remain the credential for CI,
scripts and anything that cannot open a browser.

### Historical versions and immutability

Published versions and their existing review threads form a read-only archive.
Current document ACL and expiry apply to every historical read. The current
version alone accepts comments, replies, comment edits/deletes, thread state
changes and all suggestion actions, including claim/release and idempotent
retries. The Firestore rules check the head for every annotation/comment write;
Admin SDK operations check it inside the writing transaction. A request racing
publication fails rather than writing to an archive or retargeting the new head.
The UI offers no mutation controls on historical versions and links to latest.

Each upload attempt writes create-only objects under a unique bundle prefix.
`DocVersion.storagePrefix` selects its immutable bytes; old records retain the
legacy version path. A draft save also owns a unique `draft.storagePrefix` and
adopts it transactionally only while its base is current. Publishing verifies
both the head and observed draft pointer; cleanup deletes only that draft.

### Previous versions and write guards

Use `list_versions({id, limit:20, cursor})` or `bikeshed versions <id|link>
--all --json` to discover published history. Pages are newest first, default 20,
maximum 50; pass `nextCursor` as `cursor` until null. Each row has a pinned URL.
History uses the document's current access rules and expiry. A missing or
withdrawn version is an error, never a request for the latest version.

Read a chosen version with `get_document({id, version:"v2"})` and
`get_comments({id, version:"v2", includeResolved:true})`, or
`bikeshed get <id> --version v2` and `bikeshed comments <id> --version v2 --all`.
Read results name `currentVersion` and `isCurrent`; historical write capabilities
are false. Existing comments and suggestions remain readable as an archive.
Older versions cannot be edited or receive, revise, delete, reply to, resolve,
reopen, accept, reject, claim or withdraw feedback. Fork one to make a new,
independent document with `fork_document({id, version:"v2"})`.

CLI `get`, `comments`, `fork`, and `open` preserve a version in a pasted
`/d/<id>/<version>?k=...` URL. Feedback commands also preserve it as a write
guard. `--version` must agree with the URL; conflicts fail. Keys are retained.
Document-wide sharing, folder and lineage operations still address the document.

Before changing feedback, read the latest version and its feedback, then pass
that `version` to every feedback tool (`--version` in the CLI). Pass
`baseVersion` to `update_document` and `commit_draft` (`--base` on `bikeshed
update` and `bikeshed commit`). A versioned URL supplies the CLI base too.
If the head changes, the server refuses the write. Read the new head and
reassess the request; never silently redirect a historical request to it.

### MCP — thirty-two tools

`POST /mcp`, streamable HTTP, one Cloud Function, one rewrite.

| Tool | Purpose |
|---|---|
| `get_document_access` | owner-only complete direct, inherited and effective access; includes visibility, open editing, expiry and usable URL without source bytes |
| `set_document_access` | owner-only grant/revoke/role delta; invitations to newly effective readers |
| `get_folder_access` | owner-only complete direct, inherited and effective folder access |
| `set_folder_access` | owner-only grant/revoke/role delta and subtree recomputation; invitations to newly effective folder readers |
| `set_document_visibility` | owner-only sparse patch of visibility, publicEdit and expiresAt; null clears expiry, omissions stay unchanged |
| `rename_folder` | rename a folder the caller can edit |
| `move_folder` | move a folder the caller can edit into a writable parent; omit parent for root; reject cycles and recompute access |
| `delete_folder` | owner-only; reparent contents to the parent/root and recompute access; retain documents |
| `list_versions` | published versions ordered by publishedAt and id descending, limit 20/max 50, cursor/nextCursor, pinned URLs |
| `list_documents` | the caller's documents, with visibility, current version and where each is filed (`filedIn`) |
| `get_document` | metadata, its address and where it is filed, + current **source** (Markdown where available) |
| `publish_document` | create a document from content, optionally at a chosen `id`, saying whether that id was taken (`requestedId`, `idTaken`, §4), where it is filed and who can read it there (`filedIn`, `access`, §13), and the `cursor` to watch it from |
| `fork_document` | copy a version of a document the caller can read into one they own (§21), with `filedIn` and `access` |
| `get_lineage` | what a document was forked from and, for its owner, its forks (§21) |
| `update_document` | commit a new version of an existing document; given the `baseVersion` it was revised from, refused when another version is current; refused while anybody has the document open in the editor; and it counts the open threads the new version leaves behind (`threadsLeftBehind`) |
| `commit_draft` | publish the draft as the next version, through the in-app commit's own gates (§6a) |
| `suggest_edit` | propose replacing a passage with new text, for a person to accept or reject (§22) |
| `revise_suggestion` | change the caller's own pending suggestion; what it said before is kept (§22) |
| `withdraw_suggestion` | take back the caller's own pending suggestion; its thread stays, closed (§22) |
| `accept_suggestion` | accept a pending suggestion, for the owner or an approver: its change is made in the draft (§22) |
| `reject_suggestion` | decline a pending suggestion, for the owner or an approver, with a reason (§22) |
| `list_folders` | every folder the caller can see, each with its full path and how many can read it (`readers`, `shared`) |
| `get_folder` | who can read one folder: everyone by email (the first 25, then a count), its editors, and its teams, each named only to its members (§13) |
| `create_folder` | create one, optionally inside another |
| `move_document` | file a document into a folder, or back to the workspace root, saying who can now read it (`access`) |
| `rename_document` | change a document's title and slug; its docId, the address, never changes (§4) |
| `get_comments` | **unresolved feedback, each with its anchored quote**, oldest thread first, at most 50 with `truncated` when there were more; `awaitingReply` marks a thread a person spoke last in on the current version; `threads` fetches only the named ids; `version` names an earlier version, whose threads any reader of the document may read |
| `get_changes` | what happened since a cursor, in recorded order: comments, threads, suggestions, versions, and changes to the document's title, folder, visibility, expiry, trust and sharing; `since` is required; with `needsReply` and the document's `state` (ADR 0016) |
| `add_comment` | start a thread on one passage, found by its quote |
| `reply_to_comment` | respond in a thread |
| `resolve_thread` | close a thread on the current version that is not a suggestion, leaving a note that says so (§6) |
| `reopen_thread` | open such a thread again, with a note |

`get_document`, `update_document`, `suggest_edit`, `get_comments`, `get_changes`,
`add_comment`, `reply_to_comment`, `resolve_thread` and `reopen_thread` take an optional `k`: an unlisted document's key, for a caller who is not a member and
whose account holds no link grant. Without it such a document answers exactly as
an id that does not exist (§17). The CLI accepts the link itself wherever it
takes an id, because the link is the only place a person holds the key.

### Watching a document: `get_changes`

An agent that publishes a document watches it for what people say. `get_changes`
reads the document's change log (§4, ADR 0016) after a cursor.

**`since` is required.** A poll that starts from an unknown point returns
nothing, and nothing reads as nothing happened. So the server never picks the
starting point. It is one of:
- a cursor from an earlier result: the events after it;
- `"last"`: the cursor this credential was last given for this document, or the
  log's start when it has none, said as `resumedFrom: "start"`;
- `"all"`: the log from its start.

A cursor is bound to its document. One from another document, a malformed one,
or one of an unknown version is refused, never read as "start over" or "now".
It grants nothing, so it is not signed.

**Where a cursor comes from, and only a poll moves one:**

| Result | Carries a cursor | Saves it as `"last"` |
|---|---|---|
| `get_changes` | the position after the last event read | always |
| `publish_document`, `fork_document`, `POST /publish` | the head of the new document's log | yes |
| `get_document` | the head of the log, to start watching from | only if none is saved |
| `update_document` and every other write | none | no |

A write's cursor would sit at the head of the log, past events recorded since
the caller's last poll that it has not seen. So an update hands none back.

**Each response** carries `cursor` (the same value back on a quiet poll), `more`
(call again now; pages are 100 events, cut on `(at, eventId)`) and `retryAfter`
in seconds, because there is no rate limiter. It also carries:
- `events`, in recorded order, each with its `type`, `at` and `channel`, and
  `by`, the email joined at read time. A comment carries its `body` and `quote`
  read from the source, and a deleted one drops out. A `fork.created` is dated
  to the day, never by whom (§21).
- `needsReply`: the threads in this page a person is waiting on. That means the
  current version, open, with the latest comment that is not a server note
  written in the browser. Never an agent's comment, so two agents cannot keep
  answering each other.
- `state`: the document now. Its version, title, `filedIn`, readers,
  visibility, expiry, trust, open threads and pending suggestions, whether a
  draft exists (to editors only, as the app shows it), and what the caller may
  do.

**Filtering:**
- **What the caller caused** is left out unless `includeMine`. That means an
  agent channel and this token: the rules pin a browser write's channel to
  `web`, so a browser comment signed with an agent's token is still reported.
- **Audience** follows the gates that exist. Readers see reader events.
  `isDocEditor` adds editor events: moves, visibility, trust and sharing, as the
  activity panel and the `acl` log are gated. The owner adds `fork.created`.

From a shell, `bikeshed changes <id> --since <cursor|last|all>` reads every page
and prints the cursor to pass next. `--wait` keeps checking until something
happens, at most every 30 seconds or `retryAfter`, and exits 3 with the cursor
when `--timeout` runs out.

`get_comments` is what earns the whole surface. Because every annotation stores
`exact`/`prefix`/`suffix`, a comment comes back **with the passage it is about**,
so an agent knows what to change without fetching and diffing the document. That
closes the loop this product exists for.

Efficiency rules, because agent context is the scarce resource: `get_comments`
returns, per thread, its id, quote, section, whether it is resolved and whether
a person awaits a reply, a suggestion's replacement, state and earlier
revisions, and each comment's id, time, author, channel and body, and nothing
else; `list_documents` is metadata-only; `get_document` returns **source, never
rendered HTML with its embedded stylesheet**; responses are capped, and say so.
`list_documents` pages with a cursor, `list_folders` says `truncated`, and
`get_comments` returns the 50 oldest threads and says `truncated` when there
were more; it orders by `createdAt`, the server's clock on every thread (§4),
through a composite index on `(resolved, createdAt)` that the emulator does not
demand and production does. A deploy ships the functions before that index
finishes building, so until it is ready the query reads every thread in order
and drops the resolved ones itself: the same answer, at more reads. `list_folders` counts each folder's readers and
names none; `get_folder` names them for the one folder an agent is about to
file into, because two hundred folders of email addresses would flood the
context. The source cap
is 200,000 characters, and `truncated` says when it applied. The CLI does not
inherit it: its output lands in a file, not a context, so `bikeshed get` reads a
cut source whole through `/content`, behind the same read checks.

There is no anonymous MCP access. Publishing always attributes to a real account
and stamps `publishedVia: "mcp"`.

`list_documents` and `get_document` report `expiresAt`. Owner management tools
may inspect and change access/settings on expired documents, including clearing
or extending expiry; content writes remain refused until expiry no longer holds.
`set_document_visibility` requires at least one of `visibility`, `publicEdit`
and `expiresAt`; omission preserves a field and null clears expiry. The CLI
accepts ISO-8601 timestamps with a timezone or `none`. Private disables open
editing; remaining unlisted preserves the key. This shared operation uses a
transaction for settings so omitted values come from the current record.

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

`rename_document` is the workspace list's rename through the same
`renameDocument` (`lib/rename.ts`) that `POST /organize` calls: `canEdit` with
no link key, at most 200 characters, `title` and `slug` and nothing else (§4),
and the public projection follows. Unlike the list it refuses an expired
document, as every write tool does. A document's own `<title>` is content and
is not rewritten, so a link preview still shows it (§17).

Management is available under the same identity and role checks as the web app
(ADR 0017). Eight additional tools take `id`; access writes take
`add: [{principal, role}]` and/or `remove: [principal]`. Emails and existing
`team:<id>` principals use the four existing roles. Access reads/writes return
`{id, kind, owner, direct, inherited, effective}` plus document visibility,
publicEdit, expiresAt and its usable URL. They are owner-only; inherited rows
retain the existing hidden-path and team naming policy. Removing a direct grant
does not override inheritance. Newly effective readers receive invitations;
repeating a grant or changing only its role does not send another invitation.

Folder rename/move require edit rights, and moving requires destination rights.
Deletion is owner-only, reparents immediate contents, and returns
`{id, deleted, parent, reparented: {folders, documents}}`. Folder moves/deletion
send no invitations. Documents cannot be deleted; team administration and script
trust remain outside this surface. HTTP and MCP call the same implementation.

**An agent proposes, and decides with its person's role** (ADR 0015). `suggest_edit` takes the passage as a
reader sees it — no markup — and finds it in the current version's RENDERED
entry without a DOM (`lib/quote.ts`): exactly, inside one block, with a prefix
or suffix to choose between repeats. It refuses a passage that is not there,
that repeats with nothing to tell the copies apart, or that spans a block or a
line break, each with what to do instead. The anchor it stores is the one the
browser's strict resolver will find; a fixture of golden cases is asserted by
both (§22). An agent whose person is the owner or an approver decides a
suggestion on the current version. `reject_suggestion` is `changeSuggestion`
exactly as the app's Reject, with the reason in the generated note and the
caller's actor in `decidedBy`. `accept_suggestion` takes the app's four steps
— claim, make the change in the draft, save it, record — with the change made
in the source by `lib/apply.ts` rather than typed into a page (§22), and
mints no version: `commit_draft` publishes the draft through `commitDraft`, the
in-app commit's own code, gates and all. Both write to the draft only while
nobody has the document open in the editor (§6b). The role is checked in the
tool, because a token never reaches the endpoint's check: `claim`, `accept` and
`reject` on `/suggestion` refuse a token. `functions/test/suggest-edit.test.js`
pins the tools whose names close anything to exactly the ones this section
lists, so a new one cannot arrive unexamined. What an
agent proposed it may change (`revise_suggestion`) or take back
(`withdraw_suggestion`) until it is decided — its person's own suggestions, on
the current version, where every pending one is. Neither erases anything
(§22). `get_comments` reports
a suggestion's `replacement`, `state` and `revisions` (each with its `via`
channel, never its token); `get_document` reports `canSuggest`;
and `update_document` from a caller who may only suggest names `suggest_edit`.

**An agent raises points as well as answering them.** `add_comment` finds its
passage exactly as `suggest_edit` does, with the same refusals, and writes the
annotation and its first comment in one batch, stamped with the caller's
actor. Anyone who can read a document may comment on it, as in the browser.
The anchor is stored with `strict: true`, because its offsets mean nothing in
the page (§6). Nothing caps how many threads an agent opens, as nothing caps a
person. Like every thread it stays on its version, and it holds back a new
version saved in the app, but not `update_document`: the comment gate is the
in-app commit's alone (`lib/review.ts`).

**An agent closes what it dealt with** (ADR 0015). `resolve_thread` and
`reopen_thread` do what any reader does with the panel's button, under the
same two rules the browser's write is held to: whoever may read the document
may, and never on a suggestion, which is decided rather than resolved. They act
on the current version only; an earlier version's threads are the record of
its review. A token cannot write Firestore, so they go through `lib/threads.ts`
in a transaction, and unlike the app each change leaves a generated note in the
thread — "Resolved." or "Reopened." — stamped with the caller's actor. Resolving
hides a point from the person who raised it; the note, and the comment notice
it sends them (§14), are how they hear an agent closed it, and the panel lets
them reopen it. A retry that changes nothing writes nothing.

One resolver authorizes every "put this inside that folder" in the system —
`resolveFolderTarget` in `functions/src/lib/folders.ts` — used by `createDoc`,
`createFolder`, both halves of `organize`, three MCP tools (`publish_document`,
`create_folder`, `move_document`), and `lib/fork.ts`, which `forkDoc` and
`fork_document` share. It authorizes with `canEditFolder`, which is the
question all seven are asking.

### CLI — `bikeshed`

Deliberately distinct from `scripts/*.mjs`:

| | `scripts/*.mjs` | `bikeshed` CLI |
|---|---|---|
| Who | whoever owns the deployment | any signed-up user |
| Credential | Admin SDK / gcloud, `--account` required | personal access token |
| Talks to | Firestore and Storage directly | the deployment over HTTPS |
| Purpose | provision, withdraw, tear down | publish and revise documents |

Commands: `login`, `logout`, `publish <file>`, `update <slug> <file> [--base <v>]`, `fork <slug>`,
`lineage <slug>`, `list`,
`get <slug>`, `comments <slug>`, `changes <slug> --since <cursor|last|all> [--wait]`,
`comment <slug> <text> --body <text>`, `reply`,
`resolve <slug> <thread>`, `reopen <slug> <thread>`, `suggest <slug> <text> (--with <text>
| --delete)`, `revise <slug> <thread>`, `withdraw <slug> <thread>`, `accept <slug> <thread>`, `reject <slug> <thread>
[--reason <text>]`, `commit <slug>`, `open <slug>`,
`folders`, `folder <id>`, `mkdir <name>`, `mv <slug> <folder|root>`, `rename <slug> <title>`,
`skills [install <dir>]`, plus `publish --watch`.
Every command takes `--json`. `--version` on its own prints the CLI's version,
read from its own `package.json`, which is also the version its
`X-Bikeshed-Client` header reports. `comments` prints a suggestion's replacement and
state under its quote. `suggest` demands exactly one of `--with` and `--delete`:
an empty `--with` is too easy to send by accident to be the way to ask for a
deletion.

`update` sends one `.md` or `.html` through `update_document`, and a `.zip` —
by name, or by the same magic-byte sniff the deployment uses — as raw bytes to
`POST /publish?update=`. Read as text, an archive is corrupted on the way.
`--base <v>` sends the version the file was revised from, as `baseVersion` by
either path. Either refuses if another version is current, with a 409 that
names it.

`publish` prints where it filed the document and who can read it there, from
the `filedIn` and `access` that `POST /publish` returns. With `--json`, it also
prints the `cursor` to watch from, as `fork --json` and `get --json` do.
`folders` counts each folder's readers, and `folder <id>` names them, from
`get_folder`.

`changes` reads every page of `get_changes` before printing, and ends with
`next: --since <cursor>`. `--since` is required. `--wait` checks again every
`--interval` seconds (at least 30, and at least the server's `retryAfter`) until
something happens, then exits 0. When `--timeout` runs out it exits 3, and still
prints the cursor to resume from.

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

### Management commands

`bikeshed access document <id>` and `bikeshed access folder <id>` inspect access;
`--add <comma-separated principals> --role <role>` and/or `--remove <principals>`
change it. Adding requires an explicit role. `bikeshed visibility <id>` reads
settings; optional `private|unlisted|public`, `--public-edit true|false`, and
`--expires <ISO timestamp|none>` patch them. `bikeshed rename-folder <id> <name>`,
`bikeshed move-folder <id> <folder|root>` and `bikeshed delete-folder <id>` map to
the three folder tools. All support human-readable and `--json` output.

### Skills

`skills/<name>/SKILL.md`, in the Agent Skills convention: YAML frontmatter
carrying `name` and `description`, then Markdown. Four of them —
`bikeshed-publishing`, `bikeshed-feedback`, `bikeshed-folders`, `bikeshed-permissions` — one per job the
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

Scopes on any credential (§23) · service accounts · webhooks · a REST API distinct from these
endpoints · SDKs in other languages · rate limiting beyond CDN caching · document
deletion, team administration or script trust through the agent surface.

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
| an agent | its person's | its person's | its person's | its person's (§19) |

Roles are granted and inherited as in §13. The author of a pending suggestion
may change or withdraw it, in the app or through an agent acting for them;
changing it needs the right to suggest still, withdrawing it does not.

### What a suggestion is

One **text** replacement inside one block: the quoted text, anchored as a
comment is (§6), and what it should become. An empty replacement deletes the
quote, and the one space beside it that would otherwise be left doubled. A
replacement is one line of text — no line break, control character or
bidirectional override — because anything else would insert structure when it
is typed in. Formatting, images and structure cannot be suggested.

It is stored as an annotation with a `suggestion` field (§4), so it has a
thread, a highlight, orphan detection and the comment email for free.

### Lifecycle

```
pending ──accept──▶ accepted
   │    └─reject──▶ rejected
   └──withdraw────▶ withdrawn
```

A **claim** is held by the approver applying it, for two minutes, and keeps
every other decision and the author's withdrawal off it meanwhile, so two
approvers cannot insert the same change twice. A lapsed claim is ignored, and
the approver lets go of theirs at once when nothing could be applied after
all. A claim and an accept name the replacement being applied, and are
refused if its author has changed it since: the text put into the draft and
the text recorded as accepted are always the same.

**Withdrawing closes, it does not delete.** A withdrawn suggestion keeps its
quote, its replacement and its whole thread, and is resolved as a decided one
is, so it stops holding back a new version. What somebody proposed and took
back is part of the document's record.

**Accepting is an edit.** The approver's browser finds the quote in the DRAFT —
exactly, never by fuzzy match — replays the replacement with `execCommand` in
the approver's own editing session, waits for the draft to save, and only then
records the decision. So it reaches every co-editor through the shared state
(§16) like a keystroke, and lands in the draft; publishing it is still "Save as
new version". A quote that no longer matches exactly is **stale**: shown as
such, and only rejectable.

**An agent's accept is the same edit, made in the source** (ADR 0015). With no
page to type into, `lib/apply.ts` finds the quote in the working copy — the
draft of the current version, else the version — by the browser's own rule,
but only where BOTH sides of its context agree; replaces exactly the source
bytes of that text, and only if they hold no markup, escaping the replacement
as HTML or, for Markdown, as inline Markdown where that is what renders right;
then reads the result back and keeps it only if its text is the old text with
that one span replaced, as the browser checks after typing. A deletion takes
the space it would leave doubled, by the browser's rule. A Markdown quote is
looked for written out in the source, wrapped lines allowed, and the change is
kept only if exactly one place renders as asked. Everything else is refused
with what to do instead, never applied nearby, and a shared fixture
(`functions/test/fixtures/apply-vectors.json`) is asserted by both sides: the
server's answer, and where the browser stands on the same text. Because the
live log wins over the draft when an editor opens (§6b), nothing is written
while anybody has the editor open, and a log nobody is using is dropped with
the write. A race remains: somebody opening the editor between that check and
the write seeds from the older draft (ADR 0015).

**A pending suggestion holds back every new version** (§6a). Only an approver
clears one, so somebody who can publish but not decide is told who can. The
hold is asked again inside the transaction that makes a version current, and a
suggestion is written in one that reads the current version, so one made while
a version is uploading either holds it back or is refused for the newer one;
it is never left behind on a version nobody reads.

The notes the server writes into a thread — the opener, "Accepted.",
"Rejected: …", "Withdrawn." — are stamped with the person they speak for, and
nobody may edit or delete them, that person included.

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
until it is decided — twenty times at most, after which it must be withdrawn
and suggested afresh. An edit never overwrites: what it replaced is kept in
`revisions` (§4), so a change of mind is on the record.

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
Nothing is judged or marked until the editing session has bound: binding to a
shared document somebody has already edited replaces the body, and a mark made
in the nodes it removes collapses to nothing.

Accept waits for the editing session to have joined the shared document (an
edit applied before the bind is lost to it), then runs claim → apply → save
the draft → record, and claims nothing it can already see is stale. The quote
and the replacement are found by one rule, the same context either side; where
one contains the other ("X" becomes "Y, X"), the longer is what stands there.
The edit is checked by what the text must read afterwards, and one that came
out otherwise is undone. A failure at any step says which and records nothing,
and accepting again after an interruption finds the change already made and
only records it. The bar, and the comments panel in the editor, call stale
exactly what Accept would refuse, judged again as the draft changes. In the
editor, the same bar tells anyone who cannot decide that suggestions are
waiting and who can clear them, which is also why "Save as new version" is
greyed out.

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
or withdrawn suggestion is resolved, and like a resolved comment is not drawn.

In the panel a suggestion reads as its change — struck, then inserted, and in
words for a screen reader — with its state, and, once its author has changed
it, "Changed N times" opening onto what it said before. It has no Resolve
button. An approver may Reject it, with a reason; its author may Withdraw it.

### Not built

A suggesting mode inside the editor · structural or formatting suggestions ·
accepting on the server across markup, or on one side of the context ·
merging a stale suggestion into changed text · carrying a pending suggestion
to the next version · bulk accept · a per-document "require review" switch.

---

## 23. Connecting an app by signing in

Existing connections gain management tools under their existing identity and
ACL, without reconnection or new scopes. Consent copy must describe sharing,
invitation emails, visibility/expiry, and folder operations; it must not claim
these are unavailable. See ADR 0017.

An app that speaks MCP connects by its address, `https://<deployment>/mcp`: the
person pastes it, signs in if they need to, and approves. This deployment is
the authorization server (OAuth 2.1, the MCP authorization specification). It
is hand-written in `functions/src/oauth/` with no dependency and no secret (ADR
0014).

### Discovery

| Path | Answers |
|---|---|
| `/.well-known/oauth-protected-resource` and `…/mcp` | RFC 9728. `resource` is `https://<host>/mcp` for the host the request used, `authorization_servers` is `[issuer]`. `private, no-store` |
| `/.well-known/oauth-authorization-server` | RFC 8414. The same on every host. `public, max-age=300` |
| `/.well-known/openid-configuration` | a JSON 404. This is not OpenID Connect |

- **The issuer** is `publicOrigin()`, a string with no trailing slash, compared
  byte for byte. In the emulator it is the request's own origin.
- **The host** comes from `X-Forwarded-Host` only when it is one of this
  deployment's hosts: the configured domain, `<project>.web.app` or
  `<project>.firebaseapp.com`, computed at runtime. Otherwise the configured
  host is used. `Host` is never read.
- **The metadata advertises:**
  - S256 only, and token-endpoint auth `none`
  - `client_id_metadata_document_supported` and
    `authorization_response_iss_parameter_supported`
  - no `scopes_supported`

A refused `/mcp` request answers `401` with
`WWW-Authenticate: Bearer realm="bikeshed", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
`error="invalid_token"` is added when a credential was presented. Every `/mcp`
response sets `Access-Control-Expose-Headers: WWW-Authenticate` and
`private, no-store`.

### Who is asking

| `client_id` | Registration | What the consent page may say |
|---|---|---|
| an https URL with a path | **metadata document**, fetched, `client_id` must equal the URL | "from {host}" — the host is verified |
| `bsdcr_…` | **stateless registration** from `POST /oauth/register`: the name and redirect URIs, encoded, unsigned, re-validated on every use | the redirect host first; the name is "chosen by the app, not checked" |
| `bikeshed-cli` | **built in**; loopback redirects to `127.0.0.1` or `[::1]` only | "Bikeshed's command line", and the device it reports |

- **The metadata fetch** is the one outbound request. It goes over https on
  443 to a hostname, never an IP literal. The address the socket connects to
  must be public, which is checked in its own `lookup`. No redirects are
  followed, the timeout is 5 s, and the body is capped at 16 KB. It runs only
  from `/oauth/consent`, behind sign-in.
- **What is validated** is only what is used. A document that requires a
  client secret is refused; anything else unused is ignored.
- **Names** lose every control and format character (`\p{Cf}`) before they
  are shown.

**Redirect URIs** are decided on the parsed scheme, after a printable-ASCII
check on the raw string:
- **Allowed:** `https:`; `http:` on a loopback host; an app's own scheme.
- **Refused:** `javascript`, `data`, `vbscript`, `blob`, `file`, `about` and
  their kind; fragments; userinfo.
- **Matching** is exact, except that a loopback redirect matches any port
  (RFC 8252). `localhost` and `127.0.0.1` are not interchangeable.

### Consent

`authorization_endpoint` is `/connect`, an app route.

- **The query is captured once, during render,** above the sign-in gate. It is
  kept in session storage for ten minutes and stripped from the address bar
  before analytics can read `document.location`.
- **`POST /oauth/consent {action, params}`** handles three actions:
  `describe`, `approve` and `deny`.
  - It authenticates with the signed-in account's **ID token**: never the
    cookie, which can name a different account from the one on screen, and
    never a personal token, the same rule as minting at `POST /tokens`.
  - It requires a same-origin `Sec-Fetch-Site` or `Origin`, and a JSON body.
- **Before the client and redirect URI are established**, a failure is shown to
  the person and nothing is sent anywhere. **After that**, a failure carries a
  `back` URL, which is followed only when the person presses the button. The
  page never redirects by itself.
- **What the page shows:**
  - who is asking and where the person will be sent back to, as a hostname
  - a warning for a program on this computer
  - what the app can and cannot do, which is §19's list
  - the account it will act as
- **What the page refuses:**
  - it does not render inside a frame
  - Approve stays disabled until the page has had focus for a second and a
    pointer or key event
- **`/connect` and `/signup` both send** `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`. `/signup` is included because `?next=` reaches the
  consent page without loading it from Hosting.
- **Approve** writes `oauthCodes/{sha256(code)}`, valid for two minutes. Every
  authorization response carries `iss` (RFC 9207).

### Tokens

A grant is a row in `tokens/` with `kind: "oauth"` and channel `mcp`, mirrored
to `users/{uid}/tokens/` so the account screen lists it and Revoke ends it.

| | Shape | Life |
|---|---|---|
| access | `bsa_<tokenId>.<secret>` | one hour; `/mcp` only, and only for the resource it was issued for |
| refresh | `bsr_<tokenId>.<secret>` | rotates on every use; lapses after 90 days unused |

A grant never has a `hash` field, so it cannot pass as a personal token, and
`resolveCaller` does not know the `bsa_` prefix.

`POST /oauth/token` reads the raw form body; a repeated parameter is
`invalid_request`. JSON is accepted as well. `scope` and `client_assertion` are
ignored.

- **Code exchange:**
  - Every check runs before the code is spent: client, `redirect_uri` when
    sent, `resource` when sent, and PKCE. A wrong verifier costs nothing.
  - The code is spent in the transaction that mints the grant.
- **Rotation:** the new secrets are `HMAC(spent secret, nonce‖label)`. A retry
  of the same spend within 60 s receives the identical pair, so a timeout cannot
  fork the chain. Outside that window, replaying the previous refresh token or
  the code revokes the grant.
- **Revocation requires possession.** A wrong secret for a known `tokenId`
  changes nothing.
- **The gate is re-checked at every refresh:**
  - not disabled
  - `emailVerified`
  - the same lowercased address
  - `isAllowedEmail`
  - `tokensValidAfterTime` not after the grant was created

  A closed gate revokes the grant. A failed lookup is `500 server_error` and
  revokes nothing, because a client told `invalid_grant` discards the connection.
- **The command line** goes through the same consent and receives an ordinary
  personal token (channel `cli`, named from the device it reports), with no
  refresh token. It calls endpoints other than `/mcp`, and parallel processes
  would trip reuse detection.

### The command line

`bikeshed login` never asks which deployment. It takes `--origin`, then
`BIKESHED_ORIGIN`, then the saved one, then the default, and names it. Then it:
1. Reads the authorization-server metadata.
2. Listens on `127.0.0.1` on an ephemeral port.
3. Opens `/connect` with PKCE, `state` and `device`.
4. Accepts one `GET /callback` whose `state` and `iss` match.
5. Exchanges the code and saves the token as before.

`--paste` is the old flow. `CI` set without a flag fails at once. The saved
config records which of the two produced the token.

`bikeshed logout` acts on the saved sign-in only, never `BIKESHED_TOKEN` or
`--token`, which belong to a shell or a job:
- A token from browser sign-in exists for this computer alone, so it is revoked
  with `POST /tokens {op:"revoke"}` under its own bearer. The server revokes the
  presenting token only: another `tokenId` is `403`, and `create` and `list`
  stay session-only, because minting with a credential is how a leaked token
  becomes permanent access, while revoking itself can only shrink it.
- A pasted token, or one saved before the config recorded which it was, is only
  deleted: CI may hold the same one. The command says where to revoke it.
- A `401` from `/tokens` is either a token that already stopped working or a
  deployment that predates self-revocation. One call to `/mcp` with the same
  token tells them apart, because the advice differs.
- The token is deleted whatever the outcome, an unreachable deployment
  included, and the origin is kept for the next `login`.

### Skills as downloads

Each skill is also served as `/skills/<name>.zip`, holding `<name>/SKILL.md`.
This is the shape Claude's skill upload takes. The zip is packed from the
**stamped** file after the build, stored rather than compressed, and verified
byte for byte by the predeploy check.

### Not built

Scopes · consent remembered across requests · token introspection or
revocation endpoints (Revoke is the account screen) · `private_key_jwt` client
authentication · OpenID Connect · a stored client registry.
