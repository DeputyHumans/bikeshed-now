// SPDX-License-Identifier: Apache-2.0
// An organisation's identity assertion connecting an app: checks, the managed row, reuse and opt-out (SPEC §23).

/**
 * Real ES256 signatures, made here with a key generated per run, so every
 * refusal is a refusal of a correctly signed JWT unless the case says
 * otherwise. Sequences share one store, as a real client's would: exchange,
 * exchange again, revoke, exchange again.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync, randomBytes, sign } = require("node:crypto");

const ISSUER = "https://idp.example/issuers/test-org";
process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
process.env.GCLOUD_PROJECT = "demo-bikeshed";
process.env.BIKESHED_ID_JAG_ISSUERS = ISSUER;
process.env.BIKESHED_ID_JAG_DOMAINS = "example.com new.example";
delete process.env.FUNCTIONS_EMULATOR;

const { fakeFirestore, withFakeAdmin, invoke } = require("./fakes.js");
const { oauth, mcp, manageTokens } = require("../lib/index.js");
const { handleToken } = require("../lib/oauth/token.js");
const { clearIssuerKeyCache } = require("../lib/oauth/assertion.js");
const { clearClientCache } = require("../lib/oauth/clients.js");
const { managedTokenId, MAX_LIVE } = require("../lib/oauth/managed.js");

const AS = "https://bikeshed.example";
const RESOURCE = `${AS}/mcp`;
const CLAUDE = require("./fixtures/cimd/claude.json");
const CLAUDE_ID = CLAUDE.client_id;
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";
const OTHER_ID = "https://other.example/client.json";
const OTHER = {
  client_id: OTHER_ID,
  client_name: "Other",
  redirect_uris: ["https://other.example/cb"],
  token_endpoint_auth_method: "none",
};

const ANA_TOKEN = { uid: "u-ana", email: "ana@example.com", email_verified: true };
const ANA_USER = {
  uid: "u-ana",
  email: "ana@example.com",
  emailVerified: true,
  disabled: false,
  tokensValidAfterTime: new Date(0).toUTCString(),
};

const issuerKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const strangerKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const JWK = { ...issuerKey.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "ES256" };

/** The issuer's published documents and Claude's, and a record of every fetch. */
function issuerSite({ down = false, clientDown = false } = {}) {
  const fetched = [];
  const fetchMetadata = async (url) => {
    fetched.push(url.href);
    // A turn of the event loop, so requests made together really overlap.
    await new Promise((resolve) => setImmediate(resolve));
    if (down && url.href.startsWith(ISSUER)) throw new Error("issuer unreachable");
    if (clientDown && url.href === CLAUDE_ID) throw new Error("client metadata unreachable");
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) return { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks.json` };
    if (url.href === `${ISSUER}/jwks.json`) return { keys: [JWK] };
    if (url.href === CLAUDE_ID) return CLAUDE;
    if (url.href === OTHER_ID) return OTHER;
    throw new Error(`unexpected fetch of ${url.href}`);
  };
  return { fetched, fetchMetadata };
}

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A signed assertion; `undefined` in claims removes a claim. */
function assertion(claims = {}, header = {}, key = issuerKey.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = { typ: "oauth-id-jag+jwt", alg: "ES256", kid: "k1", ...header };
  const c = {
    iss: ISSUER,
    sub: "idp-user-ana",
    aud: AS,
    client_id: CLAUDE_ID,
    jti: randomBytes(9).toString("base64url"),
    iat: now,
    exp: now + 300,
    email: "Ana@Example.com",
    resource: RESOURCE,
    ...claims,
  };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  const data = `${enc(h)}.${enc(c)}`;
  const sig = sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${data}.${sig}`;
}

function world({ users = { "u-ana": { ...ANA_USER } }, site = issuerSite() } = {}) {
  clearIssuerKeyCache();
  clearClientCache();
  const { db, store } = fakeFirestore();
  const env = { db, sessions: { "ana-session": ANA_TOKEN }, users };
  const run = (fn) => withFakeAdmin(env, fn);
  // withFakeAdmin swaps the admin module for the length of its callback, so
  // requests meant to overlap must share ONE run, or one restores the real
  // module under the other.
  const postRaw = (fields) =>
    invoke((req, res) => handleToken(req, res, { fetchMetadata: site.fetchMetadata }), {
      path: "/oauth/token",
      rawBody: Buffer.from(new URLSearchParams(fields).toString()),
      body: {},
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  const post = (fields) => run(() => postRaw(fields));
  const exchangeFields = (jwt, extra) => ({ grant_type: JWT_BEARER, assertion: jwt, client_id: CLAUDE_ID, ...extra });
  return {
    db,
    store,
    users,
    site,
    post,
    exchange(jwt, extra = {}) {
      return post(exchangeFields(jwt, extra));
    },
    /** Several exchanges at once, inside one fake admin. */
    together(jwts) {
      return run(() => Promise.all(jwts.map((jwt) => postRaw(exchangeFields(jwt, {})))));
    },
    mcp(bearer) {
      return run(() =>
        invoke(mcp, {
          path: "/mcp",
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          headers: { authorization: `Bearer ${bearer}` },
        }),
      );
    },
    list() {
      return run(() => invoke(manageTokens, { body: { op: "list" }, headers: { cookie: "__session=ana-session" } }));
    },
    revoke(tokenId) {
      return run(() =>
        invoke(manageTokens, { body: { op: "revoke", tokenId }, headers: { cookie: "__session=ana-session" } }),
      );
    },
    metadata() {
      return run(() => invoke(oauth, { method: "GET", path: "/.well-known/oauth-authorization-server" }));
    },
    tokenRows() {
      return [...store.keys()].filter((p) => /^tokens\/[^/]+$/.test(p));
    },
  };
}

const ROW = `tokens/${managedTokenId(ISSUER, "u-ana", "ana@example.com", CLAUDE_ID)}`;
const secretOf = (accessToken) => accessToken.split(".")[1];
const sha256 = (v) => createHash("sha256").update(v, "utf8").digest("hex");

test("a trusted assertion connects Claude: an access token for /mcp, no refresh token, one listed row", async () => {
  const w = world();
  const r = await w.exchange(assertion());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.token_type, "Bearer");
  assert.equal(r.body.refresh_token, undefined, "the draft says not to issue one");
  assert.ok(r.body.expires_in > 3500 && r.body.expires_in <= 3600, String(r.body.expires_in));
  assert.match(r.body.access_token, /^bsa_[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);

  const m = await w.mcp(r.body.access_token);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.ok(Array.isArray(m.body.result?.tools), "the token reaches the tools");

  const row = w.store.get(ROW);
  assert.ok(row, "the row is the one derived from (issuer, person, address, client)");
  assert.equal(row.kind, "oauth");
  assert.equal(row.uid, "u-ana");
  assert.equal(row.email, "ana@example.com", "lowercased, as every address here is");
  assert.deepEqual(row.managed, { issuer: ISSUER, subject: "idp-user-ana" });
  assert.equal(row.resource, RESOURCE);
  assert.equal(row.refreshHash, undefined, "no refresh token can exist for it");

  const l = await w.list();
  assert.equal(l.status, 200);
  assert.equal(l.body.tokens.length, 1);
  const t = l.body.tokens[0];
  assert.equal(t.kind, "oauth");
  assert.equal(t.name, "Claude");
  assert.equal(t.clientHost, "claude.ai");
  assert.equal(t.clientVerified, true);
  assert.equal(t.managedBy, "idp.example", "the account screen says who connected it");
  const mirror = w.store.get(`users/u-ana/tokens/${row.tokenId}`);
  assert.equal(mirror.nonce, undefined, "the owner-readable mirror never carries the nonce");
  assert.equal(mirror.managedBy, "idp.example");
});

test("each exchange gets its own token, and exchanges at once never cut each other off", async () => {
  const w = world();
  const [a, b] = await w.together([assertion(), assertion()]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.notEqual(a.body.access_token, b.body.access_token);
  assert.equal((await w.mcp(a.body.access_token)).status, 200);
  assert.equal((await w.mcp(b.body.access_token)).status, 200);
  assert.equal(w.tokenRows().length, 1, "one connection, however many exchanges");
  assert.equal(w.store.get(ROW).liveAccess.length, 2);
});

test("the store alone yields no token: the row keeps hashes, and a token needs its assertion", async () => {
  const w = world();
  const r = await w.exchange(assertion());
  const secret = secretOf(r.body.access_token);
  const row = w.store.get(ROW);
  const mirror = w.store.get(`users/u-ana/tokens/${row.tokenId}`);
  assert.equal(row.liveAccess[0].h, sha256(secret));
  assert.ok(!JSON.stringify(row).includes(secret), "the row never holds the secret");
  assert.ok(!JSON.stringify(mirror).includes(secret));
  assert.equal(row.accessHash, undefined, "a managed row has no single current secret to derive");
});

test("a token works until its own expiry, then drops off the row", async () => {
  const w = world();
  const first = await w.exchange(assertion());
  w.store.get(ROW).liveAccess[0].exp = Date.now() - 1;
  assert.equal((await w.mcp(first.body.access_token)).status, 401);
  const second = await w.exchange(assertion());
  assert.equal((await w.mcp(second.body.access_token)).status, 200);
  assert.equal(w.store.get(ROW).liveAccess.length, 1, "the expired entry is pruned");
});

test("a retry of the same assertion within a minute gets the same token; after that it is spent", async () => {
  const w = world();
  const jwt = assertion();
  const first = await w.exchange(jwt);
  assert.equal(first.status, 200);
  const retry = await w.exchange(jwt);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.access_token, first.body.access_token, "a client that timed out gets what it missed");
  assert.equal(w.store.get(ROW).liveAccess.length, 1, "a retry mints nothing");

  w.store.get(ROW).liveAccess[0].at = Date.now() - 61 * 1000;
  const late = await w.exchange(jwt);
  assert.equal(late.status, 400);
  assert.equal(late.body.error, "invalid_grant");
  assert.match(late.body.error_description, /already been used/);
});

test("the live list is bounded without forgetting an assertion that could still be presented", async () => {
  const w = world();
  await w.exchange(assertion());
  const row = w.store.get(ROW);
  const now = Date.now();
  row.liveAccess = Array.from({ length: MAX_LIVE }, (_, i) => ({
    h: sha256(`x${i}`), exp: now + 3_000_000, j: sha256(`j${i}`), ax: now + 300_000, at: now - 1000,
  }));
  const full = await w.exchange(assertion());
  assert.equal(full.status, 400);
  assert.match(full.body.error_description, /too many/);

  row.liveAccess[7].ax = now - 120_000;
  const room = await w.exchange(assertion());
  assert.equal(room.status, 200, JSON.stringify(room.body));
  assert.equal(w.store.get(ROW).liveAccess.length, MAX_LIVE);
  assert.ok(!w.store.get(ROW).liveAccess.some((e) => e.j === sha256("j7")), "only the expired assertion was forgotten");
});

test("revoking is sticky: the organisation cannot reconnect the person afterwards", async () => {
  const w = world();
  const r = await w.exchange(assertion());
  const tokenId = w.store.get(ROW).tokenId;
  assert.equal((await w.revoke(tokenId)).status, 200);
  assert.equal((await w.mcp(r.body.access_token)).status, 401);

  const again = await w.exchange(assertion());
  assert.equal(again.status, 400);
  assert.equal(again.body.error, "access_denied");
  assert.match(again.body.error_description, /turned off/);
  assert.notEqual(w.store.get(ROW).revokedAt, null, "the revocation stands");
});

test("an address that now belongs to someone else at the issuer is refused", async () => {
  const w = world();
  assert.equal((await w.exchange(assertion())).status, 200);
  const r = await w.exchange(assertion({ sub: "idp-user-someone-new" }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "access_denied");
});

test("the person must already have an account, and pass the gate", async () => {
  const nobody = world({ users: {} });
  const r = await nobody.exchange(assertion());
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "access_denied");
  assert.equal(nobody.tokenRows().length, 0, "an assertion never creates an account or a row");

  for (const [label, patch] of [
    ["unverified", { emailVerified: false }],
    ["disabled", { disabled: true }],
  ]) {
    const w = world({ users: { "u-ana": { ...ANA_USER, ...patch } } });
    const x = await w.exchange(assertion());
    assert.equal(x.status, 400, label);
    assert.equal(x.body.error, "access_denied", label);
    assert.equal(w.tokenRows().length, 0, label);
  }

  const failing = world({ users: { "u-ana": { ...ANA_USER } } });
  failing.users["u-ana"] = Object.assign(new Error("auth down"), { code: "auth/internal-error", email: "ana@example.com" });
  const y = await failing.exchange(assertion());
  assert.equal(y.status, 500, "an Auth blip of ours is never invalid_grant");

  // Found by address, then the gate's own re-read fails: "unknown" is not "closed".
  const blip = world({
    users: { lookup: { ...ANA_USER }, "u-ana": Object.assign(new Error("auth down"), { code: "auth/internal-error" }) },
  });
  const z = await blip.exchange(assertion());
  assert.equal(z.status, 500, JSON.stringify(z.body));
  assert.equal(z.body.error, "server_error");
});

test("a sign-out everywhere does not lock out what the organisation signs afterwards", async () => {
  const w = world();
  assert.equal((await w.exchange(assertion())).status, 200);
  w.store.get(ROW).createdAtMs = Date.now() - 60 * 60 * 1000;
  w.users["u-ana"] = { ...ANA_USER, tokensValidAfterTime: new Date(Date.now() - 30 * 60 * 1000).toUTCString() };
  const r = await w.exchange(assertion());
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("an account move starts a fresh connection under the new address", async () => {
  const w = world();
  assert.equal((await w.exchange(assertion())).status, 200);
  // What the move does (SPEC §14): rows under the old address are revoked,
  // and the account now answers to the new one.
  w.store.get(ROW).revokedAt = { moved: true };
  w.users["u-ana"] = { ...ANA_USER, email: "ana@new.example" };
  const r = await w.exchange(assertion({ email: "ana@new.example" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const moved = `tokens/${managedTokenId(ISSUER, "u-ana", "ana@new.example", CLAUDE_ID)}`;
  assert.notEqual(moved, ROW);
  assert.ok(w.store.get(moved));
  assert.notEqual(w.store.get(ROW).revokedAt, null, "the old connection stays revoked");
});

test("each app gets its own connection, and revoking one leaves the other", async () => {
  const w = world();
  const claude = await w.exchange(assertion());
  const other = await w.exchange(assertion({ client_id: OTHER_ID }), { client_id: OTHER_ID });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal(w.tokenRows().length, 2);
  assert.equal((await w.revoke(w.store.get(ROW).tokenId)).status, 200);
  assert.equal((await w.mcp(claude.body.access_token)).status, 401);
  assert.equal((await w.mcp(other.body.access_token)).status, 200);
  const otherRow = w.store.get(`tokens/${managedTokenId(ISSUER, "u-ana", "ana@example.com", OTHER_ID)}`);
  assert.equal(otherRow.name, "Other", "each row credits its own app");
});

test("every check on the assertion refuses with invalid_grant and writes nothing", async () => {
  const now = Math.floor(Date.now() / 1000);
  const good = assertion();
  const [h, p] = good.split(".");
  const tampered = `${h}.${enc({ ...JSON.parse(Buffer.from(p, "base64url")), email: "mallory@example.com" })}.${good.split(".")[2]}`;
  const cases = [
    ["wrong typ", assertion({}, { typ: "JWT" })],
    ["no typ", assertion({}, { typ: undefined })],
    ["alg none", `${enc({ typ: "oauth-id-jag+jwt", alg: "none", kid: "k1" })}.${p}.`],
    ["alg HS256", assertion({}, { alg: "HS256" })],
    ["critical header", assertion({}, { crit: ["exp"] })],
    ["no kid", assertion({}, { kid: undefined })],
    ["unknown kid", assertion({}, { kid: "k-unknown" })],
    ["another key", assertion({}, {}, strangerKey.privateKey)],
    ["tampered payload", tampered],
    ["not a JWT", "not.a-jwt"],
    ["another audience", assertion({ aud: "https://elsewhere.example" })],
    ["two audiences", assertion({ aud: [AS, "https://elsewhere.example"] })],
    ["expired", assertion({ iat: now - 900, exp: now - 120 })],
    ["expires too far ahead", assertion({ exp: now + 20 * 60 })],
    ["issued in the future", assertion({ iat: now + 600, exp: now + 660 })],
    ["not valid yet", assertion({ nbf: now + 600 })],
    ["no exp", assertion({ exp: undefined })],
    ["no iat", assertion({ iat: undefined })],
    ["no sub", assertion({ sub: undefined })],
    ["no jti", assertion({ jti: undefined })],
    ["no email", assertion({ email: undefined })],
    ["no client_id", assertion({ client_id: undefined })],
    ["a tenant", assertion({ aud_tenant: "acme" })],
    ["a proof-of-possession key", assertion({ cnf: { jkt: "x" } })],
    ["another server's resource", assertion({ resource: "https://elsewhere.example/mcp" })],
  ];
  for (const [label, jwt] of cases) {
    const w = world();
    const r = await w.exchange(jwt);
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_grant", `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(w.tokenRows().length, 0, label);
  }
});

test("an issuer nobody configured is refused before anything is fetched", async () => {
  const w = world();
  const r = await w.exchange(assertion({ iss: "https://idp.example/issuers/other-org" }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_grant");
  assert.deepEqual(w.site.fetched, [], "an untrusted iss must not make this server fetch anything");
});

test("the request's client must be the assertion's, and must publish its metadata", async () => {
  const w = world();
  const r = await w.exchange(assertion(), { client_id: "https://other.example/client.json" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_grant");

  const cli = await w.exchange(assertion({ client_id: "bikeshed-cli" }), { client_id: "bikeshed-cli" });
  assert.equal(cli.status, 400);
  assert.equal(cli.body.error, "invalid_client");
  assert.equal(w.tokenRows().length, 0);
});

test("a resource parameter must be this server's and agree with the assertion", async () => {
  const w = world();
  const off = await w.exchange(assertion({ resource: undefined }), { resource: "https://elsewhere.example/mcp" });
  assert.equal(off.body.error, "invalid_target", JSON.stringify(off.body));
  const other = await w.exchange(assertion(), { resource: "https://demo-bikeshed.web.app/mcp" });
  assert.equal(other.body.error, "invalid_target", "ours, but not the one the assertion names");
  const ok = await w.exchange(assertion({ resource: undefined }), { resource: `${RESOURCE}/` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(w.store.get(ROW).resource, RESOURCE);
});

test("an unknown kid fetches the keys again, but not on every request", async () => {
  const w = world();
  assert.equal((await w.exchange(assertion())).status, 200);
  const before = w.site.fetched.filter((u) => u.startsWith(ISSUER)).length;
  await w.exchange(assertion({}, { kid: "k-unknown" }));
  await w.exchange(assertion({}, { kid: "k-unknown" }));
  const after = w.site.fetched.filter((u) => u.startsWith(ISSUER)).length;
  assert.equal(after, before, "inside a minute of the last fetch, an unknown kid buys no fetch");
});

test("an unreachable issuer is our failure, not the assertion's, and is not asked again at once", async () => {
  const w = world({ site: issuerSite({ down: true }) });
  const r = await w.post({ grant_type: JWT_BEARER, assertion: assertion(), client_id: CLAUDE_ID });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "server_error");
  const again = await w.post({ grant_type: JWT_BEARER, assertion: assertion(), client_id: CLAUDE_ID });
  assert.equal(again.status, 500);
  assert.equal(w.site.fetched.filter((u) => u.startsWith(ISSUER)).length, 1, "a failure backs off rather than fetching again");
});

test("requests waiting on the same issuer share one fetch", async () => {
  const w = world();
  const rs = await w.together([assertion(), assertion(), assertion()]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  const discovery = w.site.fetched.filter((u) => u === `${ISSUER}/.well-known/openid-configuration`);
  assert.equal(discovery.length, 1);
});

test("an unreachable client metadata document is our failure, not a bad client", async () => {
  const w = world({ site: issuerSite({ clientDown: true }) });
  const r = await w.exchange(assertion());
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.error, "server_error");
});

test("the grant is advertised and accepted only where an issuer is configured", async () => {
  const w = world();
  const on = await w.metadata();
  assert.ok(on.body.grant_types_supported.includes(JWT_BEARER));
  assert.deepEqual(on.body.authorization_grant_profiles_supported, [PROFILE]);

  const saved = process.env.BIKESHED_ID_JAG_ISSUERS;
  try {
    process.env.BIKESHED_ID_JAG_ISSUERS = "";
    const off = await w.metadata();
    assert.deepEqual(off.body.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.equal(off.body.authorization_grant_profiles_supported, undefined);
    const r = await w.exchange(assertion());
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "unsupported_grant_type");
    assert.deepEqual(w.site.fetched, []);

    process.env.BIKESHED_ID_JAG_ISSUERS = "http://idp.example/plain-http not-a-url";
    assert.equal((await w.metadata()).body.authorization_grant_profiles_supported, undefined, "only https issuers count");
  } finally {
    process.env.BIKESHED_ID_JAG_ISSUERS = saved;
  }
});

test("an issuer with no domains listed is not trusted at all: the grant is off and unadvertised", async () => {
  const w = world();
  const saved = process.env.BIKESHED_ID_JAG_DOMAINS;
  try {
    for (const none of ["", "  ,  ", "not a domain"]) {
      process.env.BIKESHED_ID_JAG_DOMAINS = none;
      const off = await w.metadata();
      assert.deepEqual(off.body.grant_types_supported, ["authorization_code", "refresh_token"], JSON.stringify(none));
      assert.equal(off.body.authorization_grant_profiles_supported, undefined);
      const r = await w.exchange(assertion());
      assert.deepEqual([r.status, r.body.error], [400, "unsupported_grant_type"], JSON.stringify(none));
    }
    assert.deepEqual(w.site.fetched, [], "nothing is fetched for a grant that is off");
  } finally {
    process.env.BIKESHED_ID_JAG_DOMAINS = saved;
  }
});

test("an issuer connects only addresses at the listed domains, exactly", async () => {
  // A trusted issuer could otherwise connect any account here, an
  // administrator's included, by asserting its address.
  const w = world({
    users: {
      "u-ana": { ...ANA_USER },
      "u-root": { uid: "u-root", email: "root@elsewhere.org", emailVerified: true, disabled: false, tokensValidAfterTime: new Date(0).toUTCString() },
      "u-sub": { uid: "u-sub", email: "ana@sub.example.com", emailVerified: true, disabled: false, tokensValidAfterTime: new Date(0).toUTCString() },
    },
  });
  for (const email of ["root@elsewhere.org", "ana@sub.example.com", "ana@example.com.evil.org"]) {
    const r = await w.exchange(assertion({ email }));
    assert.deepEqual([r.status, r.body.error], [400, "invalid_grant"], email);
    assert.match(r.body.error_description, /at that domain/, email);
  }
  assert.equal([...w.store.keys()].filter((k) => k.startsWith("tokens/")).length, 0, "nothing written");
  assert.equal((await w.exchange(assertion())).status, 200, "the listed domain, in any case");
});

test("an address the issuer says it has not verified is refused; silence is not", async () => {
  const w = world();
  for (const email_verified of [false, "false", 0, null]) {
    const r = await w.exchange(assertion({ email_verified }));
    assert.deepEqual([r.status, r.body.error], [400, "invalid_grant"], JSON.stringify(email_verified));
    assert.match(r.body.error_description, /not verified/);
  }
  for (const email_verified of [true, "true", undefined]) {
    assert.equal((await w.exchange(assertion({ email_verified }))).status, 200, JSON.stringify(email_verified));
  }
});

test("the domains are read as an operator writes them", () => {
  const { idJagDomains } = require("../lib/config.js");
  const saved = process.env.BIKESHED_ID_JAG_DOMAINS;
  try {
    process.env.BIKESHED_ID_JAG_DOMAINS = "dassui.ai,deputyhumans.com";
    assert.deepEqual(idJagDomains(), ["dassui.ai", "deputyhumans.com"]);
    process.env.BIKESHED_ID_JAG_DOMAINS = " @Example.COM, ,example.org  example.com localhost a@b.c";
    assert.deepEqual(idJagDomains(), ["example.com", "example.org"]);
  } finally {
    process.env.BIKESHED_ID_JAG_DOMAINS = saved;
  }
});
