# 0002 — Two trust scopes: global and personal

**Status** Amended by [0021](0021-a-documents-script-runs-only-with-consent.md) · **Spec** §6c

## Context

[0001](0001-same-origin-iframe.md) makes running an untrusted document's scripts
a genuine risk: same-origin scripts could read the app's auth state. So scripts
are off until somebody vouches. The question is *who*, and *for whom*.

One scope is not enough, and the two obvious single-scope designs each fail:

- **Owner-only, global.** A reviewer who needs the document's scroll navigation
  to work is stuck until the owner is online.
- **Anybody, global.** Any member could enable scripts for every other reader.
  That is privilege escalation with extra steps.

## Decision

Two scopes, stored separately, never collapsed:

| | Where | Who writes | Affects |
|---|---|---|---|
| **Global** | `docs/{docId}.trusted` | owner only | every reader |
| **Personal** | `docs/{docId}/trust/{uid}` | that user only | that user only |

The effective trust for a reader is `global || personal`. A personal grant
**never** writes the global flag. Both fail closed: a missing or unreadable
record means untrusted.

The prompt appears only when the frame is sandboxed **and** the document's DOM
actually contains a `<script>`. A static document never asks, which is what
keeps the prompt meaningful when it does appear.

## Consequences

- One extra collection and one extra rule, both trivially statable:
  `trust/{uid}` is readable and writable by `{uid}` alone.
- A reviewer unblocks themselves without acquiring the power to unblock anybody
  else. That asymmetry is the whole point.
- Forking a document resets `trusted` to false, because the fork has a new
  owner who has not vouched for anything.
- A vouch covers the scripts that were vouched for. Every new version, the owner's own commit in the app included, withdraws both scopes in the transaction that makes it current, and only the current version runs (SPEC §6c). Trust used to carry across in-app edits on the claim that editing cannot add a script; the server never enforced that, so an open editor could run code in every reader's session. Until 0.32.0 it still carried when the owner committed, but a draft is shared, so an editor's script rode in on the owner's commit. The cost is that a trusted interactive document has to be vouched for again after every edit.
- Two states to reason about instead of one. Mitigated by the dialogue naming
  the scope explicitly — "for everyone" versus "for me" — rather than offering
  a single ambiguous "Trust".

## What would change this

If documents ever gain a verified publisher identity — a signature over the
bundle, checked at publish time — global trust could be derived rather than
granted, and the personal scope would become a fallback for unsigned content
instead of a routine action.
