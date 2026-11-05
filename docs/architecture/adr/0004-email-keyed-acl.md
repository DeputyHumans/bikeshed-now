# 0004 — Key the ACL by verified email, not uid

**Status** Accepted, amended by [0020](0020-an-account-follows-its-google-address.md) (an address Google renames) · **Spec** §1, §4

## Context

Sharing a document means naming somebody who may not have an account yet. A uid does not exist until first sign-in, so a uid-keyed ACL can only express "share with a person who is already here" — and the common case is the opposite.

The alternatives were an invitation record that converts to a uid on acceptance, or keying the ACL by email directly.

## Decision

**`members[]` and `editorMembers[]` are arrays of lowercased, verified email addresses.** Access is granted to an address; the account that proves control of that address inherits it.

Two conditions make this safe, and both are absolute:

1. **`email_verified === true` is required in every layer** — Firestore rules, RTDB rules, the functions gate, and the client. There is no second notion of verification: the app's own flow writes Firebase's canonical `emailVerified` field via the Admin SDK rather than inventing a parallel claim.
2. **Addresses are lowercased on write.** A mixed-case entry grants nothing, which is asserted by a rules test, because the `list` rule compares against the caller's own token email.

## Consequences

- **Anything shared with you before you signed up lights up the moment you do.** That is the feature, and the sign-up flow is built around it.
- It is also the sharpest edge in the system: signing in with an *unverified* address that matches a pending grant would hand over another person's documents. This is why verification blocks sign-up and why the gate cannot be relaxed for a provider that does not vouch for addresses — the most tempting shortcut in the codebase, called out in `docs/architecture/threat-model.md`.
- One account per email is enforced, not merely default. Two accounts sharing an address would be an ACL correctness bug, so a second provider offering a known address goes through explicit account linking.
- The email shape validator is stricter than RFC 5321 on purpose: it rejects `$ # [ ] /` because the presence mirror uses the address as an RTDB key, so every storable address is guaranteed representable as one.
- Changing your email address is not a supported operation. Stated rather than discovered.

## What would change this

An identity provider that issues stable subject identifiers *before* first sign-in, with a directory to resolve them from, would make a uid-keyed ACL possible without losing pending shares. That is what SSO/SCIM would bring, and it is explicitly not built.
