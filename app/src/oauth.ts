// SPDX-License-Identifier: Apache-2.0
// The authorize request: captured once, stripped from the URL, sent to consent (SPEC §23)

/**
 * An app that wants to connect sends the browser to `/connect?client_id=…`.
 * Those parameters are read ONCE, kept in sessionStorage, and removed from the
 * address bar before anything else gets to look at it. `client_id`,
 * `redirect_uri` and `state` would otherwise ride along on anything that reads
 * `document.location`, which includes the analytics tag (SPEC §15).
 *
 * The page never decides anything by itself. It sends what it captured to
 * `POST /oauth/consent`, shows the answer, and follows only a redirect that
 * goes back to the exact `redirect_uri` the request named.
 */

/** The only query keys that are kept. Anything else in the URL is dropped. */
export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
  "scope",
  "device",
] as const;

export type AuthorizeParam = (typeof AUTHORIZE_PARAMS)[number];
export type AuthorizeRequest = Partial<Record<AuthorizeParam, string>>;

const STORAGE_KEY = "bikeshed.connect";
/** Long enough to sign in and verify an address; short enough to go stale. */
export const CAPTURE_TTL_MS = 10 * 60 * 1000;

interface Saved {
  params: AuthorizeRequest;
  expiresAt: number;
}

/**
 * The fallback when sessionStorage throws (a private window, blocked site
 * data). React StrictMode calls a state initialiser twice, and the second call
 * finds the query already stripped, so without this copy it would find nothing.
 */
let memory: Saved | null = null;

function save(saved: Saved): void {
  memory = saved;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* the in-memory copy still covers this page's lifetime */
  }
}

function load(now: number): AuthorizeRequest | null {
  let saved: Saved | null = memory;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw) as Saved;
  } catch {
    /* keep the in-memory copy */
  }
  if (!saved || typeof saved.expiresAt !== "number" || saved.expiresAt <= now) {
    clearAuthorizeRequest();
    return null;
  }
  return pick(saved.params);
}

/** Only allowlisted keys, and only string values, whatever was stored. */
function pick(source: Record<string, unknown> | null | undefined): AuthorizeRequest {
  const params: AuthorizeRequest = {};
  if (!source) return params;
  for (const key of AUTHORIZE_PARAMS) {
    const value = source[key];
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

/**
 * Read the authorize request from the URL, keep it, and strip the URL.
 *
 * Safe to call more than once. With a query, it saves and strips; without one,
 * it returns whatever an earlier call saved, if that has not expired. Call it
 * during render, before any effect runs, because the app's analytics effect
 * reads the address as soon as it fires.
 */
export function captureAuthorizeRequest(now: number = Date.now()): AuthorizeRequest | null {
  const { search } = window.location;
  if (search.length > 1) {
    const query = new URLSearchParams(search);
    const params: AuthorizeRequest = {};
    for (const key of AUTHORIZE_PARAMS) {
      const value = query.get(key);
      if (value !== null) params[key] = value;
    }
    // History state is kept: React Router stores its own key there.
    window.history.replaceState(window.history.state, "", "/connect");
    if (Object.keys(params).length > 0) {
      save({ params, expiresAt: now + CAPTURE_TTL_MS });
      return params;
    }
  }
  return load(now);
}

/** Forget the request once it has been decided, or turned out to be dead. */
export function clearAuthorizeRequest(): void {
  memory = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored, then */
  }
}

// --- Consent ---------------------------------------------------------------

export interface ConsentClient {
  name: string;
  /** The host the client id was checked against. Null for DCR and the CLI. */
  host: string | null;
  verified: boolean;
  registration: "cimd" | "dcr" | "builtin";
}

export interface ConsentRedirect {
  host: string;
  kind: "web" | "loopback" | "app";
  scheme: string;
}

export interface DescribeValid {
  valid: true;
  client: ConsentClient;
  redirect: ConsentRedirect;
  account: { email: string };
  device: string | null;
}

/** `back` is present only when the error is safe to send to the app. */
export interface ConsentInvalid {
  valid: false;
  error: string;
  message: string;
  back?: string;
}

export type DescribeResult = DescribeValid | ConsentInvalid;
export type DecisionResult = { redirect: string } | ConsentInvalid;

export class ConsentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ConsentError";
  }
}

/**
 * The ID token, not the session cookie: the grant is bound to the exact
 * account on screen, and a personal access token cannot approve anything.
 */
async function consent<T>(
  action: "describe" | "approve" | "deny",
  params: AuthorizeRequest,
  idToken: string,
): Promise<T> {
  const res = await fetch("/oauth/consent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ action, params: pick(params) }),
  });
  if (res.ok) return (await res.json()) as T;
  let message = "";
  try {
    message = ((await res.json()) as { error?: string }).error ?? "";
  } catch {
    /* keep the fallback below */
  }
  if (res.status === 401) {
    throw new ConsentError("Your sign-in has expired. Sign in again to continue.", 401);
  }
  throw new ConsentError(message || `That didn't work (${res.status}).`, res.status);
}

export function describeRequest(params: AuthorizeRequest, idToken: string): Promise<DescribeResult> {
  return consent("describe", params, idToken);
}

export function approveRequest(params: AuthorizeRequest, idToken: string): Promise<DecisionResult> {
  return consent("approve", params, idToken);
}

export function denyRequest(params: AuthorizeRequest, idToken: string): Promise<DecisionResult> {
  return consent("deny", params, idToken);
}

// --- Leaving ---------------------------------------------------------------

/** The server refuses these as a redirect_uri too (`oauth/redirect.ts`). */
const FORBIDDEN_PROTOCOLS = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "blob:",
  "file:",
  "about:",
  "filesystem:",
  "ws:",
  "wss:",
  "ftp:",
  "intent:",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The URL to follow, or null when it must not be followed.
 *
 * It never navigates itself, so the page can say what happened either way.
 * The server builds the redirect by appending to the request's exact
 * `redirect_uri`: `?` when that has no query, `&` when it already has one. So
 * the URL must start with that string followed by exactly that separator, which
 * rules out a host that merely starts the same way. It is then parsed again,
 * and its protocol checked, because a string comparison cannot see what a
 * browser will make of `JavaScript:` or a leading space.
 */
export function safeNavigate(url: unknown, redirectUri: string | undefined): string | null {
  if (typeof url !== "string" || !redirectUri) return null;
  // Printable ASCII only, as the server requires of a redirect_uri. A URL
  // parser drops tabs and edge whitespace silently; refusing them is simpler
  // than reasoning about what was dropped.
  if (!/^[\x21-\x7e]+$/.test(url)) return null;
  const separator = redirectUri.includes("?") ? "&" : "?";
  if (!url.startsWith(redirectUri + separator)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (FORBIDDEN_PROTOCOLS.has(protocol)) return null;
  if (protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return url;
}

/** Where the person goes, as a host they can read. Punycode, never Unicode. */
export function displayHost(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

/** The one call that leaves the page. A wrapper so a test can stand in for it. */
export function leave(url: string): void {
  window.location.assign(url);
}
