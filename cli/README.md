# bikeshed

Publish a document to a [Bikeshed](https://bikeshed.now) deployment, then read
the comments people left on it — each one with the exact sentence it is about.

It talks to [bikeshed.now](https://bikeshed.now) over HTTPS, with a personal
access token that carries exactly your own permissions. Bikeshed is also
self-hostable: point the client at your own deployment and everything below
works the same, with your address in place of `https://bikeshed.now`.

```bash
npm i -g bikeshed-now
bikeshed login            # asks for the deployment and a token
```

Create a token at [bikeshed.now/account](https://bikeshed.now/account) — choose
**Command line**. It is shown once. `BIKESHED_ORIGIN` and `BIKESHED_TOKEN` work
instead of `login` where an interactive command cannot run — a CI job, or an
agent.

## The loop

```bash
bikeshed publish proposal.md --title "Storage migration"
# published storage-migration v1 — https://bikeshed.now/d/storage-migration

# Somebody highlights a sentence and says what is wrong with it.
bikeshed comments storage-migration

# Fix that sentence, publish the revision, and say what you changed.
bikeshed update storage-migration proposal.md
bikeshed reply storage-migration <thread> "Rewritten to describe the dual-write period."
```

Publishing identical bytes is a no-op: the bundle is hashed, and a matching hash
mints no new version. So `update` is safe in a loop, in CI, or after a change you
are not sure you made.

A document of several files is a `.zip` with `index.html` or `index.md` at its
root. `update` with a `.zip` replaces every file; `update` with one `.md` or
`.html` replaces the entry and keeps the images and stylesheets beside it.

The address comes from the title. To choose it, pass `--id`:

```bash
bikeshed publish platform.md --id 01-platform
# published 01-platform v1 — https://bikeshed.now/d/01-platform
```

If the id is taken, the document is still published, at the id plus a few
random characters, and the CLI says so on stderr.

Wherever a command takes an id, it also takes the link you were sent. An
unlisted document you are not a member of needs the link, because its key is in
it; without the key the document answers as an id that does not exist.

```bash
bikeshed comments 'https://bikeshed.now/d/build-estimate?k=…'
```

`bikeshed --help` lists the rest — listing documents, folders, and installing the
agent skills a deployment serves.

## Sharing is not automated

There is no command that shares a document, changes who can read it, or sets an
expiry. Those are decisions a person makes in the interface, deliberately.

## For agents

A deployment serves its own instructions at
[`https://bikeshed.now/llms.txt`](https://bikeshed.now/llms.txt), and the skills
behind them at `/skills/index.json`. `bikeshed skills install <dir>`
writes them where your harness reads skills from.

Everything done with a token is stamped with the channel it came through, so a
reviewer can always tell which feedback came from a person.

## Licence

Apache-2.0. The deployment it talks to is the same repository:
[DeputyHumans/bikeshed-now](https://github.com/DeputyHumans/bikeshed-now).
