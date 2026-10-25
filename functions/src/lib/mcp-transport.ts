// SPDX-License-Identifier: Apache-2.0
// Protect MCP responses before the managed runtime parses the body (SPEC §23).

import { subscribe } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";

// onRequest runs after the runtime JSON parser. Hosting does not attach its
// configured headers to that parser's real-cloud error responses. Node emits
// this event before dispatching the request to the runtime's HTTP listener.
subscribe("http.server.request.start", (message) => {
  const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
  const path = request.url?.split("?", 1)[0];
  if (process.env.FUNCTION_TARGET !== "mcp" && path !== "/mcp" && path !== "/mcp/") return;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
});
