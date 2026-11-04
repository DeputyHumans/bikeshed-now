# 0017 — Agents manage access with their person's permissions

**Status** Accepted · Amended by [0024](0024-deletion-goes-through-a-trash.md): deleting a folder moves it to the Trash with its contents, and documents can be trashed and restored · Amended in 0.32.0: moving a document or folder is its owner's · **Spec** §13, §17, §19, §23

## Context

CLI/MCP could publish and move documents, including changing inherited access,
but could not grant or revoke direct access, change expiry, or rename, move and
delete folders. Owners had to switch to the browser to finish an authorized job.
The HTTP endpoints already accepted the same token identity.

## Decision

Expose owner-only permission inspection and edits, visibility, open editing and
expiry through shared HTTP/MCP handlers. Expose folder rename to editors,
and folder moves and deletion to owners, with the browser's reparenting semantics.
*Amended in 0.32.0:* moves were first given to editors, of documents and
folders alike. Moving decides who may read, since a folder's readers, link and
public level reach what is filed in it, so an editor could file the owner's
document into a folder of their own and share or publish it. Moving is now the
owner's, as sharing is.
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
