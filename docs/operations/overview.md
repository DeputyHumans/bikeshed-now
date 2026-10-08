# Operations

Deploying a Bikeshed, running it, and taking it down. Every command here is
copy-pasteable; the ones that can run without a deployment are run by CI.

**Placeholders only.** No file in this repository names a real Firebase project,
console account, bucket or domain. `your-firebase-project-id` means yours, and
`demo-bikeshed` is the emulator-only id Firebase refuses to point at a real
backend.

---

## Before anything: the local stack

Nothing below needs a cloud account until [Deploying](#deploying).

```bash
npm run install:all
npm run build:policy
cp app/.env.example app/.env.local     # already points at the emulators
npm run emulators                      # one terminal
npm --prefix app run dev               # another → http://localhost:5173
```

The emulator suite runs on Auth 9099, Firestore 8088, RTDB 9000, Functions 5001,
Hosting 5050 and Storage 9199. Firestore and Hosting are **not** on their usual
8080 and 5000: 8080 is the most contended port on a developer machine and 5000
is taken by AirPlay Receiver on macOS. The ports live in `firebase.json`, and
the tests and the Vite dev proxy both read them from there rather than
hardcoding, so changing one changes all of them.

```bash
npm run verify              # everything CI runs, in CI's order
npm run test:rules:emulated # rules tests need the emulators; this starts them
```

---

## Deploying

### 1. Decide the five facts, and write them where git cannot see them

| Fact | File | Tracked example |
|---|---|---|
| Firebase project id | `.firebaserc` | `.firebaserc.example` |
| Content bucket, public origin (stamped into `/llms.txt`) | `config/deploy.json` | `config/deploy.example.json` |
| Web SDK config, measurement id | `app/.env.local` | `app/.env.example` |
| Bucket, origin, sign-in hint | `functions/.env` | `functions/.env.example` |
| Console account | **nowhere** — passed as `--account` | — |
| Resend API key | Firebase Secret Manager | `functions/.env.example` names it |

All four files are gitignored from the first commit, before any `firebase`
command runs — which matters, because `firebase use` writes `.firebaserc`
unprompted.

Keep one gitignored `DEPLOYMENT.local.md` holding the project id, account,
bucket and domain together, so the facts survive outside git without a scavenger
hunt through four dotfiles.

**None of this is secret in the cryptographic sense.** Vite inlines every
`VITE_*` value into the public bundle, and a Firebase web config is designed to
be public — security comes from the rules, not from hiding the project id.
What is kept out of the tree is the *binding* between this source and one
particular deployment. "Never committed" is achievable; "never public" is not.

The console account is deliberately in no file at all. Every script **requires**
`--account` for a real run and never defaults it, because a tool that picks up
whatever identity happens to be active is how the wrong project gets modified.

### 2. Dry-run the setup and read it

```bash
node scripts/setup.mjs --account you@example.com --project your-firebase-project-id --dry-run
```

It prints ten steps and executes nothing, needing no credentials. Read the
project id on the first line before you drop `--dry-run`.

### 3. Run it

```bash
node scripts/setup.mjs --account you@example.com --project your-firebase-project-id
```

Steps 1–9 are check-then-act or naturally idempotent, so re-running converges:
enable services, ensure the Firestore database, ensure the **private** bucket
(uniform access, public-access prevention), deploy rules and indexes, ensure the
email secret exists, grant the runtime service account its permissions, deploy
functions, allow unauthenticated invocation, then build and deploy hosting.

**The Realtime Database and email are genuinely optional.** Without an RTDB
instance step 4 skips its rules rather than failing, and the email secret is
created holding a single space, which the runtime reads as "off".

### 3b. What setup does that is not obvious

Two of its ten steps exist only because a **fresh** Google Cloud project is far
more locked down than an older one, and every symptom is remote from its cause:

| Missing | What you would see |
|---|---|
| `cloudbuild.builds.builder` | the build fails at `gcs-fetcher`, exit 3 |
| `datastore.user` | every request 500s with `PERMISSION_DENIED` |
| `firebaseauth.admin` | every sign-in fails with `session_failed` |
| `storage.objectAdmin` | documents publish but never serve |
| `iam.serviceAccountTokenCreator` on itself | `createSessionCookie` cannot sign |
| `allUsers` + `run.invoker` | **every** path answers 403 with an HTML body, before any of this code runs |

Step 6 grants the first five to the runtime service account — Storage scoped to
the content bucket only, never project-wide — and step 8 makes the 27 HTTP
functions publicly invokable. "Publicly invokable" is not "public": each
function authenticates its own caller. The Firestore trigger is deliberately
left private.

**If step 8 fails with `FAILED_PRECONDITION`**, the project's organization has
Domain Restricted Sharing on (`constraints/iam.allowedPolicyMemberDomains`),
which forbids `allUsers`. No public web app can run under it. Override it for
this project alone, leaving every other project in the organization restricted:

```bash
cat > /tmp/policy.yaml <<'YAML'
constraint: constraints/iam.allowedPolicyMemberDomains
listPolicy:
  allValues: ALLOW
YAML
gcloud resource-manager org-policies set-policy /tmp/policy.yaml --project <id>
```

That needs `roles/orgpolicy.policyAdmin`, which can only be granted at
organization or folder level — not on the project. Grant it, set the override,
and revoke it again if you would rather not leave it standing.

The same grant applies to a function created **after** setup. `firebase
deploy` grants `allUsers` `roles/run.invoker` itself when it creates a new
function such as `docShell`, `unlockDoc`, `saveThumbs`, `manageSuggestion`, `oauth` or `oauthConsent`; under Domain Restricted Sharing that deploy fails
at "set invoker" and the function stays private. The symptom of the missing
grant is a `403` with an HTML body, before any code runs — every document page
looks broken while being perfectly deployed. The repair, once the policy is
overridden:

```bash
gcloud run services add-iam-policy-binding docshell --region=us-central1 --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding unlockdoc --region=us-central1 --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding savethumbs --region=us-central1 --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding managesuggestion --region=us-central1 --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding oauth --region=us-central1 --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding oauthconsent --region=us-central1 --member=allUsers --role=roles/run.invoker
```

For `unlockDoc` the symptom is narrower and easier to miss: every unlisted
document reads "Not here" to anyone but its members, key or no key, while
everything else works. `curl -si https://<deployment>/unlock` answers `405`
from the function; a `403` with an HTML body is the platform refusing.
For `manageSuggestion` it is every suggested edit failing to save, and every
Accept and Reject failing, while comments work; `curl -si
https://<deployment>/suggestion` answers `405` from the function.

For `oauth` it is every app that connects by signing in failing to find the
sign-in. Claude reports "Couldn't reach the MCP server", while personal tokens
keep working. `curl -si https://<deployment>/.well-known/oauth-authorization-server`
answers JSON from the function when the grant is in place. For `oauthConsent`
it is the consent page saying it could not load the request, every time;
`curl -si -X POST https://<deployment>/oauth/consent` answers `403` JSON from
the function, and a `403` with an HTML body from the platform.

For `saveThumbs` nothing looks broken at all: documents read normally, and
their cards and slide rails simply never gain stored thumbnails, because every
capture an editor's browser uploads is refused before it arrives.
`curl -si https://<deployment>/thumb` answers `405` from the function when the
grant is in place.

### 4. Do step 10 by hand

There is no clean CLI for these, so the script prints them as a checklist rather
than pretending. Each one has a failure mode that reads as a bug:

- **Enable the Google provider.**
- **Enable GitHub, and request the `user:email` scope.** Without that scope
  Firebase receives no address at all for users who keep theirs private, and an
  email-keyed ACL cannot grant them anything ([ADR 0004](../architecture/adr/0004-email-keyed-acl.md)).
- **Add every serving host to Authorized domains**, including any custom domain.
  `signInWithPopup` rejects an unlisted origin with `auth/unauthorized-domain`,
  which presents as a sign-in button that does nothing.
- **Create a Realtime Database** if you want peer presence. Without one,
  presence degrades to a clean no-op and everything else is unchanged.
- **Set `RESEND_API_KEY`** if you want transactional email:
  `firebase functions:secrets:set RESEND_API_KEY`. It is a Firebase secret, not
  an env file, so it never touches disk. Without it every send is a logged
  no-op — the path CI exercises.
- **Set a budget alert.** This is a numbered step, not advice; see
  [Cost](#cost) below.

### 5. Verify the deployment does what the rules say

```bash
node scripts/publish.mjs --doc bikeshed-tour --account you@example.com   # publish a sample
node scripts/publish.mjs --doc bikeshed-tour --account you@example.com   # → "already published as v1"
```

The second run printing a no-op is the check that content-hash idempotency is
working end to end. Then sign in as an account that is not a member and confirm
`/content/bikeshed-tour/v1/index.html` returns **404**, not 403 — read-only byte
paths collapse "forbidden" into "absent" so a signed-in stranger cannot
enumerate the slug space.

---

## Running one

### Publishing and access

```bash
node scripts/publish.mjs --doc <id> --account you@example.com
node scripts/set-access.mjs --doc <id> --list
node scripts/set-access.mjs --doc <id> --add ana@example.com,team:design --account you@example.com
node scripts/set-access.mjs --doc <id> --remove bo@example.com --role editor --account you@example.com
```

`--dry-run` needs no credentials on either. `--list` does: it reads the document
from Firestore, which is the point of it.

Membership is recomputed by the same code the server uses, including the parent
folder's members, and all four membership fields are written together
([ADR 0006](../architecture/adr/0006-denormalized-members.md)).

### Withdrawing a version

The one guarded exception to "versions are immutable".

```bash
node scripts/delete-version.mjs --doc <id> --list
node scripts/delete-version.mjs --doc <id> --version v3 --repoint v2 --dry-run
node scripts/delete-version.mjs --doc <id> --version v3 --repoint v2 --yes --account you@example.com
```

Seven refusals guard it, each with its own override flag, so removing one guard
never removes the rest. **Unlike every other script here, `--dry-run` reads
Firestore and Storage and therefore needs credentials** — a destructive preview
that cannot show you what it would destroy is worthless. It performs no writes.

The order is load-bearing: `currentVersion` is repointed **first**, in a
transaction that aborts if anything published mid-run, because the viewer
resolves a bare `/d/{docId}` from that field. Then the Storage bytes, then the
Firestore record.

### Upgrading

```bash
npm run verify                                        # must pass before deploying
firebase deploy --only functions --project <id> --account you@example.com
npm --prefix app run build && firebase deploy --only hosting --project <id> --account you@example.com
```

Deploy **functions before hosting**. The new app may call an endpoint the old
functions do not have; the reverse is never a problem, because an endpoint
nobody calls yet is inert.

With [continuous deployment](#continuous-deployment) set up, a push to `main`
does all of this, and the rules too. These commands are for a deployment
without it, or for a migration while it is paused.

**The hosting build stamps the agent instructions.** `/llms.txt` and
`/skills/**` ship with this deployment's own address in place of
`https://<deployment>`, taken from `domain` in `config/deploy.json` — or from
`BIKESHED_PUBLIC_ORIGIN` exported in the build's shell, since `functions/.env`
is not read here. The build prints which one it used, and prints it just as
plainly when neither is set, in which case every agent that fetches
`/llms.txt` is told its address is a placeholder. The hosting `predeploy` hook
runs `node tools/stamp-deployment.mjs --check` and refuses a deploy whose
`app/dist` was never stamped, which is the case you get by deploying without
rebuilding.

**The document page needs both.** `docShell` is a new function *and* a
`firebase.json` rewrite for `/d/**`, and the rewrite ships with hosting.
Hosting alone keeps `/d/**` static, so nothing changes; functions alone deploys
a service nothing routes to, so nothing visible changes either. Deploy
functions, then hosting, and the first document page after the second deploy
is the one that carries its own head.

**Preview channels do not preview `/d/**`.** `docShell` fetches the app shell
from `BIKESHED_PUBLIC_ORIGIN` — the live site — at runtime, and the shell's
asset paths are root-relative (`/assets/index-<hash>.js`). So a document page
opened on a channel makes the browser request the live build's hashed asset
names from the channel host, which serves a different build and does not have
them: a blank page. Preview the workspace on a channel; preview the document
page on the live site.

**Unlisted documents needing their link is a migration**
([ADR 0012](../architecture/adr/0012-unlisted-needs-its-link.md)). Deploy in
this order, so a link holder never lands between an app and rules that
disagree:

```bash
firebase deploy --only functions --project <id> --account you@example.com
curl -si https://<deployment>/unlock | head -1            # 405, not an HTML 403
npm --prefix app run build && firebase deploy --only hosting --project <id> --account you@example.com
firebase deploy --only firestore:rules,database --project <id> --account you@example.com
node scripts/reconcile-visibility.mjs --dry-run --project <id> --database <rtdb-url>
node scripts/reconcile-visibility.mjs --yes --account you@example.com --project <id> --database <rtdb-url>
```

Functions first, because the new app calls `/unlock`; hosting next, because the
`/unlock` rewrite ships with it; the rules last, because they stop serving the
unlisted rows the old app read. The script then deletes those rows and the
realtime key that let any account edit an unlisted open-editing document.
**It is not optional.** The Firestore rule already refuses the stale rows, but
the realtime rules cannot see visibility, only the `*` key, so every key left
behind keeps that document's live log writable by any signed-in account until
the script removes it. It is idempotent, and a second run reports nothing. The `--database` URL is the one the console shows
for the Realtime Database; without it the script reports that step as skipped.

**The terminal client is published separately**, to npm as `bikeshed-now`, and
a deployment is not involved: [`publishing-the-cli.md`](publishing-the-cli.md).

**A Markdown renderer upgrade is a migration, not a deploy.** The rendered bytes
are part of the content hash, so bumping `markdown-it`, `turndown` or
`turndown-plugin-gfm` changes every Markdown document's hash and the next save
mints a new version. That is correct — the rendering is part of the artifact —
but it is a decision, which is why all three are pinned to exact versions and
`rendererVersion` is recorded on each version record
([ADR 0003](../architecture/adr/0003-server-side-markdown.md)).

### Continuous deployment

`.github/workflows/deploy.yml` deploys production on every push to `main`
that passes all three CI jobs. A push to `develop` runs CI and stops there,
until a staging project exists ([below](#staging-later)).

**Pushing `main` is deploying.** Nothing asks for approval in between: on
GitHub's free plan a private repository has no branch protection and no
environment approvals. CI is the only gate.

One run, in order:

| Step | Why there |
|---|---|
| Write `app/.env.local`, `functions/.env` and `config/deploy.json` from secrets, then build | The same files a hand deploy reads; `--project` stands in for `.firebaserc` |
| `tools/deploy-preflight.mjs` | Refuses a bundle built for another project or the emulators, a missing origin, an unstamped `app/dist`, and functions told a different origin. All of this happens before any credential exists |
| Functions, **by name** | First, as above. By name, so a function the release removed cannot abort a non-interactive deploy |
| Firestore rules and indexes, Storage rules, RTDB rules if an instance exists | Before hosting, so no visitor loads an app newer than its rules |
| Hosting | |
| `--only functions --force` | Deletes the functions the release removed, once hosting has dropped their rewrites |
| Smoke test | The live index references this build's entry script, and `GET /unlock` answers `405` rather than the platform's HTML `403` |

A deploy is never cancelled halfway. Pushes queue, and a burst of them
collapses to the newest. Every step is idempotent, so a run that failed
partway is fixed by re-running it: `gh run rerun <id> --failed`.

**What it does not do:**
- Data migrations, such as `reconcile-visibility.mjs` above.
- The `allUsers` invoker repair under Domain Restricted Sharing ([§3b](#3b-what-setup-does-that-is-not-obvious)).
- Setting `RESEND_API_KEY`.
- `npm publish`.

**Pausing it.** Some migrations need a different order: the unlisted-documents
one above puts the rules last. For those, set
`gh variable set DEPLOY_PAUSED --body true` and CI keeps running while the
deploy job is skipped. Deploy by hand, then run `gh variable delete
DEPLOY_PAUSED`. A push made while paused is not deployed when you unpause, so
deploy it with `gh workflow run deploy.yml --ref main`.

#### One-time setup

No key is created, so none can leak. The deployer service account trusts
GitHub's OIDC token through Workload Identity Federation, and only from **one
subject**: a workflow running on `refs/heads/main` of this repository. With
no environment secrets on the free plan, that binding is what stops a
workflow on another ref from deploying.

**Read the subject from GitHub; do not write it by hand.** A repository with
immutable subject claims has ids in its prefix,
`repo:<owner>@<owner-id>/<repo>@<repo-id>`, rather than `repo:<owner>/<repo>`.
A binding written in the other form matches nothing, and the deploy then fails
at authentication with an error that never names the subject. The pool admits
one repository by its numeric id, which a rename or a transfer cannot reuse.
Keep the braces in `${SUB}:ref`: in zsh, macOS's default shell, `$SUB:r` is
a modifier, and the binding comes out ending in `…ef:refs/heads/main`.

```bash
P=your-firebase-project-id
N=$(gcloud projects describe $P --format='value(projectNumber)')
REPO=<owner>/<repo>
REPO_ID=$(gh api repos/$REPO --jq .id)
SUB=$(gh api repos/$REPO/actions/oidc/customization/sub --jq '.sub_claim_prefix // empty')
SUB=${SUB:-repo:$REPO}
DEPLOYER=deployer@$P.iam.gserviceaccount.com

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project $P
gcloud iam workload-identity-pools create github --project $P --location global
gcloud iam workload-identity-pools providers create-oidc deploy --project $P --location global \
  --workload-identity-pool github --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping google.subject=assertion.sub,attribute.repository_id=assertion.repository_id \
  --attribute-condition "assertion.repository_id == '$REPO_ID'"
gcloud iam service-accounts create deployer --project $P --display-name "CI deployer"
gcloud iam service-accounts add-iam-policy-binding $DEPLOYER --project $P \
  --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/projects/$N/locations/global/workloadIdentityPools/github/subject/${SUB}:ref:refs/heads/main"
for role in cloudfunctions.admin run.admin firebasehosting.admin firebaserules.admin \
    datastore.indexAdmin firebasedatabase.admin firebasestorage.viewer secretmanager.viewer \
    serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $P --member serviceAccount:$DEPLOYER --role roles/${role} --condition None
done
for sa in ${N}-compute@developer.gserviceaccount.com ${P}@appspot.gserviceaccount.com; do
  gcloud iam service-accounts add-iam-policy-binding ${sa} --project $P \
    --role roles/iam.serviceAccountUser --member serviceAccount:$DEPLOYER
done
DEFAULT_BUCKET=$(gcloud storage buckets list --project $P --format='value(name)' | grep -E '(firebasestorage[.]app|appspot[.]com)$')
gcloud storage buckets add-iam-policy-binding gs://${DEFAULT_BUCKET} \
  --member serviceAccount:$DEPLOYER --role roles/storage.bucketViewer
```

| Role | Scope | For |
|---|---|---|
| `cloudfunctions.admin` | project | Creating and updating functions |
| `run.admin` | project | Granting `allUsers` invoker on a newly created function |
| `firebasehosting.admin` | project | Hosting |
| `firebaserules.admin` | project | Firestore and Storage rules |
| `datastore.indexAdmin` | project | Firestore indexes. The API checks `datastore.schemas.*`, which this role holds |
| `firebasedatabase.admin` | project | RTDB rules, and listing instances to decide whether to deploy them |
| `firebasestorage.viewer` | project | Finding the default bucket the Storage rules belong to |
| `secretmanager.viewer` | project | `defineSecret`: a deploy checks that the secret has a version |
| `serviceusage.serviceUsageConsumer` | project | Calling those APIs on the project's quota |
| `iam.serviceAccountUser` | the runtime account | Deploying functions that run as it |
| `iam.serviceAccountUser` | the App Engine default account | firebase-tools refuses every functions deploy without `actAs` on it, even though no function runs as it |
| `storage.bucketViewer` | the default bucket only | The Storage API reads the bucket as the caller. Without this it answers 404, and firebase-tools reports "Firebase Storage has not been set up" |

The last three were each found by a failed first deploy, and only the first of
those failures named the permission it lacked. IAM is invisible locally. A
missing role appears as a failing step, so grant the role, add it to this
table, and re-run with `gh run rerun <id> --failed`.

The pipeline deploys Storage rules unconditionally, so a project must have
Firebase Storage set up: a default bucket must exist. The rules deny
everything, and the app never reads that bucket; document bytes live in the
content bucket and go through `contentProxy`.

Then the six repository secrets. They are secrets rather than variables so that
the build log masks them, and these logs become public if the repository does.
`app/.env.local` must be the production one: the preflight refuses an
emulator config.

```bash
gh secret set PRODUCTION_FIREBASE_PROJECT --body "$P"
gh secret set PRODUCTION_WIF_PROVIDER --body "projects/$N/locations/global/workloadIdentityPools/github/providers/deploy"
gh secret set PRODUCTION_DEPLOY_SERVICE_ACCOUNT --body "$DEPLOYER"
gh secret set PRODUCTION_APP_ENV < app/.env.local
gh secret set PRODUCTION_FUNCTIONS_ENV < functions/.env
gh secret set PRODUCTION_DEPLOY_JSON < config/deploy.json
```

When one of those files changes, set its secret again. The pipeline reads only
the secret, never your disk.

#### Staging, later

1. A second project brought up with `scripts/setup.mjs`.
2. The setup above run against it, with `refs/heads/develop` in the binding.
3. `STAGING_*` secrets.
4. A second job in `deploy.yml` that runs on `develop` and reads them.

---

## Cost

**Every byte of every document is proxied through a Cloud Function.** That is
the price of a private bucket plus an ACL, and it is the line item most likely
to surprise you.

- **Prefer single-file documents.** A fifty-asset deck is fifty function
  invocations per reader; the same deck inlined is one.
  `docs/development/authoring-bundles.md` says so at the top.
- **Public content, and unlisted content fetched with its key, is cached**
  `public, max-age=300` on the immutable version path, because public documents
  are where traffic spikes. Gated content, and a link holder's read on the
  strength of their account's grant rather than a key in the URL, stays
  `private, no-store`.
- **Set the budget alert.** As of early 2026 a small team's usage sits inside
  the Firebase free tier; a public document that gets attention does not.

There is deliberately **no rate limiter**. CDN caching is the cost defence, and
Firebase App Check is the named hook if abuse ever appears.

---

## Revoking access, and the five minutes it takes

Making a document private again is immediate in Firestore — the `public/{docId}`
projection is deleted in the same write — but **content already cached at the
CDN can still be served for up to five minutes**.

That latency is the trade for caching public content at all, and it is stated
here rather than discovered. If you need it gone now:

```bash
node scripts/set-access.mjs --doc <id> --list      # confirm who actually has it
firebase hosting:channel:delete <channel> --project <id>   # only if it is on a preview channel
```

For the primary channel there is no purge API. The reliable move is to withdraw
the version with `delete-version.mjs`, which removes the bytes the cached URL
points at, and accept that the cached copy expires on its own.

**The document page is in the same window.** A public or unlisted document's
`/d/**` page carries its title and an excerpt in its head, cached
`public, max-age` for the same five minutes as the content. Withdrawing a
version does not purge it, and neither does making the document private: the
cached shell can still say what the document was called until it expires on
its own.

The same window applies after a **hosting deploy**. The cached page names the
previous release's hashed assets. Firebase's documentation says a deploy clears
cached content across the CDN; if function responses turn out not to be
included, a CDN-cached shell can go on naming asset files the new release no
longer serves for up to 300 s. A browser that already holds the page keeps it
for at most 300 s either way, and a reload after that fetches a fresh one.

If the leak was an ACL mistake rather than a visibility one, no cache is
involved: gated content was never cacheable, so removing the grant is immediate.

**To withdraw an unlisted link, rotate it.** Make the document private, then
unlisted again: the new link is the only one that works, and every account that
opened the old one loses the link grant it held, at once. There is no way to
withdraw one account's grant alone. Content cached at the old key's URL is in
the same five-minute window as everything else.

---

## Taking it down

```bash
node scripts/teardown.mjs --yes --account you@example.com --project <id> --dry-run
node scripts/teardown.mjs --yes --account you@example.com --project <id> --functions
```

Deletes `docs/**`, `folders/**`, `teams/**`, `tokens/**`, `public/**` and
`users/**`, empties the bucket's `docs/` prefix, and clears both RTDB paths;
optionally the deployed functions. **Never deletes the project.**

The function list comes from `scripts/lib/endpoints.mjs`, the same table
`firebase.json` and the dev proxy derive from, and a wiring test asserts all
three agree — so a new endpoint cannot be added without teardown learning about
it. The design this replaces deleted two functions by name, because it was
written when there were two, and reported success.

---

## When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| Sign-in button does nothing | serving host not in Authorized domains | add it; the error is `auth/unauthorized-domain` in the console |
| GitHub sign-in yields no email | `user:email` scope not requested | add the scope in the provider config |
| "email not permitted by policy" | `config/access-policy.json` has an allowlist | edit it, `npm run build:policy`, redeploy rules **and** functions |
| Rules change had no effect | generated artifacts not rebuilt | `npm run check:policy` fails loudly; it is `pretest` and the first build step |
| Peer cursors missing | no Realtime Database | create one, or accept the no-op |
| No email arriving | no `RESEND_API_KEY` | set the secret, or accept the logged no-op |
| A reader sees 404 on a document they were granted | membership not recomputed | `set-access.mjs --doc <id> --list` shows the effective members |
| Every unlisted document reads "Not here", even with its link | `unlockDoc` not invokable | `curl -si https://<deployment>/unlock` must answer 405; the invoker repair is under §3b |
| One unlisted link stopped working | the owner rotated it (private, then unlisted) | the new link is in the Share dialog; the old one is meant to be dead |
| `npm run emulators` fails to bind | another process on 8088/5050 | change the port in `firebase.json`; everything reads it from there |

**Logs.** `firebase functions:log --project <id> --account you@example.com`.
Presence, email and stats failures are logged and swallowed by design — they
never fail the request that triggered them. Access control never is.
