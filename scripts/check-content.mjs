#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The sample documents demonstrate specific properties; this keeps them doing so (SPEC §12).

/**
 * The samples are not decoration. Each one exists to exercise something, and a
 * well-meaning edit can quietly stop it doing so:
 *
 *   - Adding a script to design-review-shortener would break the half of the
 *     trust condition it demonstrates — that a document with no scripts never
 *     prompts. Nothing else in the suite would notice.
 *   - Adding an external URL to any of them would make it stop being a
 *     self-contained bundle, which is the property the authoring guide asks
 *     everybody else to maintain.
 *   - Removing an id would silently degrade every anchor in that section to
 *     document scope, which is exactly the failure the samples warn about.
 *
 * So the properties are asserted rather than described.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(ROOT, "content");

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

/**
 * Properties every sample must have, whatever it is demonstrating.
 *
 * The external-URL rule is about what the browser FETCHES, not about what the
 * document mentions. A `<a href="https://…">` is a link a reader may choose to
 * follow; `src=`, `<link rel=stylesheet>`, `url()` and `@import` are requests
 * the browser makes on its own, before the reader does anything, and those are
 * what leak a confidential document's reader to a third party.
 *
 * Distinguishing them matters here because the Markdown sample legitimately
 * links out to example.com. A rule that banned both would either fail on that
 * or — worse — be quietly relaxed until it meant nothing.
 */
function checkUniversal(name, file, text) {
  const where = `${name}/${file}`;
  const ASSET_FETCHES = [
    [/\bsrc\s*=\s*"https?:\/\//, "src="],
    [/<link\b[^>]*href\s*=\s*"https?:\/\//, "<link href="],
    [/url\(\s*['"]?https?:\/\//, "url()"],
    [/@import\s+(?:url\()?['"]https?:\/\//, "@import"],
    [/!\[[^\]]*\]\(\s*https?:\/\//, "![](…) image"],
  ];
  for (const [re, what] of ASSET_FETCHES) {
    check(
      !re.test(text),
      `${where}: ${what} fetches from a third party. Every sample must be self-contained — a reader's browser should never contact anybody to RENDER one. Outbound <a href> links are fine.`,
    );
  }
  check(
    !/data:image|\.(?:png|jpe?g|gif|webp)"/.test(text),
    `${where}: a raster image. Samples use inline SVG so they scale, print and recolour.`,
  );
  check(
    text.includes("SPDX-License-Identifier: Apache-2.0"),
    `${where}: no SPDX identifier.`,
  );
}

const EXPECTATIONS = {
  "bikeshed-tour": (text, report) => {
    // The SCRIPTED half of the trust condition.
    report(
      /<script/.test(text),
      "bikeshed-tour must contain a script: it is the sample that proves the trust prompt appears.",
    );
    report(
      text.includes('id="dot-nav"') && /<nav id="dot-nav"[^>]*>\s*<\/nav>/.test(text),
      "bikeshed-tour's #dot-nav must stay EMPTY in the markup: it is the sample for the editor's generated-container marking.",
    );
    const details = (text.match(/<details>/g) || []).length;
    report(details >= 6, `bikeshed-tour has ${details} <details>; it needs several, and at least one nested, to exercise recursive rehydration.`);
    report(
      /<details>[\s\S]*?<details>/.test(text),
      "bikeshed-tour must contain a NESTED <details>: rehydration opens every collapsed ancestor, not just the nearest.",
    );
    const svgs = (text.match(/<svg/g) || []).length;
    report(svgs >= 3, `bikeshed-tour has ${svgs} inline SVG; it needs several to exercise per-diagram SVG export.`);
    report(text.includes("@media print"), "bikeshed-tour must carry a print stylesheet.");
  },
  "deck-quarter-review": (text, report) => {
    // The DECK. The navigator is gated on slides measuring about one viewport
    // tall, so shortening these does not make the sample worse — it makes it
    // stop being the thing it is here to be, with nothing else noticing.
    report(
      /min-height:\s*100vh/.test(text),
      "deck-quarter-review's slides must be a viewport tall: that measurement is the only thing that makes the slide navigator appear.",
    );
    // Every sizing rule has to live on the CONTAINER, because a thumbnail
    // reproduces a slide's ancestors precisely so rules like this still apply.
    report(
      /\.deck\s*>\s*section\s*\{/.test(text),
      "deck-quarter-review must size its slides through `.deck > section`: a container-scoped rule is what the preview's ancestor chain exists to reproduce.",
    );
    report(
      (text.match(/<section id="/g) || []).length >= 6,
      "deck-quarter-review needs its sections: they are the slides, and they are what comments anchor to.",
    );
    // A third proof of the trust prompt would be noise; a deck that renders
    // identically either way is what makes this a demonstration of NAVIGATION.
    report(
      !/<script/.test(text),
      "deck-quarter-review must contain NO script: it demonstrates the deck navigator, and it can only do that cleanly if it renders the same trusted or not.",
    );
  },
  "deck-animated": (text, report) => {
    // The deck whose slides previewed blank. Each pattern below is a different
    // reason a thumbnail can show a slide's first frame instead of its last, so
    // losing any one of them stops the sample proving that fix.
    report(
      /<script/.test(text),
      "deck-animated must contain a script: it is what stacks the slides and moves `.active`, the state a preview never runs.",
    );
    report(
      /height:\s*100vh/.test(text),
      "deck-animated's slides must be a viewport tall, or the navigator and its thumbnails never appear.",
    );
    report(
      /\.js \.slide \.anim\s*\{\s*opacity:\s*0;?\s*\}/.test(text) &&
        // `none` excluded: the reduced-motion rule names the same selector.
        /\.js \.slide\.active \.anim\s*\{[^}]*animation:\s*(?!none\b)[\w-]+\s/.test(text),
      "deck-animated needs content hidden at opacity:0 that animates in only under `.slide.active`.",
    );
    report(
      /\.js \.slide \.bar\s*\{[^}]*width:\s*0/.test(text) &&
        /\.js \.slide\.active \.bar\s*\{[^}]*width:\s*var\(--w\)/.test(text),
      "deck-animated needs bars that start at width:0 and fill only under `.slide.active`: a final state that forcing opacity cannot reach.",
    );
    report(
      /\.badge\s*\{[^}]*animation:[^;}]*\d(?:\.\d+)?s[^;}]*\d(?:\.\d+)?s[^;}]*\bboth\b/.test(text),
      "deck-animated needs a delayed animation with fill-mode `both`, which holds its element invisible until the delay runs out.",
    );
  },
  "design-review-shortener": (text, report) => {
    // The SCRIPT-FREE half. This is the assertion that matters most in this file.
    report(
      !/<script/.test(text),
      "design-review-shortener must contain NO script: it is the sample that proves a static document never prompts for trust.",
    );
    report(
      (text.match(/<section id="/g) || []).length >= 8,
      "design-review-shortener needs its sections, which are what the open questions anchor to.",
    );
  },
  "markdown-reference": (text, report) => {
    report(
      /^#\s/m.test(text),
      "markdown-reference must use headings: they are what become sections, and sections are what anchors scope to.",
    );
    report(
      /<details>/.test(text) && /<div id="generated">/.test(text),
      "markdown-reference must keep its raw-HTML block: it demonstrates that raw HTML flows through the existing trust model.",
    );
    // The Markdown half of the trust proof. A and B prove both halves for
    // hand-authored HTML; without a script HERE, nothing in the repository
    // demonstrates that a Markdown document's raw HTML obeys the same model.
    report(
      /<script/.test(text),
      "markdown-reference must contain a <script> inside its raw-HTML block: it is the sample that proves the trust model reaches Markdown documents too.",
    );
  },
};

for (const name of readdirSync(CONTENT)) {
  const bundle = join(CONTENT, name, "bundle");
  if (!existsSync(bundle)) continue;

  const manifestPath = join(CONTENT, name, "manifest.json");
  check(existsSync(manifestPath), `${name}: no manifest.json.`);
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const field of ["title", "entry", "owner"]) {
      check(manifest[field], `${name}/manifest.json: missing "${field}".`);
    }
    // RFC 2606 reserves example.com precisely so documentation cannot name a
    // real address by accident.
    check(
      /@example\.(com|org|net)$/.test(manifest.owner ?? ""),
      `${name}/manifest.json: owner must be an example.com address, never a real one.`,
    );
    for (const viewer of manifest.viewers ?? []) {
      check(
        /@example\.(com|org|net)$/.test(viewer),
        `${name}/manifest.json: viewer "${viewer}" must be an example.com address.`,
      );
    }
  }

  let combined = "";
  for (const file of readdirSync(bundle)) {
    const text = readFileSync(join(bundle, file), "utf8");
    checkUniversal(name, file, text);
    combined += text;
  }

  const expect = EXPECTATIONS[name];
  if (expect) {
    expect(combined, (ok, message) => check(ok, message));
  }
}

if (problems.length > 0) {
  console.error(`sample content (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log("content: every sample still demonstrates what it is there for");
