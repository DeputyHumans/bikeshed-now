# Documentation

`architecture/spec.md` is normative and supersedes every other document here,
including this one. Cite it as `(SPEC §N)`.

## I want to…

| | |
|---|---|
| understand why it is shaped this way | [`architecture/overview.md`](architecture/overview.md) — start with **"What this is not"** |
| know exactly what it must do | [`architecture/spec.md`](architecture/spec.md) |
| know what it protects, and where it stops | [`architecture/threat-model.md`](architecture/threat-model.md) |
| stop re-arguing a settled decision | [`architecture/adr/`](architecture/adr/) — sixteen records, each with its reversal condition |
| deploy or run one | [`operations/overview.md`](operations/overview.md) |
| change a setting | [`operations/config.md`](operations/config.md) |
| publish the terminal client to npm | [`operations/publishing-the-cli.md`](operations/publishing-the-cli.md) |
| see it working before I believe it | [`development/verification.md`](development/verification.md) — the emulator walkthrough, and what it proves |
| write a document that works well here | [`development/authoring-bundles.md`](development/authoring-bundles.md) |
| drive a deployment from an agent | [`agents/agent-guide.md`](agents/agent-guide.md) — served at `/llms.txt` |
| change this source | [`../CLAUDE.md`](../CLAUDE.md), and [`acf/organization.md`](acf/organization.md) for where files go |

## Layout

Timeless directories update in place; git keeps the history.
`acf/`, `agents/`, `architecture/`, `development/`, `operations/`, `patterns/`.

Temporal directories take one dated file per entry, `YYYYMMDD-description.md`,
and are never edited afterwards. `research/`, `retrospectives/`, and the five
under `snapshots/`. They are empty until there is something to put in them.
