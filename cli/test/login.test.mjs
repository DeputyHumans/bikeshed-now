// SPDX-License-Identifier: Apache-2.0
// Browser sign-in, driven end to end with the test playing the browser (SPEC §23)

/**
 * The real binary against a fake deployment, with this file as the browser.
 *
 * The deployment half is small: metadata, a token endpoint that checks the
 * PKCE verifier against the challenge the CLI put in the address it printed,
 * and enough of /mcp for the token check after it. The browser half reads that
 * address from stderr and visits the redirect the way a browser would after
 * Approve, or after a forgery.
 *
 * Every child gets `--no-browser`, so no run opens a real one, and CI is
 * removed from its environment, because GitHub Actions sets it and the CLI
 * refuses to wait for a person there. The two tests about CI set it back.
 *
 * Children are SPAWNED, not exec'd: the fake deployment lives on this
 * process's event loop, and the test has to read the address while the child
 * is still waiting on the callback (the `withServer` rule in cli.test.mjs).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const login = await import(`${SRC}/login.mjs`);
const client = await import(`${SRC}/client.mjs`);

const SECRET = "s3cr3t-Secret_value-s3cr3t-Secret_val";
const TOKEN = `bsk_${"0123456789abcdef".repeat(2)}.${SECRET}`;
const LONG = { timeout: 20_000 };

// --- The fake deployment ----------------------------------------------------

/**
 * `flow` is shared with the test: it writes the challenge it read from the
 * printed address, the code it is about to hand back, and the callback port.
 */
async function withDeployment(options, body) {
  const flow = options.flow ?? {};
  const seen = { metadata: 0, token: [], mcp: [], tokens: [] };
  // Revoking TOKEN through /tokens ends it on /mcp too, as on a deployment.
  let revoked = options.revoked ?? false;
  let origin;
  const json = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", async () => {
      if (req.url === "/.well-known/oauth-authorization-server") {
        seen.metadata += 1;
        if (options.metadata) return options.metadata(res, origin);
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/connect`,
          token_endpoint: `${origin}/oauth/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (req.method === "POST" && req.url === "/oauth/token") {
        const form = Object.fromEntries(new URLSearchParams(raw));
        const entry = { form, contentType: req.headers["content-type"] };
        seen.token.push(entry);
        // The check a real token endpoint makes, against the challenge the
        // CLI sent the browser to the consent page with.
        entry.pkce =
          Boolean(flow.challenge) &&
          createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === flow.challenge;
        if (flow.port) entry.listenerGone = await refuses(flow.port);
        if (options.token) return options.token(res, form);
        if (!entry.pkce || form.code !== flow.code) {
          return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        return json(res, 200, { access_token: TOKEN, token_type: "Bearer" });
      }
      if (req.method === "POST" && req.url === "/mcp") {
        seen.mcp.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
        if (revoked || req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, {
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { documents: [], nextCursor: null } },
        });
      }
      if (req.method === "POST" && req.url === "/tokens") {
        seen.tokens.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
        if (options.tokens) return options.tokens(res);
        if (revoked || req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401);
          return res.end();
        }
        revoked = true;
        return json(res, 200, { revoked: true });
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await body({ origin, seen, flow });
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

// --- The terminal and the browser -------------------------------------------

/** Spawn `bikeshed login …`, streaming stderr so the address can be read live. */
function runLogin(args, { env = {}, stdin = "" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bikeshed-login-"));
  const childEnv = { ...process.env, XDG_CONFIG_HOME: home };
  for (const name of ["CI", "BIKESHED_TOKEN", "BIKESHED_ORIGIN", "SSH_CONNECTION", "SSH_TTY"]) {
    delete childEnv[name];
  }
  // A child that is never answered gives up on its own, well inside the test
  // timeout, rather than outliving the run.
  Object.assign(childEnv, { BIKESHED_LOGIN_TIMEOUT_MS: "10000" }, env);

  const child = spawn(process.execPath, [join(SRC, "index.mjs"), "login", ...args], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(stdin);
  let stdout = "";
  let stderr = "";
  let ended = false;
  const watchers = new Set();
  child.stdout.setEncoding("utf8").on("data", (d) => {
    stdout += d;
  });
  child.stderr.setEncoding("utf8").on("data", (d) => {
    stderr += d;
    for (const w of watchers) w();
  });
  // A child that hangs (a listener left open keeps its event loop alive) is
  // killed, so the test fails on its exit status instead of never finishing.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const exited = new Promise((resolve) =>
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      ended = true;
      for (const w of watchers) w();
      resolve({ code, signal, stdout, stderr });
    }),
  );

  const waitFor = (re) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const match = stderr.match(re);
        if (match) {
          watchers.delete(check);
          resolve(match);
        } else if (ended) {
          watchers.delete(check);
          reject(new Error(`exited before printing ${re}:\n${stderr}`));
        }
      };
      watchers.add(check);
      check();
    });

  return {
    child,
    exited,
    home,
    configPath: join(home, "bikeshed", "config.json"),
    /** The consent address, which is printed on a line of its own. */
    authorizeUrl: async () => new URL((await waitFor(/^ {2}(https?:\/\/\S+)$/m))[1]),
    cleanup() {
      if (!ended) child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Where the browser would land, with the given query. */
function callbackFor(authorize, params) {
  const target = new URL(authorize.searchParams.get("redirect_uri"));
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target;
}

/** A GET the way a browser makes it, or with a Host it would not send. */
function visit(target, { method = "GET", headers = {} } = {}) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** True when nothing is listening on the port any more. */
function refuses(port) {
  return new Promise((resolve) => {
    const socket = connect(Number(port), "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

function assertPageHeaders(headers) {
  assert.equal(headers["content-type"], "text/html; charset=utf-8");
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'");
}

// --- The whole flow -----------------------------------------------------------

test("browser sign-in saves a token that PKCE proved belongs to this run", LONG, async () => {
  const flow = {};
  await withDeployment({ flow }, async ({ origin, seen }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      const params = authorize.searchParams;
      assert.equal(`${authorize.origin}${authorize.pathname}`, `${origin}/connect`);
      assert.equal(params.get("response_type"), "code");
      assert.equal(params.get("client_id"), "bikeshed-cli");
      // The literal, never `localhost`, and on whatever port the OS gave.
      assert.match(params.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      assert.equal(params.get("code_challenge_method"), "S256");
      assert.match(params.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
      assert.match(params.get("state"), /^[A-Za-z0-9_-]{22,}$/);
      assert.equal(params.get("resource"), `${origin}/mcp`);
      assert.ok(params.get("device"), "the consent page is told which machine is asking");
      assert.ok([...params.get("device")].length <= 60);

      flow.challenge = params.get("code_challenge");
      flow.code = "code-right";
      flow.port = new URL(params.get("redirect_uri")).port;
      const page = await visit(callbackFor(authorize, { code: "code-right", state: params.get("state"), iss: origin }));
      assert.equal(page.status, 200);
      assert.match(page.body, /signed in/i);
      assertPageHeaders(page.headers);

      const { code, stdout, stderr } = await run.exited;
      assert.equal(code, 0, stderr);

      assert.equal(seen.token.length, 1);
      const [exchange] = seen.token;
      assert.match(exchange.contentType, /^application\/x-www-form-urlencoded/);
      assert.equal(exchange.pkce, true, "sha256(code_verifier) must equal the challenge the browser carried");
      assert.deepEqual(exchange.form, {
        grant_type: "authorization_code",
        code: "code-right",
        redirect_uri: params.get("redirect_uri"),
        client_id: "bikeshed-cli",
        code_verifier: exchange.form.code_verifier,
        resource: `${origin}/mcp`,
      });
      // One request, then gone: the listener closed before the code was traded.
      assert.equal(exchange.listenerGone, true, "the callback port still answers during the exchange");

      assert.equal(seen.mcp.length, 1, "the token is checked before it is saved");
      assert.equal(seen.mcp[0].authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(JSON.parse(readFileSync(run.configPath, "utf8")), { origin, token: TOKEN, via: "browser" });
      if (process.platform !== "win32") {
        assert.equal(statSync(run.configPath).mode & 0o777, 0o600);
      }

      for (const secret of [TOKEN, SECRET, exchange.form.code_verifier]) {
        assert.equal(stdout.includes(secret), false, "a secret reached stdout");
        assert.equal(stderr.includes(secret), false, "a secret reached stderr");
      }
    } finally {
      run.cleanup();
    }
  });
});

test("--json leaves stdout parseable, and a token in the environment is called out", LONG, async () => {
  const flow = {};
  await withDeployment({ flow }, async ({ origin }) => {
    const run = runLogin(["--origin", origin, "--no-browser", "--json"], {
      // An origin naming the same deployment shadows nothing, so it is not
      // worth a warning; the token is.
      env: { BIKESHED_TOKEN: "bsk_stale.from-an-old-shell", BIKESHED_ORIGIN: `${origin}/` },
    });
    try {
      const authorize = await run.authorizeUrl();
      flow.challenge = authorize.searchParams.get("code_challenge");
      flow.code = "c";
      await visit(callbackFor(authorize, { code: "c", state: authorize.searchParams.get("state"), iss: origin }));
      const { code, stdout, stderr } = await run.exited;
      assert.equal(code, 0, stderr);
      // The address went to stderr; stdout is the result and nothing else.
      assert.deepEqual(JSON.parse(stdout), { origin, saved: run.configPath, via: "browser" });
      assert.match(stderr, /BIKESHED_TOKEN is set in this shell, and it outranks what was just saved/);
      assert.doesNotMatch(stderr, /BIKESHED_ORIGIN/);
    } finally {
      run.cleanup();
    }
  });
});

test("a callback without this run's state is refused, and the wait goes on", LONG, async () => {
  const flow = {};
  await withDeployment({ flow }, async ({ origin, seen }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      const state = authorize.searchParams.get("state");
      flow.challenge = authorize.searchParams.get("code_challenge");
      flow.code = "code-right";

      // Same length, one character off: the comparison is of the whole value.
      const near = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
      for (const forged of [{ state: "not-this-run" }, { state: near }, {}]) {
        const page = await visit(callbackFor(authorize, { code: "code-forged", iss: origin, ...forged }));
        assert.equal(page.status, 400, `accepted ${JSON.stringify(forged)}`);
        assertPageHeaders(page.headers);
      }
      // Anything but GET /callback is not the callback.
      const elsewhere = callbackFor(authorize, { code: "code-forged", state, iss: origin });
      elsewhere.pathname = "/favicon.ico";
      assert.equal((await visit(elsewhere)).status, 404);
      assert.equal((await visit(callbackFor(authorize, { code: "code-forged", state, iss: origin }), { method: "POST" })).status, 404);
      assert.equal(seen.token.length, 0, "a refused callback must never reach the token endpoint");

      const page = await visit(callbackFor(authorize, { code: "code-right", state, iss: origin }));
      assert.equal(page.status, 200);
      const { code, stderr } = await run.exited;
      assert.equal(code, 0, stderr);
      assert.deepEqual(seen.token.map((t) => t.form.code), ["code-right"]);
    } finally {
      run.cleanup();
    }
  });
});

test("a Host other than 127.0.0.1:<port> is refused, which is what stops DNS rebinding", LONG, async () => {
  const flow = {};
  await withDeployment({ flow }, async ({ origin, seen }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      const port = new URL(authorize.searchParams.get("redirect_uri")).port;
      flow.challenge = authorize.searchParams.get("code_challenge");
      flow.code = "code-right";
      const target = callbackFor(authorize, { code: "code-right", state: authorize.searchParams.get("state"), iss: origin });

      for (const host of [`attacker.example:${port}`, `localhost:${port}`, "127.0.0.1"]) {
        const page = await visit(target, { headers: { Host: host } });
        assert.equal(page.status, 400, `accepted Host: ${host}`);
      }
      assert.equal(seen.token.length, 0);

      assert.equal((await visit(target)).status, 200);
      const { code, stderr } = await run.exited;
      assert.equal(code, 0, stderr);
    } finally {
      run.cleanup();
    }
  });
});

test("an answer naming another issuer is refused and its code goes nowhere", LONG, async () => {
  await withDeployment({}, async ({ origin, seen }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      const page = await visit(
        callbackFor(authorize, { code: "c", state: authorize.searchParams.get("state"), iss: "https://attacker.example" }),
      );
      assert.equal(page.status, 400);
      const { code, stderr } = await run.exited;
      assert.equal(code, 1);
      assert.match(stderr, /different server/);
      assert.equal(seen.token.length, 0);
      assert.equal(existsSync(run.configPath), false);
    } finally {
      run.cleanup();
    }
  });
});

test("Deny ends the sign-in and saves nothing", LONG, async () => {
  await withDeployment({}, async ({ origin, seen }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      const page = await visit(
        callbackFor(authorize, { error: "access_denied", state: authorize.searchParams.get("state"), iss: origin }),
      );
      assert.equal(page.status, 200);
      assert.match(page.body, /chose not to connect/);
      const { code, stderr } = await run.exited;
      assert.equal(code, 1);
      assert.match(stderr, /You chose not to connect\. Nothing was saved\./);
      assert.equal(seen.token.length, 0);
      assert.equal(existsSync(run.configPath), false);
    } finally {
      run.cleanup();
    }
  });
});

test("nothing from the callback's query is written into the page, or raw into the terminal", LONG, async () => {
  await withDeployment({}, async ({ origin }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      const page = await visit(
        callbackFor(authorize, {
          error: "server_error",
          error_description: '<script>alert("owned")</script>\u001b[2Jcleared',
          state: authorize.searchParams.get("state"),
          iss: origin,
        }),
      );
      assertPageHeaders(page.headers);
      assert.doesNotMatch(page.body, /<script|alert|owned|cleared|server_error/);
      const { code, stderr } = await run.exited;
      assert.equal(code, 1);
      assert.match(stderr, /Sign-in did not finish/);
      // A terminal is not HTML, but an escape sequence can still rewrite it.
      assert.equal(stderr.includes("\u001b"), false, "an escape sequence reached the terminal");
      assert.equal(existsSync(run.configPath), false);
    } finally {
      run.cleanup();
    }
  });
});

test("a code the deployment will not redeem says why and saves nothing", LONG, async () => {
  const token = (res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant", error_description: "That code was already used." }));
  };
  await withDeployment({ token }, async ({ origin, seen }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      await visit(callbackFor(authorize, { code: "c", state: authorize.searchParams.get("state"), iss: origin }));
      const { code, stderr } = await run.exited;
      assert.equal(code, 1);
      assert.match(stderr, /The sign-in code expired or was already used\. .*\(invalid_grant: That code was already used\.\)/);
      assert.equal(seen.mcp.length, 0);
      assert.equal(existsSync(run.configPath), false);
    } finally {
      run.cleanup();
    }
  });
});

test("an access token that is not a personal access token is refused before anything uses it", LONG, async () => {
  const token = (res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    // The connector kind: valid on /mcp for an hour, and not what a CLI stores.
    res.end(JSON.stringify({ access_token: `bsa_${"a".repeat(32)}.${SECRET}`, token_type: "Bearer" }));
  };
  await withDeployment({ token }, async ({ origin, seen }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      await visit(callbackFor(authorize, { code: "c", state: authorize.searchParams.get("state"), iss: origin }));
      const { code, stderr } = await run.exited;
      assert.equal(code, 1);
      assert.match(stderr, /not a Bikeshed token/);
      assert.equal(seen.mcp.length, 0, "the refused token was sent to /mcp");
      assert.equal(existsSync(run.configPath), false);
    } finally {
      run.cleanup();
    }
  });
});

test("exchangeCode accepts only the bsk_ shape", async () => {
  for (const [shape, ok] of [
    [TOKEN, true],
    [`bsa_${"a".repeat(32)}.${SECRET}`, false],
    [`Bearer ${TOKEN}`, false],
    [`${TOKEN}\n`, false],
    [`bsk_${"A".repeat(32)}.${SECRET}`, false],
    [`bsk_${"a".repeat(32)}.short`, false],
    [{ token: TOKEN }, false],
  ]) {
    const respond = (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: shape, token_type: "Bearer" }));
    };
    await withDeployment({ token: respond }, async ({ origin }) => {
      const exchange = client.exchangeCode(`${origin}/oauth/token`, {
        code: "c",
        verifier: "v",
        redirectUri: "http://127.0.0.1:1/callback",
        clientId: "bikeshed-cli",
        resource: `${origin}/mcp`,
      });
      if (ok) assert.equal(await exchange, TOKEN);
      else await assert.rejects(exchange, /not a Bikeshed token/, `accepted ${JSON.stringify(shape)}`);
    });
  }
});

test("exchangeCode does not follow a token endpoint that redirects", async () => {
  await withDeployment({}, async ({ origin: elsewhere, seen: there }) => {
    const token = (res) => {
      res.writeHead(307, { Location: `${elsewhere}/oauth/token` });
      res.end();
    };
    await withDeployment({ token }, async ({ origin }) => {
      await assert.rejects(
        client.exchangeCode(`${origin}/oauth/token`, {
          code: "c",
          verifier: "v",
          redirectUri: "http://127.0.0.1:1/callback",
          clientId: "bikeshed-cli",
          resource: `${origin}/mcp`,
        }),
        /could not finish signing in/,
      );
    });
    assert.equal(there.token.length, 0, "the code and its verifier were resent to the redirect target");
  });
});

test("no answer in time: exit 1 promptly, nothing saved", LONG, async () => {
  await withDeployment({}, async ({ origin }) => {
    const started = Date.now();
    const run = runLogin(["--origin", origin, "--no-browser"], { env: { BIKESHED_LOGIN_TIMEOUT_MS: "500" } });
    try {
      const { code, stderr } = await run.exited;
      assert.equal(code, 1);
      assert.match(stderr, /Nothing came back from the browser in time/);
      assert.ok(Date.now() - started < 2_500, `took ${Date.now() - started} ms`);
      assert.equal(existsSync(run.configPath), false);
    } finally {
      run.cleanup();
    }
  });
});

test("Ctrl-C stops waiting with 130", { ...LONG, skip: process.platform === "win32" }, async () => {
  await withDeployment({}, async ({ origin }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      await run.authorizeUrl();
      run.child.kill("SIGINT");
      const { code, signal, stderr } = await run.exited;
      assert.equal(signal, null);
      assert.equal(code, 130);
      assert.match(stderr, /Cancelled\. Nothing was saved\./);
      assert.equal(existsSync(run.configPath), false);
    } finally {
      run.cleanup();
    }
  });
});

test("a deployment from before browser sign-in points at --paste", LONG, async () => {
  const variants = {
    "a 404": (res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    },
    // Hosting's catch-all rewrite: an unknown path is the app, with a 200.
    "the app's index.html": (res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end('<!doctype html><html><head><title>Bikeshed</title></head><body><div id="root"></div></body></html>');
    },
  };
  for (const [name, metadata] of Object.entries(variants)) {
    await withDeployment({ metadata }, async ({ origin, seen }) => {
      const run = runLogin(["--origin", origin, "--no-browser"]);
      try {
        const { code, stderr } = await run.exited;
        assert.equal(code, 1, name);
        assert.match(stderr, /predates browser sign-in/, name);
        assert.match(stderr, /bikeshed login --paste/, name);
        assert.equal(seen.metadata, 1);
        assert.equal(seen.token.length, 0);
      } finally {
        run.cleanup();
      }
    });
  }
});

test("in CI, login fails at once unless told how to sign in", LONG, async () => {
  await withDeployment({}, async ({ origin, seen }) => {
    // SSH_CONNECTION as well, so that if the guard is ever removed this test
    // fails by waiting rather than by opening a browser on somebody's desk.
    const env = { CI: "true", SSH_CONNECTION: "203.0.113.1 50000 203.0.113.2 22", BIKESHED_LOGIN_TIMEOUT_MS: "1000" };
    const run = runLogin(["--origin", origin], { env });
    try {
      const { code, stderr } = await run.exited;
      assert.equal(code, 1);
      assert.match(stderr, /In CI, set BIKESHED_TOKEN and BIKESHED_ORIGIN\./);
      assert.equal(seen.metadata, 0, "it should fail before asking the deployment anything");
    } finally {
      run.cleanup();
    }

    // --no-browser is the way through for a runner with a person watching it.
    const watched = runLogin(["--origin", origin, "--no-browser"], { env: { ...env, BIKESHED_LOGIN_TIMEOUT_MS: "300" } });
    try {
      await watched.authorizeUrl();
      assert.equal((await watched.exited).code, 1);
    } finally {
      watched.cleanup();
    }
  });
});

test("--paste reads a token from stdin and checks it, in CI too", LONG, async () => {
  await withDeployment({}, async ({ origin, seen }) => {
    const run = runLogin(["--paste", "--origin", origin], { env: { CI: "true" }, stdin: `${TOKEN}\n` });
    try {
      const { code, stdout, stderr } = await run.exited;
      assert.equal(code, 0, stderr);
      assert.equal(seen.metadata, 0, "--paste does not look for browser sign-in");
      assert.equal(seen.mcp[0].authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(JSON.parse(readFileSync(run.configPath, "utf8")), { origin, token: TOKEN, via: "paste" });
      assert.equal(stdout.includes(TOKEN), false);
    } finally {
      run.cleanup();
    }
  });
});

test("--paste --json prints only the saved-result object and prompts on stderr", LONG, async () => {
  await withDeployment({}, async ({ origin }) => {
    const run = runLogin(["--paste", "--json", "--origin", origin], { stdin: `${TOKEN}\n` });
    try {
      const { code, stdout, stderr } = await run.exited;
      assert.equal(code, 0, stderr);
      assert.doesNotThrow(() => JSON.parse(stdout), "--json emits one JSON value");
      assert.deepEqual(JSON.parse(stdout), { origin, saved: run.configPath, via: "paste" });
      assert.match(stderr, /Create a token at .*\/account/);
      assert.match(stderr, /Token: /);
      assert.equal((stdout + stderr).includes(TOKEN), false);
      assert.deepEqual(JSON.parse(readFileSync(run.configPath, "utf8")), { origin, token: TOKEN, via: "paste" });
    } finally { run.cleanup(); }
  });
});

test("--paste without --origin asks only for the token, and uses the default deployment", LONG, async () => {
  // The deployment has a default and a flag; asking for it as well meant the
  // first line on stdin, which is the token, was read as an address.
  await withDeployment({}, async ({ origin, seen }) => {
    const run = runLogin(["--paste"], { env: { BIKESHED_ORIGIN: origin }, stdin: `${TOKEN}\n` });
    try {
      const { code, stdout, stderr } = await run.exited;
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stdout, /Deployment \[/);
      assert.equal(seen.mcp[0].authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(JSON.parse(readFileSync(run.configPath, "utf8")), { origin, token: TOKEN, via: "paste" });
    } finally {
      run.cleanup();
    }
  });
});

// --- Signing out --------------------------------------------------------------

/** Any other command, against the config in `home`. Spawned, for withDeployment. */
function runCli(home, args, { env = {} } = {}) {
  const childEnv = { ...process.env, XDG_CONFIG_HOME: home };
  for (const name of ["CI", "BIKESHED_TOKEN", "BIKESHED_ORIGIN"]) delete childEnv[name];
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, [join(SRC, "index.mjs"), ...args], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d) => {
    stdout += d;
  });
  child.stderr.setEncoding("utf8").on("data", (d) => {
    stderr += d;
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
  return new Promise((resolve) =>
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({ code, stdout, stderr });
    }),
  );
}

/** A config directory holding `config`, as an earlier `login` would leave it. */
function homeWith(config) {
  const home = mkdtempSync(join(tmpdir(), "bikeshed-logout-"));
  if (config) {
    mkdirSync(join(home, "bikeshed"), { recursive: true });
    writeFileSync(join(home, "bikeshed", "config.json"), JSON.stringify(config));
  }
  return home;
}

const savedConfig = (home) => JSON.parse(readFileSync(join(home, "bikeshed", "config.json"), "utf8"));

test("logout revokes what browser sign-in saved, and the next command has no token", LONG, async () => {
  // The sequence a person performs, in one config directory: sign in, sign
  // out, then try to use it.
  const flow = {};
  await withDeployment({ flow }, async ({ origin, seen }) => {
    const run = runLogin(["--origin", origin, "--no-browser"]);
    try {
      const authorize = await run.authorizeUrl();
      flow.challenge = authorize.searchParams.get("code_challenge");
      flow.code = "c";
      await visit(callbackFor(authorize, { code: "c", state: authorize.searchParams.get("state"), iss: origin }));
      assert.equal((await run.exited).code, 0);

      const out = await runCli(run.home, ["logout"]);
      assert.equal(out.code, 0, out.stderr);
      assert.deepEqual(seen.tokens, [{ authorization: `Bearer ${TOKEN}`, body: { op: "revoke" } }]);
      assert.match(out.stdout, /revoked the token/);
      assert.equal(out.stderr, "");
      // The deployment is remembered, so the next `login` offers it again.
      assert.deepEqual(JSON.parse(readFileSync(run.configPath, "utf8")), { origin });
      for (const text of [out.stdout, out.stderr]) assert.equal(text.includes(SECRET), false);

      const after = await runCli(run.home, ["list"]);
      assert.equal(after.code, 1);
      assert.match(after.stderr, /no token/);
    } finally {
      run.cleanup();
    }
  });
});

test("a pasted token, or one saved before login said which, is forgotten and never revoked", LONG, async () => {
  await withDeployment({}, async ({ origin, seen }) => {
    for (const config of [{ origin, token: TOKEN, via: "paste" }, { origin, token: TOKEN }]) {
      const home = homeWith(config);
      try {
        const out = await runCli(home, ["logout", "--json"]);
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(JSON.parse(out.stdout), { origin, revoked: false, forgot: true });
        assert.match(out.stderr, new RegExp(`revoke it at ${origin}/account`));
        assert.deepEqual(savedConfig(home), { origin });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
    assert.equal(seen.tokens.length, 0, "a pasted token may be in CI too");
    assert.equal(seen.mcp.length, 0);
  });
});

test("a deployment that cannot revoke from the command line is told apart from a dead token", LONG, async () => {
  // Older deployments answer /tokens with 401 to anything but a browser
  // session. So does a current one to a token that no longer works. Only /mcp
  // can say which, and the advice differs.
  const older = (res) => {
    res.writeHead(401);
    res.end();
  };
  await withDeployment({ tokens: older }, async ({ origin, seen }) => {
    const home = homeWith({ origin, token: TOKEN, via: "browser" });
    try {
      const out = await runCli(home, ["logout", "--json"]);
      assert.equal(out.code, 0, out.stderr);
      assert.deepEqual(JSON.parse(out.stdout), { origin, revoked: false, forgot: true });
      assert.match(out.stderr, /too old to revoke a token from the command line/);
      assert.match(out.stderr, new RegExp(`${origin}/account`));
      assert.equal(seen.mcp.length, 1);
      assert.deepEqual(savedConfig(home), { origin });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  await withDeployment({ revoked: true }, async ({ origin, seen }) => {
    const home = homeWith({ origin, token: TOKEN, via: "browser" });
    try {
      const out = await runCli(home, ["logout", "--json"]);
      assert.equal(out.code, 0, out.stderr);
      assert.deepEqual(JSON.parse(out.stdout), { origin, revoked: true, forgot: true });
      assert.equal(out.stderr, "", "a token that already stopped working needs no advice");
      assert.equal(seen.tokens.length, 1);
      assert.deepEqual(savedConfig(home), { origin });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("logout signs this computer out even when the deployment cannot be reached", LONG, async () => {
  // A port that was just listening and now is not.
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));

  const home = homeWith({ origin, token: TOKEN, via: "browser" });
  try {
    const out = await runCli(home, ["logout"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stderr, /Could not reach/);
    assert.match(out.stderr, new RegExp(`${origin}/account`));
    assert.deepEqual(savedConfig(home), { origin });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("logout touches only the saved sign-in, never BIKESHED_TOKEN", LONG, async () => {
  const ENV_TOKEN = `bsk_${"f".repeat(32)}.${SECRET}`;
  await withDeployment({}, async ({ origin, seen }) => {
    const home = homeWith({ origin, token: TOKEN, via: "browser" });
    try {
      const out = await runCli(home, ["logout"], { env: { BIKESHED_TOKEN: ENV_TOKEN } });
      assert.equal(out.code, 0, out.stderr);
      assert.deepEqual(
        seen.tokens.map((t) => t.authorization),
        [`Bearer ${TOKEN}`],
        "a token from the environment was sent",
      );
      assert.match(out.stderr, /BIKESHED_TOKEN is set in this shell/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    // Nothing saved: nothing to do, and still nothing sent.
    const empty = homeWith(null);
    try {
      const bare = await runCli(empty, ["logout"]);
      assert.equal(bare.code, 0, bare.stderr);
      assert.match(bare.stdout, /Not signed in on this computer/);
      assert.equal(bare.stderr, "");

      const out = await runCli(empty, ["logout"], { env: { BIKESHED_TOKEN: ENV_TOKEN, BIKESHED_ORIGIN: origin } });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Not signed in on this computer/);
      assert.match(out.stderr, /BIKESHED_TOKEN is set in this shell/);
      assert.equal(seen.tokens.length, 1);
      assert.equal(existsSync(join(empty, "bikeshed", "config.json")), false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// --- Discovery --------------------------------------------------------------

test("metadata is used only when it describes the deployment being signed in to", async () => {
  const cases = {
    "token endpoint elsewhere": (o) => ({ token_endpoint: "https://attacker.example/oauth/token", why: /token_endpoint is on https:\/\/attacker\.example/ }),
    "consent page elsewhere": (o) => ({ authorization_endpoint: "https://attacker.example/connect", why: /authorization_endpoint is on/ }),
    "issuer with a trailing slash": (o) => ({ issuer: `${o}/`, why: /calls itself/ }),
    "issuer of another host": (o) => ({ issuer: "https://attacker.example", why: /calls itself/ }),
    "no S256": (o) => ({ code_challenge_methods_supported: ["plain"], why: /S256/ }),
    "no PKCE listed": (o) => ({ code_challenge_methods_supported: undefined, why: /S256/ }),
  };
  for (const [name, change] of Object.entries(cases)) {
    let why;
    const metadata = (res, origin) => {
      const { why: expected, ...override } = change(origin);
      why = expected;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/connect`,
          token_endpoint: `${origin}/oauth/token`,
          code_challenge_methods_supported: ["S256"],
          ...override,
        }),
      );
    };
    await withDeployment({ metadata }, async ({ origin }) => {
      await assert.rejects(login.discover(origin), (err) => why.test(err.message), name);
    });
  }
  await withDeployment({}, async ({ origin }) => {
    const meta = await login.discover(`${origin}/`);
    assert.equal(meta.token_endpoint, `${origin}/oauth/token`);
  });
});

// --- The listener on its own ------------------------------------------------

test("the listener closes its port when it times out, and when it is closed", async () => {
  const timed = await login.listenForCallback({ state: "s".repeat(22), issuer: "https://x.example", timeoutMs: 100 });
  const timedPort = new URL(timed.redirectUri).port;
  try {
    assert.equal(await refuses(timedPort), false, "it should be listening first");
    await assert.rejects(timed.result, /Nothing came back from the browser in time/);
    assert.equal(await refuses(timedPort), true, "the port still answers after the timeout");
  } finally {
    timed.close();
  }

  const cancelled = await login.listenForCallback({ state: "s".repeat(22), issuer: "https://x.example" });
  const cancelledPort = new URL(cancelled.redirectUri).port;
  cancelled.close();
  await assert.rejects(cancelled.result, /cancelled/);
  assert.equal(await refuses(cancelledPort), true);
});

test("the listener binds the loopback literal and serves one valid callback", async () => {
  const state = login.createState();
  const cb = await login.listenForCallback({ state, issuer: "https://x.example", timeoutMs: 5_000 });
  try {
    assert.match(cb.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const target = new URL(cb.redirectUri);
    target.search = new URLSearchParams({ code: "abc", state, iss: "https://x.example" }).toString();
    const page = await visit(target);
    assert.equal(page.status, 200);
    assert.equal(page.headers.connection, "close");
    assert.deepEqual(await cb.result, { code: "abc" });
    assert.equal(await refuses(target.port), true, "a second request found the listener still open");
  } finally {
    cb.close();
  }
});

test("callbackPage is fixed text for each outcome", () => {
  for (const kind of ["ok", "denied", "failed"]) {
    const html = login.callbackPage(kind);
    assert.match(html, /^<!doctype html>/);
    assert.doesNotMatch(html, /<script/i);
  }
  assert.equal(login.callbackPage("<b>"), login.callbackPage("failed"));
});

// --- PKCE and the request ---------------------------------------------------

test("PKCE pairs a fresh 32-byte verifier with its SHA-256", () => {
  const a = login.createPkce();
  const b = login.createPkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, createHash("sha256").update(a.verifier).digest("base64url"));
  assert.notEqual(a.verifier, b.verifier);
});

test("authorizeUrl encodes every value rather than concatenating it", () => {
  const url = new URL(
    login.authorizeUrl("https://x.example/connect", {
      clientId: "bikeshed-cli",
      redirectUri: "http://127.0.0.1:1234/callback",
      challenge: "c",
      state: "a&b=c#d",
      resource: "https://x.example/mcp",
      device: "Sam's & laptop",
    }),
  );
  assert.equal(url.searchParams.get("state"), "a&b=c#d");
  assert.equal(url.searchParams.get("device"), "Sam's & laptop");
  assert.equal(url.hash, "");
});

test("the device name loses control characters and fits in 60", () => {
  assert.equal(login.deviceName("my\u0000-mac\u001b[31m‮.local\n"), "my-mac[31m.local");
  assert.equal([...login.deviceName("é".repeat(100))].length, 60);
  assert.equal(login.deviceName(""), "");
});

// --- Opening a browser ------------------------------------------------------

test("each platform's opener gets the address as one argument, and never through cmd", () => {
  const url = "https://x.example/connect?client_id=bikeshed-cli&state=a&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcallback";
  assert.deepEqual(login.browserCommand("darwin", url), ["open", [url]]);
  assert.deepEqual(login.browserCommand("win32", url), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  assert.deepEqual(login.browserCommand("linux", url), ["xdg-open", [url]]);
  for (const platform of ["darwin", "win32", "linux", "freebsd"]) {
    const [command, args] = login.browserCommand(platform, url);
    assert.notEqual(command.toLowerCase(), "cmd", platform);
    assert.notEqual(command.toLowerCase(), "start", platform);
    assert.equal(args.filter((a) => a.includes("&")).length, 1, `${platform} split the address`);
    assert.equal(args.at(-1), url);
  }
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "-a Calculator", "", undefined]) {
    assert.throws(() => login.browserCommand("darwin", bad), /not a web address/, String(bad));
  }
});

test("openBrowser spawns without a shell and survives a missing opener", () => {
  const calls = [];
  let listened = false;
  let unref = false;
  const fake = (command, args, options) => {
    calls.push({ command, args, options });
    const child = {
      on(event, handler) {
        if (event === "error") listened = typeof handler === "function";
        return child;
      },
      unref() {
        unref = true;
      },
    };
    return child;
  };
  assert.equal(login.openBrowser("https://x.example/a?b=1&c=2", "win32", fake), true);
  assert.deepEqual(calls[0].args, ["url.dll,FileProtocolHandler", "https://x.example/a?b=1&c=2"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(listened, true, "an unhandled spawn error crashes the CLI");
  assert.equal(unref, true);
  assert.equal(login.openBrowser("file:///etc/passwd", "darwin", fake), false);
  assert.equal(calls.length, 1);
});

test("`bikeshed open` prints the link and exits 0 when no opener exists", { skip: process.platform === "win32" }, async () => {
  // The Windows bug, reproduced where the tests run: an opener that cannot be
  // spawned. `start` was one, because it is a cmd.exe builtin, not a program.
  const empty = mkdtempSync(join(tmpdir(), "bikeshed-path-"));
  try {
    const child = spawn(process.execPath, [join(SRC, "index.mjs"), "open", "some-doc"], {
      env: { PATH: empty, BIKESHED_ORIGIN: "http://127.0.0.1:9", XDG_CONFIG_HOME: empty },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "http://127.0.0.1:9/d/some-doc\n");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("`bikeshed open` keeps an unlisted link's key", { skip: process.platform === "win32" }, async () => {
  // The link is the only place the key exists; opening the bare id of an
  // unlisted document shows the person a page that refuses them.
  const empty = mkdtempSync(join(tmpdir(), "bikeshed-path-"));
  try {
    const link = "https://bikeshed.example/d/plan/v2?k=tok_0123456789abcdefghijk";
    const child = spawn(process.execPath, [join(SRC, "index.mjs"), "open", link], {
      env: { PATH: empty, BIKESHED_ORIGIN: "http://127.0.0.1:9", XDG_CONFIG_HOME: empty },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "http://127.0.0.1:9/d/plan/v2?k=tok_0123456789abcdefghijk\n");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("`bikeshed open --json` returns its complete keyed URL when no opener exists", { skip: process.platform === "win32" }, async () => {
  const empty = mkdtempSync(join(tmpdir(), "bikeshed-path-"));
  try {
    const child = spawn(process.execPath, [join(SRC, "index.mjs"), "open", "https://example.test/d/plan/v2?k=test-key", "--json"], {
      env: { PATH: empty, BIKESHED_ORIGIN: "http://127.0.0.1:9", XDG_CONFIG_HOME: empty }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (part) => { stdout += part; }); child.stderr.on("data", (part) => { stderr += part; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    assert.doesNotThrow(() => JSON.parse(stdout), "--json emits one JSON value");
    assert.deepEqual(JSON.parse(stdout), { url: "http://127.0.0.1:9/d/plan/v2?k=test-key" });
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("a browser is opened only where the person can see it", () => {
  assert.equal(login.canOpenBrowser({}, "darwin"), true);
  assert.equal(login.canOpenBrowser({}, "win32"), true);
  assert.equal(login.canOpenBrowser({ SSH_CONNECTION: "a b c d" }, "darwin"), false);
  assert.equal(login.canOpenBrowser({ SSH_TTY: "/dev/ttys001" }, "darwin"), false);
  assert.equal(login.canOpenBrowser({ SSH_TTY: "/dev/pts/0", DISPLAY: ":0" }, "linux"), false);
  assert.equal(login.canOpenBrowser({}, "linux"), false);
  assert.equal(login.canOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(login.canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(login.canOpenBrowser({}, "freebsd"), false);
});
