// SPDX-License-Identifier: Apache-2.0
// How long node --test may run one spec file: its declared budget, or the sum of its cases' own timeouts read from the source (SPEC §12).

/**
 * On Node 22, node --test applies --test-timeout to each FILE as a whole, and
 * the spec process inherits it as the timeout of every case that sets none.
 * Measured (22.17): a file of three 1.5 s cases, each with its own 10 s
 * timeout, is cancelled after the first at --test-timeout=3000. With one
 * fixed value per tier, a long file on a slow shared stack was cancelled while
 * every case in it was still inside its own budget (a13-sharing: ten cases,
 * 1,530 s of declared timeouts, cancelled at 600 s). Node 24 (24.21) cuts no
 * file: there the flag is only the default timeout of a case without one
 * (selftest/budget-run.test.mjs pins which this Node does). On either, the
 * per-case default below is what keeps a hung case from holding its file for
 * the whole budget.
 *
 * So run.mjs gives each tier's `node --test` the largest FILE BUDGET among the
 * files it runs, never less than the tier's default:
 *
 *   declared   a top-level, unindented `[export] const E2E_FILE_TIMEOUT_MS =
 *              <integer>;` in the spec (a product of integer literals and
 *              earlier top-level numeric constants is accepted);
 *   computed   otherwise, the sum over the file's scenario() calls of
 *              (the cases the call declares) × (its timeoutMs, or the case
 *              default), capped at the tier's ceiling (CEILING_FACTOR × the
 *              tier default).
 *
 * and sets E2E_CASE_TIMEOUT_MS to the tier default, which scenario() gives a
 * case with no timeoutMs of its own, so such a case keeps the bound it had.
 * An explicit `--timeout <ms>` replaces all of this, as before: the file and
 * every case without its own timeout get exactly that.
 *
 * The scan READS the source; it never runs it. It understands a scenario()
 * call whose options are an object literal: `timeoutMs` as an integer, a
 * top-level numeric const, or a product of those; `n` as an array literal;
 * `trials` as an integer, an object of integers or "plan" (PLAN_TRIALS);
 * with no `trials`, a scenario with `n` in a concurrency spec
 * (isConcurrencySpec: under specs/concurrency/, or any file run as the
 * concurrency tier, which run.mjs passes as `tier`) counts the plan's
 * trials, as scenario() runs it; run.mjs --trials k (E2E_TRIALS) counts k
 * per N for every scenario. Anything else (options
 * built by a wrapper, a call inside a loop or a function, a spread) counts as
 * one case at the case default and is listed in `unresolved`, so a spec whose
 * cases the scan cannot see declares E2E_FILE_TIMEOUT_MS instead. Comments,
 * strings, template literals and regular expressions are blanked first, so
 * `scenario(` in a comment is not a call.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { SPECS_DIR } from "./paths.mjs";

export const FILE_TIMEOUT_NAME = "E2E_FILE_TIMEOUT_MS";
export const CASE_TIMEOUT_ENV = "E2E_CASE_TIMEOUT_MS";
export const CEILING_FACTOR = 6;
/** The plan's trials per N for the concurrency scenarios: K = 10/5/3/3 for N = 2/5/10/20 (lib/test.mjs re-exports it). */
export const PLAN_TRIALS = Object.freeze({ 2: 10, 5: 5, 10: 3, 20: 3 });
const planTrials = (N) => PLAN_TRIALS[N] ?? 1;

/**
 * Is this spec file run as the concurrency tier's: under e2e/specs/concurrency/,
 * or in a run of that tier (E2E_SUITE "concurrency": a --spec-file scratch
 * spec run with --suite concurrency)? THE one predicate: scenario() decides a
 * scenario's trials by it (lib/test.mjs re-exports it) and fileBudget counts
 * them by it, so the budget is the cases that run.
 */
export function isConcurrencySpec(file, env = process.env) {
  if (env?.E2E_SUITE === "concurrency") return true;
  if (!file) return false;
  const rel = relative(SPECS_DIR, String(file));
  return !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] === "concurrency";
}

const IDENT = /[A-Za-z0-9_$]/;
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * The source with the CONTENTS of every comment, string, template literal
 * (not its `${…}` expressions, which stay code) and regular expression
 * replaced by spaces, newlines kept: same length, same line numbers, so an
 * index into it is an index into the source.
 */
export function blankSource(src) {
  const out = src.split("");
  const n = src.length;
  const wipe = (a, b) => {
    for (let k = Math.max(0, a); k < Math.min(n, b); k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const resumes = []; // brace depth at which each open `${` closes
  let depth = 0;
  let prev = ""; // the last significant token: "a" for a value, else the punctuator
  let word = "";

  /** From inside a template literal at `p`: wipe to its end or to the next `${`; returns the index to go on from. */
  const template = (p) => {
    let j = p;
    while (j < n) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === "`") {
        wipe(p, j);
        return j + 1;
      }
      if (src[j] === "$" && src[j + 1] === "{") {
        wipe(p, j + 2);
        resumes.push(depth);
        return j + 2;
      }
      j += 1;
    }
    wipe(p, n);
    return n;
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      wipe(i, end);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      wipe(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      wipe(i + 1, j);
      i = j + 1;
      prev = "a";
      word = "";
      continue;
    }
    if (c === "`") {
      i = template(i + 1);
      prev = "a";
      word = "";
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || (prev === "a" && REGEX_AFTER_WORD.has(word)))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j += 1;
      }
      wipe(i + 1, j);
      i = j + 1;
      while (i < n && IDENT.test(src[i])) i += 1; // flags
      prev = "a";
      word = "";
      continue;
    }
    if (c === "}" && resumes.length > 0 && resumes.at(-1) === depth) {
      resumes.pop();
      wipe(i, i + 1);
      i = template(i + 1);
      prev = "a";
      word = "";
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (IDENT.test(c)) {
      let j = i;
      while (j < n && IDENT.test(src[j])) j += 1;
      word = src.slice(i, j);
      prev = "a";
      i = j;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") depth -= 1;
    prev = c;
    word = "";
    i += 1;
  }
  return out.join("");
}

const OPEN = "([{";
const CLOSE = ")]}";

/** The index of the bracket that closes the one at `at` (in blanked text), or -1. */
function closing(blank, at) {
  let d = 0;
  for (let i = at; i < blank.length; i += 1) {
    if (OPEN.includes(blank[i])) d += 1;
    else if (CLOSE.includes(blank[i])) {
      d -= 1;
      if (d === 0) return i;
    }
  }
  return -1;
}

/** Split blanked text [a, b) at depth-0 commas: [[start, end]] ranges. */
function splitTop(blank, a, b) {
  const parts = [];
  let d = 0;
  let s = a;
  for (let i = a; i < b; i += 1) {
    const c = blank[i];
    if (OPEN.includes(c)) d += 1;
    else if (CLOSE.includes(c)) d -= 1;
    else if (c === "," && d === 0) {
      parts.push([s, i]);
      s = i + 1;
    }
  }
  parts.push([s, b]);
  return parts.filter(([x, y]) => blank.slice(x, y).trim() !== "");
}

const NUMBER = /^\d[\d_]*$/;

/** An integer from `text`: a literal (underscores allowed), a known constant, or a product of those; else null. */
export function evalInteger(text, consts = new Map()) {
  const t = String(text).trim();
  if (!t) return null;
  const factors = t.split("*").map((f) => f.trim());
  let product = 1;
  for (const f of factors) {
    let v = null;
    if (NUMBER.test(f) && !/__|_$/.test(f)) v = Number(f.replace(/_/g, ""));
    else if (/^[A-Za-z_$][\w$]*$/.test(f) && consts.has(f)) v = consts.get(f);
    if (!Number.isSafeInteger(v)) return null;
    product *= v;
  }
  return Number.isSafeInteger(product) ? product : null;
}

const lineOf = (src, i) => src.slice(0, i).split("\n").length;

/** Top-level (unindented) `[export] const NAME = <integer expression>;` declarations, in order. */
export function topLevelIntegers(src, blank = blankSource(src)) {
  const consts = new Map();
  const re = /^(?:export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*([^;\n]+);/gm;
  for (const m of blank.matchAll(re)) {
    const v = evalInteger(m[2], consts);
    if (v !== null) consts.set(m[1], v);
  }
  return consts;
}

/**
 * The spec's own budget: a top-level, unindented `[export] const
 * E2E_FILE_TIMEOUT_MS = <integer expression>;`, or null when it has none.
 * Throws E2E_FILE_TIMEOUT when it is declared twice, or is not a positive
 * integer the scan can read.
 */
export function declaredFileTimeout(src, blank = blankSource(src)) {
  const re = new RegExp(`^(?:export[ \\t]+)?const[ \\t]+${FILE_TIMEOUT_NAME}[ \\t]*=([^;\\n]*)(;?)`, "gm");
  const found = [...blank.matchAll(re)];
  if (found.length === 0) return null;
  const fail = (why) => {
    const err = new Error(`${FILE_TIMEOUT_NAME}: ${why}`);
    err.code = "E2E_FILE_TIMEOUT";
    return err;
  };
  if (found.length > 1) throw fail(`declared ${found.length} times (lines ${found.map((m) => lineOf(src, m.index)).join(", ")})`);
  const [m] = found;
  const at = m.index + m[0].indexOf("=") + 1;
  const text = src.slice(at, at + m[1].length);
  const v = m[2] === ";" ? evalInteger(m[1], topLevelIntegers(src, blank)) : null;
  if (!(v > 0)) throw fail(`line ${lineOf(src, m.index)}: "${text.trim()}" is not a positive integer (write milliseconds, e.g. 1_800_000, ending with ";")`);
  return v;
}

/** The first index in [a, b) of blanked text that is not whitespace, or b. */
function firstCode(blank, a, b) {
  let i = a;
  while (i < b && /\s/.test(blank[i])) i += 1;
  return i;
}

/** One object-literal part: {spread}, {key, shorthand}, or {key, at, end} with `at` the value's first character. */
function property(src, blank, [a, b]) {
  const s = firstCode(blank, a, b);
  if (blank.startsWith("...", s)) return { spread: true };
  const k = /^([A-Za-z_$][\w$]*|"[^"\n]*"|'[^'\n]*'|\d+)\s*(:?)/.exec(src.slice(s, b));
  if (!k) return { key: null };
  const key = k[1].replace(/^["']|["']$/g, "");
  if (!k[2]) return { key, shorthand: true };
  return { key, at: firstCode(blank, s + k[0].length, b), end: b };
}

/** An object literal's properties: Map key → {at, end}; spreads counted. */
function objectProperties(src, blank, open, close) {
  const props = new Map();
  let spreads = 0;
  for (const range of splitTop(blank, open + 1, close)) {
    const p = property(src, blank, range);
    if (p.spread) spreads += 1;
    else if (p.key && !p.shorthand) props.set(p.key, { at: p.at, end: p.end });
  }
  return { props, spreads };
}

/**
 * Every scenario() call in a spec's source and the cases it declares:
 * {calls: [{line, topLevel, cases, timeoutMs, resolved, why}], cases, sumMs,
 * unresolved: [{line, why}]}. `timeoutMs` is the call's own (null: none);
 * `sumMs` counts each case at its own timeout, or `caseDefaultMs`.
 */
export function scanScenarios(src, { caseDefaultMs, blank = blankSource(src), defaultTrials = null, trialsOverride = null } = {}) {
  if (!(caseDefaultMs > 0)) throw new Error("scanScenarios: caseDefaultMs is a positive number of milliseconds");
  const consts = topLevelIntegers(src, blank);
  const calls = [];
  for (const m of blank.matchAll(/(^|[^A-Za-z0-9_$.])scenario\s*\(/gm)) {
    const nameAt = m.index + m[1].length;
    const before = blank.slice(0, nameAt).trimEnd();
    if (/(^|[^A-Za-z0-9_$])function$/.test(before)) continue; // a definition, not a call
    const line = lineOf(src, nameAt);
    const lineStart = blank.lastIndexOf("\n", nameAt - 1) + 1;
    const topLevel = nameAt === lineStart;
    const open = m.index + m[0].length - 1;
    const close = closing(blank, open);
    const call = { line, topLevel, cases: 1, timeoutMs: null, resolved: true, why: null };
    const unresolved = (why) => {
      call.resolved = false;
      call.why = call.why ? `${call.why}; ${why}` : why;
    };
    if (!topLevel) unresolved("not at the top level: it may declare more cases than the scan sees");
    if (close < 0) {
      unresolved("its arguments do not close");
      calls.push(call);
      continue;
    }
    const args = splitTop(blank, open + 1, close);
    const second = args[1];
    if (!second) {
      calls.push(call);
      continue;
    }
    const s = firstCode(blank, second[0], second[1]);
    if (blank[s] !== "{") {
      // scenario(name, fn) — no options — or options the scan cannot read.
      if (!/^(async\b|function\b|\()/.test(src.slice(s, second[1]))) unresolved("its options are not an object literal");
      calls.push(call);
      continue;
    }
    const objClose = closing(blank, s);
    const { props, spreads } = objectProperties(src, blank, s, objClose);
    const valueOf = (key) => {
      const p = props.get(key);
      return p ? blank.slice(p.at, p.end).trim() : null;
    };
    const t = valueOf("timeoutMs");
    if (t !== null) {
      const v = evalInteger(t, consts);
      if (v === null) unresolved(`timeoutMs "${t}" is not an integer the scan can read`);
      else call.timeoutMs = v > 0 ? v : null;
    } else if (spreads > 0) {
      unresolved("a spread in its options may carry a timeoutMs");
    }
    let ns = [null];
    const nText = valueOf("n");
    if (nText !== null) {
      const nAt = props.get("n").at;
      if (blank[nAt] === "[") {
        const nClose = closing(blank, nAt);
        ns = splitTop(blank, nAt + 1, nClose).map(([a, b]) => evalInteger(blank.slice(a, b), consts));
      } else {
        const one = evalInteger(nText, consts);
        if (one === null) unresolved(`n "${nText}" is not an array literal`);
        else ns = [one];
      }
    }
    let trials = () => 1;
    const trText = valueOf("trials");
    if (trText === null && nText !== null && typeof defaultTrials === "function") trials = defaultTrials;
    if (trText !== null) {
      const flat = evalInteger(trText, consts);
      const raw = src.slice(props.get("trials").at, props.get("trials").end).trim();
      if (flat !== null) trials = () => flat;
      else if (raw === '"plan"' || raw === "'plan'") trials = planTrials;
      else {
        const trAt = props.get("trials").at;
        if (blank[trAt] === "{") {
          const per = objectProperties(src, blank, trAt, closing(blank, trAt));
          const map = new Map([...per.props].map(([k, r]) => [k, evalInteger(blank.slice(r.at, r.end), consts)]));
          if ([...map.values()].some((v) => v === null)) unresolved(`trials "${trText}" holds a value the scan cannot read`);
          trials = (N) => map.get(String(N)) ?? map.get("default") ?? 1;
        } else {
          unresolved(`trials "${trText}" is not an integer or an object literal`);
        }
      }
    }
    if (Number.isInteger(trialsOverride) && trialsOverride > 0) trials = () => trialsOverride;
    call.cases = ns.reduce((sum, N) => sum + Math.max(0, Number(trials(N)) || 0), 0);
    calls.push(call);
  }
  const cases = calls.reduce((s, c) => s + c.cases, 0);
  const sumMs = calls.reduce((s, c) => s + c.cases * (c.timeoutMs ?? caseDefaultMs), 0);
  return { calls, cases, sumMs, unresolved: calls.filter((c) => !c.resolved).map(({ line, why }) => ({ line, why })) };
}

/**
 * One spec file's budget: {file, declaredMs, cases, sumMs, computedMs,
 * budgetMs, unresolved}. `budgetMs` is the declared E2E_FILE_TIMEOUT_MS
 * when there is one, else the scan's sum capped at `ceilingMs`. `tier` is the
 * tier the file runs as (run.mjs's E2E_SUITE for it): it decides, with the
 * path, whether a scenario with `n` counts the plan's trials.
 */
export function fileBudget(file, { caseDefaultMs, ceilingMs = caseDefaultMs * CEILING_FACTOR, source, trialsOverride = null, tier = null } = {}) {
  const src = source ?? readFileSync(file, "utf8");
  const blank = blankSource(src);
  let declaredMs;
  try {
    declaredMs = declaredFileTimeout(src, blank);
  } catch (err) {
    err.message = `${file}: ${err.message}`;
    throw err;
  }
  // scenario() gives a concurrency spec's `n` scenarios the plan's trials by
  // default, deciding by the same predicate with the run's tier as E2E_SUITE.
  const concurrency = isConcurrencySpec(file, tier ? { E2E_SUITE: tier } : {});
  const scan = scanScenarios(src, { caseDefaultMs, blank, defaultTrials: concurrency ? planTrials : null, trialsOverride });
  const computedMs = Math.min(ceilingMs, scan.sumMs);
  return { file, declaredMs, cases: scan.cases, sumMs: scan.sumMs, computedMs, budgetMs: declaredMs ?? computedMs, unresolved: scan.unresolved };
}

/**
 * What one tier's `node --test` gets: {fileTimeoutMs, caseTimeoutMs,
 * explicit, driver, files}. `tier` is the tier the files run as (see
 * fileBudget). `explicitMs` (run.mjs --timeout) is both, and no
 * file is read. Otherwise fileTimeoutMs is the largest file budget, never
 * below `defaultMs`; `driver` is the file that set it (null when the default
 * did); caseTimeoutMs is `defaultMs`.
 */
export function tierTimeouts(files, { defaultMs, explicitMs = null, ceilingMs = defaultMs * CEILING_FACTOR, read, trialsOverride = null, tier = null } = {}) {
  if (!(defaultMs > 0)) throw new Error("tierTimeouts: defaultMs is a positive number of milliseconds");
  if (explicitMs !== null && explicitMs !== undefined) {
    if (!Number.isSafeInteger(explicitMs) || explicitMs <= 0) throw new Error(`tierTimeouts: an explicit timeout is a positive integer of milliseconds, got ${explicitMs}`);
    return { fileTimeoutMs: explicitMs, caseTimeoutMs: explicitMs, explicit: true, driver: null, files: [] };
  }
  const budgets = files.map((f) => fileBudget(f, { caseDefaultMs: defaultMs, ceilingMs, source: read ? read(f) : undefined, trialsOverride, tier }));
  let fileTimeoutMs = defaultMs;
  let driver = null;
  for (const b of budgets) {
    if (b.budgetMs > fileTimeoutMs) {
      fileTimeoutMs = b.budgetMs;
      driver = b.file;
    }
  }
  return { fileTimeoutMs, caseTimeoutMs: defaultMs, explicit: false, driver, files: budgets };
}

/** The case default scenario() applies: E2E_CASE_TIMEOUT_MS when it is a positive integer, else null. */
export function caseTimeoutDefault(env = process.env) {
  const raw = env[CASE_TIMEOUT_ENV];
  if (raw === undefined || raw === null || raw === "") return null;
  const v = Number(raw);
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}
