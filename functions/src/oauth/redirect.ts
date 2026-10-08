// SPDX-License-Identifier: Apache-2.0
// Which redirect URIs exist, when two match, and the response sent to one (SPEC §23).

/**
 * Where a person is sent back to after deciding.
 *
 *   web       an https address
 *   loopback  http on this computer, for a native app or the CLI
 *   app       a private-use scheme a desktop app registered, e.g. `cursor:`
 */
export type RedirectKind = "web" | "loopback" | "app";

export interface ParsedRedirect {
  raw: string;
  url: URL;
  kind: RedirectKind;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Schemes that are never a place to send an authorization code.
 *
 * The first five run or read something in the browser, which on this origin
 * would run with the person's session; the rest are not an application's
 * callback by any reading. This list exists BESIDE an allowlist shape, never
 * instead of one: what reaches it has already parsed as a URL and passed the
 * scheme grammar, which is what stops `JavaScript:` or ` javascript:` or a
 * tab inside the word from getting here at all.
 */
const FORBIDDEN_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "blob:",
  "file:",
  "about:",
  "filesystem:",
  "view-source:",
  "ws:",
  "wss:",
  "ftp:",
  "intent:",
  "jar:",
  "chrome:",
]);

/**
 * Parse a redirect URI, or refuse it.
 *
 * Checked on the RAW string first: printable ASCII only, so no space, tab,
 * newline or control character survives to be stripped by a browser later —
 * browsers drop tabs and newlines inside a scheme and trim leading control
 * characters, which is how a string-prefix check is defeated. Only then is it
 * parsed, and the decision is taken on the parsed protocol.
 */
export function parseRedirectUri(raw: unknown): ParsedRedirect | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;
  if (raw.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;

  const protocol = url.protocol;
  if (protocol === "https:") {
    return url.hostname ? { raw, url, kind: "web" } : null;
  }
  if (protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname) ? { raw, url, kind: "loopback" } : null;
  }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(protocol)) return null;
  if (FORBIDDEN_SCHEMES.has(protocol)) return null;
  return { raw, url, kind: "app" };
}

/**
 * Does a presented redirect URI match a registered one?
 *
 * Exact string comparison, as OAuth requires — with the one exception RFC 8252
 * makes: a loopback redirect matches whatever PORT it presents, because a
 * native app binds an ephemeral one. Claude Code registers
 * `http://localhost/callback` and arrives on `http://localhost:3118/callback`.
 * Host, path and query must still be identical, and `localhost` is not
 * `127.0.0.1`: they can resolve differently, so each is matched only as itself.
 */
export function redirectMatches(registered: string, presented: string): boolean {
  const a = parseRedirectUri(registered);
  const b = parseRedirectUri(presented);
  if (!a || !b) return false;
  if (a.raw === b.raw) return true;
  if (a.kind !== "loopback" || b.kind !== "loopback") return false;
  return (
    a.url.hostname === b.url.hostname &&
    a.url.pathname === b.url.pathname &&
    a.url.search === b.url.search
  );
}

/** A short, human label for where a redirect goes. Punycode, never Unicode. */
export function redirectHost(parsed: ParsedRedirect): string {
  return parsed.url.host || parsed.url.protocol.replace(/:$/, "");
}

/**
 * The authorization response: the redirect URI with the result appended.
 *
 * Appended to the URI exactly as presented, so a query the client registered
 * comes back byte for byte. `iss` is on every response, success or error
 * (RFC 9207) — ChatGPT rejects one without it once it has been told to expect it.
 */
export function authorizationResponse(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) query.set(key, value);
  }
  return `${redirectUri}${redirectUri.includes("?") ? "&" : "?"}${query.toString()}`;
}
