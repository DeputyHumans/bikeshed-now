// SPDX-License-Identifier: Apache-2.0
// Assertion helpers for e2e specs: eventually(), settleStill() (records that hold still), status and header matrices, header equality minus Date, line diffs for byte oracles (SPEC §12).

/**
 * Everything here fails LOUDLY with what it saw: a polling assertion that
 * times out says how many samples it took and what the last one was, and a
 * header matrix reports every mismatching cell at once rather than the first,
 * because a cache-header defect is usually a pattern across rows.
 */

import { isDeepStrictEqual } from "node:util";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `fn` until it succeeds: it resolves without throwing and does not
 * return `false`. With `stableSamples` > 1, that many CONSECUTIVE successes
 * must return deep-equal values (a converged state, not a passing glance).
 * Resolves the last value; on timeout throws E2E_EVENTUALLY_TIMEOUT with the
 * last error or value.
 */
export async function eventually(fn, { timeout = 10_000, interval = 100, stableSamples = 1, message = "condition" } = {}) {
  const t0 = Date.now();
  let samples = 0;
  let streak = 0;
  let prev;
  let lastErr = null;
  let lastValue;
  for (;;) {
    samples += 1;
    let ok = false;
    try {
      lastValue = await fn();
      ok = lastValue !== false;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    if (ok) {
      streak = streak > 0 && isDeepStrictEqual(lastValue, prev) ? streak + 1 : 1;
      prev = lastValue;
      if (streak >= stableSamples) return lastValue;
    } else {
      streak = 0;
    }
    if (Date.now() - t0 >= timeout) break;
    await sleep(interval);
  }
  const why = lastErr ? `last error: ${lastErr.message}` : `last value: ${JSON.stringify(lastValue)?.slice(0, 500)}${stableSamples > 1 ? ` (stable streak ${streak}/${stableSamples})` : ""}`;
  const err = new Error(`eventually: ${message} not met within ${timeout} ms after ${samples} samples; ${why}`);
  err.code = "E2E_EVENTUALLY_TIMEOUT";
  err.cause = lastErr ?? undefined;
  err.samples = samples;
  throw err;
}

/** The plan's server settle: a value that holds still this long has stopped moving ("server and mail: counts stable for 10 s"). */
export const SETTLE_QUIET_MS = 10_000;
/** settleStill's default bound on the whole wait (the concurrency specs' hand-rolled settles all used 120 s). */
export const SETTLE_DEADLINE_MS = 120_000;
/** settleStill's default pause between two reads. */
export const SETTLE_INTERVAL_MS = 1_000;

/**
 * The plan's server settle: call `read()` every `intervalMs` until what it
 * returns has not changed for `quietMs`, and resolve that value (the last
 * read). "Changed" is `key(value)` differing from the previous read's
 * (JSON.stringify by default; pass a projection to compare part of a value
 * while resolving all of it). Every change restarts the quiet window, so a
 * value that comes BACK to an earlier one still has to hold for `quietMs`
 * from its return.
 *
 * Running out of `deadlineMs` throws E2E_SETTLE_TIMEOUT, worded as a wait:
 * "<what>: did not hold still for <quietMs> ms within <deadlineMs> ms
 * (…)", so a case's stack judges (pageStall, functionKill, under
 * inconclusiveOnPageStall / inconclusiveOnFunctionKill) can excuse it when
 * the stack stalled, and it FAILS on a stack that kept answering. The error
 * carries `value` (the last read), `reads`, `changes`, `waitedMs`, `stillMs`
 * (how long the last value had held), `quietMs`, `deadlineMs` and `what`.
 *
 * A read that throws is thrown at once, unchanged (an Admin SDK deadline, a
 * Hosting cut-off: the stack-did-not-answer shapes stay recognisable); it is
 * never retried. The deadline is checked between reads, so one read that
 * hangs holds it up. `step(line)` (e.g. ctx.step) hears one line when it
 * settles. TypeError, before anything is read, for a `read` that is not a
 * function, a quietMs that is not a positive number, a deadlineMs under
 * quietMs, an intervalMs that is not a positive number, an empty `what`, a
 * `key` or `step` that is not a function; and at the first read for a
 * `key(value)` that is neither a string nor undefined (an object would
 * compare equal to every other one as "[object Object]").
 *
 * @template T
 * @param {() => T | Promise<T>} read
 * @param {{quietMs?: number, deadlineMs?: number, intervalMs?: number, what?: string, key?: (value: T) => string | undefined, step?: ((line: string) => void) | null}} [o]
 * @returns {Promise<T>}
 */
export async function settleStill(read, { quietMs = SETTLE_QUIET_MS, deadlineMs = SETTLE_DEADLINE_MS, intervalMs = SETTLE_INTERVAL_MS, what = "the records", key = JSON.stringify, step = null } = {}) {
  if (typeof read !== "function") throw new TypeError(`settleStill: read is a function that returns the value to hold still, got ${typeof read}`);
  if (!Number.isFinite(quietMs) || quietMs <= 0) throw new TypeError(`settleStill: quietMs is a positive number of ms, got ${JSON.stringify(quietMs) ?? String(quietMs)}`);
  if (!Number.isFinite(deadlineMs) || deadlineMs < quietMs) throw new TypeError(`settleStill: deadlineMs is a number of ms, at least quietMs (${quietMs}), got ${JSON.stringify(deadlineMs) ?? String(deadlineMs)}`);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError(`settleStill: intervalMs is a positive number of ms, got ${JSON.stringify(intervalMs) ?? String(intervalMs)}`);
  if (typeof what !== "string" || !what.trim()) throw new TypeError(`settleStill: what names what is settling, a non-empty string, got ${JSON.stringify(what) ?? String(what)}`);
  if (typeof key !== "function") throw new TypeError(`settleStill: key is a function (value) => string, got ${typeof key}`);
  if (step !== null && typeof step !== "function") throw new TypeError(`settleStill: step is a function (line) => void or null, got ${typeof step}`);
  const t0 = Date.now();
  let reads = 0;
  let changes = 0;
  let lastKey;
  let since = t0;
  for (;;) {
    const value = await read();
    const k = key(value);
    if (k !== undefined && typeof k !== "string") throw new TypeError(`settleStill: key(value) returned ${typeof k}; it must return a string (or undefined), or every value would compare equal`);
    reads += 1;
    const now = Date.now();
    if (reads === 1 || k !== lastKey) {
      if (reads > 1) changes += 1;
      lastKey = k;
      since = now;
    }
    if (now - since >= quietMs) {
      if (step) step(`${what}: held still for ${Math.round(quietMs / 100) / 10} s (settled ${Math.round((now - t0) / 100) / 10} s after asking; ${reads} read(s), ${changes} change(s))`);
      return value;
    }
    if (now - t0 >= deadlineMs) {
      const stillMs = now - since;
      const last = String(lastKey);
      const err = new Error(`${what}: did not hold still for ${quietMs} ms within ${deadlineMs} ms (${reads} read(s), ${changes} change(s); the last value had held for ${stillMs} ms): ${last.slice(0, 500)}${last.length > 500 ? "…" : ""}`);
      err.code = "E2E_SETTLE_TIMEOUT";
      throw Object.assign(err, { value, reads, changes, waitedMs: now - t0, stillMs, quietMs, deadlineMs, what });
    }
    await sleep(Math.max(1, Math.min(intervalMs, t0 + deadlineMs - now)));
  }
}

/** Headers from a fetch Response, a Playwright response, a Headers object or a plain object → lowercase map. */
export function headerMap(source) {
  if (!source) return {};
  const h = source.headers ?? source;
  if (typeof h === "function") return lower(h.call(source)); // Playwright Response#headers()
  if (typeof h.entries === "function" && typeof h.get === "function") return lower(Object.fromEntries(h.entries()));
  return lower(h);
}

function lower(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
}

/** Status of a fetch Response, a Playwright response, or a plain {status}. */
export function statusOf(res) {
  return typeof res.status === "function" ? res.status() : res.status;
}

/**
 * Throw unless the response's status is `expected` (a number or a list).
 * `body` (if given) is shown, truncated, so a 400 says why.
 */
export function expectStatus(res, expected, { label = "", body = undefined } = {}) {
  const got = statusOf(res);
  const want = Array.isArray(expected) ? expected : [expected];
  if (!want.includes(got)) {
    const url = typeof res.url === "function" ? res.url() : res.url;
    const err = new Error(`${label ? `${label}: ` : ""}expected status ${want.join(" or ")}, got ${got}${url ? ` from ${url}` : ""}${body !== undefined ? ` — body: ${String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 400)}` : ""}`);
    err.code = "E2E_STATUS";
    err.status = got;
    throw err;
  }
  return got;
}

/** Cache-Control → {private, public, noStore, noCache, immutable, maxAge, sMaxAge, raw}. */
export function cacheControl(source) {
  const raw = typeof source === "string" ? source : headerMap(source)["cache-control"] ?? "";
  const d = {};
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const [k, v] = part.split("=");
    d[k] = v === undefined ? true : v.replace(/^"|"$/g, "");
  }
  return {
    raw,
    private: d.private === true,
    public: d.public === true,
    noStore: d["no-store"] === true,
    noCache: d["no-cache"] === true,
    immutable: d.immutable === true,
    maxAge: d["max-age"] !== undefined ? Number(d["max-age"]) : null,
    sMaxAge: d["s-maxage"] !== undefined ? Number(d["s-maxage"]) : null,
  };
}

/**
 * Check one response's headers against expectations: each value is a string
 * (exact, case-insensitive name), a RegExp, `null` (must be ABSENT), `true`
 * (must be present) or a function (value) => boolean. Returns mismatches.
 */
export function checkHeaders(source, expect) {
  const h = headerMap(source);
  const out = [];
  for (const [rawName, want] of Object.entries(expect)) {
    const name = rawName.toLowerCase();
    const got = h[name];
    let ok;
    if (want === null) ok = got === undefined;
    else if (want === true) ok = got !== undefined;
    else if (want instanceof RegExp) ok = got !== undefined && want.test(got);
    else if (typeof want === "function") ok = Boolean(want(got));
    else ok = got === String(want);
    if (!ok) out.push({ header: name, want: want === null ? "(absent)" : want instanceof RegExp ? String(want) : typeof want === "function" ? want.name || "predicate" : String(want), got: got ?? "(absent)" });
  }
  return out;
}

/**
 * A header matrix: rows of {label, res, status?, expect}. Collects EVERY
 * mismatching cell, then throws one error listing them all (E2E_HEADER_MATRIX).
 * Returns the table of checked rows when everything matched.
 */
export function assertHeaderMatrix(rows) {
  const bad = [];
  for (const row of rows) {
    if (row.status !== undefined) {
      const got = statusOf(row.res);
      const want = Array.isArray(row.status) ? row.status : [row.status];
      if (!want.includes(got)) bad.push({ label: row.label, header: ":status", want: want.join("|"), got });
    }
    for (const m of checkHeaders(row.res, row.expect ?? {})) bad.push({ label: row.label, ...m });
  }
  if (bad.length > 0) {
    const lines = bad.map((b) => `  ${b.label} | ${b.header}: want ${b.want}, got ${b.got}`);
    const err = new Error(`header matrix: ${bad.length} mismatching cell(s)\n${lines.join("\n")}`);
    err.code = "E2E_HEADER_MATRIX";
    err.cells = bad;
    throw err;
  }
  return rows.map((r) => r.label);
}

/** Headers that legitimately differ between two otherwise identical responses. */
export const VOLATILE_HEADERS = Object.freeze(["date"]);

/**
 * Compare two responses' headers ignoring Date (and `ignore`). Returns
 * {equal, diff: [{header, a, b}]} — a header present on one side only shows
 * the other as undefined.
 */
export function sameHeadersExceptDate(a, b, { ignore = [] } = {}) {
  const skip = new Set([...VOLATILE_HEADERS, ...ignore.map((x) => x.toLowerCase())]);
  const ha = headerMap(a);
  const hb = headerMap(b);
  const diff = [];
  for (const name of [...new Set([...Object.keys(ha), ...Object.keys(hb)])].sort()) {
    if (skip.has(name)) continue;
    if (ha[name] !== hb[name]) diff.push({ header: name, a: ha[name], b: hb[name] });
  }
  return { equal: diff.length === 0, diff };
}

/** Throwing form of sameHeadersExceptDate. */
export function assertSameHeadersExceptDate(a, b, opts = {}) {
  const r = sameHeadersExceptDate(a, b, opts);
  if (!r.equal) {
    const err = new Error(`headers differ (Date ignored): ${r.diff.map((d) => `${d.header}: ${JSON.stringify(d.a)} ≠ ${JSON.stringify(d.b)}`).join("; ")}`);
    err.code = "E2E_HEADERS_DIFFER";
    err.diff = r.diff;
    throw err;
  }
  return r;
}

/** Byte-for-byte body equality, with the first differing offset when not. */
export function sameBytes(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (x.equals(y)) return { equal: true };
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  return { equal: false, at: i, lengths: [x.length, y.length] };
}

/** Above this many cells (differing lines of one text times the other's), lineHunks reports the differing middle as one hunk. */
export const LINE_HUNKS_MAX_CELLS = 4_000_000;

/** A string, or a Buffer read as UTF-8; anything else throws. */
function asText(v, name) {
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  throw new TypeError(`lineHunks: ${name} is a string or a Buffer, got ${v === null ? "null" : typeof v}`);
}

/**
 * A line diff of two texts, for a byte oracle that would otherwise fail with
 * both whole documents: `assert.deepEqual(lineHunks(want, got), [])` fails
 * with only the differences.
 *
 * Returns hunks `{line, expected: [...], got: [...]}`, in order: `line` is the
 * 1-based line of `expected` where the hunk begins (for a pure insertion, the
 * line it goes before), `expected` the lines only `expected` has there and
 * `got` the lines only `actual` has. `[]` exactly when the texts are equal.
 *
 * The common head and tail are set aside, then the middle is diffed by
 * longest common subsequence, so a moved or inserted line reads as one
 * removal and one addition rather than as every line after it. A middle
 * larger than LINE_HUNKS_MAX_CELLS (lines × lines) comes back as one hunk.
 * Lines are split on "\n" only, so a "\r" stays on its line, where a CRLF
 * difference shows. Each text is a string or a Buffer (read as UTF-8).
 */
export function lineHunks(expected, actual) {
  const a = asText(expected, "expected").split("\n");
  const b = asText(actual, "actual").split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q += 1;
  const A = a.slice(p, a.length - q);
  const B = b.slice(p, b.length - q);
  if (A.length === 0 && B.length === 0) return [];
  if (A.length === 0 || B.length === 0 || (A.length + 1) * (B.length + 1) > LINE_HUNKS_MAX_CELLS) {
    return [{ line: p + 1, expected: A, got: B }];
  }
  // L[i][j]: the longest common subsequence of A[i..] and B[j..].
  const L = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i -= 1) {
    for (let j = B.length - 1; j >= 0; j -= 1) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      if (cur) hunks.push(cur);
      cur = null;
      i += 1;
      j += 1;
      continue;
    }
    cur ??= { line: p + i + 1, expected: [], got: [] };
    if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) cur.got.push(B[j++]);
    else cur.expected.push(A[i++]);
  }
  if (cur) hunks.push(cur);
  return hunks;
}
