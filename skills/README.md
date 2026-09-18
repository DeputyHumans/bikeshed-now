# Skills

Three sets of instructions for an agent **using** a Bikeshed deployment: how to
publish a document, how to read the feedback that comes back, and how to file
things without accidentally changing who can read them.

They are written in the Agent Skills convention — a directory per skill, holding
a `SKILL.md` whose YAML frontmatter carries a `name` and a `description`. The
description is what an agent matches against to decide whether to load the rest,
so it says *when* to use the skill rather than what it contains.

| Skill | Load it when |
|---|---|
| `bikeshed-publishing` | writing and publishing a document, or revising one |
| `bikeshed-feedback` | reading anchored review comments and acting on them |
| `bikeshed-folders` | organising a workspace, or moving a document |

## Installing them

Every deployment serves its own copy, so the instructions an agent installs
describe the deployment it is actually talking to:

```bash
bikeshed skills                              # what this deployment publishes
bikeshed skills install ~/.claude/skills     # write them where an agent reads
```

By hand, from this repository or from a deployment:

| Harness | Where |
|---|---|
| Claude Code | `~/.claude/skills/<name>/SKILL.md`, or `.claude/skills/` inside a project |
| Codex, and anything reading `AGENTS.md` | link or paste the file into `AGENTS.md` |
| Anything else | `https://<deployment>/skills/<name>/SKILL.md`, listed at `/skills/index.json` |

`https://<deployment>/llms.txt` is the shorter, always-loaded version. The skills
are the long form, loaded only for the task that needs them.

## Keeping them true

A skill that names a command which does not exist is worse than no skill: an
agent will believe it and spend a round trip finding out. So these are checked,
not merely written.

`functions/test/skills.test.js` reads every `SKILL.md` and asserts that

- the frontmatter parses, and `name` matches the directory,
- every `bikeshed …` command it mentions is one the CLI advertises in `--help`,
- every MCP tool it names is one the server actually serves,
- every skill is named in `docs/agents/agent-guide.md`, which is what a deployment
  serves at `/llms.txt`.

`npm run check:agents` separately asserts that the copies under
`app/public/skills/` are byte-identical to these, the same way `AGENTS.md` and
`llms.txt` are held to their sources. Edit the file here and run
`npm run build:agents`.

Licensed under Apache-2.0, like the rest of this repository. They are meant to
be copied.
