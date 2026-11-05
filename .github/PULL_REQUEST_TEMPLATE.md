<!--
Keep this short. The interesting part of a pull request here is the reasoning, which belongs in the commit body, not in a form.
-->

## What changed, and why

<!-- One paragraph. What was wrong, and what this does about it. -->

## Verification

Paste the output, do not describe it. `npm run verify` covers everything except the rules suite and the opt-in end-to-end suite.

- [ ] `npm run verify`
- [ ] `npm run test:rules:emulated` — if rules, indexes or the ACL changed
- [ ] `CHANGELOG.md` has an entry under `## Unreleased` — if this affects anyone running or using it
- [ ] No `Co-authored-by:` or `Generated-by:` trailers — `check:secrets` fails on them
- [ ] Manually exercised in the emulators — if this changes the viewer or editor
- [ ] `npm run test:e2e -- run --suite smoke`, and the area's specs — if this changes what `docs/development/verification.md` walks through (opt-in, `e2e/README.md`)

```
<!-- output -->
```

## If this touches any of these, say how

- [ ] **Security rules or the ACL** — every positive assertion has a negative beside it, and `canRead` in `acl.ts` still mirrors `canRead` in the rules
- [ ] **The serializer, the annotation layer, or the editor** — `invariant.test.tsx` passes, and no `bshd-` artifact reaches saved bytes
- [ ] **`config/access-policy.json`** — `npm run build:policy` was run and all four generated artifacts are in the diff
- [ ] **A new endpoint** — it is in `scripts/lib/endpoints.mjs`, `firebase.json` and the dev proxy; `wiring.test.js` proves it
- [ ] **A new dependency** — the written justification is below, and it is within the budget in `docs/architecture/overview.md`
- [ ] **`docs/architecture/spec.md`** — sections were appended, never renumbered

<!--
A new dependency needs a paragraph here, not a line in package.json. What does it do that ~50 lines could not, and what is its transitive footprint?
-->
