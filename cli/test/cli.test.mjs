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
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
    const commands = ["login", "publish", "update", "list", "comments", "open"];
    for (const command of [...commands, "folders", "mkdir", "mv", "skills"]) {
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

// --- Organising ------------------------------------------------------------

test("mv will not guess a destination", async () => {
  // The MCP tool treats an omitted `folder` as the workspace root, because
  // JSON-RPC has no way to send an empty one. A positional argument does have a
  // way, and `bikeshed mv report` silently pulling a document out of the folder
  // it was filed in — revoking whatever access that folder granted — is not a
  // mistake this interface should make easy to make.
  assert.throws(
    () => run(["mv", "some-doc"], { BIKESHED_TOKEN: "bsk_a.b" }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /usage: bikeshed mv <id> <folder\|root>/);
      return true;
    },
  );
});

/**
 * Run the real binary against a throwaway local server.
 *
 * Stubbing `fetch` tests the client; it cannot test what a COMMAND builds,
 * because the command runs in another process. That distinction matters here:
 * every one of these assertions is about the arguments a command assembles, not
 * about whether the client can send them.
 *
 * The child is spawned ASYNCHRONOUSLY, and that is not a style choice. The
 * server lives on this process's event loop, so `execFileSync` would block the
 * very loop that has to answer the request the child is waiting on — the test
 * deadlocks rather than fails, which is the worst way for a test to be wrong.
 */
const runAsync = (args, env = {}) =>
  promisify(execFile)(process.execPath, [join(SRC, "index.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

async function withServer(respond, body) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      seen.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      respond(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await body(origin, seen);
  } finally {
    server.close();
  }
}

const rpcOk = (result) => (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: result } }));
};

test("`root` is sent as an ABSENT folder, not as a folder named root", async () => {
  await withServer(rpcOk({ id: "some-doc", folder: null }), async (origin, seen) => {
    await runAsync(["mv", "some-doc", "root", "--json"], {
      BIKESHED_ORIGIN: origin,
      BIKESHED_TOKEN: "bsk_a.b",
    });
    const args = seen[0].body.params.arguments;
    // An empty `folder` would be rejected server-side as a missing required
    // argument, and the literal "root" would be looked up as an id and 404.
    // Absence is the only encoding of "the workspace root" that works.
    assert.deepEqual(args, { id: "some-doc" });
    assert.equal("folder" in args, false);
  });
});

test("a destination folder is sent as the folder argument", async () => {
  await withServer(rpcOk({ id: "some-doc", folder: "fold123" }), async (origin, seen) => {
    await runAsync(["mv", "some-doc", "fold123", "--json"], {
      BIKESHED_ORIGIN: origin,
      BIKESHED_TOKEN: "bsk_a.b",
    });
    assert.equal(seen[0].body.params.name, "move_document");
    assert.deepEqual(seen[0].body.params.arguments, { id: "some-doc", folder: "fold123" });
  });
});

test("mkdir sends a parent only when one was given", async () => {
  await withServer(rpcOk({ folderId: "f1", name: "Reviews" }), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    await runAsync(["mkdir", "Reviews", "--json"], env);
    assert.deepEqual(seen[0].body.params.arguments, { name: "Reviews" });

    await runAsync(["mkdir", "Reviews", "--parent", "f0", "--json"], env);
    assert.deepEqual(seen[1].body.params.arguments, { name: "Reviews", parent: "f0" });
  });
});

// --- Skills ----------------------------------------------------------------

const skillsHost = (index, text = "---\nname: x\n---\n") => (req, res) => {
  if (req.url === "/skills/index.json") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(index));
    return;
  }
  res.setHeader("Content-Type", "text/markdown");
  res.end(text);
};

test("skills install writes one SKILL.md per skill, under the given directory", async () => {
  const index = {
    skills: [
      { name: "bikeshed-publishing", description: "d", path: "skills/bikeshed-publishing/SKILL.md" },
    ],
  };
  const body = "---\nname: bikeshed-publishing\ndescription: d\n---\n\n# Publishing\n";
  await withServer(skillsHost(index, body), async (origin) => {
    const dir = mkdtempSync(join(tmpdir(), "bshd-skills-"));
    await runAsync(["skills", "install", dir], { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "" });
    assert.equal(readFileSync(join(dir, "bikeshed-publishing", "SKILL.md"), "utf8"), body);
    rmSync(dir, { recursive: true, force: true });
  });
});

test("a skill name that is a path is refused before anything is written", async () => {
  // The name decides a directory on this machine. A deployment is not an
  // adversary, but a name is the wrong place to find out it could have been
  // one — and this is the only command in the CLI that writes files it was
  // handed by a server.
  const index = { skills: [{ name: "../../../evil", description: "d", path: "skills/x/SKILL.md" }] };
  await withServer(skillsHost(index), async (origin) => {
    const dir = mkdtempSync(join(tmpdir(), "bshd-skills-"));
    await assert.rejects(
      () => runAsync(["skills", "install", dir], { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "" }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /unusable name/);
        return true;
      },
    );
    assert.equal(existsSync(join(dir, "..", "..", "..", "evil")), false);
    rmSync(dir, { recursive: true, force: true });
  });
});

test("a skill index that is really the SPA's index.html is rejected", async () => {
  // Hosting answers an unknown path with the single-page app and a 200, so a
  // deployment too old to publish skills does not 404 — it returns a web page.
  // Checking the status code alone would hand that to the parser.
  const { listSkills, CliError } = await import(`${SRC}/client.mjs`);
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  });
  try {
    await assert.rejects(() => listSkills("https://x.example"), CliError);
  } finally {
    globalThis.fetch = real;
  }
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

test("skills does not demand a token, because skills are public", () => {
  // They are static files beside /llms.txt. Requiring a credential to read the
  // instructions would mean an agent has to be credentialed before it can learn
  // how to ask for a credential.
  assert.throws(
    () =>
      run(["skills"], {
        BIKESHED_TOKEN: "",
        BIKESHED_ORIGIN: "http://127.0.0.1:1",
        XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "bshd-")),
      }),
    (err) => {
      assert.equal(err.status, 1);
      // It got as far as the network — the point — rather than stopping at the
      // credential check, which would have said "bikeshed login" instead.
      assert.doesNotMatch(err.stderr, /bikeshed login/);
      return true;
    },
  );
});
