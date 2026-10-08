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
    for (const command of [...commands, "fork", "lineage", "comment", "suggest", "folders", "mkdir", "mv", "skills"]) {
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

const tryJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

async function withServer(respond, body) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      // `publish` uploads raw bytes, not JSON-RPC, so the body is only parsed
      // when it is JSON. A thrown SyntaxError here would surface as the CLI
      // hanging on a request the server never answered.
      seen.push({ url: req.url, body: raw ? tryJson(raw) : null });
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

test("the package stays publishable, and stays cheap to run once", () => {
  // `npx bikeshed-now` is in the agent instructions a deployment serves, so the
  // two properties that make that instruction work are asserted here: the
  // package is not private, and installing it downloads nothing else. A single
  // dependency turns a one-second bootstrap into a tree resolution.
  const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));

  assert.equal(manifest.private, undefined, "a private package cannot be published");
  assert.equal(manifest.name, "bikeshed-now");
  // Spelled without "./", which is what npm's own normaliser writes to the
  // registry: the published manifest and the committed one should agree, and
  // the leading "./" made `npm publish` warn that it had corrected the field.
  assert.equal(manifest.bin.bikeshed, "src/index.mjs");
  assert.deepEqual(manifest.dependencies, undefined, "the client has no runtime dependencies");
  assert.ok(Array.isArray(manifest.files), "publish by allowlist, never by omission");
  for (const required of ["src", "README.md", "LICENSE", "NOTICE"]) {
    assert.ok(manifest.files.includes(required), `${required} is missing from files`);
  }
  // The npm page is the first thing somebody installing it reads.
  assert.ok(existsSync(join(SRC, "..", "README.md")), "cli/README.md is missing");
});

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

test("fork sends the document, and only the options it was given", async () => {
  await withServer(rpcOk({ docId: "notes-x7k2p9", versionId: "v1", title: "Notes" }), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    await runAsync(["fork", "notes", "--json"], env);
    await runAsync(
      ["fork", "https://bikeshed.example/d/notes?k=tok_0123456789abcdefghijk", "--version", "v2", "--folder", "f1", "--title", "Mine", "--json"],
      env,
    );
    assert.equal(seen[0].body.params.name, "fork_document");
    // Absent, not empty: an empty folder would be refused as a missing
    // argument, and an empty title would be an empty title.
    assert.deepEqual(seen[0].body.params.arguments, { id: "notes" });
    assert.deepEqual(seen[1].body.params.arguments, {
      id: "notes",
      k: "tok_0123456789abcdefghijk",
      version: "v2",
      folder: "f1",
      title: "Mine",
    });
  });
});

test("comment sends the passage, what to say about it, and the link's key", async () => {
  const answer = { threadId: "a7Kd", version: "v1", quote: "a single weekend" };
  await withServer(rpcOk(answer), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    const { stdout } = await runAsync(
      ["comment", "https://bikeshed.example/d/notes?k=tok_0123456789abcdefghijk", "a", "single", "weekend", "--body", "Which one?", "--prefix", "cut over in "],
      env,
    );
    assert.equal(seen[0].body.params.name, "add_comment");
    assert.deepEqual(seen[0].body.params.arguments, {
      id: "notes",
      k: "tok_0123456789abcdefghijk",
      exact: "a single weekend",
      body: "Which one?",
      prefix: "cut over in ",
    });
    assert.equal(stdout, "opened a7Kd\n");
  });
});

test("comment without something to say is a usage error, and sends nothing", async () => {
  await withServer(rpcOk({}), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    // An unset shell variable sends an empty --body; a thread that says nothing
    // is one somebody has to resolve for no reason.
    for (const args of [["comment", "notes", "a passage"], ["comment", "notes", "a passage", "--body", "  "], ["comment", "notes", "--body", "x"]]) {
      await assert.rejects(runAsync(args, env), (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /usage: bikeshed comment <id> <text> --body <comment>/);
        return true;
      });
    }
    assert.equal(seen.length, 0);
  });
});

test("lineage asks for the document a link names, with its key", async () => {
  const answer = { id: "notes", forked: false, forkedFrom: [], moreYouCannotOpen: false };
  await withServer(rpcOk(answer), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    const { stdout } = await runAsync(["lineage", "https://bikeshed.example/d/notes?k=tok_0123456789abcdefghijk"], env);
    assert.equal(seen[0].body.params.name, "get_lineage");
    assert.deepEqual(seen[0].body.params.arguments, { id: "notes", k: "tok_0123456789abcdefghijk" });
    assert.equal(stdout, "notes is not a fork.\n");
  });
});

test("lineage prints the path nearest first, says where it stops, and counts the forks", async () => {
  const answer = {
    id: "gamma",
    forked: true,
    forkedFrom: [
      { id: "beta", title: "Beta", version: "v1", changedSince: true },
      { id: "alpha", title: "Alpha", version: "v2" },
    ],
    moreYouCannotOpen: true,
    forks: {
      total: 3,
      youCannotOpen: 2,
      listed: [{ id: "delta", title: "Delta", visibility: "public", forkedAt: "2026-10-05T09:00:00.000Z", owner: "d@example.com" }],
    },
  };
  await withServer(rpcOk(answer), async (origin) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    const { stdout } = await runAsync(["lineage", "gamma"], env);
    assert.equal(
      stdout,
      [
        "forked from  beta v1  Beta   (changed since)",
        "  which was  alpha v2  Alpha",
        "  which was   forked from a document you can't open",
        "",
        "forked 3 times; 2 you can't open",
        `  ${"delta".padEnd(34)} public   2026-10-05 Delta  d@example.com`,
        "",
      ].join("\n"),
    );
    // --json is the tool's answer, untouched.
    const json = await runAsync(["lineage", "gamma", "--json"], env);
    assert.deepEqual(JSON.parse(json.stdout), answer);
  });
});

test("a pasted link is read for its id and its unlisted key", async () => {
  // The link is the only place a person ever holds an unlisted document's key,
  // and without it the document answers as an id that does not exist.
  const link = "https://bikeshed.example/d/build-estimate/v2?k=tok_0123456789abcdefghijk";
  await withServer(rpcOk({ source: "", threads: [] }), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    await runAsync(["get", link, "--json"], env);
    await runAsync(["comments", link, "--json"], env);
    await runAsync(["reply", link, "t1", "Agreed.", "--json"], env);
    assert.deepEqual(seen[0].body.params.arguments, {
      id: "build-estimate",
      k: "tok_0123456789abcdefghijk",
    });
    assert.deepEqual(seen[1].body.params.arguments, {
      id: "build-estimate",
      k: "tok_0123456789abcdefghijk",
      includeResolved: false,
    });
    assert.deepEqual(seen[2].body.params.arguments, {
      id: "build-estimate",
      k: "tok_0123456789abcdefghijk",
      threadId: "t1",
      body: "Agreed.",
    });
  });
});

test("a bare id, or a link without a key, sends no key", async () => {
  await withServer(rpcOk({ source: "" }), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    await runAsync(["get", "build-estimate", "--json"], env);
    await runAsync(["get", "https://bikeshed.example/d/build-estimate", "--json"], env);
    assert.deepEqual(seen[0].body.params.arguments, { id: "build-estimate" });
    assert.deepEqual(seen[1].body.params.arguments, { id: "build-estimate" });
  });
});

// --- A source longer than one tool result ----------------------------------

/**
 * get_document cuts a long source at a CHARACTER count, and stdout counts
 * bytes, so this source is full of characters UTF-8 spends two and three bytes
 * on. The cut copy then differs from the whole one in length, and a client that
 * printed the cut — or decoded and re-encoded the rest — fails on size, not just
 * on content. The cut falls inside <head>, which is how it was found: a
 * document with no <body>.
 */
const WHOLE = `<!doctype html><html><head><style>${"/* — é 漢 */".repeat(30_000)}</style></head><body><h1>Deck</h1></body></html>`;
const CUT = WHOLE.slice(0, 200_000);

/** Run `get` against a deployment whose get_document cut the source. */
async function getAgainst(args, { content = (req, res) => res.end(WHOLE), result = {} } = {}) {
  const requests = [];
  let stdout;
  let failure;
  await withServer(
    (req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization });
      if (req.url.startsWith("/content/")) return content(req, res);
      rpcOk({
        id: "big-deck",
        version: "v3",
        sourceFile: "index.html",
        truncated: true,
        source: CUT,
        ...result,
      })(req, res);
    },
    async (origin) => {
      try {
        ({ stdout } = await promisify(execFile)(process.execPath, [join(SRC, "index.mjs"), "get", ...args], {
          encoding: "buffer",
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" },
        }));
      } catch (err) {
        failure = err;
      }
    },
  );
  return { stdout, failure, requests };
}

test("a source get_document cut is printed whole, byte for byte", async () => {
  assert.notEqual(Buffer.byteLength(CUT), Buffer.byteLength(WHOLE), "the fixture must be cut");
  const { stdout, failure, requests } = await getAgainst(["big-deck"]);
  assert.equal(failure, undefined);
  assert.ok(stdout.equals(Buffer.from(WHOLE)), `printed ${stdout.length} bytes, not ${Buffer.byteLength(WHOLE)}`);
  assert.equal(requests[1].url, "/content/big-deck/v3/index.html");
  assert.equal(requests[1].authorization, "Bearer bsk_a.b");
});

test("the rest is read from the source file the tool named, with the link's key", async () => {
  const link = "https://bikeshed.example/d/big-deck?k=tok_0123456789abcdefghijk";
  const { requests } = await getAgainst([link], { result: { sourceFile: "slides/index.html" } });
  assert.equal(requests[1].url, "/content/big-deck/v3/slides/index.html?k=tok_0123456789abcdefghijk");
});

test("--json carries the whole source, and no longer says it was cut", async () => {
  const { stdout } = await getAgainst(["big-deck", "--json"]);
  const result = JSON.parse(stdout.toString("utf8"));
  assert.equal(result.truncated, false);
  assert.equal(result.source, WHOLE);
  assert.equal(result.version, "v3", "the rest of the result survives");
});

test("when the rest cannot be read, nothing is printed and the command fails", async () => {
  const { failure } = await getAgainst(["big-deck"], {
    content: (req, res) => {
      res.statusCode = 404;
      res.end();
    },
  });
  assert.equal(failure?.code, 1);
  assert.equal(failure.stdout.length, 0, "a partial source must not reach stdout");
  assert.match(failure.stderr.toString("utf8"), /Nothing was printed/);
});

test("a source that was not cut is printed from the one tool call", async () => {
  const { stdout, requests } = await getAgainst(["big-deck"], {
    result: { truncated: false, source: "# Short\n" },
  });
  assert.equal(stdout.toString("utf8"), "# Short\n");
  assert.equal(requests.length, 1);
});

test("a link that is not a document is refused rather than sent as an id", () => {
  assert.throws(
    () => run(["get", "https://bikeshed.example/folder/abc"], { BIKESHED_TOKEN: "bsk_a.b" }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /not a document link/);
      return true;
    },
  );
});

test("`--json` says where a reader opens the document, not just its id", async () => {
  // The human line has always printed the address; `--json` printed a docId and
  // left whoever read it to know that a URL is the origin, then /d/, then the id.
  const published = {
    docId: "storage-migration",
    versionId: "v1",
    title: "Storage migration",
    fileCount: 1,
    bytes: 24,
    format: "markdown",
  };
  const dir = mkdtempSync(join(tmpdir(), "bshd-publish-"));
  const file = join(dir, "proposal.md");
  writeFileSync(file, "# Storage migration\n");
  try {
    await withServer(
      (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(published));
      },
      async (origin) => {
        const { stdout } = await runAsync(["publish", file, "--json"], {
          BIKESHED_ORIGIN: origin,
          BIKESHED_TOKEN: "bsk_a.b",
        });
        const result = JSON.parse(stdout);
        assert.equal(result.url, `${origin}/d/storage-migration`);
        assert.equal(result.docId, "storage-migration", "the rest of the result survives");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Publish `file` with `args` against a server that answers with `docId`. */
async function publishAgainst(docId, args) {
  const dir = mkdtempSync(join(tmpdir(), "bshd-publish-id-"));
  const file = join(dir, "platform.md");
  writeFileSync(file, "# 01-platform\n");
  try {
    let seen;
    let output;
    await withServer(
      (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ docId, versionId: "v1", title: "01-platform", fileCount: 1, bytes: 14, format: "markdown" }));
      },
      async (origin, requests) => {
        output = await runAsync(["publish", file, ...args], {
          BIKESHED_ORIGIN: origin,
          BIKESHED_TOKEN: "bsk_a.b",
        });
        seen = requests;
      },
    );
    return { url: new URL(seen[0].url, "http://x"), ...output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("publish --id asks the deployment for that id, and says nothing when it gets it", async () => {
  // `--id` has to be a declared option. The parser is not strict, so an
  // undeclared one parses as `true` and its value as a stray positional: the
  // publish goes ahead at an id from the title and nobody is told.
  const { url, stderr } = await publishAgainst("01-platform", ["--id", "01-platform", "--json"]);
  assert.equal(url.pathname, "/publish");
  assert.equal(url.searchParams.get("id"), "01-platform");
  assert.equal(stderr, "");
});

test("publish without --id sends no id", async () => {
  const { url } = await publishAgainst("01-platform", ["--json"]);
  assert.equal(url.searchParams.has("id"), false);
});

test("publish --id says so when the document landed somewhere else", async () => {
  const { stdout, stderr } = await publishAgainst("01-platform-k3x9qz", ["--id", "01-platform", "--json"]);
  assert.match(stderr, /01-platform was not available; published at 01-platform-k3x9qz/);
  assert.equal(JSON.parse(stdout).docId, "01-platform-k3x9qz", "stdout stays parseable");
});

test("publish --id with no value is a usage error, not a publish", () => {
  assert.throws(
    () => run(["publish", "whatever.md", "--id"], { BIKESHED_TOKEN: "bsk_a.b" }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /usage: bikeshed publish <file> --id <id>/);
      return true;
    },
  );
});

test("an address the deployment supplied wins over one the client can build", async () => {
  // A deployment serving on a configured public origin knows its canonical
  // address; the origin this client happens to have reached may be a channel.
  const dir = mkdtempSync(join(tmpdir(), "bshd-update-"));
  const file = join(dir, "proposal.md");
  writeFileSync(file, "# Storage migration\n");
  try {
    await withServer(
      rpcOk({
        versionId: "v2",
        fileCount: 1,
        bytes: 24,
        deduped: false,
        url: "https://example.test/d/storage-migration",
      }),
      async (origin) => {
        const { stdout } = await runAsync(["update", "storage-migration", file, "--json"], {
          BIKESHED_ORIGIN: origin,
          BIKESHED_TOKEN: "bsk_a.b",
        });
        assert.equal(JSON.parse(stdout).url, "https://example.test/d/storage-migration");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Update a document from a .zip against a server that records the raw request.
 *
 * Bytes are kept as a Buffer, not decoded: decoding is exactly how the bug this
 * covers corrupted an archive, and `withServer` decodes.
 */
async function updateWithZip(ref) {
  const dir = mkdtempSync(join(tmpdir(), "bshd-update-zip-"));
  const file = join(dir, "deck.zip");
  // A local-file header, then bytes that are not valid UTF-8. Read as text,
  // 0xff and 0xfe become U+FFFD and the archive no longer parses.
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0x81]);
  writeFileSync(file, bytes);
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: new URL(req.url, "http://x"), headers: req.headers, body: Buffer.concat(chunks) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ docId: "deck", versionId: "v2", fileCount: 3, bytes: 9, deduped: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const { stdout } = await runAsync(["update", ref, file, "--json"], {
      BIKESHED_ORIGIN: origin,
      BIKESHED_TOKEN: "bsk_a.b",
    });
    return { seen, bytes, origin, result: JSON.parse(stdout) };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("update with a .zip sends its bytes, unread, as a new version of that document", async () => {
  // It used to read the archive as UTF-8 and send the text through
  // update_document, which turned every byte above 0x7f into U+FFFD.
  const { seen, bytes, origin, result } = await updateWithZip("deck");
  assert.equal(seen.length, 1);
  const [request] = seen;
  assert.equal(request.url.pathname, "/publish");
  assert.equal(request.url.searchParams.get("update"), "deck");
  assert.equal(request.url.searchParams.get("filename"), "deck.zip");
  assert.equal(request.url.searchParams.has("id"), false, "an update must not ask for a new address");
  assert.equal(request.headers["content-type"], "application/octet-stream");
  assert.equal(request.headers.authorization, "Bearer bsk_a.b");
  assert.ok(request.body.equals(bytes), "the archive was altered on the way");
  assert.equal(result.versionId, "v2");
  assert.equal(result.url, `${origin}/d/deck`);
});

test("update with a .zip carries an unlisted link's key", async () => {
  const { seen } = await updateWithZip("https://bikeshed.example/d/deck?k=tok_0123456789abcdefghijk");
  assert.equal(seen[0].url.searchParams.get("update"), "deck");
  assert.equal(seen[0].url.searchParams.get("k"), "tok_0123456789abcdefghijk");
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

// --- Listing ---------------------------------------------------------------

test("list sends the cursor its own `… more` line tells you to pass", async () => {
  // The hint was printed, the flag was parsed, and the value was dropped before
  // the request — so following the hint returned the first page again, and
  // nothing past the newest page was reachable from the terminal at all.
  await withServer(rpcOk({ documents: [], nextCursor: null }), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    await runAsync(["list", "--json"], env);
    assert.deepEqual(seen[0].body.params.arguments, { limit: 20 });

    await runAsync(["list", "--cursor", "older-doc", "--limit", "5", "--json"], env);
    assert.deepEqual(seen[1].body.params.arguments, { limit: 5, cursor: "older-doc" });
  });
});

test("list --all follows nextCursor to the last page and prints one list", async () => {
  const row = (id) => ({ id, title: id, version: "v1", visibility: "private" });
  const pages = [
    { documents: [row("newest"), row("newer")], nextCursor: "newer" },
    { documents: [row("oldest")], nextCursor: null },
  ];
  let served = 0;
  const respond = (req, res) => rpcOk(pages[served++])(req, res);

  await withServer(respond, async (origin, seen) => {
    const { stdout } = await runAsync(["list", "--all", "--json"], {
      BIKESHED_ORIGIN: origin,
      BIKESHED_TOKEN: "bsk_a.b",
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].body.params.arguments.cursor, undefined);
    assert.equal(seen[1].body.params.arguments.cursor, "newer");
    // The same shape as one page, so a script reads `--all` with the parser it
    // already has, and a null cursor says there is nothing left to fetch.
    const result = JSON.parse(stdout);
    assert.deepEqual(result.documents.map((d) => d.id), ["newest", "newer", "oldest"]);
    assert.equal(result.nextCursor, null);
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

test("suggest sends the passage and its replacement, and only the options it was given", async () => {
  await withServer(rpcOk({ threadId: "t9", version: "v3" }), async (origin, seen) => {
    const env = { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" };
    const { stdout } = await runAsync(["suggest", "plan", "a", "single", "weekend", "--with", "two weekends"], env);
    assert.equal(seen[0].body.params.name, "suggest_edit");
    assert.deepEqual(seen[0].body.params.arguments, {
      id: "plan",
      exact: "a single weekend",
      replacement: "two weekends",
    });
    assert.match(stdout, /suggested in t9; a person who can approve will accept or reject it/);

    await runAsync(
      ["suggest", "https://bikeshed.example/d/plan?k=tok_0123456789abcdefghijk", "yes", "--delete",
        "--note", "Redundant.", "--suffix", " and", "--json"],
      env,
    );
    assert.deepEqual(seen[1].body.params.arguments, {
      id: "plan",
      k: "tok_0123456789abcdefghijk",
      exact: "yes",
      replacement: "",
      note: "Redundant.",
      suffix: " and",
    });
  });
});

test("suggest wants exactly one of --with and --delete", () => {
  for (const args of [
    ["suggest", "plan", "text"],
    ["suggest", "plan", "text", "--with", "x", "--delete"],
    ["suggest", "plan", "--with", "x"],
  ]) {
    assert.throws(
      () => run(args, { BIKESHED_TOKEN: "bsk_a.b", BIKESHED_ORIGIN: "http://127.0.0.1:9" }),
      (e) => e.status !== 0 && /usage: bikeshed suggest/.test(e.stderr),
      args.join(" "),
    );
  }
});

test("comments prints a suggestion's change and whether it is decided", async () => {
  const answer = {
    id: "plan",
    version: "v3",
    threads: [
      { threadId: "t1", quote: "a single weekend", section: "", resolved: false,
        suggestion: { replacement: "two weekends", state: "pending" }, comments: [] },
      { threadId: "t2", quote: "very", section: "", resolved: true,
        suggestion: { replacement: "", state: "accepted" }, comments: [] },
    ],
  };
  await withServer(rpcOk(answer), async (origin) => {
    const { stdout } = await runAsync(["comments", "plan", "--all"], { BIKESHED_ORIGIN: origin, BIKESHED_TOKEN: "bsk_a.b" });
    assert.match(stdout, /“a single weekend”\n   → “two weekends”  \[pending\]/);
    assert.match(stdout, /“very”\n   → \(delete it\)  \[accepted\]/);
  });
});

test("an empty --with is refused, since a deletion is asked for by name", () => {
  assert.throws(
    () => run(["suggest", "plan", "text", "--with", ""], { BIKESHED_TOKEN: "bsk_a.b", BIKESHED_ORIGIN: "http://127.0.0.1:9" }),
    (e) => e.status !== 0 && /say --delete if you mean that/.test(e.stderr),
  );
});
