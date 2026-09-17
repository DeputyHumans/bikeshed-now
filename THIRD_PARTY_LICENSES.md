# Third-party licenses

Bikeshed is Apache-2.0 (see `LICENSE`). This file records what else is involved,
and is the evidence behind the licence gate in CI.

Two kinds of third-party material, and only the first is redistributed here:

- **Vendored** — files that ship inside this repository. The font, and the
  material recorded in `NOTICE`.
- **Fetched** — npm dependencies, which are downloaded at install time and are
  not part of this distribution. Listed for review, not because we redistribute
  them.

---

## Vendored

### app/public/fonts/bikeshed-sans-var.woff2 — "Bikeshed Sans"

A derivative of **Inter**, by Rasmus Andersson and the Inter Project Authors,
under the **SIL Open Font License 1.1**.

Changes: subset to the Latin and Latin Extended ranges, the optical-size axis
pinned to its default, the weight axis restricted to 300–800, and renamed.
Reproduce with `python3 tools/build-font.py <InterVariable.woff2>`.

The rename is deliberate. Subsetting and restricting an axis are modifications,
and shipping a modified file under the upstream name would imply the upstream
project vouches for it. The full OFL text and the attribution are in
`app/public/fonts/OFL.txt`, and **the OFL applies to the font files only** — it
does not extend to any other part of this work.

### docs/acf/** and .claude/scripts/

© Fibonacci Seven, LLC, under a proprietary license that forbids
redistribution. **This is a known conflict**, recorded in full in `NOTICE`,
including what a downstream recipient has to do about it. Read that before
publishing, forking or mirroring this repository.

---

## The licence gate

CI fails on any dependency outside this allowlist:

```
MIT · Apache-2.0 · ISC · BSD-2-Clause · BSD-3-Clause · 0BSD · MIT-0 ·
BlueOak-1.0.0 · CC0-1.0 · Unlicense
```

**Why it hard-fails rather than warns.** Apache-2.0 is one-way incompatible with
GPLv2-only: a single GPLv2 transitive dependency makes the combined work
undistributable under the licence this project claims. That has to surface on
the pull request that introduces it, not at release, because by release the
options are "rip it out" or "relicense the project".

Run it: `npm run check:licenses`.

---

## Direct dependencies

Every one is MIT or Apache-2.0.

| Where | Package | Licence |
|---|---|---|
| app (runtime) | `dom-anchor-text-position`, `dom-anchor-text-quote` | MIT |
| app (runtime) | `firebase` | Apache-2.0 |
| app (runtime) | `html-to-image` | MIT |
| app (runtime) | `react`, `react-dom`, `react-router-dom` | MIT |
| app (dev) | `vite`, `vitest`, `jsdom`, `@vitejs/plugin-react`, `@vitest/coverage-v8`, `@testing-library/react` | MIT |
| app (dev) | `typescript` | Apache-2.0 |
| functions | `adm-zip`, `cookie`, `mime-types` | MIT |
| functions | `firebase-admin` | Apache-2.0 |
| functions | `firebase-functions` | MIT |
| functions | `markdown-it`, `turndown`, `turndown-plugin-gfm` | MIT |
| functions | `resend` | MIT |
| functions (lazy) | `react`, `react-dom`, `@react-email/components`, `@react-email/render` | MIT |
| root (dev) | `@firebase/rules-unit-testing` | Apache-2.0 |
| root (dev) | `firebase-admin` | Apache-2.0 |
| root (dev) | `mime` | MIT |

---

## Transitive tree

501 packages at the time of writing: 365 MIT, 74 Apache-2.0, 28 ISC, 18
BSD-3-Clause, 6 BSD-2-Clause, 4 BlueOak-1.0.0, and one each of 0BSD, MIT-0,
CC-BY-4.0, Python-2.0 and a dual BSD/GPL.

Four of those are worth naming, because each is the kind of thing an automated
scanner flags and a person then has to decide about:

| Package | Declared | Assessment |
|---|---|---|
| `node-forge` | `(BSD-3-Clause OR GPL-2.0)` | **Dual-licensed, and we take BSD-3-Clause.** A scanner reporting "GPL-2.0 found" here is reporting one half of an `OR`. Reached through the `firebase-admin` tree. |
| `caniuse-lite` | CC-BY-4.0 | A build-time browser-compatibility DATABASE, not code, and not redistributed. CC-BY requires attribution, which this line is. |
| `argparse` | Python-2.0 | A permissive licence, GPL-compatible and Apache-compatible. Reached through `markdown-it`. |
| `config-chain` | MIT, declared in the legacy `{type, url}` shape | MIT. It declares it in a form modern tooling reports as unparseable rather than as a problem. |

None is a blocker. All four are recorded here so that the next person to run a
scanner has the answer already written down rather than having to derive it
again.
