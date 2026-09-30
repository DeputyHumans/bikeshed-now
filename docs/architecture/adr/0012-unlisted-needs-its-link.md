# 0012 — An unlisted document needs its link, everywhere

**Status** Accepted · **Spec** §1.4, §2, §4, §16, §17, §19

## Context

"Unlisted" was supposed to mean anyone with the link. In practice the key was
checked by hand on three byte paths, and the rest of the system treated
unlisted as public:
- the shared `canRead`, which every other endpoint and the agent tools trusted;
- the security rules;
- the `public/{docId}` projection, which was mirrored for every non-private
  document, was world-readable and could be listed.

An anonymous visitor could list every unlisted document's id and title. Opening
one without the key drew the viewer's chrome around an empty frame. Any account
could read the comments, and through `get_document` the whole source. Ids had
just become chosen by people, so they were guessable too.

Security rules cannot see a URL. So "the rules let a link holder comment" and
"the rules check the key" cannot both be true without something that carries the
key's authority to where the rules can read it.

## Decision

1. **One predicate decides every read.** `readBasis`, in `lib/acl.ts`, returns
   member, public, link or grant. `tokenMatches` is the only comparison of a key.
2. **A signed-in account that presents the key gets a link grant.** It lives at
   `docs/{id}/linkGrants/{uid}`, only the server writes it, and it names the
   token that was presented. The rules and the endpoints accept a grant in place
   of the key only while that token is still the document's. Rotating the link
   revokes every grant at once.
3. **The world-readable projection holds public documents only.** Its rule allows
   `get` of a public row and no `list`.
4. **Unlisted readers get their fields from `POST /unlock`,** the one endpoint
   that checks the key and mints grants.
5. **The realtime `*` key is written for public documents only.**

Two alternatives were rejected:
- **A secret-path collection keyed by the token.** It is another derived copy to
  keep in sync on rotation. It puts the secret into document ids, which reach
  request paths, logs and the client cache. And it still needs a separate way to
  mint grants.
- **Having `docShell` embed the fields in the page.** `docShell` never
  authenticates, so it cannot mint a grant. Its output is cached at a shared
  URL, and it does not run on in-app navigation.

## Consequences

- **Opening an unlisted document costs one more function.** An anonymous or
  non-member open calls `/unlock` in series before `contentProxy`, and each
  cold-starts separately. Public documents stay on the Firestore projection and
  pay nothing.
- **Link holders on an unlisted open-editing document are not merged live.**
  They edit through `/draft` and `/commit`, the documented fallback when there is
  no Realtime Database.
- **A grant cannot be withdrawn from one account alone.** Rotating the link
  withdraws it from everyone.
- **Grant-based reads are uncacheable at the CDN.** They use
  `private, no-store`, because their URL carries no key.
- **The write endpoints now answer 404 to anyone who may not read.** This closes
  an existence check for private documents too.

## What would change this

- **The extra cold start is measured as a problem on unlisted opens:** embed the
  reader fields in `docShell` for a request carrying the right key, and keep
  `/unlock` for grants.
- **Live co-editing through a link is asked for:** mirror grant holders into
  `editAccess` by email, and clear them on rotation.
- **Per-holder revocation is asked for twice:** a grant list the owner can see
  and prune, which would also make grants a reading history and so
  editor-only.
