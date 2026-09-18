# 0006 — Denormalize membership into a flat array

**Status** Accepted · **Spec** §4, §18

## Context

The workspace is one query: every document this person can see, live-updating,
sorted. Access comes from three sources — a direct grant on the document, a
grant inherited from an ancestor folder, and a grant to a team the person
belongs to.

Firestore has no joins. A rule cannot follow a reference to a folder, and it
cannot enumerate a caller's teams. Whatever the workspace query filters on has
to be a field on the document itself.

There is a harder constraint underneath. A Firestore `list` rule is only valid
if it is **statically provable** from the query's own constraints — the rules
engine must be able to decide, without reading any document, that the query
cannot return something the caller may not read. That is only true for a query
shaped `where("members", "array-contains", <the caller's own email>)`.

## Decision

`members[]` and `editorMembers[]` are **denormalized flat arrays of emails**,
recomputed server-side whenever anything that feeds them changes.

Grants keep their structure — `viewers[]` and `editors[]` hold plain emails
*and* `team:{teamId}` entries, so "the Design team can view this" stays legible.
The server expands them at write time into the flat sets.

Six paths recompute: `createDoc`, `duplicateDoc`, `setAccess`, `organize`,
`recomputeSubtree` in `folders.ts`, and the operator scripts. All six call one
`computeMembership`, which has an exact ESM twin in `scripts/lib/membership.mjs`
held in agreement by a parity test.

## Consequences

- One query, one composite index, one provable `list` rule — the most
  security-critical rule in the file, and it stays a single line.
- **Writes fan out.** A folder re-share or a team membership change is one write
  per affected document, through a batched BFS. A 50-person team granted on 200
  documents is 200 writes: a batch, not a job queue. Fine for a small team,
  stated here so nobody is surprised at ten thousand documents.
- Revocation correctness depends entirely on every path recomputing. The
  predecessor's `set-access` script wrote `members` *without* the parent
  folder's members and thereby silently revoked every inherited reader. That is
  why the twin exists and why parity is a test rather than a convention.
- Team ids never reach `members`, so the public projection carries no team
  names, the presence mirror needs no change, and a personal access token picks
  up team access for free.

## What would change this

Nothing short of Firestore supporting a provable rule over a joined or derived
value. The alternative considered — team ids in `members` matched against a
custom claim — works for `get` and breaks `list`, which is the query the entire
workspace depends on.
