# bikeshed

Publish a document to a [Bikeshed](https://bikeshed.now) deployment, then read
the comments people left on it — each one with the exact sentence it is about.

It talks to [bikeshed.now](https://bikeshed.now) over HTTPS, with a personal
access token that carries exactly your own permissions. Bikeshed is also
self-hostable: point the client at your own deployment and everything below
works the same, with your address in place of `https://bikeshed.now`.

```bash
npm i -g bikeshed-now
bikeshed login            # signs you in through your browser
```

`login` opens your browser at the deployment. Sign in if you need to, click
Approve, and the terminal saves a token that only you can read. It prints the
link as well, for when no browser opens. Pass `--origin <url>` for your own
deployment, or `--no-browser` to open the link yourself. An agent can run
`npx -y bikeshed-now login` for you: you approve in your browser, and the token
never appears in its output.

The browser has to be on the same computer as the terminal, because it hands
the sign-in back to a port on `127.0.0.1`. Over SSH, or against a deployment
too old to offer browser sign-in, create a token at
[bikeshed.now/account](https://bikeshed.now/account), choose **Command line**,
and run `bikeshed login --paste`. The token is shown once. In CI, set
`BIKESHED_ORIGIN` and `BIKESHED_TOKEN` instead of running `login` at all; they
outrank whatever `login` saved.

`bikeshed logout` signs this computer out. It revokes a token from browser
sign-in as well as deleting it. A pasted token is only deleted, because CI may
be using the same one: revoke it at `/account` once nothing needs it.

## The loop

```bash
bikeshed publish proposal.md --title "Storage migration"
# published storage-migration v1 — https://bikeshed.now/d/storage-migration

# Somebody highlights a sentence and says what is wrong with it.
bikeshed comments storage-migration

# Fix that sentence, say what you changed in its thread, then publish the
# revision. Reply first: a thread belongs to the version it was written on.
bikeshed reply storage-migration <thread> "Rewritten to describe the dual-write period."
bikeshed resolve storage-migration <thread>   # closes it, with a note saying you did
bikeshed update storage-migration proposal.md

# Given "Can suggest" rather than "Can edit"? Propose the change instead, for a
# person to accept or reject.
bikeshed suggest storage-migration "a single weekend" --with "two weekends"

# Own the document, or can approve on it? Decline somebody's suggestion, with
# the reason its author will be sent.
bikeshed reject storage-migration <thread> --reason "Already in section 3."

# Something nobody has raised yet? Start a thread on the passage it is about.
bikeshed comment storage-migration "a single weekend" --body "Is the dual-write fortnight in this?"
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

A rename changes the title and leaves the address alone, so links already sent
keep working:

```bash
bikeshed rename 01-platform Platform review, second pass
```

Wherever a command takes an id, it also takes the link you were sent. An
unlisted document you are not a member of needs the link, because its key is in
it; without the key the document answers as an id that does not exist.

```bash
bikeshed comments 'https://bikeshed.now/d/build-estimate?k=…'
```

`bikeshed --help` lists the rest — listing documents, folders, and installing the
agent skills a deployment serves.

## Forking

To revise a document you can read but do not own, fork it. You get your own
private copy, at the version you name or the current one, and it remembers what
it was forked from.

```bash
bikeshed fork 'https://bikeshed.now/d/build-estimate?k=…'
# forked build-estimate into build-estimate-x7k2p9 — https://bikeshed.now/d/build-estimate-x7k2p9
bikeshed lineage build-estimate-x7k2p9
# forked from  build-estimate v3  Build estimate   (changed since)
```

`lineage` shows each original you can open, nearest first, and whether the
nearest has changed since you forked it. On a document you own it also counts
its forks. The author of what you fork sees that it was forked — a count, never
who.

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
