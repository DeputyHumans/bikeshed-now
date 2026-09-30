// SPDX-License-Identifier: Apache-2.0
// The HTTP and MCP client the CLI is built on (SPEC §19).

import { readFileSync } from "node:fs";
import { basename } from "node:path";

export const CLIENT_NAME = "bikeshed-cli/0.2.0";

/**
 * Two surfaces, and the split is deliberate rather than untidy.
 *
 *   POST /publish   takes RAW BYTES, so it is the only way to send a .zip
 *                   bundle without base64-inflating it through JSON. It is
 *                   also the exact endpoint the browser uploader calls.
 *   POST /mcp       is the API for everything else — list, read, update,
 *                   comments, reply — because those tools already exist and
 *                   adding a parallel REST surface would mean two
 *                   implementations of the same six operations.
 *
 * Both carry the same Bearer token, and both stamp provenance server-side. The
 * `X-Bikeshed-Client` and `X-Bikeshed-Agent` headers are self-reported and are
 * recorded as such: they are for a human reading an activity feed, not for
 * anything that makes a decision.
 */

function headers(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Bikeshed-Client": CLIENT_NAME,
    ...(process.env.BIKESHED_AGENT ? { "X-Bikeshed-Agent": process.env.BIKESHED_AGENT } : {}),
    ...extra,
  };
}

export class CliError extends Error {}

async function readError(res, fallback) {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
  } catch {
    /* keep the fallback */
  }
  return fallback;
}

/** Call one MCP tool and return its structured result. */
export async function callTool(origin, token, name, args = {}) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (res.status === 401) {
    throw new CliError(
      "That token was not accepted. Run `bikeshed login` again, or check BIKESHED_ORIGIN.",
    );
  }
  if (!res.ok) {
    throw new CliError(await readError(res, `The server returned ${res.status}.`));
  }

  const body = await res.json();
  if (body.error) throw new CliError(body.error.message);

  const result = body.result;
  if (result?.isError) {
    // A tool failure arrives INSIDE the result rather than as a transport
    // error, because the protocol reserves transport errors for transport
    // problems — and the message is the part worth showing.
    throw new CliError(result.content?.[0]?.text ?? "That did not work.");
  }
  return result?.structuredContent ?? result;
}

/** Upload a file as a NEW document, exactly as the browser uploader does. */
export async function uploadFile(origin, token, path, { title, folder } = {}) {
  const bytes = readFileSync(path);
  const params = new URLSearchParams({ filename: basename(path) });
  if (title) params.set("title", title);
  if (folder) params.set("folderId", folder);

  const res = await fetch(`${origin}/publish?${params}`, {
    method: "POST",
    headers: headers(token, { "Content-Type": "application/octet-stream" }),
    body: bytes,
  });

  if (res.status === 401) {
    throw new CliError("That token was not accepted. Run `bikeshed login` again.");
  }
  if (!res.ok) {
    throw new CliError(await readError(res, `Upload failed (${res.status}).`));
  }
  return res.json();
}

/**
 * The skills a deployment publishes, and their text.
 *
 * Unauthenticated on purpose: these are static files beside `/llms.txt`,
 * describing what the deployment can do, not anything belonging to an account.
 * Asking for a token to read public instructions would mean an agent has to be
 * credentialed before it can learn how to ask for credentials.
 */
export async function listSkills(origin) {
  const res = await fetch(`${origin}/skills/index.json`);
  if (!res.ok) {
    throw new CliError(
      `${origin} publishes no skills (${res.status}). It may be an older deployment.`,
    );
  }
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body?.skills)) {
    // A Hosting catch-all rewrite answers a missing file with the SPA's
    // index.html and a 200, so "it parsed as JSON" is the real test of whether
    // the endpoint exists — not the status code.
    throw new CliError(`${origin} returned something that is not a skill index.`);
  }
  return body;
}

/** Fetch one skill's Markdown, by the path its index gave. */
export async function fetchSkill(origin, skill) {
  const res = await fetch(`${origin}/${skill.path}`);
  if (!res.ok) throw new CliError(`could not read ${skill.name} (${res.status})`);
  return res.text();
}

/** Check that a token works, and say who it belongs to. */
export async function whoami(origin, token) {
  // list_documents is the cheapest authenticated call, and a token that can
  // list is a token that works.
  await callTool(origin, token, "list_documents", { limit: 1 });
  return true;
}
