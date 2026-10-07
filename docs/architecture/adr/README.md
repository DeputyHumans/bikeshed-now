# Architecture decision records

Thirteen decisions that a newcomer would otherwise re-argue in a pull request, each
about thirty lines: what was decided, what it costs, and what would make it
wrong. An ADR is cheap. Re-arguing a decision without one is not.

They are **historical records, not documentation**. `docs/architecture/spec.md` is normative
and wins over anything here. When a decision is reversed, the ADR is marked
superseded rather than edited — the point is to preserve the reasoning that was
actually available at the time.

| | Decision | Status |
|---|---|---|
| [0001](0001-same-origin-iframe.md) | Render documents in a same-origin iframe | Accepted |
| [0002](0002-two-scope-trust.md) | Two trust scopes: global and personal | Accepted |
| [0003](0003-server-side-markdown.md) | Compile Markdown on the server, once per version | Accepted |
| [0004](0004-email-keyed-acl.md) | Key the ACL by verified email, not uid | Accepted |
| [0005](0005-generated-rules.md) | Generate the security rules from one policy file | Accepted |
| [0006](0006-denormalized-members.md) | Denormalize membership into a flat array | Accepted |
| [0007](0007-execcommand-over-schema-editor.md) | Edit with `execCommand`, not a schema editor | Accepted |
| [0008](0008-runtime-email-rendering.md) | Render email at runtime with a lazy import | Accepted |
| [0009](0009-hand-written-mcp.md) | Hand-write the MCP server instead of using the SDK | Accepted |
| [0010](0010-crdt-for-shared-document-state.md) | Merge shared document state with a CRDT | Accepted |
| [0011](0011-document-page-through-a-function.md) | Serve the document page through a function | Accepted |
| [0012](0012-unlisted-needs-its-link.md) | An unlisted document needs its link, everywhere | Accepted |
| [0013](0013-suggestions-applied-as-an-edit.md) | Suggestions are text, applied as an edit in the approver's browser | Accepted |

## Format

**Context** — what forced a choice. **Decision** — what was chosen, stated so it
can be checked against the code. **Consequences** — including the bad ones.
**What would change this** — the observation that should make somebody reopen it.

That last section is the one that matters. A decision with no stated reversal
condition is a decision nobody can ever revisit honestly.
