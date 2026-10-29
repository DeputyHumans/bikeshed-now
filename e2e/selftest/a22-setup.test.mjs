// SPDX-License-Identifier: Apache-2.0
// OAuth scenarios classify stalled requests and keep real tab focus measurable across renderer navigation (SPEC §12, §23).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { realPageFocus } from "../lib/oauth.mjs";

const source = () => readFileSync(new URL("../specs/functional/a22-oauth.spec.mjs", import.meta.url), "utf8");
function load() {
  const cases = [];
  const context = { answered: (x) => x, after() {}, currentTarget: () => ({ kind: "local", runId: "test" }), scenario: (name, options, body) => cases.push({ name, options, body }) };
  runInNewContext(source().replace(/^import .*;\n/gm, "") + "\nglobalThis.helpers = { mcpInit, toolNames };", context);
  return { cases, ...context.helpers };
}

test("every OAuth scenario uses case-budget and page-stall evidence instead of turning a silent backend into a product failure", () => {
  const { cases } = load();
  assert.equal(cases.length, 10);
  for (const c of cases) assert.equal(c.options.inconclusiveOnCaseTimeout, true, c.name);
});

test("OAuth MCP helpers surface Hosting cutoffs", async () => {
  const x = load();
  const options = [];
  const ctx = { mcp: (opts) => { options.push(opts); return { raw: async () => ({ status: 200, headers: new Headers(), json: { result: { tools: [] } } }), initialize: async () => undefined, listTools: async () => [] }; } };
  await x.mcpInit(ctx, "token", "actor");
  await x.toolNames(ctx, "token", "actor");
  assert.equal(options.length, 2);
  for (const opts of options) assert.equal(opts.cutoffError, true);
  for (const m of source().matchAll(/ctx\.mcp\(\{([^}]+)\}\)/g)) assert.match(m[1], /cutoffError: true/);
});

test("the first approved code is exchanged before later consent cards, and retries precede unrelated probes", () => {
  const s = source();
  const first = s.indexOf("const x = await exchangeCode(http, { code: back1.code");
  const second = s.indexOf('ctx.step("card 2 (an https redirect):');
  assert.ok(first > 0 && second > first, "card one exchanges before card two can consume its two-minute lifetime");
  const retry = s.indexOf("const retry = await refresh");
  const spent = s.indexOf('"A0-after-rotation"');
  assert.ok(retry > 0 && spent > retry, "retry the refresh before unrelated MCP probes consume its grace period");
  assert.match(s, /Date\.now\(\) - rotationStartedAt >= 60_000/);
  assert.match(s, /Date\.now\(\) - codeRetryStartedAt >= 60_000/);
});

test("real focus disables the renderer override again after navigation and restores it after closing the probe tab", async () => {
  const calls = [];
  const session = { send: async (method, options) => calls.push([method, options.enabled]), detach: async () => calls.push(["detach"]) };
  const foreground = { goto: async (url) => calls.push(["goto", url]), bringToFront: async () => calls.push(["front"]), close: async () => calls.push(["close"]) };
  const page = { context: () => ({ newCDPSession: async () => session, newPage: async () => foreground }), url: () => "http://127.0.0.1:1234/connect", bringToFront: async () => calls.push(["original-front"]) };
  const focus = await realPageFocus(page);
  await focus.blur();
  await focus.focus();
  await focus.restore();
  assert.deepEqual(calls, [
    ["Emulation.setFocusEmulationEnabled", false], ["goto", "http://127.0.0.1:1234/privacy"],
    ["Emulation.setFocusEmulationEnabled", false], ["front"], ["original-front"], ["close"],
    ["Emulation.setFocusEmulationEnabled", true], ["detach"],
  ]);
});
