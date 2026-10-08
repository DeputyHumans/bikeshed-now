# 0014 — Apps connect by signing in: OAuth 2.1 beside personal tokens

**Status** Accepted · **Spec** §19, §23 · **Reverses** the "No OAuth 2.1 for the agent surface" line in `overview.md`

## Context

SPEC §19 chose personal access tokens over OAuth and named the condition for
reversing that: "if one-click client onboarding is ever wanted." It is wanted.
The tools people now want to publish from cannot be pointed at a pasted token:
- **ChatGPT accepts no API keys.** Per-user OAuth is its only way in.
- **Claude's** custom connectors (web, Desktop, mobile) expect OAuth. Its
  header-credential option is a beta for organisation Owners.
- `/mcp` answered 401 with no `resource_metadata`, so a client that can sign in
  had no way to discover that this server offers it.

## Decision

1. **This deployment is its own authorization server.** It is hand-written on
   `node:crypto` with no dependency, no new secret and no signing key, for the
   same reasons as ADR 0009. Tokens are opaque randoms stored as SHA-256, the
   way personal tokens are.
2. **A connected app is a row in `tokens/`.** The account screen lists and
   revokes it with no new code, and its `tokenId` is stable, so "what did this
   app do" is still one query.
3. **Short-lived and re-checked.** An access token lasts an hour and works on
   `/mcp` only. The refresh token rotates on every use. The identity gate is
   re-checked at each refresh, which a personal token never gets.
4. **No scopes.** A grant is its owner, with exactly their access, as a token
   is. Scopes would be the second permission model §19 rules out.
5. **Any app may ask, and the person decides.** Clients identify themselves by
   a metadata document (Claude, ChatGPT and Claude Code), by stateless
   registration, or as the built-in CLI. No client registry is stored. Consent
   shows what is verified and labels what is not.
6. **The command line uses the same consent** and still receives a personal
   token. It calls endpoints other than `/mcp`, and its parallel processes
   would read a rotating refresh token as theft.

Rejected:
- **An external identity provider.** It would be a second account system next
  to Firebase Auth and a second place for the gate to live.
- **JWT access tokens.** They need a signing key, which means a secret to
  rotate, and they cannot be revoked before they expire without a lookup that
  would make them opaque in practice.
- **Long-lived tokens through consent, with no refresh.** Smaller, but these
  tokens are stored in a third party's cloud, and the MCP specification asks
  for short lifetimes.

## Consequences

- **It is the "real subsystem" §19 warned about.** About 1,060 lines in
  `functions/src/oauth/`, roughly five times the MCP server.
- **A disabled account keeps up to an hour of access**, until its access token
  expires and the next refresh fails the gate.
- **Open registration means a name can lie.** The consent page leads with the
  verified host or the redirect host, never with the name alone.
- **Two credentials now reach `/mcp`.** Personal tokens stay for CI, scripts
  and anything without a browser.

## What would change this

- **Clients stop using dynamic registration** (MCP deprecated it in 2026-07-28):
  delete the `bsdcr_` path. Everything else stays.
- **Personal tokens are retired**: the CLI moves to rotating tokens, and
  `verifyToken` leaves `/mcp`.
- **A client needs a capability narrower than its owner**: that is the moment
  scopes become a decision, and it is a separate ADR.
