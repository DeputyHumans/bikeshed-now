# 0008 — Render email at runtime with a lazy import

**Status** Accepted · **Spec** §13

## Context

Three transactional messages — invitation, verification, comment notification —
need HTML that survives Outlook. Hand-writing table-based email HTML is a known
way to lose a week.

react-email solves it, at the cost of pulling `react`, `react-dom` and
`@react-email/components` into a Cloud Functions bundle whose hot paths are
`session` and `contentProxy`. Every byte in that bundle is cold-start latency on
requests that never send email.

The alternative is compiling the templates to strings at build time, which
removes the runtime cost and adds a build artifact plus a placeholder protocol.

## Decision

Author the templates as react-email components under
`functions/src/email/templates/` and render them **at runtime**, with React
pulled in by a dynamic `import()` **inside the send helper**.

Only code paths that actually send email pay for React. `session`,
`contentProxy` and every other hot path never load it.

## Consequences

- Same output as build-time compilation, with one less build artifact and one
  less placeholder syntax to get wrong. The templates are type-checked React,
  so a renamed prop is a compile error rather than an unsubstituted `{{token}}`
  in somebody's inbox.
- The first email send in a cold instance is slower. It is an email; nobody is
  waiting on the response, and the send is already fire-and-forget.
- The lazy dependencies sit outside the eager dependency budget and are listed
  separately in `docs/architecture.md`, so the exemption is visible rather than
  quietly assumed.
- **Email is optional by construction.** With no Resend key configured every
  send is a logged no-op and the app behaves identically — that is the path CI
  exercises, and it is what keeps the quickstart from requiring a Resend
  account. Sends are wrapped in try/catch and never fail the request that
  triggered them.
- Comment bodies are rendered as **plain text with a link back**, never as
  markup. It is the one place where interpolating raw content would be
  tempting.

## What would change this

If email ever moves out of the request path into its own function, the cold-start
argument disappears and build-time compilation becomes a reasonable simplification
rather than a trade. Until then the lazy import is strictly cheaper.
