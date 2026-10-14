// SPDX-License-Identifier: Apache-2.0
// Self-test: treeConstant reads a literal, or with {product: true} an integer product, from the tree the target runs, and refuses anything it cannot read exactly (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { treeConstant } from "../lib/target.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const THUMBS = "functions/src/lib/thumbs.ts";

/** A target whose stack tree holds exactly `files` ({rel: text}). */
function treeTarget(files) {
  const treeDir = tempDir("e2e-treeconst-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(treeDir, rel)), { recursive: true });
    writeFileSync(join(treeDir, rel), text);
  }
  return { kind: "local", runId: "2610101200-tree", stack: { treeDir } };
}

test("treeConstant: the stack's tree, not this checkout, when the target has one", () => {
  const checkout = /export const THUMB_REVISION = (\d+);/.exec(readFileSync(join(REPO_ROOT, THUMBS), "utf8"))[1];
  const planted = String(Number(checkout) + 40);
  const t = treeTarget({ [THUMBS]: `// x\nexport const THUMB_REVISION = ${planted};\n` });
  assert.equal(treeConstant(t, THUMBS, "THUMB_REVISION"), planted, "the tree's value, which differs from the checkout's");
  assert.equal(treeConstant({ kind: "prod", runId: "x" }, THUMBS, "THUMB_REVISION"), checkout, "no tree: this checkout");
  assert.equal(treeConstant({}, THUMBS, "THUMB_REVISION"), checkout);
});

test("NEGATIVE: a tree that lacks the file throws, never falls back to this checkout", () => {
  const t = treeTarget({ "functions/src/lib/other.ts": "export const THUMB_REVISION = 1;\n" });
  assert.throws(() => treeConstant(t, THUMBS, "THUMB_REVISION"), /is not in the stack's tree/);
  const gone = { kind: "local", stack: { treeDir: join(tempDir("e2e-treeconst-"), "removed") } };
  assert.throws(() => treeConstant(gone, THUMBS, "THUMB_REVISION"), /is not in the stack's tree/);
});

test("treeConstant: the literal forms a constant takes", () => {
  const t = treeTarget({
    "c.ts": [
      "export const A = 3;",
      "export const B = 60_000;",
      "export const C = 0xff;",
      "export const D = -2.5e3;",
      'export const E = "us-central1";',
      "const F = 'single';",
      "export const G = `tick`;",
      "export const H = true;",
      "export const I: number = 7; // a trailing comment",
      'export const J = "http://x.invalid/a" as const;',
      "export const K = 9 /* block */",
      "export const L_OLD = 1;",
      "export const L = 2;",
      "export const $M = 4;",
    ].join("\n") + "\n",
  });
  const got = Object.fromEntries(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "$M"].map((n) => [n, treeConstant(t, "c.ts", n)]));
  assert.deepEqual(got, { A: "3", B: "60000", C: "255", D: "-2500", E: "us-central1", F: "single", G: "tick", H: "true", I: "7", J: "http://x.invalid/a", K: "9", L: "2", $M: "4" });
});

test("NEGATIVE: anything but one plain top-level literal throws", () => {
  const t = treeTarget({
    "c.ts": [
      "export const SUM = 1 + 2;",
      "export const SUB = `a${b}`;",
      'export const ESC = "a\\"b";',
      "export const OBJ = { a: 1 };",
      "export const TWICE = 1;",
      "export const TWICE = 2;",
      "  export const INDENTED = 5;",
      "export const SPANS =",
      "  5",
      "  * 60;",
      "// export const COMMENTED = 6;",
      "export const PAIR = 1, OTHER = 2;",
      "export const ONLY_LONGER = 1;",
    ].join("\n") + "\n",
  });
  const fails = (n, re) => assert.throws(() => treeConstant(t, "c.ts", n), re, n);
  fails("SUM", /not a plain literal/);
  fails("SUB", /not a plain literal/);
  fails("ESC", /not a plain literal/);
  fails("OBJ", /not a plain literal/);
  fails("TWICE", /declared 2 times/);
  fails("INDENTED", /no top-level const/);
  fails("SPANS", /not a plain literal/);
  fails("COMMENTED", /no top-level const/);
  fails("PAIR", /not a plain literal/);
  fails("ONLY", /no top-level const/);
  assert.throws(() => treeConstant(t, "c.ts", "A.B"), /not an identifier/);
  assert.throws(() => treeConstant(t, "c.ts", "(.*)"), /not an identifier/);
  assert.throws(() => treeConstant(t, "../c.ts", "SUM"), /escapes/);
  assert.throws(() => treeConstant(t, "/etc/hosts", "SUM"), /relative/);
  assert.throws(() => treeConstant(t, "missing.ts", "SUM"), /is not in the stack's tree/);
});

// --- {product: true}: an integer product such as 5 * 60 * 1000 -------------------

const CONFIG = "functions/src/config.ts";

test("treeConstant {product: true}: integer literals joined by * come back as one decimal string, from the stack's tree", () => {
  const t = treeTarget({
    "p.ts": [
      "export const BEAT = 5 * 60 * 1000;",
      "export const SESSION = 8 * 60 * 60 * 1000;",
      "export const SEP = 5 * 60_000;",
      "export const TIGHT = 25*1024*1024;",
      "export const ONE = 300_000;",
      "export const ZERO = 0 * 7;",
      "export const TYPED: number = 2 * 3; // 2 * 3 in a comment",
      "const BLOCK = 4 * 5 /* x * y */",
      "export const CENTURY = 100 * 365 * 24 * 60 * 60 * 1000;",
      "export const EDGE = 9007199254740991 * 1;",
    ].join("\n") + "\n",
  });
  const got = Object.fromEntries(["BEAT", "SESSION", "SEP", "TIGHT", "ONE", "ZERO", "TYPED", "BLOCK", "CENTURY", "EDGE"].map((n) => [n, treeConstant(t, "p.ts", n, { product: true })]));
  assert.deepEqual(got, { BEAT: "300000", SESSION: "28800000", SEP: "300000", TIGHT: "26214400", ONE: "300000", ZERO: "0", TYPED: "6", BLOCK: "20", CENTURY: "3153600000000", EDGE: "9007199254740991" });
  // The stack's tree wins over this checkout here too.
  const planted = treeTarget({ [CONFIG]: "export const MAX_BEAT_MS = 7 * 60 * 1000;\n" });
  assert.equal(treeConstant(planted, CONFIG, "MAX_BEAT_MS", { product: true }), "420000");
});

test("treeConstant {product: true}: this checkout's server clamps read as the source states them", () => {
  // An oracle independent of the implementation: the factors as the file spells them.
  const src = readFileSync(join(REPO_ROOT, CONFIG), "utf8");
  for (const name of ["MAX_BEAT_MS", "MAX_SESSION_MS"]) {
    const line = new RegExp(`^export const ${name} = ([0-9_ *]+);`, "m").exec(src);
    assert.ok(line, `${CONFIG} declares ${name} as an integer product`);
    const expected = line[1].split("*").reduce((a, f) => a * Number(f.trim().replace(/_/g, "")), 1);
    assert.equal(treeConstant({}, CONFIG, name, { product: true }), String(expected), name);
  }
});

test("NEGATIVE: {product: true} refuses anything but decimal integer literals joined by *, and a product past 2^53", () => {
  const t = treeTarget({
    "p.ts": [
      "export const NAMED = 5 * MINUTE;",
      "export const PLUS = 5 + 60;",
      "export const MIXED = 5 * 60 + 1;",
      "export const NEG = -5 * 60;",
      "export const HEX = 0x10 * 2;",
      "export const FRACTION = 5 * 60.5;",
      "export const EXP = 1e3 * 2;",
      "export const PARENS = (5 * 60) * 1000;",
      "export const POWER = 5 ** 2;",
      "export const DANGLING = 5 *",
      "  60;",
      "export const DOUBLE_SEP = 1__0 * 2;",
      "export const TRAILING_SEP = 10_ * 2;",
      "export const LEADING_ZERO = 05 * 2;",
      'export const QUOTED = "5 * 60";',
      "export const BOOL = true;",
      "export const DIVIDED = 60 / 2;",
      "export const OVER = 4503599627370496 * 4;",
      "export const TWICE = 2 * 3;",
      "export const TWICE = 2 * 3;",
      "  export const INDENTED = 2 * 3;",
    ].join("\n") + "\n",
  });
  const fails = (n, re) => assert.throws(() => treeConstant(t, "p.ts", n, { product: true }), re, n);
  for (const n of ["NAMED", "PLUS", "MIXED", "NEG", "HEX", "FRACTION", "EXP", "PARENS", "POWER", "DANGLING", "DOUBLE_SEP", "TRAILING_SEP", "LEADING_ZERO", "QUOTED", "BOOL", "DIVIDED"]) fails(n, /is not an integer product/);
  fails("OVER", /is 18014398509481984, past Number\.MAX_SAFE_INTEGER/);
  fails("TWICE", /declared 2 times/);
  fails("INDENTED", /no top-level const/);
});

test("NEGATIVE: without the option a product is still refused, and the error says how to read it; bad options throw", () => {
  const t = treeTarget({ "p.ts": "export const BEAT = 5 * 60 * 1000;\nexport const SUM = 1 + 2;\n" });
  assert.throws(() => treeConstant(t, "p.ts", "BEAT"), /not a plain literal: 5 \* 60 \* 1000; \(an integer product: pass \{product: true\}\)$/);
  assert.throws(() => treeConstant(t, "p.ts", "BEAT", { product: false }), /not a plain literal/);
  assert.throws(() => treeConstant(t, "p.ts", "SUM"), (e) => /not a plain literal: 1 \+ 2;$/.test(e.message), "no hint for an expression that is not a product");
  assert.throws(() => treeConstant(t, "p.ts", "BEAT", { product: "yes" }), /product is true or false/);
  assert.throws(() => treeConstant(t, "p.ts", "BEAT", { prodcut: true }), /unknown option\(s\) prodcut/);
  assert.throws(() => treeConstant(t, "p.ts", "BEAT", null), /options are an object/);
  assert.throws(() => treeConstant(t, "p.ts", "BEAT", true), /options are an object/);
});
