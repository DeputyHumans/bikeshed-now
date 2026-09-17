# Publishing to Bikeshed

Instructions for an agent publishing documents and reading review feedback on a
Bikeshed deployment.

This file is the source of truth for what a deployment serves at `/llms.txt`; a
build step copies it verbatim and CI asserts the two match. If you are an agent
**changing this repository's source** rather than using a deployment, you want
`CLAUDE.md` (mirrored to `AGENTS.md`) instead — a different job entirely.

## What this is for

You publish a document. People highlight the sentences they object to and
comment on them. You read those comments **together with the exact passage each
one is about**, and revise.

That loop is the point. It is why `get_comments` returns the anchored quote
rather than just the comment text: you do not have to fetch the document and
diff it to find out what "this paragraph is too strong" refers to.

## Getting a token

Ask the person you are working with to create one at `/account` → **Access
tokens** → *Agent (MCP)*. It is shown once.

A token carries **exactly its owner's identity and permissions**. It cannot see
more than they can, and everything it does is recorded against it — so if it
leaks, "what did this token touch" is one query and revoking it is one click.
Do not ask for a token with wider access; there is no such thing.

Send it as `Authorization: Bearer bsk_...`.

## Two interfaces, same capabilities

### MCP

```
POST https://<deployment>/mcp
Authorization: Bearer bsk_...
Content-Type: application/json
```

Streamable HTTP, JSON-RPC 2.0. `initialize`, `tools/list`, `tools/call`. The
discovery document is at `/.well-known/mcp.json`.

| Tool | What it does |
|---|---|
| `list_documents` | Your documents. Metadata only |
| `get_document` | Metadata and the current **source** |
| `publish_document` | Create a document from content you supply |
| `update_document` | Publish a new version of one that exists |
| `get_comments` | Unresolved feedback, each with its anchored quote |
| `reply_to_comment` | Reply in a thread |

### Command line

```
bikeshed login
bikeshed list [--json]
bikeshed publish <file> [--title …] [--folder …] [--watch]
bikeshed update <id> <file> [--watch]
bikeshed get <id>
bikeshed comments <id> [--json]
bikeshed reply <id> <thread> <text>
```

Every command takes `--json`. `BIKESHED_TOKEN` and `BIKESHED_ORIGIN` work
instead of `login` when you cannot run an interactive command.

## The loop, worked through

```bash
# 1. Publish a draft.
bikeshed publish proposal.md --title "Storage migration" --json
# → {"docId":"storage-migration","versionId":"v1", ...}

# 2. Share it. Ask the person you are working with to do this in the interface —
#    there is no tool for it, deliberately: deciding who sees a document is not
#    something an agent should do on somebody's behalf.

# 3. Later, read the feedback.
bikeshed comments storage-migration
# ── a7Kd…  (rollout-plan)
#    "we can cut over in a single weekend"
#    ana@example.com: This assumes no dual-write period. There is one.

# 4. Revise the passage that comment is about, then publish the revision.
bikeshed update storage-migration proposal.md

# 5. Say what you changed, in the thread.
bikeshed reply storage-migration a7Kd… "Rewritten to describe the dual-write \
period and its two-week window."
```

**Publishing the same content twice is a no-op.** Identical bytes hash to the
same value and no new version is minted, so it is safe to run `update` in a
loop, in CI, or after a change you are not sure you made.

## Writing a document that works well here

These are not style preferences. Each one changes whether a feature works.

### Put an `id` on every section

```html
<section id="rollout-plan">
  <h2>Rollout plan</h2>
  …
</section>
```

Comments anchor to the nearest ancestor with an `id`. Without one, every
highlight in the document anchors to `<body>` — so any edit anywhere shifts all
of them at once, and a comment on paragraph two can end up pointing at
paragraph nine.

**Markdown gets this for free**: every heading is wrapped in a `<section>` with
a slug derived from its text. If you are writing Markdown, just use headings.

### Keep it self-contained

One file, no external URLs. A document is an artifact: somebody will download
it, print it, or open it in three years. Every byte of a multi-file bundle is
also a separate authenticated request, so a fifty-asset deck costs fifty
round trips per reader and an inlined one costs one.

Inline your SVG. Inline your CSS. If you genuinely need several files, send a
`.zip` with `index.html` at its root.

### Markdown is usually the right choice

It renders server-side into a self-contained HTML document with sections, a
print stylesheet and no external requests. `get_document` gives you the
**Markdown source** back, not the rendered HTML — so the round trip is lossless
and your context is not filled with three kilobytes of stylesheet.

Use HTML when you need something Markdown cannot express: a slide deck, an
inline diagram, a layout.

### Scripts run only if somebody vouches for them

A document you publish through a token is trusted, and its scripts run. A
document somebody uploads through the browser is sandboxed until its owner says
otherwise. If your document depends on its own JavaScript, say so in the text,
so a reader seeing an empty box knows why.

## What you cannot do, and why

- **Share a document.** Deciding who can see something is not a decision to
  automate. Ask.
- **Delete anything.** Documents are permanent by design. A single version can
  be withdrawn by whoever runs the deployment, through a guarded tool.
- **Act as somebody else.** A token is its owner. There are no service accounts.
- **Read a document you were not given.** A token's reach is exactly its
  owner's.

## You are visible, and that is the point

Everything done through a token is stamped with the channel it came through —
`cli`, `mcp` or `api` — derived from the credential you presented, not from
anything you send. Your comments show a "via MCP" marker, and your reads are
counted separately from human reading so they do not distort the statistics.

This is not a restriction on you. It is what makes it reasonable to give an
agent write access at all: a reviewer can always tell which feedback came from
a person, and an owner can always see what an agent did.

You may also send `X-Bikeshed-Client` and `X-Bikeshed-Agent` headers naming
yourself. They are stored and displayed **as self-reported** — no badge implies
they were verified, because they were not. Send them anyway: they are what
makes an activity feed readable six months later.
