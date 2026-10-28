# Bikeshed

**Publish a document. Collect comments anchored to the exact passage they are
about. Revise, and publish again.**

People publish self-contained HTML bundles or Markdown, share them with named
reviewers, teams, or the public, and collect threaded comments attached to
highlighted text. Documents are immutable versions. Agents publish and read
feedback through the same interface people do, and are visibly marked as agents.

Self-hosted on Firebase. Apache-2.0.

Needs Node 24 (`.nvmrc`), the Firebase CLI (`npm i -g firebase-tools`) and a
JRE — the emulators are a Java process, not a Node one.

```bash
npm run install:all
npm run build:policy
cp app/.env.example app/.env.local   # already points at the emulators
npm run emulators                    # one terminal
npm --prefix app run dev             # another → http://localhost:5173
```

That costs nothing and needs no Firebase account: `demo-` prefixed project ids
are emulator-only, and Firebase refuses to point one at a real backend.

---

## What makes it different

**Comments are attached to text, not to a document.** A comment that says "this
overstates the case" is only useful while you both remember which paragraph.
Anchored to the passage, it is still useful in a month, in a different version,
and to somebody who was not in the conversation.

**It edits the document you wrote.** Not a normalized model of it. A deck with
inline SVG, a folded tree and a scroll observer survives a round trip through
the editor, because the editor works on the authored markup rather than
importing it into a schema.

**Agents are first-class, and visibly agents.** Paste the deployment's `/mcp`
address into Claude, ChatGPT, Cursor or VS Code and sign in; or mint a personal
access token for a script. Thirty-two MCP tools, a terminal client that signs in
through the browser, and four packaged skills a deployment serves to whatever
agent asks for them. Everything an agent does is stamped with the
channel it came through — derived from the credential, not claimed — so a
reviewer can always tell which feedback came from a person. Agent reads are
counted separately so they do not distort anybody's statistics.

**Publishing the same thing twice is a no-op.** The bundle is hashed; identical
bytes mint no version. Safe in a loop, in CI, and in front of an agent that
cannot remember what it already did.

---

## How it fits together

```
        browser / CLI / agent
                 │
         Cloud Functions ──── Firestore          metadata, ACL, comments
                 │                               Realtime Database   presence
                 └────────── Storage             document bytes, private
```

The bucket is private and has public access prevented. **One function is the
only path bytes take to a browser**: it authenticates the caller, checks an ACL,
and streams. The browser renders them in a **same-origin iframe**, which is what
makes highlight-anchored commenting possible without injecting anything into
your document — and is why an untrusted document's scripts are blocked until
somebody vouches for them.

`docs/architecture/overview.md` explains the five decisions everything else follows from,
and spends most of its length on **what this is not**.

---

## Documentation

| | |
|---|---|
| [`docs/architecture/spec.md`](docs/architecture/spec.md) | Normative. Supersedes every other document, including this one |
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | Why it is shaped this way, and what it deliberately is not |
| [`docs/architecture/threat-model.md`](docs/architecture/threat-model.md) | What it protects, from whom, and where it stops |
| [`docs/operations/overview.md`](docs/operations/overview.md) | Deploying and running one |
| [`docs/development/authoring-bundles.md`](docs/development/authoring-bundles.md) | Writing a document that works well here |
| [`docs/operations/config.md`](docs/operations/config.md) | Every setting, and what it changes |
| [`docs/development/verification.md`](docs/development/verification.md) | The emulator walkthrough: what to observe, and what it proves |
| [`docs/architecture/adr/`](docs/architecture/adr/) | Nineteen decisions, ~30 lines each, so nobody re-argues them in a pull request |
| [`docs/agents/agent-guide.md`](docs/agents/agent-guide.md) | Using a deployment from an agent. Served as `/llms.txt` |
| [`CLAUDE.md`](CLAUDE.md) | Changing this source. Mirrored to `AGENTS.md` |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | The verification table and the eight house rules |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | How people here are expected to treat each other |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed, and what counts as a breaking change |

---

## Two command-line tools, and they are not the same

Conflating them is how somebody runs a teardown against production, so they are
named differently and say so in their own help.

| | `scripts/*.mjs` | `bikeshed` |
|---|---|---|
| Who | whoever owns the deployment | any signed-up user |
| Credential | Admin SDK, `--account` required on every real run | a personal access token, from `bikeshed login` in the browser |
| Talks to | Firestore and Storage directly | the deployment over HTTPS |
| Purpose | provision, publish, withdraw, tear down | publish and revise documents |

```bash
# operator
node scripts/setup.mjs --account you@example.com --dry-run
node scripts/publish.mjs --doc bikeshed-tour --dry-run

# user or agent
bikeshed login
bikeshed publish proposal.md --title "Storage migration"
bikeshed comments storage-migration
```

`setup`, `teardown`, `publish` and `set-access` all have a `--dry-run` that needs
**no credentials at all**, because firebase-admin is initialized lazily. That is
what makes "run the dry run first" advice anybody can actually follow.

`delete-version` is the exception, and deliberately so: its dry run reads
Firestore and Storage, because a destructive preview that cannot show you what
it would destroy is worthless. It still performs no writes.

---

## What it costs

**Every byte of every document is proxied through a Cloud Function.** That is
the price of a private bucket plus an ACL, and it is the thing most likely to
surprise you on a bill.

Two consequences worth knowing before you deploy:

- **Prefer single-file documents.** A fifty-asset deck is fifty function
  invocations per reader; the same deck inlined is one.
- **Public documents are cached** at the CDN for five minutes, because they are
  where traffic spikes. The trade is five minutes of revocation latency, and it
  is documented rather than discovered.

`docs/operations/overview.md` makes setting a budget alert a numbered setup step. As of
early 2026, a small team's usage sits inside the Firebase free tier; a public
document that gets attention does not.

---

## Deliberately not built

Each of these is a decision with a reason in `docs/architecture/overview.md`, not a gap:

no operational transform · no plugin system · no theming engine · no i18n · no
multi-tenancy · no SSO or SCIM · no search index · no mobile app · no admin
console · no rate limiter · no document deletion · no scopes on the agent
surface · no service accounts · no unique-visitor tracking

If you need directory sync, cross-document search or per-character blame, you
need a different product. This one is for small teams who want a document read
carefully.

---

## Not to be confused with

**`speced/bikeshed`**, the W3C and WHATWG specification preprocessor. Same word,
adjacent field, entirely different tool: that one generates specification
documents from source, this one collects comments on documents you already have.
This project is `bikeshed.now` throughout, which is why the domain form is used
in the title, the wordmark and the package names.

---

## Status

Each release is tagged `vX.Y.Z` (the CLI `cli-vX.Y.Z`) and listed in
[`CHANGELOG.md`](CHANGELOG.md). Working, tested and deployable. The rough edges
are honest ones:

- A membership change fans out one write per affected document. Bounded and
  batched, fine for a small team, and stated in `docs/architecture/overview.md` so nobody
  is surprised at ten thousand documents.
- Presence needs a Realtime Database. Without one it degrades to a clean no-op —
  no peer cursors, everything else unchanged.
- Email needs a Resend key. Without one every send is a logged no-op, which is
  the path CI exercises.

## Security

See [`SECURITY.md`](SECURITY.md). Please do not open a public issue for anything
that lets somebody read a document they should not.

## Licence

[Apache-2.0](LICENSE) — with two carve-outs, both recorded in [`NOTICE`](NOTICE),
which is worth reading before you fork, mirror or redistribute this repository:

- `app/public/fonts/*.woff2` is a renamed subset of an upstream typeface under
  the SIL Open Font License 1.1. It covers the font files and nothing else.
- `docs/acf/**` and `.claude/scripts/` are third-party material under a
  proprietary licence that forbids redistribution. **They are not licensed to
  you under Apache-2.0**, and nothing in `LICENSE` grants any right in them.
  Removing them is safe: no build step and no runtime reads them.

Dependency licences, and the CI gate that hard-fails anything outside the
permissive allowlist, are in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
