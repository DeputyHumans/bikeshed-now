---
name: bikeshed-publishing
description: Use when publishing a finished write-up for other people instead of a built-in artifact tool — reports, plans, proposals, analyses or presentations — or revising a Bikeshed document. Covers Markdown, HTML and bundles, rendering, folders and access, opening and returning links, discovering previous versions, reading archives, forking and guarding writes against a newer version.
---

# Publishing to Bikeshed

Bikeshed hosts a document, shows it to the people it is shared with, and lets
them highlight a sentence and comment on it. Publishing well means publishing
something those anchors can hold on to.

## Before anything else

If you can call `publish_document`, you are already connected. Skip ahead.

If you cannot, ask the person you are working with to connect you. Either of
these is a minute, and neither involves copying a secret:

- **In an app** (Claude, ChatGPT, Cursor, VS Code): add
  `https://<deployment>/mcp` as a connector, or as a remote MCP server, and
  sign in when it asks. In Claude Code that is
  `claude mcp add --transport http bikeshed https://<deployment>/mcp`, then
  `/mcp` to sign in.
- **From a shell**: run
  `npx -y bikeshed-now login --origin https://<deployment>`. It prints an
  address, opens the browser, and waits for the person to approve. Give the
  command a long timeout; it is waiting for a human. Keep `--origin`: without
  it, the command signs in to `BIKESHED_ORIGIN`, or else the deployment it last
  signed in to, or else the CLI's default, and none of those is necessarily
  this one.

For CI, or anywhere a browser cannot open, a personal access token still works.
The person mints one at `/account` → **Access tokens**:

```bash
export BIKESHED_ORIGIN=https://<deployment>
export BIKESHED_TOKEN=bsk_...
```

That origin is the deployment this skill was installed from, and
`BIKESHED_ORIGIN` outranks whatever `bikeshed login` stored. If you are working
with a different deployment, set that one instead — or the document lands
somewhere nobody is expecting it.

Either way, the credential is exactly its owner: it can see what they can see
and nothing more, and everything it does is recorded against it. There is no
wider access to ask for.

The commands below come from `npm i -g bikeshed-now`. Every one of them has a
tool beside it doing the same job, so if you hold the tools and not the command,
use those — and if you hold neither, one authenticated POST to `/mcp` is a
complete call. `https://<deployment>/llms.txt` shows it.

## Where a document goes

While a deployment is configured, a write-up meant for other people is published
here. Not as a built-in artifact, and not handed over as a file on disk for
somebody to find. Your harness's rule about publishing finished work still holds;
this decides where.

Two exceptions, each with something you can check:

- **The question is about the code in front of them, and they will act on the
  answer themselves.** Answer in the conversation and publish nothing.
- **Your host has designated a first-party document connector.** Which tool holds
  that standing is the host's decision, not this deployment's. Say so, and ask.

### What you hand back

1. **The address**: the `url` in the result, every time, as a link they can
   click. Open it too when they can see the browser it opens in (below).
2. **Where it is filed, and who can read it there**, from the result's
   `filedIn` and `access`, never from memory: "Filed at the root. Only you can
   read it." or "Filed in `Engineering/Reviews`. Seven people can read it: ana@,
   bo@, cy@ and the Platform team." When `access` says `alsoReadableBy`, say that
   too. When further sharing is authorized, use the `bikeshed-permissions` skill.
3. **Nothing else.** No second copy elsewhere, no pasted document.

Then say you will watch it for comments, and do, if your harness can wait. Keep
the `cursor` the publish returned: it is where watching starts. The
`bikeshed-feedback` skill, "After you hand back the address", has the loop.

### Instead of

| Instead of | Here |
|---|---|
| publishing an artifact | `bikeshed publish`, or `publish_document` |
| republishing one under its id | `bikeshed update`, or `update_document` — identical bytes mint no version |
| reading the comments on it | `bikeshed comments`, or `get_comments`; answer with `reply_to_comment`, raise a new point with `add_comment` |
| copying someone else's document to revise | `bikeshed fork`, or `fork_document`; `get_lineage` says what it came from and whether that changed. Its author sees that it was forked |

There is no runtime here: no shared state, no viewer identity, no stored assets,
no pinning, and a document stays until its owner deletes it. Ship a document that stands still, and
say what it cannot do.

## What you can publish

| Send | Through | What a reader gets |
|---|---|---|
| Markdown, `.md` or `.markdown` | `bikeshed publish`, or `publish_document` (its default) | One HTML page rendered on the server. `get_document` returns your Markdown |
| HTML, `.html` or `.htm` | `bikeshed publish`, or `publish_document` with `"format": "html"` | Your file, byte for byte |
| A `.zip` of several files | `bikeshed publish`, and `bikeshed update` to revise it. The tools take text | The files, with `index.html` or `index.md` at the root as the entry. One enclosing folder is fine |

Anything else is refused. An upload may be 25 MB, and a `.zip` 25 MB
uncompressed and at most 2,000 files. Markdown is read as UTF-8.

Without a title from you, a Markdown document is named by its first `#` heading
and an HTML one by its `<title>`; failing both, by the file name.

An update keeps the title. To change it, `bikeshed rename <id> <title>` or
`rename_document`, which takes the same edit rights as an update. The address
does not move, so links already sent keep working. An HTML document's own
`<title>` is part of its content and stays as written, and link previews show
that one: change it in the file too if it should match.

## Write Markdown unless you need HTML

Markdown is rendered server-side into a self-contained document with sections, a
print stylesheet and no external requests. `get_document` hands the **Markdown
source** back, so the round trip is lossless and your context does not fill with
somebody's stylesheet.

Reach for HTML when Markdown cannot say it: a slide deck, an inline diagram, a
layout.

### What Markdown renders, and what it does not

The renderer is markdown-it 14.3.3 (CommonMark) with tables, strikethrough and
task lists. Nothing else is added.

**Renders:** headings (each one opens a `<section>` with an id), tables,
`~~strikethrough~~`, `- [x]` task lists as disabled checkboxes, fenced code as
plain monospace with no syntax colouring, links, `<https://…>` autolinks,
images, and raw HTML, including `<svg>`, `<details>` and `<script>`.

**Shows as typed, unrendered:**

| You write | Readers see | Instead |
|---|---|---|
| YAML front matter | A horizontal rule and a heading reading `title: …` | Leave it out; pass the title |
| A `mermaid` or other diagram fence | The diagram's source in a code block | Render it to SVG and paste the `<svg>` in |
| `$…$` or `$$…$$` math | The dollar signs and the TeX | An SVG or image of the formula, or plain text |
| Footnotes `[^1]` | `[^1]`, and the note as a paragraph | A numbered list under a "Notes" heading |
| `==highlight==`, `H~2~O`, `x^2^`, `:emoji:` | The characters as typed | `<mark>`, `<sub>`, `<sup>`, the emoji itself |
| A definition list | One paragraph | A table, or bold terms |
| A bare URL | Unlinked text | `<https://…>` or `[text](url)` |
| A single newline | One continuous line | Two trailing spaces, or `\` |
| `![](data:image/svg+xml,…)` | The Markdown as typed | Raw `<img src="data:image/svg+xml,…">`, or PNG, JPEG, GIF or WebP data |

A block of raw HTML ends at the first blank line, and what follows is read as
Markdown again; only `<script>`, `<style>` and `<pre>` run to their closing tag.
So put a pasted `<svg>` inside a `<div>`, with no blank line anywhere in it, or
it breaks into paragraphs.

The page has a light theme and a print stylesheet. It has no dark mode and no
generated table of contents.

## The one rule that changes whether commenting works

**Every section needs an `id`.**

Comments anchor to the nearest ancestor carrying an `id`. Without one, every
highlight in the document anchors to `<body>` — so an edit anywhere shifts all
of them at once, and a comment about paragraph two ends up pointing at
paragraph nine.

In Markdown you get this free: each heading becomes a `<section>` with a slug
from its text. Just use headings.

In HTML, write them:

```html
<section id="rollout-plan">
  <h2>Rollout plan</h2>
  …
</section>
```

## Keep it to one file

No external URLs. Images, stylesheets and fonts from another site do load —
nothing blocks them — but each one tells that site when the document is read,
breaks when the site moves, and is missing from a download. A document is
something somebody will download, print, or open in three years, and every file
of a multi-file bundle is a separate authenticated request — a fifty-asset deck
costs fifty round trips per reader, and the same deck inlined costs one.

Inline the SVG, inline the CSS. Put images in `data:` URIs. Use system fonts, or
embed a font as a `data:` URI in `@font-face`.

If you genuinely need several files, send a `.zip` with `index.html` at its root,
and refer to its files by relative path: a path starting with `/` resolves
against the deployment, not your bundle.

## Publishing

```bash
bikeshed publish proposal.md --title "Storage migration" --json
# → {"docId":"storage-migration","versionId":"v1",
#    "url":"https://<deployment>/d/storage-migration", …}

bikeshed update storage-migration proposal.md
```

Over MCP the same two are `publish_document` and `update_document`, and they
return the same `url`. That is the address to hand back. `bikeshed open` is not
how to find it: it opens a browser, on whatever machine runs the command.

### Opening it

| Where you run | Do |
|---|---|
| On the person's own machine, with them there: Claude Code, Claude Desktop, Cursor, VS Code | Give the link, then open it: `bikeshed open <link>`, or your harness's own browser tool |
| In a cloud container, over SSH, in CI, on a schedule | Give the link. Never open it: a browser would start where nobody sees it |
| In a chat app: ChatGPT, Claude on the web or a phone | Give it as a clickable Markdown link |

`bikeshed open` takes the link itself, so an unlisted document's key goes with
it.

**Publishing identical content is a no-op.** The bytes are hashed; matching
bytes mint no new version. So `update` is safe to run in a loop, in CI, or after
a change you are not sure you made — it will tell you `no change` rather than
filling the history with duplicates. A change is refused while somebody has the
document open in the editor, where it would throw away their typing; try again
once they have left it.

**An update keeps the document's format, and what it replaces depends on what
you send.**

- **One `.md` or `.html` file**, through `bikeshed update` or `update_document`,
  replaces the entry. Every file beside it is kept, so you can revise a bundle's
  text from `get_document`'s source and its images and stylesheets stay where
  they were. Revise the whole source: `get_document` cuts one over 200,000
  characters and sets `truncated`, and an update made from a cut source
  publishes a version missing everything after the cut.
  `bikeshed get <id> > index.html` writes it whole.
- **A `.zip`**, through `bikeshed update`, replaces the whole bundle. A file the
  archive leaves out is gone from the new version. This takes somebody the
  document is shared with as an editor, not open editing.

```bash
bikeshed update platform-review deck.zip     # every file, from the archive
bikeshed update platform-review index.html   # the entry; the rest is kept
```

An update cannot switch a document between Markdown and HTML. Publish a new
document for that.

## Choose the id, every time

The address comes from the title unless you choose it: `--id platform-review`,
or `publish_document`'s `id`, publishes at `/d/platform-review` (lowercase
letters, digits and hyphens, up to 60 characters). Ids are one namespace for the
whole deployment and never change. So a generic title collides with documents
you cannot see, and the document lands at that id plus a few random characters,
for good. Always pass one.

- **Time-bound documents start with the date**: meeting notes, status and
  weekly updates, incident reviews, retrospectives, period reports.
  `2026-10-09-storage-migration-review`: the ISO form sorts by date. If the
  documents beside it use another date form, copy theirs.
- **Living documents get no date**: specs, proposals, handbooks. Qualify them by
  project instead: `billing-storage-migration`, not `migration`.
- **Never a bare generic word**: `proposal`, `notes`, `plan`, `draft`,
  `report`.
- **Take the date from the environment**, never from memory: `date +%F`, or the
  date your harness states. If you are unsure of it, leave it out.
- **A revision is an update, not a new dated copy.** A better title is
  `bikeshed rename`, and the id stays.

A taken id still publishes, with the random characters added. The CLI says so on
stderr; over MCP, the result's `idTaken` does, beside the `requestedId`. Either
way, tell the person, and hand back the `url` in the result rather than an
address you built yourself.

## Where it is filed

Filing a document into a folder shares it with everyone that folder is shared
with, and nobody is emailed. You are the only one who can tell the person who
just gained access.

So, for every new document:

1. **Look first.** `bikeshed folders` (`list_folders`) lists every folder you
   can see, with how many people can read each. Find the deepest one whose
   path matches the project, client, team or kind of document.
   `list_documents` shows what is already filed there (`filedIn`) and how it is
   named.
2. **Decide by who can read it:**

   | The folder | Do |
   |---|---|
   | Only the person can read it (`shared` is false), or it is the root | File it and publish |
   | Others can read it | `get_folder`, then ask before publishing, naming them: "I'd file this in `Engineering/Reviews`. That makes it readable by 7 people: ana@, bo@, cy@ and the Platform team. Publish there?" |

   Skip the question only when the person already named the folder, or the
   people it is for. A folder you made yourself is no exception: one made inside
   a shared folder is shared too, and the person may have shared it since.
3. **Say where it went**, in the same reply as the link, from the result's
   `access`. If it is at the root, say why.
4. **Do not tidy.** Moving a document someone else filed changes who can read
   it.

From a shell, `bikeshed folders` shows how many can read each folder, and
`bikeshed folder <id>` names them. `bikeshed publish` prints where the document
went and who can read it there.

`--folder` on `publish`, or `publish_document`'s `folder`, files it in one call.
The `bikeshed-folders` skill has the rest.

## A document may expire

`list_documents` and `get_document` report `expiresAt` — epoch milliseconds, or
null for a document that does not expire. After that moment it is **read-only,
and readable only by its owner**: it will answer you as though it does not
exist, and `update_document` will refuse it.

Nothing has been deleted when that happens. The versions, the comments and the
bytes all survive, and the owner can move the date or clear it — so if you need
an expired document, ask, rather than republishing its content as a new one and
leaving two documents where there was one.

Owners can set, extend or clear expiry with `set_document_visibility`; see
`bikeshed-permissions`. Omitted settings stay unchanged.

## Scripts run only if somebody vouched for them

Everything you publish through a token is sandboxed, exactly like a browser
upload: its scripts do not run until a person trusts it in the app. A raw
`<script>` in Markdown is treated the same way as one in HTML.

Only a person in the browser can trust a document: one of the deployment's
administrators for every reader, on a document they own, or any reader for
their own browser only. A token cannot. Once trusted, JavaScript works as it
would anywhere else.

**Every new version sandboxes it again.** Trust covers the scripts a person
saw, so any new version withdraws it, the administrator's and every reader's,
until somebody trusts it again: yours through a token, and an edit in the app,
the owner's included. Older versions never run their scripts. An update that
changes nothing keeps it. So when you revise a document whose scripts matter,
say in your reply that it needs trusting again.

So if your document needs its own JavaScript, say so in the text — a reader
looking at an empty box should know why — and tell the owner what the script
does. Whether to trust it is their decision; do not ask them for it. A
`<noscript>` element is shown while the document is sandboxed, so it is the
place to say what is missing.

### What runs and what loads in HTML

| In the document | Sandboxed (the default) | Trusted, by an administrator for everyone or by a reader for themselves |
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

Declare `<meta charset="utf-8">`. HTML is served without a charset, and a
browser left to guess may garble anything outside ASCII.

### Slide decks

The viewer shows a slide rail and keyboard navigation when it finds a run of
sibling slides: elements with the class `slide`, `<section>`s carrying
`data-title`, sibling `<section>`s that share a class or all carry an `id`, or
Marp's output. Slides are read in document order. Each one is named by its
`data-title`, else its first `h1`–`h3`. Write the slides into the HTML: a deck
that builds them with JavaScript stays empty until somebody trusts it.

## What happens next

Share with additional readers when authorized, using `bikeshed-permissions`.
Then watch for what comes back, and answer it: the
`bikeshed-feedback` skill.

### Previous versions and write guards

Use `list_versions({id, limit:20, cursor})` or `bikeshed versions <id|link>
--all --json` to discover published history. Pages are newest first, default 20,
maximum 50; pass `nextCursor` as `cursor` until null. Each row has a pinned URL.
History uses the document's current access rules and expiry. A missing or
withdrawn version is an error, never a request for the latest version.

Read a chosen version with `get_document({id, version:"v2"})` and
`get_comments({id, version:"v2", includeResolved:true})`, or
`bikeshed get <id> --version v2` and `bikeshed comments <id> --version v2 --all`.
Read results name `currentVersion` and `isCurrent`; historical write capabilities
are false. Existing comments and suggestions remain readable as an archive.
Older versions cannot be edited or receive, revise, delete, reply to, resolve,
reopen, accept, reject, claim or withdraw feedback. Fork one to make a new,
independent document with `fork_document({id, version:"v2"})`.

CLI `get`, `comments`, `fork`, and `open` preserve a version in a pasted
`/d/<id>/<version>?k=...` URL. Feedback commands also preserve it as a write
guard. `--version` must agree with the URL; conflicts fail. Keys are retained.
Document-wide sharing, folder and lineage operations still address the document.

Before changing feedback, read the latest version and its feedback, then pass
that `version` to every feedback tool (`--version` in the CLI). Pass
`baseVersion` to `update_document` and `commit_draft` (`--base` on `bikeshed
update` and `bikeshed commit`). A versioned URL supplies the CLI base too.
If the head changes, the server refuses the write. Read the new head and
reassess the request; never silently redirect a historical request to it.
