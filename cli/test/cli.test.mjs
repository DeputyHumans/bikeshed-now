// SPDX-License-Identifier: Apache-2.0
// The CLI's credential resolution, wire shape, and error surface (SPEC §19).

/**
 * What is worth testing in a 444-line client, and what is not.
 *
 * Not: whether `fetch` works. Yes: the three things that would be wrong in a
 * way nobody notices until it matters —
 *
 *   1. WHICH credential wins. A flag that loses to a stale config file means
 *      `--token` silently does nothing, and the failure looks like a server
 *      problem rather than a precedence bug.
 *   2. WHAT goes on the wire. The provenance headers are how a reviewer tells
 *      agent activity from a person's; a dropped header is invisible locally
 *      and permanent in the record.
 *   3. HOW a failure is reported. MCP puts tool failures INSIDE a successful
 *      response, so a client that only checks the HTTP status reports success
 *      on every failed tool call.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Run a body with a throwaway XDG_CONFIG_HOME, so no test touches a real one. */
async function withConfig(config, body) {
  const home = mkdtempSync(join(tmpdir(), "bikeshed-cli-"));
  const prev = { ...process.env };
  try {
    process.env.XDG_CONFIG_HOME = home;
    delete process.env.BIKESHED_ORIGIN;
    delete process.env.BIKESHED_TOKEN;
    if (config) {
      mkdirSync(join(home, "bikeshed"), { recursive: true });
      writeFileSync(join(home, "bikeshed", "config.json"), JSON.stringify(config));
    }
    // Imported fresh each time: CONFIG_PATH is resolved at module load.
    const mod = await import(`${SRC}/config.mjs?t=${home}`);
    await body(mod);
  } finally {
    process.env = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

// --- Credential resolution -------------------------------------------------

test("a flag beats the environment, which beats the config file", async () => {
  await withConfig({ origin: "https://from-file.example", token: "file" }, async (m) => {
    assert.equal(m.resolveAuth().token, "file");
    assert.equal(m.resolveAuth().origin, "https://from-file.example");

    process.env.BIKESHED_TOKEN = "env";
    process.env.BIKESHED_ORIGIN = "https://from-env.example";
    assert.equal(m.resolveAuth().token, "env");
    assert.equal(m.resolveAuth().origin, "https://from-env.example");

    const flags = { token: "flag", origin: "https://from-flag.example" };
    assert.equal(m.resolveAuth(flags).token, "flag");
    assert.equal(m.resolveAuth(flags).origin, "https://from-flag.example");
  });
});

test("a trailing slash on the origin is stripped, from every source", async () => {
  await withConfig({ origin: "https://a.example///" }, async (m) => {
    assert.equal(m.resolveAuth().origin, "https://a.example");
    process.env.BIKESHED_ORIGIN = "https://b.example/";
    assert.equal(m.resolveAuth().origin, "https://b.example");
    assert.equal(m.resolveAuth({ origin: "https://c.example//" }).origin, "https://c.example");
  });
});

test("a corrupt config file reads as empty rather than throwing", async () => {
  // A half-written config is not a reason for every command to crash: the
  // recovery is `bikeshed login`, and that has to still be runnable.
  const home = mkdtempSync(join(tmpdir(), "bikeshed-cli-"));
  const prev = { ...process.env };
  try {
    process.env.XDG_CONFIG_HOME = home;
    delete process.env.BIKESHED_TOKEN;
    delete process.env.BIKESHED_ORIGIN;
    mkdirSync(join(home, "bikeshed"), { recursive: true });
    writeFileSync(join(home, "bikeshed", "config.json"), "{ not json");
    const m = await import(`${SRC}/config.mjs?corrupt=${home}`);
    assert.deepEqual(m.readConfig(), {});
    assert.equal(m.resolveAuth().token, "");
  } finally {
    process.env = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// --- What goes on the wire -------------------------------------------------

/** Swap in a fetch that records the call and returns `body`. */
function stubFetch(body, status = 200) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("a tool call is a JSON-RPC envelope carrying the bearer token and client id", async () => {
  const { callTool, CLIENT_NAME } = await import(`${SRC}/client.mjs`);
  const stub = stubFetch({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true } } });
  try {
    const out = await callTool("https://x.example", "bsk_abc.def", "list_documents", { limit: 1 });
    assert.deepEqual(out, { ok: true });

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, "https://x.example/mcp");
    assert.equal(call.init.headers.Authorization, "Bearer bsk_abc.def");
    assert.equal(call.init.headers["X-Bikeshed-Client"], CLIENT_NAME);

    const sent = JSON.parse(call.init.body);
    assert.equal(sent.jsonrpc, "2.0");
    assert.equal(sent.method, "tools/call");
    assert.deepEqual(sent.params, { name: "list_documents", arguments: { limit: 1 } });
  } finally {
    stub.restore();
  }
});

test("the agent header is sent only when BIKESHED_AGENT is set", async () => {
  const { callTool } = await import(`${SRC}/client.mjs`);
  const prev = process.env.BIKESHED_AGENT;
  const body = { result: { structuredContent: {} } };

  let stub = stubFetch(body);
  try {
    delete process.env.BIKESHED_AGENT;
    await callTool("https://x.example", "t", "list_documents");
    assert.equal("X-Bikeshed-Agent" in stub.calls[0].init.headers, false);
  } finally {
    stub.restore();
  }

  stub = stubFetch(body);
  try {
    process.env.BIKESHED_AGENT = "some-agent/1.0";
    await callTool("https://x.example", "t", "list_documents");
    assert.equal(stub.calls[0].init.headers["X-Bikeshed-Agent"], "some-agent/1.0");
  } finally {
    stub.restore();
    if (prev === undefined) delete process.env.BIKESHED_AGENT;
    else process.env.BIKESHED_AGENT = prev;
  }
});

// --- How a failure is reported ---------------------------------------------

test("a tool failure inside a 200 response is still an error", async () => {
  // This is the one a naive client gets wrong: MCP reserves transport errors
  // for transport problems, so a failed tool call arrives as isError on a
  // perfectly successful HTTP response.
  const { callTool, CliError } = await import(`${SRC}/client.mjs`);
  const stub = stubFetch({
    result: { isError: true, content: [{ type: "text", text: "no such document" }] },
  });
  try {
    await assert.rejects(
      () => callTool("https://x.example", "t", "get_document", { id: "nope" }),
      (err) => err instanceof CliError && /no such document/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

test("a 401 says how to fix it, not what the status code was", async () => {
  const { callTool, CliError } = await import(`${SRC}/client.mjs`);
  const stub = stubFetch({}, 401);
  try {
    await assert.rejects(
      () => callTool("https://x.example", "stale", "list_documents"),
      (err) => err instanceof CliError && /bikeshed login/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

test("a JSON-RPC protocol error surfaces its message", async () => {
  const { callTool, CliError } = await import(`${SRC}/client.mjs`);
  const stub = stubFetch({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
  try {
    await assert.rejects(
      () => callTool("https://x.example", "t", "nope"),
      (err) => err instanceof CliError && /Method not found/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

// --- The binary itself -----------------------------------------------------

const run = (args, env = {}) =>
  execFileSync(process.execPath, [join(SRC, "index.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("help is printed with no arguments and with --help, and exits 0", () => {
  for (const args of [[], ["--help"]]) {
    const out = run(args);
    assert.match(out, /^bikeshed/);
    for (const command of ["login", "publish", "update", "list", "comments", "open"]) {
      assert.match(out, new RegExp(`\\b${command}\\b`), `${command} is missing from --help`);
    }
  }
});

test("an unknown command exits non-zero and shows the usage", () => {
  assert.throws(
    () => run(["frobnicate"]),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /unknown command: frobnicate/);
      assert.match(err.stderr, /bikeshed —/);
      return true;
    },
  );
});

test("a command that needs a token says so instead of calling out", () => {
  // No token, no network: the check has to happen before the request, or the
  // first thing a new user sees is a 401 from a server they never configured.
  assert.throws(
    () => run(["list"], { BIKESHED_TOKEN: "", XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "bshd-")) }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /bikeshed login/);
      return true;
    },
  );
});
