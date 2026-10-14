// SPDX-License-Identifier: Apache-2.0
// Self-test: a CLI run the Hosting emulator cut off is named as such (cliCut, runCli's `cut`), and answered() ends its case INCONCLUSIVE (SPEC §12, §19).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { cliCut, cliHome, runCli } from "../lib/cli.mjs";
import { installEgressGuard } from "../lib/egress.mjs";
import { HOSTING_CUTOFF_MS, answered, onAnsweringStack, stackDidNotAnswer } from "../lib/test.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const allow = { checkCli: async () => ({ allow: true }) };

/** A stand-in tree CLI: `say <status>` reports it as the real CLI does, once `go` exists in its cwd (so a case can move the clock first). */
const FAKE_CLI = `// a stand-in for a tree's CLI (cli-cut.test.mjs)
import { existsSync, writeFileSync } from "node:fs";
const [cmd, status, gated] = process.argv.slice(2);
if (cmd === "say") {
  writeFileSync("started", "");
  const say = () => { console.error("error: The server returned " + status + "."); process.exit(1); };
  if (gated !== "gated") say();
  const t = setInterval(() => { if (existsSync("go")) { clearInterval(t); say(); } }, 10);
}
`;

function fakeTarget() {
  const runDir = tempDir("e2e-clicut-run-");
  const tree = tempDir("e2e-clicut-tree-");
  mkdirSync(join(tree, "cli", "src"), { recursive: true });
  writeFileSync(join(tree, "cli", "src", "index.mjs"), FAKE_CLI);
  installEgressGuard(tree);
  mkdirSync(join(tree, "logs"));
  return { kind: "local", runId: "2610121200-ccut", origin: "http://127.0.0.1:39011", runDir, stack: { treeDir: tree, ports: { hosting: 39011 }, logs: { egress: join(tree, "logs", "egress.jsonl") } } };
}

/** Every message the real CLI builds around a response status (cli/src/client.mjs, login.mjs), rendered for `status`. */
function cliStatusMessages(status) {
  const out = [];
  for (const file of ["client.mjs", "login.mjs"]) {
    const src = readFileSync(join(REPO_ROOT, "cli", "src", file), "utf8");
    for (const m of src.matchAll(/`([^`]*\$\{(?:res|probe)\.status\}[^`]*)`/g)) {
      out.push({ file, message: m[1].replace(/\$\{(?:res|probe)\.status\}/g, String(status)).replace(/\$\{[^}]*\}/g, "x") });
    }
  }
  return out;
}

const SLOW = HOSTING_CUTOFF_MS + 1_234;

test("cliCut: a 504 error line in a run of Hosting's cut-off or more is the stack's; the boundary is lib/test.mjs HOSTING_CUTOFF_MS", () => {
  const line = "error: The server returned 504.";
  assert.equal(cliCut({ ms: HOSTING_CUTOFF_MS - 1, stderr: `${line}\n` }), null, "one ms short of the cut-off is an answer");
  const at = cliCut({ ms: HOSTING_CUTOFF_MS, stderr: `${line}\n` }, "bikeshed list");
  assert.equal(at, `bikeshed list saw a 504 after ${HOSTING_CUTOFF_MS} ms, Hosting's cut-off for a function that has not answered (stderr "${line}")`);
  assert.match(cliCut({ ms: SLOW, stderr: `warming up\n${line}\n` }), /^bikeshed saw a 504 after 60234 ms/, "the default name, the whole run's time, and the 504 line, not the first");
  for (const r of [null, undefined, {}, { ms: SLOW }, { ms: "61000", stderr: line }, { ms: Number.NaN, stderr: line }]) assert.equal(cliCut(r), null, JSON.stringify(r));
});

test("cliCut reads every way the CLI words a 504 (read from cli/src), only on its error: line, and no other status", () => {
  const msgs = cliStatusMessages(504);
  assert.ok(msgs.length >= 8, `the CLI's status messages were found: ${JSON.stringify(msgs)}`);
  for (const { file, message } of msgs) {
    assert.notEqual(cliCut({ ms: SLOW, stderr: `error: ${message}\n` }), null, `${file}: ${message}`);
    assert.equal(cliCut({ ms: SLOW, stderr: `error: ${message.replace(/504/g, "502")}\n` }), null, `${file} with 502: ${message}`);
  }
  for (const stderr of [
    "error: The server returned 5040.\n",
    "Published “HTTP 504 explained” at x\n",
    "note: Upload failed (504).\n",
    "  error: The server returned 504.\n",
    "Timed out waiting for function to respond.\n",
  ]) {
    assert.equal(cliCut({ ms: SLOW, stderr }), null, JSON.stringify(stderr));
  }
});

test("runCli: `cut` names a run the stack cut off, and is null for a quick 504 or a slow 500", async () => {
  const target = fakeTarget();
  const quick = await runCli(target, ["say", "504"], { guard: allow, home: cliHome(target, "quick") });
  assert.equal(quick.code, 1, quick.stderr);
  assert.equal(quick.stderr, "error: The server returned 504.\n");
  assert.equal(quick.cut, null, "a quick 504 is the product's answer");

  // The clock moves past the cut-off while the CLI runs: Date.now is what spawnCapture times a run with.
  const realNow = Date.now;
  const slowRun = async (status, name) => {
    const home = cliHome(target, name);
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      const run = runCli(target, ["say", status, "gated"], { guard: allow, home });
      const end = realNow() + 10_000;
      while (!existsSync(join(home.home, "started")) && realNow() < end) await new Promise((r) => setTimeout(r, 10));
      assert.ok(existsSync(join(home.home, "started")), "the CLI started");
      skew = 60_500;
      writeFileSync(join(home.home, "go"), "");
      return await run;
    } finally {
      Date.now = realNow;
    }
  };
  const cut = await slowRun("504", "slow-504");
  assert.ok(cut.ms >= 60_500, `the run took ${cut.ms} ms by the moved clock`);
  assert.match(cut.cut, /^bikeshed say saw a 504 after 6\d{4} ms, Hosting's cut-off for a function that has not answered \(stderr "error: The server returned 504\."\)$/);
  const slow500 = await slowRun("500", "slow-500");
  assert.ok(slow500.ms >= 60_500);
  assert.equal(slow500.cut, null, "another status at the cut-off is the product's");
});

test("answered(): a CLI run with a cut throws E2E_STACK_CUTOFF without its stdout; onAnsweringStack ends the case INCONCLUSIVE on it", async () => {
  const reason = cliCut({ ms: 60_057, stderr: "error: Upload failed (504).\n" }, "bikeshed publish");
  const run = { code: 1, signal: null, stdout: "bsk_" + "0".repeat(32) + ".secret-in-stdout", stderr: "error: Upload failed (504).\n", ms: 60_057, cut: reason };
  let thrown = null;
  try {
    answered(run);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "answered() threw");
  assert.equal(thrown.code, "E2E_STACK_CUTOFF");
  assert.equal(thrown.stackCut, reason);
  assert.equal(thrown.message, reason);
  assert.equal(thrown.response, null);
  assert.deepEqual(thrown.cli, { code: 1, signal: null, ms: 60_057 });
  assert.ok(!JSON.stringify({ ...thrown, message: thrown.message }).includes("secret-in-stdout"), "stdout is not carried");
  assert.equal(stackDidNotAnswer(thrown), reason);
  assert.throws(() => answered(run, "the upload"), (e) => e.stackCut === `the upload: ${reason}`);

  const answeredRun = { ...run, cut: null, ms: 1_200 };
  assert.equal(answered(answeredRun), answeredRun, "a run with no cut is returned as it is");
  const notACli = { cut: "a cut that is not a CLI's", status: 200 };
  assert.equal(answered(notACli), notACli, "only a CLI run (a stderr string) is judged by its cut");

  const ctx = { ev: { text() {}, step() {} } };
  await assert.rejects(
    onAnsweringStack(async () => {
      answered(run);
    })(ctx),
    (e) => e.code === "E2E_INCONCLUSIVE" && e.reason === `the stack did not answer, so nothing was measured: ${reason}` && e.cause?.code === "E2E_STACK_CUTOFF" && e.cause.stackCut === reason,
  );
  assert.equal(await onAnsweringStack(async () => answered(answeredRun).code)(ctx), 1, "an answered run passes through");
});
