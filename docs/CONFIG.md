# Configuration reference

Every setting, where it lives, and what changes when you change it. Nothing here
is required to run the emulator stack; `app/.env.example` already points at it.

**Nothing in this file names a real deployment.** See `docs/operations.md` for
which values go in which gitignored file, and why the binding is kept out of git
even though a Firebase web config is public by design.

---

## The identity policy

### `config/access-policy.json`

The **single source of truth** for who this deployment admits. It renders four
committed artifacts; never hand-edit those.

```json
{ "allowedEmailDomains": [] }
```

| Value | Meaning |
|---|---|
| `[]` (default) | **Open.** Any account with a verified email may sign in |
| `["example.com"]` | Only `…@example.com`. Matching is anchored, so `a@evil.example.com` is rejected |
| `[".example.com"]` | A leading dot is an explicit **subdomain opt-in** |

Signing in is not access. The per-document ACL is the only thing that grants a
document, so an open policy means "anyone may have an account", never "anyone
may read anything".

```bash
npm run build:policy    # rewrite the four artifacts
npm run check:policy    # re-render in memory and byte-compare — pretest and prebuild
```

Renders into `firestore.rules`, `database.rules.json`,
`functions/src/generated/policy.ts` and `app/src/generated/policy.ts`, each with
a `GENERATED — DO NOT EDIT` banner and the sha256 of its source
([ADR 0005](adr/0005-generated-rules.md)).

**Changing it requires deploying both rules and functions.** They are separate
enforcement layers; updating one is how a gate half-closes.

The client artifact is deliberately **list-free** — Vite would inline the
allowlist into the public bundle. The client gets the shape rules and one
boolean, and learns policy outcomes from `POST /session`.

---

## Deployment binding

### `.firebaserc` — gitignored

```json
{ "projects": { "default": "your-firebase-project-id" } }
```

Project id resolution, in order: `--project` → `GCLOUD_PROJECT` → `.firebaserc`.
No default, and an unresolvable id is a clean error, not a stack trace.

### `config/deploy.json` — gitignored

```json
{ "bucket": "your-content-bucket", "domain": "example.com" }
```

| Key | Used for |
|---|---|
| `bucket` | the private content bucket, for the operator scripts |
| `domain` | the public domain, for printed links |

---

## The app — `app/.env.local`, gitignored

Vite inlines every `VITE_*` value into the built bundle. Nothing here can be
secret; what is kept out of git is the binding.

| Variable | Required | Effect |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | yes | Web SDK |
| `VITE_FIREBASE_AUTH_DOMAIN` | yes | Web SDK |
| `VITE_FIREBASE_PROJECT_ID` | yes | Web SDK |
| `VITE_FIREBASE_STORAGE_BUCKET` | yes | Web SDK |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | yes | Web SDK |
| `VITE_FIREBASE_APP_ID` | yes | Web SDK |
| `VITE_FIREBASE_DATABASE_URL` | no | **Peer presence.** Unset degrades to a clean no-op |
| `VITE_FIREBASE_MEASUREMENT_ID` | no | **Analytics.** Unset means no gtag request and no cookie |
| `VITE_USE_EMULATORS` | no | `1`/`true`/`yes` points the SDK at the local suite |
| `VITE_EXPORT_MARK_ENABLED` | no | Seeds each new account's export-marking default |
| `VITE_EXPORT_MARK_LABEL` | no | Corner label, ≤40 characters |
| `VITE_EXPORT_MARK_FOOTER` | no | Footer line, ≤300 characters |

### Analytics is opt-in, and quiet by default

It initializes **only** when `VITE_FIREBASE_MEASUREMENT_ID` is set, never under
emulators, and behind an `isSupported()` guard with a no-op fallback — a browser
with third-party storage blocked must not be able to take sign-in down with it.

The automatic page view is **switched off** (`send_page_view: false`) and route
changes are logged manually as route **patterns**: `/d/:docId/:versionId`, never
`/d/q3-acquisition-memo/v3`. Document slugs are frequently the confidential
part of a URL. No document id, title, slug, folder name or email is ever sent,
and a test asserts it.

Per-account opt-out lives on the user record and drives
`setAnalyticsCollectionEnabled(false)`. There is no cookie banner because there
is no anonymous browsing to consent on behalf of.

### Export marking

Three layers, each seeding the next. **The document's own value is what is
authoritative at export time**, resolved at publish time rather than export
time — otherwise a reader exporting would apply *their* default, when the
marking is the owner's policy.

```
VITE_EXPORT_MARK_*  →  users/{uid}.defaultMarking  →  docs/{docId}.marking
   deployment              account default              authoritative
```

`footer` supports `{year}`, `{date}`, `{title}`, `{version}` and `{user}`,
resolved at export. Values are written with `textContent`, never `innerHTML`.

When marking is disabled the stamp nodes are simply absent; every other export
protection — the sandboxed print iframe, the `<script>` scrub, the `on*` scrub,
the `javascript:` scrub — stays unconditional.

---

## The functions — `functions/.env`, gitignored

| Variable | Required | Effect |
|---|---|---|
| `BIKESHED_BUCKET` | recommended | The private content bucket |
| `BIKESHED_PUBLIC_ORIGIN` | recommended | Origin for links in email and `sitemap.xml` |
| `BIKESHED_MAIL_FROM` | recommended | The address email is sent FROM, e.g. `Bikeshed <noreply@example.com>` |
| `BIKESHED_SIGN_IN_HINT` | no | One sentence returned by `GET /config` to a rejected visitor |

### The bucket is never guessed

Resolution: `BIKESHED_BUCKET` → `config/deploy.json` → a derived
`${projectId}-content` that `setup.mjs` actually creates with uniform access and
public access prevention.

**The Firebase default bucket is deliberately never assumed.** Its name changed:
`${projectId}.appspot.com` is wrong for projects created after 2024, and
`.firebasestorage.app` is wrong for those created before. Either guess means
uploads land where nothing reads, or deletes remove nothing while reporting
success — the worst class of silent failure an operator tool can have. Using the
default bucket is fully supported by naming it explicitly, which is the point.

`BIKESHED_SIGN_IN_HINT` is one sentence, never the allowlist. The allowlist is
never sent to a client.

### The sending domain is not the serving domain

`BIKESHED_MAIL_FROM` is separate from `BIKESHED_PUBLIC_ORIGIN` on purpose. The
domain you **serve** from and the one you may **send** from are usually not the
same, and often cannot be: a default Firebase deployment serves on `*.web.app`,
which nobody can verify with an email provider.

Unset, it falls back to `noreply@<public origin host>` — correct only when you
serve from the domain you have verified. Set it whenever those differ, or every
send is rejected by the provider for an unverified sender.

### `RESEND_API_KEY` — a Firebase secret, not an env var

```bash
firebase functions:secrets:set RESEND_API_KEY --project <id>
```

Declared with `defineSecret`, so it never lands on disk.

**The secret must EXIST before functions deploy, even when email is off.**
`defineSecret` binds it to every mailing function and a non-interactive deploy
refuses to proceed when it has no version — while Secret Manager refuses to
store an empty payload. So "off" is expressed as a **single space**, which the
runtime trims and reads as unconfigured. `setup.mjs` creates it that way, which
is what keeps the quickstart free of a Resend account.

**Email is optional by construction**: with a blank key every send is a logged
no-op and the app behaves identically. That is the path CI exercises, and it is why the quickstart does
not require a Resend account ([ADR 0008](adr/0008-runtime-email-rendering.md)).

Sends are wrapped in try/catch and never fail the request that triggered them.

---

## Compiled-in constants — `functions/src/config.ts`

Not environment variables. Changing one is a code change and a deploy, which is
the right friction for each of them.

| Constant | Value | Why that value |
|---|---|---|
| `REGION` | `us-central1` | **Fixed.** Hosting rewrites only reach functions in us-central1 |
| `SESSION_EXPIRES_MS` | 5 days | Session cookie lifetime |
| `SESSION_COOKIE_NAME` | `__session` | The only cookie Firebase Hosting forwards to a function |
| `MAX_BUNDLE_BYTES` | 25 MB | Upper bound on a bundle held in memory at upload or commit |
| `MAX_BEAT_MS` | 5 min | Largest active-time delta one heartbeat may contribute. The client beats every 60 s, so more is a stale tab, a clock jump, or a forged payload — clamped, not trusted |
| `MAX_SESSION_MS` | 8 h | Ceiling on one reading session, so a pinned tab cannot inflate totals |
| `VERIFY_TTL_MS` | 15 min | Verification code lifetime. Short, because it is re-issuable |
| `COMMENT_EMAIL_COOLDOWN_MS` | 30 min | Minimum gap between two comment notifications to the same person about the same document |
| `PUBLIC_CACHE_SECONDS` | 300 | Cache lifetime for non-private content — **and therefore the revocation latency** |

`PUBLIC_CACHE_SECONDS` is the one with a visible trade: it is the cost defence
for public documents and the five minutes a de-published document can still be
served. Both halves are the same number, which is why it is documented in
`docs/operations.md` under revocation rather than only here.

---

## Emulator ports — `firebase.json`

| Service | Port | |
|---|---|---|
| Auth | 9099 | |
| Firestore | **8088** | not 8080 — the most contended port on a developer machine |
| Realtime Database | 9000 | |
| Functions | 5001 | |
| Hosting | **5050** | not 5000 — AirPlay Receiver holds it on macOS |
| Storage | 9199 | |
| Emulator UI | **4040** | not 4000 — Docker Desktop and a dozen dev servers claim it |

`firebase.json` is the source; the rules tests and the Vite dev proxy read the
ports from it. `app/src/config.ts` mirrors the three the client needs, because
Vite cannot import outside the app root at runtime — a mismatch surfaces
immediately, on the first emulator run.

The emulator project id is `demo-bikeshed`. Firebase treats any `demo-` prefixed
id as local-only and **refuses to contact a real backend with it**, so the
committed examples are not merely fake — they are incapable of touching
production.
