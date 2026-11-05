# 0015 — An agent decides with its owner's role

**Status** Accepted · **Spec** §6, §6a, §19, §22 · **Amends** [0013](0013-suggestions-applied-as-an-edit.md) decision 6, and narrows its rejection of applying on the server

## Context

An agent could propose a change, comment and reply, but it could not close anything. Every review cycle waited on a person to accept, reject or resolve, even when that person had connected the agent to do exactly that. A token is its owner, with no scopes (ADR 0014), so the refusal was never a permission: an approver's agent could type the change by hand, but not record that it took the reviewer's suggestion.

ADR 0013 refused it for two reasons. Deciding was a person's act (decision 6), and the server has no DOM to apply an edit with, so "a hand-rolled text model would place a replacement wrongly whenever it disagreed with the browser". The product owner asked for the first to go. The second still stands against a model that guesses, and shapes how the first is done.

## Decision

1. **A token decides with its owner's role.** An approver's agent accepts and rejects. Any reader's agent resolves and reopens a thread that is not a suggestion, as that reader can in the app.
2. **Accepting splices the source and checks its own result.** The quote is found as the browser finds it, and exactly that span is replaced: in the raw HTML, or in the Markdown source where the quote stands verbatim. Then the result is read back. Its text must equal the old text with that one span replaced, and the browser's own `alreadyApplied` rule must hold, or nothing is written and the refusal names the app. No byte outside the span changes.
3. **It lands in the draft, not in a version.** A version gathers a review; `commit_draft` publishes the draft through the in-app commit's own gates.
4. **It does not race a person in the editor.** The live log wins over the draft (ADR 0010), so an accept is refused while anyone is in the document, and a log nobody is using is cleared first, which its contract allows.
5. **Every decision says it came through an agent.** The note written into the thread carries the actor, for a resolve and a reopen as for a decision.
6. **`POST /suggestion` still refuses a token's claim, accept and reject.** There, accepting means "my browser has applied it", which a token has not.

Rejected:
- **A DOM in `functions/`.** turndown already carries one, but re-serializing the whole document rewrites bytes a person wrote, and a Markdown round trip reformats a file for the sake of one word.
- **Each accept as a new version.** Every other pending suggestion would be left on a version nobody reads.
- **Recording the decision and trusting the agent to make the edit.** An accepted suggestion that never landed would be observable, and unnoticed.

## Consequences

- **Narrower than the browser.** A span that crosses markup, a Markdown quote that is not verbatim in its source (an escape, a wrapped link), or context that repeats where the browser would have scoped by element: each is refused with a pointer to the app, never applied somewhere near.
- **The draft can hold accepted work** that `update_document` would delete. An update is refused while it does, which also closes that hole for accepts made in the app.
- **A suggester can address the approver's agent.** A note is text written by somebody with less authority, read by an agent with more. The threat model carries it.
- **A narrow race remains.** Someone who opens the editor between the presence check and the draft write seeds from the older bytes, and their autosave drops the change while the suggestion reads "Accepted.".

## What would change this

- **Refusals for formatting or verbatim mismatch are measured to be common:** apply on a DOM whose serializer matches the browser's, and accept the churn the in-app editor already causes.
- **The race is seen in practice:** version the draft, so a save from a stale session is refused instead of winning.
- **An agent is steered into a decision its owner would not make:** take deciding back to the app, or have a person confirm there.
