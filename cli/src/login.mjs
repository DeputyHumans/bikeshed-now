// SPDX-License-Identifier: Apache-2.0
// Browser sign-in for the command line: PKCE over a loopback redirect (SPEC §23)

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";

import { CliError } from "./client.mjs";

/**
 * How `bikeshed login` gets a token without anybody copying one.
 *
 * The CLI listens on a random port on 127.0.0.1, opens the deployment's
 * consent page with that address as the redirect, and waits for the browser
 * to come back with a one-time code. The code is worth nothing without the
 * PKCE verifier, which never leaves this process, so a code that leaks through
 * browser history or another program on the machine cannot be redeemed.
 *
 * What comes back is an ordinary personal access token (SPEC §19). The browser
 * only replaces the copying.
 */

/** The built-in client the deployment knows without a registration. */
export const CLI_CLIENT_ID = "bikeshed-cli";

/** How long to wait for the browser before giving up. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export function createPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createState() {
  return randomBytes(16).toString("base64url");
}

/**
 * What the consent page calls this machine, so a person can tell two
 * terminals apart in their account. A hostname is whatever its owner typed,
 * so control and formatting characters go, and it is cut to fit a row.
 */
export function deviceName(raw = hostname()) {
  const clean = String(raw ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return Array.from(clean).slice(0, 60).join("");
}

/**
 * The deployment's authorization server metadata, or null when it predates
 * browser sign-in.
 *
 * "Predates" has two shapes. A 404 is the honest one. Hosting's catch-all
 * rewrite is the other: it answers a path it does not know with the app's
 * index.html and a 200, so a body that is not JSON means the same thing as a
 * 404 (the trap `listSkills` handles too).
 *
 * Anything that IS metadata has to describe this deployment and no other. An
 * endpoint on another origin would send the person, or the code, somewhere
 * they did not ask to sign in to.
 */
export async function discover(origin) {
  const base = new URL(origin).origin;
  let res;
  try {
    res = await fetch(`${base}/.well-known/oauth-authorization-server`, {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    throw new CliError(`could not reach ${base} (${e.cause?.code ?? e.message}).`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new CliError(`${base} answered ${res.status} when asked how to sign in.`);

  const meta = await res.json().catch(() => null);
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;

  const unusable = (why) => new CliError(`${base} describes its sign-in in a way this client cannot use: ${why}.`);
  if (meta.issuer !== base) {
    throw unusable(`it calls itself ${JSON.stringify(meta.issuer)}, not ${base}`);
  }
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    let endpoint;
    try {
      endpoint = new URL(meta[key]);
    } catch {
      throw unusable(`${key} is not an address`);
    }
    if (endpoint.origin !== base) throw unusable(`${key} is on ${endpoint.origin}`);
  }
  if (!Array.isArray(meta.code_challenge_methods_supported) || !meta.code_challenge_methods_supported.includes("S256")) {
    throw unusable("it does not offer S256 PKCE");
  }
  return meta;
}

/** The consent page's address, with every value encoded by URL itself. */
export function authorizeUrl(endpoint, { clientId, redirectUri, challenge, state, resource, device }) {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", resource);
  if (device) url.searchParams.set("device", device);
  return url.toString();
}

// --- The loopback listener --------------------------------------------------

export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
};

const PAGES = {
  ok: ["Signed in", "You're signed in. You can close this tab and go back to your terminal."],
  denied: ["Not connected", "You chose not to connect the command line, so nothing was saved. You can close this tab."],
  failed: ["Sign-in didn't finish", "Go back to your terminal, which says what happened. You can close this tab."],
};

/**
 * The page the browser lands on. Fixed text, chosen by kind: nothing from the
 * query string is ever written into it, so a crafted callback has nothing to
 * inject into.
 */
export function callbackPage(kind) {
  const [title, text] = PAGES[kind] ?? PAGES.failed;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Bikeshed</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 20vh 16px 0; text-align: center; color: #1c1c1c; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #ececec; background: #161616; } }
  h1 { font-size: 1.4rem; margin: 0 0 8px; }
  p { margin: 0 auto; max-width: 32rem; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>${text}</p>
</body>
</html>
`;
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Wait for the browser to come back.
 *
 * 127.0.0.1 only, and spelled as that literal in the redirect: `localhost` can
 * resolve to ::1 first, or to anything a hosts file says. The Host header is
 * checked too, because a web page that rebinds its own name to 127.0.0.1 can
 * reach this port, but cannot make its requests say this port's name.
 *
 * Only a request carrying this attempt's `state` ends the wait. Anything else
 * — another path, a stale tab, a forged callback — gets an error page and the
 * wait goes on. The first request that does carry it is the last one served:
 * the listener closes before the code is exchanged.
 */
export async function listenForCallback({ state, issuer, timeoutMs = LOGIN_TIMEOUT_MS }) {
  let settle;
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  let done = false;
  let timer;
  let port;

  const server = createServer((req, res) => {
    const reply = (status, kind, extra = {}) => {
      const body = callbackPage(kind);
      res.writeHead(status, { ...PAGE_HEADERS, "Content-Length": Buffer.byteLength(body), ...extra });
      res.end(body);
    };

    if (req.headers.host !== `127.0.0.1:${port}`) return reply(400, "failed");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method !== "GET" || url.pathname !== "/callback") return reply(404, "failed");
    if (done || !sameSecret(url.searchParams.get("state"), state)) return reply(400, "failed");

    // This attempt's answer. Whatever it says, it is the only one.
    done = true;
    clearTimeout(timer);
    server.close();
    res.on("finish", () => server.closeAllConnections());

    const params = url.searchParams;
    if (params.get("iss") !== issuer) {
      // A response for this request from some other server is the mix-up
      // attack RFC 9207 exists for. Its code is not sent anywhere.
      reply(400, "failed", { Connection: "close" });
      settle.reject(new CliError("The sign-in came back from a different server than the one you are signing in to. Nothing was saved."));
      return;
    }
    const error = params.get("error");
    if (error) {
      reply(200, error === "access_denied" ? "denied" : "failed", { Connection: "close" });
      const description = params.get("error_description");
      settle.resolve({ error, ...(description ? { description } : {}) });
      return;
    }
    const code = params.get("code");
    if (!code) {
      reply(400, "failed", { Connection: "close" });
      settle.resolve({ error: "invalid_response", description: "the browser came back without a code" });
      return;
    }
    reply(200, "ok", { Connection: "close" });
    settle.resolve({ code });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;

  const close = (reason) => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    if (!done) {
      done = true;
      settle.reject(reason ?? new CliError("Sign-in was cancelled. Nothing was saved."));
    }
  };
  timer = setTimeout(
    () => close(new CliError("Nothing came back from the browser in time. Nothing was saved; run `bikeshed login` to try again.")),
    timeoutMs,
  );

  return { redirectUri: `http://127.0.0.1:${port}/callback`, result, close: () => close() };
}

// --- Opening a browser ------------------------------------------------------

/**
 * The program that opens a web address, and its arguments.
 *
 * Never a shell. On Windows the usual answer is `cmd /c start`, and cmd splits
 * its command line at `&`, which every query string contains: the browser
 * would get the address up to the first parameter, and cmd would try to run
 * the rest as commands. rundll32 takes the whole address as one argument.
 *
 * Only http and https, which also rules out an "address" that starts with `-`
 * and reads to the opener as an option.
 */
export function browserCommand(platform, url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new CliError(`refusing to open something that is not a web address: ${url}`);
  }
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/**
 * Open a web address, best effort. The caller prints the address either way,
 * so a missing opener (no xdg-open, a locked-down machine) costs nothing; it
 * must never crash the command, which an unhandled spawn error would.
 */
export function openBrowser(url, platform = process.platform, run = spawn) {
  try {
    const [command, args] = browserCommand(platform, url);
    run(command, args, { stdio: "ignore", detached: true, shell: false })
      .on("error", () => {})
      .unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a browser opened from here would be one the person is looking at.
 * Over SSH it would open on the remote machine, or nowhere; without a display
 * xdg-open has nothing to open it on.
 */
export function canOpenBrowser(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}
