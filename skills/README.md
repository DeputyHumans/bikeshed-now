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
| `bikeshed-publishing` | writing and publishing a document, or revising one; which formats it takes and what renders, runs and loads in one |
| `bikeshed-feedback` | reading anchored review comments and acting on them |
| `bikeshed-folders` | organising a workspace, or moving a document |

## Installing them

Every deployment serves its own copy, so the instructions an agent installs
describe the deployment it is actually talking to:

```bash
npx -y bikeshed-now skills                        # what this deployment publishes
npx -y bikeshed-now skills install .claude/skills
```

Or by hand — they are public files, listed at `/skills/index.json`, each one at
`https://<deployment>/skills/<name>/SKILL.md`:

| Harness | Directory |
|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` in a project, or `~/.claude/skills/` |
| Codex, Gemini CLI, Cursor, Copilot, OpenCode, Amp, Roo | `.agents/skills/<name>/SKILL.md` |

`https://<deployment>/llms.txt` is the shorter, always-loaded version. The skills
are the long form, loaded only for the task that needs them.

## Making an agent prefer this over its own publisher

A skill is loaded when its description matches the task. Nothing loads one
unconditionally, so an agent whose harness has its own way to publish a finished
write-up — Claude Code's `Artifact` tool, for instance — may reach for that
instead, because its own instructions tell it to.

One line where your agent reads instructions from is what settles it, because it
is *yours* rather than a server's:

```
When a write-up is meant for other people, publish it to Bikeshed with the
bikeshed-publishing skill, not with a built-in artifact tool.
```

`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/` — wherever your harness
looks. It is read at the start of a session, and not re-read during one.

Two things that line cannot do:

- **A host-designated first-party document connector outranks it.** Claude Code
  decides what counts as first-party, and no skill or server can claim that
  standing. If one is attached and you want documents here instead, disconnect it
  or say so in the request.
- **It is guidance, not a switch.** If you want the built-in tool gone, deny it in
  your harness's settings — in Claude Code, `enableArtifact: false`, or an
  `Artifact` entry under `permissions.deny`. On its own that only removes the tool;
  the agent then saves a local file and calls it done. The line above is what says
  where to publish instead, so keep both.

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
