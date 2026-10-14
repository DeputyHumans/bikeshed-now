// SPDX-License-Identifier: Apache-2.0
// A spec file outside e2e/specs, such as a scratch copy mutated for a negative control, that run.mjs --spec-file runs against an attached stack: where it may live and what it may import (SPEC §12).

/**
 *   node e2e/run.mjs run --attach <runId> --spec-file <absolute path> [--spec-file …]
 *                        [--grep <re>] [--n …] [--suite functional|concurrency] [--timeout <ms>]
 *
 * A spec-mutation negative control plants a bug in a COPY of a spec and
 * watches its case fail. The copy must stay out of the tracked tree, so it
 * cannot sit in e2e/specs/, and --spec only selects files there. --spec-file
 * runs such a copy the way a spec runs: the same environment (specEnv, plus
 * E2E_SUITE, E2E_INVOCATION_DIR and E2E_CASE_TIMEOUT_MS), the same node --test
 * argv and reporter, the tier lock and the file budget.
 *
 * Its invocation is a normal one (invocation.json, results-<tier>.jsonl,
 * results.json, summary.md, evidence/), but it lives under
 * <runDir>/scratch/<invId>/ (SCRATCH_INVOCATIONS_DIR) rather than
 * <runDir>/invocations/. A mutant fails on purpose. Kept out of
 * invocations/, it never reaches `report <runId>`, `report <runId> --merge`,
 * `classify --merge` or the merged view other agents read. Read it with
 * `report <that directory>`, which run.mjs prints. A case's id is
 * `<absolute file>::<name>`, because reporter.mjs keeps the absolute path of
 * a file outside the repo, so it never shares an id with the spec it was
 * copied from.
 *
 * specFilePlan({specFiles, spec, attach, suite}) checks the flags, and
 * checkSpecFile(file) checks each file, before run.mjs touches any stack.
 * Each one refuses:
 *   - no --attach: a scratch copy runs against a stack that is already up;
 *   - --spec beside it: --spec selects files in e2e/specs/;
 *   - a suite other than functional or concurrency (the file runs in that one tier);
 *   - a file named twice;
 *   - a path that is not absolute and resolved;
 *   - a file in e2e/specs/ (run it with --spec);
 *   - a file anywhere else in this checkout except under e2e/.out/, which is
 *     gitignored: a scratch copy stays out of the tracked tree;
 *   - a file that is missing, not a regular file, or not a .mjs;
 *   - a relative, absolute or file: import that resolves to no file (a copy
 *     that kept a spec's `../../lib/…`), or that resolves into an `e2e/lib/`
 *     other than this harness's. The copy must run the lib that run.mjs
 *     belongs to, so its scenario(), evidence and window closing are the
 *     ones being tested.
 *
 * absoluteLibImports(src) rewrites a spec's `../../lib/<module>` imports
 * (the form every spec in e2e/specs/<tier>/ uses) to this harness's lib by
 * absolute file URL, for a copy that will live elsewhere:
 *
 *   writeFileSync(copy, absoluteLibImports(readFileSync(spec, "utf8")).replace(from, to));
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { blankSource } from "./budget.mjs";
import { E2E_DIR, OUT_DIR, REPO_ROOT, SPECS_DIR, assertPath } from "./paths.mjs";

/** The tiers a --spec-file may run in: the suites that are exactly one tier of spec files. */
export const SPEC_FILE_SUITES = Object.freeze(["functional", "concurrency"]);

const LIB_DIR = join(E2E_DIR, "lib");
/** The prefix a spec in e2e/specs/<tier>/ imports the lib by. */
const SPEC_LIB_PREFIX = "../../lib/";

function refuse(message) {
  const err = new Error(message);
  err.code = "E2E_SPEC_FILE";
  return err;
}

/** Whether `p` is `root` or inside it. */
function inside(root, p) {
  const r = relative(root, p);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}

const lineAt = (src, i) => src.slice(0, i).split("\n").length;

/**
 * The module specifiers a source imports: static `import … from "x"`,
 * `import "x"`, `export … from "x"`, and `import("x")` with a quoted string.
 * Comments, other strings, template literals and regexes are skipped (read
 * through blankSource), and so is an import() of anything but one quoted
 * string. Returns [{specifier, index, line, dynamic}] in source order.
 */
export function specImports(src) {
  const text = String(src);
  const blank = blankSource(text);
  const out = [];
  const at = (q, dynamic) => {
    const quote = blank[q];
    const end = blank.indexOf(quote, q + 1);
    if (end < 0 || blank.slice(q + 1, end).includes("\n")) return;
    out.push({ specifier: text.slice(q + 1, end), index: q, line: lineAt(text, q), dynamic });
  };
  for (const m of blank.matchAll(/\b(?:from|import)[ \t]*(["'])/g)) at(m.index + m[0].length - 1, false);
  for (const m of blank.matchAll(/\bimport[ \t]*\([ \t\n]*(["'])/g)) at(m.index + m[0].length - 1, true);
  return out.sort((a, b) => a.index - b.index);
}

/** Where a relative, absolute or file: specifier points from `file` (a real path, as node resolves it), or null for a builtin or a package. */
function resolveSpecifier(file, specifier) {
  if (specifier.startsWith("file:")) {
    try {
      return fileURLToPath(new URL(specifier));
    } catch {
      return "";
    }
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) return null;
  const path = specifier.split(/[?#]/)[0];
  return resolve(dirname(file), path);
}

/** An `e2e/lib` directory pair anywhere in the path. */
const E2E_LIB_RE = new RegExp(`(?:^|\\${sep})e2e\\${sep}lib(?:\\${sep}|$)`);

/**
 * Check one --spec-file. See the header for what it refuses; each refusal
 * throws E2E_SPEC_FILE. Returns {file, real, imports: [{specifier, line,
 * dynamic, resolved}]} (resolved null for a builtin or a package).
 */
export function checkSpecFile(file) {
  if (typeof file !== "string" || file.length === 0) throw refuse(`--spec-file wants a path, got ${JSON.stringify(file)}`);
  if (!isAbsolute(file)) throw refuse(`--spec-file ${file}: not an absolute path`);
  try {
    assertPath(file, "--spec-file");
  } catch (err) {
    throw refuse(err.message);
  }
  const placed = (p) => {
    if (inside(SPECS_DIR, p)) throw refuse(`--spec-file ${file} is in e2e/specs/: run it with --spec ${relative(REPO_ROOT, p)}`);
    if (inside(REPO_ROOT, p) && !inside(OUT_DIR, p)) throw refuse(`--spec-file ${file} is in this checkout outside e2e/.out/: a scratch copy stays out of the tracked tree (put it in a scratch directory, or under e2e/.out/)`);
  };
  placed(file);
  if (!existsSync(file)) throw refuse(`--spec-file ${file}: no such file`);
  const real = realpathSync(file);
  placed(real);
  if (!statSync(real).isFile()) throw refuse(`--spec-file ${file}: not a regular file`);
  if (!file.endsWith(".mjs")) throw refuse(`--spec-file ${file}: not a .mjs file (a spec is an ES module, <name>.spec.mjs)`);
  const imports = [];
  for (const imp of specImports(readFileSync(real, "utf8"))) {
    const resolved = resolveSpecifier(real, imp.specifier);
    if (resolved === null) {
      imports.push({ ...imp, resolved: null });
      continue;
    }
    const where = `${file}:${imp.line} imports ${JSON.stringify(imp.specifier)}`;
    if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
      const hint = imp.specifier.startsWith(SPEC_LIB_PREFIX) ? `; a copy outside e2e/specs/<tier>/ imports this harness's lib by absolute URL (absoluteLibImports in lib/specfile.mjs): ${pathToFileURL(LIB_DIR).href}/…` : "";
      throw refuse(`${where}, which is no file${resolved ? ` (${resolved})` : ""}${hint}`);
    }
    const target = realpathSync(resolved);
    if (!inside(LIB_DIR, target) && E2E_LIB_RE.test(target)) throw refuse(`${where}, from an e2e/lib/ that is not this harness's (${target}); run.mjs runs ${LIB_DIR}`);
    imports.push({ ...imp, resolved: target });
  }
  return { file, real, imports: imports.map(({ index, ...rest }) => rest) };
}

/**
 * Check run.mjs's --spec-file flags. Returns null when no --spec-file was
 * given, else {tier, files}: each file checked, in the order given, as its
 * REAL path, which is how node --test (and so a case's id, and its rerun
 * line) names it. Every refusal throws E2E_SPEC_FILE.
 */
export function specFilePlan({ specFiles = [], spec = [], attach = null, suite = "functional" } = {}) {
  if (!Array.isArray(specFiles) || specFiles.length === 0) return null;
  if (!attach) throw refuse("--spec-file runs a scratch copy against a stack that is already up: add --attach <runId>");
  if (Array.isArray(spec) && spec.length > 0) throw refuse("--spec-file and --spec do not mix: --spec selects files in e2e/specs/, --spec-file names one outside it");
  if (!SPEC_FILE_SUITES.includes(suite)) throw refuse(`--spec-file runs in one tier: --suite ${SPEC_FILE_SUITES.join(" or ")}, not ${suite}`);
  const files = [];
  for (const f of specFiles) {
    const { real } = checkSpecFile(f);
    if (files.includes(real)) throw refuse(`--spec-file ${f} is named twice${real === f ? "" : ` (as ${real})`}`);
    files.push(real);
  }
  return { tier: suite, files };
}

/**
 * A spec's source with every import of `../../lib/<module>` (as a spec in
 * e2e/specs/<tier>/ writes it) made an absolute file URL into this
 * harness's lib, for a copy that will live outside e2e/specs/. Other
 * specifiers, and the same text in a comment or a string, are left alone.
 */
export function absoluteLibImports(src) {
  const text = String(src);
  const base = `${pathToFileURL(LIB_DIR).href}/`;
  let out = "";
  let from = 0;
  for (const imp of specImports(text)) {
    if (!imp.specifier.startsWith(SPEC_LIB_PREFIX)) continue;
    const start = imp.index + 1;
    out += text.slice(from, start) + base + imp.specifier.slice(SPEC_LIB_PREFIX.length);
    from = start + imp.specifier.length;
  }
  return out + text.slice(from);
}
