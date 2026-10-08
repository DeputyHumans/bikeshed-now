# Contributing

Thanks for looking. This is a small, opinionated codebase that gets most of its
value from staying small, so the most useful thing you can read before writing
code is `docs/architecture/overview.md` — in particular the **"What this is not"** list.

## Getting it running

Nothing here requires a Firebase account or a credit card. Everything runs
against the emulators.

You need Node 24 (`.nvmrc`), the Firebase CLI (`npm i -g firebase-tools`) and a
JRE. The emulators are a Java process rather than a Node one, which is the one
prerequisite `npm install` cannot hand you.

```bash
npm run install:all          # root + app + functions + cli
npm run build:policy         # render the identity gate from config/access-policy.json
npm run emulators            # in one terminal — project id is demo-bikeshed
npm --prefix app run dev     # in another — http://localhost:5173
```

`demo-` prefixed project ids are emulator-only: Firebase refuses to point them at
a real backend, so the quickstart cannot accidentally write to production.

The app connects to the emulators when `VITE_USE_EMULATORS=1` is set — copy
`app/.env.example` to `app/.env.local`, which already has it.

## The verification table

A change is done when every row passes **with output shown**. `npm run verify`
runs every row except 5, which needs the emulators — use
`npm run test:rules:emulated`, which starts them.

| # | Command | Pass condition |
|---|---|---|
| 1 | `npm run check:policy && git diff --exit-code` | codegen reproducible and committed |
| 2 | `npm --prefix app run typecheck && npm --prefix app run build` | exit 0, `app/dist/index.html` exists |
| 3 | `npm --prefix functions run build && npm --prefix functions test` | 0 failing |
| 4 | `npm --prefix app test` | green; ≥90% on `annotation/ export/ workspace/ stats.ts brand/` |
| 5 | `npm run test:rules:emulated` | 0 failing |
| 6 | `node scripts/<each>.mjs --dry-run …` | exit 0; credential-free for all but `delete-version`, whose preview must read to be useful |
| 7 | `npm run check:secrets` | `check-secrets: clean` |
| 8 | `npm run check:headers` | exit 0 |
| 9 | `npm run check:content` | every sample still demonstrates what it is there for |
| 10 | `npm run check:licenses` | exit 0 — every dependency permissive |
| 11 | `npm run check:agents` | `AGENTS.md` matches `CLAUDE.md`, and `llms.txt` matches `docs/agents/agent-guide.md` |
| 12 | `npm run test:tools` | 0 failing — the served instructions carry the deployment's own address, and no `<deployment>` survives |

**Every command in every document in this repository is copy-pasteable and is
expected to work.** A document is wrong if a command in it fails; that is a bug
worth reporting on its own.

The table above proves the code is self-consistent. It does not prove the
product works — the properties that matter most here are integration ones. For
those, walk `docs/development/verification.md` against the emulators. It is ten
observations, it needs no cloud account, and it is where four real defects were
found that no unit test could have caught.

## House rules

These are the ones that actually get enforced in review.

1. **`docs/architecture/spec.md` is normative.** It supersedes prose anywhere else, including
   the README. If your change contradicts it, change the spec in the same pull
   request and say why. Section numbers are a public API: append, never renumber.
2. **One owner per concern.** Every shared identifier, token and constant has
   exactly one defining module — `app/src/brand/dom.ts`,
   `app/src/brand/tokens.ts`, `config/access-policy.json`,
   `scripts/lib/endpoints.mjs`, `functions/src/config.ts`. A literal living in
   two files is how this kind of codebase rots.
3. **No abstraction before the second call site.** Extract a helper when two
   places need it, not when one place might.
4. **Duplication across runtimes is allowed, and is then tested into agreement.**
   The ESM/CommonJS twins (`hash`, `membership`, `policy`) are duplicated on
   purpose and pinned by parity tests. That is cheaper and safer than a shared
   build artifact.
5. **New concepts must justify themselves against an existing one.** Markdown
   reuses the trust model; email verification reuses Firebase's `emailVerified`;
   the email cooldown reuses the user record. Three chances to invent a
   subsystem, three declined.
6. **Failure of a non-essential subsystem never fails the request.** Presence,
   email and stats are try/catch-and-continue. Access control never is.
7. **Dependencies have a budget**: 7 runtime deps in `app/` and 10 in
   `functions/`, plus the four lazily imported inside the email path only.
   `functions/` currently sits at nine, one under. Anything beyond the budget
   needs a written justification in the pull request, not a line in
   `package.json`. `npm run check:licenses` separately hard-fails on anything
   outside the permissive allowlist.
8. **Every non-obvious constant carries its reason inline.** `OPEN_DELAY_MS`
   exists both to ignore mis-clicks *and* to survive StrictMode's double mount —
   that sentence is worth more than the name.

## Commits

Conventional commits: `type(scope): imperative subject`, lower case, no trailing
period, 50 characters or fewer.

Stage explicit paths. `git add -A` and `git add .` are not used here — they are
how a stray local file or a credential ends up in history.

Keep commits atomic: one change, and the project builds after each one.

## Security rules

`firestore.rules` and `database.rules.json` are **generated** from
`config/access-policy.json`. Never hand-edit them; edit the source or the
template in `config/templates/` and run `npm run build:policy`. CI byte-compares.

Every positive rules assertion needs an explicit negative beside it. A rules
suite where every test passes because the rule never fires is worse than no
suite, because it looks like coverage.

## Reporting a vulnerability

See `SECURITY.md`. Please do not open a public issue for anything that lets
someone read a document they should not.

## Licensing

By contributing you agree your contribution is licensed under Apache-2.0, the
same terms as the project. Add an SPDX header to every new source file:

```
// SPDX-License-Identifier: Apache-2.0
// <what this file owns> (SPEC §N)
```

`npm run check:headers` enforces it.
