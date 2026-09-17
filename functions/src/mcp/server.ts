// SPDX-License-Identifier: Apache-2.0
// A minimal MCP server over streamable HTTP (SPEC §19).

/**
 * Why this is hand-written rather than built on the MCP SDK
 * --------------------------------------------------------
 * The plan named `@modelcontextprotocol/sdk`. In practice the SDK pulls `zod` as
 * a required peer, which puts the functions runtime over the dependency budget
 * this project sets itself — and the SERVER half of streamable HTTP is a small,
 * fully specified surface: a JSON-RPC 2.0 request arrives by POST, a JSON-RPC
 * response goes back. Five methods, no session state, no streaming required.
 *
 * So it is implemented directly: ~120 lines, zero dependencies, and the whole
 * protocol is visible in one file instead of behind a framework. The trade is
 * that protocol changes are ours to follow; the version is pinned in
 * PROTOCOL_VERSION and asserted by a test that speaks the wire format.
 *
 * Deliberately NOT implemented: server-sent events (no tool here streams),
 * sessions (every request carries its own credential), and sampling/roots/prompts
 * (nothing would use them).
 */

import * as admin from "firebase-admin";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { actorFrom } from "../lib/actor";
import { bearerFrom, isTokenShaped, verifyToken } from "../lib/tokens";
import { TOOLS, toolByName, type ToolContext } from "./tools";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "bikeshed", version: "0.1.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

/** Handle one JSON-RPC message. Returns null for a notification. */
async function dispatch(
  message: JsonRpcRequest,
  ctx: ToolContext,
): Promise<unknown | null> {
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Publish documents and read anchored review feedback. get_comments " +
          "returns each comment together with the exact passage it is about, so " +
          "you can revise without fetching and diffing the whole document.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = String(params?.name ?? "");
      const tool = toolByName(name);
      if (!tool) {
        return rpcError(id, METHOD_NOT_FOUND, `no tool named "${name}"`);
      }
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      try {
        const output = await tool.run(ctx, args);
        // Tool failures are reported INSIDE the result with isError, not as a
        // JSON-RPC error: the protocol reserves transport errors for transport
        // problems, and an agent needs to see the message to correct itself.
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: false,
        });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: (e as Error).message }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, METHOD_NOT_FOUND, `unknown method "${method}"`);
  }
}

/**
 * Handle a POST to /mcp.
 *
 * Authentication is a personal access token, and the channel is stamped `mcp`
 * unconditionally — the endpoint knows more about the channel than the
 * credential does, so a token minted for the CLI still reads as `mcp` when it
 * arrives here. There is no anonymous MCP access: publishing always attributes
 * to a real account.
 */
export async function handleMcp(req: Request, res: Response): Promise<void> {
  if (req.method === "GET" || req.method === "DELETE") {
    // Streamable HTTP allows a server to decline the SSE channel. Saying so
    // explicitly is friendlier than a 404, which reads as "wrong URL".
    res.status(405).json(rpcError(null, INVALID_REQUEST, "this server is POST-only"));
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).end();
    return;
  }

  const token = bearerFrom(
    Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization,
  );
  // Shape first, so a malformed credential never constructs a database handle.
  const verified = isTokenShaped(token)
    ? await verifyToken(admin.firestore(), token as string)
    : null;
  if (!verified) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="bikeshed"');
    res
      .status(401)
      .json(rpcError(null, INVALID_REQUEST, "a personal access token is required"));
    return;
  }

  let payload: unknown;
  try {
    payload =
      typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)
        ? req.body
        : JSON.parse((req.rawBody ?? Buffer.from("")).toString("utf8"));
  } catch {
    res.status(400).json(rpcError(null, PARSE_ERROR, "invalid JSON"));
    return;
  }

  const principal = {
    uid: verified.uid,
    emailLower: verified.emailLower,
    channel: "mcp" as const,
    tokenId: verified.tokenId,
  };
  const ctx: ToolContext = {
    db: admin.firestore(),
    caller: principal,
    actor: actorFrom(principal, req, "mcp"),
  };

  const messages: JsonRpcRequest[] = Array.isArray(payload)
    ? (payload as JsonRpcRequest[])
    : [payload as JsonRpcRequest];

  const responses: unknown[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      responses.push(rpcError(null, INVALID_REQUEST, "not a JSON-RPC request"));
      continue;
    }
    try {
      const response = await dispatch(message, ctx);
      if (response) responses.push(response);
    } catch (e) {
      responses.push(rpcError(message.id, INTERNAL_ERROR, (e as Error).message));
    }
  }

  // A batch of notifications produces nothing to say; 202 is the protocol's
  // answer for "accepted, no response body".
  if (responses.length === 0) {
    res.status(202).end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.status(200).json(Array.isArray(payload) ? responses : responses[0]);
}
