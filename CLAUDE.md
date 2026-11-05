# Working in this repository

For an agent changing this **source**. `AGENTS.md` is generated from this file, so either name reaches the same instructions — edit this one.

If you are an agent *using* a deployment through its API rather than changing its code, you want `docs/agents/agent-guide.md` instead, which a deployment serves at `/llms.txt`. Different job, different document.

Read `docs/architecture/overview.md` first — especially **"What this is not"**. Most bad changes here are additions nobody argued for. `docs/architecture/spec.md` is normative; cite it as `(SPEC §N)`.

```bash
npm run install:all && npm run build:policy   # no Firebase account needed
```

## Before you say it works

```bash
npm run verify               # policy, agents, build, tests, secrets, headers, content, licences
npm run test:rules:emulated  # rules — needs emulators, and starts them
```

Run both. Show the output. **Never describe a check as passing that you did not run**, and never report a fix as verified when you only reasoned about it.

`npm run test:e2e` is the opt-in end-to-end suite (`e2e/README.md`), outside `verify` and CI. If a change touches the editor, live editing, sharing, publishing, MCP, the CLI, OAuth or email, also run `-- --self-test`, then `-- run --suite smoke`, then that area's specs on a kept stack. It starts its own stack on spare ports, never on yours. A `defect:` case's TODO is not a pass. A change to documentation alone does not run it, even when the document describes one of those areas: if a selftest reads what you changed, run that one file with `node --test`.

## The emulator cannot tell you everything

Four classes of defect are **invisible locally** and have all shipped:

| Invisible locally | Because |
|---|---|
| Response cache headers | Hosting adds `max-age=600` to any function response that sets none; the emulator adds nothing. A cacheable 404 got served to members |
| `admin.firestore.FieldValue` | The Functions emulator proxies firebase-admin and drops static namespace properties, so it is `undefined` there and fine in production. Import from `firebase-admin/firestore` |
| Anything IAM | A fresh project grants its runtime identity almost nothing. Symptoms are remote from causes; `docs/operations/overview.md` has the table |
| `defineSecret` | Mandatory at deploy time, whatever the runtime does with it |

So: **if you touch a response header, an admin-SDK call, the sign-in path, or anything about deployment, a green local suite is not evidence.** Assert it structurally (see `noStore` in `functions/src/lib/http.ts` and the test pinning it) or verify against a real deployment.

## How tests pass while the bug is live

This has happened repeatedly here, so assume it until disproven.

- **Write a negative control for every new assertion.** Reintroduce the bug, watch the test fail, restore. A test you have not seen fail is a test you have not written. Several tests in this repo passed with their bug put back.
- **Fresh module registry per case hides sequences.** The consent test checked each state in isolation and so never exercised *unset → granted in one page*, which is the only sequence a real visitor performs — and the only one broken.
- **Vitest loads `app/.env.local`**, so ambient config leaks into tests. Stub the module instead of asserting against whatever env happens to exist.

## Five things most likely to bite

**1. Four files are generated. Do not edit them.** `firestore.rules`, `database.rules.json`, `functions/src/generated/policy.ts`, `app/src/generated/policy.ts` come from `config/access-policy.json` via `config/policy.mjs`. Edit the source or `config/templates/`, then `npm run build:policy`. `check:policy` byte-compares and runs as `pretest`.

**2. Four module pairs are duplicated on purpose.** `hash`, `membership`, `policy`, `transaction-receipts` exist in ESM (`scripts/`) and CommonJS (`functions/`) because the runtimes differ. Parity tests hold them together, and the hash pair is pinned by a **shared golden vector** — never by comparing the two implementations, which lets them drift together. Change one, change both.

**3. Decoration must never reach serialized bytes.** Highlights, suggestion marks, placeholder marks and the peer overlay all go into the document being edited. Four legs keep them out: the `FrameMode` tagged union, effect-cleanup ordering, an unconditional strip plus a dev-only assertion, and `serializeCleanHtml`. **Every hook that puts something in the document must be declared before `useInlineEditor`** — and must be in `viewer/invariant.test.tsx`'s harness. Presence was in neither, and reached edit mode in a real browser. The one hook declared after it, `useSuggestionReview`, edits rather than decorates, and marks its target with the highlight API — no node, no attribute — which the harness checks by counting mutations.

**4. `[data-bshd]` is stripped by VALUE, not presence.** Someone's document may legitimately contain `data-bshd="whatever"`. Only values listed in `brand/dom.ts` are removed. Weakening that to an attribute check is silent data loss in a document you do not own.

**5. Use tokens that exist.** The spacing scale is `--s-1`…`--s-8` — there is no `--space-N`. An unresolved `var()` invalidates the whole declaration, so an invented name silently becomes no padding at all. The rule, enforced by `brand/tokens.test.ts`:

```
var(--x)            must resolve to a token a stylesheet defines
var(--x, fallback)  may be injected at runtime from JS
```

## Version history is a read-only archive

Use `docs/agents/agent-guide.md` for the CLI/MCP history workflow (SPEC §19). Historical content and existing feedback remain readable under current access rules; only the current version accepts version-scoped writes (SPEC §4, §22). Enforce this in Firestore rules and in the transaction that writes through the Admin SDK, including idempotent actions. A stale base must never silently become the latest version. Upload attempts own unique, create-only object prefixes; readers follow the committed pointer, and cleanup touches only the observed superseded draft. Test head changes during saves, feedback writes and publishing.

## Every file needs a two-line header

```
// SPDX-License-Identifier: Apache-2.0
// <what this file owns> (SPEC §N)
```

`check:headers` enforces both lines. The two hash implementations carry the full Apache notice instead, because they are a wire format someone may copy out alone.

## Prose is not hard-wrapped

In Markdown, a paragraph or a list item is one line, and only a blank line separates paragraphs. The same goes for commit bodies, release notes and pull request text. Code blocks and tables keep their own lines. `docs/acf/` follows its upstream, and `functions/test/fixtures/markdown/` and `content/markdown-reference/` stay wrapped on purpose, because they exercise the join.

## Commits

Conventional, lower case, imperative, no trailing period.

**Stage explicit paths.** Not `git add -A` or `.` — that is how a credential enters history. **No attribution trailers**; the secrets guard fails the build on them, and an author field cannot be fixed without a rewrite.

Write the body for someone reading `git log` in two years: what was wrong and why this fixes it, not what the diff already shows.

## Every change ships a version

A fix, a feature, or **any** change that touches more than documentation is not finished until it is released. Release it in a `chore: release X.Y.Z` commit after the change's own commits. Changes only to `docs/` or other `*.md` files are the one exception. The number is what an MCP client is told it is talking to, so a change without one is running under someone else's version.

- **Which number.** Semver, as `CHANGELOG.md` states it. A fix, a refactor or a test is a patch. A feature is a minor. Anything the changelog lists as breaking is a minor while we are below 1.0.
- **What moves, together.** `version` in `package.json`, `app/package.json` and `functions/package.json`, plus their three lockfiles. Running `npm version X.Y.Z --no-git-tag-version` in each directory changes both. Also move `SERVER_INFO` in `functions/src/mcp/server.ts`.
- **The changelog.** The change's own commit adds its entry under `## Unreleased`, and the release commit renames that heading to `## X.Y.Z — YYYY-MM-DD`.
- **The CLI versions on its own**, and only when `cli/` changed: bump `cli/package.json` and commit `chore(cli): release bikeshed-now X.Y.Z`.
- **Tag the release commit** `vX.Y.Z` (`cli-vX.Y.Z` for the CLI). **Pushing `main` is deploying production**: `.github/workflows/deploy.yml` ships every push that passes CI, unless nothing production serves has changed since the last deploy (`tools/deploy-needed.mjs`). A push of documents can still ship code an earlier run left behind, so ask for any push as you would for a deploy. `npm publish` stays a separate decision, also asked for.

## Deployment facts stay out of the tree

No tracked file may name the real project, account, bucket, SDK config or measurement id. They live in gitignored files and Secret Manager (`docs/operations/overview.md`). Everything committed uses `demo-bikeshed`, which Firebase refuses to point at a real backend.

`scripts/check-secrets.sh` matches **by shape** — `*.web.app`, `gs://`, `AIza…`, app ids, measurement ids, non-`demo-` project blocks — so a rename cannot quietly reintroduce a leak. It matches on form rather than spelling for a reason: a list of forbidden words has to be committed to be useful, and committing it publishes the very strings it exists to suppress. The slug `bikeshed-now` is a legitimate package name; the binding is what must never be committed.

**It will fire on your own comments.** Describing a forbidden shape means *describing* it, not spelling it. That has caught this project twice.

## Dependencies have a budget

8 runtime in `app/` (and it is at 8), 10 in `functions/` (currently 9) plus 4 lazily imported inside the email path only. Beyond it needs a written justification in the pull request, not a line in `package.json`. `check:licenses` separately hard-fails anything outside the permissive allowlist.

## Where things are

| | |
|---|---|
| `config/policy.mjs` | the identity gate, rendered four ways |
| `functions/src/index.ts` | every endpoint; mirrored by `scripts/lib/endpoints.mjs` |
| `app/src/viewer/` | the hooks `DocViewer` decomposes into, plus `frameMode.ts` |
| `app/src/viewer/deck.ts` | what counts as a slide, defined once for the rail, the overview and the keys |
| `app/src/viewer/preview.ts` | the separate document a thumbnail renders, and the only thing allowed to force anything on a slide |
| `app/src/brand/dom.ts` | every `bshd-` identifier, defined once |
| `scripts/` vs `cli/` | operator tools with Admin credentials vs the end-user CLI over HTTPS |
| `docs/architecture/adr/` | twenty-seven decisions, each with its reversal condition |
| `docs/development/verification.md` | the emulator walkthrough, and what it proves |

## Looks like a bug, is not

- **`execCommand` is deprecated.** It was when it was chosen, and it is the only API that edits a document in place without first deciding what a document may contain ([ADR 0007](docs/architecture/adr/0007-execcommand-over-schema-editor.md)).
- **The MCP server is hand-written.** The SDK needs `zod`; the server half of streamable HTTP is ~200 lines ([ADR 0009](docs/architecture/adr/0009-hand-written-mcp.md)).
- **Firestore is 8088, Hosting 5050, emulator UI 4040.** Not the defaults: 8080, 5000 and 4000 are all commonly taken (AirPlay, Docker).
- **`zoom` is locked in the export stamp but untestable in jsdom.** It is a real hiding vector in Blink and WebKit, named in `UNREPRESENTABLE_IN_JSDOM`, with a test asserting that list is exactly right.
- **Slide detection is a list of rules, not a selector.** Measured against real decks, `section[id]` and `section.slide` each match under half of them and their coverage does not overlap. Reading order is DOM order: some decks number sections out of order, and some use bare numerals whose `#id` form is not a valid selector at all.
- **A thumbnail keeps the slide's ancestors, and `paged` is latched.** Rendering a slide alone throws away the container rules its own stylesheet is written against, so it renders unstyled in a box measured from the styled frame — all whitespace. And the navigator is gated on `paged`, which the rail's own width can change: re-deciding it on resize makes the viewer oscillate.
- **A suggestion's replacement is not in the document's text.** It is an attribute on the last highlight wrapper, shown with `content: attr(…)`. A text node would shift `textContent`, which every anchor is measured against, and would be published by the strip that unwraps highlights.
- **The landing video's `<track>` arrives one render late.** An iPhone refuses a video whose track was attached before its `src`, with `error code=4` and correct bytes and CORS, and React attaches an element's children before its attributes. The HTML parser does the opposite, so a static copy plays, and the iOS Simulator plays both, so neither says anything about a device. `LandingVideo.test.tsx` pins the order.
- **A public document's shell holds its words, hidden.** They are for a crawler that runs no JavaScript ([ADR 0028](docs/architecture/adr/0028-what-a-crawler-can-read.md)). The stylesheet hides them and the app replaces them on mount; an attribute or inline style would read to a parser as a page choosing not to say them.
- **`robots.txt` names no bot.** A bot obeys only the group that names it, so naming one would lift every other rule for it.
- **The email secret holds a single space.** `defineSecret` demands a version; Secret Manager refuses an empty payload. Whitespace is how a deployment says "email off", and `apiKey()` trims.

## Agentic Continuous Flow (ACF)

**ACF is software development for a world where intelligence exists in silicon as well as carbon.** Humans shift from writing code to governing intelligent agent swarms. Knowledge (ontologies, policies, constraints) becomes the product; code is ephemeral output regenerated on demand.

## Conventions

- **Organization**: `docs/acf/organization.md` (naming, directory structure, documentation standards)
- **Git**: `docs/acf/git/commit-conventions.md` (conventional commits, atomic commits)
- **Audit**: `/audit-acf-conventions` checks compliance and `--fix` repairs it. It is a slash command from the `acf-librarian` Claude Code plugin in [ACF Tools](https://github.com/fib7/acf-tools), which is not vendored here — without that plugin installed, the command does not exist. The `docs/acf/` files are copies of ACF Tools files, Apache-2.0 like the rest (`NOTICE`).
