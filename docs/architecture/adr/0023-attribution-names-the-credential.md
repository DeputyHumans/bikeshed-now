# 0023 — Attribution names the credential, not the endpoint

**Status** Accepted · **Spec** §2, §17, §19, §23 · **Amends** [0016](0016-a-change-log-an-agent-pulls.md)

## Context

Everything that acts on a document is stamped with an actor whose `channel` was meant to answer "a person or an agent, and which" (SPEC §17). In practice it could not tell the three ways an agent arrives apart:

- `/mcp` stamped `mcp` on every credential it verified. The CLI calls `/mcp` for most commands, so `bikeshed update notes.md` read `mcp` while `bikeshed update site.zip` read `cli`, and `bikeshed publish` read `upload` with channel `cli`. One person at one terminal produced three different records.
- A personal token pasted into an MCP client, the CLI, and an app connected by signing in (Claude, for instance) all read `mcp`. Only `tokenId` told them apart, and co-editors cannot resolve a token id, because tokens are their owner's alone.
- `publishedVia` held both how the content arrived (upload, editor, fork) and the channel, so it could say only one of them: an agent's commit of a draft read `mcp`, a fork lost its channel.

The Activity panel showed none of this anyway. It listed reading sessions and access changes, and never who published a version. The change log that `get_changes` reads (ADR 0016) records every change, but "does not feed this panel".

## Decision

1. **The channel is the credential's, on every endpoint.** A personal token reads as what it was minted for (`cli`, `mcp`, `api`), `/mcp` included. An app connected by signing in reads `app`. The operator scripts read `operator`, not `cli`. The `/mcp` override is gone.
2. **The credential is also stored in words, when it acts.** `via` is written once by the server and kept with the action: `CLI on mbp`, `CLI token “deploy-bot”`, `personal token “laptop agent”`, `“Claude” (connected app)`, `an operator script`. Revoking or renaming a token later does not rewrite history. App names are the app's own claim, so they are always quoted and marked as an app.
3. **How a version arrived is its own field.** `origin` is `upload`, `edit` or `fork`. `publishedVia` stays, derived from `origin` and the channel by one function, so the two can no longer disagree.
4. **The change log feeds the Activity panel.** `GET /activity` merges the log with the reading sessions, editors only, rendered by the same code as `get_changes`. In every tool `via` means the words and `channel` the kind; `get_comments` used to call the channel `via`.
5. **`/activity` rides on the `recordView` function.** A new function needs a public invoker grant that a deploy can fail to make with nothing to notice it.

## Consequences

- Records written before this release keep what they say: a CLI comment from last week still reads `mcp`, with no `via`. The UI gives an old channel plain words ("MCP"). Nothing is relabelled.
- An agent that filtered `get_comments` on `via === "mcp"` breaks: `via` is now the label, and `channel` is the kind. The changelog says so.
- A token's name is shown to the document's editors, and to its readers on comments. A name is the owner's own label, and the forensic `tokenId` is still never shown. A member learns which of a person's credentials acted; a link holder is never told by `list_versions`.
- A CLI token pasted into another MCP client reads as the CLI. The credential is still the person's own, and `tokenId` still finds everything it did.
- The panel now costs one function call per page instead of three Firestore queries, and pages exactly across rows that share a timestamp.

## What would change this

Evidence that people need to know which *program* acted rather than which credential: two tools sharing one token and needing to be told apart. That is the self-reported `client` header's job, which stays self-reported; making it trustworthy would need per-client credentials, a separate identity-model decision.
