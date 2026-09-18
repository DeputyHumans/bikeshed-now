# Bikeshed — implementation spec (normative)

Every module MUST conform to this file. It supersedes prose elsewhere, including
`README.md` and `docs/architecture.md`. Field names, endpoint shapes, and the
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

**(b) Read-only byte endpoints collapse 403 into 404.** `/content/**` and
`/download/**` return `404` for "you may not read this" and for "this does not
exist" alike. Mutation endpoints keep `403`: the caller is acting inside their
own workspace and already knows the id. This drops no feature and closes the
existence oracle that an open gate would otherwise open.

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
| `/duplicate` | `duplicateDoc` |
| `/trust` | `trustDoc` |
| `/marking` | `setMarking` |
| `/visibility` | `setVisibility` |
| `/team` | `manageTeam` |
| `/team-members` | `manageTeamMembers` |
| `/tokens` | `manageTokens` |
| `/view` | `recordView` |
| `/draft` | `saveDraft` |
| `/commit` | `commitVersion` |
| `/mcp` | `mcp` |
| `/sitemap.xml` | `sitemap` |
| `/verify/**` | `verifyEmail` |
| `/download/**` | `downloadBundle` |
| `/draft/**` | `getDraft` |
| `/content/**` | `contentProxy` |
| — (Firestore trigger) | `onCommentCreated` |

Rewrite order matters: exact paths precede wildcards, which precede the SPA
catch-all. `/folder` is an exact rewrite, so `/folder/{id}` correctly falls
through to the SPA.

**`Cache-Control` for `/content/**` is set by the function, not by Hosting.**
A Hosting `headers` entry would override the function and force one policy on
both gated and public content; §17 needs them to differ.

Every endpoint is **auth-first**: authentication is checked before anything that
could reveal whether a document exists.

### `POST /session`
Body `{ idToken }`. Verifies with `verifyIdToken(idToken, true)` and applies §1.
Mints a session cookie (`createSessionCookie`, 5 days) and sets `__session` —
the only cookie Firebase Hosting forwards to functions — as
`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=<expiresIn s>`.

Response `200 { status: "ok" }`, or `200 { status: "unverified" }`,
`403 { status: "not_allowed", message }`, `401 { status: "session_failed" }`.
The status is a typed outcome, not an error string, so the UI can explain
rejection as a *state* rather than a failure.

### `DELETE /session`
Clears `__session` (Max-Age=0). `204`.

### `GET /config`
Public. Returns `{ signInHint?: string }` — a deployment-authored sentence for
the rejection screen. **Never the allowlist.**

### `GET /content/:docId/:versionId/*`
Path after `versionId` is the relative file path; default `index.html`.

1. Resolve the caller: `__session` cookie, else anonymous.
2. Load `docs/{docId}`. If absent → `404`.
3. If the doc is non-private (§17), serve. Else require a caller who passes
   `canRead` → otherwise **`404`** (§1.4b).
4. Version must exist → else `404`.
5. Stream `gs://<bucket>/docs/{docId}/{versionId}/<relPath>` with the Admin SDK.

Headers: `Content-Type` from the extension; `X-Content-Type-Options: nosniff`;
`Cache-Control: private, no-store` for gated content, `public, max-age=300` for
non-private content; `X-Robots-Tag: noindex` when visibility is `unlisted`.
Never send a restrictive `X-Frame-Options`/`frame-ancestors` — the content must
embed same-origin in the app's iframe.

Streamed with `file.createReadStream()`; large files are never buffered whole.

### `POST /access`
Body `{ docId, add?: [{ email, role: "viewer"|"editor" }], remove?: string[] }`.
`add` entries accept a plain email or a `team:{teamId}` grant (§18).

Owner-only. Applies deltas with set semantics (one role per principal; the owner
is never removed and never stored in a role), expands team grants, folds in the
parent folder chain, and writes `{ viewers, editors, members, editorMembers,
updatedAt }` via the Admin SDK. Records an entry in `docs/{docId}/acl` with the
acting `Actor` (§17). Syncs the presence mirror (§16) and the public projection
(§17).

`200 { viewers, editors, members }`.

### `POST /draft`, `GET /draft/**`, `POST /commit`
Editor-gated (`canEdit`), Admin-SDK only, versions immutable — a commit always
mints a NEW `vN+1`.

- **`POST /draft`** — `{ docId, baseVersion, entry?, html }`. `409 { currentVersion }`
  when `baseVersion !== currentVersion`. Writes `docs/{docId}/draft/{entry}` and
  `docs/{docId}.draft`. For a Markdown-sourced document the edited HTML is
  converted to Markdown server-side and `index.md` is what is stored (§11).
- **`GET /draft/:docId/*`** — serves the draft prefix, **falling back** to
  `docs/{docId}/{baseVersion}/<relPath>` for anything the draft does not carry,
  so first-edit and non-entry assets render. `private, no-store`.
- **`POST /commit`** — `{ docId, baseVersion }`. `409` if stale, if there is no
  draft, or if any annotation on the current version is unresolved
  (`{ unresolvedCount }`). Assembles base assets + edited entry, re-renders
  Markdown if applicable, hashes with the §9 framing, **dedups on `contentHash`**
  (identical bytes → no-op, clear the draft, `deduped: true`), else uploads and,
  in one transaction, creates `versions/{vN+1}`, bumps `currentVersion` and
  clears `draft`.

### Workspace endpoints
- **`POST /publish` (`createDoc`)** — raw body is the uploaded file; metadata in
  the query string (`?filename=&title=&folderId=&marking=`). Accepts a single
  `.html`, a `.md`/`.markdown`, or a `.zip`. Mints `v1`, `trusted: false`.
- **`POST /folder` (`createFolder`)** — `{ name, parentId? }`.
- **`POST /folder-access` (`setFolderAccess`)** — same delta shape as `/access`;
  owner-only; cascade-recomputes the whole subtree.
- **`POST /organize`** — `{ kind, id, op, targetFolderId?, name? }`. Document
  deletion is deliberately unsupported (`400`).
- **`POST /duplicate`** — `canRead`-gated; the copy is owner-only and
  `trusted: false`.
- **`POST /trust`** — owner-only global trust (§6c).
- **`POST /marking`** — owner-only export marking (§20).
- **`POST /visibility`** — owner-only `{ docId, visibility, publicEdit? }` (§17).
- **`POST /view` (`recordView`)** — reading heartbeat; see §4.
- **`GET /download/:docId/:versionId`** — `canRead`-gated zip of the version.

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
folders/{folderId}                             FolderMeta
teams/{teamId}                                 TeamMeta
users/{uid}                                    UserRecord
users/{uid}/tokens/{tokenId}                   TokenRecord
public/{docId}                                 PublicDoc        (projection)
```

**`members`** is the EFFECTIVE read set: the union of `ownerEmail`, direct
`viewers` and `editors`, the parent folder chain's grants, and the expansion of
any `team:{id}` grant — all lowercased. It is the array the doc list queries.
The owner is always in it. `viewers`/`editors` remain the DIRECT grants and are
the record of intent; `members` is the record of reality.

**`editorMembers`** is the EFFECTIVE editor set. Missing on legacy records ⇒
fall back to `editors`.

**`trusted`** is GLOBAL trust: it controls whether the viewer sandboxes the
content iframe FOR EVERY READER. CLI and MCP publishes write `true`; browser
upload and duplicate write `false`; the owner flips it via `/trust`.
`commitVersion` leaves it untouched, so trust PERSISTS across in-app edits.
Missing ⇒ treated as trusted.

**`stats`** is the denormalized usage rollup, so the workspace list renders
counts with no extra reads and any member can see the AGGREGATE. Written only by
the Admin SDK, always as a nested map under `set(..., { merge: true })` so the
view writer and the edit writer never clobber each other.
`recordView` deliberately does NOT touch `updatedAt` — that field means "bumped
on every publish", and a read must not masquerade as a publish.

`stats.apiReads` counts automated reads. They never enter `stats.views` or
`stats.totalMs`: reading *time* is a human concept and an agent fetching a
document forty times would otherwise turn both into noise (§17).

**Versions** are immutable and mint as `v{max(N)+1}` over EXISTING version
documents, so a withdrawn id is re-used by the next commit. `views/{sessionId}
.versionId` may therefore carry a `"{versionId}-deleted"` tombstone, written by
`delete-version.mjs`, so old and new sessions are never conflated under one id.

`createdAt` is set once. `updatedAt` is bumped on every publish.

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
  then wrap in `<mark class="bshd-hl" data-bshd-ann="...">`.
- Wrapping is per-text-node, so existing element nodes are never destroyed or
  re-parented. Highlights are presentational and are NEVER persisted.
- **A resolved annotation is not drawn.** Resolving is how a reader says a
  passage is dealt with, so its mark comes off the prose; the thread stays in
  the panel and can be reopened there. A resolved annotation is skipped before
  its anchor is resolved, so it is never reported as orphaned either.

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
- Autosave is debounced to `POST /draft`. "Save as new version" calls
  `POST /commit`, allowed only when every comment on the current version is
  resolved. Annotations are version-scoped, so the new version starts
  comment-free and the old version keeps its comments.

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
tags. Static uploads therefore never prompt.

Trust propagates across in-app edits (`commitVersion` leaves it untouched),
which is safe because platform editing is parent-driven and cannot introduce a
new uploaded bundle; re-upload and duplicate both make FRESH `trusted: false`
documents.

---

## 7. Web app structure

```
app/src/
  main.tsx App.tsx
  brand/{tokens.ts,dom.ts,fonts.ts,Wordmark.tsx,Mark.tsx}
  styles/*.css                      (11 files, @layer tokens,base,primitives,layout,feature)
  generated/policy.ts               (GENERATED)
  config.ts firebase.ts auth.tsx analytics.ts
  firestore.ts access.ts folders.ts teams.ts upload.ts edit.ts trust.ts
  presence.ts stats.ts tokens.ts visibility.ts marking.ts
  annotation/{anchor.ts,highlighter.ts,Sidebar.tsx}
  wysiwyg/{EditToolbar.tsx,placeholders.ts}
  export/{labels.ts,html.ts,pdf.ts,image.ts}
  viewer/{useDocFrame.ts,useAnnotationLayer.ts,useInlineEditor.ts,...}
  workspace/tree.ts
  pages/{DocList.tsx,DocViewer.tsx,SignUp.tsx,Account.tsx}
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
  lib/{auth,acl,access,folders,hash,bundle,presence,actor,public,teams,tokens}.ts
  lib/markdown/{render,serialize,slug,theme.ts}
  email/{send,cooldown,templates/*}
  mcp/{server,tools}.ts
```

- `lib/auth.ts` — the §1 gate over a decoded token, an ID token, a session
  cookie, or a personal access token.
- `lib/acl.ts` — `canRead`, `isDocEditor`, `canEdit`, `canManageSharing`, and
  the folder equivalents. **`acl.ts canRead()` MUST mirror `firestore.rules`
  `canRead()`.** They are tested on both sides.
- `lib/hash.ts` — the §9 framing, byte-identical to `scripts/lib/hash.mjs`.
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
`delete-version.mjs`. Shared helpers in `scripts/lib/`: `args`, `email`,
`firebase`, `hash`, `membership`, `endpoints`.

These are **operator** tools — distinct from the end-user `bikeshed` CLI (§19).
They authenticate with the Admin SDK and require `--account` explicitly on every
real run; the CLI authenticates with a personal access token over HTTPS.

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
| `npm run check:brand` | `brand-guard: clean` |
| `npm run check:headers` | exit 0 |

**The app MUST connect to the emulators** behind `VITE_USE_EMULATORS=1`
(`connectAuthEmulator`, `connectFirestoreEmulator`, `connectDatabaseEmulator`).
This is a requirement, not a convenience: it is the single thing that makes the
quickstart cost nothing.

The Vite dev proxy MUST cover **every** endpoint. Use anchored regex keys
(`^/folder(\?.*)?$`) for exact endpoints and prefix rules only for `/content`,
`/download`, `/draft`. A naive `/folder` prefix rule would proxy the client
route `/folder/{id}` to the emulator and silently break folder deep-linking.

---

## 13. Workspace: nested folders and inherited sharing

Documents organize into nested folders with their own sharing. Inheritance is
**denormalized, not resolved at read time**:

```
members       = union(self owner/viewers/editors, parent.members)
editorMembers = union(self owner/editors,         parent.editorMembers)
```

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
4. Create `users/{uid}`.
5. Land in the workspace — **anything shared with you before you signed in is
   already listed**, because the ACL is keyed by email.

Step 3 is security-load-bearing: without it, signing in with an unverified
address that matches a pending share would hand an attacker someone else's
documents. This is the most tempting shortcut in the whole feature and is
recorded as such in `docs/threat-model.md`.

### Email

Exactly three messages: **invitation** (a new grant, never a re-grant),
**verification**, **new comment**. Deliberately not built: digests, weekly
summaries, a notification centre, unread badges, mention parsing, reminders,
marketing.

The comment email is bounded **by construction rather than by infrastructure**:
one `onDocumentCreated` trigger; recipients = owner + prior thread participants −
the author; a per-(recipient, doc) cooldown on the user record. No queue, no
scheduler, no cron. Per-user opt-out in `users/{uid}.emailNotifications`.

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
   `initializeAnalytics(app, { config: { send_page_view: false } })` and log
   route changes manually using the **route pattern** (`/d/:docId/:versionId`).

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
`duplicateDoc`, `setAccess`, `organize`, `folders.ts recomputeSubtree`,
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

### The caret is still faster than the text

Peer carets and selections update at 200 ms; the document merges as fast as
updates arrive. The two are separate channels on purpose — the pointer is what
the eye tracks, so it has to feel live, and it is ephemeral, so it must never
touch the document DOM (see the overlay rule above).

### Deliberately not built

Per-character attribution or blame · cursor chat · voice and video · a live chat
channel · presence for non-members · workspace-wide "who is online".

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
| `unlisted` | anyone with the link | `X-Robots-Tag: noindex` | `/d/{slug}?k={token}` |
| `public` | anyone | indexed, in `sitemap.xml` | `/d/{slug}` |

**The private-bucket invariant is not weakened.** The bucket keeps uniform access
and public-access-prevention; `contentProxy` stays the only path bytes take.
"Public" means *the proxy will serve you without a cookie*.

### Anonymous reads use a projection, not a rules exception

Firestore rules cannot project fields, so letting an anonymous client `get` a
public `docs/{docId}` would hand the world `members`, `viewers`, `ownerEmail`
and `stats`. A non-private document is mirrored to **`public/{docId}`** carrying
only `docId`, `title`, `slug`, `currentVersion`, `entry`, `format`,
`visibility`, `publicEdit`, `trusted`, `publishedAt` — written by the same paths that
recompute `members`, and **deleted the instant visibility returns to private**.

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

This is also the cost defence: every byte is proxied through a function, and
public documents are where traffic spikes. A rate limiter is **deliberately not
built**; Firebase App Check is the named hook if abuse materializes.

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
  "editor" | "mcp" | "duplicate"`, `parentVersion`, and the full `publishedBy`
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

`viewers[]` / `editors[]` gain entries of the form `team:{teamId}` alongside
plain emails, and the server **expands them at write time** into the flat
`members[]` / `editorMembers[]` sets it already computes:

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
that is the right trade, and it is stated in `docs/architecture.md` so nobody is
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

### MCP — six tools

`POST /mcp`, streamable HTTP, one Cloud Function, one rewrite.

| Tool | Purpose |
|---|---|
| `list_documents` | the caller's documents, with visibility and current version |
| `get_document` | metadata + current **source** (Markdown where available) |
| `publish_document` | create a document from content |
| `update_document` | commit a new version of an existing document |
| `get_comments` | **unresolved feedback, each with its anchored quote** |
| `reply_to_comment` | respond in a thread |

`get_comments` is what earns the whole surface. Because every annotation stores
`exact`/`prefix`/`suffix`, a comment comes back **with the passage it is about**,
so an agent knows what to change without fetching and diffing the document. That
closes the loop this product exists for.

Efficiency rules, because agent context is the scarce resource: `get_comments`
returns quote, comment, author and thread id and nothing else; `list_documents`
is metadata-only; `get_document` returns **source, never rendered HTML with its
embedded stylesheet**; responses are capped and cursor-paginated.

There is no anonymous MCP access. Publishing always attributes to a real account
and stamps `publishedVia: "mcp"`.

### CLI — `bikeshed`

Deliberately distinct from `scripts/*.mjs`:

| | `scripts/*.mjs` | `bikeshed` CLI |
|---|---|---|
| Who | whoever owns the deployment | any signed-up user |
| Credential | Admin SDK / gcloud, `--account` required | personal access token |
| Talks to | Firestore and Storage directly | the deployment over HTTPS |
| Purpose | provision, withdraw, tear down | publish and revise documents |

Commands: `login`, `publish <file>`, `update <slug> <file>`, `list`,
`comments <slug>`, `open <slug>`, plus `publish --watch`. Every command takes
`--json`.

### Universal agent instructions

`docs/agent-guide.md` is the source of truth. A build step copies it to
`app/public/llms.txt` and **CI asserts the two match**, so hosted instructions
can never drift from the repo's. `/.well-known/mcp.json` advertises the endpoint.

### Not built

OAuth 2.1 flows · service accounts · webhooks · a REST API distinct from these
endpoints · SDKs in other languages · rate limiting beyond CDN caching.

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

Residual risk, accepted: a bundle could blank its own entire document, yielding
an empty PDF — self-defeating, no content leaked. A cryptographically guaranteed
stamp would require server-side rendering; client-side print is the chosen
trade-off.

Safety: values are written with `textContent`, never `innerHTML`; the footer is
capped at 300 characters and the label at 40, and control characters are
stripped. When marking is disabled the stamp nodes are simply absent; every
other property (sandbox, `<script>` scrub, `on*` scrub, `javascript:` scrub)
stays unconditional.
