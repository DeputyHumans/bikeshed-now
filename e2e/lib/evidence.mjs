// SPDX-License-Identifier: Apache-2.0
// Per-test evidence under e2e/.out/<runId>/evidence/<slug>/: steps, HTTP log, console, DOM, screenshots (SPEC §12).

/**
 * Evidence is BUFFERED and written only when it is needed — a failure, or
 * E2E_EVIDENCE=always — so a passing run leaves no directory per test. The
 * buffers are bounded. Everything written is redacted: cookies, bearer tokens,
 * ID tokens, passwords, link keys (`?k=`, `/content/~<k>/`) and the product's
 * token shapes (bsk_/bsa_/bsr_) — http.mjs's redactString first, then this
 * file's own rules — and then checked, line by line, against http.mjs's
 * LEAK_RE: a line in which a credential shape SURVIVED redaction is never
 * written. It is replaced by a marker naming what it was (fail-closed, as
 * http.mjs's trace is), and steps.md says how many were withheld.
 *
 * Screenshots cannot be redacted, and a Playwright trace (E2E_TRACE=1) stores
 * cookies, tokens and typed passwords as they are: BrowserPool refuses a trace
 * on any target but a local one, and captureUser writes one only there.
 *
 * The directory is <root>/evidence/<slug>[-k], where <root> is the
 * invocation's directory (E2E_INVOCATION_DIR, set by run.mjs) or the run's.
 *
 * Layout of one test's directory:
 *   steps.md                 ctx.step() lines, timestamped, and the rerun command
 *   error.txt                the failure
 *   http.jsonl               the Node HTTP client's records (via httpSink())
 *   console-<user>.jsonl     console, page errors, failed requests, toasts, breaches, SDK network tests
 *   requests-<user>.jsonl    the browser request log
 *   dom-<user>.html          URL, title, toolbars, alerts, the frame body (truncated)
 *   screenshot-<user>.png
 *   trace-<user>.zip         only with E2E_TRACE=1
 *   <name>.json              anything a spec attaches with ev.json()
 *
 * MEASUREMENTS are not evidence: they are kept whatever the outcome. A case
 * that measures a rate (how many rounds duplicated, at which offset, how long
 * a settle took) appends one JSON line per measurement with measure(ctx,
 * name, row) to <E2E_INVOCATION_DIR>/<name>.jsonl, beside the invocation's
 * load.jsonl and rss.jsonl. A PASS leaves no evidence directory unless
 * E2E_EVIDENCE=always, and the reporter keeps no diagnostic line but
 * `evidence=` and `outcome=`, so without this a passing case's numbers (a
 * serial control's, a fixed build's) would be lost. Rows are redacted like
 * evidence, and a line in which a credential shape survives is withheld.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { assertPath, OUT_DIR } from "./paths.mjs";
import { LEAK_RE, redactString as redactHttp } from "./http.mjs";

const MAX_HTTP = 2000;
const MAX_STEPS = 2000;

/**
 * The words paths.mjs assertPath refuses as a segment or beside a dash (the
 * trace of a template literal built from a missing value), as a slug can
 * spell them: "NaN" and "[object Object]" do not survive lower-casing and
 * the character filter.
 */
const MISSING_VALUE_WORDS = /null|undefined/g;

/**
 * A filesystem-safe slug of a test name: lower case, [a-z0-9-], at most 80
 * chars, and never holding "null" or "undefined". In a case name those are
 * words ("uid and email null", "non-null", "a null cursor"), not a missing
 * value, but assertPath cannot tell: each is broken before its last letter
 * ("nul-l", "undefine-d"), wherever it stands, and before the cut to 80, so
 * the cut cannot leave one whole. Every other name slugs as it always did.
 */
export function slugify(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/[^\w\s=.-]/g, " ")
    .replace(/[=.]/g, "-")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(MISSING_VALUE_WORDS, (w) => `${w.slice(0, -1)}-${w.slice(-1)}`)
    .slice(0, 80) || "test";
}

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key)$/i;
const SECRET_FIELD = /(password|passwd|idtoken|id_token|refresh_?token|access_?token|secret|apikey|api_key|code_verifier|sessioncookie)$/i;
const TOKEN_SHAPE = /\b(bs[kar]_[A-Za-z0-9_-]{6})[A-Za-z0-9_-]*/g;
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const RESEND_SHAPE = /\bre_[A-Za-z0-9_]{6,}/g;

/** Redact secrets from a string: http.mjs's rules (link keys, cookies, JWTs, tokens), then these. */
export function redactString(s) {
  return redactHttp(String(s)).replace(TOKEN_SHAPE, "$1…").replace(JWT_SHAPE, "<jwt>").replace(RESEND_SHAPE, "re_<redacted>");
}

/** The marker written instead of a line that still holds a credential shape. */
export const WITHHELD = "‹withheld: a credential shape survived redaction›";

/** A line as it may be written, or null when LEAK_RE still matches it (fail-closed). */
export function safeLine(line) {
  const s = String(line);
  return LEAK_RE.test(s) ? null : s;
}

/** Deep-redact a record before it is written: secret headers and fields, token shapes. */
export function redact(value, key = "") {
  if (value == null) return value;
  if (typeof value === "string") return SECRET_HEADER.test(key) || SECRET_FIELD.test(key) ? `<redacted:${value.length}>` : redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_HEADER.test(k) || SECRET_FIELD.test(k) ? (v == null ? v : `<redacted:${String(v).length}>`) : redact(v, k);
    return out;
  }
  return value;
}

// --- measurements ---------------------------------------------------------------

/** A measurement file's name: `<name>.jsonl` in the invocation directory. */
export const MEASURE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Names the harness's own files in an invocation directory hold, which a
 * measurement may not take: report.mjs reads `results.jsonl` and every
 * `results-*.jsonl` as the reporter's records, and load, rss and http lines
 * are written there by the memory gate, startRssSampler and http.mjs.
 */
export const RESERVED_MEASURE_NAMES = Object.freeze(["results", "load", "rss", "http", "invocation", "summary", "merged"]);

function checkMeasureName(name, who) {
  if (typeof name !== "string" || !MEASURE_NAME_RE.test(name)) throw new TypeError(`${who}: a measurement name matches ${MEASURE_NAME_RE} (the file is <name>.jsonl), got ${JSON.stringify(name)}`);
  if (RESERVED_MEASURE_NAMES.includes(name) || name.startsWith("results-")) throw new TypeError(`${who}: ${JSON.stringify(name)} is the harness's own file in an invocation directory; name the measurement after the spec`);
}

/**
 * The invocation's measurement file `name`: <E2E_INVOCATION_DIR>/<name>.jsonl,
 * or null outside a run (no E2E_INVOCATION_DIR). A directory outside
 * e2e/.out throws: nothing here is ever written anywhere else.
 */
export function measureFile(name, env = process.env) {
  checkMeasureName(name, "measureFile");
  const dir = env.E2E_INVOCATION_DIR;
  if (!dir) return null;
  assertPath(dir, "E2E_INVOCATION_DIR");
  const rel = relative(OUT_DIR, dir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`measureFile: E2E_INVOCATION_DIR ${dir} is not inside ${OUT_DIR}`);
  return join(dir, `${name}.jsonl`);
}

/**
 * Append one measurement row of the case `ctx` to the invocation's
 * `<name>.jsonl` (measureFile): the line is `{at, case, n, trial, ...row}`
 * (`at` an ISO time; `case`, `n`, `trial` the scenario ctx's, null when it
 * has none; a key of `row` wins), deep-redacted like evidence. A line in
 * which a credential shape survives redaction is replaced by `{at, case, n,
 * trial, withheld}` (WITHHELD), so the rows still count.
 *
 * Returns null outside a run (nothing written), else {file, line (the
 * object written), withheld: boolean} and, when the append failed (a full
 * disk), `error`: a measurement is never the case's outcome. A bad name, a
 * `row` that is not a plain object or does not serialise, and a ctx that is
 * not an object throw TypeError at once, in every environment, so a mistake
 * shows on the first local run.
 *
 *   measure(ctx, "c04-first-join", { scenario: "C4 press", offsetMs: 100, copies: 2 });
 */
export function measure(ctx, name, row, { env = process.env } = {}) {
  checkMeasureName(name, "measure");
  if (!ctx || typeof ctx !== "object") throw new TypeError(`measure: give the scenario's ctx, got ${ctx === null ? "null" : typeof ctx}`);
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError(`measure: a row is a plain object, got ${Array.isArray(row) ? "an array" : row === null ? "null" : typeof row}`);
  const head = { at: new Date().toISOString(), case: ctx.name ?? null, n: ctx.n ?? null, trial: ctx.trial ?? null };
  let text;
  try {
    text = JSON.stringify(redact({ ...head, ...row }));
  } catch (err) {
    throw new TypeError(`measure: the row does not serialise as JSON (${err.message})`);
  }
  const file = measureFile(name, env);
  if (!file) return null;
  let line = JSON.parse(text);
  let withheld = false;
  if (safeLine(text) === null) {
    line = { ...redact(head), withheld: WITHHELD };
    text = JSON.stringify(line);
    withheld = true;
  }
  try {
    appendFileSync(file, `${text}\n`);
  } catch (err) {
    return { file, line, withheld, error: err.message };
  }
  return { file, line, withheld };
}

export class Evidence {
  /**
   * @param runDir   e2e/.out/<runId>
   * @param slug     this test's directory name (made unique if it exists)
   * @param always   write even when the test passes
   */
  constructor({ runDir, slug, name = slug, always = process.env.E2E_EVIDENCE === "always" }) {
    this.runDir = assertPath(runDir, "runDir");
    if (!this.runDir.startsWith(OUT_DIR)) throw new Error(`evidence goes only under ${OUT_DIR}, not ${runDir}`);
    this.slug = slugify(slug);
    this.name = name;
    this.always = always;
    this.t0 = Date.now();
    this.steps = [];
    this.http = [];
    this.attachments = new Map();
    this.dir = null;
    this.rerun = null;
    this.withheld = 0;
  }

  /** `line`, or a marker in its place when a credential shape survived redaction. */
  checked(line, what = "line") {
    const ok = safeLine(line);
    if (ok !== null) return ok;
    this.withheld += 1;
    return what === "json" ? JSON.stringify({ withheld: WITHHELD }) : `${WITHHELD} (${what})`;
  }

  /**
   * The directory, created on first use and never shared: each candidate is
   * made with a plain mkdir, which fails with EEXIST when another test — in
   * this process or a concurrent one on the same run — already has it, and
   * then the next suffix is tried. (Checking existsSync first and then making
   * it with `recursive` let two processes both "create" the same one.) Each
   * candidate is checked by assertPath BEFORE it is made, so a refused name
   * throws and leaves no empty directory behind.
   */
  ensureDir() {
    if (this.dir) return this.dir;
    const base = join(this.runDir, "evidence");
    mkdirSync(base, { recursive: true });
    for (let i = 1; i < 10_000; i += 1) {
      const dir = assertPath(join(base, i === 1 ? this.slug : `${this.slug}-${i}`), "evidence dir");
      try {
        mkdirSync(dir);
      } catch (err) {
        if (err.code === "EEXIST") continue;
        throw err;
      }
      this.dir = dir;
      return this.dir;
    }
    throw new Error(`no free evidence directory for ${this.slug} under ${base}`);
  }

  step(text) {
    const line = this.checked(`- +${((Date.now() - this.t0) / 1000).toFixed(2)}s ${redactString(text)}`, "step");
    this.steps.push(line);
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS);
    if (this.dir) appendFileSync(join(this.dir, "steps.md"), `${line}\n`);
    return line;
  }

  /**
   * A sink for the Node HTTP client: call it with one record per request —
   * an object, or the JSON line http.mjs writes (already redacted there;
   * redacted again here, which is idempotent).
   */
  httpSink() {
    return (record) => {
      let rec = record;
      if (typeof rec === "string") {
        try {
          rec = JSON.parse(rec);
        } catch {
          rec = { line: rec };
        }
      }
      const r = this.checked(JSON.stringify(redact({ t: Date.now(), ...rec })), "json");
      this.http.push(r);
      if (this.http.length > MAX_HTTP) this.http.splice(0, this.http.length - MAX_HTTP);
      if (this.dir) appendFileSync(join(this.dir, "http.jsonl"), `${r}\n`);
    };
  }

  /** Attach a JSON value under <name>.json (buffered until flush, like the rest). */
  json(name, value) {
    this.attachments.set(`${name}.json`, this.checkedLines(JSON.stringify(redact(value), null, 2), `${name}.json`));
    if (this.dir) this.writeAttachments();
  }

  text(name, value) {
    this.attachments.set(name, this.checkedLines(redactString(value), name));
    if (this.dir) this.writeAttachments();
  }

  /** Every line of a text checked on its own, so one bad line does not cost the rest. */
  checkedLines(text, what) {
    return String(text).split("\n").map((l) => this.checked(l, what)).join("\n");
  }

  writeAttachments() {
    for (const [file, body] of this.attachments) writeFileSync(join(this.dir, file), `${body}\n`);
  }

  /** Write everything buffered; returns the directory. */
  flush({ error = null } = {}) {
    const dir = this.ensureDir();
    if (error) writeFileSync(join(dir, "error.txt"), `${this.checkedLines(`${redactString(error.stack || error.message || String(error))}\n${error.cause ? `\ncause: ${redactString(error.cause.stack || error.cause.message || error.cause)}\n` : ""}`, "error")}`);
    if (this.http.length) writeFileSync(join(dir, "http.jsonl"), this.http.join("\n") + "\n");
    this.writeAttachments();
    const head = [this.checked(`# ${redactString(this.name)}`, "title"), "", ...(this.rerun ? ["```", this.checked(this.rerun, "rerun"), "```", ""] : [])];
    const tail = this.withheld ? ["", `${this.withheld} line(s) withheld: a credential shape survived redaction (see e2e/lib/evidence.mjs)`] : [];
    writeFileSync(join(dir, "steps.md"), `${[...head, ...this.steps, ...tail].join("\n")}\n`);
    return dir;
  }

  /** Capture one browser user: console, requests, DOM excerpt, screenshot, trace. */
  async captureUser(user) {
    const dir = this.ensureDir();
    const n = slugify(user.name);
    const lines = [
      ...user.log.console.map((c) => ({ kind: "console", ...c })),
      ...user.log.errors.map((e) => ({ kind: "pageerror", ...e })),
      ...user.log.toasts.map((t) => ({ kind: "toast", ...t })),
      ...user.log.breaches.map((b) => ({ kind: "isolation-breach", ...b })),
      ...user.log.external.map((b) => ({ kind: "external-blocked", ...b })),
      ...(user.log.sdkProbes ?? []).map((b) => ({ kind: "sdk-probe", ...b })),
      ...user.log.websockets.map((w) => ({ kind: "websocket", ...w })),
      ...user.log.requests.filter((r) => r.failure).map((r) => ({ kind: "requestfailed", ...r })),
    ].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    writeFileSync(join(dir, `console-${n}.jsonl`), lines.map((l) => this.checked(JSON.stringify(redact(l)), "json")).join("\n") + "\n");
    writeFileSync(join(dir, `requests-${n}.jsonl`), user.log.requests.map((r) => this.checked(JSON.stringify(redact(r)), "json")).join("\n") + "\n");
    const out = { dir, user: user.name, files: [`console-${n}.jsonl`, `requests-${n}.jsonl`] };
    if (user.closed || !user.page || user.page.isClosed()) return out;
    try {
      const dom = await user.domExcerpt();
      writeFileSync(join(dir, `dom-${n}.html`), this.checkedLines(redactString(domHtml(user, dom)), `dom-${n}.html`));
      out.files.push(`dom-${n}.html`);
    } catch (err) {
      writeFileSync(join(dir, `dom-${n}.html`), `<!-- dom excerpt failed: ${this.checked(redactString(err.message), "error")} -->\n`);
    }
    try {
      await user.page.screenshot({ path: join(dir, `screenshot-${n}.png`), fullPage: false, timeout: 10_000 });
      out.files.push(`screenshot-${n}.png`);
    } catch {
      /* a crashed page has no screenshot; the rest is still useful */
    }
    // A trace holds cookies, tokens and typed passwords unredacted: local stacks only.
    if (user.pool?.trace && user.target?.kind === "local") {
      try {
        await user.context.tracing.stop({ path: join(dir, `trace-${n}.zip`) });
        out.files.push(`trace-${n}.zip`);
      } catch {
        /* tracing was not running */
      }
    }
    return out;
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function domHtml(user, dom) {
  const rows = (list) => (list ?? []).map((b) => `<li>${esc(b.label)}${b.disabled ? " <b>(disabled)</b>" : ""}${b.title ? ` — <i>${esc(b.title)}</i>` : ""}</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>${esc(user.name)} DOM excerpt</title>
<h1>${esc(user.name)}</h1>
<p>URL: <code>${esc(redactString(dom.url))}</code><br>Title: ${esc(dom.title)}<br>Share state: ${esc(dom.shareState)} · Save state: ${esc(dom.saveState)}</p>
<h2>Viewer toolbar</h2><ul>${rows(dom.viewerToolbar)}</ul>
<h2>Edit toolbar</h2><ul>${rows(dom.editToolbar)}</ul>
<h2>Alerts</h2><ul>${(dom.alerts ?? []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
<h2>Toasts on screen</h2><ul>${(dom.toasts ?? []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
<h2>Frame</h2><p>iframe: <code>${esc(JSON.stringify(dom.iframe))}</code></p>
<p>body attributes: <code>${esc(JSON.stringify(dom.frame?.bodyAttrs ?? null))}</code>${dom.frame?.truncated ? " (body truncated)" : ""}</p>
<pre>${esc(dom.frame?.body ?? dom.frame?.error ?? "(no frame)")}</pre>
`;
}
