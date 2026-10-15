// SPDX-License-Identifier: Apache-2.0
// Real CLI watch processes keep status notices off the machine-readable result stream (SPEC §19).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/index.mjs", import.meta.url));

for (const command of ["publish", "update"]) {
  test(`${command} --watch --json emits only JSON results and keeps its notice on stderr`, { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bikeshed-watch-output-"));
    const file = join(dir, "watched.html");
    writeFileSync(file, "<p>First bytes</p>");
    const requests = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (part) => { raw += part; });
      req.on("end", () => {
        requests.push({ path: req.url.split("?")[0], body: raw });
        const result = { docId: "watched", versionId: `v${requests.length}`, fileCount: 1, bytes: raw.length };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url.startsWith("/mcp")
          ? { jsonrpc: "2.0", id: 1, result: { structuredContent: result } }
          : result));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const args = command === "publish" ? [command, file] : [command, "watched", file];
    const child = spawn(process.execPath, [CLI, ...args, "--watch", "--json"], {
      env: { ...process.env, XDG_CONFIG_HOME: dir, BIKESHED_ORIGIN: `http://127.0.0.1:${server.address().port}`, BIKESHED_TOKEN: "bsk_test.token" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exited = false;
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr += part; });
    const closed = new Promise((resolve) => child.once("close", () => { exited = true; resolve(); }));
    const until = async (predicate, what) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        assert.equal(exited, false, `watch exited before ${what}: ${stderr}`);
        assert.ok(Date.now() < deadline, `watch did not reach ${what}: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      // Accept the readiness notice on either stream so the old defect reaches
      // the JSON assertion instead of passing because no watch ever started.
      await until(() => /watching watched\.html/.test(stdout + stderr), "watch readiness");
      assert.equal(exited, false, "the watch remains active after its first result");
      writeFileSync(file, "<p>Changed bytes</p>");
      await until(() => /"versionId": "v2"/.test(stdout), "the changed file's result");
      child.kill("SIGTERM");
      await closed;
      const values = stdout.trim().split(/\n(?=\{)/).map((value) => JSON.parse(value));
      assert.deepEqual(values.map((value) => value.versionId), ["v1", "v2"], "stdout is exactly the initial and changed-file JSON results");
      assert.match(stderr, /^watching watched\.html — ctrl-C to stop\n$/, "the human watch notice is on stderr");
      assert.equal(requests.length, 2, "the live watch sends one changed-file update");
      assert.deepEqual(requests.map((request) => request.path), command === "publish" ? ["/publish", "/mcp"] : ["/mcp", "/mcp"]);
      assert.equal(JSON.parse(requests[1].body).params.arguments.content, "<p>Changed bytes</p>");
    } finally {
      if (!exited) { child.kill("SIGKILL"); await closed; }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
