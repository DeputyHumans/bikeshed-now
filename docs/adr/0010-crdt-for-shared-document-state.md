# 0010 — Merge shared document state with a CRDT

**Status** Accepted · **Spec** §6b, §16 · **Supersedes** the no-merge half of the
collaboration design · **Amends** [0007](0007-execcommand-over-schema-editor.md)

## Context

Until now two people could work in a document at the same time but only one
could type. A single-holder soft lock in Realtime Database made that honest:
SPEC §6b said "shared awareness is in scope, shared document state is not",
and `docs/architecture.md` listed "no CRDT or operational-transform merge"
under *What this is not*.

The product owner asked for genuine simultaneous typing, with the costs in this
record stated up front and accepted. This ADR is the written argument that
`architecture.md` demands before one of those lines changes.

Two facts forced the shape of the answer rather than the answer itself.

**The lock was not holding.** An audit plus live testing on a real deployment
found the one-writer model leaking in ways that make "only one person types" a
claim rather than a guarantee: nothing re-stamped the lock while somebody was
typing, so a five-minute editing session was cut off mid-sentence and the lock
became stealable; losing it tore down the editing host without flushing the
pending autosave; `publicEdit` documents had no lock at all, because the
presence gate is keyed by `members` and open editing admits accounts that are
not in it; and a failed lock read resolved to "nobody holds it", failing open.
Hardening that was the alternative to this ADR, not a prerequisite for it.

**A schema was the thing to avoid, not a CRDT.** ADR 0007 chose `execCommand`
because every schema editor normalizes a document into its own model, and for
hand-authored HTML — inline SVG, a `<details>` tree, a scroll observer —
normalizing is destruction. That reasoning is about *schemas*. It was applied to
CRDTs because every rich-text CRDT binding in common use (`y-prosemirror`,
Automerge's rich-text work) arrives attached to one.

## Decision

Use **Yjs** for shared document state, bound to the DOM by a hand-written
binding over `Y.XmlFragment`, and delete the edit lock.

Yjs's XML types are the exception to the schema rule: `Y.XmlElement` is a name,
a string map and a child list, with no opinion about what an element may be
called, what attributes it may carry, or what may nest inside what. It can
mirror an arbitrary DOM exactly. The schema belongs to `y-prosemirror`, not to
Yjs, and this codebase does not take `y-prosemirror`.

The binding is `app/src/crdt/binding.ts`, and the property it exists to hold is
tested against the real sample bundles rather than against invented markup:
both survive a round trip through the wire format **byte-identical**.

## Consequences

- **The app dependency budget goes from seven to eight.** `yjs` is MIT with one
  transitive dependency (`lib0`, MIT). No CRDT can be hand-written at a
  defensible size, and this is the one place in this codebase where the
  "no library" discipline buys less than it costs.
- **Three fidelity traps are now load-bearing**, each with a test:
  namespaces (`createElement("svg")` yields an HTML element, which lowercases
  `viewBox` and silently stops the graphic scaling — this is a defect the first
  version of the binding actually had); comments, because Yjs has no comment
  node and a bundle's licence header is one; and decoration, because anything
  in the local DOM at seed time is replicated to every peer and then published.
- **Decoration containment gains a fourth path.** The §13 invariant guarded one
  document's own save. A highlight reaching the CRDT arrives in *everyone's*
  copy and is then indistinguishable from the author's markup. The binding
  refuses it at the boundary, by value and never by prefix.
- **Deletion beats concurrent typing.** If one person deletes a paragraph while
  another types into it, the paragraph goes. That is Yjs's semantics, it is
  deterministic, and it is tested; it is not a merge policy this project chose.
- **Losing the lock loses the "who is writing v3" story.** `draft.editSessions`
  was appended when the lock changed hands. With no lock there are no hand-offs
  to record, and per-author attribution would need per-character provenance —
  which SPEC §16 still declines.
- The soft lock's **one honest property is gone**: it made "no merge engine" a
  design rather than a hole. That sentence is now false and is removed rather
  than left to rot.

## What would change this

If the round-trip test ever has to be relaxed to keep the binding working —
if some real document cannot survive the wire byte-identical — then this
approach has become a schema after all, wearing a different name, and the
honest move is to reverse it rather than to weaken the test.

Separately, if Yjs's XML types ever acquire a schema requirement, or if the
binding grows past roughly the size of the thing it replaced, the trade this
record makes has stopped being the trade that was accepted.

What would *not* change it: Yjs being one more dependency. That cost was named
here, and accepted here, deliberately.
