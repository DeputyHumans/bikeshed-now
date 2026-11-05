# 0020 — An account follows the address Google renames it to

**Status** Accepted · **Spec** §1, §2, §4, §14

## Context

ADR 0004 keys the ACL by verified address and says changing an address is not a supported operation. That held while the only way to change one was to ask. Then a Workspace admin renamed a person's primary address, from one company domain to another.

Firebase finds a returning Google user by Google's permanent account id (`sub`). It never rewrites the account's own `email`, and only the provider entry beneath it learns the new address. So the person signed in with Google as the new address, and the product kept treating them as the old one. Everything shared with the new address was invisible, and nothing told them why. The emulator does the same, which is how it was confirmed (`signInWithIdp` in firebase-tools: an existing user matched by provider id gets no top-level update).

The other choices were:
- an operator script that moves one account on request;
- doing nothing, and asking owners to share again with the old address.

The script is smaller. It also means everyone a company renames is stuck until somebody notices, and a domain rename renames everyone.

## Decision

1. **The account follows Google, at Google sign-in.** The browser sends Google's own ID token, and only when Google's address differs from the account's. The server believes nothing else:
   - the RS256 signature is checked locally against Google's keys;
   - `iss`, `exp` and `email_verified === "true"` must hold, the last compared as a string;
   - `sub` must be one of the Google ids in the caller's verified Firebase token;
   - the address must pass the deployment's policy.
2. **`aud` is not checked, deliberately.** With the `sub` binding, a token can only ever align the caller's own account with what Google vouches for that Google account now. A token minted for another app proves the same facts.
3. **The move is a job, not a request.** It runs in a Firestore trigger with retries, because Hosting cuts a request at sixty seconds and a move recomputes everything the person can see.
4. **Add, commit, remove.** The new address is added beside the old, then Firebase's record changes (which revokes every session), then the old address is removed. Every step finds its work by query, so a redelivery resumes from wherever an attempt died. A move that stops anywhere leaves nobody with less access than before.
5. **Everything that names the person moves; nothing that records them does.** Ownership, grants, team membership and the account record move. Personal tokens minted under the old address are revoked, because one would act as that address forever. Comments, versions, views and the change log keep the address they were written under. Each owner's ACL log gets one entry per record that named the address directly.
6. **One account per address still holds.** An unverified, password-only account holding the new address is deleted, as Firebase does when a trusted provider vouches for an address. Any other holder blocks the move, and merging two accounts is left to a person.

## Consequences

- A rename costs the person one wait on a "moving your account" screen. It also signs them out everywhere, and connected apps and tokens must be reconnected. That is the price of revoking credentials that carry the old address.
- Owners see an access change they did not make, attributed to the person who moved and marked `address-moved`. It is true, and it is the only way the log stays complete.
- GitHub and password accounts do not follow automatically, because GitHub does not vouch for addresses. Their way to a new address is still the verification code, which moves nothing.
- A share sent to the old address afterwards goes to whoever proves that address. There are no aliases.
- An allowlist that rejects the old address stops the gate before the move is considered. A deployment renaming its domain keeps both domains listed until everyone has moved.

## What would change this

Firebase starting to rewrite an account's email when its provider's address changes would make the detection unnecessary, though not the move. SSO with SCIM, which ADR 0004 already names, would make the ACL uid-keyed and the whole problem disappear. A second provider that vouches for addresses as Google does would want the same treatment, and should get it through this path rather than a parallel one.
