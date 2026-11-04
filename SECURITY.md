# Security policy

## Reporting a vulnerability

Report it privately, either through [GitHub](https://github.com/DeputyHumans/bikeshed-now/security/advisories/new) or by email to **info@bikeshed.now**. Please do not open a public issue for anything that lets someone read a document they should not.

Include what you can: the version or commit, what you did, what happened, and
what you expected. A minimal reproduction is worth more than a long description.
If you are unsure whether something is a vulnerability, report it anyway — a
wrong guess costs us a few minutes.

You will get an acknowledgement within 72 hours and an assessment within seven
days. We will tell you what we decided and when we expect a fix. If we disagree
that it is a vulnerability, we will explain why rather than going quiet.

We will credit you in the release notes unless you would rather we did not.

## Testing

Test against your own copy. The emulators need no account and no card, and `README.md` gets you running in five commands. Please do not test against `bikeshed.now`: it holds other people's documents. If a finding can only be shown on a real deployment, ask first at the address above.

## Scope

In scope: anything that lets a caller read, write or enumerate content they are
not entitled to; anything that escapes the untrusted-content sandbox; anything
that lets a client forge provenance; anything that lets one account act as
another.

Out of scope: findings that require a malicious deployment operator (they own
the data already), denial of service through sheer volume (see below),
self-XSS, missing headers with no demonstrated impact, and reports produced by a
scanner with no analysis attached.

## What this project deliberately does not defend against

Stated plainly, because "not built" is a decision and not an oversight:

- **Rate limiting.** Public documents are cacheable at the CDN, which is the
  primary cost defence. There is no application-level rate limiter. Firebase App
  Check is the documented hook if abuse materializes.
- **A malicious editor on a trusted document.** An owner who grants edit rights
  grants the ability to commit content, and a trusted document runs its own
  scripts for every reader. This is an owner-gated, deliberate relaxation of the
  sandbox — see `docs/architecture/threat-model.md`.
- **A bundle blanking its own export.** The export marking is locked against
  every CSS hiding vector, but a document can render itself empty. That is
  self-defeating and leaks nothing.
- **Unique-visitor identification.** Anonymous reading sessions are counted;
  the people behind them are not. No IP, no fingerprint. This is a privacy
  floor, and it means anonymous abuse is not attributable.

## Supported versions

The `main` branch and its latest `vX.Y.Z` tag are supported, along with the latest `bikeshed-now` CLI on npm, which is versioned on its own. This project has not cut a maintenance release line; a fix lands on `main` and in the next tag.
