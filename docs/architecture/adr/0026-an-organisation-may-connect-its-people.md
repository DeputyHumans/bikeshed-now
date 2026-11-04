# 0026 — An organisation's issuer may connect its people's apps, if the deployment trusts it

**Status** Accepted · Amended in 0.32.0 (issuers are trusted for listed domains only; the veto and the pinned `sub` hold across apps) · **Spec** §2, §23 · **Amends** [0014](0014-oauth-for-the-agent-surface.md) · **Narrows** overview.md's "No SSO or SCIM"

## Context

Claude can connect a whole organisation to an MCP server without anyone seeing a consent page: "Claude-issued managed authorization", Claude's implementation of the MCP extension `io.modelcontextprotocol/enterprise-managed-authorization` (stable 2026-07-28). Claude's admin signs a short JWT for each member, an Identity Assertion JWT Authorization Grant (ID-JAG, draft-ietf-oauth-identity-assertion-authz-grant), and Claude presents it at the server's token endpoint with the RFC 7523 jwt-bearer grant. The server's operator has to trust the organisation's issuer first. Claude's admin screen asks for exactly that.

Bikeshed had no way to say yes. Its token endpoint took a code or a refresh token. ADR 0014 had rejected an external identity provider as a second account system and made consent the person's decision; overview.md said "No SSO or SCIM".

## Decision

1. **The operator trusts issuers by configuration, for listed domains.** `BIKESHED_ID_JAG_ISSUERS` lists exact https issuer URLs, and `BIKESHED_ID_JAG_DOMAINS` the address domains they may vouch for; an assertion's address must be at one of them exactly, and an `email_verified` the issuer sends must be true. Both are deployment configuration, never committed, because an issuer URL names the organisation. Unless both are set, the grant is neither accepted nor advertised. *Amended in 0.32.0:* there were no domains at first, so a trusted issuer could connect any account here by asserting its address, an administrator's included, and one leaked signing key reached every account. There is no admin screen: the configuration is the admin surface, as everywhere else here.
2. **An assertion is checked before anything in it is used.** `iss` must be configured, compared byte for byte, before any fetch. The header must be `typ` `oauth-id-jag+jwt`, `alg` ES256 only, with a `kid` from the issuer's published keys. The signature must verify. `aud` must be this server's issuer. It must not be expired, must not be issued in the future, and must expire no more than ten minutes ahead. `client_id` must match the request's, and that client must publish a metadata document. No `aud_tenant` and no `cnf` are accepted. Each `jti` is used once.
3. **It connects an account; it never makes one.** The address it carries must already be an account here, and it passes the same gate as every sign-in: verified, enabled, allowed, not signed out everywhere since. Creating accounts from assertions would be the second account system ADR 0014 refused.
4. **One connection per person, address and app, and the person can end it for good.** It is a row in `tokens/` like any connected app, listed and revoked from the account screen. Each assertion gets its own access token of an hour, `HMAC(row nonce, assertion)`, and there is no refresh token. Only hashes are stored, so the store alone yields no token. Revoking it is sticky: later assertions from that issuer for that person and address are refused, whichever app they name, and the person can still connect apps themselves through consent. The issuer's `sub` is fixed at the first exchange, across apps, so a reassigned address is refused rather than inherited. *Amended in 0.32.0:* both were the row's alone at first, and the row is keyed by the app, so an assertion naming another `client_id` was neither vetoed nor pinned.
5. **Each assertion is a sign-in.** The gate judges it as one, so an earlier "sign out everywhere" does not bar the organisation from signing the person in again. An address move starts a new row rather than reviving the revoked one.

## Consequences

- **Consent moves from the person to the operator.** That is the feature. A person whose organisation connects Claude for them never sees /connect. The account screen says who connected the app, and Revoke is how they decline.
- **Claude authenticates as nobody.** Its metadata document says `token_endpoint_auth_method: "none"`, which the MCP profile allows. Draft -06 of the ID-JAG specification, from 2026-10-31, says a server MUST reject an assertion with neither client authentication nor a bound key. A leaked assertion is therefore a bearer credential for up to ten minutes, once.
- **Removal lags by up to an hour.** When the organisation removes someone, its issuer stops signing for them, but the access token already issued lasts until it expires. The same is true of an ordinary connection's access token.
- **"No SSO" is no longer absolute.** One deployment can now let one outside party vouch for its people's addresses, for connecting apps only. Signing in to the web app is unchanged.
- **Every exchange writes the row.** One token per assertion keeps concurrent exchanges independent and keeps tokens underivable from the store, at the price of a Firestore write per exchange and a list of up to 100 live hashes per row. A retry of the same assertion within 60 s is answered with the same token and writes nothing.
- **A trusted issuer can connect any account at its listed domains**, the operator's own included if it is at one of them. An agent connection cannot do what only a person can (trusting scripts, deleting forever), so that is the reach of an app, not of the account.

## What would change this

Claude, or the issuer an operator trusts, starts authenticating its client: then require it, and refuse `none`, as draft -06 asks. The extension is withdrawn or Claude stops using it: delete the grant, which is one dispatch in the token endpoint and two files. A deployment needs an assertion to create an account, or to sign in to the web app: that is SSO, and it needs its own decision.
