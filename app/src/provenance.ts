// SPDX-License-Identifier: Apache-2.0
// What acted, in words: the label the server stored with the action, or for an older record its channel (SPEC §17, ADR 0023).

/**
 * The server writes `via` once, when something acts: "CLI on mbp",
 * `“Claude” (connected app)`, `personal token “deploy-bot”`. Anything written
 * before that carries only its channel, and gets the plainest words for it
 * rather than a guess at which CLI or which app.
 */
const OLD_CHANNEL_WORDS: Record<string, string> = {
  cli: "the command line",
  mcp: "MCP",
  api: "the API",
  app: "a connected app",
  operator: "an operator script",
};

export interface Acted {
  channel?: string;
  via?: string;
}

/** True when a person at a keyboard did not: anything but the browser. */
export function isAutomated(actor: Acted | null | undefined): boolean {
  return !!actor?.channel && actor.channel !== "web";
}

/** The words for what acted, or null for a person in the browser. */
export function viaOf(actor: Acted | null | undefined): string | null {
  if (!isAutomated(actor)) return null;
  return actor?.via || OLD_CHANNEL_WORDS[actor!.channel!] || actor!.channel!;
}
