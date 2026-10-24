// SPDX-License-Identifier: Apache-2.0
// Observe a local CLI's MCP call boundaries without recording credentials, arguments or response bodies (SPEC §12, §19).

import { appendFileSync } from "node:fs";

/** Wrap the existing fetch, preserving the egress guard and the response body. */
export function traceToolCalls(fetch, write, now = () => performance.now()) {
  let sequence = 0;
  return async function (input, init) {
    let tool;
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (url.pathname === "/mcp" && body?.method === "tools/call" && /^[a-z_]+$/.test(body.params?.name)) tool = body.params.name;
    } catch { /* Non-JSON/non-MCP fetches are intentionally not recorded. */ }
    if (!tool) return fetch(input, init);
    const id = ++sequence;
    write({ id, tool, phase: "start", ms: now() });
    try {
      const response = await fetch(input, init);
      write({ id, tool, phase: "end", ms: now(), status: response.status });
      // The CLI parses JSON before deciding whether another wait fits. Record
      // that completion too: a slow body must not be counted as a fast call.
      const json = response.json.bind(response);
      response.json = async (...args) => {
        const value = await json(...args);
        write({ id, tool, phase: "body", ms: now() });
        return value;
      };
      return response;
    } catch (error) {
      write({ id, tool, phase: "error", ms: now() });
      throw error;
    }
  };
}

if (process.env.E2E_CLI_CALL_TRACE) {
  const path = process.env.E2E_CLI_CALL_TRACE;
  globalThis.fetch = traceToolCalls(globalThis.fetch, (event) => appendFileSync(path, JSON.stringify(event) + "\n"));
}
