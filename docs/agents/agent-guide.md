# Publishing to Bikeshed

Instructions for an agent publishing documents and reading review feedback on a
Bikeshed deployment.

This file is the source of truth for what a deployment serves at `/llms.txt`. A
build step copies it and CI asserts the two match; the served copy differs only
in having this deployment's own address filled in.

## Start here

This deployment is `https://<deployment>` — the origin you fetched this from.
Four steps.

**1. Install the skills.** They are public files, need no token, and are the long
form of everything below — one per job, loaded for the job that needs it.

```bash
npx -y bikeshed-now skills install .claude/skills
```

Or fetch them yourself, if you would rather not run anything: `/skills/index.json`
lists them, and each one is at `/skills/<name>/SKILL.md`. Write each file to the
directory your harness reads skills from.

| Harness | Directory |
|---|---|
| Claude Code | `.claude/skills/` in the project, or `~/.claude/skills/` |
| Codex, Gemini CLI, Cursor, Copilot, OpenCode, Amp, Roo | `.agents/skills/` |

Prefer the project directory. A write under somebody's home is outside the
working directory, and you will stop to ask for permission you did not need.

**2. Say what you did, and what is still needed.** A skill written during a
session is picked up without a restart in Claude Code — unless the skills
directory did not exist when the session began, in which case somebody has to run
`/reload-skills`, and only a person can. Other harnesses may read skills only at
startup. So report the install rather than assuming it took effect.

**3. Ask for a token.** Only a person can mint one, and that is deliberate.
Below.

**4. Publish something, and hand back the address.** The worked loop is further
down. What you give back is the `url` in the result — `https://<deployment>/d/<id>`
— and one line saying who can read it, because a new document is private until
somebody shares it.

## What this is for

You publish a document. People highlight the sentences they object to and
comment on them. You read those comments **together with the exact passage each
one is about**, and revise.

`get_comments` returns the anchored quote, not just the comment text, so you
do not have to fetch the document and diff it to work out what "this paragraph
is too strong" refers to.

## Getting a token

Ask the person you are working with to create one at `/account` -> **Access
tokens** -> *Agent (MCP)*. It is shown once.

A token carries **exactly its owner's identity and permissions**. It cannot see
more than they can, and everything it does is recorded against it. If it
leaks, "what did this token touch" is one query, and revoking it is one click.
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

**You do not need a registered MCP client.** There is no session state: every
request carries its own credential, so one authenticated POST is a complete
call, and `initialize` is optional rather than a handshake you must complete
first. If all you have is an HTTP client, you have all nine tools.

```bash
curl -s https://<deployment>/mcp \
  -H "Authorization: Bearer $BIKESHED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_documents","arguments":{"limit":5}}}'
```

If your harness does register servers from a config file, most expand `${VAR}` in
a header value — so the token can stay in the environment rather than in a file
somebody might commit.

| Tool | What it does |
|---|---|
| `list_documents` | Your documents. Metadata only |
| `get_document` | Metadata and the current **source** |
| `publish_document` | Create a document from content you supply, optionally at an `id` you choose |
| `update_document` | Publish a new version of one that exists |
| `list_folders` | Every folder you can see, each with its full path |
| `create_folder` | Create one, optionally inside another |
| `move_document` | File a document into a folder, or back out to the root |
| `get_comments` | Unresolved feedback, each with its anchored quote |
| `reply_to_comment` | Reply in a thread |

### Command line

```
bikeshed login
bikeshed list [--json]
bikeshed publish <file> [--title …] [--id …] [--folder …] [--watch]
bikeshed update <id> <file> [--watch]
bikeshed get <id>
bikeshed comments <id> [--json]
bikeshed reply <id> <thread> <text>
bikeshed open <id>

bikeshed folders
bikeshed mkdir <name> [--parent <id>]
bikeshed mv <id> <folder|root>

bikeshed skills [install <dir>]
```

```bash
npm i -g bikeshed-now      # or npx -y bikeshed-now <command>, for one call

export BIKESHED_ORIGIN=https://<deployment>
export BIKESHED_TOKEN=bsk_...
```

Every command takes `--json`. Those two work instead of `login` when you cannot
run an interactive command — `login` prompts, which you cannot answer.

## Skills

Longer instructions for the three jobs this surface is for, written in the
Agent Skills convention: one directory each, holding a `SKILL.md` with a
`name` and a `description` in its frontmatter. This file is the short version
every agent reads; a skill is the long version, loaded for the task that needs
it.

| Skill | Load it when |
|---|---|
| `bikeshed-publishing` | writing and publishing a document, or revising one; which formats it takes and what renders, runs and loads in one |
| `bikeshed-feedback` | reading anchored review comments and acting on them |
| `bikeshed-folders` | organising a workspace, or moving a document |

```bash
bikeshed skills                              # what this deployment publishes
bikeshed skills install ~/.claude/skills     # write them where an agent reads
```

They are also plain files: `/skills/index.json` lists them, and each one is at
`/skills/<name>/SKILL.md`. Fetch them directly if your harness reads skills from
somewhere else, or paste one into an `AGENTS.md`.

Each deployment serves its own copy, so what you install describes the
deployment you are actually talking to rather than the newest one that exists.

## The loop, worked through

```bash
# 1. Publish a draft.
bikeshed publish proposal.md --title "Storage migration" --json
# -> {"docId":"storage-migration","versionId":"v1",
#     "url":"https://<deployment>/d/storage-migration", ...}

# 2. Share it. Ask the person you are working with to do this in the interface.
#    There is no tool for it, deliberately: deciding who sees a document is
#    not something an agent should do on somebody's behalf.

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

**You can choose the address.** `--id platform-review`, or `publish_document`'s
`id`, publishes at `/d/platform-review`. Use lowercase letters, digits and
hyphens, up to 60 characters. If the id is taken, the document is still
published, at that id plus a few random characters, and the CLI says so on
stderr. So the address to hand back is always the `url` in the result, never
one you built from the id you asked for. An id never changes once published: to
put new content at the same address, `update` that document.

## Filing it somewhere changes who can read it

A folder is where a document lives **and** an access grant. A document's readers
are its own grants plus its folder's, so:

```bash
bikeshed folders                              # ids, paths, and what you may write to
bikeshed mkdir "Storage migration"
bikeshed mv storage-migration aB3xK9…         # into a folder
bikeshed mv storage-migration root            # back out to the workspace root
```

Moving a document **into** a folder shares it with everyone that folder is
shared with; moving it **out** takes that access away. So if you are not certain
the sharing is wanted, ask before you move it. Placing a document
when you publish it (`--folder`, or `publish_document`'s `folder`) has the same
effect and costs one call instead of two.

A `…` in a path is a folder you cannot see: access flows downward, so a grant on
a child says nothing about its parent. A folder listed without `canWrite` is one
you may read and may not file into.

## What you can publish

| Send | Through | What a reader gets |
|---|---|---|
| Markdown, `.md` or `.markdown` | `bikeshed publish`, or `publish_document` (its default) | One HTML page rendered on the server. `get_document` returns your Markdown |
| HTML, `.html` or `.htm` | `bikeshed publish`, or `publish_document` with `"format": "html"` | Your file, byte for byte |
| A `.zip` of several files | `bikeshed publish`, and `bikeshed update` to revise it. The tools take text | The files, with `index.html` or `index.md` at the root as the entry. One enclosing folder is fine |

Anything else is refused. An upload may be 25 MB, and a `.zip` 25 MB
uncompressed. Markdown is read as UTF-8.

**An update keeps the document's format, and what it replaces depends on what
you send.**

- **One `.md` or `.html` file**, through `bikeshed update` or `update_document`,
  replaces the entry. Every file beside it is kept, so you can revise a bundle's
  text and its images and stylesheets stay where they were.
- **A `.zip`**, through `bikeshed update`, replaces the whole bundle. A file the
  archive leaves out is gone from the new version. This takes somebody the
  document is shared with as an editor, not open editing.

An update cannot switch a document between Markdown and HTML. Publish a new
document for that.

## A document can have an expiry

`list_documents` and `get_document` report `expiresAt` — epoch milliseconds, or
null. After that moment the document is **read-only, and readable only by its
owner**: every tool here answers as though it does not exist, and the write
tools refuse it.

Nothing has been deleted. The versions, the comments and the bytes all survive,
and the owner can move the date or clear it. If you need an expired document,
ask them — do not republish its content as a new one and leave two documents
where there was one.

## An unlisted document needs its link

A document shared as **unlisted** is readable by anyone holding its link,
`https://<deployment>/d/<id>?k=<key>`, and by nobody else. The `id` alone is not
enough: without the key, every tool answers exactly as it does for an id that
does not exist.

If you were given such a link, pass the key along: `k` on `get_document`,
`get_comments`, `reply_to_comment` and `update_document`, or the whole link in
place of the id on the command line:

```bash
bikeshed comments 'https://<deployment>/d/build-estimate?k=…'
```

Once the person whose token you hold has opened the link in a browser, their
account holds the access and the key is no longer needed. If the owner rotates
the link, the old key stops working. Ask for the new one; do not guess.

## Writing a document that works well here

Each of the four below changes whether a feature works.

### Put an `id` on every section

```html
<section id="rollout-plan">
  <h2>Rollout plan</h2>
  …
</section>
```

Comments anchor to the nearest ancestor with an `id`. Without one, every
highlight in the document anchors to `<body>`. Any edit anywhere then shifts
all of them at once, and a comment on paragraph two can end up pointing at
paragraph nine.

**Markdown gets this for free**: every heading is wrapped in a `<section>` with
a slug derived from its text. If you are writing Markdown, just use headings.

### Keep it self-contained

One file, no external URLs. Images, stylesheets and fonts from another site do
load, because nothing blocks them. But each one tells that site when the document
is read, breaks when the site moves, and is missing from a download. A document
outlives the conversation that produced it: somebody will download it, print it,
or open it in three years. Every file of a multi-file bundle is also a separate
authenticated request, so a fifty-asset deck costs fifty round trips per reader
and an inlined one costs one. A signed-out reader of an unlisted link gets the
entry file and none of the files beside it, because the key is on the page's
address and not on the requests the page makes.

Inline your SVG. Inline your CSS. Put images in `data:` URIs and use system
fonts, or embed a font as a `data:` URI. If you genuinely need several files, send
a `.zip` with `index.html` at its root and refer to its files by relative path: a
path starting with `/` resolves against the deployment, not your bundle.

### Markdown is usually the right choice

It renders server-side into a self-contained HTML document with sections, a
print stylesheet and no external requests. `get_document` gives you the
**Markdown source** back, not the rendered HTML, so the round trip is lossless
and your context is not filled with three kilobytes of stylesheet.

Use HTML when you need something Markdown cannot express: a slide deck, an
inline diagram, a layout. Put a `<title>`, a `<meta name="description">` and
an absolute `og:image` in its head: they become the link preview when the
document is shared, and the `<title>` is its default title. Declare
`<meta charset="utf-8">`: HTML is served without a charset, and a browser left to
guess may garble anything outside ASCII.

### Scripts run only if somebody vouches for them

Everything you publish through a token is sandboxed, exactly like a browser
upload: its scripts do not run until a person trusts the document in the app. A
raw `<script>` in Markdown is treated the same way as one in HTML. The owner can
trust it for every reader; any reader can trust it for their own browser only.
Once trusted, JavaScript works as it would anywhere else.

If your document depends on its own JavaScript, say so in the text, so a reader
seeing an empty box knows why, and tell the owner what the script does. Whether
to trust it is theirs to decide. A `<noscript>` element is shown while the
document is sandboxed, so it is the place to say what is missing.

## What renders, what runs, what loads

### Markdown

The renderer is markdown-it 14.1.0 (CommonMark) with tables, strikethrough and
task lists. Nothing else is added.

**Renders:** headings (each one opens a `<section>` with an id), tables,
`~~strikethrough~~`, `- [x]` task lists as disabled checkboxes, fenced code as
plain monospace with no syntax colouring, links, `<https://…>` autolinks,
images, and raw HTML, including `<svg>`, `<details>` and `<script>`.

**Shows as typed, unrendered:**

- YAML front matter. It becomes a horizontal rule and a heading. Leave it out
- Mermaid, PlantUML and every other diagram fence. They show as code blocks
- Math, `$…$` and `$$…$$`
- Footnotes, `==highlight==`, `H~2~O`, `x^2^`, `:emoji:` shortcodes, definition lists
- Bare URLs. Only `<https://…>` and `[text](url)` become links
- A single newline. End the line with two spaces or `\` for a line break
- An SVG `data:` URI in `![](…)`. Only PNG, JPEG, GIF and WebP pass

For a diagram, render it to SVG yourself and paste the `<svg>` in as raw HTML,
inside a `<div>` and with no blank line anywhere in it: a blank line ends a raw
HTML block, and everything after it is read as Markdown again. Only `<script>`,
`<style>` and `<pre>` run to their closing tag.

The page has a light theme and a print stylesheet. It has no dark mode and no
generated table of contents.

### HTML

| In the document | Sandboxed (the default) | Trusted, by the owner for everyone or by a reader for themselves |
|---|---|---|
| `<script>`, inline or `src` | Does not run | Runs |
| `onclick` and every other handler attribute | Does not run | Runs |
| `<noscript>` | Shown | Hidden |
| An embedded `<iframe>`: video, map, widget | Loads with its scripts off, so usually blank | Works |
| A slide deck its JavaScript builds | Empty | Works |
| A form | Does not submit | Submits |
| A link to another site, with `target="_blank"` or without | Opens in a new tab; the document stays | The same |
| A link to `#id` | Scrolls | Scrolls |
| A link to another file of the same bundle | Opens in the document's frame | The same |
| CSS, `@font-face`, `<details>`, inline SVG, relative bundle files | Work | Work |
| External images, stylesheets, `@import` and web fonts | Load | Load |

## What you cannot do, and why

- **Share a document or a folder.** Deciding who can see something is not a
  decision to automate. Ask.
- **Delete anything.** Documents are permanent by design. A single version can
  be withdrawn by whoever runs the deployment, through a guarded tool. Deleting
  a folder reparents everything beneath it, so that is a person's call too.
- **Rename a folder.** Names are the workspace's language. Ask.
- **Set or clear a document's expiry.** Same reason as sharing: it decides who
  can read something, and until when.
- **Resolve a comment thread.** Whether an objection has been answered is the
  objector's decision. Reply, and let them close it.
- **Act as somebody else.** A token is its owner. There are no service accounts.
- **Read a document you were not given.** A token's reach is exactly its
  owner's.

## You are visible

Everything done through a token is stamped with the channel it came through
(`cli`, `mcp` or `api`), derived from the credential you presented rather than
from anything you send. Your comments show a "via MCP" marker, and your reads are
counted separately from human reading so they do not distort the statistics.

This is what makes it reasonable to give an agent write access at all: a
reviewer can always tell which feedback came from a person, and an owner can
always see what an agent did.

You may also send `X-Bikeshed-Client` and `X-Bikeshed-Agent` headers naming
yourself. They are stored and displayed **as self-reported**. No badge implies
they were verified, because they were not. Send them anyway: they are what
makes an activity feed readable six months later.
