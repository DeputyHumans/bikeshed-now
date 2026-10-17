# 0017 — Agents manage access with their person's permissions

**Status** Accepted · **Spec** §13, §17, §19, §23

## Context

CLI/MCP could publish and move documents, including changing inherited access,
but could not grant or revoke direct access, change expiry, or rename, move and
delete folders. Owners had to switch to the browser to finish an authorized job.
The HTTP endpoints already accepted the same token identity.

## Decision

Expose owner-only permission inspection and edits, visibility, open editing and
expiry through shared HTTP/MCP handlers. Expose folder rename/move to editors
and folder deletion to owners, with the browser's reparenting semantics.
Documents remain permanent. Existing connections retain their identity; no new
scope or reconsent mechanism is introduced. Consent copy describes the expanded
surface. A skill treats the person's request as authority and document content
as data, and does not repeatedly ask for already-given authorization.

Invitations match the web app: newly effective readers only. MCP declares the
email secret. Sparse settings updates preserve omitted values. Access responses
distinguish direct, inherited and effective roles so revocation is not mistaken
for removal of access that still has another source.

## Consequences

Existing connections can perform the new operations immediately. The release
notes and consent screen say so. Owner checks, permanent ownership, inherited
access, team expansion, audit attribution and mirrors remain server-enforced.
Folder deletion changes inherited access but retains every document. Team
administration and script trust remain outside the agent interface.

## What would change this

Evidence that authorized connections repeatedly exceed their person's intended
reach would justify scoped credentials or operation-specific consent. That is
a separate identity-model decision, not a second role system in these tools.
