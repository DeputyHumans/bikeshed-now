// SPDX-License-Identifier: Apache-2.0
// Self-test: treeConstant reads a value a formatter wrapped onto the line after `=`, exactly as it would on one line, and refuses one that could go on past that line (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { treeConstant } from "../lib/target.mjs";
import { tempDir } from "./helpers/tmp.mjs";

/** A target whose stack tree holds exactly `files` ({rel: text}). */
function treeTarget(files) {
  const treeDir = tempDir("e2e-treewrap-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(treeDir, rel)), { recursive: true });
    writeFileSync(join(treeDir, rel), text);
  }
  return { kind: "local", runId: "2610111200-wrap", stack: { treeDir } };
}

test("treeConstant: a literal alone on the next line, indented and ended with its \";\", reads as it would on one line", () => {
  const t = treeTarget({
    "w.ts": [
      "export const FOOTER =",
      '  "© {year} · {title} · {version} · Confidential — for review only.";',
      "export const SINGLE =",
      "\t'tabbed';",
      "export const NUM: number =",
      "    60_000; // a trailing comment",
      "export const FLAG =",
      "  true;",
      "export const TPL =",
      "  `tick` as const;",
      "export const CRLF =\r\n  \"windows\";\r",
      "export const SPACE_AFTER_EQ =   ",
      '  "kept";',
      "export const ONE_LINE = \"still read as before\";",
    ].join("\n") + "\n",
  });
  const got = Object.fromEntries(["FOOTER", "SINGLE", "NUM", "FLAG", "TPL", "CRLF", "SPACE_AFTER_EQ", "ONE_LINE"].map((n) => [n, treeConstant(t, "w.ts", n)]));
  assert.deepEqual(got, {
    FOOTER: "© {year} · {title} · {version} · Confidential — for review only.",
    SINGLE: "tabbed",
    NUM: "60000",
    FLAG: "true",
    TPL: "tick",
    CRLF: "windows",
    SPACE_AFTER_EQ: "kept",
    ONE_LINE: "still read as before",
  });
  const p = treeTarget({ "p.ts": "export const BEAT_MS =\n  5 * 60 * 1000;\n" });
  assert.equal(treeConstant(p, "p.ts", "BEAT_MS", { product: true }), "300000", "{product: true} too");
});

test("treeConstant: this checkout's SUGGESTED_FOOTER, which app/src/export/labels.ts declares with its literal on the next line", () => {
  const rel = "app/src/export/labels.ts";
  const lines = readFileSync(join(REPO_ROOT, rel), "utf8").split("\n");
  const at = lines.indexOf("export const SUGGESTED_FOOTER =");
  assert.ok(at >= 0, `${rel} still wraps SUGGESTED_FOOTER (else this test reads nothing new)`);
  // An oracle independent of the implementation: the next line as JSON, minus its ";".
  const expected = JSON.parse(lines[at + 1].trim().replace(/;$/, ""));
  assert.equal(treeConstant({}, rel, "SUGGESTED_FOOTER"), expected);
  assert.equal(treeConstant({}, rel, "SUGGESTED_LABEL"), "CONFIDENTIAL", "a one-line neighbour is unchanged");
});

test("NEGATIVE: a wrapped value that could go on past its line, a blank, unindented or missing next line, or an expression throws", () => {
  const t = treeTarget({
    "w.ts": [
      "export const NO_SEMI =",
      "  5",
      "  * 60;",
      "export const CONCAT =",
      '  "a" +',
      '  "b";',
      "export const TERNARY =",
      "  cond",
      "    ? 1",
      "    : 2;",
      "export const COMMENT_SEMI =",
      '  "x" // looks ended;',
      '  + "y";',
      "export const BLANK =",
      "",
      '  "after a blank";',
      "export const UNINDENTED =",
      '"flush left";',
      "export const NEXT_IS_EXPR =",
      "  1 + 2;",
      "export const PRODUCT_NO_SEMI =",
      "  5 * 60",
      "  * 1000;",
      "export const AT_END =",
    ].join("\n"),
  });
  const fails = (n, re, o) => assert.throws(() => treeConstant(t, "w.ts", n, o), re, n);
  fails("NO_SEMI", /NO_SEMI in w\.ts is not a plain literal: its value on the next line does not end with ";"/);
  fails("CONCAT", /is not a plain literal: "a" \+$/);
  fails("TERNARY", /is not a plain literal: cond$/);
  fails("COMMENT_SEMI", /does not end with ";"/);
  fails("BLANK", /has nothing after "=", and the next line is not an indented value/);
  fails("UNINDENTED", /has nothing after "=", and the next line is not an indented value/);
  fails("NEXT_IS_EXPR", /is not a plain literal: 1 \+ 2;$/);
  fails("PRODUCT_NO_SEMI", /is not an integer product: its value on the next line does not end with ";"/, { product: true });
  fails("AT_END", /has nothing after "=", and the next line is not an indented value/);
});
