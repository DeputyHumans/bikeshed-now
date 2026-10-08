// SPDX-License-Identifier: Apache-2.0
// Connecting an app end to end: consent, code, tokens, /mcp, rotation and revocation (SPEC §23).

/**
 * One module registry and one store per sequence, on purpose. Each step here is
 * correct alone; what breaks is the ORDER a real client takes them in — the
 * retry after a timeout, the old refresh token arriving after the new one, the
 * revoke between two refreshes. A test per state would never see those.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");

process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
process.env.GCLOUD_PROJECT = "demo-bikeshed";
delete process.env.FUNCTIONS_EMULATOR;

const { fakeFirestore, fakeToken, withFakeAdmin, invoke } = require("./fakes.js");
const { oauth, oauthConsent, mcp, manageTokens } = require("../lib/index.js");
const { handleConsent } = require("../lib/oauth/consent.js");
const { verifyAccessToken } = require("../lib/oauth/grants.js");
const { resolveCaller } = require("../lib/lib/actor.js");
const { clearClientCache } = require("../lib/oauth/clients.js");

const ANA_TOKEN = { uid: "u-ana", email: "ana@example.com", email_verified: true };
const ANA_USER = {
  uid: "u-ana",
  email: "ana@example.com",
  emailVerified: true,
  disabled: false,
  tokensValidAfterTime: new Date(0).toUTCString(),
};
const ISS = "https://bikeshed.example";
const RESOURCE = "https://bikeshed.example/mcp";
const REDIRECT = "https://app.example/cb";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The world a sequence runs in: one store, one set of accounts. */
function world({ users = { "u-ana": ANA_USER } } = {}) {
  const { db, store } = fakeFirestore();
  const env = { db, idTokens: { "ana-id": ANA_TOKEN }, sessions: { "ana-session": ANA_TOKEN }, users };
  const run = (fn) => withFakeAdmin(env, fn);

  return {
    db,
    store,
    env,
    async register(body = { redirect_uris: [REDIRECT], client_name: "Example" }) {
      const r = await run(() =>
        invoke(oauth, { path: "/oauth/register", body, headers: { "content-type": "application/json" } }),
      );
      return r.body.client_id;
    },
    consent(action, params, { headers = {}, handler } = {}) {
      return run(() =>
        invoke(handler ?? oauthConsent, {
          path: "/oauth/consent",
          body: { action, params },
          headers: {
            "content-type": "application/json",
            authorization: "Bearer ana-id",
            "sec-fetch-site": "same-origin",
            ...headers,
          },
        }),
      );
    },
    token(fields, { headers = {} } = {}) {
      const raw = typeof fields === "string" ? fields : new URLSearchParams(fields).toString();
      return run(() =>
        invoke(oauth, {
          path: "/oauth/token",
          rawBody: Buffer.from(raw),
          body: {},
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        }),
      );
    },
    mcp(bearer, { method = "tools/list", headers = {} } = {}) {
      return run(() =>
        invoke(mcp, {
          path: "/mcp",
          body: { jsonrpc: "2.0", id: 1, method },
          headers: bearer ? { authorization: `Bearer ${bearer}`, ...headers } : headers,
        }),
      );
    },
    listTokens() {
      return run(() =>
        invoke(manageTokens, { body: { op: "list" }, headers: { cookie: "__session=ana-session" } }),
      );
    },
    revoke(tokenId) {
      return run(() =>
        invoke(manageTokens, { body: { op: "revoke", tokenId }, headers: { cookie: "__session=ana-session" } }),
      );
    },
    run,
  };
}

function authorizeParams(clientId, challenge, extra = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: RESOURCE,
    ...extra,
  };
}

/** Approve, and return the code from the redirect the person is sent to. */
async function approve(w, params) {
  const r = await w.consent("approve", params);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const url = new URL(r.body.redirect);
  assert.equal(url.searchParams.get("state"), params.state ?? null);
  assert.equal(url.searchParams.get("iss"), ISS);
  return url.searchParams.get("code");
}

async function connect(w, extra = {}) {
  const clientId = await w.register();
  const { verifier, challenge } = pkce();
  const code = await approve(w, authorizeParams(clientId, challenge, extra));
  const r = await w.token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
    resource: extra.resource ?? RESOURCE,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { clientId, code, verifier, pair: r.body, tokenId: r.body.access_token.slice(4, 36) };
}

// --- The whole life of a connection -----------------------------------------

test("a connection lives, refreshes, survives a retry, and dies on a replay", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 8, 12) });
  const w = world();

  const clientId = await w.register();
  const { verifier, challenge } = pkce();
  const params = authorizeParams(clientId, challenge);

  const described = await w.consent("describe", params);
  assert.equal(described.body.valid, true);
  assert.deepEqual(described.body.client, { name: "Example", host: null, verified: false, registration: "dcr" });
  assert.deepEqual(described.body.redirect, { host: "app.example", kind: "web", scheme: "https" });
  assert.equal(described.body.account.email, "ana@example.com");

  const code = await approve(w, params);
  const first = await w.token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "private, no-store");
  assert.equal(first.headers.pragma, "no-cache");
  assert.match(first.body.access_token, /^bsa_[0-9a-f]{32}\./);
  assert.match(first.body.refresh_token, /^bsr_[0-9a-f]{32}\./);
  assert.equal(first.body.expires_in, 3600);

  const listed = await w.mcp(first.body.access_token);
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.result.tools));

  // An hour later the access token is spent, and says so.
  t.mock.timers.tick(3600 * 1000 + 1);
  const expired = await w.mcp(first.body.access_token);
  assert.equal(expired.status, 401);
  assert.match(expired.headers["www-authenticate"], /error="invalid_token"/);

  const second = await w.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(second.body.access_token, first.body.access_token);
  assert.notEqual(second.body.refresh_token, first.body.refresh_token);
  assert.equal((await w.mcp(second.body.access_token)).status, 200);

  // The client timed out and retries with the token it still holds: it gets
  // the pair it missed, byte for byte, not a fork of the chain.
  t.mock.timers.tick(30 * 1000);
  const retry = await w.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.access_token, second.body.access_token);
  assert.equal(retry.body.refresh_token, second.body.refresh_token);

  // Past the grace window, the old token is somebody else's copy.
  t.mock.timers.tick(31 * 1000);
  const replay = await w.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");

  const tokenId = first.body.access_token.slice(4, 36);
  assert.notEqual(w.store.get(`tokens/${tokenId}`).revokedAt, null);
  assert.equal((await w.mcp(second.body.access_token)).status, 401, "the newest access token died with the grant");
  const list = await w.listTokens();
  const row = list.body.tokens.find((x) => x.tokenId === tokenId);
  assert.equal(row.kind, "oauth");
  assert.equal(row.revoked, true);
});

test("revoking on the account screen ends a connection with no new code", async () => {
  const w = world();
  const { pair, tokenId } = await connect(w);
  const list = await w.listTokens();
  const row = list.body.tokens.find((x) => x.tokenId === tokenId);
  assert.equal(row.name, "Example");
  assert.equal(row.kind, "oauth");
  assert.equal(row.clientHost, "app.example");
  assert.equal(row.clientVerified, false);

  assert.equal((await w.revoke(tokenId)).status, 200);
  assert.equal((await w.mcp(pair.access_token)).status, 401);
  const refreshed = await w.token({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
  assert.equal(refreshed.body.error, "invalid_grant");
});

test("a code exchanged twice inside the window gives one grant and the same pair", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 8, 12) });
  const w = world();
  const clientId = await w.register();
  const { verifier, challenge } = pkce();
  const code = await approve(w, authorizeParams(clientId, challenge));
  const fields = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId };

  const a = await w.token(fields);
  t.mock.timers.tick(5000);
  const b = await w.token(fields);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.access_token, a.body.access_token);
  assert.deepEqual(b.body.refresh_token, a.body.refresh_token);
  const grants = [...w.store.keys()].filter((k) => /^tokens\/[0-9a-f]{32}$/.test(k));
  assert.equal(grants.length, 1);

  t.mock.timers.tick(60 * 1000);
  const late = await w.token(fields);
  assert.equal(late.body.error, "invalid_grant");
  assert.notEqual(w.store.get(grants[0]).revokedAt, null, "what the code issued is revoked");
});

test("a changed address at the identity provider ends the connection at the next refresh", async () => {
  const users = { "u-ana": ANA_USER };
  const w = world({ users });
  const { pair, tokenId } = await connect(w);
  users["u-ana"] = { ...ANA_USER, email: "ana@elsewhere.example" };
  const r = await w.token({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
  assert.equal(r.body.error, "invalid_grant");
  assert.notEqual(w.store.get(`tokens/${tokenId}`).revokedAt, null);
});

test("each closed gate ends the connection at refresh", async () => {
  for (const [label, user] of [
    ["disabled", { ...ANA_USER, disabled: true }],
    ["unverified", { ...ANA_USER, emailVerified: false }],
    ["signed out everywhere", { ...ANA_USER, tokensValidAfterTime: new Date(Date.now() + 60_000).toUTCString() }],
    ["deleted", undefined],
  ]) {
    const users = { "u-ana": ANA_USER };
    const w = world({ users });
    const { pair, tokenId } = await connect(w);
    users["u-ana"] = user;
    const r = await w.token({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
    assert.equal(r.body.error, "invalid_grant", label);
    assert.notEqual(w.store.get(`tokens/${tokenId}`).revokedAt, null, label);
  }
});

test("a failed identity lookup is a server error, never a disconnection", async () => {
  // A client told invalid_grant throws the connection away; one permission
  // blip on the Auth backend must not disconnect every app.
  const users = { "u-ana": ANA_USER };
  const w = world({ users });
  const { pair, tokenId } = await connect(w);
  users["u-ana"] = new Error("PERMISSION_DENIED");
  const r = await w.token({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "server_error");
  assert.equal(w.store.get(`tokens/${tokenId}`).revokedAt, null);
});

test("the command line gets an ordinary personal token through the same consent", async () => {
  const w = world();
  const { verifier, challenge } = pkce();
  const params = {
    response_type: "code",
    client_id: "bikeshed-cli",
    redirect_uri: "http://127.0.0.1:61234/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "cli-state",
    resource: RESOURCE,
    device: "laptop‮",
  };
  const described = await w.consent("describe", params);
  assert.equal(described.body.client.registration, "builtin");
  assert.equal(described.body.redirect.kind, "loopback");
  assert.equal(described.body.device, "laptop");

  const code = await approve(w, params);
  const r = await w.token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: "bikeshed-cli",
    redirect_uri: params.redirect_uri,
  });
  assert.equal(r.status, 200);
  assert.match(r.body.access_token, /^bsk_[0-9a-f]{32}\./);
  assert.equal(r.body.refresh_token, undefined);

  const caller = await w.run(() => resolveCaller({ headers: { authorization: `Bearer ${r.body.access_token}` } }));
  assert.equal(caller.uid, "u-ana");
  assert.equal(caller.channel, "cli");
  const row = (await w.listTokens()).body.tokens.find((x) => x.tokenId === caller.tokenId);
  assert.equal(row.name, "CLI on laptop");
  assert.equal(row.kind, undefined);
});

test("a code from a registered app cannot be redeemed as the command line", async () => {
  const w = world();
  const clientId = await w.register();
  const { verifier, challenge } = pkce();
  const code = await approve(w, authorizeParams(clientId, challenge));
  const r = await w.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: "bikeshed-cli" });
  assert.equal(r.body.error, "invalid_grant");
});

// --- Consent -----------------------------------------------------------------

test("consent takes the account's ID token, and refuses a personal token or none", async () => {
  const w = world();
  const pat = fakeToken({ uid: "u-ana", email: "ana@example.com", channel: "mcp" });
  w.store.set(pat.path, pat.record);
  const clientId = await w.register();
  const params = authorizeParams(clientId, pkce().challenge);

  assert.equal((await w.consent("describe", params, { headers: { authorization: "" } })).status, 401);
  // Approving a new credential with an existing one is how a leaked token
  // becomes permanent access.
  assert.equal((await w.consent("describe", params, { headers: { authorization: `Bearer ${pat.bearer}` } })).status, 401);
  assert.equal((await w.consent("describe", params, { headers: { cookie: "__session=ana-session", authorization: "" } })).status, 401);
});

test("consent refuses a request from another site", async () => {
  const w = world();
  const params = authorizeParams(await w.register(), pkce().challenge);
  assert.equal((await w.consent("describe", params, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const noFetchMeta = { "sec-fetch-site": undefined };
  assert.equal((await w.consent("describe", params, { headers: { ...noFetchMeta, origin: "https://evil.example" } })).status, 403);
  assert.equal((await w.consent("describe", params, { headers: { ...noFetchMeta, origin: ISS } })).status, 200);
  assert.equal((await w.consent("describe", params, { headers: { "content-type": "text/plain" } })).status, 400);
});

test("a request that cannot be trusted is shown to the person and sent nowhere", async () => {
  const w = world();
  const clientId = await w.register();
  const { challenge } = pkce();
  for (const params of [
    authorizeParams(clientId, challenge, { redirect_uri: "https://evil.example/cb" }),
    authorizeParams("bsdcr_garbage", challenge),
    authorizeParams(undefined, challenge),
  ]) {
    const r = await w.consent("approve", params);
    assert.equal(r.body.valid, false);
    assert.equal("back" in r.body, false, JSON.stringify(r.body));
    assert.equal("redirect" in r.body, false);
  }
});

test("a malformed request from a known app can go back, carrying state and iss", async () => {
  const w = world();
  const clientId = await w.register();
  for (const [extra, error] of [
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ resource: "https://evil.example/mcp" }, "invalid_target"],
  ]) {
    const r = await w.consent("describe", authorizeParams(clientId, pkce().challenge, extra));
    assert.equal(r.body.valid, false);
    const back = new URL(r.body.back);
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get("error"), error);
    assert.equal(back.searchParams.get("state"), "st-1");
    assert.equal(back.searchParams.get("iss"), ISS);
  }
});

test("declining sends the person back with access_denied, state and iss", async () => {
  const w = world();
  const params = authorizeParams(await w.register(), pkce().challenge);
  const r = await w.consent("deny", params);
  const url = new URL(r.body.redirect);
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("state"), "st-1");
  assert.equal(url.searchParams.get("iss"), ISS);
  assert.equal(url.searchParams.get("code"), null);
});

test("a metadata-document client is described by its verified host", async () => {
  clearClientCache();
  const w = world();
  const doc = require("./fixtures/cimd/claude.json");
  const handler = (req, res) => handleConsent(req, res, { fetchMetadata: async () => doc });
  const r = await w.consent(
    "describe",
    { ...authorizeParams(doc.client_id, pkce().challenge), redirect_uri: "https://claude.ai/api/mcp/auth_callback" },
    { handler },
  );
  assert.equal(r.body.valid, true);
  assert.deepEqual(r.body.client, { name: "Claude", host: "claude.ai", verified: true, registration: "cimd" });
  clearClientCache();
});

test("a token may be bound to any host this deployment answers on, and no other", async () => {
  const w = world();
  const { pair } = await connect(w, { resource: "https://demo-bikeshed.web.app/mcp" });
  assert.equal((await w.mcp(pair.access_token, { headers: { "x-forwarded-host": "demo-bikeshed.web.app" } })).status, 200);
  const tokenId = pair.access_token.slice(4, 36);
  const g = w.store.get(`tokens/${tokenId}`);
  assert.equal(g.resource, "https://demo-bikeshed.web.app/mcp");
  const verified = await w.run(() => verifyAccessToken(w.db, pair.access_token, ["https://elsewhere.example/mcp"]));
  assert.equal(verified, null, "a token is only good for the resource it was issued for");
});

// --- The token endpoint -----------------------------------------------------

test("a repeated parameter is refused rather than resolved", async () => {
  const w = world();
  const r = await w.token("grant_type=authorization_code&code=a&code=b&code_verifier=x");
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_request");
  // Not merely refused: refused for the repeat, which a body read through the
  // framework's own parser would never see.
  assert.match(r.body.error_description, /repeated/);
});

test("every check runs before a code is spent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 8, 12) });
  const w = world();
  const clientId = await w.register();
  const { verifier, challenge } = pkce();
  const code = await approve(w, authorizeParams(clientId, challenge));
  const base = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId };

  for (const [fields, error] of [
    [{ ...base, code_verifier: pkce().verifier }, "invalid_grant"],
    [{ ...base, client_id: "bsdcr_someone-else" }, "invalid_grant"],
    [{ ...base, redirect_uri: "https://app.example/other" }, "invalid_grant"],
    [{ ...base, resource: "https://demo-bikeshed.web.app/mcp" }, "invalid_target"],
  ]) {
    const r = await w.token(fields);
    assert.equal(r.body.error, error, JSON.stringify(fields));
  }
  // None of those burned it.
  const ok = await w.token({ ...base, client_assertion: "eyJ", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" });
  assert.equal(ok.status, 200, "an assertion is ignored rather than refused");
});

test("an authorization code lasts two minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 8, 12) });
  const w = world();
  const clientId = await w.register();
  const { verifier, challenge } = pkce();
  const code = await approve(w, authorizeParams(clientId, challenge));
  t.mock.timers.tick(2 * 60 * 1000 + 1);
  const r = await w.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId });
  assert.equal(r.body.error, "invalid_grant");
});

test("a wrong secret for a real grant refuses and changes nothing", async () => {
  // The tokenId is not secret — it is stamped on what a token does — so
  // knowing one must never be enough to disconnect anybody.
  const w = world();
  const { pair, tokenId } = await connect(w);
  const before = JSON.stringify(w.store.get(`tokens/${tokenId}`));
  const r = await w.token({ grant_type: "refresh_token", refresh_token: `bsr_${tokenId}.${"A".repeat(43)}` });
  assert.equal(r.body.error, "invalid_grant");
  assert.equal(JSON.stringify(w.store.get(`tokens/${tokenId}`)), before);
  assert.equal((await w.mcp(pair.access_token)).status, 200);
});

test("a grant and a personal token cannot stand in for each other", async () => {
  const w = world();
  const { pair, tokenId } = await connect(w);
  const secret = pair.access_token.split(".")[1];
  assert.equal((await w.mcp(`bsk_${tokenId}.${secret}`)).status, 401, "a grant dressed as a personal token");

  const pat = fakeToken({ uid: "u-ana", email: "ana@example.com", channel: "mcp" });
  w.store.set(pat.path, pat.record);
  const [patId, patSecret] = pat.bearer.slice(4).split(".");
  assert.equal((await w.mcp(`bsa_${patId}.${patSecret.padEnd(43, "A").slice(0, 43)}`)).status, 401);

  // And an access token is good on /mcp alone.
  const caller = await w.run(() => resolveCaller({ headers: { authorization: `Bearer ${pair.access_token}` } }));
  assert.equal(caller, null);
});

test("the grant's mirror never holds a secret", async () => {
  const w = world();
  const { tokenId } = await connect(w);
  const mirror = w.store.get(`users/u-ana/tokens/${tokenId}`);
  for (const key of Object.keys(mirror)) assert.doesNotMatch(key, /hash|nonce|secret/i, key);
});

// --- /mcp --------------------------------------------------------------------

test("a refused /mcp request tells the client where to sign in", async () => {
  const w = world();
  const none = await w.mcp(null);
  assert.equal(none.status, 401);
  assert.equal(
    none.headers["www-authenticate"],
    'Bearer realm="bikeshed", resource_metadata="https://bikeshed.example/.well-known/oauth-protected-resource/mcp"',
  );
  assert.equal(none.headers["access-control-expose-headers"], "WWW-Authenticate");
  assert.equal(none.headers["cache-control"], "private, no-store");

  const bad = await w.mcp("nonsense");
  assert.match(bad.headers["www-authenticate"], /, error="invalid_token"$/);

  const get = await w.run(() => invoke(mcp, { method: "GET", path: "/mcp", headers: {} }));
  assert.equal(get.status, 405);
  assert.equal(get.headers["cache-control"], "private, no-store", "the 405 must not inherit Hosting's max-age=600");
});
