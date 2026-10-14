// SPDX-License-Identifier: Apache-2.0
// A streamable-HTTP MCP client for specs: JSON-RPC over POST /mcp, JSON or SSE replies, batches, raw mode (SPEC §19).

/**
 * What a real MCP client does, and nothing the server would not see from one:
 *
 *   - POST /mcp with `Accept: application/json, text/event-stream` and a JSON
 *     body; the reply is parsed whether it is JSON or an SSE stream of
 *     `data:` frames (this server answers JSON; a client must accept both);
 *   - `Mcp-Session-Id` is carried on every later request once a reply sets it,
 *     and `MCP-Protocol-Version` once initialize has negotiated one;
 *   - `initialize` records serverInfo.version, which the production tier
 *     compares with --expect-version;
 *   - `call(name, args)` → {isError, text, json, result}: tool failures are
 *     inside a 200 result with isError, transport errors are JSON-RPC errors.
 *
 * Every request goes through http.mjs, so it is guarded and traced.
 */

import { createHttp } from "./http.mjs";

export const ACCEPT = "application/json, text/event-stream";
export const CLIENT_INFO = Object.freeze({ name: "bikeshed-e2e", version: "1" });
export const DEFAULT_PROTOCOL = "2025-06-18";

/**
 * Parse a /mcp reply body into its JSON-RPC messages.
 * JSON: one message or a batch array. SSE: each event's `data:` lines joined.
 */
export function parseMcpBody(contentType, text) {
  const type = String(contentType ?? "").toLowerCase();
  if (!text || text.trim() === "") return [];
  if (type.includes("text/event-stream")) {
    const messages = [];
    for (const event of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    }
    return messages;
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** A tool result → {isError, text, json, result}. */
export function toolOutcome(result) {
  const text = (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  let json = result?.structuredContent;
  if (json === undefined && !result?.isError) {
    try {
      json = JSON.parse(text);
    } catch {}
  }
  return { isError: result?.isError === true, text, json, result };
}

/**
 * @param {object} target
 * @param {object} o
 * @param {string} [o.token]       bsk_ or bsa_; omitted for unauthenticated probes
 * @param {object} [o.http]        a client to reuse (its headers are kept)
 * @param {string} [o.actor]
 * @param {object} [o.headers]     extra headers on every request (X-Bikeshed-Client…)
 * @param {number} [o.timeoutMs]   the client's default request timeout (http.mjs createHttp); ignored with `o.http`, which keeps its own
 * @param {boolean} [o.cutoffError] throw E2E_STACK_CUTOFF for Hosting's cut-off 504 (http.mjs createHttp); ignored with `o.http`, which keeps its own
 */
export function mcpClient(target, o = {}) {
  const http =
    o.http ??
    createHttp(target, {
      actor: o.actor ?? "mcp",
      evidence: o.evidence,
      guard: o.guard,
      headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
      timeoutMs: o.timeoutMs,
      cutoffError: o.cutoffError,
    });
  let nextId = 1;
  const state = { sessionId: null, protocolVersion: null, serverInfo: null, instructions: null };

  function headers(extra = {}) {
    return {
      accept: ACCEPT,
      "content-type": "application/json",
      ...(state.sessionId ? { "mcp-session-id": state.sessionId } : {}),
      ...(state.protocolVersion ? { "mcp-protocol-version": state.protocolVersion } : {}),
      ...extra,
    };
  }

  /**
   * Send a raw body (any JSON value or a string) and return everything:
   * {status, headers, text, messages, json, response}. Never throws on status.
   */
  async function raw(body, r = {}) {
    const res = await http.request(r.method ?? "POST", r.path ?? "/mcp", {
      headers: headers(r.headers),
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      timeoutMs: r.timeoutMs,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) state.sessionId = sid;
    let messages = [];
    let parseError = null;
    try {
      messages = parseMcpBody(res.headers.get("content-type"), res.text);
    } catch (e) {
      parseError = e.message;
    }
    return { status: res.status, headers: res.headers, text: res.text, messages, json: res.json, parseError, response: res };
  }

  /** One JSON-RPC request → its response message; throws on transport failure. */
  async function rpc(method, params, r = {}) {
    const id = r.id ?? nextId++;
    const res = await raw({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }, r);
    if (res.status !== 200) {
      const err = new Error(`MCP ${method}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
      err.code = "E2E_MCP_HTTP";
      err.status = res.status;
      err.res = res;
      throw err;
    }
    const msg = res.messages.find((m) => m.id === id) ?? res.messages[0];
    if (!msg) throw new Error(`MCP ${method}: no JSON-RPC response in the reply`);
    return msg;
  }

  /** A notification (no id): resolves to the HTTP status (202 expected). */
  async function notify(method, params) {
    const res = await raw({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    return res.status;
  }

  /** A batch: [{method, params, id?, notification?}] → the response messages, in reply order. */
  async function batch(items) {
    const body = items.map((it) =>
      it.notification ? { jsonrpc: "2.0", method: it.method, params: it.params } : { jsonrpc: "2.0", id: it.id ?? nextId++, method: it.method, ...(it.params !== undefined ? { params: it.params } : {}) },
    );
    const res = await raw(body);
    return { status: res.status, messages: res.messages, res };
  }

  async function initialize(params = {}) {
    const msg = await rpc("initialize", {
      protocolVersion: params.protocolVersion ?? DEFAULT_PROTOCOL,
      capabilities: params.capabilities ?? {},
      clientInfo: params.clientInfo ?? CLIENT_INFO,
    });
    if (msg.error) throw new Error(`MCP initialize: ${msg.error.code} ${msg.error.message}`);
    state.protocolVersion = msg.result?.protocolVersion ?? null;
    state.serverInfo = msg.result?.serverInfo ?? null;
    state.instructions = msg.result?.instructions ?? null;
    if (params.sendInitialized !== false) await notify("notifications/initialized");
    return msg.result;
  }

  async function listTools() {
    const msg = await rpc("tools/list", {});
    if (msg.error) throw new Error(`MCP tools/list: ${msg.error.code} ${msg.error.message}`);
    return msg.result.tools;
  }

  /** tools/call → {isError, text, json, result}; a JSON-RPC error throws with .rpcError. */
  async function call(name, args = {}) {
    const msg = await rpc("tools/call", { name, arguments: args });
    if (msg.error) {
      const err = new Error(`MCP tools/call ${name}: ${msg.error.code} ${msg.error.message}`);
      err.code = "E2E_MCP_RPC";
      err.rpcError = msg.error;
      throw err;
    }
    return toolOutcome(msg.result);
  }

  /** call() that throws unless the tool succeeded; returns its json. */
  async function ok(name, args = {}) {
    const out = await call(name, args);
    if (out.isError) {
      const err = new Error(`MCP ${name} failed: ${out.text}`);
      err.code = "E2E_MCP_TOOL";
      err.outcome = out;
      throw err;
    }
    return out.json;
  }

  return {
    http,
    state,
    get serverVersion() {
      return state.serverInfo?.version ?? null;
    },
    raw,
    rpc,
    notify,
    batch,
    initialize,
    listTools,
    call,
    ok,
  };
}
