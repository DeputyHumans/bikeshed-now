# 0009 — Hand-write the MCP server instead of using the SDK

**Status** Accepted · **Spec** §19 · **Deviates from** the implementation plan

## Context

The agent surface needs an MCP endpoint: six tools over streamable HTTP, one
Cloud Function, one rewrite. The plan named `@modelcontextprotocol/sdk` and
counted it inside the functions dependency budget of ten.

The SDK requires **`zod` as a peer dependency**. That is two packages, not one,
and the second is a validation library this codebase has no other use for —
tool arguments are validated by hand today because there are six of them.
Taking it would have put the runtime over budget for a surface that is, on the
server side, small and fully specified.

The relevant asymmetry: the SDK's value is concentrated in the **client** half
of MCP — transport negotiation, session management, sampling, reconnection. The
**server** half of streamable HTTP is a JSON-RPC 2.0 request arriving by POST
and a JSON-RPC response going back.

## Decision

Implement the server directly. `functions/src/mcp/server.ts` is about 200 lines
with **zero dependencies**: five methods (`initialize`, `notifications/initialized`,
`tools/list`, `tools/call`, `ping`), the standard JSON-RPC error codes, and
`PROTOCOL_VERSION` pinned to `2025-06-18`.

Deliberately not implemented: server-sent events (no tool here streams),
sessions (every request carries its own credential), and sampling, roots and
prompts (nothing would use them).

## Consequences

- The functions runtime stays at **nine** eager dependencies, one under budget,
  rather than eleven.
- The entire wire protocol is visible in one file. A reader can see what the
  endpoint accepts without reading a framework.
- **Protocol changes are ours to follow.** That is the real cost, and it is
  mitigated by a test that speaks the wire format directly — constructing raw
  JSON-RPC envelopes rather than calling through a client — so a protocol
  revision surfaces as a failing assertion about bytes.
- No client-side compatibility risk, because the deviation is server-only: any
  conformant MCP client still talks to it.
- The Functions runtime parses JSON before invoking the HTTP handler. A malformed
  `application/json` request may be refused there as HTTP 400 rather than the
  handler's JSON-RPC `-32700`. The Hosting route pins the no-store and exposed
  authentication headers for that boundary; clients treat its diagnostic as a
  transport error (SPEC §23). Hand-writing the MCP handler does not replace the
  runtime's parser.
- This is a **documented deviation from the approved plan**, recorded here
  rather than absorbed silently, and repeated in the module header where
  somebody editing the file will actually see it.

## Since

**2026-09-17** — the surface grew from six tools to nine, the three new ones for
folders. The count is not what this decision turned on: hand-validation is still
one `required` check in `missingArguments`, and what a schema library would buy
at nine tools is the same coercion nobody has asked for at six. The reversal
conditions below are streaming, sessions and the `zod` peer, and none of them
moved.

**2026-10-05** — eleven, with `fork_document` and `get_lineage` (SPEC §21). Two
more `required` fields; nothing above moved.

**2026-10-06** — twelve, with `suggest_edit` (SPEC §22).

**2026-10-08** — thirteen with `add_comment`, fifteen with `revise_suggestion`
and `withdraw_suggestion`, and twenty-one with the decisions ADR 0015 lets an
agent make (`accept_suggestion`, `reject_suggestion`, `resolve_thread`,
`reopen_thread`, `commit_draft`) and `rename_document`. Still one `required`
check per tool; streaming, sessions and the `zod` peer have not moved.

**2026-10-09** — twenty-two, with `get_folder`, and an optional `baseVersion`
on `update_document` and `threads` on `get_comments`. Optional arguments are
still a `typeof` check in the tool; nothing above moved.

**2026-10-09** — twenty-three, with `get_changes`. Its `since` cursor is an
argument, not a session: every request still carries its own credential and
stands alone. The server keeps the last cursor each credential was given per
document, so a client that forgets can ask for `"last"`. That is a bookmark in
Firestore, not protocol state, so the reversal condition on sessions has not
moved (ADR 0016).

## What would change this

Two things, either one sufficient. If the SDK drops the `zod` peer or ships a
server-only entry point without it, the argument disappears and adopting it is
the better default. If this endpoint ever needs streaming, sessions or
sampling, the hand-written surface stops being small and the SDK's cost becomes
worth paying.
