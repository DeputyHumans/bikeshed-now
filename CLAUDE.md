# Working in this repository

Notes for an agent — human or otherwise — making changes here. `AGENTS.md` is
different: it is for an agent *using* a deployment through the API. This file is
about editing the source.

Read `docs/architecture.md` first, especially **"What this is not"**. Most bad
changes to this codebase are additions that were never argued for.

## Before you start

```bash
npm run install:all
npm run build:policy
```

Nothing needs a Firebase account. `demo-bikeshed` is emulator-only and Firebase
refuses to point it at a real backend.

## Before you claim you are done

```bash
npm run verify              # policy, agents, build, tests, brand, headers, content, licences
npm run test:rules:emulated # rules tests — needs the emulators, and starts them
```

`npm run verify` is the whole gate except the rules suite. Run both, show the
output, and do not describe a check as passing that you did not run.

## The five things most likely to bite you

**1. Four files are generated. Do not edit them.**
`firestore.rules`, `database.rules.json`, `functions/src/generated/policy.ts`
and `app/src/generated/policy.ts` are rendered from `config/access-policy.json`
by `config/policy.mjs`. Edit the source or the template in `config/templates/`,
then `npm run build:policy`. `npm run check:policy` byte-compares and runs as
`pretest` and `prebuild`.

**2. Three module pairs are duplicated on purpose.**
`hash`, `membership` and `policy` exist in both ESM (`scripts/`) and CommonJS
(`functions/`) because the runtimes differ. They are held in agreement by parity
tests, and the hash pair is pinned by a **shared golden-vector fixture** — never
by comparing one implementation to the other, which lets them drift together.
Change one, change both, and the parity test is the proof.

**3. Decoration must never reach serialized bytes.**
Highlights, placeholder marks and the peer-presence overlay are all injected
into the document being edited. Four independent legs keep them out of what is
saved: the `FrameMode` tagged union, effect-cleanup ordering, an unconditional
strip plus a dev-only assertion, and `serializeCleanHtml` itself. If you touch
`viewer/`, `annotation/` or `wysiwyg/`, run `app/src/viewer/invariant.test.tsx`
and believe it — it has already caught one real bug that no other test saw.

**4. `[data-bshd]` is removed by VALUE, not by presence.**
A document of somebody else's could legitimately contain `data-bshd="whatever"`.
The serializer only strips values this app writes, listed in `brand/dom.ts`.
Weakening that check to an attribute-presence test is silent data loss in
somebody's document.

**5. Every source file needs a two-line header.**

```
// SPDX-License-Identifier: Apache-2.0
// <what this file owns> (SPEC §N)
```

`npm run check:headers` enforces both lines. The two hash implementations carry
the full Apache notice instead, because they are a normative wire format
somebody may copy out on its own.

## Commits

Conventional commits, lower case, imperative, no trailing period.

**Stage explicit paths.** `git add -A` and `git add .` are not used here — they
are how a stray local file or a credential enters history.

**No attribution trailers.** `Co-Authored-By:`, `Generated-by:` and session ids
do not belong in the permanent record of what the code is. The brand guard fails
the build on them, and an author field cannot be corrected without rewriting
history.

Write the commit body for somebody reading `git log` in two years with no
context. Say what was wrong and why this fixes it, not what the diff already
shows.

## Deployment facts stay out of the tree

No tracked file may name the real Firebase project, console account, bucket,
Web SDK config or measurement id. They live in gitignored files and in Firebase
Secret Manager; see `docs/operations.md`.

The brand guard catches leaks **by shape** — any `*.web.app`, `gs://` URL,
`AIza…` key, app id, measurement id, or a `projects` block naming a non-`demo-`
id — so a project rename cannot quietly reintroduce one. The package slug
`bikeshed-now` is a legitimate name and is not forbidden; the binding is.

## Where things are

| | |
|---|---|
| `docs/SPEC.md` | normative; cite it as `(SPEC §N)` |
| `docs/adr/` | nine decisions with their reversal conditions |
| `config/policy.mjs` | the identity gate, rendered four ways |
| `functions/src/index.ts` | every endpoint; mirrored by `scripts/lib/endpoints.mjs` |
| `functions/src/lib/` | one concern per module |
| `app/src/viewer/` | the nine hooks `DocViewer` decomposes into, plus `frameMode.ts` |
| `app/src/brand/dom.ts` | every `bshd-` identifier, defined once |
| `scripts/` | operator CLIs, Admin credentials |
| `cli/` | the end-user CLI, token over HTTPS |

## Things that look like bugs and are not

- **`execCommand` is deprecated.** It was deprecated when it was chosen, and it
  is the only API that edits a document in place without first deciding what a
  document may contain. See [ADR 0007](docs/adr/0007-execcommand-over-schema-editor.md).
- **The MCP server is hand-written.** The SDK needs `zod` as a peer, and the
  server half of streamable HTTP is ~200 lines. See
  [ADR 0009](docs/adr/0009-hand-written-mcp.md).
- **Firestore is 8088 and Hosting is 5050.** Not the defaults: 8080 is the most
  contended port on a developer machine and 5000 is AirPlay on macOS.
- **`zoom` is in the export stamp lock but untestable in jsdom.** It is a real
  hiding vector in Blink and WebKit. It is named in `UNREPRESENTABLE_IN_JSDOM`,
  and a test asserts that list is exactly right.
