# 0005 — Generate the security rules from one policy file

**Status** Accepted · **Spec** §1.1

## Context

The identity policy — who this deployment admits — has to be enforced in four places that cannot import from each other: `firestore.rules`, `database.rules.json`, the functions runtime, and the client bundle.

`.rules` files have no import mechanism and the Firebase toolchain has no preprocessor. The predecessor of this codebase had the policy hand-written in six independent layers, and they drifted.

## Decision

`config/access-policy.json` is the single source of truth. `config/policy.mjs` holds **pure renderers**, and `tools/build-policy.mjs` writes four **committed** artifacts, each carrying a `GENERATED — DO NOT EDIT` banner and the sha256 of its source:

```
firestore.rules · database.rules.json
functions/src/generated/policy.ts · app/src/generated/policy.ts
```

`npm run check:policy` re-renders in memory and byte-compares. It runs as `pretest` and as the first step of `npm run build`.

## Consequences

- **Generated, not gitignored.** A security boundary that is not in git is not reviewable and has no diff history. The generated rules show up in a pull request exactly like hand-written ones.
- Functions needs its own generated `.ts` under `functions/src/` because Cloud Functions uploads only that directory and `tsconfig` pins `rootDir: "src"`. A shared module one level up is simply not deployed.
- The renderers being pure functions is what lets the rules tests render allowlist mode **in memory** and hand the string to `initializeTestEnvironment` — no temp files, no second committed fixture that could itself drift.
- The client artifact is deliberately **list-free**. Vite inlines it into the public bundle, so it carries the shape rules and one boolean, never the allowlist. The client learns policy outcomes from `POST /session`.
- Renderer substitution uses a `subst()` split/join helper rather than `String.replace`, because `$` in a replacement string is a special sequence and the generated regexes contain `$`. That bug cost an afternoon; the reason is a comment in the file.

## What would change this

If the Firebase toolchain gains a real import or macro mechanism for `.rules`, two of the four artifacts stop needing generation. The two TypeScript modules would still need it, so the tool would shrink rather than disappear.
