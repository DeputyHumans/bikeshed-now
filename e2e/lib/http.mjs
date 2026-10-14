// SPDX-License-Identifier: Apache-2.0
// One traced fetch for Node specs: a cookie jar per actor, guard first, redacted JSONL evidence (SPEC §12).

/**
 * Every HTTP request a Node spec makes goes through `createHttp(...)`. It
 *
 *   1. resolves the URL against the target and refuses, on a local target, any
 *      host that is not loopback or any port that is not this stack's (the
 *      Node half of the isolation tripwire; the browser half is browser.mjs);
 *   2. asks the guard first (`guard.check(req)`), which on production refuses
 *      everything that could send an email or touch a document the run does
 *      not own, and on a local target allows everything;
 *   3. sends `User-Agent` and `X-Bikeshed-Agent: bikeshed-e2e/<runId>`, so the
 *      deployment's own logs can be counted for the run (the zero-send proof);
 *   4. keeps cookies per actor — `__session` above all — in its own jar;
 *   5. writes one redacted JSONL row per request to the evidence sink.
 *
 * Redaction is fail-closed: after a row is redacted it is checked again for a
 * credential shape, and a row that still holds one is never written — the
 * request throws E2E_REDACTION instead, because a leak is a harness bug.
 *
 * The jar ignores `Secure` on loopback http origins, as browsers do for
 * localhost: the emulator serves http, and `/session` sets a Secure cookie.
 *
 * Redirects are NOT followed unless asked (`redirect: "follow"`): several
 * oracles are about the 3xx itself. When asked, they are followed HERE, one
 * hop at a time (never by fetch), so every hop gets the isolation check and
 * the guard before it is sent, its own trace row, and the jar's cookies for
 * its own URL: a redirect to a host or port outside the stack throws
 * E2E_ISOLATION before anything is sent there. Like fetch: 303, and 301/302
 * after a POST, become a GET without a body; Authorization is dropped when
 * the origin changes; at most `maxRedirects` (20) hops.
 *
 * Every request is bounded: by its own `timeoutMs`, else by the client's
 * (`createHttp(target, {timeoutMs})`, kept by `with()`), else by
 * DEFAULT_REQUEST_TIMEOUT_MS (60 s). A helper that passes a request
 * `timeoutMs: undefined` (seed.publish without one) gets the client's. On a
 * contended shared stack one POST /publish has taken over 60 s, so a spec
 * that waits longer says so once, on the client, not on every call.
 *
 * A client made with `cutoffError: true` (kept by `with()`) throws
 * E2E_STACK_CUTOFF instead of returning the Hosting emulator's own 504 for a
 * function that has not answered: a 504 whose request took HOSTING_CUTOFF_MS
 * or more, timed per hop. Its message and `stackCut` are lib/test.mjs
 * stackCutoff's, "<METHOD> <path> answered 504 after <ms> ms, Hosting's
 * cut-off for a function that has not answered" (redacted), and `response`
 * is the response. It is thrown before `expect` is checked. A quicker 504, or
 * any other status however slow, is returned as before: the product answered.
 *
 * A hop's record reaches the sink only once the hop is over. Until then it is
 * in flight, and `pendingRequests(sink)` lists it ({t, actor, method, url},
 * redacted) under the sink its record will go to: lib/test.mjs
 * ctx.requests({pending: true}) reads it, so a judge sees the request a case's
 * budget ran out during.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { denySet } from "./ports.mjs";

export const REDACTED = "‹redacted›";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_TRACE_BODY = 4096;

/** Shapes that must never reach a trace, checked AFTER redaction. */
export const LEAK_RE = new RegExp(
  [
    String.raw`\b(?:bsk|bsa|bsr)_[0-9a-f]{32}\.(?!‹)[A-Za-z0-9_-]{8,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
    String.raw`__session=(?!‹)[^;\s"]{8,}`,
    String.raw`[?&]k=(?!‹)[^&#\s"]{6,}`,
    String.raw`\bre_e2e_[0-9a-f]{8,}`,
  ].join("|"),
);

/** JSON keys whose string values are credentials wherever they appear. */
export const SECRET_KEYS = new Set([
  "k", "linkToken", "password", "idToken", "refreshToken", "refresh_token", "access_token",
  "token", "code", "code_verifier", "oobCode", "sessionCookie", "secret", "plaintext", "id_token",
]);

// `auth` is the Realtime Database REST credential (an ID token, or a legacy secret that has no JWT shape).
const QUERY_SECRET_RE = /([?&](?:k|code|code_verifier|oobCode|refresh_token|access_token|token|idToken|id_token|password|auth)=)[^&#\s"']+/g;
const FORM_SECRET_RE = /((?:^|&)(?:k|code|code_verifier|refresh_token|access_token|password|oobCode|id_token)=)[^&\s]*/g;

/** Redact every credential shape in a string. */
export function redactString(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  return s
    .replace(/\b(bsk|bsa|bsr)_([0-9a-f]{32})\.[A-Za-z0-9_-]+/g, `$1_$2.${REDACTED}`)
    .replace(/\b(bsk|bsa|bsr)_(?![0-9a-f]{32}\.‹)[A-Za-z0-9._-]+/g, `$1_${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.?[A-Za-z0-9_-]*/g, `‹jwt›`)
    .replace(/(__session=)[^;\s"]+/g, `$1${REDACTED}`)
    .replace(QUERY_SECRET_RE, `$1${REDACTED}`)
    .replace(/(\/(?:content|thumb|download|draft|d)\/)~[^/?#\s"']+/g, `$1~${REDACTED}`)
    .replace(/\bre_e2e_[0-9a-f]+/g, `re_e2e_${REDACTED}`);
}

/** Redact a parsed JSON value: secret keys by name, every string by shape. */
export function redactJson(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) && typeof v === "string" && v.length > 0 ? REDACTED : redactJson(v);
    }
    return out;
  }
  return value;
}

/** Redact a body for the trace, whatever its type. Binary becomes a digest. */
export function redactBody(body, contentType = "") {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    const buf = Buffer.from(body);
    const textual = /json|text|html|xml|x-www-form-urlencoded|event-stream|javascript/i.test(contentType);
    if (!textual) return `<${buf.length} bytes sha256:${createHash("sha256").update(buf).digest("hex").slice(0, 16)}>`;
    body = buf.toString("utf8");
  }
  if (typeof body !== "string") body = JSON.stringify(body);
  let out;
  if (/x-www-form-urlencoded/i.test(contentType)) {
    out = redactString(body.replace(FORM_SECRET_RE, `$1${REDACTED}`));
  } else {
    try {
      out = JSON.stringify(redactJson(JSON.parse(body)));
    } catch {
      // SSE frames carry JSON after `data:`; redact each frame's JSON by key too.
      out = redactString(
        body.replace(/^data: ?(.*)$/gm, (line, data) => {
          try {
            return `data: ${JSON.stringify(redactJson(JSON.parse(data)))}`;
          } catch {
            return line;
          }
        }),
      );
    }
  }
  return out.length > MAX_TRACE_BODY ? `${out.slice(0, MAX_TRACE_BODY)}… (${out.length} chars)` : out;
}

/** Redact a header map: credentials by name, everything else by shape. */
export function redactHeaders(headers) {
  const out = {};
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers ?? {});
  for (const [rawK, v] of entries) {
    const k = rawK.toLowerCase();
    if (k === "set-cookie") {
      // The value goes; the attributes stay, because they are what A1 checks.
      const values = Array.isArray(v) ? v : [v];
      out[k] = values.map((c) => String(c).replace(/^\s*([^=;\s]+)=[^;]*/, `$1=${REDACTED}`)).join(" | ");
      continue;
    }
    if (k === "cookie") {
      out[k] = String(v).replace(/(^|;\s*)([^=;\s]+)=[^;]*/g, `$1$2=${REDACTED}`);
      continue;
    }
    if (k === "authorization") {
      const m = /^(\w+)\s+(.*)$/.exec(String(v));
      if (!m) out[k] = REDACTED;
      else if (m[1].toLowerCase() === "bearer" && m[2] === "owner") out[k] = "Bearer owner"; // the emulator's admin, not a secret
      else if (m[1].toLowerCase() === "bearer" && redactString(m[2]) !== m[2]) out[k] = `Bearer ${redactString(m[2])}`;
      else out[k] = `${m[1]} ${REDACTED}`;
      continue;
    }
    out[k] = redactString(String(v));
  }
  return out;
}

/** A trace row, fully redacted, or a throw if anything credential-shaped survived. */
export function traceLine(record) {
  const line = JSON.stringify(record);
  if (LEAK_RE.test(line)) {
    const err = new Error(`redaction failed for ${record.method} ${record.url}: a credential shape survived; the row was not written`);
    err.code = "E2E_REDACTION";
    throw err;
  }
  return line;
}

// --- Cookie jar ------------------------------------------------------------

function isLoopbackUrl(u) {
  return LOOPBACK.has(u.hostname) || LOOPBACK.has(`[${u.hostname}]`);
}

/** A minimal RFC 6265 jar: host-only and domain cookies, path, expiry, Secure. */
export class CookieJar {
  constructor() {
    this.cookies = new Map(); // key `${domain}|${path}|${name}`
  }

  /** Store every Set-Cookie of a response for `url`. */
  store(url, setCookies) {
    const u = new URL(url);
    for (const sc of setCookies ?? []) {
      const [pair, ...attrs] = String(sc).split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const c = { name, value, domain: u.hostname.toLowerCase(), hostOnly: true, path: "/", secure: false, expires: null };
      for (const a of attrs) {
        const [ak, ...av] = a.split("=");
        const key = ak.trim().toLowerCase();
        const val = av.join("=").trim();
        if (key === "max-age") c.expires = Date.now() + Number(val) * 1000;
        else if (key === "expires" && c.expires === null) c.expires = Date.parse(val);
        else if (key === "path" && val.startsWith("/")) c.path = val;
        else if (key === "domain" && val) {
          c.domain = val.replace(/^\./, "").toLowerCase();
          c.hostOnly = false;
        } else if (key === "secure") c.secure = true;
      }
      const id = `${c.domain}|${c.path}|${c.name}`;
      if (c.expires !== null && c.expires <= Date.now()) this.cookies.delete(id);
      else this.cookies.set(id, c);
    }
  }

  /** The Cookie header for a request to `url`, or undefined. */
  header(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const secureOk = u.protocol === "https:" || isLoopbackUrl(u);
    const now = Date.now();
    const out = [];
    for (const [id, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) {
        this.cookies.delete(id);
        continue;
      }
      const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`);
      const pathOk = u.pathname === c.path || u.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`) || c.path === "/";
      if (domainOk && pathOk && (!c.secure || secureOk)) out.push(`${c.name}=${c.value}`);
    }
    return out.length > 0 ? out.join("; ") : undefined;
  }

  get(name) {
    for (const c of this.cookies.values()) if (c.name === name) return c.value;
    return undefined;
  }

  has(name) {
    return this.get(name) !== undefined;
  }

  clear() {
    this.cookies.clear();
  }
}

// --- Evidence sink ---------------------------------------------------------

let defaultSink = null;

/**
 * The sink of the test case whose code is running, carried through every
 * await by AsyncLocalStorage. scenario() runs each body inside one, so a
 * client made without an explicit sink (openSession's, a module-level one)
 * logs into the case that actually made the request — and a timed-out body
 * that keeps running after node:test has moved on still logs into its own
 * case, never into the next one's.
 */
const caseSink = new AsyncLocalStorage();

/** Run `fn` with `sink` as the evidence sink of every client that has no explicit one. */
export function withEvidenceSink(sink, fn) {
  return caseSink.run(typeof sink === "function" ? sink : null, fn);
}

/**
 * Install a process-wide fallback sink, used outside any case's
 * withEvidenceSink(). It receives each redacted row as a JSON string. Pass
 * null to restore the default (`$E2E_EVIDENCE_DIR/http.jsonl`, else
 * `<runDir>/http.jsonl`).
 */
export function setEvidenceSink(fn) {
  defaultSink = typeof fn === "function" ? fn : null;
}

function fileSink(file) {
  let made = false;
  return (line) => {
    if (!made) {
      mkdirSync(dirname(file), { recursive: true });
      made = true;
    }
    appendFileSync(file, line + "\n");
  };
}

// --- Requests in flight ----------------------------------------------------

/**
 * The hops each evidence sink is still waiting on: sent (past the isolation
 * check and the guard) and not yet answered or failed. A hop's record reaches
 * its sink only once it is over, so without this a request the stack is still
 * sitting on is invisible to a judge reading the case's rows: the one a case's
 * budget ran out during, above all. Keyed by the sink function the hop's
 * record will be written to, so a case reads exactly the requests whose rows
 * will be its own; a client made with `evidence: false`, or a directory, is
 * not tracked.
 */
const inFlight = new WeakMap();

/** The sink function a hop of a client made with `evidence` is logged to, as resolveSink decides it at the moment of sending; null when it is none. */
function flightKey(evidence) {
  if (evidence === false || typeof evidence === "string") return null;
  if (typeof evidence === "function") return evidence;
  return caseSink.getStore() ?? defaultSink ?? null;
}

/**
 * The hops `sink` is still waiting on, oldest first: [{t (when it was sent, a
 * Date.now() time), actor, method, url (redacted)}], copies. [] for anything
 * that is not a sink with a hop in flight. lib/test.mjs ctx.requests({pending:
 * true}) reads it with the case's own sink.
 */
export function pendingRequests(sink) {
  const hops = typeof sink === "function" ? inFlight.get(sink) : null;
  return hops ? [...hops].map((h) => ({ ...h })) : [];
}

function trackHop(key, hop) {
  if (key === null) return;
  let hops = inFlight.get(key);
  if (!hops) inFlight.set(key, (hops = new Set()));
  hops.add(hop);
}

function untrackHop(key, hop) {
  if (key === null) return;
  inFlight.get(key)?.delete(hop);
}

function resolveSink(evidence, target) {
  if (evidence === false) return () => {};
  if (typeof evidence === "function") return evidence;
  if (typeof evidence === "string") return fileSink(join(evidence, "http.jsonl"));
  // Decided per REQUEST, not when the client was made: the running case's
  // sink, else the process-wide one, else the run's file.
  let file = null;
  return (line) => {
    const sink = caseSink.getStore() ?? defaultSink;
    if (sink) return sink(line);
    file ??= fileSink(join(process.env.E2E_EVIDENCE_DIR || target.runDir, "http.jsonl"));
    return file(line);
  };
}

/**
 * The sink a createHttp client made with `evidence` writes its rows to, for
 * requests sent OUTSIDE createHttp (lib/sync.mjs syncHttp's worker threads),
 * so their rows land beside the client's: a function is itself; a directory
 * is its http.jsonl; false writes nothing; undefined decides per row, as a
 * client does: the running case's sink (withEvidenceSink, so the case's
 * http.jsonl and ctx.requests()), else the process-wide one (setEvidenceSink),
 * else `$E2E_EVIDENCE_DIR/http.jsonl` or `<target.runDir>/http.jsonl`. Give it
 * only traceLine() strings. TypeError for any other `evidence`.
 */
export function evidenceSink(target, evidence = undefined) {
  if (evidence !== undefined && evidence !== false && typeof evidence !== "function" && typeof evidence !== "string") {
    throw new TypeError(`evidenceSink: evidence is a sink function, a directory, false or undefined (the running case's), got ${JSON.stringify(evidence) ?? String(evidence)}`);
  }
  return resolveSink(evidence, target);
}

/**
 * Count one request sent OUTSIDE createHttp as in flight, under the sink a
 * client made with `evidence` would log it to (decided now, in the caller's
 * async context: the running case's), until the returned `untrack()` is
 * called (idempotent). Meanwhile pendingRequests(sink), so
 * ctx.requests({pending: true}), lists it. `hop` is {t (Date.now() when it
 * was sent; default now), actor (default "anon"), method, url}; the url is
 * redacted here. Nothing is tracked for `evidence` false or a directory, as
 * for a client.
 */
export function trackPending(evidence, { t = Date.now(), actor = "anon", method, url } = {}) {
  if (typeof method !== "string" || !method) throw new TypeError(`trackPending: method is a string, got ${JSON.stringify(method) ?? String(method)}`);
  if (typeof url !== "string" || !url) throw new TypeError(`trackPending: url is a string, got ${JSON.stringify(url) ?? String(url)}`);
  const key = flightKey(evidence);
  const hop = { t, actor: String(actor), method: method.toUpperCase(), url: redactString(url) };
  trackHop(key, hop);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    untrackHop(key, hop);
  };
}

// --- Client ----------------------------------------------------------------

/** How long a request waits for its answer when neither it nor its client says otherwise. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** A client's default timeout: a positive number of ms, or undefined/null for DEFAULT_REQUEST_TIMEOUT_MS. */
function clientTimeout(value, where) {
  if (value === undefined || value === null) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${where}: timeoutMs is a positive number of ms (the default for every request of the client), got ${JSON.stringify(value) ?? String(value)}`);
  }
  return value;
}

/**
 * Hosting's cut-off for a function that has not answered: lib/test.mjs
 * HOSTING_CUTOFF_MS, the same 59,000 ms (selftest/http-cutoff.test.mjs pins
 * the two together at the boundary; this module does not import the scenario
 * runner).
 */
const HOSTING_CUTOFF_MS = 59_000;

/** A client's `cutoffError`: true or false, or undefined/null for false. */
function clientCutoff(value, where) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new TypeError(`${where}: cutoffError is true or false (throw E2E_STACK_CUTOFF for Hosting's cut-off 504), got ${JSON.stringify(value) ?? String(value)}`);
  }
  return value;
}

/** E2E_STACK_CUTOFF for `method url` answered Hosting's cut-off 504 after `ms`, worded as lib/test.mjs stackCutoff words it. */
function cutoffErrorFor(method, url, ms, response) {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {}
  const reason = redactString(`${method} ${path} answered 504 after ${Math.round(ms)} ms, Hosting's cut-off for a function that has not answered`);
  const err = new Error(reason);
  err.code = "E2E_STACK_CUTOFF";
  err.stackCut = reason;
  err.response = response;
  return err;
}

export function agentName(target) {
  return `bikeshed-e2e/${target.runId}`;
}

/** Throw unless `url` is somewhere a spec on this target may talk to. */
export function assertReachable(target, url, allowPorts = []) {
  const u = new URL(url);
  if (target.kind === "local") {
    if (!isLoopbackUrl(u)) {
      const err = new Error(`isolation breach: ${u.host} is not loopback on a local target`);
      err.code = "E2E_ISOLATION";
      throw err;
    }
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const own = new Set([...Object.values(target.stack?.ports ?? {}), ...allowPorts]);
    if (!own.has(port) || denySet().has(port)) {
      const err = new Error(`isolation breach: port ${port} is not one of run ${target.runId}'s ports`);
      err.code = "E2E_ISOLATION";
      throw err;
    }
  }
  return u;
}

/**
 * A traced HTTP client for one actor.
 *
 * @param {object} target            from loadTarget()
 * @param {object} [o]
 * @param {string} [o.actor]         a label for the trace ("owner", "viewer", "anon")
 * @param {object} [o.guard]         { check(req) } — defaults to createGuard(target)
 * @param {Function|string|false} [o.evidence]  sink fn, a directory, or false
 * @param {CookieJar} [o.jar]        shared jar; default a fresh one
 * @param {object} [o.headers]       default headers for every request (e.g. Authorization)
 * @param {number[]} [o.allowPorts]  extra loopback ports (an OAuth receiver)
 * @param {number} [o.timeoutMs]     every request's timeout unless it gives its own; default DEFAULT_REQUEST_TIMEOUT_MS
 * @param {boolean} [o.cutoffError]  throw E2E_STACK_CUTOFF for Hosting's cut-off 504 instead of returning it; default false
 * @param {Function} [o.fetch]       for tests
 */
export function createHttp(target, o = {}) {
  const defaultTimeoutMs = clientTimeout(o.timeoutMs, "createHttp");
  const cutoffError = clientCutoff(o.cutoffError, "createHttp");
  const actor = o.actor ?? "anon";
  const jar = o.jar ?? new CookieJar();
  const sink = resolveSink(o.evidence, target);
  const fetchImpl = o.fetch ?? fetch;
  const defaults = { ...(o.headers ?? {}) };
  let guardPromise = o.guard ? Promise.resolve(o.guard) : null;
  const guard = () => (guardPromise ??= import("./guard.mjs").then((m) => m.createGuard(target)));
  let seq = 0;

  function resolveUrl(pathOrUrl, query) {
    const base = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${target.origin}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    const u = new URL(base);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * Send one request (following redirects hop by hop only when
   * `redirect: "follow"`). Resolves to a fully read response:
   *   { status, ok, headers, buffer, text, json, url, ms, redirects }
   * where `json` is the parsed body or undefined, `url` the last hop's, and
   * `redirects` the [{status, url}] hops that led there (empty unless followed).
   */
  async function request(method, pathOrUrl, r = {}) {
    method = method.toUpperCase();
    let url = resolveUrl(pathOrUrl, r.query);
    const headers = { "user-agent": agentName(target), "x-bikeshed-agent": agentName(target) };
    for (const [k, v] of Object.entries({ ...defaults, ...(r.headers ?? {}) })) {
      if (v === undefined || v === null) delete headers[k.toLowerCase()];
      else headers[k.toLowerCase()] = String(v);
    }
    let body = r.body;
    if (r.json !== undefined) {
      body = JSON.stringify(r.json);
      headers["content-type"] ??= "application/json";
    } else if (r.form !== undefined) {
      body = new URLSearchParams(r.form).toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    }
    const callerCookie = headers.cookie;
    const mode = r.redirect ?? "manual";
    const follow = mode === "follow";
    const maxRedirects = r.maxRedirects ?? 20;
    const redirects = [];
    const firstOrigin = new URL(url).origin;

    const timeoutMs = r.timeoutMs ?? defaultTimeoutMs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    const t0 = Date.now();
    let res;
    let buffer;
    let setCookies;
    let hopMs = 0; // the last hop's own time: Hosting cuts each request off on its own
    try {
      for (;;) {
        // Every hop: the isolation check, then the guard, then (only then) fetch.
        assertReachable(target, url, o.allowPorts);
        const sameOrigin = new URL(url).origin === firstOrigin;
        if (!r.noCookies) {
          const fromJar = jar.header(url);
          if (callerCookie !== undefined && sameOrigin) headers.cookie = callerCookie;
          else if (fromJar) headers.cookie = fromJar;
          else delete headers.cookie;
        }
        const n = ++seq;
        const started = Date.now();
        const base = {
          t: new Date(started).toISOString(),
          seq: n,
          pid: process.pid,
          actor,
          method,
          url: redactString(url),
          ...(redirects.length ? { hop: redirects.length, redirectedFrom: redactString(redirects.at(-1).url) } : {}),
          reqHeaders: redactHeaders(headers),
          reqBody: redactBody(body, headers["content-type"]),
        };

        const verdict = await (await guard()).check({ method, url, headers, body, actor });
        if (verdict && verdict.allow === false) {
          sink(traceLine({ ...base, guard: { refused: true, rule: verdict.rule, reason: verdict.reason } }));
          const err = new Error(`guard refused ${method} ${redactString(url)}: ${verdict.reason}`);
          err.code = "E2E_GUARD";
          err.rule = verdict.rule;
          throw err;
        }

        // In flight from here until its record is written, or it fails (pendingRequests).
        const flight = flightKey(o.evidence);
        const hop = { t: started, actor, method, url: base.url };
        trackHop(flight, hop);
        try {
          try {
            res = await fetchImpl(url, { method, headers, body, redirect: follow ? "manual" : mode, signal: ac.signal });
          } catch (e) {
            sink(traceLine({ ...base, ms: Date.now() - started, error: redactString(String(e?.cause?.message ?? e?.message ?? e)) }));
            throw e;
          }
          buffer = Buffer.from(await res.arrayBuffer());
          setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
          if (setCookies.length > 0 && !r.noCookies) jar.store(url, setCookies);
          const contentType = res.headers.get("content-type") ?? "";
          const resHeaders = redactHeaders(res.headers);
          if (setCookies.length > 0) resHeaders["set-cookie"] = redactHeaders({ "set-cookie": setCookies })["set-cookie"];
          hopMs = Date.now() - started;
          sink(traceLine({ ...base, status: res.status, ms: hopMs, resHeaders, resBody: redactBody(buffer, contentType) }));
        } finally {
          untrackHop(flight, hop);
        }

        const location = res.headers.get("location");
        if (!follow || ![301, 302, 303, 307, 308].includes(res.status) || !location) break;
        if (redirects.length >= maxRedirects) {
          const err = new Error(`${method} ${redactString(url)}: more than ${maxRedirects} redirects`);
          err.code = "E2E_REDIRECTS";
          throw err;
        }
        const next = new URL(location, url).toString();
        redirects.push({ status: res.status, url, location: next });
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          if (method !== "HEAD") method = "GET";
          body = undefined;
          delete headers["content-type"];
          delete headers["content-length"];
        }
        if (new URL(next).origin !== new URL(url).origin) delete headers.authorization;
        url = next;
      }
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - t0;
    const contentType = res.headers.get("content-type") ?? "";
    const text = buffer.toString("utf8");
    let json;
    if (/json/i.test(contentType) || (/^\s*[[{]/.test(text) && text.length < 5_000_000)) {
      try {
        json = JSON.parse(text);
      } catch {}
    }
    const out = { status: res.status, ok: res.ok, headers: res.headers, setCookies, buffer, text, json, url, ms, redirects: redirects.map(({ status, url: u }) => ({ status, url: u })) };
    if (cutoffError && res.status === 504 && hopMs >= HOSTING_CUTOFF_MS) throw cutoffErrorFor(method, url, hopMs, out);
    if (r.expect !== undefined) {
      const want = Array.isArray(r.expect) ? r.expect : [r.expect];
      if (!want.includes(res.status)) {
        const err = new Error(`${method} ${redactString(url)}: expected ${want.join("|")}, got ${res.status}: ${redactBody(buffer, contentType)?.slice(0, 300)}`);
        err.code = "E2E_STATUS";
        err.response = out;
        throw err;
      }
    }
    return out;
  }

  return {
    target,
    actor,
    jar,
    headers: defaults,
    /** The timeout of a request that gives none of its own. */
    timeoutMs: defaultTimeoutMs,
    /** Whether Hosting's cut-off 504 throws E2E_STACK_CUTOFF instead of being returned. */
    cutoffError,
    request,
    get: (p, r) => request("GET", p, r),
    head: (p, r) => request("HEAD", p, r),
    post: (p, r) => request("POST", p, r),
    put: (p, r) => request("PUT", p, r),
    delete: (p, r) => request("DELETE", p, r),
    /** POST a JSON body and return the response (json parsed). */
    postJson: (p, json, r = {}) => request("POST", p, { ...r, json }),
    /** A second client sharing this one's jar, guard, sink, default timeout and cutoffError, with other headers (or another `timeoutMs`, `cutoffError`). */
    with(extra = {}) {
      return createHttp(target, { ...o, actor: extra.actor ?? actor, jar, headers: { ...defaults, ...(extra.headers ?? {}) }, guard: o.guard, evidence: o.evidence, timeoutMs: extra.timeoutMs ?? defaultTimeoutMs, cutoffError: extra.cutoffError ?? cutoffError });
    },
  };
}
