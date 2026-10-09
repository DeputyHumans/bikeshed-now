# 0013 — Suggestions are text, applied as an edit in the approver's browser

**Status** Accepted, amended by [0015](0015-agents-decide-as-approvers.md) (decision 6 and
"Applying on the server") · **Spec** §6a, §13, §19, §22

## Context

Contributing a change meant making it. There was no way to propose one for
somebody else to decide, for a person or for an agent, and access had two
levels: read and edit.

Three facts about this system ruled most designs out:
- The browser writes a document's bytes. It edits the real authored DOM with
  `execCommand` and serializes it (ADR 0007). `functions/` has no DOM, and the
  dependency budget does not admit one.
- Live editing is a CRDT bound to the DOM (ADR 0010). Anything put into the
  edited document, as a node or an attribute, is synced to every peer.
- Merging hand-authored HTML is a subsystem of its own, and SPEC §21 says this
  system does not have one.

## Decision

1. **Four roles in a ladder.** viewer < suggester < editor < approver, one per
   principal, inherited as reading and editing are. Each effective set contains
   the one above it.
2. **A suggestion is one text replacement inside one block.** It is anchored the
   way a comment is and stored as an annotation with a `suggestion` field. Only
   `POST /suggestion` writes that field; the rules refuse every client write
   that names it.
3. **Accepting is an edit.** The approver's browser re-finds the quote in the
   draft strictly, replays the replacement with `execCommand` in their own
   editing session, saves the draft, then records the decision. It lands in the
   draft, and a person still publishes it.
4. **So an approver is an editor.** A role that could accept text but not type
   it cannot be enforced when the browser is what writes the bytes.
5. **A pending suggestion holds back every new version,** on every account
   channel. Only an approver clears one.
6. **Agents propose and never decide.**

Rejected:
- **Applying on the server.** It has no DOM. A hand-rolled text model would
  place a replacement wrongly whenever it disagreed with the browser.
- **A suggesting mode inside the editor.** Typed changes would have to be caught
  before the editor applied them and kept out of the CRDT, and IME composition
  cannot be cancelled. It would also be a fifth way decoration could reach the
  bytes.
- **An approver below editor.** Not enforceable, for the reason in 4.
- **A per-document "require review" switch.** The role already decides who
  must suggest instead of editing.

## Consequences

- **A suggestion whose quote no longer matches exactly is stale.** It can only
  be rejected. Nothing is merged and nothing is guessed.
- **Text only.** Formatting, images and structure cannot be suggested. A
  replacement loses inline formatting inside the span it replaces.
- **The role decides who may decide, not what can change.** An editor can type
  the same change by hand. What the role guarantees is that a pending
  suggestion is cleared by an approver and nobody else.
- **Acceptance is recorded after the draft is saved.** A crash in between
  leaves the change in the draft and the suggestion pending. Accepting again
  finds it already applied and only records it.
- **Two more effective sets on every document and folder,** and four more team
  lookups per team change.

## What would change this

- **A DOM becomes affordable in `functions/`:** apply on the server, and let an
  approver who does not edit exist.
- **Stale suggestions are measured to be common:** carry them forward to the
  next version and re-anchor them there.
- **People ask for structural suggestions twice:** that is the merge subsystem
  SPEC §21 declines, and it needs its own argument.
