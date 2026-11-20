# 0040 — A person is shown by a short name, looked up by uid

**Status** Accepted · **Spec** §4, §7, §16, §17 · **Builds on** [0004](0004-email-keyed-acl.md) (the address is the identity), [0023](0023-attribution-names-the-credential.md) (attribution)

## Context

Bikeshed showed people by their address: in the header, on every comment, on a suggestion's decision, in the details panel and in the workspace. Presence chips used the whole name a sign-in provider gives, or the address when there was none. An address is long, it reads as a system's identifier rather than a person, and a whole name made a presence chip as wide as the provider liked. People asked for a short, plain name instead, "Pavel S", for themselves and for everyone else.

Nobody could read another person's name. A comment, a version and a document record an address and a uid, never a name, and `users/{uid}` is readable by its own account only, because it holds verification state, cooldowns and tokens. The address stays the identity: the ACL, presence matching and every agent's output are keyed by it (ADR 0004).

## Decision

1. **`profiles/{uid}` holds the short name and nothing else,** `{ name?, chosen, updatedAt }`, separate from `users/{uid}` so the private record stays private.
2. **Anybody past the identity gate may read one by uid; nobody may list them.** A uid is learned only from a record its reader can already read, so a name is never more visible than the work it is attached to, and names cannot be enumerated. Signed out, every read is refused and the address's name is drawn.
3. **Only its own account writes it,** with exactly those keys and a name of 1 to 40 characters. The person's browser writes it on every load: the short form of the sign-in provider's name, unless the person chose one on Account, which a sign-in never replaces. A server write at sign-in would add no trust, since a chosen name is self-reported anyway, and it would miss sessions that never sign in again.
4. **A name is drawn short, always:** the first word and the first letter of the last word. Drawing applies it again, so a stored long value or an older client's whole presence name still draws short. With no name anywhere, the address gives one: `dana.kim@` is "Dana K".
5. **The address goes with every name,** as its tooltip, and the dot beside it is the colour the address already has everywhere. On a phone, where there is no pointer, the account menu spells out your own.
6. **Names replace addresses only where a person is shown.** The share panel, team members, the sign-in and account screens, a moved address, the export marking, email, and the MCP and CLI surface keep addresses, because there the address is the point.
7. **The app reads a profile once per uid per session.** A record that holds only an address uses the name a profile gave that address in the same session. Nothing on the server joins names, and no comment, version or document gains a field.

## Consequences

- Old comments and versions show names too, with no migration, because they already carry a uid.
- A name is self-reported, so two people can choose the same one, and one person can choose another's. The tooltip and the colour are how a reader tells them apart, and nothing that decides access looks at a name.
- Somebody who has not opened the app since this shipped, or who signs in with a password, is named from their address until they choose a name or sign in with a provider that gives one.
- A draft, a version summary and an Activity row carry an address without a uid, so they show the address's name unless a profile for that address was read earlier in the session.
- Each distinct author on screen costs one small read per session.

## What would change this

- Somebody impersonating another person through a chosen name. Then a chosen name is checked against the sign-in name, or shown beside the address rather than instead of it.
- Teams large enough that a page of comments costs many profile reads. Then the server writes the name beside the uid when it writes the record.
- A request for names in email or agent output. Then the server reads profiles, and the agent guide says what a name is and is not.
