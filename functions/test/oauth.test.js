// SPDX-License-Identifier: Apache-2.0
// Discovery, redirect URIs, the guarded fetch and client identity, one unit at a time (SPEC §23).

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

process.env.BIKESHED_PUBLIC_ORIGIN = "https://bikeshed.example";
process.env.GCLOUD_PROJECT = "demo-bikeshed";
delete process.env.FUNCTIONS_EMULATOR;

const { invoke } = require("./fakes.js");
const { oauth } = require("../lib/index.js");
const metadata = require("../lib/oauth/metadata.js");
const { parseRedirectUri, redirectMatches, authorizationResponse } = require("../lib/oauth/redirect.js");
const {
  isPublicAddress,
  checkMetadataUrl,
  guardedLookup,
  readMetadataResponse,
  fetchClientMetadata,
} = require("../lib/oauth/fetch.js");
const {
  clientFromMetadata,
  registerClient,
  resolveClient,
  cleanClientName,
  clearClientCache,
  CLI_CLIENT_ID,
} = require("../lib/oauth/clients.js");

const fixture = (name) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", "cimd", `${name}.json`), "utf8"));

const get = (path, headers = {}) => invoke(oauth, { method: "GET", path, headers, body: undefined });

// --- Discovery ---------------------------------------------------------------

test("the authorization-server metadata advertises what Claude and ChatGPT select on", async () => {
  const r = await get("/.well-known/oauth-authorization-server");
  assert.equal(r.status, 200);
  const m = r.body;
  assert.equal(m.issuer, "https://bikeshed.example");
  assert.equal(m.authorization_endpoint, "https://bikeshed.example/connect");
  assert.equal(m.token_endpoint, "https://bikeshed.example/oauth/token");
  assert.equal(m.registration_endpoint, "https://bikeshed.example/oauth/register");
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  // Claude uses its published identity only when BOTH of these are present;
  // without either it falls back to registering a new client every time.
  assert.equal(m.client_id_metadata_document_supported, true);
  assert.ok(m.token_endpoint_auth_methods_supported.includes("none"));
  // ChatGPT uses its stable identity only when this is advertised.
  assert.equal(m.authorization_response_iss_parameter_supported, true);
  assert.equal("scopes_supported" in m, false, "no scope model to advertise");
});

test("the issuer is the protected resource's first authorization server, on every host", async () => {
  const as = (await get("/.well-known/oauth-authorization-server")).body;
  for (const host of [undefined, "bikeshed.example", "demo-bikeshed.web.app", "demo-bikeshed.firebaseapp.com"]) {
    const headers = host ? { "x-forwarded-host": host } : {};
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = (await get(path, headers)).body;
      // Compared byte for byte, as ChatGPT compares them.
      assert.equal(prm.authorization_servers[0], as.issuer, `${path} on ${host}`);
    }
  }
});

test("the protected resource names the host the person used, if it is one of ours", async () => {
  const on = async (headers) => (await get("/.well-known/oauth-protected-resource/mcp", headers)).body.resource;
  assert.equal(await on({}), "https://bikeshed.example/mcp");
  assert.equal(await on({ "x-forwarded-host": "demo-bikeshed.web.app" }), "https://demo-bikeshed.web.app/mcp");
  assert.equal(await on({ "x-forwarded-host": "DEMO-BIKESHED.firebaseapp.com" }), "https://demo-bikeshed.firebaseapp.com/mcp");
  // Anything else is somebody reaching the function directly with a header.
  assert.equal(await on({ "x-forwarded-host": "evil.example" }), "https://bikeshed.example/mcp");
  assert.equal(await on({ host: "evil.example" }), "https://bikeshed.example/mcp");
});

test("the protected resource is never cached by URL, and the server metadata is", async () => {
  // The resource names the host it was asked on, so a CDN keyed on the path
  // would serve one host's answer on another.
  const prm = await get("/.well-known/oauth-protected-resource");
  assert.equal(prm.headers["cache-control"], "private, no-store");
  const as = await get("/.well-known/oauth-authorization-server");
  assert.equal(as.headers["cache-control"], "public, max-age=300");
  assert.equal(as.headers["access-control-allow-origin"], "*");
});

test("an OpenID Connect probe gets a JSON 404, not the app", async () => {
  const r = await get("/.well-known/openid-configuration");
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "not_found");
});

test("the challenge points at the protected resource on the host that was asked", () => {
  const req = (headers = {}) => ({ headers });
  assert.equal(
    metadata.challenge(req(), false),
    'Bearer realm="bikeshed", resource_metadata="https://bikeshed.example/.well-known/oauth-protected-resource/mcp"',
  );
  assert.match(metadata.challenge(req({ "x-forwarded-host": "demo-bikeshed.web.app" }), true), /resource_metadata="https:\/\/demo-bikeshed\.web\.app\/\.well-known\/oauth-protected-resource\/mcp", error="invalid_token"$/);
});

test("a resource parameter is compared in canonical form", () => {
  assert.equal(metadata.canonicalResource("HTTPS://Bikeshed.Example/mcp/"), "https://bikeshed.example/mcp");
  assert.equal(metadata.canonicalResource("https://bikeshed.example/mcp?x=1"), null);
  assert.equal(metadata.canonicalResource("bikeshed.example/mcp"), null);
});

// --- Redirect URIs ------------------------------------------------------------

test("a redirect URI is decided on its parsed scheme, never on a string prefix", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,hi",
    "vbscript:x",
    "file:///etc/passwd",
    "http://example.com/cb",
    "https://example.com/cb#frag",
    "https://user:pw@example.com/cb",
    "https://example.com/c b",
    "",
  ]) {
    assert.equal(parseRedirectUri(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseRedirectUri("https://claude.ai/api/mcp/auth_callback").kind, "web");
  assert.equal(parseRedirectUri("http://127.0.0.1:3118/callback").kind, "loopback");
  assert.equal(parseRedirectUri("http://[::1]:3118/callback").kind, "loopback");
  assert.equal(parseRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback").kind, "app");
  assert.equal(parseRedirectUri("vscode://vscode.github-authentication/did-authenticate").kind, "app");
});

test("a loopback redirect matches on any port, and nothing else does", () => {
  assert.ok(redirectMatches("http://localhost/callback", "http://localhost:3118/callback"));
  assert.ok(redirectMatches("http://127.0.0.1/callback", "http://127.0.0.1:50000/callback"));
  // localhost and 127.0.0.1 can resolve differently, so neither stands for the other.
  assert.ok(!redirectMatches("http://localhost/callback", "http://127.0.0.1:3118/callback"));
  assert.ok(!redirectMatches("http://localhost/callback", "http://localhost:3118/other"));
  assert.ok(!redirectMatches("http://localhost/callback?a=1", "http://localhost:3118/callback?a=2"));
  // https is exact, port included.
  assert.ok(redirectMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback"));
  assert.ok(!redirectMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai:8443/api/mcp/auth_callback"));
  assert.ok(!redirectMatches("https://claude.ai/cb", "https://claude.ai/cb/"));
});

test("the authorization response keeps the client's own query and always carries iss", () => {
  assert.equal(
    authorizationResponse("https://app.example/cb", { code: "c", state: "s", iss: "https://bikeshed.example" }),
    "https://app.example/cb?code=c&state=s&iss=https%3A%2F%2Fbikeshed.example",
  );
  assert.equal(
    authorizationResponse("https://app.example/cb?tenant=1", { error: "access_denied", state: null, iss: "i" }),
    "https://app.example/cb?tenant=1&error=access_denied&iss=i",
  );
});

// --- The guarded fetch -------------------------------------------------------

test("only a public address may be connected to", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "not an address",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "160.79.104.10", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("a metadata URL must be https on 443 with a hostname and a path", () => {
  assert.ok(checkMetadataUrl("https://claude.ai/oauth/mcp-oauth-client-metadata"));
  for (const bad of [
    "http://claude.ai/x",
    "https://claude.ai",
    "https://claude.ai/",
    "https://claude.ai:8443/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://printer.local/x",
    "https://u:p@claude.ai/x",
    "https://claude.ai/x#y",
  ]) {
    assert.equal(checkMetadataUrl(bad), null, bad);
  }
});

test("the socket's own lookup refuses a name that resolves anywhere private", async () => {
  const resolving = (...addresses) => (_host, _opts, cb) =>
    cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  const run = (resolver) =>
    new Promise((resolve) => guardedLookup(resolver)("example.com", {}, (err, address) => resolve({ err, address })));

  assert.equal((await run(resolving("93.184.216.34"))).address, "93.184.216.34");
  assert.equal((await run(resolving("127.0.0.1"))).err.code, "EREFUSED_PRIVATE");
  // One private answer among public ones is the rebinding attack in miniature.
  assert.equal((await run(resolving("93.184.216.34", "10.0.0.1"))).err.code, "EREFUSED_PRIVATE");
  assert.equal((await run(resolving("::ffff:169.254.169.254"))).err.code, "EREFUSED_PRIVATE");
});

test("fetching through the guard never reaches a private address", async () => {
  // The lookup the real request uses is the guarded one: a name that resolves
  // to loopback fails before any connection is attempted.
  const lookup = (_host, _opts, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(
    fetchClientMetadata(new URL("https://client.example/metadata.json"), { lookup, timeoutMs: 2000 }),
    /not a public address/,
  );
});

test("a metadata response is read only when it is a 200, under the cap, and JSON", async () => {
  const response = (status, body) => {
    const s = new PassThrough();
    s.statusCode = status;
    process.nextTick(() => s.end(body));
    return s;
  };
  assert.deepEqual(await readMetadataResponse(response(200, '{"a":1}')), { a: 1 });
  await assert.rejects(readMetadataResponse(response(302, "")), /redirects are not followed/);
  await assert.rejects(readMetadataResponse(response(200, "x".repeat(20000))), /too large/);
  await assert.rejects(readMetadataResponse(response(200, "<html>")), /not JSON/);
});

// --- Client identity ----------------------------------------------------------

test("the real Claude, Claude Code and ChatGPT metadata documents are accepted", () => {
  for (const [name, expected] of [
    ["claude", { name: "Claude", host: "claude.ai" }],
    ["claude-code", { name: "Claude Code", host: "claude.ai" }],
    ["chatgpt", { name: "ChatGPT", host: "chatgpt.com" }],
  ]) {
    const doc = fixture(name);
    const client = clientFromMetadata(doc, doc.client_id, new URL(doc.client_id).hostname);
    assert.ok(client, `${name} was refused`);
    assert.equal(client.name, expected.name);
    assert.equal(client.host, expected.host);
    assert.equal(client.verified, true);
    assert.equal(client.registration, "cimd");
  }
});

test("a metadata document must name the URL it was served from", () => {
  const doc = fixture("claude");
  assert.equal(clientFromMetadata(doc, "https://claude.ai/oauth/other", "claude.ai"), null);
  assert.equal(clientFromMetadata({ ...doc, redirect_uris: [] }, doc.client_id, "claude.ai"), null);
  assert.equal(
    clientFromMetadata({ ...doc, token_endpoint_auth_method: "client_secret_basic" }, doc.client_id, "claude.ai"),
    null,
    "nothing here can hold a client secret",
  );
});

test("resolving a metadata client fetches once and remembers", async () => {
  clearClientCache();
  const doc = fixture("chatgpt");
  let fetches = 0;
  const deps = { fetchMetadata: async () => (fetches++, doc) };
  const first = await resolveClient(doc.client_id, deps);
  const second = await resolveClient(doc.client_id, deps);
  assert.equal(first.host, "chatgpt.com");
  assert.deepEqual(second, first);
  assert.equal(fetches, 1);
  clearClientCache();
  assert.equal(await resolveClient(doc.client_id, { fetchMetadata: async () => { throw new Error("down"); } }), null);
});

test("registration writes nothing, and its client_id carries the registration", async () => {
  const r = registerClient({ redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"], client_name: "Cursor" });
  assert.equal(r.status, 201);
  assert.equal(r.body.token_endpoint_auth_method, "none");
  const client = await resolveClient(r.body.client_id);
  assert.equal(client.registration, "dcr");
  assert.equal(client.verified, false);
  assert.equal(client.host, null, "a self-registered client has no verified host");
  assert.deepEqual(client.redirectUris, ["cursor://anysphere.cursor-retrieval/oauth/callback"]);
});

test("registration refuses a redirect URI that could run in the browser", () => {
  for (const uri of ["javascript:alert(1)", "http://evil.example/cb", "data:,x"]) {
    assert.equal(registerClient({ redirect_uris: [uri] }).status, 400, uri);
  }
  assert.equal(registerClient({}).status, 400);
});

test("a hand-built registration id is re-validated, not trusted because it decodes", async () => {
  const forged = `bsdcr_${Buffer.from(JSON.stringify({ n: "Claude", r: ["javascript:alert(1)"] })).toString("base64url")}`;
  assert.equal(await resolveClient(forged), null);
});

test("a client's chosen name loses control and format characters", () => {
  // U+202E reverses the text after it; U+200B is invisible. Either can make one
  // name look like another.
  assert.equal(cleanClientName("Cla​ude‮", "x"), "Claude");
  assert.equal(cleanClientName("  \u0007  ", "fallback"), "fallback");
  assert.equal(cleanClientName("a".repeat(200), "x").length, 80);
});

test("the command line is a built-in client that may only return to this computer", async () => {
  const cli = await resolveClient(CLI_CLIENT_ID);
  assert.equal(cli.registration, "builtin");
  assert.ok(cli.redirectUris.every((u) => parseRedirectUri(u).kind === "loopback"));
  assert.ok(cli.redirectUris.some((u) => redirectMatches(u, "http://127.0.0.1:61234/callback")));
  assert.ok(!cli.redirectUris.some((u) => redirectMatches(u, "https://evil.example/callback")));
});
