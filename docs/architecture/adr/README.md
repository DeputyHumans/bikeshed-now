# Architecture decision records

Twenty-six decisions that a newcomer would otherwise re-argue in a pull request, each
about thirty lines: what was decided, what it costs, and what would make it
wrong. An ADR is cheap. Re-arguing a decision without one is not.

They are **historical records, not documentation**. `docs/architecture/spec.md` is normative
and wins over anything here. When a decision is reversed, the ADR is marked
superseded rather than edited — the point is to preserve the reasoning that was
actually available at the time.

| | Decision | Status |
|---|---|---|
| [0001](0001-same-origin-iframe.md) | Render documents in a same-origin iframe | Accepted |
| [0002](0002-two-scope-trust.md) | Two trust scopes: global and personal | Amended by 0021 |
| [0003](0003-server-side-markdown.md) | Compile Markdown on the server, once per version | Accepted |
| [0004](0004-email-keyed-acl.md) | Key the ACL by verified email, not uid | Amended by 0020 |
| [0005](0005-generated-rules.md) | Generate the security rules from one policy file | Accepted |
| [0006](0006-denormalized-members.md) | Denormalize membership into a flat array | Accepted |
| [0007](0007-execcommand-over-schema-editor.md) | Edit with `execCommand`, not a schema editor | Accepted |
| [0008](0008-runtime-email-rendering.md) | Render email at runtime with a lazy import | Accepted |
| [0009](0009-hand-written-mcp.md) | Hand-write the MCP server instead of using the SDK | Accepted |
| [0010](0010-crdt-for-shared-document-state.md) | Merge shared document state with a CRDT | Accepted |
| [0011](0011-document-page-through-a-function.md) | Serve the document page through a function | Amended by 0018 |
| [0012](0012-unlisted-needs-its-link.md) | An unlisted document needs its link, everywhere | Extended by 0019 |
| [0013](0013-suggestions-applied-as-an-edit.md) | Suggestions are text, applied as an edit in the approver's browser | Amended by 0015 |
| [0014](0014-oauth-for-the-agent-surface.md) | Apps connect by signing in: OAuth 2.1 beside personal tokens | Amended by 0026 |
| [0015](0015-agents-decide-as-approvers.md) | An agent decides with its owner's role | Accepted |
| [0016](0016-a-change-log-an-agent-pulls.md) | A change log an agent pulls, one per document | Amended by 0023 |
| [0017](0017-agent-management-with-owner-permissions.md) | Agents manage access with their person's permissions | Amended by 0024; amended in 0.32.0 |
| [0018](0018-keep-the-document-open-path-warm.md) | Keep the document-open path warm | Accepted |
| [0019](0019-folder-links-reach-their-subtree.md) | A folder's link reaches everything beneath it, to read | Accepted |
| [0020](0020-an-account-follows-its-google-address.md) | An account follows the address Google renames it to | Accepted |
| [0021](0021-a-documents-script-runs-only-with-consent.md) | A document's script runs only with its reader's consent | Amended in 0.32.0 |
| [0023](0023-attribution-names-the-credential.md) | Attribution names the credential, not the endpoint | Accepted |
| [0024](0024-deletion-goes-through-a-trash.md) | Deletion goes through a Trash | Accepted, amended by 0025 |
| [0025](0025-the-trash-empties-on-one-daily-job.md) | The Trash empties on one daily job, or sooner with an emailed code | Accepted |
| [0026](0026-an-organisation-may-connect-its-people.md) | An organisation's issuer may connect its people's apps, if the deployment trusts it | Accepted |
| [0027](0027-a-reader-lists-their-own-reading.md) | A reader lists their own reading, across documents | Accepted |

## Format

**Context** — what forced a choice. **Decision** — what was chosen, stated so it
can be checked against the code. **Consequences** — including the bad ones.
**What would change this** — the observation that should make somebody reopen it.

That last section is the one that matters. A decision with no stated reversal
condition is a decision nobody can ever revisit honestly.
