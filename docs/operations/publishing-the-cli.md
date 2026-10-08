# Publishing the terminal client

`cli/` is published to npm as **`bikeshed-now`**, which provides the `bikeshed`
command. It is the only part of this repository that is published anywhere, and
it is separate from deploying: a deployment serves documents, the package is how
somebody reaches one from a terminal — or how an agent installs the skills, since
`https://<deployment>/llms.txt` tells it to run `npx -y bikeshed-now`.

That instruction is served to agents, so the package existing is not optional
once it has been named.

## Before the first publish

An npm account with 2FA, added to the package as an owner. `npm whoami` should
answer. Node 24, as everywhere here.

The first publish claims the name. It is the one step that cannot be rehearsed,
so read the file list before running it.

## What ships

Three source files and no dependencies. `files` in `cli/package.json` is an
allowlist, not an ignore list — nothing is published because somebody forgot to
exclude it. `prepack` copies `LICENSE` and `NOTICE` in (both gitignored, so the
tree keeps one copy of each) and `postpack` removes them again.

`cli/test/cli.test.mjs` asserts the package is not private, has no runtime
dependencies, and still has a README. A dependency is the expensive regression:
`npx -y bikeshed-now` is in an instruction an agent follows, and one dependency
turns a one-second bootstrap into a tree resolution.

## The recipe

```bash
npm run verify                  # from the root, as for any change
cd cli && npm pack              # READ the file list it prints
npm i -g --prefix /tmp/bshd ./bikeshed-now-<version>.tgz
/tmp/bshd/bin/bikeshed --help   # the binary runs from a real install
rm -rf /tmp/bshd cli/*.tgz

npm publish                     # publishConfig already says access: public
```

Then, from an empty directory on a machine that has never installed it:

```bash
npx -y bikeshed-now --help
```

The package name and the command differ, and npx resolves the sole binary
regardless — verified against a local install, but only a published package
proves the registry path. Do that check once, after the first publish.

## Never

**Never publish from the root.** It is `private` deliberately. A root publish
would ship the app, the functions, and whatever untracked local files are not
excluded — including the ones holding the deployment's real configuration.

**Never unpublish.** npm's removal window exists, but taking a version back
breaks everyone who already installed it. Publish a patch, and
`npm deprecate bikeshed-now@<version> "<why, and what to use instead>"`.

## Versions

Semver, and a `CHANGELOG.md` entry in the same commit. The published version and
the deployment are independent: an older client talking to a newer deployment is
the normal case, which is why `bikeshed skills install` fetches the skills from
the deployment rather than bundling them.

Bumping the version touches `CLIENT_NAME` in `cli/src/client.mjs` — the
`X-Bikeshed-Client` value stamped on every request and shown in activity feeds —
and the fixtures in `functions/test/provenance.test.js` that spell it.

`docs/agents/agent-guide.md` names the package, and `functions/test/skills.test.js`
asserts it matches `cli/package.json`, so a rename fails the build until the guide
is regenerated with `npm run build:agents`.

## One thing to know

`cli/src/config.mjs` defaults the origin to the public deployment. Somebody who
installs the package and runs a command without configuring anything talks to
that host — deliberate, since it is the deployment the package is named after,
but worth knowing before the name is public.
