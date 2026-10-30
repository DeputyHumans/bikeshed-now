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
import { actorFrom, principalOf } from "../lib/actor";
import { bearerFrom, isTokenShaped, verifyToken, type VerifiedToken } from "../lib/tokens";
import { isAccessTokenShaped, verifyAccessToken } from "../oauth/grants";
import { allowedResources, challenge } from "../oauth/metadata";
import { TOOLS, toolByName, type ToolContext } from "./tools";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "bikeshed", version: "0.27.0" };

/**
 * What a client injects into the model's context on connect.
 *
 * Stated as fact, not as an instruction to override the host. A server cannot
 * make itself the place documents go — Claude Code says so explicitly, and it is
 * right: anything else would let any server claim the role by describing itself
 * that way. What this can do is tell a model what exists here and what does not,
 * so the three things it would otherwise get wrong — that there is an address to
 * hand back, that a document is not world-readable, that its scripts do not run
 * — do not have to be discovered a round trip at a time.
 *
 * Short on purpose: Codex treats the first 512 characters as the self-contained
 * part and Claude Code caps the whole thing at 2 KB, so the sentences that matter
 * most come first. A test pins both budgets.
 */
export const INSTRUCTIONS =
  "Bikeshed is where this person publishes documents for other people to read " +
  "and comment on. A finished write-up goes here, with publish_document, rather " +
  "than to a built-in artifact tool; the result carries the address a reader " +
  "opens, and you always give the person that url. Revise with update_document, " +
  "passing the baseVersion you revised; identical bytes mint no version. " +
  "fork_document copies one you can read into one you own, and get_lineage " +
  "says where one came from; an author sees a count of forks, never who made " +
  "them. " +
  "get_comments returns each comment together with the exact passage it is " +
  "about, so you can revise without fetching and diffing the whole document. " +
  "Raise a new point on a passage with add_comment; answer a thread with " +
  "reply_to_comment, and close it with resolve_thread once it is dealt with. A " +
  "new document is readable by its owner and by the members of any folder it is " +
  "filed in, until a person shares it. Nobody is emailed when it is filed, so " +
  "say where it went and who can read it there: get_folder and the result's " +
  "access name them. Owners can manage grants, visibility and expiry; folder " +
  "editors can rename and move folders, and owners can delete them, retaining " +
  "their contents. New grants email new readers. Document scripts stay sandboxed. " +
  "Where you may suggest but not edit, propose a change with suggest_edit; " +
  "until it is decided, revise_suggestion and withdraw_suggestion change or " +
  "take back your own. For an owner or approver, accept_suggestion makes " +
  "one's change in the draft, reject_suggestion declines it, and " +
  "commit_draft publishes the draft. list_versions discovers history; get_document " +
  "and get_comments accept version. Older versions and their feedback are read-only. " +
  "Pass version on feedback writes and baseVersion on update_document/commit_draft; " +
  "if stale, read the latest and reassess, never silently retarget.";

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
/**
 * Enforce a tool's own `required` list before it runs.
 *
 * Without this a missing argument reaches Firestore and comes back as
 * `Value for argument "documentPath" is not a valid resource path` — an internal
 * error that tells an agent nothing about which argument to supply. An agent's
 * context is the scarce resource on this surface, so an error that costs a round
 * trip and teaches nothing is the expensive kind.
 *
 * Empty string counts as missing: every required argument here is an id or a
 * body, and none of them is meaningfully empty.
 *
 * Returns the complaint, or null when the arguments are acceptable.
 */
export function missingArguments(
  tool: { name: string; inputSchema: Record<string, unknown> },
  args: Record<string, unknown>,
): string | null {
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  const missing = required.filter(
    (key) => args[key] === undefined || args[key] === null || args[key] === "",
  );
  if (missing.length === 0) return null;
  const plural = missing.length === 1 ? "argument" : "arguments";
  const names = missing.map((k) => `"${k}"`).join(", ");
  return `${tool.name}: missing required ${plural} ${names}. Call tools/list for this tool's schema.`;
}

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
        instructions: INSTRUCTIONS,
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

      const complaint = missingArguments(tool, args);
      if (complaint) {
        return rpcResult(id, {
          content: [{ type: "text", text: complaint }],
          isError: true,
        });
      }

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
 * Authentication is a personal access token or a connected app's access token
 * (SPEC §23), and what acted is the credential's own channel: the CLI reads
 * `cli` here too, a connected app `app`, and only a personal token minted for
 * MCP reads `mcp` (ADR 0023). There is no anonymous MCP access: publishing
 * always attributes to a real account.
 */
export async function handleMcp(req: Request, res: Response): Promise<void> {
  // The CORS middleware exposes no response headers, so without this a
  // browser-hosted client cannot read the challenge that tells it to sign in.
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
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
  let verified: VerifiedToken | null = null;
  if (isTokenShaped(token)) {
    verified = await verifyToken(admin.firestore(), token as string);
  } else if (isAccessTokenShaped(token)) {
    verified = await verifyAccessToken(admin.firestore(), token as string, allowedResources(req));
  }
  if (!verified) {
    // `resource_metadata` is what lets an OAuth-capable client find the
    // sign-in; Claude starts it only from a 401 that carries it.
    res.setHeader("WWW-Authenticate", challenge(req, token !== null));
    res
      .status(401)
      .json(rpcError(null, INVALID_REQUEST, "sign in to connect, or send a personal access token"));
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

  // Its own channel and name, never the endpoint's (ADR 0023).
  const principal = principalOf(verified);
  const ctx: ToolContext = {
    db: admin.firestore(),
    caller: principal,
    actor: actorFrom(principal, req),
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
